/**
 * PgCampaigns — campaigns, submissions, perks, point awards.
 *
 * Cross-domain: releaseBonus credits the submitter's balance + handles the
 * auto-earn tail inline. Uses LedgerStateManager for the user-state plumbing.
 */

import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  nbCampaignSubmissions,
  nbCampaigns,
  nbUserPerks,
} from '../../db/schema/index.js';
import {
  POINTS_PER_USD,
  TIER_MULTIPLIERS,
  multiplierForTier,
  tierForPoints,
} from '../../lib/campaigns/perks.js';
import {
  type Campaign,
  type CampaignInput,
  type CampaignPlatform,
  type CampaignStatus,
  type CampaignSubmission,
  type PerkTier,
  PolicyError,
  type SessionUser,
  type User,
} from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';
import type { PgLedger } from './ledger.js';
import { campaignFromRow, n, round2, submissionFromRow } from './_shared.js';

export class PgCampaigns {
  constructor(
    private db: Db,
    private core: LedgerStateManager,
    /**
     * Sprint 13 COMMIT 1 — releaseBonus credits the submitter via PgLedger.topUp
     * so earnByDefault auto-tail + chain mirror fire. The prior inline credit
     * + earn split was a pure state mutation and skipped the mirror.
     */
    private ledger: PgLedger,
  ) {}

  async createCampaign(creator: User, input: CampaignInput): Promise<Campaign> {
    const [row] = await this.db
      .insert(nbCampaigns)
      .values({
        creatorId: creator.id,
        title: input.title,
        brand: input.brand,
        baseUsd: input.baseUsd.toFixed(6),
        bonusTiers: input.bonusTiers,
        topPrizeUsd: (input.topPrizeUsd ?? 0).toFixed(6),
        status: 'active',
        endAt: input.endAt ? new Date(input.endAt) : null,
      })
      .returning();
    return campaignFromRow(row!);
  }

  async listCampaigns(filter?: { status?: CampaignStatus }): Promise<Campaign[]> {
    const rows = await (filter?.status
      ? this.db
          .select()
          .from(nbCampaigns)
          .where(eq(nbCampaigns.status, filter.status))
          .orderBy(desc(nbCampaigns.createdAt))
      : this.db.select().from(nbCampaigns).orderBy(desc(nbCampaigns.createdAt)));
    return rows.map(campaignFromRow);
  }

  async submitToCampaign(
    u: SessionUser,
    campaignId: string,
    input: { clipUrl: string; platform: CampaignPlatform; viewsAttested: number },
  ): Promise<CampaignSubmission> {
    const [campRow] = await this.db
      .select()
      .from(nbCampaigns)
      .where(eq(nbCampaigns.id, campaignId))
      .limit(1);
    if (!campRow) throw new Error('campaign_not_found');
    if (campRow.status !== 'active') throw new Error('campaign_closed');

    try {
      const [row] = await this.db
        .insert(nbCampaignSubmissions)
        .values({
          campaignId,
          userId: u.id,
          clipUrl: input.clipUrl,
          platform: input.platform,
          viewsAttested: Math.max(0, Math.floor(input.viewsAttested)),
          viewsVerified: 0,
          status: 'submitted',
          paidUsd: '0',
        })
        .returning();
      return submissionFromRow(row!);
    } catch (e) {
      // 23505 = unique_violation.
      const err = e as { code?: string; constraint_name?: string };
      if (err.code === '23505' && err.constraint_name === 'nb_campaign_submissions_campaign_user_uq') {
        throw new PolicyError('expired', 'submission_cap');
      }
      throw e;
    }
  }

  async approveSubmission(
    submissionId: string,
    viewsVerified: number,
  ): Promise<CampaignSubmission> {
    let approved!: CampaignSubmission;
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(nbCampaignSubmissions)
        .where(eq(nbCampaignSubmissions.id, submissionId))
        .for('update');
      if (!existing) throw new Error('submission_not_found');
      if (existing.status === 'paid') throw new Error('submission_already_paid');

      const [row] = await tx
        .update(nbCampaignSubmissions)
        .set({
          viewsVerified: Math.max(0, Math.floor(viewsVerified)),
          status: 'approved',
          approvedAt: new Date(),
        })
        .where(eq(nbCampaignSubmissions.id, submissionId))
        .returning();
      approved = submissionFromRow(row!);
    });
    return approved;
  }

  async releaseBonus(campaignId: string, submissionId: string): Promise<{
    submission: CampaignSubmission;
    paidUsd: number;
    tier: PerkTier;
    multiplier: number;
  }> {
    let result!: {
      submission: CampaignSubmission;
      paidUsd: number;
      tier: PerkTier;
      multiplier: number;
    };
    let paidUserId = '';
    let creditUsd = 0;
    let campaignTitle = '';

    await this.db.transaction(async (tx) => {
      const [subRow] = await tx
        .select()
        .from(nbCampaignSubmissions)
        .where(eq(nbCampaignSubmissions.id, submissionId))
        .for('update');
      if (!subRow) throw new Error('submission_not_found');
      // Sprint 13 COMMIT 6 — assert the submission belongs to the URL's
      // campaignId so a compromised admin key can't pay out across campaigns.
      if (subRow.campaignId !== campaignId)
        throw new PolicyError('expired', 'subId_campaignId_mismatch');
      if (subRow.status === 'paid') throw new Error('submission_already_paid');
      if (subRow.status !== 'approved') throw new Error('submission_not_approved');

      const [campRow] = await tx
        .select()
        .from(nbCampaigns)
        .where(eq(nbCampaigns.id, subRow.campaignId))
        .limit(1);
      if (!campRow) throw new Error('campaign_not_found');

      // Sum the base + every bonus tier whose threshold is met by viewsVerified.
      const bonusTiers =
        (campRow.bonusTiers as Array<{ viewsThreshold: number; bonusUsd: number }>) ?? [];
      let bonus = 0;
      for (const tier of bonusTiers) {
        if (subRow.viewsVerified >= tier.viewsThreshold) bonus += Number(tier.bonusUsd);
      }
      const subtotal = Number(campRow.baseUsd) + bonus;
      // Snapshot tier BEFORE crediting the payout: the multiplier should reflect
      // the submitter's current standing, not the post-payout standing.
      const [perkRow] = await tx
        .select()
        .from(nbUserPerks)
        .where(eq(nbUserPerks.userId, subRow.userId))
        .for('update');
      const tier = (perkRow?.tier as PerkTier | undefined) ?? 'starter';
      const multiplier = multiplierForTier(tier);
      const paidUsd = round2(subtotal * multiplier);

      if (paidUsd > 0) {
        // Sprint 13 COMMIT 1 — write only the perks delta + submission flip
        // inside the tx. The balance credit goes through PgLedger.topUp after
        // commit so earnByDefault auto-tail + chain mirror fire. If the topUp
        // throws post-commit we log and leave the submission marked paid;
        // operator reconciliation is the safety net (best-effort contract,
        // matches chain-mirror).
        const prevPoints = perkRow?.points ?? 0;
        const prevLifetime = perkRow ? n(perkRow.lifetimeEarnedUsd) : 0;
        const points = Math.floor(prevPoints + paidUsd * POINTS_PER_USD.earn);
        const nextTier = tierForPoints(points);
        const lifetimeEarnedUsd = round2(prevLifetime + paidUsd);
        await tx
          .insert(nbUserPerks)
          .values({
            userId: subRow.userId,
            points,
            tier: nextTier,
            lifetimeEarnedUsd: lifetimeEarnedUsd.toFixed(6),
          })
          .onConflictDoUpdate({
            target: nbUserPerks.userId,
            set: {
              points,
              tier: nextTier,
              lifetimeEarnedUsd: lifetimeEarnedUsd.toFixed(6),
              updatedAt: new Date(),
            },
          });
      }

      const [updated] = await tx
        .update(nbCampaignSubmissions)
        .set({ paidUsd: paidUsd.toFixed(6), status: 'paid' })
        .where(eq(nbCampaignSubmissions.id, submissionId))
        .returning();

      paidUserId = subRow.userId;
      creditUsd = paidUsd;
      campaignTitle = campRow.title;
      result = {
        submission: submissionFromRow(updated!),
        paidUsd,
        tier,
        multiplier,
      };
    });

    // After-tx: route the credit through the ledger so chain mirror fires.
    if (paidUserId && creditUsd > 0) {
      const user = await this.core.hydrateUser(paidUserId);
      await this.ledger.topUp(user, creditUsd, 'Campaign · ' + campaignTitle);
    }
    return result;
  }

  async getPerks(
    u: SessionUser,
  ): Promise<{ tier: PerkTier; points: number; multiplier: number; lifetimeEarnedUsd: number }> {
    const [row] = await this.db
      .select()
      .from(nbUserPerks)
      .where(eq(nbUserPerks.userId, u.id))
      .limit(1);
    if (!row) {
      return {
        tier: 'starter',
        points: 0,
        multiplier: TIER_MULTIPLIERS.starter,
        lifetimeEarnedUsd: 0,
      };
    }
    const tier = row.tier as PerkTier;
    return {
      tier,
      points: row.points,
      multiplier: multiplierForTier(tier),
      lifetimeEarnedUsd: n(row.lifetimeEarnedUsd),
    };
  }

  async awardPoints(
    u: SessionUser,
    source: 'earn' | 'cardSpend',
    usd: number,
  ): Promise<{ tier: PerkTier; points: number }> {
    if (!Number.isFinite(usd) || usd <= 0) {
      const perks = await this.getPerks(u);
      return { tier: perks.tier, points: perks.points };
    }

    let outTier: PerkTier = 'starter';
    let outPoints = 0;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(nbUserPerks)
        .where(eq(nbUserPerks.userId, u.id))
        .for('update');
      const prevPoints = row?.points ?? 0;
      const prevLifetime = row ? n(row.lifetimeEarnedUsd) : 0;
      const delta = usd * POINTS_PER_USD[source];
      const points = Math.floor(prevPoints + delta);
      const tier = tierForPoints(points);
      const lifetimeEarnedUsd = source === 'earn' ? round2(prevLifetime + usd) : prevLifetime;
      await tx
        .insert(nbUserPerks)
        .values({
          userId: u.id,
          points,
          tier,
          lifetimeEarnedUsd: lifetimeEarnedUsd.toFixed(6),
        })
        .onConflictDoUpdate({
          target: nbUserPerks.userId,
          set: {
            points,
            tier,
            lifetimeEarnedUsd: lifetimeEarnedUsd.toFixed(6),
            updatedAt: new Date(),
          },
        });
      outTier = tier;
      outPoints = points;
    });
    return { tier: outTier, points: outPoints };
  }
}

/**
 * InMemoryCampaigns — campaigns, submissions, perks, point awards.
 *
 * Cross-domain: releaseBonus calls ledger.topUp (credits the submitter)
 * and this.awardPoints (records the tier increment).
 */

import { randomUUID } from 'node:crypto';
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
import type { InMemoryState } from '../core/in-memory-state.js';
import type { InMemoryLedger } from './ledger.js';
import { nowIso, round2 } from './_shared.js';

export class InMemoryCampaigns {
  private campaignsById = new Map<string, Campaign>();
  private campaignSubmissionsById = new Map<string, CampaignSubmission>();
  private userPerksByUserId = new Map<
    string,
    { points: number; tier: PerkTier; lifetimeEarnedUsd: number }
  >();

  constructor(
    private state: InMemoryState,
    private ledger: InMemoryLedger,
  ) {}

  async createCampaign(creator: User, input: CampaignInput): Promise<Campaign> {
    const live = this.state.usersById.get(creator.id);
    if (!live) throw new Error('user_not_found');
    const campaign: Campaign = {
      id: randomUUID(),
      creatorId: live.id,
      title: input.title,
      brand: input.brand,
      baseUsd: input.baseUsd,
      bonusTiers: input.bonusTiers,
      topPrizeUsd: input.topPrizeUsd ?? 0,
      status: 'active',
      endAt: input.endAt ?? null,
      createdAt: nowIso(),
    };
    this.campaignsById.set(campaign.id, campaign);
    return campaign;
  }

  async listCampaigns(filter?: { status?: CampaignStatus }): Promise<Campaign[]> {
    return [...this.campaignsById.values()]
      .filter((c) => filter?.status === undefined || c.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async submitToCampaign(
    u: SessionUser,
    campaignId: string,
    input: { clipUrl: string; platform: CampaignPlatform; viewsAttested: number },
  ): Promise<CampaignSubmission> {
    const campaign = this.campaignsById.get(campaignId);
    if (!campaign) throw new Error('campaign_not_found');
    if (campaign.status !== 'active') throw new Error('campaign_closed');
    // Enforce MAX_SUBMISSIONS_PER_CAMPAIGN = 1 explicitly (unique idx in PG).
    for (const sub of this.campaignSubmissionsById.values()) {
      if (sub.campaignId === campaignId && sub.userId === u.id) {
        throw new PolicyError('expired', 'submission_cap');
      }
    }
    const submission: CampaignSubmission = {
      id: randomUUID(),
      campaignId,
      userId: u.id,
      clipUrl: input.clipUrl,
      platform: input.platform,
      viewsAttested: input.viewsAttested,
      viewsVerified: 0,
      status: 'submitted',
      paidUsd: 0,
      approvedAt: null,
      createdAt: nowIso(),
    };
    this.campaignSubmissionsById.set(submission.id, submission);
    return submission;
  }

  async approveSubmission(
    submissionId: string,
    viewsVerified: number,
  ): Promise<CampaignSubmission> {
    const sub = this.campaignSubmissionsById.get(submissionId);
    if (!sub) throw new Error('submission_not_found');
    if (sub.status === 'paid') throw new Error('submission_already_paid');
    sub.viewsVerified = Math.max(0, Math.floor(viewsVerified));
    sub.status = 'approved';
    sub.approvedAt = nowIso();
    return sub;
  }

  async releaseBonus(campaignId: string, submissionId: string): Promise<{
    submission: CampaignSubmission;
    paidUsd: number;
    tier: PerkTier;
    multiplier: number;
  }> {
    const sub = this.campaignSubmissionsById.get(submissionId);
    if (!sub) throw new Error('submission_not_found');
    // Sprint 13 COMMIT 6 — pre-check the URL :id matches the submission.
    if (sub.campaignId !== campaignId)
      throw new PolicyError('expired', 'subId_campaignId_mismatch');
    if (sub.status === 'paid') throw new Error('submission_already_paid');
    if (sub.status !== 'approved') throw new Error('submission_not_approved');
    const campaign = this.campaignsById.get(sub.campaignId);
    if (!campaign) throw new Error('campaign_not_found');
    const submitter = this.state.usersById.get(sub.userId);
    if (!submitter) throw new Error('user_not_found');

    // Sum the base + every bonus tier whose threshold is met by viewsVerified.
    let bonus = 0;
    for (const tier of campaign.bonusTiers) {
      if (sub.viewsVerified >= tier.viewsThreshold) bonus += tier.bonusUsd;
    }
    const subtotal = campaign.baseUsd + bonus;
    // Snapshot tier BEFORE crediting the payout — the multiplier should reflect
    // the submitter's current standing, not the post-payout standing.
    const perks = await this.getPerks(submitter);
    const tier = perks.tier;
    const multiplier = multiplierForTier(tier);
    const paidUsd = round2(subtotal * multiplier);

    await this.ledger.topUp(submitter, paidUsd, 'Campaign · ' + campaign.title);
    await this.awardPoints(submitter, 'earn', paidUsd);
    sub.paidUsd = paidUsd;
    sub.status = 'paid';
    return { submission: sub, paidUsd, tier, multiplier };
  }

  async getPerks(
    u: SessionUser,
  ): Promise<{ tier: PerkTier; points: number; multiplier: number; lifetimeEarnedUsd: number }> {
    const row = this.userPerksByUserId.get(u.id);
    if (!row) {
      return { tier: 'starter', points: 0, multiplier: TIER_MULTIPLIERS.starter, lifetimeEarnedUsd: 0 };
    }
    return {
      tier: row.tier,
      points: row.points,
      multiplier: multiplierForTier(row.tier),
      lifetimeEarnedUsd: row.lifetimeEarnedUsd,
    };
  }

  async awardPoints(
    u: SessionUser,
    source: 'earn' | 'cardSpend',
    usd: number,
  ): Promise<{ tier: PerkTier; points: number }> {
    if (!Number.isFinite(usd) || usd <= 0) {
      const row = this.userPerksByUserId.get(u.id);
      return row
        ? { tier: row.tier, points: row.points }
        : { tier: 'starter', points: 0 };
    }
    const existing = this.userPerksByUserId.get(u.id);
    const prevPoints = existing?.points ?? 0;
    const prevLifetime = existing?.lifetimeEarnedUsd ?? 0;
    const delta = usd * POINTS_PER_USD[source];
    const points = Math.floor(prevPoints + delta);
    const tier = tierForPoints(points);
    const lifetimeEarnedUsd = source === 'earn' ? round2(prevLifetime + usd) : prevLifetime;
    this.userPerksByUserId.set(u.id, { points, tier, lifetimeEarnedUsd });
    return { tier, points };
  }

  clearAll(): void {
    this.campaignsById.clear();
    this.campaignSubmissionsById.clear();
    this.userPerksByUserId.clear();
  }
}

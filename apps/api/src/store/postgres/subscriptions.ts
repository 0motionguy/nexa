/**
 * PgSubscriptions — recurring offers, sub-accounts (one KYC, many businesses),
 * payouts, API keys, webhooks.
 *
 * Cross-domain: renewSubscription locks user state for the renewal credit;
 * createPayout debits user state. Both go via LedgerStateManager.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  nbApiKeys,
  nbPayouts,
  nbSubAccounts,
  nbSubscriptions,
  nbTransactions,
  nbWebhookEndpoints,
} from '../../db/schema/index.js';
import {
  type Activity,
  type ApiKey,
  type ApiKeyCreated,
  type Payout,
  type PayoutInput,
  PolicyError,
  type SubAccount,
  type Subscription,
  type SessionUser,
  type User,
  type WebhookEndpoint,
} from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';
import type { PgAuth } from './auth.js';
import {
  apiKeyFromRow,
  money,
  n,
  payoutFromRow,
  sha256,
  subAccountFromRow,
  subscriptionFromRow,
  webhookFromRow,
} from './_shared.js';

export class PgSubscriptions {
  constructor(
    private db: Db,
    private core: LedgerStateManager,
    private auth: PgAuth,
  ) {}

  /* ── developer surface: API keys ── */

  async createApiKey(u: SessionUser, label: string | null, livemode: boolean): Promise<ApiKeyCreated> {
    const prefix: ApiKey['prefix'] = livemode ? 'sk_live' : 'sk_test';
    const secret = prefix + '_' + randomBytes(18).toString('hex');
    const hash = sha256(secret);
    const id = randomUUID();
    const at = new Date();
    const [row] = await this.db
      .insert(nbApiKeys)
      .values({
        id,
        sellerId: u.id,
        prefix,
        keyHash: hash,
        last4: secret.slice(-4),
        label,
        livemode,
        createdAt: at,
        lastUsedAt: null,
        revokedAt: null,
      })
      .returning();
    return { ...apiKeyFromRow(row!), secret };
  }

  async listApiKeys(u: SessionUser): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(nbApiKeys)
      .where(eq(nbApiKeys.sellerId, u.id))
      .orderBy(desc(nbApiKeys.createdAt));
    return rows.map(apiKeyFromRow);
  }

  async revokeApiKey(u: SessionUser, id: string): Promise<ApiKey | null> {
    const [row] = await this.db
      .select()
      .from(nbApiKeys)
      .where(and(eq(nbApiKeys.id, id), eq(nbApiKeys.sellerId, u.id)))
      .limit(1);
    if (!row) return null;
    if (!row.revokedAt) {
      const at = new Date();
      const [updated] = await this.db
        .update(nbApiKeys)
        .set({ revokedAt: at })
        .where(eq(nbApiKeys.id, id))
        .returning();
      return apiKeyFromRow(updated ?? { ...row, revokedAt: at });
    }
    return apiKeyFromRow(row);
  }

  async userForApiKey(secret: string): Promise<{ user: User; livemode: boolean } | null> {
    const [row] = await this.db
      .select()
      .from(nbApiKeys)
      .where(eq(nbApiKeys.keyHash, sha256(secret)))
      .limit(1);
    if (!row || row.revokedAt) return null;
    await this.db.update(nbApiKeys).set({ lastUsedAt: new Date() }).where(eq(nbApiKeys.id, row.id));
    try {
      const user = await this.auth.user(row.sellerId);
      return { user, livemode: row.livemode };
    } catch {
      return null;
    }
  }

  /* ── sub-accounts ── */

  async createSubAccount(u: SessionUser, name: string): Promise<SubAccount> {
    const id = randomUUID();
    const at = new Date();
    const [row] = await this.db
      .insert(nbSubAccounts)
      .values({ id, sellerId: u.id, name, balUsd: '0', sandboxBalUsd: '0', createdAt: at })
      .returning();
    return subAccountFromRow(row!);
  }

  async listSubAccounts(u: SessionUser): Promise<SubAccount[]> {
    const rows = await this.db
      .select()
      .from(nbSubAccounts)
      .where(eq(nbSubAccounts.sellerId, u.id))
      .orderBy(desc(nbSubAccounts.createdAt));
    return rows.map(subAccountFromRow);
  }

  async subAccount(u: SessionUser, id: string): Promise<SubAccount> {
    const [row] = await this.db
      .select()
      .from(nbSubAccounts)
      .where(and(eq(nbSubAccounts.id, id), eq(nbSubAccounts.sellerId, u.id)))
      .limit(1);
    if (!row) throw new Error('sub_account_not_found');
    return subAccountFromRow(row);
  }

  /* ── payouts ── */

  async createPayout(
    u: SessionUser,
    input: PayoutInput,
    opts?: { livemode?: boolean; idempotencyKey?: string | null },
  ): Promise<Payout> {
    const live = opts?.livemode ?? true;

    // Idempotency: a repeat key returns the prior payout, no re-debit.
    if (opts?.idempotencyKey) {
      const [prior] = await this.db
        .select()
        .from(nbPayouts)
        .where(and(eq(nbPayouts.sellerId, u.id), eq(nbPayouts.idempotencyKey, opts.idempotencyKey)))
        .limit(1);
      if (prior) return payoutFromRow(prior);
    }

    let payout!: Payout;
    let activity: Activity | null = null;

    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      const bal = live ? state.balUsd : state.sandboxBalUsd;
      if (input.amountUsd > bal)
        throw new PolicyError('insufficient_funds', 'Not enough balance for this payout.');
      if (live) state.balUsd -= input.amountUsd;
      else state.sandboxBalUsd -= input.amountUsd;
      await this.core.writeUserState(tx, u.id, state);

      const id = randomUUID();
      const at = new Date();
      const [row] = await tx
        .insert(nbPayouts)
        .values({
          id,
          sellerId: u.id,
          amountUsd: input.amountUsd.toFixed(6),
          currency: 'USD',
          destination: input.destination,
          method: input.method ?? 'email',
          note: input.note ?? null,
          status: 'paid',
          livemode: live,
          idempotencyKey: opts?.idempotencyKey ?? null,
          createdAt: at,
        })
        .returning();
      payout = payoutFromRow(row!);

      if (live) {
        const txId = randomUUID();
        await tx.insert(nbTransactions).values({
          id: txId,
          userId: u.id,
          kind: 'out',
          status: 'confirmed',
          title: 'Payout · ' + input.destination,
          subtitle: 'SENT · JUST NOW',
          amountUsd: input.amountUsd.toFixed(6),
          counterparty: input.destination,
          createdAt: at,
        });
        activity = {
          id: txId,
          n: 'Payout · ' + input.destination,
          s: 'SENT · JUST NOW',
          a: '−' + money(input.amountUsd),
          k: 'out',
          at: at.toISOString(),
        };
      }
    });

    if (live) {
      await this.core.invalidateUser(u.id);
      if (activity) this.core.emitActivity(u.id, activity);
    }
    return payout;
  }

  async listPayouts(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payout[]> {
    const where =
      opts?.livemode === undefined
        ? eq(nbPayouts.sellerId, u.id)
        : and(eq(nbPayouts.sellerId, u.id), eq(nbPayouts.livemode, opts.livemode));
    const rows = await this.db
      .select()
      .from(nbPayouts)
      .where(where)
      .orderBy(desc(nbPayouts.createdAt));
    return rows.map(payoutFromRow);
  }

  async payout(u: SessionUser, id: string): Promise<Payout> {
    const [row] = await this.db
      .select()
      .from(nbPayouts)
      .where(and(eq(nbPayouts.id, id), eq(nbPayouts.sellerId, u.id)))
      .limit(1);
    if (!row) throw new Error('payout_not_found');
    return payoutFromRow(row);
  }

  /* ── subscriptions ── */

  async listSubscriptions(u: SessionUser, opts?: { livemode?: boolean }): Promise<Subscription[]> {
    const where =
      opts?.livemode === undefined
        ? eq(nbSubscriptions.sellerId, u.id)
        : and(eq(nbSubscriptions.sellerId, u.id), eq(nbSubscriptions.livemode, opts.livemode));
    const rows = await this.db
      .select()
      .from(nbSubscriptions)
      .where(where)
      .orderBy(desc(nbSubscriptions.createdAt));
    return rows.map(subscriptionFromRow);
  }

  async subscription(u: SessionUser, id: string): Promise<Subscription> {
    const [row] = await this.db
      .select()
      .from(nbSubscriptions)
      .where(and(eq(nbSubscriptions.id, id), eq(nbSubscriptions.sellerId, u.id)))
      .limit(1);
    if (!row) throw new Error('subscription_not_found');
    return subscriptionFromRow(row);
  }

  async renewSubscription(u: SessionUser, id: string, opts?: { dueBefore?: Date }): Promise<Subscription> {
    let result!: Subscription;
    let activity: Activity | null = null;

    await this.db.transaction(async (tx) => {
      // Row-lock the subscription (ownership + status check).
      const [subLocked] = await tx
        .select()
        .from(nbSubscriptions)
        .where(and(eq(nbSubscriptions.id, id), eq(nbSubscriptions.sellerId, u.id)))
        .for('update');
      if (!subLocked) throw new Error('subscription_not_found');
      if (subLocked.status === 'canceled') throw new Error('subscription_canceled');
      if (opts?.dueBefore && subLocked.currentPeriodEnd >= opts.dueBefore)
        throw new Error('subscription_not_due');

      const amountUsd = n(subLocked.amountUsd);
      const live = subLocked.livemode;

      // Credit the seller a renewal charge (live → bal_usd, sandbox → sandbox_bal_usd).
      const state = await this.core.lockUserState(tx, u.id);
      if (live) state.balUsd += amountUsd;
      else state.sandboxBalUsd += amountUsd;
      await this.core.writeUserState(tx, u.id, state);

      const at = new Date();
      const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const [updated] = await tx
        .update(nbSubscriptions)
        .set({ currentPeriodEnd: periodEnd })
        .where(eq(nbSubscriptions.id, id))
        .returning();
      result = subscriptionFromRow(updated!);

      if (live) {
        const txId = randomUUID();
        const title = 'Renewal · ' + subLocked.offerTitle;
        await tx.insert(nbTransactions).values({
          id: txId,
          userId: u.id,
          kind: 'in',
          status: 'confirmed',
          title,
          subtitle: 'SUBSCRIPTION · JUST NOW',
          amountUsd: amountUsd.toFixed(6),
          createdAt: at,
        });
        activity = {
          id: txId,
          n: title,
          s: 'SUBSCRIPTION · JUST NOW',
          a: '+' + money(amountUsd),
          pos: true,
          k: 'in',
          at: at.toISOString(),
        };
      }
    });

    await this.core.invalidateUser(u.id);
    if (activity) this.core.emitActivity(u.id, activity);
    return result;
  }

  async cancelSubscription(u: SessionUser, id: string): Promise<Subscription> {
    // Ownership check (throws subscription_not_found if not owned).
    await this.subscription(u, id);
    const [row] = await this.db
      .update(nbSubscriptions)
      .set({ status: 'canceled' })
      .where(eq(nbSubscriptions.id, id))
      .returning();
    return subscriptionFromRow(row!);
  }

  async findSubscriptionsDueBefore(cutoff: Date): Promise<Subscription[]> {
    const rows = await this.db
      .select()
      .from(nbSubscriptions)
      .where(
        and(
          eq(nbSubscriptions.status, 'active'),
          // Raw sql`${col} < ${cutoff}` bypassed the column's mapToDriverValue,
          // handing postgres-js a naked Date — client-side ERR_INVALID_ARG_TYPE
          // on every renewer run in prod (2026-07-15 incident). lt() maps
          // Date -> ISO string. Guarded by store/postgres/date-params.spec.ts.
          lt(nbSubscriptions.currentPeriodEnd, cutoff),
        ),
      )
      .orderBy(desc(nbSubscriptions.createdAt));
    return rows.map(subscriptionFromRow);
  }

  /* ── webhooks ── */

  async registerWebhook(u: SessionUser, url: string): Promise<WebhookEndpoint> {
    const id = randomUUID();
    const at = new Date();
    const secret = 'whsec_' + randomUUID().replace(/-/g, '');
    const [row] = await this.db
      .insert(nbWebhookEndpoints)
      .values({ id, sellerId: u.id, url, secret, active: true, createdAt: at })
      .returning();
    return webhookFromRow(row!);
  }

  async listWebhooks(u: SessionUser): Promise<WebhookEndpoint[]> {
    const rows = await this.db
      .select()
      .from(nbWebhookEndpoints)
      .where(eq(nbWebhookEndpoints.sellerId, u.id))
      .orderBy(desc(nbWebhookEndpoints.createdAt));
    return rows.map(webhookFromRow);
  }

  async webhooksForSeller(sellerId: string): Promise<WebhookEndpoint[]> {
    const rows = await this.db
      .select()
      .from(nbWebhookEndpoints)
      .where(eq(nbWebhookEndpoints.sellerId, sellerId));
    return rows.map(webhookFromRow);
  }
}

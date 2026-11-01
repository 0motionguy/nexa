/**
 * Postgres Store impl — production durability.
 *
 * Sprint 12 Phase 3 — this file is now a thin facade. The 3,622-LOC monolith
 * was split into one shared LedgerStateManager kernel under store/core/ plus
 * twelve focused domain modules under store/postgres/. Each domain module
 * owns its own transactions; the facade wires them up and forwards the
 * Store-interface methods to the correct module.
 *
 * Public Store interface (store/types.ts) is preserved verbatim. Every money-
 * mutating method still runs as one db.transaction with row-level locks
 * (SELECT ... FOR UPDATE); the activity bus emit still fires after commit.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { nbPushSubscriptions, nbExpoPushSubscriptions, nbSessions } from '../db/schema/index.js';
import type { RedisClient } from '../lib/redis.js';
import { LedgerStateManager } from './core/ledger-state.js';
import { PgAgents } from './postgres/agents.js';
import { PgAuditLog } from './postgres/audit-log.js';
import { PgAuth } from './postgres/auth.js';
import { PgBridge } from './postgres/bridge.js';
import { PgCampaigns } from './postgres/campaigns.js';
import { PgCards } from './postgres/cards.js';
import { PgClaims } from './postgres/claims.js';
import { PgKyc } from './postgres/kyc.js';
import { PgLedger } from './postgres/ledger.js';
import { PgMarkets } from './postgres/markets.js';
import { PgPayments } from './postgres/payments.js';
import { PgSubscriptions } from './postgres/subscriptions.js';
import {
  type Activity, type Agent, type AgentDigestDue, type AgentPolicy, type AgentWalletRecord,
  type ApiKey, type ApiKeyCreated, type AuditLogEntry, type AuditLogFilter, type AuditLogRecord,
  type BridgeTransfer, type Campaign, type CampaignInput,
  type CampaignPlatform, type CampaignStatus, type CampaignSubmission, type ChainMirror, type CheckoutView,
  type ClaimSendResult,
  type ClaimRecord, type CreateStripeSessionInput, type EarnMoveResult, type KycStatus,
  type LifecycleTransitionInput,
  type MarketOrderCompletionInput, type MarketOrderInput, type MarketOrderReservationInput,
  type MarketOrderReservationResult,
  type MarketPosition, type MarketVenue, type Offer, type OfferInput, type PayResult,
  type Payment, type Payout, type PayoutInput, type PayoutMethod, type PayoutMethodType,
  type PerkTier, type PushSubscriptionInput, type PushSubscriptionRecord,
  type DevicePlatform, type DeviceUpsertInput,
  type ExpoPushSubscriptionInput, type ExpoPushSubscriptionRecord, type SendResult, type SessionUser, type Store,
  type StripeSessionRecord, type SubAccount, type Subscription, type SwapResult, type User, type VaultTier, type VirtualAccount,
  type WebhookEndpoint, type X402Contract, type X402PayResult,
} from './types.js';

type PushSubscriptionRow = typeof nbPushSubscriptions.$inferSelect;

function pushSubscriptionFromRow(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.userId,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Deterministic installation id for legacy `/push/expo-subscribe` rows so the
 *  opaque-token channel coexists with installation-keyed devices under the new
 *  unique index. MUST match the SQL backfill in migration 0035
 *  ('legacy-' || left(md5(token),16)). */
function legacyInstallationId(token: string): string {
  return 'legacy-' + createHash('md5').update(token).digest('hex').slice(0, 16);
}

function expoPushSubscriptionFromRow(row: typeof nbExpoPushSubscriptions.$inferSelect): ExpoPushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.userId,
    installationId: row.installationId,
    token: row.token,
    platform: row.platform as DevicePlatform,
    appVersion: row.appVersion,
    enabled: row.enabled,
    preferences: (row.preferences as Record<string, boolean> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PostgresStore implements Store {
  readonly bus = new EventEmitter();
  private db: Db;
  private core: LedgerStateManager;
  private auth: PgAuth;
  private ledger: PgLedger;
  private agents: PgAgents;
  private cards: PgCards;
  private kyc: PgKyc;
  private payments: PgPayments;
  private subscriptions: PgSubscriptions;
  private bridge: PgBridge;
  private claims: PgClaims;
  private markets: PgMarkets;
  private campaigns: PgCampaigns;
  private auditLog: PgAuditLog;

  constructor(opts: { db: Db; redis: RedisClient | null }) {
    this.db = opts.db;
    this.core = new LedgerStateManager(opts.db, opts.redis, this.bus);
    this.auth = new PgAuth(opts.db, opts.redis, this.core);
    this.ledger = new PgLedger(opts.db, this.core);
    this.agents = new PgAgents(opts.db, this.core);
    this.cards = new PgCards(opts.db, this.core);
    this.kyc = new PgKyc(opts.db, this.core);
    // Sprint 13 COMMIT 1 — payments, bridge, campaigns, claims accept the
    // ledger facade as a sibling so cross-domain credits + auto-divest fire
    // the chain mirror + earnByDefault tail via PgLedger.topUp /
    // autoDivestIfNeeded instead of mutating user state inline.
    this.payments = new PgPayments(opts.db, this.core, this.ledger);
    this.subscriptions = new PgSubscriptions(opts.db, this.core, this.auth);
    this.bridge = new PgBridge(opts.db, this.core, this.auth, this.ledger);
    this.claims = new PgClaims(opts.db, this.core, this.auth, this.ledger);
    this.markets = new PgMarkets(opts.db);
    this.campaigns = new PgCampaigns(opts.db, this.core, this.ledger);
    this.auditLog = new PgAuditLog(opts.db);
  }

  attachChainMirror(m: ChainMirror): void { this.ledger.setChainMirror(m); }

  /* ── auth / users ── */
  upsertUserByEmail(
    email: string,
    name?: string,
    opts?: { privyDid?: string | null },
  ): Promise<User> {
    return this.auth.upsertUserByEmail(email, name, opts);
  }
  user(id: string): Promise<User> { return this.auth.user(id); }
  userSession(id: string): Promise<SessionUser> { return this.auth.userSession(id); }
  setPrivyWallet(userId: string, walletId: string, walletAddress: string, opts?: { force?: boolean }): Promise<void> {
    return this.auth.setPrivyWallet(userId, walletId, walletAddress, opts);
  }
  setHlBuilderApproval(userId: string, maxFeeTenthsBp: number): Promise<void> {
    return this.auth.setHlBuilderApproval(userId, maxFeeTenthsBp);
  }
  setPmClobCredentials(
    userId: string,
    creds: { key: string; secret: string; passphrase: string },
    opts?: { force?: boolean },
  ): Promise<void> {
    return this.auth.setPmClobCredentials(userId, creds, opts);
  }
  setPrivySolWallet(
    userId: string,
    walletId: string,
    walletAddress: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    return this.auth.setPrivySolWallet(userId, walletId, walletAddress, opts);
  }
  setUserCohort(userId: string, cohort: string | null): Promise<void> {
    return this.auth.setUserCohort(userId, cohort);
  }
  listUsersByCohort(cohort: string): Promise<User[]> {
    return this.auth.listUsersByCohort(cohort);
  }
  bindAgentKeyToUser(key: string, userId: string): Promise<void> { return this.auth.bindAgentKeyToUser(key, userId); }
  userForAgentKey(key: string): Promise<User | null> { return this.auth.userForAgentKey(key); }

  /* ── ledger / money ── */
  pushActivity(u: SessionUser, row: Omit<Activity, 'id' | 'at'>): Promise<Activity> { return this.ledger.pushActivity(u, row); }
  async savePushSubscription(u: SessionUser, input: PushSubscriptionInput): Promise<PushSubscriptionRecord> {
    const now = new Date();
    const [row] = await this.db
      .insert(nbPushSubscriptions)
      .values({
        userId: u.id,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [nbPushSubscriptions.userId, nbPushSubscriptions.endpoint],
        set: {
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return pushSubscriptionFromRow(row!);
  }
  async deletePushSubscription(u: SessionUser, endpoint: string): Promise<boolean> {
    const rows = await this.db
      .delete(nbPushSubscriptions)
      .where(and(eq(nbPushSubscriptions.userId, u.id), eq(nbPushSubscriptions.endpoint, endpoint)))
      .returning({ id: nbPushSubscriptions.id });
    return rows.length > 0;
  }
  async listPushSubscriptions(u: SessionUser): Promise<PushSubscriptionRecord[]> {
    return this.pushSubscriptionsForUser(u.id);
  }
  async pushSubscriptionsForUser(userId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(nbPushSubscriptions)
      .where(eq(nbPushSubscriptions.userId, userId))
      .orderBy(desc(nbPushSubscriptions.updatedAt));
    return rows.map(pushSubscriptionFromRow);
  }
  async saveExpoPushSubscription(u: SessionUser, input: ExpoPushSubscriptionInput): Promise<ExpoPushSubscriptionRecord> {
    // Dual-write: legacy token registrations get a deterministic installation id
    // so old clients coexist with installation-keyed devices under the new
    // unique index. Idempotent on (user_id, installation_id).
    return this.upsertDeviceByInstallation(u.id, {
      installationId: legacyInstallationId(input.token),
      expoPushToken: input.token,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
    });
  }
  async deleteExpoPushSubscription(u: SessionUser, token: string): Promise<boolean> {
    return this.pruneExpoPushToken(u.id, token);
  }
  async listExpoPushSubscriptions(u: SessionUser): Promise<ExpoPushSubscriptionRecord[]> {
    return this.expoPushSubscriptionsForUser(u.id);
  }
  async expoPushSubscriptionsForUser(userId: string): Promise<ExpoPushSubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(nbExpoPushSubscriptions)
      .where(eq(nbExpoPushSubscriptions.userId, userId))
      .orderBy(desc(nbExpoPushSubscriptions.updatedAt));
    return rows.map(expoPushSubscriptionFromRow);
  }
  async pruneExpoPushToken(userId: string, token: string): Promise<boolean> {
    const rows = await this.db
      .delete(nbExpoPushSubscriptions)
      .where(and(eq(nbExpoPushSubscriptions.userId, userId), eq(nbExpoPushSubscriptions.token, token)))
      .returning({ id: nbExpoPushSubscriptions.id });
    return rows.length > 0;
  }
  async usersWithExpoPushTokens(limit = 1000): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: nbExpoPushSubscriptions.userId })
      .from(nbExpoPushSubscriptions)
      .where(eq(nbExpoPushSubscriptions.enabled, true))
      .limit(limit);
    return rows.map((r) => r.userId);
  }
  async listPushEnabledUserIdsPage(opts: { after: string | null; limit: number }): Promise<string[]> {
    const { after, limit } = opts;
    const rows = await this.db
      .selectDistinct({ userId: nbExpoPushSubscriptions.userId })
      .from(nbExpoPushSubscriptions)
      .where(
        after
          ? and(eq(nbExpoPushSubscriptions.enabled, true), gt(nbExpoPushSubscriptions.userId, after))
          : eq(nbExpoPushSubscriptions.enabled, true),
      )
      .orderBy(asc(nbExpoPushSubscriptions.userId))
      .limit(limit);
    return rows.map((r) => r.userId);
  }

  /* ── NEO Session 1 — installation-keyed devices + notification prefs ── */
  async upsertDeviceByInstallation(userId: string, input: DeviceUpsertInput): Promise<ExpoPushSubscriptionRecord> {
    const now = new Date();
    // Omitted enabled/preferences are PRESERVED on update (kept out of the SET
    // clause) so an app-open re-register can't wipe prefs set via PATCH. On
    // insert the values below (default enabled=true) apply.
    const set: Record<string, unknown> = {
      token: input.expoPushToken,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
      updatedAt: now,
    };
    if (input.enabled !== undefined) set['enabled'] = input.enabled;
    if (input.preferences !== undefined) set['preferences'] = input.preferences;
    const [row] = await this.db
      .insert(nbExpoPushSubscriptions)
      .values({
        userId,
        installationId: input.installationId,
        token: input.expoPushToken,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        enabled: input.enabled ?? true,
        preferences: input.preferences ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [nbExpoPushSubscriptions.userId, nbExpoPushSubscriptions.installationId],
        set,
      })
      .returning();
    return expoPushSubscriptionFromRow(row!);
  }
  async deleteDeviceByInstallation(userId: string, installationId: string): Promise<boolean> {
    const rows = await this.db
      .delete(nbExpoPushSubscriptions)
      .where(and(
        eq(nbExpoPushSubscriptions.userId, userId),
        eq(nbExpoPushSubscriptions.installationId, installationId),
      ))
      .returning({ id: nbExpoPushSubscriptions.id });
    return rows.length > 0;
  }
  async listDevices(userId: string): Promise<ExpoPushSubscriptionRecord[]> {
    return this.expoPushSubscriptionsForUser(userId);
  }
  async setNotificationPreferences(
    userId: string,
    prefs: Record<string, boolean>,
    installationId?: string,
  ): Promise<Record<string, boolean>> {
    const now = new Date();
    const where = installationId
      ? and(
          eq(nbExpoPushSubscriptions.userId, userId),
          eq(nbExpoPushSubscriptions.installationId, installationId),
        )
      : eq(nbExpoPushSubscriptions.userId, userId);
    const rows = await this.db
      .update(nbExpoPushSubscriptions)
      .set({
        // jsonb merge-patch: existing prefs (or {}) concatenated with the patch.
        preferences: sql`coalesce(${nbExpoPushSubscriptions.preferences}, '{}'::jsonb) || ${JSON.stringify(prefs)}::jsonb`,
        updatedAt: now,
      })
      .where(where)
      .returning({ preferences: nbExpoPushSubscriptions.preferences });
    // Fold the post-update rows into one merged view. Seed with the patch so the
    // response always reflects it even when the user has no devices yet.
    return rows.reduce<Record<string, boolean>>(
      (acc, r) => ({ ...acc, ...((r.preferences as Record<string, boolean> | null) ?? {}) }),
      { ...prefs },
    );
  }

  /* ── NEO Session 1 — session revocation registry ── */
  async createSession(input: { userId: string; jti: string; installationId?: string | null }): Promise<void> {
    await this.db
      .insert(nbSessions)
      .values({ userId: input.userId, jti: input.jti, installationId: input.installationId ?? null })
      .onConflictDoNothing();
  }
  async revokeSession(userId: string, target: string | { all: true }): Promise<void> {
    const now = new Date();
    if (typeof target === 'object') {
      await this.db
        .update(nbSessions)
        .set({ revokedAt: now })
        .where(and(eq(nbSessions.userId, userId), isNull(nbSessions.revokedAt)));
      return;
    }
    await this.db
      .update(nbSessions)
      .set({ revokedAt: now })
      .where(and(
        eq(nbSessions.userId, userId),
        eq(nbSessions.jti, target),
        isNull(nbSessions.revokedAt),
      ));
  }
  async revokeSessionsByInstallation(
    userId: string,
    installationId: string,
    exceptJti: string,
  ): Promise<string[]> {
    // P1-4 — mirrors revokeSession above, scoped to the installation and
    // sparing the freshly-minted jti.
    const rows = await this.db
      .update(nbSessions)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(nbSessions.userId, userId),
        eq(nbSessions.installationId, installationId),
        ne(nbSessions.jti, exceptJti),
        isNull(nbSessions.revokedAt),
      ))
      .returning({ jti: nbSessions.jti });
    return rows.map((r) => r.jti);
  }
  async isSessionRevoked(jti: string): Promise<boolean> {
    const [row] = await this.db
      .select({ revokedAt: nbSessions.revokedAt })
      .from(nbSessions)
      .where(eq(nbSessions.jti, jti))
      .limit(1);
    if (!row) return false; // missing row = NOT revoked (pre-upgrade back-compat)
    return row.revokedAt != null;
  }
  send(u: SessionUser, amountUsd: number, to: string, opts?: { idempotencyKey?: string | null }): Promise<SendResult> { return this.ledger.send(u, amountUsd, to, opts); }
  sendClaim(u: SessionUser, amountUsd: number, email: string, opts?: { idempotencyKey?: string | null }): Promise<ClaimSendResult> { return this.claims.sendClaim(u, amountUsd, email, opts); }
  topUp(u: SessionUser, amountUsd: number, label?: string): Promise<Activity> { return this.ledger.topUp(u, amountUsd, label); }
  creditDeposit(u: SessionUser, amountUsd: number, opts: { txHash: string; chain: string }): Promise<{ activity: Activity; fresh: boolean }> { return this.ledger.creditDeposit(u, amountUsd, opts); }
  earnDeposit(
    u: User,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult> {
    return this.ledger.earnDeposit(u, amountUsd, opts);
  }
  earnWithdraw(
    u: User,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult> {
    return this.ledger.earnWithdraw(u, amountUsd, opts);
  }
  swap(u: SessionUser, amountUsd: number, direction: 'usd-eur' | 'eur-usd', opts?: { idempotencyKey?: string | null }): Promise<SwapResult> { return this.ledger.swap(u, amountUsd, direction, opts); }
  setEarnConfig(u: SessionUser, patch: Partial<{ earnByDefault: boolean; autoDivestOnSpend: boolean; divestThresholdUsd: number }>): Promise<User> { return this.ledger.setEarnConfig(u, patch); }
  autoDivestIfNeeded(u: SessionUser, amountUsd: number): Promise<void> { return this.ledger.autoDivestIfNeeded(u, amountUsd); }
  setPreferredVaultTier(u: SessionUser, tier: VaultTier): Promise<User> { return this.ledger.setPreferredVaultTier(u, tier); }
  setKillSwitch(u: SessionUser, on: boolean): Promise<void> { return this.ledger.setKillSwitch(u, on); }

  /* ── agents + policy ── */
  createAgent(u: SessionUser, name: string, perDayCapUsd: number, perTxCapUsd: number, allowlist: string[]): Promise<Agent> { return this.agents.createAgent(u, name, perDayCapUsd, perTxCapUsd, allowlist); }
  agent(u: SessionUser, id: string): Promise<Agent> { return this.agents.agent(u, id); }
  fundAgent(
    u: User,
    agentId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<Agent> { return this.agents.fundAgent(u, agentId, amountUsd, opts); }
  defundAgent(u: SessionUser, agentId: string): Promise<Agent> { return this.agents.defundAgent(u, agentId); }
  setAgentPaused(u: SessionUser, agentId: string, paused: boolean): Promise<Agent> { return this.agents.setAgentPaused(u, agentId, paused); }
  updateAgentPolicy(u: SessionUser, agentId: string, patch: Partial<AgentPolicy>): Promise<Agent> { return this.agents.updateAgentPolicy(u, agentId, patch); }
  x402Pay(
    u: User,
    agentId: string,
    endpoint: string,
    amountUsd: number,
    reason: string,
    settlementRef?: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<X402PayResult> { return this.agents.x402Pay(u, agentId, endpoint, amountUsd, reason, settlementRef, opts); }
  x402ApproveOnce(u: SessionUser, agentId: string, endpoint: string, amountUsd: number, reason: string, opts?: { idempotencyKey?: string | null }): Promise<X402PayResult> { return this.agents.x402ApproveOnce(u, agentId, endpoint, amountUsd, reason, opts); }
  createContract(u: SessionUser, name: string, endpointPath: string, method: 'GET' | 'POST', priceUsd: number, currency: 'USDC' | 'EURC'): Promise<X402Contract> { return this.agents.createContract(u, name, endpointPath, method, priceUsd, currency); }
  contract(u: SessionUser, id: string): Promise<X402Contract> { return this.agents.contract(u, id); }
  setContractStatus(u: SessionUser, id: string, status: 'live' | 'paused'): Promise<X402Contract> { return this.agents.setContractStatus(u, id, status); }
  findContractByEndpoint(endpointPath: string): Promise<{ id: string; payeeAddress: string | null } | null> { return this.agents.findContractByEndpoint(endpointPath); }
  findContractById(contractId: string): Promise<{ id: string; payeeAddress: string | null } | null> { return this.agents.findContractById(contractId); }
  getAgentWallet(agentId: string): Promise<AgentWalletRecord | null> { return this.agents.getAgentWallet(agentId); }
  setAgentWallet(agentId: string, input: AgentWalletRecord): Promise<AgentWalletRecord> { return this.agents.setAgentWallet(agentId, input); }
  recordAgentDigestSent(agentId: string, windowSpentUsd: number): Promise<void> { return this.agents.recordAgentDigestSent(agentId, windowSpentUsd); }
  findAgentsDueForDigest(cutoff: Date): Promise<AgentDigestDue[]> { return this.agents.findAgentsDueForDigest(cutoff); }

  /* ── cards / kyc ── */
  setCardFrozen(u: SessionUser, frozen: boolean): Promise<void> { return this.cards.setCardFrozen(u, frozen); }
  setCardDayLimit(u: SessionUser, limit: number): Promise<void> { return this.cards.setCardDayLimit(u, limit); }
  setKyc(u: SessionUser, status: KycStatus): Promise<void> { return this.kyc.setKyc(u, status); }

  /* ── facilitator: offers / checkout / payments / stripe ── */
  createOffer(u: SessionUser, input: OfferInput, opts?: { livemode?: boolean; idempotencyKey?: string | null }): Promise<Offer> { return this.payments.createOffer(u, input, opts); }
  listOffers(u: SessionUser, opts?: { livemode?: boolean }): Promise<Offer[]> { return this.payments.listOffers(u, opts); }
  sellerOffer(u: SessionUser, id: string): Promise<Offer> { return this.payments.sellerOffer(u, id); }
  updateOffer(u: SessionUser, id: string, patch: Partial<OfferInput> & { active?: boolean }): Promise<Offer> { return this.payments.updateOffer(u, id, patch); }
  checkoutView(offerId: string): Promise<CheckoutView | null> { return this.payments.checkoutView(offerId); }
  payOffer(offerId: string, opts: { buyerEmail: string | null; method: string; idempotencyKey?: string | null; buyerUser?: User | null }): Promise<PayResult> { return this.payments.payOffer(offerId, opts); }
  listPayments(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payment[]> { return this.payments.listPayments(u, opts); }
  payment(u: SessionUser, id: string): Promise<Payment> { return this.payments.payment(u, id); }
  createStripeSession(input: CreateStripeSessionInput): Promise<StripeSessionRecord> { return this.payments.createStripeSession(input); }
  findStripeSession(sessionId: string): Promise<StripeSessionRecord | null> { return this.payments.findStripeSession(sessionId); }
  markStripeSessionCompleted(sessionId: string): Promise<StripeSessionRecord | null> { return this.payments.markStripeSessionCompleted(sessionId); }
  markStripeSessionStatus(sessionId: string, status: 'expired' | 'failed'): Promise<StripeSessionRecord | null> { return this.payments.markStripeSessionStatus(sessionId, status); }

  /* ── facilitator: API keys + sub-accounts + payouts + subscriptions + webhooks ── */
  createApiKey(u: SessionUser, label: string | null, livemode: boolean): Promise<ApiKeyCreated> { return this.subscriptions.createApiKey(u, label, livemode); }
  listApiKeys(u: SessionUser): Promise<ApiKey[]> { return this.subscriptions.listApiKeys(u); }
  revokeApiKey(u: SessionUser, id: string): Promise<ApiKey | null> { return this.subscriptions.revokeApiKey(u, id); }
  userForApiKey(secret: string): Promise<{ user: User; livemode: boolean } | null> { return this.subscriptions.userForApiKey(secret); }
  createSubAccount(u: SessionUser, name: string): Promise<SubAccount> { return this.subscriptions.createSubAccount(u, name); }
  listSubAccounts(u: SessionUser): Promise<SubAccount[]> { return this.subscriptions.listSubAccounts(u); }
  subAccount(u: SessionUser, id: string): Promise<SubAccount> { return this.subscriptions.subAccount(u, id); }
  createPayout(u: SessionUser, input: PayoutInput, opts?: { livemode?: boolean; idempotencyKey?: string | null }): Promise<Payout> { return this.subscriptions.createPayout(u, input, opts); }
  listPayouts(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payout[]> { return this.subscriptions.listPayouts(u, opts); }
  payout(u: SessionUser, id: string): Promise<Payout> { return this.subscriptions.payout(u, id); }
  listSubscriptions(u: SessionUser, opts?: { livemode?: boolean }): Promise<Subscription[]> { return this.subscriptions.listSubscriptions(u, opts); }
  subscription(u: SessionUser, id: string): Promise<Subscription> { return this.subscriptions.subscription(u, id); }
  renewSubscription(u: SessionUser, id: string, opts?: { dueBefore?: Date }): Promise<Subscription> { return this.subscriptions.renewSubscription(u, id, opts); }
  cancelSubscription(u: SessionUser, id: string): Promise<Subscription> { return this.subscriptions.cancelSubscription(u, id); }
  findSubscriptionsDueBefore(cutoff: Date): Promise<Subscription[]> { return this.subscriptions.findSubscriptionsDueBefore(cutoff); }
  registerWebhook(u: SessionUser, url: string): Promise<WebhookEndpoint> { return this.subscriptions.registerWebhook(u, url); }
  listWebhooks(u: SessionUser): Promise<WebhookEndpoint[]> { return this.subscriptions.listWebhooks(u); }
  webhooksForSeller(sellerId: string): Promise<WebhookEndpoint[]> { return this.subscriptions.webhooksForSeller(sellerId); }

  /* ── Bridge.xyz compliance perimeter ── */
  setBridgeCustomer(u: SessionUser, customerId: string): Promise<void> { return this.bridge.setBridgeCustomer(u, customerId); }
  saveVirtualAccount(u: SessionUser, va: Omit<VirtualAccount, 'id' | 'createdAt'>): Promise<VirtualAccount> { return this.bridge.saveVirtualAccount(u, va); }
  listVirtualAccounts(u: SessionUser): Promise<VirtualAccount[]> { return this.bridge.listVirtualAccounts(u); }
  userForBridgeCustomer(customerId: string): Promise<User | null> { return this.bridge.userForBridgeCustomer(customerId); }
  applyBridgeDeposit(customerId: string, amountUsd: number, ref: string): Promise<boolean> { return this.bridge.applyBridgeDeposit(customerId, amountUsd, ref); }
  savePayoutMethod(u: SessionUser, input: { type: PayoutMethodType; externalAccountId: string; label: string; livemode: boolean }): Promise<PayoutMethod> { return this.bridge.savePayoutMethod(u, input); }
  listPayoutMethods(u: SessionUser): Promise<PayoutMethod[]> { return this.bridge.listPayoutMethods(u); }
  createBridgeTransfer(u: SessionUser, input: { payoutMethodId: string; amountUsd: number; externalRef: string | null }): Promise<BridgeTransfer> { return this.bridge.createBridgeTransfer(u, input); }
  createBridgeTransferDebit(u: SessionUser, input: { payoutMethodId: string; amountUsd: number; idempotencyKey: string; label: string }): Promise<{ transfer: BridgeTransfer; fresh: boolean }> { return this.bridge.createBridgeTransferDebit(u, input); }
  setBridgeTransferExternalRef(id: string, externalRef: string): Promise<BridgeTransfer> { return this.bridge.setBridgeTransferExternalRef(id, externalRef); }
  failBridgeTransferById(id: string): Promise<BridgeTransfer | null> { return this.bridge.failBridgeTransferById(id); }
  markTransferStatus(externalRef: string, status: 'completed' | 'failed', expected?: { amountUsd?: number; externalAccountId?: string | null }): Promise<BridgeTransfer | null> { return this.bridge.markTransferStatus(externalRef, status, expected); }
  userForBridgeTransfer(externalRef: string): Promise<User | null> { return this.bridge.userForBridgeTransfer(externalRef); }

  /* ── claims (email-claim escrow) ── */
  recordClaim(u: SessionUser, email: string, amountUsd: number): Promise<ClaimRecord> { return this.claims.recordClaim(u, email, amountUsd); }
  getClaim(slug: string): Promise<ClaimRecord | null> { return this.claims.getClaim(slug); }
  claimFunds(slug: string, recipientEmail: string): Promise<{ amountUsd: number; recipient: User } | null> { return this.claims.claimFunds(slug, recipientEmail); }
  claimPendingFundsForEmail(email: string): Promise<{ claimed: number; amountUsd: number }> { return this.claims.claimPendingFundsForEmail(email); }
  listClaims(u: SessionUser): Promise<ClaimRecord[]> { return this.claims.listClaims(u); }
  expireClaimsBefore(cutoff: Date): Promise<{ expired: ClaimRecord[]; refundsApplied: number }> { return this.claims.expireClaimsBefore(cutoff); }

  /* ── markets ── */
  placeMarketOrder(u: SessionUser, input: MarketOrderInput): Promise<MarketPosition> { return this.markets.placeMarketOrder(u, input); }
  reserveMarketOrder(u: SessionUser, input: MarketOrderReservationInput): Promise<MarketOrderReservationResult> { return this.markets.reserveMarketOrder(u, input); }
  completeMarketOrder(positionId: string, input: MarketOrderCompletionInput): Promise<MarketPosition> { return this.markets.completeMarketOrder(positionId, input); }
  failMarketOrder(positionId: string): Promise<MarketPosition | null> { return this.markets.failMarketOrder(positionId); }
  cancelMarketOrder(u: SessionUser, externalRef: string): Promise<MarketPosition | null> { return this.markets.cancelMarketOrder(u, externalRef); }
  reduceMarketPosition(u: SessionUser, positionId: string, reduceQtyUsd: number): Promise<MarketPosition | null> { return this.markets.reduceMarketPosition(u, positionId, reduceQtyUsd); }
  listMarketPositions(u: SessionUser, venue?: MarketVenue): Promise<MarketPosition[]> { return this.markets.listMarketPositions(u, venue); }
  recordLifecycleTransition(positionId: string, input: LifecycleTransitionInput): Promise<MarketPosition | null> { return this.markets.recordLifecycleTransition(positionId, input); }
  getMarketPositionById(positionId: string): Promise<MarketPosition | null> { return this.markets.getMarketPositionById(positionId); }
  listMarketOrders(u: SessionUser, filter?: { venue?: MarketVenue; symbol?: string; statuses?: string[]; fromMs?: number; toMs?: number; limit?: number }): Promise<MarketPosition[]> { return this.markets.listMarketOrders(u, filter); }

  /* ── campaigns + perks ── */
  createCampaign(creator: User, input: CampaignInput): Promise<Campaign> { return this.campaigns.createCampaign(creator, input); }
  listCampaigns(filter?: { status?: CampaignStatus }): Promise<Campaign[]> { return this.campaigns.listCampaigns(filter); }
  submitToCampaign(u: SessionUser, campaignId: string, input: { clipUrl: string; platform: CampaignPlatform; viewsAttested: number }): Promise<CampaignSubmission> { return this.campaigns.submitToCampaign(u, campaignId, input); }
  approveSubmission(submissionId: string, viewsVerified: number): Promise<CampaignSubmission> { return this.campaigns.approveSubmission(submissionId, viewsVerified); }
  releaseBonus(campaignId: string, submissionId: string): Promise<{ submission: CampaignSubmission; paidUsd: number; tier: PerkTier; multiplier: number }> { return this.campaigns.releaseBonus(campaignId, submissionId); }
  getPerks(u: SessionUser): Promise<{ tier: PerkTier; points: number; multiplier: number; lifetimeEarnedUsd: number }> { return this.campaigns.getPerks(u); }
  awardPoints(u: SessionUser, source: 'earn' | 'cardSpend', usd: number): Promise<{ tier: PerkTier; points: number }> { return this.campaigns.awardPoints(u, source, usd); }

  /* ── Tier 3 #14 — append-only audit log ── */
  recordAuditEntry(entry: AuditLogEntry): Promise<{ id: string }> { return this.auditLog.recordAuditEntry(entry); }
  listAuditEntries(filter: AuditLogFilter): Promise<AuditLogRecord[]> { return this.auditLog.listAuditEntries(filter); }

  /* ── ops ── */
  async ping(): Promise<boolean> {
    try { await this.db.execute(sql`select 1`); return true; } catch { return false; }
  }
  async dispose(): Promise<void> { this.bus.removeAllListeners(); }
}

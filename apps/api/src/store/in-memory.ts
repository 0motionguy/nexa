/**
 * In-memory Store impl — DEMO_MODE default. Same seed numbers as app-v2.html
 * so the wired frontend shows familiar data. Lost on restart.
 *
 * Sprint 12 Phase 3 — the 1,734-LOC monolith was split into one shared
 * InMemoryState kernel under store/core/in-memory-state.ts plus the same
 * twelve domain modules that the postgres impl has, under store/in-memory/.
 * This file is now a thin facade that wires the modules up and delegates
 * every Store-interface method to the correct module.
 *
 * Policy engine lives in store/in-memory/agents.ts (server-side, never
 * trusts agent-supplied context). The PostgresStore mirrors these gates
 * verbatim inside row-locking transactions for production.
 */

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { InMemoryState } from './core/in-memory-state.js';
import { InMemoryAgents } from './in-memory/agents.js';
import { InMemoryAuditLog } from './in-memory/audit-log.js';
import { InMemoryAuth } from './in-memory/auth.js';
import { InMemoryBridge } from './in-memory/bridge.js';
import { InMemoryCampaigns } from './in-memory/campaigns.js';
import { InMemoryCards } from './in-memory/cards.js';
import { InMemoryClaims } from './in-memory/claims.js';
import { InMemoryKyc } from './in-memory/kyc.js';
import { InMemoryLedger } from './in-memory/ledger.js';
import { InMemoryMarkets } from './in-memory/markets.js';
import { InMemoryPayments } from './in-memory/payments.js';
import { InMemorySubscriptions } from './in-memory/subscriptions.js';
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
  type DeviceUpsertInput,
  type ExpoPushSubscriptionInput, type ExpoPushSubscriptionRecord, type SendResult, type SessionUser, type Store,
  type StripeSessionRecord, type SubAccount,
  type Subscription, type SwapResult, type User, type VaultTier, type VirtualAccount,
  type WebhookEndpoint, type X402Contract, type X402PayResult,
} from './types.js';

function pushSubscriptionKey(userId: string, endpoint: string): string {
  return `${userId}\0${endpoint}`;
}

/** NEO Session 1 — expo devices are keyed by (userId, installationId). */
function expoDeviceKey(userId: string, installationId: string): string {
  return `${userId}\0${installationId}`;
}

/** Deterministic installation id for legacy `/push/expo-subscribe` rows so the
 *  opaque-token channel coexists with installation-keyed devices. MUST match the
 *  SQL backfill in migration 0035 ('legacy-' || left(md5(token),16)). */
function legacyInstallationId(token: string): string {
  return 'legacy-' + createHash('md5').update(token).digest('hex').slice(0, 16);
}

interface InMemorySessionRow {
  userId: string;
  jti: string;
  installationId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export class InMemoryStore implements Store {
  readonly bus = new EventEmitter();
  private state: InMemoryState;
  private auth: InMemoryAuth;
  private ledger: InMemoryLedger;
  private agents: InMemoryAgents;
  private cards: InMemoryCards;
  private kyc: InMemoryKyc;
  private payments: InMemoryPayments;
  private subscriptions: InMemorySubscriptions;
  private bridge: InMemoryBridge;
  private claims: InMemoryClaims;
  private markets: InMemoryMarkets;
  private campaigns: InMemoryCampaigns;
  private auditLog: InMemoryAuditLog;
  private pushSubscriptions = new Map<string, PushSubscriptionRecord>();
  private expoPushSubscriptions = new Map<string, ExpoPushSubscriptionRecord>();
  /** NEO Session 1 — session revocation registry, keyed by jti. */
  private sessions = new Map<string, InMemorySessionRow>();

  constructor() {
    this.state = new InMemoryState(this.bus);
    // payments must exist before auth (auth.upsertUserByEmail seeds a demo
    // offer via payments.createOffer); ledger then binds back into payments.
    this.payments = new InMemoryPayments(this.state);
    this.auth = new InMemoryAuth(this.state, this.payments);
    this.ledger = new InMemoryLedger(this.state);
    this.subscriptions = new InMemorySubscriptions(this.state);
    this.payments.bindSiblings(this.subscriptions, this.ledger);
    this.agents = new InMemoryAgents(this.state);
    this.cards = new InMemoryCards();
    this.kyc = new InMemoryKyc(this.state);
    this.bridge = new InMemoryBridge(this.state, this.ledger);
    this.claims = new InMemoryClaims(this.state, this.auth, this.ledger);
    this.markets = new InMemoryMarkets(this.state);
    this.campaigns = new InMemoryCampaigns(this.state, this.ledger);
    this.auditLog = new InMemoryAuditLog();
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
  async pushActivity(u: SessionUser, row: Omit<Activity, 'id' | 'at'>): Promise<Activity> {
    // Scale wave 3 — resolve the canonical map object; activity pushed onto a
    // detached session projection would never reach reads or the event bus.
    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    return this.state.pushActivity(live, row);
  }
  async savePushSubscription(u: SessionUser, input: PushSubscriptionInput): Promise<PushSubscriptionRecord> {
    const key = pushSubscriptionKey(u.id, input.endpoint);
    const existing = this.pushSubscriptions.get(key);
    const now = new Date().toISOString();
    const record: PushSubscriptionRecord = existing
      ? {
        ...existing,
        endpoint: input.endpoint,
        keys: input.keys,
        userAgent: input.userAgent ?? null,
        updatedAt: now,
      }
      : {
        id: randomUUID(),
        userId: u.id,
        endpoint: input.endpoint,
        keys: input.keys,
        userAgent: input.userAgent ?? null,
        createdAt: now,
        updatedAt: now,
      };
    this.pushSubscriptions.set(key, record);
    return record;
  }
  async deletePushSubscription(u: SessionUser, endpoint: string): Promise<boolean> {
    return this.pushSubscriptions.delete(pushSubscriptionKey(u.id, endpoint));
  }
  async listPushSubscriptions(u: SessionUser): Promise<PushSubscriptionRecord[]> {
    return this.pushSubscriptionsForUser(u.id);
  }
  async saveExpoPushSubscription(u: SessionUser, input: ExpoPushSubscriptionInput): Promise<ExpoPushSubscriptionRecord> {
    // Dual-write legacy token registrations under a deterministic installation
    // id so they coexist with installation-keyed devices (parity with postgres).
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
    return Array.from(this.expoPushSubscriptions.values())
      .filter((sub) => sub.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async pruneExpoPushToken(userId: string, token: string): Promise<boolean> {
    for (const [key, rec] of this.expoPushSubscriptions) {
      if (rec.userId === userId && rec.token === token) {
        this.expoPushSubscriptions.delete(key);
        return true;
      }
    }
    return false;
  }
  async usersWithExpoPushTokens(limit = 1000): Promise<string[]> {
    const ids = new Set<string>();
    for (const sub of this.expoPushSubscriptions.values()) {
      if (sub.enabled !== false) ids.add(sub.userId);
    }
    return Array.from(ids).slice(0, limit);
  }
  async listPushEnabledUserIdsPage(opts: { after: string | null; limit: number }): Promise<string[]> {
    const { after, limit } = opts;
    const ids = new Set<string>();
    for (const sub of this.expoPushSubscriptions.values()) {
      if (sub.enabled !== false) ids.add(sub.userId);
    }
    // Explicit sort — Set insertion order isn't a keyset-stable total order.
    const sorted = Array.from(ids).sort();
    const page = after ? sorted.filter((id) => id > after) : sorted;
    return page.slice(0, limit);
  }

  /* ── NEO Session 1 — installation-keyed devices + notification prefs ── */
  async upsertDeviceByInstallation(userId: string, input: DeviceUpsertInput): Promise<ExpoPushSubscriptionRecord> {
    const key = expoDeviceKey(userId, input.installationId);
    const existing = this.expoPushSubscriptions.get(key);
    const now = new Date().toISOString();
    const record: ExpoPushSubscriptionRecord = existing
      ? {
        ...existing,
        token: input.expoPushToken,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        // Omitted enabled/preferences are preserved (parity with postgres SET).
        enabled: input.enabled ?? existing.enabled,
        preferences: input.preferences !== undefined ? input.preferences : existing.preferences,
        updatedAt: now,
      }
      : {
        id: randomUUID(),
        userId,
        installationId: input.installationId,
        token: input.expoPushToken,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        enabled: input.enabled ?? true,
        preferences: input.preferences ?? null,
        createdAt: now,
        updatedAt: now,
      };
    this.expoPushSubscriptions.set(key, record);
    // Cap per user (parity with the old in-memory sender): evict oldest devices.
    const mine = Array.from(this.expoPushSubscriptions.values()).filter((s) => s.userId === userId);
    if (mine.length > 10) {
      mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const dead of mine.slice(0, mine.length - 10)) {
        this.expoPushSubscriptions.delete(expoDeviceKey(dead.userId, dead.installationId));
      }
    }
    return record;
  }
  async deleteDeviceByInstallation(userId: string, installationId: string): Promise<boolean> {
    return this.expoPushSubscriptions.delete(expoDeviceKey(userId, installationId));
  }
  async listDevices(userId: string): Promise<ExpoPushSubscriptionRecord[]> {
    return this.expoPushSubscriptionsForUser(userId);
  }
  async setNotificationPreferences(
    userId: string,
    prefs: Record<string, boolean>,
    installationId?: string,
  ): Promise<Record<string, boolean>> {
    const now = new Date().toISOString();
    const merged: Record<string, boolean> = { ...prefs };
    for (const rec of this.expoPushSubscriptions.values()) {
      if (rec.userId !== userId) continue;
      if (installationId && rec.installationId !== installationId) continue;
      rec.preferences = { ...(rec.preferences ?? {}), ...prefs };
      rec.updatedAt = now;
      Object.assign(merged, rec.preferences);
    }
    return merged;
  }

  /* ── NEO Session 1 — session revocation registry ── */
  async createSession(input: { userId: string; jti: string; installationId?: string | null }): Promise<void> {
    if (!this.sessions.has(input.jti)) {
      this.sessions.set(input.jti, {
        userId: input.userId,
        jti: input.jti,
        installationId: input.installationId ?? null,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      });
    }
  }
  async revokeSession(userId: string, target: string | { all: true }): Promise<void> {
    const now = new Date().toISOString();
    if (typeof target === 'object') {
      for (const s of this.sessions.values()) {
        if (s.userId === userId && !s.revokedAt) s.revokedAt = now;
      }
      return;
    }
    const s = this.sessions.get(target);
    if (s && s.userId === userId && !s.revokedAt) s.revokedAt = now;
  }
  async revokeSessionsByInstallation(
    userId: string,
    installationId: string,
    exceptJti: string,
  ): Promise<string[]> {
    // P1-4 — mirrors revokeSession above, scoped to the installation and
    // sparing the freshly-minted jti.
    const now = new Date().toISOString();
    const revoked: string[] = [];
    for (const s of this.sessions.values()) {
      if (
        s.userId === userId &&
        s.installationId === installationId &&
        s.jti !== exceptJti &&
        !s.revokedAt
      ) {
        s.revokedAt = now;
        revoked.push(s.jti);
      }
    }
    return revoked;
  }
  async isSessionRevoked(jti: string): Promise<boolean> {
    const s = this.sessions.get(jti);
    if (!s) return false; // missing row = NOT revoked (pre-upgrade back-compat)
    return s.revokedAt != null;
  }
  async pushSubscriptionsForUser(userId: string): Promise<PushSubscriptionRecord[]> {
    return Array.from(this.pushSubscriptions.values())
      .filter((sub) => sub.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  async ping(): Promise<boolean> { return true; }

  async dispose(): Promise<void> {
    this.bus.removeAllListeners();
    this.state.usersById.clear();
    this.state.usersByEmail.clear();
    this.sessions.clear();
    this.auth.clearAgentKeys();
    this.payments.clearAll();
    this.subscriptions.clearAll();
    this.bridge.clearAll();
    this.claims.clearAll();
    this.markets.clearAll();
    this.campaigns.clearAll();
    this.auditLog.clearAll();
    // Sprint 17 (Sweep #6) — agents domain owns side-Maps (wallets + digests)
    // that survived dispose before; vitest module resets carried them across
    // spec files. Reset alongside the other domains.
    this.agents.clearAll();
  }
}

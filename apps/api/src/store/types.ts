/**
 * Store interface — the persistence contract consumed by routes, MCP, auth.
 *
 * Two impls live behind this:
 *   - InMemoryStore (store/in-memory.ts) — DEMO_MODE default, lost on restart
 *   - PostgresStore (store/postgres.ts) — DATABASE_URL set, durable
 *
 * Routes always await; the in-memory impl returns resolved Promises so the
 * surface stays identical to callers. Adding a Postgres backend is one factory
 * swap (createStore in store/index.ts) and zero handler edits.
 */

import type { EventEmitter } from 'node:events';

export interface ChainMirror {
  /** Fire after a successful earnDeposit ledger move. */
  depositEarn(u: SessionUser, amountUsd: number, tier?: VaultTier): Promise<void>;
  /** Fire after a successful earnWithdraw ledger move. */
  withdrawEarn(u: SessionUser, amountUsd: number, tier?: VaultTier): Promise<void>;
}

export type TxKind =
  | 'in'
  | 'out'
  | 'card'
  | 'agent'
  | 'swap'
  | 'x402'
  | 'amazon'
  | 'spotify'
  | 'uber';

export interface Activity {
  id: string;
  n: string;
  s: string;
  a: string;
  k: TxKind;
  pos?: boolean;
  logo?: string;
  at: string;
  status?: 'pending' | 'submitted' | 'confirmed' | 'failed' | string;
  venue?: string;
  signer?: string;
  txHash?: string;
  chain?: string;
  explorerUrl?: string;
}

export interface AgentPolicy {
  perTxCapUsd: number;
  perDayCapUsd: number;
  /** Hostname allowlist (e.g. "api.exa.ai"). Empty = nothing allowed. */
  endpointAllowlist: string[];
  humanApprovalThresholdUsd: number;
  expiresAt: string | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  balanceUsd: number;
  spentTodayUsd: number;
  policy: AgentPolicy;
  state: 'live' | 'ready' | 'paused' | 'review' | 'blocked';
  createdAt: string;
}

export interface X402Contract {
  id: string;
  name: string;
  endpointPath: string;
  method: 'GET' | 'POST';
  priceUsd: number;
  currency: 'USDC' | 'EURC';
  status: 'live' | 'paused';
  requestsToday: number;
  revenueTodayUsd: number;
  paidSuccessRate: number;
  /**
   * Stack upgrades Phase 3 — vendor EVM address that receives x402 settlements
   * for this contract. Null = legacy self-pay (the agent's own wallet becomes
   * both `from` and `to`); the settler logs a warn when it falls back.
   */
  payeeAddress?: string | null;
}

export interface X402Event {
  id: string;
  contractId: string | null;
  buyer: string;
  buyerType: 'agent' | 'human';
  resource: string;
  amountUsd: number;
  httpStatus: number;
  ref: string;
  at: string;
}

export type KycStatus = 'none' | 'pending' | 'verified' | 'failed';

/**
 * A Bridge.xyz-issued deposit account. USD = ACH (routing + account); EUR = SEPA
 * (iban + bic). Demo issues plausible mock numbers; real numbers arrive once
 * BRIDGE_API_KEY is set and KYB has cleared.
 */
export interface VirtualAccount {
  id: string;
  currency: 'USD' | 'EUR';
  routingNumber: string | null;
  accountNumber: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string;
  livemode: boolean;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  /** Privy DID from live auth. Null/undefined means demo OTP or legacy user. */
  privyDid?: string | null;
  /** Sprint 16.4 — cached Privy EVM walletId for Hyperliquid live trading. */
  privyWalletId?: string | null;
  /** Sprint 16.4 — cached EVM address paired with privyWalletId. */
  privyWalletAddress?: string | null;
  /** Sprint 16.4 — set when backend completed approveBuilderFee for our HL builder. */
  hlBuilderApprovedAt?: string | null;
  /** Sprint 16.4 — max fee in tenths-of-bp user authorised for our builder. */
  hlBuilderMaxFeeTenthsBp?: number | null;
  /**
   * Audit 2026-06-19 — Polymarket CLOB L2 credentials, derived once per
   * user via clob.createOrDeriveApiKey. Null until first live trade attempt.
   */
  pmClobKey?: string | null;
  pmClobSecret?: string | null;
  pmClobPassphrase?: string | null;
  /** Audit 2026-06-19 — Privy Solana server-wallet id (paired with EVM above). */
  privySolWalletId?: string | null;
  /** Audit 2026-06-19 — Solana base58 address paired with privySolWalletId. */
  privySolWalletAddress?: string | null;
  /** Audit 2026-06-19 — opt-in test cohort tag (e.g. `tester-2026Q3`); null = regular user. */
  cohort?: string | null;
  balUsd: number;
  /** EUR cash balance (EURC) credited/debited by /swap. Added 2026-07-02 —
   *  previously usd→eur only debited USD (the EUR side vanished from every
   *  surface) and eur→usd credited USD without any EUR debit. */
  eurUsd: number;
  /** Sandbox (sk_test_) balance — fake money, isolated from the live ledger. */
  sandboxBalUsd: number;
  earnUsd: number;
  earnApy: number;
  cardFrozen: boolean;
  cardDayLimitUsd: number;
  killSwitch: boolean;
  kycStatus: KycStatus;
  /** Bridge.xyz customer id once a customer record exists (null = not yet). */
  bridgeCustomerId: string | null;
  /** Sprint 10 Item A — opt-in auto-deposit of topUp tail into earn. */
  earnByDefault: boolean;
  /** Sprint 10 Item A — opt-in auto-withdraw from earn when balUsd is short. */
  autoDivestOnSpend: boolean;
  /** Sprint 10 Item A — floor maintained in balUsd before auto-deposits hit earn. */
  divestThresholdUsd: number;
  /**
   * Stack upgrades Upgrade 1 — picks between the Morpho-curated 'standard'
   * vault and the highest-APY 'higher_yield' vault. Optional on the snapshot
   * so Sprint 10 consumers that destructure User keep typechecking before the
   * earn-router lands; defaults to 'standard' in the store impls.
   */
  preferredVaultTier?: VaultTier;
  virtualAccounts: VirtualAccount[];
  activity: Activity[];
  agents: Agent[];
  contracts: X402Contract[];
  x402Events: X402Event[];
}

/**
 * Scale wave 3 (2026-07-16) — the session-auth projection of User.
 *
 * `requireSession` hydrates a user on EVERY authed request. The full User
 * aggregate costs ~9 queries (50 activity rows, 50 x402 events, agents +
 * policies, contracts, virtual accounts); under the 100-user staging ramp
 * that per-request storm queued on the pool and pushed /me/profile to
 * p50 ≈ 530ms on localhost. Session auth only ever needs the scalar row
 * fields, so the middleware hydrates this projection instead (3 primary-key
 * reads: users, user_state, card_state).
 *
 * Deliberately a DISTINCT type rather than `User` with empty arrays: money
 * paths (x402 idempotency replay, spend caps) read `u.activity` — an empty
 * array there would silently skip replay detection and double-charge.
 * Omitting the fields makes any aggregate access on a session user a TYPE
 * ERROR; such routes must explicitly call `store.user(u.id)`.
 */
export type SessionUser = Omit<
  User,
  'virtualAccounts' | 'activity' | 'agents' | 'contracts' | 'x402Events'
>;

export class PolicyError extends Error {
  constructor(
    public code:
      | 'kill_switch'
      | 'agent_paused'
      | 'per_tx_cap'
      | 'per_day_cap'
      | 'endpoint_not_allowed'
      | 'needs_approval'
      | 'needs_human_approval'
      | 'insufficient_funds'
      | 'expired',
    message: string,
  ) {
    super(message);
  }
}

/** Mutation result types so impls share return shapes. */
export interface SendResult {
  claim: boolean;
  activity: Activity;
  fresh?: boolean;
}
export interface ClaimSendResult extends SendResult {
  claim: true;
  claimRecord: ClaimRecord;
}
export interface SwapResult {
  out: number;
  rate: number;
  fresh?: boolean;
}
export interface EarnMoveResult {
  fresh: boolean;
}
export interface X402PayResult {
  receipt: X402Event;
  activity: Activity;
}

/* ──────────────────────────────────────────────────────────────────────────
 * MAZE facilitator — the get-paid layer (MAYZ-FACILITATOR.md primitives).
 * Three objects: Offer (a thing sold) → Checkout (public link) → Payment.
 * Offers/payments index globally by offerId because the public checkout has no
 * session — payOffer resolves the seller from the offer and credits their ledger.
 * ────────────────────────────────────────────────────────────────────────── */

export type OfferType = 'one_time' | 'subscription';
export type FulfillmentKind = 'url' | 'message' | 'none';
export type FiatCurrency = 'USD' | 'EUR';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

/** One slice of a sale. Exactly one of subAccountId | email; percent is 0–100. */
export interface SplitRule {
  subAccountId?: string | null;
  email?: string | null;
  percent: number;
}

/** Seller-supplied fields for create/update. */
export interface OfferInput {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  amountUsd: number;
  currency?: FiatCurrency;
  type?: OfferType;
  fulfillmentKind?: FulfillmentKind;
  fulfillmentValue?: string | null;
  /** Route the base proceeds to a sub-account instead of the seller's main balance. */
  subAccountId?: string | null;
  /** Auto-split the sale across sub-accounts (balance credit) + emails (auto-payout). */
  splits?: SplitRule[] | null;
}

export interface Offer {
  id: string;
  sellerId: string; // internal — never exposed on the public checkout
  title: string;
  description: string | null;
  imageUrl: string | null;
  amountUsd: number;
  currency: FiatCurrency;
  type: OfferType;
  fulfillmentKind: FulfillmentKind;
  fulfillmentValue: string | null;
  active: boolean;
  /** false = created by an sk_test_ key (sandbox); true = live (app + sk_live_). */
  livemode: boolean;
  subAccountId: string | null;
  splits: SplitRule[];
  createdAt: string;
}

export interface Payment {
  id: string;
  offerId: string;
  sellerId: string;
  offerTitle: string;
  amountUsd: number;
  currency: FiatCurrency;
  buyerEmail: string | null;
  method: string; // 'demo' | 'card' | 'balance'
  status: PaymentStatus;
  fulfillmentSent: boolean;
  livemode: boolean;
  createdAt: string;
}

/** Public API key (sk_test_/sk_live_). The raw secret is shown ONCE at creation. */
export interface ApiKey {
  id: string;
  sellerId: string;
  prefix: 'sk_test' | 'sk_live';
  last4: string;
  label: string | null;
  livemode: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface ApiKeyCreated extends ApiKey {
  /** Full secret — returned only at creation; stored hashed, never in clear. */
  secret: string;
}

export interface WebhookEndpoint {
  id: string;
  sellerId: string;
  url: string;
  secret: string; // whsec_...
  active: boolean;
  createdAt: string;
}

/** Public, PII-light projection rendered on the hosted checkout page. */
export interface CheckoutView {
  offerId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  amountUsd: number;
  currency: FiatCurrency;
  type: OfferType;
  sellerName: string;
  active: boolean;
}

/** A named isolated balance under one seller (one KYC, many businesses). */
export interface SubAccount {
  id: string;
  sellerId: string;
  name: string;
  balUsd: number;
  sandboxBalUsd: number;
  createdAt: string;
}

export type PayoutStatus = 'pending' | 'paid' | 'failed';

export interface PayoutInput {
  amountUsd: number;
  destination: string; // email or account ref (free-form in demo)
  method?: string; // 'email' | 'bank' | 'card' (demo defaults 'email')
  note?: string | null;
}

export interface Payout {
  id: string;
  sellerId: string;
  amountUsd: number;
  currency: FiatCurrency;
  destination: string;
  method: string;
  note: string | null;
  status: PayoutStatus;
  livemode: boolean;
  createdAt: string;
}

export type SubscriptionStatus = 'active' | 'canceled' | 'past_due';

/** A recurring agreement, created when a `subscription`-type offer is paid. */
export interface Subscription {
  id: string;
  sellerId: string;
  offerId: string;
  offerTitle: string;
  buyerEmail: string | null;
  amountUsd: number;
  currency: FiatCurrency;
  status: SubscriptionStatus;
  /** ISO — when the current paid period ends (renew advances it). */
  currentPeriodEnd: string;
  livemode: boolean;
  createdAt: string;
}

export type ClaimStatus = 'pending' | 'claimed' | 'expired';

/**
 * Email-claim escrow (BUILD-PLAN "send $20 to bob@x.com"). send() debits the
 * sender; recordClaim parks the funds against a pregenerated Privy wallet keyed
 * to the email, with a 30-day reclaim window. The recipient claims on first login.
 */
export interface ClaimRecord {
  id: string;
  slug: string;
  senderUserId: string;
  senderName: string;
  email: string;
  amountUsd: number;
  /** Pregenerated Privy wallet for the email (null in pure demo). */
  walletAddress: string | null;
  status: ClaimStatus;
  expiresAt: string;
  claimedAt: string | null;
  createdAt: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 — Bridge offramp + markets + campaigns + perks types.
 * Schema is in db/schema/index.ts; constants for campaigns/perks live in
 * lib/campaigns/perks.ts (Phase 1 γ).
 * ────────────────────────────────────────────────────────────────────────── */

export type PayoutMethodType = 'ach' | 'sepa' | 'wire' | 'crypto';
export type PayoutMethodStatus = 'active' | 'disabled';

export interface PayoutMethod {
  id: string;
  userId: string;
  type: PayoutMethodType;
  externalAccountId: string;
  label: string;
  status: PayoutMethodStatus;
  livemode: boolean;
  createdAt: string;
}

export type BridgeTransferStatus = 'pending' | 'completed' | 'failed';

export interface BridgeTransfer {
  id: string;
  userId: string;
  payoutMethodId: string;
  amountUsd: number;
  status: BridgeTransferStatus;
  /** Bridge transfer id once the API has returned it. Null in flight. */
  externalRef: string | null;
  createdAt: string;
}

export type MarketVenue =
  | 'hyperliquid'
  | 'hyperliquid-spot'
  | 'hyperliquid-hip3'
  | 'jupiter'
  | 'xstocks'
  | 'polymarket';
/**
 * Sprint 1 lifecycle: legacy 4-state values (pending|open|closed|failed) remain
 * readable forever; new writes use the full vocabulary. Mapping for old rows:
 *   pending → reserved, open → resting OR filled (ambiguous), closed → canceled.
 */
export type MarketOrderStatus =
  // Legacy values (old rows, demo-mode placeMarketOrder)
  | 'pending'
  | 'open'
  | 'closed'
  // Lifecycle vocabulary (Sprint 1+)
  | 'created'
  | 'reserved'
  | 'submitted'
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'resting'
  | 'cancel_requested'
  | 'canceled'
  | 'expired'
  | 'rejected'
  | 'failed'
  | 'reconciled';

export type MarketPositionStatus = MarketOrderStatus;

/**
 * Append-only audit entry written by `recordLifecycleTransition`. The Order
 * Detail Sheet renders this as a timeline; the activity ledger reads the last
 * entry to derive a human-readable activity row.
 */
export interface LifecycleEvent {
  status: MarketOrderStatus;
  ts: string; // ISO timestamp
  externalOrderId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  providerPayload?: unknown;
}

export interface MarketOrderInput {
  venue: MarketVenue;
  symbol: string;
  sideLong: boolean;
  qtyUsd: number;
  entryPriceUsd: number;
  externalRef?: string | null;
  /** Copy-trading attribution — wallet of the trader this order copied. */
  copiedFrom?: string | null;
}

export interface MarketOrderReservationInput extends MarketOrderInput {
  idempotencyKey: string;
}

export interface MarketOrderReservationResult {
  position: MarketPosition;
  fresh: boolean;
  intentMismatch?: boolean;
}

export type MarketOrderCompletionInput = Pick<MarketOrderInput, 'qtyUsd' | 'entryPriceUsd'> & {
  externalRef: string;
  symbol?: string;
  sideLong?: boolean;
};

export interface MarketPosition {
  id: string;
  userId: string;
  venue: MarketVenue;
  symbol: string;
  sideLong: boolean;
  qtyUsd: number;
  entryPriceUsd: number;
  status: MarketPositionStatus;
  externalRef: string | null;
  createdAt: string;
  /** Copy-trading attribution — wallet of the trader this order copied. */
  copiedFrom?: string | null;
  // Sprint 1 lifecycle fields — all optional on read so legacy rows still parse.
  lifecycleEvents?: LifecycleEvent[];
  avgFillPriceUsd?: number | null;
  filledQtyUsd?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  submittedAt?: string | null;
  acceptedAt?: string | null;
  filledAt?: string | null;
  canceledAt?: string | null;
  failedAt?: string | null;
  updatedAt?: string;
}

/** Patch passed to `recordLifecycleTransition`. */
export interface LifecycleTransitionInput {
  /** The new status to transition to. */
  status: MarketOrderStatus;
  /** Venue-assigned order id (HL oid, Polymarket id, Jupiter tx hash). */
  externalOrderId?: string | null;
  /** Filled qty so far in USD. */
  filledQtyUsd?: number | null;
  /** Volume-weighted average fill price. */
  avgFillPriceUsd?: number | null;
  /** Error code on failure / rejection (e.g. `polymarket_token_unavailable`). */
  errorCode?: string | null;
  /** Free-form error message for support / debug. */
  errorMessage?: string | null;
  /** Raw provider response — stored in lifecycleEvents for the receipt pane. */
  providerPayload?: unknown;
  /**
   * Was this a demo-mode write? Propagated to the lifecycle publisher's
   * envelope so realtime subscribers can distinguish; NOT persisted as a
   * column. Default false.
   */
  demo?: boolean;
}

export type CampaignStatus = 'active' | 'closed';
export type CampaignPlatform = 'tiktok' | 'instagram' | 'youtube' | 'x';
export type CampaignSubmissionStatus = 'submitted' | 'approved' | 'paid' | 'rejected';

/** Bonus payout step. Submission gets bonusUsd when viewsVerified ≥ viewsThreshold. */
export interface CampaignBonusTier {
  viewsThreshold: number;
  bonusUsd: number;
}

export interface CampaignInput {
  title: string;
  brand: string;
  baseUsd: number;
  bonusTiers: CampaignBonusTier[];
  topPrizeUsd?: number;
  endAt?: string | null;
}

export interface Campaign {
  id: string;
  creatorId: string;
  title: string;
  brand: string;
  baseUsd: number;
  bonusTiers: CampaignBonusTier[];
  topPrizeUsd: number;
  status: CampaignStatus;
  endAt: string | null;
  createdAt: string;
}

export interface CampaignSubmission {
  id: string;
  campaignId: string;
  userId: string;
  clipUrl: string;
  platform: CampaignPlatform;
  viewsAttested: number;
  viewsVerified: number;
  status: CampaignSubmissionStatus;
  paidUsd: number;
  approvedAt: string | null;
  createdAt: string;
}

export type PerkTier = 'starter' | 'rising' | 'top';

/* ──────────────────────────────────────────────────────────────────────────
 * Stack upgrades — types shared across Phases 1–4 (earn router, agent moat,
 * stripe checkout). Phase 0 freezes them so each phase can ship serially.
 * ────────────────────────────────────────────────────────────────────────── */

/** Upgrade 1 — pick a Morpho-curated default vs the highest-APY adapter. */
export type VaultTier = 'standard' | 'higher_yield';

/** Upgrade 3 — one Privy server wallet pinned to one agent × chain. */
export interface AgentWalletRecord {
  walletId: string;
  address: string;
  chain: string;
}

/** Upgrade 4 — Stripe Checkout session ↔ offer correlation. */
export interface StripeSessionRecord {
  id: string;
  sessionId: string;
  offerId: string;
  buyerEmail: string;
  amountUsd: number;
  status: 'pending' | 'completed' | 'expired' | 'failed';
  createdAt: string;
  completedAt: string | null;
}

/** Upgrade 4 — input for createStripeSession (the rest is server-set). */
export interface CreateStripeSessionInput {
  sessionId: string;
  offerId: string;
  buyerEmail: string;
  amountUsd: number;
}

/** Upgrade 3 — daily digest projection of one agent's recent spend. */
export interface AgentDigestDue {
  agentId: string;
  userId: string;
  spentUsd: number;
  topEndpoint: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Tier 3 #14 — append-only audit log (compliance prereq per HANDOVER-FULL.md
 * §13). recordAuditEntry inserts a forensic row; listAuditEntries supports the
 * admin-gated read endpoint and downstream SIEM exports. Entries are never
 * mutated or hand-deleted; the table is the source of truth for "who did X".
 * ────────────────────────────────────────────────────────────────────────── */

export type AuditActorType = 'user' | 'admin' | 'system' | 'agent';

/** Caller-supplied write shape — store assigns id + createdAt. */
export interface AuditLogEntry {
  actorType: AuditActorType;
  actorId?: string | null;
  /** Dotted action key (e.g. 'user.kyc.approved', 'card.frozen', 'payout.created'). */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Free-form JSON. Defaults to `{}` server-side when omitted. */
  metadata?: Record<string, unknown>;
  /** Correlation with the originating HTTP request id (Caddy + Hono x-request-id). */
  requestId?: string | null;
}

/** Read shape — id is a string so callers don't depend on JS bigint semantics. */
export interface AuditLogRecord {
  id: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

/**
 * Filter for listAuditEntries.
 *
 *   - `actorType`     — exact match on the actor type.
 *   - `actionPrefix`  — case-sensitive prefix on `action` ('user.' matches every
 *                       'user.*' row). The admin route validates the input is
 *                       a sensible action token.
 *   - `since`         — only rows with createdAt >= since.
 *   - `limit`         — capped at 1000 in the impl (default 100); requests
 *                       above 1000 are clamped, not rejected.
 */
export interface AuditLogFilter {
  actorType?: AuditActorType;
  actionPrefix?: string;
  since?: Date;
  limit?: number;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string | null;
}

/** Device platform for push registration. Expo (native) is ios|android; `web`
 *  is the Expo-web / PWA target. */
export type DevicePlatform = 'ios' | 'android' | 'web';

/** Legacy Expo push token registration (POST /push/expo-subscribe). Kept for
 *  back-compat; the store dual-writes a deterministic `legacy-<md5(token)[:16]>`
 *  installation id so these rows coexist with the installation-keyed devices. */
export interface ExpoPushSubscriptionInput {
  token: string;
  platform: 'ios' | 'android';
  appVersion?: string | null;
}

/**
 * NEO Session 1 — installation-keyed device upsert (PUT /me/devices/:id/push).
 * `installationId` is the stable per-install key the upsert conflicts on;
 * `expoPushToken` rotates underneath it. `enabled` + `preferences` are optional
 * on write — omitted → keep existing on update, default enabled=true on insert.
 */
export interface DeviceUpsertInput {
  installationId: string;
  expoPushToken: string;
  platform: DevicePlatform;
  appVersion?: string | null;
  enabled?: boolean;
  preferences?: Record<string, boolean> | null;
}

/** A registered push device row. Read by the delivery path (enabled +
 *  per-category preferences gate) and the /me/devices management surface. */
export interface ExpoPushSubscriptionRecord {
  id: string;
  userId: string;
  installationId: string;
  token: string;
  platform: DevicePlatform;
  appVersion: string | null;
  enabled: boolean;
  preferences: Record<string, boolean> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PushSubscriptionRecord extends PushSubscriptionInput {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

/** Return of payOffer — the route fires the webhook + fulfillment email from this. */
export interface PayResult {
  payment: Payment;
  sellerId: string;
  fulfillment: { kind: FulfillmentKind; value: string | null };
  /** false when the idempotencyKey matched a prior pay (no re-credit happened). */
  fresh: boolean;
  /** Auto-payouts created from email splits — route fires payout.completed for each. */
  payouts: Payout[];
  /** Set when a `subscription`-type offer was paid; null otherwise. */
  subscription: Subscription | null;
}

export interface Store {
  /** EventEmitter bus — emits 'activity' (userId, Activity) for SSE streams. */
  readonly bus: EventEmitter;

  /** Find-or-create by email — demo onboarding IS account creation. */
  upsertUserByEmail(
    email: string,
    name?: string,
    opts?: { privyDid?: string | null },
  ): Promise<User>;
  user(id: string): Promise<User>;

  /**
   * Scale wave 3 — cheap session-auth projection (see SessionUser). Hot path
   * for requireSession/requireRealtimeAuth; MUST stay O(primary-key reads).
   */
  userSession(id: string): Promise<SessionUser>;

  /**
   * Sprint 16.4 — persist the Privy server wallet id + address on the user
   * row at sign-in. Idempotent (sets only when the row currently has null;
   * subsequent calls with the same value are no-ops). Pass `force: true` to
   * overwrite (e.g. wallet rotation).
   */
  setPrivyWallet(
    userId: string,
    walletId: string,
    walletAddress: string,
    opts?: { force?: boolean },
  ): Promise<void>;

  /**
   * Sprint 16.4 — record that the backend completed `approveBuilderFee` for
   * our Hyperliquid builder code. `maxFeeTenthsBp` is the maximum recorded
   * agreement; we can never charge more without completing a new agreement.
   */
  setHlBuilderApproval(
    userId: string,
    maxFeeTenthsBp: number,
  ): Promise<void>;

  /**
   * Audit 2026-06-19 — cache Polymarket CLOB L2 credentials after the first
   * `createOrDeriveApiKey()` call so subsequent orders skip the derive
   * round-trip. Idempotent; pass force=true to rotate.
   */
  setPmClobCredentials(
    userId: string,
    creds: { key: string; secret: string; passphrase: string },
    opts?: { force?: boolean },
  ): Promise<void>;

  /**
   * Audit 2026-06-19 — cache the Solana sibling wallet at sign-in so the
   * Marinade / Mayan adapters don't re-provision per request. Idempotent.
   */
  setPrivySolWallet(
    userId: string,
    walletId: string,
    walletAddress: string,
    opts?: { force?: boolean },
  ): Promise<void>;

  /**
   * Audit 2026-06-19 — set or clear a user's test cohort tag. Used by the
   * admin route `POST /admin/cohort`. Pass null to clear.
   */
  setUserCohort(userId: string, cohort: string | null): Promise<void>;

  /**
   * Audit 2026-06-19 — enumerate every user whose cohort matches the given
   * tag. Used by `GET /admin/test-users` to power the tester dashboard.
   * Returns users only; route layer enriches with positions + activity.
   */
  listUsersByCohort(cohort: string): Promise<User[]>;

  /** Agent-key → user resolution. Demo keys map 1:1. */
  bindAgentKeyToUser(key: string, userId: string): Promise<void>;
  userForAgentKey(key: string): Promise<User | null>;

  pushActivity(u: SessionUser, row: Omit<Activity, 'id' | 'at'>): Promise<Activity>;

  /* Web Push notifications. */
  savePushSubscription(u: SessionUser, input: PushSubscriptionInput): Promise<PushSubscriptionRecord>;
  deletePushSubscription(u: SessionUser, endpoint: string): Promise<boolean>;
  listPushSubscriptions(u: SessionUser): Promise<PushSubscriptionRecord[]>;
  pushSubscriptionsForUser(userId: string): Promise<PushSubscriptionRecord[]>;
  /** Expo push tokens — separate table; the fills worker reads via userId. */
  saveExpoPushSubscription(u: SessionUser, input: ExpoPushSubscriptionInput): Promise<ExpoPushSubscriptionRecord>;
  deleteExpoPushSubscription(u: SessionUser, token: string): Promise<boolean>;
  listExpoPushSubscriptions(u: SessionUser): Promise<ExpoPushSubscriptionRecord[]>;
  expoPushSubscriptionsForUser(userId: string): Promise<ExpoPushSubscriptionRecord[]>;
  /** Prune a single dead token by userId (sender has no User handle). */
  pruneExpoPushToken(userId: string, token: string): Promise<boolean>;
  /** Distinct userIds with ≥1 ENABLED Expo device — the fills worker's poll
   *  set. A fully-disabled user is excluded (nothing to notify). */
  usersWithExpoPushTokens(limit?: number): Promise<string[]>;
  /**
   * WORKER-P1-1 — keyset page over push-enabled userIds, ordered ascending
   * and stable across calls so a worker can page through the FULL
   * population across successive sweeps instead of the fixed single-page
   * cap of usersWithExpoPushTokens. `after: null` starts at the beginning;
   * pass the last id from the previous page to fetch the next one. A page
   * shorter than `limit` (including empty) signals the end of the keyspace
   * — callers wrap by passing `after: null` again on the next sweep.
   */
  listPushEnabledUserIdsPage(opts: { after: string | null; limit: number }): Promise<string[]>;

  /* ── NEO Session 1 — installation-keyed devices + notification prefs ── */
  /** Upsert a device by (userId, installationId). Rotates the token/platform in
   *  place; omitted enabled/preferences are preserved on update, enabled
   *  defaults to true on insert. */
  upsertDeviceByInstallation(userId: string, input: DeviceUpsertInput): Promise<ExpoPushSubscriptionRecord>;
  /** Delete a device by installation id. Idempotent — false when none matched. */
  deleteDeviceByInstallation(userId: string, installationId: string): Promise<boolean>;
  /** Every registered device for the user (management surface + delivery). */
  listDevices(userId: string): Promise<ExpoPushSubscriptionRecord[]>;
  /** Merge-patch the notification-preferences map across the user's devices
   *  (all devices when installationId omitted). Returns the merged result. */
  setNotificationPreferences(
    userId: string,
    prefs: Record<string, boolean>,
    installationId?: string,
  ): Promise<Record<string, boolean>>;

  /* ── NEO Session 1 — session revocation registry ── */
  /** Record a freshly-issued session by its jti. Idempotent on jti. */
  createSession(input: { userId: string; jti: string; installationId?: string | null }): Promise<void>;
  /** Revoke one session by jti, or every live session for the user ({ all:true }). */
  revokeSession(userId: string, target: string | { all: true }): Promise<void>;
  /** P1-4: revoke every OTHER live session for (userId, installationId) —
   *  sign-in REPLACES the installation's prior session instead of stacking a
   *  new live bearer beside it. Returns the revoked jtis so callers can prime
   *  the revocation cache (markJtiRevokedInCache). */
  revokeSessionsByInstallation(
    userId: string,
    installationId: string,
    exceptJti: string,
  ): Promise<string[]>;
  /** True only when a row exists AND is revoked. A missing row = NOT revoked, so
   *  pre-upgrade tokens (no jti / no row) keep authenticating until the no-jti
   *  cutover (lib/auth.ts SESSION_JTI_REQUIRED_AFTER_MS). Note: fail-closed
   *  issuance now guarantees every freshly-minted token HAS a row, so flipping
   *  missing-row => revoked is a possible future hardening — out of scope here. */
  isSessionRevoked(jti: string): Promise<boolean>;

  /* ── money ── */
  send(u: SessionUser, amountUsd: number, to: string, opts?: { idempotencyKey?: string | null }): Promise<SendResult>;
  /** Debit sender and park email escrow in one operation. */
  sendClaim(u: SessionUser, amountUsd: number, email: string, opts?: { idempotencyKey?: string | null }): Promise<ClaimSendResult>;
  topUp(u: SessionUser, amountUsd: number, label?: string): Promise<Activity>;
  /**
   * ADR-0006 Phase 2 — credit a VERIFIED on-chain USDC deposit. Idempotent
   * on the real deposit tx hash (re-offered deposits credit exactly once).
   */
  creditDeposit(
    u: SessionUser,
    amountUsd: number,
    opts: { txHash: string; chain: string },
  ): Promise<{ activity: Activity; fresh: boolean }>;
  earnDeposit(
    u: SessionUser,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult>;
  earnWithdraw(
    u: SessionUser,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult>;
  swap(
    u: SessionUser,
    amountUsd: number,
    direction: 'usd-eur' | 'eur-usd',
    opts?: { idempotencyKey?: string | null },
  ): Promise<SwapResult>;

  /* ── agents + policy ── */
  createAgent(
    u: SessionUser,
    name: string,
    perDayCapUsd: number,
    perTxCapUsd: number,
    allowlist: string[],
  ): Promise<Agent>;
  agent(u: SessionUser, id: string): Promise<Agent>;
  fundAgent(
    u: SessionUser,
    agentId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<Agent>;
  defundAgent(u: SessionUser, agentId: string): Promise<Agent>;
  setAgentPaused(u: SessionUser, agentId: string, paused: boolean): Promise<Agent>;
  setKillSwitch(u: SessionUser, on: boolean): Promise<void>;
  updateAgentPolicy(u: SessionUser, agentId: string, patch: Partial<AgentPolicy>): Promise<Agent>;

  x402Pay(
    u: SessionUser,
    agentId: string,
    endpoint: string,
    amountUsd: number,
    reason: string,
    settlementRef?: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<X402PayResult>;
  x402ApproveOnce(
    u: SessionUser,
    agentId: string,
    endpoint: string,
    amountUsd: number,
    reason: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<X402PayResult>;

  /* ── x402 vendor (merchant) side ── */
  createContract(
    u: SessionUser,
    name: string,
    endpointPath: string,
    method: 'GET' | 'POST',
    priceUsd: number,
    currency: 'USDC' | 'EURC',
  ): Promise<X402Contract>;
  contract(u: SessionUser, id: string): Promise<X402Contract>;
  setContractStatus(u: SessionUser, id: string, status: 'live' | 'paused'): Promise<X402Contract>;

  /** Card surface (lives in Store so PostgresStore can persist limits/freeze). */
  setCardFrozen(u: SessionUser, frozen: boolean): Promise<void>;
  setCardDayLimit(u: SessionUser, limit: number): Promise<void>;

  /* ── facilitator: offers / checkout / payments ── */
  createOffer(
    u: SessionUser,
    input: OfferInput,
    opts?: { livemode?: boolean; idempotencyKey?: string | null },
  ): Promise<Offer>;
  listOffers(u: SessionUser, opts?: { livemode?: boolean }): Promise<Offer[]>;
  sellerOffer(u: SessionUser, id: string): Promise<Offer>;
  updateOffer(
    u: SessionUser,
    id: string,
    patch: Partial<OfferInput> & { active?: boolean },
  ): Promise<Offer>;
  /** PUBLIC (no session). Null when the offer is missing or inactive. */
  checkoutView(offerId: string): Promise<CheckoutView | null>;
  /**
   * PUBLIC (no session by default). Credits the seller's ledger, records the
   * Payment, emits an activity row (→ SSE). Idempotent on idempotencyKey: a
   * repeat key returns the prior result with fresh=false and does NOT re-credit.
   *
   * Sprint 10 Item G — when `buyerUser` is provided and `method === 'balance'`
   * the buyer's balUsd is ALSO debited inside the same transaction (with
   * autoDivestIfNeeded honored), so humans check out via x402/MAZE balance
   * instead of a card PSP. Insufficient balance → `PolicyError('insufficient_funds')`.
   *
   * Throws 'offer_not_found' or 'offer_inactive' (plain Error) on bad input.
   */
  payOffer(
    offerId: string,
    opts: {
      buyerEmail: string | null;
      method: string;
      idempotencyKey?: string | null;
      buyerUser?: User | null;
      expectedAmountUsd?: number;
    },
  ): Promise<PayResult>;
  listPayments(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payment[]>;
  /** Single payment owned by the seller. Throws 'payment_not_found'. */
  payment(u: SessionUser, id: string): Promise<Payment>;

  /* ── facilitator: webhooks ── */
  registerWebhook(u: SessionUser, url: string): Promise<WebhookEndpoint>;
  listWebhooks(u: SessionUser): Promise<WebhookEndpoint[]>;
  /** By sellerId, for the route to dispatch after payOffer (no session in that path). */
  webhooksForSeller(sellerId: string): Promise<WebhookEndpoint[]>;

  /* ── developer surface: API keys (sk_test_/sk_live_) ── */
  createApiKey(u: SessionUser, label: string | null, livemode: boolean): Promise<ApiKeyCreated>;
  listApiKeys(u: SessionUser): Promise<ApiKey[]>;
  /**
   * Sprint 12 Phase 0 — idempotent semantics. Returns the revoked row when
   * the id exists AND is owned by `u`; returns `null` when the id is unknown
   * (Stripe/Twilio-style: re-deleting an unknown resource is a 200, not 500).
   * Re-revoking an already-revoked key still resolves to the row (no throw).
   */
  revokeApiKey(u: SessionUser, id: string): Promise<ApiKey | null>;
  /** Resolve a presented secret → owner + mode. Null if unknown/revoked. Bumps lastUsedAt. */
  userForApiKey(secret: string): Promise<{ user: User; livemode: boolean } | null>;

  /* ── facilitator: sub-accounts (one KYC, many businesses) ── */
  createSubAccount(u: SessionUser, name: string): Promise<SubAccount>;
  listSubAccounts(u: SessionUser): Promise<SubAccount[]>;
  /** Owned sub-account or throw 'sub_account_not_found'. */
  subAccount(u: SessionUser, id: string): Promise<SubAccount>;

  /* ── facilitator: payouts (money out to a dev/collaborator) ── */
  /**
   * Debits the seller's balance (live → balUsd, sandbox → sandboxBalUsd), records
   * the Payout (demo: status 'paid' immediately), emits an activity row for live.
   * Throws PolicyError('insufficient_funds'). Idempotent on idempotencyKey.
   */
  createPayout(
    u: SessionUser,
    input: PayoutInput,
    opts?: { livemode?: boolean; idempotencyKey?: string | null },
  ): Promise<Payout>;
  listPayouts(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payout[]>;
  /** Owned payout or throw 'payout_not_found'. */
  payout(u: SessionUser, id: string): Promise<Payout>;

  /* ── facilitator: subscriptions (recurring offers) ── */
  listSubscriptions(u: SessionUser, opts?: { livemode?: boolean }): Promise<Subscription[]>;
  /** Owned subscription or throw 'subscription_not_found'. */
  subscription(u: SessionUser, id: string): Promise<Subscription>;
  /** Advance the period + credit the seller a renewal charge. Throws if canceled. */
  renewSubscription(u: SessionUser, id: string, opts?: { dueBefore?: Date }): Promise<Subscription>;
  /** Mark canceled (idempotent). */
  cancelSubscription(u: SessionUser, id: string): Promise<Subscription>;

  /* ── Bridge.xyz compliance perimeter (real money in/out) ── */
  /** Persist the Bridge customer id after the route creates the customer. */
  setBridgeCustomer(u: SessionUser, customerId: string): Promise<void>;
  setKyc(u: SessionUser, status: KycStatus): Promise<void>;
  /** Persist a provisioned virtual account (route calls Bridge, store persists). */
  saveVirtualAccount(
    u: SessionUser,
    va: Omit<VirtualAccount, 'id' | 'createdAt'>,
  ): Promise<VirtualAccount>;
  listVirtualAccounts(u: SessionUser): Promise<VirtualAccount[]>;
  /** Resolve the owner of a Bridge customer id (for the deposit webhook, no session). */
  userForBridgeCustomer(customerId: string): Promise<User | null>;
  /**
   * PUBLIC webhook mutation. Idempotently applies one Bridge deposit event by
   * ref; returns true only when a fresh balance credit was written.
   */
  applyBridgeDeposit(customerId: string, amountUsd: number, ref: string): Promise<boolean>;

  /* ── email-claim escrow (pregenerated wallets) ── */
  /** Park an escrow for an email (send() already debited the sender). 30-day expiry. */
  recordClaim(u: SessionUser, email: string, amountUsd: number): Promise<ClaimRecord>;
  /** PUBLIC — the claim page reads this by slug. Null if missing. */
  getClaim(slug: string): Promise<ClaimRecord | null>;
  /**
   * PUBLIC — recipient claims: credits the recipient (find-or-create by email),
   * marks the claim 'claimed'. Returns null if missing/already-claimed/expired.
   */
  claimFunds(slug: string, recipientEmail: string): Promise<{ amountUsd: number; recipient: User } | null>;
  /** Claim every pending escrow addressed to this email. Used after verified sign-in. */
  claimPendingFundsForEmail(email: string): Promise<{ claimed: number; amountUsd: number }>;
  listClaims(u: SessionUser): Promise<ClaimRecord[]>;

  /* ── Sprint 10 — Item A: earn-by-default + auto-divest-on-spend ── */
  /** Update toggles on nb_user_state. Returns the fresh User row. */
  setEarnConfig(
    u: SessionUser,
    patch: Partial<{
      earnByDefault: boolean;
      autoDivestOnSpend: boolean;
      divestThresholdUsd: number;
    }>,
  ): Promise<User>;
  /**
   * Called before user-balance debits. If balUsd < amountUsd && autoDivestOnSpend
   * && earnUsd >= shortfall, withdraw the shortfall from earn into balance. No-op otherwise.
   */
  autoDivestIfNeeded(u: SessionUser, amountUsd: number): Promise<void>;

  /* ── Sprint 10 — Item B: Bridge offramp ── */
  savePayoutMethod(
    u: SessionUser,
    input: { type: PayoutMethodType; externalAccountId: string; label: string; livemode: boolean },
  ): Promise<PayoutMethod>;
  listPayoutMethods(u: SessionUser): Promise<PayoutMethod[]>;
  createBridgeTransfer(
    u: SessionUser,
    input: { payoutMethodId: string; amountUsd: number; externalRef: string | null },
  ): Promise<BridgeTransfer>;
  /**
   * Reserve an off-ramp transfer and debit the user's balance atomically.
   * fresh=false means idempotencyKey matched a prior transfer and no debit happened.
   */
  createBridgeTransferDebit(
    u: SessionUser,
    input: { payoutMethodId: string; amountUsd: number; idempotencyKey: string; label: string },
  ): Promise<{ transfer: BridgeTransfer; fresh: boolean }>;
  /** Attach the Bridge transfer id after the external call succeeds. */
  setBridgeTransferExternalRef(id: string, externalRef: string): Promise<BridgeTransfer>;
  /** Mark a pending reserved transfer failed and refund the debit. */
  failBridgeTransferById(id: string): Promise<BridgeTransfer | null>;
  /** Idempotent on externalRef. Null when no row matches or webhook guards mismatch. Re-credits balance on 'failed'. */
  markTransferStatus(
    externalRef: string,
    status: 'completed' | 'failed',
    expected?: { amountUsd?: number; externalAccountId?: string | null },
  ): Promise<BridgeTransfer | null>;
  /** Owner lookup for the Bridge transfer webhook (no session in that path). */
  userForBridgeTransfer(externalRef: string): Promise<User | null>;

  /* ── Sprint 10 — Item C/D: claim sweeper + subscription renewer ── */
  /** Mark pending claims past `cutoff` expired + refund senders. Returns rows touched + refunds. */
  expireClaimsBefore(cutoff: Date): Promise<{ expired: ClaimRecord[]; refundsApplied: number }>;
  /** Active subscriptions with current_period_end < cutoff. Worker iterates + calls renewSubscription. */
  findSubscriptionsDueBefore(cutoff: Date): Promise<Subscription[]>;

  /* ── Sprint 10 — Item E: markets trading (Hyperliquid + Polymarket) ── */
  placeMarketOrder(u: SessionUser, input: MarketOrderInput): Promise<MarketPosition>;
  /** Reserve a live venue order before external submission. fresh=false is an idempotency replay. */
  reserveMarketOrder(u: SessionUser, input: MarketOrderReservationInput): Promise<MarketOrderReservationResult>;
  /** Complete a previously reserved live order with the venue's accepted order reference. */
  completeMarketOrder(
    positionId: string,
    input: MarketOrderCompletionInput,
  ): Promise<MarketPosition>;
  /** Mark a reserved live order failed so the same idempotency key cannot submit again. */
  failMarketOrder(positionId: string): Promise<MarketPosition | null>;
  /** Owned, open position by externalRef → marked closed. Null when missing. */
  cancelMarketOrder(u: SessionUser, externalRef: string): Promise<MarketPosition | null>;
  /**
   * Reduce an owned position after a confirmed sell fill (competitor sprint
   * Lane A). Decrements qtyUsd (entry-usd denominated); residual ≤ $0.000001
   * closes the row. Guarded to live displayable statuses — a failed/closed
   * row can never be reduced. Null when the row is missing/not owned/not
   * reducible; the CALLER treats null as a hard error (venue already filled).
   */
  reduceMarketPosition(
    u: SessionUser,
    positionId: string,
    reduceQtyUsd: number,
  ): Promise<MarketPosition | null>;
  listMarketPositions(u: SessionUser, venue?: MarketVenue): Promise<MarketPosition[]>;
  /**
   * Sprint 1 lifecycle backbone — append-only status transition. Updates the
   * row's `status`, sets the matching lifecycle timestamp (submittedAt /
   * acceptedAt / filledAt / canceledAt / failedAt), appends to
   * `lifecycleEvents[]`, and emits a `priv:<userId>:order:<id>` event via the
   * lifecycle publisher. Returns the updated position; null when the id is
   * unknown. NEVER mutates rows from another user.
   */
  recordLifecycleTransition(
    positionId: string,
    input: LifecycleTransitionInput,
  ): Promise<MarketPosition | null>;
  /** Read a single position by id — used by /markets/orders/:id + cancel dispatch. */
  getMarketPositionById(positionId: string): Promise<MarketPosition | null>;
  /**
   * Sprint 2 — full-history read for the /markets/orders surface. Unlike
   * listMarketPositions (which drops failed/rejected/transient rows for the
   * positions tab), this returns EVERY row including failed and rejected so
   * NEO + MAZE can render order history end-to-end. Filters are JS-side for
   * the Sprint 2 minimal cut; push down to SQL when indexed.
   */
  listMarketOrders(
    u: SessionUser,
    filter?: {
      venue?: MarketVenue;
      symbol?: string;
      statuses?: MarketOrderStatus[];
      fromMs?: number;
      toMs?: number;
      limit?: number;
    },
  ): Promise<MarketPosition[]>;

  /* ── Sprint 10 — Item F: campaigns + submissions + perks ── */
  createCampaign(creator: User, input: CampaignInput): Promise<Campaign>;
  listCampaigns(filter?: { status?: CampaignStatus }): Promise<Campaign[]>;
  /** Enforces MAX_SUBMISSIONS_PER_CAMPAIGN=1 via unique (campaign_id, user_id). */
  submitToCampaign(
    u: SessionUser,
    campaignId: string,
    input: { clipUrl: string; platform: CampaignPlatform; viewsAttested: number },
  ): Promise<CampaignSubmission>;
  /** Admin path — sets viewsVerified + status='approved' + approvedAt. */
  approveSubmission(submissionId: string, viewsVerified: number): Promise<CampaignSubmission>;
  /**
   * Admin path — computes payout × tier multiplier, credits the user's balance,
   * awards points (earn source), marks submission 'paid'.
   *
   * Sprint 13 COMMIT 6 (SR4) — campaignId is a required arg so the impl can
   * assert `submission.campaignId === campaignId` before paying out. Without
   * the binding, a compromised admin key could pay out across campaigns by
   * passing a foreign submissionId. PolicyError('expired',
   * 'subId_campaignId_mismatch') on miss.
   */
  releaseBonus(
    campaignId: string,
    submissionId: string,
  ): Promise<{ submission: CampaignSubmission; paidUsd: number; tier: PerkTier; multiplier: number }>;
  getPerks(
    u: SessionUser,
  ): Promise<{ tier: PerkTier; points: number; multiplier: number; lifetimeEarnedUsd: number }>;
  /** Idempotent per call (caller dedupes). Recomputes tier from points after increment. */
  awardPoints(
    u: SessionUser,
    source: 'earn' | 'cardSpend',
    usd: number,
  ): Promise<{ tier: PerkTier; points: number }>;

  /* ── Stack upgrades — Phase 0 schema gate (Phases 1–4 implement) ── */

  /** Upgrade 3 — read the per-agent Privy wallet binding. */
  getAgentWallet(agentId: string): Promise<AgentWalletRecord | null>;
  /** Upgrade 3 — persist (or idempotently upsert) the per-agent wallet binding. */
  setAgentWallet(agentId: string, input: AgentWalletRecord): Promise<AgentWalletRecord>;

  /** Upgrade 4 — record a Stripe Checkout session at /pay time. */
  createStripeSession(input: CreateStripeSessionInput): Promise<StripeSessionRecord>;
  /** Upgrade 4 — webhook handler looks up the session by Stripe id. */
  findStripeSession(sessionId: string): Promise<StripeSessionRecord | null>;
  /** Upgrade 4 — flip a pending session to completed (idempotent). */
  markStripeSessionCompleted(sessionId: string): Promise<StripeSessionRecord | null>;
  /** Upgrade 4 — flip a pending session to expired/failed (idempotent). */
  markStripeSessionStatus(
    sessionId: string,
    status: 'expired' | 'failed',
  ): Promise<StripeSessionRecord | null>;

  /** Upgrade 1 — persist the earn router's user tier preference. */
  setPreferredVaultTier(u: SessionUser, tier: VaultTier): Promise<User>;

  /** Upgrade 3 — mark a digest as sent for this agent's last 24h window. */
  recordAgentDigestSent(agentId: string, windowSpentUsd: number): Promise<void>;
  /** Upgrade 3 — agents with spend whose last_sent_at is before the cutoff. */
  findAgentsDueForDigest(cutoff: Date): Promise<AgentDigestDue[]>;

  /* ── Tier 3 #14 — append-only audit log (compliance prereq) ── */

  /**
   * Append one row to nb_audit_log. The id is auto-assigned (bigserial) and
   * createdAt defaults to NOW(). Returns the assigned id as a string so callers
   * can correlate the write into structured logs without a follow-up read.
   */
  recordAuditEntry(entry: AuditLogEntry): Promise<{ id: string }>;
  /**
   * Read forensic rows newest-first. Filter supports actorType, actionPrefix,
   * since, and limit (default 100, max 1000 — out-of-range is clamped). The
   * admin route maps each query param into this shape.
   */
  listAuditEntries(filter: AuditLogFilter): Promise<AuditLogRecord[]>;

  /**
   * Sprint 12 Phase 0 — install the chain mirror at boot. After this call,
   * successful earnDeposit / earnWithdraw fire-and-forget the mirror so the
   * user's `preferredVaultTier` choice routes through `EarnRouter` instead
   * of staying ledger-only. Optional: tests can construct a Store without
   * ever attaching a mirror and behavior reduces to the prior ledger-only path.
   */
  attachChainMirror(m: ChainMirror): void;

  /** Optional health probe for /healthz. */
  ping?(): Promise<boolean>;
  dispose(): Promise<void>;
}

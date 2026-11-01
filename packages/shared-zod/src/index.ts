import { z } from 'zod';

/* Realtime hub wire schemas — see ./realtime.ts for the source-of-truth Zod
 * definitions of FeedEvent / ClientOp / ServerOp / VenueHealth that
 * apps/api/src/realtime/* and @nexa/realtime-client both consume. */
export * from './realtime.js';

export const Currency = z.enum(['USD', 'EUR', 'USDC', 'EURC']);
export type Currency = z.infer<typeof Currency>;

export const Address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'invalid 0x address');
export type Address = z.infer<typeof Address>;

export const ChainName = z.enum(['base', 'base-sepolia', 'gnosis']);
export type ChainName = z.infer<typeof ChainName>;

export const TxKind = z.enum([
  'card',
  'bank_in',
  'bank_out',
  'send',
  'receive',
  'claim',
  'agent_pay',
  'x402',
  'defi_deposit',
  'defi_withdraw',
  'swap',
  'policy',
  'fund_agent',
  'defund_agent',
]);
export type TxKind = z.infer<typeof TxKind>;

export const TxStatus = z.enum(['pending', 'sent', 'confirmed', 'failed', 'claim_pending']);
export type TxStatus = z.infer<typeof TxStatus>;

export const Money = z.object({
  amount: z.string().regex(/^-?\d+(\.\d+)?$/, 'amount must be a decimal string'),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

/**
 * F016 — single canonical enum, matches the 5 values the store actually
 * emits (see apps/api/src/store/types.ts Agent.state:56) and the DB column
 * default (`nb_agents.state` varchar(20) default 'ready', see
 * apps/api/src/db/schema/index.ts:55).
 *
 * Wire ↔ DB reconciled: both sides ship the same 5-value set
 * { live | ready | paused | review | blocked }. Three legacy wire-only
 * values ('active', 'needs_approval', 'limit_reached') were never returned
 * by the server and have been dropped. No state-mapping helper is needed —
 * the store emits the canonical enum directly.
 */
export const PolicyState = z.enum([
  'live',
  'ready',
  'paused',
  'review',
  'blocked',
]);
export type PolicyState = z.infer<typeof PolicyState>;

export const AgentPolicy = z.object({
  perTxCapUsd: z.number().nonnegative(),
  perDayCapUsd: z.number().nonnegative(),
  endpointAllowlist: z.array(z.string().min(1)),
  expiresAt: z.string().datetime().nullable(),
  humanApprovalThresholdUsd: z.number().nonnegative(),
});
export type AgentPolicy = z.infer<typeof AgentPolicy>;

export const Agent = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  role: z.string().min(1),
  balanceUsd: z.number(),
  spentTodayUsd: z.number(),
  policy: AgentPolicy,
  state: PolicyState,
  createdAt: z.string().datetime(),
});
export type Agent = z.infer<typeof Agent>;

export const Transaction = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  kind: TxKind,
  status: TxStatus,
  title: z.string(),
  subtitle: z.string().nullable(),
  amount: Money,
  counterparty: z.string().nullable(),
  agentId: z.string().uuid().nullable(),
  txHash: z.string().nullable(),
  chain: ChainName.nullable(),
  createdAt: z.string().datetime(),
});
export type Transaction = z.infer<typeof Transaction>;

/**
 * Tier 3 #11 — reconcile to the DB. The legacy `User` wire shape was the
 * minimum identity envelope. The four optional fields below mirror what
 * `nb_user_state` (apps/api/src/db/schema/index.ts:173) actually persists,
 * so consumers can treat `User` as the canonical balance-bearing record
 * instead of having to call `/auth/me` for the `UserResponse` envelope.
 *
 * Added fields are all `.optional()` so existing API consumers that ignored
 * them keep typechecking; the store impls fill them on every read path.
 *
 * Two wire-only fields stay legacy projections, not DB columns:
 *   - `walletAddress` is the user's primary `nb_wallets.address` (kind='embedded').
 *   - `virtualAccount` is a singular projection over `nb_virtual_accounts[]`;
 *     the full list is exposed separately on `/ledger/me.virtualAccountsList`.
 */
export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  walletAddress: Address,
  kycStatus: z.enum(['none', 'pending', 'verified', 'failed']),
  killSwitch: z.boolean(),
  /** nb_user_state.bal_usd — live ledger balance (numeric(18,6), USD). */
  balUsd: z.number().optional(),
  /** nb_user_state.earn_usd — earn-vault principal (numeric(18,6), USD). */
  earnUsd: z.number().optional(),
  /** Computed APY surfaced from the earn router (not persisted on nb_user_state). */
  earnApy: z.number().optional(),
  /** nb_users.bridge_customer_id — present once a Bridge customer record exists. */
  bridgeCustomerId: z.string().nullable().optional(),
  virtualAccount: z
    .object({
      ach: z.object({
        routing: z.string(),
        account: z.string(),
        bankName: z.string(),
      }),
      iban: z.object({
        iban: z.string(),
        bic: z.string(),
        bankName: z.string(),
      }),
    })
    .nullable(),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

export const Balance = z.object({
  totalUsd: z.number(),
  available: Money,
  earning: Money,
  earningApy: z.number(),
});
export type Balance = z.infer<typeof Balance>;

/**
 * F014 — full /auth/me response shape. Extends `User` (identity) with the
 * runtime fields the API actually serialises: balances, earn config, and
 * preferred vault tier. Existing callers of `User` keep working — this is
 * an additive envelope, not a replacement.
 */
export const UserResponse = User.extend({
  balUsd: z.number(),
  sandboxBalUsd: z.number(),
  earnUsd: z.number(),
  earnApy: z.number(),
  earnByDefault: z.boolean(),
  autoDivestOnSpend: z.boolean(),
  divestThresholdUsd: z.number(),
  preferredVaultTier: z.enum(['standard', 'higher_yield']),
});
export type UserResponse = z.infer<typeof UserResponse>;

/** `/auth/start` request and response envelope. */
export const AuthStartInput = z.object({
  email: z.string().email(),
});
export type AuthStartInput = z.infer<typeof AuthStartInput>;

const AuthStartDemo = z.object({
  ok: z.literal(true),
  mode: z.literal('demo'),
  challengeId: z.string().uuid(),
  hint: z.string().optional(),
});

const AuthStartPrivy = z.object({
  ok: z.literal(true),
  mode: z.literal('privy'),
  appId: z.string(),
  email: z.string().email(),
});

export const AuthStartResponse = z.discriminatedUnion('mode', [AuthStartDemo, AuthStartPrivy]);
export type AuthStartResponse = z.infer<typeof AuthStartResponse>;

/** `/auth/verify` and `/auth/privy-verify` token minting response. */
export const AuthVerifyResponse = z.object({
  ok: z.literal(true),
  token: z.string(),
  expiresAt: z.number().int().nonnegative(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string().nullable(),
  }),
});
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponse>;

export const AuthVerifyInput = z.object({
  challengeId: z.string().uuid(),
  code: z.string().length(6),
});
export type AuthVerifyInput = z.infer<typeof AuthVerifyInput>;

export const AuthPrivyVerifyInput = z.object({
  accessToken: z.string().min(10),
});
export type AuthPrivyVerifyInput = z.infer<typeof AuthPrivyVerifyInput>;

/** `/auth/me` session-authenticated user snapshot. */
export const AuthMeResponse = z.object({
  ok: z.literal(true),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string().nullable(),
  }),
  balance: z.object({
    balUsd: z.number(),
    earnUsd: z.number(),
    earnApy: z.number(),
  }),
  earnConfig: z.object({
    earnByDefault: z.boolean(),
    autoDivestOnSpend: z.boolean(),
    divestThresholdUsd: z.number(),
  }),
});
export type AuthMeResponse = z.infer<typeof AuthMeResponse>;

/**
 * `/me` profile shared types.
 *
 * `trading` is a keyed dictionary by venue rather than an array so clients can
 * do constant-time lookup for venue flags and fee metadata.
 */
export const MeProfileVenueTradingSchema = z.object({
  enabled: z.boolean(),
  liveTrading: z.boolean(),
  regionAllowed: z.boolean(),
  walletReady: z.boolean(),
  feeBps: z.number(),
});
export type MeProfileVenueTrading = z.infer<typeof MeProfileVenueTradingSchema>;

export const MeProfileVenueTradingHyperliquidSchema = MeProfileVenueTradingSchema.extend({
  builderApproved: z.boolean(),
  builderMaxFeeTenthsBp: z.number().nullable(),
});
export type MeProfileVenueTradingHyperliquid = z.infer<typeof MeProfileVenueTradingHyperliquidSchema>;

export const MeProfileVenueTradingHip3Schema = MeProfileVenueTradingSchema.extend({
  builderApproved: z.boolean(),
  dex: z.literal('xyz'),
});
export type MeProfileVenueTradingHip3 = z.infer<typeof MeProfileVenueTradingHip3Schema>;

export const MeProfileVenueTradingJupiterSchema = MeProfileVenueTradingSchema.extend({
  feeAccountConfigured: z.boolean(),
});
export type MeProfileVenueTradingJupiter = z.infer<typeof MeProfileVenueTradingJupiterSchema>;

export const MeProfileVenueTradingPolymarketSchema = MeProfileVenueTradingSchema.extend({
  clobCredsReady: z.boolean(),
});
export type MeProfileVenueTradingPolymarket = z.infer<typeof MeProfileVenueTradingPolymarketSchema>;

export const MeProfileTradingSchema = z
  .object({
    hyperliquid: MeProfileVenueTradingHyperliquidSchema,
    'hyperliquid-spot': MeProfileVenueTradingSchema,
    'hyperliquid-hip3': MeProfileVenueTradingHip3Schema,
    jupiter: MeProfileVenueTradingJupiterSchema,
    xstocks: MeProfileVenueTradingSchema,
    polymarket: MeProfileVenueTradingPolymarketSchema,
  })
  .catchall(MeProfileVenueTradingSchema);
export type MeProfileTrading = z.infer<typeof MeProfileTradingSchema>;

export const MeProfileSchema = z.object({
  ok: z.literal(true),
  livemode: z.boolean().nullable(),
  region: z.string().nullable(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string().nullable(),
    kycStatus: z.enum(['none', 'pending', 'verified', 'failed']),
    killSwitch: z.boolean(),
  }),
  wallets: z.object({
    primary: z.string().nullable(),
    privy: z.object({
      evm: z
        .object({
          walletId: z.string(),
          address: Address,
        })
        .nullable(),
      solana: z.object({ address: z.string() }).nullable(),
    }),
  }),
  balances: z.object({
    balUsd: z.number(),
    earnUsd: z.number(),
    earnApy: z.number().nullable(),
  }),
  earnConfig: z.object({
    earnByDefault: z.boolean(),
    autoDivestOnSpend: z.boolean(),
    divestThresholdUsd: z.number(),
  }),
  trading: MeProfileTradingSchema,
  features: z.record(z.string(), z.boolean()),
});
export type MeProfile = z.infer<typeof MeProfileSchema>;

/* ──────────────────────────────────────────────────────────────────────────
 * NEO Session 1 (2026-07-09) — per-device push registration + notification
 * preferences. Devices are keyed by the client's stable installation id (one
 * row per install, surviving token rotation). `preferences` is a per-category
 * opt-out map: an omitted category defaults to ON, an explicit `false` opts the
 * device out of that category. Categories the delivery path recognises today:
 * fills · orders · markets · rewards · general.
 *
 * Surfaced on:  PUT/DELETE /me/devices/:installationId/push · GET /me/devices ·
 *               PATCH /me/notification-preferences.
 * ────────────────────────────────────────────────────────────────────────── */
export const NotificationPreferencesSchema = z.record(z.string(), z.boolean());
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const MeDeviceSchema = z.object({
  installationId: z.string(),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().nullable(),
  enabled: z.boolean(),
  preferences: NotificationPreferencesSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MeDevice = z.infer<typeof MeDeviceSchema>;

export const MeDevicesResponseSchema = z.object({
  ok: z.literal(true),
  devices: z.array(MeDeviceSchema),
});
export type MeDevicesResponse = z.infer<typeof MeDevicesResponseSchema>;

export const MeFeeEventSchema = z.object({
  at: z.string().datetime(),
  userId: z.string().uuid().nullable(),
  venue: z.string(),
  kind: z.enum(['builder', 'platform', 'spread']),
  notionalUsd: z.number(),
  rateBps: z.number(),
  feeUsd: z.number(),
  symbol: z.string().optional(),
  attempted: z.boolean(),
});
export type MeFeeEvent = z.infer<typeof MeFeeEventSchema>;

export const MeFeesSchema = z.object({
  ok: z.literal(true),
  userId: z.string().uuid(),
  windowFrom: z.string().nullable(),
  windowTo: z.string(),
  totalFeeUsd: z.number(),
  totalNotionalUsd: z.number(),
  byVenue: z.record(
    z.string(),
    z.object({
      feeUsd: z.number(),
      orderCount: z.number(),
      notionalUsd: z.number(),
    }),
  ),
  recent: z.array(MeFeeEventSchema),
});
export type MeFees = z.infer<typeof MeFeesSchema>;

export const X402Contract = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  endpointPath: z.string().startsWith('/'),
  method: z.enum(['GET', 'POST']),
  priceUsd: z.number().positive(),
  currency: z.enum(['USDC', 'EURC']),
  status: z.enum(['live', 'paused']),
  requestsToday: z.number().int().nonnegative(),
  revenueTodayUsd: z.number().nonnegative(),
  paidSuccessRate: z.number().min(0).max(1),
});
export type X402Contract = z.infer<typeof X402Contract>;

export const X402Event = z.object({
  id: z.string().uuid(),
  contractId: z.string().uuid().nullable(),
  buyer: z.string(),
  buyerType: z.enum(['human', 'agent']),
  resource: z.string(),
  amountUsd: z.number().positive(),
  httpStatus: z.number().int(),
  ref: z.string(),
  at: z.string().datetime(),
});
export type X402Event = z.infer<typeof X402Event>;

/* ──────────────────────────────────────────────────────────────────────────
 * MAZE facilitator — the get-paid layer (offers, hosted checkout, payments).
 * Buyer-facing surfaces are fiat-only ("pay $9.99", never "send USDC").
 * ────────────────────────────────────────────────────────────────────────── */

export const OfferType = z.enum(['one_time', 'subscription']);
export type OfferType = z.infer<typeof OfferType>;

export const FulfillmentKind = z.enum(['url', 'message', 'none']);
export type FulfillmentKind = z.infer<typeof FulfillmentKind>;

export const FiatCurrency = z.enum(['USD', 'EUR']);
export type FiatCurrency = z.infer<typeof FiatCurrency>;

export const PaymentStatus = z.enum(['pending', 'paid', 'failed', 'refunded']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/** One slice of a sale — exactly one of subAccountId | email, percent 0–100. */
export const SplitRule = z
  .object({
    subAccountId: z.string().uuid().nullish(),
    email: z.string().email().nullish(),
    percent: z.number().positive().max(100),
  })
  .refine((s) => Boolean(s.subAccountId) !== Boolean(s.email), {
    message: 'each split needs exactly one of subAccountId or email',
  });
export type SplitRule = z.infer<typeof SplitRule>;

/** Seller create/update input (PATCH passes a partial). */
export const OfferInput = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  imageUrl: z.string().url().max(2000).nullish(),
  amountUsd: z.number().positive().max(99999),
  currency: FiatCurrency.default('USD'),
  type: OfferType.default('one_time'),
  fulfillmentKind: FulfillmentKind.default('none'),
  fulfillmentValue: z.string().max(2000).nullish(),
  subAccountId: z.string().uuid().nullish(),
  splits: z.array(SplitRule).max(20).nullish(),
});
export type OfferInput = z.infer<typeof OfferInput>;

export const Offer = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  amountUsd: z.number(),
  currency: FiatCurrency,
  type: OfferType,
  fulfillmentKind: FulfillmentKind,
  fulfillmentValue: z.string().nullable(),
  active: z.boolean(),
  livemode: z.boolean(),
  subAccountId: z.string().uuid().nullable(),
  splits: z.array(SplitRule),
  /** Hosted, shareable link — `${CHECKOUT_BASE_URL}/${id}`. */
  checkoutUrl: z.string().url(),
  createdAt: z.string().datetime(),
});
export type Offer = z.infer<typeof Offer>;

export const Payment = z.object({
  id: z.string().uuid(),
  offerId: z.string().uuid(),
  offerTitle: z.string(),
  amountUsd: z.number(),
  currency: FiatCurrency,
  buyerEmail: z.string().email().nullable(),
  method: z.string(),
  status: PaymentStatus,
  fulfillmentSent: z.boolean(),
  livemode: z.boolean(),
  createdAt: z.string().datetime(),
});
export type Payment = z.infer<typeof Payment>;

/** Public projection rendered on the hosted checkout page (no seller PII). */
export const CheckoutView = z.object({
  offerId: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  amountUsd: z.number(),
  currency: FiatCurrency,
  type: OfferType,
  sellerName: z.string(),
  active: z.boolean(),
});
export type CheckoutView = z.infer<typeof CheckoutView>;

/** Checkout submit. method='balance' debits the signed-in buyer's balUsd;
 *  method='demo' is retained for DEMO_MODE=1 legacy e2e. Card fields are
 *  ignored at the API layer (humans pay via x402/MAZE balance, not a PSP).
 *
 *  Stack upgrades Phase 4 — adds 'card' (Stripe Checkout redirect) and
 *  'bank_topup' (Bridge virtual-account wire). The route narrows on `method`
 *  and reaches the strict CheckoutPayInput below for the new branches.
 */
export const PayInput = z.object({
  buyerEmail: z.string().email().nullish(),
  method: z.enum(['balance', 'demo', 'card', 'bank_topup']).nullish(),
  card: z
    .object({ number: z.string(), exp: z.string(), cvc: z.string() })
    .nullish(),
  idempotencyKey: z.string().max(120).nullish(),
});
export type PayInput = z.infer<typeof PayInput>;

/** Stack upgrades Phase 4 — discriminated union for the three Sprint-10+
 *  checkout methods. The route validates against PayInput first (back-compat
 *  with the existing balance + demo paths) and asserts CheckoutPayInput on the
 *  card / bank_topup branches so buyerEmail is guaranteed before reaching
 *  Stripe or Bridge.
 */
export const CheckoutPayInput = z.discriminatedUnion('method', [
  z.object({ method: z.literal('balance') }),
  z.object({
    method: z.literal('card'),
    buyerEmail: z.string().email(),
    idempotencyKey: z.string().max(120).optional(),
  }),
  z.object({
    method: z.literal('bank_topup'),
    buyerEmail: z.string().email(),
  }),
]);
export type CheckoutPayInput = z.infer<typeof CheckoutPayInput>;

export const PayResult = z.object({
  ok: z.boolean(),
  paymentId: z.string().uuid(),
  status: PaymentStatus,
  fulfillment: z.object({ kind: FulfillmentKind, value: z.string().nullable() }),
});
export type PayResult = z.infer<typeof PayResult>;

/* ──────────────────────────────────────────────────────────────────────────
 * Developer surface (Sprint 2) — public API keys + the /v1 REST representations.
 * ────────────────────────────────────────────────────────────────────────── */

export const ApiKeyPrefix = z.enum(['sk_test', 'sk_live']);
export type ApiKeyPrefix = z.infer<typeof ApiKeyPrefix>;

/** Masked key as shown in the dashboard — never carries the raw secret. */
export const ApiKey = z.object({
  id: z.string().uuid(),
  prefix: ApiKeyPrefix,
  last4: z.string().length(4),
  label: z.string().nullable(),
  livemode: z.boolean(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** Returned ONCE at creation — the only time `secret` crosses the wire. */
export const ApiKeyCreated = ApiKey.extend({ secret: z.string() });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;

export const ApiKeyCreateInput = z.object({
  label: z.string().max(80).nullish(),
  livemode: z.boolean().default(true),
});
export type ApiKeyCreateInput = z.infer<typeof ApiKeyCreateInput>;

/** GET /v1/balance — scoped to the presenting key's mode. */
export const V1Balance = z.object({
  livemode: z.boolean(),
  available: Money,
  earning: Money,
});
export type V1Balance = z.infer<typeof V1Balance>;

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 3 — sub-accounts (one KYC, many businesses) + payouts (money out).
 * ────────────────────────────────────────────────────────────────────────── */

export const SubAccount = z.object({
  id: z.string().uuid(),
  name: z.string(),
  balUsd: z.number(),
  sandboxBalUsd: z.number(),
  createdAt: z.string().datetime(),
});
export type SubAccount = z.infer<typeof SubAccount>;

export const SubAccountCreateInput = z.object({ name: z.string().min(1).max(80) });
export type SubAccountCreateInput = z.infer<typeof SubAccountCreateInput>;

export const PayoutStatus = z.enum(['pending', 'paid', 'failed']);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

export const PayoutInput = z.object({
  amountUsd: z.number().positive().max(99999),
  destination: z.string().min(1).max(320),
  method: z.string().max(16).nullish(),
  note: z.string().max(200).nullish(),
});
export type PayoutInput = z.infer<typeof PayoutInput>;

export const Payout = z.object({
  id: z.string().uuid(),
  amountUsd: z.number(),
  currency: FiatCurrency,
  destination: z.string(),
  method: z.string(),
  note: z.string().nullable(),
  status: PayoutStatus,
  livemode: z.boolean(),
  createdAt: z.string().datetime(),
});
export type Payout = z.infer<typeof Payout>;

export const KycStatus = z.enum(['none', 'pending', 'verified', 'failed']);
export type KycStatus = z.infer<typeof KycStatus>;

export const ClaimStatus = z.enum(['pending', 'claimed', 'expired']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Public projection for the hosted claim page (no sender PII beyond name). */
export const ClaimView = z.object({
  slug: z.string(),
  senderName: z.string(),
  amountUsd: z.number(),
  status: ClaimStatus,
  expiresAt: z.string().datetime(),
});
export type ClaimView = z.infer<typeof ClaimView>;

/** POST /kyc/start — applicant token for the hosted Sumsub SDK. */
export const KycStart = z.object({
  token: z.string(),
  applicantId: z.string(),
  demo: z.boolean(),
});
export type KycStart = z.infer<typeof KycStart>;

/** Bridge.xyz deposit account — USD (ACH) or EUR (SEPA). */
export const VirtualAccount = z.object({
  id: z.string().uuid(),
  currency: z.enum(['USD', 'EUR']),
  routingNumber: z.string().nullable(),
  accountNumber: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  bankName: z.string(),
  livemode: z.boolean(),
  createdAt: z.string().datetime(),
});
export type VirtualAccount = z.infer<typeof VirtualAccount>;

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 Item B — Bridge offramp (payout methods + withdrawals).
 * The /bridge/payout-method body's `accountDetails` carries the rail-specific
 * routing payload (ACH numbers, IBAN, etc.); Bridge validates it on the live
 * path, so we keep the inner shape free-form here.
 * ────────────────────────────────────────────────────────────────────────── */

export const PayoutMethodType = z.enum(['ach', 'sepa', 'wire', 'crypto']);
export type PayoutMethodType = z.infer<typeof PayoutMethodType>;

export const PayoutMethodCreateInput = z.object({
  type: PayoutMethodType,
  label: z.string().min(1).max(120),
  accountDetails: z.record(z.string(), z.unknown()).default({}),
});
export type PayoutMethodCreateInput = z.infer<typeof PayoutMethodCreateInput>;

export const PayoutMethod = z.object({
  id: z.string().uuid(),
  type: PayoutMethodType,
  externalAccountId: z.string(),
  label: z.string(),
  status: z.enum(['active', 'disabled']),
  livemode: z.boolean(),
  createdAt: z.string().datetime(),
});
export type PayoutMethod = z.infer<typeof PayoutMethod>;

export const BridgeWithdrawInput = z.object({
  payoutMethodId: z.string().uuid(),
  amountUsd: z
    .number()
    .positive()
    .max(99999)
    .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-8, {
      message: 'amountUsd must be in whole cents',
    }),
  idempotencyKey: z.string().min(1).max(120).optional(),
});
export type BridgeWithdrawInput = z.infer<typeof BridgeWithdrawInput>;

export const BridgeTransfer = z.object({
  id: z.string().uuid(),
  payoutMethodId: z.string().uuid(),
  amountUsd: z.number(),
  status: z.enum(['pending', 'completed', 'failed']),
  externalRef: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type BridgeTransfer = z.infer<typeof BridgeTransfer>;

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 Item E — markets trading. Position lifecycles are persisted on
 * `nb_market_positions`; place/cancel hit the venue adapter then record.
 * ────────────────────────────────────────────────────────────────────────── */

export const MarketVenue = z.enum([
  'hyperliquid',
  'hyperliquid-spot',
  'hyperliquid-hip3',
  'jupiter',
  'xstocks',
  'polymarket',
]);
export type MarketVenue = z.infer<typeof MarketVenue>;

export const MarketPositionStatus = z.enum([
  'pending',
  'open',
  'closed',
  'created',
  'reserved',
  'submitted',
  'accepted',
  'partially_filled',
  'filled',
  'resting',
  'cancel_requested',
  'canceled',
  'expired',
  'rejected',
  'failed',
  'reconciled',
]);
export type MarketPositionStatus = z.infer<typeof MarketPositionStatus>;

export const MarketLifecycleEvent = z.object({
  status: MarketPositionStatus,
  ts: z.string().datetime(),
  externalOrderId: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  providerPayload: z.unknown().optional(),
});
export type MarketLifecycleEvent = z.infer<typeof MarketLifecycleEvent>;

export const MarketPosition = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().optional(),
  venue: MarketVenue,
  symbol: z.string(),
  sideLong: z.boolean(),
  qtyUsd: z.number(),
  entryPriceUsd: z.number(),
  status: MarketPositionStatus,
  externalRef: z.string().nullable(),
  externalOrderId: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  lifecycleEvents: z.array(MarketLifecycleEvent).optional(),
  avgFillPriceUsd: z.number().nullable().optional(),
  filledQtyUsd: z.number().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
  acceptedAt: z.string().datetime().nullable().optional(),
  filledAt: z.string().datetime().nullable().optional(),
  canceledAt: z.string().datetime().nullable().optional(),
  failedAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type MarketPosition = z.infer<typeof MarketPosition>;

export const HyperliquidOrderInput = z.object({
  coin: z.string().min(1).max(16),
  sideLong: z.boolean(),
  qtyUsd: z.number().positive().max(99999),
  leverage: z.number().positive().max(50).default(1),
  kind: z.enum(['market', 'limit', 'stopLimit', 'twap']).optional(),
  orderType: z.enum(['market', 'limit']).optional(),
  limitPriceUsd: z.number().positive().optional(),
  triggerPriceUsd: z.number().positive().optional(),
  stopKind: z.enum(['sl', 'tp']).optional(),
  durationMinutes: z.number().int().min(5).max(1440).optional(),
  randomize: z.boolean().optional(),
  tif: z.enum(['Ioc', 'Gtc', 'Alo']).optional(),
  reduceOnly: z.boolean().optional(),
  takeProfit: z.object({
    triggerPriceUsd: z.number().positive(),
    limitPriceUsd: z.number().positive().optional(),
  }).optional(),
  stopLoss: z.object({
    triggerPriceUsd: z.number().positive(),
    limitPriceUsd: z.number().positive().optional(),
  }).optional(),
});
export type HyperliquidOrderInput = z.infer<typeof HyperliquidOrderInput>;

export const HyperliquidCancelInput = z.object({
  /** The VENUE order id (`position.externalRef`) — never the internal position id. */
  externalRef: z.string().min(1),
  /** Optional coin hint; the route falls back to the stored position symbol. */
  coin: z.string().min(1).max(32).optional(),
});
export type HyperliquidCancelInput = z.infer<typeof HyperliquidCancelInput>;

export const PolymarketOrderInput = z.object({
  marketId: z.string().min(1),
  outcome: z.string().min(1),
  priceCents: z.number().int().min(1).max(99),
  qtyUsd: z.number().positive().max(99999),
  /** Copy-trading attribution — wallet of the leaderboard trader this order
   *  copied. Display-only; the route degrades malformed values to null. */
  copiedFrom: z.string().min(1).max(64).optional(),
});
export type PolymarketOrderInput = z.infer<typeof PolymarketOrderInput>;

/**
 * Sell/close an existing Polymarket position (competitor sprint Lane A,
 * 2026-07-03). Anchored on the POSITION ID — the server derives the outcome
 * token and the shares held from the stored row, so a client can never sell
 * more than it holds or sell someone else's tokens.
 */
export const PolymarketSellInput = z.object({
  positionId: z.string().min(1),
  /** Portion to sell, denominated in ENTRY-usd of the position (the same
   *  unit the position row's qtyUsd uses). Omit to close the full position. */
  qtyUsd: z.number().positive().max(99999).optional(),
  /** Limit price for the sell, in cents (1..99). */
  limitPriceCents: z.number().int().min(1).max(99),
});
export type PolymarketSellInput = z.infer<typeof PolymarketSellInput>;

/* ──────────────────────────────────────────────────────────────────────────
 * Money-path request contracts (2026-07-02 lockstep pass). These are the
 * exact wire shapes the API routes accept; NEO/web clients must build their
 * payloads from these types so a field rename on either side fails typecheck
 * instead of silently failing in production (the `orderId` vs `externalRef`
 * cancel drift). `apps/api/src/routes/transfers.ts` validates with these
 * schemas at runtime; `routes/markets.ts` is pinned by
 * `routes/money-contract.spec.ts`.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Canonical idempotency header for live money routes. The markets routes also
 * accept the `X-Idempotency-Key` alias; `/transfers` takes the key in-body.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * POST /markets/hyperliquid/cancel-many — batch cancel. NOTE: each item's
 * `orderId` is the VENUE order id — the same value single-cancel calls
 * `externalRef`. The naming differs across the two routes for historical
 * reasons; this schema is the documented contract for both sides.
 */
export const HyperliquidCancelManyInput = z.object({
  cancels: z
    .array(
      z.object({
        coin: z.string().min(1).max(32),
        orderId: z.string().min(1),
      }),
    )
    .min(1),
});
export type HyperliquidCancelManyInput = z.infer<typeof HyperliquidCancelManyInput>;

/** POST /markets/hyperliquid/usd-class-transfer — spot⇄perps USDC move. */
export const UsdClassTransferInput = z.object({
  amountUsd: z.number().positive(),
  toPerp: z.boolean().optional(),
});
export type UsdClassTransferInput = z.infer<typeof UsdClassTransferInput>;

export const TransferBucket = z.enum([
  'perps',
  'predictions',
  'memes',
  'stocks-spot',
  'cash',
]);
export type TransferBucket = z.infer<typeof TransferBucket>;

/** State-machine values serialized by nb_transfers. */
export const TransferStatus = z.enum([
  'created',
  'burning',
  'attesting',
  'minting',
  'depositing',
  'hl_depositing',
  'hl_withdrawing',
  'complete',
  'failed',
]);
export type TransferStatus = z.infer<typeof TransferStatus>;

export const TransferChain = z.enum([
  'arbitrum',
  'polygon',
  'solana',
  'base',
  'optimism',
  'gnosis',
]);
export type TransferChain = z.infer<typeof TransferChain>;

export const TransferRail = z.enum([
  'cctp',
  'mayan',
  'socket',
  'lifi',
  'hl_bridge',
  'hl_withdraw',
  'internal',
]);
export type TransferRail = z.infer<typeof TransferRail>;

/** GET /transfers/onramp/deposit-address query. */
export const DepositAddressQuery = z.object({
  bucket: TransferBucket,
});
export type DepositAddressQuery = z.infer<typeof DepositAddressQuery>;

export const TransferDepositAddressResponse = z.object({
  ok: z.literal(true),
  bucket: TransferBucket,
  bucketLabel: z.string(),
  chain: TransferChain,
  address: z.string().min(1),
  token: z.literal('USDC'),
  live: z.boolean(),
  memo: z.string().nullable(),
});
export type TransferDepositAddressResponse = z.infer<typeof TransferDepositAddressResponse>;

/** POST /transfers/internal — cross-bucket USDC move (CCTP / Mayan / internal). */
export const InternalTransferInput = z.object({
  fromBucket: TransferBucket,
  toBucket: TransferBucket,
  amountUsd: z.number().positive().max(50_000),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
export type InternalTransferInput = z.infer<typeof InternalTransferInput>;

export const InternalTransferResponse = z.object({
  ok: z.literal(true),
  transferId: z.string().min(1),
  status: TransferStatus,
  rail: TransferRail,
  fromBucket: TransferBucket,
  toBucket: TransferBucket,
  amountUsd: z.number().nonnegative(),
  requestedUsd: z.number().positive(),
  feeUsd: z.number().nonnegative(),
  feeBps: z.number().nonnegative(),
  etaSec: z.number().int().nonnegative(),
  idempotent: z.boolean(),
  demo: z.boolean(),
  sourced: z.unknown().optional(),
});
export type InternalTransferResponse = z.infer<typeof InternalTransferResponse>;

/** POST /transfers/external — Base USDC send to an EVM wallet address. */
export const ExternalTransferInput = z.object({
  chain: z.literal('base'),
  destinationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountUsd: z.number().positive().max(50_000),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
export type ExternalTransferInput = z.infer<typeof ExternalTransferInput>;

export const ExternalTransferResponse = z.object({
  ok: z.literal(true),
  transferId: z.string().min(1),
  status: TransferStatus,
  chain: z.literal('base'),
  destinationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountUsd: z.number().positive(),
  txHash: z.string().nullable(),
  demo: z.boolean(),
  idempotent: z.boolean(),
  submittedUnknown: z.boolean().optional(),
  sourced: z.unknown().optional(),
});
export type ExternalTransferResponse = z.infer<typeof ExternalTransferResponse>;

/** POST /transfers/hl-deposit — Arbitrum USDC into Hyperliquid Bridge2. */
export const HlDepositInput = z.object({
  amountUsd: z.number().positive().max(50_000).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
export type HlDepositInput = z.infer<typeof HlDepositInput>;

export const HlDepositResponse = z.object({
  ok: z.literal(true),
  callId: z.string().nullable(),
  amountUsd: z.number().positive(),
  demo: z.boolean(),
  transferId: z.string().min(1),
  status: TransferStatus,
  idempotent: z.boolean(),
  submittedUnknown: z.boolean().optional(),
  sourced: z.unknown().optional(),
});
export type HlDepositResponse = z.infer<typeof HlDepositResponse>;

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 Item F — campaigns + submissions + perks. Economic constants
 * (tier thresholds / multipliers / points-per-USD) live in
 * apps/api/src/lib/campaigns/perks.ts — this file is the wire schema only.
 * ────────────────────────────────────────────────────────────────────────── */

export const CampaignStatus = z.enum(['active', 'closed']);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const CampaignPlatform = z.enum(['tiktok', 'instagram', 'youtube', 'x']);
export type CampaignPlatform = z.infer<typeof CampaignPlatform>;

export const CampaignSubmissionStatus = z.enum(['submitted', 'approved', 'paid', 'rejected']);
export type CampaignSubmissionStatus = z.infer<typeof CampaignSubmissionStatus>;

export const CampaignBonusTier = z.object({
  viewsThreshold: z.number().int().nonnegative(),
  bonusUsd: z.number().nonnegative(),
});
export type CampaignBonusTier = z.infer<typeof CampaignBonusTier>;

export const CampaignCreateInput = z.object({
  title: z.string().min(1).max(120),
  brand: z.string().min(1).max(120),
  baseUsd: z.number().nonnegative().max(99999),
  bonusTiers: z.array(CampaignBonusTier).max(10).default([]),
  topPrizeUsd: z.number().nonnegative().max(99999).default(0),
  endAt: z.string().datetime().nullish(),
});
export type CampaignCreateInput = z.infer<typeof CampaignCreateInput>;

export const Campaign = z.object({
  id: z.string().uuid(),
  creatorId: z.string().uuid(),
  title: z.string(),
  brand: z.string(),
  baseUsd: z.number(),
  bonusTiers: z.array(CampaignBonusTier),
  topPrizeUsd: z.number(),
  status: CampaignStatus,
  endAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Campaign = z.infer<typeof Campaign>;

export const CampaignSubmitInput = z.object({
  clipUrl: z.string().url().max(2000),
  platform: CampaignPlatform,
  viewsAttested: z.number().int().nonnegative().max(1_000_000_000).default(0),
});
export type CampaignSubmitInput = z.infer<typeof CampaignSubmitInput>;

export const CampaignSubmission = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  userId: z.string().uuid(),
  clipUrl: z.string(),
  platform: CampaignPlatform,
  viewsAttested: z.number().int(),
  viewsVerified: z.number().int(),
  status: CampaignSubmissionStatus,
  paidUsd: z.number(),
  approvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type CampaignSubmission = z.infer<typeof CampaignSubmission>;

export const PerkTier = z.enum(['starter', 'rising', 'top']);
export type PerkTier = z.infer<typeof PerkTier>;

export const PerksResponse = z.object({
  ok: z.literal(true),
  tier: PerkTier,
  points: z.number().int().nonnegative(),
  multiplier: z.number(),
  lifetimeEarnedUsd: z.number(),
  nextTierAt: z.number().int().nullable(),
});
export type PerksResponse = z.infer<typeof PerksResponse>;

export const SubscriptionStatus = z.enum(['active', 'canceled', 'past_due']);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** Recurring agreement created when a `subscription`-type offer is paid. */
export const Subscription = z.object({
  id: z.string().uuid(),
  offerId: z.string().uuid(),
  offerTitle: z.string(),
  buyerEmail: z.string().email().nullable(),
  amountUsd: z.number(),
  currency: FiatCurrency,
  status: SubscriptionStatus,
  currentPeriodEnd: z.string().datetime(),
  livemode: z.boolean(),
  createdAt: z.string().datetime(),
});
export type Subscription = z.infer<typeof Subscription>;

/* ──────────────────────────────────────────────────────────────────────────
 * Stack upgrades — Phase 1: earn router tier preference.
 * The router picks between two tiers per request and persists the chosen
 * tier on the user. 'standard' = Morpho-curated (Steakhouse vault on Base);
 * 'higher_yield' = highest risk-weighted APY across yoUSD/Aave/Compound/Morpho.
 * ────────────────────────────────────────────────────────────────────────── */
export const VaultTier = z.enum(['standard', 'higher_yield']);
export type VaultTier = z.infer<typeof VaultTier>;

export const EarnTierInput = z.object({ tier: VaultTier });
export type EarnTierInput = z.infer<typeof EarnTierInput>;

/* ──────────────────────────────────────────────────────────────────────────
 * Stack upgrades — Phase 2: bridge router. Multi-chain swap surface lifted
 * over the same wire schema so the /swap/* routes accept both the legacy
 * `direction` shape and explicit `fromChain/toChain/fromToken/toToken`.
 * ────────────────────────────────────────────────────────────────────────── */
export const BridgeChain = z.enum(['base', 'gnosis', 'polygon', 'optimism', 'arbitrum']);
export type BridgeChain = z.infer<typeof BridgeChain>;

export const BridgeToken = z.enum(['USDC', 'EURC', 'EURe', 'USDT']);
export type BridgeToken = z.infer<typeof BridgeToken>;

export const SwapDirection = z.enum(['usd-eur', 'eur-usd']);
export type SwapDirection = z.infer<typeof SwapDirection>;

export const SwapQuoteInput = z.object({
  amount: z.number().positive().max(999999),
  direction: SwapDirection.optional(),
  fromChain: BridgeChain.optional(),
  toChain: BridgeChain.optional(),
  fromToken: BridgeToken.optional(),
  toToken: BridgeToken.optional(),
  enableRefuel: z.boolean().optional(),
});
export type SwapQuoteInput = z.infer<typeof SwapQuoteInput>;

export const SwapExecuteInput = SwapQuoteInput.describe('SwapExecuteInput');
export type SwapExecuteInput = z.infer<typeof SwapExecuteInput>;

/* ── Sprint 15 — sourced-value envelope ─────────────────────────────────────
 * Every financial value emitted by the API now carries a SourcedValueMeta
 * declaring where it came from, when, and (for cached/unavailable values) why
 * it can't be trusted as live. The frontend renders this via <nexa-source-badge>
 * so a user can always answer "who provided this number, and when".
 *
 * `live`          → just fetched from the real provider this turn
 * `sandbox`       → provider's official sandbox/testnet (e.g. Bridge sandbox)
 * `cached-live`   → prior live read, now stale; ttlSeconds + fetchedAt explain
 * `provider-demo` → DEMO_MODE synthetic fallback; never set in production
 * `unavailable`   → provider known but the live path didn't return; UI shows
 *                   "Unavailable · Provider · Docs" instead of a number
 * `error`         → unhandled internal failure; UI shows the errorCode
 *
 * Demo account is allowed; demo data is not. Outside DEMO_MODE, `provider-demo`
 * must NEVER appear in a production response — the no-leak test guards in
 * Sprint 15 Phase 4 assert this.
 */
export const DataSourceKind = z.enum([
  'live',
  'sandbox',
  'cached-live',
  'provider-demo',
  'unavailable',
  'error',
]);
export type DataSourceKind = z.infer<typeof DataSourceKind>;

export const SourcedValueMeta = z.object({
  source: DataSourceKind,
  provider: z.string().min(1),
  fetchedAt: z.string().datetime().nullable(),
  ttlSeconds: z.number().int().positive().optional(),
  docsUrl: z.string().url().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type SourcedValueMeta = z.infer<typeof SourcedValueMeta>;

/**
 * Generic wrapper builder — `SourcedValue(MyValueSchema)` produces
 * `{ value: MyValue | null } & SourcedValueMeta`. Used at route boundaries to
 * give clients a single typed envelope per field.
 */
export const SourcedValue = <T extends z.ZodTypeAny>(value: T) =>
  SourcedValueMeta.extend({ value: value.nullable() });

/* ── Provider registry — GET /system/providers ──────────────────────────── */
/** Public operator kill switches consumed by NEO at startup and while running. */
export const SafeModeSubsystem = z.enum([
  'realtimeHub',
  'proChart',
  'chartWebViewEnhancements',
  'publicCachePersistence',
  'venueLiveTrading',
  'experimentalSearch',
  'animatedMoney',
]);
export type SafeModeSubsystem = z.infer<typeof SafeModeSubsystem>;

export const SafeModeResponse = z.object({
  v: z.literal(1),
  disabled: z.array(SafeModeSubsystem),
});
export type SafeModeResponse = z.infer<typeof SafeModeResponse>;

export const ProviderCategory = z.enum([
  'wallet',
  'kyc',
  'onramp',
  'offramp',
  'stablecoin',
  'swap',
  'defi-yield',
  'card',
  'agent-wallet',
  'x402',
  'markets',
  'tokenized-stocks',
  'observability',
  'email',
  'persistence',
  'auth',
]);
export type ProviderCategory = z.infer<typeof ProviderCategory>;

export const ProviderStatus = z.enum([
  'live',
  'sandbox',
  'gated',
  'docs-only',
  'missing-keys',
  'disabled',
]);
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const ProviderRegistryEntry = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: ProviderCategory,
  status: ProviderStatus,
  envVars: z.array(z.string().min(1)),
  backendFiles: z.array(z.string().min(1)),
  frontendScreens: z.array(z.string().min(1)),
  publicDocsUrl: z.string().url().nullable(),
  internalDocsPath: z.string().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
  dataFreshnessTtlSeconds: z.number().int().positive().optional(),
  demoFallbackAllowed: z.boolean(),
  notes: z.string().optional(),
});
export type ProviderRegistryEntry = z.infer<typeof ProviderRegistryEntry>;

export const ProvidersResponse = z.object({
  ok: z.literal(true),
  fetchedAt: z.string().datetime(),
  providers: z.array(ProviderRegistryEntry),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponse>;

/* /system/data-sources — running snapshot of live data freshness per (domain, metric) */
export const DataSourceEntry = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  metric: z.string().min(1),
  meta: SourcedValueMeta,
  screens: z.array(z.string().min(1)),
});
export type DataSourceEntry = z.infer<typeof DataSourceEntry>;

export const DataSourcesResponse = z.object({
  ok: z.literal(true),
  fetchedAt: z.string().datetime(),
  sources: z.array(DataSourceEntry),
});
export type DataSourcesResponse = z.infer<typeof DataSourcesResponse>;

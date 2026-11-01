/**
 * Drizzle nb_* schema — the persistence contract for the production flip.
 *
 * DEMO_MODE serves from store/in-memory.ts; PostgresStore (store/postgres.ts)
 * lands writes here when DATABASE_URL is configured (toolbox-postgres,
 * same instance as cx_* — subtree-clean, lift-out-ready).
 *
 * `pnpm drizzle:generate` emits migrations from this file.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const nbUsers = pgTable('nb_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  name: varchar('name', { length: 120 }),
  privyDid: varchar('privy_did', { length: 120 }).unique(),
  /**
   * Sprint 16.4 — Privy server-wallet id (EVM). Cached at sign-in so the live
   * Hyperliquid / Polymarket order routes don't re-provision per request.
   * Nullable for legacy users + demo flow.
   */
  privyWalletId: varchar('privy_wallet_id', { length: 80 }),
  /** EVM address of the Privy wallet — cached alongside id for SDK calls. */
  privyWalletAddress: varchar('privy_wallet_address', { length: 42 }),
  /**
   * When the backend completed `approveBuilderFee` for our Hyperliquid
   * builder code. Null until the account setup or first live HL action
   * completes the agreement.
   */
  hlBuilderApprovedAt: timestamp('hl_builder_approved_at', { withTimezone: true }),
  /**
   * Maximum fee in tenths of bps recorded for the builder agreement. We can
   * lower the actual fee on individual orders, but we cannot exceed this
   * number without completing a new agreement. Format matches
   * HYPERLIQUID_BUILDER_FEE_TENTHS_BP env var.
   */
  hlBuilderMaxFeeTenthsBp: integer('hl_builder_max_fee_tenths_bp'),
  /**
   * Sprint 17 / Audit 2026-06-19 — Polymarket CLOB L2 credentials. Derived
   * once via `clob.createOrDeriveApiKey()` against the user's Privy wallet
   * (L1 EIP-712 sig), then persisted for subsequent HMAC-authed order POSTs.
   * Null until derive completes. We do NOT log these.
   *
   * SEC-01 (Sprint 17.5, migration 0019) — at-rest envelope is AES-256-GCM
   * `nx1:<iv>:<authTag>:<ciphertext>`. Plaintext value is ~32 chars for the
   * key and ~88 chars (base64) for the secret/passphrase, so the wrapped
   * envelope tops out around ~200 chars; column widened to 400 with headroom.
   */
  pmClobKey: varchar('pm_clob_key', { length: 400 }),
  pmClobSecret: varchar('pm_clob_secret', { length: 400 }),
  pmClobPassphrase: varchar('pm_clob_passphrase', { length: 400 }),
  /**
   * Sprint 17 / Audit 2026-06-19 — Privy Solana server-wallet, paired with
   * the EVM wallet above. Provisioned on demand by the chain layer (Marinade
   * stake, Mayan swap). Solana addresses are base58 (no 0x prefix), typically
   * 44 chars — keeping 64 for safety.
   */
  privySolWalletId: varchar('privy_sol_wallet_id', { length: 80 }),
  privySolWalletAddress: varchar('privy_sol_wallet_address', { length: 64 }),
  /**
   * Audit 2026-06-19 — opt-in test-cohort tag. Null = regular user; non-null
   * (e.g. `tester-2026Q3`) routes the user into the `/admin/test-users`
   * dashboard + cohort-tagged Sentry events. Free-form text so cohorts can
   * be introduced without a schema change.
   */
  cohort: varchar('cohort', { length: 40 }),
  kycStatus: varchar('kyc_status', { length: 20 }).notNull().default('none'),
  bridgeCustomerId: varchar('bridge_customer_id', { length: 80 }).unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nbWallets = pgTable('nb_wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => nbUsers.id),
  address: varchar('address', { length: 42 }).notNull().unique(),
  kind: varchar('kind', { length: 20 }).notNull().default('embedded'), // embedded | server | pregenerated
  chain: varchar('chain', { length: 20 }).notNull().default('base'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nbPushSubscriptions = pgTable(
  'nb_push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userEndpointUq: uniqueIndex('nb_push_subscriptions_user_endpoint_uq').on(
      table.userId,
      table.endpoint,
    ),
    userIdx: index('nb_push_subscriptions_user_idx').on(table.userId),
  }),
);

/**
 * Expo push tokens (competitor sprint push channel, 2026-07-03). Separate
 * from nb_push_subscriptions (VAPID web-push): Expo uses opaque device tokens,
 * not endpoint/p256dh/auth. Persisted (was an in-memory Map) so the scheduler
 * process — where the fills worker runs — can read tokens the API registered.
 *
 * NEO Session 1 (2026-07-09) — account isolation + push lifecycle. A device is
 * now keyed by the client's stable `installation_id` (one row per install, not
 * per opaque token — a token rotates while the install persists). `enabled`
 * gates all delivery for the device; `preferences` is a per-category opt-out
 * map ({ fills:false } etc.) read by the delivery path. Legacy `/push/expo-
 * subscribe` rows are backfilled with a deterministic `legacy-<md5(token)[:16]>`
 * installation id (migration 0035) so old clients coexist with the new unique
 * index. The old (user_id, token) uniqueness is relaxed to a plain lookup index
 * used by the DeviceNotRegistered pruning path.
 */
export const nbExpoPushSubscriptions = pgTable(
  'nb_expo_push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: varchar('platform', { length: 16 }).notNull(),
    appVersion: varchar('app_version', { length: 32 }),
    installationId: varchar('installation_id', { length: 64 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    preferences: jsonb('preferences'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userInstallationUq: uniqueIndex('nb_expo_push_subscriptions_user_installation_uq').on(
      table.userId,
      table.installationId,
    ),
    userTokenIdx: index('nb_expo_push_subscriptions_user_token_idx').on(
      table.userId,
      table.token,
    ),
    userIdx: index('nb_expo_push_subscriptions_user_idx').on(table.userId),
  }),
);

/**
 * NEO Session 1 (2026-07-09) — session revocation registry. One row per issued
 * session JWT, keyed by its `jti` claim. `revoked_at` non-null = the token is
 * dead (sign-out, /auth/refresh rotation, /auth/revoke). A MISSING row means
 * "not revoked" — pre-upgrade tokens minted without a `jti` claim keep working,
 * so the upgrade never signs anyone out. The auth middleware checks this behind
 * a short in-process TTL cache to keep it off the hot path.
 */
export const nbSessions = pgTable(
  'nb_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    jti: varchar('jti', { length: 64 }).notNull().unique(),
    installationId: varchar('installation_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('nb_sessions_user_idx').on(t.userId),
  }),
);

export const nbAgents = pgTable('nb_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => nbUsers.id),
  walletId: uuid('wallet_id').references(() => nbWallets.id),
  name: varchar('name', { length: 60 }).notNull(),
  role: varchar('role', { length: 120 }),
  state: varchar('state', { length: 20 }).notNull().default('ready'),
  balanceUsd: numeric('balance_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  spentTodayUsd: numeric('spent_today_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nbAgentPolicies = pgTable(
  'nb_agent_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => nbAgents.id),
    perTxCapUsd: numeric('per_tx_cap_usd', { precision: 18, scale: 6 }).notNull(),
    perDayCapUsd: numeric('per_day_cap_usd', { precision: 18, scale: 6 }).notNull(),
    endpointAllowlist: jsonb('endpoint_allowlist').notNull().default([]),
    humanApprovalThresholdUsd: numeric('human_approval_threshold_usd', {
      precision: 18,
      scale: 6,
    }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // W2-C hot path: per-agent policy fetch + dashboard batch (eq/inArray on agent_id).
    agentIdx: index('nb_agent_policies_agent_idx').on(t.agentId),
  }),
);

export const nbTransactions = pgTable(
  'nb_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id),
    agentId: uuid('agent_id').references(() => nbAgents.id),
    kind: varchar('kind', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('confirmed'),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    counterparty: text('counterparty'),
    txHash: varchar('tx_hash', { length: 80 }),
    chain: varchar('chain', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTxHashUq: uniqueIndex('nb_transactions_user_tx_hash_uq')
      .on(table.userId, table.txHash)
      .where(sql`${table.txHash} IS NOT NULL`),
    // W2-C hot path: ledger activity feed (WHERE user_id ORDER BY created_at DESC).
    userCreatedIdx: index('nb_transactions_user_created_idx').on(
      table.userId,
      table.createdAt.desc(),
    ),
  }),
);

export const nbClaimWallets = pgTable('nb_claim_wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 24 }).unique(),
  email: varchar('email', { length: 320 }).notNull(),
  walletAddress: varchar('wallet_address', { length: 42 }).notNull(),
  amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('pending'),
  senderUserId: uuid('sender_user_id')
    .notNull()
    .references(() => nbUsers.id),
  senderName: varchar('sender_name', { length: 120 }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nbX402Contracts = pgTable('nb_x402_contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => nbUsers.id),
  name: varchar('name', { length: 80 }).notNull(),
  endpointPath: varchar('endpoint_path', { length: 120 }).notNull(),
  method: varchar('method', { length: 8 }).notNull().default('GET'),
  priceUsd: numeric('price_usd', { precision: 18, scale: 6 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull().default('USDC'),
  status: varchar('status', { length: 12 }).notNull().default('live'),
  requestsToday: integer('requests_today').notNull().default(0),
  revenueTodayUsd: numeric('revenue_today_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  // Stack upgrades Phase 3 — vendor EVM address that receives x402 settlements
  // for this contract. Null = legacy self-pay fallback (the agent's own wallet
  // becomes both `from` and `to`). 0x-prefixed; 42 chars is plenty for EVM.
  payeeAddress: varchar('payee_address', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nbX402Events = pgTable(
  'nb_x402_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id),
    contractId: uuid('contract_id').references(() => nbX402Contracts.id),
    agentId: uuid('agent_id').references(() => nbAgents.id),
    buyer: varchar('buyer', { length: 120 }).notNull(),
    buyerType: varchar('buyer_type', { length: 10 }).notNull(),
    resource: text('resource').notNull(),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    httpStatus: integer('http_status').notNull(),
    settlementRef: varchar('settlement_ref', { length: 80 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // F063 — findAgentsDueForDigest filters x402 events per agent over a 24h
    // window; covering index keeps the digest sweep off a sequential scan as
    // event volume grows. Added in migration 0013.
    agentCreatedIdx: index('nb_x402_events_agent_created_idx').on(
      table.agentId,
      table.createdAt,
    ),
  }),
);

export const nbCardState = pgTable('nb_card_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => nbUsers.id),
  frozen: boolean('frozen').notNull().default(false),
  dayLimitUsd: integer('day_limit_usd').notNull().default(500),
  gnosisPayToken: text('gnosis_pay_token'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-user ledger state (current balances + kill switch). Separate from
 * nb_users so the identity row stays stable while balances mutate constantly.
 * Money columns use numeric(18,6) like every other money column.
 */
export const nbUserState = pgTable('nb_user_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => nbUsers.id),
  // 2026-07-08 — defaults zeroed (migration 0031). The demo seed ($4,820.40 /
  // $3,200 earn) is applied EXPLICITLY by the auth/ledger layer when
  // DEMO_MODE=1; a raw insert must never mint phantom money for a real user.
  balUsd: numeric('bal_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  // 2026-07-02 — EUR cash balance (EURC), the other side of /swap. Append-only
  // column with a safe default; see migration 0027.
  eurUsd: numeric('eur_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  sandboxBalUsd: numeric('sandbox_bal_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  earnUsd: numeric('earn_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  killSwitch: boolean('kill_switch').notNull().default(false),
  // Sprint 10 — Item A: earn-by-default + auto-divest-on-spend toggles.
  earnByDefault: boolean('earn_by_default').notNull().default(false),
  autoDivestOnSpend: boolean('auto_divest_on_spend').notNull().default(false),
  divestThresholdUsd: numeric('divest_threshold_usd', { precision: 18, scale: 6 })
    .notNull()
    .default('50'),
  // Stack upgrades Phase 0 — feeds the earn router selection between the
  // Morpho-curated standard tier and the highest-APY higher-yield tier.
  preferredVaultTier: varchar('preferred_vault_tier', { length: 16 })
    .notNull()
    .default('standard'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-agent Privy server wallet binding — Upgrade 3 in the stack upgrades sprint.
 * Each row pins one chain × agent to a Privy walletId + 0x… address, so x402
 * payments come FROM the agent's own wallet (not the human's). Unique on
 * (agent_id, chain) so lazy provisioning is idempotent.
 */
export const nbPrivyWallets = pgTable(
  'nb_privy_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => nbAgents.id, { onDelete: 'cascade' }),
    walletId: varchar('wallet_id', { length: 120 }).notNull(),
    address: varchar('address', { length: 64 }).notNull(),
    chain: varchar('chain', { length: 16 }).notNull().default('base'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agentChainUq: uniqueIndex('nb_privy_wallets_agent_chain_uq').on(t.agentId, t.chain),
  }),
);

/**
 * OTP challenges (Redis-first, this is a fallback for when REDIS_URL is unset).
 * Cleared on verify or expiry.
 */
export const nbOtpChallenges = pgTable(
  'nb_otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    codeHash: varchar('code_hash', { length: 80 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // W2-C hot path: expiry sweep / active-challenge lookup.
    expiresAtIdx: index('nb_otp_challenges_expires_at_idx').on(t.expiresAt),
  }),
);

/**
 * Agent-key registry (Redis-first cache; this is the source-of-truth row).
 */
export const nbAgentKeys = pgTable('nb_agent_keys', {
  key: varchar('key', { length: 80 }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => nbUsers.id),
  label: varchar('label', { length: 120 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

/* ──────────────────────────────────────────────────────────────────────────
 * MAZE facilitator — the get-paid layer. Offers (a thing sold) → Payments,
 * plus seller-registered webhook endpoints. Offers/payments index by id; the
 * public checkout resolves the seller from the offer (no session in that path).
 * ────────────────────────────────────────────────────────────────────────── */

export const nbOffers = pgTable(
  'nb_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => nbUsers.id),
    title: varchar('title', { length: 120 }).notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('USD'),
    type: varchar('type', { length: 16 }).notNull().default('one_time'),
    fulfillmentKind: varchar('fulfillment_kind', { length: 12 }).notNull().default('none'),
    fulfillmentValue: text('fulfillment_value'),
    active: boolean('active').notNull().default(true),
    livemode: boolean('livemode').notNull().default(true),
    // Route the base proceeds to a sub-account instead of the seller's main balance.
    // No .references() to avoid a table-ordering dependency on nb_sub_accounts.
    subAccountId: uuid('sub_account_id'),
    // SplitRule[] — auto-split a sale across sub-accounts (balance) + emails (payout).
    splits: jsonb('splits').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // F063 — listOffers orders by created_at per seller; mirrors the index
    // shape used on nb_payments. Added in migration 0013.
    sellerCreatedIdx: index('nb_offers_seller_created_idx').on(
      table.sellerId,
      table.createdAt,
    ),
  }),
);

export const nbPayments = pgTable('nb_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => nbOffers.id),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => nbUsers.id),
    offerTitle: text('offer_title').notNull(),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull(),
    buyerEmail: varchar('buyer_email', { length: 320 }),
    method: varchar('method', { length: 16 }).notNull().default('demo'),
    status: varchar('status', { length: 12 }).notNull().default('paid'),
    fulfillmentSent: boolean('fulfillment_sent').notNull().default(false),
    livemode: boolean('livemode').notNull().default(true),
    // F009 — idempotency key scoped per-seller via the compound uniqueIndex
    // below; a single global unique would force two sellers picking the same
    // free-form key to collide. Bridge transfers use the same pattern.
    idempotencyKey: varchar('idempotency_key', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sellerIdempotencyKeyUq: uniqueIndex('nb_payments_seller_idempotency_key_uq').on(
      table.sellerId,
      table.idempotencyKey,
    ),
    // F063 — listPayments orders by created_at desc per seller; the composite
    // index serves both the predicate and the sort without a sequential scan.
    sellerCreatedIdx: index('nb_payments_seller_created_idx').on(
      table.sellerId,
      table.createdAt,
    ),
  }),
);

export const nbWebhookEndpoints = pgTable('nb_webhook_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => nbUsers.id),
  url: text('url').notNull(),
  secret: varchar('secret', { length: 80 }).notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Public API keys (sk_test_/sk_live_) — the developer surface. Only the SHA-256
 * hash of the secret is stored; the raw secret is returned once at creation and
 * never persisted. last4 + prefix let the dashboard show a masked label.
 */
export const nbApiKeys = pgTable('nb_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => nbUsers.id),
  prefix: varchar('prefix', { length: 8 }).notNull(),
  keyHash: varchar('key_hash', { length: 80 }).notNull().unique(),
  last4: varchar('last4', { length: 8 }).notNull(),
  label: varchar('label', { length: 80 }),
  livemode: boolean('livemode').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * Sub-accounts — one KYC, many businesses. A named isolated balance under one
 * seller. Live + sandbox balances are tracked separately, like nb_user_state.
 */
export const nbSubAccounts = pgTable('nb_sub_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => nbUsers.id),
  name: varchar('name', { length: 80 }).notNull(),
  balUsd: numeric('bal_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  sandboxBalUsd: numeric('sandbox_bal_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Payouts — money out to a dev/collaborator. Debits the seller's balance
 * (live → nb_user_state.bal_usd, sandbox → sandbox_bal_usd). Demo settles
 * 'paid' immediately. Idempotent on idempotency_key.
 */
export const nbPayouts = pgTable(
  'nb_payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => nbUsers.id),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('USD'),
    destination: varchar('destination', { length: 320 }).notNull(),
    method: varchar('method', { length: 16 }).notNull().default('email'),
    note: text('note'),
    status: varchar('status', { length: 12 }).notNull().default('paid'),
    livemode: boolean('livemode').notNull().default(true),
    // F009 — see comment on nbPayments.idempotencyKey.
    idempotencyKey: varchar('idempotency_key', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sellerIdempotencyKeyUq: uniqueIndex('nb_payouts_seller_idempotency_key_uq').on(
      table.sellerId,
      table.idempotencyKey,
    ),
    sellerCreatedIdx: index('nb_payouts_seller_created_idx').on(
      table.sellerId,
      table.createdAt,
    ),
  }),
);

/**
 * Subscriptions — a recurring agreement, created when a `subscription`-type
 * offer is paid. renewSubscription credits the seller again + advances the
 * period; cancelSubscription marks it canceled. Money is numeric(18,6).
 */
export const nbSubscriptions = pgTable(
  'nb_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => nbUsers.id),
    offerId: uuid('offer_id').notNull(),
    offerTitle: text('offer_title').notNull(),
    buyerEmail: varchar('buyer_email', { length: 320 }),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('USD'),
    status: varchar('status', { length: 12 }).notNull().default('active'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    livemode: boolean('livemode').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // W2-C hot path: renewal/expiry sweep over active subscriptions.
    statusPeriodIdx: index('nb_subscriptions_status_period_idx').on(
      t.status,
      t.currentPeriodEnd,
    ),
  }),
);

/* ──────────────────────────────────────────────────────────────────────────
 * Bridge.xyz compliance perimeter — virtual (deposit) accounts. USD = ACH
 * (routing + account number); EUR = SEPA (iban + bic). Demo issues plausible
 * mock numbers; real numbers arrive once BRIDGE_API_KEY is set + KYB clears.
 * ────────────────────────────────────────────────────────────────────────── */

export const nbVirtualAccounts = pgTable(
  'nb_virtual_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id),
    currency: varchar('currency', { length: 8 }).notNull(),
    routingNumber: varchar('routing_number', { length: 40 }),
    accountNumber: varchar('account_number', { length: 60 }),
    iban: varchar('iban', { length: 60 }),
    bic: varchar('bic', { length: 20 }),
    bankName: varchar('bank_name', { length: 80 }).notNull(),
    livemode: boolean('livemode').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // W2-C hot path: per-user virtual-account lookup.
    userIdx: index('nb_virtual_accounts_user_idx').on(t.userId),
  }),
);

export const nbBridgeWebhookEvents = pgTable('nb_bridge_webhook_events', {
  ref: varchar('ref', { length: 160 }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => nbUsers.id),
  customerId: varchar('customer_id', { length: 80 }).notNull(),
  amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 — Bridge offramp payout methods (ACH/SEPA/wire/crypto). One row
 * per externally-linked destination account. Transfers (below) reference
 * exactly one method. user_id CASCADE so closing an account purges payouts.
 * ────────────────────────────────────────────────────────────────────────── */

export const nbPayoutMethods = pgTable('nb_payout_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => nbUsers.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 8 }).notNull(), // 'ach' | 'sepa' | 'wire' | 'crypto'
  externalAccountId: text('external_account_id').notNull(),
  label: text('label').notNull(),
  status: varchar('status', { length: 12 }).notNull().default('active'), // 'active' | 'disabled'
  livemode: boolean('livemode').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A Bridge.xyz off-ramp transfer. RESTRICT on payout_method_id keeps a
 * deleted method from orphaning an audit row; user_id CASCADE matches the
 * lift-out-with-account semantics from the rest of the schema.
 */
export const nbBridgeTransfers = pgTable(
  'nb_bridge_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    payoutMethodId: uuid('payout_method_id')
      .notNull()
      .references(() => nbPayoutMethods.id, { onDelete: 'restrict' }),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    status: varchar('status', { length: 12 }).notNull().default('pending'), // 'pending' | 'completed' | 'failed'
    externalRef: text('external_ref'), // Bridge transfer id
    idempotencyKey: varchar('idempotency_key', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalRefUq: uniqueIndex('nb_bridge_transfers_external_ref_uq').on(table.externalRef),
    userIdempotencyKeyUq: uniqueIndex('nb_bridge_transfers_user_idempotency_key_uq').on(
      table.userId,
      table.idempotencyKey,
    ),
  }),
);

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 — Markets trading (Hyperliquid + Polymarket). Read path stayed
 * read-only in Sprint 9; this lights up the write path with hard guards in
 * routes/markets.ts (region eligibility / idempotency / kill-switch).
 * ────────────────────────────────────────────────────────────────────────── */

export const nbMarketPositions = pgTable(
  'nb_market_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    venue: varchar('venue', { length: 16 }).notNull(), // 'hyperliquid' | 'polymarket' | …
    symbol: text('symbol').notNull(),
    sideLong: boolean('side_long').notNull(),
    qtyUsd: numeric('qty_usd', { precision: 18, scale: 6 }).notNull(),
    entryPriceUsd: numeric('entry_price_usd', { precision: 18, scale: 6 }).notNull(),
    // Sprint 1 lifecycle: widened from varchar(8) to varchar(20) to fit the full
    // MarketOrderStatus union. Old values (pending|open|closed|failed) remain
    // valid reads; new writes use the lifecycle vocabulary.
    status: varchar('status', { length: 20 }).notNull().default('open'),
    externalRef: text('external_ref'),
    idempotencyKey: varchar('idempotency_key', { length: 120 }),
    // Copy-trading attribution — wallet of the leaderboard trader this order
    // copied, set at order time from the client's copy intent. Display-only.
    copiedFrom: varchar('copied_from', { length: 64 }),
    // Append-only audit trail of every status transition. Each entry is
    // { status, ts, externalOrderId?, errorCode?, errorMessage?, providerPayload? }.
    // Read by the Order Detail Sheet to render the lifecycle timeline.
    lifecycleEvents: jsonb('lifecycle_events').notNull().default([]),
    avgFillPriceUsd: numeric('avg_fill_price_usd', { precision: 18, scale: 6 }),
    filledQtyUsd: numeric('filled_qty_usd', { precision: 18, scale: 6 }),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdempotencyKeyUq: uniqueIndex('nb_market_positions_user_idempotency_key_uq').on(
      table.userId,
      table.idempotencyKey,
    ),
    // 0037 — positions-history hot path (user_id, created_at DESC), the
    // nb_transactions_user_created_idx twin. Readiness audit 2026-07-16.
    userCreatedIdx: index('nb_market_positions_user_created_idx').on(
      table.userId,
      table.createdAt.desc().nullsFirst(),
    ),
  }),
);

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 — Campaigns + submissions + perks (creator/payout marketplace).
 * Constants live in apps/api/src/lib/campaigns/perks.ts — schema is just the
 * persistence layer. bonus_tiers is `{ viewsThreshold, bonusUsd }[]`.
 * ────────────────────────────────────────────────────────────────────────── */

export const nbCampaigns = pgTable('nb_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id')
    .notNull()
    .references(() => nbUsers.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  brand: text('brand').notNull(),
  baseUsd: numeric('base_usd', { precision: 18, scale: 6 }).notNull(),
  bonusTiers: jsonb('bonus_tiers').notNull(), // Array<{ viewsThreshold: number; bonusUsd: number }>
  topPrizeUsd: numeric('top_prize_usd', { precision: 18, scale: 6 }).notNull().default('0'),
  status: varchar('status', { length: 8 }).notNull().default('active'), // 'active' | 'closed'
  endAt: timestamp('end_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nbCampaignSubmissions = pgTable(
  'nb_campaign_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => nbCampaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    clipUrl: text('clip_url').notNull(),
    platform: varchar('platform', { length: 12 }).notNull(), // 'tiktok' | 'instagram' | 'youtube' | 'x'
    viewsAttested: integer('views_attested').notNull().default(0),
    viewsVerified: integer('views_verified').notNull().default(0),
    status: varchar('status', { length: 12 }).notNull().default('submitted'), // 'submitted' | 'approved' | 'paid' | 'rejected'
    paidUsd: numeric('paid_usd', { precision: 18, scale: 6 }).notNull().default('0'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Enforce MAX_SUBMISSIONS_PER_CAMPAIGN = 1 from lib/campaigns/perks.ts.
    campaignUserUq: uniqueIndex('nb_campaign_submissions_campaign_user_uq').on(
      t.campaignId,
      t.userId,
    ),
  }),
);

/** Per-user perks roll-up. PK is user_id (1:1). Tier is derived from points. */
export const nbUserPerks = pgTable('nb_user_perks', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => nbUsers.id, { onDelete: 'cascade' }),
  points: integer('points').notNull().default(0),
  tier: varchar('tier', { length: 12 }).notNull().default('starter'), // 'starter' | 'rising' | 'top'
  lifetimeEarnedUsd: numeric('lifetime_earned_usd', { precision: 18, scale: 6 })
    .notNull()
    .default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ──────────────────────────────────────────────────────────────────────────
 * Stack upgrades — Stripe Checkout correlation (Upgrade 4: multi-method
 * checkout). One row per Stripe `cs_…` session, persisted at session creation
 * so the `checkout.session.completed` webhook can resolve the offer + buyer
 * + amount without a Stripe re-fetch. session_id is unique; status walks
 * pending → completed | expired | failed. Idempotency on payOffer is keyed
 * off session_id at the route layer.
 * ────────────────────────────────────────────────────────────────────────── */

export const nbStripeSessions = pgTable('nb_stripe_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: varchar('session_id', { length: 120 }).notNull().unique(),
  offerId: uuid('offer_id')
    .notNull()
    .references(() => nbOffers.id, { onDelete: 'cascade' }),
  buyerEmail: varchar('buyer_email', { length: 120 }).notNull(),
  amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/* ──────────────────────────────────────────────────────────────────────────
 * Stack upgrades — Daily agent-spend digest idempotency (Upgrade 3). One row
 * per agent records the last digest cycle so the BullMQ Repeat worker doesn't
 * re-send for the same window. PK is agent_id (1:1).
 * ────────────────────────────────────────────────────────────────────────── */

export const nbAgentSpendDigests = pgTable('nb_agent_spend_digests', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => nbAgents.id, { onDelete: 'cascade' }),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
  lastWindowSpentUsd: numeric('last_window_spent_usd', { precision: 18, scale: 6 })
    .notNull()
    .default('0'),
});

/* ──────────────────────────────────────────────────────────────────────────
 * Tier 3 #14 — append-only audit log (compliance prereq per HANDOVER-FULL.md
 * §13). Forensic trail for who did what to which target, with structured
 * metadata + request id correlation. Never UPDATE; never DELETE — sweepers
 * archive by created_at if retention ever needs trimming.
 *
 * Indexes:
 *   - (actor_type, actor_id, created_at DESC) — "everything this admin did"
 *   - (action,                created_at DESC) — "every card.frozen event"
 *   - (created_at DESC)                       — global timeline scan / export
 * ────────────────────────────────────────────────────────────────────────── */

export const nbAuditLog = pgTable(
  'nb_audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorType: text('actor_type').notNull(), // 'user' | 'admin' | 'system' | 'agent'
    actorId: text('actor_id'),
    action: text('action').notNull(), // e.g. 'user.kyc.approved', 'card.frozen'
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').notNull().default({}),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorIdx: index('nb_audit_log_actor_idx').on(t.actorType, t.actorId, t.createdAt.desc()),
    actionIdx: index('nb_audit_log_action_idx').on(t.action, t.createdAt.desc()),
    createdAtIdx: index('nb_audit_log_created_at_idx').on(t.createdAt.desc()),
  }),
);

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 19 — Cross-chain transfer ledger.
 *
 * Bucket-to-bucket movement of USDC across the chains NEXA operates on
 * (Arbitrum perps · Polygon predictions · Solana memes · Base cash).
 * Source of truth for the bridge worker state machine:
 *   created → burning → attesting → minting → depositing → complete | failed
 *
 * `id` is a Stripe-style "tr_<nanoid>" string so the API surfaces a stable,
 * human-mentionable handle (Stripe sessions follow the same shape).
 * Idempotency is keyed on (user_id, idempotency_key) like nb_bridge_transfers
 * and nb_market_positions, so a retried POST returns the same transfer.
 * ────────────────────────────────────────────────────────────────────────── */

export const nbTransfers = pgTable(
  'nb_transfers',
  {
    id: varchar('id', { length: 40 }).primaryKey(), // 'tr_' + 32-char nanoid
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    // Buckets are logical; chains are physical. Both stored so the route
    // doesn't have to re-derive the chain from the bucket on every read.
    fromBucket: varchar('from_bucket', { length: 16 }).notNull(), // perps | predictions | memes | cash | external
    toBucket: varchar('to_bucket', { length: 16 }).notNull(),
    fromChain: varchar('from_chain', { length: 16 }).notNull(), // arbitrum | polygon | solana | base
    toChain: varchar('to_chain', { length: 16 }).notNull(),
    amountUsd: numeric('amount_usd', { precision: 18, scale: 6 }).notNull(),
    // Native token units (e.g. "5000000" for 5 USDC; 6 decimals). String so we
    // never lose precision through JS number conversion before signing.
    amountTokenAtoms: text('amount_token_atoms').notNull(),
    token: varchar('token', { length: 12 }).notNull().default('USDC'),
    // Which rail handled this transfer. `internal` = same-chain bucket move
    // (no on-chain hop), the rest map to the bridge router adapters.
    rail: varchar('rail', { length: 16 }).notNull(), // cctp | mayan | socket | lifi | hl_bridge | hl_withdraw | internal
    status: varchar('status', { length: 20 }).notNull().default('created'),
    // CCTP bookkeeping — null for non-CCTP rails. `message_body` is the raw
    // CCTP message bytes extracted from the burn tx's MessageSent log; needed
    // alongside the attestation when calling receiveMessage. Persisted so a
    // worker restart between attest and mint doesn't lose state.
    srcTxHash: varchar('src_tx_hash', { length: 80 }),
    dstTxHash: varchar('dst_tx_hash', { length: 80 }),
    // Alchemy EIP-7702 prepared-call IDs are chainId(32B)+userOpHash(32B) = 130
    // chars, well past a plain 66-char tx hash. Widened from 80 (mig 0030) after
    // real 7702 burns overflowed varchar(80) and stuck transfers at 'burning'.
    srcCallId: varchar('src_call_id', { length: 200 }),
    dstCallId: varchar('dst_call_id', { length: 200 }),
    cctpMessageHash: varchar('cctp_message_hash', { length: 80 }),
    cctpMessageBody: text('cctp_message_body'),
    cctpAttestation: text('cctp_attestation'),
    // 2026-07-08 (ADR-0005) — which CCTP protocol version this transfer's
    // burn used. Persisted at burn-submit time so an env-flag flip mid-flight
    // can't misroute the attest/mint hops of an in-flight transfer. Null =
    // pre-V2 row (V1) or non-CCTP rail.
    cctpVersion: integer('cctp_version'),
    feesUsd: numeric('fees_usd', { precision: 18, scale: 6 }).notNull().default('0'),
    error: jsonb('error'),
    idempotencyKey: varchar('idempotency_key', { length: 120 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Same idempotency contract as nb_bridge_transfers — replay returns the
    // existing transfer instead of creating a second.
    userIdempotencyKeyUq: uniqueIndex('nb_transfers_user_idempotency_key_uq').on(
      t.userId,
      t.idempotencyKey,
    ),
    // GET /transfers (per-user history) — order by created_at desc.
    userCreatedIdx: index('nb_transfers_user_created_idx').on(t.userId, t.createdAt.desc()),
    // Worker scanning — pick up rows that are mid-flight after a restart.
    statusIdx: index('nb_transfers_status_idx').on(t.status),
  }),
);

/**
 * Append-only audit trail for each transfer's state transitions. One row per
 * status change, attestation hit, tx submission, etc. Lets the API answer
 * "what happened to this transfer" without depending on log retention.
 */
export const nbTransferEvents = pgTable(
  'nb_transfer_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    transferId: varchar('transfer_id', { length: 40 })
      .notNull()
      .references(() => nbTransfers.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 40 }).notNull(), // created | state_change | attestation_received | tx_submitted | tx_confirmed | error
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    transferCreatedIdx: index('nb_transfer_events_transfer_created_idx').on(
      t.transferId,
      t.createdAt,
    ),
  }),
);

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 20 — Collector Crypt trade ledger.
 *
 * Audit row per buy/sell against the CC marketplace
 * (`api.collectorcrypt.com`, USDC SPL settlement on Solana).
 * Mirrors the nb_market_positions pattern: idempotency keyed on `signature`
 * since the Solana tx signature IS the natural dedup key — submitting the
 * same signed tx twice gets the same signature back and we return the
 * existing row instead of double-recording.
 * ────────────────────────────────────────────────────────────────────────── */

export const nbCcTrades = pgTable(
  'nb_cc_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => nbUsers.id, { onDelete: 'cascade' }),
    side: varchar('side', { length: 8 }).notNull(), // 'buy' | 'sell' | 'offer'
    nftAddress: varchar('nft_address', { length: 64 }).notNull(),
    cardId: varchar('card_id', { length: 64 }),
    name: text('name'),
    imageUrl: text('image_url'),
    priceUsdc: numeric('price_usdc', { precision: 18, scale: 6 }).notNull(),
    feeUsdc: numeric('fee_usdc', { precision: 18, scale: 6 }).notNull().default('0'),
    tokenStandard: varchar('token_standard', { length: 8 }), // 'Pnft' | 'Cnft' | 'Nft' | 'Core'
    signature: varchar('signature', { length: 100 }),
    status: varchar('status', { length: 16 }).notNull().default('submitted'), // 'submitted' | 'confirmed' | 'failed'
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('nb_cc_trades_user_created_idx').on(t.userId, t.createdAt.desc()),
    signatureUq: uniqueIndex('nb_cc_trades_signature_uq').on(t.signature),
  }),
);

export const nbPmLeaderboardSnapshots = pgTable(
  'nb_pm_leaderboard_snapshots',
  {
    key: varchar('key', { length: 128 }).primaryKey(),
    sort: varchar('sort', { length: 16 }).notNull(),
    traderLimit: integer('trader_limit').notNull(),
    marketLimit: integer('market_limit').notNull(),
    payload: jsonb('payload').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('nb_pm_leaderboard_snapshots_expires_idx').on(t.expiresAt),
    paramsIdx: index('nb_pm_leaderboard_snapshots_params_idx').on(
      t.sort,
      t.traderLimit,
      t.marketLimit,
    ),
  }),
);

/**
 * 2026-07-08 (ADR-0004) — audit trail of Hyperliquid agent-wallet approvals.
 * One row per master-signed `approveAgent` action we submit. Append-only:
 * approval STATE lives in-process (the agent key is ephemeral per process);
 * this table answers "which agent keys were ever authorized to trade for
 * which wallet, and when" for incident response. Keyed by wallet address —
 * the signer identity Hyperliquid sees — not user id.
 */
export const nbHlAgents = pgTable(
  'nb_hl_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Master wallet (Privy EVM address) that signed the approval. */
    userWalletAddress: varchar('user_wallet_address', { length: 42 }).notNull(),
    /** Agent public address registered on Hyperliquid. */
    agentAddress: varchar('agent_address', { length: 42 }).notNull(),
    agentName: varchar('agent_name', { length: 32 }),
    /** hostname:pid of the process holding the ephemeral private key. */
    processId: varchar('process_id', { length: 80 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    walletIdx: index('nb_hl_agents_wallet_idx').on(t.userWalletAddress),
  }),
);

/**
 * 2026-07-08 (ADR-0006 Phase 2) — scan cursors for on-chain reconciliation
 * sweeps. One row per (chain, concern) key, e.g. `base:usdc-deposits`,
 * holding the last block already scanned. A crashed sweep resumes from the
 * cursor and re-offers deposits; creditDeposit's tx-hash idempotency makes
 * the re-offer harmless.
 */
export const nbChainCursors = pgTable('nb_chain_cursors', {
  key: varchar('key', { length: 64 }).primaryKey(),
  lastBlock: bigint('last_block', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

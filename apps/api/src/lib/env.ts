import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  API_PORT: z.coerce.number().int().positive().default(8090),

  /** Demo mode: in-memory ledger, mock OTP auth, no external calls. */
  DEMO_MODE: z
    .string()
    .default('1')
    .transform((v) => v === '1' || v === 'true'),

  /** HS256 secret for session JWTs. Fine to be static in demo mode. */
  JWT_SECRET: z.string().min(16).default('nexa-demo-secret-change-in-prod'),

  /**
   * F020 — optional comma-separated list of HS256 secrets for zero-downtime
   * rotation. New tokens are signed with the FIRST secret; verification
   * accepts ANY secret in the list. Rotation: set JWT_SECRETS="<new>,<old>",
   * redeploy. After max session age (30 days — SESSION_TTL_SECONDS) drop the
   * old with JWT_SECRETS="<new>". Unset = single-secret behavior (no change).
   */
  JWT_SECRETS: z.string().optional(),

  /**
   * F020 — observability label for the currently active signing secret.
   * Embedded as the `kid` claim in every issued token. Operators can audit
   * which key minted a session without reading the secret value itself.
   * Bump this whenever you rotate JWT_SECRETS (e.g. "k1" → "k2"). Optional;
   * defaults to "k1" when unset.
   */
  JWT_KID_CURRENT: z.string().optional(),

  /**
   * Red-team P1-8 — no-jti session cutover override. Session tokens minted
   * before the jti upgrade (5eeb8d0, 2026-07-10) carry no `jti` and cannot be
   * revoked. They are honored until SESSION_JTI_REQUIRED_AFTER_MS (2026-08-11,
   * see lib/auth.ts) so the 2026-07-02..07-10 sign-in cohort isn't
   * mass-signed-out. This flag overrides that date:
   *   '1' → force the cutover early (emergency — a known pre-jti token is loose);
   *   '0' → hold the gate open past the date (escape hatch, no deploy);
   *   unset → date-based default. See docs/FEATURE_FLAGS.md.
   */
  SESSION_REQUIRE_JTI: z.enum(['0', '1']).optional(),

  /** Demo MCP/API keys accepted for agent surface (comma-separated). */
  NEXA_AGENT_KEYS: z.string().default('nx_live_7f3k_demo'),

  /** Explicit guardrail for running the demo ledger/auth stack under NODE_ENV=production. */
  ALLOW_DEMO_IN_PRODUCTION: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),

  /**
   * F093 Sprint 18 — route POST /markets/<venue>/order through the unified
   * `MarketAdapter` + parameterised handler (`router-v2`). Off by default so
   * the legacy per-venue handlers stay live during shadow-test. Flip to '1'
   * per pod once the v2 path's responses are byte-identical to the legacy
   * shape across the whole venue matrix.
   */
  MARKETS_ROUTER_V2: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),

  /**
   * Phase A — realtime fan-out hub dark launch.
   * '0' = `/v1/stream/sse` + `/v1/feeds/health` return 404 (the routes are
   * not mounted). '1' = routes mount; the hub still only opens upstream
   * sockets on first client subscribe so flipping to '1' on an idle pod is
   * zero-cost. Model + rollout cadence mirror `MARKETS_ROUTER_V2`.
   */
  REALTIME_HUB_V1: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),

  /** Comma-separated NEO subsystems disabled by the operator at runtime. */
  SAFE_MODE_DISABLED: z.string().default(''),

  /** Max distinct topics one realtime client may subscribe to at once. */
  REALTIME_MAX_TOPICS_PER_CLIENT: z.coerce.number().int().positive().default(200),

  /** Sliding-window inbound msg cap per realtime client (per second). */
  REALTIME_MAX_MSGS_PER_SEC: z.coerce.number().int().positive().default(50),

  /**
   * Scale plan 1.5 — hard ceiling on concurrent WS clients per process.
   * Past it, new upgrades are shed with close 1013 so existing clients keep
   * their latency. Sized for the single-process deployment; raise with
   * replicas.
   */
  REALTIME_MAX_CLIENTS: z.coerce.number().int().positive().default(1500),

  /**
   * Readiness audit 2026-07-16 — per-user cap inside the global budget.
   * Bounds one credential (or a leaked stream ticket) to a handful of
   * sockets instead of the whole pool. 8 ≈ web + mobile + a few tabs.
   */
  REALTIME_MAX_CONNS_PER_USER: z.coerce.number().int().positive().default(8),

  /**
   * Per-source-IP cap. The key comes from lib/rate-limit.ts clientIp(),
   * trust-gated by TRUSTED_PROXY_HOPS — forged x-forwarded-for values can't
   * rotate past the cap. NAT-friendly: one office egress gets 64.
   */
  REALTIME_MAX_CONNS_PER_IP: z.coerce.number().int().positive().default(64),

  /**
   * Server→client WS keepalive interval ms (0 = off). Defeats proxy idle
   * reaping on quiet subscriptions and surfaces dead peers via send failure.
   */
  REALTIME_KEEPALIVE_MS: z.coerce.number().int().min(0).default(30_000),

  /**
   * WS-P0-2 (wave 3) — approximate MAXLEN (`~`) trim for the shared lifecycle
   * event stream `nb:lifecycle:events`. With >1 API replica the private
   * order/fill/account lifecycle fan-out rides a Redis stream so a user on
   * pod B receives events for an order mutated on pod A (or by a worker).
   * Each pod tails from `$`, so only the tail matters — history beyond this
   * cap is trimmed to bound Redis memory. Applies only when REDIS_URL is set;
   * demo/dev keeps the in-process emitter (no stream, no cross-pod gap).
   */
  LIFECYCLE_STREAM_MAXLEN: z.coerce.number().int().positive().default(10_000),

  /** Pyth Hermes streaming base URL — used by the (next) pyth-hermes venue. */
  PYTH_HERMES_URL: z.string().default('https://hermes.pyth.network'),

  /** Demo OTP code accepted when Privy is not configured. */
  DEMO_OTP_CODE: z.string().length(6).default('482019'),

  /* ── persistence ── */
  /** Postgres DSN. Scheme-refined so a typo'd value fails loudly at boot
      instead of silently falling back to the in-memory store (readiness
      audit 2026-07-16). Blank normalizes to unset FIRST (Codex review
      2026-07-16): demo/in-process producers legitimately export
      `DATABASE_URL=''` — Compose's `${MAZE_DATABASE_URL:-}` fallback and the
      probe scripts that clear the DSN to force the in-memory store. The
      prod fail-closed guard still rejects *unset*, so blank cannot sneak a
      production boot past persistence checks. */
  DATABASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .regex(/^postgres(ql)?:\/\/\S+$/, 'DATABASE_URL must be a postgres(ql):// DSN')
      .optional(),
  ),
  REDIS_URL: z.string().optional(),

  /* ── Privy server auth (optional — falls back to demo OTP) ── */
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  PRIVY_VERIFICATION_KEY: z.string().optional(),
  /* Authorization keypair for server-side signing of user-owned wallets.
     Without it, walletApi RPC signing 401s ("no valid authorization keys")
     and every live money path (swap/order/deposit/transfer) silently fails.
     PRIVATE_KEY (wallet-auth:… PKCS8) configures the client; KEY_ID is the
     dashboard key id registered as an additionalSigner on wallets so the
     server can sign while the user keeps ownership. */
  PRIVY_AUTHORIZATION_PRIVATE_KEY: z.string().optional(),
  PRIVY_AUTHORIZATION_KEY_ID: z.string().optional(),

  /* ── Live-trade region gate ── */
  /** Comma-separated account emails allowed to bypass the live-write country
      block (named internal smoke-test accounts ONLY — exempt trades still
      emit a 'region_exempt' metric). Unset/empty → nobody is exempt. */
  LIVE_WRITE_REGION_EXEMPT_EMAILS: z.string().optional(),

  /* ── Resend email (optional — falls back to stdout) ── */
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('MAZE <hello@nexa.aiso.tools>'),

  /* ── Chain (optional — DeFi / x402 settle gate behind these) ── */
  BASE_RPC_URL: z.string().optional(),
  CHAINSTACK_BASE_RPC_URL: z.string().optional(),
  GNOSIS_RPC_URL: z.string().default('https://rpc.gnosischain.com'),
  /* ── Sprint 19 — multi-chain RPC URLs for /balances + CCTP routing ── */
  /** Arbitrum mainnet RPC. Optional; defaults to public arb1.arbitrum.io/rpc. */
  ARBITRUM_RPC_URL: z.string().optional(),
  /** Polygon PoS mainnet RPC. Optional; defaults to public polygon-bor-rpc.publicnode.com. */
  POLYGON_RPC_URL: z.string().optional(),
  /** Optimism mainnet RPC. Optional; defaults to public mainnet.optimism.io. */
  OPTIMISM_RPC_URL: z.string().optional(),
  /** Onramper widget API key. Optional; falls back to buy-sandbox widget. */
  ONRAMPER_API_KEY: z.string().optional(),
  /* ── Alchemy Wallet API / Gas Manager (optional — EIP-7702 sponsored batch) ── */
  ALCHEMY_API_KEY: z.string().optional(),
  ALCHEMY_GAS_POLICY_ID: z.string().optional(),
  /** yoUSD ERC-4626 vault on Base (primary earn). */
  YOUSD_ADDRESS: z.string().default('0x0000000f2eB9f69274678c76222B35eEc7588a65'),
  /** USDC on Base mainnet. Override for testnets. */
  USDC_ADDRESS: z.string().default('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  /** EURC on Base mainnet. */
  EURC_ADDRESS: z.string().default('0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'),
  /** Aave v3 Pool on Base mainnet. */
  AAVE_POOL_ADDRESS: z.string().default('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'),
  /** aUSDC on Base (received from Aave deposit). */
  AUSDC_ADDRESS: z.string().default('0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB'),
  /** Compound v3 Comet (cUSDCv3) market on Base mainnet (diversification venue). */
  COMPOUND_COMET_ADDRESS: z.string().default('0xb125E6687d4313864e53df431d5425969c15Eb2F'),
  /**
   * MetaMorpho ERC-4626 USDC vault on Base mainnet — the "Standard" tier
   * pick in the earn router (Steakhouse-curated, the same vault that backs
   * Coinbase's USDC lending product launched in 2025).
   *
   * Address: 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183
   * Source:  https://app.merkl.xyz/opportunities/base/MORPHOVAULT/0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183
   *          https://morpho.org/blog/morpho-is-now-powering-usdc-lending-on-coinbase/
   * Retrieved: 2026-06-14
   */
  MORPHO_VAULT_ADDRESS: z.string().default('0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183'),
  /**
   * Steakhouse High Yield USDC v1.1 vault (bbqUSDC) — the higher-yield tier
   * Morpho vault Coinbase wired as their "USDC High Yield" product (powered by
   * Ethena USDe; Steakhouse-curated). 7.87% APY at announcement (12 Jun 2026);
   * net APY varies with Ethena's USDe rate. Use this address for the
   * higher_yield tier when the user opts up the risk curve.
   * Source: Coinbase + @SteakhouseFi + Morpho announcement 2026-06-12.
   */
  MORPHO_HIGH_YIELD_VAULT_ADDRESS: z
    .string()
    .default('0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F'),
  /** Morpho GraphQL API for real vault APY reads. */
  MORPHO_API_URL: z.string().url().default('https://api.morpho.org/graphql'),
  /**
   * Optional yoUSD APY endpoint. Leave unset rather than showing a fake rate;
   * the adapter reports APY unavailable until a real provider URL is configured.
   */
  YOUSD_APY_URL: z.string().url().optional(),

  /* ── x402 facilitator ── */
  X402_FACILITATOR_URL: z.string().default('https://x402.coinbase.com'),

  /** Public base for generated one-time payment links. */
  PAY_LINK_BASE_URL: z.string().url().default('https://maze.to/pay'),

  /** Public base for email claim links. */
  CLAIM_LINK_BASE_URL: z.string().url().default('https://maze.aiso.tools/claim'),

  /** Public base for hosted offer checkout links — `${CHECKOUT_BASE_URL}/${offerId}`. */
  CHECKOUT_BASE_URL: z.string().url().default('https://maze.to/o'),

  /* ── LIFI (optional cross-chain swap) ── */
  LIFI_API_KEY: z.string().optional(),

  /* ── Socket (optional cross-chain swap aggregator, primary in bridge-router) ──
   * Socket Swap V3 API (formerly the standalone Socket Liquidity Layer). When
   * SOCKET_API_KEY is set the bridge router prefers Socket and falls back to
   * LIFI if no route. Default base hits the API-key-gated dedicated backend so
   * the `x-api-key` header is meaningful; without a key, set SOCKET_API_BASE
   * to https://backend.socket.tech (domain-whitelist endpoint).
   *
   * Source: https://docs.socket.tech/integrate/get-api-access  (2026-06-14)
   *         https://docs.socket.tech/integrate/integration-guides/socket-api.md
   *         openapi.json — GET /v3/swap/quote, refuel=true|false query param.
   */
  SOCKET_API_KEY: z.string().optional(),
  SOCKET_API_BASE: z.string().default('https://backend.socket.tech'),
  /**
   * Optional Socket integrator/affiliate ID — sent as the `AFFILIATE-ID`
   * header so bridge routes earn affiliate fees. Independent of the API key
   * (a key can run without an affiliate ID); when set, every /v3/swap/quote
   * carries it. Secret — VPS env only, never committed.
   */
  SOCKET_AFFILIATE_ID: z.string().optional(),

  /* ── Gnosis Pay (optional — Safe deploy + virtual card mint; gates the card layer) ── */
  GNOSIS_PAY_BASE: z.string().default('https://api.gnosispay.com'),
  GNOSIS_PAY_API_KEY: z.string().optional(),

  /* ── Ethena sUSDe (read-only headline yield tile; deposit deep-links to ethena.fi) ── */
  ETHENA_API_URL: z.string().optional(),
  ETHENA_DEPOSIT_URL: z.string().optional(),

  /* ── Jupiter Lend (read-only headline yield tile; deposit deep-links to jup.ag/lend) ── */
  JUPITER_LEND_API_URL: z.string().optional(),
  JUPITER_LEND_DEPOSIT_URL: z.string().optional(),

  /* ── DefiLlama Yields API (cross-protocol best-yield aggregator; no auth) ── */
  DEFILLAMA_YIELDS_URL: z.string().optional(),

  /* ── Laso Finance (optional — Base + USDC native card issuer; S10) ── */
  LASO_API_BASE: z.string().default('https://api.laso.finance'),
  LASO_API_KEY: z.string().optional(),

  /**
   * Card issuer selector. Default `gnosis-pay` preserves current behavior;
   * flip to `laso` once LASO_API_KEY lands in /opt/neobank/secrets/maze.env.
   * `sponge` and `solcard` are reserved for future wrappers.
   */
  CARD_ISSUER: z.enum(['gnosis-pay', 'sponge', 'laso', 'solcard']).default('gnosis-pay'),

  /* ── Sponge (optional — agent card + bank account issuance) ── */
  SPONGE_API_KEY: z.string().optional(),
  SPONGE_API_BASE: z.string().default('https://api.paysponge.com'),

  /* ── Bridge.xyz (optional — KYC + fiat virtual accounts; gates real money in/out) ── */
  BRIDGE_API_KEY: z.string().optional(),
  BRIDGE_API_BASE: z.string().default('https://api.sandbox.bridge.xyz'),
  BRIDGE_WEBHOOK_SECRET: z.string().optional(),

  /* ── Monerium (optional — EU EUR ⇄ EURe ⇄ SEPA via Gnosis Chain).
   * Alternative to Bridge for EU users while Bridge KYB is pending. The IBAN
   * is issued in the user's name (not custodial-to-MAZE) because Monerium is
   * an EU e-money institution. OAuth client-credentials flow against /auth/token.
   * Source: https://monerium.dev/docs (2026-06-17). */
  MONERIUM_API_KEY: z.string().optional(),
  MONERIUM_API_SECRET: z.string().optional(),
  MONERIUM_API_BASE: z.string().optional(),

  /* ── Stripe Checkout (optional — hosted card/Apple-Pay path on the public
   * checkout). When STRIPE_SECRET_KEY is set the /checkout/:id/pay route
   * accepts `method: 'card'` and returns a hosted-page redirectUrl. Without
   * the key, the route still accepts 'card' and returns a synthetic
   * `cs_demo_<hex>` + `/checkout-demo-success` redirect so e2e fixtures don't
   * require a Stripe account. The webhook secret gates HMAC verification of
   * `checkout.session.completed`; without it, the webhook returns 400.
   *
   * Pinned apiVersion follows @stripe/stripe-node v22.2.1 (2026-05-27.dahlia).
   * Source: https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md
   *         Retrieved 2026-06-14.
   * ── */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SUCCESS_URL: z
    .string()
    .default('https://checkout.maze.bank/return?session={CHECKOUT_SESSION_ID}'),
  STRIPE_CANCEL_URL: z
    .string()
    .default('https://checkout.maze.bank/cancel?session={CHECKOUT_SESSION_ID}'),

  /* ── Sumsub (optional — applicant KYC; gates identity verification) ── */
  SUMSUB_APP_TOKEN: z.string().optional(),
  SUMSUB_SECRET_KEY: z.string().optional(),
  SUMSUB_BASE: z.string().default('https://api.sumsub.com'),

  /* ── Market data (read-only public APIs — Hyperliquid + Polymarket).
     Defaults ON so the demo surfaces sample prices/odds with no config. */
  MARKETS_ENABLED: z
    .string()
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  JUPITER_SWAPS_ENABLED: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /**
   * NEXA platform fee on every Jupiter swap, in basis points (50 = 0.50%).
   * Capped at 100 by Jupiter. Default 0 = pass-through. Production target:
   * 50 bps on memes + xStocks. Collected in the OUTPUT token at the user's
   * `JUPITER_PLATFORM_FEE_ACCOUNT` ATA. Pairs with `JUPITER_PLATFORM_FEE_ACCOUNT`.
   */
  JUPITER_PLATFORM_FEE_BPS: z.coerce.number().int().nonnegative().max(100).default(0),
  /**
   * Solana base58 address of the NEXA fee receiver. When `JUPITER_PLATFORM_FEE_BPS`
   * is > 0, Jupiter routes the platform fee here (the user pre-creates an ATA
   * for the OUTPUT token at this account, or sends a wrapped-SOL fee account).
   * Without this address, fees are skipped even if BPS is set.
   */
  JUPITER_PLATFORM_FEE_ACCOUNT: z.string().optional(),
  /**
   * Optional paid Jupiter API key. When set, swap/token/price traffic moves
   * off the shared keyless `lite-api.jup.ag` pool (heavily rate-limited —
   * live 429 storms on /quote, 2026-07-06) onto `api.jup.ag` with the key in
   * the `x-api-key` header. Leave unset to stay on the free tier.
   */
  JUPITER_API_KEY: z.string().optional(),
  /* ── Sprint 20 — Collector Crypt (Solana NFT card marketplace) ───────────
   * NEO trading-terminal Cards tab proxies through these endpoints. CC's API
   * is keyless (wallet-sig auth); NEXA proxies so signing key material stays
   * server-side and so the live status reports through /system/providers.
   * Set CC_ENABLED=0 to hide the surface entirely (cards routes return 503). */
  CC_API_BASE: z.string().url().default('https://api.collectorcrypt.com'),
  CC_ENABLED: z
    .string()
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  /** Builder address surfaced in Hyperliquid builder-fee approval params. */
  HL_BUILDER_ADDRESS: z.string().optional(),
  /** Hyperliquid builder fee in tenths of a basis point (25 = 2.5 bps = 0.025%). */
  HYPERLIQUID_BUILDER_FEE_TENTHS_BP: z.coerce.number().int().nonnegative().optional(),
  /** Hyperliquid referral code surfaced on user trades. */
  HYPERLIQUID_REFERRAL_CODE: z.string().optional(),

  /** Polymarket CLOB API key — when set, the markets trade path goes live. */
  POLY_API_KEY: z.string().optional(),
  /** Polymarket CLOB API secret (Basic-auth pair with POLY_API_KEY). */
  POLYMARKET_BUILDER_API_SECRET: z.string().optional(),
  /** Polymarket CLOB API passphrase (third leg of the auth tuple). */
  POLYMARKET_BUILDER_API_PASSPHRASE: z.string().optional(),
  /** Polymarket builder address — collects the per-order fee. */
  POLYMARKET_BUILDER_ADDRESS: z.string().optional(),
  /** Polymarket builder fee in basis points (100 = 1%). */
  POLYMARKET_BUILDER_FEE_BPS: z.coerce.number().int().nonnegative().optional(),
  /** Polymarket builder code surfaced on every order. */
  POLYMARKET_BUILDER_CODE: z.string().optional(),
  /** Polymarket relayer base URL override (default https://relayer-v2.polymarket.com). */
  PM_RELAYER_URL: z.string().optional(),
  /**
   * "Relayer API keys" pair from polymarket.com/settings?tab=builder — sent
   * verbatim as RELAYER_API_KEY / RELAYER_API_KEY_ADDRESS headers on every
   * builder-relayer request (Safe deploy / approvals / CTF ops).
   */
  POLYMARKET_RELAYER_API_KEY: z.string().optional(),
  POLYMARKET_RELAYER_API_KEY_ADDRESS: z.string().optional(),
  /**
   * '1'/'true' → CLOB orders ride the per-user Safe (signatureType 2) builder
   * lane whenever the user's Safe is verified trade-ready; otherwise legacy
   * lanes. Kill-switch stays OFF until the live $1 proof lands.
   */
  PM_BUILDER_LANE: z.string().optional(),

  /**
   * NEO platform skim on internal cross-chain CCTP transfers (`/transfers/internal`),
   * in basis points (10 = 0.10%). Default 0 = pass-through. Capped at 100 (1%) so
   * a misconfigured value can't ever exceed bridge spread. Burn amount sent to
   * Circle is `requested - (requested * BPS / 10000)`; the skim is recorded via
   * `recordFee({ venue: 'cctp-bridge' })` so it shows up in the same Prometheus +
   * ring-buffer infrastructure as Jupiter / HL / PM fees.
   */
  NEO_BRIDGE_FEE_BPS: z.coerce.number().int().nonnegative().max(100).default(0),
  /**
   * CCTP protocol version cutover (ADR-0005). '0' (default) keeps the proven
   * V1 burn/attest/mint path; '1' routes NEW transfers through CCTP V2
   * (TokenMessengerV2, iris /v2 attestation, Fast Transfer when a fee quote
   * is available). In-flight transfers always finish on the version their
   * burn used (persisted in nb_transfers.cctp_version). Circle begins V1
   * phase-out 2026-07-31 — the flag exists so cutover is config, not deploy.
   */
  CCTP_V2: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /**
   * Hyperliquid per-process agent wallets (ADR-0004). '1' routes L1 actions
   * (orders/cancels/leverage/margin — NOT fund moves) through an ephemeral
   * process-local agent key registered via master-signed approveAgent on a
   * user's first live action. Gives each process its own 100-nonce window,
   * eliminating multi-process nonce races. Approval failures fall back to
   * master-wallet signing, so flipping this on can slow the first action per
   * user but never break it. Default off.
   */
  HL_AGENT_WALLETS: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /**
   * ADR-0006 Phase 2 — on-chain deposit reconciliation. '1' enables the
   * scheduler worker that scans Base USDC Transfer logs to user wallets and
   * credits the app ledger (idempotent on tx hash). Postgres-only; no-op in
   * demo/in-memory mode. Default off until the supervised live test passes.
   */
  DEPOSIT_RECONCILER: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /**
   * ADR-0004 part 2 — Hyperliquid user-data streaming. '1' lets the realtime
   * hub open per-user webData2 + userFills upstream subscriptions (sharded,
   * ≤10 users per connection, ≤10 connections) and fan them out on
   * `priv:<userId>:account` / `priv:<userId>:fills`. The web client
   * feature-detects by event arrival and suppresses its REST polls while the
   * stream is fresh, so flipping this off (default) restores pure polling
   * with no client change. Default off until the supervised live canary.
   */
  HL_USER_STREAMS: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /**
   * Treasury addresses receiving the bridge skim on each supported source chain.
   * When `NEO_BRIDGE_FEE_BPS > 0` and the matching treasury address is set, the
   * fee burn route emits an extra transfer to the treasury before the CCTP burn.
   * Leave any chain blank to skip the skim on that source even when BPS > 0.
   */
  NEO_BRIDGE_TREASURY_ARB: z.string().optional(),
  NEO_BRIDGE_TREASURY_POL: z.string().optional(),
  NEO_BRIDGE_TREASURY_BASE: z.string().optional(),
  NEO_BRIDGE_TREASURY_SOL: z.string().optional(),

  /**
   * SEC-01 — base64-encoded 32-byte master key for at-rest encryption of
   * Polymarket CLOB credentials (and any other small per-user secrets that
   * land in nb_users). Generate via `openssl rand -base64 32`. In
   * NODE_ENV=production this MUST be set; in dev/test, unset = pass-through
   * (encryption is a no-op so existing fixtures keep working). Rotation
   * requires re-deriving each user's CLOB triple via
   * `setPmClobCredentials({force:true})`.
   */
  PM_CLOB_ENC_KEY: z.string().optional(),

  /* ── Solana RPC for Marinade staking (read surface lives on the public
     Marinade REST API; the write surface needs an RPC for tx submit). The
     adapter reads via process.env to support either Chainstack, Helius, or a
     vanilla SOLANA_RPC_URL — declaring all three here keeps the F075
     coverage gate honest. */
  CHAINSTACK_SOLANA_RPC_URL: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),
  HELIUS_RPC_URL: z.string().optional(),

  /** Privy webhook secret — validates auth.* events posted to /auth/privy-webhook. */
  PRIVY_WEBHOOK_SECRET: z.string().optional(),

  /* ── CORS ── */
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  PORTAL_ORIGIN: z.string().default('http://localhost:5173'),

  /* ── Observability (Sprint 10 Phase 2 δ) ── */
  /** Sentry DSN — when set, error/warn reporting is wired through @sentry/node. */
  SENTRY_DSN: z.string().optional(),
  /** Sentry traces sample rate (0–1, default 0.1). */
  SENTRY_TRACES_SAMPLE_RATE: z.string().optional().default('0.1'),
  /** Enable the Prometheus /metrics endpoint. METRICS_TOKEN required at runtime. */
  METRICS_ENABLED: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /** Bearer token required to read /metrics when METRICS_ENABLED. */
  METRICS_TOKEN: z.string().optional(),
  /**
   * W2-B — port for the scheduler container's standalone /metrics +
   * /health/live server (the API's Hono /metrics doesn't run there).
   */
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(8091),

  /* â”€â”€ Web Push (optional PWA notifications) â”€â”€ */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:ops@maze.to'),

  /* ── Sprint 10 Phase 2 ε: admin sweep routes ── */
  /**
   * Bearer token gating POST /admin/sweep-claims and /admin/sweep-subscriptions —
   * the manual fallback for the BullMQ repeat workers when Redis is unavailable
   * or an on-call needs an immediate run. When unset, every request is rejected
   * with 401 so the routes are inert by default.
   */
  ADMIN_TOKEN: z.string().optional(),

  /* ── Sprint 11 Phase 0: hardening middleware ──
   * RATE_LIMIT_ENABLED can be flipped to false in dev/test to bypass the
   * sliding-window counter without unmounting middleware. The webhook
   * freshness window guards bridge/kyc replay; 5 min matches Stripe's window. */
  RATE_LIMIT_ENABLED: z
    .string()
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  WEBHOOK_FRESHNESS_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),

  /**
   * W2-B — rate-limiter behavior when the Redis backend is degraded or
   * missing (unparseable URL, connect/INCR failure, unconfigured). 'open'
   * falls back to the in-memory counter (pre-W2 behavior); 'closed' rejects
   * with 503. Unset derives from the runtime: closed in real production
   * (NODE_ENV=production && !DEMO_MODE), open in dev/demo/test.
   */
  RATE_LIMIT_FAIL_MODE: z.enum(['open', 'closed']).optional(),

  /**
   * W2-B — number of trusted reverse proxies appending to x-forwarded-for
   * (Caddy = 1 in prod). clientIp() takes the entry `hops` from the right,
   * so a client-supplied (spoofed) leftmost hop is never trusted. 0 means
   * "no trusted proxy": ignore x-forwarded-for/x-real-ip and use the socket
   * peer address.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  /**
   * Codex review 2026-07-16 [P1] — end-client identity behind a CDN/tunnel
   * front. In the deployed topology (browser → Cloudflare edge → cloudflared
   * → Caddy → API) the x-forwarded-for hop Caddy appends is the tunnel-side
   * peer, not the browser, so every user collapsed into ONE realtime per-IP
   * bucket and the 65th concurrent socket shed with `ip_capacity` — far
   * below REALTIME_MAX_CLIENTS. When set (prod compose: `cf-connecting-ip`),
   * clientIp() prefers this proxy-set end-client header. Trust-gated like
   * x-forwarded-for: honored only while TRUSTED_PROXY_HOPS > 0, because a
   * direct-origin client can forge any header (Cloudflare overwrites this
   * one at the edge). Empty/unset = disabled (spoof-safe default).
   */
  TRUSTED_CLIENT_IP_HEADER: z.string().trim().toLowerCase().default(''),

  /**
   * WORKER-P1-1 — fills-notifier scale-out. The worker used to cap its poll
   * at a single 500-user page (silently dropping the tail of the population)
   * and kept cursors only in process memory (a restart replayed or missed
   * fills). These four knobs replace that with keyset pagination over the
   * full population + durable Redis-backed cursors. See the sweep-budget
   * math and per-lane throttle comment in workers/fills-notifier.ts.
   */
  /** Keyset page size — how many push-enabled users one page fetch returns. */
  MAX_USERS_PER_SWEEP: z.coerce.number().int().positive().default(200),
  /** Bounded worker-pool concurrency processing one page (no queue lib). */
  FILLS_NOTIFIER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Wall-clock budget (ms) for one sweep; past it, no new users are started
      and the scan cursor is persisted so the next sweep resumes there. */
  FILLS_SWEEP_BUDGET_MS: z.coerce.number().int().positive().default(45_000),
  /** Per-lane floor (ms) before each Hyperliquid fills fetch — bounds this
      process's worst-case request rate to the venue regardless of how fast
      HL responds. 0 disables the floor (tests). */
  FILLS_NOTIFIER_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(100),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse + validate a raw environment map. Exported (W2-A) so the spec suite
 * can exercise the production fail-closed guards against synthetic envs
 * without mutating process.env or re-importing this module. Throws on any
 * invalid or unsafe-for-production configuration.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const rawEnv = EnvSchema.parse(raw);
  const parsed: Env = {
    ...rawEnv,
    BASE_RPC_URL: rawEnv.BASE_RPC_URL || rawEnv.CHAINSTACK_BASE_RPC_URL,
  };

  if (parsed.NODE_ENV === 'production') {
    if (parsed.DEMO_MODE && !parsed.ALLOW_DEMO_IN_PRODUCTION) {
      throw new Error('DEMO_MODE=1 under NODE_ENV=production requires ALLOW_DEMO_IN_PRODUCTION=1.');
    }
    // W2-A fail-closed core — a non-demo production process must never boot
    // onto the in-memory ledger (DATABASE_URL absent previously degraded
    // silently to InMemoryStore) or run money paths without Redis (queues,
    // OTP store, rate limits, caches all fail-open in-process otherwise).
    if (!parsed.DEMO_MODE) {
      const missing: string[] = [];
      if (!parsed.DATABASE_URL) missing.push('DATABASE_URL');
      if (!parsed.REDIS_URL) missing.push('REDIS_URL');
      if (missing.length > 0) {
        throw new Error(
          `${missing.join(' and ')} required when NODE_ENV=production and DEMO_MODE=0 — ` +
            'refusing to fall back to in-memory/demo infrastructure (fail-closed).',
        );
      }
    }
    if (parsed.JWT_SECRET === 'nexa-demo-secret-change-in-prod') {
      throw new Error('JWT_SECRET must be configured in production.');
    }
    if (parsed.NEXA_AGENT_KEYS === 'nx_live_7f3k_demo') {
      throw new Error('NEXA_AGENT_KEYS must be configured in production.');
    }
    if (!parsed.PRIVY_APP_ID || !parsed.PRIVY_APP_SECRET) {
      throw new Error('Privy must be configured in production; static OTP fallback is demo-only.');
    }
    // F083 Sprint 18 — PM_CLOB_ENC_KEY fail-at-boot guard. The crypto module is
    // fail-closed on first encrypt() call when the key is missing, but a process
    // can boot and serve read traffic before that surfaces. If Polymarket is
    // configured live in production (POLY_API_KEY set), the encryption envelope
    // MUST be configured too — otherwise the next CLOB credential derive throws
    // mid-request instead of at deploy time. Vanilla deployments without
    // Polymarket are unaffected.
    if (parsed.POLY_API_KEY) {
      const enc = parsed.PM_CLOB_ENC_KEY;
      if (!enc) {
        throw new Error(
          'PM_CLOB_ENC_KEY required when POLY_API_KEY is set in production. Generate via: openssl rand -base64 32',
        );
      }
      const decoded = Buffer.from(enc, 'base64');
      if (decoded.length !== 32) {
        throw new Error(
          `PM_CLOB_ENC_KEY must decode to exactly 32 bytes; got ${decoded.length}. Generate via: openssl rand -base64 32`,
        );
      }
    }
  }

  return parsed;
}

export const env: Env = parseEnv(process.env);

/**
 * W2-B — true when this process must fail CLOSED on degraded runtime
 * dependencies (rate-limit Redis, stream-ticket store): real production,
 * i.e. NODE_ENV=production without DEMO_MODE. A function (not a frozen
 * boolean) so tests can stub `env` fields and see the change reflected.
 */
export function runtimeFailClosed(): boolean {
  return env.NODE_ENV === 'production' && !env.DEMO_MODE;
}

/** Feature flags derived from env. */
export const features = {
  privy: Boolean(env.PRIVY_APP_ID && env.PRIVY_APP_SECRET),
  /** Server can sign user-owned Privy wallets (auth key configured). When
      false, live signing 401s — every money path degrades to failure. */
  privyServerSigning: Boolean(
    env.PRIVY_APP_ID && env.PRIVY_APP_SECRET && env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
  ),
  resend: Boolean(env.RESEND_API_KEY),
  chain: Boolean(env.BASE_RPC_URL),
  alchemy: Boolean(env.ALCHEMY_API_KEY),
  lifi: Boolean(env.BASE_RPC_URL), // works without API key for low volume
  /** Socket bridge aggregator — primary in bridge-router when set. */
  socket: Boolean(env.SOCKET_API_KEY),
  bridge: Boolean(env.BRIDGE_API_KEY),
  monerium: Boolean(env.MONERIUM_API_KEY && env.MONERIUM_API_SECRET),
  stripe: Boolean(env.STRIPE_SECRET_KEY),
  gnosisPay: Boolean(env.GNOSIS_PAY_API_KEY),
  sponge: Boolean(env.SPONGE_API_KEY),
  sumsub: Boolean(env.SUMSUB_APP_TOKEN),
  markets: env.MARKETS_ENABLED,
  jupiterSwaps: env.JUPITER_SWAPS_ENABLED,
  /** Sprint 20 — Collector Crypt cards marketplace (Solana NFT). */
  ccEnabled: env.CC_ENABLED,
  solanaRpc: Boolean(env.CHAINSTACK_SOLANA_RPC_URL || env.SOLANA_RPC_URL || env.HELIUS_RPC_URL),
  postgres: Boolean(env.DATABASE_URL),
  redis: Boolean(env.REDIS_URL),
  sentry: Boolean(env.SENTRY_DSN),
  metrics: env.METRICS_ENABLED,
  push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
  admin: Boolean(env.ADMIN_TOKEN),
} as const;

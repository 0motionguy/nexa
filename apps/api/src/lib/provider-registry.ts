/**
 * Provider registry — Sprint 15.
 *
 * Single source of truth for every external vendor / API the API depends on.
 * Status is derived from the `features.*` flags in `env.ts` plus the last-fetch
 * tracker in `lib/sourced.ts`. The registry is exposed via `GET /system/providers`
 * so the frontend's "More → System / Docs → Providers" screen can render the
 * canonical "Bridge · KYB pending · Docs" view.
 *
 * Rules:
 *   - Adding a vendor here is a one-line edit. Don't scatter status checks.
 *   - `demoFallbackAllowed: true` means DEMO_MODE may synthesize data when the
 *     real API is unreachable. Always false for vendors where fake data would
 *     mislead the user (markets, APY, swap quote).
 *   - `internalDocsPath` points at a docs file under `nexa/docs/` (relative).
 *   - `envVars` is the COMPLETE list — both required and optional — so the
 *     System screen can show "missing-keys" clearly.
 */

import type {
  DataSourceEntry,
  ProviderRegistryEntry,
} from '@nexa/shared-zod';
import { env, features } from './env.js';
import { lastFetch } from './sourced.js';

interface StaticEntry extends Omit<ProviderRegistryEntry, 'status' | 'lastCheckedAt'> {
  /** Computed at request time from the features.* flag and runtime hints. */
  resolveStatus(): ProviderRegistryEntry['status'];
  /** Optional metric key for lastFetch lookup. */
  freshnessKey?: { provider: string; metric: string };
}

const ENTRIES: StaticEntry[] = [
  {
    id: 'privy',
    name: 'Privy',
    category: 'wallet',
    envVars: [
      'PRIVY_APP_ID',
      'PRIVY_APP_SECRET',
      'PRIVY_VERIFICATION_KEY',
      'PRIVY_AUTHORIZATION_PRIVATE_KEY',
      'PRIVY_AUTHORIZATION_KEY_ID',
    ],
    backendFiles: [
      'apps/api/src/lib/privy.ts',
      'apps/api/src/lib/chain/privy-agent-wallet.ts',
      'apps/api/src/lib/chain/privy-claim.ts',
    ],
    frontendScreens: ['s01', 's02', 's03', 's08'],
    publicDocsUrl: 'https://docs.privy.io/wallets/wallets/create/create-a-wallet',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#privy',
    demoFallbackAllowed: true,
    notes: 'Falls back to demo OTP 482019 when keys absent.',
    resolveStatus: () => (features.privy ? 'live' : 'missing-keys'),
  },
  {
    id: 'bridge',
    name: 'Bridge',
    category: 'onramp',
    envVars: ['BRIDGE_API_KEY', 'BRIDGE_API_BASE', 'BRIDGE_WEBHOOK_SECRET'],
    backendFiles: ['apps/api/src/lib/chain/bridge.ts', 'apps/api/src/routes/bridge.ts'],
    frontendScreens: ['s09', 's10'],
    publicDocsUrl: 'https://apidocs.bridge.xyz/platform/orchestration/overview',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#bridge',
    demoFallbackAllowed: false,
    notes:
      'KYB approval is the longest critical path before live US bank rails work.',
    resolveStatus: () => {
      if (!features.bridge) return 'missing-keys';
      return env.BRIDGE_API_BASE.includes('sandbox') ? 'sandbox' : 'live';
    },
  },
  {
    id: 'chain-balances',
    name: 'Chain USDC balances',
    category: 'wallet',
    envVars: [
      'ARBITRUM_RPC_URL',
      'POLYGON_RPC_URL',
      'BASE_RPC_URL',
      'OPTIMISM_RPC_URL',
      'CHAINSTACK_SOLANA_RPC_URL',
      'SOLANA_RPC_URL',
      'HELIUS_RPC_URL',
    ],
    backendFiles: ['apps/api/src/lib/chain/balances.ts', 'apps/api/src/routes/transfers.ts'],
    frontendScreens: ['s27'],
    publicDocsUrl: null,
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#chain-usdc-balances',
    demoFallbackAllowed: false,
    notes:
      'Best-effort USDC balance reads for portfolio buckets across Arbitrum, Polygon, Base, Optimism, and Solana.',
    resolveStatus: () => (features.chain || features.solanaRpc ? 'live' : 'missing-keys'),
  },
  {
    id: 'monerium',
    name: 'Monerium',
    category: 'offramp',
    envVars: ['MONERIUM_API_KEY', 'MONERIUM_API_SECRET', 'MONERIUM_API_BASE'],
    backendFiles: [
      'apps/api/src/lib/chain/monerium.ts',
      'apps/api/src/routes/monerium.ts',
    ],
    frontendScreens: ['s09', 's10'],
    publicDocsUrl: 'https://monerium.dev/docs',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#monerium',
    demoFallbackAllowed: true,
    notes:
      'EUR onramp + SEPA offramp via Gnosis Chain EURe. IBAN issued in the user\'s name (not custodial). Alternative to Bridge for EU users.',
    freshnessKey: { provider: 'monerium', metric: 'status' },
    resolveStatus: () => (features.monerium ? 'live' : 'missing-keys'),
  },
  {
    id: 'sumsub',
    name: 'Sumsub',
    category: 'kyc',
    envVars: ['SUMSUB_APP_TOKEN', 'SUMSUB_SECRET_KEY', 'SUMSUB_BASE'],
    backendFiles: ['apps/api/src/lib/kyc.ts', 'apps/api/src/routes/kyc.ts'],
    frontendScreens: ['s05'],
    publicDocsUrl: 'https://docs.sumsub.com/reference/get-started-with-api',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#sumsub',
    demoFallbackAllowed: true,
    resolveStatus: () => (features.sumsub ? 'live' : 'missing-keys'),
  },
  {
    id: 'stripe-checkout',
    name: 'Stripe Checkout',
    category: 'onramp',
    envVars: [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SUCCESS_URL',
      'STRIPE_CANCEL_URL',
    ],
    backendFiles: ['apps/api/src/lib/psp/stripe.ts', 'apps/api/src/routes/offers.ts'],
    frontendScreens: ['checkout.html'],
    publicDocsUrl: 'https://docs.stripe.com/payments/checkout',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#stripe',
    demoFallbackAllowed: true,
    notes: 'Hosted checkout for sellers. Synthetic cs_demo_* session when keys absent.',
    resolveStatus: () => (features.stripe ? 'live' : 'missing-keys'),
  },
  {
    id: 'stripe-crypto-onramp',
    name: 'Stripe Crypto Onramp',
    category: 'onramp',
    envVars: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    backendFiles: ['apps/api/src/lib/psp/stripe.ts', 'apps/api/src/routes/onramp.ts'],
    frontendScreens: ['s09'],
    publicDocsUrl: 'https://docs.stripe.com/crypto/onramp',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#stripe-crypto-onramp',
    demoFallbackAllowed: true,
    notes:
      'USD/EUR -> USDC via Stripe hosted page. Alternative to Bridge while Bridge KYB is pending. KYC handled by Stripe.',
    freshnessKey: { provider: 'stripe', metric: 'onramp-session' },
    resolveStatus: () => (features.stripe ? 'live' : 'missing-keys'),
  },
  {
    id: 'resend',
    name: 'Resend',
    category: 'email',
    envVars: ['RESEND_API_KEY', 'RESEND_FROM'],
    backendFiles: ['apps/api/src/lib/email.ts'],
    frontendScreens: ['s02', 's03', 's12'],
    publicDocsUrl: 'https://resend.com/docs/api-reference/emails/send-email',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#resend',
    demoFallbackAllowed: true,
    notes: 'Falls back to stdout when key absent.',
    resolveStatus: () => (features.resend ? 'live' : 'missing-keys'),
  },
  {
    id: 'socket',
    name: 'Socket',
    category: 'swap',
    envVars: ['SOCKET_API_KEY', 'SOCKET_API_BASE'],
    backendFiles: ['apps/api/src/lib/chain/socket.ts', 'apps/api/src/lib/bridge-router.ts'],
    frontendScreens: ['s16', 's17'],
    publicDocsUrl: 'https://docs.socket.tech/integrate/get-api-access',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#socket',
    demoFallbackAllowed: false,
    notes: 'Primary bridge aggregator; falls back to LI.FI when key absent.',
    freshnessKey: { provider: 'socket', metric: 'swap-quote' },
    resolveStatus: () => (features.socket ? 'live' : 'missing-keys'),
  },
  {
    id: 'lifi',
    name: 'LI.FI',
    category: 'swap',
    envVars: ['LIFI_API_KEY'],
    backendFiles: ['apps/api/src/lib/chain/lifi.ts'],
    frontendScreens: ['s16', 's17'],
    publicDocsUrl: 'https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#lifi',
    demoFallbackAllowed: false,
    notes: 'Works without API key at low volume; fallback when Socket is unavailable.',
    freshnessKey: { provider: 'lifi', metric: 'swap-quote' },
    resolveStatus: () => (features.lifi ? 'live' : 'missing-keys'),
  },
  {
    id: 'mayan',
    name: 'Mayan Finance',
    category: 'swap',
    envVars: [],
    backendFiles: ['apps/api/src/lib/chain/mayan.ts'],
    frontendScreens: ['s16'],
    publicDocsUrl: 'https://docs.mayan.finance/',
    internalDocsPath: 'docs/SWAP-WIRING.md#mayan',
    demoFallbackAllowed: false,
    notes:
      'Cross-chain swap (Solana <-> EVM) via Swift (~3s), MCTP, or Wormhole. Public quote API at price-api.mayan.finance - no key. /swap routes Solana legs through Mayan execute. Quotes are keyless; execution needs Privy signing plus the 7702 executor (EVM legs) or a Solana RPC.',
    freshnessKey: { provider: 'mayan', metric: 'quote' },
    // 'live' only when the execute path is actually signable; quotes alone are
    // 'gated' (the adapter itself fails closed to `unavailable`).
    resolveStatus: () =>
      features.privy && (features.alchemy || features.solanaRpc)
        ? 'live'
        : 'gated',
  },
  {
    id: 'circle-cctp',
    name: 'Circle CCTP',
    category: 'stablecoin',
    envVars: ['ALCHEMY_API_KEY', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET'],
    backendFiles: [
      'apps/api/src/lib/chain/cctp.ts',
      'apps/api/src/workers/bridge-worker.ts',
      'apps/api/src/routes/transfers.ts',
    ],
    frontendScreens: [],
    publicDocsUrl: 'https://developers.circle.com/cctp',
    internalDocsPath: 'docs/CCTP-WIRING.md',
    demoFallbackAllowed: false,
    notes:
      'LIVE V1 rail for /transfers/internal cross-chain USDC: burn → Iris attestation → mint via the bridge-worker, signed through the Alchemy 7702 executor + Privy. The single-shot CctpAdapter inside the swap router remains a placeholder.',
    resolveStatus: () =>
      features.alchemy && features.privy ? 'live' : 'missing-keys',
  },
  {
    id: 'collector-crypt',
    name: 'Collector Crypt',
    category: 'markets',
    envVars: ['CC_API_BASE', 'CC_ENABLED'],
    backendFiles: [
      'apps/api/src/lib/markets/collector-crypt.ts',
      'apps/api/src/routes/markets-cards.ts',
    ],
    frontendScreens: ['neo/Cards tab'],
    publicDocsUrl: 'https://docs.collectorcrypt.com/marketplace/api',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#collector-crypt',
    demoFallbackAllowed: false,
    notes:
      'Solana NFT marketplace for tokenized trading cards. Keyless REST + Anchor program CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr. USDC SPL settlement, 2% seller fee. Powers NEO trading-terminal Cards tab. Gated on CC_ENABLED + features.privy + features.solanaRpc for write path.',
    freshnessKey: { provider: 'collector-crypt', metric: 'listings' },
    resolveStatus: () => (env.CC_ENABLED ? 'live' : 'disabled'),
  },
  {
    id: 'coinbase-x402',
    name: 'Coinbase x402',
    category: 'x402',
    envVars: ['X402_FACILITATOR_URL', 'BASE_RPC_URL'],
    backendFiles: ['apps/api/src/lib/chain/x402.ts', 'apps/api/src/routes/x402.ts'],
    frontendScreens: ['s23', 's24', 'portal.html'],
    publicDocsUrl: 'https://docs.cdp.coinbase.com/x402/welcome',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#x402',
    demoFallbackAllowed: true,
    notes:
      'Synthetic 0x… tx hash returned in demo mode. X402_FACILITATOR_URL has an env default, so status keys on the live-settle gate (BASE_RPC_URL) instead; settle fails closed when the facilitator is unreachable.',
    // Mirror x402Adapter.isLive (features.chain) — keying on the facilitator
    // URL was vacuous because the env default is always set.
    resolveStatus: () => (features.chain ? 'live' : 'missing-keys'),
  },
  {
    id: 'aave',
    name: 'Aave v3',
    category: 'defi-yield',
    envVars: ['BASE_RPC_URL', 'AAVE_POOL_ADDRESS', 'AUSDC_ADDRESS'],
    backendFiles: ['apps/api/src/lib/chain/defi.ts'],
    frontendScreens: ['s08', 's14'],
    publicDocsUrl: 'https://aave.com/docs/aave-v3/overview',
    internalDocsPath: 'docs/APY-WIRING.md#aave',
    demoFallbackAllowed: false,
    freshnessKey: { provider: 'aave', metric: 'apy' },
    resolveStatus: () => (features.chain ? 'live' : 'missing-keys'),
  },
  {
    id: 'morpho',
    name: 'Morpho · Standard',
    category: 'defi-yield',
    envVars: ['BASE_RPC_URL', 'MORPHO_VAULT_ADDRESS', 'MORPHO_API_URL'],
    backendFiles: ['apps/api/src/lib/chain/morpho.ts'],
    frontendScreens: ['s08', 's14'],
    publicDocsUrl: 'https://docs.morpho.org/build/earn/resources/all',
    internalDocsPath: 'docs/APY-WIRING.md#morpho',
    demoFallbackAllowed: false,
    notes:
      'Standard tier — Steakhouse-curated USDC vault (0xbeeF...8183). Same vault Coinbase uses for "USDC Prime" lending.',
    freshnessKey: { provider: 'morpho', metric: 'apy' },
    resolveStatus: () => 'live', // Morpho GraphQL is public; no key required
  },
  {
    id: 'morpho-high-yield',
    name: 'Morpho · High Yield (Coinbase)',
    category: 'defi-yield',
    envVars: ['MORPHO_HIGH_YIELD_VAULT_ADDRESS', 'MORPHO_API_URL'],
    backendFiles: ['apps/api/src/lib/chain/morpho.ts'],
    frontendScreens: ['s08', 's14'],
    publicDocsUrl: 'https://docs.morpho.org/build/earn/resources/all',
    internalDocsPath: 'docs/APY-WIRING.md#morpho-high-yield',
    demoFallbackAllowed: false,
    notes:
      'Higher Yield tier — Steakhouse High Yield USDC v1.1 (bbqUSDC, 0xBEEF...878F). Same vault Coinbase wired as their "USDC High Yield" product (powered by Ethena).',
    freshnessKey: { provider: 'morpho-high-yield', metric: 'apy' },
    resolveStatus: () => 'live',
  },
  {
    id: 'compound',
    name: 'Compound III',
    category: 'defi-yield',
    envVars: ['BASE_RPC_URL', 'COMPOUND_COMET_ADDRESS'],
    backendFiles: ['apps/api/src/lib/chain/compound.ts'],
    frontendScreens: ['s14'],
    publicDocsUrl: 'https://docs.compound.finance/interest-rates/',
    internalDocsPath: 'docs/APY-WIRING.md#compound',
    demoFallbackAllowed: false,
    freshnessKey: { provider: 'compound', metric: 'apy' },
    resolveStatus: () => (features.chain ? 'live' : 'missing-keys'),
  },
  {
    id: 'yousd',
    name: 'yoUSD',
    category: 'defi-yield',
    envVars: ['YOUSD_ADDRESS', 'YOUSD_APY_URL', 'BASE_RPC_URL'],
    backendFiles: ['apps/api/src/lib/chain/yousd.ts'],
    frontendScreens: ['s14'],
    publicDocsUrl: 'https://docs.yo.xyz/integrations/api',
    internalDocsPath: 'docs/APY-WIRING.md#yousd',
    demoFallbackAllowed: false,
    notes:
      'YO Protocol public API at https://api.yo.xyz/api/v1/vault/yield/timeseries/base/{vault} returns the realised yield timeseries. Adapter reads the last entry, no auth required.',
    freshnessKey: { provider: 'yousd', metric: 'apy' },
    resolveStatus: () => 'live', // YO Protocol API is public; no key required
  },
  {
    id: 'ethena',
    name: 'Ethena · sUSDe',
    category: 'defi-yield',
    envVars: ['ETHENA_API_URL', 'ETHENA_DEPOSIT_URL'],
    backendFiles: ['apps/api/src/lib/chain/ethena.ts', 'apps/api/src/routes/earn.ts'],
    frontendScreens: ['s14', 'landing.html'],
    publicDocsUrl: 'https://docs.ethena.fi/',
    internalDocsPath: 'docs/APY-WIRING.md#ethena-susde',
    demoFallbackAllowed: false,
    notes:
      'Read-only headline yield tile. APY is public; deposits deep-link to Ethena and NEXA does not custody sUSDe.',
    freshnessKey: { provider: 'ethena', metric: 'apy' },
    resolveStatus: () => 'live',
  },
  {
    id: 'hyperliquid',
    name: 'Hyperliquid',
    category: 'markets',
    envVars: ['MARKETS_ENABLED'],
    backendFiles: [
      'apps/api/src/lib/chain/hl-bridge.ts',
      'apps/api/src/lib/markets/hl-builder-approval.ts',
      // 2026-07-08 — shared config (URLs + geo blocklist) and the ADR-0004
      // per-process agent-wallet module.
      'apps/api/src/lib/markets/hl-config.ts',
      'apps/api/src/lib/markets/hl-agent.ts',
      // 2026-07-08 — ADR-0004 part 2 user-data streaming (webData2/userFills).
      'apps/api/src/realtime/venues/hyperliquid-user.ts',
      'apps/api/src/lib/markets/hyperliquid.ts',
      'apps/api/src/lib/markets/hyperliquid-spot.ts',
      'apps/api/src/lib/markets/hyperliquid-hip3.ts',
      'apps/api/src/routes/markets.ts',
    ],
    frontendScreens: ['s27'],
    publicDocsUrl:
      'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#hyperliquid',
    demoFallbackAllowed: true,
    notes:
      'READS are public via api.hyperliquid.xyz/info — no key required. Trading needs a Privy wallet signature. HL_BUILDER_ADDRESS is optional for builder-fee earning.',
    freshnessKey: { provider: 'hyperliquid', metric: 'market-list' },
    resolveStatus: () => {
      // Read surface is public; live whenever MARKETS_ENABLED is on. Trading
      // status is separate (see liveTradingWalletGate in routes/markets.ts).
      if (!features.markets) return 'disabled';
      return 'live';
    },
  },
  {
    id: 'polymarket',
    name: 'Polymarket',
    category: 'markets',
    envVars: [
      'POLY_API_KEY',
      'POLYMARKET_BUILDER_API_SECRET',
      'POLYMARKET_BUILDER_API_PASSPHRASE',
      'POLYMARKET_BUILDER_ADDRESS',
      'POLYMARKET_BUILDER_FEE_BPS',
      'POLYMARKET_BUILDER_CODE',
      'POLYMARKET_RELAYER_API_KEY',
      'POLYMARKET_RELAYER_API_KEY_ADDRESS',
      'PM_RELAYER_URL',
      'PM_BUILDER_LANE',
      'MARKETS_ENABLED',
    ],
    backendFiles: [
      'apps/api/src/lib/markets/polymarket.ts',
      'apps/api/src/lib/markets/pm-clob.ts',
      'apps/api/src/lib/markets/pm-relayer.ts',
      'apps/api/src/lib/markets/pm-approvals.ts',
      'apps/api/src/routes/markets.ts',
    ],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://docs.polymarket.com/market-data/overview',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#polymarket',
    demoFallbackAllowed: true,
    notes:
      'READS are public via gamma-api.polymarket.com/markets - no key required. Live order submit uses per-user L2 CLOB creds plus a Privy-backed typed-data signer.',
    freshnessKey: { provider: 'polymarket', metric: 'market-list' },
    resolveStatus: () => {
      if (!features.markets) return 'disabled';
      return 'live'; // read surface is public; trading gated separately
    },
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    category: 'markets',
    envVars: [
      'MARKETS_ENABLED',
      'JUPITER_SWAPS_ENABLED',
      'PRIVY_APP_ID',
      'PRIVY_APP_SECRET',
      'CHAINSTACK_SOLANA_RPC_URL',
      'SOLANA_RPC_URL',
      'HELIUS_RPC_URL',
    ],
    backendFiles: [
      'apps/api/src/lib/markets/jupiter.ts',
      'apps/api/src/lib/markets/ipfs-url.ts',
      'apps/api/src/routes/markets.ts',
    ],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://developers.jup.ag/',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#jupiter',
    demoFallbackAllowed: true,
    notes:
      'Token API v2 powers Solana meme enrichment and prices. Swap v1 execution requires explicit JUPITER_SWAPS_ENABLED plus Privy Solana signing and RPC.',
    freshnessKey: { provider: 'jupiter', metric: 'market-list' },
    resolveStatus: () => {
      if (!features.markets) return 'disabled';
      return features.jupiterSwaps && features.privy && features.solanaRpc ? 'live' : 'gated';
    },
  },
  {
    id: 'pumpfun',
    name: 'Pump.fun',
    category: 'markets',
    envVars: ['MARKETS_ENABLED'],
    backendFiles: [
      'apps/api/src/lib/markets/pumpfun.ts',
      'apps/api/src/lib/markets/ipfs-url.ts',
      'apps/api/src/routes/markets.ts',
    ],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://frontend-api-v3.pump.fun/',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#pumpfun',
    demoFallbackAllowed: true,
    notes:
      'Frontend API v3 discovery for fresh pump.fun-native memes; execution routes through Jupiter.',
    freshnessKey: { provider: 'pumpfun', metric: 'market-list' },
    resolveStatus: () => (features.markets ? 'live' : 'disabled'),
  },
  {
    id: 'alternative-me',
    name: 'Alternative.me Fear & Greed',
    category: 'markets',
    envVars: ['MARKETS_ENABLED'],
    backendFiles: ['apps/api/src/lib/markets/global-metrics.ts', 'apps/api/src/routes/markets.ts'],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://alternative.me/crypto/fear-and-greed-index/',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#alternative-me',
    demoFallbackAllowed: false,
    notes:
      'Crypto Fear & Greed index (current + daily history), keyless. Feeds the NEO pulse tiles via GET /markets/global; leg fails soft to null, never synthesized.',
    resolveStatus: () => (features.markets ? 'live' : 'disabled'),
  },
  {
    id: 'coingecko',
    name: 'CoinGecko',
    category: 'markets',
    envVars: ['MARKETS_ENABLED'],
    backendFiles: ['apps/api/src/lib/markets/global-metrics.ts', 'apps/api/src/routes/markets.ts'],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://docs.coingecko.com/reference/crypto-global',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#coingecko',
    demoFallbackAllowed: false,
    notes:
      'Free /global endpoint: total market cap, 24h %, BTC dominance. Sparkline series is an in-process ring buffer of observed values (24h window) — no paid history API.',
    resolveStatus: () => (features.markets ? 'live' : 'disabled'),
  },
  {
    id: 'geckoterminal',
    name: 'GeckoTerminal',
    category: 'markets',
    envVars: ['MARKETS_ENABLED'],
    backendFiles: ['apps/api/src/lib/markets/gecko-terminal.ts', 'apps/api/src/routes/markets.ts'],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://www.geckoterminal.com/dex-api',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#geckoterminal',
    demoFallbackAllowed: false,
    notes:
      'Free keyless OHLCV for Solana tokens (top-pool candles) — powers meme/xStock charts via GET /markets/jupiter/candles. Pools under $100 liquidity are treated as no-market; failures degrade to empty candle lists, never synthetic bars.',
    resolveStatus: () => (features.markets ? 'live' : 'disabled'),
  },
  {
    id: 'gnosis-pay',
    name: 'Gnosis Pay',
    category: 'card',
    envVars: ['GNOSIS_PAY_API_KEY', 'GNOSIS_PAY_BASE'],
    backendFiles: ['apps/api/src/lib/chain/gnosisPay.ts'],
    frontendScreens: ['s17', 's18'],
    publicDocsUrl: 'https://docs.gnosispay.com/',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#gnosis-pay',
    demoFallbackAllowed: true,
    notes: 'Synthetic Safe deploy + card details in demo mode.',
    freshnessKey: { provider: 'gnosis-pay', metric: 'card-state' },
    resolveStatus: () => (features.gnosisPay ? 'live' : 'missing-keys'),
  },
  {
    id: 'sponge',
    name: 'Sponge',
    category: 'card',
    envVars: ['SPONGE_API_KEY', 'SPONGE_API_BASE'],
    backendFiles: ['apps/api/src/lib/chain/sponge.ts'],
    frontendScreens: ['s23'],
    publicDocsUrl: null,
    internalDocsPath: 'docs/MISSING-PROVIDER-DOCS.md#sponge',
    demoFallbackAllowed: true,
    notes: 'US debit fallback + agent bank account issuance.',
    resolveStatus: () => (features.sponge ? 'live' : 'missing-keys'),
  },
  {
    id: 'alchemy',
    name: 'Alchemy',
    category: 'wallet',
    envVars: ['ALCHEMY_API_KEY', 'ALCHEMY_GAS_POLICY_ID'],
    backendFiles: ['apps/api/src/lib/chain/alchemy.ts'],
    frontendScreens: ['s14', 's15', 's17'],
    publicDocsUrl: 'https://www.alchemy.com/docs/wallets',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#alchemy',
    demoFallbackAllowed: true,
    notes: 'EIP-7702 batch executor + gas sponsorship.',
    resolveStatus: () => (features.alchemy ? 'live' : 'missing-keys'),
  },
  {
    id: 'marinade',
    name: 'Marinade Finance',
    category: 'defi-yield',
    envVars: ['CHAINSTACK_SOLANA_RPC_URL', 'SOLANA_RPC_URL', 'HELIUS_RPC_URL'],
    backendFiles: [
      'apps/api/src/lib/chain/marinade.ts',
      'apps/api/src/lib/chain/solana-tx.ts',
      'apps/api/src/lib/chain/solana-ata.ts',
    ],
    frontendScreens: ['s14'],
    publicDocsUrl: 'https://docs.marinade.finance/',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#marinade',
    demoFallbackAllowed: false,
    notes:
      'Solana liquid staking via mSOL. APY is public. Stake and instant liquid unstake submit when Solana RPC plus Privy Solana wallet signing are configured.',
    freshnessKey: { provider: 'marinade', metric: 'apy' },
    resolveStatus: () =>
      env.CHAINSTACK_SOLANA_RPC_URL || env.SOLANA_RPC_URL || env.HELIUS_RPC_URL
        ? 'live'
        : 'missing-keys',
  },
  {
    id: 'xstocks',
    name: 'xStocks (Backed)',
    category: 'tokenized-stocks',
    envVars: ['MARKETS_ENABLED', 'JUPITER_SWAPS_ENABLED'],
    backendFiles: ['apps/api/src/lib/markets/xstocks.ts'],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://docs.xstocks.fi/docs',
    internalDocsPath: 'docs/MISSING-PROVIDER-DOCS.md#xstocks',
    demoFallbackAllowed: false,
    notes:
      'Secondary-market trading of Backed xStocks SPL tokens routes through Jupiter: reads are public, swaps gated on JUPITER_SWAPS_ENABLED + Privy + Solana RPC. Primary mint/redeem at backed.fi stays partner-gated docs-only (lib/markets/tokenized.ts).',
    resolveStatus: () => {
      if (!features.markets) return 'disabled';
      return features.jupiterSwaps && features.privy && features.solanaRpc
        ? 'live'
        : 'gated';
    },
  },
  {
    id: 'dinari',
    name: 'Dinari',
    category: 'tokenized-stocks',
    envVars: [],
    backendFiles: [],
    frontendScreens: [],
    publicDocsUrl: 'https://dinari.com/defi',
    internalDocsPath: 'docs/MISSING-PROVIDER-DOCS.md#dinari',
    demoFallbackAllowed: false,
    notes: 'Partner access not approved. Same gating rule as xStocks.',
    resolveStatus: () => 'docs-only',
  },
  {
    id: 'onramper',
    name: 'Onramper',
    category: 'onramp',
    envVars: ['ONRAMPER_API_KEY'],
    backendFiles: ['apps/api/src/routes/onramp.ts'],
    frontendScreens: ['s09'],
    publicDocsUrl: 'https://docs.onramper.com/docs/widget',
    internalDocsPath: 'docs/ONRAMP-OPTIONS.md',
    demoFallbackAllowed: false,
    notes:
      'Signed-iframe widget session (buy.onramper.com) — meta-aggregator across 30+ onramps, no NEXA custody or KYC. Without a key the route returns the public sandbox widget URL.',
    resolveStatus: () => (env.ONRAMPER_API_KEY ? 'live' : 'sandbox'),
  },
  {
    id: 'jupiter-lend',
    name: 'Jupiter Lend',
    category: 'defi-yield',
    envVars: ['JUPITER_LEND_API_URL'],
    backendFiles: ['apps/api/src/lib/chain/jupiter-lend.ts'],
    frontendScreens: ['s14'],
    publicDocsUrl: 'https://dev.jup.ag/docs/lend/sdk',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#jupiter-lend-solana-usdc--usdt',
    demoFallbackAllowed: false,
    notes:
      'Read-only APY headline tile; deposits deep-link to jup.ag/lend — NEXA does not custody positions. Public lend-api.jup.ag read, no key.',
    freshnessKey: { provider: 'jupiter-lend', metric: 'apy' },
    resolveStatus: () => 'live',
  },
  {
    id: 'yields-landscape',
    name: 'DefiLlama Yields',
    category: 'defi-yield',
    envVars: ['DEFILLAMA_YIELDS_URL'],
    backendFiles: ['apps/api/src/lib/chain/yields-landscape.ts'],
    frontendScreens: ['s14'],
    publicDocsUrl: 'https://defillama.com/docs/api',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#defillama-yields-api-cross-protocol-comparator',
    demoFallbackAllowed: false,
    notes:
      'Cross-protocol comparator feeding /earn/landing. Public yields.llama.fi read, whitelisted projects only. NOTE: llama rows are currently excluded from the landing output (native adapters only) — fetched but not surfaced.',
    resolveStatus: () => 'live',
  },
  {
    id: 'tradingview',
    name: 'TradingView',
    category: 'markets',
    envVars: [],
    backendFiles: [
      'apps/api/src/external/tradingview-client.ts',
      'apps/api/src/routes/tv.ts',
    ],
    frontendScreens: ['s27'],
    publicDocsUrl: 'https://www.tradingview.com/charting-library-docs/',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md',
    demoFallbackAllowed: false,
    notes:
      'Unofficial WS client (@mathieuc/tradingview) backing /tv candles/quotes. Keyless; rate-limited 30/min at the edge; failures surface as 502, never synthesized.',
    resolveStatus: () => 'live',
  },
  {
    id: 'pyth-hermes',
    name: 'Pyth Hermes',
    category: 'markets',
    envVars: ['PYTH_HERMES_URL', 'REALTIME_HUB_V1'],
    backendFiles: ['apps/api/src/realtime/venues/pyth-hermes.ts'],
    frontendScreens: [],
    publicDocsUrl: 'https://docs.pyth.network/price-feeds/how-pyth-works/hermes',
    internalDocsPath: 'docs/REALTIME-MARKETS.md',
    demoFallbackAllowed: false,
    notes:
      'SSE price-feed adapter registered in the realtime hub for ticker/stock/meme topics. Dark-launched: active only when REALTIME_HUB_V1=1.',
    resolveStatus: () => (env.REALTIME_HUB_V1 ? 'live' : 'disabled'),
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'observability',
    envVars: ['SENTRY_DSN', 'SENTRY_TRACES_SAMPLE_RATE'],
    backendFiles: ['apps/api/src/lib/sentry.ts'],
    frontendScreens: [],
    publicDocsUrl: 'https://docs.sentry.io/platforms/node/',
    internalDocsPath: 'docs/API-INTEGRATION-REGISTRY.md#sentry',
    demoFallbackAllowed: true,
    resolveStatus: () => (features.sentry ? 'live' : 'missing-keys'),
  },
  {
    id: 'postgres',
    name: 'Postgres',
    category: 'persistence',
    envVars: ['DATABASE_URL'],
    backendFiles: ['apps/api/src/store/postgres.ts'],
    frontendScreens: [],
    publicDocsUrl: 'https://www.postgresql.org/docs/',
    internalDocsPath: 'docs/LIVE-API-ARCHITECTURE.md#persistence',
    demoFallbackAllowed: true,
    notes: 'Falls back to in-memory store when DATABASE_URL absent.',
    resolveStatus: () => (features.postgres ? 'live' : 'missing-keys'),
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'persistence',
    envVars: ['REDIS_URL'],
    backendFiles: ['apps/api/src/workers/connection.ts'],
    frontendScreens: [],
    publicDocsUrl: 'https://redis.io/docs/',
    internalDocsPath: 'docs/LIVE-API-ARCHITECTURE.md#queue',
    demoFallbackAllowed: true,
    notes: 'BullMQ approval + scheduler workers; in-memory fallback for dev.',
    resolveStatus: () => (features.redis ? 'live' : 'missing-keys'),
  },
];

export function buildProviderRegistry(): ProviderRegistryEntry[] {
  const checkedAt = new Date().toISOString();
  return ENTRIES.map((entry) => {
    const status = entry.resolveStatus();
    const freshness = entry.freshnessKey
      ? lastFetch(entry.freshnessKey.provider, entry.freshnessKey.metric)
      : null;
    const lastCheckedAt = freshness?.fetchedAt ?? checkedAt;
    const { resolveStatus: _resolveStatus, freshnessKey: _fk, ...rest } = entry;
    void _resolveStatus;
    void _fk;
    return { ...rest, status, lastCheckedAt };
  });
}

interface DataSourceMapping {
  id: string;
  domain: string;
  metric: string;
  provider: string;
  screens: string[];
}

/** Each visible "number" the PWA renders → which (provider, metric) tuple feeds it. */
const DATA_SOURCES: DataSourceMapping[] = [
  { id: 'onramp-stripe',    domain: 'onramp', metric: 'onramp-session', provider: 'stripe', screens: ['s09'] },
  { id: 'monerium-status',  domain: 'offramp', metric: 'status', provider: 'monerium', screens: ['s09', 's10'] },
  { id: 'monerium-offramp', domain: 'offramp', metric: 'offramp', provider: 'monerium', screens: ['s10'] },
  { id: 'home-blended-apy', domain: 'earn', metric: 'apy', provider: 'morpho', screens: ['s08'] },
  { id: 'earn-blended-apy', domain: 'earn', metric: 'apy', provider: 'morpho', screens: ['s14'] },
  { id: 'earn-morpho-apy',  domain: 'earn', metric: 'apy', provider: 'morpho', screens: ['s14'] },
  { id: 'earn-morpho-high-yield-apy', domain: 'earn', metric: 'apy', provider: 'morpho-high-yield', screens: ['s14'] },
  { id: 'earn-marinade-apy', domain: 'earn', metric: 'apy', provider: 'marinade', screens: ['s14'] },
  { id: 'earn-aave-apy',    domain: 'earn', metric: 'apy', provider: 'aave', screens: ['s14'] },
  { id: 'earn-compound-apy',domain: 'earn', metric: 'apy', provider: 'compound', screens: ['s14'] },
  { id: 'earn-yousd-apy',   domain: 'earn', metric: 'apy', provider: 'yousd', screens: ['s14'] },
  { id: 'swap-quote',       domain: 'swap', metric: 'swap-quote', provider: 'socket', screens: ['s16'] },
  { id: 'swap-quote-fallback', domain: 'swap', metric: 'swap-quote', provider: 'lifi', screens: ['s16'] },
  { id: 'card-state',       domain: 'card', metric: 'card-state', provider: 'gnosis-pay', screens: ['s17', 's18'] },
  { id: 'card-topup',       domain: 'card', metric: 'card-topup', provider: 'socket', screens: ['s17'] },
  { id: 'hl-market-list',   domain: 'markets', metric: 'market-list', provider: 'hyperliquid', screens: ['s27'] },
  { id: 'hl-market-detail', domain: 'markets', metric: 'market-detail', provider: 'hyperliquid', screens: ['s27'] },
  { id: 'pm-market-list',   domain: 'markets', metric: 'market-list', provider: 'polymarket', screens: ['s27'] },
  { id: 'pm-market-detail', domain: 'markets', metric: 'market-detail', provider: 'polymarket', screens: ['s27'] },
  { id: 'pump-market-list', domain: 'markets', metric: 'market-list', provider: 'pumpfun', screens: ['s27'] },
];

export function buildDataSources(): DataSourceEntry[] {
  return DATA_SOURCES.map((m) => {
    const freshness = lastFetch(m.provider, m.metric);
    return {
      id: m.id,
      domain: m.domain,
      metric: m.metric,
      meta: {
        source: freshness?.source ?? 'unavailable',
        provider: m.provider,
        fetchedAt: freshness?.fetchedAt ?? null,
      },
      screens: m.screens,
    } satisfies DataSourceEntry & { meta: { source: string } };
  });
}

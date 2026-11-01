# LIVE-API-ARCHITECTURE.md

**Last updated:** 2026-06-17 (Sprint 15)

This document is the single source of truth for how the MAZE/NEXA backend hangs together. It maps every domain to its routes, its store module, its chain adapters, and the providers that feed it live data.

Companion docs:
- [API-INTEGRATION-REGISTRY.md](API-INTEGRATION-REGISTRY.md) — per-vendor matrix
- [API-DATA-LINEAGE.md](API-DATA-LINEAGE.md) — screen → API → adapter → provider
- [NO-DEMO-DATA-AUDIT.md](NO-DEMO-DATA-AUDIT.md) — where demo data lives + why it can't leak
- [APY-WIRING.md](APY-WIRING.md) — Morpho / Aave / Compound / yoUSD details
- [SWAP-WIRING.md](SWAP-WIRING.md) - Socket / LI.FI / Mayan / CCTP / tokenized stocks

## Top-level layout

```
apps/api/src
├── index.ts             // Hono bootstrap, CORS, rate limit, route mount
├── lib/
│   ├── env.ts           // env + feature flags (env-gated integrations)
│   ├── auth.ts          // Bearer session middleware
│   ├── errors.ts        // ApiError canonical shape (ADR 0002)
│   ├── sourced.ts       // SourcedValue helpers (Sprint 15)
│   ├── provider-registry.ts // ProviderRegistry builder
│   ├── earn-router.ts   // Morpho / Aave / Compound / yoUSD facade
│   ├── bridge-router.ts // Socket primary + LI.FI fallback
│   ├── chain/           // per-protocol adapters (apy, defi, morpho, etc.)
│   ├── markets/         // Hyperliquid + Polymarket adapters
│   ├── psp/stripe.ts    // Stripe Checkout integration
│   ├── kyc.ts           // Sumsub applicant token + webhook
│   └── ...
├── routes/
│   ├── auth.ts          // OTP + Privy challenge
│   ├── ledger.ts        // balance + activity + SSE stream
│   ├── earn.ts          // /earn/* + /swap/*
│   ├── markets.ts       // Hyperliquid + Polymarket
│   ├── x402.ts          // facilitator settle + contracts
│   ├── card.ts          // Gnosis Pay state + topup
│   ├── bridge.ts        // virtual accounts + payouts + webhooks
│   ├── kyc.ts           // Sumsub
│   ├── offers.ts        // seller offers + checkout
│   ├── claim.ts         // email-claim escrow
│   ├── payments.ts      // send + topup + request links
│   ├── campaigns.ts     // creator clips + verify
│   ├── perks.ts         // tiers + multipliers
│   ├── agent.ts         // agent wallet + policy + fund
│   ├── admin.ts         // sweep + audit-log (Bearer-gated)
│   ├── keys.ts          // /keys (session) + v1 API key mint
│   ├── v1.ts            // public seller API surface
│   └── system.ts        // Sprint 15 — /system/providers + /system/data-sources
├── store/
│   ├── core/            // LedgerStateManager + InMemoryStateManager (shared kernel)
│   ├── in-memory/       // per-domain in-memory modules
│   ├── postgres/        // per-domain postgres modules (ADR 0001 split)
│   └── index.ts         // factory: postgres when DATABASE_URL set, in-memory else
├── workers/             // BullMQ approvals + scheduler (claim sweep, sub renewer, digest)
├── db/                  // Drizzle schemas + migrations 0000-0014
├── mcp/                 // MCP transport + tool registrations
└── openapi.ts           // OpenAPI 3.0 spec for /v1
```

## Backend domains

| Domain | Routes | Store module | Chain dependency | Providers |
|--------|--------|--------------|------------------|-----------|
| Auth | `/auth/*` | `store/{*}/auth.ts` | — | Privy (optional) |
| Ledger | `/ledger/*` | `store/core/ledger-state.ts` | — | — |
| Bridge | `/bridge/*` | `store/{*}/bridge.ts` | `lib/chain/bridge.ts` | Bridge |
| Stripe | `/checkout/*` | `store/{*}/payments.ts` | `lib/psp/stripe.ts` | Stripe |
| Earn | `/earn/*` | LedgerStateManager (via routes) | `lib/earn-router.ts` -> Morpho / Aave / Compound / yoUSD; Marinade route helpers | Morpho, Aave, Compound, yoUSD, Marinade |
| Swap | `/swap/*` | none (settled on chain or ledger) | `lib/bridge-router.ts` -> Socket / LI.FI; `lib/chain/mayan.ts` for Solana legs | Socket, LI.FI, Mayan |
| Card | `/card/*` | `store/{*}/cards.ts` | `lib/chain/gnosisPay.ts`, `lib/chain/sponge.ts` | Gnosis Pay, Sponge |
| Agent | `/agent/*` | `store/{*}/agents.ts` | `lib/chain/privy-agent-wallet.ts` | Privy |
| x402 | `/x402/*` | `store/{*}/agents.ts` | `lib/chain/x402.ts` | Coinbase x402 |
| KYC | `/kyc/*` | `store/{*}/kyc.ts` | `lib/kyc.ts` (Sumsub) | Sumsub |
| Claims | `/claim/*` | `store/{*}/claims.ts` | `lib/chain/privy-claim.ts` | Privy |
| Markets | `/markets/*` | `store/{*}/markets.ts` | `lib/markets/{hyperliquid,polymarket}.ts` | Hyperliquid, Polymarket |
| Campaigns | `/campaigns/*` | `store/{*}/campaigns.ts` | — | (TikTok / YouTube v2 stub) |
| Perks | `/perks` | `store/{*}/campaigns.ts` | — | — |
| Admin | `/admin/*` | (cross-cutting) | — | — |
| System | `/system/*` | (in-process) | — | (registry of all of the above) |
| Observability | `/healthz` + internal `/metrics` | — | — | Sentry, Prometheus |
| MCP | `/mcp` | (cross-cutting) | — | — |

## Boot order

1. Env validated by `lib/env.ts` (Zod schema). Production guards reject demo defaults under `NODE_ENV=production`.
2. Sentry bootstrapped first (`lib/sentry-bootstrap.ts`) so Hono server instrumentation lands cleanly.
3. Store factory resolves at module load: postgres when `DATABASE_URL` is set, in-memory otherwise.
4. Chain mirror attached to the store (best-effort async ledger → DeFi sync).
5. Routes mounted in order: auth → ledger → payments → offers → checkout → v1 → keys → earn → swap → card → agent → x402 → bridge → kyc → claim → markets → campaigns → perks → admin → system.
6. Approval worker started when Redis is present.
7. HTTP server bound to `API_PORT`.

## Data-source contract

Every screen calls one or more routes. Every route returns either a plain value or a value wrapped in a `SourcedValueMeta` envelope. The envelope is defined in `@nexa/shared-zod`:

```ts
SourcedValueMeta {
  source: 'live' | 'sandbox' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error';
  provider: string;          // e.g. 'morpho', 'aave', 'socket'
  fetchedAt: string | null;  // ISO timestamp of the last successful fetch
  ttlSeconds?: number;
  docsUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}
```

The PWA renders this envelope via `<nexa-source-badge>` so the user can always trace a number back to a vendor and a timestamp. Under `NODE_ENV=production`, `source: 'provider-demo'` is impossible — `lib/sourced.ts.providerDemoMeta()` guards against it.

## Chain-mirror lifecycle

`lib/chain/chain-mirror.ts` attaches a fire-and-forget post-commit hook to the ledger state manager. After `earnDeposit` / `earnWithdraw` succeeds, it routes through `EarnRouter.deposit/withdraw` to mirror the move on chain. The mirror never blocks the user-facing response. Failures bump the `chain_mirror_failed_total` Prometheus counter but never throw.

## Custody status

The system is **semi-custodial** today (Option C in `docs/CUSTODY-ANALYSIS.md`). Receive / send USDC + x402 settlement are already non-custodial-ready (EIP-3009 + Privy TEE wallets). Cards, earn deposits, and bank rails remain semi-custodial. Sprint 15 doesn't change custody status — it strengthens the transparency layer so the user can see exactly what's live and what's gated.

## Production guardrails

`lib/env.ts:205-215` enforces three production safety rules:
- `DEMO_MODE=1` rejected unless `ALLOW_DEMO_IN_PRODUCTION=1`
- `JWT_SECRET` must be rotated from the demo default
- `NEXA_AGENT_KEYS` must be rotated from the demo default

`lib/sourced.ts.providerDemoMeta()` will refuse to emit `source: 'provider-demo'` when `env.DEMO_MODE` is false, defaulting to `unavailable` instead.

`apps/api/src/routes/no-leak.spec.ts` regression-tests these invariants.

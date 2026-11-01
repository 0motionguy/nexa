# Tech Stack · Route · Provider Inventory

**Last verified: 2026-07-02** (full integration audit: two file:line code sweeps, live production probes, npm/lockfile currency, upstream changelogs, package provenance).

This is the umbrella inventory for the NEXA monorepo (`github.com/0motionguy/maze`). It links the two **generated** matrices and the existing canon docs instead of duplicating them:

| Artifact | Source of truth | Regenerate |
|---|---|---|
| [`API_ROUTE_MATRIX.md`](API_ROUTE_MATRIX.md) (+ `api-route-matrix.json`) | `apps/api/src` route tree | `pnpm route:inventory` |
| [`PROVIDER_MATRIX.md`](PROVIDER_MATRIX.md) | `GET /system/providers` (runtime registry) | `pnpm route:inventory` |
| [`API-INTEGRATION-REGISTRY.md`](API-INTEGRATION-REGISTRY.md) | hand-maintained vendor registry mirror | on vendor change |
| [`API.md`](API.md), [`FEATURE_FLAGS.md`](FEATURE_FLAGS.md), [`adr/`](adr/) | existing canon | — |

---

## 1. Tech stack (lockfile-resolved versions, 2026-07-02)

**Monorepo**: pnpm 9.12.0 workspaces (`apps/*`, `packages/*`), Node >= 22, TypeScript 5.7, ESLint 10, Vitest 3.2.

**Apps**
- `apps/api` — `@nexa/api`. Hono 4.12.25 on `@hono/node-server`, WS via `@hono/node-ws`, Swagger UI, Zod 3.25.76 validation (`@hono/zod-validator` + `@nexa/shared-zod`), OpenAPI via `@asteasolutions/zod-to-openapi`.
- `apps/web` — `@nexa/web`. React 18.3 + Vite 6.4.3 (pinned), `@privy-io/react-auth` 3.32.x, Playwright e2e, Vitest + jsdom.
- `apps/mcp` — thin MCP client for the `/mcp` Streamable-HTTP server.

**Packages**
- `@nexa/shared-zod` — shared wire schemas (API + web + OpenAPI consume the same source).
- `@nexa/sdk` — **public** TS client (`publishConfig.access: public`); types generated from the OpenAPI spec via `openapi-typescript` (`gen:types`) — expanding OpenAPI coverage directly improves the SDK.
- `@nexa/realtime-client`, `@nexa/charts` — consumed by web and the sibling NEO Expo app via `link:` deps.

**DB / cache / queue**: Postgres (`postgres` 3.4 + Drizzle ORM 0.45.2, migrations in `db/migrations/`), Redis (`ioredis` 5.4), BullMQ 5.78 (approvals worker in-process; standalone scheduler runs claim-sweeper, subscription-renewer, digest-sender, bridge-worker).

**Auth / wallet**: `@privy-io/server-auth` 1.32.5 (EVM + Solana server wallets, EIP-712/raw/Solana signing; **upstream-deprecated** → `@privy-io/node` 0.24.0 migration deferred, see registry), SIWE 3.0 (Gnosis Pay), JWT sessions + httpOnly cookie, `sk_*` API keys, `nx_live_*` agent keys.

**Chains**: Base, Arbitrum, Polygon, Optimism, Gnosis, Solana — via viem 2.52.2, `@solana/web3.js` 1.98.4, Alchemy EIP-7702 sponsored batch executor.

**Market SDKs**: `@nktkas/hyperliquid` 0.32.2, `@polymarket/clob-client-v2` 1.0.6 (official Polymarket — provenance verified), Jupiter raw HTTP (Token v2 + Swap v1), `@mayanfinance/swap-sdk` 15.0.0, `@mathieuc/tradingview` 3.5.2.

**Payments**: Stripe 22.2.1 (pinned, apiVersion `2026-05-27.dahlia`), Bridge.xyz (raw v0), Monerium, Onramper widget, Circle CCTP V1 (+ Iris attestation), x402 Coinbase facilitator (EIP-3009).

**Observability**: `@sentry/node` 10.x, Prometheus (`prom-client`, Bearer-gated `/metrics`), Pino (+ Sentry transport), web-push, Resend.

---

## 2. Route inventory

Generated: **218 endpoints across 31 mounts** (+5 app-level: `/healthz`, `/metrics`, `/v1/openapi.json`, `/v1/docs`, `/mcp`). See [`API_ROUTE_MATRIX.md`](API_ROUTE_MATRIX.md) for the full method/path/auth/OpenAPI/source table.

Auth models in use: `session` (JWT/cookie) · `api-key (sk_*)` on `/v1` · `agent-key (nx_live_*)` on `/x402/pay|settle` + `/mcp` · `admin-token` on `/admin` · `admin-key (agent)` on campaign admin · hybrid public-GET-allowlist on `/markets` · webhook HMAC verified in-handler (Sumsub, Bridge, Stripe) · public tiles/discovery.

### Route gaps (verified 2026-07-02)

1. **OpenAPI coverage is 23/218 operations (11%)** — only `/v1/*`, `/auth/*`, `/me/*` are documented. All 59 `/markets` routes, `/earn`, `/swap`, `/transfers`, `/balances`, `/x402`, `/card` etc. are undocumented. Because `@nexa/sdk` types are generated from this spec, expanding it upgrades the public SDK for free.
2. **Duplicate route**: `GET /earn/ethena` defined at `routes/earn.ts:50` (public — wins first-match) **and** `routes/earn.ts:249` (byte-identical, behind the session gate at `:197` — unreachable dead code). The generator warns on this.
3. **`/markets/fills` merges Hyperliquid only** (`routes/markets.ts:4232-4238`) — Jupiter + Polymarket adapters have no `getUserFills`; the "cross-venue" fills feed is single-venue today.
4. **`POST /markets/hyperliquid/update-isolated-margin`** is mounted but backed by a `not_implemented` stub (`lib/markets/hyperliquid.ts:1118`).
5. **Two admin auth models**: `/admin` uses static Bearer `ADMIN_TOKEN` (`routes/admin.ts:50`), campaign admin uses agent keys (`routes/campaigns.ts:39`) — unify or document intent.
6. Spec files exist for 26/28 mounted modules (`spend.ts`, `wellknown.ts` have none; `markets-cards.ts` is covered by `cards.spec.ts`).
7. Cross-venue cancel returns **412 `cancel_unsupported_for_venue`** for anything but HL/HL-spot/HIP-3/Polymarket (`routes/markets.ts:4257-4263`) — by design, but clients must handle 412.

---

## 3. Provider inventory

Live registry (production, 2026-07-02): **33 providers — 23 live · 6 missing-keys · 3 docs-only · 1 gated**. Full table with SDK currency + docs links: [`PROVIDER_MATRIX.md`](PROVIDER_MATRIX.md).

**Live in production** (probed): Hyperliquid perps/spot/HIP-3 stocks (`source:"live"`), Polymarket, Jupiter reads, Collector-Crypt cards, xStocks-via-Jupiter, Stripe Checkout + Crypto Onramp, LI.FI, Mayan, x402, Privy, Alchemy 7702, chain balances, Earn adapters (Morpho ×2, Aave, Compound, yoUSD, Marinade), Resend, Sentry, Postgres, Redis.

**Not yet live in production** (missing vendor keys — the fiat/card/KYC edge): Bridge.xyz (KYB pending — longest critical path to US bank rails), Monerium, Sumsub KYC, Socket (partner form submitted), Gnosis Pay, Sponge.

**Registry-truth drift** (the status page lies in both directions — fix list in §5):
- `circle-cctp` says *docs-only* but a **live CCTP V1 burn→attestation→mint pipeline** serves `/transfers/internal` via the bridge-worker (`lib/chain/cctp.ts:244-533`).
- `coinbase-x402` status is vacuous — the env default (`lib/env.ts:152`) makes it unconditionally "live"; facilitator reachability is never probed.
- `mayan` is hard-coded `'live'` (`lib/provider-registry.ts:208`).
- `xstocks` says *docs-only* ("UI must remain hidden") while secondary-market trading via Jupiter is live today; docs-only truly applies only to primary mint/redeem (`lib/markets/tokenized.ts`).
- `pumpfun` says *live* but production `/markets/jupiter` reports `pumpSource:"provider-demo"` (API answers 200 externally — server-side cause, root-cause pending).
- **Unregistered surfaces** (invisible to `/system/providers`): TradingView, Onramper, Jupiter Lend, DefiLlama/yields-landscape (fetched but rows voided in `/earn/landing`), Pyth Hermes (dark-launched behind `REALTIME_HUB_V1`).

### SDK currency snapshot (lockfile-resolved → npm latest, 2026-07-02)

| Package | Resolved | Latest | Verdict |
|---|---|---|---|
| `@polymarket/clob-client-v2` | 1.0.6 | **1.0.8** (2026-07-01) | **Upgrade soon** — adds ExchangeV3 order signing + new tick sizes; README now recommends Polymarket's unified ts-sdk |
| `@nktkas/hyperliquid` | 0.32.2 | 0.33.1 | Upgrade at leisure — 0.33.0 breaks only `noop`/`createVault`/multi-sig (unused here); confirm at bump |
| `stripe` | 22.2.1 (pinned) | 22.3.0 | Patch bump; recheck `2026-05-27.dahlia` pin + untyped onramp `rawRequest` |
| `resend` | 4.8.0 | 6.16.0 | Two majors behind; email-only blast radius, low urgency |
| `@privy-io/server-auth` | 1.32.5 | 1.32.5 | Current but **deprecated upstream** → `@privy-io/node` 0.24.0 migration spike |
| `hono` / `bullmq` / MCP SDK / `drizzle-orm` / `mayan` / `siwe` / `@solana/web3.js` / `viem` | 4.12.25 / 5.78.0 / 1.29.0 / 0.45.2 / 15.0.0 / 3.0.0 / 1.98.4 / 2.52.2 | ≈ current | Healthy |
| `zod` | 3.25.76 | 4.4.3 | Staying on v3 is deliberate (shared-zod contract surface) |

NEO sibling app: `@privy-io/expo` 0.69.4 + `@privy-io/react-auth` 3.32.2 current; `lightweight-charts` 5.0.9 → 5.2.0 available; Expo SDK 54 → 57 available (own sprint).

---

## 4. NEO Terminal gap map

**Already strong** (backend exists, live): six-venue trading (HL perps/spot/HIP-3, Polymarket incl. top-traders/leaderboard, Jupiter memes, xStocks, Collector-Crypt cards), shared order lifecycle (`/markets/orders|positions|fills` + cross-venue cancel), portfolio buckets + CCTP/Mayan transfers, earn/yield, swaps, payments/offers/checkout, agents + x402 + MCP, cards (key-gated), realtime hub (dark-launched incl. Pyth Hermes).

**Missing for the digital-economy layer** (no routes today):
- CoinGecko/CMC-style **discovery** layer (trending, categories, global market data) — add behind a data-provider abstraction, not as a one-off adapter.
- **News/topic/AISO Trace** layer; Entity/Topic/Profile/Community/threads APIs.
- **Sports odds** provider + routes.
- **Mini-app marketplace** (AISO profile install/payment/booking hooks).
- GTA6 economy hub (depends on Entity/Topic API first).

---

## 5. Ranked improvement backlog (2026-07-02 audit)

**P0 — money-path correctness**
1. NEO↔NEXA contract lockstep (from `neo/AUDIT-2026-07-02-CODE-AND-UX.md`): cancel `orderId`→`externalRef` mismatch, missing `Idempotency-Key` on spot→perps transfer, stale builder-banner field, orphaned withdraw sheet, mobile clipboard no-op. Structural fix: share order/cancel/transfer schemas via `@nexa/shared-zod`.
2. Bump `@polymarket/clob-client-v2` → 1.0.8 (ExchangeV3 + tick sizes) + order-signing regression snapshots; evaluate Polymarket's unified ts-sdk.
3. Registry truth pass: CCTP → live w/ real `backendFiles`; xStocks split secondary/primary; derive x402 + Mayan status from real reachability (add to `/system/data-sources`); register TradingView/Onramper/Jupiter-Lend/yields-landscape; un-exempt from the coverage gate; verify x402 facilitator URL against current CDP docs (env default DNS was ambiguous in probe).
4. Pump.fun production root-cause (`provider-demo` despite reachable API).

**P1 — API surface hygiene**
5. Delete dead duplicate `/earn/ethena` (`routes/earn.ts:249-263`).
6. Unified fills: `getUserFills` for Polymarket + Jupiter, merged in `/markets/fills`.
7. `updateIsolatedMargin`: implement or unmount.
8. OpenAPI expansion 23 → ~60 ops (markets/earn/swap/transfers/balances/x402 core) — free SDK upgrade via typegen.
9. Unify/document the two admin auth models.

**P2 — SDK/platform currency**
10. `@nktkas/hyperliquid` 0.33.1 · `stripe` 22.3.0 · `resend` 6.x.
11. Privy `server-auth` → `@privy-io/node` migration spike.
12. `.well-known/x402` discovery for agent commerce; decide DefiLlama voided-fetch (surface or delete).
13. NEO-side: `lightweight-charts` 5.2, Expo 57 planning.

**P3 — product layer**: discovery abstraction + CoinGecko/CMC adapters, Entity/Topic/Community APIs, sports odds, mini-app marketplace (see §4).

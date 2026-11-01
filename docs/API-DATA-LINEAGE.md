# API-DATA-LINEAGE.md

**Last updated:** 2026-06-17 (Sprint 15)

For every screen the user can see, this doc traces every visible financial value back to the API route, the chain adapter, and the underlying provider. If a value is on screen, it appears here. If it doesn't appear here, it's either marketing copy (landing only) or it's a bug.

## Reading this table

- **Element**: what the user sees
- **Route**: which API endpoint owns the value
- **Adapter**: backend module that fetches it
- **Provider**: vendor returning the data
- **Source kind**: `live` / `sandbox` / `unavailable` / etc. as carried in the `SourcedValueMeta` envelope (Sprint 15)
- **Demo fallback**: what shows up when the live path fails

The runtime snapshot of this lineage is available at `GET /system/data-sources`.

## Home (s08)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Balance hero (`#balEl`) | `/ledger/me` | `store/{*}/ledger.ts` | (internal) | n/a | `L.bal = 4820.4` (Mirko canonical fixture) |
| Earn APY badge | `/earn/protocols` | `lib/earn-router.ts` → Morpho adapter | Morpho | live / unavailable | "Live APY pending" string |
| Recent activity (rows) | `/ledger/activity` SSE | `store/core/ledger-state.ts` | (internal) | n/a | seeded activity from `L.activity` |
| Agent summary | `/ledger/me` | `store/{*}/agents.ts` | (internal) | n/a | demo agents from `L` |

## Earn (s14)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Earning balance hero (`#earnPos`) | `/ledger/me` | `store/{*}/ledger.ts` | (internal) | n/a | `L.earnPos = 3200` |
| Blended APY tag (`[data-earn-apy]`) | `/earn/apy` | `lib/earn-router.ts` | tier-picked (Morpho or higher-yield) | live / unavailable | "APY unavailable" |
| Source badge (`[data-earn-apy-source]`) | `/earn/apy` `.sourced` | `lib/sourced.ts` | provider name | live / unavailable / cached-live | hidden in DEMO_MODE |
| Morpho row APY | `/earn/protocols` `.adapters[name=morpho]` | `lib/chain/morpho.ts` | Morpho GraphQL | live / unavailable | "Unavailable" string |
| Aave row APY | `/earn/protocols` `.adapters[name=aave]` | `lib/chain/defi.ts` | Aave v3 Pool | live / unavailable | "Unavailable" string |
| Compound row APY | `/earn/protocols` `.adapters[name=compound]` | `lib/chain/compound.ts` | Compound v3 Comet | live / unavailable | "Unavailable" string |
| yoUSD row APY | `/earn/protocols` `.adapters[name=yousd]` | `lib/chain/yousd.ts` | YO Protocol public API | live / unavailable | "Unavailable" string |
| Marinade row APY | `/earn/protocols` `.adapters[name=marinade]` plus `/earn/marinade/*` writes | `lib/chain/marinade.ts` | Marinade Finance | live / missing-keys / unavailable | "Unavailable" string |
| Projected/year tile | client-side `projectedYield(L.earnPos)` | derived from `earnApyBps` | (same as above) | n/a | "Live APY pending" |
| Campaigns list | `/campaigns?status=active` | `store/{*}/campaigns.ts` | (internal) | n/a | seeded campaigns |
| Perks tier card | `/perks` | `store/{*}/campaigns.ts` | (internal) | n/a | "Tier · Multiplier" demo string |

## Swap (s16)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Quote out (`#swOut`) | `/swap/quote` | `lib/bridge-router.ts` -> Socket or LI.FI; `lib/chain/mayan.ts` for Solana legs | Socket primary, LI.FI fallback, Mayan for Solana | live / provider-demo / unavailable | 0.92 rate ONLY in DEMO_MODE |
| Rate (`#swRate`) | `/swap/quote` | (same) | (same) | (same) | derived from 0.92 |
| Network fee (`#swFee`) | `/swap/quote` | (same) | (same) | (same) | 0 |
| Best route (`#swRoute`) | `/swap/quote` `.source` | (same) | (same) | (same) | "DEMO QUOTE" string |
| Source badge (`[data-swap-source]`) | `/swap/quote` `.sourced` | `lib/sourced.ts` | provider name | live / provider-demo / unavailable | hidden outside DEMO_MODE |

## Card (s17 / s18)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Card last 4 (`#vPan`) | `/card` | `lib/chain/gnosisPay.ts` | Gnosis Pay | live / provider-demo / unavailable | synthetic `••• 0000` |
| Network + kind (`#vCvv`) | `/card` | (same) | (same) | (same) | "VISA · DEBIT · DEMO" |
| Freeze state (`#freezeSw`) | `/card/freeze` | `store/{*}/cards.ts` | (internal) | n/a | `L.frozen` |
| Day limit (`#dayLimitVal`) | `/card/limit` | `store/{*}/cards.ts` | (internal) | n/a | `$500` default |
| Card top-up | `/card/topup` | `lib/bridge-router.ts` | Socket / LI.FI (BASE→GNOSIS USDC→EURe) | live / provider-demo / unavailable | logs the activity only |
| Card activity | `/ledger/activity?filter=card` | `store/{*}/ledger.ts` | (internal) | n/a | "LIVE CARD TRANSACTIONS" empty state |

## Agents (s19–s24)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Agent list | `/agent` | `store/{*}/agents.ts` | (internal) | n/a | seeded agents |
| Kill switch | `/agent/kill-switch` | `store/{*}/agents.ts` | (internal) | n/a | local toggle |
| Agent fund | `/agent/:id/fund` | `store/{*}/agents.ts` + `lib/chain/privy-agent-wallet.ts` | Privy | n/a | synthetic wallet handle |
| Approve-once | `/agent/:id/approve-once` | `store/{*}/agents.ts` | (internal) | n/a | client toast only |
| MCP config (s24) | client-rendered (no fetch) | — | — | n/a | n/a |

## Markets (s27)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Hyperliquid market list | `/markets/hyperliquid` | `lib/markets/hyperliquid.ts` | Hyperliquid public API | live / provider-demo | sample synthetic markets |
| Market detail | `/markets/hyperliquid/:coin` | (same) | (same) | (same) | sample synthetic market |
| Polymarket market list | `/markets/polymarket` | `lib/markets/polymarket.ts` | Polymarket public API | live / provider-demo | sample synthetic markets |
| Polymarket market detail | `/markets/polymarket/:id` | (same) | (same) | (same) | sample synthetic market |
| Hyperliquid order | `/markets/hyperliquid/order` | (same) | Hyperliquid private exchange endpoint | live | gated 503 when no Privy wallet ID |
| Polymarket order | `/markets/polymarket/order` | (same) | Polymarket CLOB | live | gated 503 when no Privy wallet ID |

## More → System / Docs (s28, Sprint 15)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Providers list | `/system/providers` | `lib/provider-registry.ts` | (registry) | n/a | n/a (always returns the static registry) |
| Data sources list | `/system/data-sources` | `lib/provider-registry.ts` + `lib/sourced.ts` | (registry + freshness tracker) | n/a | shows last successful fetch per (provider, metric) |
| Missing docs | derived from `/system/providers` | (registry) | (same) | n/a | shows entries where `publicDocsUrl === null` |
| Health tag | `/system/health` | (env + storeBoot) | (internal) | n/a | "DEMO" vs "LIVE" badge |

## x402 vendor portal (portal.html → p01–p04)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Contracts list | `/x402/contracts` | `store/{*}/agents.ts` | (internal) | n/a | seeded contracts |
| Events | `/x402/contracts/events` | (same) | (same) | n/a | seeded events |
| Endpoint price | client-rendered from `/x402/contracts` | (same) | (same) | n/a | n/a |
| Settlement | `/x402/pay` | `lib/chain/x402.ts` | Coinbase x402 facilitator | live / provider-demo | synthetic `0x…` tx hash |

## Public checkout (checkout.html)

| Element | Route | Adapter | Provider | Source kind | Demo fallback |
|---------|-------|---------|----------|-------------|---------------|
| Offer summary | `/checkout/:id` | `store/{*}/payments.ts` | (internal) | n/a | n/a |
| Pay (balance / card / bank_topup) | `/checkout/:id/pay` | `lib/psp/stripe.ts` for card | Stripe | live | `cs_demo_*` session in DEMO_MODE |
| Session status | `/checkout/session-status` | (same) | Stripe webhook | n/a | n/a |

## Landing (landing.html) — out of scope for source badges

The landing page is marketing copy per `nexa-taste-skill-rules` memory. Numbers there (`8.4%` est., BTC `$100,240.00`, etc.) are intentional demo presentation, not user-facing financial data. Source-badge wiring does **not** apply to landing.

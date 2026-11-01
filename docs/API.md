# Neo Bank / NEXA — Public API Reference

The Neo Bank server exposes a unified HTTP/JSON surface for everything the
mobile + web clients use, plus third-party integration. Same wire shape
everywhere: JSON in, JSON out, bearer-token auth.

- **Base URL (prod)**: `https://nexa.aiso.tools`
- **OpenAPI spec**: `GET /v1/openapi.json` (machine-readable, downstream tools)
- **Interactive docs**: `GET /v1/docs` (Swagger UI, behind session JWT)
- **SDK**: [`@nexa/sdk`](../packages/nexa-sdk) — TypeScript
- **MCP**: [`@nexa/mcp`](../apps/mcp) — for AI agents
- **Source of truth**: `apps/api/src/routes/`

## Authentication

Two equivalent ways to authenticate. Same Bearer header, different token
types — the server treats them identically at the wire level.

### 1. Session JWT (mobile / web user)

```
POST /auth/start   { email }
POST /auth/verify  { challengeId, code }  → { token, expiresAt }
GET  /me/profile   Authorization: Bearer <token>
```

JWTs expire after 7 days; refresh via `POST /auth/refresh`.

### 2. API Key (server-to-server, AI agents)

```
Authorization: Bearer sk_live_…   # production
Authorization: Bearer sk_test_…   # sandbox
```

API keys are created via the developer dashboard (or `POST /keys`). They
authenticate the same routes as a session JWT but additionally scope reads
to the key's mode (sk_test_ keys see only sandbox data).

The `/me/*` and `/markets/*` surfaces accept both; the `/v1/*` namespace is
**API-key only** (the canonical seller / partner surface).

## Conventions

- Successful responses: `{ ok: true, ...data }`
- Errors: `{ ok: false, error: { code, message, details? } }` with the matching HTTP status
- Pagination: `?limit=N&offset=K` where supported
- Idempotency: every live trade POST **requires** `Idempotency-Key: <opaque>` header. Server caches responses for ~24h and replays them on duplicate keys.
- Wire timestamps: ISO 8601 strings except where noted (HL candles use ms epoch).

## Profile + identity

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/auth/me` | session | Identity + balance + earn config |
| GET | `/me/profile` | session or sk_* | **Unified aggregator** — see [PROFILE.md](./PROFILE.md) |
| GET | `/me/fees` | session or sk_* | Fees collected on this user's behalf |
| GET | `/me/admin/fees/summary` | sk_live_ | Platform-wide fee summary (ops) |

## Markets

Six venues, one wire shape per resource. All listing endpoints are
**public** (no auth needed) — they wrap upstream public APIs and add
caching + sourcing metadata. Trading endpoints require auth + geo gate +
the per-venue trading-eligibility checks described in [PROFILE.md](./PROFILE.md).

### Hyperliquid perps (`/markets/hyperliquid`)

| Method | Path | Notes |
|---|---|---|
| GET | `/markets/hyperliquid?limit=N` | 230 perps |
| GET | `/markets/hyperliquid/:coin` | Single market detail |
| GET | `/markets/hyperliquid/candles?coin=…&interval=…` | OHLCV |
| GET | `/markets/hyperliquid/all-mids` | All mid prices, 1s cache |
| GET | `/markets/hyperliquid/orderbook?coin=…` | L2 book |
| GET | `/markets/hyperliquid/recent-trades?coin=…` | Recent trades |
| GET | `/markets/hyperliquid/funding-history?coin=…` | Funding rate history |
| GET | `/markets/hyperliquid/builder-status` | Backend-managed HL builder-fee agreement status |
| POST | `/markets/hyperliquid/approve-builder` | Backend/manual compatibility path for the agreement |
| POST | `/markets/hyperliquid/order` | Place perp order (idempotent) |
| POST | `/markets/hyperliquid/cancel` | Cancel by externalRef |
| POST | `/markets/hyperliquid/usd-class-transfer` | Move USDC between spot/cash and perp margin, no KYC gate; live requires `Idempotency-Key` |
| POST | `/markets/hyperliquid/usd-send` | Send Hyperliquid core USDC to an EVM wallet, no KYC gate; live requires `Idempotency-Key` |
| POST | `/markets/hyperliquid/transfer-to-dex` | Move HL USDC between core and builder DEX, no KYC gate; defaults to trade.xyz `xyz`; set `sourceDex=xyz,destinationDex=""` to return to core; live requires `Idempotency-Key` |
| POST | `/markets/hyperliquid/withdraw` | Withdraw from HL to an EVM wallet address, no KYC gate; live requires `Idempotency-Key` |
| GET | `/markets/hyperliquid/positions` | User positions |

### Hyperliquid spot (`/markets/hyperliquid-spot`)

| Method | Path | Notes |
|---|---|---|
| GET | `/markets/hyperliquid-spot?limit=N` | 307 spot pairs |
| GET | `/markets/hyperliquid-spot/detail?coin=…` | Detail (canonical pair name or @N) |
| GET | `/markets/hyperliquid-spot/all-mids` | Shared with HL perps |
| POST | `/markets/hyperliquid-spot/order` | Spot order (asset id `10000 + idx`) |
| POST | `/markets/hyperliquid-spot/cancel` | |
| GET | `/markets/hyperliquid-spot/positions` | |

### Stocks — trade.xyz HIP-3 + Backed xStocks (`/markets/stocks`)

| Method | Path | Notes |
|---|---|---|
| GET | `/markets/stocks?limit=N` | **Merged** perps (HIP-3) + spot (xStocks) |
| GET | `/markets/stocks/perps?limit=N` | trade.xyz HIP-3 only (93 markets) |
| GET | `/markets/stocks/spot?category=…&limit=N` | Backed xStocks (131 assets) |
| GET | `/markets/stocks/detail?coin=xyz:TSLA` or `?mint=Xs…` | Single market |
| GET | `/markets/stocks/candles?coin=xyz:TSLA&interval=1h` | HIP-3 OHLCV |
| GET | `/markets/stocks/all-mids` | HIP-3 mids |
| POST | `/markets/stocks/order` | HIP-3 perp order (`coin` accepts bare ticker or `xyz:TICKER`) |
| POST | `/markets/stocks/cancel` | |
| GET | `/markets/stocks/positions` | Stored stock positions; add `?includeLive=1` to include live HIP-3 wallet positions (`livePerps`) |

xStocks trades route through `/markets/jupiter/swap` because xStocks are
just SPL Token-2022 mints — Jupiter handles the routing.

### Memes — Pump.fun + Jupiter (`/markets/jupiter`)

| Method | Path | Notes |
|---|---|---|
| GET | `/markets/jupiter?source=both&tag=verified&sort=market_cap&limit=N` | Merged pump.fun + Jupiter |
| GET | `/markets/jupiter/detail?mint=…` | |
| GET | `/markets/jupiter/prices?ids=mint1,mint2,…` | Bulk price lookup (up to 100) |
| POST | `/markets/jupiter/quote` | Swap quote |
| POST | `/markets/jupiter/swap` | Execute swap (Privy Solana signs server-side, idempotent) |
| GET | `/markets/jupiter/positions` | |

### Polymarket (`/markets/polymarket`)

| Method | Path | Notes |
|---|---|---|
| GET | `/markets/polymarket?category=…&limit=N` | Active markets, sorted by 24h volume |
| GET | `/markets/polymarket/:id` | Single market detail |
| GET | `/markets/polymarket/:id/book?outcome=Yes` | CLOB orderbook (2s cache) |
| GET | `/markets/polymarket/:id/top-traders?limit=N` | Public outcome-token holder leaderboard (30s cache) |
| POST | `/markets/polymarket/order` | Place CLOB order |
| GET | `/markets/polymarket/positions` | |

## Balances + portfolio transfers

These routes move USDC between NEXA portfolio buckets and venue wallets. They
are not KYC-gated bank payouts; live writes require an authenticated session,
an unfrozen account, wallet/executor readiness, and idempotency.

| Method | Path | Notes |
|---|---|---|
| GET | `/balances` | Aggregate USDC balances by bucket (`cash`, `perps`, `predictions`, `memes`); `perps` includes the Arbitrum wallet plus Hyperliquid Spot USDC and exposes `sources` |
| GET | `/onramp/deposit-address?bucket=…` | Canonical deposit address for a bucket, including `stocks-spot` |
| POST | `/transfers/internal` | Move between buckets; live requires `Idempotency-Key` |
| POST | `/transfers/hl-deposit` | Push Arbitrum USDC from the user wallet into Hyperliquid Bridge2; live requires `Idempotency-Key` |
| GET | `/transfers?limit=N` | Recent transfer rows |
| GET | `/transfers/:id` | Transfer row plus state-machine events |

## Payments + payouts + offers (`/v1/*`)

The canonical seller-API surface. API-key auth only. Mirrors `/payments`
+ `/offers` etc. but speaks the public-API dialect (bare resources, no
`{ ok }` envelope).

See [v1.ts](../apps/api/src/routes/v1.ts) for the surface and the spec at
`/v1/openapi.json`.

| Method | Path |
|---|---|
| POST | `/v1/offers` |
| GET | `/v1/offers/:id` |
| POST | `/v1/sub-accounts` |
| POST | `/v1/payouts` |
| GET | `/v1/payments/:id` |
| GET | `/v1/subscriptions/:id` |
| POST | `/v1/subscriptions/:id/cancel` |
| GET | `/v1/balance` |

## x402

Agent-payment surface. Discoverable via `/.well-known/x402-catalog`.
Premium endpoints are gated by `402 Payment Required` and settled with
the x402 facilitator.

## Stable error codes

| Code | When |
|---|---|
| `unauthorized` | Bad/expired token |
| `forbidden` | Feature flag off or admin-only route |
| `region_blocked` | Geo gate on a venue |
| `polymarket_token_unavailable` | Couldn't resolve outcome tokenId |
| `solana_wallet_unavailable` | Privy Solana wallet not yet provisioned |
| `idempotency_key_required` | Missing `Idempotency-Key` on live trade |
| `quote_unavailable` | Jupiter / venue rejected the quote |
| `order_rejected` | Venue rejected the signed order |
| `account_frozen` | Kill switch active on user |

## Rate limits

Per-route, configured at `apps/api/src/index.ts:212–322`. Notable buckets:

- `/auth/start` — 5 / 10 min per email + IP
- `/v1/*` — bucketed per API-key hash
- `/x402/settle` — 60 / min per agent key
- `/markets/*/positions` — authenticated user-position reads use their own bucket so polling cannot starve public market lists

## Versioning

The public `/v1/*` surface is versioned in the OpenAPI spec. The
`/markets/*` + `/me/*` surfaces are pre-1.0 — additive changes only, no
breaking changes without a deprecation window. Subscribe to releases on
GitHub for change notices.

## Related docs

- [FEES.md](./FEES.md) — revenue model + fee receivers per venue
- [PROFILE.md](./PROFILE.md) — the `/me/profile` aggregator schema
- [`@nexa/sdk` README](../packages/nexa-sdk/README.md) — TypeScript client
- [`@nexa/mcp` README](../apps/mcp/README.md) — MCP for AI agents

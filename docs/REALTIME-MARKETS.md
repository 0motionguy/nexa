# Realtime Markets — Shared WSS Architecture

NEO (trading terminal) and MAZE (banking PWA) consume one realtime market feed
from one NEXA API process. Frontends never open direct vendor sockets and
never poll for prices. REST is reserved for cold-start snapshots and writes.

## Topology

```
            ┌──────────────────────────────────────────────────────────────┐
            │                       apps/api                               │
            │                                                              │
            │   ┌────────┐    ┌──────────┐    ┌────────────────────────┐   │
            │   │  HL    │ ─▶ │  Hub     │ ─▶ │  WS server             │   │
            │   │  PM    │ ─▶ │  ref-cnt │    │   /v1/stream/ws        │   │
            │   │  Pyth  │ ─▶ │  cache   │    │   /ws/markets   (alias)│   │
            │   │  Helius│ ─▶ │  coalesce│    │   /v1/stream/sse       │   │
            │   │  TV    │ ─▶ │          │    └────────────────────────┘   │
            │   └────────┘    └──────────┘                                 │
            │       ▲              │                                       │
            │       │              ▼                                       │
            │   vendor WS    REST snapshot                                 │
            └───────────────────────┬──────────────────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
            ┌──────────────┐                    ┌──────────────┐
            │     NEO      │                    │     MAZE     │
            │ (Expo + web) │                    │ (Vite PWA)   │
            │              │                    │              │
            │ React hooks: │                    │ Vanilla JS:  │
            │ useTicker    │                    │ new          │
            │ useCandle    │                    │ RealtimeClnt │
            │ useOrderbook │                    │              │
            └──────────────┘                    └──────────────┘
                  │                                   │
                  │  one WS per browser tab           │
                  │  ref-counted subscriptions        │
                  └──────────────┬────────────────────┘
                                 ▼
                       @nexa/realtime-client
                       @nexa/shared-zod (FeedEventZ)
```

One Hyperliquid upstream socket and one Polymarket upstream socket per API
process. The hub reference-counts client subscriptions and only opens a venue
sub when the first client asks for it; closes it when the last leaves.

## Public endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/healthz` | Pod liveness + non-fatal `realtime` section |
| `GET`  | `/v1/feeds/health` | Full hub + per-venue snapshot |
| `POST` | `/v1/stream/ticket` | Mint a 60s single-use ticket from a session JWT |
| `GET`  | `/v1/stream/sse` | EventSource transport (topic set pinned to URL) |
| `GET`  | `/v1/stream/ws` | WebSocket transport (legacy path, mid-stream sub/unsub) |
| `GET`  | `/ws/markets` | WebSocket transport (clean public alias — NEO + MAZE) |

Both WS paths share one handler. Production hosts:

```
wss://api.maze.bank/ws/markets
wss://api.nexa.aiso.tools/ws/markets
wss://maze.aiso.tools/api/ws/markets   (path-routed previews)
```

Caddy `reverse_proxy` to `neobank-api:8090` passes WS upgrades transparently
when `flush_interval -1` is set (it is, in `infra/caddy-fragment.conf`).

## Auth

| Credential | Where it goes | Notes |
|---|---|---|
| Session JWT | `Authorization: Bearer <jwt>` header | Standard cookie/Bearer accepted |
| Session cookie | `nexa_session=<jwt>` cookie | Browser-direct |
| Stream ticket | `?token=<ticket>` query param | 60s TTL, single-use, replay-guarded |

Full session JWTs are **rejected** from `?token=` to close the URL-leakage
surface (referrer headers, server logs, browser history). Use the ticket
flow for `EventSource` clients that can't set headers.

## Protocol — topic grammar

The wire grammar is `kind:venue:symbol[:param]` — colon-separated, lowercase,
parsed by [`apps/api/src/realtime/topic.ts`](../apps/api/src/realtime/topic.ts).

| Topic | Example | Meaning |
|---|---|---|
| `ticker:<venue>:<symbol>` | `ticker:hl:BTC` | Mid-price tick stream |
| `candle:<venue>:<symbol>:<interval>` | `candle:hl:BTC:1m` | OHLCV bars |
| `book:<venue>:<symbol>:<depth>` | `book:hl:BTC:50` | Top-N order book |
| `trades:<venue>:<symbol>` | `trades:hl:BTC` | Trade tape |
| `stock:pyth:<symbol>` | `stock:pyth:AAPL` | Pyth equity price |
| `meme:helius:<mint>` | `meme:helius:So11…` | Helius pool-derived meme price |
| `predictions:pm:<tokenId>` | `predictions:pm:0xabc…` | Polymarket outcome feed |

Venues: `hl` (Hyperliquid), `pm` (Polymarket), `pyth` (Pyth Hermes),
`helius` (Solana long-tail), `jup` (Jupiter — REST snapshot only),
`yahoo` (REST fallback), `tv` (TradingView WS proxy), `rest` (generic
fallback during breaker-open).

Intervals: `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `8h`, `12h`,
`1d`, `3d`, `1w`, `1M`.

### Deviation from the original WSS rollout prompt

The 2026-06-24 rollout prompt specified `hl.mids` / `hl.asset` / `pm.market`
style topics and a `{v:1, seq, ts, source, topic, key?, snapshot, data}`
envelope. The shipped hub uses the `kind:venue:symbol[:param]` grammar above
because 171 tests, 5 venue adapters, two SDK packages, and one NEO chart
wiring already speak it. The grammar is an internal contract, not a
publicly-documented spec, and the prompt explicitly allowed path/naming
variations when the current repo conventions required them.

## Protocol — envelopes

All schemas live in [`packages/shared-zod/src/realtime.ts`](../packages/shared-zod/src/realtime.ts).

### Client → server (`ClientOp`)

```ts
{ op: 'sub'   , topics: string[] }
{ op: 'unsub' , topics: string[] }
{ op: 'ping'  }
```

### Server → client (`ServerOp`)

```ts
// Control envelopes
{ op: 'ready' , accepted: string[] , serverVersion: '1' }
{ op: 'pong'  , ts: number }
{ op: 'err'   , code: 'unauthorized'|'topic_invalid'|'topic_cap_exceeded'
                     |'rate_limited'|'venue_unavailable'|'denied_acl'|'internal',
                topic?: string }

// FeedEvent (discriminated on `t`)
{ t: 'tick'   , topic, ts, lastTickAgeMs, src, px,             stale? }
{ t: 'candle' , topic, ts, lastTickAgeMs, src, o,h,l,c,v,closed,stale? }
{ t: 'book'   , topic, ts, lastTickAgeMs, src, bids[], asks[], seq, stale? }
{ t: 'trade'  , topic, ts, lastTickAgeMs, src, px, sz, side,   stale? }
```

`lastTickAgeMs` lets clients dim/grey out stale rows instead of lying.
`stale: true` flags a fallback-path emission (REST snapshot, after-hours)
vs the live WS happy path.

## REST vs WSS responsibility

```text
REST = initial snapshot, catalog, history, ALL writes
WSS  = incremental public market updates
```

Order placement, cancellation, fund transfers, and signed actions stay on
REST endpoints (e.g. `POST /markets/hyperliquid/order`). The WS path is for
data delivery only. This prevents accidental duplicate execution.

## Reconnect + backpressure policy

- **Coalesce.** Ticker events flow through a 100ms last-write-wins coalescer
  per topic. Candles / books / trades skip coalesce.
- **Cache.** The hub stores the last event per topic. New subscribers get
  the cached snapshot immediately (no wait for the next upstream tick).
- **Breaker.** Per-venue circuit breaker trips at 5 errors in 30s (base
  cooldown 30s, cap 5min).
- **Reconnect.** Exponential backoff 1s → 2s → 4s → 8s → 16s → 30s cap.
  Resets on a successful open. The hub resubscribes every active topic
  after reconnect.
- **Stale fallback.** During breaker-open, the venue's `snapshot(topic)`
  REST path keeps data flowing with `stale: true`.
- **Backpressure.** Each downstream socket has a bounded write queue. Slow
  consumers are bounded and closed; control/error messages are never
  dropped, only market ticks.
- **Per-client caps.** `REALTIME_MAX_TOPICS_PER_CLIENT` (default 200) and
  `REALTIME_MAX_MSGS_PER_SEC` (default 50).

## Smoke

Run the end-to-end check:

```bash
pnpm --filter @nexa/api smoke:wss
```

Expects: `pnpm --filter @nexa/api dev` is running locally with
`REALTIME_HUB_V1=1` and `DEMO_MODE=true`. The script mints a demo
session, opens `ws://localhost:8090/ws/markets`, subscribes to
`ticker:hl:BTC`, validates one envelope through `FeedEventZ`, then
unsubscribes and closes. Exit 0 on success.

For remote validation, see [RUNBOOK.md](../RUNBOOK.md) "WSS smoke".

## NEO usage

`@nexa/realtime-client/react` exports `useTicker`, `useCandle`,
`useOrderbook`, `useTrades`. Hooks are ref-counted: ten components
calling `useTicker('hl', 'BTC')` share one server subscription.
`MarketChartProV2` uses `useLiveCandleSource` to merge live candle
events into the static history.

## MAZE usage

MAZE (vanilla JS at [`apps/web/src/app-main.ts`](../apps/web/src/app-main.ts))
uses `WsTransport` directly when `VITE_REALTIME_HUB_ENABLED` is `1` or
`true`. It mints `/v1/stream/ticket`, connects to `/ws/markets`, and
ref-counts ticker, candle, and Polymarket outcome topics inside the page-level
binding.

```ts
import { WsTransport, tickerTopic } from '@nexa/realtime-client';

const rt = new WsTransport({
  baseUrl: '/api',
  path: '/ws/markets',
  mintTicket,
  topics: [tickerTopic('hl', 'BTC')],
  onEvent: (event) => { /* mutate the active row/chart */ },
});
```

User-state polling (HL positions, `/ledger/me` sync) stays on its existing
`setInterval` path until a user-streams sprint adds `userFills` / `orderUpdates`.

## Costs (this phase)
Free / already in deps:

- Hyperliquid public WS
- Polymarket public market WS
- `@nktkas/hyperliquid` (MIT, already installed)
- `ws` (already pinned via pnpm override)
- Existing NEXA API process, Caddy, Prometheus

No new paid provider was added.

## Deferred (explicit non-goals this sprint)

- Walletscope / whales / mentions / pulse
- Polymarket sports / RTDS / authenticated user channel
- Hyperliquid user-specific WS (`userFills`, `orderUpdates`, `openOrders`)
- Jupiter realtime adapter — memes tab stays on `refreshJupPrices` polling
- Sports / cards realtime adapters
- MAZE HL positions / ledger sync WS migration
- Redis pub/sub fan-out across pods
- Separate realtime microservice
- Hyperunit deposit/withdraw integration
- Paid equity feeds (Pyth equities trial expires; renewal is a separate ADR)

## Vendor references

- Hyperliquid WS: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- Hyperliquid subscriptions: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- Hyperliquid timeouts/heartbeats: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats
- `@nktkas/hyperliquid`: https://github.com/nktkas/hyperliquid
- Polymarket WS overview: https://docs.polymarket.com/market-data/websocket/overview
- Polymarket market channel: https://docs.polymarket.com/market-data/websocket/market-channel
- Polymarket user channel (deferred): https://docs.polymarket.com/market-data/websocket/user-channel

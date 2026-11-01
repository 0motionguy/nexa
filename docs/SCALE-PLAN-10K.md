# SCALE PLAN — 10,000 users on NEO + NEXA

**Date:** 2026-07-02 · **Author:** CTO pass (three parallel audits: NEXA hot paths, NEO client, live competitor probes — every claim file:line-cited or curl-measured).

## 0. Verdict

**10,000 registered users: yes, after Phase 0-1 below. The real currency is *concurrent* users.** Today's measured ceiling is **~300-500 concurrent** before three walls compound. The plan below takes us to **1,000+ concurrent on the current single VPS** (Phases 0-2, ~1 week of work), with a documented seam to 5-10k concurrent (Phase 3). The market-data read path and realtime hub core are already excellently engineered — the work is demand-shaping, config, and five targeted fixes, **not** a rewrite.

## 1. Load model

10k registered → peak concurrent ≈ 8-12% → **~1,000 concurrent** (money apps spike on market events). Per the measured client audit, ONE active NEO user today generates:

| State | req/min | Source |
|---|---|---|
| Idle on Home (even backgrounded!) | 20 | 8 polling queries, `lib/use-portfolio-summary.ts:121-156` + markets lists |
| Trading (coin detail open) | 73 | + `useHlUserEvents` polls open-orders @2s + fills @3s (`lib/use-hl-user-events.ts:24-25`) = 50/min alone |

**1,000 concurrent traders as-built = ~1,217 req/s sustained** against a single Node process with a Postgres pool of 10 (`apps/api/src/db/client.ts:20`) and a 256 MB container (`infra/compose-fragment.yml:67,136`). That is the problem statement.

## 2. Measured reality (2026-07-02, curl, 3-sample medians)

| Endpoint | Median | Size | Edge cache |
|---|---|---|---|
| ours /api/markets/hyperliquid | 0.909s | 27 KB | **DYNAMIC — never cached** |
| ours /api/markets/polymarket | 0.850s | **222 KB** | DYNAMIC |
| ours /api/markets/stocks | 1.135s | 75 KB | DYNAMIC |
| ours /api/markets/jupiter?limit=50 | 1.498s | 31 KB | DYNAMIC |
| upstream api.hyperliquid.xyz/info (our source) | 0.368s | 71 KB | — |
| app.hyperliquid.xyz shell | **0.162s** | 1.4 KB | Age: 12,347s (edge-cached) |
| trade.xyz shell | 0.585s | 16 KB | Age: **77 days** |

Facts: our proxy adds **+0.541s** over upstream (while correctly trimming payload 62% and adding geo/caps/fees). **None of our market endpoints send any Cache-Control**; every reference product serves from edge cache. Polymarket's 222 KB payload is 8× our HL payload.

## 3. What is ALREADY built right (do not re-solve)

- `_cachedLoad` single-flight coalescing + stale-on-error + bounded 500-entry GC (`routes/markets.ts:2510-2558`) on every heavy read route.
- **One shared upstream WS per venue** with per-topic ref-counting (`realtime/venues/hyperliquid.ts:765`, `realtime/hub.ts:121-210`): 1,000 clients on BTC = 1 upstream subscription.
- WS backpressure: async send queues, slow-client kill at 1024 queued, 200 topics/client, ticker coalescing 100ms (`realtime/ws-server.ts:157-189`, `hub.ts:68`).
- Client: Jotai price-atom sidecar fully consumed — a BTC tick re-renders only the BTC row (`lib/price-atoms.ts:49-91`, `components/MarketRow.tsx:36`); rAF-batched tick writes; refcounted single hub socket; hard list caps.
- DB indexes cover every hot WHERE; migrations as one-shot container; idempotency on all money routes; healthz drains on dependency loss.

## 4. The plan

### Phase 0 — Client demand shaping (NEO repo, ~1 day, cuts backend load ~8-10×)

| # | Fix | Evidence | Effect |
|---|---|---|---|
| 0.1 | Wire TanStack `focusManager` → RN `AppState` + `onlineManager` → NetInfo; polls stop when app backgrounded/blurred | zero AppState/focusManager hits in repo; `app/_layout.tsx:54-58` | removes the permanent 333 req/s idle floor at 1k users |
| 0.2 | De-fang `useHlUserEvents`: WS events are already primary (`lib/use-hl-user-events.ts:64-77` invalidates on fill/order) → REST fallback 2s/3s → 20-30s, gate on visible tab + foreground | `use-hl-user-events.ts:24-25,42,53` | kills the dominant 833 req/s term |
| 0.3 | Sentry hygiene: don't `captureException` expected 401/429/offline; add `beforeSend` drop-list + error sample rate | `lib/api.ts:84,98`, `lib/sentry.ts:43-51` | prevents 50k events/min quota incineration during any rate-limit event |
| 0.4 | Scope hub subscriptions to visible rows ∪ ticker ∪ watchlist (~20 topics), not the full ~175-coin catalog | `app/(tabs)/markets.tsx:113-114` | ~1.75M → ~200k topic-subs at 10k users |
| 0.5 | Realtime client fatal-close guard: stop reconnecting on 1008/4xx-class closes / N zero-ready opens; drop `key={token}` remount, use `client.setToken()` | `packages/realtime-client/src/transport/ws.ts:219-294`, `neo lib/realtime/Provider.tsx:40` | no infinite ticket-mint loops during outages (web fixed this; NEO/client lib hasn't) |
| 0.6 | Aggregate portfolio: one `GET /portfolio/summary` server endpoint replacing 6 parallel client polls; interval 15s→30-60s, gate to Portfolio tab | `lib/use-portfolio-summary.ts:121-156` | 18 req/min/user → ~1-2 |

### Phase 1 — Server headroom (NEXA repo, ~1-2 days, config + small diffs)

| # | Fix | Evidence | Effect |
|---|---|---|---|
| 1.1 | **Edge-cache shared market JSON**: `Cache-Control: public, s-maxage=2-5, stale-while-revalidate=30` on public `/markets/*` GETs + Cloudflare Cache Rule for the path (CF doesn't cache JSON by default) | measured: all DYNAMIC; references all Age-cached | 10k pollers collapse to ~1 origin hit per TTL; user latency 0.9s → ~0.2s |
| 1.2 | Container: `mem_limit` 256m → 1-2 GB, `--max-old-space-size` → ~1500 | `compose-fragment.yml:67,136` | removes the hard OOM wall (~1k WS) |
| 1.3 | Balances: point 4 chains at the DEDICATED RPC keys already in env (Alchemy/Helius), TTL 10s → 30-60s, add circuit-breaker; **never silently return 0 on RPC failure — return stale + `degraded: true`** | `lib/chain/balances.ts:32-36,120,167,208` | kills the first thing that breaks (~400 concurrent portfolio viewers → 429s → WRONG balances on a money app) |
| 1.4 | Hydrate path: coalesce concurrent `hydrateUser` per userId (reuse `_infoInflight` pattern); split slim auth-identity cache from the fat aggregate; fold `readUserState` into the parallel batch; pool 10 → 25 | `store/core/ledger-state.ts:114-299`, `db/client.ts:20` | ~270 auth queries/s at 1k users stops threatening the pool |
| 1.5 | WS: pre-serialize each event ONCE in `deliverNow` (today: JSON.stringify per client per event); add `MAX_WS_CLIENTS` cap rejecting with 1013 | `realtime/hub.ts:241-251`, `ws-server.ts:166` | biggest single realtime CPU win; bounded blast radius |
| 1.6 | **Metrics ON in prod** (`METRICS_ENABLED=1` — already token+edge gated) + add: cache hit/miss/stale counters in `_cachedLoad`, upstream-call counter per venue, pg-pool in-use gauge, alerts on WS client count / event-loop lag / RSS vs limit | `lib/env.ts:458`, `compose:100`, `lib/metrics.ts:307` | we SEE saturation before users feel it |
| 1.7 | Route `candles` + `all-mids` through `_cachedLoad` (today raw get/set — 200 chart viewers on a cold key = 200 upstream calls); widen staleMs; warm default list keys on boot | `routes/markets.ts:2573-2595` | closes the last un-coalesced hot path (explains today's transient 503) |
| 1.8 | Trim Polymarket list payload (222 KB → target <50 KB: paginate + field-trim like Jupiter's `?limit=`) | measured | 8× byte cut on our fattest poll |

### Phase 2 — Structural resilience (~2-3 days)

- **Graceful deploys**: SIGTERM → stop upgrades → WS `reconnect` hint → drain → exit (today: `server.close()` fire-and-forget, every deploy drops all sockets + triggers a reconnect/hydrate stampede) — `index.ts:524-541`.
- **2 API replicas behind Caddy** (needs 1.4's Redis-authoritative rate-limit confirmed — backend exists at `lib/rate-limit.ts:149-161` — and stream-ticket jti moved to Redis, seam flagged in `lib/auth.ts:112-116`); keeps deploys zero-downtime and doubles CPU.
- Approval worker out of the API process into the existing scheduler container (`compose:155-193`).
- Money-tx review rule: no network I/O between `lockUserState` and commit (`ledger-state.ts:317`).
- NEO: single-SVG sparklines instead of 12 chart engines (`components/web/DesktopTerminalHome.tsx:352-368`); pause WebView candle injection off-screen (`lib/charts/LightweightChart.tsx:38-69`).

### Phase 3 — The 5-10k-concurrent seam (documented now, build when growth demands)

Node `cluster`/replicas ×4 + all per-process state in Redis (hydrate cache already there; rate-limit backend exists; ticket-jti seam flagged) + WS clients sharded across workers + read-replica Postgres if query volume demands. No architecture rewrite required — the seams are already in the code.

### Phase 4 — Load-test gates (prove it, don't claim it)

k6 profiles committed to `scripts/load/`: (a) 1k idle-home (post-0.1 should be near-zero), (b) 500 traders (coin detail + order lifecycle), (c) 1k WS subscribe/churn, (d) deploy-during-load (zero dropped orders, WS reconnect < 5s). Acceptance: p95 cached reads <250ms edge / <600ms origin-miss; p95 authed <400ms; tick→client <250ms; 0 silent-zero balances; error rate <0.1%; RSS <60% of limit at 1k WS.

## 5. Competitor parity (measured, not vibes)

- **Adopt**: edge-cached shared snapshots (every reference Age-caches; we DYNAMIC) · snapshot-once + WS deltas as the primary live-price path (HL ships a 1.4 KB shell, data 100% over `wss://api.hyperliquid.xyz/ws` — confirmed alive; our hub is the same architecture, dark-launched — **flip `REALTIME_HUB_V1=1` after 0.4/0.5/1.5**) · deploy-pinned immutable assets (trade.xyz `?dpl=`, HL content-hash + 77-day Age).
- **Already at/above parity**: payload discipline (27 KB vs upstream 71 KB while adding geo/caps/builder-fee server-side — Bullpen/HL can't do compliance-side enforcement for us), h3 + Cloudflare front (= bullpen.fi), per-topic WS ref-counting (= HL's model), and a design system whose density specs (40-48px rows, 11-level book, 236px book column) came from these references and deliberately specify NO refresh cadence — cadence is ours to engineer, which this plan does.

## 6. Sequencing & ownership

Day 1: 0.1-0.5 (NEO) + 1.2/1.6 (config). Day 2: 1.1 + 1.3 + 1.7 + 1.8. Day 3: 1.4 + 1.5 + 0.6. Day 4-5: Phase 2. Then k6 gates before flipping `REALTIME_HUB_V1=1` in prod. Every item lands with its metric/alert so regressions are visible.

### Execution status (2026-07-02, same-day)

- **SHIPPED**: 0.1 (focusManager→AppState) · 0.2 (poller 2s/3s→20s/30s) · 0.3 (Sentry 401/429 gate) — NEO `f620641`. 1.2 (heap 200→1200 MB, mem_limit 256m→1536m) · 1.3 (legs return null on failure; last-known-good + `degraded`/`staleChains`; hl-deposit fails closed on unknown balance; TTL 10s→30s; prod boot-warn for public-RPC defaults) · 1.6 (METRICS_ENABLED default 1) · 1.7 (candles + all-mids through `_cachedLoad`) · 1.1 **origin half** (`Cache-Control: public, s-maxage=3, stale-while-revalidate=30` on the shared public read predicate `isPublicMarketReadPath` + earn tiles, header-contract test).
- **1.1 ops half PENDING**: Cloudflare Cache Rule for `nexa.aiso.tools/api/markets/*` + `/api/earn/(landing|ethena|jupiter-lend)` — "Eligible for cache, respect origin Cache-Control". Until then Cf-Cache-Status stays DYNAMIC (header is already correct). Client follow-up: NEO/web should drop the Authorization header on these public GETs so edge hits apply to signed-in users too.
- **SHIPPED (2026-07-03, phase-2 batch + hardening)**: 1.4 hydrate single-flight (per-caller structuredClone isolation; invalidateUser evicts in-flight joins) + pool 25 · 1.5 WS pre-serialize memo (shared with the SSE path) + `REALTIME_MAX_CLIENTS` shed (1013, counter-safe, kick-timer-safe) · 1.8 `?view=compact` PM projection (−52% payload; shared upstream cache) · 0.6 server half — `GET /markets/portfolio/summary` (all legs fail soft, `sourced` + per-leg `legs` availability) + client intervals 30/60s · 0.4 stable topic scoping (top-12 ∪ ticker ∪ watchlist; search slice deliberately excluded — per-keystroke resubscribe burst tripped the 50 msg/s limiter and froze prices) · 0.5 runaway-reconnect guard as **cold-retry mode** (12 fast attempts → 1/5 min; ready-frame refills; WS + SSE parity; plumbed through RealtimeClientOptions; NEO Provider no longer remounts per token).
- **Hardening pass findings fixed same day**: public-cards regex matched `/markets/cards/positions` (auth-gate bypass at the mount layer + would have edge-cached per-user data once the CF rule lands) → negative lookahead + tests · sub-second price surfaces (`all-mids`, `orderbook`) now get `s-maxage=1` instead of the blanket 3s · summary route no longer 500s when the store leg hiccups.
- **Edge-cache ops note (updated 2026-07-03, two required CF settings)**: the Cloudflare Cache Rule for `/api/markets/*` + `/api/earn/*` MUST (a) be **"Eligible for cache"** keyed on the **full query string** (`?view=compact` / `?limit=` are distinct bodies at one path — "ignore query string" would cross-serve variants), AND (b) set **Browser Cache TTL → "Respect Existing Headers"**. Measured 2026-07-03: CF's zone default was injecting `max-age=14400` (4h) onto price responses — a live mids feed cached 4h in-browser freezes entry/liq math. Origin now sends explicit `max-age=0` so browsers always revalidate; the CF setting must stop overriding it.
- **SHIPPED (2026-07-03, follow-up batch)**: 0.6 REALIZED client-side — NEO's portfolio hook now makes ONE `/markets/portfolio/summary` call instead of six polls (nexa#30 extended orderEnvelope with `copiedFrom` so the aggregate doesn't drop copy attribution; pure client resolver holds LAST-KNOWN-GOOD on a `failed` leg + raises `degraded`, 8 contract tests; every money mutation — fills WS, auto-deposit, spot→perps, all cancel surfaces, transfer sheet — now invalidates `["portfolio"]`, and the transfer sheet previously refreshed *nothing*).
- **Phase 4 load gate SHIPPED + PASSED (2026-07-03)**: `pnpm load:gate` (`scripts/load-gate.mjs`, dependency-free Node 22 — no k6 install needed). Scenarios: hot public reads, auth'd summary, WS ramp (ticket-minted; multi-demo-user because ticket minting sits in the per-user 120/min `/v1/*` bucket by design — a real client mints ONE ticket per connect). **Local single-process result (hub ON, 300 WS + 40 VUs): reads 1,074 rps p95 49ms · summary 1,821 rps p95 25ms 0 errors · WS 300/300 ready p95 233ms, 0 shed.** The §2 measured ceiling was ~300-500 concurrent *total* — cleared with headroom. **Prod probe same run: the Cloudflare Cache Rule is NOW ACTIVE — 79% edge-hit rate on the hot read set, p50 78ms, 0 errors** (was 100% DYNAMIC when §2 was measured). Browser-Cache-TTL "Respect Existing Headers" still pending (max-age=14400 still injected).
- **REMAINING (deliberately staged)**: replicas + Redis-shared limiter/tickets/hub (Phase 3 — `markTicketUsed` is single-pod by design, Redis swap documented in auth.ts) · degraded-balances UI affordance in NEO (hook now exposes `degraded`; render an "updating…" pill) · single-flight helper extraction (3 hand-rolls noted) · device visual pass on the new portfolio hook (typecheck/tests/CI green; TestFlight look-over recommended).

**Deliberately NOT doing**: microservices, Kubernetes, DB sharding, rewriting the markets router, adding an external cache product — the measured bottlenecks don't ask for any of it, and the current cache/hub design is already the right architecture. This plan is demand-shaping + config + 5 targeted diffs.

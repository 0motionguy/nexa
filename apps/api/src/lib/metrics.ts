/**
 * Prometheus instruments. Idempotent: re-importing the module returns the
 * same registered metrics, so vitest module-resets and dev HMR don't crash
 * on "metric already registered" errors.
 *
 * Cardinality: the HTTP histogram labels by `route` (the Hono templated
 * path from `c.req.routePath`, e.g. `/offers/:id`), never `c.req.path`,
 * because the literal URL has unbounded cardinality from offer/claim ids.
 *
 * Endpoint exposure: index.ts mounts `GET /metrics` gated on
 * `features.metrics && Authorization: Bearer ${METRICS_TOKEN}`. The Caddy
 * edge config also blocks `/metrics` as belt-and-braces — the route is the
 * second line of defense, not the only one.
 *
 * Default Node metrics (event loop lag, GC, RSS) are collected only when
 * METRICS_ENABLED, so demo runs don't pay the sampling cost.
 */

import {
  register,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
  type Registry,
} from 'prom-client';
import { features } from './env.js';

/**
 * Lookup-or-create helper. Re-imports of this module (vitest, dev) get the
 * same instrument back instead of throwing. Casts are tight: prom-client's
 * `getSingleMetric` returns a base `Metric` but the lookup key is unique by
 * type so the cast is safe.
 */
function existing<T>(name: string): T | undefined {
  return register.getSingleMetric(name) as T | undefined;
}

if (features.metrics && !existing('process_cpu_user_seconds_total')) {
  collectDefaultMetrics({ register });
}

/* ── HTTP duration histogram (labels: method, route, status) ─────────────── */
export const httpRequestDuration: Histogram<string> =
  existing<Histogram<string>>('http_request_duration_seconds') ??
  new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

/* ── domain counters ─────────────────────────────────────────────────────── */

export const paymentsCreated: Counter<string> =
  existing<Counter<string>>('payments_created_total') ??
  new Counter({
    name: 'payments_created_total',
    help: 'Payments created (offer paid, fresh path)',
    labelNames: [] as const,
  });

export const paymentsPaid: Counter<string> =
  existing<Counter<string>>('payments_paid_total') ??
  new Counter({
    name: 'payments_paid_total',
    help: 'Payments marked paid',
    labelNames: [] as const,
  });

export const paymentsFailed: Counter<string> =
  existing<Counter<string>>('payments_failed_total') ??
  new Counter({
    name: 'payments_failed_total',
    help: 'Payments that failed (policy error or upstream)',
    labelNames: ['reason'] as const,
  });

export const claimsCreated: Counter<string> =
  existing<Counter<string>>('claims_created_total') ??
  new Counter({
    name: 'claims_created_total',
    help: 'Email-claim escrows opened',
    labelNames: [] as const,
  });

export const claimsClaimed: Counter<string> =
  existing<Counter<string>>('claims_claimed_total') ??
  new Counter({
    name: 'claims_claimed_total',
    help: 'Email-claim escrows redeemed by the recipient',
    labelNames: [] as const,
  });

export const claimsExpired: Counter<string> =
  existing<Counter<string>>('claims_expired_total') ??
  new Counter({
    name: 'claims_expired_total',
    help: 'Email-claim escrows expired by the daily sweeper (refunded to sender)',
    labelNames: [] as const,
  });

export const earnDeposit: Counter<string> =
  existing<Counter<string>>('earn_deposit_total') ??
  new Counter({
    name: 'earn_deposit_total',
    help: 'Earn deposits routed to a vault adapter',
    labelNames: ['adapter'] as const,
  });

export const earnWithdraw: Counter<string> =
  existing<Counter<string>>('earn_withdraw_total') ??
  new Counter({
    name: 'earn_withdraw_total',
    help: 'Earn withdrawals from a vault adapter',
    labelNames: ['adapter'] as const,
  });

export const mcpRequests: Counter<string> =
  existing<Counter<string>>('mcp_requests_total') ??
  new Counter({
    name: 'mcp_requests_total',
    help: 'MCP tool invocations over Streamable HTTP',
    labelNames: ['method'] as const,
  });

export const x402Settlements: Counter<string> =
  existing<Counter<string>>('x402_settlements_total') ??
  new Counter({
    name: 'x402_settlements_total',
    help: 'x402 settlement attempts (success vs failure)',
    labelNames: ['result'] as const,
  });

export const marketsOrders: Counter<string> =
  existing<Counter<string>>('markets_orders_total') ??
  new Counter({
    name: 'markets_orders_total',
    help: 'Market order POSTs (Hyperliquid + Polymarket) bucketed by outcome',
    labelNames: ['venue', 'result'] as const,
  });

/**
 * F093 Sprint 18 router-v2 observability. Two bounded-cardinality
 * instruments give us:
 *   - per-version request counts (canary rollout truth: how many orders
 *     went through v1 vs v2 today, by venue, by outcome)
 *   - per-version latency distribution (regression detector: did the
 *     parameterised v2 handler get slower than the legacy v1 body?)
 *
 * Label cardinality is finite by design:
 *   version ∈ {v1, v2}
 *   venue   ∈ {hyperliquid, hyperliquid-spot, hyperliquid-hip3,
 *              jupiter, polymarket, xstocks}
 *   result  ∈ {success, parse_error, gate_blocked, venue_error,
 *              preflight_error, idempotency_replay}
 *
 * No payloads, user ids, order ids, or symbols enter labels. The v2
 * handler emits these alongside the existing `markets_orders_total`
 * counter so dashboards can A/B v1 vs v2 without changing the legacy
 * surface.
 */
export const marketRouterRequests: Counter<string> =
  existing<Counter<string>>('market_router_requests_total') ??
  new Counter({
    name: 'market_router_requests_total',
    help: 'Market order routing requests by router version + venue + outcome',
    labelNames: ['version', 'venue', 'result'] as const,
  });

export const marketRouterDuration: Histogram<string> =
  existing<Histogram<string>>('market_router_duration_seconds') ??
  new Histogram({
    name: 'market_router_duration_seconds',
    help: 'Market order routing duration in seconds, by version + venue',
    labelNames: ['version', 'venue'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

/**
 * NEXA platform-fee tracker (best-effort revenue counter). Labels:
 *   venue = 'hyperliquid' | 'hyperliquid-spot' | 'hyperliquid-hip3' | 'jupiter' | 'polymarket' | 'xstocks'
 *   kind  = 'builder' (HL builder rebate) | 'platform' (Jupiter platformFeeBps) | 'spread' (manual markup)
 *
 * `fees_earned_usd_total` is a Counter (monotonic-increase USD totals).
 * Use `rate(fees_earned_usd_total[1d])` in Grafana for daily revenue.
 * `fees_attempted_total` counts every order we tried to collect on,
 * regardless of fill — useful for catching mis-configured fee accounts.
 */
export const feesEarnedUsd: Counter<string> =
  existing<Counter<string>>('fees_earned_usd_total') ??
  new Counter({
    name: 'fees_earned_usd_total',
    help: 'Cumulative USD of platform/builder fees earned, by venue + kind',
    labelNames: ['venue', 'kind'] as const,
  });

export const feesAttempted: Counter<string> =
  existing<Counter<string>>('fees_attempted_total') ??
  new Counter({
    name: 'fees_attempted_total',
    help: 'Order count where a fee was wired into the action (success or not)',
    labelNames: ['venue', 'kind'] as const,
  });

export const campaignPayouts: Counter<string> =
  existing<Counter<string>>('campaign_payouts_total') ??
  new Counter({
    name: 'campaign_payouts_total',
    help: 'Creator campaign bonuses released by an admin (per-tier breakdown)',
    labelNames: ['tier'] as const,
  });

/**
 * Sprint 13 COMMIT 7 (C9) — chain-mirror failure counter. The mirror is
 * best-effort and swallows errors so the ledger move keeps; this counter is
 * how operators see whether the chain-side has gone silent. Labels:
 *   op   = 'deposit' | 'withdraw'
 *   tier = 'standard' | 'higher_yield' | 'unset'
 * Alerts on rate (rule lives in infra/prometheus/alerts.yml).
 */
export const chainMirrorFailures: Counter<string> =
  existing<Counter<string>>('chain_mirror_failures_total') ??
  new Counter({
    name: 'chain_mirror_failures_total',
    help: 'Chain-mirror earn deposit/withdraw failures (ledger move kept)',
    labelNames: ['op', 'tier'] as const,
  });

/* ── HTTP error counter (F058 — alert-on-rate primitive) ─────────────────── */

/**
 * Bucketed counter of 4xx + 5xx responses. labels intentionally use the
 * Hono templated `route` (e.g. `/offers/:id`), not the literal URL, so
 * cardinality stays bounded. Incremented from lib/errors.ts errorHandler.
 */
export const httpErrors: Counter<string> =
  existing<Counter<string>>('http_errors_total') ??
  new Counter({
    name: 'http_errors_total',
    help: 'HTTP error responses (4xx + 5xx) bucketed by method, route, status',
    labelNames: ['method', 'route', 'status'] as const,
  });

/* ── gauges ──────────────────────────────────────────────────────────────── */

export const bullmqQueueDepth: Gauge<string> =
  existing<Gauge<string>>('bullmq_queue_depth') ??
  new Gauge({
    name: 'bullmq_queue_depth',
    help: 'Job counts per BullMQ queue and state (waiting, active, delayed, failed)',
    labelNames: ['queue', 'state'] as const,
  });

/**
 * F056 — per-worker liveness gauge. Each worker bumps to `Date.now() / 1000`
 * on every successful iteration (cron tick or job completion). Operators
 * alert on `time() - worker_heartbeat_seconds{worker="X"} > N` to catch
 * silent hangs that don't throw and so produce no error signal.
 *
 * Known worker labels: claim-sweep, subscription-renewer, digest-sender,
 * approvals, scheduler.
 */
export const workerHeartbeat: Gauge<string> =
  existing<Gauge<string>>('worker_heartbeat_seconds') ??
  new Gauge({
    name: 'worker_heartbeat_seconds',
    help: 'Unix timestamp of the last successful iteration per worker',
    labelNames: ['worker'] as const,
  });

/**
 * F095 Sprint 18 — Per-state bridge-transfer count. Lets operators answer
 * "how many transfers are stuck in `created` / `attesting` right now?" from
 * Grafana instead of an ad-hoc SQL query against the prod DB.
 *
 * Cardinality is bounded: 8 statuses × 6 rails × 5 buckets = 240 labels max.
 * In practice ~30-50 active labels — the rest stay at 0.
 *
 * Refresh: the bridge worker's scheduler updates this gauge on boot and every
 * 30s thereafter via `refreshBridgeTransferGauge()` in workers/bridge-worker.ts.
 */
export const bridgeTransfersByStatus: Gauge<string> =
  existing<Gauge<string>>('bridge_transfers_by_status') ??
  new Gauge({
    name: 'bridge_transfers_by_status',
    help: 'Count of nb_transfers rows by status / rail / destination bucket',
    labelNames: ['status', 'rail', 'bucket'] as const,
  });

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Observe one HTTP request on the histogram. Skips the /metrics path itself
 * so scraping doesn't pollute its own duration.
 *
 * route — pass `c.req.routePath` (the templated Hono pattern such as
 * `/offers/:id`), NOT `c.req.path` (the literal URL); the latter blows out
 * cardinality.
 */
export function recordHttpDuration(
  method: string,
  route: string,
  status: number,
  durationMs: number,
): void {
  if (!features.metrics) return;
  if (route === '/metrics') return;
  httpRequestDuration.observe(
    { method, route, status: String(status) },
    durationMs / 1000,
  );
}

/** Expose the shared registry for the /metrics endpoint + tests. */
export function getRegistry(): Registry {
  return register;
}

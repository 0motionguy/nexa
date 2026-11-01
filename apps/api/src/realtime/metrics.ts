/**
 * Realtime hub Prometheus instruments. Same idempotent `existing()` pattern
 * as `lib/metrics.ts` — re-import safe under vitest module reset + dev HMR.
 *
 * Cardinality budget:
 *   venue ∈ VenueTag (7 values)
 *   topic_kind ∈ {ticker, candle, book, trades, stock, meme, predictions}
 *   reason / result ∈ small string enums per metric
 *
 * No user ids, no symbols, no order ids in labels.
 */

import { register, Counter, Gauge, Histogram } from 'prom-client';

function existing<T>(name: string): T | undefined {
  return register.getSingleMetric(name) as T | undefined;
}

/* ── freshness ────────────────────────────────────────────────────────────── */

export const feedTickLagMs: Histogram<string> =
  existing<Histogram<string>>('feed_tick_lag_ms') ??
  new Histogram({
    name: 'feed_tick_lag_ms',
    help: 'Tick lag at the moment the hub forwarded an upstream event to clients',
    labelNames: ['venue', 'topic_kind'] as const,
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  });

export const snapshotFillDurationMs: Histogram<string> =
  existing<Histogram<string>>('snapshot_fill_duration_ms') ??
  new Histogram({
    name: 'snapshot_fill_duration_ms',
    help: 'Wall-clock ms for a venue REST snapshot fill (cold-start / reconnect)',
    labelNames: ['venue'] as const,
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  });

/* ── stability ────────────────────────────────────────────────────────────── */

export const feedDisconnectTotal: Counter<string> =
  existing<Counter<string>>('feed_disconnect_total') ??
  new Counter({
    name: 'feed_disconnect_total',
    help: 'Upstream WS disconnects per venue, bucketed by reason',
    labelNames: ['venue', 'reason'] as const,
  });

export const feedReconnectAttemptsTotal: Counter<string> =
  existing<Counter<string>>('feed_reconnect_attempts_total') ??
  new Counter({
    name: 'feed_reconnect_attempts_total',
    help: 'Upstream WS reconnect attempts per venue',
    labelNames: ['venue'] as const,
  });

/* ── capacity (HANDOVER-2026-07-19-RPC-PARITY) ────────────────────────────── */

/** reason ∈ {backpressure, capacity, user_capacity, ip_capacity} */
export const realtimeCapacityShedsTotal: Counter<string> =
  existing<Counter<string>>('realtime_capacity_sheds_total') ??
  new Counter({
    name: 'realtime_capacity_sheds_total',
    help: 'Client connections shed with 1013, bucketed by exhausted budget',
    labelNames: ['reason'] as const,
  });

/** reason ∈ {user_superseded} */
export const realtimeEvictionsTotal: Counter<string> =
  existing<Counter<string>>('realtime_evictions_total') ??
  new Counter({
    name: 'realtime_evictions_total',
    help: 'Live connections reaped to admit a newer one (newest-wins budgets)',
    labelNames: ['reason'] as const,
  });

export const feedBreakerState: Gauge<string> =
  existing<Gauge<string>>('feed_breaker_state') ??
  new Gauge({
    name: 'feed_breaker_state',
    help: 'Per-venue circuit breaker state: 0=closed, 1=half-open, 2=open',
    labelNames: ['venue'] as const,
  });

/* ── fan-out efficiency ───────────────────────────────────────────────────── */

export const feedSubscribersGauge: Gauge<string> =
  existing<Gauge<string>>('feed_subscribers_gauge') ??
  new Gauge({
    name: 'feed_subscribers_gauge',
    help: 'Active client-facing topic subscriptions per venue + topic_kind',
    labelNames: ['venue', 'topic_kind'] as const,
  });

export const hubFanoutRatio: Gauge<string> =
  existing<Gauge<string>>('hub_fanout_ratio') ??
  new Gauge({
    name: 'hub_fanout_ratio',
    help: 'client_subs / upstream_subs per venue — grows with users',
    labelNames: ['venue'] as const,
  });

export const hubMessagesInTotal: Counter<string> =
  existing<Counter<string>>('hub_messages_in_total') ??
  new Counter({
    name: 'hub_messages_in_total',
    help: 'Upstream events received by the hub',
    labelNames: ['venue', 'topic_kind'] as const,
  });

export const hubMessagesOutTotal: Counter<string> =
  existing<Counter<string>>('hub_messages_out_total') ??
  new Counter({
    name: 'hub_messages_out_total',
    help: 'Events delivered to client sinks (post-coalesce)',
    labelNames: ['venue', 'topic_kind'] as const,
  });

export const hubDroppedTotal: Counter<string> =
  existing<Counter<string>>('hub_dropped_total') ??
  new Counter({
    name: 'hub_dropped_total',
    help: 'Events / subs dropped, bucketed by reason',
    labelNames: ['venue', 'reason'] as const,
  });

/* ── capacity ─────────────────────────────────────────────────────────────── */

export const hubClientsGauge: Gauge<string> =
  existing<Gauge<string>>('hub_clients_gauge') ??
  new Gauge({
    name: 'hub_clients_gauge',
    help: 'Active WS+SSE clients connected to the hub',
    labelNames: [] as const,
  });

export const hubClientTopicsGauge: Gauge<string> =
  existing<Gauge<string>>('hub_client_topics_gauge') ??
  new Gauge({
    name: 'hub_client_topics_gauge',
    help: 'Sum of per-client topic counts (total active subscriptions across all clients)',
    labelNames: [] as const,
  });

/* ── auth ─────────────────────────────────────────────────────────────────── */

export const streamAuthFailuresTotal: Counter<string> =
  existing<Counter<string>>('stream_auth_failures_total') ??
  new Counter({
    name: 'stream_auth_failures_total',
    help: 'WS upgrade / SSE connect auth failures, bucketed by reason',
    labelNames: ['reason'] as const,
  });

/* ── lifecycle fan-out bus (WS-P0-2, wave 3) ─────────────────────────────────
 *
 * The shared Redis-stream bus that carries private order/fill/account
 * lifecycle events across API replicas + workers. `published` counts XADDs
 * that landed on the stream (any producer); `consumed` counts entries this
 * pod's tail consumer forwarded into its local hub; `dropped` buckets the
 * ones that didn't make it (publish failure, malformed entry, cross-pod
 * duplicate suppressed by the dedupe LRU, etc.). `lag_seconds` is now minus
 * the produced-at time of the last event this pod consumed — the cross-pod
 * delivery latency operators alert on. No user ids / order ids in labels. */

export const lifecycleEventsPublished: Counter<string> =
  existing<Counter<string>>('lifecycle_events_published_total') ??
  new Counter({
    name: 'lifecycle_events_published_total',
    help: 'Lifecycle events XADDed onto the shared Redis stream (any producer)',
    labelNames: [] as const,
  });

export const lifecycleEventsConsumed: Counter<string> =
  existing<Counter<string>>('lifecycle_events_consumed_total') ??
  new Counter({
    name: 'lifecycle_events_consumed_total',
    help: 'Lifecycle events forwarded from the stream into this pod local hub',
    labelNames: [] as const,
  });

export const lifecycleEventsDropped: Counter<string> =
  existing<Counter<string>>('lifecycle_events_dropped_total') ??
  new Counter({
    name: 'lifecycle_events_dropped_total',
    help: 'Lifecycle bus events not delivered, bucketed by reason',
    labelNames: ['reason'] as const,
  });

export const lifecycleConsumerLagSeconds: Gauge<string> =
  existing<Gauge<string>>('lifecycle_consumer_lag_seconds') ??
  new Gauge({
    name: 'lifecycle_consumer_lag_seconds',
    help: 'now - produced-at of the last lifecycle event this pod consumed',
    labelNames: [] as const,
  });

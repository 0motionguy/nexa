/**
 * lib/metrics.mjs — percentile math, certification GATES, and artifact
 * assembly for the 1k-user load-certification harness (audit blocker #11).
 *
 * GATES provenance — aligned to the certification plan's gate table
 * (audit bundle "03_LOAD_TEST_PLAN_100_TO_1000.md → Performance gates",
 * the authoritative staged-ladder spec this harness implements):
 *
 *   readErrorRatePct   <- plan "Overall read error rate <0.5%"
 *   readP95EdgeMs      <- plan "Public cached read p95 <250 ms"
 *   readP95OriginMs    <- plan "Public origin read p95 <600 ms"
 *   authedP95Ms        <- plan "Auth profile/balance p95 <750 ms"
 *   wsReadyRatePct     <- plan "Ready rate >=99%"
 *   wsReadyP95Ms       <- plan "Ready p95 <1,500 ms"
 *   eventLagP95Ms      <- plan "Market-event lag p95 <500 ms" (measured
 *        only on events whose ts is server emit time — see ws-client.mjs)
 *   eventLagP99Ms      <- plan "Market-event lag p99 <1,500 ms"
 *   unplannedDisconnectsPerHourMax
 *     <- plan "Unplanned disconnects <0.5%/hour" expressed as an absolute
 *        fleet budget (5/hour); counts SERVER-caused drops only —
 *        harness-injected flaky drops are excluded by design (they are
 *        reported separately as websocket.injectedDrops).
 *   crossUserPrivateEventsMax
 *     <- 0. Stated directly as a correctness invariant in the harness
 *        spec (an ACL leak is never acceptable at any rate), not a
 *        numeric citation.
 *
 * Every threshold below is overridable via CLI flags (see lib/args.mjs)
 * so a future run can supply the authoritative numbers without editing
 * this file.
 */

export const GATES = Object.freeze({
  readErrorRatePct: 0.5,
  readP95EdgeMs: 250,
  readP95OriginMs: 600,
  authedP95Ms: 750,
  // Portfolio summary fan-out aggregate — separate plan gate
  // (03_LOAD_TEST_PLAN: "Portfolio summary p95 <1,200 ms").
  portfolioP95Ms: 1200,
  wsReadyRatePct: 99,
  wsReadyP95Ms: 1500,
  eventLagP95Ms: 500,
  eventLagP99Ms: 1500,
  unplannedDisconnectsPerHourMax: 5,
  crossUserPrivateEventsMax: 0,
  // Correctness invariant, same class as crossUserPrivateEventsMax: an
  // idempotency-key replay that returns anything other than the exact
  // original response means the server double-processed a write.
  idempotencyReplayMismatchesMax: 0,
});

/** Floor below which unplannedDisconnectsPerHour is not evaluated — see
 * the comment at its call site in evaluateGates(). Matches GATE_PRESETS[0]
 * (smoke-25, 60s), the shortest real staged run. */
export const MIN_DURATION_FOR_DISCONNECT_RATE_GATE_SECONDS = 60;

/** Sorted-array percentile (nearest-rank, matches load-gate.mjs's `pct`). */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

/** Summarize a raw (unsorted) latency-sample array into count/p50/p95/p99. */
export function summarizeLatencies(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
  };
}

/** Summarize an HTTP family bucket: latencies + pass/fail counters. */
export function summarizeHttpFamily(samples, errors) {
  const lat = summarizeLatencies(samples);
  const total = lat.count;
  return {
    ...lat,
    errors,
    errorRatePct: total ? +((errors / total) * 100).toFixed(3) : 0,
  };
}

/**
 * Compute PASS/FAIL against GATES. Returns { result, failures }.
 * Any subsystem left `null` (database/redis/workers/apiReplicas/
 * schedulerReplicas — filled later from Prometheus snapshots or deploy
 * topology) is skipped, not treated as a failure: this harness cannot
 * observe server-side infra over plain HTTP/WS from the outside.
 */
export function evaluateGates(artifact, gates = GATES) {
  const failures = [];
  const http = artifact.http;
  if (http) {
    if (http.overall.errorRatePct >= gates.readErrorRatePct) {
      failures.push(`http overall error rate ${http.overall.errorRatePct}% >= ${gates.readErrorRatePct}%`);
    }
    if (http.edge.count && http.edge.p95 >= gates.readP95EdgeMs) {
      failures.push(`http edge-hit p95 ${http.edge.p95}ms >= ${gates.readP95EdgeMs}ms`);
    }
    if (http.originMiss.count && http.originMiss.p95 >= gates.readP95OriginMs) {
      failures.push(`http origin-miss p95 ${http.originMiss.p95}ms >= ${gates.readP95OriginMs}ms`);
    }
    const authed = http.byFamily?.authed;
    if (authed?.count && authed.p95 >= gates.authedP95Ms) {
      failures.push(`authed p95 ${authed.p95}ms >= ${gates.authedP95Ms}ms`);
    }
    const portfolio = http.byFamily?.portfolio;
    if (portfolio?.count && portfolio.p95 >= gates.portfolioP95Ms) {
      failures.push(`portfolio p95 ${portfolio.p95}ms >= ${gates.portfolioP95Ms}ms`);
    }
  }
  const ws = artifact.websocket;
  if (ws && ws.connections > 0) {
    if (ws.readyRatePct <= gates.wsReadyRatePct) {
      failures.push(`ws ready rate ${ws.readyRatePct}% <= ${gates.wsReadyRatePct}%`);
    }
    if (ws.readyP95Ms >= gates.wsReadyP95Ms) {
      failures.push(`ws ready p95 ${ws.readyP95Ms}ms >= ${gates.wsReadyP95Ms}ms`);
    }
    const lagSampleCount = ws.eventsLagSampled ?? ws.eventsReceived;
    if (lagSampleCount > 0) {
      if (ws.eventLagP95Ms >= gates.eventLagP95Ms) {
        failures.push(`ws event lag p95 ${ws.eventLagP95Ms}ms >= ${gates.eventLagP95Ms}ms`);
      }
      if (ws.eventLagP99Ms >= gates.eventLagP99Ms) {
        failures.push(`ws event lag p99 ${ws.eventLagP99Ms}ms >= ${gates.eventLagP99Ms}ms`);
      }
    }
    // Extrapolating a raw count to a per-hour rate is only meaningful once
    // the run has accumulated enough wall-clock time — below MIN_DURATION,
    // one incidental disconnect blows the rate up by 100-450x (e.g. a
    // single drop in an 8s run extrapolates to ~450/hour) even though the
    // same drop in a real 600s+ certification run barely moves the needle.
    // Gate 0 (smoke-25, 60s) is the shortest REAL staged run and still
    // gets evaluated; only sub-minute runs (self-test) skip this check.
    if (artifact.durationSeconds >= MIN_DURATION_FOR_DISCONNECT_RATE_GATE_SECONDS
      && ws.unplannedDisconnectsPerHour > gates.unplannedDisconnectsPerHourMax) {
      failures.push(`ws unplanned disconnects/hour ${ws.unplannedDisconnectsPerHour} > ${gates.unplannedDisconnectsPerHourMax}`);
    }
  }
  const correctness = artifact.correctness;
  if (correctness && correctness.crossUserPrivateEvents > gates.crossUserPrivateEventsMax) {
    failures.push(`cross_user_private_event count ${correctness.crossUserPrivateEvents} > ${gates.crossUserPrivateEventsMax}`);
  }
  if (correctness && correctness.idempotencyReplayMismatches > gates.idempotencyReplayMismatchesMax) {
    failures.push(`idempotency replay mismatch count ${correctness.idempotencyReplayMismatches} > ${gates.idempotencyReplayMismatchesMax}`);
  }
  return { result: failures.length ? 'FAIL' : 'PASS', failures };
}

/**
 * Assemble the final artifact in the exact shape required by the task
 * spec. `database`/`redis`/`workers` are null placeholders — this
 * harness is an external HTTP/WS client and cannot observe server-side
 * subsystem internals; a later step fills these from Prometheus
 * snapshots taken during the same run window. `apiReplicas` /
 * `schedulerReplicas` get the same treatment for the same reason
 * (deploy topology isn't visible over the wire) unless supplied via
 * --api-replicas / --scheduler-replicas by whoever runs the harness
 * against a staging stack with known topology.
 */
export function buildArtifact({
  neoSha,
  nexaSha,
  databaseMigrationCount,
  apiReplicas,
  schedulerReplicas,
  users,
  durationSeconds,
  http,
  websocket,
  correctness,
  gates,
}) {
  const artifact = {
    neoSha,
    nexaSha,
    databaseMigrationCount,
    apiReplicas,
    schedulerReplicas,
    users,
    durationSeconds,
    http,
    websocket,
    // Placeholders — see doc-comment above. Filled from Prometheus
    // snapshots of the staging stack during/after the run window.
    database: null,
    redis: null,
    workers: null,
    correctness,
    gatesApplied: gates,
  };
  const { result, failures } = evaluateGates(artifact, gates);
  artifact.result = result;
  artifact.failures = failures;
  return artifact;
}

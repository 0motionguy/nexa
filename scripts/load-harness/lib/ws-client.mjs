/**
 * lib/ws-client.mjs — per-VU WebSocket lifecycle: ticket mint, connect,
 * subscribe, event-lag capture, background/resume + flaky-reconnect
 * behavior, and the cross-user-private-event correctness probe.
 *
 * Protocol notes (verified against apps/api/src/realtime/ws-server.ts —
 * NOT copied from scripts/load-gate.mjs, which has a live bug: it sends
 * `{op:'subscribe', topics}` but the server's parseClientOp() only
 * recognizes `op:'sub'|'unsub'|'ping'`, so load-gate.mjs's subscribes
 * are silently dropped server-side and it never measures real event
 * delivery. This client sends the correct `op:'sub'`.):
 *   - upgrade requires ?token=<single-use ticket> (session JWTs in the
 *     URL are rejected)
 *   - server sends {op:'ready', accepted:[], serverVersion} immediately
 *     on open; topics are requested afterward via {op:'sub', topics}
 *   - capacity shed closes 1013; expired/invalid auth closes 1008
 *   - events carry {topic, ts, ...} but ts semantics differ by kind
 *     (verified in apps/api/src/realtime/venues/*): t:'tick' events and
 *     priv:* lifecycle envelopes stamp ts = server emit time (Date.now()
 *     at publish) -> delivery lag = Date.now() - ts is meaningful.
 *     t:'candle' events carry the VENUE bar-open time (tradingview.ts:
 *     ts = p.time * 1000 — minutes old for 15m/1h bars by design); that
 *     is data freshness (the server already reports it as lastTickAgeMs),
 *     NOT delivery lag, so those kinds are counted but excluded from lag
 *     sampling (stats.lagExcluded).
 */

import { buildTopicsForCohort, COHORT_WS_POLICY } from './cohorts.mjs';

const READY_TIMEOUT_MS = 10_000;
const CROSS_USER_SAMPLE_CAP = 20;

export async function mintTicket(base, token) {
  const res = await fetch(`${base}/v1/stream/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ticket mint failed: HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body?.token) throw new Error('ticket mint: response missing token field');
  return body.token;
}

/**
 * Classify a topic against a VU's own userId — the correctness probe
 * (spec point 4: "any private event for a userId != the VU's own userId
 * -> record cross_user_private_event (must be 0)"). Pure + exported so
 * it can be unit-tested directly against fabricated topics without a
 * live server.
 */
export function classifyPrivateEvent(topic, ownUserId) {
  if (typeof topic !== 'string' || !topic.startsWith('priv:')) return 'not_private';
  const parts = topic.split(':');
  const eventUserId = parts[1];
  if (!eventUserId) return 'not_private';
  return eventUserId === ownUserId ? 'own' : 'cross_user';
}

export function createWsStatsAccumulator() {
  return {
    connections: 0,
    ready: 0,
    readyLat: [],
    shed1013: 0,
    unauthorized1008: 0,
    unplannedDisconnects: 0,
    injectedDrops: 0,
    lagExcluded: 0,
    snapshotSeeds: 0,
    mintFailures: 0,
    deniedAcl: 0,
    errFramesByCode: {},
    eventsReceived: 0,
    eventLag: [],
    crossUserPrivateEvents: 0,
    crossUserSamples: [],
    backgroundAttempted: 0,
    backgroundResumed: 0,
    flakyAttempted: 0,
    flakySucceeded: 0,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** One connect -> ready -> subscribe -> hold -> close cycle. Records
 * everything into the shared `stats` accumulator.
 *
 * EVERY hold-expiry close is harness-initiated and therefore planned —
 * including flaky VUs' simulated network drops (`injectDropAtHoldExpiry`),
 * which are tallied separately as stats.injectedDrops. The
 * unplannedDisconnects counter is reserved for closes the harness did NOT
 * cause (server crash/restart, proxy timeout, capacity churn): any close
 * arriving BEFORE the hold timer fires that is not a 1013 shed or a 1008
 * auth close. Self-injected drops must never gate the fleet-health
 * disconnect budget — at 1k users the 5% flaky cohort alone injects
 * thousands of drops/hour by design, which would make the gate
 * structurally impossible to pass. */
export function connectAndHold({ base, token, userId, topics, holdMs, stats, injectDropAtHoldExpiry = false }) {
  stats.connections += 1;
  return new Promise((resolve) => {
    let ticketPromise;
    try {
      ticketPromise = mintTicket(base, token);
    } catch (e) {
      ticketPromise = Promise.reject(e);
    }
    ticketPromise
      .then((ticket) => {
        const wsUrl = `${base.replace(/^http/, 'ws')}/ws/markets?token=${encodeURIComponent(ticket)}`;
        const t0 = performance.now();
        let gotReady = false;
        let plannedClose = false;
        const lagSeenTopics = new Set();
        let settled = false;
        let holdTimer = null;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

        const ws = new WebSocket(wsUrl);
        const readyTimer = setTimeout(() => {
          try { ws.close(); } catch { /* already gone */ }
        }, READY_TIMEOUT_MS);

        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
          if (!gotReady && (msg?.op === 'ready' || msg?.t === 'ready')) {
            gotReady = true;
            clearTimeout(readyTimer);
            stats.ready += 1;
            stats.readyLat.push(performance.now() - t0);
            try { ws.send(JSON.stringify({ op: 'sub', topics })); } catch { /* gone */ }
            holdTimer = setTimeout(() => {
              plannedClose = true;
              if (injectDropAtHoldExpiry) stats.injectedDrops += 1;
              try { ws.close(1000); } catch { /* gone */ }
            }, holdMs);
            return;
          }
          if (msg?.op === 'err') {
            // r4 lesson: subscription NACKs were invisible — the run showed
            // "low events" with zero evidence the server had rejected subs.
            // Bucket every server error frame by code so a bad topic shape
            // (e.g. depthless book) surfaces in the artifact, not in silence.
            const code = typeof msg.code === 'string' && msg.code ? msg.code : 'unknown';
            stats.errFramesByCode[code] = (stats.errFramesByCode[code] ?? 0) + 1;
            if (msg.code === 'denied_acl') stats.deniedAcl += 1;
            return;
          }
          if (typeof msg?.topic === 'string' && typeof msg?.ts === 'number') {
            stats.eventsReceived += 1;
            // Delivery lag is only measurable where ts = server emit time:
            // ticks + priv: lifecycle envelopes (see header note). Candle
            // ts is the venue bar-open time — freshness, not delivery.
            if (msg.t === 'tick' || msg.topic.startsWith('priv:')) {
              // The hub seeds every new subscription with the topic's cached
              // last event (snapshot-on-connect, hub.ts lastByTopic) — it
              // arrives bearing the ORIGINAL emit ts of a possibly minutes-old
              // event. Cold-start seeding is not delivery lag: skip the first
              // event per (connection, topic) and sample only live deliveries.
              if (lagSeenTopics.has(msg.topic)) {
                stats.eventLag.push(Date.now() - msg.ts);
              } else {
                lagSeenTopics.add(msg.topic);
                stats.snapshotSeeds += 1;
              }
            } else {
              stats.lagExcluded += 1;
            }
            if (classifyPrivateEvent(msg.topic, userId) === 'cross_user') {
              stats.crossUserPrivateEvents += 1;
              if (stats.crossUserSamples.length < CROSS_USER_SAMPLE_CAP) {
                stats.crossUserSamples.push({ topic: msg.topic, ownUserId: userId });
              }
            }
          }
        };
        ws.onclose = (ev) => {
          clearTimeout(readyTimer);
          if (holdTimer) clearTimeout(holdTimer);
          if (ev.code === 1013) stats.shed1013 += 1;
          else if (ev.code === 1008) stats.unauthorized1008 += 1;
          else if (!plannedClose) stats.unplannedDisconnects += 1;
          finish({ closedPlanned: plannedClose, gotReady });
        };
        ws.onerror = () => { /* onclose always follows in the ws/undici impl */ };
      })
      .catch(() => {
        stats.mintFailures += 1;
        resolve({ closedPlanned: false, gotReady: false });
      });
  });
}

/**
 * Drive one VU's WebSocket presence for the whole run window, applying
 * its behavior class (spec point 3):
 *   normal      — one connection held for the full run duration
 *   background  — connect, hold a shorter dwell, deliberately disconnect
 *                 (app backgrounded), pause 10-60s, reconnect; repeat
 *   flaky       — short connect/hold/drop cycles (5-20s) for the whole
 *                 run — drops are harness-injected and tallied as
 *                 injectedDrops, NOT unplannedDisconnects: the fleet
 *                 disconnect gate budgets server-caused drops only
 */
export async function runVuLifecycle({ base, token, userId, cohortName, catalog, deadlineMs, behaviorClass, stats, rng = Math.random }) {
  if (!COHORT_WS_POLICY[cohortName]) return; // portfolio-only: no WS
  while (Date.now() < deadlineMs) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    const holdMs = behaviorClass === 'flaky'
      ? Math.min(remainingMs, 5_000 + rng() * 15_000)
      : behaviorClass === 'background'
        ? Math.min(remainingMs, 30_000 + rng() * 90_000)
        : remainingMs;
    const topics = buildTopicsForCohort(cohortName, catalog, userId, rng);
    // eslint-disable-next-line no-await-in-loop -- sequential by design: one VU's connection cycles are inherently serial
    await connectAndHold({ base, token, userId, topics, holdMs, stats, injectDropAtHoldExpiry: behaviorClass === 'flaky' });
    if (Date.now() >= deadlineMs) break;
    if (behaviorClass === 'background') {
      stats.backgroundAttempted += 1;
      const gapMs = Math.min(deadlineMs - Date.now(), 10_000 + rng() * 50_000);
      // eslint-disable-next-line no-await-in-loop
      await sleep(gapMs);
      if (Date.now() < deadlineMs) stats.backgroundResumed += 1;
    } else if (behaviorClass === 'flaky') {
      stats.flakyAttempted += 1;
      const gapMs = Math.min(deadlineMs - Date.now(), 1_000 + rng() * 4_000);
      // eslint-disable-next-line no-await-in-loop
      await sleep(gapMs);
      if (Date.now() < deadlineMs) stats.flakySucceeded += 1;
    } else {
      break;
    }
  }
}

/** Reduce a stats accumulator + run duration into the artifact's
 * `websocket` section shape. */
export function summarizeWsStats(stats, durationSeconds) {
  const sortedReady = [...stats.readyLat].sort((a, b) => a - b);
  const sortedLag = [...stats.eventLag].sort((a, b) => a - b);
  const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
  const hours = durationSeconds / 3600;
  return {
    connections: stats.connections,
    ready: stats.ready,
    readyRatePct: stats.connections ? +((stats.ready / stats.connections) * 100).toFixed(1) : 0,
    readyP95Ms: Math.round(pct(sortedReady, 95)),
    shed1013: stats.shed1013,
    unauthorized1008: stats.unauthorized1008,
    unplannedDisconnects: stats.unplannedDisconnects,
    unplannedDisconnectsPerHour: hours > 0 ? +(stats.unplannedDisconnects / hours).toFixed(2) : 0,
    injectedDrops: stats.injectedDrops,
    mintFailures: stats.mintFailures,
    deniedAcl: stats.deniedAcl,
    errFrames: Object.values(stats.errFramesByCode).reduce((a, b) => a + b, 0),
    errFramesByCode: stats.errFramesByCode,
    eventsReceived: stats.eventsReceived,
    eventsLagSampled: stats.eventLag.length,
    eventsLagExcluded: stats.lagExcluded,
    snapshotSeedsSkipped: stats.snapshotSeeds,
    eventLagP50Ms: Math.round(pct(sortedLag, 50)),
    eventLagP95Ms: Math.round(pct(sortedLag, 95)),
    eventLagP99Ms: Math.round(pct(sortedLag, 99)),
    backgroundResume: { attempted: stats.backgroundAttempted, resumed: stats.backgroundResumed },
    flakyReconnects: { attempted: stats.flakyAttempted, succeeded: stats.flakySucceeded },
  };
}

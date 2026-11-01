/**
 * Standalone scheduler process.
 *
 * Same Docker image as the API, different command: `node dist/workers/scheduler.js`.
 * Boots Sentry, then starts the repeat workers when REDIS_URL is set. With
 * Redis absent: exits 0 in dev/demo (Docker Compose `restart: on-failure`
 * won't loop on a clean exit; admin sweep endpoints remain the manual
 * fallback) but exits 1 in real production (W2-B fail-closed), and a set-but-
 * unparseable REDIS_URL exits 1 everywhere. Also serves /metrics +
 * /health/live on WORKER_METRICS_PORT and beats `nexa:scheduler:heartbeat`.
 *
 * Also populates the `bullmq_queue_depth` Prometheus gauge every 15 s so the API
 * `/metrics` endpoint reports queue health. The gauge instrument itself is
 * registered by lib/metrics.ts; the scheduler is the populator because it
 * owns the live queue references (per the comment δ left in index.ts).
 *
 * Signal handling: SIGTERM/SIGINT close the workers + queues before exit so
 * BullMQ doesn't leak Redis sockets across container restarts.
 */

// First line: Sentry init must run before any module touches node:http.
// Pattern mirrors apps/api/src/index.ts so the scheduler process gets the same
// auto-instrumentation.
import '../lib/sentry-bootstrap.js';

import { log } from '../lib/log.js';
import { env, features, runtimeFailClosed } from '../lib/env.js';
import { startClaimSweeper, stopClaimSweeper, claimSweepQueue } from './claim-sweeper.js';
import {
  startSubscriptionRenewer,
  stopSubscriptionRenewer,
  subscriptionRenewerQueue,
} from './subscription-renewer.js';
import { startDigestSender, stopDigestSender, digestSenderQueue } from './digest-sender.js';
import { startFillsNotifier, stopFillsNotifier, fillsNotifierQueue } from './fills-notifier.js';
import {
  startBridgeWorker,
  stopBridgeWorker,
  bridgeTransferQueue,
} from './bridge-worker.js';
import {
  startDepositReconciler,
  stopDepositReconciler,
  depositReconcileQueue,
} from './deposit-reconciler.js';
import { bullmqQueueDepth, getRegistry, workerHeartbeat } from '../lib/metrics.js';
import { parseRedisUrl } from '../lib/redis-url.js';
import { RedisKeys } from '../lib/redis.js';
import { WORKER_HEARTBEAT_TTL_SECONDS } from '../lib/health.js';
import { Redis } from 'ioredis';
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const GAUGE_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Scheduler-native heartbeat key (ISO string) — log/debug tooling only.
 * The API's /health/money does NOT read this key: it reads the shared
 * worker namespace `RedisKeys.workerHeartbeat('scheduler')` (epoch-ms, TTL
 * WORKER_HEARTBEAT_TTL_SECONDS), dual-written in writeHeartbeat() below.
 * Keep both keys — renaming either breaks a consumer.
 */
const HEARTBEAT_KEY = 'nexa:scheduler:heartbeat';
const HEARTBEAT_TTL_SECONDS = 90;

/**
 * Read job counts and write to the shared gauge. Best-effort: a Redis blip
 * during a sample shouldn't crash the scheduler — log + continue.
 */
export async function updateQueueDepthGauges(): Promise<void> {
  try {
    // Re-import so we see the live `let` after start*() assigned. ES modules
    // bind exports live, but the explicit dynamic import keeps the pattern
    // obvious and decouples the scheduler from worker module init order.
    const { claimSweepQueue: csq } = await import('./claim-sweeper.js');
    const { subscriptionRenewerQueue: srq } = await import('./subscription-renewer.js');
    const { digestSenderQueue: dsq } = await import('./digest-sender.js');
    const { bridgeTransferQueue: btq } = await import('./bridge-worker.js');
    const { fillsNotifierQueue: fnq } = await import('./fills-notifier.js');
    const { depositReconcileQueue: drq } = await import('./deposit-reconciler.js');
    // agent-approvals is intentionally not sampled: its worker is never started by this scheduler.
    const csCounts = csq ? await csq.getJobCounts() : null;
    const srCounts = srq ? await srq.getJobCounts() : null;
    const dsCounts = dsq ? await dsq.getJobCounts() : null;
    const btCounts = btq ? await btq.getJobCounts() : null;
    const fnCounts = fnq ? await fnq.getJobCounts() : null;
    const drCounts = drq ? await drq.getJobCounts() : null;
    if (csCounts) {
      for (const [state, count] of Object.entries(csCounts)) {
        bullmqQueueDepth.set({ queue: 'claim-sweep', state }, Number(count) || 0);
      }
    }
    if (srCounts) {
      for (const [state, count] of Object.entries(srCounts)) {
        bullmqQueueDepth.set({ queue: 'subscription-renewer', state }, Number(count) || 0);
      }
    }
    if (dsCounts) {
      for (const [state, count] of Object.entries(dsCounts)) {
        bullmqQueueDepth.set({ queue: 'digest-sender', state }, Number(count) || 0);
      }
    }
    if (btCounts) {
      for (const [state, count] of Object.entries(btCounts)) {
        bullmqQueueDepth.set({ queue: 'bridge-transfer', state }, Number(count) || 0);
      }
    }
    if (fnCounts) {
      for (const [state, count] of Object.entries(fnCounts)) {
        bullmqQueueDepth.set({ queue: 'fills-notifier', state }, Number(count) || 0);
      }
    }
    if (drCounts) {
      for (const [state, count] of Object.entries(drCounts)) {
        bullmqQueueDepth.set({ queue: 'deposit-reconcile', state }, Number(count) || 0);
      }
    }
    // F056 — the scheduler process itself is a worker; this gauge proves the
    // gauge tick fired and the process is still draining Redis. Alert on
    // `time() - worker_heartbeat_seconds{worker="scheduler"} > 60`.
    workerHeartbeat.set({ worker: 'scheduler' }, Date.now() / 1000);
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'scheduler: gauge update failed',
    );
  }
}

/**
 * W2-B — standalone observability surface for the scheduler container (the
 * API's Hono /metrics doesn't run in this process). Mirrors the API contract
 * (see apps/api/src/index.ts): 404 while the metrics feature is off, 401
 * without the exact Bearer METRICS_TOKEN (timing-safe compare), prom-client
 * text on success. /health/live is unauthenticated liveness for probes.
 */
export function startMetricsServer(): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (url !== '/metrics' || !features.metrics) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"not_found"}');
      return;
    }
    const expected = env.METRICS_TOKEN ? `Bearer ${env.METRICS_TOKEN}` : null;
    if (!expected) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"unauthorized"}');
      return;
    }
    const a = Buffer.from(req.headers.authorization ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"unauthorized"}');
      return;
    }
    getRegistry()
      .metrics()
      .then((body) => {
        res.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        });
        res.end(body);
      })
      .catch((e: unknown) => {
        log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'scheduler: metrics render failed',
        );
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"metrics_failed"}');
      });
  });
  server.on('error', (e) => {
    log.error({ err: e.message }, 'scheduler: metrics server error');
  });
  server.listen(env.WORKER_METRICS_PORT, () => {
    log.info({ port: env.WORKER_METRICS_PORT }, 'scheduler: metrics server listening');
  });
  return server;
}

/**
 * W2-B — liveness heartbeat, dual-written every HEARTBEAT_INTERVAL_MS:
 *   1. HEARTBEAT_KEY (ISO string, TTL 90 s) — scheduler-native, for
 *      log/debug tooling.
 *   2. RedisKeys.workerHeartbeat('scheduler') (epoch-ms, shared TTL) — the
 *      namespace the API's /health/money folds in via
 *      combineWorkerHeartbeats(). Integration fix: without this write a dead
 *      scheduler stalled bridge/fills queues while money-health stayed green.
 * Best-effort: a Redis blip must not crash the scheduler.
 */
async function writeHeartbeat(redis: Redis): Promise<void> {
  const now = new Date();
  try {
    await redis.set(HEARTBEAT_KEY, now.toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);
    await redis.set(
      RedisKeys.workerHeartbeat('scheduler'),
      String(now.getTime()),
      'EX',
      WORKER_HEARTBEAT_TTL_SECONDS,
    );
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'scheduler: heartbeat write failed',
    );
  }
}

export async function runScheduler(): Promise<void> {
  if (!features.redis || !env.REDIS_URL) {
    if (runtimeFailClosed()) {
      // W2-B fail-closed: a real-production scheduler without Redis is a
      // misconfiguration, not a degraded mode — exit 1 so `restart:
      // on-failure` restarts/alerts instead of silently dropping every job.
      log.error('scheduler: REDIS_URL required in production, refusing to run');
      process.exit(1);
    }
    log.warn(
      'scheduler: redis unavailable, exiting (admin endpoints remain as fallback)',
    );
    // exit 0 + compose `restart: on-failure` → no crash-loop on a clean exit.
    process.exit(0);
  }

  // Set-but-malformed REDIS_URL is a loud boot failure in every environment
  // (see workers/connection.ts) — a typo must not degrade to a silent no-op.
  const parsedRedis = parseRedisUrl(env.REDIS_URL);
  if (!parsedRedis) {
    log.error('scheduler: REDIS_URL is set but unparseable, refusing to run');
    process.exit(1);
  }

  log.info('scheduler: starting repeat workers');
  await startClaimSweeper();
  await startSubscriptionRenewer();
  await startDigestSender();
  await startBridgeWorker();
  await startFillsNotifier();
  await startDepositReconciler();

  // Touch the imports so a future bundler doesn't tree-shake them; the
  // assignment to `let` exports happens inside start*() and is read via the
  // dynamic re-import in updateQueueDepthGauges.
  void claimSweepQueue;
  void subscriptionRenewerQueue;
  void digestSenderQueue;
  void bridgeTransferQueue;
  void fillsNotifierQueue;
  void depositReconcileQueue;

  // W2-B observability — scrapeable /metrics + /health/live for this container.
  const metricsServer = startMetricsServer();

  // Dedicated heartbeat client: liveness must reflect THIS process, not any
  // one queue's health. Primed immediately so probes see it within one tick.
  const hbRedis = new Redis({
    ...parsedRedis,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });
  hbRedis.on('error', (e) => {
    log.warn({ err: e.message }, 'scheduler: heartbeat redis error');
  });
  void writeHeartbeat(hbRedis);
  const heartbeatTimer = setInterval(() => {
    void writeHeartbeat(hbRedis);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const gaugeTimer = setInterval(() => {
    void updateQueueDepthGauges();
  }, GAUGE_INTERVAL_MS);
  // Don't keep the event loop alive for the gauge alone.
  gaugeTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'scheduler: shutdown');
    clearInterval(gaugeTimer);
    clearInterval(heartbeatTimer);
    metricsServer.close();
    try {
      await Promise.all([
        stopClaimSweeper(),
        stopSubscriptionRenewer(),
        stopDigestSender(),
        stopBridgeWorker(),
        stopFillsNotifier(),
        stopDepositReconciler(),
      ]);
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'scheduler: worker close failed',
      );
    }
    await hbRedis.quit().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Boot guard mirrors index.ts: tests import the module without auto-running.
if (process.env['VITEST'] === undefined) {
  void runScheduler();
}

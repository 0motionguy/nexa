/**
 * W2-A (harden/wave2-failclosed-core) — honest health evaluation.
 *
 * Pure decision functions behind `/health/ready` and `/health/money`, kept
 * free of app imports (no env/store singletons) so the spec matrix can drive
 * every branch with plain inputs. Wiring lives in index.ts.
 *
 *   /health/ready — pod readiness, fail-closed. Unlike the legacy /healthz
 *     (kept byte-compatible for existing uplinks), readiness refuses to call
 *     a production non-demo pod healthy on the in-memory backend, on a
 *     failing Postgres ping, or on dead/unconfigured Redis — the LB drains
 *     the pod before money flows hit a half-broken instance. Demo mode
 *     reports honestly (demo flag + real backend) and stays ready:
 *     in-memory IS the intended demo backend.
 *
 *   /health/money — money-path liveness. Every money-path worker writes an
 *     epoch-ms heartbeat to Redis under `nb:worker_heartbeat:<name>`: the
 *     in-process approvals worker (workers/approvals.ts) AND the standalone
 *     scheduler that owns the bridge/fills queues (workers/scheduler.ts),
 *     each every WORKER_HEARTBEAT_INTERVAL_MS. The endpoint folds them with
 *     combineWorkerHeartbeats() and 503s when ANY beat is missing or stale,
 *     so "money machinery wedged" is visible separately from pod readiness.
 */

import { RedisKeys } from './redis.js';

/** Mirrors pingRedis() in rate-limit.ts: 'absent' = intentionally unconfigured. */
export type RedisState = 'ok' | 'down' | 'absent';

/* ── readiness ─────────────────────────────────────────────────────────── */

export interface ReadinessInput {
  nodeEnv: string;
  demoMode: boolean;
  backend: 'in-memory' | 'postgres';
  /** store.ping() result; pass true when the backend has no ping (in-memory). */
  dbOk: boolean;
  redisState: RedisState;
}

export interface ReadinessReport {
  status: 200 | 503;
  body: {
    ok: boolean;
    ready: boolean;
    demo: boolean;
    backend: 'in-memory' | 'postgres';
    db: 'connected' | 'down' | 'in-memory';
    redis: 'connected' | 'down' | 'absent';
    /** Machine-readable failure causes; empty when ready. */
    reasons: string[];
  };
}

/**
 * Fail-closed readiness matrix:
 *   - demo (any NODE_ENV): ready unless a *configured* dependency is down —
 *     honest body, in-memory allowed.
 *   - production non-demo: in-memory backend, failed PG ping, Redis down OR
 *     unconfigured → not ready (503).
 */
export function evaluateReadiness(i: ReadinessInput): ReadinessReport {
  const prodNonDemo = i.nodeEnv === 'production' && !i.demoMode;
  const reasons: string[] = [];

  if (prodNonDemo && i.backend !== 'postgres') reasons.push('in_memory_backend_in_production');
  if (i.backend === 'postgres' && !i.dbOk) reasons.push('postgres_ping_failed');
  if (i.redisState === 'down') reasons.push('redis_down');
  if (prodNonDemo && i.redisState === 'absent') reasons.push('redis_unconfigured');

  const ready = reasons.length === 0;
  return {
    status: ready ? 200 : 503,
    body: {
      ok: ready,
      ready,
      demo: i.demoMode,
      backend: i.backend,
      db: i.backend === 'postgres' ? (i.dbOk ? 'connected' : 'down') : 'in-memory',
      redis: i.redisState === 'ok' ? 'connected' : i.redisState,
      reasons,
    },
  };
}

/* ── money-path liveness (worker heartbeat) ────────────────────────────── */

/** How often the approvals worker beats (workers/approvals.ts). */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
/** Heartbeat older than this → money 503 (three missed beats). */
export const WORKER_HEARTBEAT_MAX_AGE_SECONDS = 90;
/** Redis EX on the heartbeat key — a dead writer self-erases shortly after staleness. */
export const WORKER_HEARTBEAT_TTL_SECONDS = 120;

export interface MoneyHealthInput {
  demoMode: boolean;
  redisConfigured: boolean;
  /** Parsed heartbeat epoch-ms, or null when missing/unreadable. */
  heartbeatMs: number | null;
  nowMs?: number;
  maxAgeSeconds?: number;
}

export interface MoneyHealthReport {
  status: 200 | 503;
  body: {
    ok: boolean;
    demo: boolean;
    worker: 'alive' | 'missing' | 'stale' | 'skipped' | 'unknown';
    ageSeconds: number | null;
    reasons: string[];
  };
}

export function evaluateMoneyHealth(i: MoneyHealthInput): MoneyHealthReport {
  if (i.demoMode) {
    // Demo has no queue worker/Redis by design — honest skip, never a 503.
    return {
      status: 200,
      body: { ok: true, demo: true, worker: 'skipped', ageSeconds: null, reasons: [] },
    };
  }
  if (!i.redisConfigured) {
    return {
      status: 503,
      body: { ok: false, demo: false, worker: 'unknown', ageSeconds: null, reasons: ['redis_unconfigured'] },
    };
  }
  if (i.heartbeatMs === null || !Number.isFinite(i.heartbeatMs)) {
    return {
      status: 503,
      body: { ok: false, demo: false, worker: 'missing', ageSeconds: null, reasons: ['heartbeat_missing'] },
    };
  }
  const nowMs = i.nowMs ?? Date.now();
  const maxAge = i.maxAgeSeconds ?? WORKER_HEARTBEAT_MAX_AGE_SECONDS;
  const ageSeconds = Math.max(0, Math.round((nowMs - i.heartbeatMs) / 1000));
  if (ageSeconds > maxAge) {
    return {
      status: 503,
      body: { ok: false, demo: false, worker: 'stale', ageSeconds, reasons: ['heartbeat_stale'] },
    };
  }
  return {
    status: 200,
    body: { ok: true, demo: false, worker: 'alive', ageSeconds, reasons: [] },
  };
}

/**
 * Read + parse a worker heartbeat from Redis. Best-effort: missing key,
 * unparseable value, read error, or no client all normalize to null (the
 * evaluator turns null into a 503) — the health endpoint itself never throws.
 */
export async function readWorkerHeartbeatMs(
  client: { get(key: string): Promise<string | null> } | null,
  name: string,
): Promise<number | null> {
  if (!client) return null;
  try {
    const raw = await client.get(RedisKeys.workerHeartbeat(name));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Fold per-worker heartbeats into the single freshness signal
 * evaluateMoneyHealth() consumes. Money-readiness requires EVERY money-path
 * worker alive, so: any missing/unparseable beat → null (the evaluator turns
 * that into a 503), otherwise the OLDEST beat — the worst worker's staleness
 * is the money path's staleness.
 *
 * Integration fix (wave-2 merge): W2-A shipped /health/money reading only the
 * in-process approvals worker, while the W2-B scheduler — which owns the
 * bridge-transfer and fills queues — wrote a heartbeat nothing read. A dead
 * scheduler kept /health/money green while transfers silently stalled
 * (exactly the audit's WORKER-P0-1 failure mode). The scheduler now
 * dual-writes `nb:worker_heartbeat:scheduler` and this fold requires it.
 */
export function combineWorkerHeartbeats(...heartbeats: Array<number | null>): number | null {
  let oldest: number | null = null;
  for (const hb of heartbeats) {
    if (hb === null || !Number.isFinite(hb)) return null;
    if (oldest === null || hb < oldest) oldest = hb;
  }
  return oldest;
}

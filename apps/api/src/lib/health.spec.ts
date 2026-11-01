/**
 * W2-A — honest health decision matrix (lib/health.ts).
 *
 * Pure-function coverage for the /health/ready + /health/money evaluators:
 * demo stays ready + honest, production non-demo fails closed on in-memory
 * backend / dead Postgres / dead-or-missing Redis, and the money endpoint
 * gates on money-worker heartbeat freshness (approvals + scheduler beats,
 * folded fail-closed by combineWorkerHeartbeats).
 */

import { describe, expect, it } from 'vitest';
import {
  combineWorkerHeartbeats,
  evaluateMoneyHealth,
  evaluateReadiness,
  readWorkerHeartbeatMs,
  WORKER_HEARTBEAT_MAX_AGE_SECONDS,
} from './health.js';

describe('evaluateReadiness', () => {
  it('demo + in-memory → ready 200 with an honest backend report', () => {
    const r = evaluateReadiness({
      nodeEnv: 'production',
      demoMode: true,
      backend: 'in-memory',
      dbOk: true,
      redisState: 'absent',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.ready).toBe(true);
    expect(r.body.demo).toBe(true);
    expect(r.body.backend).toBe('in-memory');
    expect(r.body.db).toBe('in-memory'); // honest: never claims "connected"
    expect(r.body.redis).toBe('absent');
    expect(r.body.reasons).toEqual([]);
  });

  it('development defaults (demo + in-memory + no redis) → ready 200', () => {
    const r = evaluateReadiness({
      nodeEnv: 'development',
      demoMode: true,
      backend: 'in-memory',
      dbOk: true,
      redisState: 'absent',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('production non-demo + in-memory backend → 503 fail-closed', () => {
    const r = evaluateReadiness({
      nodeEnv: 'production',
      demoMode: false,
      backend: 'in-memory',
      dbOk: true,
      redisState: 'ok',
    });
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    expect(r.body.ready).toBe(false);
    expect(r.body.reasons).toContain('in_memory_backend_in_production');
  });

  it('production + postgres + failing ping → 503', () => {
    const r = evaluateReadiness({
      nodeEnv: 'production',
      demoMode: false,
      backend: 'postgres',
      dbOk: false,
      redisState: 'ok',
    });
    expect(r.status).toBe(503);
    expect(r.body.db).toBe('down');
    expect(r.body.reasons).toContain('postgres_ping_failed');
  });

  it('production + postgres + redis down → 503', () => {
    const r = evaluateReadiness({
      nodeEnv: 'production',
      demoMode: false,
      backend: 'postgres',
      dbOk: true,
      redisState: 'down',
    });
    expect(r.status).toBe(503);
    expect(r.body.redis).toBe('down');
    expect(r.body.reasons).toContain('redis_down');
  });

  it('production non-demo + redis unconfigured → 503 (fail-closed)', () => {
    const r = evaluateReadiness({
      nodeEnv: 'production',
      demoMode: false,
      backend: 'postgres',
      dbOk: true,
      redisState: 'absent',
    });
    expect(r.status).toBe(503);
    expect(r.body.reasons).toContain('redis_unconfigured');
  });

  it('production + postgres + all green → ready 200', () => {
    const r = evaluateReadiness({
      nodeEnv: 'production',
      demoMode: false,
      backend: 'postgres',
      dbOk: true,
      redisState: 'ok',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      ready: true,
      demo: false,
      backend: 'postgres',
      db: 'connected',
      redis: 'connected',
      reasons: [],
    });
  });

  it('demo with a configured-but-dead redis → 503 (a real fault in any mode)', () => {
    const r = evaluateReadiness({
      nodeEnv: 'development',
      demoMode: true,
      backend: 'in-memory',
      dbOk: true,
      redisState: 'down',
    });
    expect(r.status).toBe(503);
    expect(r.body.reasons).toContain('redis_down');
  });
});

describe('evaluateMoneyHealth', () => {
  const NOW = 1_750_000_000_000;

  it('missing heartbeat → 503 worker=missing', () => {
    const r = evaluateMoneyHealth({
      demoMode: false,
      redisConfigured: true,
      heartbeatMs: null,
      nowMs: NOW,
    });
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    expect(r.body.worker).toBe('missing');
    expect(r.body.reasons).toContain('heartbeat_missing');
  });

  it('fresh heartbeat → 200 worker=alive with age', () => {
    const r = evaluateMoneyHealth({
      demoMode: false,
      redisConfigured: true,
      heartbeatMs: NOW - 10_000,
      nowMs: NOW,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.worker).toBe('alive');
    expect(r.body.ageSeconds).toBe(10);
  });

  it('stale heartbeat past the max age → 503 worker=stale', () => {
    const r = evaluateMoneyHealth({
      demoMode: false,
      redisConfigured: true,
      heartbeatMs: NOW - (WORKER_HEARTBEAT_MAX_AGE_SECONDS + 30) * 1000,
      nowMs: NOW,
    });
    expect(r.status).toBe(503);
    expect(r.body.worker).toBe('stale');
    expect(r.body.ageSeconds).toBe(WORKER_HEARTBEAT_MAX_AGE_SECONDS + 30);
    expect(r.body.reasons).toContain('heartbeat_stale');
  });

  it('demo mode → 200 skipped (no heartbeat machinery in demo)', () => {
    const r = evaluateMoneyHealth({
      demoMode: true,
      redisConfigured: false,
      heartbeatMs: null,
      nowMs: NOW,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, demo: true, worker: 'skipped' });
  });

  it('non-demo without redis configured → 503', () => {
    const r = evaluateMoneyHealth({
      demoMode: false,
      redisConfigured: false,
      heartbeatMs: null,
      nowMs: NOW,
    });
    expect(r.status).toBe(503);
    expect(r.body.worker).toBe('unknown');
    expect(r.body.reasons).toContain('redis_unconfigured');
  });
});

describe('readWorkerHeartbeatMs', () => {
  it('reads + parses the heartbeat key from redis (mock)', async () => {
    const calls: string[] = [];
    const client = {
      get: async (k: string): Promise<string | null> => {
        calls.push(k);
        return '1750000000000';
      },
    };
    const ms = await readWorkerHeartbeatMs(client, 'approvals');
    expect(ms).toBe(1_750_000_000_000);
    expect(calls).toEqual(['nb:worker_heartbeat:approvals']);
  });

  it('missing key → null → composes to a money 503', async () => {
    const client = { get: async (): Promise<string | null> => null };
    const ms = await readWorkerHeartbeatMs(client, 'approvals');
    expect(ms).toBeNull();
    const r = evaluateMoneyHealth({ demoMode: false, redisConfigured: true, heartbeatMs: ms });
    expect(r.status).toBe(503);
  });

  it('read error / garbage value / absent client all normalize to null', async () => {
    const throwing = {
      get: async (): Promise<string | null> => {
        throw new Error('conn reset');
      },
    };
    expect(await readWorkerHeartbeatMs(throwing, 'approvals')).toBeNull();
    const garbage = { get: async (): Promise<string | null> => 'not-a-number' };
    expect(await readWorkerHeartbeatMs(garbage, 'approvals')).toBeNull();
    expect(await readWorkerHeartbeatMs(null, 'approvals')).toBeNull();
  });
});

describe('combineWorkerHeartbeats', () => {
  it('returns the oldest beat when every worker reported', () => {
    expect(combineWorkerHeartbeats(1_000, 2_000)).toBe(1_000);
    expect(combineWorkerHeartbeats(2_000, 1_000)).toBe(1_000);
    expect(combineWorkerHeartbeats(5)).toBe(5);
  });

  it('fails closed: any missing/garbage worker nulls the composite', () => {
    expect(combineWorkerHeartbeats(1_000, null)).toBeNull();
    expect(combineWorkerHeartbeats(null, 2_000)).toBeNull();
    expect(combineWorkerHeartbeats(Number.NaN, 1_000)).toBeNull();
    expect(combineWorkerHeartbeats()).toBeNull();
  });

  it('a stale scheduler trips the money 503 even with a fresh approvals beat', () => {
    const now = 1_750_000_000_000;
    const combined = combineWorkerHeartbeats(now - 1_000, now - 600_000);
    const r = evaluateMoneyHealth({
      demoMode: false,
      redisConfigured: true,
      heartbeatMs: combined,
      nowMs: now,
    });
    expect(r.status).toBe(503);
    expect(r.body.worker).toBe('stale');
    expect(r.body.reasons).toContain('heartbeat_stale');
  });

  it('a missing scheduler beat composes to a money 503 (dead-scheduler visibility)', () => {
    const combined = combineWorkerHeartbeats(Date.now(), null);
    const r = evaluateMoneyHealth({ demoMode: false, redisConfigured: true, heartbeatMs: combined });
    expect(r.status).toBe(503);
    expect(r.body.worker).toBe('missing');
  });
});

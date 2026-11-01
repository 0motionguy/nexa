/**
 * W2-B — stream-ticket one-shot consumption (lib/auth.ts replay guard).
 *
 * The Redis-backed path is exercised with an injected fake client
 * (`_setTicketRedisForTests`) rather than `vi.doMock('ioredis')`: auth.ts
 * builds its client through lib/redis.ts on first use, and injection avoids
 * reloading auth's heavy import graph (store, sentry) via vi.resetModules.
 *
 * Fail-mode tests flip NODE_ENV/DEMO_MODE on the live env singleton —
 * `runtimeFailClosed()` reads them per call by design — and afterEach
 * restores the originals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  _resetTicketJtisForTests,
  _setTicketRedisForTests,
  issueTicket,
  setSessionFromTicket,
} from './auth.js';
import { env } from './env.js';
import type { RedisClient } from './redis.js';
import { store } from '../store/index.js';

const envMut = env as unknown as { NODE_ENV: string; DEMO_MODE: boolean };
const ORIGINAL = { NODE_ENV: envMut.NODE_ENV, DEMO_MODE: envMut.DEMO_MODE };

function fakeRedis(set: ReturnType<typeof vi.fn>): RedisClient {
  return { set } as unknown as RedisClient;
}

/** Consume `token` via a synthetic route so setSessionFromTicket gets a real Context. */
async function consume(token: string): Promise<boolean> {
  const app = new Hono();
  app.get('/t', async (c) => c.json({ ok: await setSessionFromTicket(c, token) }));
  const res = await app.request('/t');
  const body = (await res.json()) as { ok: boolean };
  return body.ok;
}

describe('stream-ticket consumption (W2-B)', () => {
  beforeEach(() => {
    _resetTicketJtisForTests();
    _setTicketRedisForTests(null);
  });
  afterEach(() => {
    _resetTicketJtisForTests();
    _setTicketRedisForTests(null);
    envMut.NODE_ENV = ORIGINAL.NODE_ENV;
    envMut.DEMO_MODE = ORIGINAL.DEMO_MODE;
  });

  it('redis-backed: SET NX consumes exactly once — replay (any pod) is rejected', async () => {
    const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    _setTicketRedisForTests(fakeRedis(set));

    const user = await store.upsertUserByEmail(`w2b-nx-${Math.random()}@example.com`);
    const { token } = await issueTicket(user);

    expect(await consume(token)).toBe(true);
    expect(await consume(token)).toBe(false);

    expect(set).toHaveBeenCalledTimes(2);
    const [key, val, px, ttl, nx] = set.mock.calls[0] as [string, string, string, number, string];
    expect(key).toMatch(/^nb:ticket_jti:/);
    expect(key).not.toContain(token); // key is the jti, never the raw JWT
    expect(val).toBe('1');
    expect(px).toBe('PX');
    expect(ttl).toBeGreaterThan(0);
    expect(nx).toBe('NX');
  });

  it('redis error in dev/test: falls back to the in-process map and stays single-use', async () => {
    const set = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    _setTicketRedisForTests(fakeRedis(set));

    const user = await store.upsertUserByEmail(`w2b-open-${Math.random()}@example.com`);
    const { token } = await issueTicket(user);

    expect(await consume(token)).toBe(true); // fallback consumed it in-process…
    expect(await consume(token)).toBe(false); // …and it stays one-shot
  });

  it('redis error in real production: fails closed on the FIRST use', async () => {
    const set = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    _setTicketRedisForTests(fakeRedis(set));

    const user = await store.upsertUserByEmail(`w2b-closed-${Math.random()}@example.com`);
    const { token } = await issueTicket(user);

    envMut.NODE_ENV = 'production';
    envMut.DEMO_MODE = false;
    expect(await consume(token)).toBe(false);
  });

  it('no shared store in real production: fails closed (per-pod map cannot prove single-use)', async () => {
    // _setTicketRedisForTests(null) in beforeEach forces "no redis".
    const user = await store.upsertUserByEmail(`w2b-nostore-${Math.random()}@example.com`);
    const { token } = await issueTicket(user);

    envMut.NODE_ENV = 'production';
    envMut.DEMO_MODE = false;
    expect(await consume(token)).toBe(false);
  });
});

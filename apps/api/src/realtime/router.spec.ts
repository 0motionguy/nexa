/**
 * Realtime router + registry integration.
 *
 * Drives the mounted Hono app directly (not via HTTP), confirming:
 *   - `/feeds/health` returns the summarized envelope with both registered venues
 *   - the health endpoint is publicly reachable (no auth)
 *   - `getHub()` is a process-wide singleton across imports
 *
 * SSE-specific behaviour (subscribe / pump / disconnect cleanup) is covered
 * in `realtime.spec.ts` at the hub level. The router slice is thin enough
 * that mocking the SSE stream object would test the mock, not the route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SSEStreamingApi } from 'hono/streaming';
import { realtimeRoutes } from './router.js';
import { v1Routes } from '../routes/v1.js';
import { authRoutes } from '../routes/auth.js';
import { getHub, shutdown } from './registry.js';
import { _resetTicketJtisForTests, issueToken, issueTicket } from '../lib/auth.js';
import { store } from '../store/index.js';
import { env } from '../lib/env.js';
import {
  activeIpSlots,
  activeRealtimeClients,
  activeUserSlots,
  resetRealtimeBudget,
  tryAcquireIpSlot,
  tryAcquireUserSlot,
} from './capacity.js';
import type { Topic } from './types.js';

function makeApp(): Hono {
  const app = new Hono();
  app.route('/v1', realtimeRoutes);
  return app;
}

/**
 * Mirror the index.ts mount order: v1Routes (developer surface, apikey-gated)
 * is registered first, then realtimeRoutes. Regression for the production bug
 * where v1Routes' `use('*', requireApiKey)` swallowed /v1/stream/* and
 * /v1/feeds/health before realtimeRoutes could match.
 */
function makeRealisticApp(): Hono {
  const app = new Hono();
  app.route('/v1', v1Routes);
  app.route('/v1', realtimeRoutes);
  return app;
}

describe('GET /v1/feeds/health', () => {
  it('returns a JSON envelope with both registered venues and an ok flag', async () => {
    const app = makeApp();
    const res = await app.request('/v1/feeds/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      hub: { clients: number; subscriptions: number; activeTopics: number };
      venues: Record<string, unknown>;
    };
    expect(body).toMatchObject({
      ok: expect.any(Boolean),
      hub: {
        clients: expect.any(Number),
        subscriptions: expect.any(Number),
        activeTopics: expect.any(Number),
      },
    });
    // At minimum HL + PM are registered before pyth/helius land.
    expect(Object.keys(body.venues)).toEqual(expect.arrayContaining(['hl', 'pm']));
  });

  it('reports ok=true when no venue breaker is open', async () => {
    const app = makeApp();
    const res = await app.request('/v1/feeds/health');
    const body = (await res.json()) as { ok: boolean };
    // Fresh adapters in a unit-test context have closed breakers + no errors.
    expect(body.ok).toBe(true);
  });

  it('is public (no Authorization header required)', async () => {
    const app = makeApp();
    const res = await app.request('/v1/feeds/health', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('has no active clients in the hub.clients counter before any SSE connect', async () => {
    const app = makeApp();
    const res = await app.request('/v1/feeds/health');
    const body = (await res.json()) as { hub: { clients: number } };
    expect(body.hub.clients).toBe(0);
  });
});

describe('registry.getHub()', () => {
  it('returns the same Hub across multiple calls (process-wide singleton)', () => {
    const a = getHub();
    const b = getHub();
    expect(a).toBe(b);
  });

  it('registers at least the HL and PM venue adapters', () => {
    const hub = getHub();
    const venues = hub.listAdapters().map((a) => a.venue);
    expect(venues).toEqual(expect.arrayContaining(['hl', 'pm']));
  });

  it('shutdown() releases the cached singleton so the next getHub builds fresh', async () => {
    const a = getHub();
    await shutdown();
    const b = getHub();
    expect(a).not.toBe(b);
    await shutdown();
  });
});

describe('SSE route auth', () => {
  it('rejects /v1/stream/sse without a session token (401)', async () => {
    const app = makeApp();
    const res = await app.request('/v1/stream/sse?topics=ticker:hl:BTC');
    expect(res.status).toBe(401);
  });
});

describe('stream-ticket auth flow', () => {
  beforeEach(() => { _resetTicketJtisForTests(); });
  afterEach(() => { _resetTicketJtisForTests(); });

  function makeAuthApp(): Hono {
    const app = new Hono();
    app.route('/auth', authRoutes);
    app.route('/v1', realtimeRoutes);
    return app;
  }

  it('POST /v1/stream/ticket mints a ticket for a Bearer-session caller', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`ticket-mint-${Math.random()}@example.com`);
    const { token: session, expiresAt: sessionExpiresAt } = await issueToken(user);
    const res = await app.request('/v1/stream/ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string; expiresAt: number };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(50);
    // Ticket expires within the next 5 minutes (we use 60s but allow generous slack).
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(body.expiresAt).toBeLessThan(Math.floor(Date.now() / 1000) + 5 * 60);
    const [, payload] = body.token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { sessionExp?: number };
    expect(claims.sessionExp).toBe(sessionExpiresAt);
  });

  it('POST /v1/stream/ticket rejects unauthenticated callers', async () => {
    const app = makeAuthApp();
    const res = await app.request('/v1/stream/ticket', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects a full session JWT via ?token= (URL-leakage gate)', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`session-in-url-${Math.random()}@example.com`);
    const { token: session } = await issueToken(user);
    const res = await app.request(`/v1/stream/sse?topics=ticker:hl:BTC&token=${session}`);
    // Session token in URL is no longer accepted — only tickets ride `?token=`.
    expect(res.status).toBe(401);
  });

  it('accepts a valid ticket via ?token= once; second use is rejected (replay)', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`replay-test-${Math.random()}@example.com`);
    const { token: ticket } = await issueTicket(user);

    // First use: 200 — request returns a stream so we abort fast to avoid blocking.
    const ac1 = new AbortController();
    const res1 = await app.request(
      `/v1/stream/sse?topics=ticker:hl:BTC&token=${ticket}`,
      { signal: ac1.signal },
    );
    expect(res1.status).toBe(200);
    ac1.abort();

    // Second use of the same jti: 401.
    const res2 = await app.request(`/v1/stream/sse?topics=ticker:hl:BTC&token=${ticket}`);
    expect(res2.status).toBe(401);
  });

  it('Bearer session header still accepted on SSE without any ticket', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`bearer-direct-${Math.random()}@example.com`);
    const { token: session } = await issueToken(user);
    const ac = new AbortController();
    const res = await app.request('/v1/stream/sse?topics=ticker:hl:BTC', {
      headers: { authorization: `Bearer ${session}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    ac.abort();
  });
});

describe('v1Routes + realtimeRoutes coexistence at /v1', () => {
  // Regression: in production index.ts mounts BOTH at /v1. v1Routes uses
  // `use('*', requireApiKey)` which previously swallowed /v1/stream/* and
  // /v1/feeds/health before realtimeRoutes could match — making the entire
  // hub non-functional outside of isolated unit tests.
  it('lets /v1/feeds/health pass without an API key', async () => {
    const app = makeRealisticApp();
    const res = await app.request('/v1/feeds/health');
    // 200 (not 401). 401 here means the apikey gate captured the path again.
    expect(res.status).toBe(200);
  });

  it('lets /v1/stream/sse reach the session-auth gate (401 unauth, not apikey-401)', async () => {
    const app = makeRealisticApp();
    const res = await app.request('/v1/stream/sse?topics=ticker:hl:BTC');
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    // The session gate returns `{ ok: false, error: 'unauthorized' }`.
    // The apikey gate returns `{ error: { type: 'authentication_error', message } }`.
    // Differentiate: session gate has the `ok` key, apikey gate does not.
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unauthorized');
  });
});

describe('/ws/markets alias', () => {
  /**
   * `/v1/stream/ws` is the legacy path the existing 171 tests + bench script
   * target. `/ws/markets` is the clean public alias NEO + MAZE connect to.
   * Both routes must be registered on the same Hono app via
   * `createRealtimeWsServer(app).registerRoute(app)`. This guard fires if a
   * future refactor drops one of the two registrations.
   */
  it('registers both /v1/stream/ws and /ws/markets handlers', async () => {
    const { createRealtimeWsServer } = await import('./ws-server.js');
    const app = new Hono();
    const ws = createRealtimeWsServer(app);
    ws.registerRoute(app);
    const paths = app.routes.filter((r) => r.method === 'GET').map((r) => r.path);
    expect(paths).toContain('/v1/stream/ws');
    expect(paths).toContain('/ws/markets');
  });
});

describe('SSE sub-budget shed (Codex review 2026-07-16)', () => {
  // The WS path enforces per-user/per-IP budgets in onOpen (ws-server.ts).
  // These specs pin the SSE path to the SAME budgets — without them, one
  // credential shed at the WS cap could pivot to /v1/stream/sse and drain
  // REALTIME_MAX_CLIENTS from a single user/IP.
  function makeAuthApp(): Hono {
    const app = new Hono();
    app.route('/auth', authRoutes);
    app.route('/v1', realtimeRoutes);
    return app;
  }

  afterEach(() => resetRealtimeBudget());

  async function poll(fn: () => boolean, ms = 2_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!fn() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('sheds 503 user_capacity at the per-user cap and releases the global slot', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`sse-user-budget-${Math.random()}@example.com`);
    const { token: session } = await issueToken(user);
    for (let i = 0; i < env.REALTIME_MAX_CONNS_PER_USER; i++) {
      expect(tryAcquireUserSlot(user.id)).toBe(true);
    }
    const before = activeRealtimeClients();
    const res = await app.request('/v1/stream/sse?topics=ticker:hl:BTC', {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'user_capacity' });
    // Reverse-order release: the global slot must not leak on user-shed.
    expect(activeRealtimeClients()).toBe(before);
  });

  it('sheds 503 ip_capacity keyed by the trust-gated resolver and releases user + global slots', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`sse-ip-budget-${Math.random()}@example.com`);
    const { token: session } = await issueToken(user);
    // TRUSTED_PROXY_HOPS=1 (default): clientIp() picks the RIGHTMOST
    // x-forwarded-for entry — the address our own proxy observed. The budget
    // key and the header below must therefore agree.
    const ip = '203.0.113.9';
    for (let i = 0; i < env.REALTIME_MAX_CONNS_PER_IP; i++) {
      expect(tryAcquireIpSlot(ip)).toBe(true);
    }
    const before = activeRealtimeClients();
    const res = await app.request('/v1/stream/sse?topics=ticker:hl:BTC', {
      headers: { authorization: `Bearer ${session}`, 'x-forwarded-for': ip },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'ip_capacity' });
    expect(activeUserSlots(user.id)).toBe(0); // user slot returned
    expect(activeRealtimeClients()).toBe(before); // global slot returned
  });

  it('holds user + IP slots while the stream is open and releases them on disconnect', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`sse-slot-cycle-${Math.random()}@example.com`);
    const { token: session } = await issueToken(user);
    const ip = '203.0.113.77';
    const before = activeRealtimeClients();
    const res = await app.request('/v1/stream/sse?topics=ticker:hl:BTC', {
      headers: { authorization: `Bearer ${session}`, 'x-forwarded-for': ip },
    });
    expect(res.status).toBe(200);
    expect(activeUserSlots(user.id)).toBe(1);
    expect(activeIpSlots(ip)).toBe(1);
    // Tear down the way @hono/node-server does when the client socket drops:
    // cancel the response readable. StreamingApi.abort() fires on consumer
    // cancel, which is the adapter's transport-disconnect path; the next test
    // independently pins the raw request-signal path.
    await res.body?.cancel();
    await poll(() => activeUserSlots(user.id) === 0 && activeIpSlots(ip) === 0);
    expect(activeUserSlots(user.id)).toBe(0);
    expect(activeIpSlots(ip)).toBe(0);
    expect(activeRealtimeClients()).toBe(before); // global slot returned too
  });

  it('releases exactly once when request abort and body cancellation race before ready', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`sse-abort-race-${Math.random()}@example.com`);
    const { token: session } = await issueToken(user);
    const ip = '203.0.113.78';
    const ac = new AbortController();

    // Keep one independent allocation for the same identity. A duplicate
    // cleanup would steal this slot and make the counters fall to zero.
    expect(tryAcquireUserSlot(user.id)).toBe(true);
    expect(tryAcquireIpSlot(ip)).toBe(true);
    const before = activeRealtimeClients();

    const res = await app.request('/v1/stream/sse?topics=ticker:hl:BTC', {
      headers: { authorization: `Bearer ${session}`, 'x-forwarded-for': ip },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(activeUserSlots(user.id)).toBe(2);
    expect(activeIpSlots(ip)).toBe(2);

    // The response body has not been consumed, so the initial SSE write can
    // still be pending when the request signal aborts.
    ac.abort();
    await poll(() => activeUserSlots(user.id) === 1 && activeIpSlots(ip) === 1);
    expect(activeUserSlots(user.id)).toBe(1);
    expect(activeIpSlots(ip)).toBe(1);
    expect(activeRealtimeClients()).toBe(before);

    // A second transport-level notification must be a no-op for this lease.
    await res.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeUserSlots(user.id)).toBe(1);
    expect(activeIpSlots(ip)).toBe(1);
    expect(activeRealtimeClients()).toBe(before);
  });

  it('releases all slots when an event write fails after the stream is ready', async () => {
    const app = makeAuthApp();
    const user = await store.upsertUserByEmail(`sse-write-fail-${Math.random()}@example.com`);
    const { token: session } = await issueToken(user);
    const ip = '203.0.113.79';
    const before = activeRealtimeClients();
    const res = await app.request('/v1/stream/sse?topics=candle:hl:BTC:1m', {
      headers: { authorization: `Bearer ${session}`, 'x-forwarded-for': ip },
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let prelude = '';
    while (!prelude.includes('event: ready')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE ended before the ready frame');
      prelude += decoder.decode(value, { stream: true });
    }
    const writeSpy = vi
      .spyOn(SSEStreamingApi.prototype, 'writeSSE')
      .mockRejectedValueOnce(new Error('forced writer failure'));

    try {
      getHub().publish({
        t: 'candle',
        topic: 'candle:hl:BTC:1m' as Topic,
        ts: Date.now(),
        lastTickAgeMs: 0,
        src: 'hl',
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        v: 5,
        closed: false,
      });
      await poll(() => activeUserSlots(user.id) === 0 && activeIpSlots(ip) === 0);
      expect(activeUserSlots(user.id)).toBe(0);
      expect(activeIpSlots(ip)).toBe(0);
      expect(activeRealtimeClients()).toBe(before);
    } finally {
      writeSpy.mockRestore();
      await reader.cancel();
    }
  });
});

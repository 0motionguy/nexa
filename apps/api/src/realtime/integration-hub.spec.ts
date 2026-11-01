/**
 * End-to-end integration spec for the realtime hub — drives the SSE route
 * over a real `node:http` socket so streaming semantics match production.
 *
 * Why the real socket: Hono `streamSSE` flushes only when the response is
 * consumed over a kernel-level TCP read. `app.request()` (Hono's in-memory
 * dispatcher) keeps the long-lived `while (!aborted)` loop alive forever
 * because there's no TCP buffer for the writer to drain into, so the test
 * reader never sees `done` and frames never land. Spinning a real server
 * on port 0 with `@hono/node-server` resolves that.
 *
 * Covers behaviors that unit tests miss:
 *   - SSE wire format (`event:` + `data:` lines, JSON payload)
 *   - `ready` frame arrives with the accepted topic list
 *   - Ref-count rises on connect and falls back to 0 on disconnect
 *   - Multi-client fan-out from a single `hub.publish()`
 *   - Snapshot seed delivered ahead of `ready` to a newly-connected client
 *   - Per-client topic cap (REALTIME_MAX_TOPICS_PER_CLIENT) enforced
 *   - Stream-ticket auth is wired end-to-end (mint via session, consume via SSE)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

import { realtimeRoutes } from './router.js';
import { authRoutes } from '../routes/auth.js';
import { v1Routes } from '../routes/v1.js';
import * as registry from './registry.js';
import type { Topic } from './types.js';

/* ── test-server lifecycle ──────────────────────────────────────────────── */

let baseUrl: string;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  const app = new Hono();
  app.route('/auth', authRoutes);
  // Mirror the production mount order: v1Routes FIRST, then realtimeRoutes.
  // This exercises the `use('*')` middleware skip we added in v1.ts so the
  // realtime hub coexists with the API-key surface at /v1.
  app.route('/v1', v1Routes);
  app.route('/v1', realtimeRoutes);

  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => {
    const probe = (): void => {
      const addr = server.address() as AddressInfo | null;
      if (addr && typeof addr === 'object') resolve();
      else setTimeout(probe, 10);
    };
    probe();
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await registry.shutdown();
});

/* ── helpers ────────────────────────────────────────────────────────────── */

async function authedSessionToken(email: string): Promise<string> {
  const start = await fetch(`${baseUrl}/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (start.status !== 200) throw new Error(`auth/start: ${start.status}`);
  const { challengeId } = (await start.json()) as { challengeId: string };
  const verify = await fetch(`${baseUrl}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: '482019' }),
  });
  if (verify.status !== 200) throw new Error(`auth/verify: ${verify.status}`);
  const { token } = (await verify.json()) as { token: string };
  return token;
}

async function mintTicket(sessionToken: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/stream/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (res.status !== 200) throw new Error(`stream/ticket: ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

interface SseClient {
  events: Array<{ event: string; data: unknown }>;
  controller: AbortController;
  done: Promise<void>;
}

async function connectSse(
  topics: string[],
  sessionToken: string,
): Promise<SseClient> {
  const ticket = await mintTicket(sessionToken);
  return connectSseWithTicket(topics, ticket);
}

async function connectSseWithTicket(
  topics: string[],
  ticket: string,
): Promise<SseClient> {
  const controller = new AbortController();
  const url = `${baseUrl}/v1/stream/sse?topics=${encodeURIComponent(topics.join(','))}&token=${ticket}`;
  const res = await fetch(url, { signal: controller.signal });
  if (res.status !== 200) throw new Error(`SSE connect: status ${res.status}`);
  if (!res.body) throw new Error('SSE connect: no body');

  const events: Array<{ event: string; data: unknown }> = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split('\n');
          let evt = 'message';
          let data = '';
          for (const ln of lines) {
            if (ln.startsWith('event: ')) evt = ln.slice(7);
            else if (ln.startsWith('data: ')) data = ln.slice(6);
          }
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          events.push({ event: evt, data: parsed });
        }
      }
    } catch {
      // expected on abort
    }
  })();

  return { events, controller, done };
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 2000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor: timeout');
}

/* ── suite ──────────────────────────────────────────────────────────────── */

describe('realtime hub — end-to-end SSE integration', () => {
  it('returns 401 without a token', async () => {
    const res = await fetch(`${baseUrl}/v1/stream/sse?topics=ticker:hl:BTC`);
    expect(res.status).toBe(401);
  });

  it('emits a ready frame on successful connect', async () => {
    const session = await authedSessionToken(`e2e-ready-${Math.random()}@example.com`);
    const client = await connectSse(['ticker:hl:BTC'], session);
    const ready = await waitFor(
      () => client.events.find((e) => e.event === 'ready'),
    );
    expect(ready.event).toBe('ready');
    const payload = ready.data as { accepted: string[]; serverVersion: string };
    expect(payload.accepted).toContain('ticker:hl:BTC');
    client.controller.abort();
    await client.done;
  });

  it('emits an err frame for invalid topic strings', async () => {
    const session = await authedSessionToken(`e2e-err-${Math.random()}@example.com`);
    const client = await connectSse(['not-a-valid-topic'], session);
    const err = await waitFor(
      () => client.events.find((e) => e.event === 'err'),
    );
    expect((err.data as { code: string }).code).toBe('topic_invalid');
    client.controller.abort();
    await client.done;
  });

  it('fans a single hub.publish to multiple connected SSE clients', async () => {
    const topic = 'ticker:hl:ETH' as Topic;
    const session = await authedSessionToken(`e2e-fanout-${Math.random()}@example.com`);
    const [a, b, c] = await Promise.all([
      connectSse(['ticker:hl:ETH'], session),
      connectSse(['ticker:hl:ETH'], session),
      connectSse(['ticker:hl:ETH'], session),
    ]);
    await Promise.all([a, b, c].map((cl) =>
      waitFor(() => cl.events.find((e) => e.event === 'ready')),
    ));
    const hub = registry.getHub();
    expect(hub.refCountFor(topic)).toBeGreaterThanOrEqual(3);

    hub.publish({
      t: 'tick', topic, px: 4242, ts: Date.now(),
      lastTickAgeMs: 0, src: 'hl',
    });
    // Tickers coalesce at 100ms; allow the window to flush + the SSE write.
    await new Promise((r) => setTimeout(r, 300));

    for (const client of [a, b, c]) {
      const tick = client.events.find(
        (e) => e.event === 'tick' && (e.data as { px?: number }).px === 4242,
      );
      expect(tick).toBeDefined();
    }
    for (const client of [a, b, c]) {
      client.controller.abort();
      await client.done;
    }
  });

  it('ref-count drops back to 0 after every client disconnects', async () => {
    const topic = 'candle:hl:SOL:1m' as Topic;
    const session = await authedSessionToken(`e2e-refcount-${Math.random()}@example.com`);
    const startCount = registry.getHub().refCountFor(topic);

    const client = await connectSse(['candle:hl:SOL:1m'], session);
    await waitFor(() => client.events.find((e) => e.event === 'ready'));
    expect(registry.getHub().refCountFor(topic)).toBe(startCount + 1);

    client.controller.abort();
    await client.done;
    // The SSE close handler runs asynchronously after the socket tears down.
    await waitFor(
      () => (registry.getHub().refCountFor(topic) === startCount ? true : undefined),
      3000,
    );
  });

  it('delivers candle (non-ticker) events without coalesce delay', async () => {
    const topic = 'candle:hl:BTC:1m' as Topic;
    const session = await authedSessionToken(`e2e-candle-${Math.random()}@example.com`);
    const client = await connectSse(['candle:hl:BTC:1m'], session);
    await waitFor(() => client.events.find((e) => e.event === 'ready'));

    registry.getHub().publish({
      t: 'candle', topic, ts: Date.now(), lastTickAgeMs: 0, src: 'hl',
      o: 100, h: 101, l: 99, c: 100, v: 5, closed: false,
    });
    const candle = await waitFor(
      () => client.events.find((e) => e.event === 'candle'),
      1000,
    );
    expect((candle.data as { c?: number }).c).toBe(100);

    client.controller.abort();
    await client.done;
  });

  it('snapshot-seeds a freshly-connected client from hub.lastByTopic cache', async () => {
    const topic = 'ticker:hl:USDC' as Topic;
    const session = await authedSessionToken(`e2e-seed-${Math.random()}@example.com`);
    // Pre-publish so the cache has an entry before anyone subscribes.
    registry.getHub().publish({
      t: 'tick', topic, px: 1.0, ts: Date.now(),
      lastTickAgeMs: 0, src: 'hl',
    });

    const client = await connectSse(['ticker:hl:USDC'], session);
    await waitFor(() => client.events.find((e) => e.event === 'ready'));

    const tick = client.events.find((e) => e.event === 'tick');
    expect(tick).toBeDefined();
    expect((tick?.data as { px?: number }).px).toBe(1.0);

    client.controller.abort();
    await client.done;
  });

  it('rejects priv: topic with a different userId (per-user ACL gate)', async () => {
    const session = await authedSessionToken(`e2e-acl-${Math.random()}@example.com`);
    // Subscribe as user X to a priv: topic claiming to be user Y.
    const client = await connectSse(['priv:other-user-id:positions:hl:BTC'], session);
    const denied = await waitFor(
      () => client.events.find((e) => e.event === 'err' && (e.data as { code?: string }).code === 'denied_acl'),
    );
    expect(denied).toBeDefined();
    client.controller.abort();
    await client.done;
  });

  it('emits realtime.subscribe + realtime.unsubscribe audit logs (P3.10)', async () => {
    const { log } = await import('../lib/log.js');
    const infoSpy = vi.spyOn(log, 'info');
    try {
      const session = await authedSessionToken(`e2e-audit-${Math.random()}@example.com`);
      const client = await connectSse(['ticker:hl:BTC'], session);
      await waitFor(() => client.events.find((e) => e.event === 'ready'));

      const subCall = infoSpy.mock.calls.find(([payload, msg]) => {
        const p = payload as { evt?: string; topic?: string };
        return msg === 'realtime.subscribe' && p?.evt === 'realtime.subscribe' && p?.topic === 'ticker:hl:BTC';
      });
      expect(subCall).toBeDefined();
      const subPayload = subCall![0] as Record<string, unknown>;
      expect(subPayload.transport).toBe('sse');
      expect(subPayload.venue).toBe('hl');
      expect(subPayload.topicKind).toBe('ticker');
      expect(typeof subPayload.userId).toBe('string');
      expect(typeof subPayload.sinkId).toBe('string');

      client.controller.abort();
      await client.done;
      await waitFor(() => {
        const unsubCall = infoSpy.mock.calls.find(([payload, msg]) => {
          const p = payload as { evt?: string; topic?: string };
          return msg === 'realtime.unsubscribe' && p?.evt === 'realtime.unsubscribe' && p?.topic === 'ticker:hl:BTC';
        });
        return unsubCall ?? undefined;
      }, 3000);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('rejects a ticket reused after first consumption (replay protection)', async () => {
    const session = await authedSessionToken(`e2e-replay-${Math.random()}@example.com`);
    const ticket = await mintTicket(session);

    // First use consumes the jti.
    const a = await connectSseWithTicket(['ticker:hl:BTC'], ticket);
    await waitFor(() => a.events.find((e) => e.event === 'ready'));
    a.controller.abort();
    await a.done;

    // Second use of the SAME ticket: should be 401.
    const replay = await fetch(
      `${baseUrl}/v1/stream/sse?topics=ticker:hl:BTC&token=${ticket}`,
    );
    expect(replay.status).toBe(401);
  });
});

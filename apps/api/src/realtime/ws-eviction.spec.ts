/**
 * E2E guard for newest-wins per-user eviction (HANDOVER-2026-07-19-RPC-
 * PARITY). Under flaky-reconnect churn — abrupt drop with no FIN, reconnect
 * 10-60s later with a fresh ticket — the per-user budget stayed pinned by
 * half-open predecessors until the keepalive reaper settled a full ping
 * round (~60s). The LIVE reconnect was shed `1013 user_capacity` while dead
 * sockets kept the slots; staging ws-ready collapsed to 75.6%. The fix
 * reaps the user's OLDEST connection synchronously (close 4000
 * 'superseded') and admits the fresh one, so capacity sheds only fire when
 * every held connection is genuinely newer traffic.
 *
 * Real node server on port 0 (same rationale as ws-keepalive.spec.ts):
 * upgrade + close-frame codes only exist on a kernel TCP socket.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The cap must be in process.env BEFORE lib/env.js zod-parses it at module
// load; vi.hoisted runs ahead of the hoisted static imports. Cap 2 keeps the
// churn loop cheap while exercising the same evict-retry path as prod's 8.
vi.hoisted(() => {
  process.env.REALTIME_MAX_CONNS_PER_USER = '2';
});

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';

import { authRoutes } from '../routes/auth.js';
import { createRealtimeWsServer, getActiveWsClientCount } from './ws-server.js';
import * as registry from './registry.js';

/* ── test-server lifecycle ──────────────────────────────────────────────── */

let baseUrl: string;
let wsUrl: string;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  const app = new Hono();
  app.route('/auth', authRoutes);
  // createNodeWebSocket inside the factory is bound to this same `app`;
  // registerRoute must therefore receive the identical instance.
  const handles = createRealtimeWsServer(app);
  handles.registerRoute(app);

  server = serve({ fetch: app.fetch, port: 0 });
  handles.inject(server);

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
  wsUrl = `ws://127.0.0.1:${addr.port}/v1/stream/ws`;
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

function openWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

/** Resolve with the close (code, reason) of a socket. */
function closeOf(client: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    client.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/** Poll `predicate` every 10ms until true or `deadlineMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  deadlineMs: number,
  label: string,
): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > deadlineMs) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ── specs ──────────────────────────────────────────────────────────────── */

describe('WS newest-wins per-user eviction (e2e)', () => {
  it('admits the newest connection past the cap by evicting the oldest (4000 superseded)', async () => {
    const token = await authedSessionToken('ws-evict@example.com');

    const s1 = await openWs(token);
    const s2 = await openWs(token);
    await waitFor(() => getActiveWsClientCount() === 2, 2000, 'two live conns');
    const s1Closed = closeOf(s1);

    // Third connection for the same user: over the cap of 2. Pre-fix this
    // was shed 1013 `user_capacity`; newest-wins must admit it and reap s1.
    const s3 = await openWs(token);
    const evicted = await s1Closed;
    expect(evicted.code).toBe(4000);
    expect(evicted.reason).toBe('superseded');

    await waitFor(() => getActiveWsClientCount() === 2, 2000, 'count settles at cap');
    expect(s2.readyState).toBe(WebSocket.OPEN);
    expect(s3.readyState).toBe(WebSocket.OPEN);

    s2.close();
    s3.close();
    await waitFor(() => getActiveWsClientCount() === 0, 2000, 'all released');
  });

  it('reconnect churn never sheds the fresh connection and never leaks slots', async () => {
    const token = await authedSessionToken('ws-churn@example.com');
    const closeCodes: number[] = [];
    const live: WebSocket[] = [];

    // 6 sequential connects at cap 2 — the shape of the harness flaky-
    // reconnect storm. Every single one must be ADMITTED (open resolves and
    // any eviction hits an older socket); a 1013 anywhere is the regression.
    for (let i = 0; i < 6; i++) {
      const s = await openWs(token);
      void closeOf(s).then(({ code }) => closeCodes.push(code));
      live.push(s);
      await waitFor(
        () => getActiveWsClientCount() === Math.min(i + 1, 2),
        2000,
        `count at cap after connect ${i + 1}`,
      );
    }

    await waitFor(() => closeCodes.length === 4, 2000, 'four oldest evicted');
    expect(closeCodes).toEqual([4000, 4000, 4000, 4000]);
    expect(getActiveWsClientCount()).toBe(2);

    for (const s of live) {
      if (s.readyState === WebSocket.OPEN) s.close();
    }
    await waitFor(() => getActiveWsClientCount() === 0, 2000, 'all released');
  });
});

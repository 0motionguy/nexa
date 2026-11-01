/**
 * E2E guard for the WS keepalive liveness reaper (Codex review 2026-07-16,
 * P2). The old keepalive only `send()`d a JSON beat — on a half-open peer
 * (mobile network drop: no FIN/RST ever arrives) `send()` just queues into
 * the kernel buffer, nothing throws, and the dead socket held its
 * global/user/IP capacity slots until the OS gave up, wedging the per-user
 * cap (REALTIME_MAX_CONNS_PER_USER=8) against reconnect storms. The fix
 * rides RFC 6455 ping/pong: each tick first settles the previous round
 * trip; a peer that missed a full round is `terminate()`d, which fires the
 * close path and releases every slot.
 *
 * The `ws` client's `autoPong: false` (ws >= 8.14) suppresses the
 * protocol-level pong reply while leaving the socket otherwise healthy —
 * the closest userspace simulation of a half-open peer: the server's pings
 * go unanswered exactly as if the peer had vanished mid-flight.
 *
 * Real node server on port 0 (same rationale as integration-hub.spec.ts):
 * upgrade + RFC 6455 control frames only exist on a kernel TCP socket, so
 * `app.request()` can't exercise any of this.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// REALTIME_KEEPALIVE_MS must be in process.env BEFORE lib/env.js zod-parses
// it at module load; vi.hoisted runs ahead of the hoisted static imports.
// 75ms keeps the reap deadline (~2 ticks = 150ms) far inside test timeouts
// while staying coarse enough not to flake on a loaded CI box.
vi.hoisted(() => {
  process.env.REALTIME_KEEPALIVE_MS = '75';
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

function openWs(
  token: string,
  opts: { autoPong: boolean },
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${token}` },
      autoPong: opts.autoPong,
    });
    client.once('open', () => resolve(client));
    client.once('error', reject);
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

const KEEPALIVE_MS = 75;

/* ── specs ──────────────────────────────────────────────────────────────── */

describe('WS keepalive liveness reaper (e2e)', () => {
  it('terminates a peer that never answers protocol pings and releases its slots', async () => {
    const token = await authedSessionToken('ws-reaper@example.com');
    const client = await openWs(token, { autoPong: false });
    expect(getActiveWsClientCount()).toBe(1);

    // Tick 1 (~75ms): ping sent, peerAlive=false. Tick 2 (~150ms): no pong
    // seen -> terminate(). The client observes an abrupt 1006 close. Allow
    // a wide margin (40 ticks) so a busy CI box can't flake this.
    const closeCode = await new Promise<number>((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error('half-open peer was never reaped')),
        KEEPALIVE_MS * 40,
      );
      client.once('close', (code) => {
        clearTimeout(guard);
        resolve(code);
      });
    });
    expect(closeCode).toBe(1006); // terminate() = abnormal closure, no close frame

    // The whole point of the fix: the reap must free capacity slots so the
    // per-user cap can't wedge against reconnects.
    await waitFor(() => getActiveWsClientCount() === 0, 2_000, 'slot release after reap');
  });

  it('keeps a live peer (auto-pong) connected across many keepalive rounds', async () => {
    const token = await authedSessionToken('ws-alive@example.com');
    const client = await openWs(token, { autoPong: true });

    // JSON beat still rides alongside the protocol ping (client-visible
    // latency signal + send-failure teardown path). Capture one to prove
    // the dual mechanism survived the rework.
    const sawJsonBeat = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data)) as { op?: string };
          if (msg.op === 'pong') resolve();
        } catch {
          /* non-JSON frame — ignore */
        }
      });
    });

    // Survive ~6 keepalive rounds — far past the 2-tick reap horizon.
    await new Promise((r) => setTimeout(r, KEEPALIVE_MS * 6));
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(getActiveWsClientCount()).toBe(1);
    await sawJsonBeat;

    client.close(1000);
    await waitFor(() => getActiveWsClientCount() === 0, 2_000, 'slot release after clean close');
  });
});

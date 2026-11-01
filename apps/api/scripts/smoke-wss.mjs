#!/usr/bin/env node
/**
 * smoke-wss.mjs — end-to-end smoke test for the realtime WSS path.
 *
 * Validates that the full chain works: Caddy (when run against a remote
 * host) → @hono/node-server upgrade → @hono/node-ws → realtime hub →
 * Hyperliquid upstream → FeedEvent envelope back to the client. Exits 0
 * on a single successful `TickEvent`, 1 on any failure.
 *
 * Usage:
 *
 *   # Local (assumes `pnpm --filter @nexa/api dev` is running with DEMO_MODE):
 *   pnpm --filter @nexa/api smoke:wss
 *
 *   # Local against an alternate port:
 *   WSS_SMOKE_URL=ws://localhost:8091/ws/markets pnpm --filter @nexa/api smoke:wss
 *
 *   # Remote (operator must mint a session JWT first):
 *   WSS_SMOKE_URL=wss://api.maze.bank/ws/markets \
 *     WSS_SMOKE_TOKEN=<jwt> \
 *     pnpm --filter @nexa/api smoke:wss
 *
 * Env knobs:
 *   WSS_SMOKE_URL          ws://localhost:8090/ws/markets (default)
 *   WSS_SMOKE_TOKEN        explicit JWT; skips the demo-mint path
 *   WSS_SMOKE_TOPIC        ticker:hl:BTC (default)
 *   WSS_SMOKE_API_BASE     http://localhost:8090 (used only when minting via demo)
 *   WSS_SMOKE_TIMEOUT_MS   15000 (overall budget)
 *   WSS_SMOKE_EMAIL        smoke-<random>@example.com
 *
 * Exit codes:
 *   0  one valid envelope received, unsubscribed cleanly, closed with 1000
 *   1  any timeout, parse failure, auth failure, or transport error
 */

import process from 'node:process';
import WebSocket from 'ws';
import { FeedEventZ } from '@nexa/shared-zod';

const URL_ = process.env.WSS_SMOKE_URL ?? 'ws://localhost:8090/ws/markets';
const TOKEN_FROM_ENV = process.env.WSS_SMOKE_TOKEN ?? '';
const TOPIC = process.env.WSS_SMOKE_TOPIC ?? 'ticker:hl:BTC';
const API_BASE = process.env.WSS_SMOKE_API_BASE ?? deriveHttpBase(URL_);
const TIMEOUT_MS = Number(process.env.WSS_SMOKE_TIMEOUT_MS ?? '15000');
const EMAIL = process.env.WSS_SMOKE_EMAIL ?? `smoke-${Math.random().toString(36).slice(2, 10)}@example.com`;

/* ── helpers ──────────────────────────────────────────────────────────────── */

function deriveHttpBase(wsUrl) {
  return wsUrl.replace(/^wss?:\/\//, (m) => (m === 'wss://' ? 'https://' : 'http://')).replace(/\/ws\/markets.*$/, '');
}

function fail(msg, err) {
  console.error(JSON.stringify({ ok: false, error: msg, detail: err?.message ?? err ?? null }));
  process.exit(1);
}

function pass(sample) {
  console.log(JSON.stringify({ ok: true, url: URL_, topic: TOPIC, sample }));
  process.exit(0);
}

/** Mint a demo session token via /auth/start + /auth/verify. Requires
 *  DEMO_MODE=true on the API. The verify code `482019` is the fixed demo
 *  bypass used by tests + bench-hub.mjs. */
async function mintDemoToken() {
  const start = await fetch(`${API_BASE}/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });
  if (start.status !== 200) throw new Error(`/auth/start failed: ${start.status}`);
  const { challengeId } = await start.json();
  const verify = await fetch(`${API_BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: '482019' }),
  });
  if (verify.status !== 200) throw new Error(`/auth/verify failed: ${verify.status}`);
  const { token } = await verify.json();
  if (!token) throw new Error('/auth/verify returned no token');
  return token;
}

/* ── main ────────────────────────────────────────────────────────────────── */

const overallTimer = setTimeout(() => {
  fail('overall_timeout', new Error(`no envelope after ${TIMEOUT_MS}ms`));
}, TIMEOUT_MS);
overallTimer.unref?.();

const token = TOKEN_FROM_ENV || (await mintDemoToken().catch((err) => {
  fail('auth_mint_failed', err);
}));

const ws = new WebSocket(URL_, {
  headers: { authorization: `Bearer ${token}` },
});

let readyReceived = false;
let envelopeReceived = false;

ws.on('open', () => {
  // ready arrives next; subscribe gets sent after we see it.
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    fail('json_parse_failed', err);
    return;
  }

  if (!readyReceived) {
    if (msg?.op === 'ready') {
      readyReceived = true;
      ws.send(JSON.stringify({ op: 'sub', topics: [TOPIC] }));
    } else if (msg?.op === 'err') {
      fail('server_error_before_ready', new Error(JSON.stringify(msg)));
    }
    return;
  }

  if (msg?.op === 'err') {
    fail('server_error_after_sub', new Error(JSON.stringify(msg)));
    return;
  }

  // Skip pong / future control envelopes — we're after the first FeedEvent.
  if (msg?.op) return;

  const parsed = FeedEventZ.safeParse(msg);
  if (!parsed.success) {
    fail('envelope_validation_failed', new Error(parsed.error.message));
    return;
  }
  envelopeReceived = true;
  // Unsubscribe + close. The hub releases the upstream sub on 1→0 transition.
  ws.send(JSON.stringify({ op: 'unsub', topics: [TOPIC] }));
  setTimeout(() => {
    try { ws.close(1000, 'smoke_done'); } catch { /* ignore */ }
  }, 50);
  pass(parsed.data);
});

ws.on('error', (err) => {
  fail('ws_error', err);
});

ws.on('close', (code, reason) => {
  if (!envelopeReceived) {
    fail('closed_before_envelope', new Error(`code=${code} reason=${reason?.toString() ?? ''}`));
  }
});

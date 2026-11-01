/**
 * Sprint 11 Phase 3 — coverage for /ledger. api.spec.ts hits /balance (via
 * /auth/me) and /activity (limit=-1 → 400); this file adds the remaining
 * targets the audit flagged:
 *
 *   GET /ledger/balance          — auth gate + payload
 *   GET /ledger/activity         — auth gate + happy path + invalid_limit (400)
 *   GET /ledger/me               — extended bootstrap shape
 *   GET /ledger/activity/stream  — SSE connect (auth gate via Bearer token, then
 *                                  text/event-stream and a ping frame).
 *
 * Sprint 14 (F011 closeout) — fills the audit residue with:
 *
 *   - /balance + /activity + /me auth-gate symmetry (every route 401s)
 *   - /balance reflects Mirko's seeded fixture values ($4820.40 / $3200)
 *   - /activity default-limit happy path + lower-bound (limit=0 → 400)
 *   - cross-tenant isolation: user A's session must not surface user B's
 *     activity rows, even after B mutates their ledger via /payments/topup
 *
 * SSE is exercised by opening the stream with an AbortController, reading the
 * first ping (the `streamSSE` impl emits before sleeping 15s), then aborting.
 * Without the abort the request would hang for 15s — the testTimeout is 30s.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';

const ORIGINAL_ENV = process.env;

async function loadApp(): Promise<typeof import('../index.js').app> {
  const mod = await import('../index.js');
  return mod.app;
}

async function postJson(
  app: Awaited<ReturnType<typeof loadApp>>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function freshSessionToken(
  app: Awaited<ReturnType<typeof loadApp>>,
): Promise<string> {
  const email = `ledger-test-${randomBytes(4).toString('hex')}@example.com`;
  const start = await postJson(app, '/auth/start', { email });
  const verify = await postJson(app, '/auth/verify', {
    challengeId: start.body['challengeId'] as string,
    code: '482019',
  });
  return verify.body['token'] as string;
}

describe('routes/ledger — /balance + /activity + /me', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '1' };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('GET /ledger/balance rejects requests without a session', async () => {
    const app = await loadApp();
    const res = await app.request('/ledger/balance');
    expect(res.status).toBe(401);
  });

  it('GET /ledger/balance returns the canonical {balUsd, earnUsd, earnApy} payload', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/balance', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(typeof body['balUsd']).toBe('number');
    expect(typeof body['earnUsd']).toBe('number');
    expect(typeof body['earnApy']).toBe('number');
  });

  it('GET /ledger/activity bounds-check the limit query param (>50 → 400)', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/activity?limit=999', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    // F062 — ledger.ts migrated to ApiError; code is in error.message.
    expect(body['error'].message).toBe('invalid_limit');
  });

  it('GET /ledger/me returns the extended bootstrap shape (card + accounts + earn + agents)', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(typeof body['user']?.email).toBe('string');
    expect(typeof body['balance']?.balUsd).toBe('number');
    expect(body['card']?.kind).toBe('DEBIT');
    expect(typeof body['virtualAccounts']?.us?.number).toBe('string');
    expect(typeof body['virtualAccounts']?.eu?.iban).toBe('string');
    expect(body['earn']?.apyBps).toBeNull();
    expect(typeof body['agents']?.count).toBe('number');
  });

  it('GET /ledger/me returns null money identities outside DEMO_MODE without providers', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    delete process.env['GNOSIS_PAY_API_KEY'];
    delete process.env['BRIDGE_API_KEY'];
    vi.resetModules();
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(body['card']).toBeNull();
    expect(body['virtualAccounts']?.us).toBeNull();
    expect(body['virtualAccounts']?.eu).toBeNull();
  });

  /* ── Sprint 14 (F011 closeout) — auth-gate symmetry + fixture values + isolation ── */

  it('GET /ledger/activity rejects requests without a session', async () => {
    const app = await loadApp();
    const res = await app.request('/ledger/activity');
    expect(res.status).toBe(401);
  });

  it('GET /ledger/me rejects requests without a session', async () => {
    const app = await loadApp();
    const res = await app.request('/ledger/me');
    expect(res.status).toBe(401);
  });

  it('GET /ledger/balance surfaces the Mirko fixture seed ($4,820.40 balance / $3,200 earn)', async () => {
    // The in-memory seed (apps/api/src/store/core/in-memory-state.ts) hard-codes
    // these values for every freshly-created user. The contract is reinforced
    // here so a future seed-tweak that changes the demo show-up amount has to
    // update this test on the way through.
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/balance', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['balUsd']).toBe(4820.4);
    expect(body['earnUsd']).toBe(3200);
  });

  it('GET /ledger/activity returns the seeded activity rows at the default limit', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/activity', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    const rows = body['activity'] as Array<Record<string, any>>;
    expect(Array.isArray(rows)).toBe(true);
    // The in-memory seed inserts real account/agent rows, but no fake card spend.
    // We assert ≥1 to stay resilient if the seed grows, but the rows must
    // carry the canonical shape ({id, n, s, a, k, at}).
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(typeof rows[0]?.['id']).toBe('string');
    expect(typeof rows[0]?.['n']).toBe('string');
    expect(typeof rows[0]?.['a']).toBe('string');
    expect(typeof rows[0]?.['k']).toBe('string');
  });

  it('GET /ledger/activity?limit=N clamps the returned page to N rows', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/activity?limit=1', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect((body['activity'] as unknown[]).length).toBe(1);
  });

  it('GET /ledger/activity?limit=0 rejects at the lower bound with invalid_limit (400)', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/ledger/activity?limit=0', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body['error'].message).toBe('invalid_limit');
  });

  it('GET /ledger/activity is tenant-scoped — user B mutations do not surface in user A', async () => {
    // F011 closeout — cross-tenant isolation. User B tops up via /payments/topup
    // (which calls pushActivity on B). User A then reads /ledger/activity and
    // must NOT see B's topup row.
    const app = await loadApp();
    const tokenA = await freshSessionToken(app);
    const tokenB = await freshSessionToken(app);

    // Drive a topup on B so a new activity row lands on B's ledger.
    const topup = await postJson(
      app,
      '/payments/topup',
      { amountUsd: 50, label: 'B-only-marker-row' },
      { authorization: `Bearer ${tokenB}` },
    );
    expect(topup.status).toBe(200);

    // Read A's ledger — none of the rows may carry B's marker label, and
    // the balance must still be the untouched seed ($4820.40).
    const aActivity = await app.request('/ledger/activity?limit=50', {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(aActivity.status).toBe(200);
    const aBody = (await aActivity.json()) as Record<string, any>;
    const aRows = aBody['activity'] as Array<Record<string, any>>;
    const leaked = aRows.find((row) =>
      String(row['n'] ?? '').includes('B-only-marker-row'),
    );
    expect(leaked).toBeUndefined();

    const aBalance = await app.request('/ledger/balance', {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const aBalanceBody = (await aBalance.json()) as Record<string, any>;
    expect(aBalanceBody['balUsd']).toBe(4820.4);

    // Sanity: B's own ledger DID record the topup amount on top of the seed.
    const bBalance = await app.request('/ledger/balance', {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const bBalanceBody = (await bBalance.json()) as Record<string, any>;
    expect(bBalanceBody['balUsd']).toBe(4820.4 + 50);
  });
});

describe('routes/ledger — /activity/stream (SSE)', () => {
  let server: ServerType;
  let base: string;

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    process.env.REALTIME_HUB_V1 = '1';
    vi.resetModules();
    const app = await loadApp();
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    server?.close();
    process.env = ORIGINAL_ENV;
  });

  it('rejects connections without a session token → 401', async () => {
    const res = await fetch(`${base}/ledger/activity/stream`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('opens an SSE stream when a valid token is supplied via the Authorization header', async () => {
    // We cannot reuse the in-app /auth flow here (SSE needs the real server),
    // so go via fetch against the just-booted server.
    const email = `ledger-sse-${randomBytes(4).toString('hex')}@example.com`;
    const startRes = await fetch(`${base}/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const startBody = (await startRes.json()) as Record<string, any>;
    const verifyRes = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: startBody['challengeId'], code: '482019' }),
    });
    const verifyBody = (await verifyRes.json()) as Record<string, any>;
    const token = verifyBody['token'] as string;
    expect(token).toBeTruthy();

    const controller = new AbortController();
    const res = await fetch(`${base}/ledger/activity/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');

    // Read the first frame, then bail — streamSSE emits a 'ping' before its
    // 15s sleep so this resolves quickly.
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    if (reader) {
      const first = await reader.read();
      const decoded = new TextDecoder().decode(first.value ?? new Uint8Array());
      expect(decoded).toContain('event: ping');
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // already aborted
      }
    }
  });

  it('keeps query-token stream auth as a compatibility fallback', async () => {
    const email = `ledger-sse-fallback-${randomBytes(4).toString('hex')}@example.com`;
    const startRes = await fetch(`${base}/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const startBody = (await startRes.json()) as Record<string, any>;
    const verifyRes = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: startBody['challengeId'], code: '482019' }),
    });
    const verifyBody = (await verifyRes.json()) as Record<string, any>;
    const token = verifyBody['token'] as string;

    const controller = new AbortController();
    const res = await fetch(
      `${base}/ledger/activity/stream?token=${encodeURIComponent(token)}`,
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);
    controller.abort();
    await res.body?.cancel().catch(() => {
      // already aborted
    });
  });

  it('opens an SSE stream when a short-lived stream ticket is supplied via query token', async () => {
    const email = `ledger-sse-ticket-${randomBytes(4).toString('hex')}@example.com`;
    const startRes = await fetch(`${base}/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const startBody = (await startRes.json()) as Record<string, any>;
    const verifyRes = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: startBody['challengeId'], code: '482019' }),
    });
    const verifyBody = (await verifyRes.json()) as Record<string, any>;
    const token = verifyBody['token'] as string;
    const ticketRes = await fetch(`${base}/v1/stream/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const ticketBody = (await ticketRes.json()) as Record<string, any>;

    const controller = new AbortController();
    const url = `${base}/ledger/activity/stream?token=${encodeURIComponent(ticketBody['token'] as string)}`;
    const res = await fetch(url, { signal: controller.signal });
    expect(res.status).toBe(200);
    controller.abort();
    await res.body?.cancel().catch(() => {
      // already aborted
    });

    const replay = await fetch(url);
    expect(replay.status).toBe(401);
    await replay.body?.cancel();
  });
});

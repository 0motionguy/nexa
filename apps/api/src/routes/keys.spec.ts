/**
 * Sprint 11 Phase 3 — coverage for /keys. v1.spec.ts indirectly exercises
 * createApiKey via the store (it seeds a sk_test_ to drive the /v1 surface);
 * this file exercises the HTTP layer:
 *
 *   POST   /keys     — secret returned EXACTLY once, prefix matches livemode
 *   GET    /keys     — returns the list-envelope with masked entries (no secret)
 *   DELETE /keys/:id — Sprint 12 Phase 0: idempotent. Both InMemory and
 *                       Postgres impls return null for unknown ids and the row
 *                       for owned ids (Stripe/Twilio semantics). The route
 *                       always answers 200 {ok:true, revoked:<bool>} — re-
 *                       deleting an unknown id or a previously-revoked key
 *                       never 500s.
 *
 * Sprint 14 (F011 closeout) — fills the audit residue with:
 *
 *   - POST + DELETE auth-gate symmetry (GET was already covered; the
 *     keyRoutes.use('*', requireSession) line means every method must 401)
 *   - POST /keys with omitted livemode → ApiKeyCreateInput defaults to true
 *   - GET /keys empty-state (a fresh user with no keys gets data:[])
 *   - GET /keys listing two keys at once (newest-first, both masked)
 *   - cross-tenant DELETE: user A cannot revoke user B's key — the route
 *     reports revoked:false (idempotent unknown-id path) and the key stays
 *     live in B's list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

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
  const email = `keys-test-${randomBytes(4).toString('hex')}@example.com`;
  const start = await postJson(app, '/auth/start', { email });
  const verify = await postJson(app, '/auth/verify', {
    challengeId: start.body['challengeId'] as string,
    code: '482019',
  });
  return verify.body['token'] as string;
}

describe('routes/keys', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('GET /keys rejects requests without a session (401)', async () => {
    const app = await loadApp();
    const res = await app.request('/keys');
    expect(res.status).toBe(401);
  });

  it('POST /keys returns the raw secret EXACTLY once, with the right prefix', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const live = await postJson(app, '/keys', { label: 'live key', livemode: true }, auth);
    expect(live.status).toBe(201);
    expect(typeof live.body['secret']).toBe('string');
    expect((live.body['secret'] as string).startsWith('sk_live_')).toBe(true);
    expect(live.body['prefix']).toBe('sk_live');
    expect(typeof live.body['last4']).toBe('string');

    const test = await postJson(app, '/keys', { label: 'test key', livemode: false }, auth);
    expect(test.status).toBe(201);
    expect((test.body['secret'] as string).startsWith('sk_test_')).toBe(true);
  });

  it('GET /keys returns a {object:"list", data:[…]} envelope WITHOUT the secret', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const created = await postJson(app, '/keys', { label: 'shown', livemode: true }, auth);
    const id = created.body['id'] as string;

    const list = await app.request('/keys', { headers: auth });
    expect(list.status).toBe(200);
    const body = (await list.json()) as Record<string, any>;
    expect(body['object']).toBe('list');
    const rows = body['data'] as Array<Record<string, any>>;
    const found = rows.find((row) => row['id'] === id);
    expect(found).toBeTruthy();
    // The masked projection must NOT carry the raw secret.
    expect(found && 'secret' in found).toBe(false);
    expect(found?.['last4']).toBeTruthy();
  });

  it('DELETE /keys/:id revokes an owned key (200 ok:true)', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(app, '/keys', { label: 'to-revoke', livemode: false }, auth);
    const id = created.body['id'] as string;

    const res = await app.request(`/keys/${id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(body['revoked']).toBe(true);

    // The list-projection still includes the row but the store has set
    // revokedAt on it (covered by v1.spec.ts via secret rejection).
  });

  it('DELETE /keys/:id returns 200 {ok:true, revoked:false} for an unknown id (Stripe/Twilio idempotency)', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    // No key was created — the id is plausible-looking but unknown to the store.
    const res = await app.request(`/keys/key_${randomBytes(8).toString('hex')}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(body['revoked']).toBe(false);
  });

  it('DELETE /keys/:id is idempotent — re-deleting an already-revoked key still 200 {ok:true, revoked:true}', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(app, '/keys', { label: 'twice', livemode: false }, auth);
    const id = created.body['id'] as string;

    const first = await app.request(`/keys/${id}`, { method: 'DELETE', headers: auth });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, any>;
    expect(firstBody['revoked']).toBe(true);

    // Re-delete the same id — store still resolves the row (revokedAt unchanged)
    // and the route reports revoked:true. No 500.
    const second = await app.request(`/keys/${id}`, { method: 'DELETE', headers: auth });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, any>;
    expect(secondBody['ok']).toBe(true);
    expect(secondBody['revoked']).toBe(true);
  });

  /* ── Sprint 14 (F011 closeout) — auth-gate symmetry + cross-tenant ── */

  it('POST /keys rejects requests without a session (401)', async () => {
    const app = await loadApp();
    const res = await app.request('/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'nope', livemode: false }),
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /keys/:id rejects requests without a session (401)', async () => {
    const app = await loadApp();
    const res = await app.request('/keys/00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('POST /keys defaults livemode to true when the field is omitted', async () => {
    // ApiKeyCreateInput sets `livemode: z.boolean().default(true)` in
    // shared-zod; the client may omit it and still receive an sk_live_ key.
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const created = await postJson(app, '/keys', { label: 'default-mode' }, auth);
    expect(created.status).toBe(201);
    expect(created.body['prefix']).toBe('sk_live');
    expect((created.body['secret'] as string).startsWith('sk_live_')).toBe(true);
    expect(created.body['livemode']).toBe(true);
  });

  it('GET /keys returns an empty list-envelope for a brand-new user with no keys', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const list = await app.request('/keys', { headers: auth });
    expect(list.status).toBe(200);
    const body = (await list.json()) as Record<string, any>;
    expect(body['object']).toBe('list');
    expect(Array.isArray(body['data'])).toBe(true);
    expect((body['data'] as unknown[]).length).toBe(0);
  });

  it('GET /keys lists multiple keys at once, newest first, every row masked', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const first = await postJson(app, '/keys', { label: 'older', livemode: false }, auth);
    // Force a real-clock gap so createdAt sort is unambiguous on Windows
    // (the in-memory impl orders by ISO createdAt; same-millisecond writes can
    // tie, which makes the newest-first assertion flaky).
    await new Promise((r) => setTimeout(r, 5));
    const second = await postJson(app, '/keys', { label: 'newer', livemode: true }, auth);

    const list = await app.request('/keys', { headers: auth });
    const body = (await list.json()) as Record<string, any>;
    const rows = body['data'] as Array<Record<string, any>>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Ordering: newest createdAt at the head of the list.
    const firstIdx = rows.findIndex((r) => r['id'] === first.body['id']);
    const secondIdx = rows.findIndex((r) => r['id'] === second.body['id']);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeLessThan(firstIdx);
    // No row may carry the raw secret.
    for (const row of rows) {
      expect('secret' in row).toBe(false);
      expect(typeof row['last4']).toBe('string');
    }
  });

  it('DELETE /keys/:id is tenant-scoped — user A cannot revoke user B\'s key', async () => {
    // F011 closeout — cross-tenant DELETE. The store's revokeApiKey only
    // returns the row when sellerId matches u.id; otherwise null. The route
    // turns null into 200 {ok:true, revoked:false} (the same shape as an
    // unknown id), so A receives a benign idempotent response and B's key
    // stays live in B's list.
    const app = await loadApp();
    const tokenA = await freshSessionToken(app);
    const tokenB = await freshSessionToken(app);

    // B creates a key.
    const createdByB = await postJson(
      app,
      '/keys',
      { label: 'B-owned', livemode: false },
      { authorization: `Bearer ${tokenB}` },
    );
    expect(createdByB.status).toBe(201);
    const bKeyId = createdByB.body['id'] as string;

    // A attempts to delete it.
    const crossDelete = await app.request(`/keys/${bKeyId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(crossDelete.status).toBe(200);
    const crossBody = (await crossDelete.json()) as Record<string, any>;
    expect(crossBody['ok']).toBe(true);
    expect(crossBody['revoked']).toBe(false);

    // B's key is still listed and still live (revokedAt is null).
    const bList = await app.request('/keys', {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const bBody = (await bList.json()) as Record<string, any>;
    const bRows = bBody['data'] as Array<Record<string, any>>;
    const stillThere = bRows.find((row) => row['id'] === bKeyId);
    expect(stillThere).toBeTruthy();
    expect(stillThere?.['revokedAt']).toBeNull();
  });
});

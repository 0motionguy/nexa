/**
 * Sprint 11 Phase 3 — route-level coverage for /kyc. Phase 0 added the
 * verifyWebhook freshness gate at `lib/kyc.spec.ts`; this file exercises the
 * three HTTP entries:
 *
 *   POST /kyc/start    (session) — issues an SDK token, flips status to pending
 *   GET  /kyc/status   (session) — current KYC state for the signed-in user
 *   POST /kyc/webhook  (PUBLIC)  — Sumsub callback; signature gate + parse
 *
 * Demo mode is the only viable path here — live mode requires a Sumsub
 * tenant. The webhook signature path is covered with a real HMAC over the
 * raw body so the verifier (which timing-safe-compares) accepts.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  email = `kyc-test-${randomBytes(4).toString('hex')}@example.com`,
): Promise<{ token: string; email: string }> {
  const start = await postJson(app, '/auth/start', { email });
  const verify = await postJson(app, '/auth/verify', {
    challengeId: start.body['challengeId'] as string,
    code: '482019',
  });
  return { token: verify.body['token'] as string, email };
}

describe('routes/kyc — /start (demo)', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    // Force demo path — guarantees no outbound call to Sumsub.
    delete process.env['SUMSUB_APP_TOKEN'];
    delete process.env['SUMSUB_SECRET_KEY'];
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('rejects requests without a session (401)', async () => {
    const app = await loadApp();
    const { status } = await postJson(app, '/kyc/start', {});
    expect(status).toBe(401);
  });

  it('returns a synthetic demo token + applicantId + demo:true', async () => {
    const app = await loadApp();
    const { token } = await freshSessionToken(app);
    const { status, body } = await postJson(
      app,
      '/kyc/start',
      {},
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(typeof body['token']).toBe('string');
    expect((body['token'] as string).startsWith('sumsub_demo_')).toBe(true);
    expect(typeof body['applicantId']).toBe('string');
    expect(body['demo']).toBe(true);
  });
});

describe('routes/kyc — /status', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns the current kycStatus for the signed-in user', async () => {
    const app = await loadApp();
    const { token } = await freshSessionToken(app);
    const res = await app.request('/kyc/status', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    // Seeded users start at 'verified'; once /kyc/start runs we flip to pending.
    expect(['none', 'pending', 'verified', 'failed']).toContain(body['kycStatus']);
  });
});

describe('routes/kyc — /webhook signature gate', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('without SUMSUB_SECRET_KEY (pure demo) accepts the payload', async () => {
    delete process.env['SUMSUB_APP_TOKEN'];
    delete process.env['SUMSUB_SECRET_KEY'];
    const app = await loadApp();
    const res = await app.request('/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'applicantReviewed', externalUserId: 'noop' }),
    });
    expect(res.status).toBe(200);
  });

  it('with SUMSUB_SECRET_KEY set, an unsigned request is rejected (400)', async () => {
    process.env['SUMSUB_APP_TOKEN'] = 'sumsub_test_token';
    process.env['SUMSUB_SECRET_KEY'] = 'whsec_kyc_route_test_xyz';
    const app = await loadApp();
    const res = await app.request('/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'applicantReviewed', externalUserId: 'noop' }),
    });
    expect(res.status).toBe(400);
    // F062 — error envelope check: code in error.message per ApiError migration.
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(false);
    expect(body['error']?.message).toBe('bad_signature');
  });

  it('with SUMSUB_SECRET_KEY set, a correctly-signed fresh request is accepted (200)', async () => {
    const SECRET = 'whsec_kyc_route_test_xyz';
    process.env['SUMSUB_APP_TOKEN'] = 'sumsub_test_token';
    process.env['SUMSUB_SECRET_KEY'] = SECRET;
    process.env['WEBHOOK_FRESHNESS_WINDOW_SECONDS'] = '300';
    const app = await loadApp();

    // Use a body for a non-existent externalUserId so the handler short-circuits
    // after parseReviewEvent (no store mutation needed).
    const body = JSON.stringify({
      type: 'applicantReviewed',
      externalUserId: 'not-a-real-user-id',
      reviewResult: { reviewAnswer: 'GREEN' },
    });
    const ts = Math.floor(Date.now() / 1000);
    const hex = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    const sig = `t=${ts},v1=${hex}`;

    const res = await app.request('/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Payload-Digest': sig },
      body,
    });
    expect(res.status).toBe(200);
  });
});

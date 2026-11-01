/**
 * F011 — coverage for the payments surface. Routes:
 *
 *   POST /payments/send         — money out (or claim escrow for unknown email)
 *   POST /payments/request-link — generate a one-time pay-me URL
 *   POST /payments/topup        — credit balance (manual)
 *
 * Demo mode only. PolicyError → ApiError migration tested via the
 * insufficient_funds path which exercises `error.details.policyCode`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

async function loadApp() {
  const mod = await import('../index.js');
  return mod.app;
}

async function postJson(app: Awaited<ReturnType<typeof loadApp>>, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function authedToken(app: Awaited<ReturnType<typeof loadApp>>, email: string): Promise<string> {
  const start = await postJson(app, '/auth/start', { email });
  const verify = await postJson(app, '/auth/verify', {
    challengeId: start.body['challengeId'],
    code: '482019',
  });
  return verify.body['token'] as string;
}

describe('routes/payments', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('rejects /send without a session', async () => {
    const app = await loadApp();
    const { status } = await postJson(app, '/payments/send', { amountUsd: 10, to: 'x@y.co' });
    expect(status).toBe(401);
  });

  it('/send to an unknown email creates a claim escrow', async () => {
    process.env = { ...ORIGINAL_ENV, CLAIM_LINK_BASE_URL: 'https://claim.test/claim' };
    const app = await loadApp();
    const token = await authedToken(app, 'alice@test.co');

    const { status, body } = await postJson(
      app,
      '/payments/send',
      { amountUsd: 5, to: 'unknown-recipient@external.test' },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(body['claim']).toBe(true);
    expect(typeof body['claimSlug']).toBe('string');
    expect(body['claimUrl']).toBe(`https://claim.test/claim/${body['claimSlug']}`);
    expect(typeof body['activityId']).toBe('string');
  });

  it('/send requires an Idempotency-Key outside demo mode', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const app = await loadApp();
    const token = await authedToken(app, 'send-live-no-idem@test.co');

    const { status, body } = await postJson(
      app,
      '/payments/send',
      { amountUsd: 5, to: 'recipient@external.test' },
      { authorization: `Bearer ${token}` },
    );

    expect(status).toBe(400);
    expect(body['error']?.message).toBe('idempotency_key_required');
  });

  it('/send replays an Idempotency-Key without a second debit', async () => {
    process.env = { ...ORIGINAL_ENV, CLAIM_LINK_BASE_URL: 'https://claim.test/claim' };
    const app = await loadApp();
    const token = await authedToken(app, 'send-idem@test.co');
    const headers = { authorization: `Bearer ${token}`, 'Idempotency-Key': 'send-idem-1' };

    const first = await postJson(app, '/payments/send', { amountUsd: 5, to: 'idem-recipient@external.test' }, headers);
    const replay = await postJson(app, '/payments/send', { amountUsd: 5, to: 'idem-recipient@external.test' }, headers);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body['activityId']).toBe(first.body['activityId']);
    expect(replay.body['claimSlug']).toBe(first.body['claimSlug']);
    expect(replay.body['balUsd']).toBe(first.body['balUsd']);
  });

  it('/send rejects Idempotency-Key replay with a different payload', async () => {
    const app = await loadApp();
    const token = await authedToken(app, 'send-idem-conflict@test.co');
    const headers = { authorization: `Bearer ${token}`, 'Idempotency-Key': 'send-idem-conflict-1' };

    await postJson(app, '/payments/send', { amountUsd: 5, to: 'first@external.test' }, headers);
    const replay = await postJson(app, '/payments/send', { amountUsd: 6, to: 'first@external.test' }, headers);

    expect(replay.status).toBe(409);
    expect(replay.body['error']?.message).toBe('idempotency_key_reused');
  });

  it('/send with insufficient balance surfaces PolicyError as ApiError shape', async () => {
    const app = await loadApp();
    const token = await authedToken(app, 'broke@test.co');

    // Demo user starts at $4820.40; 50_000 is over balance but under the
    // 99999 schema cap so we hit the PolicyError path, not Zod.
    const { status, body } = await postJson(
      app,
      '/payments/send',
      { amountUsd: 50_000, to: 'someone@external.test' },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(400);
    // F062 — payments.ts is the exemplar migrated route; error shape carries
    // the policy code in error.details.policyCode.
    expect(body['error']?.details?.policyCode).toBe('insufficient_funds');
  });

  it('/send rejects malformed body at Zod boundary', async () => {
    const app = await loadApp();
    const token = await authedToken(app, 'val@test.co');

    const { status } = await postJson(
      app,
      '/payments/send',
      { amountUsd: -5, to: '' },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(400);
  });

  it('/request-link returns a URL with the configured PAY_LINK_BASE_URL prefix', async () => {
    const app = await loadApp();
    const token = await authedToken(app, 'req@test.co');

    const { status, body } = await postJson(
      app,
      '/payments/request-link',
      { amountUsd: 25, note: 'coffee' },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(typeof body['url']).toBe('string');
    expect(body['amountUsd']).toBe(25);
    expect(body['note']).toBe('coffee');
    expect(body['oneTime']).toBe(true);
  });

  it('/topup credits the user balance', async () => {
    const app = await loadApp();
    const token = await authedToken(app, 'topup@test.co');

    const before = await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } });
    const beforeBody = (await before.json()) as { balance: { balUsd: number } };
    const beforeBal = beforeBody.balance.balUsd;

    const { status, body } = await postJson(
      app,
      '/payments/topup',
      { amountUsd: 100, label: 'manual' },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(body['balUsd']).toBe(beforeBal + 100);
  });

  it('/topup is unavailable outside demo mode', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const app = await loadApp();
    const token = await authedToken(app, 'topup-prod@test.co');

    const { status, body } = await postJson(
      app,
      '/payments/topup',
      { amountUsd: 100, label: 'manual' },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(403);
    expect(body['ok']).toBe(false);
    expect(body['error']?.message).toBe('demo_only_endpoint');
  });
});

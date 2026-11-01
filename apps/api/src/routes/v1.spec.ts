/**
 * /v1 public REST API — API-key auth, sandbox scoping, idempotency.
 *
 * Drives the Hono app via app.fetch (no raw socket needed here — unlike the MCP
 * transport in api.spec.ts) and seeds directly through the imported store: a
 * fresh user + a sk_test_ key, so every call below runs in sandbox mode.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { store } from '../store/index.js';

let secret = '';

async function api(
  path: string,
  init?: RequestInit & { auth?: boolean | string },
): Promise<{ status: number; body: any }> {
  const auth = init?.auth;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (auth === undefined || auth === true) headers['authorization'] = `Bearer ${secret}`;
  else if (typeof auth === 'string') headers['authorization'] = `Bearer ${auth}`;
  const res = await app.fetch(
    new Request(`http://local${path}`, { ...init, headers }),
  );
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const u = await store.upsertUserByEmail('dev@test.co');
  const k = await store.createApiKey(u, 'test', false);
  secret = k.secret;
});

describe('/v1 auth', () => {
  it('rejects a missing key', async () => {
    const { status, body } = await api('/v1/balance', { auth: false });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('rejects a garbage key', async () => {
    const { status, body } = await api('/v1/balance', { auth: 'sk_test_not_a_real_key' });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('rejects a non-sk_ bearer', async () => {
    const { status } = await api('/v1/balance', { auth: 'Bearer-but-wrong' });
    expect(status).toBe(401);
  });
});

describe('/v1 offers (sandbox)', () => {
  let createdId = '';

  it('POST /v1/offers creates a sandbox offer with a checkout url', async () => {
    const { status, body } = await api('/v1/offers', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test offer', amountUsd: 12.5 }),
    });
    expect(status).toBe(201);
    expect(body.livemode).toBe(false);
    expect(body.checkoutUrl).toContain(body.id);
    expect(body.title).toBe('Test offer');
    createdId = body.id;
  });

  it('GET /v1/offers lists it under {object:"list"}', async () => {
    const { status, body } = await api('/v1/offers');
    expect(status).toBe(200);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.map((o: { id: string }) => o.id)).toContain(createdId);
    // sandbox scope: every returned offer is test-mode
    expect(body.data.every((o: { livemode: boolean }) => o.livemode === false)).toBe(true);
  });
});

describe('/v1 balance', () => {
  it('GET /v1/balance reports the sandbox mode', async () => {
    const { status, body } = await api('/v1/balance');
    expect(status).toBe(200);
    expect(body.livemode).toBe(false);
    expect(body.available.currency).toBe('USD');
    expect(body.available.amount).toMatch(/^\d+\.\d{2}$/);
  });
});

describe('/v1 idempotency', () => {
  it('a repeated Idempotency-Key returns the same offer id', async () => {
    const key = `idem-${Date.now()}`;
    const first = await api('/v1/offers', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ title: 'Idempotent offer', amountUsd: 5 }),
    });
    const second = await api('/v1/offers', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ title: 'Idempotent offer', amountUsd: 5 }),
    });
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });
});

/**
 * Sprint 3 — sub-accounts + payouts + offer splits. Runs against a sk_live key
 * (livemode true) so balances are real: payouts debit balUsd and a sub-account
 * split credit lands on balUsd, both observable via GET /v1/balance and
 * GET /v1/sub-accounts/:id.
 */
describe('/v1 sub-accounts + payouts (live)', () => {
  let liveKey = '';

  async function liveApi(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    return api(path, { ...init, auth: liveKey });
  }

  beforeAll(async () => {
    const u = await store.upsertUserByEmail('live-seller@test.co');
    const k = await store.createApiKey(u, 'live', true);
    liveKey = k.secret;
  });

  it('POST /v1/sub-accounts creates one (201) and GET returns it', async () => {
    const created = await liveApi('/v1/sub-accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Crew member' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Crew member');
    expect(created.body.balUsd).toBe(0);

    const fetched = await liveApi(`/v1/sub-accounts/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
  });

  it('POST /v1/payouts lowers the available balance by the amount', async () => {
    const before = await liveApi('/v1/balance');
    const startAvail = Number(before.body.available.amount);

    const payout = await liveApi('/v1/payouts', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'payout-success-1' },
      body: JSON.stringify({ amountUsd: 100, destination: 'dev@crew.io' }),
    });
    expect(payout.status).toBe(201);
    expect(payout.body.amountUsd).toBe(100);
    expect(payout.body.status).toBe('paid');

    const after = await liveApi('/v1/balance');
    expect(Number(after.body.available.amount)).toBeCloseTo(startAvail - 100, 2);

    const list = await liveApi('/v1/payouts');
    expect(list.body.object).toBe('list');
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(payout.body.id);
  });

  it('POST /v1/payouts requires an Idempotency-Key for live keys', async () => {
    const { status, body } = await liveApi('/v1/payouts', {
      method: 'POST',
      body: JSON.stringify({ amountUsd: 10, destination: 'dev@crew.io' }),
    });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toBe('idempotency_key_required');
  });

  it('POST /v1/payouts over the balance → 402 insufficient_funds', async () => {
    const { status, body } = await liveApi('/v1/payouts', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'payout-insufficient-1' },
      body: JSON.stringify({ amountUsd: 50000, destination: 'dev@crew.io' }),
    });
    expect(status).toBe(402);
    expect(body.error.type).toBe('insufficient_funds');
  });

  it('POST /v1/payouts rejects bank method instead of marking it paid locally', async () => {
    const before = await liveApi('/v1/balance');
    const startAvail = Number(before.body.available.amount);

    const { status, body } = await liveApi('/v1/payouts', {
      method: 'POST',
      body: JSON.stringify({ amountUsd: 25, destination: 'bank-account-1', method: 'bank' }),
    });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');

    const after = await liveApi('/v1/balance');
    expect(Number(after.body.available.amount)).toBeCloseTo(startAvail, 2);
  });

  it('an offer split crediting a sub-account 50% shows up on GET /v1/sub-accounts/:id after a pay', async () => {
    const sub = await liveApi('/v1/sub-accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Split target' }),
    });
    expect(sub.status).toBe(201);

    const offer = await liveApi('/v1/offers', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Split sale',
        amountUsd: 80,
        splits: [{ subAccountId: sub.body.id, percent: 50 }],
      }),
    });
    expect(offer.status).toBe(201);
    expect(offer.body.splits).toHaveLength(1);

    // Public checkout pay (no auth header) settles the sale and runs the split.
    const paid = await api(`/checkout/${offer.body.id}/pay`, {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ buyerEmail: 'buyer@x.com' }),
    });
    expect(paid.status).toBe(200);
    expect(paid.body.ok).toBe(true);

    const after = await liveApi(`/v1/sub-accounts/${sub.body.id}`);
    expect(after.body.balUsd).toBeCloseTo(40, 2); // 50% of $80
  });

  it('an offer whose splits sum > 100 → 400', async () => {
    const { status, body } = await liveApi('/v1/offers', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Over-split',
        amountUsd: 50,
        splits: [
          { email: 'a@crew.io', percent: 60 },
          { email: 'b@crew.io', percent: 60 },
        ],
      }),
    });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toBe('split percentages exceed 100');
  });
});

/**
 * Sprint 4 — subscriptions lifecycle (live). A `subscription`-type offer paid via
 * the public checkout creates an active Subscription; renew simulates a billing
 * cycle (advances currentPeriodEnd + credits the seller, observable via
 * GET /v1/balance); cancel flips status; a renew after cancel is a 409.
 */
describe('/v1 subscriptions (live)', () => {
  let liveKey = '';
  let subId = '';
  let firstPeriodEnd = '';

  async function liveApi(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    return api(path, { ...init, auth: liveKey });
  }

  beforeAll(async () => {
    const u = await store.upsertUserByEmail('sub-seller@test.co');
    const k = await store.createApiKey(u, 'live', true);
    liveKey = k.secret;
  });

  it('a paid subscription offer shows up as active under GET /v1/subscriptions', async () => {
    const offer = await liveApi('/v1/offers', {
      method: 'POST',
      body: JSON.stringify({ title: 'Pro plan', amountUsd: 20, type: 'subscription' }),
    });
    expect(offer.status).toBe(201);
    expect(offer.body.type).toBe('subscription');

    // Public checkout pay (no auth) settles the first charge and opens the subscription.
    const paid = await api(`/checkout/${offer.body.id}/pay`, {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ buyerEmail: 'subscriber@x.com' }),
    });
    expect(paid.status).toBe(200);
    expect(paid.body.ok).toBe(true);

    const list = await liveApi('/v1/subscriptions');
    expect(list.status).toBe(200);
    expect(list.body.object).toBe('list');
    const mine = list.body.data.filter((s: { offerId: string }) => s.offerId === offer.body.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('active');
    subId = mine[0].id;
    firstPeriodEnd = mine[0].currentPeriodEnd;

    const fetched = await liveApi(`/v1/subscriptions/${subId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(subId);
  });

  it('POST /v1/subscriptions/:id/renew is blocked for live API keys', async () => {
    const before = await liveApi('/v1/balance');
    const startAvail = Number(before.body.available.amount);

    const renewed = await liveApi(`/v1/subscriptions/${subId}/renew`, { method: 'POST' });
    expect(renewed.status).toBe(400);
    expect(renewed.body.error.type).toBe('invalid_request_error');
    expect(renewed.body.error.message).toBe('subscription renew is test-mode only');

    const after = await liveApi('/v1/balance');
    expect(Number(after.body.available.amount)).toBeCloseTo(startAvail, 2);

    const fetched = await liveApi(`/v1/subscriptions/${subId}`);
    expect(fetched.body.currentPeriodEnd).toBe(firstPeriodEnd);
  });

  it('POST /v1/subscriptions/:id/cancel flips status to canceled', async () => {
    const canceled = await liveApi(`/v1/subscriptions/${subId}/cancel`, { method: 'POST' });
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
  });

  it('a renew after cancel is still blocked for live API keys', async () => {
    const { status, body } = await liveApi(`/v1/subscriptions/${subId}/renew`, { method: 'POST' });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toBe('subscription renew is test-mode only');
  });

  it('GET /v1/subscriptions/:id for an unknown id → 404', async () => {
    const { status, body } = await liveApi('/v1/subscriptions/sub_does_not_exist');
    expect(status).toBe(404);
    expect(body.error.type).toBe('invalid_request_error');
  });
});

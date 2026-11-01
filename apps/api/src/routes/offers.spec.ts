/**
 * Sprint 10 Item G — humans check out via the same path as agents. The route
 * dispatcher chooses 'balance' (auth Bearer present) or 'demo' (DEMO_MODE=1
 * fallback for the existing live-mode e2e). There is no 'card' branch.
 *
 * Boots the real Hono app on an ephemeral port (same harness as
 * routes/bridge.spec.ts) because the public POST /:id/pay reads the raw body
 * and middleware order matters.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { env } from '../lib/env.js';
import { resetStripeClient, setStripeClient } from '../lib/psp/stripe.js';

let server: ServerType;
let base: string;
const originalDemoMode = env.DEMO_MODE;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  env.DEMO_MODE = originalDemoMode;
  resetStripeClient();
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

function expectApiError(body: any, code: string, message: string, details?: unknown): void {
  expect(body).toMatchObject({
    ok: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

async function freshSession(email: string): Promise<string> {
  const start = await json('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  return verify.body.token;
}

async function createOffer(token: string, body: Record<string, unknown>): Promise<string> {
  const r = await json('/offers', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return r.body.offer.id;
}

describe('checkout pay handler (Sprint 10 Item G)', () => {
  it('balance pay (signed-in) debits buyer + credits seller', async () => {
    const sellerTok = await freshSession('seller-route-balance@example.com');
    const buyerTok = await freshSession('buyer-route-balance@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Coaching', amountUsd: 30 });

    const buyerBefore = await json('/auth/me', {
      headers: { authorization: `Bearer ${buyerTok}` },
    });
    const sellerBefore = await json('/auth/me', {
      headers: { authorization: `Bearer ${sellerTok}` },
    });

    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${buyerTok}` },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const buyerAfter = await json('/auth/me', {
      headers: { authorization: `Bearer ${buyerTok}` },
    });
    const sellerAfter = await json('/auth/me', {
      headers: { authorization: `Bearer ${sellerTok}` },
    });
    expect(buyerAfter.body.balance.balUsd).toBeCloseTo(buyerBefore.body.balance.balUsd - 30);
    expect(sellerAfter.body.balance.balUsd).toBeCloseTo(sellerBefore.body.balance.balUsd + 30);
  });

  it('balance pay requires an Idempotency-Key outside demo mode', async () => {
    env.DEMO_MODE = false;
    const sellerTok = await freshSession('seller-route-balance-no-idem@example.com');
    const buyerTok = await freshSession('buyer-route-balance-no-idem@example.com');
    const offerId = await createOffer(sellerTok, { title: 'No idem', amountUsd: 30 });

    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${buyerTok}` },
      body: JSON.stringify({ method: 'balance' }),
    });
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'idempotency_key_required');
  });

  it('balance pay with insufficient funds returns 400', async () => {
    const sellerTok = await freshSession('seller-route-broke@example.com');
    const buyerTok = await freshSession('buyer-route-broke@example.com');
    // Drain the buyer's balance with a send.
    const me = await json('/auth/me', {
      headers: { authorization: `Bearer ${buyerTok}` },
    });
    await json('/payments/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${buyerTok}` },
      body: JSON.stringify({ amountUsd: me.body.balance.balUsd, to: 'sink@example.com' }),
    });
    const offerId = await createOffer(sellerTok, { title: 'Pricey', amountUsd: 200 });

    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${buyerTok}` },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'Not enough balance.', { policyCode: 'insufficient_funds' });
  });

  it('demo path (no auth) still works under DEMO_MODE=1 — credits seller', async () => {
    const sellerTok = await freshSession('seller-route-demo@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Beat pack', amountUsd: 12 });

    const sellerBefore = await json('/auth/me', {
      headers: { authorization: `Bearer ${sellerTok}` },
    });
    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      // No Authorization header → demo path under DEMO_MODE.
      body: JSON.stringify({ buyerEmail: 'unknown@example.com' }),
    });
    expect(r.status).toBe(200);

    const sellerAfter = await json('/auth/me', {
      headers: { authorization: `Bearer ${sellerTok}` },
    });
    expect(sellerAfter.body.balance.balUsd).toBeCloseTo(sellerBefore.body.balance.balUsd + 12);
  });

  it('seller GET /offers/:id returns 404 ApiError envelope for an unknown offer', async () => {
    const sellerTok = await freshSession('seller-offer-get-missing@example.com');
    const r = await json('/offers/00000000-0000-0000-0000-000000000000', {
      headers: { authorization: `Bearer ${sellerTok}` },
    });
    expect(r.status).toBe(404);
    expectApiError(r.body, 'not_found', 'offer_not_found');
  });

  it('seller PATCH /offers/:id returns 404 ApiError envelope for an unknown offer', async () => {
    const sellerTok = await freshSession('seller-offer-patch-missing@example.com');
    const r = await json('/offers/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${sellerTok}` },
      body: JSON.stringify({ active: false }),
    });
    expect(r.status).toBe(404);
    expectApiError(r.body, 'not_found', 'offer_not_found');
  });

  it('explicit balance method without a session returns 401 ApiError envelope', async () => {
    const sellerTok = await freshSession('seller-route-balance-auth-required@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Auth required', amountUsd: 12 });
    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ method: 'balance' }),
    });
    expect(r.status).toBe(401);
    expectApiError(r.body, 'unauthorized', 'unauthorized');
  });

  it('demo pay returns 404 ApiError envelope for an unknown offer', async () => {
    const r = await json('/checkout/00000000-0000-0000-0000-000000000000/pay', {
      method: 'POST',
      body: JSON.stringify({ method: 'demo' }),
    });
    expect(r.status).toBe(404);
    expectApiError(r.body, 'not_found', 'offer_not_found');
  });

  it('demo pay returns 409 ApiError envelope for an inactive offer', async () => {
    const sellerTok = await freshSession('seller-route-inactive@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Inactive', amountUsd: 12 });
    await json(`/offers/${offerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${sellerTok}` },
      body: JSON.stringify({ active: false }),
    });
    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ method: 'demo' }),
    });
    expect(r.status).toBe(409);
    expectApiError(r.body, 'conflict', 'offer_inactive');
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Stack upgrades Phase 4 — multi-method hosted checkout.
 *
 * Three new method branches are layered on /pay:
 *   - card → demo synthetic cs_demo_ session + redirect (no STRIPE_SECRET_KEY)
 *   - bank_topup → Bridge virtual-account instructions (demo numbers, no
 *     BRIDGE_API_KEY → livemode=false in the response)
 *   - balance pay still works alongside (regression-protected by the cases
 *     above).
 *
 * Plus the public stripe-webhook surface: invalid signatures return 400 and
 * the session-status poll round-trips.
 * ────────────────────────────────────────────────────────────────────────── */
describe('checkout pay handler — Phase 4 multi-method', () => {
  it('card method returns a redirectUrl + sessionId (demo fallback)', async () => {
    const sellerTok = await freshSession('seller-card-demo@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Card method', amountUsd: 9.99 });

    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'card',
        buyerEmail: 'card-buyer@example.com',
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.method).toBe('card');
    expect(r.body.sessionId).toMatch(/^cs_demo_/);
    expect(r.body.redirectUrl).toContain('/checkout.html');
    expect(r.body.demo).toBe(true);

    // The session row is persisted; the status poll resolves to 'pending'.
    // Sprint 13 COMMIT 5 (SR1) — session-status now requires buyerEmail.
    const statusBefore = await json(
      `/checkout/session-status?id=${encodeURIComponent(r.body.sessionId)}&buyerEmail=${encodeURIComponent('card-buyer@example.com')}`,
    );
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.body.status).toBe('pending');
    expect(statusBefore.body.offerId).toBe(offerId);
  });

  it('card method returns a structured 502 body when Stripe session creation fails', async () => {
    const sellerTok = await freshSession('seller-card-failure@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Card failure', amountUsd: 9.99 });
    setStripeClient({
      checkout: {
        sessions: {
          create: async () => {
            throw new Error('stripe down');
          },
        },
      },
    } as unknown as Parameters<typeof setStripeClient>[0]);

    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'card',
        buyerEmail: 'card-failure@example.com',
      }),
    });
    expect(r.status).toBe(502);
    expectApiError(r.body, 'stripe_session_failed', 'stripe_session_failed');
  });

  it('card method requires buyerEmail', async () => {
    const sellerTok = await freshSession('seller-card-required@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Card req', amountUsd: 5 });
    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ method: 'card' }),
    });
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'buyer_email_required');
  });

  it('bank_topup returns Bridge virtual-account instructions (demo numbers)', async () => {
    const sellerTok = await freshSession('seller-bank-topup@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Bank wire', amountUsd: 50 });

    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'bank_topup',
        buyerEmail: 'bank-buyer@example.com',
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.method).toBe('bank_topup');
    expect(r.body.routingNumber).toBeTruthy();
    expect(r.body.accountNumber).toBeTruthy();
    expect(r.body.bankName).toBeTruthy();
    expect(r.body.amountUsd).toBe(50);
    expect(typeof r.body.note).toBe('string');
  });

  it('bank_topup is unavailable outside demo mode until settlement mapping exists', async () => {
    const sellerTok = await freshSession('seller-bank-topup-live-disabled@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Bank wire live disabled', amountUsd: 50 });
    env.DEMO_MODE = false;

    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'bank_topup',
        buyerEmail: 'bank-live-disabled@example.com',
      }),
    });
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'bank_topup_unavailable');
  });

  it('bank_topup requires buyerEmail', async () => {
    const sellerTok = await freshSession('seller-bank-req@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Bank req', amountUsd: 5 });
    const r = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ method: 'bank_topup' }),
    });
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'buyer_email_required');
  });

  it('stripe-webhook with missing signature returns 400 invalid_signature', async () => {
    const r = await json('/checkout/stripe-webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'invalid_signature');
  });

  it('session-status without id returns 400 ApiError envelope', async () => {
    const r = await json('/checkout/session-status?buyerEmail=probe@example.com');
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'session_id_required');
  });

  it('session-status returns 404 for an unknown session id', async () => {
    // Sprint 13 COMMIT 5 (SR1) — buyerEmail is required even for the 404 path
    // so an attacker can't probe sessionId existence without supplying a
    // candidate email.
    const r = await json(
      '/checkout/session-status?id=cs_unknown_abc&buyerEmail=probe@example.com',
    );
    expect(r.status).toBe(404);
    expectApiError(r.body, 'not_found', 'not_found');
  });

  /* Sprint 13 COMMIT 5 (SR1) — session-status auth gate. */

  it('session-status without buyerEmail returns 400', async () => {
    const r = await json('/checkout/session-status?id=cs_anything');
    expect(r.status).toBe(400);
    expectApiError(r.body, 'bad_request', 'buyer_email_required');
  });

  it('session-status with a mismatched buyerEmail returns 404 (no existence leak)', async () => {
    const sellerTok = await freshSession('seller-mismatch@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Mismatch', amountUsd: 7 });
    const created = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ method: 'card', buyerEmail: 'right-buyer@example.com' }),
    });
    expect(created.status).toBe(200);

    const r = await json(
      `/checkout/session-status?id=${encodeURIComponent(created.body.sessionId)}&buyerEmail=${encodeURIComponent('wrong@example.com')}`,
    );
    expect(r.status).toBe(404);
    expectApiError(r.body, 'not_found', 'not_found');
  });

  it('session-status with the matching buyerEmail returns 200', async () => {
    const sellerTok = await freshSession('seller-status-match@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Match', amountUsd: 11 });
    const created = await json(`/checkout/${offerId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ method: 'card', buyerEmail: 'correct@example.com' }),
    });
    expect(created.status).toBe(200);

    const r = await json(
      `/checkout/session-status?id=${encodeURIComponent(created.body.sessionId)}&buyerEmail=${encodeURIComponent('correct@example.com')}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('pending');
    expect(r.body.offerId).toBe(offerId);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 11 Phase 2 — checkoutView JOIN coverage.
 *
 * Phase 2 collapsed the prior two-SELECT checkoutView (one for the offer,
 * one for the seller name) into a single LEFT JOIN. The shape of the
 * public response must stay identical: { offerId, title, amountUsd,
 * sellerName, ... }. These tests pin that contract — adding regression
 * coverage so a future revert to the two-SELECT form (or a JOIN typo that
 * drops sellerName) is caught.
 * ────────────────────────────────────────────────────────────────────────── */
describe('GET /checkout/:id — single-query JOIN view', () => {
  it('returns the offer + sellerName in one HTTP call (JOIN)', async () => {
    const sellerTok = await freshSession('seller-checkout-join@example.com');
    const offerId = await createOffer(sellerTok, { title: 'Joined item', amountUsd: 42 });

    const r = await json(`/checkout/${offerId}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.checkout.offerId).toBe(offerId);
    expect(r.body.checkout.title).toBe('Joined item');
    expect(r.body.checkout.amountUsd).toBe(42);
    // The JOIN must surface the seller's name. /auth/start with the email
    // alone leaves name unset, so the store falls back to the email-prefix
    // default; either way it must be a non-empty string.
    expect(typeof r.body.checkout.sellerName).toBe('string');
    expect(r.body.checkout.sellerName.length).toBeGreaterThan(0);
    // Public projection must NOT leak sellerId.
    expect(r.body.checkout.sellerId).toBeUndefined();
  });

  it('returns 404 for an unknown offer id (JOIN returns 0 rows)', async () => {
    const r = await json('/checkout/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
    expectApiError(r.body, 'not_found', 'not_found');
  });
});

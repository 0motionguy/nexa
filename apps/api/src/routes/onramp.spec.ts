/**
 * /onramp/stripe/* integration tests — Sprint 15 alternative providers.
 *
 * Bridge KYB is the longest critical path before native bank rails. Stripe
 * Crypto Onramp is the alternative we wire while Bridge is pending. These
 * tests confirm the session route, the demo-success closing loop, the
 * webhook rejection on missing signature, and the status probe.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import type Stripe from 'stripe';
import { app } from '../index.js';
import { resetStripeClient, setStripeClient, setStripeWebhookSecret } from '../lib/psp/stripe.js';
import { _resetWebhookDedupForTests } from '../lib/webhook-dedup.js';
import { store } from '../store/index.js';

let server: ServerType;
let base: string;

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
  resetStripeClient();
  _resetWebhookDedupForTests();
});

async function json(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

let token = '';

beforeAll(async () => {
  const start = await json('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email: 'onramp-tester@example.com' }),
  });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  token = verify.body.token;
});

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('/onramp/stripe', () => {
  it('POST /session returns a demo redirect when no Stripe key is configured', async () => {
    const { status, body } = await json('/onramp/stripe/session', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 250 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sessionId).toMatch(/^cs_onramp_demo_/);
    expect(body.demo).toBe(true);
    expect(body.redirectUrl).toContain('/onramp-demo-success');
    expect(body.redirectUrl).toContain(`session=${body.sessionId}`);
    expect(body.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(body.sourced).toBeDefined();
    expect(body.sourced.source).toBe('provider-demo');
    expect(body.sourced.provider).toBe('stripe');
  });

  it('POST /session rejects sub-zero amounts', async () => {
    const { status } = await json('/onramp/stripe/session', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 0 }),
    });
    // Zod validator returns 400 with its own shape; ok flag may be on a
    // nested `error` field. Status is the canonical check.
    expect(status).toBe(400);
  });

  it('POST /session honours destinationNetwork override', async () => {
    const { body } = await json('/onramp/stripe/session', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 50, destinationNetwork: 'optimism' }),
    });
    expect(body.destinationNetwork).toBe('optimism');
  });

  it('POST /webhook rejects when stripe-signature header is missing', async () => {
    const res = await fetch(`${base}/onramp/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'crypto.onramp_session.updated' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /webhook credits delivered USDC instead of gross source spend', async () => {
    const user = await store.upsertUserByEmail('onramp-tester@example.com');
    setStripeWebhookSecret('whsec_test_onramp');
    setStripeClient({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: 'evt_onramp_delivered_amount',
          type: 'crypto.onramp_session.fulfillment_completed',
          data: {
            object: {
              id: 'cs_onramp_delivered_amount',
              status: 'fulfillment_complete',
              source_total_amount: '10.00',
              destination_amount: '9.95',
              metadata: { userId: user.id },
            },
          },
        })),
      },
    } as unknown as Stripe);

    const { status, body } = await json('/onramp/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=test' },
      body: JSON.stringify({ id: 'evt_onramp_delivered_amount' }),
    });

    expect(status).toBe(200);
    expect(body.credited).toBe(9.95);
  });

  it('POST /webhook ignores duplicate fulfillment events for the same onramp session', async () => {
    const user = await store.upsertUserByEmail('onramp-tester@example.com');
    setStripeWebhookSecret('whsec_test_onramp');
    setStripeClient({
      webhooks: {
        constructEvent: vi.fn((raw: string) => {
          const event = JSON.parse(raw) as { id: string };
          return {
            id: event.id,
            type: 'crypto.onramp_session.fulfillment_completed',
            data: {
              object: {
                id: 'cs_onramp_duplicate_session',
                status: 'fulfillment_complete',
                source_total_amount: '10.00',
                destination_amount: '10.00',
                metadata: { userId: user.id },
              },
            },
          };
        }),
      },
    } as unknown as Stripe);

    const first = await json('/onramp/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=test' },
      body: JSON.stringify({ id: 'evt_onramp_duplicate_session_1' }),
    });
    const second = await json('/onramp/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=test' },
      body: JSON.stringify({ id: 'evt_onramp_duplicate_session_2' }),
    });

    expect(first.body.credited).toBe(10);
    expect(second.body.ignored).toBe('session_replay');
  });

  it('GET /stripe/status reports demo-fallback status when no key configured', async () => {
    const { status, body } = await json('/onramp/stripe/status');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('stripe');
    expect(body.available).toBe(false); // STRIPE_SECRET_KEY unset in vitest
    expect(body.sourced.source).toBe('provider-demo');
  });

  it('GET /demo-success credits the ledger and returns sourced envelope', async () => {
    // Boot a known balance via the existing /payments/topup is unnecessary —
    // the auth/me endpoint will reflect the demo seed.
    const { status, body } = await json('/onramp/demo-success?amount=15000', {
      headers: authed(),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.amountUsd).toBe(150);
    expect(body.sourced.source).toBe('provider-demo');
    expect(body.sourced.provider).toBe('stripe');
    expect(typeof body.balUsd).toBe('number');
  });
});

describe('/onramp/onramper', () => {
  it('routes stocks-spot sessions to a Solana wallet', async () => {
    const { status, body } = await json('/onramp/onramper/session', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 50, bucket: 'stocks-spot' }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.bucket).toBe('stocks-spot');
    expect(body.chain).toBe('solana');
    expect(body.widgetUrl).toContain('networkWallets=solana%3A');
  });
});

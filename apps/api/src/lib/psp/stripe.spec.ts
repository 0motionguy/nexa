/**
 * Stripe Checkout adapter — unit tests.
 *
 * Three surfaces:
 *   - createCheckoutSession: demo (no key) returns cs_demo_*; live (mocked
 *     client) returns the SDK's session id + url and threads the
 *     idempotencyKey through to the request options.
 *   - verifyAndParseWebhook: null when STRIPE_WEBHOOK_SECRET is unset; null
 *     when the signature header is missing; null when the SDK throws
 *     SignatureVerificationError; happy-path returns the event.
 *   - parseCheckoutCompleted: only matches checkout.session.completed; pulls
 *     sessionId / paymentStatus / amount_total / metadata.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  createCheckoutSession,
  parseCheckoutCompleted,
  parseOnrampCompleted,
  resetStripeClient,
  setStripeClient,
  setStripeWebhookSecret,
  verifyAndParseWebhook,
} from './stripe.js';

beforeEach(() => {
  // Each test re-pins the SDK client + webhook secret directly; env wiring at
  // module load is intentionally bypassed via the test-override surface.
  resetStripeClient();
});

describe('lib/psp/stripe — createCheckoutSession', () => {
  it('returns a synthetic cs_demo_* + relative redirect when no key is set', async () => {
    const out = await createCheckoutSession({
      offer: { id: 'off_1', title: 'Priority queue', amountUsd: 9.99, sellerId: 'sel_1' },
      buyerEmail: 'buyer@example.com',
      idempotencyKey: 'idem_1',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });
    expect(out.demo).toBe(true);
    expect(out.sessionId).toMatch(/^cs_demo_[a-f0-9]+$/);
    expect(out.redirectUrl).toContain('/checkout.html');
    expect(out.redirectUrl).toContain('mode=demo');
    expect(out.redirectUrl).toContain(out.sessionId);
  });

  it('forwards offer fields + idempotencyKey to stripe.checkout.sessions.create when live', async () => {
    const create = vi.fn(async () => ({
      id: 'cs_test_abc',
      url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
    }));
    setStripeClient({
      checkout: { sessions: { create } },
    } as unknown as Stripe);

    const out = await createCheckoutSession({
      offer: { id: 'off_1', title: 'Priority queue', amountUsd: 9.99, sellerId: 'sel_1' },
      buyerEmail: 'buyer@example.com',
      idempotencyKey: 'idem_buyer:off_1',
      successUrl: 'https://example.com/success?session={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://example.com/cancel',
    });

    expect(out.demo).toBe(false);
    expect(out.sessionId).toBe('cs_test_abc');
    expect(out.redirectUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');

    expect(create).toHaveBeenCalledTimes(1);
    const [params, opts] = create.mock.calls[0]!;
    expect(params.mode).toBe('payment');
    expect(params.payment_method_types).toEqual(['card']);
    expect(params.line_items[0].quantity).toBe(1);
    expect(params.line_items[0].price_data.currency).toBe('usd');
    expect(params.line_items[0].price_data.unit_amount).toBe(999); // 9.99 USD → 999 cents
    expect(params.line_items[0].price_data.product_data.name).toBe('Priority queue');
    expect(params.customer_email).toBe('buyer@example.com');
    expect(params.metadata).toEqual({ offerId: 'off_1', sellerId: 'sel_1' });
    expect(opts.idempotencyKey).toBe('idem_buyer:off_1');
  });

  it('rejects when Stripe returns a session without a url', async () => {
    setStripeClient({
      checkout: { sessions: { create: vi.fn(async () => ({ id: 'cs_test_abc' })) } },
    } as unknown as Stripe);
    await expect(
      createCheckoutSession({
        offer: { id: 'off_1', title: 'X', amountUsd: 1, sellerId: 's' },
        buyerEmail: 'b@x.com',
        idempotencyKey: 'k',
        successUrl: 's',
        cancelUrl: 'c',
      }),
    ).rejects.toThrow();
  });
});

describe('lib/psp/stripe — verifyAndParseWebhook', () => {
  it('returns null when STRIPE_WEBHOOK_SECRET is unset', () => {
    setStripeWebhookSecret(null);
    expect(verifyAndParseWebhook('{}', 't=1,v1=abc')).toBeNull();
  });

  it('returns null when no signature header is provided', () => {
    setStripeWebhookSecret('whsec_dummy');
    setStripeClient({ webhooks: { constructEvent: vi.fn() } } as unknown as Stripe);
    expect(verifyAndParseWebhook('{}', null)).toBeNull();
  });

  it('returns null when the SDK throws on signature mismatch', () => {
    setStripeWebhookSecret('whsec_dummy');
    setStripeClient({
      webhooks: {
        constructEvent: vi.fn(() => {
          throw new Error('No signatures found matching the expected signature');
        }),
      },
    } as unknown as Stripe);
    expect(verifyAndParseWebhook('{}', 't=1,v1=bad')).toBeNull();
  });

  it('returns the parsed event on a valid signature', () => {
    setStripeWebhookSecret('whsec_dummy');
    const event = { id: 'evt_1', type: 'checkout.session.completed' } as Stripe.Event;
    setStripeClient({
      webhooks: { constructEvent: vi.fn(() => event) },
    } as unknown as Stripe);
    const out = verifyAndParseWebhook('{}', 't=1,v1=ok');
    expect(out).not.toBeNull();
    expect(out!.event.id).toBe('evt_1');
  });
});

describe('lib/psp/stripe — parseCheckoutCompleted', () => {
  it('returns null for unrelated event types', () => {
    const evt = {
      type: 'invoice.paid',
      data: { object: {} },
    } as unknown as Stripe.Event;
    expect(parseCheckoutCompleted(evt)).toBeNull();
  });

  it('pulls sessionId, paymentStatus, amount_total, metadata for a checkout.session.completed', () => {
    const evt = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_abc',
          payment_status: 'paid',
          amount_total: 999,
          metadata: { offerId: 'off_1', sellerId: 'sel_1' },
        },
      },
    } as unknown as Stripe.Event;
    const out = parseCheckoutCompleted(evt);
    expect(out).toEqual({
      sessionId: 'cs_test_abc',
      paymentStatus: 'paid',
      amountTotalCents: 999,
      metadata: { offerId: 'off_1', sellerId: 'sel_1' },
    });
  });

  it('defaults amount and metadata when the SDK omits them', () => {
    const evt = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_x', payment_status: 'unpaid' } },
    } as unknown as Stripe.Event;
    const out = parseCheckoutCompleted(evt);
    expect(out).toEqual({
      sessionId: 'cs_test_x',
      paymentStatus: 'unpaid',
      amountTotalCents: 0,
      metadata: {},
    });
  });
});

describe('lib/psp/stripe — parseOnrampCompleted', () => {
  it('ignores generic onramp updated events so one session cannot credit twice', () => {
    const evt = {
      type: 'crypto.onramp_session.updated',
      data: {
        object: {
          id: 'cs_onramp_1',
          status: 'fulfillment_complete',
          source_total_amount: '10.00',
          metadata: { userId: 'user_1' },
        },
      },
    } as unknown as Stripe.Event;

    expect(parseOnrampCompleted(evt)).toBeNull();
  });

  it('parses the fulfillment event that actually credits the ledger', () => {
    const evt = {
      type: 'crypto.onramp_session.fulfillment_completed',
      data: {
        object: {
          id: 'cs_onramp_1',
          status: 'fulfillment_complete',
          source_total_amount: '10.00',
          destination_amount: '9.95',
          metadata: { userId: 'user_1' },
        },
      },
    } as unknown as Stripe.Event;

    expect(parseOnrampCompleted(evt)).toEqual({
      sessionId: 'cs_onramp_1',
      status: 'fulfillment_complete',
      sourceAmountCents: 1000,
      destinationAmount: '9.95',
      metadata: { userId: 'user_1' },
    });
  });
});

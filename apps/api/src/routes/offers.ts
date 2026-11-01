/**
 * MAZE facilitator — the get-paid layer.
 *
 * Two Hono apps:
 *   offerRoutes   (/offers)   — seller surface, session-auth: CRUD offers, list
 *                               payments, register webhooks.
 *   checkoutRoutes (/checkout) — PUBLIC, no session: the hosted checkout view +
 *                               pay. payOffer credits the seller (resolved from
 *                               the offer), then the route fires the fulfillment
 *                               email + seller webhooks on a fresh payment.
 *
 * Buyer-facing copy is fiat-only ("pay $9.99"). Seller-internal `sellerId` is
 * never exposed — toWire strips it and attaches the shareable checkoutUrl.
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { OfferInput, PayInput } from '@nexa/shared-zod';
import { optionalSession, requireSession } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { store } from '../store/index.js';
import { sendEmail } from '../lib/email.js';
import { fireWebhooks } from '../lib/webhooks.js';
import { validateUrl } from '../lib/safe-fetch.js';
import { ApiError } from '../lib/errors.js';
import { PolicyError, type Offer } from '../store/types.js';
import { paymentsFailed, paymentsPaid } from '../lib/metrics.js';
import {
  createCheckoutSession,
  parseCheckoutCompleted,
  verifyAndParseWebhook,
} from '../lib/psp/stripe.js';
import {
  BridgeProvisioningError,
  createCustomer as bridgeCreateCustomer,
  createVirtualAccount as bridgeCreateVirtualAccount,
} from '../lib/chain/bridge.js';
import { markWebhookSeen } from '../lib/webhook-dedup.js';
import { log } from '../lib/log.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Internal Offer → public wire shape (shared-zod Offer): drop sellerId, add checkoutUrl. */
export function toWire(o: Offer): Omit<Offer, 'sellerId'> & { checkoutUrl: string } {
  const { sellerId: _sellerId, ...rest } = o;
  const base = env.CHECKOUT_BASE_URL.replace(/\/+$/, '');
  return {
    ...rest,
    livemode: o.livemode,
    subAccountId: o.subAccountId,
    splits: o.splits,
    checkoutUrl: `${base}/${o.id}`,
  };
}

/* ── seller surface (session) ───────────────────────────────────────────── */

export const offerRoutes = new Hono();

offerRoutes.use('*', requireSession);

offerRoutes.post('/', zValidator('json', OfferInput), async (c) => {
  const u = c.get('user');
  const body = c.req.valid('json');
  const offer = await store.createOffer(u, body);
  return c.json({ ok: true, offer: toWire(offer) });
});

offerRoutes.get('/', async (c) => {
  const u = c.get('user');
  const offers = await store.listOffers(u);
  return c.json({ ok: true, offers: offers.map(toWire) });
});

offerRoutes.get('/payments', async (c) => {
  const u = c.get('user');
  const payments = await store.listPayments(u);
  return c.json({ ok: true, payments });
});

offerRoutes.post('/webhooks', zValidator('json', z.object({ url: z.string().url() })), async (c) => {
  const u = c.get('user');
  const { url } = c.req.valid('json');
  // Sprint 11 Phase 0 — SSRF guard. Reject the URL up front when it resolves
  // to a private/loopback/link-local address; this stops the URL from ever
  // entering the store, so a later dispatch can't even attempt the call.
  const check = await validateUrl(url);
  if (!check.ok) {
    throw ApiError.badRequest(
      check.reason === 'internal_ip' ? 'webhook_url_internal' : `webhook_url_${check.reason}`,
    );
  }
  const endpoint = await store.registerWebhook(u, url);
  // Secret is returned ONCE here; listWebhooks omits it thereafter.
  return c.json({ ok: true, id: endpoint.id, url: endpoint.url, secret: endpoint.secret });
});

offerRoutes.get('/webhooks', async (c) => {
  const u = c.get('user');
  const webhooks = await store.listWebhooks(u);
  return c.json({
    ok: true,
    webhooks: webhooks.map((w) => ({ id: w.id, url: w.url, active: w.active, createdAt: w.createdAt })),
  });
});

offerRoutes.get('/:id', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  try {
    const offer = await store.sellerOffer(u, id);
    return c.json({ ok: true, offer: toWire(offer) });
  } catch (e) {
    if (e instanceof Error && e.message === 'offer_not_found') {
      throw ApiError.notFound('offer_not_found');
    }
    throw e;
  }
});

offerRoutes.patch(
  '/:id',
  zValidator('json', OfferInput.partial().extend({ active: z.boolean().optional() })),
  async (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    const patch = c.req.valid('json');
    try {
      const offer = await store.updateOffer(u, id, patch);
      return c.json({ ok: true, offer: toWire(offer) });
    } catch (e) {
      if (e instanceof Error && e.message === 'offer_not_found') {
        throw ApiError.notFound('offer_not_found');
      }
      throw e;
    }
  },
);

/* ── public checkout (NO session) ───────────────────────────────────────── */

export const checkoutRoutes = new Hono();

/* ── PUBLIC session-status poll (Phase 4) ──────────────────────────────────
 * Registered before the dynamic /:id route so `GET /checkout/session-status`
 * doesn't get swallowed by the offer-lookup handler.
 *
 * Sprint 13 COMMIT 5 (SR1) — the prior implementation was unauthenticated AND
 * not in the /checkout/* rate-limit binding. Anyone with a sessionId could
 * confirm the buyer email + amount + offer the session was created for.
 * Tactical fix: require the buyerEmail query param + match it against the
 * persisted record; rate-limit binding lives in index.ts keyed on IP.
 * ────────────────────────────────────────────────────────────────────────── */
checkoutRoutes.get('/session-status', async (c) => {
  const sessionId = c.req.query('id') ?? '';
  const buyerEmail = c.req.query('buyerEmail') ?? '';
  if (!sessionId) throw ApiError.badRequest('session_id_required');
  if (!buyerEmail) throw ApiError.badRequest('buyer_email_required');
  const session = await store.findStripeSession(sessionId);
  // Constant-shape 404 whether the session is missing OR the buyer email
  // doesn't match — no existence leak to an attacker fishing for sessionIds.
  if (!session) throw ApiError.notFound('not_found');
  if (session.buyerEmail?.toLowerCase() !== buyerEmail.toLowerCase()) {
    throw ApiError.notFound('not_found');
  }
  return c.json({
    ok: true,
    sessionId: session.sessionId,
    status: session.status,
    amountUsd: session.amountUsd,
    offerId: session.offerId,
    completedAt: session.completedAt,
  });
});

checkoutRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const v = await store.checkoutView(id);
  if (!v) throw ApiError.notFound('not_found');
  return c.json({ ok: true, checkout: v });
});

/**
 * Sprint 10 Item G (β) + Stack upgrades Phase 4 — humans pick one of three
 * checkout methods on the hosted page:
 *
 *   - method='balance' — signed-in MAZE buyer. payOffer debits buyer's balUsd,
 *     credits seller, fires payment.paid. PolicyError('insufficient_funds') → 400.
 *   - method='card' — Stripe Checkout. The route creates a hosted session,
 *     persists `nb_stripe_sessions` for the webhook to resolve, and returns
 *     { redirectUrl } so the web app can window.location to Stripe. Settles in
 *     POST /checkout/stripe-webhook on checkout.session.completed.
 *   - method='bank_topup' — demo-only Bridge virtual-account preview. Live
 *     checkout bank topups need a durable offer/buyer/customer settlement row
 *     before we can safely emit routing details.
 *   - method='demo' — DEMO_MODE=1 fixture path retained for the existing
 *     live-mode e2e.
 *
 * Signed-out buyer asking for 'balance' in production = 401. Idempotency-Key
 * header wins over the body field; both are accepted for back-compat.
 */
checkoutRoutes.post('/:id/pay', optionalSession, zValidator('json', PayInput), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const buyer = (c.get('user') ?? null) as Awaited<ReturnType<typeof store.user>> | null;
  const idem = c.req.header('Idempotency-Key') ?? body.idempotencyKey ?? null;

  // Resolve the method: explicit body.method wins, otherwise infer from the
  // buyer's session. Cards/bank_topup don't require a session.
  const requested = body.method ?? null;
  let method: 'balance' | 'demo' | 'card' | 'bank_topup';
  if (requested === 'card' || requested === 'bank_topup') {
    method = requested;
  } else if (buyer) {
    method = 'balance';
  } else if (env.DEMO_MODE && (requested === 'demo' || requested == null)) {
    method = 'demo';
  } else {
    throw ApiError.unauthorized('unauthorized');
  }

  if (method === 'balance' && !env.DEMO_MODE && !idem) {
    throw ApiError.badRequest('idempotency_key_required');
  }

  /* ── card: Stripe Checkout redirect ────────────────────────────────────── */
  if (method === 'card') {
    const buyerEmail = body.buyerEmail ?? null;
    if (!buyerEmail) {
      throw ApiError.badRequest('buyer_email_required');
    }
    const offer = await store.checkoutView(id);
    if (!offer || !offer.active) {
      paymentsFailed.inc({ reason: 'offer_not_found' });
      throw ApiError.notFound('offer_not_found');
    }
    const stripeKey = idem ?? sha256(`${buyerEmail}:${id}`);
    const successUrl = env.STRIPE_SUCCESS_URL;
    const cancelUrl = env.STRIPE_CANCEL_URL;
    try {
      const session = await createCheckoutSession({
        offer: {
          id: offer.offerId,
          title: offer.title,
          amountUsd: offer.amountUsd,
          sellerId: '', // metadata-only; the webhook re-reads sellerId from the persisted row's offer.
        },
        buyerEmail,
        idempotencyKey: stripeKey,
        successUrl,
        cancelUrl,
      });
      await store.createStripeSession({
        sessionId: session.sessionId,
        offerId: offer.offerId,
        buyerEmail,
        amountUsd: offer.amountUsd,
      });
      return c.json({
        ok: true,
        method: 'card' as const,
        redirectUrl: session.redirectUrl,
        sessionId: session.sessionId,
        demo: session.demo,
      });
    } catch {
      paymentsFailed.inc({ reason: 'stripe_session_failed' });
      return c.json({
        ok: false,
        error: { code: 'stripe_session_failed', message: 'stripe_session_failed' },
      }, 502);
    }
  }

  /* ── bank_topup: Bridge virtual-account wire instructions ──────────────── */
  if (method === 'bank_topup') {
    if (!env.DEMO_MODE) {
      throw ApiError.badRequest('bank_topup_unavailable');
    }
    const buyerEmail = body.buyerEmail ?? null;
    if (!buyerEmail) {
      throw ApiError.badRequest('buyer_email_required');
    }
    const offer = await store.checkoutView(id);
    if (!offer || !offer.active) {
      paymentsFailed.inc({ reason: 'offer_not_found' });
      throw ApiError.notFound('offer_not_found');
    }
    try {
      const customer = await bridgeCreateCustomer({ email: buyerEmail, name: buyerEmail });
      const va = await bridgeCreateVirtualAccount(customer.customerId, 'USD');
      return c.json({
        ok: true,
        method: 'bank_topup' as const,
        amountUsd: offer.amountUsd,
        accountNumber: va.accountNumber,
        routingNumber: va.routingNumber,
        bankName: va.bankName,
        livemode: va.livemode,
        note: 'Wire the offer amount from your bank to this account. We credit on receipt (typically 1–3 business days for ACH).',
      });
    } catch (e) {
      if (e instanceof BridgeProvisioningError) {
        return c.json({
          ok: false,
          error: { code: e.code, message: e.message },
        }, 502);
      }
      throw e;
    }
  }

  /* ── balance / demo: existing Sprint 10 Item G β path ──────────────────── */
  try {
    const r = await store.payOffer(id, {
      buyerEmail: buyer?.email ?? body.buyerEmail ?? null,
      method,
      idempotencyKey: idem,
      buyerUser: method === 'balance' ? buyer : null,
    });
    if (r.fresh) {
      paymentsPaid.inc();
      if (r.payment.buyerEmail) {
        void sendEmail(r.payment.buyerEmail, 'fulfillment', {
          offerTitle: r.payment.offerTitle,
          kind: r.fulfillment.kind,
          value: r.fulfillment.value,
          amountUsd: r.payment.amountUsd,
        });
      }
      void fireWebhooks(await store.webhooksForSeller(r.sellerId), {
        id: r.payment.id,
        type: 'payment.paid',
        created: new Date().toISOString(),
        data: { payment: r.payment },
      });
      if (r.payouts.length > 0) {
        const endpoints = await store.webhooksForSeller(r.sellerId);
        for (const payout of r.payouts) {
          void fireWebhooks(endpoints, {
            id: payout.id,
            type: 'payout.completed',
            created: new Date().toISOString(),
            data: { payout },
          });
        }
      }
    }
    return c.json({
      ok: true,
      paymentId: r.payment.id,
      status: r.payment.status,
      fulfillment: r.fulfillment,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (m === 'offer_not_found') {
      paymentsFailed.inc({ reason: 'offer_not_found' });
      throw ApiError.notFound('offer_not_found');
    }
    if (m === 'offer_inactive') {
      paymentsFailed.inc({ reason: 'offer_inactive' });
      throw ApiError.conflict('offer_inactive');
    }
    if (e instanceof PolicyError && e.code === 'insufficient_funds') {
      paymentsFailed.inc({ reason: 'insufficient_funds' });
      throw ApiError.badRequest(e.message, { policyCode: e.code });
    }
    throw e;
  }
});

/* ── PUBLIC Stripe webhook (HMAC-verified) ───────────────────────────────────
 * checkout.session.completed → look up the persisted nb_stripe_sessions row,
 * settle the offer with `payOffer` using sessionId as the idempotencyKey (free
 * dedupe on repeat firings), mark the session 'completed'. The payment.paid
 * webhook to the seller fires from inside `payOffer`'s normal post-credit path.
 * ────────────────────────────────────────────────────────────────────────── */
checkoutRoutes.post('/stripe-webhook', async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header('stripe-signature') ?? null;
  const verified = verifyAndParseWebhook(rawBody, sig);
  if (!verified) {
    throw ApiError.badRequest('invalid_signature');
  }
  // SEC-04 — explicit replay guard (defense in depth on top of payOffer's
  // idempotencyKey). Same Stripe event id replayed inside the 5-min window
  // would otherwise re-enter the offer/fulfillment branch.
  if (await markWebhookSeen('stripe', verified.event.id)) {
    log.info(
      { eventId: verified.event.id, type: verified.event.type },
      'checkout: stripe webhook replay skipped',
    );
    return c.json({ ok: true, ignored: 'replay' });
  }
  const parsed = parseCheckoutCompleted(verified.event);
  if (!parsed) {
    return c.json({ ok: true, ignored: verified.event.type });
  }
  if (parsed.paymentStatus !== 'paid') {
    return c.json({ ok: true, ignored: 'unpaid', status: parsed.paymentStatus });
  }
  const session = await store.findStripeSession(parsed.sessionId);
  if (!session) {
    return c.json({ ok: true, ignored: 'unknown_session' });
  }
  if (session.status === 'completed') {
    return c.json({ ok: true, ignored: 'already_completed' });
  }
  // Settle: payOffer's idempotencyKey dedupes against future webhook retries.
  try {
    const r = await store.payOffer(session.offerId, {
      buyerEmail: session.buyerEmail,
      method: 'card',
      idempotencyKey: parsed.sessionId,
    });
    if (r.fresh) {
      paymentsPaid.inc();
      if (r.payment.buyerEmail) {
        void sendEmail(r.payment.buyerEmail, 'fulfillment', {
          offerTitle: r.payment.offerTitle,
          kind: r.fulfillment.kind,
          value: r.fulfillment.value,
          amountUsd: r.payment.amountUsd,
        });
      }
      void fireWebhooks(await store.webhooksForSeller(r.sellerId), {
        id: r.payment.id,
        type: 'payment.paid',
        created: new Date().toISOString(),
        data: { payment: r.payment },
      });
    }
    await store.markStripeSessionCompleted(parsed.sessionId);
    return c.json({ ok: true, paymentId: r.payment.id, fresh: r.fresh });
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (m === 'offer_not_found' || m === 'offer_inactive') {
      await store.markStripeSessionStatus(parsed.sessionId, 'failed');
      return c.json({ ok: false, error: { code: m, message: m } }, 200);
    }
    throw e;
  }
});

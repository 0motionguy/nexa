/**
 * MAZE public REST API (/v1) — the developer surface, authed by API key
 * (sk_test_/sk_live_). Mirrors the seller app routes but speaks the public-API
 * dialect from MAYZ-FACILITATOR.md §3–4:
 *   - success returns the BARE resource (no `{ ok: … }` envelope)
 *   - collections return `{ object: 'list', data: [...] }`
 *   - errors return `{ error: { type, message } }` with the matching status
 *
 * The presenting key's mode (c.get('livemode')) scopes every read/write: a
 * sk_test_ key only ever sees sandbox offers/payments and the sandbox balance.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { OfferInput, SubAccountCreateInput, PayoutInput } from '@nexa/shared-zod';
import { requireApiKey } from '../lib/auth.js';
import { store } from '../store/index.js';
import { PolicyError } from '../store/types.js';
import type { SessionUser } from '../store/types.js';
import { fireWebhooks } from '../lib/webhooks.js';
import { toWire } from './offers.js';

export const v1Routes = new Hono();

function idempotencyKeyOf(c: { req: { header(name: string): string | undefined } }): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? '').trim();
  return key || null;
}

function invalidRequest(message: string): { error: { type: 'invalid_request_error'; message: string } } {
  return { error: { type: 'invalid_request_error', message } };
}

// Realtime hub (REALTIME_HUB_V1) ALSO mounts under /v1 — its /stream/* and
// /feeds/health routes use session auth, not API keys. Skip the apikey gate
// for those paths so the hub's own middleware runs.
v1Routes.use('*', async (c, next) => {
  const p = c.req.path;
  if (p.startsWith('/v1/stream/') || p === '/v1/feeds/health') return await next();
  return requireApiKey(c, next);
});

/**
 * Validate the optional split/sub-account routing on an offer create/patch.
 * Returns an error-object response body on failure, or null when valid.
 *   - split percentages must sum to ≤ 100
 *   - every referenced sub-account (base + per-split) must belong to the seller
 * Email splits carry no sub-account, so they need no ownership lookup.
 */
async function validateOfferRouting(
  u: SessionUser,
  body: { subAccountId?: string | null; splits?: { subAccountId?: string | null; percent: number }[] | null },
): Promise<{ type: string; message: string } | null> {
  if (body.splits && body.splits.length > 0) {
    const sum = body.splits.reduce((acc, s) => acc + s.percent, 0);
    if (sum > 100) return { type: 'invalid_request_error', message: 'split percentages exceed 100' };
  }
  const subIds = [
    ...(body.subAccountId ? [body.subAccountId] : []),
    ...(body.splits ?? []).flatMap((s) => (s.subAccountId ? [s.subAccountId] : [])),
  ];
  for (const id of subIds) {
    try {
      await store.subAccount(u, id);
    } catch (e) {
      if (e instanceof Error && e.message === 'sub_account_not_found') {
        return { type: 'invalid_request_error', message: 'unknown sub_account' };
      }
      throw e;
    }
  }
  return null;
}

/* ── offers ─────────────────────────────────────────────────────────────── */

v1Routes.post('/offers', zValidator('json', OfferInput), async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  const body = c.req.valid('json');
  const invalid = await validateOfferRouting(u, body);
  if (invalid) return c.json({ error: invalid }, 400);
  const offer = await store.createOffer(u, body, {
    livemode: live,
    idempotencyKey: c.req.header('Idempotency-Key') ?? null,
  });
  return c.json(toWire(offer), 201);
});

v1Routes.get('/offers', async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  const offers = await store.listOffers(u, { livemode: live });
  return c.json({ object: 'list', data: offers.map(toWire) });
});

v1Routes.get('/offers/:id', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  try {
    const offer = await store.sellerOffer(u, id);
    return c.json(toWire(offer));
  } catch (e) {
    if (e instanceof Error && e.message === 'offer_not_found') {
      return c.json({ error: { type: 'invalid_request_error', message: 'No such offer.' } }, 404);
    }
    throw e;
  }
});

v1Routes.patch(
  '/offers/:id',
  zValidator('json', OfferInput.partial().extend({ active: z.boolean().optional() })),
  async (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    const patch = c.req.valid('json');
    const invalid = await validateOfferRouting(u, patch);
    if (invalid) return c.json({ error: invalid }, 400);
    try {
      const offer = await store.updateOffer(u, id, patch);
      return c.json(toWire(offer));
    } catch (e) {
      if (e instanceof Error && e.message === 'offer_not_found') {
        return c.json({ error: { type: 'invalid_request_error', message: 'No such offer.' } }, 404);
      }
      throw e;
    }
  },
);

/* ── payments ───────────────────────────────────────────────────────────── */

v1Routes.get('/payments', async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  const payments = await store.listPayments(u, { livemode: live });
  return c.json({ object: 'list', data: payments });
});

v1Routes.get('/payments/:id', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  try {
    const payment = await store.payment(u, id);
    return c.json(payment);
  } catch (e) {
    if (e instanceof Error && e.message === 'payment_not_found') {
      return c.json({ error: { type: 'invalid_request_error', message: 'No such payment.' } }, 404);
    }
    throw e;
  }
});

/* ── sub-accounts ───────────────────────────────────────────────────────── */

v1Routes.post('/sub-accounts', zValidator('json', SubAccountCreateInput), async (c) => {
  const u = c.get('user');
  const { name } = c.req.valid('json');
  const sub = await store.createSubAccount(u, name);
  return c.json(sub, 201);
});

v1Routes.get('/sub-accounts', async (c) => {
  const u = c.get('user');
  const data = await store.listSubAccounts(u);
  return c.json({ object: 'list', data });
});

v1Routes.get('/sub-accounts/:id', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  try {
    const sub = await store.subAccount(u, id);
    return c.json(sub);
  } catch (e) {
    if (e instanceof Error && e.message === 'sub_account_not_found') {
      return c.json({ error: { type: 'invalid_request_error', message: 'No such sub_account.' } }, 404);
    }
    throw e;
  }
});

/* ── payouts ────────────────────────────────────────────────────────────── */

v1Routes.post('/payouts', zValidator('json', PayoutInput), async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  const body = c.req.valid('json');
  if ((body.method ?? '').toLowerCase() === 'bank') {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'bank payouts must use /bridge/withdraw' } },
      400,
    );
  }
  const idempotencyKey = idempotencyKeyOf(c);
  if (live && !idempotencyKey) {
    return c.json(invalidRequest('idempotency_key_required'), 400);
  }
  try {
    const payout = await store.createPayout(
      u,
      { amountUsd: body.amountUsd, destination: body.destination, method: body.method ?? undefined, note: body.note },
      {
        livemode: live,
        idempotencyKey,
      },
    );
    void fireWebhooks(await store.webhooksForSeller(u.id), {
      id: payout.id,
      type: 'payout.completed',
      created: new Date().toISOString(),
      data: { payout },
    });
    return c.json(payout, 201);
  } catch (e) {
    if (e instanceof PolicyError && e.code === 'insufficient_funds') {
      return c.json({ error: { type: 'insufficient_funds', message: e.message } }, 402);
    }
    throw e;
  }
});

v1Routes.get('/payouts', async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  const data = await store.listPayouts(u, { livemode: live });
  return c.json({ object: 'list', data });
});

v1Routes.get('/payouts/:id', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  try {
    const payout = await store.payout(u, id);
    return c.json(payout);
  } catch (e) {
    if (e instanceof Error && e.message === 'payout_not_found') {
      return c.json({ error: { type: 'invalid_request_error', message: 'No such payout.' } }, 404);
    }
    throw e;
  }
});

/* ── subscriptions ──────────────────────────────────────────────────────── */

v1Routes.get('/subscriptions', async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  const data = await store.listSubscriptions(u, { livemode: live });
  return c.json({ object: 'list', data });
});

v1Routes.get('/subscriptions/:id', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  try {
    const sub = await store.subscription(u, id);
    return c.json(sub);
  } catch (e) {
    if (e instanceof Error && e.message === 'subscription_not_found') {
      return c.json({ error: { type: 'invalid_request_error', message: 'No such subscription.' } }, 404);
    }
    throw e;
  }
});

v1Routes.post('/subscriptions/:id/cancel', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  try {
    const sub = await store.cancelSubscription(u, id);
    void fireWebhooks(await store.webhooksForSeller(u.id), {
      id: sub.id,
      type: 'subscription.canceled',
      created: new Date().toISOString(),
      data: { subscription: sub },
    });
    return c.json(sub);
  } catch (e) {
    if (e instanceof Error && e.message === 'subscription_not_found') {
      return c.json({ error: { type: 'invalid_request_error', message: 'No such subscription.' } }, 404);
    }
    throw e;
  }
});

// Simulates a billing cycle (advance period + credit a renewal charge) for demo/testing.
v1Routes.post('/subscriptions/:id/renew', async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  const id = c.req.param('id');
  if (live) {
    return c.json(invalidRequest('subscription renew is test-mode only'), 400);
  }
  try {
    const sub = await store.renewSubscription(u, id);
    void fireWebhooks(await store.webhooksForSeller(u.id), {
      id: sub.id,
      type: 'subscription.renewed',
      created: new Date().toISOString(),
      data: { subscription: sub },
    });
    return c.json(sub);
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (m === 'subscription_not_found') {
      return c.json({ error: { type: 'invalid_request_error', message: 'No such subscription.' } }, 404);
    }
    if (m === 'subscription_canceled') {
      return c.json({ error: { type: 'invalid_request_error', message: 'subscription is canceled' } }, 409);
    }
    throw e;
  }
});

/* ── balance ────────────────────────────────────────────────────────────── */

v1Routes.get('/balance', async (c) => {
  const u = c.get('user');
  const live = c.get('livemode');
  return c.json({
    livemode: live,
    available: { amount: (live ? u.balUsd : u.sandboxBalUsd).toFixed(2), currency: 'USD' },
    earning: { amount: (live ? u.earnUsd : 0).toFixed(2), currency: 'USD' },
  });
});

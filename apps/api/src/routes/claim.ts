/**
 * Public claim routes — the recipient side of the email-claim escrow.
 *
 *   GET  /claim/:slug   → PII-light view of a parked escrow (sender, amount, status)
 *   POST /claim/:slug    → recipient claims the funds (credits find-or-create user)
 *
 * No session: the claim link arrives by email before the recipient has an account.
 * send() already debited the sender and recordClaim() parked the escrow with a slug.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { store } from '../store/index.js';
import { claimsClaimed } from '../lib/metrics.js';
import { ApiError } from '../lib/errors.js';

export const claimRoutes = new Hono();

claimRoutes.get('/:slug', async (c) => {
  const r = await store.getClaim(c.req.param('slug'));
  // F062 — throw ApiError so the global error handler renders the canonical
  // {ok:false, error:{code,message,…}} shape. The code is in error.message.
  if (!r) throw ApiError.notFound('not_found');
  return c.json({
    ok: true,
    claim: {
      slug: r.slug,
      senderName: r.senderName,
      amountUsd: r.amountUsd,
      status: r.status,
      expiresAt: r.expiresAt,
    },
  });
});

claimRoutes.post(
  '/:slug',
  zValidator('json', z.object({ email: z.string().email() })),
  async (c) => {
    const res = await store.claimFunds(c.req.param('slug'), c.req.valid('json').email);
    // F062 — 410 isn't in ApiError's status union; use conflict (409) which is
    // semantically closer for "claim already taken/expired" than 4xx generic.
    if (!res) throw ApiError.conflict('unavailable');
    claimsClaimed.inc();
    return c.json({ ok: true, amountUsd: res.amountUsd });
  },
);

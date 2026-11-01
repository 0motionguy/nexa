/**
 * Send / request-link / top-up. Email-claim mechanic per BUILD-PLAN: sends to
 * an email park in claim escrow (demo: flagged CLAIM PENDING on the ledger).
 *
 * Sprint 10 Phase 2 ε — exemplar migration to the structured error normalizer
 * (lib/errors.ts). PolicyError now rethrows as `ApiError.badRequest` with the
 * policy code surfaced in `error.details.policyCode`, rendering the canonical
 * `{ ok: false, error: { code, message, requestId, details } }` shape via the
 * global `errorHandler`. Broader migration across the other ~28 route files
 * is Sprint 11.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'node:crypto';
import { requireSession } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { store } from '../store/index.js';
import { PolicyError } from '../store/types.js';
import { ApiError } from '../lib/errors.js';
import { emitAudit } from '../lib/audit.js';
import { sendEmail } from '../lib/email.js';
import {
  claimsCreated,
  paymentsCreated,
  paymentsFailed,
} from '../lib/metrics.js';

export const paymentRoutes = new Hono();

paymentRoutes.use('*', requireSession);

function claimLink(slug: string): string {
  return `${env.CLAIM_LINK_BASE_URL.replace(/\/+$/, '')}/${slug}`;
}

function idempotencyKeyOf(c: { req: { header(name: string): string | undefined } }): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? '').trim();
  if (!key) return null;
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key;
}

paymentRoutes.post(
  '/send',
  zValidator(
    'json',
    z.object({
      amountUsd: z.number().positive().max(99999),
      to: z.string().min(1).max(120),
    }),
  ),
  async (c) => {
    const u = c.get('user');
    const { amountUsd, to } = c.req.valid('json');
    const idempotencyKey = idempotencyKeyOf(c);
    if (!env.DEMO_MODE && !idempotencyKey) {
      throw ApiError.badRequest('idempotency_key_required');
    }
    try {
      const isEmailClaim = to.includes('@');
      const result = isEmailClaim
        ? await store.sendClaim(u, amountUsd, to, { idempotencyKey })
        : { ...(await store.send(u, amountUsd, to, { idempotencyKey })), claimRecord: null };
      const { claim, activity, claimRecord } = result;
      let slug: string | null = null;
      if (claim && claimRecord) {
        slug = claimRecord.slug;
        if (result.fresh !== false) {
          claimsCreated.inc();
          void sendEmail(to, 'claim', {
            senderName: u.name,
            amountUsd,
            claimUrl: claimLink(slug),
          });
        }
      } else {
        if (result.fresh !== false) paymentsCreated.inc();
      }
      // F066 — single audit row covers both the instant-send and email-claim
      // paths. The `to` field is forensically meaningful (recipient email or
      // address) but is sender-supplied input so the metadata is already
      // owned by the actor.
      if (result.fresh !== false) {
        emitAudit(c, {
          action: claim ? 'payment.claim_created' : 'payment.sent',
          actorType: 'user',
          actorId: u.id,
          targetType: 'activity',
          targetId: activity.id,
          metadata: { amountUsd, to, claimSlug: slug },
        });
      }
      return c.json({
        ok: true,
        claim,
        claimSlug: claim ? slug : null,
        claimUrl: claim && slug ? claimLink(slug) : null,
        balUsd: u.balUsd,
        activityId: activity.id,
        message: claim ? `${to} gets a claim email right now.` : `Delivered instantly to ${to}.`,
      });
    } catch (e) {
      if (e instanceof PolicyError) {
        paymentsFailed.inc({ reason: e.code });
        // Exemplar: rethrow as ApiError so the structured normalizer renders
        // the wire shape. The PolicyError code (e.g. 'insufficient_funds') is
        // surfaced in details.policyCode so the web client can still branch.
        throw ApiError.badRequest(e.message, { policyCode: e.code });
      }
      if (e instanceof Error && e.message === 'idempotency_key_reused') {
        throw ApiError.conflict('idempotency_key_reused');
      }
      throw e;
    }
  },
);

paymentRoutes.post(
  '/request-link',
  zValidator(
    'json',
    z.object({
      amountUsd: z.number().positive().max(99999),
      note: z.string().max(200).default(''),
    }),
  ),
  (c) => {
    const { amountUsd, note } = c.req.valid('json');
    const slug = randomUUID().slice(0, 8);
    const baseUrl = env.PAY_LINK_BASE_URL.replace(/\/+$/, '');
    return c.json({
      ok: true,
      url: `${baseUrl}/${slug}`,
      amountUsd,
      note,
      expiresInDays: 7,
      oneTime: true,
    });
  },
);

paymentRoutes.post(
  '/topup',
  zValidator(
    'json',
    z.object({
      amountUsd: z.number().positive().max(99999),
      label: z.string().max(80).optional(),
    }),
  ),
  async (c) => {
    if (!env.DEMO_MODE) {
      throw ApiError.forbidden('demo_only_endpoint');
    }
    const u = c.get('user');
    const { amountUsd, label } = c.req.valid('json');
    await store.topUp(u, amountUsd, label);
    return c.json({ ok: true, balUsd: u.balUsd });
  },
);

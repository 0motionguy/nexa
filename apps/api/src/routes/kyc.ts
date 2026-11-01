/**
 * KYC (Sumsub) routes — onboarding identity gate.
 *
 *   POST /kyc/start    (session)  → mint a per-applicant SDK token, flag pending
 *   GET  /kyc/status   (session)  → current kycStatus for the signed-in user
 *   POST /kyc/webhook  (PUBLIC)   → Sumsub review callback → persist the result
 *
 * Demo (SUMSUB_APP_TOKEN unset): /start returns a synthetic token with demo:true
 * and the webhook accepts without a signature, so onboarding completes locally.
 */

import { Hono } from 'hono';
import { requireSession } from '../lib/auth.js';
import { store } from '../store/index.js';
import * as kyc from '../lib/kyc.js';
import { ApiError } from '../lib/errors.js';

export const kycRoutes = new Hono();

kycRoutes.post('/start', requireSession, async (c) => {
  const u = c.get('user');
  const { token, applicantId } = await kyc.generateApplicantToken(u.id);
  await store.setKyc(u, 'pending');
  return c.json({ ok: true, token, applicantId, demo: !kyc.isKycEnabled() });
});

kycRoutes.get('/status', requireSession, (c) =>
  c.json({ ok: true, kycStatus: c.get('user').kycStatus }),
);

// F007 — signature verification + Sprint 11 freshness window are handled
// inside kyc.verifyWebhook (mirrors the bridge variant). `applicantId` +
// `externalUserId` dedup inside store.setKyc is the second line of defense
// against duplicate `applicantReviewed` events.
kycRoutes.post('/webhook', async (c) => {
  const raw = await c.req.text();
  if (!kyc.verifyWebhook(c.req.header('X-Payload-Digest') ?? null, raw)) {
    // F062 — throw ApiError so the global handler renders the canonical
    // {ok:false, error:{code,message,…}} envelope.
    throw ApiError.badRequest('bad_signature');
  }
  let ev: ReturnType<typeof kyc.parseReviewEvent> = null;
  try {
    ev = kyc.parseReviewEvent(JSON.parse(raw));
  } catch {
    /* malformed body — fall through, ack so Sumsub stops retrying */
  }
  if (ev) {
    const u = await store.user(ev.externalUserId).catch(() => null);
    if (u) await store.setKyc(u, ev.status);
  }
  return c.json({ ok: true });
});

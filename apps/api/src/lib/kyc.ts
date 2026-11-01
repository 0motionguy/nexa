/**
 * Sumsub KYC adapter — the identity-verification gate for onboarding.
 *
 * Sumsub issues a per-applicant access token; the frontend SDK consumes it to
 * run the verification flow, and Sumsub calls back via webhook with the review
 * result. Everything is env-gated behind SUMSUB_APP_TOKEN (same pattern as the
 * Bridge/Aave/LIFI adapters): unset → a synthetic demo token + a webhook that
 * accepts without a signature, so onboarding completes locally without config.
 *
 * Every network call is wrapped so a Sumsub outage degrades to demo behaviour
 * rather than throwing to the route — the demo flow must never 500.
 *
 * Auth: Sumsub signs each request with HMAC-SHA256 over `ts + METHOD + path + body`
 * using SUMSUB_SECRET_KEY, sent as X-App-Access-Sig alongside X-App-Token and
 * X-App-Access-Ts. Webhooks carry the same HMAC over the raw body.
 *
 * Docs: https://docs.sumsub.com/reference
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env, features } from './env.js';
import { log } from './log.js';
import { httpRequest } from './http.js';

export function isKycEnabled(): boolean {
  return features.sumsub;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function apiBase(): string {
  return env.SUMSUB_BASE.replace(/\/+$/, '');
}

/** A synthetic token pair so onboarding completes without a live Sumsub app. */
function demoToken(userId: string): { token: string; applicantId: string } {
  return { token: 'sumsub_demo_' + hex(8), applicantId: 'app_demo_' + userId.slice(0, 8) };
}

/**
 * Build the signed headers for a Sumsub request. The signature is HMAC-SHA256
 * over `ts + METHOD + path + body` (path includes the query string), hex-encoded.
 */
function signedHeaders(
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', env.SUMSUB_SECRET_KEY ?? '')
    .update(ts + method.toUpperCase() + path + body)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'X-App-Token': env.SUMSUB_APP_TOKEN ?? '',
    'X-App-Access-Ts': ts,
    'X-App-Access-Sig': sig,
  };
}

/**
 * Create (or reuse) an applicant for the user and mint an SDK access token.
 * Live: POST /resources/applicants (idempotent on externalUserId — a 409/conflict
 * means the applicant already exists, which is fine) then POST an access token.
 * Disabled or on any error: a synthetic `sumsub_demo_<hex>` token so the flow
 * still completes in demo.
 */
export async function generateApplicantToken(
  userId: string,
): Promise<{ token: string; applicantId: string }> {
  if (!isKycEnabled()) return demoToken(userId);
  try {
    // 1) Create the applicant keyed to our internal user id (externalUserId).
    //    A conflict (already exists) is non-fatal — we still want a token.
    let applicantId = '';
    const createPath = '/resources/applicants?levelName=basic-kyc-level';
    const createBody = JSON.stringify({ externalUserId: userId });
    // Sprint 17 F072 — httpRequest wraps timeout + structured error; POSTs
    // are not auto-retried (Sumsub applicant creation is sensitive to dupes
    // even though the `externalUserId` collision is a safe 409 below).
    const createRes = await httpRequest(`${apiBase()}${createPath}`, {
      vendor: 'sumsub',
      method: 'POST',
      headers: signedHeaders('POST', createPath, createBody),
      body: createBody,
      timeoutMs: 10_000,
    });
    if (createRes.ok) {
      const data = (await createRes.json().catch(() => ({}))) as { id?: string };
      applicantId = data.id ?? '';
    } else if (createRes.status !== 409 && createRes.status !== 400) {
      const text = await createRes.text().catch(() => '');
      log.warn({ status: createRes.status, text }, 'sumsub: createApplicant rejected — demo fallback');
      return demoToken(userId);
    }
    if (!applicantId) applicantId = 'app_demo_' + userId.slice(0, 8);

    // 2) Mint an access token for the SDK, scoped to this externalUserId.
    const tokenPath = `/resources/accessTokens?userId=${encodeURIComponent(userId)}&levelName=basic-kyc-level`;
    const tokenRes = await httpRequest(`${apiBase()}${tokenPath}`, {
      vendor: 'sumsub',
      method: 'POST',
      headers: signedHeaders('POST', tokenPath, ''),
      body: '',
      timeoutMs: 10_000,
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      log.warn({ status: tokenRes.status, text }, 'sumsub: accessToken rejected — demo fallback');
      return demoToken(userId);
    }
    const tokenData = (await tokenRes.json().catch(() => ({}))) as { token?: string };
    if (!tokenData.token) return demoToken(userId);
    return { token: tokenData.token, applicantId };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'sumsub: generateApplicantToken unreachable — demo fallback',
    );
    return demoToken(userId);
  }
}

/**
 * Verify a Sumsub webhook signature. When SUMSUB_SECRET_KEY is set, compute
 * HMAC-SHA256 over the raw body and timing-safe compare to the header value
 * (tolerating a `sha256=` / `t=…,v1=…` style prefix). When no secret is set
 * (demo), accept everything so the local webhook flow works without config.
 *
 * Sprint 11 Phase 0 — freshness gate. When the header carries a `t=<unix>`
 * timestamp, reject when the skew exceeds
 * `WEBHOOK_FRESHNESS_WINDOW_SECONDS` (default 300s) so a captured webhook
 * cannot be replayed days later. Sumsub's own `X-App-Access-Ts` header is
 * outside this surface — receivers route that header into `signature` only
 * when wired explicitly.
 */
export function verifyWebhook(signature: string | null, rawBody: string): boolean {
  const secret = env.SUMSUB_SECRET_KEY;
  if (!secret) return !isKycEnabled();
  if (!signature) return false;
  try {
    const tMatch = signature.match(/(?:^|[,;\s])t=(\d{1,11})\b/);
    if (tMatch) {
      const t = Number.parseInt(tMatch[1]!, 10);
      const nowSec = Math.floor(Date.now() / 1000);
      const skew = Math.abs(nowSec - t);
      const windowSec = env.WEBHOOK_FRESHNESS_WINDOW_SECONDS;
      if (skew > windowSec) {
        log.warn({ skewSec: skew, source: 'kyc', windowSec }, 'webhook freshness check failed');
        return false;
      }
      if (skew > 60) {
        log.warn({ skewSec: skew, source: 'kyc' }, 'webhook clock skew detected');
      }
    }

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    // Pull the last hex run out of the header (handles `sha256=…` and `t=…,v1=…`).
    const m = signature.match(/[a-f0-9]{64}/i);
    const provided = (m ? m[0] : signature).toLowerCase();
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'sumsub: verifyWebhook error');
    return false;
  }
}

/**
 * Recognise an applicant-review event and map it to our KYC status using the
 * `externalUserId` we set at applicant creation. Sumsub sends `applicantReviewed`
 * with `reviewResult.reviewAnswer` of GREEN (passed) or RED (failed); anything
 * else (pending/onHold) maps to 'pending'. Defensive about the event shape —
 * returns null for anything that isn't a review event we can act on.
 */
export function parseReviewEvent(
  body: any,
): { externalUserId: string; status: 'verified' | 'failed' | 'pending' } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;

  const type = String(b.type ?? b.eventType ?? '').toLowerCase();
  // Only act on review-result events. `applicantReviewed` is the terminal one;
  // `applicantPending`/`applicantOnHold` we surface as pending.
  const isReview =
    type.includes('applicantreviewed') ||
    type.includes('applicantpending') ||
    type.includes('applicantonhold') ||
    type.includes('reviewed');
  if (!isReview) return null;

  const externalUserId =
    b.externalUserId ?? b.applicant?.externalUserId ?? b.data?.externalUserId ?? null;
  if (!externalUserId || typeof externalUserId !== 'string') return null;

  const answer = String(
    b.reviewResult?.reviewAnswer ?? b.review_result?.review_answer ?? b.reviewAnswer ?? '',
  ).toUpperCase();

  let status: 'verified' | 'failed' | 'pending';
  if (answer === 'GREEN') status = 'verified';
  else if (answer === 'RED') status = 'failed';
  else status = 'pending';

  return { externalUserId, status };
}

/**
 * F039 — shared 30-day claim reclaim sweep.
 *
 * Both the BullMQ cron worker (apps/api/src/workers/claim-sweeper.ts) and the
 * admin fallback route (apps/api/src/routes/admin.ts:/sweep-claims) call this
 * function so the sweep logic + metrics increment is the single source of
 * truth. Mirrors the already-extracted pattern in subscription-renewer.ts
 * (`sweepDueSubscriptions`) and digest-sender.ts (`sweepDigests`).
 *
 * Idempotent: only `pending` rows past `expiresAt` are touched. A second
 * call in the same minute returns `expiredCount: 0`.
 */

import { store } from '../../store/index.js';
import { claimsExpired } from '../metrics.js';

export interface ClaimSweepResult {
  /** Number of claims that flipped from `pending` to `expired`. */
  expiredCount: number;
  /** Number of refund credits applied to senders. */
  refundsApplied: number;
}

export async function sweepExpiredClaims(): Promise<ClaimSweepResult> {
  const { expired, refundsApplied } = await store.expireClaimsBefore(new Date());
  if (expired.length > 0) claimsExpired.inc(expired.length);
  return { expiredCount: expired.length, refundsApplied };
}

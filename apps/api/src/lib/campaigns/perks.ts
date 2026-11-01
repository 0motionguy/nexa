/**
 * Sprint 10 Item F — campaigns + perks economic constants.
 *
 * Edit any of the four exports below and the whole campaigns/perks system
 * shifts: tier cutoffs, payout multipliers, points-per-USD by source, and
 * the per-user-per-campaign submission cap.
 *
 * `tierForPoints` and `multiplierForTier` are pure helpers used by the store
 * impls and the perks route. Points never expire (the tier downgrade case
 * never occurs by design).
 */
import type { PerkTier } from '../../store/types.js';

/** Lower-bound points to be in each tier. starter = 0..99, rising = 100..499, top = 500+. */
// F029 — module-private: only referenced inside this file. tierForPoints +
// nextTierTarget below are the public surface.
const TIER_THRESHOLDS = { starter: 0, rising: 100, top: 500 } as const;

/** Bonus multiplier applied to campaign payouts at each tier. */
export const TIER_MULTIPLIERS = { starter: 1.0, rising: 1.05, top: 1.1 } as const;

/**
 * Points awarded per USD by source.
 *   - earn: campaign payouts, payment-link receipts, agent earnings.
 *   - cardSpend: card purchases.
 */
export const POINTS_PER_USD = { earn: 1.0, cardSpend: 0.5 } as const;

/** Hard cap of submissions per user per campaign — enforced by a unique index. */
// F029 — module-private; the cap is enforced at the DB layer via a unique index
// (see nbCampaignSubmissions). The constant is kept for documentation symmetry.
const MAX_SUBMISSIONS_PER_CAMPAIGN = 1;
void MAX_SUBMISSIONS_PER_CAMPAIGN;

export function tierForPoints(points: number): PerkTier {
  const p = Number.isFinite(points) ? points : 0;
  if (p >= TIER_THRESHOLDS.top) return 'top';
  if (p >= TIER_THRESHOLDS.rising) return 'rising';
  return 'starter';
}

export function multiplierForTier(tier: PerkTier): number {
  return TIER_MULTIPLIERS[tier];
}

/**
 * Points to reach the next tier above the current one, or null at the top.
 * Used by GET /perks to surface a "next tier at X pts" UI string.
 */
export function nextTierAt(tier: PerkTier): number | null {
  if (tier === 'starter') return TIER_THRESHOLDS.rising;
  if (tier === 'rising') return TIER_THRESHOLDS.top;
  return null;
}

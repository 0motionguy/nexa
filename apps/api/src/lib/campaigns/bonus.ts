/**
 * F019 — campaign bonus accumulator, extracted from store/postgres.ts:2778
 * and store/in-memory.ts (equivalent block) so both implementations call one
 * source of truth.
 *
 * Sums the bonus dollars for every tier whose `viewsThreshold` is met by
 * the verified view count. Pure — no I/O.
 */

export interface BonusTier {
  /** Threshold the submission must hit to earn this tier's bonus. */
  viewsThreshold: number;
  /** Dollar amount added when the threshold is met. */
  bonusUsd: number;
}

/**
 * Sum the dollars across every tier whose threshold is met by `viewsVerified`.
 * Tiers are evaluated independently; tier values are NOT max-of, they
 * accumulate. (Example: tiers at 10k + 50k + 100k views, viewsVerified=60k →
 * payout includes the 10k and 50k tier bonuses, not the 100k.)
 *
 * Pure — no I/O, no side effects.
 */
export function sumBonusForViews(
  viewsVerified: number,
  bonusTiers: ReadonlyArray<BonusTier>,
): number {
  let bonus = 0;
  for (const tier of bonusTiers) {
    if (viewsVerified >= tier.viewsThreshold) bonus += Number(tier.bonusUsd);
  }
  return bonus;
}

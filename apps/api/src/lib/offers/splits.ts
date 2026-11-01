/**
 * F019 — pure split-portion math, extracted from store/postgres.ts:1412 and
 * store/in-memory.ts (equivalent block) so both implementations call one
 * source of truth.
 *
 * Side effects (locking ledger rows, debiting balances, emitting payouts) stay
 * inside the stores; this module only owns the math.
 */

import { round2 } from '../money.js';
import type { SplitRule } from '../../store/types.js';

export interface SplitPortion {
  /** The split rule that produced this portion. */
  rule: SplitRule;
  /** Dollar amount routed to this rule (rounded to cents). */
  amt: number;
}

export interface SplitDistribution {
  /** Per-rule portions, in input order. */
  portions: SplitPortion[];
  /**
   * Rounding remainder routed to the BASE target (sub-account if set on the
   * offer, else the seller's main balance). Together with `portions` this
   * sums exactly to the input amount, no money lost or doubled.
   */
  remainder: number;
}

/**
 * Compute per-rule portions + the remainder for a gross amount. Each portion
 * is `round2((amount * rule.percent) / 100)`; the BASE target receives
 * `amount - sum(portions)` so the full amount is always accounted for.
 *
 * Pure — no I/O, no side effects.
 */
export function computeSplitDistribution(
  amountUsd: number,
  splits: ReadonlyArray<SplitRule>,
): SplitDistribution {
  const portions: SplitPortion[] = splits.map((rule) => ({
    rule,
    amt: round2((amountUsd * rule.percent) / 100),
  }));
  const portionSum = portions.reduce((acc, p) => acc + p.amt, 0);
  const remainder = round2(amountUsd - portionSum);
  return { portions, remainder };
}

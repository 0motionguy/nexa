/**
 * F037 — property tests for the bonus accumulator.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sumBonusForViews } from './bonus.js';

describe('lib/campaigns/bonus — sumBonusForViews', () => {
  it('returns 0 when no tier is met', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(
          fc.record({
            viewsThreshold: fc.integer({ min: 10_000_000, max: 100_000_000 }),
            bonusUsd: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 0, maxLength: 5 },
        ),
        (views, tiers) => {
          expect(sumBonusForViews(views, tiers)).toBe(0);
        },
      ),
    );
  });

  it('returns 0 for empty tiers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e9 }), (views) => {
        expect(sumBonusForViews(views, [])).toBe(0);
      }),
    );
  });

  it('accumulates the bonus of every met tier (not just the top one)', () => {
    const tiers = [
      { viewsThreshold: 1_000, bonusUsd: 10 },
      { viewsThreshold: 10_000, bonusUsd: 50 },
      { viewsThreshold: 100_000, bonusUsd: 200 },
    ];
    expect(sumBonusForViews(500, tiers)).toBe(0);
    expect(sumBonusForViews(1_000, tiers)).toBe(10);
    expect(sumBonusForViews(10_000, tiers)).toBe(60);
    expect(sumBonusForViews(100_000, tiers)).toBe(260);
    expect(sumBonusForViews(999_999, tiers)).toBe(260);
  });

  it('is monotonic — more views never decrease the payout', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            viewsThreshold: fc.integer({ min: 0, max: 1_000_000 }),
            bonusUsd: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (tiers, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(sumBonusForViews(hi, tiers)).toBeGreaterThanOrEqual(sumBonusForViews(lo, tiers));
        },
      ),
    );
  });
});

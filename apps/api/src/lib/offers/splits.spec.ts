/**
 * F037 — property tests for the split distribution helper. The single
 * invariant that matters: portions + remainder always sum to the original
 * amount (no money lost or created).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeSplitDistribution } from './splits.js';

describe('lib/offers/splits — computeSplitDistribution', () => {
  it('portions + remainder always equal the gross amount (to cent precision)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        fc.array(
          fc.record({
            percent: fc.integer({ min: 0, max: 100 }),
            subAccountId: fc.constant(null),
            email: fc.constant(null),
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (amount, splitsRaw) => {
          // Cap total percent at 100 to model realistic offers.
          let totalPercent = 0;
          const splits = splitsRaw.map((s) => {
            const room = Math.max(0, 100 - totalPercent);
            const percent = Math.min(s.percent, room);
            totalPercent += percent;
            return { ...s, percent };
          });

          const { portions, remainder } = computeSplitDistribution(amount, splits);
          const portionSum = portions.reduce((acc, p) => acc + p.amt, 0);
          const total = portionSum + remainder;
          // Round both sides to cents — float noise on 2-decimal arithmetic.
          expect(Math.abs(total - amount)).toBeLessThan(0.01);
        },
      ),
    );
  });

  it('returns no portions when splits is empty; remainder equals input', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }), (amount) => {
        const { portions, remainder } = computeSplitDistribution(amount, []);
        expect(portions).toEqual([]);
        expect(remainder).toBeCloseTo(Math.round(amount * 100) / 100);
      }),
    );
  });

  it('each portion is exactly round2((amount * percent) / 100)', () => {
    const { portions } = computeSplitDistribution(100, [
      { percent: 30, subAccountId: null, email: null },
      { percent: 25, subAccountId: null, email: null },
    ]);
    expect(portions[0]!.amt).toBe(30);
    expect(portions[1]!.amt).toBe(25);
  });
});

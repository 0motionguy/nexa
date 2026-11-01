/**
 * F037 — property tests for the money helpers. Pure functions are the
 * cheapest target for fast-check; rounding/coercion bugs in `round2`/`n` would
 * cascade through every store/payout/payment path so we want broad coverage
 * without hand-picking values.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { n, round2 } from './money.js';

describe('lib/money — round2', () => {
  it('preserves any 2-decimal input exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (cents) => {
        const v = cents / 100;
        expect(round2(v)).toBe(v);
      }),
    );
  });

  it('rounds to a finite value for any realistic money amount', () => {
    // Bounded at ±1e9 USD — money in this system is bounded by the integer
    // numeric(18,6) column on the Postgres side anyway. The unbounded path
    // overflows because Math.round(v*100) loses precision at 1e15+; not a
    // round2 bug, a domain bound.
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }),
        (v) => {
          expect(Number.isFinite(round2(v))).toBe(true);
        },
      ),
    );
  });

  it('never exceeds 2 decimal places (within float precision)', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }), (v) => {
        const out = round2(v);
        // out * 100 should land on an integer (modulo float noise)
        const remainder = Math.abs(out * 100 - Math.round(out * 100));
        expect(remainder).toBeLessThan(1e-6);
      }),
    );
  });

  it('is idempotent — round2(round2(x)) === round2(x)', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }), (v) => {
        expect(round2(round2(v))).toBe(round2(v));
      }),
    );
  });
});

describe('lib/money — n', () => {
  it('returns 0 for null / undefined / NaN strings', () => {
    expect(n(null)).toBe(0);
    expect(n(undefined)).toBe(0);
    expect(n('not-a-number')).toBe(0);
    expect(n('')).toBe(0);
  });

  it('round-trips finite numbers through string form', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }), (v) => {
        // 6-decimal storage matches the postgres numeric(18,6) column shape.
        const asString = v.toFixed(6);
        const out = n(asString);
        expect(Math.abs(out - Number(asString))).toBeLessThan(1e-9);
      }),
    );
  });

  it('returns the same finite number it was given', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }), (v) => {
        expect(n(v)).toBe(v);
      }),
    );
  });
});

/**
 * Indicator math correctness — these pure functions live in `@nexa/charts`
 * but are tested here because the API workspace already runs vitest. They
 * underpin every overlay the chart renders; a regression breaks every
 * screen using the chart package, so they need green tests on every PR.
 *
 * Cases use small hand-computed expected values so a future change can be
 * audited line-by-line, not just "snapshot matches".
 */

import { describe, expect, it } from 'vitest';
import {
  atr,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  vwap,
  wma,
} from '../../../../packages/charts/src/indicators/index.js';
import { heikinAshi } from '../../../../packages/charts/src/engine/heikinAshi.js';
import type { Candle } from '../../../../packages/charts/src/types.js';

/** Helper: build a candle with everything pinned except close. */
function c(t: number, close: number, vol = 1, range = 0): Candle {
  return {
    t,
    o: close,
    h: close + range,
    l: close - range,
    c: close,
    v: vol,
    closed: true,
  };
}

const RISING = Array.from({ length: 20 }, (_, i) => c(i * 60_000, 100 + i));
const FLAT = Array.from({ length: 10 }, (_, i) => c(i * 60_000, 100));

/* ── SMA ───────────────────────────────────────────────────────────────── */

describe('sma', () => {
  it('mean of the trailing window', () => {
    const r = sma(RISING, 5);
    expect(r).toHaveLength(16);
    // SMA(5) at index 4: mean of 100..104 = 102.
    expect(r[0]?.v).toBeCloseTo(102);
    // SMA(5) at index 5: mean of 101..105 = 103.
    expect(r[1]?.v).toBeCloseTo(103);
  });

  it('zero-period or insufficient input returns []', () => {
    expect(sma(RISING, 0)).toEqual([]);
    expect(sma(RISING, 100)).toEqual([]);
  });
});

/* ── EMA ───────────────────────────────────────────────────────────────── */

describe('ema', () => {
  it('rises after a step up', () => {
    const r = ema(RISING, 5);
    expect(r).toHaveLength(16);
    expect(r[0]?.v).toBeCloseTo(102);          // seeded to SMA
    expect((r.at(-1)?.v ?? 0)).toBeGreaterThan(110);
  });

  it('flat input → flat output', () => {
    const r = ema(FLAT, 3);
    expect(r.every((p) => Math.abs(p.v - 100) < 1e-9)).toBe(true);
  });
});

/* ── WMA ───────────────────────────────────────────────────────────────── */

describe('wma', () => {
  it('newest bar dominates a flat window', () => {
    // 3-bar WMA: (1*100 + 2*100 + 3*100) / 6 = 100.
    const r = wma(FLAT, 3);
    expect(r.every((p) => Math.abs(p.v - 100) < 1e-9)).toBe(true);
  });

  it('rising series — last point exceeds SMA of same window', () => {
    const w = wma(RISING, 5).at(-1);
    const s = sma(RISING, 5).at(-1);
    expect((w?.v ?? 0)).toBeGreaterThan(s?.v ?? 0);
  });
});

/* ── VWAP ──────────────────────────────────────────────────────────────── */

describe('vwap', () => {
  it('flat price + equal volume → flat vwap', () => {
    const r = vwap(FLAT, 'cumulative');
    expect(r.every((p) => Math.abs(p.v - 100) < 1e-9)).toBe(true);
  });

  it('session window resets at UTC day boundary', () => {
    const day = 24 * 60 * 60 * 1000;
    const candles: Candle[] = [
      c(0, 100, 10),                        // session 1
      c(1_000, 100, 10),                    // session 1
      c(day, 200, 10),                      // session 2 — reset
      c(day + 1_000, 200, 10),              // session 2
    ];
    const r = vwap(candles, 'session');
    expect(r[1]?.v).toBeCloseTo(100);       // still session 1
    expect(r[2]?.v).toBeCloseTo(200);       // reset to session 2
  });
});

/* ── RSI ───────────────────────────────────────────────────────────────── */

describe('rsi', () => {
  it('flat series → undefined / not-meaningful (zero loss → 100)', () => {
    const r = rsi(FLAT, 5);
    // No gains and no losses; the formula returns 100 by convention.
    expect(r[0]?.v).toBe(100);
  });

  it('steadily rising → high (>70)', () => {
    const r = rsi(RISING, 5);
    expect(r.at(-1)?.v).toBeGreaterThan(70);
  });

  it('steadily falling → low (<30)', () => {
    const FALLING = Array.from({ length: 20 }, (_, i) => c(i * 60_000, 100 - i));
    const r = rsi(FALLING, 5);
    expect(r.at(-1)?.v).toBeLessThan(30);
  });
});

/* ── Bollinger ─────────────────────────────────────────────────────────── */

describe('bollinger', () => {
  it('flat input → bands collapse to the mean', () => {
    const { middle, upper, lower } = bollinger(FLAT, 5, 2);
    expect(middle.length).toBe(6);
    for (let i = 0; i < middle.length; i++) {
      expect(middle[i]?.v).toBeCloseTo(100);
      expect(upper[i]?.v).toBeCloseTo(100);
      expect(lower[i]?.v).toBeCloseTo(100);
    }
  });

  it('upper > middle > lower on a volatile series', () => {
    const { middle, upper, lower } = bollinger(RISING, 5, 2);
    expect((upper.at(-1)?.v ?? 0)).toBeGreaterThan(middle.at(-1)?.v ?? 0);
    expect((middle.at(-1)?.v ?? 0)).toBeGreaterThan(lower.at(-1)?.v ?? 0);
  });
});

/* ── MACD ──────────────────────────────────────────────────────────────── */

describe('macd', () => {
  it('rising series: macd line is positive', () => {
    const { macd: line } = macd(RISING, 5, 10, 3);
    expect((line.at(-1)?.v ?? 0)).toBeGreaterThan(0);
  });

  it('flat series: macd line is ~0', () => {
    const { macd: line } = macd(FLAT, 3, 5, 2);
    if (line.length > 0) expect(Math.abs(line.at(-1)?.v ?? 0)).toBeLessThan(1e-6);
  });
});

/* ── ATR ───────────────────────────────────────────────────────────────── */

describe('atr', () => {
  it('flat low/high → ATR ≈ 0', () => {
    const r = atr(FLAT, 5);
    if (r.length > 0) expect(r[0]?.v).toBeCloseTo(0);
  });

  it('volatile series → ATR > 0', () => {
    const volatile = Array.from({ length: 20 }, (_, i) =>
      c(i * 60_000, 100 + (i % 2 ? 5 : -5), 1, 3),
    );
    const r = atr(volatile, 5);
    expect((r.at(-1)?.v ?? 0)).toBeGreaterThan(0);
  });
});

/* ── Heikin-Ashi ───────────────────────────────────────────────────────── */

describe('heikinAshi', () => {
  it('empty input → empty output', () => {
    expect(heikinAshi([])).toEqual([]);
  });

  it('preserves length', () => {
    const r = heikinAshi(RISING);
    expect(r.length).toBe(RISING.length);
  });

  it('HA close at index t equals (o+h+l+c)/4 of the source candle', () => {
    const src = c(0, 100, 1, 4); // o=100, h=104, l=96, c=100
    const [r] = heikinAshi([src]);
    expect(r?.c).toBeCloseTo((100 + 104 + 96 + 100) / 4);
  });

  it('HA open at t > 0 averages prev HA open + prev HA close', () => {
    const src = [c(0, 100, 1, 2), c(60_000, 110, 1, 2)];
    const r = heikinAshi(src);
    expect(r[1]?.o).toBeCloseTo(((r[0]?.o ?? 0) + (r[0]?.c ?? 0)) / 2);
  });
});

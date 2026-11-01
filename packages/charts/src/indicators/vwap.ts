/**
 * Volume-Weighted Average Price.
 *
 *   typical_t = (h + l + c) / 3
 *   vwap_t   = Σ(typical_t * v_t) / Σ(v_t) over the active window
 *
 * `session`    — accumulator resets at each new UTC day boundary
 * `cumulative` — accumulator never resets; useful for back-tests
 */

import type { Candle, Point } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function vwap(
  candles: readonly Candle[],
  window: 'session' | 'cumulative' = 'session',
): readonly Point[] {
  if (candles.length === 0) return [];
  const out: Point[] = [];
  let pv = 0;
  let v = 0;
  let day = window === 'session' ? Math.floor((candles[0] as Candle).t / DAY_MS) : -1;
  for (const candle of candles) {
    if (window === 'session') {
      const d = Math.floor(candle.t / DAY_MS);
      if (d !== day) { pv = 0; v = 0; day = d; }
    }
    const typical = (candle.h + candle.l + candle.c) / 3;
    pv += typical * candle.v;
    v += candle.v;
    out.push({ t: candle.t, v: v === 0 ? typical : pv / v });
  }
  return out;
}

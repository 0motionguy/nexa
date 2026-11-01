/**
 * Exponential Moving Average — pure function, no side effects.
 *
 *   ema_t = price_t * k + ema_{t-1} * (1 - k)   where k = 2 / (period + 1)
 *
 * Seed: SMA of the first `period` values. Output is `period - 1` shorter
 * than the input on its leading edge.
 */

import type { Candle, Point } from '../types.js';

export function ema(candles: readonly Candle[], period: number): readonly Point[] {
  if (period <= 0 || candles.length < period) return [];
  const k = 2 / (period + 1);

  // Seed = SMA of the first `period` closes.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (candles[i] as Candle).c;
  let prev = sum / period;

  const out: Point[] = [];
  // First emitted point lines up with the `period - 1` index.
  out.push({ t: (candles[period - 1] as Candle).t, v: prev });
  for (let i = period; i < candles.length; i++) {
    const c = (candles[i] as Candle).c;
    prev = c * k + prev * (1 - k);
    out.push({ t: (candles[i] as Candle).t, v: prev });
  }
  return out;
}

/**
 * Bollinger Bands — `period`-bar SMA with upper / lower bands at
 * `stdDev` standard deviations above / below the mean.
 *
 * Returns three parallel series (middle, upper, lower) aligned to the same
 * timestamps. Output starts at the `period - 1` index.
 */

import type { Candle, Point } from '../types.js';

export interface BollingerOutput {
  readonly middle: readonly Point[];
  readonly upper: readonly Point[];
  readonly lower: readonly Point[];
}

export function bollinger(
  candles: readonly Candle[],
  period: number,
  stdDev: number,
): BollingerOutput {
  if (period <= 0 || candles.length < period) {
    return { middle: [], upper: [], lower: [] };
  }
  const middle: Point[] = [];
  const upper: Point[] = [];
  const lower: Point[] = [];

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (candles[j] as Candle).c;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = (candles[j] as Candle).c - mean;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / period);
    const t = (candles[i] as Candle).t;
    middle.push({ t, v: mean });
    upper.push({ t, v: mean + stdDev * sd });
    lower.push({ t, v: mean - stdDev * sd });
  }

  return { middle, upper, lower };
}

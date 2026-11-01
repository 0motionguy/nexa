/**
 * Weighted Moving Average — most recent bar weighs `period`, oldest weighs
 * 1. Sum of weights = period * (period + 1) / 2.
 */

import type { Candle, Point } from '../types.js';

export function wma(candles: readonly Candle[], period: number): readonly Point[] {
  if (period <= 0 || candles.length < period) return [];
  const denom = (period * (period + 1)) / 2;
  const out: Point[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let num = 0;
    for (let j = 0; j < period; j++) {
      const weight = j + 1; // oldest weight 1, newest weight `period`
      num += (candles[i - (period - 1) + j] as Candle).c * weight;
    }
    out.push({ t: (candles[i] as Candle).t, v: num / denom });
  }
  return out;
}

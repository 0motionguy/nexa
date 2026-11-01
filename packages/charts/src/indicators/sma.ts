/**
 * Simple Moving Average — rolling arithmetic mean of close prices over
 * the last `period` candles.
 */

import type { Candle, Point } from '../types.js';

export function sma(candles: readonly Candle[], period: number): readonly Point[] {
  if (period <= 0 || candles.length < period) return [];
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (candles[i] as Candle).c;
  out.push({ t: (candles[period - 1] as Candle).t, v: sum / period });
  for (let i = period; i < candles.length; i++) {
    sum += (candles[i] as Candle).c - (candles[i - period] as Candle).c;
    out.push({ t: (candles[i] as Candle).t, v: sum / period });
  }
  return out;
}

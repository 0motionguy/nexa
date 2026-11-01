/**
 * Relative Strength Index — Wilder's smoothing of gains and losses.
 *
 *   gain_t = max(0, close_t - close_{t-1})
 *   loss_t = max(0, close_{t-1} - close_t)
 *   avgGain_t = (avgGain_{t-1} * (period-1) + gain_t) / period
 *   avgLoss_t = (avgLoss_{t-1} * (period-1) + loss_t) / period
 *   RS  = avgGain / avgLoss
 *   RSI = 100 - 100 / (1 + RS)
 *
 * Seed: SMA of the first `period` gains / losses. Output is `period`
 * candles shorter than the input.
 */

import type { Candle, Point } from '../types.js';

export function rsi(candles: readonly Candle[], period: number): readonly Point[] {
  if (period <= 0 || candles.length <= period) return [];

  // Seed: SMA of gains/losses over the first `period` deltas.
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (candles[i] as Candle).c - (candles[i - 1] as Candle).c;
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  const out: Point[] = [];
  out.push({
    t: (candles[period] as Candle).t,
    v: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
  });

  for (let i = period + 1; i < candles.length; i++) {
    const d = (candles[i] as Candle).c - (candles[i - 1] as Candle).c;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const value = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    out.push({ t: (candles[i] as Candle).t, v: value });
  }
  return out;
}

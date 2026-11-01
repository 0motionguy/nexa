/**
 * Average True Range — Wilder's smoothed true range over `period` bars.
 *
 *   TR_t = max(h_t - l_t, |h_t - c_{t-1}|, |l_t - c_{t-1}|)
 *   ATR_t = (ATR_{t-1} * (period - 1) + TR_t) / period
 *
 * Seed: SMA of the first `period` true ranges.
 */

import type { Candle, Point } from '../types.js';

export function atr(candles: readonly Candle[], period: number): readonly Point[] {
  if (period <= 0 || candles.length <= period) return [];

  const trs: number[] = [0]; // TR[0] not defined without a prior close — placeholder.
  for (let i = 1; i < candles.length; i++) {
    const ci = candles[i] as Candle;
    const cp = candles[i - 1] as Candle;
    trs.push(Math.max(ci.h - ci.l, Math.abs(ci.h - cp.c), Math.abs(ci.l - cp.c)));
  }

  // Seed = SMA of TR[1..period].
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i] as number;
  let prev = sum / period;

  const out: Point[] = [{ t: (candles[period] as Candle).t, v: prev }];
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + (trs[i] as number)) / period;
    out.push({ t: (candles[i] as Candle).t, v: prev });
  }
  return out;
}

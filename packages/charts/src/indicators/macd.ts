/**
 * Moving Average Convergence Divergence.
 *
 *   macd_t      = EMA(close, fast)_t - EMA(close, slow)_t
 *   signal_t    = EMA(macd, signal)_t
 *   histogram_t = macd_t - signal_t
 *
 * Common defaults: fast=12, slow=26, signal=9.
 */

import type { Candle, Point } from '../types.js';
import { ema } from './ema.js';

export interface MacdOutput {
  readonly macd: readonly Point[];
  readonly signal: readonly Point[];
  readonly histogram: readonly Point[];
}

export function macd(
  candles: readonly Candle[],
  fast: number,
  slow: number,
  signalPeriod: number,
): MacdOutput {
  if (candles.length === 0 || fast <= 0 || slow <= 0 || signalPeriod <= 0) {
    return { macd: [], signal: [], histogram: [] };
  }

  const emaFast = ema(candles, fast);
  const emaSlow = ema(candles, slow);
  // Align EMAs by timestamp — the slow series is shorter on the leading edge.
  const macdLine: Point[] = [];
  const slowByT = new Map<number, number>();
  for (const p of emaSlow) slowByT.set(p.t, p.v);
  for (const f of emaFast) {
    const sv = slowByT.get(f.t);
    if (sv === undefined) continue;
    macdLine.push({ t: f.t, v: f.v - sv });
  }
  if (macdLine.length === 0) return { macd: [], signal: [], histogram: [] };

  // The MACD line itself is the input to the signal EMA. Reuse the `ema`
  // function by wrapping points as pseudo-candles where `c = macd.v`.
  const pseudo: Candle[] = macdLine.map((p) => ({
    t: p.t, o: p.v, h: p.v, l: p.v, c: p.v, v: 0, closed: true,
  }));
  const signal = ema(pseudo, signalPeriod);

  // Histogram aligns to the signal's timestamps (the macd line is longer
  // than the signal by `signalPeriod - 1`).
  const macdByT = new Map<number, number>();
  for (const p of macdLine) macdByT.set(p.t, p.v);
  const histogram: Point[] = signal.map((s) => ({
    t: s.t,
    v: (macdByT.get(s.t) ?? 0) - s.v,
  }));

  return { macd: macdLine, signal, histogram };
}

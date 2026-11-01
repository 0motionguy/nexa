import type { Candle } from '../types.js';

export type CandleRange = { high: number; low: number };

export function candleRange(candles: readonly Candle[]): CandleRange | null {
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;

  for (const c of candles) {
    if (Number.isFinite(c.h)) high = Math.max(high, c.h);
    if (Number.isFinite(c.l)) low = Math.min(low, c.l);
  }

  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low };
}

export function sameCandleRange(a: CandleRange | null, b: CandleRange | null): boolean {
  return a?.high === b?.high && a?.low === b?.low;
}

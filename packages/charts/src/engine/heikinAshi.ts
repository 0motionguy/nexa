/**
 * Heikin-Ashi transform — derives smoothed candles from a normal OHLC series.
 *
 *   HA.close = (o + h + l + c) / 4
 *   HA.open  = (prev HA.open + prev HA.close) / 2   (HA.open[0] = (o[0] + c[0]) / 2)
 *   HA.high  = max(h, HA.open, HA.close)
 *   HA.low   = min(l, HA.open, HA.close)
 *
 * Pure transform; volume / closed flag pass through unchanged.
 */

import type { Candle } from '../types.js';

export function heikinAshi(candles: readonly Candle[]): readonly Candle[] {
  if (candles.length === 0) return [];
  const out: Candle[] = [];
  const first = candles[0] as Candle;
  let prevOpen = (first.o + first.c) / 2;
  let prevClose = (first.o + first.h + first.l + first.c) / 4;
  out.push({
    t: first.t,
    o: prevOpen,
    h: Math.max(first.h, prevOpen, prevClose),
    l: Math.min(first.l, prevOpen, prevClose),
    c: prevClose,
    v: first.v,
    closed: first.closed,
  });
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i] as Candle;
    const haClose = (cur.o + cur.h + cur.l + cur.c) / 4;
    const haOpen = (prevOpen + prevClose) / 2;
    const haHigh = Math.max(cur.h, haOpen, haClose);
    const haLow = Math.min(cur.l, haOpen, haClose);
    out.push({
      t: cur.t,
      o: haOpen,
      h: haHigh,
      l: haLow,
      c: haClose,
      v: cur.v,
      closed: cur.closed,
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

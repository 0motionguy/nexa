import { describe, expect, it } from 'vitest';
import { candleRange, sameCandleRange } from './rangeLines.js';
import type { Candle } from '../types.js';

function candle(t: number, h: number, l: number): Candle {
  return { t, o: l, h, l, c: h, v: 1, closed: true };
}

describe('candleRange', () => {
  it('finds high and low across valid candles', () => {
    expect(candleRange([
      candle(1, 120, 100),
      candle(2, 140, 110),
      candle(3, 130, 90),
    ])).toEqual({ high: 140, low: 90 });
  });

  it('ignores invalid prices', () => {
    expect(candleRange([
      candle(1, Number.NaN, 100),
      candle(2, 140, Number.POSITIVE_INFINITY),
      candle(3, 130, 90),
    ])).toEqual({ high: 140, low: 90 });
  });

  it('recognizes unchanged ranges', () => {
    expect(sameCandleRange({ high: 140, low: 90 }, { high: 140, low: 90 })).toBe(true);
    expect(sameCandleRange({ high: 140, low: 90 }, { high: 141, low: 90 })).toBe(false);
    expect(sameCandleRange(null, { high: 140, low: 90 })).toBe(false);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import {
  _stopGlobalMetricsWarmLoopForTests,
  fngClassification,
  mapFngPayload,
  mapGlobalPayload,
  pushMcapPoint,
} from './global-metrics.js';

afterAll(() => {
  _stopGlobalMetricsWarmLoopForTests();
});

describe('mapFngPayload', () => {
  it('maps the current value + daily history oldest-first', () => {
    const out = mapFngPayload({
      data: [
        { value: '21', value_classification: 'Extreme Fear', timestamp: '1783036800' },
        { value: '19', value_classification: 'Extreme Fear', timestamp: '1782950400' },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.value).toBe(21);
    expect(out!.classification).toBe('Extreme Fear');
    expect(out!.history.map((p) => p.value)).toEqual([19, 21]);
    expect(out!.history[0].t).toBe(1782950400_000);
  });

  it('returns null on empty/garbage payloads', () => {
    expect(mapFngPayload(null)).toBeNull();
    expect(mapFngPayload({})).toBeNull();
    expect(mapFngPayload({ data: [{ value: 'nan' }] })).toBeNull();
  });

  it('falls back to the banded classification when upstream omits one', () => {
    const out = mapFngPayload({ data: [{ value: 88, timestamp: 1783036800 }] });
    expect(out!.classification).toBe('Extreme Greed');
  });
});

describe('fngClassification', () => {
  it('uses the alternative.me bands', () => {
    expect(fngClassification(10)).toBe('Extreme Fear');
    expect(fngClassification(30)).toBe('Fear');
    expect(fngClassification(50)).toBe('Neutral');
    expect(fngClassification(60)).toBe('Greed');
    expect(fngClassification(90)).toBe('Extreme Greed');
  });
});

describe('mapGlobalPayload', () => {
  it('maps mcap + change + dominance', () => {
    const out = mapGlobalPayload(
      {
        data: {
          total_market_cap: { usd: 2_233_431_021_560 },
          market_cap_change_percentage_24h_usd: -1.41,
          market_cap_percentage: { btc: 61.9 },
          updated_at: 1783036800,
        },
      },
      [],
    );
    expect(out).not.toBeNull();
    expect(out!.totalUsd).toBe(2_233_431_021_560);
    expect(out!.change24hPct).toBe(-1.41);
    expect(out!.btcDominancePct).toBe(61.9);
  });

  it('returns null without a usable usd total', () => {
    expect(mapGlobalPayload(null, [])).toBeNull();
    expect(mapGlobalPayload({ data: { total_market_cap: { btc: 1 } } }, [])).toBeNull();
  });
});

describe('pushMcapPoint', () => {
  it('appends, rate-limits to the min gap, and prunes the 24h window', () => {
    const series: Array<{ t: number; usd: number }> = [];
    const t0 = 1_783_000_000_000;
    pushMcapPoint(2.2e12, t0, series);
    // Too soon — dropped.
    pushMcapPoint(2.21e12, t0 + 60_000, series);
    expect(series).toHaveLength(1);
    // Past the gap — appended.
    pushMcapPoint(2.22e12, t0 + 5 * 60_000, series);
    expect(series).toHaveLength(2);
    // 25h later — the first two fall out of the window.
    pushMcapPoint(2.3e12, t0 + 25 * 3_600_000, series);
    expect(series).toHaveLength(1);
    expect(series[0].usd).toBe(2.3e12);
  });

  it('ignores non-finite values', () => {
    const series: Array<{ t: number; usd: number }> = [];
    pushMcapPoint(Number.NaN, 1, series);
    pushMcapPoint(-5, 2, series);
    expect(series).toHaveLength(0);
  });
});

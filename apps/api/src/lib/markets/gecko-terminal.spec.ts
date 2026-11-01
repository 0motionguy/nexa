import { describe, expect, it } from 'vitest';
import { cleanGtInterval, mapOhlcvList } from './gecko-terminal.js';

describe('cleanGtInterval', () => {
  it('accepts the four supported timeframes and defaults to 1h', () => {
    expect(cleanGtInterval('15m')).toBe('15m');
    expect(cleanGtInterval('4h')).toBe('4h');
    expect(cleanGtInterval('1d')).toBe('1d');
    expect(cleanGtInterval('7m')).toBe('1h');
    expect(cleanGtInterval(undefined)).toBe('1h');
  });
});

describe('mapOhlcvList', () => {
  it('maps GT rows (newest-first) to ascending HL-shaped candles in ms', () => {
    const out = mapOhlcvList(
      [
        [1783134000, 0.3628, 0.3748, 0.3508, 0.3523, 929778.89],
        [1783130400, 0.3111, 0.3851, 0.311, 0.3628, 2287325.96],
      ],
      'MINT',
      '1h',
    );
    expect(out).toHaveLength(2);
    expect(out[0].t).toBe(1783130400_000);
    expect(out[1].t).toBe(1783134000_000);
    expect(out[1].T - out[1].t).toBe(3_600_000);
    expect(out[0].o).toBe('0.3111');
    expect(out[0].s).toBe('MINT');
    expect(out[0].i).toBe('1h');
  });

  it('drops rows with non-finite prices/timestamps', () => {
    const out = mapOhlcvList(
      [
        [Number.NaN, 1, 1, 1, 1, 1],
        [1783130400, 'x', 1, 1, 1, 1],
        [1783134000, 1, 2, 0.5, 1.5, Number.NaN],
      ],
      'MINT',
      '15m',
    );
    expect(out).toHaveLength(1);
    expect(out[0].v).toBe('0');
    expect(out[0].T - out[0].t).toBe(15 * 60_000);
  });
});

import { describe, expect, it } from 'vitest';
import { formatHlPerpPx, formatHlSize, formatHlSpotPx, trimDecimalString } from './hl-format.js';

describe('hl-format — canonical Hyperliquid numbers (no trailing zeros)', () => {
  it('trimDecimalString strips trailing zeros and dangling dots', () => {
    expect(trimDecimalString('28.198400')).toBe('28.1984'); // only zeros stripped
    expect(trimDecimalString('28.20')).toBe('28.2');
    expect(trimDecimalString('100.000')).toBe('100');
    expect(trimDecimalString('62442')).toBe('62442');
    expect(trimDecimalString('0.400000')).toBe('0.4');
  });

  it('formatHlPerpPx: 5 sig figs, never trailing zeros (the phantom trigger)', () => {
    // The exact live-proven case: .toFixed(6) -> "28.198400" phantomed; canonical wins.
    expect(formatHlPerpPx(28.1984, undefined)).toBe('28.198');
    expect(formatHlPerpPx(62441.5, undefined)).toBe('62442'); // rounds to 5 sig figs, integer
    expect(formatHlPerpPx(28.4, undefined)).toBe('28.4');
    // No trailing zeros ever
    expect(formatHlPerpPx(28.2, undefined)).toBe('28.2');
    expect(formatHlPerpPx(100, undefined)).toBe('100');
  });

  it('formatHlSpotPx: same canonicalization for spot', () => {
    expect(formatHlSpotPx(70.496, undefined)).toBe('70.496');
    expect(formatHlSpotPx(0.0975, undefined)).toBe('0.0975');
    // .toFixed(6) style input never leaks trailing zeros through
    expect(formatHlSpotPx(Number((28.1984).toFixed(6)), undefined)).toBe('28.198');
  });

  it('formatHlSize: rounds to szDecimals, trims trailing zeros', () => {
    expect(formatHlSize(0.4, undefined)).toBe('0.4');
    expect(formatHlSize(0.070000123, 2)).toBe('0.07');
    expect(formatHlSize(1.5, 0)).toBe('2'); // szDecimals 0 rounds to integer
    expect(() => formatHlSize(0.0000001, 2)).toThrow(/size_below_lot/);
  });

  it('honors the decimal cap when szDecimals is known', () => {
    // perp cap = 6 - szDecimals; spot cap = 8 - szDecimals
    expect(formatHlPerpPx(28.19837, 4)).toBe('28.2'); // cap 2 -> 28.20 -> trim -> 28.2
    expect(formatHlSpotPx(28.19837, 4)).toBe('28.198'); // cap 4 -> 28.1980 -> trim
  });

  it('rejects non-positive / non-finite prices', () => {
    expect(() => formatHlPerpPx(0, undefined)).toThrow(/invalid_price/);
    expect(() => formatHlPerpPx(-1, undefined)).toThrow(/invalid_price/);
    expect(() => formatHlPerpPx(Number.NaN, undefined)).toThrow(/invalid_price/);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeGammaTimestamp } from './polymarket.js';

describe('normalizeGammaTimestamp', () => {
  it("normalizes Gamma's SQL-ish sports gameStartTime to ISO", () => {
    expect(normalizeGammaTimestamp('2026-07-03 05:40:00+00')).toBe('2026-07-03T05:40:00.000Z');
  });

  it('passes ISO timestamps through unchanged (canonicalized)', () => {
    expect(normalizeGammaTimestamp('2026-07-03T05:40:00Z')).toBe('2026-07-03T05:40:00.000Z');
  });

  it('returns null for empty or unparseable values', () => {
    expect(normalizeGammaTimestamp(undefined)).toBeNull();
    expect(normalizeGammaTimestamp('')).toBeNull();
    expect(normalizeGammaTimestamp('not a date')).toBeNull();
  });
});

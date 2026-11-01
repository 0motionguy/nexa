import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../env.js';
import {
  LIVE_WRITE_BLOCKED_COUNTRIES,
  isLiveWriteCountryAllowed,
  isRegionExemptUser,
} from './region.js';

afterEach(() => {
  env.LIVE_WRITE_REGION_EXEMPT_EMAILS = undefined;
});

describe('region gate', () => {
  it('blocks the compliance list for non-polymarket venues, allows others', () => {
    expect(isLiveWriteCountryAllowed('hyperliquid', 'DE')).toBe(false);
    expect(isLiveWriteCountryAllowed('jupiter', 'us')).toBe(false);
    expect(isLiveWriteCountryAllowed('hyperliquid', 'NL')).toBe(true);
    expect(isLiveWriteCountryAllowed('hyperliquid-spot', 'CH')).toBe(true);
    expect(LIVE_WRITE_BLOCKED_COUNTRIES.has('DE')).toBe(true);
  });

  it('polymarket venue delegates to the polymarket block list', () => {
    expect(isLiveWriteCountryAllowed('polymarket', 'US')).toBe(false);
    expect(isLiveWriteCountryAllowed('polymarket', 'NL')).toBe(true);
  });

  it('exemption is opt-in, comma-separated, case/whitespace-insensitive', () => {
    expect(isRegionExemptUser({ email: 'a@b.c' })).toBe(false);

    env.LIVE_WRITE_REGION_EXEMPT_EMAILS = ' Ops@Example.com , a@B.c ';
    expect(isRegionExemptUser({ email: 'A@b.C' })).toBe(true);
    expect(isRegionExemptUser({ email: 'ops@example.com' })).toBe(true);
    expect(isRegionExemptUser({ email: 'other@b.c' })).toBe(false);
    expect(isRegionExemptUser({ email: null })).toBe(false);
    expect(isRegionExemptUser({})).toBe(false);
  });
});

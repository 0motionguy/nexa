/**
 * Pump.fun adapter — upstream sort-key drift regression (2026-07-02).
 *
 * pump.fun removed `usd_market_cap` from /coins sort validation; the legacy
 * key 400s upstream (prod evidence: Sentry JAVASCRIPT-NEXTJS-2K; reproduced
 * externally). Every prod list call used that default → permanent demo
 * fallback. These tests pin the sort normalization and the truthful
 * freshness recording that surfaces degradation on /system/data-sources.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const httpRequest = vi.hoisted(() => vi.fn());
vi.mock('../http.js', () => ({ httpRequest }));

import { pumpfun, upstreamSort } from './pumpfun.js';
import { clearFreshness, lastFetch } from '../sourced.js';

afterEach(() => {
  httpRequest.mockReset();
  clearFreshness();
});

describe('pumpfun adapter', () => {
  it('maps the removed usd_market_cap sort to market_cap (identical ranking)', () => {
    expect(upstreamSort('usd_market_cap')).toBe('market_cap');
    expect(upstreamSort('market_cap')).toBe('market_cap');
    expect(upstreamSort('created_timestamp')).toBe('created_timestamp');
  });

  it('never sends the legacy usd_market_cap key upstream and records live freshness', async () => {
    httpRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ mint: 'MintAAA', symbol: 'AAA', name: 'AAA coin' }],
    });
    const res = await pumpfun.list({ sort: 'usd_market_cap', limit: 5 });
    expect(res.source).toBe('live');
    expect(res.memes[0]?.mint).toBe('MintAAA');
    const url = String(httpRequest.mock.calls[0]?.[0]);
    expect(url).toContain('sort=market_cap');
    expect(url).not.toContain('usd_market_cap');
    expect(lastFetch('pumpfun', 'market-list')?.source).toBe('live');
  });

  it('falls back to demo AND records provider-demo freshness on upstream rejection', async () => {
    httpRequest.mockResolvedValueOnce({ ok: false, status: 400 });
    const res = await pumpfun.list({ limit: 5 });
    expect(res.source).toBe('provider-demo');
    expect(res.memes.length).toBeGreaterThan(0);
    expect(lastFetch('pumpfun', 'market-list')?.source).toBe('provider-demo');
  });

  it('records provider-demo freshness when the fetch throws', async () => {
    httpRequest.mockRejectedValueOnce(new Error('network_down'));
    const res = await pumpfun.list({ limit: 5 });
    expect(res.source).toBe('provider-demo');
    expect(lastFetch('pumpfun', 'market-list')?.source).toBe('provider-demo');
  });
});

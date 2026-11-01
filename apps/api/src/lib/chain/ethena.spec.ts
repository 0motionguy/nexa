/**
 * Ethena adapter unit tests.
 *
 * The live API endpoint is mocked via the injected fetchImpl so tests stay
 * deterministic. Under VITEST the adapter's getApyBps refuses to call the
 * network; we only exercise the fetchSusdeApyBps helper with mocked fetch.
 */

import { describe, expect, it } from 'vitest';
import { ethenaAdapter, fetchEthenaSusdeApyBps } from './ethena.js';

function mockFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 503,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response) as unknown as typeof fetch;
}

describe('EthenaAdapter — read-only headline tile', () => {
  it('is always live (no auth gate on APY read)', () => {
    expect(ethenaAdapter.isLive).toBe(true);
  });

  it('getApyBps throws apy_unavailable under VITEST', async () => {
    await expect(ethenaAdapter.getApyBps()).rejects.toThrow(/apy_unavailable|Ethena APY unavailable/);
  });

  it('getTileSummary degrades to apyBps=0 when the live read fails', async () => {
    const summary = await ethenaAdapter.getTileSummary();
    expect(summary.apyBps).toBe(0);
    expect(summary.depositUrl).toMatch(/ethena\.fi/);
    expect(summary.riskCopy).toMatch(/Synthetic dollar/);
    expect(summary.readAt).toBeTruthy();
  });
});

describe('fetchEthenaSusdeApyBps — endpoint parsing', () => {
  it('parses top-level apy decimal (e.g. 0.18 = 18% = 1800 bps)', async () => {
    const fetchImpl = mockFetch({ apy: 0.18 });
    const bps = await fetchEthenaSusdeApyBps({ fetchImpl, apiUrl: 'http://test/' });
    expect(bps).toBe(1800);
  });

  it('parses apy as percentage when value > 1', async () => {
    const fetchImpl = mockFetch({ apy: 18 });
    const bps = await fetchEthenaSusdeApyBps({ fetchImpl, apiUrl: 'http://test/' });
    expect(bps).toBe(1800);
  });

  it('falls back to staking.apy when top-level is null', async () => {
    const fetchImpl = mockFetch({ apy: null, staking: { apy: 0.215 } });
    const bps = await fetchEthenaSusdeApyBps({ fetchImpl, apiUrl: 'http://test/' });
    expect(bps).toBe(2150);
  });

  it('falls back to data.apr when no apy is present', async () => {
    const fetchImpl = mockFetch({ data: { apr: 0.12 } });
    const bps = await fetchEthenaSusdeApyBps({ fetchImpl, apiUrl: 'http://test/' });
    expect(bps).toBe(1200);
  });

  it('throws apy_unavailable when the endpoint returns no usable shape', async () => {
    const fetchImpl = mockFetch({ unrelated: 'shape' });
    await expect(
      fetchEthenaSusdeApyBps({ fetchImpl, apiUrl: 'http://test/' }),
    ).rejects.toThrow(/apy_unavailable|Ethena APY unavailable/);
  });

  it('throws when the API returns non-2xx', async () => {
    const fetchImpl = mockFetch({}, false);
    await expect(
      fetchEthenaSusdeApyBps({ fetchImpl, apiUrl: 'http://test/' }),
    ).rejects.toThrow(/Ethena|rpc_failed/);
  });
});

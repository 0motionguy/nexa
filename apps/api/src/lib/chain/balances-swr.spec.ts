/**
 * SWR + coalescing on the portfolio fan-out (HANDOVER-2026-07-19-RPC-
 * PARITY): authed p95 was pinned at 937ms by cold fan-outs paying the
 * slowest vendor leg inline, and reconnect bursts ran one full RPC storm
 * per concurrent miss. Within BALANCES_SWR_MS of the last read the route
 * now answers from the retained snapshot and revalidates behind the
 * response; concurrent misses share one inflight fan-out.
 *
 * Seam: the EVM/Polygon/Solana legs stub to 0 under VITEST inside
 * balances.ts; the Hyperliquid leg calls hyperliquidSpot.getUserState —
 * spied here as the fan-out counter AND the controlled-latency leg. Only
 * `Date` is faked so real promises/timers behave natively.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBalancesCache, readPortfolioBalances } from './balances.js';
import { hyperliquidSpot } from '../markets/hyperliquid-spot.js';

type HlState = Awaited<ReturnType<typeof hyperliquidSpot.getUserState>>;
const hl = (usdcUsd: number): HlState => ({ usdcUsd }) as HlState;

const ARGS = {
  evmAddress: '0x00000000000000000000000000000000000000aa' as const,
  solanaAddress: 'So1anaAddrSwr',
};

const T0 = new Date('2026-07-19T12:00:00Z').getTime();

/** Let the background revalidate (pure microtasks + one macrotask) settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('readPortfolioBalances — SWR + coalescing', () => {
  beforeEach(() => {
    clearBalancesCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearBalancesCache();
  });

  it('TTL-fresh hits serve from cache without a fan-out', async () => {
    const spy = vi.spyOn(hyperliquidSpot, 'getUserState').mockResolvedValue(hl(5));

    const first = await readPortfolioBalances(ARGS);
    expect(first.cached).toBeUndefined();
    expect(first.totalUsd).toBe(5);
    expect(spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 10_000); // inside 30s TTL
    const second = await readPortfolioBalances(ARGS);
    expect(second.cached).toBe(true);
    expect(second.totalUsd).toBe(5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('inside the SWR window: serves the snapshot instantly, revalidates behind the response', async () => {
    const spy = vi.spyOn(hyperliquidSpot, 'getUserState').mockResolvedValue(hl(5));
    await readPortfolioBalances(ARGS);
    expect(spy).toHaveBeenCalledTimes(1);

    // Past the 30s TTL, inside the 60s SWR window. The refreshed value (9)
    // must NOT appear in this response — a block on the fan-out here is the
    // exact authed-p95 regression. Keep the vendor leg pending until after
    // the stale response returns to prove the read never awaited it.
    let releaseVendor!: (v: HlState) => void;
    spy.mockImplementation(() => new Promise<HlState>((res) => { releaseVendor = res; }));
    vi.setSystemTime(T0 + 40_000);

    const stale = await readPortfolioBalances(ARGS);
    expect(stale.cached).toBe(true);
    expect(stale.totalUsd).toBe(5); // snapshot, not the pending refresh
    expect(spy).toHaveBeenCalledTimes(2); // background revalidate DID launch

    releaseVendor(hl(9));
    await flush();

    // Revalidate landed: next read is a TTL-fresh hit on the NEW snapshot.
    const refreshed = await readPortfolioBalances(ARGS);
    expect(refreshed.cached).toBe(true);
    expect(refreshed.totalUsd).toBe(9);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('beyond the SWR window (idle user) the read blocks for fresh data', async () => {
    const spy = vi.spyOn(hyperliquidSpot, 'getUserState').mockResolvedValue(hl(5));
    await readPortfolioBalances(ARGS);

    vi.setSystemTime(T0 + 120_000); // past TTL AND past SWR
    spy.mockResolvedValue(hl(11));
    const out = await readPortfolioBalances(ARGS);
    expect(out.cached).toBeUndefined(); // blocked, not stale-served
    expect(out.totalUsd).toBe(11);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('forceFresh skips the stale serve but keeps TTL-fresh hits', async () => {
    const spy = vi.spyOn(hyperliquidSpot, 'getUserState').mockResolvedValue(hl(5));
    await readPortfolioBalances(ARGS);

    vi.setSystemTime(T0 + 40_000); // SWR window — default path would stale-serve
    spy.mockResolvedValue(hl(9));
    const fresh = await readPortfolioBalances(ARGS, { forceFresh: true });
    expect(fresh.cached).toBeUndefined();
    expect(fresh.totalUsd).toBe(9);
    expect(spy).toHaveBeenCalledTimes(2);

    // Immediately after: TTL-fresh hit — forceFresh keeps the pre-SWR contract.
    const hit = await readPortfolioBalances(ARGS, { forceFresh: true });
    expect(hit.cached).toBe(true);
    expect(hit.totalUsd).toBe(9);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('concurrent cold misses coalesce onto one fan-out', async () => {
    let releaseVendor!: (v: HlState) => void;
    const spy = vi
      .spyOn(hyperliquidSpot, 'getUserState')
      .mockImplementation(() => new Promise<HlState>((res) => { releaseVendor = res; }));

    const a = readPortfolioBalances(ARGS);
    const b = readPortfolioBalances(ARGS);
    const c = readPortfolioBalances(ARGS);
    expect(spy).toHaveBeenCalledTimes(1); // one storm, three awaiters

    releaseVendor(hl(7));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.totalUsd).toBe(7);
    expect(rb.totalUsd).toBe(7);
    expect(rc.totalUsd).toBe(7);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

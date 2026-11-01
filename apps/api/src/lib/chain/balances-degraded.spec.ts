/**
 * Scale plan 1.3 (2026-07-02) — /balances must never render a silent fake $0.
 *
 * Chain reads now return null on failure; the merge serves last-known-good
 * for the failing chain and flags the payload `degraded` + `staleChains`.
 */

import { describe, expect, it } from 'vitest';
import { mergePortfolioLegs, type PortfolioBalances } from './balances.js';

const WALLETS = { evm: '0x00000000000000000000000000000000000000aa', solana: 'So1anaAddr' };

describe('mergePortfolioLegs (never-silent-zero)', () => {
  it('all legs fresh → no degraded flag, totals add up', () => {
    const out = mergePortfolioLegs(
      { arbitrum: 100, polygon: 25, base: 50, solana: 10, hyperliquidSpot: 5 },
      undefined,
      WALLETS,
    );
    expect(out.degraded).toBeUndefined();
    expect(out.staleChains).toBeUndefined();
    expect(out.totalUsd).toBe(190);
    expect(out.buckets.perps.usd).toBe(105); // arbitrum + HL spot
  });

  it('failed leg with last-known-good → serves the stale value, flagged', () => {
    const lastGood = mergePortfolioLegs(
      { arbitrum: 100, polygon: 25, base: 50, solana: 10, hyperliquidSpot: 5 },
      undefined,
      WALLETS,
    ) as PortfolioBalances;
    const out = mergePortfolioLegs(
      { arbitrum: null, polygon: 25, base: 50, solana: 10, hyperliquidSpot: 5 },
      lastGood,
      WALLETS,
    );
    expect(out.degraded).toBe(true);
    expect(out.staleChains).toEqual(['arbitrum']);
    // The user's arbitrum money did NOT vanish to $0 — last-known-good served.
    expect(out.byChain.arbitrum).toBe(100);
    expect(out.totalUsd).toBe(190);
  });

  it('failed leg with NO history → 0 but still flagged degraded (client can say "updating")', () => {
    const out = mergePortfolioLegs(
      { arbitrum: null, polygon: 25, base: null, solana: 10, hyperliquidSpot: 5 },
      undefined,
      WALLETS,
    );
    expect(out.degraded).toBe(true);
    expect(out.staleChains).toEqual(['arbitrum', 'base']);
    expect(out.byChain.arbitrum).toBe(0);
    expect(out.totalUsd).toBe(40);
  });

  it('recovered leg overwrites the stale snapshot', () => {
    const stale = mergePortfolioLegs(
      { arbitrum: null, polygon: 25, base: 50, solana: 10, hyperliquidSpot: 5 },
      mergePortfolioLegs(
        { arbitrum: 100, polygon: 25, base: 50, solana: 10, hyperliquidSpot: 5 },
        undefined,
        WALLETS,
      ),
      WALLETS,
    );
    const recovered = mergePortfolioLegs(
      { arbitrum: 42, polygon: 25, base: 50, solana: 10, hyperliquidSpot: 5 },
      stale,
      WALLETS,
    );
    expect(recovered.degraded).toBeUndefined();
    expect(recovered.byChain.arbitrum).toBe(42);
  });
});

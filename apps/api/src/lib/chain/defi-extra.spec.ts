/**
 * DeFi diversification adapters (Sprint 7) — demo-mode unit tests.
 *
 * No chain keys in CI (ALCHEMY_API_KEY / BASE_RPC_URL / Privy all unset), so the
 * whole stack runs its demo fallback. We assert the demo contract holds:
 *   - Compound v3 (Comet) APY does not silently return a demo percentage
 *   - Morpho APY is parsed from the live GraphQL shape, not a demo percentage
 *   - Compound / Morpho deposit/withdraw resolve to demo when writes are not live
 *   - calldata encoding never throws (deposit completing proves the approve +
 *     Comet.supply / ERC-4626.deposit calls encode cleanly)
 *   - lifi.executeSwap returns a demo 0xdemo… hash (no real userop submitted)
 *
 * Live paths (Comet getSupplyRate, Morpho API, LIFI quote → 7702) are untestable
 * without keys and are covered structurally in each adapter.
 */

import { describe, expect, it } from 'vitest';
import { type ExecResult } from './alchemy.js';
import { compoundAdapter } from './compound.js';
import { fetchMorphoVaultApyBps, morphoAdapter } from './morpho.js';
import { lifiAdapter } from './lifi.js';

const DEMO_HASH = /^0xdemo[0-9a-f]{28}$/;

function expectDemo(r: ExecResult): void {
  expect(r.demo).toBe(true);
  expect(r.sponsored).toBe(false);
  expect(r.txHash).toMatch(DEMO_HASH);
}

describe('CompoundAdapter — diversification venue, demo mode', () => {
  it('is not live without keys', () => {
    expect(compoundAdapter.isLive).toBe(false);
  });

  it('getApyBps reports unavailable instead of returning a demo APY', async () => {
    await expect(compoundAdapter.getApyBps()).rejects.toThrow(/APY|SupplyRate|rpc/i);
  });

  it('depositUsd encodes approve + Comet.supply and resolves to a demo ExecResult', async () => {
    const r = await compoundAdapter.depositUsd('u', 100);
    expectDemo(r);
  });

  it('withdrawUsd encodes Comet.withdraw and resolves to a demo ExecResult', async () => {
    const r = await compoundAdapter.withdrawUsd('u', 50);
    expectDemo(r);
  });

  it('handles fractional amounts without throwing', async () => {
    const r = await compoundAdapter.depositUsd('u', 4820.4);
    expectDemo(r);
  });
});

describe('MorphoAdapter — diversification venue, demo mode', () => {
  it('is not live without keys', () => {
    expect(morphoAdapter.isLive).toBe(false);
  });

  it('fetchMorphoVaultApyBps parses netApy from Morpho V1 GraphQL', async () => {
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body ?? '{}')) as { variables?: { address?: string; chainId?: number } };
      expect(body.variables?.address).toBe('0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183');
      expect(body.variables?.chainId).toBe(8453);
      // Schema switched to V1 vaultByAddress on 2026-06-17 (Steakhouse pinned
      // vault is V1, not V2). Response now wraps fields under `state`.
      return Response.json({
        data: {
          vaultByAddress: {
            state: {
              netApy: 0.05234,
              netApyWithoutRewards: 0.041,
              apy: 0.06,
            },
          },
        },
      });
    };

    await expect(
      fetchMorphoVaultApyBps({
        fetchImpl,
        vaultAddress: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
        chainId: 8453,
      }),
    ).resolves.toBe(523);
  });

  it('getApyBps reports unavailable instead of returning a demo APY when Morpho is unreachable', async () => {
    await expect(morphoAdapter.getApyBps()).rejects.toThrow(/APY|Morpho/i);
  });

  it('depositUsd encodes approve + ERC-4626 deposit and resolves to a demo ExecResult', async () => {
    const r = await morphoAdapter.depositUsd('u', 100);
    expectDemo(r);
  });

  it('withdrawUsd encodes ERC-4626 withdraw and resolves to a demo ExecResult', async () => {
    const r = await morphoAdapter.withdrawUsd('u', 50);
    expectDemo(r);
  });
});

describe('LifiAdapter — same-chain swap, demo mode', () => {
  it('executeSwap returns a demo 0xdemo… hash', async () => {
    const r = await lifiAdapter.executeSwap('u', 'USDC', 'EURC', 100);
    expect(r.demo).toBe(true);
    expect(r.txHash).toMatch(DEMO_HASH);
  });
});

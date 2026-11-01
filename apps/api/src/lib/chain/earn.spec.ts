/**
 * Earn write-path — demo-mode unit tests.
 *
 * No chain keys in CI (ALCHEMY_API_KEY / BASE_RPC_URL / Privy all unset), so
 * the whole stack runs its demo fallback. We assert the demo contract holds:
 *   - the 7702 executor returns a `0xdemo…` hash, demo:true, sponsored:false
 *   - yoUSD / Aave APY reads do not silently return demo percentages
 *   - yoUSD (primary) and Aave (secondary) deposit/withdraw resolve to demo
 *   - calldata encoding never throws (the deposit path completing proves the
 *     approve + ERC-4626/Pool calls encode cleanly)
 *
 * The live JSON-RPC path (Alchemy wallet_prepareCalls → sign → sendPreparedCalls)
 * is untestable without keys and is covered structurally in alchemy.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { executor, type ExecResult } from './alchemy.js';
import { yoUsdAdapter } from './yousd.js';
import { aaveAdapter } from './defi.js';
import { env, features } from '../env.js';

const DEMO_HASH = /^0xdemo[0-9a-f]{28}$/;

function expectDemo(r: ExecResult): void {
  expect(r.demo).toBe(true);
  expect(r.sponsored).toBe(false);
  expect(r.txHash).toMatch(DEMO_HASH);
}

const originalLiveConfig = {
  alchemy: features.alchemy,
  chain: features.chain,
  privy: features.privy,
  alchemyApiKey: env.ALCHEMY_API_KEY,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  features.alchemy = originalLiveConfig.alchemy;
  features.chain = originalLiveConfig.chain;
  features.privy = originalLiveConfig.privy;
  env.ALCHEMY_API_KEY = originalLiveConfig.alchemyApiKey;
});

describe('BatchExecutor (7702) — demo mode', () => {
  it('is not live without keys', () => {
    expect(executor.isLive).toBe(false);
  });

  it('sendCalls returns a demo ExecResult with a 0xdemo hash', async () => {
    const r = await executor.sendCalls('u', []);
    expectDemo(r);
  });

  it('sendCalls never throws even with populated calls', async () => {
    const r = await executor.sendCalls('u', [
      { to: '0x0000000000000000000000000000000000000001', data: '0x' },
    ]);
    expectDemo(r);
  });

  it('treats a confirmed 0x0 receipt as failed', async () => {
    features.alchemy = true;
    features.chain = true;
    features.privy = true;
    env.ALCHEMY_API_KEY = 'alchemy_test_key';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        result: {
          status: 'CONFIRMED',
          receipts: [{ transactionHash: '0xabc', status: '0x0', logs: [] }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const status = await executor.getCallStatus('call_reverted', 8453);

    expect(status).toEqual({ status: 'FAILED', error: 'receipt_status_0x0' });
  });

  it('maps Alchemy numeric status 200 to CONFIRMED (real 7702 burns)', async () => {
    features.alchemy = true;
    features.chain = true;
    features.privy = true;
    env.ALCHEMY_API_KEY = 'alchemy_test_key';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        result: {
          status: 200,
          receipts: [{ transactionHash: '0xf00d', status: '0x1', logs: [] }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const status = await executor.getCallStatus('call_confirmed_numeric', 8453);

    expect(status).toMatchObject({ status: 'CONFIRMED', txHash: '0xf00d' });
  });

  it('maps Alchemy numeric status 500 to FAILED without failing on "unexpected status"', async () => {
    features.alchemy = true;
    features.chain = true;
    features.privy = true;
    env.ALCHEMY_API_KEY = 'alchemy_test_key';
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ result: { status: 500, receipts: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const status = await executor.getCallStatus('call_failed_numeric', 8453);

    expect(status).toEqual({ status: 'FAILED', error: 'status_500' });
  });
});

describe('YoUsdAdapter — primary earn, demo mode', () => {
  it('is not live without keys', () => {
    expect(yoUsdAdapter.isLive).toBe(false);
  });

  it('getApyBps reports unavailable instead of returning a demo APY', async () => {
    await expect(yoUsdAdapter.getApyBps()).rejects.toThrow(/APY/i);
  });

  it('deposit encodes approve + ERC-4626 deposit and resolves to a demo ExecResult', async () => {
    const r = await yoUsdAdapter.deposit('u', 100);
    expectDemo(r);
  });

  it('withdraw encodes ERC-4626 withdraw and resolves to a demo ExecResult', async () => {
    const r = await yoUsdAdapter.withdraw('u', 50);
    expectDemo(r);
  });

  it('handles fractional amounts without throwing', async () => {
    const r = await yoUsdAdapter.deposit('u', 4820.4);
    expectDemo(r);
  });
});

describe('AaveAdapter — secondary earn, demo mode', () => {
  it('getApy reports unavailable instead of returning a demo APY', async () => {
    await expect(aaveAdapter.getApy('USDC')).rejects.toThrow(/APY|ReserveData|rpc/i);
  });

  it('depositUsd encodes approve + Pool.supply and resolves to a demo ExecResult', async () => {
    const r = await aaveAdapter.depositUsd('u', 100);
    expectDemo(r);
  });

  it('withdrawUsd encodes Pool.withdraw and resolves to a demo ExecResult', async () => {
    const r = await aaveAdapter.withdrawUsd('u', 25);
    expectDemo(r);
  });
});

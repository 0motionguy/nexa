/**
 * Socket adapter — Swap V3 /v3/swap/quote parsing tests.
 *
 * Tests run without SOCKET_API_KEY (the default CI shape), so the demo path
 * returns null and the bridge router would degrade. To exercise the live path
 * we re-import the module with the key set and stub global fetch with a
 * canonical Socket response body.
 *
 * Source schema: https://docs.socket.tech/openapi.json (retrieved 2026-06-14).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeQuoteInput } from '../bridge-router.js';

const ORIGINAL_ENV = process.env;

function makeInput(overrides: Partial<BridgeQuoteInput> = {}): BridgeQuoteInput {
  return {
    fromChain: 'base',
    toChain: 'gnosis',
    fromToken: 'USDC',
    toToken: 'EURe',
    amountUsd: 50,
    userAddress: '0x000000000000000000000000000000000000dEaD',
    ...overrides,
  };
}

describe('SocketAdapter — demo mode (no key)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    delete process.env.SOCKET_API_KEY;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is not live without SOCKET_API_KEY', async () => {
    const { socketAdapter } = await import('./socket.js');
    expect(socketAdapter.isLive).toBe(false);
  });

  it('returns null from quote() when not live (router falls back to LIFI)', async () => {
    const { socketAdapter } = await import('./socket.js');
    const q = await socketAdapter.quote(makeInput());
    expect(q).toBeNull();
  });

  it('returns null for unknown chains even with a key present', async () => {
    process.env.SOCKET_API_KEY = 'sk_live_demo';
    const { socketAdapter } = await import('./socket.js');
    // arbitrum is supported but we don't map USDT on it in the TOKENS map.
    const q = await socketAdapter.quote(
      makeInput({ fromChain: 'arbitrum', toChain: 'base', fromToken: 'USDT', toToken: 'USDC' }),
    );
    expect(q).toBeNull();
  });
});

describe('SocketAdapter — live mode (stubbed fetch)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      SOCKET_API_KEY: 'sk_test_live',
      SOCKET_API_BASE: 'https://backend.socket.tech',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses a canonical /v3/swap/quote response into a BridgeQuote', async () => {
    const sampleResponse = {
      success: true,
      statusCode: 200,
      result: {
        routes: [
          {
            quoteId: '0xq1',
            output: {
              amount: '46000000',
              minAmountOut: '45540000',
              valueInUsd: 46,
            },
            txData: {
              kind: 'evm_tx',
              object: {
                chainId: 8453,
                to: '0xRouter000000000000000000000000000000beef',
                data: '0xdeadbeef',
                value: '0',
              },
            },
            gasFee: { feeInUsd: 0.42 },
          },
        ],
      },
    };
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/v3/swap/quote');
      expect(String(url)).toContain('originChainId=8453');
      expect(String(url)).toContain('destinationChainId=100');
      expect(String(url)).toContain('userOps=tx');
      return new Response(JSON.stringify(sampleResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { socketAdapter } = await import('./socket.js');
    const q = await socketAdapter.quote(makeInput());
    expect(q).not.toBeNull();
    expect(q?.provider).toBe('socket');
    expect(q?.calls).toHaveLength(1);
    expect(q?.calls[0].to).toBe('0xRouter000000000000000000000000000000beef');
    expect(q?.calls[0].data).toBe('0xdeadbeef');
    expect(q?.estimate.fromAmount).toBe('50000000');
    expect(q?.estimate.toAmount).toBe('46000000');
    expect(q?.estimate.toAmountMin).toBe('45540000');
    expect(q?.estimate.estimatedGasUsd).toBe(0.42);
    expect(q?.estimate.rate).toBeCloseTo(0.92);
    // Auth header sent under BOTH contested spellings; no Bearer.
    const callArgs = fetchMock.mock.calls[0][1];
    expect(callArgs?.headers).toMatchObject({
      'API-KEY': 'sk_test_live',
      'x-api-key': 'sk_test_live',
    });
    // No affiliate id set → no AFFILIATE-ID header.
    expect(callArgs?.headers).not.toHaveProperty('AFFILIATE-ID');
  });

  it('sends AFFILIATE-ID when SOCKET_AFFILIATE_ID is set', async () => {
    process.env.SOCKET_AFFILIATE_ID = 'aff_123';
    const sampleResponse = {
      success: true,
      result: {
        routes: [{
          quoteId: '0xq',
          output: { amount: '46000000', minAmountOut: '45540000' },
          txData: { kind: 'evm_tx', object: { chainId: 8453, to: '0xabc', data: '0xdef', value: '0' } },
          gasFee: { feeInUsd: 0.4 },
        }],
      },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(sampleResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { socketAdapter } = await import('./socket.js');
    await socketAdapter.quote(makeInput());
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'AFFILIATE-ID': 'aff_123' });
  });

  it('prepends a ready-made approval tx as calls[0] (approve, then swap)', async () => {
    const sampleResponse = {
      success: true,
      result: {
        routes: [{
          quoteId: '0xqA',
          output: { amount: '46000000', minAmountOut: '45540000' },
          approval: { txData: { object: { to: '0xToken', data: '0xapprove', value: '0' } } },
          txData: { kind: 'evm_tx', object: { chainId: 8453, to: '0xSwap', data: '0xswap', value: '0' } },
          gasFee: { feeInUsd: 0.4 },
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sampleResponse), { status: 200 })));
    const { socketAdapter } = await import('./socket.js');
    const q = await socketAdapter.quote(makeInput());
    expect(q?.calls).toHaveLength(2);
    expect(q?.calls[0]).toMatchObject({ to: '0xToken', data: '0xapprove' });
    expect(q?.calls[1]).toMatchObject({ to: '0xSwap', data: '0xswap' });
  });

  it('synthesizes approve() from allowance metadata when no approval tx is given', async () => {
    const sampleResponse = {
      success: true,
      result: {
        routes: [{
          quoteId: '0xqB',
          output: { amount: '46000000', minAmountOut: '45540000' },
          approval: {
            allowanceTarget: '0x1111111111111111111111111111111111111111',
            approvalTokenAddress: '0x2222222222222222222222222222222222222222',
            minimumApprovalAmount: '50000000',
          },
          txData: { kind: 'evm_tx', object: { chainId: 8453, to: '0xSwap', data: '0xswap', value: '0' } },
          gasFee: { feeInUsd: 0.4 },
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sampleResponse), { status: 200 })));
    const { socketAdapter } = await import('./socket.js');
    const q = await socketAdapter.quote(makeInput());
    expect(q?.calls).toHaveLength(2);
    // approve() call targets the token, encodes the ERC-20 approve selector.
    expect(q?.calls[0].to).toBe('0x2222222222222222222222222222222222222222');
    expect(q?.calls[0].data.startsWith('0x095ea7b3')).toBe(true);
    expect(q?.calls[1]).toMatchObject({ to: '0xSwap', data: '0xswap' });
  });

  it('single call when the route needs no approval', async () => {
    const sampleResponse = {
      success: true,
      result: {
        routes: [{
          quoteId: '0xqC',
          output: { amount: '46000000', minAmountOut: '45540000' },
          txData: { kind: 'evm_tx', object: { chainId: 8453, to: '0xSwap', data: '0xswap', value: '0' } },
          gasFee: { feeInUsd: 0.4 },
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sampleResponse), { status: 200 })));
    const { socketAdapter } = await import('./socket.js');
    const q = await socketAdapter.quote(makeInput());
    expect(q?.calls).toHaveLength(1);
    expect(q?.calls[0]).toMatchObject({ to: '0xSwap', data: '0xswap' });
  });

  it('passes refuel=true when enableRefuel is set, and surfaces refuelGasUsd', async () => {
    const sampleResponse = {
      success: true,
      statusCode: 200,
      result: {
        routes: [
          {
            quoteId: '0xq2',
            output: { amount: '46000000', minAmountOut: '45540000' },
            txData: { kind: 'evm_tx', object: { chainId: 8453, to: '0xabc', data: '0xdef', value: '0' } },
            gasFee: { feeInUsd: 0.5 },
            refuel: { estimatedOutputUsd: 0.07 },
          },
        ],
      },
    };
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('refuel=true');
      return new Response(JSON.stringify(sampleResponse), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { socketAdapter } = await import('./socket.js');
    const q = await socketAdapter.quote(makeInput({ enableRefuel: true }));
    expect(q?.estimate.refuelGasUsd).toBe(0.07);
  });

  it('returns null on HTTP error (bridge-router falls back to LIFI)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream rejected', { status: 502 })),
    );
    const { socketAdapter } = await import('./socket.js');
    expect(await socketAdapter.quote(makeInput())).toBeNull();
  });

  it('returns null when txData.object is missing from the route', async () => {
    const sampleResponse = {
      success: true,
      result: { routes: [{ quoteId: '0xq3', output: { amount: '0' } }] }, // no txData
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(sampleResponse), { status: 200 })),
    );
    const { socketAdapter } = await import('./socket.js');
    expect(await socketAdapter.quote(makeInput())).toBeNull();
  });
});

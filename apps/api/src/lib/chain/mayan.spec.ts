/**
 * Mayan Finance adapter tests — Sprint 15 alternative providers.
 *
 * The public quote API, execute pre-flight behavior, and capability metadata
 * are covered so the registry stays aligned with the routed Solana swap path.
 */

import { describe, expect, it } from 'vitest';
import {
  buildUsdcApproveCall,
  executeMayanSwap,
  fetchMayanQuote,
  mayanAdapter,
  mayanCapability,
} from './mayan.js';

describe('lib/chain/mayan', () => {
  it('parses a SWIFT quote response into the normalised shape', async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      expect(url).toContain('price-api.mayan.finance');
      expect(url).toContain('amountIn=100');
      expect(url).toContain('swift=true');
      return Response.json({
        quotes: [
          {
            type: 'SWIFT',
            expectedAmountOut: 99.619,
            minAmountOut: 96.598,
            price: 0.9969,
            etaSeconds: 3,
            redeemRelayerFee: 0.336,
            fromToken: { symbol: 'USDC' },
            toToken: { symbol: 'USDC' },
            fromChain: 'base',
            toChain: 'solana',
          },
        ],
      });
    };
    const out = await fetchMayanQuote(
      {
        amountIn: 100,
        fromToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        fromChain: 'base',
        toToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        toChain: 'solana',
        slippageBps: 300,
      },
      { fetchImpl },
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('SWIFT');
    expect(out[0].expectedAmountOut).toBeCloseTo(99.619);
    expect(out[0].etaSeconds).toBe(3);
    expect(out[0].fromSymbol).toBe('USDC');
  });

  it('sorts multiple quotes by expectedAmountOut desc', async () => {
    const fetchImpl = async (): Promise<Response> =>
      Response.json({
        quotes: [
          { type: 'WORMHOLE', expectedAmountOut: 95.0, minAmountOut: 92, price: 0.95, etaSeconds: 60, fromToken: { symbol: 'USDC' }, toToken: { symbol: 'USDC' }, fromChain: 'base', toChain: 'solana' },
          { type: 'SWIFT',    expectedAmountOut: 99.6, minAmountOut: 96, price: 0.996, etaSeconds: 3, fromToken: { symbol: 'USDC' }, toToken: { symbol: 'USDC' }, fromChain: 'base', toChain: 'solana' },
          { type: 'MCTP',     expectedAmountOut: 97.3, minAmountOut: 94, price: 0.973, etaSeconds: 15, fromToken: { symbol: 'USDC' }, toToken: { symbol: 'USDC' }, fromChain: 'base', toChain: 'solana' },
        ],
      });
    const out = await fetchMayanQuote(
      { amountIn: 100, fromToken: 'x', fromChain: 'base', toToken: 'y', toChain: 'solana', slippageBps: 300 },
      { fetchImpl },
    );
    expect(out.map((q) => q.type)).toEqual(['SWIFT', 'MCTP', 'WORMHOLE']);
  });

  it('throws ChainError when Mayan returns ROUTE_NOT_FOUND', async () => {
    const fetchImpl = async (): Promise<Response> =>
      Response.json({ code: 'ROUTE_NOT_FOUND', msg: 'no path' });
    await expect(
      fetchMayanQuote(
        { amountIn: 100, fromToken: 'x', fromChain: 'base', toToken: 'y', toChain: 'solana', slippageBps: 300 },
        { fetchImpl },
      ),
    ).rejects.toThrow(/Mayan: no path/);
  });

  it('capability snapshot pins surfaces + chains', () => {
    const cap = mayanCapability();
    expect(cap.provider).toBe('mayan');
    expect(cap.surfaces.quoteRead).toBe(true);
    expect(cap.surfaces.execute).toBe(true);
    expect(cap.supportedChains).toContain('base');
    expect(cap.supportedChains).toContain('solana');
    expect(cap.supportedChains).toContain('ethereum');
  });

  it('adapter reports live (quote API is public)', () => {
    expect(mayanAdapter.isLive).toBe(true);
  });

  it('adapter quote refuses to run in vitest (deterministic test guard)', async () => {
    await expect(
      mayanAdapter.quote({
        amountIn: 100,
        fromToken: 'x',
        fromChain: 'base',
        toToken: 'y',
        toChain: 'solana',
        slippageBps: 300,
      }),
    ).rejects.toThrow(/Mayan/);
  });

  /* Audit 2026-06-19 — executeMayanSwap pre-flight gating (cheap unit checks
   * without making the SDK fire). Real SDK paths are tested via Mirko pilot. */
  describe('executeMayanSwap pre-flight', () => {
    it('rejects EVM-source swaps when userId is missing', async () => {
      const r = await executeMayanSwap({
        // Minimal quote shape — only fromChain matters for the dispatch check.
        quote: { fromChain: 'base' } as never,
        fromAddress: '0x1111111111111111111111111111111111111111',
        toAddress: 'SoLAddressBase58',
      });
      expect(r.status).toBe('unavailable');
      if (r.status === 'unavailable') {
        expect(r.reason).toBe('evm_source_requires_userId');
      }
    });

    it('rejects Solana-source swaps when the Solana signer is missing', async () => {
      const r = await executeMayanSwap({
        quote: { fromChain: 'solana' } as never,
        fromAddress: 'SoLAddressBase58',
        toAddress: '0x1111111111111111111111111111111111111111',
      });
      expect(r.status).toBe('unavailable');
      if (r.status === 'unavailable') {
        expect(r.reason).toBe('solana_signer_missing');
      }
    });

    it('reports unsupported source chains explicitly', async () => {
      const r = await executeMayanSwap({
        quote: { fromChain: 'narnia' } as never,
        fromAddress: 'whatever',
        toAddress: 'whatever',
      });
      expect(r.status).toBe('unavailable');
      if (r.status === 'unavailable') {
        expect(r.reason).toBe('unsupported_source_chain:narnia');
      }
    });
  });

  /* ── TEST-03 (Sprint 17.5) — REL-03 USDC approve helper ───────────────── */
  describe('buildUsdcApproveCall (REL-03)', () => {
    it('targets the USDC contract address from env (ASSETS.USDC)', () => {
      const call = buildUsdcApproveCall('0xc0ffee0000000000000000000000000000000001');
      // Base mainnet USDC by default.
      expect(call.to.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    });

    it('encodes ERC-20 approve(spender, MAX_UINT256) calldata', () => {
      // All-lowercase 20-byte address (viem rejects mixed-case unless EIP-55).
      const spender = '0x1234567890abcdef1234567890abcdef12345678';
      const call = buildUsdcApproveCall(spender);
      // approve(address,uint256) selector = 0x095ea7b3
      expect(call.data.startsWith('0x095ea7b3')).toBe(true);
      // Spender (20 bytes left-padded to 32) appears in calldata.
      expect(call.data.toLowerCase()).toContain(
        '0000000000000000000000001234567890abcdef1234567890abcdef12345678',
      );
      // MAX_UINT256 (all-f, 32 bytes) appears as the amount.
      expect(call.data.toLowerCase()).toContain(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      );
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { features } from '../env.js';

vi.mock('./hl-signer.js', () => ({
  hlSignL1Action: vi.fn(async () => ({
    r: ('0x' + '11'.repeat(32)) as `0x${string}`,
    s: ('0x' + '22'.repeat(32)) as `0x${string}`,
    v: 27,
  })),
  nextHlNonce: vi.fn(() => Date.now()),
}));

import { hyperliquidSpot } from './hyperliquid-spot.js';

const ADDRESS = '0xebde45ee1e224aa5e304089aaa3a313c01a30f63';
const WALLET_ID = 'wallet_hls_test';
const WALLET_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const originalMarkets = features.markets;
const originalPrivy = features.privy;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  features.markets = true;
  features.privy = false;
});

afterEach(() => {
  features.markets = originalMarkets;
  features.privy = originalPrivy;
  (hyperliquidSpot as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HyperliquidSpotAdapter.getUserState', () => {
  it('reads spot balances when market data is enabled even if live trading is off', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        type: 'spotClearinghouseState',
        user: ADDRESS,
      });
      return jsonResponse({
        balances: [
          { coin: 'USDC', total: '15.118582', hold: '0.0', entryNtl: '0.0' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const state = await hyperliquidSpot.getUserState(ADDRESS);

    expect(state.live).toBe(true);
    expect(state.usdcUsd).toBe(15.118582);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('HyperliquidSpotAdapter.getMarketsResult', () => {
  it('resolves spot universe token ids by token.index, not token array offset', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([
      {
        tokens: [
          { name: 'USDC', index: 0 },
          { name: 'PURR', index: 7 },
        ],
        universe: [
          { name: '@42', tokens: [7, 0], index: 42, isCanonical: false },
        ],
      },
      [
        { markPx: '0.1', prevDayPx: '0.08', dayNtlVlm: '1234' },
      ],
    ]));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await hyperliquidSpot.getMarketsResult();

    expect(result.source).toBe('live');
    expect(result.markets).toEqual([
      expect.objectContaining({
        coin: '@42',
        displayName: 'PURR/USDC',
        baseToken: 'PURR',
        quoteToken: 'USDC',
        index: 42,
      }),
    ]);
  });

  it('joins asset ctxs by coin key — the upstream arrays are NOT parallel', async () => {
    // Real-world shape (probed 2026-07-03): ctxs carries MORE rows than the
    // universe and in a different order — a positional zip priced WOW at a
    // neighbouring pair's $68.83 instead of its real $0.0005965.
    const fetchSpy = vi.fn(async () => jsonResponse([
      {
        tokens: [
          { name: 'USDC', index: 0 },
          { name: 'WOW', index: 98 },
          { name: 'PURR', index: 1 },
        ],
        universe: [
          { name: 'PURR/USDC', tokens: [1, 0], index: 0, isCanonical: true },
          { name: '@109', tokens: [98, 0], index: 109, isCanonical: false },
        ],
      },
      [
        // Extra delisted row first + shuffled order — positional zip would
        // give PURR the delisted price and @109 PURR's price.
        { coin: '@7', markPx: '68.83', prevDayPx: '70.1', dayNtlVlm: '1' },
        { coin: '@109', markPx: '0.0005965', prevDayPx: '0.0005965', dayNtlVlm: '67018828' },
        { coin: 'PURR/USDC', markPx: '0.094829', prevDayPx: '0.086203', dayNtlVlm: '776172' },
      ],
    ]));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await hyperliquidSpot.getMarketsResult();

    expect(result.source).toBe('live');
    const wow = result.markets.find((m) => m.coin === '@109');
    const purr = result.markets.find((m) => m.coin === 'PURR/USDC');
    expect(wow?.priceUsd).toBe(0.0005965);
    expect(wow?.dayVolumeUsd).toBe(67018828);
    expect(purr?.priceUsd).toBe(0.094829);
    expect(purr?.change24hPct).toBeCloseTo(10.01, 1);
  });
});

describe('HyperliquidSpotAdapter live venue status handling', () => {
  beforeEach(() => {
    features.markets = true;
    features.privy = true;
    (hyperliquidSpot as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = new Map([['@1', 10001]]);
    vi.spyOn(hyperliquidSpot, 'getMarket').mockResolvedValue({
      coin: '@1',
      displayName: 'PURR/USDC',
      baseToken: 'PURR',
      quoteToken: 'USDC',
      priceUsd: 0.1,
      change24hPct: null,
      dayVolumeUsd: null,
      index: 1,
    });
  });

  it('rejects per-order venue errors instead of reporting order_missing_oid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      status: 'ok',
      response: { data: { statuses: [{ error: 'Spot order rejected.' }] } },
    })));

    await expect(hyperliquidSpot.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: '@1',
      sideLong: true,
      qtyUsd: 10,
      orderType: 'market',
    })).rejects.toThrow(/order_rejected/);
  });

  it('rejects per-cancel venue errors instead of reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      status: 'ok',
      response: { data: { statuses: [{ error: 'Spot order already filled.' }] } },
    })));

    await expect(hyperliquidSpot.cancelOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: '@1',
      externalRef: 'hls_123',
    })).rejects.toThrow(/cancel_rejected/);
  });
});

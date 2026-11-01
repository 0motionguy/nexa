/**
 * HL adapter v2 — body-shape unit tests for the 9 methods added in the order
 * expansion (cancelMany, modifyOrder, updateLeverage, updateIsolatedMargin,
 * usdClassTransfer, withdraw3, getOpenOrders, getUserFills, getUserState).
 *
 * Goal: lock the wire shape against regression so a typo in an action key
 * or signing call surfaces in CI instead of in production trading.
 *
 * Mocks (mirrors markets.spec.ts pattern):
 *   - hlSignL1Action / hlSignUserSignedAction → fake (r,s,v)
 *   - signTypedDataWithPrivy → fake signature
 *   - global fetch → vi.fn() so we can inspect the request body
 *   - resolveAssetId is bypassed via pre-seeded private cache so we don't have
 *     to answer a {type:'meta'} round-trip in every test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, features } from '../env.js';

vi.mock('./hl-signer.js', () => ({
  hlSignL1Action: vi.fn(async () => ({
    r: ('0x' + '11'.repeat(32)) as `0x${string}`,
    s: ('0x' + '22'.repeat(32)) as `0x${string}`,
    v: 27,
  })),
  hlSignUserSignedAction: vi.fn(async () => ({
    r: ('0x' + '33'.repeat(32)) as `0x${string}`,
    s: ('0x' + '44'.repeat(32)) as `0x${string}`,
    v: 28,
  })),
  nextHlNonce: vi.fn(() => Date.now()),
  HL_USER_SIGN_CHAIN_ID: '0x66eee',
  HL_HYPERLIQUID_CHAIN: 'Mainnet',
}));

vi.mock('../privy.js', () => ({
  signTypedDataWithPrivy: vi.fn(async () => '0x' + 'aa'.repeat(65)),
}));

import { hyperliquid } from './hyperliquid.js';
import { hlSignL1Action, hlSignUserSignedAction } from './hl-signer.js';

const WALLET_ID = 'wallet_hl_test';
const WALLET_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const BUILDER_ADDRESS = '0x1111111111111111111111111111111111111111';
const okResponse = (body: unknown = { status: 'ok', response: { data: { statuses: [{ resting: { oid: 42 } }] } } }) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const originalMarketsEnabled = features.markets;
const originalPrivyEnabled = features.privy;
const originalHlBuilderAddress = env.HL_BUILDER_ADDRESS;
const originalHlBuilderFeeTenths = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP;

function enterLiveTrading(): void {
  features.markets = true;
  features.privy = true;
  env.HL_BUILDER_ADDRESS = BUILDER_ADDRESS;
  // Pre-seed the private asset cache so resolveAssetId doesn't fire a real
  // {type:'meta'} fetch in every test. Each spec only cares about the action
  // body, not the meta round-trip.
  (hyperliquid as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = new Map([
    ['BTC', 0],
    ['ETH', 4],
    ['SOL', 5],
  ]);
}

beforeEach(() => {
  features.markets = false;
  vi.clearAllMocks();
});

afterEach(() => {
  features.markets = originalMarketsEnabled;
  features.privy = originalPrivyEnabled;
  env.HL_BUILDER_ADDRESS = originalHlBuilderAddress;
  env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = originalHlBuilderFeeTenths;
  (hyperliquid as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastFetchAction(): { type: string; [k: string]: unknown } {
  const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastBody = calls[calls.length - 1][1].body as string;
  const parsed = JSON.parse(lastBody) as { action: { type: string; [k: string]: unknown } };
  return parsed.action;
}

function lastFetchUrl(): string {
  const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0] as string;
}

// ────────────────────────────────────────────────────────────────────────────
// cancelMany
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.cancelMany', () => {
  it('demo path returns one ok=true entry per requested cancel', async () => {
    const out = await hyperliquid.cancelMany({
      privyWalletId: null,
      privyWalletAddress: null,
      cancels: [
        { coin: 'BTC', orderId: 'hl_111' },
        { coin: 'ETH', orderId: 'hl_222' },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.ok)).toBe(true);
  });

  it('live path POSTs {type:"cancel", cancels:[{a,o}…]} with one entry per parsed oid', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.cancelMany({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      cancels: [
        { coin: 'BTC', orderId: 'hl_111' },
        { coin: 'ETH', orderId: 'hl_222' },
      ],
    });

    expect(out.ok).toBe(true);
    const action = lastFetchAction();
    expect(action.type).toBe('cancel');
    expect(action.cancels).toEqual([
      { a: 0, o: 111 }, // BTC = asset 0
      { a: 4, o: 222 }, // ETH = asset 4
    ]);
    expect(hlSignL1Action).toHaveBeenCalledTimes(1);
  });

  it('live path returns per-entry errors when the venue rejects a cancel status', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({
      status: 'ok',
      response: { data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.cancelMany({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      cancels: [{ coin: 'BTC', orderId: 'hl_111' }],
    });

    expect(out.ok).toBe(true);
    expect(out.results).toEqual([
      {
        orderId: 'hl_111',
        ok: false,
        error: {
          code: 'venue_cancel_failed',
          message: 'Order was never placed, already canceled, or filled.',
        },
      },
    ]);
  });

  it('live path: empty cancels short-circuits with no fetch', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.cancelMany({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      cancels: [],
    });
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hlSignL1Action).not.toHaveBeenCalled();
  });

  it('live path: unparseable orderIds return per-entry invalid_oid errors and skip the venue call', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.cancelMany({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      cancels: [
        { coin: 'BTC', orderId: 'not-a-number' },
        { coin: 'ETH', orderId: 'still-not' },
      ],
    });

    expect(out.ok).toBe(true);
    expect(out.results.every((r) => !r.ok && r.error?.code === 'invalid_oid')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// modifyOrder
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.modifyOrder', () => {
  it('demo path returns the same orderId with state="resting" and demo=true', async () => {
    const out = await hyperliquid.modifyOrder({
      privyWalletId: null,
      privyWalletAddress: null,
      coin: 'BTC',
      orderId: 'hl_42',
      order: {
        privyWalletId: null,
        privyWalletAddress: null,
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 100,
        leverage: 5,
        kind: 'limit',
        limitPriceUsd: 60_000,
      },
    });
    expect(out.demo).toBe(true);
    expect(out.orderId).toBe('hl_42');
    expect(out.state).toBe('resting');
  });

  const OPEN_LIMIT_42 = {
    orderId: 'hl_42',
    coin: 'BTC',
    sideLong: true,
    qty: 0.01,
    qtyUsd: 600,
    limitPriceUsd: 60_000,
    triggerPriceUsd: null,
    tif: 'Gtc' as const,
    kind: 'limit' as const,
    reduceOnly: false,
    createdAtMs: 0,
  };

  it('live (flat limit) POSTs singular {type:"modify", oid, order:{a,b,p,s,r,t:{limit:{tif}}}}', async () => {
    enterLiveTrading();
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 60_000,
      change24hPct: null,
    });
    vi.spyOn(hyperliquid, 'getOpenOrders').mockResolvedValue([OPEN_LIMIT_42]);
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.modifyOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      orderId: 'hl_42',
      order: {
        privyWalletId: WALLET_ID,
        privyWalletAddress: WALLET_ADDRESS,
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 600,
        leverage: 5,
        kind: 'limit',
        tif: 'Gtc',
        limitPriceUsd: 60_000,
      },
    });

    const action = lastFetchAction() as {
      type: string;
      oid: number;
      order: { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif: string } } };
    };
    expect(action.type).toBe('modify');
    expect(action.oid).toBe(42);
    expect(action.order.a).toBe(0);
    expect(action.order.b).toBe(true);
    expect(action.order.p).toBe('60000');
    expect(action.order.t.limit?.tif).toBe('Gtc');
  });

  it('preserves the RESTING order size / TIF / reduce-only — never resizes from qtyUsd at the current mark', async () => {
    enterLiveTrading();
    // Mark has moved 60k → 40k since placement; the old qtyUsd/refPrice math
    // would have replaced 0.01 BTC with 600/40000 = 0.015 BTC (+50%).
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 40_000,
      change24hPct: null,
    });
    vi.spyOn(hyperliquid, 'getOpenOrders').mockResolvedValue([
      { ...OPEN_LIMIT_42, tif: 'Alo', reduceOnly: true },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ status: 'ok' })));

    const out = await hyperliquid.modifyOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      orderId: 'hl_42',
      order: {
        privyWalletId: WALLET_ID,
        privyWalletAddress: WALLET_ADDRESS,
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 600,
        leverage: 5,
        kind: 'limit',
        tif: 'Gtc', // client-supplied — the venue order's Alo must win
        limitPriceUsd: 59_000,
      },
    });

    const action = lastFetchAction() as {
      order: { b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif: string } } };
    };
    expect(action.order.s).toBe('0.01');           // size preserved
    expect(action.order.r).toBe(true);             // reduce-only preserved
    expect(action.order.t.limit?.tif).toBe('Alo'); // post-only preserved
    expect(action.order.p).toBe('59000');          // only the price moved
    expect(out.filledQtyUsd).toBeCloseTo(0.01 * 59_000);
  });

  it('throws order_not_found when the oid is no longer resting on the venue', async () => {
    enterLiveTrading();
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 60_000,
      change24hPct: null,
    });
    vi.spyOn(hyperliquid, 'getOpenOrders').mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ status: 'ok' })));

    await expect(
      hyperliquid.modifyOrder({
        privyWalletId: WALLET_ID,
        privyWalletAddress: WALLET_ADDRESS,
        coin: 'BTC',
        orderId: 'hl_42',
        order: {
          privyWalletId: WALLET_ID,
          privyWalletAddress: WALLET_ADDRESS,
          coin: 'BTC',
          sideLong: true,
          qtyUsd: 600,
          leverage: 5,
          kind: 'limit',
          limitPriceUsd: 59_000,
        },
      }),
    ).rejects.toThrow('order_not_found');
  });

  it('live (stopLimit kind) routes through the trigger leg, not the limit leg', async () => {
    enterLiveTrading();
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 60_000,
      change24hPct: null,
    });
    vi.spyOn(hyperliquid, 'getOpenOrders').mockResolvedValue([
      {
        ...OPEN_LIMIT_42,
        orderId: 'hl_99',
        sideLong: false,
        limitPriceUsd: 57_000,
        triggerPriceUsd: 58_500,
        tif: null,
        kind: 'stopLimit',
      },
    ]);
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.modifyOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      orderId: 'hl_99',
      order: {
        privyWalletId: WALLET_ID,
        privyWalletAddress: WALLET_ADDRESS,
        coin: 'BTC',
        sideLong: false,
        qtyUsd: 600,
        leverage: 5,
        kind: 'stopLimit',
        triggerPriceUsd: 58_000,
        limitPriceUsd: 57_500,
        stopKind: 'sl',
      },
    });

    const action = lastFetchAction() as { order: { t: { trigger?: { triggerPx: string; isMarket: boolean; tpsl: string }; limit?: unknown } } };
    const t = action.order.t;
    expect(t.trigger).toBeDefined();
    expect(t.limit).toBeUndefined();
    expect(t.trigger?.tpsl).toBe('sl');
    expect(t.trigger?.isMarket).toBe(false);
    expect(t.trigger?.triggerPx).toBe('58000');
  });
});

describe('HyperliquidAdapter.placeOrder builder fee wiring', () => {
  it('live trading surfaces per-order venue errors instead of order_missing_oid', async () => {
    enterLiveTrading();
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 60_000,
      change24hPct: null,
      fundingRate: null,
      openInterestUsd: null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      status: 'ok',
      response: { data: { statuses: [{ error: 'Insufficient margin to place order.' }] } },
    })));

    await expect(hyperliquid.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    })).rejects.toThrow(/order_rejected/);
  });

  it('live trading does not require a builder address when fee is zero', async () => {
    features.markets = true;
    features.privy = true;
    env.HL_BUILDER_ADDRESS = undefined;
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 0;
    (hyperliquid as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = new Map([['BTC', 0]]);
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 60_000,
      change24hPct: null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      status: 'ok',
      response: { data: { statuses: [{ filled: { oid: 42, avgPx: '60050' } }] } },
    })));

    const result = await hyperliquid.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 600,
      leverage: 1,
      orderType: 'market',
    });

    expect(result.demo).toBe(false);
    expect(result.entryPriceUsd).toBe(60_050);
    expect(lastFetchAction()).not.toHaveProperty('builder');
  });

  it('caps submitted builder fee at the Hyperliquid 10 bps max', async () => {
    enterLiveTrading();
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 250;
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 60_000,
      change24hPct: null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      status: 'ok',
      response: { data: { statuses: [{ filled: { oid: 43, avgPx: '60000' } }] } },
    })));

    await hyperliquid.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 600,
      leverage: 1,
      orderType: 'market',
    });

    const action = lastFetchAction() as { builder?: { f: number } };
    expect(action.builder?.f).toBe(100);
  });

  it('uses positive slippage prices for market TP/SL trigger legs', async () => {
    enterLiveTrading();
    vi.spyOn(hyperliquid, 'getMarket').mockResolvedValue({
      coin: 'BTC',
      priceUsd: 60_000,
      change24hPct: null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      status: 'ok',
      response: {
        data: {
          statuses: [
            { filled: { oid: 44, avgPx: '60000' } },
            { resting: { oid: 45 } },
            { resting: { oid: 46 } },
          ],
        },
      },
    })));

    await hyperliquid.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 600,
      leverage: 1,
      kind: 'market',
      takeProfit: { triggerPriceUsd: 66_000, isMarket: true },
      stopLoss: { triggerPriceUsd: 57_000, isMarket: true },
    });

    const action = lastFetchAction() as {
      grouping?: string;
      orders?: Array<{ p: string; t?: { trigger?: { isMarket?: boolean } } }>;
    };
    expect(action.grouping).toBe('normalTpsl');
    expect(action.orders?.[1]?.t?.trigger?.isMarket).toBe(true);
    expect(action.orders?.[2]?.t?.trigger?.isMarket).toBe(true);
    expect(action.orders?.[1]?.p).toBe('59400');
    expect(action.orders?.[2]?.p).toBe('59400');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateLeverage
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.updateLeverage', () => {
  it('demo path returns ok+demo without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await hyperliquid.updateLeverage({
      privyWalletId: null,
      privyWalletAddress: null,
      coin: 'BTC',
      leverage: 10,
      isCross: true,
    });
    expect(out).toEqual({ ok: true, demo: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live POSTs {type:"updateLeverage", asset, isCross, leverage} with floored leverage', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.updateLeverage({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'ETH',
      leverage: 7.9,
      isCross: false,
    });

    const action = lastFetchAction() as { type: string; asset: number; isCross: boolean; leverage: number };
    expect(action.type).toBe('updateLeverage');
    expect(action.asset).toBe(4); // ETH = 4
    expect(action.isCross).toBe(false);
    expect(action.leverage).toBe(7); // Math.floor
    expect(hlSignL1Action).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateIsolatedMargin
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.updateIsolatedMargin', () => {
  it('demo path returns ok+demo without fetching or signing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await hyperliquid.updateIsolatedMargin({
      privyWalletId: null,
      privyWalletAddress: null,
      coin: 'BTC',
      sideLong: true,
      amountUsd: 100,
    });
    expect(out).toEqual({ ok: true, demo: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hlSignL1Action).not.toHaveBeenCalled();
  });

  it('live POSTs {type:"updateIsolatedMargin", asset, isBuy:true, ntli} with 6-decimal int ntli', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.updateIsolatedMargin({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'ETH',
      sideLong: true,
      amountUsd: 25.5,
    });

    const action = lastFetchAction() as { type: string; asset: number; isBuy: boolean; ntli: number };
    expect(action.type).toBe('updateIsolatedMargin');
    expect(action.asset).toBe(4); // ETH = 4
    // Docs: isBuy has no effect until hedge mode — always true.
    expect(action.isBuy).toBe(true);
    expect(action.ntli).toBe(25_500_000); // $25.50 → 6-decimal int, NOT a decimal string
    expect(hlSignL1Action).toHaveBeenCalledTimes(1);
  });

  it('negative amount sends negative ntli (margin removal)', async () => {
    enterLiveTrading();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ status: 'ok' })));

    await hyperliquid.updateIsolatedMargin({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'BTC',
      sideLong: false,
      amountUsd: -10,
    });

    const action = lastFetchAction() as { ntli: number };
    expect(action.ntli).toBe(-10_000_000);
  });

  it('rejects a zero delta before signing', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      hyperliquid.updateIsolatedMargin({
        privyWalletId: WALLET_ID,
        privyWalletAddress: WALLET_ADDRESS,
        coin: 'BTC',
        sideLong: true,
        amountUsd: 0,
      }),
    ).rejects.toThrow('invalid_margin_delta');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// usdClassTransfer (user-signed)
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.usdClassTransfer', () => {
  it('demo path returns hl_demo_xfer_* callId and echoes amount + direction', async () => {
    const out = await hyperliquid.usdClassTransfer({
      privyWalletId: null,
      privyWalletAddress: null,
      amountUsd: 25,
      toPerp: true,
    });
    expect(out.demo).toBe(true);
    expect(out.callId).toMatch(/^hl_demo_xfer_/);
    expect(out.amountUsd).toBe(25);
    expect(out.toPerp).toBe(true);
  });

  it('live POSTs {type:"usdClassTransfer", signatureChainId, hyperliquidChain, amount:String, toPerp, nonce} via hlSignUserSignedAction', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.usdClassTransfer({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      amountUsd: 12.5,
      toPerp: true,
    });

    const action = lastFetchAction() as {
      type: string;
      signatureChainId: string;
      hyperliquidChain: string;
      amount: string;
      toPerp: boolean;
      nonce: number;
    };
    expect(action.type).toBe('usdClassTransfer');
    expect(action.signatureChainId).toBe('0x66eee');
    expect(action.hyperliquidChain).toBe('Mainnet');
    expect(action.amount).toBe('12.5'); // string, not number
    expect(typeof action.amount).toBe('string');
    expect(action.toPerp).toBe(true);
    expect(typeof action.nonce).toBe('number');
    expect(hlSignUserSignedAction).toHaveBeenCalledTimes(1);
    expect(hlSignL1Action).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// withdraw3 (user-signed)
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.usdSend', () => {
  it('demo path returns hl_demo_usd_send_* callId and echoes destination + amount', async () => {
    const out = await hyperliquid.usdSend({
      privyWalletId: null,
      privyWalletAddress: null,
      destination: '0xAbCdEf0000000000000000000000000000000001',
      amountUsd: 5,
    });
    expect(out.demo).toBe(true);
    expect(out.callId).toMatch(/^hl_demo_usd_send_/);
    expect(out.destination).toBe('0xAbCdEf0000000000000000000000000000000001');
    expect(out.amountUsd).toBe(5);
  });

  it('live POSTs {type:"usdSend", signatureChainId, hyperliquidChain, destination:lowercased, amount:String, time:nonce} via hlSignUserSignedAction', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.usdSend({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      destination: '0xAbCdEf0000000000000000000000000000000001',
      amountUsd: 7.25,
    });

    const action = lastFetchAction() as {
      type: string;
      signatureChainId: string;
      hyperliquidChain: string;
      destination: string;
      amount: string;
      time: number;
    };
    expect(action.type).toBe('usdSend');
    expect(action.signatureChainId).toBe('0x66eee');
    expect(action.hyperliquidChain).toBe('Mainnet');
    expect(action.destination).toBe('0xabcdef0000000000000000000000000000000001');
    expect(action.amount).toBe('7.25');
    expect(typeof action.amount).toBe('string');
    expect(typeof action.time).toBe('number');
    expect(hlSignUserSignedAction).toHaveBeenCalledTimes(1);
    expect(hlSignL1Action).not.toHaveBeenCalled();
  });
});

describe('HyperliquidAdapter.transferToDex', () => {
  it('demo path returns hl_demo_dex_xfer_* callId and echoes dex transfer details', async () => {
    const out = await hyperliquid.transferToDex({
      privyWalletId: null,
      privyWalletAddress: null,
      amountUsd: 5,
      destinationDex: 'xyz',
    });
    expect(out.demo).toBe(true);
    expect(out.callId).toMatch(/^hl_demo_dex_xfer_/);
    expect(out.amountUsd).toBe(5);
    expect(out.sourceDex).toBe('');
    expect(out.destinationDex).toBe('xyz');
    expect(out.token).toBe('USDC:0x6d1e7cde53ba9467b783cb7c530ce054');
  });

  it('live POSTs sendAsset with source/destination dex fields via hlSignUserSignedAction', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.transferToDex({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      amountUsd: 12.5,
      sourceDex: '',
      destinationDex: 'xyz',
    });

    const action = lastFetchAction() as {
      type: string;
      signatureChainId: string;
      hyperliquidChain: string;
      destination: string;
      sourceDex: string;
      destinationDex: string;
      token: string;
      amount: string;
      fromSubAccount: string;
      nonce: number;
    };
    expect(action.type).toBe('sendAsset');
    expect(action.signatureChainId).toBe('0x66eee');
    expect(action.hyperliquidChain).toBe('Mainnet');
    expect(action.destination).toBe(WALLET_ADDRESS);
    expect(action.sourceDex).toBe('');
    expect(action.destinationDex).toBe('xyz');
    expect(action.token).toBe('USDC:0x6d1e7cde53ba9467b783cb7c530ce054');
    expect(action.amount).toBe('12.5');
    expect(action.fromSubAccount).toBe('');
    expect(typeof action.nonce).toBe('number');
    expect(hlSignUserSignedAction).toHaveBeenCalledTimes(1);
    expect(hlSignL1Action).not.toHaveBeenCalled();
  });
});

describe('HyperliquidAdapter.withdraw3', () => {
  it('demo path returns hl_demo_wdr_* callId, echoes destination + amount', async () => {
    const out = await hyperliquid.withdraw3({
      privyWalletId: null,
      privyWalletAddress: null,
      destination: '0xAbCdEf0000000000000000000000000000000001',
      amountUsd: 5,
    });
    expect(out.demo).toBe(true);
    expect(out.callId).toMatch(/^hl_demo_wdr_/);
    expect(out.amountUsd).toBe(5);
    expect(out.destination).toBe('0xAbCdEf0000000000000000000000000000000001');
  });

  it('live POSTs {type:"withdraw3", signatureChainId, hyperliquidChain, destination:lowercased, amount:String, time:nonce} via hlSignUserSignedAction', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);

    await hyperliquid.withdraw3({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      destination: '0xAbCdEf0000000000000000000000000000000001',
      amountUsd: 7.25,
    });

    const action = lastFetchAction() as {
      type: string;
      signatureChainId: string;
      hyperliquidChain: string;
      destination: string;
      amount: string;
      time: number;
    };
    expect(action.type).toBe('withdraw3');
    expect(action.signatureChainId).toBe('0x66eee');
    expect(action.hyperliquidChain).toBe('Mainnet');
    expect(action.destination).toBe('0xabcdef0000000000000000000000000000000001'); // lowercased
    expect(action.amount).toBe('7.25');
    expect(typeof action.amount).toBe('string');
    expect(typeof action.time).toBe('number');
    expect(hlSignUserSignedAction).toHaveBeenCalledTimes(1);
    expect(hlSignL1Action).not.toHaveBeenCalled();
  });

  it('live: venue rejection surfaces as withdraw3_rejected (no silent demo fallback)', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async () => okResponse({ status: 'err', response: { error: 'unauthorized' } }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      hyperliquid.withdraw3({
        privyWalletId: WALLET_ID,
        privyWalletAddress: WALLET_ADDRESS,
        destination: '0x0000000000000000000000000000000000000001',
        amountUsd: 1,
      }),
    ).rejects.toThrow('withdraw3_rejected');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getOpenOrders (read-only /info)
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.getOpenOrders', () => {
  it('demo / no address returns []', async () => {
    const out = await hyperliquid.getOpenOrders(null);
    expect(out).toEqual([]);
  });

  it('live POSTs /info {type:"frontendOpenOrders", user} and maps rows with correct kind derivation', async () => {
    enterLiveTrading();
    const rows = [
      { coin: 'BTC', side: 'B', limitPx: '60000', sz: '0.01', oid: 111, timestamp: 1_780_000_000_000, tif: 'Gtc', reduceOnly: false },                                  // limit
      { coin: 'ETH', side: 'A', limitPx: '3400',  triggerPx: '3300', sz: '1', oid: 222, timestamp: 1_780_000_000_001, tif: 'Gtc', reduceOnly: true, isTrigger: true }, // stopLimit
      { coin: 'SOL', side: 'B', limitPx: '0',     sz: '5', oid: 333, timestamp: 1_780_000_000_002, orderType: 'TWAP order', reduceOnly: false },                       // twap (by orderType)
    ];
    const fetchSpy = vi.fn(async () => okResponse(rows));
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.getOpenOrders(WALLET_ADDRESS);

    expect(lastFetchUrl()).toContain('/info');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body) as { type: string; user: string };
    expect(body.type).toBe('frontendOpenOrders');
    expect(body.user).toBe(WALLET_ADDRESS);

    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe('limit');
    expect(out[0].sideLong).toBe(true);
    expect(out[0].tif).toBe('Gtc');
    expect(out[0].orderId).toBe('hl_111');
    expect(out[1].kind).toBe('stopLimit');
    expect(out[1].sideLong).toBe(false);
    expect(out[1].reduceOnly).toBe(true);
    expect(out[1].triggerPriceUsd).toBe(3300);
    expect(out[2].kind).toBe('twap');
  });

  it('live: coin filter only returns rows for that coin (case-insensitive)', async () => {
    enterLiveTrading();
    const rows = [
      { coin: 'BTC', side: 'B', limitPx: '60000', sz: '0.01', oid: 1, timestamp: 1, tif: 'Gtc' },
      { coin: 'ETH', side: 'A', limitPx: '3400', sz: '1', oid: 2, timestamp: 2, tif: 'Gtc' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(rows)));

    const out = await hyperliquid.getOpenOrders(WALLET_ADDRESS, 'eth');
    expect(out).toHaveLength(1);
    expect(out[0].coin).toBe('ETH');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getUserFills (read-only /info)
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.getUserFills', () => {
  it('demo / no address returns []', async () => {
    expect(await hyperliquid.getUserFills(null)).toEqual([]);
  });

  it('live POSTs /info {type:"userFills", user} and honours sinceMs + limit params', async () => {
    enterLiveTrading();
    const rows = [
      { coin: 'BTC', side: 'B', px: '60000', sz: '0.01', time: 100, hash: '0xa', oid: 1, fee: '0.5' },
      { coin: 'ETH', side: 'A', px: '3400',  sz: '1',    time: 200, hash: '0xb', oid: 2, fee: '1.0' },
      { coin: 'SOL', side: 'B', px: '160',   sz: '10',   time: 300, hash: '0xc', oid: 3, fee: '0.2' },
    ];
    const fetchSpy = vi.fn(async () => okResponse(rows));
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.getUserFills(WALLET_ADDRESS, { sinceMs: 150, limit: 5 });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body) as { type: string; user: string };
    expect(body.type).toBe('userFills');
    expect(body.user).toBe(WALLET_ADDRESS);

    // sinceMs=150 drops the row at time=100; limit=5 leaves both surviving rows.
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.timeMs)).toEqual([200, 300]);
    expect(out[0].feeUsd).toBe(1);
    expect(out[0].sideLong).toBe(false); // 'A' = ask = sell = short
    expect(out[1].sideLong).toBe(true);
  });

  it('live: limit caps the number of returned rows', async () => {
    enterLiveTrading();
    const rows = Array.from({ length: 50 }, (_, i) => ({
      coin: 'BTC', side: 'B', px: '60000', sz: '0.01', time: 1000 + i, hash: '0x' + i, oid: i, fee: '0',
    }));
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(rows)));

    const out = await hyperliquid.getUserFills(WALLET_ADDRESS, { limit: 5 });
    expect(out).toHaveLength(5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getUserState (read-only /info)
// ────────────────────────────────────────────────────────────────────────────

describe('HyperliquidAdapter.getUserState', () => {
  it('demo / no address returns all zeros + empty positions', async () => {
    const out = await hyperliquid.getUserState(null);
    expect(out).toEqual({
      equityUsd: 0,
      marginUsedUsd: 0,
      withdrawableUsd: 0,
      accountValueUsd: 0,
      positions: [],
    });
  });

  it('live POSTs /info {type:"clearinghouseState", user} and maps margin + positions fields', async () => {
    enterLiveTrading();
    const body = {
      marginSummary: { accountValue: '12345.67', totalMarginUsed: '1000.00', totalRawUsd: '12500.00' },
      withdrawable: '11000.00',
      assetPositions: [
        { position: { coin: 'BTC', szi: '0.1', entryPx: '60000', positionValue: '6100.50', unrealizedPnl: '100.50', liquidationPx: '52000', leverage: { value: 5 } } }, // long
        { position: { coin: 'ETH', szi: '-2',   entryPx: '3400' } },  // short, no liquidationPx
        { position: { coin: 'SOL', szi: '0',    entryPx: '160' } },   // zero — must be filtered
      ],
    };
    const fetchSpy = vi.fn(async () => okResponse(body));
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.getUserState(WALLET_ADDRESS);

    const reqBody = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body) as { type: string; user: string };
    expect(reqBody.type).toBe('clearinghouseState');
    expect(reqBody.user).toBe(WALLET_ADDRESS);

    expect(out.accountValueUsd).toBe(12345.67);
    expect(out.equityUsd).toBe(12345.67); // alias of accountValue
    expect(out.marginUsedUsd).toBe(1000);
    expect(out.withdrawableUsd).toBe(11000);
    expect(out.positions).toHaveLength(2); // SOL zero-size dropped
    expect(out.positions[0]).toEqual({
      coin: 'BTC',
      sideLong: true,
      qty: 0.1,
      qtyUsd: 6100.5, // prefers venue positionValue (mark-to-market) over szi*entry
      entryPriceUsd: 60_000,
      unrealizedPnlUsd: 100.5,
      leverage: 5,
      liquidationPriceUsd: 52_000, // authoritative venue liq price
    });
    expect(out.positions[1].sideLong).toBe(false);
    // ETH mock omits positionValue/uPnl/leverage/liquidationPx → safe fallbacks, never undefined.
    expect(out.positions[1].qty).toBe(2);
    expect(out.positions[1].qtyUsd).toBe(6800); // 2 * 3400 fallback
    expect(out.positions[1].unrealizedPnlUsd).toBe(0);
    expect(out.positions[1].leverage).toBe(1);
    expect(out.positions[1].liquidationPriceUsd).toBeNull(); // absent → null
  });

  it('getUserState + getPositions share one mapper: liq price carried, non-finite entryPx guarded to 0', async () => {
    enterLiveTrading();
    const body = {
      marginSummary: { accountValue: '100', totalMarginUsed: '10' },
      withdrawable: '90',
      assetPositions: [
        // Malformed entryPx (the case the old per-copy REST mappers pushed as NaN).
        { position: { coin: 'HYPE', szi: '3', entryPx: 'not-a-number', positionValue: '90', unrealizedPnl: '1', liquidationPx: '12.5', leverage: 3 } },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(body)));
    const state = await hyperliquid.getUserState(WALLET_ADDRESS);
    expect(state.positions[0].entryPriceUsd).toBe(0);        // guarded, never NaN
    expect(state.positions[0].liquidationPriceUsd).toBe(12.5);

    vi.stubGlobal('fetch', vi.fn(async () => okResponse(body)));
    const positions = await hyperliquid.getPositions(WALLET_ADDRESS);
    // Same shape from the sibling read — proves the shared mapper.
    expect(positions[0].entryPriceUsd).toBe(0);
    expect(positions[0].liquidationPriceUsd).toBe(12.5);
  });
});

describe('HyperliquidAdapter public detail reads', () => {
  it('forwards builder dex on orderbook and recent-trades reads', async () => {
    enterLiveTrading();
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
      if (body.type === 'l2Book') return okResponse({ coin: 'xyz:TSLA', levels: [[], []], time: 123 });
      if (body.type === 'recentTrades') return okResponse([]);
      return okResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(hyperliquid.getL2Book('xyz:TSLA', 'xyz')).resolves.toMatchObject({ coin: 'xyz:TSLA' });
    expect(JSON.parse((fetchSpy.mock.calls.at(-1)?.[1] as { body: string }).body)).toMatchObject({
      type: 'l2Book',
      coin: 'xyz:TSLA',
      dex: 'xyz',
    });

    await expect(hyperliquid.getRecentTrades('xyz:TSLA', 'xyz')).resolves.toEqual([]);
    expect(JSON.parse((fetchSpy.mock.calls.at(-1)?.[1] as { body: string }).body)).toMatchObject({
      type: 'recentTrades',
      coin: 'xyz:TSLA',
      dex: 'xyz',
    });
  });
});

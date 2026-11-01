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

import { Hip3RateLimitError, hyperliquidHip3 } from './hyperliquid-hip3.js';
import { hlSignUserSignedAction } from './hl-signer.js';

const WALLET_ID = 'wallet_hip3_test';
const WALLET_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const BUILDER_ADDRESS = '0x1111111111111111111111111111111111111111';

const originalMarkets = features.markets;
const originalPrivy = features.privy;
const originalBuilder = env.HL_BUILDER_ADDRESS;
const originalBuilderFeeTenths = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP;

function liveHip3(): void {
  features.markets = true;
  features.privy = true;
  env.HL_BUILDER_ADDRESS = BUILDER_ADDRESS;
  (hyperliquidHip3 as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = null;
}

function stubHip3Provider(
  submittedActions: Array<{ type: string; [k: string]: unknown }>,
  orderStatus: { filled?: { oid: number; avgPx?: string; px?: string }; resting?: { oid: number }; error?: string } = {
    filled: { oid: 42, avgPx: '102.50' },
  },
  opts: {
    perpDexs?: Array<{ name: string } | null>;
    universe?: Array<{ name: string; szDecimals?: number }>;
    dexWithdrawable?: number;
    coreWithdrawable?: number;
  } = {},
): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      type?: string;
      dex?: string;
      action?: { type: string; [k: string]: unknown };
    };

    if (body.type === 'perpDexs') {
      return Response.json(opts.perpDexs ?? [null, { name: 'xyz' }]);
    }
    if (body.type === 'meta') {
      return Response.json({ universe: opts.universe ?? [{ name: 'xyz:AAPL' }] });
    }
    if (body.type === 'clearinghouseState') {
      // ensureDexFunded reads the xyz-dex account (dex set) and the core account
      // (no dex). Default: empty dex → funds; well-capitalized core → move fires.
      const wd = body.dex ? (opts.dexWithdrawable ?? 0) : (opts.coreWithdrawable ?? 1_000);
      return Response.json({ withdrawable: String(wd), marginSummary: { accountValue: String(wd) } });
    }
    if (body.action) {
      submittedActions.push(body.action);
      return Response.json({
        status: 'ok',
        response: { data: { statuses: [orderStatus] } },
      });
    }
    return Response.json({}, { status: 400 });
  }));
}

beforeEach(() => {
  liveHip3();
  vi.spyOn(hyperliquidHip3, 'getMarket').mockResolvedValue({
    coin: 'xyz:AAPL',
    ticker: 'AAPL',
    category: 'stock',
    priceUsd: 100,
    change24hPct: null,
    index: 0,
  });
});

afterEach(() => {
  features.markets = originalMarkets;
  features.privy = originalPrivy;
  env.HL_BUILDER_ADDRESS = originalBuilder;
  env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = originalBuilderFeeTenths;
  (hyperliquidHip3 as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HyperliquidHip3Adapter live order wire shape', () => {
  it('uses the perpDexs index when building the HIP-3 asset id', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions);

    await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    });

    const order = submittedActions.find((a) => a.type === 'order') as {
      orders: Array<{ a: number }>;
    };
    expect(order.orders[0].a).toBe(110000);
  });

  it('uses index_in_meta for non-zero HIP-3 universe offsets', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions, undefined, {
      perpDexs: [null, { name: 'other' }, null, { name: 'xyz' }],
      universe: [{ name: 'xyz:XYZ100' }, { name: 'xyz:TSLA' }, { name: 'xyz:AAPL' }],
    });

    await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    });

    const order = submittedActions.find((a) => a.type === 'order') as {
      orders: Array<{ a: number }>;
    };
    expect(order.orders[0].a).toBe(130002);
  });

  it('funds the xyz dex (sendAsset) before submitting the first live HIP-3 order', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions); // dexWithdrawable defaults to 0 → funding fires

    await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    });

    expect(submittedActions.map((a) => a.type)).toEqual(['sendAsset', 'order']);
    const fund = submittedActions.find((a) => a.type === 'sendAsset') as {
      sourceDex: string;
      destinationDex: string;
      token: string;
    };
    expect(fund.sourceDex).toBe('');
    expect(fund.destinationDex).toBe('xyz');
    expect(fund.token).toBe('USDC:0x6d1e7cde53ba9467b783cb7c530ce054');
    expect(hlSignUserSignedAction).toHaveBeenCalledTimes(1);
  });

  it('skips dex funding when the xyz account already holds enough margin', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions, undefined, { dexWithdrawable: 1_000 });

    await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    });

    expect(submittedActions.map((a) => a.type)).toEqual(['order']);
    expect(hlSignUserSignedAction).not.toHaveBeenCalled();
  });

  it('accepts a live GTC limit order that rests on the book', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions, { resting: { oid: 99 } });

    const result = await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'limit',
      tif: 'Gtc',
      limitPriceUsd: 101,
    });

    expect(result).toMatchObject({
      orderId: 'hip3_99',
      filledQtyUsd: 0,
      entryPriceUsd: 100,
      demo: false,
      state: 'resting',
    });
  });

  it('formats HIP-3 order price and size with asset tick and lot precision', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions);
    vi.mocked(hyperliquidHip3.getMarket).mockResolvedValueOnce({
      coin: 'xyz:AAPL',
      ticker: 'AAPL',
      category: 'stock',
      priceUsd: 101.23,
      change24hPct: null,
      index: 0,
      szDecimals: 3,
    });

    await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 12.345,
      leverage: 1,
      orderType: 'limit',
      tif: 'Gtc',
      limitPriceUsd: 123.45,
    });

    const order = submittedActions.find((a) => a.type === 'order') as {
      orders: Array<{ p: string; s: string }>;
    };
    expect(order.orders[0]).toMatchObject({
      p: '123.45',
      s: '0.122',
    });
  });

  it('rejects per-order venue errors instead of reporting order_missing_oid', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions, { error: 'HIP-3 order rejected.' });

    await expect(hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    })).rejects.toThrow(/order_rejected/);
  });

  it('preserves upstream HIP-3 rate limits during setup', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
      // The per-dex clearinghouse read (ensureDexFunded) is the first setup hop;
      // a 429 there must surface as a rate-limit error, not be swallowed.
      if (body.type === 'clearinghouseState') {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '60' } });
      }
      return Response.json({});
    }));

    await expect(hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    })).rejects.toBeInstanceOf(Hip3RateLimitError);
  });

  it('rejects per-cancel venue errors instead of reporting success', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    stubHip3Provider(submittedActions, { error: 'HIP-3 order already filled.' });

    await expect(hyperliquidHip3.cancelOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      externalRef: 'hip3_123',
    })).rejects.toThrow(/cancel_rejected/);
  });

  it('keeps live HIP-3 trading enabled when builder fee is zero and no builder address is set', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    env.HL_BUILDER_ADDRESS = undefined;
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 0;
    stubHip3Provider(submittedActions);

    expect(hyperliquidHip3.isLiveTrading).toBe(true);
    const result = await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    });

    const order = submittedActions.find((a) => a.type === 'order') as {
      builder?: unknown;
    };
    expect(result.demo).toBe(false);
    expect(result.entryPriceUsd).toBe(102.5);
    expect(order.builder).toBeUndefined();
  });

  it('caps submitted HIP-3 builder fees at 10 bps', async () => {
    const submittedActions: Array<{ type: string; [k: string]: unknown }> = [];
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 250;
    stubHip3Provider(submittedActions);

    await hyperliquidHip3.placeOrder({
      privyWalletId: WALLET_ID,
      privyWalletAddress: WALLET_ADDRESS,
      coin: 'xyz:AAPL',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      orderType: 'market',
    });

    const order = submittedActions.find((a) => a.type === 'order') as {
      builder?: { b: string; f: number };
    };
    expect(order.builder).toEqual({ b: BUILDER_ADDRESS, f: 100 });
  });
});

describe('HyperliquidHip3Adapter.getUserState (xyz clearinghouse money truth)', () => {
  // Live payload captured 2026-07-05 for the founder wallet: AAPL 0.078 @ 20x
  // cross — notional $24.02, accountValue $3.218833. The money display must
  // carry accountValue, never notional (the exact inflation bug of the
  // 2026-07-05 TOTAL EQUITY fix).
  const LIVE_XYZ_STATE = {
    marginSummary: { accountValue: '3.218833', totalNtlPos: '24.01932' },
    withdrawable: '2.017867',
    assetPositions: [
      {
        type: 'oneWay',
        position: { coin: 'xyz:AAPL', szi: '0.078', entryPx: '307.74', unrealizedPnl: '0.0156' },
      },
    ],
  };

  it('returns dex accountValue as equity — never position notional', async () => {
    const seen: Array<{ type?: string; dex?: string; user?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string; dex?: string; user?: string };
      seen.push(body);
      if (body.type === 'clearinghouseState') return Response.json(LIVE_XYZ_STATE);
      return Response.json({}, { status: 400 });
    }));

    const state = await hyperliquidHip3.getUserState(WALLET_ADDRESS);

    expect(seen[0]).toMatchObject({ type: 'clearinghouseState', user: WALLET_ADDRESS, dex: 'xyz' });
    expect(state).toEqual({
      equityUsd: 3.218833,
      withdrawableUsd: 2.017867,
      unrealizedPnlUsd: 0.0156,
      positions: [
        {
          coin: 'xyz:AAPL',
          sideLong: true,
          qtyUsd: 0.078 * 307.74,
          entryPriceUsd: 307.74,
          unrealizedPnlUsd: 0.0156,
          leverage: 1,
        },
      ],
    });
    // Position notional is carried on the ROW (qtyUsd), but the aggregate
    // equity must remain accountValue, never the 20x notional.
    // Regression tripwire: 20x notional must NOT leak into the money path.
    expect(state?.equityUsd).not.toBeCloseTo(24.01932, 2);
  });

  it('parses short side, per-position leverage, and drops flat rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({
        marginSummary: { accountValue: '1000' },
        withdrawable: '500',
        assetPositions: [
          { position: { coin: 'xyz:TSLA', szi: '-2', entryPx: '250', unrealizedPnl: '-14.5', leverage: { type: 'isolated', value: 20 } } },
          { position: { coin: 'xyz:FLAT', szi: '0', entryPx: '10', unrealizedPnl: '0' } },
        ],
      }),
    ));
    const state = await hyperliquidHip3.getUserState(WALLET_ADDRESS);
    expect(state?.positions).toEqual([
      { coin: 'xyz:TSLA', sideLong: false, qtyUsd: 2 * 250, entryPriceUsd: 250, unrealizedPnlUsd: -14.5, leverage: 20 },
    ]);
    // Flat (szi 0) rows drop out and never distort the summed aggregate uPnL.
    expect(state?.unrealizedPnlUsd).toBe(-14.5);
  });

  it('fails soft to null when the venue read breaks (route marks leg failed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })));
    await expect(hyperliquidHip3.getUserState(WALLET_ADDRESS)).resolves.toBeNull();
  });

  it('demo env returns stubbed zeros; missing wallet returns null', async () => {
    features.markets = false;
    await expect(hyperliquidHip3.getUserState(WALLET_ADDRESS)).resolves.toEqual({
      equityUsd: 0,
      withdrawableUsd: 0,
      unrealizedPnlUsd: 0,
      positions: [],
    });
    await expect(hyperliquidHip3.getUserState(null)).resolves.toBeNull();
  });
});

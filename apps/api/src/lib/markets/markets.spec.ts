/**
 * Market-data adapters — demo-mode unit tests.
 *
 * No live calls in CI: features.markets defaults ON, but the public APIs are not
 * reached here, so getMarkets resolves to the stable demo sample either way (a
 * real fetch failure also falls through to the same demo path). We assert the
 * demo contract holds and the pure helpers (builder-fee clamp, region gate,
 * outcome math) behave.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, features } from '../env.js';

const clobMock = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  createAndPostOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));

vi.mock('@polymarket/clob-client-v2', () => ({
  Chain: { POLYGON: 137 },
  OrderType: { GTC: 'GTC' },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  ClobClient: vi.fn((opts: unknown) => {
    clobMock.clientOptions.push(opts);
    return {
      createAndPostOrder: clobMock.createAndPostOrder,
      cancelOrder: clobMock.cancelOrder,
    };
  }),
}));

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
import { hyperliquidSpot } from './hyperliquid-spot.js';
import { jupiter, JUPITER_SOL_MINT } from './jupiter.js';
import { polymarket } from './polymarket.js';
import type { ProviderRateLimitError } from './provider-errors.js';

const originalMarketsEnabled = features.markets;
const originalPrivyEnabled = features.privy;
const originalHlBuilderAddress = env.HL_BUILDER_ADDRESS;

beforeEach(() => {
  features.markets = false;
});

afterEach(() => {
  features.markets = originalMarketsEnabled;
  features.privy = originalPrivyEnabled;
  env.HL_BUILDER_ADDRESS = originalHlBuilderAddress;
  (hyperliquidSpot as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = null;
  clobMock.clientOptions.length = 0;
  clobMock.createAndPostOrder.mockReset();
  clobMock.cancelOrder.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HyperliquidAdapter — demo mode', () => {
  it('getMarkets returns at least 3 markets including BTC with a positive price', async () => {
    const markets = await hyperliquid.getMarkets();
    expect(markets.length).toBeGreaterThanOrEqual(3);
    const btc = markets.find((m) => m.coin === 'BTC');
    expect(btc).toBeDefined();
    expect(btc?.priceUsd).toBeGreaterThan(0);
  });

  it('getMarket is case-insensitive', async () => {
    const lower = await hyperliquid.getMarket('btc');
    expect(lower).not.toBeNull();
    expect(lower?.coin).toBe('BTC');
    const upper = await hyperliquid.getMarket('BTC');
    expect(upper?.coin).toBe('BTC');
  });

  it('getMarket returns null for an unknown coin', async () => {
    expect(await hyperliquid.getMarket('NOTACOIN')).toBeNull();
  });

  it('builderApprovalParams(50) clamps maxFeeBps to the 10 bps perps cap', () => {
    const p = hyperliquid.builderApprovalParams(50);
    expect(p.maxFeeBps).toBe(10);
    expect(p.maxFeeRate).toBe('0.001');
    expect(p.market).toBe('perps');
    expect(p.revocable).toBe(true);
  });

  it('builderApprovalParams defaults to the cap and keeps a valid sub-cap value', () => {
    expect(hyperliquid.builderApprovalParams().maxFeeBps).toBe(10);
    expect(hyperliquid.builderApprovalParams(5).maxFeeBps).toBe(5);
    expect(hyperliquid.builderApprovalParams(-1).maxFeeBps).toBe(0);
  });

  it('maps metaAndAssetCtxs perps by volume, filters delisted assets, and exposes venue stats', async () => {
    features.markets = true;
    const requests: Array<{ type?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')) as { type?: string });
      return new Response(JSON.stringify([
        {
          universe: [
            { name: 'ETH', maxLeverage: 25 },
            { name: 'BTC', maxLeverage: 50 },
            { name: 'DELIST', maxLeverage: 3, isDelisted: true },
            { name: 'HYPE', maxLeverage: 5 },
          ],
        },
        [
          { markPx: '3000', midPx: '2999', prevDayPx: '2500', dayNtlVlm: '1000', openInterest: '12', funding: '0.0001' },
          { markPx: '60000', midPx: '60010', prevDayPx: '50000', dayNtlVlm: '5000', openInterest: '99', funding: '0.0002' },
          { markPx: '1', midPx: '1', prevDayPx: '1', dayNtlVlm: '9000', openInterest: '1', funding: '0' },
          { markPx: '25', midPx: '24.5', prevDayPx: '20', dayNtlVlm: '2000', openInterest: '70', funding: '-0.0001' },
        ],
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const markets = await hyperliquid.getMarkets();

    expect(requests[0]?.type).toBe('metaAndAssetCtxs');
    expect(markets.map((m) => m.coin)).toEqual(['BTC', 'HYPE', 'ETH']);
    expect(markets).not.toEqual(expect.arrayContaining([expect.objectContaining({ coin: 'DELIST' })]));
    expect(markets[0]).toEqual(expect.objectContaining({
      coin: 'BTC',
      priceUsd: 60000,
      change24hPct: 20,
      maxLeverage: 50,
      dayVolumeUsd: 5000,
      openInterest: 99,
      fundingRate: 0.0002,
    }));
  });

  it('keeps detail lookup uncapped even when the visible list is limited', async () => {
    features.markets = true;
    // 2026-06-21 — cap lifted from 30 to 500 so the full HL perp universe
    // (~230 markets) renders in the list. This test still asserts the
    // visible-vs-detail invariant: detail lookup must reach past the cap.
    const universe = Array.from({ length: 501 }, (_, index) => ({
      name: index === 500 ? 'TAIL' : `COIN${index}`,
      maxLeverage: 3,
    }));
    const ctxs = universe.map((_asset, index) => ({
      markPx: String(100 + index),
      prevDayPx: '100',
      dayNtlVlm: String(10_000 - index),
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ universe }, ctxs]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const visible = await hyperliquid.getMarkets();
    const tail = await hyperliquid.getMarket('tail');

    expect(visible).toHaveLength(500);
    expect(visible.map((m) => m.coin)).not.toContain('TAIL');
    expect(tail).toEqual(expect.objectContaining({ coin: 'TAIL', priceUsd: 600 }));
  });
});

describe('PolymarketAdapter — demo mode', () => {
  it('getMarkets returns at least 1 market with two outcomes summing to ~100', async () => {
    const markets = await polymarket.getMarkets();
    expect(markets.length).toBeGreaterThanOrEqual(1);
    const first = markets[0];
    expect(first).toBeDefined();
    expect(first?.outcomes.length).toBe(2);
    const sum = (first?.outcomes ?? []).reduce((acc, o) => acc + o.pricePct, 0);
    expect(sum).toBeGreaterThanOrEqual(99);
    expect(sum).toBeLessThanOrEqual(101);
  });

  it('isRegionAllowed gates blocked codes and permits others / unknowns', () => {
    expect(polymarket.isRegionAllowed('US')).toBe(false);
    expect(polymarket.isRegionAllowed('NL')).toBe(true);
    expect(polymarket.isRegionAllowed(null)).toBe(true);
  });

  it('isRegionAllowed is case-insensitive', () => {
    expect(polymarket.isRegionAllowed('us')).toBe(false);
    expect(polymarket.isRegionAllowed('nl')).toBe(true);
  });

  it('reads Gamma events by volume and maps NegRisk event metadata plus leading outcomes', async () => {
    features.markets = true;
    let requested: URL | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      requested = new URL(String(url));
      return new Response(JSON.stringify([
        {
          id: 'event-election',
          title: '2028 Democratic nominee?',
          image: 'https://polymarket.example/election.png',
          category: 'Politics',
          tags: [{ label: 'Elections' }],
          negRisk: true,
          markets: [
            {
              id: 'market-harris',
              conditionId: 'condition-harris',
              question: 'Will Harris win the nomination?',
              groupItemTitle: 'Harris',
              outcomes: '["Yes","No"]',
              outcomePrices: '["0.52","0.48"]',
              clobTokenIds: '["token-harris-yes","token-harris-no"]',
              endDate: '2028-08-01T00:00:00Z',
            },
            {
              id: 'market-newsom',
              conditionId: 'condition-newsom',
              question: 'Will Newsom win the nomination?',
              groupItemTitle: 'Newsom',
              outcomes: '["Yes","No"]',
              outcomePrices: '["0.21","0.79"]',
              clobTokenIds: '["token-newsom-yes","token-newsom-no"]',
              endDate: '2028-08-01T00:00:00Z',
            },
          ],
        },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const markets = await polymarket.getMarkets(12);

    expect(requested?.pathname).toBe('/events');
    expect(requested?.searchParams.get('active')).toBe('true');
    expect(requested?.searchParams.get('closed')).toBe('false');
    expect(requested?.searchParams.get('archived')).toBe('false');
    expect(requested?.searchParams.get('order')).toBe('volume24hr');
    expect(requested?.searchParams.get('ascending')).toBe('false');
    expect(requested?.searchParams.get('limit')).toBe('12');
    expect(markets[0]).toEqual(expect.objectContaining({
      id: 'event-election',
      question: '2028 Democratic nominee?',
      imageUrl: 'https://polymarket.example/election.png',
      category: 'Politics',
      tags: ['Elections'],
      isNegRisk: true,
      isMultiOutcome: true,
    }));
    expect(markets[0]?.outcomes).toEqual([
      expect.objectContaining({ label: 'Harris', pricePct: 52, marketId: 'market-harris', tokenId: 'token-harris-yes' }),
      expect.objectContaining({ label: 'Newsom', pricePct: 21, marketId: 'market-newsom', tokenId: 'token-newsom-yes' }),
    ]);
  });

  it('returns an empty list for category misses instead of unrelated demos', async () => {
    features.markets = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      {
        id: 'event-sports',
        title: 'Will City win?',
        category: 'Sports',
        markets: [
          {
            id: 'market-city',
            question: 'Will City win?',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.60","0.40"]',
            clobTokenIds: '["token-city-yes","token-city-no"]',
          },
        ],
      },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })));

    const sports = await polymarket.getMarkets(10, 'Sports');
    const crypto = await polymarket.getMarkets(10, 'Crypto');

    expect(sports.map((m) => m.id)).toEqual(['event-sports']);
    expect(crypto).toEqual([]);
  });

  it('maps data-api holders and respects public username visibility', async () => {
    features.markets = true;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      urls.push(href);
      if (href.includes('data-api.polymarket.com/holders')) {
        return new Response(JSON.stringify([
          {
            token: 'token_yes',
            holders: [
              {
                proxyWallet: '0xpublic',
                name: 'Visible Maker',
                pseudonym: 'Visible-Pseudonym',
                displayUsernamePublic: true,
                amount: '12.5',
                outcomeIndex: 0,
                verified: true,
              },
              {
                proxyWallet: '0xhidden',
                name: 'Hidden Maker',
                pseudonym: 'Hidden-Pseudonym',
                displayUsernamePublic: false,
                amount: 7,
                outcomeIndex: 0,
                verified: false,
              },
            ],
          },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'event-world-cup',
        title: 'World Cup Winner',
        markets: [
          {
            id: 'market-france',
            conditionId: 'condition-france',
            question: 'Will France win?',
            groupItemTitle: 'France',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.25","0.75"]',
            clobTokenIds: '["token_yes","token_no"]',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await polymarket.getTopTraders('event-world-cup', 100);
    const holdersUrl = urls.find((u) => u.includes('data-api.polymarket.com/holders'));

    expect(new URL(holdersUrl ?? '').searchParams.get('limit')).toBe('50');
    expect(new URL(holdersUrl ?? '').searchParams.get('market')).toBe('condition-france');
    expect(result).toEqual({
      source: 'live',
      outcomes: [
        {
          tokenId: 'token_yes',
          holders: [
            {
              wallet: '0xpublic',
              name: 'Visible Maker',
              amount: 12.5,
              outcomeIndex: 0,
              verified: true,
            },
            {
              wallet: '0xhidden',
              name: null,
              amount: 7,
              outcomeIndex: 0,
              verified: false,
            },
          ],
        },
      ],
    });
  });

  it('keeps hidden holder names private in the best-traders leaderboard', async () => {
    features.markets = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('data-api.polymarket.com/holders')) {
        return new Response(JSON.stringify([
          {
            token: 'token_yes',
            holders: [
              {
                proxyWallet: '0xhidden',
                name: 'Hidden Maker',
                pseudonym: 'Hidden-Pseudonym',
                displayUsernamePublic: false,
              },
            ],
          },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('data-api.polymarket.com/positions')) {
        return new Response(JSON.stringify([
          { cashPnl: '12', realizedPnl: '3', currentValue: '50' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([
        {
          id: 'event-world-cup',
          title: 'World Cup Winner',
          markets: [
            {
              id: 'market-france',
              conditionId: 'condition-france',
              question: 'Will France win?',
              groupItemTitle: 'France',
              outcomes: '["Yes","No"]',
              outcomePrices: '["0.25","0.75"]',
              clobTokenIds: '["token_yes","token_no"]',
            },
          ],
        },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await polymarket.getLeaderboard({ markets: 1, traders: 1 });

    expect(result.source).toBe('live');
    expect(result.traders).toEqual([
      expect.objectContaining({ wallet: '0xhidden', name: null }),
    ]);
  });

  it('caches identical best-traders leaderboard requests', async () => {
    features.markets = true;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      calls++;
      const href = String(url);
      if (href.includes('data-api.polymarket.com/holders')) {
        return new Response(JSON.stringify([
          { token: 'token_yes', holders: [{ proxyWallet: '0xcached', name: 'Cached' }] },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('data-api.polymarket.com/positions')) {
        return new Response(JSON.stringify([
          { cashPnl: '7', realizedPnl: '2', currentValue: '11' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([
        {
          id: 'event-cache',
          title: 'Cache test',
          markets: [{
            id: 'market-cache',
            conditionId: 'condition-cache',
            question: 'Cache?',
            outcomes: '["Yes","No"]',
            outcomePrices: '["0.5","0.5"]',
            clobTokenIds: '["token_yes","token_no"]',
          }],
        },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const opts = { markets: 1, traders: 1, sort: 'value' as const };
    await polymarket.getLeaderboard(opts);
    await polymarket.getLeaderboard(opts);

    expect(calls).toBe(3);
  });
});

/* ── Sprint 10 Item E — write surface (placeOrder/cancelOrder/getPositions) ── */

describe('Hyperliquid placeOrder — demo path', () => {
  it('returns hl_demo_* when not configured for live trading', async () => {
    const result = await hyperliquid.placeOrder({
      privyWalletId: null,
      privyWalletAddress: null,
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
    });
    expect(result.demo).toBe(true);
    expect(result.orderId).toMatch(/^hl_demo_/);
    expect(result.filledQtyUsd).toBe(100);
    expect(result.entryPriceUsd).toBeGreaterThan(0);
  });

  it('isLiveTrading is false without Privy + builder address (demo env)', () => {
    expect(hyperliquid.isLiveTrading).toBe(false);
  });

  it('cancelOrder demo path is idempotent ok', async () => {
    const out = await hyperliquid.cancelOrder({
      privyWalletId: null,
      privyWalletAddress: null,
      coin: 'BTC',
      externalRef: 'hl_demo_xx',
    });
    expect(out.ok).toBe(true);
    expect(out.demo).toBe(true);
  });

  it('cancelOrder live path treats synthetic refs as local-only closes', async () => {
    features.markets = true;
    features.privy = true;
    env.HL_BUILDER_ADDRESS = '0x1111111111111111111111111111111111111111';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = await hyperliquid.cancelOrder({
      privyWalletId: 'wallet_hl_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      coin: 'ETH',
      externalRef: 'hl_demo_legacy',
    });

    expect(out.ok).toBe(true);
    expect(out.demo).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancelOrder live path rejects malformed non-demo refs', async () => {
    features.markets = true;
    features.privy = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(hyperliquid.cancelOrder({
      privyWalletId: 'wallet_hl_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      coin: 'ETH',
      externalRef: 'not-a-venue-order',
    })).rejects.toThrow('invalid_oid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('getPositions demo path returns []', async () => {
    const out = await hyperliquid.getPositions(null);
    expect(out).toEqual([]);
  });

  it('demo path tags Gtc limit orders with state="resting"', async () => {
    // V2 placeOrder now accepts Gtc/Alo resting orders end-to-end. The
    // pre-submission "resting_orders_unsupported" guard is gone — the venue
    // handles resting acceptance directly. Without Privy creds the demo path
    // simulates the same lifecycle hint so UI flows stay green.
    features.markets = true;
    features.privy = true;
    env.HL_BUILDER_ADDRESS = '0x1111111111111111111111111111111111111111';

    const result = await hyperliquid.placeOrder({
      privyWalletId: null,
      privyWalletAddress: null,
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 100,
      leverage: 1,
      kind: 'limit',
      tif: 'Gtc',
      limitPriceUsd: 59900,
    });

    expect(result.demo).toBe(true);
    expect(result.orderId).toMatch(/^hl_demo_/);
    expect(result.state).toBe('resting');
  });
});

describe('Polymarket placeOrder — demo path', () => {
  it('returns pm_demo_* when not configured for live trading', async () => {
    const result = await polymarket.placeOrder({
      privyWalletId: null,
      privyWalletAddress: null,
      marketId: 'demo-btc-100k',
      outcome: 'Yes',
      priceCents: 62,
      qtyUsd: 50,
    });
    expect(result.demo).toBe(true);
    expect(result.orderId).toMatch(/^pm_demo_/);
    expect(result.priceCents).toBe(62);
    expect(result.filledQtyUsd).toBe(50);
  });

  it('isLiveTrading is false without Privy + POLY_API_KEY (demo env)', () => {
    expect(polymarket.isLiveTrading).toBe(false);
  });

  it('getPositions demo path returns []', async () => {
    const out = await polymarket.getPositions(null);
    expect(out).toEqual([]);
  });

  it('fails closed when live CLOB submit is rejected', async () => {
    features.markets = true;
    features.privy = true;
    clobMock.createAndPostOrder.mockResolvedValueOnce({
      success: false,
      errorMsg: 'bad order',
    });

    await expect(polymarket.placeOrder({
      privyWalletId: 'wallet_pm_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      marketId: 'pm-live-test',
      outcome: 'Yes',
      priceCents: 62,
      qtyUsd: 50,
      outcomeTokenId: '123456789',
      clobCreds: {
        key: 'test-api-key-uuid',
        secret: Buffer.from('a'.repeat(32)).toString('base64'),
        passphrase: 'test-passphrase',
      },
    })).rejects.toThrow('polymarket_order_rejected');
  });

  it('normalizes live CLOB submit SDK 429 errors', async () => {
    features.markets = true;
    features.privy = true;
    clobMock.createAndPostOrder.mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
      status: 429,
      response: { headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '19' : null) } },
    }));

    await expect(polymarket.placeOrder({
      privyWalletId: 'wallet_pm_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      marketId: 'pm-live-test',
      outcome: 'Yes',
      priceCents: 62,
      qtyUsd: 50,
      outcomeTokenId: '123456789',
      clobCreds: {
        key: 'test-api-key-uuid',
        secret: Buffer.from('a'.repeat(32)).toString('base64'),
        passphrase: 'test-passphrase',
      },
    })).rejects.toMatchObject({
      name: 'ProviderRateLimitError',
      vendor: 'polymarket-clob',
      retryAfter: '19',
    } satisfies Partial<ProviderRateLimitError>);
  });

  it('submits a live CLOB limit buy when wallet, token and L2 creds are present', async () => {
    features.markets = true;
    features.privy = true;
    clobMock.createAndPostOrder.mockResolvedValueOnce({
      success: true,
      orderID: '0xpmorder123',
      status: 'live',
      makingAmount: '50000000',
      takingAmount: '80645161',
    });

    const result = await polymarket.placeOrder({
      privyWalletId: 'wallet_pm_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      marketId: 'pm-live-test',
      outcome: 'Yes',
      priceCents: 62,
      qtyUsd: 50,
      outcomeTokenId: '123456789',
      clobCreds: {
        key: 'test-api-key-uuid',
        secret: Buffer.from('a'.repeat(32)).toString('base64'),
        passphrase: 'test-passphrase',
      },
    });

    expect(result).toEqual({
      orderId: '0xpmorder123',
      filledQtyUsd: 0,
      priceCents: 62,
      demo: false,
      state: 'resting',
    });
    expect(clobMock.clientOptions).toHaveLength(1);
    const [order, options, orderType] = clobMock.createAndPostOrder.mock.calls[0]!;
    expect(order).toEqual(expect.objectContaining({
      tokenID: '123456789',
      price: 0.62,
      side: 'BUY',
    }));
    expect((order as { size: number }).size).toBeCloseTo(80.645, 3);
    expect(options).toEqual({ tickSize: '0.01' });
    expect(orderType).toBe('GTC');
  });

  it('cancels a live CLOB order through the SDK orderID payload', async () => {
    features.markets = true;
    features.privy = true;
    clobMock.cancelOrder.mockResolvedValueOnce({ success: true });

    const result = await polymarket.cancelOrder({
      privyWalletId: 'wallet_pm_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      externalRef: '0xpmorder123',
      clobCreds: {
        key: 'test-api-key-uuid',
        secret: Buffer.from('a'.repeat(32)).toString('base64'),
        passphrase: 'test-passphrase',
      },
    });

    expect(result).toEqual({ ok: true, demo: false });
    expect(clobMock.cancelOrder).toHaveBeenCalledWith({ orderID: '0xpmorder123' });
  });

  it('normalizes live CLOB cancel SDK 429 errors', async () => {
    features.markets = true;
    features.privy = true;
    clobMock.cancelOrder.mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
      response: {
        status: 429,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '23' : null) },
      },
    }));

    await expect(polymarket.cancelOrder({
      privyWalletId: 'wallet_pm_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      externalRef: '0xpmorder123',
      clobCreds: {
        key: 'test-api-key-uuid',
        secret: Buffer.from('a'.repeat(32)).toString('base64'),
        passphrase: 'test-passphrase',
      },
    })).rejects.toMatchObject({
      name: 'ProviderRateLimitError',
      vendor: 'polymarket-clob',
      retryAfter: '23',
    } satisfies Partial<ProviderRateLimitError>);
  });
});

describe('HyperliquidSpotAdapter live order wire shape', () => {
  it('rejects malformed non-demo cancel refs in live mode', async () => {
    features.markets = true;
    features.privy = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(hyperliquidSpot.cancelOrder({
      privyWalletId: 'wallet_spot_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      coin: 'PURR/USDC',
      externalRef: 'not-a-spot-order',
    })).rejects.toThrow('invalid_oid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps Gtc limit orders resting instead of rejecting them', async () => {
    features.markets = true;
    features.privy = true;
    (hyperliquidSpot as unknown as { assetIdCache: Map<string, number> | null }).assetIdCache = null;
    vi.spyOn(hyperliquidSpot, 'getMarket').mockResolvedValue({
      coin: 'PURR/USDC',
      displayName: 'PURR/USDC',
      baseToken: 'PURR',
      quoteToken: 'USDC',
      priceUsd: 0.1,
      change24hPct: null,
      index: 12,
      isCanonical: true,
    });
    const submittedActions: Array<{ orders: Array<{ a: number; t: { limit: { tif: string } } }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        type?: string;
        action?: { orders: Array<{ a: number; t: { limit: { tif: string } } }> };
      };
      if (body.type === 'spotMeta') {
        return Response.json({
          tokens: [{ name: 'PURR' }, { name: 'USDC' }],
          universe: [{ name: 'PURR/USDC', tokens: [0, 1], index: 12, isCanonical: true }],
        });
      }
      if (body.action) {
        submittedActions.push(body.action);
        return Response.json({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 99 } }] } },
        });
      }
      return Response.json({}, { status: 400 });
    }));

    const result = await hyperliquidSpot.placeOrder({
      privyWalletId: 'wallet_spot_test',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      coin: 'PURR/USDC',
      sideLong: true,
      qtyUsd: 40,
      orderType: 'limit',
      limitPriceUsd: 0.09,
      tif: 'Gtc',
    });

    expect(result).toEqual(expect.objectContaining({
      orderId: 'hls_99',
      filledQtyUsd: 0,
      state: 'resting',
      demo: false,
    }));
    expect(submittedActions[0]?.orders[0]?.a).toBe(10012);
    expect(submittedActions[0]?.orders[0]?.t.limit.tif).toBe('Gtc');
  });
});

describe('JupiterAdapter quote error handling', () => {
  it('preserves upstream 429 as ProviderRateLimitError', async () => {
    features.markets = true;
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json(
        { error: 'rate limited' },
        { status: 429, headers: { 'Retry-After': '37' } },
      ),
    ));

    await expect(jupiter.quote({
      inputMint: JUPITER_SOL_MINT,
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountAtomic: '1000000',
    })).rejects.toMatchObject({
      name: 'ProviderRateLimitError',
      vendor: 'jupiter',
      retryAfter: '37',
    } satisfies Partial<ProviderRateLimitError>);
  });
});

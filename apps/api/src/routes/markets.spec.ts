/**
 * Markets routes — read-only Hyperliquid + Polymarket, demo-mode coverage.
 *
 * No market upstreams are configured under vitest, so the adapters serve demo
 * sample data (hyperliquid.isLive / polymarket.isLive false). Boots the real
 * Hono app on an ephemeral port, same harness as api.spec.ts / earn.spec.ts.
 *
 * Geo-gate: Polymarket allows EU regions (NL) and restricts the US (451). The
 * builder-approval params clamp maxFeeBps to 10 inside the adapter regardless of
 * the requested value. There is no trade endpoint — these are all reads.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { _resetMarketRouteCacheForTests } from './markets.js';
import { env, features } from '../lib/env.js';
import { _resetForTests as resetRateLimitForTests } from '../lib/rate-limit.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import { hlSignUserSignedAction } from '../lib/markets/hl-signer.js';
import { walletService } from '../lib/chain/wallet.js';
import { hyperliquidSpot } from '../lib/markets/hyperliquid-spot.js';
import { Hip3RateLimitError, hyperliquidHip3 } from '../lib/markets/hyperliquid-hip3.js';
import { jupiter, JUPITER_SOL_MINT } from '../lib/markets/jupiter.js';
import { ProviderRateLimitError } from '../lib/markets/provider-errors.js';
import { polymarket } from '../lib/markets/polymarket.js';
import { store } from '../store/index.js';
import { pmLeaderboardIndex } from '../store/polymarket-index.js';
import { transferStore } from '../store/transfers.js';

vi.mock('../lib/markets/hl-signer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/markets/hl-signer.js')>();
  return {
    ...actual,
    hlSignUserSignedAction: vi.fn(async () => ({
      r: ('0x' + '11'.repeat(32)) as `0x${string}`,
      s: ('0x' + '22'.repeat(32)) as `0x${string}`,
      v: 27,
    })),
  };
});

let server: ServerType;
let base: string;
const originalLiveConfig = {
  privy: features.privy,
  jupiterSwaps: features.jupiterSwaps,
  solanaRpc: features.solanaRpc,
  ccEnabled: features.ccEnabled,
  hlBuilderAddress: env.HL_BUILDER_ADDRESS,
  hlBuilderFeeTenthsBp: env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP,
  polyApiKey: env.POLY_API_KEY,
  nodeEnv: env.NODE_ENV,
  demoMode: env.DEMO_MODE,
  rateLimitEnabled: env.RATE_LIMIT_ENABLED,
};

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  pmLeaderboardIndex._resetForTests();
  features.privy = originalLiveConfig.privy;
  features.jupiterSwaps = originalLiveConfig.jupiterSwaps;
  features.solanaRpc = originalLiveConfig.solanaRpc;
  features.ccEnabled = originalLiveConfig.ccEnabled;
  env.HL_BUILDER_ADDRESS = originalLiveConfig.hlBuilderAddress;
  env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = originalLiveConfig.hlBuilderFeeTenthsBp;
  env.POLY_API_KEY = originalLiveConfig.polyApiKey;
  env.NODE_ENV = originalLiveConfig.nodeEnv;
  env.DEMO_MODE = originalLiveConfig.demoMode;
  env.RATE_LIMIT_ENABLED = originalLiveConfig.rateLimitEnabled;
  resetRateLimitForTests();
  _resetMarketRouteCacheForTests();
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

let token = '';
const EMAIL = 'markets-tester@example.com';

async function login(): Promise<void> {
  const start = await json('/auth/start', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  token = verify.body.token;
}

async function freshAuthHeaders(email: string): Promise<Record<string, string>> {
  const start = await json('/auth/start', { method: 'POST', body: JSON.stringify({ email }) });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  return { authorization: `Bearer ${verify.body.token as string}` };
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function expectError(
  body: any,
  code: string,
  message = code,
  details?: Record<string, unknown>,
): void {
  expect(body.ok).toBe(false);
  expect(body.error).toEqual(expect.objectContaining({ code, message }));
  if (details) {
    expect(body.error.details).toEqual(expect.objectContaining(details));
  }
}

function forceHyperliquidLiveTrading(): void {
  features.privy = true;
  env.HL_BUILDER_ADDRESS = '0x0000000000000000000000000000000000000001';
}

function forcePolymarketLiveTrading(): void {
  features.privy = true;
  env.POLY_API_KEY = 'poly_test_key';
}

function forceJupiterLiveTrading(): void {
  features.privy = true;
  features.jupiterSwaps = true;
  features.solanaRpc = true;
}

async function userIdFor(headers: Record<string, string>): Promise<string> {
  const me = await json('/auth/me', { headers });
  return me.body.user.id as string;
}

beforeAll(login);

describe('markets routes (read-only, demo mode)', () => {
  it('never rate-limits public market GETs; mutations keep the bucket', async () => {
    env.RATE_LIMIT_ENABLED = true;
    resetRateLimitForTests();
    const ip = '198.51.100.42';

    // 140 straight GETs from one IP — the route cache is the abuse shield,
    // so reads can never 429 the app's own screens into "provider
    // unavailable". (This was the root cause of intermittent empty market
    // tabs: chart/orderbook polling + list hydrates walked through the old
    // per-IP read buckets.)
    for (let i = 0; i < 140; i++) {
      const { status } = await json('/markets/jupiter/detail?mint=bad', {
        headers: { 'x-forwarded-for': ip },
      });
      expect(status).toBe(400);
    }

    // Writes still consume the markets bucket: 120 anonymous POSTs from the
    // same IP exhaust it and the next one 429s before reaching the route.
    for (let i = 0; i < 120; i++) {
      const { status } = await json('/markets/hyperliquid/order', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(status).not.toBe(429);
    }
    const blockedWrite = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(blockedWrite.status).toBe(429);

    const prices = await json('/markets/jupiter/prices?ids=not-a-mint', {
      headers: { 'x-forwarded-for': ip },
    });
    expect(prices.status).toBe(200);

    const listPaths = [
      '/markets/hyperliquid',
      '/markets/hyperliquid-spot',
      '/markets/jupiter',
      '/markets/polymarket',
      '/markets/stocks',
      '/markets/stocks/perps',
      '/markets/stocks/spot',
      '/markets/cards',
      '/markets/cards/collections',
    ];
    for (const path of listPaths) {
      const list = await json(path, { headers: { 'x-forwarded-for': ip } });
      expect(list.status).toBe(200);
    }

    const positionPaths = [
      '/markets/positions',
      '/markets/hyperliquid/positions',
      '/markets/hyperliquid-spot/user-state',
      '/markets/hyperliquid-spot/positions',
      '/markets/jupiter/positions',
      '/markets/polymarket/positions',
      '/markets/stocks/positions',
      '/markets/cards/positions',
    ];
    for (let i = 0; i < 125; i++) {
      const positions = await json(positionPaths[i % positionPaths.length]!, {
        headers: { ...authed(), 'x-forwarded-for': ip },
      });
      expect(positions.status).toBe(200);
    }
  });

  it('GET /markets/hyperliquid lists markets including BTC', async () => {
    const { status, body } = await json('/markets/hyperliquid', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.markets)).toBe(true);
    const coins = body.markets.map((m: { coin: string }) => m.coin);
    expect(coins).toContain('BTC');
  });

  it('GET /markets/hyperliquid labels adapter fallback as provider-demo, not live', async () => {
    vi.spyOn(hyperliquid, 'getMarketsResult').mockResolvedValueOnce({
      source: 'provider-demo',
      markets: [{ coin: 'BTC', priceUsd: 64210.5, change24hPct: null }],
    });

    const { status, body } = await json('/markets/hyperliquid');

    expect(status).toBe(200);
    expect(body.source).toBe('demo');
    expect(body.sourced.source).toBe('provider-demo');
  });

  it('GET /markets/hyperliquid/btc returns a single market', async () => {
    const { status, body } = await json('/markets/hyperliquid/btc', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.market).toBeTruthy();
  });

  it('POST /markets/cards/buy returns a demo receipt in DEMO_MODE', async () => {
    env.DEMO_MODE = true;
    features.ccEnabled = true;
    features.privy = false;
    features.solanaRpc = false;

    const { status, body } = await json('/markets/cards/buy', {
      method: 'POST',
      headers: { ...authed(), 'Idempotency-Key': 'cards-demo-buy' },
      body: JSON.stringify({
        cardId: '202605230C136034',
        nftAddress: 'GNWtRMUAA9Bmajsyd4bFHqTcwZjfJy9Vn8rdB9WevsAz',
        expectedPriceUsdc: 1,
        tokenStandard: 'Pnft',
      }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.signature).toMatch(/^cc_demo_/);
    expect(body.sourced.source).toBe('provider-demo');
  });

  it('GET /markets/hyperliquid/:coin returns ApiError shape when missing', async () => {
    const { status, body } = await json('/markets/hyperliquid/not-a-market', {
      headers: authed(),
    });

    expect(status).toBe(404);
    expectError(body, 'not_found', 'not_found');
  });

  it('GET /markets/hyperliquid/builder-approval clamps maxFeeBps to 10', async () => {
    const { status, body } = await json('/markets/hyperliquid/builder-approval?maxFeeBps=50', {
      headers: authed(),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.params.maxFeeBps).toBe(10);
  });

  it('GET /markets/polymarket returns markets for an allowed region (NL)', async () => {
    const { status, body } = await json('/markets/polymarket', {
      headers: { ...authed(), 'X-Region': 'NL' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.markets)).toBe(true);
  });

  it('GET /markets/polymarket coalesces identical list reads through the route cache', async () => {
    const getMarkets = vi.spyOn(polymarket, 'getMarketsResult').mockResolvedValue({
      source: 'live',
      markets: [],
    });

    const [first, second] = await Promise.all([
      json('/markets/polymarket?limit=7&category=cache-test'),
      json('/markets/polymarket?limit=7&category=cache-test'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getMarkets).toHaveBeenCalledTimes(1);
    expect([first.body.cached, second.body.cached]).toContain(true);
  });

  it('GET /markets/polymarket is open to all regions (Avici restructure)', async () => {
    const { status, body } = await json('/markets/polymarket', {
      headers: { ...authed(), 'X-Region': 'US' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  // Sprint 16 — /markets/hyperliquid and /markets/polymarket list endpoints
  // are now public reads so the landing page + visitor-mode app can show real
  // prices. Auth still wraps user-specific paths (/positions, /order, /:id).
  it('GET /markets/hyperliquid is public (no session required)', async () => {
    const { status, body } = await json('/markets/hyperliquid');
    expect(status).toBe(200);
    expect(Array.isArray(body.markets)).toBe(true);
  });

  it('GET /markets/hyperliquid/:coin is public for uppercase market details', async () => {
    const { status, body } = await json('/markets/hyperliquid/BTC');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.market).toEqual(expect.objectContaining({ coin: 'BTC' }));
  });

  it('GET /markets/hyperliquid/funding-history is public and forwards bounded params', async () => {
    const getFundingHistory = vi
      .spyOn(hyperliquid, 'getFundingHistory')
      .mockResolvedValueOnce([
        { coin: 'BTC', fundingRate: 0.0001, premium: null, time: 1_720_000_000_000 },
      ]);

    const { status, body } = await json('/markets/hyperliquid/funding-history?coin=btc&lookback=3600000');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.history).toEqual([
      { coin: 'BTC', fundingRate: 0.0001, premium: null, time: 1_720_000_000_000 },
    ]);
    expect(getFundingHistory).toHaveBeenCalledWith('btc', 3_600_000);
  });

  it('GET /markets/hyperliquid detail book and trades forward builder dex', async () => {
    const getL2Book = vi
      .spyOn(hyperliquid, 'getL2Book')
      .mockResolvedValueOnce({ coin: 'xyz:TSLA', levels: [[], []], time: 1_720_000_000_000 });
    const getRecentTrades = vi.spyOn(hyperliquid, 'getRecentTrades').mockResolvedValueOnce([]);

    const book = await json('/markets/hyperliquid/orderbook?coin=xyz%3ATSLA&dex=xyz');
    const trades = await json('/markets/hyperliquid/recent-trades?coin=xyz%3ATSLA&dex=xyz');

    expect(book.status).toBe(200);
    expect(book.body.ok).toBe(true);
    expect(trades.status).toBe(200);
    expect(trades.body.ok).toBe(true);
    expect(getL2Book).toHaveBeenCalledWith('xyz:TSLA', 'xyz');
    expect(getRecentTrades).toHaveBeenCalledWith('xyz:TSLA', 'xyz');
  });

  it('GET /markets/polymarket is public (no session required)', async () => {
    const { status, body } = await json('/markets/polymarket');
    expect(status).toBe(200);
    expect(Array.isArray(body.markets)).toBe(true);
  });

  it('GET /markets/polymarket/:id is public for numeric market details', async () => {
    const getMarket = vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: '123',
      question: 'Will the test market settle yes?',
      outcomes: [
        { label: 'Yes', pricePct: 62 },
        { label: 'No', pricePct: 38 },
      ],
      closesAt: null,
    });

    const { status, body } = await json('/markets/polymarket/123');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.market).toEqual(expect.objectContaining({ id: '123' }));
    expect(getMarket).toHaveBeenCalledWith('123');
  });

  it('GET /markets/polymarket/:id/book is public for numeric market orderbooks', async () => {
    const getOrderbook = vi.spyOn(polymarket, 'getOrderbook').mockResolvedValueOnce({
      bids: [{ priceCents: 61, sizeShares: 12 }],
      asks: [{ priceCents: 63, sizeShares: 8 }],
      midCents: 62,
      spreadCents: 2,
    });

    const { status, body } = await json('/markets/polymarket/123/book?outcome=Yes');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.book).toEqual({
      bids: [{ priceCents: 61, sizeShares: 12 }],
      asks: [{ priceCents: 63, sizeShares: 8 }],
      midCents: 62,
      spreadCents: 2,
    });
    expect(getOrderbook).toHaveBeenCalledWith('123', 'Yes');
  });

  it('GET /markets/polymarket/:id/book coalesces identical cold reads', async () => {
    const getOrderbook = vi.spyOn(polymarket, 'getOrderbook').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        bids: [{ priceCents: 61, sizeShares: 12 }],
        asks: [{ priceCents: 63, sizeShares: 8 }],
        midCents: 62,
        spreadCents: 2,
      };
    });

    const [first, second] = await Promise.all([
      json('/markets/polymarket/123/book?outcome=Yes'),
      json('/markets/polymarket/123/book?outcome=Yes'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getOrderbook).toHaveBeenCalledTimes(1);
    expect([first.body.cached, second.body.cached]).toContain(true);
  });

  it('GET /markets/polymarket/:id/top-traders is public for numeric markets', async () => {
    const getTopTraders = vi.spyOn(polymarket, 'getTopTraders').mockResolvedValueOnce({
      source: 'live',
      outcomes: [
        {
          tokenId: 'token_yes',
          holders: [
            {
              wallet: '0xabc',
              name: 'maker',
              amount: 42,
              outcomeIndex: 0,
              verified: true,
            },
          ],
        },
      ],
    });

    const { status, body } = await json('/markets/polymarket/123/top-traders?limit=100');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.source).toBe('polymarket');
    expect(body.outcomes).toEqual([
      {
        tokenId: 'token_yes',
        holders: [
          {
            wallet: '0xabc',
            name: 'maker',
            amount: 42,
            outcomeIndex: 0,
            verified: true,
          },
        ],
      },
    ]);
    expect(getTopTraders).toHaveBeenCalledWith('123', 50);
  });

  it('GET /markets/polymarket/:id/top-traders coalesces identical cold reads', async () => {
    const getTopTraders = vi.spyOn(polymarket, 'getTopTraders').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        source: 'live',
        outcomes: [{ tokenId: 'token_yes', holders: [] }],
      };
    });

    const [first, second] = await Promise.all([
      json('/markets/polymarket/456/top-traders?limit=5'),
      json('/markets/polymarket/456/top-traders?limit=5'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getTopTraders).toHaveBeenCalledTimes(1);
    expect([first.body.cached, second.body.cached]).toContain(true);
  });

  it('GET /markets/polymarket/leaderboard clamps params before adapter + cache key', async () => {
    const getLeaderboard = vi.spyOn(polymarket, 'getLeaderboard').mockResolvedValueOnce({
      source: 'live',
      traders: [
        {
          wallet: '0xabc',
          name: null,
          pnl: 10,
          realizedPnl: 2,
          value: 50,
          positions: 3,
          winRate: 2 / 3,
        },
      ],
    });

    const first = await json('/markets/polymarket/leaderboard?limit=999&markets=999&sort=value');
    const second = await json('/markets/polymarket/leaderboard?limit=50&markets=20&sort=value');

    expect(first.status).toBe(200);
    expect(first.body.cached).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.cached).toBe(true);
    expect(getLeaderboard).toHaveBeenCalledTimes(1);
    expect(getLeaderboard).toHaveBeenCalledWith({ sort: 'value', traders: 50, markets: 20 });
  });

  it('GET /markets/polymarket/leaderboard coalesces identical cold recomputes', async () => {
    const getLeaderboard = vi.spyOn(polymarket, 'getLeaderboard').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        source: 'live',
        traders: [
          {
            wallet: '0xcoalesce',
            name: null,
            pnl: 10,
            realizedPnl: 2,
            value: 50,
            positions: 3,
            winRate: 2 / 3,
          },
        ],
      };
    });

    const [first, second] = await Promise.all([
      json('/markets/polymarket/leaderboard?limit=3&markets=3&sort=realizedPnl'),
      json('/markets/polymarket/leaderboard?limit=3&markets=3&sort=realizedPnl'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(getLeaderboard).toHaveBeenCalledTimes(1);
    expect([first.body.cached, second.body.cached]).toContain(true);
  });

  it('GET /markets/polymarket/leaderboard serves an unexpired persisted snapshot before recomputing', async () => {
    await pmLeaderboardIndex.write('pm-leaderboard:pnl:2:2', {
      source: 'polymarket',
      sourced: { source: 'live', provider: 'polymarket', fetchedAt: '2026-06-29T00:00:00.000Z' },
      traders: [
        {
          wallet: '0xpersisted',
          name: 'steady',
          pnl: 42,
          realizedPnl: 4,
          value: 100,
          positions: 2,
          winRate: 0.5,
        },
      ],
    }, { ttlMs: 300_000 });
    const getLeaderboard = vi.spyOn(polymarket, 'getLeaderboard').mockResolvedValueOnce({
      source: 'provider-demo',
      traders: [],
    });

    const res = await json('/markets/polymarket/leaderboard?limit=2&markets=2&sort=pnl');

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.persisted).toBe(true);
    expect(res.body.stale).toBe(false);
    expect(res.body.traders[0].wallet).toBe('0xpersisted');
    expect(getLeaderboard).not.toHaveBeenCalled();
  });

  it('GET /markets/polymarket/leaderboard falls back to a stale persisted snapshot when recompute has no traders', async () => {
    await pmLeaderboardIndex.write('pm-leaderboard:winRate:1:1', {
      source: 'polymarket',
      sourced: { source: 'live', provider: 'polymarket', fetchedAt: '2026-06-29T00:00:00.000Z' },
      traders: [
        {
          wallet: '0xstale',
          name: null,
          pnl: 12,
          realizedPnl: 1,
          value: 80,
          positions: 4,
          winRate: 0.75,
        },
      ],
    }, { ttlMs: -1 });
    const getLeaderboard = vi.spyOn(polymarket, 'getLeaderboard').mockResolvedValueOnce({
      source: 'provider-demo',
      traders: [],
    });

    const res = await json('/markets/polymarket/leaderboard?limit=1&markets=1&sort=winRate');

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.persisted).toBe(true);
    expect(res.body.stale).toBe(true);
    expect(res.body.traders[0].wallet).toBe('0xstale');
    expect(getLeaderboard).toHaveBeenCalledTimes(1);
  });

  it('GET /markets/polymarket/traders/:wallet/copy-intent is public and returns a copy target', async () => {
    const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const getCopyIntent = vi.spyOn(polymarket, 'getCopyIntent').mockResolvedValueOnce({
      source: 'live',
      intent: {
        wallet,
        marketId: '30615',
        outcome: 'Yes',
        outcomeIndex: 0,
        title: 'Will France win the 2026 FIFA World Cup?',
        slug: 'will-france-win',
        icon: null,
        conditionId: '0xcond',
        asset: '123',
        oppositeAsset: null,
        currentValueUsd: 100,
        suggestedQtyUsd: 5,
        entryPriceCents: 16.8,
        currentPriceCents: 23.4,
        pnlUsd: 20,
        sizeShares: 400,
        endDate: '2026-07-20',
        negativeRisk: true,
      },
    });

    const res = await json(`/markets/polymarket/traders/${wallet}/copy-intent`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source).toBe('polymarket');
    expect(res.body.intent.marketId).toBe('30615');
    expect(getCopyIntent).toHaveBeenCalledWith(wallet);
  });

  it('GET /markets/hyperliquid/positions still requires a session', async () => {
    const { status } = await json('/markets/hyperliquid/positions');
    expect(status).toBe(401);
  });

  it('GET /markets/hyperliquid-spot/user-state returns live spot USDC for the signed-in user', async () => {
    const getUserState = vi.spyOn(hyperliquidSpot, 'getUserState').mockResolvedValueOnce({
      usdcUsd: 15.118582,
      balances: [{ coin: 'USDC', total: 15.118582, hold: 0, entryNtl: null }],
      live: true,
    });

    const { status, body } = await json('/markets/hyperliquid-spot/user-state', { headers: authed() });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.state.usdcUsd).toBe(15.118582);
    expect(body.state.balances[0].coin).toBe('USDC');
    expect(getUserState).toHaveBeenCalledTimes(1);
  });

  it('GET /markets/hyperliquid-spot/user-state still requires a session', async () => {
    const { status } = await json('/markets/hyperliquid-spot/user-state');
    expect(status).toBe(401);
  });

  it('GET /markets/polymarket/positions still requires a session', async () => {
    const { status } = await json('/markets/polymarket/positions');
    expect(status).toBe(401);
  });

  it('GET /markets/hyperliquid/candles rejects unsafe public query params', async () => {
    const badCoin = await json('/markets/hyperliquid/candles?coin=BTC%3Cscript%3E');
    expect(badCoin.status).toBe(400);
    expectError(badCoin.body, 'bad_request', 'invalid_coin');

    const badDex = await json('/markets/hyperliquid/orderbook?coin=BTC&dex=xyz%3Cscript%3E');
    expect(badDex.status).toBe(400);
    expectError(badDex.body, 'bad_request', 'invalid_dex');

    const badLookback = await json('/markets/hyperliquid/candles?coin=BTC&lookback=999999999999');
    expect(badLookback.status).toBe(400);
    expectError(badLookback.body, 'bad_request', 'invalid_lookback');
  });
});

/* ── Sprint 10 Item E — write surface tests ─────────────────────────────── */

describe('markets trade routes (demo mode)', () => {
  it('POST /markets/hyperliquid/order from any region succeeds (Avici restructure)', async () => {
    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'US' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 100, leverage: 1 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('POST /markets/hyperliquid/order in allowed region returns 200 and persists position', async () => {
    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.position.venue).toBe('hyperliquid');
    expect(body.position.qtyUsd).toBe(75);
    expect(body.position.externalRef).toMatch(/^hl_/);

    const list = await json('/markets/hyperliquid/positions', {
      headers: { ...authed(), 'X-Region': 'NL' },
    });
    expect(list.status).toBe(200);
    const refs = list.body.positions.map((p: { externalRef: string }) => p.externalRef);
    expect(refs).toContain(body.position.externalRef);
  });

  it('POST /markets/hyperliquid/order forwards limit price and TIF to the adapter (v2 kind shape)', async () => {
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_demo_limit_forwarded',
      filledQtyUsd: 75,
      entryPriceUsd: 50000,
      demo: true,
    });

    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        orderType: 'limit',
        limitPriceUsd: 50000,
        tif: 'Ioc',
      }),
    });

    expect(status).toBe(200);
    expect(body.position.externalRef).toBe('hl_demo_limit_forwarded');
    // V2 router maps legacy orderType:"limit" → kind:"limit" before invoking the adapter.
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'limit',
      limitPriceUsd: 50000,
      tif: 'Ioc',
    }));
  });

  it('POST /markets/hyperliquid/order forwards reduce-only to the adapter (close semantics)', async () => {
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_demo_reduce_only',
      filledQtyUsd: 75,
      entryPriceUsd: 50000,
      demo: true,
    });

    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        reduceOnly: true,
      }),
    });

    expect(status).toBe(200);
    expect(body.position.externalRef).toBe('hl_demo_reduce_only');
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      reduceOnly: true,
    }));
  });

  it('POST /markets/hyperliquid/order accepts resting Gtc TIF and forwards to the adapter', async () => {
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_demo_resting_gtc',
      filledQtyUsd: 0,
      entryPriceUsd: 50000,
      demo: true,
      state: 'resting',
    });

    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        orderType: 'limit',
        limitPriceUsd: 50000,
        tif: 'Gtc',
      }),
    });

    expect(status).toBe(200);
    expect(body.order.state).toBe('resting');
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'limit',
      tif: 'Gtc',
    }));
  });

  it('POST /markets/stocks/order records a resting HIP-3 limit order as resting', async () => {
    const placeOrder = vi.spyOn(hyperliquidHip3, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hip3_demo_resting_gtc',
      filledQtyUsd: 0,
      entryPriceUsd: 101,
      demo: true,
      state: 'resting',
    });

    const { status, body } = await json('/markets/stocks/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'AAPL',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        orderType: 'limit',
        limitPriceUsd: 101,
        tif: 'Gtc',
        reduceOnly: true,
      }),
    });

    expect(status).toBe(200);
    expect(body.order.state).toBe('resting');
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      orderType: 'limit',
      tif: 'Gtc',
      reduceOnly: true,
    }));
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.status).toBe('resting');
    expect(row?.qtyUsd).toBe(75);
    expect(body.position.qtyUsd).toBe(75);
    expect(body.position.filledQtyUsd ?? 0).toBe(0);
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual(['resting']);
  });

  it('POST /markets/stocks/order preserves upstream HIP-3 rate limits', async () => {
    vi.spyOn(hyperliquidHip3, 'placeOrder').mockRejectedValueOnce(new Hip3RateLimitError('60'));

    const res = await fetch(base + '/markets/stocks/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL', 'content-type': 'application/json' },
      body: JSON.stringify({
        coin: 'AAPL',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        orderType: 'market',
      }),
    });
    const body = await res.json() as { error?: { code?: string; message?: string } };

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(body.error?.message).toBe('too_many_requests');
  });

  it('POST /markets/jupiter/quote preserves upstream rate limits', async () => {
    vi.spyOn(jupiter, 'quote').mockRejectedValueOnce(new ProviderRateLimitError('jupiter', '45'));

    const res = await fetch(base + '/markets/jupiter/quote', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL', 'content-type': 'application/json' },
      body: JSON.stringify({
        inputMint: JUPITER_SOL_MINT,
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amountAtomic: '1000000',
      }),
    });
    const body = await res.json() as { error?: { code?: string; message?: string } };

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('45');
    expect(body.error?.message).toBe('too_many_requests');
  });

  it('POST /markets/hyperliquid/order returns ApiError shape for invalid limit order price', async () => {
    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        orderType: 'limit',
      }),
    });

    expect(status).toBe(400);
    expectError(body, 'bad_request', 'invalid_limit_price');
  });

  it('POST /markets/hyperliquid/order rejects live trading without a wallet id', async () => {
    forceHyperliquidLiveTrading();
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder');

    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });

    expect(status).toBe(503);
    expectError(body, 'trading_wallet_unavailable');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('POST /markets/hyperliquid/order allows live trading before KYC approval', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-no-kyc@example.com');
    const userId = await userIdFor(headers);
    const user = await store.user(userId);
    await store.setKyc(user, 'pending');
    await store.setPrivyWallet(userId, 'wallet_route_live_no_kyc', '0x00000000000000000000000000000000000000aa', { force: true });
    await store.setHlBuilderApproval(userId, env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0);
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_live_no_kyc',
      filledQtyUsd: 75,
      entryPriceUsd: 50000,
      demo: false,
    });

    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'X-Idempotency-Key': 'hl-live-no-kyc-1' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });

    expect(status).toBe(200);
    expect(body.position.externalRef).toBe('hl_live_no_kyc');
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/usd-class-transfer replays duplicate live idempotency keys without a second venue call', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-class-transfer-replay@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_class_transfer_live_replay', '0x00000000000000000000000000000000000000aa', { force: true });
    const usdClassTransfer = vi.spyOn(hyperliquid, 'usdClassTransfer').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_xfer_replay',
      amountUsd: 25,
      toPerp: true,
      demo: false,
    });
    const request = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-class-transfer-replay-1' },
      body: JSON.stringify({ amountUsd: 25, toPerp: true }),
    };

    const first = await json('/markets/hyperliquid/usd-class-transfer', request);
    const second = await json('/markets/hyperliquid/usd-class-transfer', request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.transfer.id).toBe(second.body.transfer.id);
    expect(first.body.transfer.status).toBe('complete');
    expect(second.body.replay).toBe(true);
    expect(second.body.callId).toBe('hl_xfer_replay');
    expect(usdClassTransfer).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/usd-class-transfer stays complete when post-submit audit append fails', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-class-transfer-audit-fail@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_class_transfer_live_audit_fail', '0x00000000000000000000000000000000000000aa', { force: true });
    const usdClassTransfer = vi.spyOn(hyperliquid, 'usdClassTransfer').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_xfer_audit_fail',
      amountUsd: 25,
      toPerp: true,
      demo: false,
    });
    const appendEvent = transferStore.appendEvent.bind(transferStore);
    vi.spyOn(transferStore, 'appendEvent').mockImplementation(async (transferId, eventType, payload) => {
      if (eventType === 'complete') throw new Error('audit db down');
      return appendEvent(transferId, eventType, payload);
    });
    const request = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-class-transfer-audit-fail-1' },
      body: JSON.stringify({ amountUsd: 25, toPerp: true }),
    };

    const first = await json('/markets/hyperliquid/usd-class-transfer', request);
    const second = await json('/markets/hyperliquid/usd-class-transfer', request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.callId).toBe('hl_xfer_audit_fail');
    expect(first.body.transfer.status).toBe('complete');
    expect(first.body.transfer.error).toMatchObject({
      code: 'usd_class_transfer_audit_failed',
      callId: 'hl_xfer_audit_fail',
    });
    expect(second.body.replay).toBe(true);
    expect(second.body.callId).toBe('hl_xfer_audit_fail');
    expect(usdClassTransfer).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/usd-class-transfer requires an idempotency key before live venue submission', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-class-transfer-no-idem@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_class_transfer_live_no_idem', '0x00000000000000000000000000000000000000aa', { force: true });
    const usdClassTransfer = vi.spyOn(hyperliquid, 'usdClassTransfer');

    const { status, body } = await json('/markets/hyperliquid/usd-class-transfer', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL' },
      body: JSON.stringify({ amountUsd: 25, toPerp: true }),
    });

    expect(status).toBe(400);
    expectError(body, 'bad_request', 'idempotency_key_required');
    expect(usdClassTransfer).not.toHaveBeenCalled();
  });

  it('POST /markets/hyperliquid/withdraw allows live wallet withdrawal before KYC approval', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-withdraw-no-kyc@example.com');
    const userId = await userIdFor(headers);
    const user = await store.user(userId);
    await store.setKyc(user, 'pending');
    await store.setPrivyWallet(userId, 'wallet_withdraw_live_no_kyc', '0x00000000000000000000000000000000000000aa', { force: true });
    const destination = '0x00000000000000000000000000000000000000bb';
    const withdraw3 = vi.spyOn(hyperliquid, 'withdraw3').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_wdr_no_kyc',
      destination,
      amountUsd: 25,
      demo: false,
    });

    const { status, body } = await json('/markets/hyperliquid/withdraw', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'X-Idempotency-Key': 'hl-withdraw-no-kyc-1' },
      body: JSON.stringify({ destination, amountUsd: 25 }),
    });

    expect(status).toBe(200);
    expect(body.callId).toBe('hl_wdr_no_kyc');
    expect(body.transfer.status).toBe('complete');
    expect(body.transfer.rail).toBe('hl_withdraw');
    expect(withdraw3).toHaveBeenCalledWith(expect.objectContaining({ destination, amountUsd: 25 }));
  });

  it('POST /markets/hyperliquid/usd-send allows live core wallet send before KYC and replays idempotency', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-usd-send-no-kyc@example.com');
    const userId = await userIdFor(headers);
    const user = await store.user(userId);
    await store.setKyc(user, 'pending');
    await store.setPrivyWallet(userId, 'wallet_usd_send_live_no_kyc', '0x00000000000000000000000000000000000000aa', { force: true });
    const destination = '0x00000000000000000000000000000000000000bb';
    const usdSend = vi.spyOn(hyperliquid, 'usdSend').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_usd_send_no_kyc',
      destination,
      amountUsd: 25,
      demo: false,
    });
    const request = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-usd-send-no-kyc-1' },
      body: JSON.stringify({ destination, amountUsd: 25 }),
    };

    const first = await json('/markets/hyperliquid/usd-send', request);
    const second = await json('/markets/hyperliquid/usd-send', request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.callId).toBe('hl_usd_send_no_kyc');
    expect(first.body.transfer.status).toBe('complete');
    expect(second.body.replay).toBe(true);
    expect(second.body.transfer.id).toBe(first.body.transfer.id);
    expect(usdSend).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/usd-send blocks replay of an unsubmitted local transfer', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-usd-send-created-replay@example.com');
    const userId = await userIdFor(headers);
    const user = await store.user(userId);
    await store.setKyc(user, 'pending');
    await store.setPrivyWallet(userId, 'wallet_usd_send_created_replay', '0x00000000000000000000000000000000000000aa', { force: true });
    await transferStore.create({
      userId,
      fromBucket: 'perps',
      toBucket: 'external',
      fromChain: 'arbitrum',
      toChain: 'arbitrum',
      amountUsd: 25,
      amountTokenAtoms: '25000000',
      rail: 'internal',
      idempotencyKey: 'hlusdsend:hl-usd-send-created-replay-1',
    });
    const usdSend = vi.spyOn(hyperliquid, 'usdSend');

    const { status, body } = await json('/markets/hyperliquid/usd-send', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-usd-send-created-replay-1' },
      body: JSON.stringify({ destination: '0x00000000000000000000000000000000000000bb', amountUsd: 25 }),
    });

    expect(status).toBe(409);
    expectError(body, 'transfer_in_progress');
    expect(usdSend).not.toHaveBeenCalled();
  });

  it('POST /markets/hyperliquid/usd-send rejects same-key replay with a changed destination', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-usd-send-mismatch@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_usd_send_mismatch', '0x00000000000000000000000000000000000000aa', { force: true });
    const usdSend = vi.spyOn(hyperliquid, 'usdSend').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_usd_send_mismatch',
      destination: '0x00000000000000000000000000000000000000bb',
      amountUsd: 25,
      demo: false,
    });
    const headersWithKey = { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-usd-send-mismatch-1' };

    const first = await json('/markets/hyperliquid/usd-send', {
      method: 'POST',
      headers: headersWithKey,
      body: JSON.stringify({ destination: '0x00000000000000000000000000000000000000bb', amountUsd: 25 }),
    });
    const second = await json('/markets/hyperliquid/usd-send', {
      method: 'POST',
      headers: headersWithKey,
      body: JSON.stringify({ destination: '0x00000000000000000000000000000000000000cc', amountUsd: 25 }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expectError(second.body, 'idempotency_key_body_mismatch');
    expect(usdSend).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/usd-send does not fail a submitted provider call when completion persistence hiccups', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-usd-send-persist-fail@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_usd_send_persist_fail', '0x00000000000000000000000000000000000000aa', { force: true });
    vi.spyOn(hyperliquid, 'usdSend').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_usd_send_persist_fail',
      destination: '0x00000000000000000000000000000000000000bb',
      amountUsd: 25,
      demo: false,
    });
    vi.spyOn(transferStore, 'update').mockRejectedValueOnce(new Error('db down after submit'));

    const { status, body } = await json('/markets/hyperliquid/usd-send', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-usd-send-persist-fail-1' },
      body: JSON.stringify({ destination: '0x00000000000000000000000000000000000000bb', amountUsd: 25 }),
    });

    expect(status).toBe(200);
    expect(body.callId).toBe('hl_usd_send_persist_fail');
    expect(body.transfer.status).toBe('complete');
    expect(body.transfer.error).toMatchObject({
      code: 'usd_send_audit_failed',
      callId: 'hl_usd_send_persist_fail',
      reconciliationRequired: true,
    });
  });

  it('POST /markets/hyperliquid/transfer-to-dex allows live builder DEX transfer before KYC and replays idempotency', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-dex-transfer-no-kyc@example.com');
    const userId = await userIdFor(headers);
    const user = await store.user(userId);
    await store.setKyc(user, 'pending');
    await store.setPrivyWallet(userId, 'wallet_dex_transfer_live_no_kyc', '0x00000000000000000000000000000000000000aa', { force: true });
    const transferToDex = vi.spyOn(hyperliquid, 'transferToDex').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_dex_no_kyc',
      amountUsd: 25,
      sourceDex: '',
      destinationDex: 'xyz',
      token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
      demo: false,
    });
    const request = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-dex-transfer-no-kyc-1' },
      body: JSON.stringify({ amountUsd: 25, destinationDex: 'xyz' }),
    };

    const first = await json('/markets/hyperliquid/transfer-to-dex', request);
    const second = await json('/markets/hyperliquid/transfer-to-dex', request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.callId).toBe('hl_dex_no_kyc');
    expect(first.body.transfer.status).toBe('complete');
    expect(first.body.destinationDex).toBe('xyz');
    expect(second.body.replay).toBe(true);
    expect(second.body.transfer.id).toBe(first.body.transfer.id);
    expect(transferToDex).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/transfer-to-dex allows returning from builder DEX to core before KYC', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-dex-return-no-kyc@example.com');
    const userId = await userIdFor(headers);
    const user = await store.user(userId);
    await store.setKyc(user, 'pending');
    await store.setPrivyWallet(userId, 'wallet_dex_return_live_no_kyc', '0x00000000000000000000000000000000000000aa', { force: true });
    const transferToDex = vi.spyOn(hyperliquid, 'transferToDex').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_dex_return_no_kyc',
      amountUsd: 25,
      sourceDex: 'xyz',
      destinationDex: '',
      token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
      demo: false,
    });

    const { status, body } = await json('/markets/hyperliquid/transfer-to-dex', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-dex-return-no-kyc-1' },
      body: JSON.stringify({ amountUsd: 25, sourceDex: 'xyz', destinationDex: '' }),
    });

    expect(status).toBe(200);
    expect(body.callId).toBe('hl_dex_return_no_kyc');
    expect(body.sourceDex).toBe('xyz');
    expect(body.destinationDex).toBe('');
    expect(transferToDex).toHaveBeenCalledWith(expect.objectContaining({
      amountUsd: 25,
      sourceDex: 'xyz',
      destinationDex: '',
    }));
  });

  it('POST /markets/hyperliquid/withdraw replays duplicate live idempotency keys without a second venue call', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-withdraw-replay@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_withdraw_live_replay', '0x00000000000000000000000000000000000000aa', { force: true });
    const destination = '0x00000000000000000000000000000000000000bb';
    const withdraw3 = vi.spyOn(hyperliquid, 'withdraw3').mockResolvedValueOnce({
      ok: true,
      callId: 'hl_wdr_replay',
      destination,
      amountUsd: 25,
      demo: false,
    });
    const request = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-withdraw-replay-1' },
      body: JSON.stringify({ destination, amountUsd: 25 }),
    };

    const first = await json('/markets/hyperliquid/withdraw', request);
    const second = await json('/markets/hyperliquid/withdraw', request);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.transfer.id).toBe(second.body.transfer.id);
    expect(second.body.replay).toBe(true);
    expect(second.body.callId).toBe('hl_wdr_replay');
    expect(withdraw3).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/withdraw requires an idempotency key before live venue submission', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-withdraw-no-idem@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_withdraw_live_no_idem', '0x00000000000000000000000000000000000000aa', { force: true });
    const withdraw3 = vi.spyOn(hyperliquid, 'withdraw3');

    const { status, body } = await json('/markets/hyperliquid/withdraw', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL' },
      body: JSON.stringify({ destination: '0x00000000000000000000000000000000000000bb', amountUsd: 25 }),
    });

    expect(status).toBe(400);
    expectError(body, 'bad_request', 'idempotency_key_required');
    expect(withdraw3).not.toHaveBeenCalled();
  });
  it.skip('legacy: production live mode required trusted geo metadata (Avici restructure dropped this gate)', () => {});

  it('POST /markets/hyperliquid/order requires an idempotency key before live venue submission', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-no-idem@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_route_live_no_idem', '0x00000000000000000000000000000000000000aa', { force: true });
    await store.setHlBuilderApproval(userId, env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0);
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder');

    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });

    expect(status).toBe(400);
    expectError(body, 'bad_request', 'idempotency_key_required');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('POST /markets/hyperliquid/order replays duplicate live idempotency keys without a second venue call', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-idem-replay@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_route_live_replay', '0x00000000000000000000000000000000000000aa', { force: true });
    await store.setHlBuilderApproval(userId, env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0);
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_424242',
      filledQtyUsd: 75,
      entryPriceUsd: 50000,
      demo: false,
    });
    const order = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'X-Idempotency-Key': 'hl-live-replay-1' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 75, leverage: 1 }),
    };

    const first = await json('/markets/hyperliquid/order', order);
    const second = await json('/markets/hyperliquid/order', order);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.position.id).toBe(second.body.position.id);
    expect(second.body.order.replay).toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  // Gate-5 soak regression (2026-07-17): demo mode used to ignore the
  // Idempotency-Key header entirely (key was only read when isLiveTrading),
  // so every replay minted a fresh hl_demo_* order — 7926/7926 mismatches in
  // the 6h soak. Keys are now honored whenever provided; only the
  // *requirement* stays live-only.
  it('POST /markets/hyperliquid/order honors idempotency keys in demo mode', async () => {
    const headers = await freshAuthHeaders('markets-demo-idem-replay@example.com');
    const order = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-demo-replay-1' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 5, leverage: 1 }),
    };

    const first = await json('/markets/hyperliquid/order', order);
    const second = await json('/markets/hyperliquid/order', order);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Same reservation row + same synthetic venue ref — a replay, not a new order.
    expect(second.body.position.id).toBe(first.body.position.id);
    expect(second.body.order.orderId).toBe(first.body.order.orderId);
    expect(second.body.order.replay).toBe(true);
    // Replay response must keep telling the truth about demo execution.
    expect(second.body.order.demo).toBe(true);
  });

  it('POST /markets/hyperliquid/order rejects demo-mode key reuse with a different intent', async () => {
    const headers = await freshAuthHeaders('markets-demo-idem-mismatch@example.com');
    const withCoin = (coin: string) => ({
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-demo-mismatch-1' },
      body: JSON.stringify({ coin, sideLong: true, qtyUsd: 5, leverage: 1 }),
    });

    const first = await json('/markets/hyperliquid/order', withCoin('BTC'));
    const mismatch = await json('/markets/hyperliquid/order', withCoin('ETH'));

    expect(first.status).toBe(200);
    expect(mismatch.status).toBe(409);
    expectError(mismatch.body, 'idempotency_key_body_mismatch');
  });

  it('POST /markets/hyperliquid/order rejects a reused idempotency key with a different intent', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-idem-mismatch@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_route_live_mismatch', '0x00000000000000000000000000000000000000aa', { force: true });
    await store.setHlBuilderApproval(userId, env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0);
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_idem_mismatch_original',
      filledQtyUsd: 75,
      entryPriceUsd: 50000,
      demo: false,
    });
    const headersWithIdem = { ...headers, 'CF-IPCountry': 'NL', 'X-Idempotency-Key': 'hl-live-mismatch-1' };

    const first = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: headersWithIdem,
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });
    const mismatch = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: headersWithIdem,
      body: JSON.stringify({ coin: 'ETH', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });

    expect(first.status).toBe(200);
    expect(mismatch.status).toBe(409);
    expectError(mismatch.body, 'idempotency_key_body_mismatch');
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/order retries recording an accepted live order', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-recording-retry@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_route_live_recording_retry', '0x00000000000000000000000000000000000000aa', { force: true });
    await store.setHlBuilderApproval(userId, env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0);
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_recorded_after_retry',
      filledQtyUsd: 80,
      entryPriceUsd: 51000,
      demo: false,
    });
    const complete = vi.spyOn(store, 'completeMarketOrder');
    complete.mockRejectedValueOnce(new Error('pg_transient_drop'));
    const order = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'Idempotency-Key': 'hl-live-recording-retry-1' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 80, leverage: 1 }),
    };

    const first = await json('/markets/hyperliquid/order', order);
    const replay = await json('/markets/hyperliquid/order', order);

    expect(first.status).toBe(200);
    // Sprint 1 lifecycle: response now carries the lifecycle vocabulary
    // ('filled' for a venue-accepted live order). Legacy 'open' value remains
    // valid in the DB for historic rows that never went through lifecycle.
    expect(first.body.position).toEqual(expect.objectContaining({
      status: 'filled',
      externalRef: 'hl_recorded_after_retry',
    }));
    expect(replay.status).toBe(200);
    expect(replay.body.order.replay).toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('POST /markets/hyperliquid/order does not persist a local position when the live venue rejects', async () => {
    forceHyperliquidLiveTrading();
    const headers = authed();
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_route_live_test', '0x00000000000000000000000000000000000000aa', { force: true });
    await store.setHlBuilderApproval(userId, env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0);
    const before = await json('/markets/hyperliquid/positions', {
      headers: { ...headers, 'X-Region': 'NL' },
    });
    const beforeCount = before.body.positions.length;
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockRejectedValueOnce(new Error('venue_down'));
    const order = {
      method: 'POST',
      headers: { ...headers, 'CF-IPCountry': 'NL', 'X-Idempotency-Key': 'hl-live-reject-1' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 75, leverage: 1 }),
    };

    const { status, body } = await json('/markets/hyperliquid/order', order);

    // 422, not 502: Cloudflare swallows origin 502/504 (serves its own
    // CORS-less error page), so venue rejections must not look like a gateway.
    // The message carries the venue's own reason so the ticket can show WHY.
    expect(status).toBe(422);
    expectError(body, 'venue_order_failed', 'venue_down');
    const after = await json('/markets/hyperliquid/positions', {
      headers: { ...headers, 'X-Region': 'NL' },
    });
    expect(after.body.positions).toHaveLength(beforeCount);
    const retry = await json('/markets/hyperliquid/order', order);
    expect(retry.status).toBe(409);
    expectError(retry.body, 'idempotency_key_used');
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/hyperliquid/cancel → status closed for the just-placed order', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', sideLong: false, qtyUsd: 30, leverage: 1, kind: 'limit', limitPriceUsd: 2500 }),
    });
    const ref = placed.body.position.externalRef as string;
    const { status, body } = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef: ref }),
    });
    expect(status).toBe(200);
    // Sprint 1 lifecycle: cancel response carries the lifecycle vocabulary.
    expect(body.position.status).toBe('canceled');
  });

  it('POST /markets/hyperliquid/cancel uses the stored symbol when coin is omitted', async () => {
    const headers = await freshAuthHeaders('markets-live-cancel-symbol@example.com');
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', sideLong: false, qtyUsd: 30, leverage: 1, kind: 'limit', limitPriceUsd: 2500 }),
    });
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_route_live_cancel_symbol', '0x00000000000000000000000000000000000000aa', { force: true });
    await store.setHlBuilderApproval(userId, env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0);
    forceHyperliquidLiveTrading();
    const cancelOrder = vi.spyOn(hyperliquid, 'cancelOrder').mockResolvedValueOnce({ ok: true, demo: false });

    const { status, body } = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef: placed.body.position.externalRef }),
    });

    expect(status).toBe(200);
    // Sprint 1 lifecycle: cancel response carries the lifecycle vocabulary.
    expect(body.position.status).toBe('canceled');
    expect(cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ coin: 'ETH' }));
  });

  it('POST /markets/hyperliquid/cancel does not resubmit a cancel already in flight', async () => {
    const headers = await freshAuthHeaders('markets-cancel-inflight@example.com');
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', sideLong: false, qtyUsd: 30, leverage: 1, kind: 'limit', limitPriceUsd: 2500 }),
    });
    const positionId = placed.body.position.id as string;
    const externalRef = placed.body.position.externalRef as string;
    await store.recordLifecycleTransition(positionId, { status: 'cancel_requested' });
    const cancelOrder = vi.spyOn(hyperliquid, 'cancelOrder');

    const { status, body } = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef }),
    });

    expect(status).toBe(409);
    expectError(body, 'order_not_cancellable');
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('POST /markets/hyperliquid/cancel rejects live trading without a wallet id', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-no-wallet-cancel@example.com');
    const cancelOrder = vi.spyOn(hyperliquid, 'cancelOrder');

    const { status, body } = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef: 'hl_demo_test' }),
    });

    expect(status).toBe(503);
    expectError(body, 'trading_wallet_unavailable');
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('POST /markets/hyperliquid/cancel falls through to the venue for TP/SL legs with no local row', async () => {
    // Attached TP/SL legs get venue oids but never a local order row (audit A10).
    const cancelOrder = vi.spyOn(hyperliquid, 'cancelOrder').mockResolvedValueOnce({ ok: true, demo: true });

    const { status, body } = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', externalRef: '987654321' }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.position).toBeNull();
    expect(cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ coin: 'ETH', externalRef: '987654321' }));
  });

  it('POST /markets/hyperliquid/cancel still 404s for unknown refs that are not venue oids', async () => {
    const cancelOrder = vi.spyOn(hyperliquid, 'cancelOrder');

    const { status, body } = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', externalRef: 'hl_demo_notmine' }),
    });

    expect(status).toBe(404);
    expectError(body, 'not_found');
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it.skip('legacy: unverified users had a $1k position cap (Avici restructure dropped this gate)', () => {});

  it('POST /markets/hyperliquid/order is rejected by kill-switch → 423', async () => {
    // Flip the kill switch on the markets-tester user, then attempt an order.
    await json('/agent/kill-switch', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ on: true }),
    });
    try {
      const { status, body } = await json('/markets/hyperliquid/order', {
        method: 'POST',
        headers: { ...authed(), 'X-Region': 'NL' },
        body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 50, leverage: 1 }),
      });
      expect(status).toBe(423);
      expectError(body, 'account_frozen');
    } finally {
      // Restore for the rest of the suite.
      await json('/agent/kill-switch', {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ on: false }),
      });
    }
  });

  it('GET /markets/jupiter/detail rejects malformed mints before upstream fanout', async () => {
    const { status, body } = await json('/markets/jupiter/detail?mint=not-a-mint');

    expect(status).toBe(400);
    expectError(body, 'bad_request', 'invalid_mint');
  });
  it('GET /markets/jupiter/prices skips malformed ids instead of failing the batch', async () => {
    const prices = vi.spyOn(jupiter, 'prices');

    const { status, body } = await json('/markets/jupiter/prices?ids=not-a-mint,mint-trump');

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, prices: {} });
    expect(prices).not.toHaveBeenCalled();
  });

  it('GET /markets/jupiter/prices coalesces identical batch reads through the route cache', async () => {
    const prices = vi.spyOn(jupiter, 'prices').mockResolvedValue({
      [JUPITER_SOL_MINT]: { priceUsd: 123.45, confidence: 'high' },
    });

    const path = `/markets/jupiter/prices?ids=${JUPITER_SOL_MINT}`;
    const [first, second] = await Promise.all([json(path), json(path)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(prices).toHaveBeenCalledTimes(1);
    expect([first.body.cached, second.body.cached]).toContain(true);
  });

  it('POST /markets/jupiter/swap re-quotes live swaps instead of trusting client quote', async () => {
    forceJupiterLiveTrading();
    const headers = await freshAuthHeaders('jupiter-live-requote@example.com');
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    vi.spyOn(walletService, 'getOrCreateUserSolanaWallet').mockResolvedValueOnce({
      live: true,
      walletId: 'sol_wallet_requote',
      address: '11111111111111111111111111111111',
      signTx: vi.fn(async () => 'sig'),
    });
    const quote = vi.spyOn(jupiter, 'quote').mockResolvedValueOnce({
      ok: true,
      quote: { fresh: true },
      inputMint,
      outputMint,
      inAmount: '1000',
      outAmount: '2000',
      priceImpactPct: '0',
      routePlan: [],
    });
    const swap = vi.spyOn(jupiter, 'swap').mockResolvedValueOnce({
      ok: true,
      signature: 'jup_live_sig',
      confirmed: true,
      inputMint,
      outputMint,
      inAmount: '1000',
      outAmount: '2000',
      demo: false,
    });

    const { status, body } = await json('/markets/jupiter/swap', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL', 'Idempotency-Key': 'jup-live-requote-1' },
      body: JSON.stringify({
        inputMint,
        outputMint,
        amountAtomic: '1000',
        quote: { inputMint: outputMint, outputMint: inputMint, inAmount: '999999' },
      }),
    });

    expect(status).toBe(200);
    expect(body.order.signature).toBe('jup_live_sig');
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ inputMint, outputMint, amountAtomic: '1000' }));
    expect(swap).toHaveBeenCalledWith(expect.objectContaining({
      quote: { fresh: true },
      inAmount: '1000',
      outAmount: '2000',
    }));
  });

  it('POST /markets/jupiter/swap 451s from a blocked country, passes for an exempt email', async () => {
    forceJupiterLiveTrading();
    const headers = await freshAuthHeaders('region-exempt@example.com');
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

    const blocked = await json('/markets/jupiter/swap', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'DE', 'Idempotency-Key': 'region-exempt-de-0' },
      body: JSON.stringify({ inputMint, outputMint, amountAtomic: '1000' }),
    });
    expect(blocked.status).toBe(451);
    expectError(blocked.body, 'region_blocked');

    env.LIVE_WRITE_REGION_EXEMPT_EMAILS = ' ops@example.com, Region-Exempt@Example.com ';
    try {
      vi.spyOn(walletService, 'getOrCreateUserSolanaWallet').mockResolvedValueOnce({
        live: true,
        walletId: 'sol_wallet_exempt',
        address: '11111111111111111111111111111111',
        signTx: vi.fn(async () => 'sig'),
      });
      vi.spyOn(jupiter, 'quote').mockResolvedValueOnce({
        ok: true,
        quote: { fresh: true },
        inputMint,
        outputMint,
        inAmount: '1000',
        outAmount: '2000',
        priceImpactPct: '0',
        routePlan: [],
      });
      vi.spyOn(jupiter, 'swap').mockResolvedValueOnce({
        ok: true,
        signature: 'exempt_live_sig',
        confirmed: true,
        inputMint,
        outputMint,
        inAmount: '1000',
        outAmount: '2000',
        demo: false,
      });

      const { status, body } = await json('/markets/jupiter/swap', {
        method: 'POST',
        headers: { ...headers, 'X-Region': 'DE', 'Idempotency-Key': 'region-exempt-de-1' },
        body: JSON.stringify({ inputMint, outputMint, amountAtomic: '1000' }),
      });
      expect(status).toBe(200);
      expect(body.order.signature).toBe('exempt_live_sig');
    } finally {
      env.LIVE_WRITE_REGION_EXEMPT_EMAILS = undefined;
    }
  });

  it('POST /markets/jupiter/swap keeps unconfirmed live broadcasts submitted', async () => {
    forceJupiterLiveTrading();
    const headers = await freshAuthHeaders('jupiter-live-unconfirmed@example.com');
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    vi.spyOn(walletService, 'getOrCreateUserSolanaWallet').mockResolvedValue({
      live: true,
      walletId: 'sol_wallet_unconfirmed',
      address: '11111111111111111111111111111111',
      signTx: vi.fn(async () => 'sig'),
    });
    vi.spyOn(jupiter, 'quote').mockResolvedValue({
      ok: true,
      quote: { fresh: true },
      inputMint,
      outputMint,
      inAmount: '1000',
      outAmount: '2000',
      priceImpactPct: '0',
      routePlan: [],
    });
    const swap = vi.spyOn(jupiter, 'swap').mockResolvedValueOnce({
      ok: true,
      signature: 'jup_live_pending_sig',
      confirmed: false,
      inputMint,
      outputMint,
      inAmount: '1000',
      outAmount: '2000',
      demo: false,
    });
    const request = {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL', 'Idempotency-Key': 'jup-live-unconfirmed-1' },
      body: JSON.stringify({ inputMint, outputMint, amountAtomic: '1000' }),
    };

    const { status, body } = await json('/markets/jupiter/swap', request);

    expect(status).toBe(200);
    expect(body.order.confirmed).toBe(false);
    expect(body.position.status).toBe('submitted');
    expect(body.position.externalRef).toBe('jup_live_pending_sig');
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.status).toBe('submitted');
    expect(row?.lifecycleEvents?.at(-1)).toMatchObject({
      status: 'submitted',
      externalOrderId: 'jup_live_pending_sig',
    });

    const replay = await json('/markets/jupiter/swap', request);
    expect(replay.status).toBe(409);
    expect(replay.body.error?.message).toBe('order_in_progress');
    expect(swap).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/jupiter/swap records Backed xStock spot fills under stocks positions', async () => {
    const headers = await freshAuthHeaders('jupiter-xstock-spot-position@example.com');
    const inputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const outputMint = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
    vi.spyOn(jupiter, 'quote').mockResolvedValueOnce(null);
    vi.spyOn(jupiter, 'swap').mockResolvedValueOnce({
      ok: true,
      signature: 'jup_xstock_spot_demo',
      confirmed: false,
      inputMint,
      outputMint,
      inAmount: '25000000',
      outAmount: '1000000',
      demo: true,
    });

    const { status, body } = await json('/markets/jupiter/swap', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
      body: JSON.stringify({
        inputMint,
        outputMint,
        amountAtomic: '25000000',
        quote: { demo: true },
      }),
    });

    expect(status).toBe(200);
    expect(body.position.venue).toBe('xstocks');
    const stocksPositions = await json('/markets/stocks/positions', { headers });
    expect(stocksPositions.body.spot.some((p: { externalRef?: string }) => p.externalRef === 'jup_xstock_spot_demo')).toBe(true);
    const jupiterPositions = await json('/markets/jupiter/positions', { headers });
    expect(jupiterPositions.body.positions.some((p: { externalRef?: string }) => p.externalRef === 'jup_xstock_spot_demo')).toBe(false);
  });

  it('GET /markets/stocks/positions skips live HIP-3 by default', async () => {
    const headers = await freshAuthHeaders('stocks-db-only-position@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_stocks_db_only', '0x00000000000000000000000000000000000000aa', { force: true });
    const getPositions = vi.spyOn(hyperliquidHip3, 'getPositions');

    const { status, body } = await json('/markets/stocks/positions', { headers });

    expect(status).toBe(200);
    expect(getPositions).not.toHaveBeenCalled();
    expect(body.livePerps).toEqual([]);
  });

  it('GET /markets/stocks/positions includes live HIP-3 positions when requested', async () => {
    const headers = await freshAuthHeaders('stocks-live-hip3-position@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_stocks_live_hip3', '0x00000000000000000000000000000000000000aa', { force: true });
    const getPositions = vi.spyOn(hyperliquidHip3, 'getPositions').mockResolvedValueOnce([
      { coin: 'xyz:AAPL', sideLong: true, qtyUsd: 250, entryPriceUsd: 125 },
    ]);

    const { status, body } = await json('/markets/stocks/positions?includeLive=1', { headers });

    expect(status).toBe(200);
    expect(getPositions).toHaveBeenCalledWith('0x00000000000000000000000000000000000000aa');
    expect(body.livePerps).toEqual([
      { coin: 'xyz:AAPL', sideLong: true, qtyUsd: 250, entryPriceUsd: 125 },
    ]);
  });

  it('POST /markets/polymarket/order from any region succeeds (Avici restructure)', async () => {
    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'US' },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 62, qtyUsd: 50 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('POST /markets/polymarket/order in allowed region returns 200 and persists position', async () => {
    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 62, qtyUsd: 50 }),
    });
    expect(status).toBe(200);
    expect(body.position.venue).toBe('polymarket');
    expect(body.position.qtyUsd).toBe(50);
  });

  it('POST /markets/polymarket/order persists copiedFrom attribution and returns it on positions', async () => {
    const wallet = '0xCafeBabe00000000000000000000000000000001';
    const placed = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 62, qtyUsd: 25, copiedFrom: wallet }),
    });
    expect(placed.status).toBe(200);
    expect(placed.body.position.copiedFrom).toBe(wallet);
    const positions = await json('/markets/polymarket/positions', {
      headers: { ...authed(), 'X-Region': 'NL' },
    });
    const mine = (positions.body.positions as Array<{ id: string; copiedFrom?: string | null }>).find(
      (p) => p.id === placed.body.position.id,
    );
    expect(mine?.copiedFrom).toBe(wallet);
  });

  it('POST /markets/polymarket/order fails closed when live outcome token is unavailable', async () => {
    forcePolymarketLiveTrading();
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-no-token-test',
      question: 'Missing token test',
      outcomes: [
        { label: 'Yes', pricePct: 62 },
        { label: 'No', pricePct: 38 },
      ],
      closesAt: null,
    });
    const placeOrder = vi.spyOn(polymarket, 'placeOrder');

    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: {
        ...authed(),
        'X-Region': 'NL',
        'Idempotency-Key': 'pm-test-missing-token-1',
      },
      body: JSON.stringify({ marketId: 'pm-no-token-test', outcome: 'Yes', priceCents: 62, qtyUsd: 50 }),
    });

    expect(status).toBe(503);
    expect(body.error?.message).toBe('polymarket_token_unavailable');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('POST /markets/polymarket/order fails closed when live CLOB creds are unavailable', async () => {
    // Missing L2 CLOB credentials must stop before placeOrder so live mode
    // never records a synthetic demo order as a real position.
    forcePolymarketLiveTrading();
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-live-token-test',
      question: 'Live token test',
      outcomes: [
        { label: 'Yes', pricePct: 62, tokenId: '123456789' },
        { label: 'No', pricePct: 38, tokenId: '987654321' },
      ],
      closesAt: null,
    });
    const placeOrder = vi.spyOn(polymarket, 'placeOrder');
    expect(polymarket.isLiveTrading).toBe(true);

    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: {
        ...authed(),
        'X-Region': 'NL',
        'Idempotency-Key': 'pm-test-partial-clob-1',
      },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 62, qtyUsd: 50 }),
    });

    expect(status).toBe(503);
    expect(body.error?.message).toBe('polymarket_clob_credentials_unavailable');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('POST /markets/polymarket/order submits live when token, wallet, and CLOB creds exist', async () => {
    forcePolymarketLiveTrading();
    const headers = await freshAuthHeaders('pm-live-ok@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_pm_live_ok', '0x2222222222222222222222222222222222222222');
    await store.setPmClobCredentials(userId, {
      key: 'pm-key',
      secret: Buffer.from('a'.repeat(32)).toString('base64'),
      passphrase: 'pm-pass',
    });
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-election-event',
      question: 'Live token test',
      outcomes: [
        { label: 'Harris', pricePct: 52, tokenId: 'token-harris-yes' },
        { label: 'Newsom', pricePct: 21, tokenId: 'token-newsom-yes' },
      ],
      closesAt: null,
    });
    const placeOrder = vi.spyOn(polymarket, 'placeOrder').mockResolvedValueOnce({
      orderId: 'pm-live-order-1',
      filledQtyUsd: 25,
      priceCents: 52,
      demo: false,
    });

    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Region': 'NL',
        'Idempotency-Key': 'pm-live-ok-1',
      },
      body: JSON.stringify({ marketId: 'pm-election-event', outcome: 'Harris', priceCents: 52, qtyUsd: 25 }),
    });

    expect(status).toBe(200);
    expect(body.order.demo).toBe(false);
    expect(body.position.externalRef).toBe('pm-live-order-1');
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      marketId: 'pm-election-event',
      outcome: 'Harris',
      outcomeTokenId: 'token-harris-yes',
      clobCreds: expect.objectContaining({ key: 'pm-key', passphrase: 'pm-pass' }),
    }));
  });

  it('POST /markets/polymarket/order allows live numeric outcome before KYC approval', async () => {
    forcePolymarketLiveTrading();
    const headers = await freshAuthHeaders('pm-live-numeric-no-kyc@example.com');
    const userId = await userIdFor(headers);
    const user = await store.user(userId);
    await store.setKyc(user, 'pending');
    await store.setPrivyWallet(userId, 'wallet_pm_live_numeric_no_kyc', '0x2222222222222222222222222222222222222222');
    await store.setPmClobCredentials(userId, {
      key: 'pm-key-numeric',
      secret: Buffer.from('b'.repeat(32)).toString('base64'),
      passphrase: 'pm-pass-numeric',
    });
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-numeric-event',
      question: 'Live numeric token test',
      outcomes: [
        { label: 'Harris', pricePct: 52, tokenId: 'token-harris-yes' },
        { label: 'Newsom', pricePct: 21, tokenId: 'token-newsom-yes' },
      ],
      closesAt: null,
    });
    const placeOrder = vi.spyOn(polymarket, 'placeOrder').mockResolvedValueOnce({
      orderId: 'pm-live-numeric-no-kyc',
      filledQtyUsd: 25,
      priceCents: 21,
      demo: false,
    });

    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Region': 'NL',
        'Idempotency-Key': 'pm-live-numeric-no-kyc-1',
      },
      body: JSON.stringify({ marketId: 'pm-numeric-event', outcome: '1', priceCents: 21, qtyUsd: 25 }),
    });

    expect(status).toBe(200);
    expect(body.position.externalRef).toBe('pm-live-numeric-no-kyc');
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      outcome: '1',
      outcomeTokenId: 'token-newsom-yes',
    }));
  });

  it('POST /markets/polymarket/order records live CLOB resting orders as resting, not filled', async () => {
    forcePolymarketLiveTrading();
    const headers = await freshAuthHeaders('pm-live-resting@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_pm_live_resting', '0x2222222222222222222222222222222222222222');
    await store.setPmClobCredentials(userId, {
      key: 'pm-key',
      secret: Buffer.from('a'.repeat(32)).toString('base64'),
      passphrase: 'pm-pass',
    });
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-resting-event',
      question: 'Live resting test',
      outcomes: [
        { label: 'Yes', pricePct: 62, tokenId: 'token-yes' },
        { label: 'No', pricePct: 38, tokenId: 'token-no' },
      ],
      closesAt: null,
    });
    const placeOrder = vi.spyOn(polymarket, 'placeOrder').mockResolvedValueOnce({
      orderId: 'pm-live-resting-1',
      filledQtyUsd: 0,
      priceCents: 62,
      demo: false,
      state: 'resting',
    });

    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Region': 'NL',
        'Idempotency-Key': 'pm-live-resting-1',
      },
      body: JSON.stringify({ marketId: 'pm-resting-event', outcome: 'Yes', priceCents: 62, qtyUsd: 25 }),
    });

    expect(status).toBe(200);
    expect(body.position.status).toBe('resting');
    expect(body.position.qtyUsd).toBe(25);
    expect(body.position.filledQtyUsd ?? 0).toBe(0);
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual(['reserved', 'submitted', 'resting']);

    const replay = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Region': 'NL',
        'Idempotency-Key': 'pm-live-resting-1',
      },
      body: JSON.stringify({ marketId: 'pm-resting-event', outcome: 'Yes', priceCents: 62, qtyUsd: 25 }),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.order.replay).toBe(true);
    expect(replay.body.order.state).toBe('resting');
    expect(replay.body.order.filledQtyUsd).toBe(0);
    expect(replay.body.position.status).toBe('resting');
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('POST /markets/polymarket/order returns ApiError shape for invalid price', async () => {
    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 100, qtyUsd: 50 }),
    });

    expect(status).toBe(400);
    expectError(body, 'bad_request', 'invalid_price');
  });
});

/* ── Sprint 1 lifecycle — HL route lifecycle integration ─────────────────── */

describe('hyperliquid order lifecycle (Sprint 1)', () => {
  it('demo place order writes a single `filled` lifecycle event to the row', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 50, leverage: 1 }),
    });
    expect(placed.status).toBe(200);

    const row = await store.getMarketPositionById(placed.body.position.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('filled');
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual(['filled']);
    expect(row?.lifecycleEvents?.[0]?.externalOrderId).toMatch(/^hl_/);
    expect(row?.filledAt).toBeTruthy();
  });

  it('publisher fires a `filled` envelope to subscribers on a demo place order', async () => {
    const { lifecyclePublisher } = await import('../lib/lifecycle/publisher.js');
    const events: Array<{ status: string; orderId: string; demo: boolean }> = [];
    const off = lifecyclePublisher.onLifecycle((env) => {
      events.push({ status: env.status, orderId: env.orderId, demo: env.demo });
    });
    try {
      const { status, body } = await json('/markets/hyperliquid/order', {
        method: 'POST',
        headers: { ...authed(), 'X-Region': 'NL' },
        body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 25, leverage: 1 }),
      });
      expect(status).toBe(200);
      const placedId = body.position.id as string;
      const ours = events.filter((e) => e.orderId === placedId);
      expect(ours.length).toBeGreaterThanOrEqual(1);
      expect(ours[ours.length - 1]?.status).toBe('filled');
      expect(ours[ours.length - 1]?.demo).toBe(true);
    } finally {
      off();
    }
  });

  it('cancel transitions through `cancel_requested` → `canceled` in the audit trail', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', sideLong: true, qtyUsd: 25, leverage: 1, kind: 'limit', limitPriceUsd: 2500 }),
    });
    expect(placed.status).toBe(200);
    const ref = placed.body.position.externalRef as string;
    const id = placed.body.position.id as string;

    const cancel = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef: ref }),
    });
    expect(cancel.status).toBe(200);

    const row = await store.getMarketPositionById(id);
    expect(row?.status).toBe('canceled');
    const trail = (row?.lifecycleEvents ?? []).map((e) => e.status);
    expect(trail).toEqual(['resting', 'cancel_requested', 'canceled']);
    expect(row?.canceledAt).toBeTruthy();
  });

  it('rejects cancel for already filled orders', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', sideLong: true, qtyUsd: 25, leverage: 1 }),
    });
    expect(placed.status).toBe(200);
    expect(placed.body.position.status).toBe('filled');

    const cancel = await json('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef: placed.body.position.externalRef }),
    });
    expect(cancel.status).toBe(409);
    expectError(cancel.body, 'order_not_cancellable');

    const row = await store.getMarketPositionById(placed.body.position.id as string);
    expect(row?.status).toBe('filled');
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual(['filled']);
  });
});

/* ── Sprint 2 — shared cross-venue order/position/fill surface ──────────── */

describe('markets shared cross-venue surface (Sprint 2)', () => {
  it('GET /markets/orders returns the user’s order history with the order envelope shape', async () => {
    // Place 1 HL + 1 Polymarket order to populate the user's history.
    await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 12, leverage: 1 }),
    });
    await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 50, qtyUsd: 7 }),
    });

    const { status, body } = await json('/markets/orders?limit=50', { headers: authed() });
    expect(status).toBe(200);
    expect(Array.isArray(body.orders)).toBe(true);
    // Each envelope carries lifecycle fields (status / createdAt / updatedAt etc).
    const sample = body.orders[0];
    expect(sample).toEqual(expect.objectContaining({
      id: expect.any(String),
      venue: expect.any(String),
      symbol: expect.any(String),
      status: expect.any(String),
      createdAt: expect.any(String),
    }));
  });

  it('GET /markets/orders?venue=hyperliquid filters to a single venue', async () => {
    const { status, body } = await json('/markets/orders?venue=hyperliquid&limit=5', { headers: authed() });
    expect(status).toBe(200);
    expect(body.orders.every((o: { venue: string }) => o.venue === 'hyperliquid')).toBe(true);
  });

  it('GET /markets/orders falls back to the default limit for non-numeric input', async () => {
    const list = vi.spyOn(store, 'listMarketOrders');
    const { status } = await json('/markets/orders?limit=NaN', { headers: authed() });

    expect(status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 100 }));
  });

  it('GET /markets/orders/:id returns the lifecycle audit trail', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'ETH', sideLong: false, qtyUsd: 8, leverage: 1 }),
    });
    const id = placed.body.position.id as string;
    const { status, body } = await json(`/markets/orders/${id}`, { headers: authed() });
    expect(status).toBe(200);
    expect(body.order.id).toBe(id);
    expect(Array.isArray(body.order.lifecycleEvents)).toBe(true);
    expect(body.order.lifecycleEvents.length).toBeGreaterThanOrEqual(1);
    expect(body.order.lifecycleEvents[body.order.lifecycleEvents.length - 1].status).toBe('filled');
  });

  it('GET /markets/orders/:id from a different user returns 404 (ownership)', async () => {
    // Foreign user places an order; current authed() user must not see it.
    const otherHeaders = await freshAuthHeaders('s2-foreign-user@example.com');
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...otherHeaders, 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'SOL', sideLong: true, qtyUsd: 5, leverage: 1 }),
    });
    const foreignId = placed.body.position.id as string;
    const { status, body } = await json(`/markets/orders/${foreignId}`, { headers: authed() });
    expect(status).toBe(404);
    expectError(body, 'not_found');
  });

  it('GET /markets/positions returns current holdings rollup with the order envelope shape', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 6, leverage: 1 }),
    });
    const { status, body } = await json('/markets/positions', { headers: authed() });
    expect(status).toBe(200);
    expect(Array.isArray(body.positions)).toBe(true);
    const row = body.positions.find((p: { id: string }) => p.id === placed.body.position.id);
    expect(row).toEqual(expect.objectContaining({
      externalRef: placed.body.position.externalRef,
      externalOrderId: placed.body.position.externalRef,
    }));
  });

  it('GET /markets/fills returns an array (HL fills in live mode, empty otherwise)', async () => {
    const { status, body } = await json('/markets/fills?limit=10', { headers: authed() });
    expect(status).toBe(200);
    expect(Array.isArray(body.fills)).toBe(true);
  });

  it('GET /markets/hyperliquid/user-fills falls back to safe defaults for non-numeric input', async () => {
    const getUserFills = vi.spyOn(hyperliquid, 'getUserFills').mockResolvedValueOnce([]);
    const { status } = await json('/markets/hyperliquid/user-fills?limit=NaN&sinceMs=wat', {
      headers: authed(),
    });

    expect(status).toBe(200);
    expect(getUserFills).toHaveBeenCalledWith(expect.anything(), { limit: 200, sinceMs: 0 });
  });

  it('POST /markets/orders/:id/cancel dispatches to the venue, records canceled, returns updated envelope', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 6, leverage: 1, kind: 'limit', limitPriceUsd: 95000 }),
    });
    const id = placed.body.position.id as string;
    const { status, body } = await json(`/markets/orders/${id}/cancel`, {
      method: 'POST',
      headers: authed(),
    });
    expect(status).toBe(200);
    expect(body.position.id).toBe(id);
    expect(body.position.status).toBe('canceled');

    const row = await store.getMarketPositionById(id);
    const trail = (row?.lifecycleEvents ?? []).map((e) => e.status);
    expect(trail).toEqual(expect.arrayContaining(['resting', 'cancel_requested', 'canceled']));
  });

  it('POST /markets/orders/:id/cancel returns 409 for already filled orders', async () => {
    const placed = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 6, leverage: 1 }),
    });
    const id = placed.body.position.id as string;
    const { status, body } = await json(`/markets/orders/${id}/cancel`, {
      method: 'POST',
      headers: authed(),
    });
    expect(status).toBe(409);
    expectError(body, 'order_not_cancellable');
  });

  it('POST /markets/orders/:id/cancel rejects live cancels without a wallet before local close', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('markets-live-cancel-no-wallet@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, '', '', { force: true });
    const user = await store.user(userId);
    const row = await store.placeMarketOrder(user, {
      venue: 'hyperliquid',
      symbol: 'BTC',
      sideLong: true,
      qtyUsd: 6,
      entryPriceUsd: 95_000,
      externalRef: 'hl_123',
    });
    const cancelOrder = vi.spyOn(hyperliquid, 'cancelOrder');

    const { status, body } = await json(`/markets/orders/${row.id}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
    });

    expect(status).toBe(503);
    expectError(body, 'trading_wallet_unavailable');
    expect(cancelOrder).not.toHaveBeenCalled();
    const after = await store.getMarketPositionById(row.id);
    expect(after?.status).toBe('open');
    expect((after?.lifecycleEvents ?? []).map((e) => e.status)).not.toContain('canceled');
  });

  it('POST /markets/orders/:id/cancel dispatches live Polymarket resting orders', async () => {
    forcePolymarketLiveTrading();
    const headers = await freshAuthHeaders('pm-live-cancel-resting@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_pm_live_cancel', '0x2222222222222222222222222222222222222222');
    await store.setPmClobCredentials(userId, {
      key: 'pm-cancel-key',
      secret: Buffer.from('a'.repeat(32)).toString('base64'),
      passphrase: 'pm-cancel-pass',
    });
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-live-cancel-event',
      question: 'Live cancel test',
      outcomes: [
        { label: 'Yes', pricePct: 60, tokenId: 'token-yes-cancel' },
        { label: 'No', pricePct: 40, tokenId: 'token-no-cancel' },
      ],
      closesAt: null,
    });
    vi.spyOn(polymarket, 'placeOrder').mockResolvedValueOnce({
      orderId: 'pm-live-cancel-1',
      filledQtyUsd: 0,
      priceCents: 60,
      demo: false,
      state: 'resting',
    });
    const cancelOrder = vi.spyOn(polymarket, 'cancelOrder').mockResolvedValueOnce({ ok: true, demo: false });

    const placed = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL', 'Idempotency-Key': 'pm-live-cancel-resting-1' },
      body: JSON.stringify({ marketId: 'pm-live-cancel-event', outcome: 'Yes', priceCents: 60, qtyUsd: 9 }),
    });
    expect(placed.status).toBe(200);
    expect(placed.body.position.status).toBe('resting');
    const id = placed.body.position.id as string;
    const { status, body } = await json(`/markets/orders/${id}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL' },
    });
    expect(status).toBe(200);
    expect(body.position.status).toBe('canceled');
    expect(cancelOrder).toHaveBeenCalledWith(expect.objectContaining({
      privyWalletId: 'wallet_pm_live_cancel',
      privyWalletAddress: '0x2222222222222222222222222222222222222222',
      externalRef: 'pm-live-cancel-1',
      clobCreds: expect.objectContaining({ key: 'pm-cancel-key', passphrase: 'pm-cancel-pass' }),
    }));
    const after = await store.getMarketPositionById(id);
    expect(after?.status).toBe('canceled');
    expect(after?.lifecycleEvents?.map((e) => e.status)).toContain('cancel_requested');
    expect(after?.lifecycleEvents?.map((e) => e.status)).toContain('canceled');
  });
});

/* ── Sprint 16.4 — builder fee approval surface ──────────────────────────── */

describe('hyperliquid builder approval (Sprint 16.4)', () => {
  it('GET /markets/hyperliquid/builder-status reports backend-managed agreement for a fresh user', async () => {
    const originalTenths = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP;
    const headers = await freshAuthHeaders('builder-status-fresh@example.com');
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 25;
    env.HL_BUILDER_ADDRESS = '0x0000000000000000000000000000000000000001';
    try {
      const { status, body } = await json('/markets/hyperliquid/builder-status', {
        headers,
      });
      expect(status).toBe(200);
      expect(body.builder.currentFeeTenthsBp).toBe(25);
      expect(body.builder.currentFeeBps).toBeCloseTo(2.5);
      expect(body.builder.currentFeeRate).toBe('0.025%');
      expect(body.builder.capBps).toBe(10);
      expect(body.user.approved).toBe(false);
      expect(body.needsApproval).toBe(false);
    } finally {
      env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = originalTenths;
    }
  });

  it('GET /markets/hyperliquid/builder-status does not require approval when builder fee is zero', async () => {
    const originalTenths = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP;
    const originalBuilder = env.HL_BUILDER_ADDRESS;
    const headers = await freshAuthHeaders('builder-status-zero-fee@example.com');
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 0;
    env.HL_BUILDER_ADDRESS = undefined;
    try {
      const { status, body } = await json('/markets/hyperliquid/builder-status', {
        headers,
      });
      expect(status).toBe(200);
      expect(body.builder.currentFeeTenthsBp).toBe(0);
      expect(body.needsApproval).toBe(false);
    } finally {
      env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = originalTenths;
      env.HL_BUILDER_ADDRESS = originalBuilder;
    }
  });

  it('POST /markets/hyperliquid/approve-builder signs fee caps as percent, not bps', async () => {
    forceHyperliquidLiveTrading();
    const headers = await freshAuthHeaders('builder-approve-percent@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(
      userId,
      'wallet_builder_percent',
      '0x00000000000000000000000000000000000000cc',
      { force: true },
    );
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 25;

    const realFetch = globalThis.fetch;
    const exchangeCalls: Array<{ action?: { maxFeeRate?: string } }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(base)) return realFetch(input, init);
      exchangeCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { status, body } = await json('/markets/hyperliquid/approve-builder', {
      method: 'POST',
      headers,
      body: JSON.stringify({ maxFeeBps: 10 }),
    });

    expect(status).toBe(200);
    expect(hlSignUserSignedAction).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ maxFeeRate: '0.1%' }),
    }));
    expect(exchangeCalls[0]?.action?.maxFeeRate).toBe('0.1%');
    expect(body.builder.maxFeeRate).toBe('0.1%');
    expect(body.builder.maxFeeTenthsBp).toBe(100);
  });

  it('POST /markets/hyperliquid/approve-builder returns 503 when no builder address', async () => {
    const original = env.HL_BUILDER_ADDRESS;
    env.HL_BUILDER_ADDRESS = undefined;
    try {
      const { status, body } = await json('/markets/hyperliquid/approve-builder', {
        method: 'POST',
        headers: { ...authed() },
        body: JSON.stringify({}),
      });
      expect(status).toBe(503);
      expectError(body, 'builder_address_unset');
    } finally {
      env.HL_BUILDER_ADDRESS = original;
    }
  });

  it('POST /markets/hyperliquid/approve-builder returns 503 when Privy disabled', async () => {
    env.HL_BUILDER_ADDRESS = '0x0000000000000000000000000000000000000001';
    features.privy = false;
    const { status, body } = await json('/markets/hyperliquid/approve-builder', {
      method: 'POST',
      headers: { ...authed() },
      body: JSON.stringify({}),
    });
    expect(status).toBe(503);
    expectError(body, 'privy_disabled');
  });

  it('order auto-signs the backend builder agreement when fee>0 and user not approved', async () => {
    forceHyperliquidLiveTrading();
    const originalTenths = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP;
    const headers = await freshAuthHeaders('builder-required-fresh@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_builder_required', '0x00000000000000000000000000000000000000bb', { force: true });
    env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = 25;
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_builder_auto_agreement',
      filledQtyUsd: 100,
      entryPriceUsd: 65000,
      demo: false,
    });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(base)) return realFetch(input, init);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const { status, body } = await json('/markets/hyperliquid/order', {
        method: 'POST',
        headers: { ...headers, 'X-Region': 'NL', 'X-Idempotency-Key': 'hl-builder-auto-agreement' },
        body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 100, leverage: 1 }),
      });
      expect(status).toBe(200);
      expect(body.order.orderId).toBe('hl_builder_auto_agreement');
      expect(placeOrder).toHaveBeenCalledTimes(1);
      expect(hlSignUserSignedAction).toHaveBeenCalledWith(expect.objectContaining({
        action: expect.objectContaining({ type: 'approveBuilderFee', maxFeeRate: '0.025%' }),
      }));
      const user = await store.user(userId);
      expect(user.hlBuilderApprovedAt).toBeTruthy();
      expect(user.hlBuilderMaxFeeTenthsBp).toBe(25);
    } finally {
      env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP = originalTenths;
    }
  });
});

/**
 * F093 Sprint 18 — Router V2 shadow tests.
 *
 * With `MARKETS_ROUTER_V2=1` the existing /markets/hyperliquid/order handler
 * delegates to `handleAdapterPlaceOrder(hyperliquidAdapter)`. Response shape
 * must stay byte-identical to the legacy v1 path so the SDK + frontend
 * consumer types remain untouched.
 */
describe('markets router v2 (F093, MARKETS_ROUTER_V2=1)', () => {
  const originalFlag = env.MARKETS_ROUTER_V2;
  beforeAll(() => {
    env.MARKETS_ROUTER_V2 = true;
  });
  afterAll(() => {
    env.MARKETS_ROUTER_V2 = originalFlag;
  });

  it('routes HL perps order through the parameterised handler with identical response shape', async () => {
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_v2_demo_route',
      filledQtyUsd: 50,
      entryPriceUsd: 65000,
      demo: true,
    });
    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 50, leverage: 1 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // Legacy shape preserved: `order` is the venue raw payload + `position` is the
    // local record. Test against the same fields as the v1 spec above.
    expect(body.order.orderId).toBe('hl_v2_demo_route');
    expect(body.order.filledQtyUsd).toBe(50);
    expect(body.order.entryPriceUsd).toBe(65000);
    expect(body.position.venue).toBe('hyperliquid');
    expect(body.position.qtyUsd).toBe(50);
    expect(body.position.externalRef).toBe('hl_v2_demo_route');
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ coin: 'BTC', sideLong: true, qtyUsd: 50 }),
    );
  });

  it('routes HL TWAP orders through the parameterised handler', async () => {
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_v2_twap_route',
      filledQtyUsd: 0,
      entryPriceUsd: 65000,
      demo: true,
      state: 'twap_active',
    });
    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'BTC',
        sideLong: true,
        qtyUsd: 50,
        leverage: 1,
        kind: 'twap',
        durationMinutes: 10,
        randomize: true,
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.order.orderId).toBe('hl_v2_twap_route');
    expect(body.position.status).toBe('accepted');
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'twap',
      durationMinutes: 10,
      randomize: true,
    }));
  });

  it('rejects invalid body with 400 invalid_coin before calling the venue', async () => {
    const placeOrder = vi.spyOn(hyperliquid, 'placeOrder');
    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: '', sideLong: true, qtyUsd: 50 }),
    });
    expect(status).toBe(400);
    // ApiError envelope: { code: 'bad_request', message: '<reason>' } — matches
    // the legacy v1 path's error shape exactly.
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('invalid_coin');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('forwards reduceOnly through to the adapter (v2 — close semantics)', async () => {
    vi.spyOn(hyperliquid, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hl_demo_v2_reduce',
      filledQtyUsd: 50,
      entryPriceUsd: 64210.5,
      demo: true,
    });
    const { status, body } = await json('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'BTC', sideLong: false, qtyUsd: 50, reduceOnly: true }),
    });
    expect(status).toBe(200);
    expect(body.order.orderId).toBe('hl_demo_v2_reduce');
  });

  /* ── HL Spot v2 ───────────────────────────────────────────────────────── */

  it('HL spot: routes order through the adapter with identical response shape', async () => {
    const placeOrder = vi
      .spyOn(hyperliquidSpot, 'placeOrder')
      .mockResolvedValueOnce({
        orderId: 'hls_v2_demo_route',
        filledQtyUsd: 40,
        entryPriceUsd: 0.0975,
        demo: true,
      });
    const { status, body } = await json('/markets/hyperliquid-spot/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'PURR/USDC', sideLong: true, qtyUsd: 40 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.order.orderId).toBe('hls_v2_demo_route');
    expect(body.position.venue).toBe('hyperliquid-spot');
    expect(body.position.symbol).toBe('PURR/USDC');
    expect(body.position.externalRef).toBe('hls_v2_demo_route');
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ coin: 'PURR/USDC', sideLong: true, qtyUsd: 40 }),
    );
  });

  it('HL spot: rejects empty coin with 400 invalid_coin before calling the venue', async () => {
    const placeOrder = vi.spyOn(hyperliquidSpot, 'placeOrder');
    const { status, body } = await json('/markets/hyperliquid-spot/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: '', sideLong: true, qtyUsd: 40 }),
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('invalid_coin');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('HL spot: forwards reduceOnly through to the adapter', async () => {
    vi.spyOn(hyperliquidSpot, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hls_v2_reduce',
      filledQtyUsd: 40,
      entryPriceUsd: 0.0975,
      demo: true,
    });
    const { status, body } = await json('/markets/hyperliquid-spot/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'PURR/USDC', sideLong: false, qtyUsd: 40, reduceOnly: true }),
    });
    expect(status).toBe(200);
    expect(body.order.orderId).toBe('hls_v2_reduce');
  });

  it('HL spot: preserves resting state from the adapter', async () => {
    vi.spyOn(hyperliquidSpot, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hls_v2_resting_gtc',
      filledQtyUsd: 0,
      entryPriceUsd: 0.09,
      demo: true,
      state: 'resting',
    });
    const { status, body } = await json('/markets/hyperliquid-spot/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'PURR/USDC',
        sideLong: true,
        qtyUsd: 40,
        orderType: 'limit',
        limitPriceUsd: 0.09,
        tif: 'Gtc',
      }),
    });
    expect(status).toBe(200);
    expect(body.order.state).toBe('resting');
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.status).toBe('resting');
    expect(row?.qtyUsd).toBe(40);
    expect(row?.filledQtyUsd ?? 0).toBe(0);
  });

  it('HL spot: legacy cancel records the canonical lifecycle trail', async () => {
    vi.spyOn(hyperliquidSpot, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hls_legacy_cancel_resting',
      filledQtyUsd: 0,
      entryPriceUsd: 0.09,
      demo: true,
      state: 'resting',
    });
    const placed = await json('/markets/hyperliquid-spot/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'PURR/USDC',
        sideLong: true,
        qtyUsd: 40,
        orderType: 'limit',
        limitPriceUsd: 0.09,
        tif: 'Gtc',
      }),
    });
    const id = placed.body.position.id as string;
    const ref = placed.body.position.externalRef as string;

    const canceled = await json('/markets/hyperliquid-spot/cancel', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef: ref, coin: 'PURR/USDC' }),
    });

    expect(canceled.status).toBe(200);
    expect(canceled.body.position.status).toBe('canceled');
    const row = await store.getMarketPositionById(id);
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual([
      'resting',
      'cancel_requested',
      'canceled',
    ]);
  });

  /* ── HL HIP-3 (stocks) v2 ─────────────────────────────────────────────── */

  it('HL spot: records reservation lifecycle before live venue submit', async () => {
    features.privy = true;
    const headers = await freshAuthHeaders('hl-spot-live-lifecycle@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_hls_lifecycle', '0x00000000000000000000000000000000000000aa', { force: true });
    vi.spyOn(hyperliquidSpot, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hls_live_lifecycle',
      filledQtyUsd: 40,
      entryPriceUsd: 0.0975,
      demo: false,
    });

    const { status, body } = await json('/markets/hyperliquid-spot/order', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL', 'Idempotency-Key': 'hls-live-lifecycle-1' },
      body: JSON.stringify({ coin: 'PURR/USDC', sideLong: true, qtyUsd: 40 }),
    });

    expect(status).toBe(200);
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual(['reserved', 'submitted', 'filled']);
  });

  it('HIP-3: routes order through adapter and prefixes coin with the HIP-3 dex name', async () => {
    const placeOrder = vi
      .spyOn(hyperliquidHip3, 'placeOrder')
      .mockResolvedValueOnce({
        orderId: 'hip3_v2_demo_route',
        filledQtyUsd: 75,
        entryPriceUsd: 215.5,
        demo: true,
      });
    const { status, body } = await json('/markets/stocks/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'AAPL', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.order.orderId).toBe('hip3_v2_demo_route');
    expect(body.position.venue).toBe('hyperliquid-hip3');
    expect(placeOrder).toHaveBeenCalledWith(
      // The adapter attached the canonical HIP-3 dex prefix to bare "AAPL".
      expect.objectContaining({ coin: expect.stringMatching(/:AAPL$/), qtyUsd: 75 }),
    );
  });

  it('HIP-3: rejects empty coin with 400 invalid_coin before calling the venue', async () => {
    const placeOrder = vi.spyOn(hyperliquidHip3, 'placeOrder');
    const { status, body } = await json('/markets/stocks/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: '', sideLong: true, qtyUsd: 75, leverage: 1 }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toBe('invalid_coin');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('HIP-3: forwards reduceOnly through to the adapter', async () => {
    const placeOrder = vi.spyOn(hyperliquidHip3, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hip3_v2_reduce',
      filledQtyUsd: 75,
      entryPriceUsd: 215.5,
      demo: true,
    });
    const { status, body } = await json('/markets/stocks/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ coin: 'AAPL', sideLong: false, qtyUsd: 75, leverage: 1, reduceOnly: true }),
    });
    expect(status).toBe(200);
    expect(body.order.orderId).toBe('hip3_v2_reduce');
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ reduceOnly: true }));
  });

  it('HIP-3: preserves resting state from the adapter', async () => {
    vi.spyOn(hyperliquidHip3, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hip3_v2_resting_gtc',
      filledQtyUsd: 0,
      entryPriceUsd: 101,
      demo: true,
      state: 'resting',
    });
    const { status, body } = await json('/markets/stocks/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'AAPL',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        orderType: 'limit',
        limitPriceUsd: 101,
        tif: 'Gtc',
      }),
    });
    expect(status).toBe(200);
    expect(body.order.state).toBe('resting');
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.status).toBe('resting');
  });

  it('HIP-3: legacy stocks cancel records the canonical lifecycle trail', async () => {
    vi.spyOn(hyperliquidHip3, 'placeOrder').mockResolvedValueOnce({
      orderId: 'hip3_legacy_cancel_resting',
      filledQtyUsd: 0,
      entryPriceUsd: 101,
      demo: true,
      state: 'resting',
    });
    const placed = await json('/markets/stocks/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        coin: 'AAPL',
        sideLong: true,
        qtyUsd: 75,
        leverage: 1,
        orderType: 'limit',
        limitPriceUsd: 101,
        tif: 'Gtc',
      }),
    });
    const id = placed.body.position.id as string;
    const ref = placed.body.position.externalRef as string;

    const canceled = await json('/markets/stocks/cancel', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ externalRef: ref, coin: 'AAPL' }),
    });

    expect(canceled.status).toBe(200);
    expect(canceled.body.position.status).toBe('canceled');
    const row = await store.getMarketPositionById(id);
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual([
      'resting',
      'cancel_requested',
      'canceled',
    ]);
  });

  it('Polymarket: preserves lifecycle trail for resting orders', async () => {
    forcePolymarketLiveTrading();
    const headers = await freshAuthHeaders('pm-v2-resting-lifecycle@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_pm_v2_resting_lifecycle', '0x2222222222222222222222222222222222222222');
    await store.setPmClobCredentials(userId, {
      key: 'pm-key',
      secret: Buffer.from('a'.repeat(32)).toString('base64'),
      passphrase: 'pm-pass',
    });
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-v2-resting',
      question: 'Router v2 resting test',
      category: 'Crypto',
      endDate: '2026-12-31',
      liquidity: 1000,
      volume24h: 500,
      yesPrice: 0.62,
      noPrice: 0.38,
      outcomes: [{ label: 'Yes', price: 0.62, tokenId: 'token-yes-v2-resting' }],
    });
    vi.spyOn(polymarket, 'placeOrder').mockResolvedValueOnce({
      orderId: 'pm-v2-resting-1',
      filledQtyUsd: 0,
      priceCents: 62,
      demo: false,
      state: 'resting',
    });

    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL', 'Idempotency-Key': 'pm-v2-resting-lifecycle-1' },
      body: JSON.stringify({ marketId: 'pm-v2-resting', outcome: 'Yes', priceCents: 62, qtyUsd: 25 }),
    });

    expect(status).toBe(200);
    expect(body.order.state).toBe('resting');
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.status).toBe('resting');
    expect(row?.symbol).toBe('pm-v2-resting:Yes');
    expect(row?.sideLong).toBe(true);
    expect(row?.entryPriceUsd).toBeCloseTo(0.62);
    expect(row?.lifecycleEvents?.map((e) => e.status)).toEqual(['reserved', 'submitted', 'resting']);
  });

  /* ── Jupiter v2 ───────────────────────────────────────────────────────── */

  it('Jupiter: routes swap through the adapter with identical response shape', async () => {
    // In demo (non-live) mode the adapter calls jupiter.quote and falls back
    // to the body-supplied quote when the live read returns null. We stub
    // both so the adapter happily produces a demo signature.
    vi.spyOn(jupiter, 'quote').mockResolvedValueOnce(null);
    const swap = vi.spyOn(jupiter, 'swap').mockResolvedValueOnce({
      ok: true,
      signature: 'jup_v2_demo_route',
      confirmed: false,
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmount: '100000',
      outAmount: '5000000',
      demo: true,
    });
    const { status, body } = await json('/markets/jupiter/swap', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outputMint: 'So11111111111111111111111111111111111111112',
        amountAtomic: '100000',
        quote: { fakeQuote: true },
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.order.signature).toBe('jup_v2_demo_route');
    expect(body.order.demo).toBe(true);
    expect(body.position.venue).toBe('jupiter');
    expect(body.position.externalRef).toBe('jup_v2_demo_route');
    expect(swap).toHaveBeenCalled();
  });

  it('Jupiter: live v2 swaps use the Solana wallet path without requiring an EVM trading wallet', async () => {
    forceJupiterLiveTrading();
    const headers = await freshAuthHeaders('jupiter-v2-solana-wallet-only@example.com');
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const solWallet = vi.spyOn(walletService, 'getOrCreateUserSolanaWallet').mockResolvedValueOnce({
      live: true,
      walletId: 'sol_wallet_v2_only',
      address: '11111111111111111111111111111111',
      signTx: vi.fn(async () => 'sig'),
    });
    vi.spyOn(jupiter, 'quote').mockResolvedValueOnce({
      ok: true,
      quote: { fresh: true },
      inputMint,
      outputMint,
      inAmount: '1000',
      outAmount: '2000',
      priceImpactPct: '0',
      routePlan: [],
    });
    vi.spyOn(jupiter, 'swap').mockResolvedValueOnce({
      ok: true,
      signature: 'jup_v2_live_sol_only',
      confirmed: true,
      inputMint,
      outputMint,
      inAmount: '1000',
      outAmount: '2000',
      demo: false,
    });

    const { status, body } = await json('/markets/jupiter/swap', {
      method: 'POST',
      headers: { ...headers, 'X-Region': 'NL', 'Idempotency-Key': 'jup-v2-solana-wallet-only' },
      body: JSON.stringify({
        inputMint,
        outputMint,
        amountAtomic: '1000',
      }),
    });

    expect(status).toBe(200);
    expect(body.order.signature).toBe('jup_v2_live_sol_only');
    expect(solWallet).toHaveBeenCalled();
  });

  it('Jupiter: rejects invalid amount with 400 invalid_amount before calling the venue', async () => {
    const swap = vi.spyOn(jupiter, 'swap');
    const { status, body } = await json('/markets/jupiter/swap', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outputMint: 'So11111111111111111111111111111111111111112',
        amountAtomic: '0',
      }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toBe('invalid_amount');
    expect(swap).not.toHaveBeenCalled();
  });

  it('Jupiter: fails with 422 quote_unavailable when live quote returns null and no body quote', async () => {
    vi.spyOn(jupiter, 'quote').mockResolvedValueOnce(null);
    const swap = vi.spyOn(jupiter, 'swap');
    const { status, body } = await json('/markets/jupiter/swap', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outputMint: 'So11111111111111111111111111111111111111112',
        amountAtomic: '100000',
        // No quote supplied — adapter has nothing to fall back to.
      }),
    });
    expect(status).toBe(422);
    expect(body.error.message).toBe('quote_unavailable');
    expect(swap).not.toHaveBeenCalled();
  });

  /* ── Polymarket v2 ────────────────────────────────────────────────────── */

  it('Polymarket: routes order through the adapter with identical response shape', async () => {
    const placeOrder = vi
      .spyOn(polymarket, 'placeOrder')
      .mockResolvedValueOnce({
        orderId: 'pm_v2_demo_route',
        filledQtyUsd: 50,
        priceCents: 62,
        demo: true,
      });
    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 62, qtyUsd: 50 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.order.orderId).toBe('pm_v2_demo_route');
    expect(body.position.venue).toBe('polymarket');
    expect(body.position.externalRef).toBe('pm_v2_demo_route');
    // Adapter normalizes priceCents → entryPriceUsd (cents / 100).
    expect(body.position.entryPriceUsd).toBeCloseTo(0.62);
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 62 }),
    );
  });

  it('Polymarket: live idempotent reservations persist the resolved outcome symbol and side', async () => {
    forcePolymarketLiveTrading();
    const headers = await freshAuthHeaders('pm-v2-live-meta@example.com');
    const userId = await userIdFor(headers);
    await store.setPrivyWallet(userId, 'wallet_pm_v2_live_meta', '0x2222222222222222222222222222222222222222');
    await store.setPmClobCredentials(userId, {
      key: 'pm-key',
      secret: Buffer.from('a'.repeat(32)).toString('base64'),
      passphrase: 'pm-pass',
    });
    vi.spyOn(polymarket, 'getMarket').mockResolvedValueOnce({
      id: 'pm-v2-election',
      question: 'Router v2 live metadata test',
      outcomes: [
        { label: 'Yes', pricePct: 62, tokenId: 'token-v2-yes' },
        { label: 'No', pricePct: 38, tokenId: 'token-v2-no' },
      ],
      closesAt: null,
    });
    const placeOrder = vi.spyOn(polymarket, 'placeOrder').mockResolvedValueOnce({
      orderId: 'pm_v2_live_meta',
      filledQtyUsd: 50,
      priceCents: 62,
      demo: false,
    });

    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Region': 'NL',
        'Idempotency-Key': 'pm-v2-live-meta-1',
      },
      body: JSON.stringify({ marketId: 'pm-v2-election', outcome: 'Yes', priceCents: 62, qtyUsd: 50 }),
    });

    expect(status).toBe(200);
    expect(body.position.symbol).toBe('pm-v2-election:Yes');
    expect(body.position.sideLong).toBe(true);
    const row = await store.getMarketPositionById(body.position.id);
    expect(row?.symbol).toBe('pm-v2-election:Yes');
    expect(row?.sideLong).toBe(true);
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ outcomeTokenId: 'token-v2-yes' }));
  });

  it('Polymarket: rejects empty marketId with 400 invalid_market before calling the venue', async () => {
    const placeOrder = vi.spyOn(polymarket, 'placeOrder');
    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ marketId: '', outcome: 'Yes', priceCents: 62, qtyUsd: 50 }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toBe('invalid_market');
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('Polymarket: rejects out-of-range price with 400 invalid_price', async () => {
    const placeOrder = vi.spyOn(polymarket, 'placeOrder');
    const { status, body } = await json('/markets/polymarket/order', {
      method: 'POST',
      headers: { ...authed(), 'X-Region': 'NL' },
      body: JSON.stringify({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 100, qtyUsd: 50 }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toBe('invalid_price');
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

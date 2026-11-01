import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiFailure,
  authMePathForBrowserPath,
  nexaApi,
  openActivityStream,
  setToken,
  shouldResetMarketOrderAttempt,
} from './api.js';

afterEach(() => {
  setToken(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shouldResetMarketOrderAttempt', () => {
  it('resets after a failed venue reservation can only replay as idempotency_key_used', () => {
    expect(shouldResetMarketOrderAttempt(new ApiFailure(502, 'venue_order_failed', 'venue down'))).toBe(true);
    expect(shouldResetMarketOrderAttempt(new ApiFailure(409, 'idempotency_key_used', 'key used'))).toBe(true);
  });

  it('preserves keys while an accepted order may still be recorded', () => {
    expect(shouldResetMarketOrderAttempt(new ApiFailure(503, 'order_recording_pending', 'recording pending'))).toBe(false);
    expect(shouldResetMarketOrderAttempt(new ApiFailure(409, 'order_in_progress', 'order in progress'))).toBe(false);
  });

  it('resets for client-correctable validation errors only', () => {
    expect(shouldResetMarketOrderAttempt(new ApiFailure(400, 'invalid_tif', 'invalid tif'))).toBe(true);
    expect(shouldResetMarketOrderAttempt(new Error('network down'))).toBe(false);
  });
});

describe('openActivityStream ticket minting', () => {
  it('stops reconnecting when the stream ticket route is absent (hub disabled)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    setToken('session-token');

    const stream = openActivityStream(() => {});
    expect(stream).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A dead route is permanent for the session — no 30s polling loop.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stream?.close();
  });

  it('keeps the backoff reconnect for transient ticket failures', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    setToken('session-token');

    const stream = openActivityStream(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // attempt=1 → 1s delay; a second mint fires.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    stream?.close();
  });
});

describe('authMePathForBrowserPath', () => {
  it('requests claim sweep only on email claim links', () => {
    expect(authMePathForBrowserPath('/claim/abc123')).toBe('/auth/me?claim=1');
    expect(authMePathForBrowserPath('/claim/')).toBe('/auth/me?claim=1');
    expect(authMePathForBrowserPath('/app.html')).toBe('/auth/me');
  });
});

describe('api retry policy', () => {
  it('does not retry rate-limit responses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'too_many_requests', message: 'rate_limited' },
    }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '60' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = expect(nexaApi.markets.hyperliquid.positions()).rejects.toMatchObject({
      status: 429,
      code: 'too_many_requests',
      retryAfterMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps status and Retry-After on non-JSON error responses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('upstream rate limited', {
      status: 429,
      headers: { 'content-type': 'text/plain', 'Retry-After': '15' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = expect(nexaApi.markets.positions()).rejects.toMatchObject({
      status: 429,
      code: 'request_failed',
      message: 'upstream rate limited',
      retryAfterMs: 15_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('bridge withdraw client', () => {
  it('sends an idempotency key with bank withdraw requests', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        ok: true,
        transfer: {
          id: 'bridge-transfer-1',
          rail: 'bridge',
          status: 'pending',
          amountUsd: 25,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    setToken('session-token');

    await expect(nexaApi.bridgeWithdraw({ payoutMethodId: 'pm_1', amountUsd: 25 })).resolves.toMatchObject({
      ok: true,
    });

    expect(calls[0]?.headers).toEqual(expect.objectContaining({
      authorization: 'Bearer session-token',
      'Idempotency-Key': expect.any(String),
    }));
  });

  it('uses the caller-provided bank withdraw idempotency key', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ ok: true, transfer: { id: 'bridge-transfer-2' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    setToken('session-token');

    await nexaApi.bridgeWithdraw(
      { payoutMethodId: 'pm_1', amountUsd: 25 },
      { idempotencyKey: 'bridge-withdraw:fixed' },
    );

    expect(calls[0]?.headers).toEqual(expect.objectContaining({
      'Idempotency-Key': 'bridge-withdraw:fixed',
    }));
  });
});

describe('money movement client idempotency', () => {
  it('sends caller-provided idempotency keys on send, earn, swap, agent fund, and card buy', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        ok: true,
        claim: false,
        claimSlug: null,
        claimUrl: null,
        balUsd: 100,
        activityId: 'act_1',
        message: 'ok',
        out: 92,
        rate: 0.92,
        fees: 0,
        txHash: null,
        source: 'demo',
        tradeId: 'trade_1',
        signature: 'sig_1',
        confirmed: true,
        nftAddress: 'nft_1',
        pricePaidUsdc: 10,
        solscanUrl: 'https://solscan.io/tx/sig_1',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    setToken('session-token');

    await nexaApi.send(10, 'bob@example.com', { idempotencyKey: 'send-key' });
    await nexaApi.earnDeposit(10, undefined, { idempotencyKey: 'earn-deposit-key' });
    await nexaApi.earnWithdraw(5, undefined, { idempotencyKey: 'earn-withdraw-key' });
    await nexaApi.swapExecute(10, 'usd-eur', { idempotencyKey: 'swap-key' });
    await nexaApi.agentFund('ResearchBot-01', 7, { idempotencyKey: 'agent-fund-key' });
    await nexaApi.approveOnce(
      'ResearchBot-01',
      'dataset.vendor.io/v1/access',
      2.4,
      'dataset access',
      { idempotencyKey: 'agent-approve-key' },
    );
    await nexaApi.markets.cards.buy(
      {
        cardId: 'card_1234',
        nftAddress: '11111111111111111111111111111111',
        expectedPriceUsdc: 10,
        tokenStandard: 'Nft',
      },
      { idempotencyKey: 'card-key' },
    );

    expect(calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key'])).toEqual([
      'send-key',
      'earn-deposit-key',
      'earn-withdraw-key',
      'swap-key',
      'agent-fund-key',
      'agent-approve-key',
      'card-key',
    ]);
  });
});

describe('markets shared surface', () => {
  it('proxies canonical Hyperliquid book and trades through the API', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes('orderbook')) {
        return new Response(JSON.stringify({ ok: true, book: { levels: [[], []] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, trades: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(nexaApi.markets.hyperliquid.orderbook('BTC')).resolves.toMatchObject({ ok: true });
    await expect(nexaApi.markets.hyperliquid.recentTrades('ETH')).resolves.toMatchObject({ ok: true });
    await expect(nexaApi.markets.hyperliquid.orderbook('xyz:TSLA', { dex: 'xyz' })).resolves.toMatchObject({ ok: true });
    await expect(nexaApi.markets.hyperliquid.recentTrades('xyz:TSLA', { dex: 'xyz' })).resolves.toMatchObject({ ok: true });

    expect(urls).toEqual([
      '/api/markets/hyperliquid/orderbook?coin=BTC',
      '/api/markets/hyperliquid/recent-trades?coin=ETH',
      '/api/markets/hyperliquid/orderbook?coin=xyz%3ATSLA&dex=xyz',
      '/api/markets/hyperliquid/recent-trades?coin=xyz%3ATSLA&dex=xyz',
    ]);
  });

  it('keeps live stock wallet reads opt-in', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true, perps: [], spot: [], livePerps: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(nexaApi.markets.stocks.positions()).resolves.toMatchObject({ ok: true, livePerps: [] });
    await expect(nexaApi.markets.stocks.positions({ includeLive: true })).resolves.toMatchObject({
      ok: true,
      livePerps: [],
    });

    expect(urls).toEqual([
      '/api/markets/stocks/positions',
      '/api/markets/stocks/positions?includeLive=1',
    ]);
  });

  it('reads positions from the cross-venue rollup endpoint', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true, positions: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(nexaApi.markets.positions()).resolves.toEqual({ ok: true, positions: [] });

    expect(urls).toEqual(['/api/markets/positions']);
  });

  it('routes Polymarket category reads through the API cache layer', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true, source: 'polymarket', markets: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(nexaApi.markets.polymarket.list({ category: 'sports', limit: 20 })).resolves.toMatchObject({
      ok: true,
      markets: [],
    });

    expect(urls).toEqual(['/api/markets/polymarket?limit=20&category=sports']);
  });

  it('routes market write actions with auth, region, payload, and idempotency headers', async () => {
    setToken('market-action-token');
    const calls: Array<{
      url: string;
      method: string | undefined;
      headers: Record<string, string>;
      body: unknown;
    }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({
        url: String(url),
        method: init?.method,
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const isQuote = String(url).endsWith('/markets/jupiter/quote');
      return new Response(JSON.stringify(isQuote
        ? { ok: true, quote: { inAmount: '1000000', outAmount: '900000', priceImpactPct: 0, routePlan: [], slippageBps: 50 } }
        : {
            ok: true,
            order: { orderId: 'ord_1', demo: true },
            position: {
              id: 'pos_1',
              venue: 'demo',
              symbol: 'BTC',
              sideLong: true,
              qtyUsd: 1,
              entryPriceUsd: 1,
              status: 'open',
              externalRef: 'ord_1',
              externalOrderId: 'ord_1',
              createdAt: new Date(0).toISOString(),
            },
          }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await nexaApi.markets.hyperliquid.placeOrder(
      { coin: 'BTC', sideLong: true, qtyUsd: 10, leverage: 2, orderType: 'market' },
      { region: 'NL', idempotencyKey: 'hl-key' },
    );
    await nexaApi.markets.hyperliquidSpot.placeOrder(
      { coin: '@1', sideLong: true, qtyUsd: 5, orderType: 'market' },
      { idempotencyKey: 'spot-key' },
    );
    await nexaApi.markets.stocks.placeOrder(
      { coin: 'xyz:AAPL', sideLong: true, qtyUsd: 20, leverage: 1, orderType: 'market' },
      { idempotencyKey: 'stock-key' },
    );
    await nexaApi.markets.jupiter.quote({
      inputMint: 'USDC',
      outputMint: 'xAAPL',
      amountAtomic: '1000000',
      slippageBps: 50,
    });
    await nexaApi.markets.jupiter.swap(
      { inputMint: 'USDC', outputMint: 'xAAPL', amountAtomic: '1000000', slippageBps: 50 },
      { idempotencyKey: 'jup-key' },
    );
    await nexaApi.markets.polymarket.placeOrder(
      { marketId: '123', outcome: 'Yes', priceCents: 55, qtyUsd: 10 },
      { idempotencyKey: 'pm-key' },
    );
    await nexaApi.markets.polymarket.sell(
      { positionId: 'pos_1', limitPriceCents: 50, qtyUsd: 2 },
      { idempotencyKey: 'pm-sell-key' },
    );

    expect(calls.map((c) => ({ url: c.url, method: c.method }))).toEqual([
      { url: '/api/markets/hyperliquid/order', method: 'POST' },
      { url: '/api/markets/hyperliquid-spot/order', method: 'POST' },
      { url: '/api/markets/stocks/order', method: 'POST' },
      { url: '/api/markets/jupiter/quote', method: 'POST' },
      { url: '/api/markets/jupiter/swap', method: 'POST' },
      { url: '/api/markets/polymarket/order', method: 'POST' },
      { url: '/api/markets/polymarket/sell', method: 'POST' },
    ]);
    expect(calls.every((c) => c.headers.authorization === 'Bearer market-action-token')).toBe(true);
    expect(calls[0]?.headers['x-region']).toBe('NL');
    expect(calls.map((c) => c.headers['idempotency-key'] ?? null)).toEqual([
      'hl-key',
      'spot-key',
      'stock-key',
      null,
      'jup-key',
      'pm-key',
      'pm-sell-key',
    ]);
    expect(calls[6]?.body).toEqual({ positionId: 'pos_1', limitPriceCents: 50, qtyUsd: 2 });
  });

  it('cancels a position through the cross-venue order dispatcher', async () => {
    const calls: Array<{ url: string; method: string | undefined; body: BodyInit | null | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      return new Response(JSON.stringify({
        ok: true,
        position: {
          id: 'b48ef452-ea9a-4d66-980a-33e8d20af3a7',
          venue: 'hyperliquid',
          symbol: 'BTC',
          sideLong: true,
          qtyUsd: 1,
          entryPriceUsd: 1,
          status: 'canceled',
          externalRef: 'hl_123',
          externalOrderId: 'hl_123',
          createdAt: new Date(0).toISOString(),
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(nexaApi.markets.cancelOrder('pos/123')).resolves.toMatchObject({
      ok: true,
      position: { id: 'b48ef452-ea9a-4d66-980a-33e8d20af3a7', status: 'canceled' },
    });

    expect(calls).toEqual([
      { url: '/api/markets/orders/pos%2F123/cancel', method: 'POST', body: null },
    ]);
  });
});

describe('openActivityStream', () => {
  it('uses a short-lived stream ticket in the EventSource URL', async () => {
    const storage = new Map<string, string>();
    const urls: string[] = [];
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    });
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer session-token' }));
      return new Response(JSON.stringify({ token: 'stream-ticket' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    vi.stubGlobal('EventSource', class {
      constructor(url: string) { urls.push(url); }
      addEventListener(): void {}
      close(): void {}
    });

    setToken('session-token');
    const stream = openActivityStream(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls).toEqual(['/api/ledger/activity/stream?token=stream-ticket']);
    stream?.close();
  });
});

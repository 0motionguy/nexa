import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

describe('routes/tv', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, RATE_LIMIT_ENABLED: '1' };
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../external/tradingview-client.js');
    process.env = ORIGINAL_ENV;
  });

  it('rate limits public quote reads by client IP', async () => {
    const fetchTradingViewQuote = vi.fn(async (symbol: string) => ({
      symbol,
      description: 'Bitcoin',
      exchange: 'COINBASE',
      currency: 'USD',
      price: 100_000,
      asOf: 1,
    }));
    vi.doMock('../external/tradingview-client.js', () => ({
      fetchTradingViewQuote,
      fetchTradingViewSnapshot: vi.fn(),
    }));

    const { app } = await import('../index.js');
    const { _resetForTests } = await import('../lib/rate-limit.js');
    _resetForTests();

    let res = await app.request('/tv/quote/BTCUSD', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    for (let i = 0; i < 30; i++) {
      res = await app.request('/tv/quote/BTCUSD', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
    }

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('returns 400 for malformed encoded quote symbols', async () => {
    const fetchTradingViewQuote = vi.fn();
    vi.doMock('../external/tradingview-client.js', () => ({
      fetchTradingViewQuote,
      fetchTradingViewSnapshot: vi.fn(),
    }));

    const { app } = await import('../index.js');
    const res = await app.request('/tv/quote/%E0%A4%A');

    expect(res.status).toBe(400);
    expect(fetchTradingViewQuote).not.toHaveBeenCalled();
  });
});

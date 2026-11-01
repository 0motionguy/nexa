import { afterEach, describe, expect, it } from 'vitest';

import { app } from '../index.js';
import { env } from '../lib/env.js';
import { getOpenApiDocument } from '../lib/openapi.js';

const envBag = env as unknown as Record<string, unknown>;
const originalDisabled = envBag.SAFE_MODE_DISABLED;

afterEach(() => {
  envBag.SAFE_MODE_DISABLED = originalDisabled;
});

async function sessionToken(): Promise<string> {
  const start = await app.request('/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'safe-mode@example.com' }),
  });
  const challenge = await start.json() as { challengeId: string };
  const verify = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.challengeId, code: '482019' }),
  });
  return ((await verify.json()) as { token: string }).token;
}

describe('safe-mode config', () => {
  it('publishes only declared switches without caching', async () => {
    envBag.SAFE_MODE_DISABLED = 'venueLiveTrading, proChart, madeUp';

    const res = await app.request('/config/safe-mode');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      v: 1,
      disabled: ['realtimeHub', 'proChart', 'venueLiveTrading'],
    });
    const doc = getOpenApiDocument() as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/config/safe-mode');
  });

  it('blocks new venue writes but leaves protective cancels available', async () => {
    envBag.SAFE_MODE_DISABLED = 'venueLiveTrading';
    const unauthenticated = await app.request('/markets/hyperliquid/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);

    const token = await sessionToken();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const order = await app.request('/markets/hyperliquid/order', {
      method: 'POST',
      headers,
      body: JSON.stringify({ coin: 'BTC', sideLong: true, qtyUsd: 10, leverage: 1, orderType: 'market' }),
    });
    expect(order.status).toBe(503);
    expect(await order.json()).toMatchObject({
      ok: false,
      error: { code: 'venue_live_trading_disabled' },
    });

    const cardBuy = await app.request('/markets/cards/buy', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(cardBuy.status).toBe(503);

    const quote = await app.request('/markets/jupiter/quote', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(quote.status).not.toBe(503);

    const cancel = await app.request('/markets/hyperliquid/cancel', {
      method: 'POST',
      headers,
      body: JSON.stringify({ externalRef: 'missing', coin: 'BTC' }),
    });
    expect(cancel.status).not.toBe(503);
  });
});

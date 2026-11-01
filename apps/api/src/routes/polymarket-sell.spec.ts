/**
 * POST /markets/polymarket/sell — competitor sprint Lane A (2026-07-03).
 *
 * Money-truth contract: sells anchor on an OWNED position row; the holding
 * is reduced only on a confirmed fill; partial sells leave a live remainder;
 * oversells fail closed (including against pending sell rows); replays of
 * the same Idempotency-Key never double-submit; strangers and anonymous
 * callers never touch the row.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { store } from '../store/index.js';

let server: ServerType;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
  return () => server.close();
});

afterEach(() => {
  // No spies in this suite — demo mode exercises the real adapter fallback.
});

async function authUser(email: string): Promise<{ headers: Record<string, string>; userId: string }> {
  const start = await fetch(base + '/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const { challengeId } = (await start.json()) as { challengeId: string };
  const verify = await fetch(base + '/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: '482019' }),
  });
  const { token } = (await verify.json()) as { token: string };
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const me = (await fetch(base + '/auth/me', { headers }).then((r) => r.json())) as { user: { id: string } };
  return { headers, userId: me.user.id };
}

/** Seed a filled PM holding directly in the store — $50 of "Yes" at 25c → 200 shares. */
async function seedHolding(userId: string): Promise<{ id: string; qtyUsd: number }> {
  const u = await store.user(userId);
  const pos = await store.placeMarketOrder(u!, {
    venue: 'polymarket',
    symbol: 'mkt_sell_test:Yes',
    sideLong: true,
    qtyUsd: 50,
    entryPriceUsd: 0.25,
    externalRef: 'pm_seed_buy',
  });
  return { id: pos.id, qtyUsd: pos.qtyUsd };
}

describe('POST /markets/polymarket/sell', () => {
  it('full close: sell row fills, holding row closes, proceeds reflect exit price', async () => {
    const { headers, userId } = await authUser('pm-sell-full@example.com');
    const holding = await seedHolding(userId);

    const res = await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ positionId: holding.id, limitPriceCents: 60 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      order: { demo: boolean; state: string; filledQtyUsd: number };
      sellOrder: { symbol: string; qtyUsd: number; status: string };
      position: { status: string; qtyUsd: number } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.order.state).toBe('filled');
    // 200 shares (50/0.25) sold at 60c → $120 proceeds.
    expect(body.order.filledQtyUsd).toBeCloseTo(120, 6);
    expect(body.sellOrder.symbol).toBe(`SELL:${holding.id}`);
    // Holding fully disposed → closed with zero qty.
    expect(body.position?.status).toBe('closed');
    expect(body.position?.qtyUsd ?? -1).toBeCloseTo(0, 6);
  });

  it('partial sell reduces the holding and leaves it live', async () => {
    const { headers, userId } = await authUser('pm-sell-partial@example.com');
    const holding = await seedHolding(userId);

    const res = await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ positionId: holding.id, qtyUsd: 20, limitPriceCents: 40 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      order: { filledQtyUsd: number };
      position: { status: string; qtyUsd: number } | null;
    };
    // 80 shares (20/0.25) at 40c → $32 proceeds.
    expect(body.order.filledQtyUsd).toBeCloseTo(32, 6);
    expect(body.position?.qtyUsd).toBeCloseTo(30, 6);
    expect(body.position?.status).not.toBe('closed');
  });

  it('oversell fails closed — request above held quantity is clamped-or-rejected, never oversold', async () => {
    const { headers, userId } = await authUser('pm-sell-over@example.com');
    const holding = await seedHolding(userId);

    // qtyUsd above the holding is clamped to the holding (full close), which
    // is the money-safe interpretation; the wire schema caps the field, and
    // the atomic reduce guard makes a true oversell impossible.
    const res = await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ positionId: holding.id, qtyUsd: 99999, limitPriceCents: 50 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { position: { status: string; qtyUsd: number } | null };
    expect(body.position?.status).toBe('closed');
    expect(body.position?.qtyUsd ?? -1).toBeCloseTo(0, 6);

    // A second sell on the now-closed holding is rejected.
    const again = await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ positionId: holding.id, limitPriceCents: 50 }),
    });
    expect(again.status).toBe(400);
  });

  it("stranger's position is invisible (404), anonymous is 401", async () => {
    const owner = await authUser('pm-sell-owner@example.com');
    const holding = await seedHolding(owner.userId);
    const stranger = await authUser('pm-sell-stranger@example.com');

    const res = await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers: stranger.headers,
      body: JSON.stringify({ positionId: holding.id, limitPriceCents: 50 }),
    });
    expect(res.status).toBe(404);

    const anon = await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positionId: holding.id, limitPriceCents: 50 }),
    });
    expect(anon.status).toBe(401);
  });

  it('rejects malformed input (missing price, bad price bounds)', async () => {
    const { headers, userId } = await authUser('pm-sell-input@example.com');
    const holding = await seedHolding(userId);
    for (const bad of [
      { positionId: holding.id },
      { positionId: holding.id, limitPriceCents: 0 },
      { positionId: holding.id, limitPriceCents: 100 },
      { limitPriceCents: 50 },
    ]) {
      const res = await fetch(base + '/markets/polymarket/sell', {
        method: 'POST',
        headers,
        body: JSON.stringify(bad),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('sell rows never surface as holdings (positions route + portfolio summary)', async () => {
    const { headers, userId } = await authUser('pm-sell-phantom@example.com');
    const holding = await seedHolding(userId);
    await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ positionId: holding.id, qtyUsd: 10, limitPriceCents: 50 }),
    });

    const positions = (await fetch(base + '/markets/polymarket/positions', { headers }).then((r) =>
      r.json(),
    )) as { positions: Array<{ symbol: string }> };
    expect(positions.positions.some((p) => p.symbol.startsWith('SELL:'))).toBe(false);
    // The reduced holding itself is still there.
    expect(positions.positions.some((p) => p.symbol === 'mkt_sell_test:Yes')).toBe(true);

    const summary = (await fetch(base + '/markets/portfolio/summary', { headers }).then((r) =>
      r.json(),
    )) as { positions: Array<{ symbol: string }> };
    expect(summary.positions.some((p) => p.symbol.startsWith('SELL:'))).toBe(false);
  });

  it('trading-status + enable-trading degrade honestly without wallet/RPC', async () => {
    const { headers } = await authUser('pm-approvals@example.com');
    // Demo users have no Privy wallet → status reports no-wallet, enable 400s.
    const status = (await fetch(base + '/markets/polymarket/trading-status', { headers }).then((r) =>
      r.json(),
    )) as { ok: boolean; live: boolean; reason?: string };
    expect(status.ok).toBe(true);
    expect(status.live).toBe(false);
    expect(status.reason).toBe('no-wallet');

    const enable = await fetch(base + '/markets/polymarket/enable-trading', { method: 'POST', headers });
    expect(enable.status).toBe(400);

    // pUSD ramps require a wallet too.
    for (const path of ['/markets/polymarket/wrap', '/markets/polymarket/unwrap']) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ amountUsd: 10 }),
      });
      expect(res.status, path).toBe(400);
    }

    // Session-gated like every money surface.
    const anon = await fetch(base + '/markets/polymarket/trading-status');
    expect(anon.status).toBe(401);
  });

  it('sell rows are excluded from being sold themselves', async () => {
    const { headers, userId } = await authUser('pm-sell-row@example.com');
    const holding = await seedHolding(userId);
    const first = (await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ positionId: holding.id, qtyUsd: 10, limitPriceCents: 50 }),
    }).then((r) => r.json())) as { sellOrder: { id: string } };

    const res = await fetch(base + '/markets/polymarket/sell', {
      method: 'POST',
      headers,
      body: JSON.stringify({ positionId: first.sellOrder.id, limitPriceCents: 50 }),
    });
    expect(res.status).toBe(400);
  });
});

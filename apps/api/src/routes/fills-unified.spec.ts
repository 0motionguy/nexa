/**
 * GET /markets/fills — unified cross-venue fills (2026-07-02).
 *
 * Previously HL-only despite the "cross-venue" contract: Polymarket and
 * Jupiter/xStocks fills were invisible to NEO's portfolio activity. These
 * tests pin the three sources merging into one time-ordered feed:
 *   - Hyperliquid  → venue API (adapter.getUserFills, spied)
 *   - Polymarket   → public data-api trades (adapter.getUserFills, spied)
 *   - Jupiter/xStocks → our lifecycle store (atomic swaps: ledger is truth)
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import { polymarket } from '../lib/markets/polymarket.js';
import { store } from '../store/index.js';
import type { MarketPosition } from '../store/types.js';

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
  vi.restoreAllMocks();
});

async function authHeaders(email: string): Promise<Record<string, string>> {
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
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function jupiterPosition(overrides: Partial<MarketPosition>): MarketPosition {
  return {
    id: 'pos_jup_1',
    userId: 'u_1',
    venue: 'jupiter',
    symbol: 'WIF',
    sideLong: true,
    qtyUsd: 50,
    entryPriceUsd: 2,
    externalRef: 'jup_sig_abc',
    status: 'filled',
    createdAt: '2026-07-02T10:00:00.000Z',
    filledAt: '2026-07-02T10:00:05.000Z',
    ...overrides,
  } as MarketPosition;
}

describe('GET /markets/fills — unified cross-venue feed', () => {
  it('merges HL + Polymarket + store-derived swap fills, sorted desc by timeMs', async () => {
    const headers = await authHeaders('fills-unified@example.com');

    vi.spyOn(hyperliquid, 'getUserFills').mockResolvedValueOnce([
      { orderId: 'hl_1', coin: 'BTC', sideLong: true, qty: 0.001, priceUsd: 50_000, feeUsd: 0.02, timeMs: 3_000, hash: '0xhl' },
    ]);
    vi.spyOn(polymarket, 'getUserFills').mockResolvedValueOnce([
      { orderId: 'pm_1', coin: 'Yes', sideLong: true, qty: 10, priceUsd: 0.26, feeUsd: 0, timeMs: 2_000, hash: '0xpm', market: 'Will X happen?' },
    ]);
    const listSpy = vi.spyOn(store, 'listMarketPositions').mockImplementation(
      async (_u, venue?: string) => {
        if (venue === 'jupiter') {
          return [jupiterPosition({ filledAt: '1970-01-01T00:00:01.000Z' })];
        }
        return [];
      },
    );
    // Give the demo user a wallet so the HL/PM venue branches engage.
    const userSetup = await fetch(base + '/auth/me', { headers }).then((r) => r.json()) as { user: { id: string } };
    await store.setPrivyWallet(userSetup.user.id, 'wallet_fills_test', '0x00000000000000000000000000000000000000ff', { force: true });

    const res = await fetch(base + '/markets/fills', { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fills: Array<{ venue: string; orderId: string; timeMs: number; market?: string | null }> };
    expect(body.ok).toBe(true);

    const venues = body.fills.map((f) => f.venue);
    expect(venues).toContain('hyperliquid');
    expect(venues).toContain('polymarket');
    expect(venues).toContain('jupiter');
    // Sorted desc by timeMs: HL(3000) > PM(2000) > jupiter(1000).
    expect(body.fills.map((f) => f.orderId)).toEqual(['hl_1', 'pm_1', 'jup_sig_abc']);
    // Prediction fills carry the market question for meaningful labels.
    expect(body.fills.find((f) => f.venue === 'polymarket')?.market).toBe('Will X happen?');
    expect(listSpy).toHaveBeenCalled();
  });

  it('portfolio summary (scale 0.6): one call returns positions + venue states + balances', async () => {
    const headers = await authHeaders('summary-aggregate@example.com');
    vi.spyOn(store, 'listMarketPositions').mockResolvedValue([
      jupiterPosition({ id: 'pos_sum_1' }),
    ]);
    const res = await fetch(base + '/markets/portfolio/summary', { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      legs: Record<string, string>;
      positions: Array<Record<string, unknown>>;
      balances: { totalUsd: number } | null;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.positions)).toBe(true);
    // NEO's resolver keys off this exact legs contract — pin it.
    for (const leg of ['positions', 'hyperliquid', 'hyperliquidSpot', 'hyperliquidHip3', 'balances']) {
      expect(['ok', 'failed', 'no-wallet']).toContain(body.legs[leg]);
    }
    // orderEnvelope must carry copy-trading attribution (NEO renders it).
    expect(body.positions[0]).toHaveProperty('copiedFrom');
    // Demo env: balances resolve via the stubbed leg reads — shape present.
    expect(body.balances === null || typeof body.balances.totalUsd === 'number').toBe(true);
    // Session-gated — anonymous callers never see a portfolio.
    const anon = await fetch(base + '/markets/portfolio/summary');
    expect(anon.status).toBe(401);
  });

  it('compact view (scale 1.8): polymarket list drops description/related, default keeps shape', async () => {
    const compact = await fetch(base + '/markets/polymarket?view=compact').then((r) => r.json()) as {
      markets: Array<Record<string, unknown>>;
    };
    expect(compact.markets.length).toBeGreaterThan(0);
    for (const m of compact.markets) {
      expect(m).not.toHaveProperty('description');
      expect(m).not.toHaveProperty('related');
      expect(typeof m.question).toBe('string');
    }
    const full = await fetch(base + '/markets/polymarket').then((r) => r.json()) as {
      markets: Array<Record<string, unknown>>;
    };
    expect(full.markets[0]).toHaveProperty('description');
  });

  it('edge-cache header (scale 1.1): shared market GETs carry s-maxage, personalized reads never do', async () => {
    const pub = await fetch(base + '/markets/hyperliquid');
    expect(pub.status).toBe(200);
    expect(pub.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3, stale-while-revalidate=30');

    const headers = await authHeaders('fills-cache-header@example.com');
    vi.spyOn(store, 'listMarketPositions').mockResolvedValue([]);
    const personal = await fetch(base + '/markets/fills', { headers });
    expect(personal.status).toBe(200);
    // Personalized money reads DECLARE uncacheability — no cache layer may
    // ever store one user's fills and serve them to another.
    expect(personal.headers.get('cache-control')).toBe('private, no-store');

    // Error responses under the cached mounts are explicitly uncacheable too.
    const anon = await fetch(base + '/markets/fills');
    expect(anon.status).toBe(401);
    expect(anon.headers.get('cache-control')).toBe('private, no-store');
  });

  it('edge-cache price tier (hardening): all three all-mids feeds + HL orderbook get s-maxage=1, not the blanket 3s', async () => {
    for (const path of [
      '/markets/hyperliquid/all-mids',
      '/markets/hyperliquid-spot/all-mids',
      '/markets/stocks/all-mids',
      '/markets/hyperliquid/orderbook?coin=BTC',
    ]) {
      const res = await fetch(base + path);
      // Route may 200 or degrade upstream; the header tier is what we pin.
      const cc = res.headers.get('cache-control');
      if (cc) expect(cc, path).toBe('public, max-age=0, s-maxage=1, stale-while-revalidate=2');
    }
    // A non-price shared read still gets the 3s tier.
    const list = await fetch(base + '/markets/hyperliquid');
    expect(list.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3, stale-while-revalidate=30');
  });

  it('degrades to an empty feed (not an error) when no wallet and no swap history exist', async () => {
    const headers = await authHeaders('fills-empty@example.com');
    vi.spyOn(store, 'listMarketPositions').mockResolvedValue([]);
    const res = await fetch(base + '/markets/fills', { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fills: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.fills).toEqual([]);
  });
});

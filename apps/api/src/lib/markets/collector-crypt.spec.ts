/**
 * Adapter contract tests — Sprint 20.
 *
 * Validate the row-normalisation + disabled-guard paths without hitting the
 * real CC upstream. The live HTTP shape is verified in the smoke test.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_DEMO_MODE = process.env['DEMO_MODE'];

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = handler(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('collector-crypt adapter', () => {
  beforeEach(() => {
    process.env['CC_ENABLED'] = '1';
    process.env['CC_API_BASE'] = 'https://api.collectorcrypt.com';
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_DEMO_MODE === undefined) {
      delete process.env['DEMO_MODE'];
    } else {
      process.env['DEMO_MODE'] = ORIGINAL_DEMO_MODE;
    }
  });

  it('listSupportedCollections returns All first + known collections', async () => {
    const mod = await import('./collector-crypt.js');
    const list = mod.listSupportedCollections();
    expect(list[0]).toBe('All');
    expect(list).toContain('Pokemon');
    expect(list).toContain('NBA');
  });

  it('isCcLiveTrading is false when Privy is unset', async () => {
    delete process.env['PRIVY_APP_ID'];
    delete process.env['PRIVY_APP_SECRET'];
    vi.resetModules();
    const mod = await import('./collector-crypt.js');
    expect(mod.isCcLiveTrading()).toBe(false);
  });

  it('fetchCcListings returns empty when CC_ENABLED=0', async () => {
    process.env['CC_ENABLED'] = '0';
    vi.resetModules();
    const mod = await import('./collector-crypt.js');
    const page = await mod.fetchCcListings({ limit: 5 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('fetchCcListings normalises rows from real CC shape (probed 2026-06-21)', async () => {
    mockFetch(() => ({
      filterNFtCard: [
        {
          id: '2025112044C86171',
          itemName: 'Charizard Base 1st Ed',
          nftAddress: '7xKXtmint',
          frontImage: 'https://arweave.net/abc123',
          category: 'Pokemon',
          grade: 'GEM MT 10',
          gradeNum: 10,
          gradingCompany: 'PSA',
          nftStandard: null,
          listing: {
            createdAt: '2026-06-21T12:00:00Z',
            currency: 'USDC',
            price: 12500,
            sellerId: 'sellerId123',
          },
          owner: { id: 'sellerId123', wallet: 'WALLET123' },
        },
        // Invalid row — no listing.price
        { id: 'unlisted', nftAddress: 'addr', listing: null },
        // Invalid row — missing nftAddress
        { id: 'no-mint', itemName: 'Broken' },
      ],
      findTotal: 1,
      totalPages: 1,
    }));
    vi.resetModules();
    const mod = await import('./collector-crypt.js');
    const page = await mod.fetchCcListings({ collection: 'Pokemon', sort: 'trending' });
    expect(page.items).toHaveLength(1);
    const card = page.items[0]!;
    expect(card.id).toBe('2025112044C86171');
    expect(card.name).toBe('Charizard Base 1st Ed');
    expect(card.priceUsdc).toBe(12500);
    expect(card.collection).toBe('Pokemon');
    expect(card.imageUrl).toBe('https://arweave.net/abc123');
    expect(card.gradeLabel).toBe('PSA GEM MT 10');
    expect(card.tokenStandard).toBe('Nft'); // nftStandard=null defaults to Nft
  });

  it('fetchCcListings uses page-based pagination + client-side filters', async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return { filterNFtCard: [], findTotal: 0, totalPages: 0 };
    });
    vi.resetModules();
    const mod = await import('./collector-crypt.js');
    await mod.fetchCcListings({ collection: 'NBA', sort: 'floor', cursor: '3', limit: 10 });
    expect(calls).toHaveLength(1);
    // Per probed API: only `page` is accepted at the URL level.
    expect(calls[0]).toMatch(/page=3/);
    // `collection`/`sort` are NOT forwarded (client-side filter).
    expect(calls[0]).not.toMatch(/collection=/);
    expect(calls[0]).not.toMatch(/sort=/);
  });

  it('fetchCcCardFromListings resolves active listing ids when the detail endpoint lags', async () => {
    mockFetch((url) => {
      if (url.includes('/marketplace/202605230C136034')) {
        return new Response(JSON.stringify({ ok: false }), { status: 404 });
      }
      return {
        filterNFtCard: [
          {
            id: '202605230C136034',
            itemName: 'O-Nami SP BGS 10',
            nftAddress: 'WxUTBhnFg3jG4768MZSdm11vbaVSwxQHovD4ZfvkCaY',
            frontImage: 'https://arweave.net/card',
            category: 'One Piece',
            grade: 'g10p',
            gradingCompany: 'Beckett',
            nftStandard: null,
            listing: {
              createdAt: '2026-06-29T13:35:00.171Z',
              price: 800,
            },
            owner: { wallet: 'GNWtRMUAA9Bmajsyd4bFHqTcwZjfJy9Vn8rdB9WevsAz' },
          },
        ],
        findTotal: 1,
        totalPages: 1,
      };
    });
    vi.resetModules();
    const mod = await import('./collector-crypt.js');
    const direct = await mod.fetchCcCard('202605230C136034');
    expect(direct).toBeNull();
    const fallback = await mod.fetchCcCardFromListings('202605230C136034');
    expect(fallback?.name).toBe('O-Nami SP BGS 10');
    expect(fallback?.saleHistory).toEqual([]);
    expect(fallback?.collectionFloorUsdc).toBeNull();
  });

  it('executeCcBuy refuses without live trading', async () => {
    process.env['DEMO_MODE'] = '0';
    delete process.env['PRIVY_APP_ID'];
    delete process.env['PRIVY_APP_SECRET'];
    vi.resetModules();
    const mod = await import('./collector-crypt.js');
    const r = await mod.executeCcBuy({
      privyWalletId: null,
      buyerSolanaAddress: null,
      nftAddress: 'x',
      expectedPriceUsdc: 1,
      tokenStandard: 'Pnft',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cc_not_live');
  });
});

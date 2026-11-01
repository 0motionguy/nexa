/**
 * /markets/cards/* — Collector Crypt trading-card marketplace (Sprint 20).
 *
 *   GET  /markets/cards                — paginated listings (public, CDN-cached)
 *   GET  /markets/cards/collections    — supported collection chips
 *   GET  /markets/cards/:id            — single card detail + sale history
 *   POST /markets/cards/buy            — execute buy with Privy Solana wallet
 *   GET  /markets/cards/positions      — user's owned cards
 *
 * Powers the NEO trading-terminal Cards tab. NEO calls these through the
 * normal NEXA Bearer-JWT pipe (same as Jupiter / Hyperliquid / Polymarket);
 * NEXA owns the upstream CC API contract, the Privy signing, and the audit
 * row in nb_cc_trades.
 *
 * Gated on `features.ccEnabled` (env CC_ENABLED=1). When off, every route
 * returns 503 with `{ error: 'cards_disabled' }` so the UI knows to hide.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { requireSession } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { env, features } from '../lib/env.js';
import { liveMeta, providerDemoMeta } from '../lib/sourced.js';
import { walletService } from '../lib/chain/wallet.js';
import { storeBoot } from '../store/index.js';
import { nbCcTrades } from '../db/schema/index.js';
import {
  fetchCcListings,
  fetchCcCard,
  fetchCcCardFromListings,
  fetchCcPositionsByOwner,
  executeCcBuy,
  isCcLiveTrading,
  listSupportedCollections,
  type CcTokenStandard,
} from '../lib/markets/collector-crypt.js';

export const marketsCardsRoutes = new Hono();

function disabledGuard(): { ok: false; error: { code: string; message: string } } {
  return {
    ok: false,
    error: { code: 'cards_disabled', message: 'Collector Crypt surface disabled (CC_ENABLED=0).' },
  };
}

function idempotencyKeyOf(c: { req: { header(name: string): string | undefined } }): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? '').trim();
  if (!key) return null;
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key;
}

function uuidFromHash(input: string): string {
  const h = createHash('sha256').update(input).digest('hex');
  const variant = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/* ── GET /markets/cards ─────────────────────────────────────────────────── */

const ListQuery = z.object({
  collection: z.string().optional(),
  sort: z.enum(['trending', 'floor', 'recent', 'movers']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

marketsCardsRoutes.get('/', zValidator('query', ListQuery), async (c) => {
  if (!features.ccEnabled) return c.json(disabledGuard(), 503);
  const q = c.req.valid('query');
  const page = await fetchCcListings({
    collection: q.collection as Parameters<typeof fetchCcListings>[0]['collection'],
    sort: q.sort,
    cursor: q.cursor,
    limit: q.limit,
  });
  return c.json({
    ok: true,
    items: page.items,
    total: page.total,
    cursor: page.cursor,
    totalPages: page.totalPages,
    sourced: liveMeta('collector-crypt', 'listings'),
  });
});

/* ── GET /markets/cards/collections ─────────────────────────────────────── */

marketsCardsRoutes.get('/collections', (c) => {
  if (!features.ccEnabled) return c.json(disabledGuard(), 503);
  return c.json({
    ok: true,
    collections: listSupportedCollections(),
    sourced: liveMeta('collector-crypt', 'collections'),
  });
});

/* ── GET /markets/cards/positions (user-authed) ─────────────────────────── */

marketsCardsRoutes.get('/positions', requireSession, async (c) => {
  if (!features.ccEnabled) return c.json(disabledGuard(), 503);
  const u = c.get('user');
  const solWallet = await walletService.getOrCreateUserSolanaWallet(u.id, null);
  if (!solWallet.address) {
    return c.json({ ok: true, items: [], sourced: providerDemoMeta('collector-crypt', 'positions') });
  }
  const items = await fetchCcPositionsByOwner(solWallet.address);
  return c.json({
    ok: true,
    items,
    wallet: solWallet.address,
    sourced: solWallet.live
      ? liveMeta('collector-crypt', 'positions')
      : providerDemoMeta('collector-crypt', 'positions'),
  });
});

/* ── GET /markets/cards/:id ─────────────────────────────────────────────── */

marketsCardsRoutes.get('/:id', async (c) => {
  if (!features.ccEnabled) return c.json(disabledGuard(), 503);
  const id = c.req.param('id');
  if (!id || id.length < 4) throw ApiError.badRequest('invalid_card_id');
  const card = (await fetchCcCard(id)) ?? (await fetchCcCardFromListings(id));
  if (!card) throw ApiError.notFound('card_not_found');
  return c.json({
    ok: true,
    card,
    sourced: liveMeta('collector-crypt', 'card-detail'),
  });
});

/* ── POST /markets/cards/buy ────────────────────────────────────────────── */

const BuyInput = z.object({
  cardId: z.string().min(4).max(64),
  nftAddress: z.string().min(32).max(64),
  expectedPriceUsdc: z.number().positive().max(1_000_000),
  tokenStandard: z.enum(['Pnft', 'Cnft', 'Nft', 'Core']),
  // Optional metadata for the audit row.
  name: z.string().max(200).optional(),
  imageUrl: z.string().url().max(2048).optional(),
});

marketsCardsRoutes.post('/buy', requireSession, zValidator('json', BuyInput), async (c) => {
  if (!features.ccEnabled) return c.json(disabledGuard(), 503);
  if (!isCcLiveTrading() && !env.DEMO_MODE) {
    throw ApiError.serviceUnavailable('cards_execution_unavailable', {
      ccEnabled: features.ccEnabled,
      privy: features.privy,
      solanaRpc: features.solanaRpc,
    });
  }
  const u = c.get('user');
  if (u.killSwitch) throw ApiError.forbidden('account_frozen');
  const body = c.req.valid('json');
  const idempotencyKey = idempotencyKeyOf(c);
  if (!idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const tradeId = uuidFromHash(`cc-buy:${u.id}:${idempotencyKey}`);

  // Resolve the user's Privy Solana wallet (provisions one if missing).
  const solWallet = await walletService.getOrCreateUserSolanaWallet(u.id, u.privyDid ?? null);
  if ((!solWallet.live || !solWallet.address) && !env.DEMO_MODE) {
    throw ApiError.serviceUnavailable('cards_wallet_unavailable', {
      privyDid: Boolean(u.privyDid),
    });
  }

  if (storeBoot.db) {
    try {
      const [reserved] = await storeBoot.db
        .insert(nbCcTrades)
        .values({
          id: tradeId,
          userId: u.id,
          side: 'buy',
          nftAddress: body.nftAddress,
          cardId: body.cardId,
          name: body.name ?? null,
          imageUrl: body.imageUrl ?? null,
          priceUsdc: String(body.expectedPriceUsdc),
          tokenStandard: body.tokenStandard,
          signature: null,
          status: 'submitted',
          error: null,
        })
        .onConflictDoNothing()
        .returning();
      if (!reserved) {
        const [existing] = await storeBoot.db
          .select()
          .from(nbCcTrades)
          .where(and(eq(nbCcTrades.userId, u.id), eq(nbCcTrades.id, tradeId)))
          .limit(1);
        if (!existing) throw new Error('cards_reservation_missing');
        if (
          existing.nftAddress !== body.nftAddress ||
          existing.cardId !== body.cardId ||
          existing.tokenStandard !== body.tokenStandard ||
          Math.abs(Number(existing.priceUsdc) - body.expectedPriceUsdc) > 0.005
        ) {
          throw ApiError.conflict('idempotency_key_reused', { tradeId });
        }
        if (existing.status === 'failed') {
          throw ApiError.conflict('idempotency_key_used', { tradeId, status: existing.status });
        }
        if (existing.signature) {
          return c.json({
            ok: true,
            tradeId,
            signature: existing.signature,
            confirmed: existing.status === 'confirmed',
            nftAddress: existing.nftAddress,
            pricePaidUsdc: Number(existing.priceUsdc),
            solscanUrl: `https://solscan.io/tx/${existing.signature}`,
            idempotent: true,
            sourced: liveMeta('collector-crypt', 'buy'),
          });
        }
        throw ApiError.conflict('transfer_in_progress', { tradeId });
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      log.error(
        { err: e instanceof Error ? e.message : String(e), tradeId },
        'cards: buy reservation failed before provider submit',
      );
      throw ApiError.serviceUnavailable('cards_reservation_failed');
    }
  }

  const result = await executeCcBuy({
    privyWalletId: solWallet.walletId,
    buyerSolanaAddress: solWallet.address,
    nftAddress: body.nftAddress,
    expectedPriceUsdc: body.expectedPriceUsdc,
    tokenStandard: body.tokenStandard as CcTokenStandard,
    cardId: body.cardId,
    name: body.name,
    imageUrl: body.imageUrl,
  });

  // Persist the audit row in both branches — failures are still useful history.
  if (storeBoot.db) {
    try {
      await storeBoot.db
        .update(nbCcTrades)
        .set({
          signature: result.ok ? result.signature : null,
          status: result.ok ? (result.confirmed ? 'confirmed' : 'submitted') : 'failed',
          error: result.ok ? null : ({ reason: result.reason } as Record<string, unknown>),
        })
        .where(and(eq(nbCcTrades.userId, u.id), eq(nbCcTrades.id, tradeId)));
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), tradeId },
        'cards: audit row update failed after provider submit',
      );
    }
  }

  if (!result.ok) {
    return c.json(
      {
        ok: false,
        error: { code: 'cards_buy_failed', message: result.reason, requestId: c.get('requestId') },
        tradeId,
      },
      502,
    );
  }
  // Activity-feed integration is a follow-up — the nb_cc_trades row is the
  // source of truth and GET /markets/cards/trades/me serves the history.
  return c.json({
    ok: true,
    tradeId,
    signature: result.signature,
    confirmed: result.confirmed,
    nftAddress: body.nftAddress,
    pricePaidUsdc: result.pricePaidUsdc,
    solscanUrl: `https://solscan.io/tx/${result.signature}`,
    sourced: result.demo
      ? providerDemoMeta('collector-crypt', 'buy')
      : liveMeta('collector-crypt', 'buy'),
  });
});

/* ── GET /markets/cards/trades (user history, optional) ─────────────────── */

marketsCardsRoutes.get('/trades/me', requireSession, async (c) => {
  if (!features.ccEnabled) return c.json(disabledGuard(), 503);
  const u = c.get('user');
  if (!storeBoot.db) {
    return c.json({ ok: true, trades: [], note: 'in-memory store — no trade history' });
  }
  const rows = await storeBoot.db
    .select()
    .from(nbCcTrades)
    .where(and(eq(nbCcTrades.userId, u.id)))
    .limit(50);
  return c.json({
    ok: true,
    trades: rows.map((r) => ({
      id: r.id,
      side: r.side,
      nftAddress: r.nftAddress,
      cardId: r.cardId,
      name: r.name,
      imageUrl: r.imageUrl,
      priceUsdc: Number(r.priceUsdc),
      signature: r.signature,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      solscanUrl: r.signature ? `https://solscan.io/tx/${r.signature}` : null,
    })),
  });
});

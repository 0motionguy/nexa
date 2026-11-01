/**
 * Card surface — freeze / limits. State persists via store.setCardFrozen /
 * setCardDayLimit so PostgresStore writes to nb_card_state. InMemoryStore
 * mutates the live user object.
 */

import { createHash } from 'node:crypto';
import { Hono, type Handler } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireSession } from '../lib/auth.js';
import { store } from '../store/index.js';
import { transferStore } from '../store/transfers.js';
import { getChainStack } from '../lib/chain/index.js';
import { env } from '../lib/env.js';
import { resolveCardProjection } from '../lib/card-projection.js';
import { liveMeta, providerDemoMeta, unavailableMeta } from '../lib/sourced.js';
import { ApiError } from '../lib/errors.js';

export const cardRoutes = new Hono();

cardRoutes.use('*', requireSession);

function cardTopupIdempotencyKeyOf(
  c: { req: { header(name: string): string | undefined } },
  bodyKey?: string,
): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? bodyKey ?? '').trim();
  if (!key) return null;
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key;
}

function cardTopupTransferKey(key: string): string {
  return `card-topup:${createHash('sha256').update(key).digest('hex')}`;
}

function cardOrderStepKey(key: string, step: 'safe' | 'card'): string {
  return `card-order:${step}:${createHash('sha256').update(key).digest('hex')}`;
}

export const getCardState: Handler = async (c) => {
  const u = c.get('user');
  const view = await resolveCardProjection(u.id, u.cardFrozen, u.cardDayLimitUsd);
  // Card provider is Gnosis Pay today (Sponge is planned for the US debit path
  // but not yet wired). resolveCardProjection sets `demo: true` when no live
  // provider is reachable, so reuse that signal for source kind selection.
  const sourced = view.demo
    ? providerDemoMeta('gnosis-pay', 'card-state')
    : liveMeta('gnosis-pay', 'card-state');
  return c.json({
    ok: true,
    ...view,
    sourced,
  });
};

cardRoutes.get('/', getCardState);

cardRoutes.post('/order', async (c) => {
  const u = c.get('user');
  const idempotencyKey = cardTopupIdempotencyKeyOf(c);
  if (!env.DEMO_MODE && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  const stack = getChainStack();
  const safe = await stack.gnosis.deploySafe(u.id, {
    idempotencyKey: idempotencyKey ? cardOrderStepKey(idempotencyKey, 'safe') : null,
  });
  const card = await stack.gnosis.orderVirtualCard(u.id, {
    idempotencyKey: idempotencyKey ? cardOrderStepKey(idempotencyKey, 'card') : null,
  });
  if (!env.DEMO_MODE && (safe.demo || card.demo)) {
    return c.json(
      {
        ok: false,
        error: { code: 'card_unavailable', message: 'Live card provisioning is unavailable.' },
        sourced: unavailableMeta('gnosis-pay', 'card-order', new Error('safe or card demo path returned outside DEMO_MODE')),
      },
      503,
    );
  }
  const sourced = card.demo
    ? providerDemoMeta('gnosis-pay', 'card-order')
    : liveMeta('gnosis-pay', 'card-order');
  return c.json({
    ok: true,
    last4: card.last4,
    network: card.network,
    pan: card.demo ? null : card.pan,
    safeAddress: safe.safeAddress,
    demo: card.demo,
    sourced,
  });
});

cardRoutes.post(
  '/topup',
  zValidator('json', z.object({
    amountUsd: z.number().positive().max(99999),
    idempotencyKey: z.string().min(1).max(120).optional(),
  })),
  async (c) => {
    const u = c.get('user');
    const { amountUsd, idempotencyKey: bodyIdempotencyKey } = c.req.valid('json');
    const idempotencyKey = cardTopupIdempotencyKeyOf(c, bodyIdempotencyKey);
    if (!env.DEMO_MODE && !idempotencyKey) {
      throw ApiError.badRequest('idempotency_key_required');
    }
    let transferId: string | null = null;
    const idem = idempotencyKey ? cardTopupTransferKey(idempotencyKey) : null;
    if (idem) {
      const created = await transferStore.create({
        userId: u.id,
        fromBucket: 'cash',
        toBucket: 'external',
        fromChain: 'base',
        toChain: 'gnosis',
        amountUsd,
        amountTokenAtoms: String(Math.round(amountUsd * 1_000_000)),
        token: 'USDC',
        rail: 'socket',
        idempotencyKey: idem,
      });
      if (!created.fresh) {
        if (Math.abs(created.transfer.amountUsd - amountUsd) > 0.005) {
          throw ApiError.conflict('idempotency_key_reused');
        }
        const provider = created.transfer.rail === 'lifi' ? 'lifi' : 'socket';
        return c.json({
          ok: true,
          txHash: created.transfer.srcTxHash,
          source: provider,
          sourced: liveMeta(provider, 'card-topup'),
        });
      }
      transferId = created.transfer.id;
    }
    // A cross-chain top-up moves money TO the card — it is logged as activity,
    // NOT credited to the human ledger balance. Phase 2: routes through the
    // bridge router so Socket is tried first (with destination-gas refuel ON
    // so the user doesn't need xDAI to settle), falling back to LIFI.
    const stack = getChainStack();
    const wallet = await stack.wallets.getOrCreateUserWallet(u.id, null);
    const r = await stack.bridgeRouter.execute(
      {
        fromChain: 'base',
        toChain: 'gnosis',
        fromToken: 'USDC',
        toToken: 'EURe',
        amountUsd,
        userAddress: wallet.address,
        enableRefuel: true,
      },
      u.id,
      { idempotencyKey },
    );
    if (transferId) {
      await transferStore.update(transferId, { status: 'complete', rail: r.provider, srcTxHash: r.txHash });
    }
    await store.pushActivity(u, {
      n: 'Card top-up',
      s: 'BASE→GNOSIS · JUST NOW',
      a: '−$' + amountUsd.toFixed(2),
      k: 'card',
      status: 'submitted',
      venue: r.provider,
      signer: wallet.address,
      txHash: r.txHash,
      chain: 'base',
    });
    const sourced = r.demo
      ? providerDemoMeta(r.provider, 'card-topup')
      : liveMeta(r.provider, 'card-topup');
    return c.json({
      ok: true,
      txHash: r.txHash,
      source: r.demo ? 'demo' : r.provider,
      sourced,
    });
  },
);

cardRoutes.post(
  '/freeze',
  zValidator('json', z.object({ frozen: z.boolean() })),
  async (c) => {
    const u = c.get('user');
    await store.setCardFrozen(u, c.req.valid('json').frozen);
    return c.json({ ok: true, frozen: u.cardFrozen });
  },
);

cardRoutes.post(
  '/limit',
  zValidator('json', z.object({ dayLimitUsd: z.number().int().min(100).max(2000) })),
  async (c) => {
    const u = c.get('user');
    await store.setCardDayLimit(u, c.req.valid('json').dayLimitUsd);
    return c.json({ ok: true, dayLimitUsd: u.cardDayLimitUsd });
  },
);

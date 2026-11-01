/**
 * Balance + unified activity + SSE stream + extended /me view.
 *
 * The /me endpoint is the bootstrap for the Live frontend — virtual accounts,
 * card details, earn position, all in one fetch.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireEventStreamSession, requireSession } from '../lib/auth.js';
import { store } from '../store/index.js';
import { ApiError } from '../lib/errors.js';
import type { Activity } from '../store/types.js';
import { getChainStack } from '../lib/chain/index.js';
import { log } from '../lib/log.js';
import { resolveCardProjection } from '../lib/card-projection.js';
import { env } from '../lib/env.js';
import type { VirtualAccount } from '../store/types.js';
import { transferStore, type Transfer } from '../store/transfers.js';

export const ledgerRoutes = new Hono();

function maskSensitiveAccountValue(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, '');
  const tail = compact.slice(-4);
  return tail ? `****${tail}` : null;
}

function redactVirtualAccount(account: VirtualAccount): VirtualAccount {
  return {
    ...account,
    routingNumber: maskSensitiveAccountValue(account.routingNumber),
    accountNumber: maskSensitiveAccountValue(account.accountNumber),
    iban: maskSensitiveAccountValue(account.iban),
  };
}

ledgerRoutes.get('/balance', requireSession, (c) => {
  const u = c.get('user');
  return c.json({ ok: true, balUsd: u.balUsd, earnUsd: u.earnUsd, earnApy: u.earnApy });
});

/** Human labels for transfer buckets in the merged activity feed. */
const TRANSFER_BUCKET_LABEL: Record<string, string> = {
  cash: 'Cash',
  perps: 'Perps',
  predictions: 'Predictions',
  memes: 'Memes',
  'stocks-spot': 'xStocks',
  external: 'External',
};

/** Map an nb_transfers row into the activity wire shape. Cross-chain/HL
 *  moves live only in nb_transfers — without this read-time merge they were
 *  invisible in the main feed (the split-history gap). */
function transferActivity(t: Transfer): Activity {
  const from = TRANSFER_BUCKET_LABEL[t.fromBucket] ?? t.fromBucket;
  const to = TRANSFER_BUCKET_LABEL[t.toBucket] ?? t.toBucket;
  const status =
    t.status === 'complete' ? 'confirmed' : t.status === 'failed' ? 'failed' : 'pending';
  return {
    id: t.id,
    n: `Moved ${from} → ${to}`,
    s: `${t.rail.toUpperCase()} · ${t.status.replace(/_/g, ' ').toUpperCase()}`,
    a: '$' + t.amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    k: 'swap',
    at: t.createdAt,
    status,
    venue: 'transfer',
    txHash: t.srcTxHash ?? undefined,
    chain: t.fromChain,
  };
}

ledgerRoutes.get('/activity', requireSession, async (c) => {
  const u = c.get('user');
  const rawLimit = c.req.query('limit') ?? '20';
  const parsedLimit = Number(rawLimit);
  // F062 — surface as structured ApiError.
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
    throw ApiError.badRequest('invalid_limit');
  }
  const limit = parsedLimit;
  // Read-time merge of the two append-only histories (nb_transactions via
  // u.activity + nb_transfers). The transfers leg fails soft — a store
  // hiccup must not blank the whole feed. Opt out with ?transfers=0.
  let transferRows: Activity[] = [];
  if (c.req.query('transfers') !== '0') {
    try {
      transferRows = (await transferStore.listByUser(u.id, limit)).map(transferActivity);
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId: u.id },
        'ledger: transfers leg of activity merge failed',
      );
    }
  }
  // Scale wave 3 — session objects are projections; hydrate for the activity feed.
  const fullUser = await store.user(u.id);
  const merged = [...fullUser.activity.slice(0, limit), ...transferRows]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
  return c.json({ ok: true, activity: merged });
});

/**
 * Extended /me — what the frontend's syncFromServer() needs in one fetch.
 * Card and virtual-account identity are live-or-null outside demo mode.
 */
ledgerRoutes.get('/me', requireSession, async (c) => {
  const u = c.get('user');
  // Scale wave 3 — virtual accounts + agent count live on the full record.
  const full = await store.user(u.id);
  let liveApyBps: number | null = null;
  try {
    const protocols = await getChainStack().earnRouter.getProtocols(u);
    liveApyBps = protocols.blendedApy > 0 ? protocols.blendedApy : null;
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'ledger: earn APY unavailable');
  }
  const canExposeVirtualAccounts = env.DEMO_MODE || Boolean(u.bridgeCustomerId);
  const usAcct = canExposeVirtualAccounts ? full.virtualAccounts.find((v) => v.currency === 'USD') : null;
  const euAcct = canExposeVirtualAccounts ? full.virtualAccounts.find((v) => v.currency === 'EUR') : null;
  const card = await resolveCardProjection(u.id, u.cardFrozen, u.cardDayLimitUsd);
  return c.json({
    ok: true,
    user: { id: u.id, email: u.email, name: u.name },
    balance: { balUsd: u.balUsd, earnUsd: u.earnUsd, earnApy: u.earnApy },
    kycStatus: u.kycStatus,
    card: card.card,
    virtualAccounts: {
      us:
        usAcct?.accountNumber && usAcct.routingNumber
          ? { number: usAcct.accountNumber, routing: usAcct.routingNumber }
          : null,
      eu:
        euAcct?.iban && euAcct.bic
          ? { iban: euAcct.iban, bic: euAcct.bic }
          : null,
    },
    virtualAccountsList: full.virtualAccounts.map(redactVirtualAccount),
    wallet: {
      baseAddress: u.privyWalletAddress ?? null,
      solanaAddress: u.privySolWalletAddress ?? null,
    },
    earn: {
      apyBps: liveApyBps,
      posUsd: u.earnUsd,
    },
    agents: { count: full.agents.length, killSwitch: u.killSwitch },
  });
});

/** Server-sent events — new ledger rows as they land. 15s keepalive. */
ledgerRoutes.get('/activity/stream', requireEventStreamSession, (c) => {
  const u = c.get('user');
  return streamSSE(c, async (stream) => {
    const onActivity = (userId: string, row: Activity): void => {
      if (userId !== u.id) return;
      void stream.writeSSE({ event: 'activity', data: JSON.stringify(row) });
    };
    store.bus.on('activity', onActivity);

    let alive = true;
    stream.onAbort(() => {
      alive = false;
      store.bus.off('activity', onActivity);
    });

    while (alive) {
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      await stream.sleep(15_000);
    }
  });
});

import { eq } from 'drizzle-orm';
import { nbPmLeaderboardSnapshots } from '../db/schema/index.js';
import type { PmLeaderboardEntry } from '../lib/markets/polymarket.js';
import { log } from '../lib/log.js';
import { storeBoot } from './index.js';

export type PmLeaderboardSnapshotPayload = {
  source: 'polymarket' | 'demo';
  sourced?: unknown;
  traders: PmLeaderboardEntry[];
};

export type PmLeaderboardSnapshot = {
  payload: PmLeaderboardSnapshotPayload;
  expiresAt: string;
  persisted: true;
  stale: boolean;
};

type SnapshotRow = typeof nbPmLeaderboardSnapshots.$inferSelect;

const memSnapshots = new Map<string, { payload: PmLeaderboardSnapshotPayload; expiresAt: Date }>();

function parseKey(key: string): { sort: string; traderLimit: number; marketLimit: number } {
  const [, sort = 'pnl', traders = '20', markets = '5'] = key.split(':');
  return {
    sort,
    traderLimit: Number(traders) || 20,
    marketLimit: Number(markets) || 5,
  };
}

function snapshotFrom(row: SnapshotRow, nowMs: number): PmLeaderboardSnapshot {
  return {
    payload: row.payload as PmLeaderboardSnapshotPayload,
    expiresAt: row.expiresAt.toISOString(),
    persisted: true,
    stale: row.expiresAt.getTime() <= nowMs,
  };
}

export const pmLeaderboardIndex = {
  async read(
    key: string,
    opts: { allowStale?: boolean; nowMs?: number } = {},
  ): Promise<PmLeaderboardSnapshot | null> {
    const nowMs = opts.nowMs ?? Date.now();
    const db = storeBoot.db;
    if (!db) {
      const row = memSnapshots.get(key);
      if (!row) return null;
      const stale = row.expiresAt.getTime() <= nowMs;
      if (stale && !opts.allowStale) return null;
      return {
        payload: row.payload,
        expiresAt: row.expiresAt.toISOString(),
        persisted: true,
        stale,
      };
    }
    try {
      const [row] = await db
        .select()
        .from(nbPmLeaderboardSnapshots)
        .where(eq(nbPmLeaderboardSnapshots.key, key))
        .limit(1);
      if (!row) return null;
      const snapshot = snapshotFrom(row, nowMs);
      if (snapshot.stale && !opts.allowStale) return null;
      return snapshot;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), key },
        'polymarket index: snapshot read failed',
      );
      return null;
    }
  },

  async write(
    key: string,
    payload: PmLeaderboardSnapshotPayload,
    opts: { ttlMs: number; nowMs?: number },
  ): Promise<void> {
    const now = new Date(opts.nowMs ?? Date.now());
    const expiresAt = new Date(now.getTime() + opts.ttlMs);
    const params = parseKey(key);
    const db = storeBoot.db;
    if (!db) {
      memSnapshots.set(key, { payload, expiresAt });
      return;
    }
    try {
      await db
        .insert(nbPmLeaderboardSnapshots)
        .values({
          key,
          sort: params.sort,
          traderLimit: params.traderLimit,
          marketLimit: params.marketLimit,
          payload,
          expiresAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: nbPmLeaderboardSnapshots.key,
          set: {
            sort: params.sort,
            traderLimit: params.traderLimit,
            marketLimit: params.marketLimit,
            payload,
            expiresAt,
            updatedAt: now,
          },
        });
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), key },
        'polymarket index: snapshot write failed',
      );
    }
  },

  _resetForTests(): void {
    memSnapshots.clear();
  },
};

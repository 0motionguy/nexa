/**
 * GeckoTerminal market-data adapter — free, keyless OHLCV for on-chain tokens.
 *
 * Fills the meme/xStock candle gap (NEO register P2 #15): Jupiter Lite has no
 * candles API and pump.fun only covers bonding-curve tokens. GeckoTerminal
 * serves pool-level OHLCV for any Solana token with a real pool:
 *
 *   1. GET /networks/solana/tokens/{mint}/pools   → top pool (liquidity-ranked)
 *   2. GET /networks/solana/pools/{pool}/ohlcv/{tf} → [ts,o,h,l,c,vol] rows
 *
 * Honesty rules: pools under MIN_POOL_LIQUIDITY_USD are treated as no-market
 * (a $0.55 dust pool would draw a garbage chart — verified live on an xStock),
 * and every failure degrades to an empty candle list, never synthetic bars.
 * Candles are shaped to the HL candle wire format so the existing chart
 * components consume them without a second code path.
 *
 * Rate limit: ~30 req/min per IP on the free tier — the route layer caches
 * for 60 s and the pool resolution caches here for 10 min, so a busy detail
 * page costs at most 2 upstream calls a minute.
 */

import { features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
export const MIN_POOL_LIQUIDITY_USD = 100;

export type GtInterval = '15m' | '1h' | '4h' | '1d';

const INTERVALS: Record<GtInterval, { path: 'minute' | 'hour' | 'day'; aggregate: number; bucketMs: number }> = {
  '15m': { path: 'minute', aggregate: 15, bucketMs: 15 * 60_000 },
  '1h': { path: 'hour', aggregate: 1, bucketMs: 3_600_000 },
  '4h': { path: 'hour', aggregate: 4, bucketMs: 4 * 3_600_000 },
  '1d': { path: 'day', aggregate: 1, bucketMs: 24 * 3_600_000 },
};

export function cleanGtInterval(raw: string | undefined): GtInterval {
  return raw === '15m' || raw === '1h' || raw === '4h' || raw === '1d' ? raw : '1h';
}

/** HL candle wire shape — NEO's chart components consume this directly. */
export interface GtCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

export interface GtCandlesResult {
  /** Top pool the series came from, or null when no real pool exists. */
  pool: string | null;
  candles: GtCandle[];
}

/** GeckoTerminal pools payload — only the fields we read. */
interface GtPoolsPayload {
  data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string | number } }>;
}

/** GeckoTerminal ohlcv payload — rows are [tsSec, o, h, l, c, volume]. */
interface GtOhlcvPayload {
  data?: { attributes?: { ohlcv_list?: Array<Array<number | string>> } };
}

export function mapOhlcvList(
  rows: Array<Array<number | string>>,
  mint: string,
  interval: GtInterval,
): GtCandle[] {
  const { bucketMs } = INTERVALS[interval];
  return rows
    .map((r) => ({
      tsSec: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    }))
    .filter(
      (r) =>
        Number.isFinite(r.tsSec) &&
        r.tsSec > 0 &&
        Number.isFinite(r.o) &&
        Number.isFinite(r.c) &&
        Number.isFinite(r.h) &&
        Number.isFinite(r.l),
    )
    .sort((a, b) => a.tsSec - b.tsSec)
    .map((r) => ({
      t: r.tsSec * 1000,
      T: r.tsSec * 1000 + bucketMs,
      s: mint,
      i: interval,
      o: String(r.o),
      c: String(r.c),
      h: String(r.h),
      l: String(r.l),
      v: String(Number.isFinite(r.v) ? r.v : 0),
      n: 0,
    }));
}

/* ── pool resolution cache (per-process, 10 min) ────────────────────────── */

const poolCache = new Map<string, { pool: string | null; expiresAt: number }>();
const POOL_TTL_MS = 10 * 60_000;

export function _resetGeckoTerminalCacheForTests(): void {
  poolCache.clear();
}

async function resolveTopPool(mint: string): Promise<string | null> {
  const now = Date.now();
  const hit = poolCache.get(mint);
  if (hit && hit.expiresAt > now) return hit.pool;
  let pool: string | null = null;
  try {
    const res = await httpRequest(
      `${GT_BASE}/networks/${NETWORK}/tokens/${encodeURIComponent(mint)}/pools?page=1`,
      {
        vendor: 'geckoterminal',
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 8_000,
        maxAttempts: 2,
      },
    );
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as GtPoolsPayload | null;
      const top = data?.data?.[0]?.attributes;
      const liquidity = Number(top?.reserve_in_usd);
      if (top?.address && Number.isFinite(liquidity) && liquidity >= MIN_POOL_LIQUIDITY_USD) {
        pool = top.address;
      }
    }
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), mint },
      'geckoterminal: pool resolve failed',
    );
  }
  poolCache.set(mint, { pool, expiresAt: now + POOL_TTL_MS });
  if (poolCache.size > 256) {
    const cutoff = Date.now();
    for (const [k, v] of poolCache) if (v.expiresAt < cutoff) poolCache.delete(k);
  }
  return pool;
}

/* ── entrypoint ────────────────────────────────────────────────────────── */

export async function getTokenCandles(
  mint: string,
  interval: GtInterval,
  limit = 300,
): Promise<GtCandlesResult> {
  if (!features.markets) return { pool: null, candles: [] };
  const pool = await resolveTopPool(mint);
  if (!pool) return { pool: null, candles: [] };
  const { path, aggregate } = INTERVALS[interval];
  try {
    const res = await httpRequest(
      `${GT_BASE}/networks/${NETWORK}/pools/${encodeURIComponent(pool)}/ohlcv/${path}?aggregate=${aggregate}&limit=${Math.max(1, Math.min(1000, limit))}&currency=usd`,
      {
        vendor: 'geckoterminal',
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 8_000,
        maxAttempts: 2,
      },
    );
    if (!res.ok) return { pool, candles: [] };
    const data = (await res.json().catch(() => null)) as GtOhlcvPayload | null;
    const rows = data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(rows)) return { pool, candles: [] };
    return { pool, candles: mapOhlcvList(rows, mint, interval) };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), mint, pool, interval },
      'geckoterminal: ohlcv fetch failed',
    );
    return { pool, candles: [] };
  }
}

/**
 * Tradingview proxy — exposes Mathieu2301's @mathieuc/tradingview WS client
 * over REST so the Neo mobile app (and anything else) can fetch TV snapshots
 * + quotes without running Node themselves.
 *
 * Endpoints are public reads (no session auth) — the data isn't user-private
 * and matches the rest of `/markets/*` list shape. Rate limit is enforced
 * upstream by ipRateLimit on the app surface; an in-memory TTL cache here
 * dedupes hot symbols to keep TV happy.
 *
 * Failure modes:
 *   - tv_timeout / tv_error / tv_init_failed → 502
 *   - missing params → 400
 *   - cache hit → x-cache: HIT
 */

import { Hono } from 'hono';
import { ApiError } from '../lib/errors.js';
import {
  fetchTradingViewQuote,
  fetchTradingViewSnapshot,
  type TvSnapshot,
} from '../external/tradingview-client.js';

export const tvRoutes = new Hono();

type CacheEntry<T> = { value: T; expiresAt: number };
const snapshotCache = new Map<string, CacheEntry<TvSnapshot>>();
const quoteCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof fetchTradingViewQuote>>>>();

const MAX_CACHE_ENTRIES = 500;
const MAX_SYMBOL_LENGTH = 64;
const MAX_TIMEFRAME_LENGTH = 16;
const SNAPSHOT_TTL_MS = 30_000; // 30s — chart data refreshes slowly enough
const QUOTE_TTL_MS = 5_000;     // 5s  — quotes are tighter

function cleanParam(
  raw: string | null | undefined,
  name: 'symbol' | 'timeframe',
  fallback?: string,
): string {
  const value = raw?.trim() || fallback || '';
  if (!value) throw ApiError.badRequest(`${name}_required`);
  const max = name === 'symbol' ? MAX_SYMBOL_LENGTH : MAX_TIMEFRAME_LENGTH;
  if (value.length > max || !/^[A-Za-z0-9:._/!-]+$/.test(value)) {
    throw ApiError.badRequest(`invalid_${name}`);
  }
  return value;
}

function safeDecodeSymbol(raw: string | null | undefined): string | null | undefined {
  if (!raw) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw ApiError.badRequest('invalid_symbol');
  }
}

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const e = map.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    map.delete(key);
    return null;
  }
  return e.value;
}

function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) {
  if (map.has(key)) map.delete(key);
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (map.size > MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of map.entries()) if (v.expiresAt < now) map.delete(k);
    while (map.size > MAX_CACHE_ENTRIES) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) break;
      map.delete(oldest);
    }
  }
}

tvRoutes.get('/snapshot', async (c) => {
  const symbol = cleanParam(c.req.query('symbol'), 'symbol');
  const timeframe = cleanParam(c.req.query('timeframe'), 'timeframe', 'D');
  const rangeQ = Number(c.req.query('range') ?? 200);
  const range = Number.isFinite(rangeQ) && rangeQ > 0 && rangeQ <= 500 ? Math.floor(rangeQ) : 200;
  const key = `${symbol}|${timeframe}|${range}`;
  const cached = getCached(snapshotCache, key);
  if (cached) {
    c.header('x-cache', 'HIT');
    return c.json({ ok: true, source: 'tradingview-cache', ...cached });
  }
  try {
    const snap = await fetchTradingViewSnapshot(symbol, timeframe, range);
    setCached(snapshotCache, key, snap, SNAPSHOT_TTL_MS);
    c.header('x-cache', 'MISS');
    return c.json({ ok: true, source: 'tradingview', ...snap });
  } catch (e) {
    return c.json(
      { ok: false, error: { code: 'tv_unavailable', message: String(e instanceof Error ? e.message : e) } },
      502,
    );
  }
});

tvRoutes.get('/quote/:symbol', async (c) => {
  const raw = c.req.param('symbol');
  const symbol = cleanParam(safeDecodeSymbol(raw), 'symbol');
  const cached = getCached(quoteCache, symbol);
  if (cached) {
    c.header('x-cache', 'HIT');
    return c.json({ ok: true, source: 'tradingview-cache', ...cached });
  }
  try {
    const q = await fetchTradingViewQuote(symbol);
    setCached(quoteCache, symbol, q, QUOTE_TTL_MS);
    c.header('x-cache', 'MISS');
    return c.json({ ok: true, source: 'tradingview', ...q });
  } catch (e) {
    return c.json(
      { ok: false, error: { code: 'tv_unavailable', message: String(e instanceof Error ? e.message : e) } },
      502,
    );
  }
});

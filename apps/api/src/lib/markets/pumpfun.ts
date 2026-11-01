/**
 * Pump.fun discovery adapter — read-only proxy over the public
 * `frontend-api-v3.pump.fun/coins` endpoint. Returns the fullest meme list
 * with bonding-curve + post-migration tokens, market caps, images, and
 * social metadata.
 *
 * No auth required for read-only. Trading is handled by the Jupiter adapter
 * (Jupiter routes through PumpSwap so both bonding-curve and migrated tokens
 * trade through a single signing path).
 *
 * Why pump.fun for discovery + Jupiter for execution:
 *   - Pump.fun is the authoritative source for pump.fun-native tokens (richer
 *     metadata: image, replies, KOTH timestamp, bonding-curve reserves).
 *   - Jupiter exposes the same mints in its token API with USD prices and
 *     swap routing — but the metadata is sparser and the freshest tokens
 *     take a few minutes to show up there.
 *   - Routing trades through Jupiter gives the best fill price across
 *     PumpSwap, Raydium, Orca, Meteora, etc.
 *
 * Docs: https://docs.pump.fun (frontend API undocumented but stable).
 */

import { features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import { recordFetch } from '../sourced.js';
import { normalizeIpfsUrl } from './ipfs-url.js';

const PUMP_BASE = 'https://frontend-api-v3.pump.fun';

export type PumpSort =
  | 'created_timestamp'
  | 'last_trade_timestamp'
  | 'market_cap'
  | 'usd_market_cap'
  | 'reply_count'
  | 'king_of_the_hill_timestamp';

export interface PumpMeme {
  mint: string;
  name: string;
  symbol: string;
  description?: string | null;
  imageUrl?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
  /** True when bonding curve completed → migrated to Raydium/PumpSwap. */
  migrated: boolean;
  marketCapUsd: number | null;
  marketCapSol: number | null;
  virtualSolReserves: number | null;
  realSolReserves: number | null;
  totalSupply: string | null;
  createdAt: number | null;
  lastTradeAt: number | null;
  /** Pump's KOTH (king-of-the-hill) crowning timestamp; null when never crowned. */
  kingOfTheHillAt: number | null;
  /** Reply count on pump.fun's comment thread — proxy for social activity. */
  replyCount: number | null;
  raydiumPool?: string | null;
  bondingCurve?: string | null;
}

interface PumpRawCoin {
  mint?: string;
  name?: string;
  symbol?: string;
  description?: string;
  image_uri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  complete?: boolean;
  market_cap?: number;
  usd_market_cap?: number;
  virtual_sol_reserves?: number;
  real_sol_reserves?: number;
  total_supply?: number;
  total_supply_str?: string;
  created_timestamp?: number;
  last_trade_timestamp?: number;
  king_of_the_hill_timestamp?: number;
  reply_count?: number;
  raydium_pool?: string | null;
  bonding_curve?: string;
  nsfw?: boolean;
  is_banned?: boolean;
}

type MarketDataSource = 'live' | 'provider-demo';

export interface PumpListResult {
  source: MarketDataSource;
  memes: PumpMeme[];
}

const DEMO_MEMES: readonly PumpMeme[] = [
  {
    mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
    name: 'Fartcoin',
    symbol: 'FARTCOIN',
    imageUrl: 'https://ipfs.io/ipfs/QmQr3Fz4h1etNsF7oLGMRHiCzhB5y9a7GjyodnF7zLHK1g',
    twitter: 'https://x.com/fartcoinofsol',
    migrated: true,
    marketCapUsd: 1_250_000_000,
    marketCapSol: null,
    virtualSolReserves: null,
    realSolReserves: null,
    totalSupply: '999978899969322',
    createdAt: 1729231506539,
    lastTradeAt: null,
    kingOfTheHillAt: 1729231563000,
    replyCount: 14017,
    raydiumPool: null,
    bondingCurve: null,
    description: null,
    telegram: null,
    website: null,
  },
];

function mapCoin(raw: PumpRawCoin): PumpMeme | null {
  const mint = raw?.mint?.trim();
  const symbol = raw?.symbol?.trim();
  if (!mint || !symbol) return null;
  if (raw.is_banned) return null;
  return {
    mint,
    name: raw.name?.trim() || symbol,
    symbol,
    description: raw.description?.trim() ?? null,
    // Older pump.fun metadata pins images to Cloudflare's dead IPFS
    // gateways — rewrite onto a live one (ERR_NAME_NOT_RESOLVED, 2026-07-06).
    imageUrl: normalizeIpfsUrl(raw.image_uri?.trim() ?? null),
    twitter: raw.twitter?.trim() ?? null,
    telegram: raw.telegram?.trim() ?? null,
    website: raw.website?.trim() ?? null,
    migrated: raw.complete === true,
    marketCapUsd: typeof raw.usd_market_cap === 'number' ? raw.usd_market_cap : null,
    marketCapSol: typeof raw.market_cap === 'number' ? raw.market_cap : null,
    virtualSolReserves: typeof raw.virtual_sol_reserves === 'number' ? raw.virtual_sol_reserves : null,
    realSolReserves: typeof raw.real_sol_reserves === 'number' ? raw.real_sol_reserves : null,
    totalSupply: raw.total_supply_str ?? (raw.total_supply != null ? String(raw.total_supply) : null),
    createdAt: typeof raw.created_timestamp === 'number' ? raw.created_timestamp : null,
    lastTradeAt: typeof raw.last_trade_timestamp === 'number' ? raw.last_trade_timestamp : null,
    kingOfTheHillAt: typeof raw.king_of_the_hill_timestamp === 'number' ? raw.king_of_the_hill_timestamp : null,
    replyCount: typeof raw.reply_count === 'number' ? raw.reply_count : null,
    raydiumPool: raw.raydium_pool ?? null,
    bondingCurve: raw.bonding_curve ?? null,
  };
}

function demo(): PumpMeme[] {
  return DEMO_MEMES.map((m) => ({ ...m }));
}

/**
 * pump.fun removed `usd_market_cap` from /coins sort validation — the exact
 * query 400s upstream as of 2026-07-02 (prod evidence: Sentry
 * JAVASCRIPT-NEXTJS-2K, reproduced from a second vantage point). USD and SOL
 * market cap rank identically (same quantity, different unit), so the legacy
 * key maps to `market_cap`. It stays in the public `PumpSort` union so
 * existing clients sending it keep working.
 */
export function upstreamSort(sort: PumpSort): Exclude<PumpSort, 'usd_market_cap'> {
  return sort === 'usd_market_cap' ? 'market_cap' : sort;
}

export class PumpFunAdapter {
  get isLive(): boolean {
    return features.markets;
  }

  /**
   * List pump.fun tokens with sort + filters. Defaults to the top-by-usd-mcap
   * view that mirrors the homepage. `migratedOnly=true` filters to graduated
   * tokens (those tradable on Raydium/PumpSwap via Jupiter aggregation).
   * `migratedOnly=false` keeps both bonding-curve and migrated tokens.
   */
  async list(opts: {
    sort?: PumpSort;
    limit?: number;
    offset?: number;
    migratedOnly?: boolean;
    includeNsfw?: boolean;
  } = {}): Promise<PumpListResult> {
    if (!this.isLive) return { source: 'provider-demo', memes: demo() };
    const sort = upstreamSort(opts.sort ?? 'market_cap');
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const url = new URL(`${PUMP_BASE}/coins`);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sort', sort);
    url.searchParams.set('order', 'DESC');
    url.searchParams.set('includeNsfw', String(Boolean(opts.includeNsfw)));
    try {
      const res = await httpRequest(url.toString(), {
        vendor: 'pumpfun',
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        log.warn({ status: res.status, sort, limit, offset }, 'pumpfun: list rejected — demo fallback');
        recordFetch('pumpfun', 'market-list', 'provider-demo');
        return { source: 'provider-demo', memes: demo() };
      }
      const data = (await res.json().catch(() => null)) as PumpRawCoin[] | { coins?: PumpRawCoin[] } | null;
      const rows = Array.isArray(data) ? data : Array.isArray(data?.coins) ? data.coins : [];
      const memes = rows
        .map(mapCoin)
        .filter((m): m is PumpMeme => m !== null)
        .filter((m) => (opts.migratedOnly ? m.migrated : true));
      recordFetch('pumpfun', 'market-list', memes.length > 0 ? 'live' : 'provider-demo');
      return memes.length > 0
        ? { source: 'live', memes }
        : { source: 'provider-demo', memes: demo() };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), sort },
        'pumpfun: list unreachable — demo fallback',
      );
      recordFetch('pumpfun', 'market-list', 'provider-demo');
      return { source: 'provider-demo', memes: demo() };
    }
  }

  async getCoin(mint: string): Promise<PumpMeme | null> {
    if (!this.isLive) return null;
    const trimmed = mint.trim();
    if (!trimmed) return null;
    try {
      const res = await httpRequest(`${PUMP_BASE}/coins/${encodeURIComponent(trimmed)}`, {
        vendor: 'pumpfun',
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 6_000,
        maxAttempts: 2,
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as PumpRawCoin | null;
      return data ? mapCoin(data) : null;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), mint: trimmed },
        'pumpfun: getCoin failed',
      );
      return null;
    }
  }
}

export const pumpfun = new PumpFunAdapter();

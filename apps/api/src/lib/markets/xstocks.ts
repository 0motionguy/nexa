/**
 * xStocks adapter — Backed Finance tokenized equities + ETFs on Solana.
 *
 * Filters Jupiter's verified token set for tokens whose name ends with
 * " xStock" (Backed's canonical naming). Returns a clean ticker + display
 * name list with USD price, mcap, 24h stats, and the canonical SPL mint.
 *
 * Trading is done through Jupiter Swap (already wired) — xStocks are
 * normal SPL Token-2022 mints that route through PumpSwap / Raydium /
 * Orca / Meteora pools, exactly like any other Solana token. The only
 * thing this adapter adds is the curation + the ticker-without-x label.
 *
 * Primary market (mint / redeem against the underlying share) is gated
 * behind KYC on backed.fi — we do NOT touch that path. We trade purely
 * the secondary market that's permissionless on Solana DEXes.
 */

import { features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';

const JUPITER_BASE = 'https://lite-api.jup.ag';

export type XStockCategory = 'stock' | 'etf' | 'commodity' | 'crypto-adjacent';

export interface XStock {
  /** SPL mint address — canonical Backed Finance Token-2022 mint. */
  mint: string;
  /** Bare ticker without the `x` suffix (e.g. "AAPL" from "AAPLx"). */
  ticker: string;
  /** Full xStock symbol as it appears on Jupiter (e.g. "AAPLx"). */
  symbolX: string;
  /** Display name without " xStock" suffix (e.g. "Apple"). */
  name: string;
  category: XStockCategory;
  icon: string | null;
  decimals: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  priceChange24h: number | null;
  volume24hUsd: number | null;
  tags: string[];
}

interface JupRawStats {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
}

interface JupRawToken {
  id?: string;
  symbol?: string;
  name?: string;
  icon?: string;
  decimals?: number;
  usdPrice?: number;
  mcap?: number;
  liquidity?: number;
  holderCount?: number;
  tags?: string[];
  stats24h?: JupRawStats;
}

type MarketDataSource = 'live' | 'provider-demo';

export interface XStockListResult {
  source: MarketDataSource;
  stocks: XStock[];
}

/**
 * ETF tickers we treat as ETFs vs single stocks. Everything else from the
 * Backed catalog is a single stock or commodity tracker.
 */
const ETF_TICKERS = new Set([
  'SPY', 'QQQ', 'TQQQ', 'GLD', 'SLV', 'XLE', 'XLF', 'XLK', 'IWM', 'VOO', 'VTI',
]);

/** Crypto-adjacent listings on Backed (HOOD, COIN, MSTR, CRCL, etc.). */
const CRYPTO_ADJACENT_TICKERS = new Set([
  'HOOD', 'COIN', 'MSTR', 'CRCL', 'STRC', 'SPCX', 'DFDV', 'MARA', 'RIOT',
]);

/** Commodity proxies on Backed. */
const COMMODITY_TICKERS = new Set(['GLD', 'SLV', 'GOLD', 'SILVER']);

function classifyXStock(ticker: string): XStockCategory {
  const upper = ticker.toUpperCase();
  if (COMMODITY_TICKERS.has(upper)) return 'commodity';
  if (ETF_TICKERS.has(upper)) return 'etf';
  if (CRYPTO_ADJACENT_TICKERS.has(upper)) return 'crypto-adjacent';
  return 'stock';
}

/** Demo set — used when markets are disabled or the Jupiter API is unreachable. */
const DEMO_XSTOCKS: readonly XStock[] = [
  { mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', ticker: 'AAPL', symbolX: 'AAPLx', name: 'Apple', category: 'stock', icon: null, decimals: 8, priceUsd: 295.79, marketCapUsd: 45_632_085, liquidityUsd: null, holderCount: null, priceChange24h: null, volume24hUsd: null, tags: ['verified', 'token-2022', 'moonshot-verified'] },
  { mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', ticker: 'TSLA', symbolX: 'TSLAx', name: 'Tesla', category: 'stock', icon: null, decimals: 8, priceUsd: 402.07, marketCapUsd: 92_155_584, liquidityUsd: null, holderCount: null, priceChange24h: null, volume24hUsd: null, tags: ['verified', 'token-2022'] },
  { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', ticker: 'NVDA', symbolX: 'NVDAx', name: 'NVIDIA', category: 'stock', icon: null, decimals: 8, priceUsd: 209.24, marketCapUsd: 67_073_011, liquidityUsd: null, holderCount: null, priceChange24h: null, volume24hUsd: null, tags: ['verified', 'token-2022'] },
  { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', ticker: 'SPY', symbolX: 'SPYx', name: 'SP500', category: 'etf', icon: null, decimals: 8, priceUsd: 5840, marketCapUsd: 71_455_840, liquidityUsd: null, holderCount: null, priceChange24h: null, volume24hUsd: null, tags: ['verified', 'token-2022'] },
];

function demo(): XStock[] {
  return DEMO_XSTOCKS.map((s) => ({ ...s, tags: [...s.tags] }));
}

function mapJupRow(raw: JupRawToken): XStock | null {
  if (!raw?.id || !raw?.symbol) return null;
  const symbolX = raw.symbol;
  const name = (raw.name ?? '').trim();
  // Match Backed Finance canonical pattern: name ends with " xStock" and
  // symbol ends with lowercase x.
  if (!name.endsWith(' xStock') && !name.endsWith(' xstock')) return null;
  if (!/[A-Z0-9.]x$/i.test(symbolX)) return null;
  const ticker = symbolX.replace(/x$/i, '').toUpperCase();
  const cleanName = name.replace(/ xStock$/i, '').trim();
  const stats = raw.stats24h ?? {};
  const buy = typeof stats.buyVolume === 'number' ? stats.buyVolume : 0;
  const sell = typeof stats.sellVolume === 'number' ? stats.sellVolume : 0;
  const volume24h = buy + sell > 0 ? buy + sell : null;
  return {
    mint: raw.id,
    ticker,
    symbolX,
    name: cleanName,
    category: classifyXStock(ticker),
    icon: raw.icon?.trim() || null,
    decimals: typeof raw.decimals === 'number' ? raw.decimals : 8,
    priceUsd: typeof raw.usdPrice === 'number' ? raw.usdPrice : null,
    marketCapUsd: typeof raw.mcap === 'number' ? raw.mcap : null,
    liquidityUsd: typeof raw.liquidity === 'number' ? raw.liquidity : null,
    holderCount: typeof raw.holderCount === 'number' ? raw.holderCount : null,
    priceChange24h: typeof stats.priceChange === 'number' ? stats.priceChange : null,
    volume24hUsd: volume24h,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

export class XStocksAdapter {
  get isLive(): boolean {
    return features.markets;
  }

  /**
   * List xStocks — filters Jupiter's verified set for Backed Finance
   * tokenized equities. Sorted by market cap desc.
   */
  async list(opts: { category?: XStockCategory; limit?: number; offset?: number } = {}): Promise<XStockListResult> {
    if (!this.isLive) return { source: 'provider-demo', stocks: demo() };
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    try {
      const res = await httpRequest(`${JUPITER_BASE}/tokens/v2/tag?query=verified`, {
        vendor: 'jupiter',
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        log.warn({ status: res.status }, 'xstocks: jupiter verified rejected — demo fallback');
        return { source: 'provider-demo', stocks: demo() };
      }
      const data = (await res.json().catch(() => null)) as JupRawToken[] | null;
      if (!Array.isArray(data)) return { source: 'provider-demo', stocks: demo() };
      const all = data
        .map(mapJupRow)
        .filter((s): s is XStock => s !== null)
        .filter((s) => (opts.category ? s.category === opts.category : true))
        .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
      const sliced = all.slice(offset, offset + limit);
      return sliced.length > 0
        ? { source: 'live', stocks: sliced }
        : { source: 'provider-demo', stocks: demo() };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'xstocks: list unreachable — demo fallback',
      );
      return { source: 'provider-demo', stocks: demo() };
    }
  }

  /** Look up a single xStock by its mint. Returns null when not found. */
  async getStock(mint: string): Promise<XStock | null> {
    const m = mint.trim();
    if (!m) return null;
    const all = await this.list({ limit: 500 });
    return all.stocks.find((s) => s.mint === m) ?? null;
  }
}

export const xstocks = new XStocksAdapter();

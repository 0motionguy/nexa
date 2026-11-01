/**
 * Hyperliquid HIP-3 adapter — tokenized equities + commodities + FX via
 * permissionless builder-deployed perps. Specifically wired for the `xyz`
 * DEX (trade.xyz by Hyperunit) which holds ~90% of HIP-3 open interest
 * and ships markets for the major US tickers, an S&P 500 perp, and global
 * indices / commodities / FX.
 *
 * All reads use the same /info endpoint as the canonical perps, just with
 * `dex: 'xyz'` on the payload. The `allMids` WebSocket subscription also
 * accepts `{type: 'allMids', dex: 'xyz'}` and streams 93 mid prices keyed
 * by `xyz:AAPL` etc.
 *
 * Order placement on a HIP-3 DEX uses the same /exchange endpoint with the
 * builder-perp asset-id offset used by trade.xyz:
 * assetId = 100_000 + 10_000 * perpDexIndex + universe_index.
 *
 * HIP-3 markets settle on a per-dex clearinghouse separate from the core
 * perp account, so the adapter funds the `xyz` dex core→dex with a
 * `sendAsset` user-signed action before the first order (see ensureDexFunded).
 * The older `userSetAbstraction`/`dexAbstraction` auto-collateral toggle is
 * deprecated on Hyperliquid and is NOT used.
 *
 * Docs:
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3
 */

import { randomBytes } from 'node:crypto';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import { SendAssetTypes } from '@nktkas/hyperliquid/api/exchange';
import {
  HL_HYPERLIQUID_CHAIN,
  HL_USER_SIGN_CHAIN_ID,
  hlSignL1Action,
  hlSignUserSignedAction,
  nextHlNonce,
} from './hl-signer.js';
import { formatHlPerpPx, formatHlSize } from './hl-format.js';
import { HL_USDC_TOKEN } from './hyperliquid.js';
import { HL_INFO_URL, HL_EXCHANGE_URL, isHlRegionAllowed } from './hl-config.js';

const INFO_URL = HL_INFO_URL;
const EXCHANGE_URL = HL_EXCHANGE_URL;

/** Canonical HIP-3 DEX we route to. `xyz` is the trade.xyz builder. */
export const HIP3_DEX_NAME = 'xyz';

const HIP3_VISIBLE_LIMIT = 500;
const HIP3_BUILDER_FEE_CAP_TENTHS_BP = 100; // Hyperliquid max: 10 bps.

/* Geo blocklist — shared module (hl-config.ts), same ToS as perps/spot. */

export class Hip3RateLimitError extends Error {
  constructor(public retryAfter: string | null = null) {
    super('hip3_rate_limited');
    this.name = 'Hip3RateLimitError';
  }
}

async function hip3Fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 429) throw new Hip3RateLimitError(res.headers.get('Retry-After'));
  return res;
}

export function isHip3RegionAllowed(country: string | null): boolean {
  return isHlRegionAllowed(country);
}

/**
 * Categorize a HIP-3 coin into a tradable asset class. Helps the UI tab the
 * list ("Stocks" / "Indices" / "Commodities" / "FX") without needing a
 * separate metadata feed.
 */
export type Hip3Category = 'stock' | 'index' | 'commodity' | 'fx' | 'other';

/** Static classifier for the xyz universe — covers all 93 markets at launch. */
const HIP3_CATEGORY_MAP: Record<string, Hip3Category> = {
  // Indices
  XYZ100: 'index', SP500: 'index', NIFTY: 'index', JP225: 'index', KR200: 'index',
  IBOV: 'index', EWJ: 'index', EWT: 'index', EWY: 'index', EWZ: 'index',
  XLE: 'index', SMH: 'index', URNM: 'index', SPCX: 'index', H100: 'index',
  VIX: 'index', VOL: 'index', CBRS: 'index', LITE: 'index',
  // Commodities
  GOLD: 'commodity', SILVER: 'commodity', PLATINUM: 'commodity', PALLADIUM: 'commodity',
  COPPER: 'commodity', ALUMINIUM: 'commodity', URANIUM: 'commodity',
  CL: 'commodity', BRENTOIL: 'commodity', NATGAS: 'commodity', TTF: 'commodity',
  CORN: 'commodity', WHEAT: 'commodity',
  // FX
  EUR: 'fx', GBP: 'fx', JPY: 'fx', KRW: 'fx', NOK: 'fx', DXY: 'fx',
  // Everything else is treated as a stock — covers AAPL, TSLA, NVDA, MSFT,
  // META, AMZN, GOOGL, COIN, HOOD, MSTR, PLTR, MU, INTC, AMD, AVGO, ASML,
  // BABA, IBM, ORCL, NFLX, QCOM, MRVL, BX, COST, KIOXIA, NBIS, LLY, ARM,
  // SMSN, HYUNDAI, SOFTBANK, ZHIPU, MINIMAX, BIRD, BB, BE, GME, DKNG, EBAY,
  // RIVN, RKLB, USAR, WDC, SNDK, SKHX, NOW, QNT, PURRDAT, DELL, CRCL, CRWV.
};

export function classifyHip3(coin: string): Hip3Category {
  const ticker = coin.startsWith(`${HIP3_DEX_NAME}:`) ? coin.slice(HIP3_DEX_NAME.length + 1) : coin;
  return HIP3_CATEGORY_MAP[ticker.toUpperCase()] ?? 'stock';
}

export interface Hip3Market {
  /** Full coin key with the `xyz:` prefix, e.g. "xyz:AAPL". */
  coin: string;
  /** Bare ticker without the DEX prefix, e.g. "AAPL". */
  ticker: string;
  /** Display name resolved via the static category map. */
  category: Hip3Category;
  priceUsd: number;
  change24hPct: number | null;
  /** Max leverage offered by trade.xyz on this market. */
  maxLeverage?: number | null;
  dayVolumeUsd?: number | null;
  openInterest?: number | null;
  fundingRate?: number | null;
  /** Universe index — used to compute the order asset id. */
  index: number;
  /** Native size decimals required by Hyperliquid order wires. */
  szDecimals?: number | null;
}

export interface Hip3OrderInput {
  privyWalletId: string | null;
  privyWalletAddress: `0x${string}` | null;
  /** Either the full "xyz:AAPL" or the bare "AAPL" ticker. */
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  leverage: number;
  orderType?: 'market' | 'limit';
  limitPriceUsd?: number;
  tif?: 'Ioc' | 'Gtc' | 'Alo';
  reduceOnly?: boolean;
}

export interface Hip3OrderResult {
  orderId: string;
  filledQtyUsd: number;
  entryPriceUsd: number;
  demo: boolean;
  state?: 'filled' | 'resting';
}

type Hip3VenueOrderStatus = {
  resting?: { oid?: number };
  filled?: { oid?: number; avgPx?: string; px?: string };
  error?: string;
};

function venueStatusError(status: unknown): string | null {
  if (typeof status === 'string') return status === 'success' ? null : status;
  if (status && typeof status === 'object' && 'error' in status) {
    const error = (status as { error?: unknown }).error;
    return typeof error === 'string' && error.trim() ? error : 'venue_error';
  }
  return null;
}

function assertVenueStatusOk(status: unknown, code: string): void {
  const error = venueStatusError(status);
  if (error) throw new Error(`${code}:${error}`);
}

export interface Hip3Position {
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  entryPriceUsd: number;
  /** Clearinghouse-marked unrealized PnL (display path). */
  unrealizedPnlUsd: number;
  /** Position leverage (cross/isolated value); 1 when absent. */
  leverage: number;
}

/** Raw `assetPositions[].position` shape from clearinghouseState (dex:xyz). */
interface Hip3RawPosition {
  coin?: string;
  szi?: string;
  entryPx?: string;
  unrealizedPnl?: string;
  leverage?: { value?: number };
}

/** Map one raw clearinghouse position → Hip3Position, or null when flat. */
function parseHip3Position(p: Hip3RawPosition | undefined): Hip3Position | null {
  if (!p?.coin) return null;
  const szi = Number(p.szi ?? '0');
  if (!Number.isFinite(szi) || szi === 0) return null;
  const entry = Number(p.entryPx ?? '0');
  const upnl = Number(p.unrealizedPnl ?? '0');
  const lev = Number(p.leverage?.value ?? 1);
  const entryUsd = Number.isFinite(entry) ? entry : 0;
  return {
    coin: p.coin,
    sideLong: szi > 0,
    qtyUsd: Math.abs(szi) * entryUsd,
    entryPriceUsd: entryUsd,
    unrealizedPnlUsd: Number.isFinite(upnl) ? upnl : 0,
    leverage: Number.isFinite(lev) && lev > 0 ? lev : 1,
  };
}

/**
 * Builder-dex clearinghouse money truth (display path). `equityUsd` is
 * marginSummary.accountValue — collateral ± uPnL, NEVER position notional
 * (a 20x cross position contributes its margin, not qtyUsd, to net worth).
 * `positions` are the open trade.xyz stock-perp rows (portfolio display).
 */
export interface Hip3UserState {
  equityUsd: number;
  withdrawableUsd: number;
  unrealizedPnlUsd: number;
  positions: Hip3Position[];
}

interface Hip3UniverseAsset {
  szDecimals?: number;
  name?: string;
  maxLeverage?: number | string;
  isDelisted?: boolean;
}

interface Hip3AssetCtx {
  markPx?: string;
  midPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  openInterest?: string;
  funding?: string;
}

type Hip3MetaAndAssetCtxs = [
  { universe?: Hip3UniverseAsset[] },
  Hip3AssetCtx[],
];

type MarketDataSource = 'live' | 'provider-demo';

export interface Hip3MarketsResult {
  source: MarketDataSource;
  markets: Hip3Market[];
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n !== null && n > 0 ? n : null;
}

function configuredBuilderFeeTenths(): number {
  const raw = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0;
  return Math.max(0, Math.min(HIP3_BUILDER_FEE_CAP_TENTHS_BP, raw));
}

function configuredBuilder(): { b: `0x${string}`; f: number } | undefined {
  const feeTenths = configuredBuilderFeeTenths();
  if (!env.HL_BUILDER_ADDRESS || feeTenths <= 0) return undefined;
  return {
    b: env.HL_BUILDER_ADDRESS.toLowerCase() as `0x${string}`,
    f: feeTenths,
  };
}

function pctChange(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}


/** Stable demo sample — used when markets are disabled or the API is unreachable. */
const DEMO_HIP3: readonly Hip3Market[] = [
  { coin: 'xyz:AAPL', ticker: 'AAPL', category: 'stock', priceUsd: 295.79, change24hPct: null, maxLeverage: 20, dayVolumeUsd: 1_385_270, index: 4 },
  { coin: 'xyz:TSLA', ticker: 'TSLA', category: 'stock', priceUsd: 402.07, change24hPct: null, maxLeverage: 20, dayVolumeUsd: 8_500_000, index: 1 },
  { coin: 'xyz:NVDA', ticker: 'NVDA', category: 'stock', priceUsd: 209.24, change24hPct: null, maxLeverage: 20, dayVolumeUsd: 3_185_168, index: 2 },
  { coin: 'xyz:SP500', ticker: 'SP500', category: 'index', priceUsd: 5840, change24hPct: null, maxLeverage: 30, dayVolumeUsd: 20_000_000, index: 76 },
  { coin: 'xyz:GOLD', ticker: 'GOLD', category: 'commodity', priceUsd: 2742, change24hPct: null, maxLeverage: 30, dayVolumeUsd: 15_000_000, index: 33 },
];

function mapMetaAndAssetCtxs(data: Hip3MetaAndAssetCtxs | null): Hip3Market[] {
  if (!Array.isArray(data) || data.length < 2) return [];
  const [meta, ctxs] = data;
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  if (!Array.isArray(ctxs) || universe.length === 0) return [];

  const markets: Hip3Market[] = [];
  for (let i = 0; i < universe.length; i++) {
    const asset = universe[i];
    const ctx = ctxs[i];
    if (!asset || !ctx || asset.isDelisted === true) continue;
    const coin = String(asset.name ?? '').trim();
    if (!coin) continue;
    const priceUsd = positiveNumberOrNull(ctx.markPx) ?? positiveNumberOrNull(ctx.midPx);
    if (priceUsd === null) continue;
    const ticker = coin.startsWith(`${HIP3_DEX_NAME}:`)
      ? coin.slice(HIP3_DEX_NAME.length + 1).toUpperCase()
      : coin.toUpperCase();
    markets.push({
      coin,
      ticker,
      category: classifyHip3(coin),
      priceUsd,
      change24hPct: pctChange(priceUsd, positiveNumberOrNull(ctx.prevDayPx)),
      maxLeverage: numberOrNull(asset.maxLeverage),
      dayVolumeUsd: numberOrNull(ctx.dayNtlVlm),
      openInterest: numberOrNull(ctx.openInterest),
      fundingRate: numberOrNull(ctx.funding),
      index: i,
      szDecimals: numberOrNull(asset.szDecimals),
    });
  }
  return markets.sort((a, b) => (b.dayVolumeUsd ?? 0) - (a.dayVolumeUsd ?? 0));
}

function demo(): Hip3Market[] {
  return DEMO_HIP3.map((m) => ({ ...m }));
}

export class HyperliquidHip3Adapter {
  get isLive(): boolean {
    return features.markets;
  }

  get isLiveTrading(): boolean {
    return Boolean(features.markets && features.privy);
  }

  async getMarketsResult(limit = HIP3_VISIBLE_LIMIT): Promise<Hip3MarketsResult> {
    if (!this.isLive) return { source: 'provider-demo', markets: demo() };
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: HIP3_DEX_NAME }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'hyperliquid-hip3: metaAndAssetCtxs rejected — demo fallback');
        return { source: 'provider-demo', markets: demo() };
      }
      const data = (await res.json().catch(() => null)) as Hip3MetaAndAssetCtxs | null;
      const all = mapMetaAndAssetCtxs(data);
      const sliced = Number.isFinite(limit) && limit > 0 ? all.slice(0, Math.floor(limit)) : all;
      return sliced.length > 0
        ? { source: 'live', markets: sliced }
        : { source: 'provider-demo', markets: demo() };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-hip3: metaAndAssetCtxs unreachable — demo fallback',
      );
      return { source: 'provider-demo', markets: demo() };
    }
  }

  async getMarkets(limit = HIP3_VISIBLE_LIMIT): Promise<Hip3Market[]> {
    return (await this.getMarketsResult(limit)).markets;
  }

  /** Look up a single market by either `xyz:AAPL` or bare `AAPL`. */
  async getMarket(coin: string): Promise<Hip3Market | null> {
    const want = coin.trim();
    if (!want) return null;
    const full = want.includes(':') ? want : `${HIP3_DEX_NAME}:${want.toUpperCase()}`;
    const markets = await this.getMarkets(Number.POSITIVE_INFINITY);
    return markets.find((m) => m.coin.toLowerCase() === full.toLowerCase()) ?? null;
  }

  /**
   * Candle snapshot for a HIP-3 coin. Same shape + endpoint as the canonical
   * `getCandles` — HL routes by the coin name (`xyz:AAPL`) without needing
   * an explicit dex on the candle request.
   */
  async getCandles(
    coin: string,
    interval: string = '1h',
    lookbackMs: number = 24 * 60 * 60 * 1000,
    endMs?: number,
  ): Promise<Array<{ t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }>> {
    if (!this.isLive) return [];
    const full = coin.includes(':') ? coin : `${HIP3_DEX_NAME}:${coin.toUpperCase()}`;
    // Optional `endMs` pages OLDER history (`[end - lookback, end]`) on
    // left-scroll; default is the live window.
    const endTime = Number.isFinite(endMs as number) && (endMs as number) > 0 ? Math.floor(endMs as number) : Date.now();
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin: full, interval, startTime: endTime - lookbackMs, endTime },
        }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as unknown;
      return Array.isArray(data)
        ? (data as Array<{ t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }>)
        : [];
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), coin: full },
        'hyperliquid-hip3: candleSnapshot failed',
      );
      return [];
    }
  }

  /** allMids proxy for the xyz DEX. Returns `{ "xyz:AAPL": "295.79", ... }`. */
  async getAllMids(): Promise<Record<string, string>> {
    if (!this.isLive) return {};
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'allMids', dex: HIP3_DEX_NAME }),
        timeoutMs: 5_000,
        maxAttempts: 2,
      });
      if (!res.ok) return {};
      const data = (await res.json().catch(() => null)) as Record<string, string> | null;
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-hip3: allMids failed',
      );
      return {};
    }
  }

  /** Asset id cache keyed by lowercase coin name. */
  private assetIdCache: Map<string, number> | null = null;

  private async resolveAssetIdOffset(): Promise<number | null> {
    try {
      const res = await hip3Fetch(INFO_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'perpDexs' }),
      });
      if (!res.ok) return null;
      const dexs = (await res.json().catch(() => null)) as Array<{ name?: string } | null> | null;
      const dexIndex = Array.isArray(dexs)
        ? dexs.findIndex((dex) => dex?.name === HIP3_DEX_NAME)
        : -1;
      return dexIndex >= 0 ? 100_000 + dexIndex * 10_000 : null;
    } catch (e) {
      if (e instanceof Hip3RateLimitError) throw e;
      return null;
    }
  }

  private async resolveAssetId(coin: string): Promise<number | null> {
    const full = coin.includes(':') ? coin : `${HIP3_DEX_NAME}:${coin.toUpperCase()}`;
    if (!this.assetIdCache) {
      try {
        const offset = await this.resolveAssetIdOffset();
        if (offset == null) return null;
        const res = await hip3Fetch(INFO_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'meta', dex: HIP3_DEX_NAME }),
        });
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as { universe?: Array<{ name?: string }> } | null;
        const map = new Map<string, number>();
        data?.universe?.forEach((u, i) => {
          if (u.name) map.set(u.name.toLowerCase(), offset + i);
        });
        this.assetIdCache = map;
      } catch (e) {
        if (e instanceof Hip3RateLimitError) throw e;
        return null;
      }
    }
    return this.assetIdCache.get(full.toLowerCase()) ?? null;
  }

  /**
   * Free `withdrawable` collateral (USDC) in a HL clearinghouse. Pass the
   * `xyz` dex to read the per-dex account, or `undefined` for the core perp
   * account (the source of core→dex funding).
   */
  private async clearinghouseWithdrawable(
    user: `0x${string}`,
    dex?: string,
  ): Promise<number> {
    try {
      const res = await hip3Fetch(INFO_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user, ...(dex ? { dex } : {}) }),
      });
      if (!res.ok) return 0;
      const data = (await res.json().catch(() => null)) as
        | { withdrawable?: string; marginSummary?: { accountValue?: string } }
        | null;
      const wd = Number(data?.withdrawable ?? data?.marginSummary?.accountValue ?? 0);
      return Number.isFinite(wd) ? wd : 0;
    } catch (e) {
      if (e instanceof Hip3RateLimitError) throw e;
      return 0;
    }
  }

  /**
   * Ensure the user's `xyz`-dex perp account holds at least `requiredUsd` of
   * free margin before the first order. HIP-3 markets settle on a per-dex
   * clearinghouse that is separate from the core perp account, so collateral
   * must be moved core→dex with a `sendAsset` user-signed action (source dex
   * `''` = the core USDC perp account). This is what trade.xyz does; the old
   * `userSetAbstraction` "dexAbstraction" toggle is deprecated and its
   * "Must deposit before performing actions" rejection was an unfunded-dex
   * symptom, not a signature error. Verified live 2026-07-04 (AAPL oid
   * 487335769961 filled after a $3 core→xyz sendAsset).
   */
  private async ensureDexFunded(
    walletId: string,
    walletAddress: `0x${string}`,
    requiredUsd: number,
  ): Promise<void> {
    const have = await this.clearinghouseWithdrawable(walletAddress, HIP3_DEX_NAME);
    if (have >= requiredUsd) return;
    // Cap the move at the core account's free balance so funding can't be
    // rejected with "Insufficient balance for withdrawal". Moving less than the
    // full shortfall is fine: HIP-3 cross-margin locks only notional/maxLeverage
    // (a fraction of requiredUsd), so a partial top-up still lets the order fill;
    // a truly empty core account surfaces as a clear order-side margin error.
    const coreFree = await this.clearinghouseWithdrawable(walletAddress);
    const shortfall = Math.ceil((requiredUsd - have) * 100) / 100;
    const moveUsd = Math.floor(Math.min(shortfall, coreFree) * 100) / 100;
    if (!(moveUsd > 0)) return;
    const nonce = nextHlNonce();
    const action = {
      type: 'sendAsset' as const,
      signatureChainId: HL_USER_SIGN_CHAIN_ID,
      hyperliquidChain: HL_HYPERLIQUID_CHAIN,
      destination: walletAddress.toLowerCase() as `0x${string}`,
      sourceDex: '',
      destinationDex: HIP3_DEX_NAME,
      token: HL_USDC_TOKEN,
      amount: String(moveUsd),
      fromSubAccount: '',
      nonce,
    };
    const signature = await hlSignUserSignedAction({
      walletId,
      walletAddress,
      action,
      types: SendAssetTypes,
    });
    const res = await hip3Fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature }),
    });
    if (!res.ok) throw new Error('dex_funding_rejected');
    const data = (await res.json().catch(() => ({}))) as { status?: string; response?: unknown };
    if (data.status !== 'ok') {
      log.warn({ data, moveUsd }, 'hyperliquid-hip3: dex funding rejected');
      throw new Error('dex_funding_rejected');
    }
    // Give the venue a moment to credit the dex account before the order.
    await new Promise((r) => setTimeout(r, 1200));
  }

  /**
   * Place an order on a HIP-3 market. Demo path returns a synthetic
   * `hip3_demo_*` id; live path signs and submits via /exchange.
   *
   * The adapter funds the per-dex clearinghouse (core→`xyz` `sendAsset`) before
   * the first live order when the dex account is short of the required margin.
   */
  async placeOrder(input: Hip3OrderInput): Promise<Hip3OrderResult> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      const market = await this.getMarket(input.coin);
      const entry = market?.priceUsd ?? 0;
      return {
        orderId: 'hip3_demo_' + hex(8),
        filledQtyUsd: input.qtyUsd,
        entryPriceUsd: entry,
        demo: true,
        state: input.orderType === 'limit' && (input.tif ?? 'Gtc') !== 'Ioc' ? 'resting' : 'filled',
      };
    }
    try {
      const tif = input.tif ?? (input.orderType === 'limit' ? 'Gtc' : 'Ioc');

      // Fund the per-dex clearinghouse before the first order. Initial margin
      // is notional / effectiveLeverage; HIP-3 stock perps run high leverage
      // (cross, up to ~20x), so floor the divisor at 5 to avoid grossly
      // over-funding when the client omits leverage (defaults to 1). Add a 10%
      // buffer; ensureDexFunded moves only the shortfall, capped at the core
      // account's free balance, and is a no-op once the dex is capitalized.
      const marginNeed =
        Math.ceil((input.qtyUsd / Math.max(5, input.leverage)) * 1.1 * 100) / 100;
      await this.ensureDexFunded(input.privyWalletId, input.privyWalletAddress, marginNeed);

      const assetId = await this.resolveAssetId(input.coin);
      if (assetId == null) throw new Error('unknown_asset');

      const market = await this.getMarket(input.coin);
      const refPrice = market?.priceUsd ?? 0;
      if (refPrice <= 0) throw new Error('unknown_price');
      const szDecimals = market?.szDecimals;
      const sizeNative = input.qtyUsd / refPrice;

      const limitPx = input.orderType === 'limit' && input.limitPriceUsd
        ? input.limitPriceUsd
        : input.sideLong
        ? refPrice * 1.01
        : refPrice * 0.99;

      const builder = configuredBuilder();

      const action = {
        type: 'order' as const,
        orders: [
          {
            a: assetId,
            b: input.sideLong,
            p: formatHlPerpPx(limitPx, szDecimals),
            s: formatHlSize(sizeNative, szDecimals),
            r: Boolean(input.reduceOnly),
            t: { limit: { tif } },
          },
        ],
        grouping: 'na' as const,
        ...(builder ? { builder } : {}),
      };
      const nonce = nextHlNonce();
      const signature = await hlSignL1Action({
        walletId: input.privyWalletId,
        walletAddress: input.privyWalletAddress,
        action,
        nonce,
        isMainnet: true,
      });

      const res = await hip3Fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'hyperliquid-hip3: order rejected');
        throw new Error('order_rejected');
      }
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        response?: { data?: { statuses?: Array<Hip3VenueOrderStatus> } };
      };
      if (data.status !== 'ok') throw new Error('order_rejected');
      const status = data.response?.data?.statuses?.[0];
      assertVenueStatusOk(status, 'order_rejected');
      const fill = status?.filled;
      const oid = fill?.oid ?? status?.resting?.oid;
      if (oid == null) throw new Error('order_missing_oid');
      return {
        orderId: 'hip3_' + String(oid),
        filledQtyUsd: fill ? input.qtyUsd : 0,
        entryPriceUsd: fill?.avgPx ? Number(fill.avgPx) : fill?.px ? Number(fill.px) : refPrice,
        demo: false,
        state: fill ? 'filled' : 'resting',
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-hip3: order live path failed',
      );
      throw e;
    }
  }

  /**
   * Cancel an open HIP-3 order. Same /exchange action shape as canonical
   * perps with the HIP-3 asset id offset.
   */
  async cancelOrder(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    coin: string;
    externalRef: string;
  }): Promise<{ ok: boolean; demo: boolean }> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return { ok: true, demo: true };
    }
    try {
      const venueOid = /^hip3_(\d+)$/i.exec(input.externalRef)?.[1]
        ?? (/^\d+$/.test(input.externalRef) ? input.externalRef : null);
      if (!venueOid) return { ok: true, demo: true };
      const oid = Number(venueOid);
      if (!Number.isFinite(oid)) throw new Error('invalid_oid');
      const assetId = await this.resolveAssetId(input.coin);
      if (assetId == null) throw new Error('unknown_asset');
      const action = { type: 'cancel' as const, cancels: [{ a: assetId, o: oid }] };
      const nonce = nextHlNonce();
      const signature = await hlSignL1Action({
        walletId: input.privyWalletId,
        walletAddress: input.privyWalletAddress,
        action,
        nonce,
        isMainnet: true,
      });
      const res = await hip3Fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });
      if (!res.ok) throw new Error('cancel_rejected');
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        response?: { data?: { statuses?: unknown[] } };
      };
      if (data.status !== 'ok') throw new Error('cancel_rejected');
      assertVenueStatusOk(data.response?.data?.statuses?.[0], 'cancel_rejected');
      return { ok: true, demo: false };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-hip3: cancel live path failed',
      );
      throw e;
    }
  }

  /** User positions on the HIP-3 DEX. Reads `clearinghouseState` with `dex: 'xyz'`. */
  async getPositions(userAddress: string | null): Promise<Hip3Position[]> {
    if (!this.isLiveTrading || !userAddress) return [];
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: userAddress, dex: HIP3_DEX_NAME }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as {
        assetPositions?: Array<{ position?: Hip3RawPosition }>;
      } | null;
      if (!data?.assetPositions) return [];
      const out: Hip3Position[] = [];
      for (const ap of data.assetPositions) {
        const parsed = parseHip3Position(ap.position);
        if (parsed) out.push(parsed);
      }
      return out;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-hip3: positions unreachable',
      );
      return [];
    }
  }

  /**
   * Equity truth for the `xyz` dex clearinghouse — portfolio/summary leg.
   * Money-DISPLAY path only: order sizing keeps using
   * clearinghouseWithdrawable so main-dex margin never counts builder-dex
   * collateral. Demo env returns zeros (every demo leg is stubbed); live
   * failures return null so the route marks the leg 'failed' instead of
   * rendering a fake $0.
   */
  async getUserState(userAddress: string | null): Promise<Hip3UserState | null> {
    if (!userAddress) return null;
    if (!this.isLiveTrading) return { equityUsd: 0, withdrawableUsd: 0, unrealizedPnlUsd: 0, positions: [] };
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: userAddress, dex: HIP3_DEX_NAME }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        withdrawable?: string;
        marginSummary?: { accountValue?: string };
        assetPositions?: Array<{ position?: Hip3RawPosition }>;
      } | null;
      if (!data?.marginSummary) return null;
      const equity = Number(data.marginSummary.accountValue ?? '0');
      if (!Number.isFinite(equity)) return null;
      const withdrawable = Number(data.withdrawable ?? '0');
      // One clearinghouse read yields both the aggregate AND the per-position
      // rows the portfolio renders — no second fetch. uPnL is summed from the
      // same parsed positions so the aggregate and rows never disagree.
      const positions: Hip3Position[] = [];
      let upnl = 0;
      for (const ap of data.assetPositions ?? []) {
        const parsed = parseHip3Position(ap.position);
        if (parsed) {
          positions.push(parsed);
          upnl += parsed.unrealizedPnlUsd;
        }
      }
      return {
        equityUsd: equity,
        withdrawableUsd: Number.isFinite(withdrawable) ? withdrawable : 0,
        unrealizedPnlUsd: upnl,
        positions,
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-hip3: user state unreachable',
      );
      return null;
    }
  }
}

export const hyperliquidHip3 = new HyperliquidHip3Adapter();

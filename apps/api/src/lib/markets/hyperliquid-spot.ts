/**
 * Hyperliquid SPOT market-data adapter — read-only spot pairs PLUS the
 * write surface (placeOrder / cancelOrder / getPositions) for spot trading.
 *
 * Spot is a distinct universe from perps: 307 active pairs versus 230 perps.
 * Read path: `POST /info {type: 'spotMetaAndAssetCtxs'}` returns the spot
 * universe (pair names + token indices) and parallel asset contexts (mark
 * price, day volume). Non-canonical pairs are named `"@N"` upstream; we
 * resolve them to a `BASE/QUOTE` display name using the token table.
 *
 * Write path: same `POST /exchange` endpoint as perps with the same EIP-712
 * L1 action signature. The ONLY difference is the asset index: spot uses
 * `10000 + universe[i].index` per HL spec. Builder fees do NOT apply to spot.
 *
 * Demo fallback on any error mirrors the perp adapter. Live trading gated
 * behind features.markets + features.privy (no builder address needed).
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/spot
 */

import { randomBytes } from 'node:crypto';
import { features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import { hlSignL1Action, nextHlNonce } from './hl-signer.js';
import { formatHlSize, formatHlSpotPx } from './hl-format.js';
import { throwIfProviderRateLimited } from './provider-errors.js';
import { HL_INFO_URL, HL_EXCHANGE_URL, isHlRegionAllowed } from './hl-config.js';

const INFO_URL = HL_INFO_URL;
const EXCHANGE_URL = HL_EXCHANGE_URL;

/** Spot asset id offset per HL spec — `a = 10000 + universe.index`. */
const SPOT_ASSET_ID_OFFSET = 10000;

const HL_SPOT_VISIBLE_LIMIT = 500;

/** Geo gate — shared blocklist lives in hl-config.ts (same ToS as perps). */
export function isHyperliquidSpotRegionAllowed(country: string | null): boolean {
  return isHlRegionAllowed(country);
}

export interface HlSpotMarket {
  /** Upstream coin key — either canonical (e.g. "PURR/USDC") or "@N" placeholder. */
  coin: string;
  /** Human display — `BASE/QUOTE` resolved via the token table. */
  displayName: string;
  baseToken: string;
  quoteToken: string;
  priceUsd: number;
  change24hPct: number | null;
  dayVolumeUsd?: number | null;
  /** HL universe index (used to compute the order asset id). */
  index: number;
  /** Canonical pairs are surfaced as the default; non-canonical are noisier. */
  isCanonical: boolean;
  /** Base-token size decimals — order size must round to this or HL rejects
      "Order has invalid size". From the spot token table. */
  szDecimals?: number | null;
}

export interface HlSpotOrderInput {
  privyWalletId: string | null;
  privyWalletAddress: `0x${string}` | null;
  /** Either canonical coin name (e.g. "PURR/USDC") or `@N`. */
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  orderType?: 'market' | 'limit';
  limitPriceUsd?: number;
  tif?: 'Ioc' | 'Gtc' | 'Alo';
  reduceOnly?: boolean;
}

export interface HlSpotOrderResult {
  orderId: string;
  filledQtyUsd: number;
  entryPriceUsd: number;
  demo: boolean;
  state?: 'filled' | 'resting';
}

type HlSpotVenueOrderStatus = {
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

export interface HlSpotPosition {
  coin: string;
  qtyBase: number;
  entryPriceUsd: number;
}

const DEMO_SPOT_MARKETS: readonly HlSpotMarket[] = [
  { coin: 'PURR/USDC', displayName: 'PURR/USDC', baseToken: 'PURR', quoteToken: 'USDC', priceUsd: 0.0975, change24hPct: null, dayVolumeUsd: 0, index: 0, isCanonical: true },
  { coin: 'HYPE/USDC', displayName: 'HYPE/USDC', baseToken: 'HYPE', quoteToken: 'USDC', priceUsd: 28.4, change24hPct: null, dayVolumeUsd: 0, index: 1, isCanonical: true },
];

interface HlSpotToken {
  name?: string;
  index?: number;
  szDecimals?: number;
  weiDecimals?: number;
}

interface HlSpotUniverseEntry {
  name?: string;
  tokens?: [number, number];
  index?: number;
  isCanonical?: boolean;
}

interface HlSpotAssetCtx {
  coin?: string;
  markPx?: string;
  midPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  dayBaseVlm?: string;
  circulatingSupply?: string;
}

type HlSpotMetaAndAssetCtxs = [
  { universe?: HlSpotUniverseEntry[]; tokens?: HlSpotToken[] },
  HlSpotAssetCtx[],
];

type MarketDataSource = 'live' | 'provider-demo';

export interface HlSpotMarketsResult {
  source: MarketDataSource;
  markets: HlSpotMarket[];
}

export interface HlSpotBalance {
  coin: string;
  total: number;
  hold: number;
  entryNtl: number | null;
}

export interface HlSpotUserState {
  usdcUsd: number;
  balances: HlSpotBalance[];
  live: boolean;
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

function pctChange(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function spotTokenName(tokens: HlSpotToken[], tokenIndex: number | undefined): string | undefined {
  if (typeof tokenIndex !== 'number') return undefined;
  return (
    tokens.find((token) => token.index === tokenIndex)?.name?.trim()
    || tokens[tokenIndex]?.name?.trim()
  );
}

/** Size decimals for the pair's BASE token (universe.tokens[0]). */
function spotBaseSzDecimals(tokens: HlSpotToken[], entry: HlSpotUniverseEntry): number | null {
  const baseIdx = entry.tokens?.[0];
  if (typeof baseIdx !== 'number') return null;
  const tok = tokens.find((t) => t.index === baseIdx) ?? tokens[baseIdx];
  return typeof tok?.szDecimals === 'number' ? tok.szDecimals : null;
}

/**
 * Resolve display name + base/quote symbols. Canonical pairs already carry
 * `name = "BASE/QUOTE"`. Non-canonical placeholders (`"@N"`) need a lookup
 * via the token table — each token index points at a `tokens[]` row with a
 * `name`. Returns null when the lookup fails so the row gets skipped.
 */
function resolveSpotDisplay(
  entry: HlSpotUniverseEntry,
  tokens: HlSpotToken[],
): { displayName: string; baseToken: string; quoteToken: string } | null {
  const upstream = entry.name?.trim() ?? '';
  const baseIdx = entry.tokens?.[0];
  const quoteIdx = entry.tokens?.[1];
  const baseTok = spotTokenName(tokens, baseIdx);
  const quoteTok = spotTokenName(tokens, quoteIdx);
  if (upstream && !upstream.startsWith('@') && upstream.includes('/')) {
    const [base, quote] = upstream.split('/');
    return {
      displayName: upstream,
      baseToken: baseTok || base || 'BASE',
      quoteToken: quoteTok || quote || 'USDC',
    };
  }
  if (!baseTok || !quoteTok) return null;
  return {
    displayName: `${baseTok}/${quoteTok}`,
    baseToken: baseTok,
    quoteToken: quoteTok,
  };
}

function mapSpotMetaAndAssetCtxs(data: HlSpotMetaAndAssetCtxs | null): HlSpotMarket[] {
  if (!Array.isArray(data) || data.length < 2) return [];
  const [meta, ctxs] = data;
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const tokens = Array.isArray(meta?.tokens) ? meta.tokens : [];
  if (!Array.isArray(ctxs) || universe.length === 0) return [];

  // Asset contexts are NOT parallel to the universe — probed 2026-07-03:
  // 699 ctx rows vs 308 universe entries, 237/308 positional joins wrong
  // (WOW showed another pair's $68.83 instead of $0.0005965). Each ctx row
  // carries its own `coin` key; join by it and only fall back to position
  // when the upstream omits the key entirely.
  const ctxByCoin = new Map<string, HlSpotAssetCtx>();
  for (const ctx of ctxs) {
    const key = typeof ctx?.coin === 'string' ? ctx.coin.trim() : '';
    if (key && !ctxByCoin.has(key)) ctxByCoin.set(key, ctx);
  }

  const markets: HlSpotMarket[] = [];
  for (let i = 0; i < universe.length; i++) {
    const entry = universe[i];
    const entryName = entry?.name?.trim() ?? '';
    const ctx = (entryName ? ctxByCoin.get(entryName) : undefined)
      ?? (ctxByCoin.size === 0 ? ctxs[i] : undefined);
    if (!entry || !ctx) continue;

    const display = resolveSpotDisplay(entry, tokens);
    if (!display) continue;

    const priceUsd = positiveNumberOrNull(ctx.markPx) ?? positiveNumberOrNull(ctx.midPx);
    if (priceUsd === null) continue;

    const coin = (entry.name ?? display.displayName).trim();
    if (!coin) continue;

    markets.push({
      coin,
      displayName: display.displayName,
      baseToken: display.baseToken,
      quoteToken: display.quoteToken,
      priceUsd,
      change24hPct: pctChange(priceUsd, positiveNumberOrNull(ctx.prevDayPx)),
      dayVolumeUsd: numberOrNull(ctx.dayNtlVlm),
      index: typeof entry.index === 'number' ? entry.index : i,
      isCanonical: entry.isCanonical === true,
      szDecimals: spotBaseSzDecimals(tokens, entry),
    });
  }

  return markets.sort((a, b) => (b.dayVolumeUsd ?? 0) - (a.dayVolumeUsd ?? 0));
}

function demo(): HlSpotMarket[] {
  return DEMO_SPOT_MARKETS.map((m) => ({ ...m }));
}

export class HyperliquidSpotAdapter {
  get isLive(): boolean {
    return features.markets;
  }

  /**
   * Spot trading uses the same /exchange endpoint as perps but has no builder
   * fee, so we only need markets + privy. No HL_BUILDER_ADDRESS dependency.
   */
  get isLiveTrading(): boolean {
    return Boolean(features.markets && features.privy);
  }

  async getMarketsResult(limit = HL_SPOT_VISIBLE_LIMIT): Promise<HlSpotMarketsResult> {
    if (!this.isLive) return { source: 'provider-demo', markets: demo() };
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'hyperliquid-spot: spotMetaAndAssetCtxs rejected — demo fallback');
        return { source: 'provider-demo', markets: demo() };
      }
      const data = (await res.json().catch(() => null)) as HlSpotMetaAndAssetCtxs | null;
      const all = mapSpotMetaAndAssetCtxs(data);
      const sliced = Number.isFinite(limit) && limit > 0 ? all.slice(0, Math.floor(limit)) : all;
      return sliced.length > 0
        ? { source: 'live', markets: sliced }
        : { source: 'provider-demo', markets: demo() };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-spot: spotMetaAndAssetCtxs unreachable — demo fallback',
      );
      return { source: 'provider-demo', markets: demo() };
    }
  }

  async getMarkets(limit = HL_SPOT_VISIBLE_LIMIT): Promise<HlSpotMarket[]> {
    return (await this.getMarketsResult(limit)).markets;
  }

  /** Find a single spot market by coin (case-insensitive on the upstream name). */
  async getMarket(coin: string): Promise<HlSpotMarket | null> {
    const want = coin.trim();
    if (!want) return null;
    const markets = await this.getMarkets(Number.POSITIVE_INFINITY);
    const lower = want.toLowerCase();
    return markets.find((m) => m.coin.toLowerCase() === lower || m.displayName.toLowerCase() === lower) ?? null;
  }

  /**
   * Asset index resolution. The order action's `a` field is
   * `10000 + universe[i].index`. Cache the canonical-name → asset-id map
   * after the first /info call so subsequent orders skip the round-trip.
   */
  private assetIdCache: Map<string, number> | null = null;

  private async resolveAssetId(coin: string): Promise<number | null> {
    if (!this.assetIdCache) {
      try {
        const res = await fetch(INFO_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'spotMeta' }),
        });
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as {
          universe?: HlSpotUniverseEntry[];
          tokens?: HlSpotToken[];
        } | null;
        const map = new Map<string, number>();
        const tokens = data?.tokens ?? [];
        data?.universe?.forEach((u, i) => {
          const idx = typeof u.index === 'number' ? u.index : i;
          const venueAssetId = SPOT_ASSET_ID_OFFSET + idx;
          if (u.name) map.set(u.name.toUpperCase(), venueAssetId);
          const display = resolveSpotDisplay(u, tokens);
          if (display) map.set(display.displayName.toUpperCase(), venueAssetId);
        });
        this.assetIdCache = map;
      } catch {
        return null;
      }
    }
    return this.assetIdCache.get(coin.toUpperCase()) ?? null;
  }

  async placeOrder(input: HlSpotOrderInput): Promise<HlSpotOrderResult> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      const market = await this.getMarket(input.coin);
      const entry = market?.priceUsd ?? 0;
      return {
        orderId: 'hls_demo_' + hex(8),
        filledQtyUsd: input.orderType === 'limit' && (input.tif ?? 'Gtc') !== 'Ioc' ? 0 : input.qtyUsd,
        entryPriceUsd: entry,
        demo: true,
        state: input.orderType === 'limit' && (input.tif ?? 'Gtc') !== 'Ioc' ? 'resting' : 'filled',
      };
    }
    try {
      const tif = input.tif ?? (input.orderType === 'limit' ? 'Gtc' : 'Ioc');
      const assetId = await this.resolveAssetId(input.coin);
      if (assetId == null) throw new Error('unknown_asset');

      const market = await this.getMarket(input.coin);
      const refPrice = market?.priceUsd ?? 0;
      if (refPrice <= 0) throw new Error('unknown_price');
      const sizeNative = input.qtyUsd / refPrice;

      const limitPx = input.orderType === 'limit' && input.limitPriceUsd
        ? input.limitPriceUsd
        : input.sideLong
        ? refPrice * 1.01
        : refPrice * 0.99;

      const action = {
        type: 'order' as const,
        orders: [
          {
            a: assetId,
            b: input.sideLong,
            // Canonical HL format (no trailing zeros) — .toFixed() trailing
            // zeros make HL re-hash a different action and recover a phantom
            // signer ("User or API Wallet 0x… does not exist"). See hl-format.ts.
            // szDecimals (base-token size decimals) is required or HL rejects
            // "Order has invalid size" for tokens with fewer than 6 decimals.
            p: formatHlSpotPx(limitPx, market?.szDecimals),
            s: formatHlSize(sizeNative, market?.szDecimals),
            r: Boolean(input.reduceOnly),
            t: { limit: { tif } },
          },
        ],
        grouping: 'na' as const,
      };
      const nonce = nextHlNonce();
      const signature = await hlSignL1Action({
        walletId: input.privyWalletId,
        walletAddress: input.privyWalletAddress,
        action,
        nonce,
        isMainnet: true,
      });

      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });
      if (!res.ok) {
        throwIfProviderRateLimited(res, 'hyperliquid-spot');
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'hyperliquid-spot: order rejected');
        throw new Error('order_rejected');
      }
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        response?: { data?: { statuses?: Array<HlSpotVenueOrderStatus> } };
      };
      if (data.status !== 'ok') {
        log.warn({ data }, 'hyperliquid-spot: order status not ok');
        throw new Error('order_rejected');
      }
      const status = data.response?.data?.statuses?.[0];
      assertVenueStatusOk(status, 'order_rejected');
      const fill = status?.filled;
      const oid = fill?.oid ?? status?.resting?.oid;
      if (oid == null) throw new Error('order_missing_oid');
      return {
        orderId: 'hls_' + String(oid),
        filledQtyUsd: fill ? input.qtyUsd : 0,
        entryPriceUsd: fill?.avgPx ? Number(fill.avgPx) : fill?.px ? Number(fill.px) : refPrice,
        demo: false,
        state: fill ? 'filled' : 'resting',
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-spot: order live path failed',
      );
      throw e;
    }
  }

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
      const venueOid = /^hls_(\d+)$/i.exec(input.externalRef)?.[1]
        ?? (/^\d+$/.test(input.externalRef) ? input.externalRef : null);
      if (!venueOid) {
        if (/^hls_demo_/i.test(input.externalRef)) return { ok: true, demo: true };
        throw new Error('invalid_oid');
      }
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
      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });
      if (!res.ok) {
        throwIfProviderRateLimited(res, 'hyperliquid-spot');
        throw new Error('cancel_rejected');
      }
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
        'hyperliquid-spot: cancel live path failed',
      );
      throw e;
    }
  }

  /**
   * Spot balances → positions. HL `/info {type: 'spotClearinghouseState'}`
   * returns `balances[]` with `{coin, hold, total}` per token. We surface
   * non-zero non-USDC balances as positions priced at the current mark.
   */
  async getUserState(userAddress: string | null): Promise<HlSpotUserState> {
    if (!this.isLive || !userAddress) return { usdcUsd: 0, balances: [], live: this.isLive };
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: userAddress }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return { usdcUsd: 0, balances: [], live: true };
      const data = (await res.json().catch(() => null)) as {
        balances?: Array<{ coin?: string; hold?: string; total?: string; entryNtl?: string }>;
      } | null;
      const balances: HlSpotBalance[] = [];
      for (const b of data?.balances ?? []) {
        const coin = (b.coin ?? '').trim();
        const total = Number(b.total ?? '0');
        const hold = Number(b.hold ?? '0');
        if (!coin || !Number.isFinite(total) || !Number.isFinite(hold)) continue;
        balances.push({ coin, total, hold, entryNtl: numberOrNull(b.entryNtl) });
      }
      return {
        usdcUsd: balances.find((b) => b.coin.toUpperCase() === 'USDC')?.total ?? 0,
        balances,
        live: true,
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-spot: user-state unreachable',
      );
      return { usdcUsd: 0, balances: [], live: true };
    }
  }

  async getPositions(userAddress: string | null): Promise<HlSpotPosition[]> {
    if (!this.isLive || !userAddress) return [];
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: userAddress }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as {
        balances?: Array<{ coin?: string; hold?: string; total?: string; entryNtl?: string }>;
      } | null;
      if (!data?.balances) return [];
      const markets = await this.getMarkets(Number.POSITIVE_INFINITY);
      const priceByBase = new Map<string, number>();
      for (const m of markets) {
        if (m.quoteToken.toUpperCase() === 'USDC') priceByBase.set(m.baseToken.toUpperCase(), m.priceUsd);
      }
      const out: HlSpotPosition[] = [];
      for (const b of data.balances) {
        const coin = (b.coin ?? '').trim();
        if (!coin || coin.toUpperCase() === 'USDC') continue;
        const total = Number(b.total ?? '0');
        if (!Number.isFinite(total) || total === 0) continue;
        const px = priceByBase.get(coin.toUpperCase()) ?? 0;
        out.push({
          coin,
          qtyBase: total,
          entryPriceUsd: px,
        });
      }
      return out;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid-spot: positions unreachable',
      );
      return [];
    }
  }
}

export const hyperliquidSpot = new HyperliquidSpotAdapter();

/**
 * Hyperliquid market-data adapter — read-only perps/spot mid prices PLUS the
 * Sprint 10 Item E write surface (placeOrder / cancelOrder / getPositions).
 *
 * Live reads hit the public, no-auth info API (POST https://api.hyperliquid.xyz/info).
 * Live writes hit the exchange (POST https://api.hyperliquid.xyz/exchange) with
 * an EIP-712 typed-data L1 action signed by a Privy server wallet. Every network
 * call is wrapped so read outages degrade to demo behaviour. Live write outages
 * throw to the route so we never persist a local fill/cancel that the venue did
 * not accept.
 *
 * Live trading is gated behind features.markets + features.privy + a user
 * Privy server wallet. Builder fees are optional on the order action; when
 * configured, the backend signs/persists the one-time approveBuilderFee
 * agreement during account setup or the first live HL action.
 *
 * The pre-existing builderApprovalParams helper is retained as read-only
 * legacy/debug metadata. Normal users should not see an order-time approval UI.
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs
 */

import { randomBytes } from 'node:crypto';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import {
  hlSignL1Action,
  hlSignUserSignedAction,
  HL_USER_SIGN_CHAIN_ID,
  HL_HYPERLIQUID_CHAIN,
  nextHlNonce,
} from './hl-signer.js';
import { throwIfProviderRateLimited } from './provider-errors.js';
import { formatHlPerpPx, formatHlSize } from './hl-format.js';
import { SendAssetTypes, UsdClassTransferTypes, UsdSendTypes, Withdraw3Types } from '@nktkas/hyperliquid/api/exchange';
import { HL_INFO_URL, HL_EXCHANGE_URL, isHlRegionAllowed } from './hl-config.js';

const INFO_URL = HL_INFO_URL;
const EXCHANGE_URL = HL_EXCHANGE_URL;
// Canonical HL mainnet USDC token spec (`name:tokenId` from spotMeta.tokens[0]).
// Verified live against POST /info {type:'spotMeta'} on 2026-07-04; the previous
// id (0xeb62…) was rejected by /exchange as "Unknown token" on every sendAsset,
// silently breaking core→HIP-3-dex funding.
export const HL_USDC_TOKEN = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';

/** Hyperliquid builder-fee cap on perps, in basis points (0.1%). */
const PERPS_BUILDER_FEE_CAP_BPS = 10;
const PERPS_BUILDER_FEE_CAP_TENTHS_BP = PERPS_BUILDER_FEE_CAP_BPS * 10;

/** Placeholder builder address when HL_BUILDER_ADDRESS is unset. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function configuredBuilderFeeTenths(): number {
  const raw = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0;
  return Math.max(0, Math.min(PERPS_BUILDER_FEE_CAP_TENTHS_BP, raw));
}

function configuredBuilder(): { b: `0x${string}`; f: number } | undefined {
  const address = env.HL_BUILDER_ADDRESS?.trim().toLowerCase();
  const feeTenths = configuredBuilderFeeTenths();
  return address && feeTenths > 0 ? { b: address as `0x${string}`, f: feeTenths } : undefined;
}

/** Geo gate — shared blocklist lives in hl-config.ts (one source of truth). */
export function isHyperliquidRegionAllowed(country: string | null): boolean {
  return isHlRegionAllowed(country);
}

export interface HlMarket {
  coin: string;
  priceUsd: number;
  /** 24h change in percent. Null when unknown (always null in demo). */
  change24hPct: number | null;
  /** Venue max leverage for this perp, when supplied by Hyperliquid meta. */
  maxLeverage?: number | null;
  /** 24h notional volume in USD, from dayNtlVlm. */
  dayVolumeUsd?: number | null;
  /** Open interest from the Hyperliquid asset context. */
  openInterest?: number | null;
  /** Current funding rate as a decimal, e.g. 0.0001 = 1 bp. */
  fundingRate?: number | null;
  /** Size decimals — order size must round to this or HL rejects "invalid size". */
  szDecimals?: number | null;
}

export type HlTif = 'Ioc' | 'Gtc' | 'Alo';

export type HlOrderKind = 'market' | 'limit' | 'stopLimit' | 'twap';

export interface HlTpSlLeg {
  triggerPriceUsd: number;
  /** True = post-trigger market fill; false = post-trigger resting limit at limitPriceUsd. */
  isMarket: boolean;
  limitPriceUsd?: number;
}

export interface HlOrderInput {
  /** Privy server-wallet id of the user signing the L1 action. */
  privyWalletId: string | null;
  /** EVM address of the Privy wallet — required by the SDK as wallet.address. */
  privyWalletAddress: `0x${string}` | null;
  /** Coin symbol — uppercase, e.g. "BTC" or "ETH". */
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  /** Leverage as a decimal — 5 = 5x. Capped by venue; we pass it through. */
  leverage: number;
  /**
   * V2 discriminated `kind`. New code should set this; if absent we fall back
   * to the legacy `orderType` for back-compat with existing callers.
   */
  kind?: HlOrderKind;
  /** Legacy — use `kind` instead. Mapped: "market"→kind:"market", "limit"→kind:"limit". */
  orderType?: 'market' | 'limit';
  /** Limit price USD when kind ∈ { limit, stopLimit }. */
  limitPriceUsd?: number;
  /** Trigger price USD when kind === "stopLimit". */
  triggerPriceUsd?: number;
  /** "sl" or "tp" — selects HL's `tpsl` discriminator on the trigger leg. */
  stopKind?: 'sl' | 'tp';
  /** TWAP slice window in minutes — HL bounds: 5..1440. */
  durationMinutes?: number;
  /** TWAP — randomize sub-slice timing. */
  randomize?: boolean;
  /** Time-in-force — "Ioc" / "Gtc" / "Alo" (post-only). */
  tif?: HlTif;
  /**
   * Set true for position-close / take-profit / stop-loss orders. Maps to the
   * `r` flag on the HL order action so the venue rejects orders that would
   * increase the user's net position past zero.
   */
  reduceOnly?: boolean;
  /** Attached take-profit leg — grouped with parent via "normalTpsl". */
  takeProfit?: HlTpSlLeg;
  /** Attached stop-loss leg — same grouping rules as takeProfit. */
  stopLoss?: HlTpSlLeg;
}

export type HlOrderState = 'filled' | 'resting' | 'triggered' | 'twap_active';

export interface HlOrderResult {
  orderId: string;
  filledQtyUsd: number;
  entryPriceUsd: number;
  /** True when the adapter took the demo path. */
  demo: boolean;
  /** Lifecycle hint — populated for non-IOC orders. Defaults to "filled". */
  state?: HlOrderState;
  /** Attached TP/SL child orders, keyed by leg type. */
  legs?: { tp?: { orderId: string }; sl?: { orderId: string } };
}

type HlOrderVenueStatus = {
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

export interface HlPosition {
  coin: string;
  sideLong: boolean;
  /** Signed-size magnitude in the base coin (e.g. 0.0053 BTC). */
  qty: number;
  qtyUsd: number;
  entryPriceUsd: number;
  /** Mark-to-market unrealized PnL in USD from the clearinghouse. */
  unrealizedPnlUsd: number;
  /** Position leverage (decimal, e.g. 5 = 5x). */
  leverage: number;
  /** Venue's authoritative liquidation price, or null when absent/invalid. */
  liquidationPriceUsd: number | null;
}

/**
 * Single source of truth for the Hyperliquid `clearinghouseState.assetPositions`
 * → `HlPosition[]` mapping. Both REST reads (`getUserState`, `getPositions`)
 * and the webData2 stream (`realtime/venues/hyperliquid-user.ts`) go through
 * here so the shape — including the `entryPriceUsd` finite-guard and the
 * `liquidationPx` parse — can never drift between the polling and streaming
 * surfaces. Flat rows (`szi === 0`) are skipped.
 */
export function mapClearinghousePositions(
  assetPositions:
    | Array<{
        position?: {
          coin?: string;
          szi?: string;
          entryPx?: string;
          positionValue?: string;
          unrealizedPnl?: string;
          liquidationPx?: string | null;
          leverage?: { value?: number } | number;
        };
      }>
    | undefined
    | null,
): HlPosition[] {
  const out: HlPosition[] = [];
  for (const ap of assetPositions ?? []) {
    const p = ap.position;
    if (!p?.coin) continue;
    const szi = Number(p.szi ?? '0');
    if (!Number.isFinite(szi) || szi === 0) continue;
    const entry = Number(p.entryPx ?? '0');
    const positionValue = Number(p.positionValue ?? '0');
    const uPnl = Number(p.unrealizedPnl ?? '0');
    const lev = typeof p.leverage === 'number' ? p.leverage : Number(p.leverage?.value ?? 0);
    const liq = p.liquidationPx == null ? NaN : Number(p.liquidationPx);
    out.push({
      coin: p.coin,
      sideLong: szi > 0,
      qty: Math.abs(szi),
      qtyUsd:
        Number.isFinite(positionValue) && positionValue > 0
          ? Math.abs(positionValue)
          : Math.abs(szi) * (Number.isFinite(entry) ? entry : 0),
      entryPriceUsd: Number.isFinite(entry) ? entry : 0,
      unrealizedPnlUsd: Number.isFinite(uPnl) ? uPnl : 0,
      leverage: Number.isFinite(lev) && lev > 0 ? lev : 1,
      liquidationPriceUsd: Number.isFinite(liq) && liq > 0 ? liq : null,
    });
  }
  return out;
}

/** Stable demo sample — used when markets are disabled or the API is unreachable. */
const DEMO_MARKETS: readonly HlMarket[] = [
  { coin: 'BTC', priceUsd: 64210.5, change24hPct: null },
  { coin: 'ETH', priceUsd: 3420.18, change24hPct: null },
  { coin: 'SOL', priceUsd: 158.92, change24hPct: null },
  { coin: 'HYPE', priceUsd: 28.4, change24hPct: null },
];

const HL_VISIBLE_PERPS_LIMIT = 500;

interface HlUniverseAsset {
  name?: string;
  maxLeverage?: number | string;
  szDecimals?: number;
  isDelisted?: boolean;
}

interface HlAssetCtx {
  markPx?: string;
  midPx?: string;
  prevDayPx?: string;
  dayNtlVlm?: string;
  openInterest?: string;
  funding?: string;
}

type HlMetaAndAssetCtxs = [
  { universe?: HlUniverseAsset[] },
  HlAssetCtx[],
];

type MarketDataSource = 'live' | 'provider-demo';
export interface HlMarketsResult {
  source: MarketDataSource;
  markets: HlMarket[];
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

type TriggerLeg = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { trigger: { triggerPx: string; isMarket: boolean; tpsl: 'tp' | 'sl' } };
};

function triggerLegFromTpSl(
  assetId: number,
  isBuy: boolean,
  sizeNative: number,
  leg: HlTpSlLeg,
  kind: 'tp' | 'sl',
  refPrice: number,
  szDecimals?: number | null,
): TriggerLeg {
  const px = leg.isMarket ? (isBuy ? refPrice * 1.01 : refPrice * 0.99) : leg.limitPriceUsd ?? 0;
  if (!leg.isMarket && !(px > 0)) {
    throw new Error('tpsl_limit_requires_price');
  }
  return {
    a: assetId,
    b: isBuy,
    // Canonical HL format (no trailing zeros) — see hl-format.ts.
    p: formatHlPerpPx(px, szDecimals),
    s: formatHlSize(sizeNative, szDecimals),
    r: true,
    t: {
      trigger: {
        triggerPx: formatHlPerpPx(leg.triggerPriceUsd, szDecimals),
        isMarket: leg.isMarket,
        tpsl: kind,
      },
    },
  };
}

export class HyperliquidAdapter {
  get isLive(): boolean {
    return features.markets;
  }

  /**
   * Live trading requires markets + Privy. Builder fees are optional; missing
   * builder env just means orders go out without a builder-fee field.
   */
  get isLiveTrading(): boolean {
    return Boolean(features.markets && features.privy);
  }

  /**
   * Visible perpetual markets. Live: POST { type: 'metaAndAssetCtxs' }, filter
   * active perps, sort by 24h notional volume, then map venue stats.
   * Disabled or on any error: the demo sample (a fresh array copy).
   */
  async getMarketsResult(limit = HL_VISIBLE_PERPS_LIMIT): Promise<HlMarketsResult> {
    if (!this.isLive) return { source: 'provider-demo', markets: demo() };
    try {
      // Sprint 17 F072 — info endpoint is unauthenticated + idempotent; retry
      // is safe. maxAttempts=2 keeps the read fast even on flapping nodes.
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'hyperliquid: metaAndAssetCtxs rejected — demo fallback');
        return { source: 'provider-demo', markets: demo() };
      }
      const data = (await res.json().catch(() => null)) as HlMetaAndAssetCtxs | null;
      const allMarkets = mapMetaAndAssetCtxs(data);
      const markets = Number.isFinite(limit) && limit > 0
        ? allMarkets.slice(0, Math.floor(limit))
        : allMarkets;
      return markets.length > 0
        ? { source: 'live', markets }
        : { source: 'provider-demo', markets: demo() };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid: metaAndAssetCtxs unreachable — demo fallback',
      );
      return { source: 'provider-demo', markets: demo() };
    }
  }

  async getMarkets(limit = HL_VISIBLE_PERPS_LIMIT): Promise<HlMarket[]> {
    return (await this.getMarketsResult(limit)).markets;
  }

  /** A single coin's market, matched case-insensitively. Null if not found. */
  async getMarket(coin: string): Promise<HlMarket | null> {
    const want = coin.trim().toLowerCase();
    if (!want) return null;
    const markets = await this.getMarkets(Number.POSITIVE_INFINITY);
    return markets.find((m) => m.coin.toLowerCase() === want) ?? null;
  }

  /**
   * Candle snapshot proxy. Wraps Hyperliquid's public `/info` candleSnapshot
   * shape so the browser doesn't have to talk to api.hyperliquid.xyz (CORS).
   * Returns raw HL candle objects `{t, T, s, i, o, c, h, l, v, n}` — the
   * mobile chart already consumes this shape, so the Neo wire stays stable.
   */
  async getCandles(
    coin: string,
    interval: string = '1h',
    lookbackMs: number = 24 * 60 * 60 * 1000,
    endMs?: number,
  ): Promise<Array<{ t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }>> {
    if (!this.isLive) return [];
    // Optional `endMs` lets the chart page OLDER history (`[end - lookback, end]`)
    // when the user scrolls past the left edge; default is the live window.
    const endTime = Number.isFinite(endMs as number) && (endMs as number) > 0 ? Math.floor(endMs as number) : Date.now();
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin: coin.toUpperCase(), interval, startTime: endTime - lookbackMs, endTime },
        }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        log.warn({ status: res.status, coin, interval }, 'hyperliquid: candleSnapshot rejected');
        return [];
      }
      const data = (await res.json().catch(() => null)) as unknown;
      return Array.isArray(data) ? (data as Array<{ t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }>) : [];
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), coin }, 'hyperliquid: candleSnapshot failed');
      return [];
    }
  }

  /**
   * allMids proxy. Returns `{ <coin>: <price-string> }` for every listed
   * perp + spot pair. Hot path — keep cache tight (1s) at the route level.
   */
  async getAllMids(): Promise<Record<string, string>> {
    if (!this.isLive) return {};
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
        timeoutMs: 5_000,
        maxAttempts: 2,
      });
      if (!res.ok) return {};
      const data = (await res.json().catch(() => null)) as Record<string, string> | null;
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: allMids failed');
      return {};
    }
  }

  /**
   * L2 orderbook proxy — `levels[0]` is bids, `levels[1]` is asks. Each level
   * is `{ px, sz, n }` (price string, size string, # of orders). Cached at
   * the route layer with a short TTL because depth ticks fast.
   */
  async getL2Book(coin: string, dex?: string): Promise<{
    coin: string;
    time?: number;
    levels?: Array<Array<{ px: string; sz: string; n: number }>>;
  } | null> {
    if (!this.isLive) return null;
    const wireCoin = coin.includes(':') ? coin : coin.toUpperCase();
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: wireCoin, ...(dex ? { dex } : {}) }),
        timeoutMs: 5_000,
        maxAttempts: 2,
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        coin?: string;
        time?: number;
        levels?: Array<Array<{ px: string; sz: string; n: number }>>;
      } | null;
      if (!data) return null;
      return { coin: data.coin ?? wireCoin, time: data.time, levels: data.levels };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), coin }, 'hyperliquid: l2Book failed');
      return null;
    }
  }

  /**
   * Recent trades for a coin. HL returns objects `{coin, side, px, sz, time, hash, tid}`.
   * 30s cache at the route layer.
   */
  async getRecentTrades(coin: string, dex?: string): Promise<Array<{ coin: string; side: 'A' | 'B'; px: string; sz: string; time: number; hash: string; tid: number }>> {
    if (!this.isLive) return [];
    const wireCoin = coin.includes(':') ? coin : coin.toUpperCase();
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'recentTrades', coin: wireCoin, ...(dex ? { dex } : {}) }),
        timeoutMs: 5_000,
        maxAttempts: 1,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as unknown;
      return Array.isArray(data) ? (data as Array<{ coin: string; side: 'A' | 'B'; px: string; sz: string; time: number; hash: string; tid: number }>) : [];
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), coin }, 'hyperliquid: recentTrades failed');
      return [];
    }
  }

  /**
   * Funding-rate history for a coin. Hyperliquid `/info` returns hourly
   * `{ coin, fundingRate, premium, time }` rows over the requested window.
   * Used by the detail-page FundingHistory chart. The 7-day default is capped
   * at 30 days to keep payload bounded.
   */
  async getFundingHistory(
    coin: string,
    lookbackMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<Array<{ coin: string; fundingRate: number; premium: number | null; time: number }>> {
    if (!this.isLive) return [];
    const now = Date.now();
    const cap = 30 * 24 * 60 * 60 * 1000;
    const window = Math.max(60 * 60 * 1000, Math.min(cap, lookbackMs));
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'fundingHistory',
          coin: coin.toUpperCase(),
          startTime: now - window,
          endTime: now,
        }),
        timeoutMs: 6_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as unknown;
      if (!Array.isArray(data)) return [];
      return data
        .map((r) => {
          const row = r as { coin?: unknown; fundingRate?: unknown; premium?: unknown; time?: unknown };
          return {
            coin: typeof row.coin === 'string' ? row.coin : coin.toUpperCase(),
            fundingRate: Number(row.fundingRate) || 0,
            premium: row.premium != null ? Number(row.premium) : null,
            time: Number(row.time) || 0,
          };
        })
        .filter((r) => r.time > 0);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), coin }, 'hyperliquid: fundingHistory failed');
      return [];
    }
  }

  /**
   * Parameters for legacy builder-fee approval metadata — NOT a transaction.
   * Normal approval signing is backend-managed. The fee is clamped to the
   * perps cap (10 bps). maxFeeRate is the decimal form (bps / 10000)
   * Hyperliquid's approveBuilderFee action expects.
   */
  builderApprovalParams(maxFeeBps = PERPS_BUILDER_FEE_CAP_BPS): {
    builder: string;
    maxFeeBps: number;
    maxFeeRate: string;
    market: 'perps';
    revocable: true;
    note: string;
  } {
    const safe = Number.isFinite(maxFeeBps) ? maxFeeBps : PERPS_BUILDER_FEE_CAP_BPS;
    const clamped = Math.max(0, Math.min(PERPS_BUILDER_FEE_CAP_BPS, Math.floor(safe)));
    return {
      builder: env.HL_BUILDER_ADDRESS ?? ZERO_ADDRESS,
      maxFeeBps: clamped,
      maxFeeRate: (clamped / 10000).toString(),
      market: 'perps',
      revocable: true,
      note: 'Approve in your main wallet; revoke anytime.',
    };
  }

  /**
   * Place a perp order. Live: sign an L1 `order` action with EIP-712 typed data
   * via Privy, POST it to /exchange, and return the venue's order id. Without
   * a live trading config (markets + privy + builder), a synthetic `hl_demo_*`
   * id is returned so the route + store flow stays exercisable in demo.
   */
  async placeOrder(input: HlOrderInput): Promise<HlOrderResult> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return this.demoPlace(input);
    }
    const attempt = async (): Promise<HlOrderResult> => {
      // Normalize kind from V2 or legacy shape — legacy callers don't set kind.
      const kind: HlOrderKind = input.kind ?? (input.orderType === 'limit' ? 'limit' : 'market');

      const assetId = await this.resolveAssetId(input.coin);
      if (assetId == null) throw new Error('unknown_asset');

      const market = await this.getMarket(input.coin);
      const refPrice = market?.priceUsd ?? 0;
      if (refPrice <= 0) throw new Error('unknown_price');
      const sizeNative = input.qtyUsd / refPrice;
      const szDecimals = market?.szDecimals;

      const builder = configuredBuilder();

      switch (kind) {
        case 'market':
        case 'limit':
          return this.placeFlatOrder({ input, assetId, sizeNative, refPrice, builder, kind, szDecimals });
        case 'stopLimit':
          return this.placeStopLimit({ input, assetId, sizeNative, builder, szDecimals });
        case 'twap':
          return this.placeTwapOrder({ input, assetId, sizeNative, builder, szDecimals });
        default: {
          const _exhaust: never = kind;
          throw new Error('unsupported_kind:' + String(_exhaust));
        }
      }
    };
    try {
      return await attempt();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Perps are the default surface — if the only problem is that the user's
      // margin sits on HL spot, sweep it to perps and retry once so they never
      // see a bare "insufficient margin". Spot orders never reach here.
      if (/insufficient margin/i.test(msg) && input.privyWalletId && input.privyWalletAddress) {
        const spotUsd = await this.spotUsdcBalance(input.privyWalletAddress);
        const moveUsd = Math.floor(spotUsd * 100) / 100;
        if (moveUsd >= 1 && (await this.moveSpotToPerp(input.privyWalletId, input.privyWalletAddress, moveUsd))) {
          await new Promise((r) => setTimeout(r, 1500));
          return await attempt();
        }
      }
      log.warn(
        { err: msg, coin: input.coin, kind: input.kind ?? input.orderType },
        'hyperliquid: order live path failed',
      );
      throw e;
    }
  }

  /** USDC balance on the HL spot clearinghouse for an address (0 on failure). */
  private async spotUsdcBalance(address: string): Promise<number> {
    try {
      const res = await fetch(INFO_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'spotClearinghouseState', user: address }),
      });
      if (!res.ok) return 0;
      const data = (await res.json().catch(() => null)) as { balances?: Array<{ coin?: string; total?: string }> } | null;
      const usdc = (data?.balances ?? []).find((b) => b.coin === 'USDC');
      return usdc ? Number(usdc.total) || 0 : 0;
    } catch {
      return 0;
    }
  }

  /** Move USDC from HL spot to the perps account (usdClassTransfer, user-signed). */
  private async moveSpotToPerp(walletId: string, walletAddress: `0x${string}`, amountUsd: number): Promise<boolean> {
    try {
      const nonce = nextHlNonce();
      const action = {
        type: 'usdClassTransfer' as const,
        signatureChainId: HL_USER_SIGN_CHAIN_ID,
        hyperliquidChain: HL_HYPERLIQUID_CHAIN,
        amount: String(amountUsd),
        toPerp: true,
        nonce,
      };
      const signature = await hlSignUserSignedAction({ walletId, walletAddress, action, types: UsdClassTransferTypes });
      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, signature, nonce }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      const ok = res.ok && data.status === 'ok';
      log.info({ amountUsd, ok }, 'hyperliquid: auto spot->perp margin sweep');
      return ok;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: spot->perp sweep failed');
      return false;
    }
  }

  private async demoPlace(input: HlOrderInput): Promise<HlOrderResult> {
    const market = await this.getMarket(input.coin);
    const entry = market?.priceUsd ?? 0;
    const prefix = input.kind === 'twap'
      ? 'hl_demo_twap_'
      : input.kind === 'stopLimit'
      ? 'hl_demo_stop_'
      : 'hl_demo_';
    return {
      orderId: prefix + hex(8),
      filledQtyUsd: input.qtyUsd,
      entryPriceUsd: entry,
      demo: true,
      state: input.kind === 'twap'
        ? 'twap_active'
        : input.kind === 'stopLimit'
        ? 'triggered'
        : (input.kind === 'limit' && (input.tif ?? 'Gtc') !== 'Ioc')
        ? 'resting'
        : 'filled',
    };
  }

  private async placeFlatOrder(args: {
    input: HlOrderInput;
    assetId: number;
    sizeNative: number;
    refPrice: number;
    builder?: { b: `0x${string}`; f: number };
    kind: 'market' | 'limit';
    szDecimals?: number | null;
  }): Promise<HlOrderResult> {
    const { input, assetId, sizeNative, refPrice, builder, kind, szDecimals } = args;

    const tif: HlTif = input.tif ?? (kind === 'limit' ? 'Gtc' : 'Ioc');

    // Limit price: explicit when kind=limit. For market we send price ±1% as
    // the IOC slippage band — HL requires a price field even for market orders.
    const limitPx = kind === 'limit' && input.limitPriceUsd
      ? input.limitPriceUsd
      : input.sideLong
      ? refPrice * 1.01
      : refPrice * 0.99;

    const parentLeg = {
      a: assetId,
      b: input.sideLong,
      // Canonical HL format (no trailing zeros) — see hl-format.ts. Trailing
      // zeros from .toFixed() make HL recover a phantom signer and reject.
      p: formatHlPerpPx(limitPx, szDecimals),
      s: formatHlSize(sizeNative, szDecimals),
      r: Boolean(input.reduceOnly),
      t: { limit: { tif } } as const,
    };

    const hasAttached = Boolean(input.takeProfit || input.stopLoss);
    const orders: Array<typeof parentLeg | TriggerLeg> = [parentLeg];
    if (input.takeProfit) {
      orders.push(triggerLegFromTpSl(assetId, !input.sideLong, sizeNative, input.takeProfit, 'tp', refPrice, szDecimals));
    }
    if (input.stopLoss) {
      orders.push(triggerLegFromTpSl(assetId, !input.sideLong, sizeNative, input.stopLoss, 'sl', refPrice, szDecimals));
    }

    const action = {
      type: 'order' as const,
      orders,
      grouping: hasAttached ? ('normalTpsl' as const) : ('na' as const),
      ...(builder ? { builder } : {}),
    };
    const nonce = nextHlNonce();
    const signature = await hlSignL1Action({
      walletId: input.privyWalletId!,
      walletAddress: input.privyWalletAddress!,
      action,
      nonce,
      isMainnet: true,
    });

    const data = await this.submitExchange(action, nonce, signature);
    const statuses = data.response?.data?.statuses ?? [];
    statuses.forEach((status) => assertVenueStatusOk(status, 'order_rejected'));
    const parentStatus = statuses[0];
    const fill = parentStatus?.filled;
    const oid = fill?.oid ?? parentStatus?.resting?.oid;
    if (oid == null) {
      log.warn({ data }, 'hyperliquid: order missing venue oid');
      throw new Error('order_missing_oid');
    }

    const legs: HlOrderResult['legs'] = {};
    if (input.takeProfit) {
      const s = statuses[1];
      const legOid = s?.filled?.oid ?? s?.resting?.oid;
      if (legOid != null) legs.tp = { orderId: 'hl_' + String(legOid) };
    }
    if (input.stopLoss) {
      const idx = input.takeProfit ? 2 : 1;
      const s = statuses[idx];
      const legOid = s?.filled?.oid ?? s?.resting?.oid;
      if (legOid != null) legs.sl = { orderId: 'hl_' + String(legOid) };
    }

    return {
      orderId: 'hl_' + String(oid),
      filledQtyUsd: fill ? input.qtyUsd : 0,
      entryPriceUsd: fill?.avgPx ? Number(fill.avgPx) : fill?.px ? Number(fill.px) : refPrice,
      demo: false,
      state: fill ? 'filled' : 'resting',
      legs: Object.keys(legs).length ? legs : undefined,
    };
  }

  private async placeStopLimit(args: {
    input: HlOrderInput;
    assetId: number;
    sizeNative: number;
    builder?: { b: `0x${string}`; f: number };
    szDecimals?: number | null;
  }): Promise<HlOrderResult> {
    const { input, assetId, sizeNative, builder, szDecimals } = args;
    if (!input.triggerPriceUsd || !input.limitPriceUsd) {
      throw new Error('stop_limit_requires_trigger_and_limit');
    }
    if (!input.stopKind) throw new Error('stop_limit_requires_stopKind');

    const action = {
      type: 'order' as const,
      orders: [
        {
          a: assetId,
          b: input.sideLong,
          // Canonical HL format (no trailing zeros) — see hl-format.ts.
          p: formatHlPerpPx(input.limitPriceUsd, szDecimals),
          s: formatHlSize(sizeNative, szDecimals),
          r: Boolean(input.reduceOnly),
          t: {
            trigger: {
              triggerPx: formatHlPerpPx(input.triggerPriceUsd, szDecimals),
              isMarket: false,
              tpsl: input.stopKind,
            },
          } as const,
        },
      ],
      grouping: 'na' as const,
      ...(builder ? { builder } : {}),
    };
    const nonce = nextHlNonce();
    const signature = await hlSignL1Action({
      walletId: input.privyWalletId!,
      walletAddress: input.privyWalletAddress!,
      action,
      nonce,
      isMainnet: true,
    });

    const data = await this.submitExchange(action, nonce, signature);
    const status = data.response?.data?.statuses?.[0];
    assertVenueStatusOk(status, 'order_rejected');
    const oid = status?.filled?.oid ?? status?.resting?.oid;
    if (oid == null) throw new Error('order_missing_oid');
    return {
      orderId: 'hl_' + String(oid),
      filledQtyUsd: 0,
      entryPriceUsd: input.limitPriceUsd,
      demo: false,
      state: 'triggered',
    };
  }

  private async placeTwapOrder(args: {
    input: HlOrderInput;
    assetId: number;
    sizeNative: number;
    builder?: { b: `0x${string}`; f: number };
    szDecimals?: number | null;
  }): Promise<HlOrderResult> {
    const { input, assetId, sizeNative, builder, szDecimals } = args;
    const minutes = Math.max(5, Math.min(1440, Math.floor(input.durationMinutes ?? 30)));
    const action = {
      type: 'twapOrder' as const,
      twap: {
        a: assetId,
        b: input.sideLong,
        s: formatHlSize(sizeNative, szDecimals),
        r: Boolean(input.reduceOnly),
        m: minutes,
        t: Boolean(input.randomize),
      },
      ...(builder ? { builder } : {}),
    };
    const nonce = nextHlNonce();
    const signature = await hlSignL1Action({
      walletId: input.privyWalletId!,
      walletAddress: input.privyWalletAddress!,
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
      throwIfProviderRateLimited(res, 'hyperliquid');
      throw new Error('twap_rejected');
    }
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      response?: { data?: { status?: { running?: { twapId?: number | string } } } };
    };
    if (data.status !== 'ok') throw new Error('twap_rejected');
    const twapId = data.response?.data?.status?.running?.twapId;
    if (twapId == null) throw new Error('twap_missing_id');
    return {
      orderId: 'hl_twap_' + String(twapId),
      filledQtyUsd: 0,
      entryPriceUsd: 0,
      demo: false,
      state: 'twap_active',
    };
  }

  private async submitExchange(action: unknown, nonce: number, signature: unknown): Promise<{
    status?: string;
    response?: {
      data?: { statuses?: Array<HlOrderVenueStatus> };
    };
  }> {
    const res = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature }),
    });
    if (!res.ok) {
      throwIfProviderRateLimited(res, 'hyperliquid');
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'hyperliquid: order rejected');
      throw new Error('order_rejected');
    }
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      response?: {
        data?: { statuses?: Array<HlOrderVenueStatus> };
      };
    };
    if (data.status !== 'ok') {
      log.warn({ data }, 'hyperliquid: order status not ok');
      throw new Error('order_rejected');
    }
    return data;
  }

  /**
   * Asset id cache. The HL `/info meta` response lists every coin with its
   * `universe` index — that's the integer the order action's `a` field
   * expects. Cached because it never changes within a process; refreshed on
   * cache miss only.
   */
  private assetIdCache: Map<string, number> | null = null;

  private async resolveAssetId(coin: string): Promise<number | null> {
    if (!this.assetIdCache) {
      try {
        const res = await fetch(INFO_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'meta' }),
        });
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as { universe?: Array<{ name: string }> } | null;
        const map = new Map<string, number>();
        data?.universe?.forEach((u, i) => map.set(u.name.toUpperCase(), i));
        this.assetIdCache = map;
      } catch {
        return null;
      }
    }
    return this.assetIdCache.get(coin.toUpperCase()) ?? null;
  }

  /**
   * Cancel an open order by exchange oid. Live: sign a `cancel` L1 action.
   * Demo: synthetic ok.
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
      const venueOid = /^hl_(\d+)$/i.exec(input.externalRef)?.[1] ?? (/^\d+$/.test(input.externalRef) ? input.externalRef : null);
      if (!venueOid) {
        if (/^hl_demo_/i.test(input.externalRef)) return { ok: true, demo: true };
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
        throwIfProviderRateLimited(res, 'hyperliquid');
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
        'hyperliquid: cancel live path failed',
      );
      throw e;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // HL order-type expansion v2 — adapter stubs that mirror the route table.
  // Each phase past Phase 2 replaces these with real L1 action builders +
  // Privy server-wallet signing via hlSignL1Action / hlSignUserSignedAction.
  // ──────────────────────────────────────────────────────────────────────

  async cancelMany(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    cancels: Array<{ coin: string; orderId: string }>;
  }): Promise<{ ok: boolean; results: Array<{ orderId: string; ok: boolean; error?: { code: string; message: string } }> }> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return {
        ok: true,
        results: input.cancels.map((c) => ({ orderId: c.orderId, ok: true })),
      };
    }
    if (input.cancels.length === 0) return { ok: true, results: [] };
    try {
      // Resolve assetId per coin (cached lookup). Build the cancels array; skip
      // any orderId we can't parse to a numeric oid (HL refuses mixed batches).
      const parsed: Array<{ a: number; o: number; orderId: string } | null> = await Promise.all(
        input.cancels.map(async (c) => {
          const venueOid = /^hl_(\d+)$/i.exec(c.orderId)?.[1] ?? (/^\d+$/.test(c.orderId) ? c.orderId : null);
          if (!venueOid) return null;
          const oid = Number(venueOid);
          if (!Number.isFinite(oid)) return null;
          const a = await this.resolveAssetId(c.coin);
          if (a == null) return null;
          return { a, o: oid, orderId: c.orderId };
        }),
      );
      const valid = parsed.filter((p): p is { a: number; o: number; orderId: string } => p !== null);
      if (valid.length === 0) {
        return {
          ok: true,
          results: input.cancels.map((c) => ({
            orderId: c.orderId,
            ok: false,
            error: { code: 'invalid_oid', message: 'order id could not be parsed' },
          })),
        };
      }
      const action = { type: 'cancel' as const, cancels: valid.map(({ a, o }) => ({ a, o })) };
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
        throwIfProviderRateLimited(res, 'hyperliquid');
        throw new Error('cancel_many_rejected');
      }
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        response?: { data?: { statuses?: unknown[] } };
      };
      if (data.status !== 'ok') throw new Error('cancel_many_rejected');
      const venueStatuses = data.response?.data?.statuses ?? [];
      const statusByOrderId = new Map(valid.map((v, i) => [v.orderId, venueStatusError(venueStatuses[i])]));
      return {
        ok: true,
        results: input.cancels.map((c) => {
          if (!statusByOrderId.has(c.orderId)) {
            return {
              orderId: c.orderId,
              ok: false,
              error: { code: 'invalid_oid', message: 'order id could not be parsed' },
            };
          }
          const error = statusByOrderId.get(c.orderId);
          return {
            orderId: c.orderId,
            ok: !error,
            error: error ? { code: 'venue_cancel_failed', message: error } : undefined,
          };
        }),
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: cancel-many failed');
      throw e;
    }
  }

  async modifyOrder(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    coin: string;
    orderId: string;
    order: HlOrderInput;
  }): Promise<HlOrderResult> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return {
        orderId: input.orderId,
        filledQtyUsd: input.order.qtyUsd,
        entryPriceUsd: input.order.limitPriceUsd ?? 0,
        demo: true,
        state: 'resting',
      };
    }
    try {
      const venueOid = /^hl_(\d+)$/i.exec(input.orderId)?.[1] ?? (/^\d+$/.test(input.orderId) ? input.orderId : null);
      if (!venueOid) throw new Error('invalid_oid');
      const oid = Number(venueOid);
      const assetId = await this.resolveAssetId(input.coin);
      if (assetId == null) throw new Error('unknown_asset');
      const market = await this.getMarket(input.coin);
      const refPrice = market?.priceUsd ?? 0;
      if (refPrice <= 0) throw new Error('unknown_price');
      // Modify means "same order, new price": read the RESTING order from
      // the venue and preserve its remaining coin size, side, reduce-only,
      // and TIF. Recomputing size from qtyUsd at the CURRENT mark (the old
      // behavior) silently resized the order whenever the mark had moved,
      // and re-upped the full notional on partially-filled orders.
      const open = (await this.getOpenOrders(input.privyWalletAddress, input.coin))
        .find((o) => o.orderId === `hl_${oid}`);
      if (!open) throw new Error('order_not_found');
      if (!(open.qty > 0)) throw new Error('order_not_found');
      const kind = open.kind === 'stopLimit' ? 'stopLimit' : 'limit';
      const sizeNative = open.qty;
      const limitPx = (input.order.limitPriceUsd && input.order.limitPriceUsd > 0)
        ? input.order.limitPriceUsd
        : open.limitPriceUsd && open.limitPriceUsd > 0
        ? open.limitPriceUsd
        : input.order.sideLong ? refPrice * 1.01 : refPrice * 0.99;
      const tif: HlTif = open.tif ?? input.order.tif ?? 'Gtc';
      const triggerPx = input.order.triggerPriceUsd && input.order.triggerPriceUsd > 0
        ? input.order.triggerPriceUsd
        : open.triggerPriceUsd;
      const szDecimals = market?.szDecimals;
      const orderLeg = {
        a: assetId,
        b: open.sideLong,
        // Canonical HL format (no trailing zeros) — see hl-format.ts.
        p: formatHlPerpPx(limitPx, szDecimals),
        s: formatHlSize(sizeNative, szDecimals),
        r: open.reduceOnly,
        t: kind === 'stopLimit' && triggerPx && input.order.stopKind
          ? { trigger: { triggerPx: formatHlPerpPx(triggerPx, szDecimals), isMarket: false, tpsl: input.order.stopKind } } as const
          : { limit: { tif } } as const,
      };
      const action = { type: 'modify' as const, oid, order: orderLeg };
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
        throwIfProviderRateLimited(res, 'hyperliquid');
        throw new Error('modify_rejected');
      }
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (data.status !== 'ok') throw new Error('modify_rejected');
      return {
        orderId: input.orderId,
        // Notional of the PRESERVED size at the new price — not the caller's
        // stale qtyUsd, which reflects placement-time pricing.
        filledQtyUsd: sizeNative * limitPx,
        entryPriceUsd: limitPx,
        demo: false,
        state: 'resting',
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: modify failed');
      throw e;
    }
  }

  async updateLeverage(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    coin: string;
    leverage: number;
    isCross: boolean;
  }): Promise<{ ok: boolean; demo: boolean }> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return { ok: true, demo: true };
    }
    try {
      const assetId = await this.resolveAssetId(input.coin);
      if (assetId == null) throw new Error('unknown_asset');
      const action = {
        type: 'updateLeverage' as const,
        asset: assetId,
        isCross: Boolean(input.isCross),
        leverage: Math.floor(input.leverage),
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
        throwIfProviderRateLimited(res, 'hyperliquid');
        throw new Error('update_leverage_rejected');
      }
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (data.status !== 'ok') throw new Error('update_leverage_rejected');
      return { ok: true, demo: false };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: update-leverage failed');
      throw e;
    }
  }

  async updateIsolatedMargin(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    coin: string;
    sideLong: boolean;
    /** Positive adds margin to the isolated position, negative removes. */
    amountUsd: number;
  }): Promise<{ ok: boolean; demo: boolean }> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return { ok: true, demo: true };
    }
    try {
      const assetId = await this.resolveAssetId(input.coin);
      if (assetId == null) throw new Error('unknown_asset');
      // Official payload: `ntli` is USDC with 6 decimals as an INT
      // (1_000_000 = $1), signed — positive adds, negative removes. NOT the
      // decimal-string format usdClassTransfer uses; mixing the two is the
      // classic HL integration bug. `isBuy` has no effect until hedge mode
      // ships — docs say always send true.
      const ntli = Math.round(input.amountUsd * 1_000_000);
      if (ntli === 0) throw new Error('invalid_margin_delta');
      const action = {
        type: 'updateIsolatedMargin' as const,
        asset: assetId,
        isBuy: true,
        ntli,
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
        throwIfProviderRateLimited(res, 'hyperliquid');
        throw new Error('update_isolated_margin_rejected');
      }
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (data.status !== 'ok') throw new Error('update_isolated_margin_rejected');
      return { ok: true, demo: false };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid: update-isolated-margin failed',
      );
      throw e;
    }
  }

  async usdClassTransfer(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    amountUsd: number;
    toPerp: boolean;
  }): Promise<{ ok: boolean; callId: string; amountUsd: number; toPerp: boolean; demo: boolean }> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return {
        ok: true,
        callId: 'hl_demo_xfer_' + hex(8),
        amountUsd: input.amountUsd,
        toPerp: input.toPerp,
        demo: true,
      };
    }
    try {
      const nonce = nextHlNonce();
      const action = {
        type: 'usdClassTransfer' as const,
        signatureChainId: HL_USER_SIGN_CHAIN_ID,
        hyperliquidChain: HL_HYPERLIQUID_CHAIN,
        amount: input.amountUsd.toString(),
        toPerp: Boolean(input.toPerp),
        nonce,
      };
      const signature = await hlSignUserSignedAction({
        walletId: input.privyWalletId,
        walletAddress: input.privyWalletAddress,
        action,
        types: UsdClassTransferTypes,
      });
      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, signature, nonce }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (!res.ok || data.status !== 'ok') {
        throwIfProviderRateLimited(res, 'hyperliquid');
        log.warn({ status: res.status, data }, 'hyperliquid: usdClassTransfer rejected');
        throw new Error('usd_class_transfer_rejected');
      }
      return {
        ok: true,
        callId: 'hl_xfer_' + String(nonce),
        amountUsd: input.amountUsd,
        toPerp: input.toPerp,
        demo: false,
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: usdClassTransfer failed');
      throw e;
    }
  }

  async usdSend(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    destination: `0x${string}`;
    amountUsd: number;
  }): Promise<{ ok: boolean; callId: string; destination: string; amountUsd: number; demo: boolean }> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return {
        ok: true,
        callId: 'hl_demo_usd_send_' + hex(8),
        destination: input.destination,
        amountUsd: input.amountUsd,
        demo: true,
      };
    }
    try {
      const time = nextHlNonce();
      const action = {
        type: 'usdSend' as const,
        signatureChainId: HL_USER_SIGN_CHAIN_ID,
        hyperliquidChain: HL_HYPERLIQUID_CHAIN,
        destination: input.destination.toLowerCase() as `0x${string}`,
        amount: input.amountUsd.toString(),
        time,
      };
      const signature = await hlSignUserSignedAction({
        walletId: input.privyWalletId,
        walletAddress: input.privyWalletAddress,
        action,
        types: UsdSendTypes,
      });
      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, signature, nonce: time }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (!res.ok || data.status !== 'ok') {
        throwIfProviderRateLimited(res, 'hyperliquid');
        log.warn({ status: res.status, data }, 'hyperliquid: usdSend rejected');
        throw new Error('usd_send_rejected');
      }
      return {
        ok: true,
        callId: 'hl_usd_send_' + String(time),
        destination: input.destination,
        amountUsd: input.amountUsd,
        demo: false,
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: usdSend failed');
      throw e;
    }
  }

  async transferToDex(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    amountUsd: number;
    sourceDex?: string;
    destinationDex: string;
    token?: string;
  }): Promise<{
    ok: boolean;
    callId: string;
    amountUsd: number;
    sourceDex: string;
    destinationDex: string;
    token: string;
    demo: boolean;
  }> {
    const sourceDex = input.sourceDex ?? '';
    const token = input.token ?? HL_USDC_TOKEN;
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return {
        ok: true,
        callId: 'hl_demo_dex_xfer_' + hex(8),
        amountUsd: input.amountUsd,
        sourceDex,
        destinationDex: input.destinationDex,
        token,
        demo: true,
      };
    }
    try {
      const nonce = nextHlNonce();
      const action = {
        type: 'sendAsset' as const,
        signatureChainId: HL_USER_SIGN_CHAIN_ID,
        hyperliquidChain: HL_HYPERLIQUID_CHAIN,
        destination: input.privyWalletAddress.toLowerCase() as `0x${string}`,
        sourceDex,
        destinationDex: input.destinationDex,
        token,
        amount: input.amountUsd.toString(),
        fromSubAccount: '',
        nonce,
      };
      const signature = await hlSignUserSignedAction({
        walletId: input.privyWalletId,
        walletAddress: input.privyWalletAddress,
        action,
        types: SendAssetTypes,
      });
      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, signature, nonce }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (!res.ok || data.status !== 'ok') {
        throwIfProviderRateLimited(res, 'hyperliquid');
        log.warn({ status: res.status, data }, 'hyperliquid: transferToDex rejected');
        throw new Error('transfer_to_dex_rejected');
      }
      return {
        ok: true,
        callId: 'hl_dex_xfer_' + String(nonce),
        amountUsd: input.amountUsd,
        sourceDex,
        destinationDex: input.destinationDex,
        token,
        demo: false,
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: transferToDex failed');
      throw e;
    }
  }

  async withdraw3(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    destination: `0x${string}`;
    amountUsd: number;
  }): Promise<{ ok: boolean; callId: string; destination: string; amountUsd: number; demo: boolean }> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.privyWalletAddress) {
      return {
        ok: true,
        callId: 'hl_demo_wdr_' + hex(8),
        destination: input.destination,
        amountUsd: input.amountUsd,
        demo: true,
      };
    }
    try {
      const time = nextHlNonce();
      const action = {
        type: 'withdraw3' as const,
        signatureChainId: HL_USER_SIGN_CHAIN_ID,
        hyperliquidChain: HL_HYPERLIQUID_CHAIN,
        destination: input.destination.toLowerCase() as `0x${string}`,
        amount: input.amountUsd.toString(),
        time,
      };
      const signature = await hlSignUserSignedAction({
        walletId: input.privyWalletId,
        walletAddress: input.privyWalletAddress,
        action,
        types: Withdraw3Types,
      });
      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, signature, nonce: time }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (!res.ok || data.status !== 'ok') {
        throwIfProviderRateLimited(res, 'hyperliquid');
        log.warn({ status: res.status, data }, 'hyperliquid: withdraw3 rejected');
        throw new Error('withdraw3_rejected');
      }
      return {
        ok: true,
        callId: 'hl_wdr_' + String(time),
        destination: input.destination,
        amountUsd: input.amountUsd,
        demo: false,
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: withdraw3 failed');
      throw e;
    }
  }

  async getOpenOrders(userAddress: string | null, coin?: string): Promise<Array<{
    orderId: string;
    coin: string;
    sideLong: boolean;
    qty: number;
    qtyUsd: number;
    limitPriceUsd: number | null;
    triggerPriceUsd: number | null;
    tif: HlTif | null;
    kind: 'market' | 'limit' | 'stopLimit' | 'twap';
    reduceOnly: boolean;
    createdAtMs: number;
  }>> {
    if (!this.isLiveTrading || !userAddress) return [];
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'frontendOpenOrders', user: userAddress }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as Array<{
        coin?: string;
        side?: string;        // 'B' = bid (long buy), 'A' = ask (short sell)
        limitPx?: string;
        triggerPx?: string;
        sz?: string;
        oid?: number;
        timestamp?: number;
        tif?: string;
        orderType?: string;
        reduceOnly?: boolean;
        isTrigger?: boolean;
        isPositionTpsl?: boolean;
      }> | null;
      if (!Array.isArray(data)) return [];
      const filter = coin?.trim().toUpperCase();
      return data
        .filter((o) => o.coin && o.oid != null)
        .filter((o) => !filter || String(o.coin).toUpperCase() === filter)
        .map((o) => {
          const qty = Number(o.sz ?? '0');
          const limitPx = o.limitPx ? Number(o.limitPx) : null;
          const triggerPx = o.triggerPx ? Number(o.triggerPx) : null;
          const sideLong = (o.side ?? '').toUpperCase() === 'B';
          const kind: 'market' | 'limit' | 'stopLimit' | 'twap' = triggerPx
            ? 'stopLimit'
            : String(o.orderType ?? '').toLowerCase().includes('twap')
            ? 'twap'
            : limitPx
            ? 'limit'
            : 'market';
          const tifRaw = String(o.tif ?? '').trim();
          const tif: HlTif | null = tifRaw === 'Gtc' || tifRaw === 'Ioc' || tifRaw === 'Alo' ? (tifRaw as HlTif) : null;
          return {
            orderId: 'hl_' + String(o.oid),
            coin: String(o.coin).toUpperCase(),
            sideLong,
            qty,
            qtyUsd: limitPx ? qty * limitPx : 0,
            limitPriceUsd: limitPx,
            triggerPriceUsd: triggerPx,
            tif,
            kind,
            reduceOnly: Boolean(o.reduceOnly),
            createdAtMs: Number(o.timestamp ?? 0),
          };
        });
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: open-orders unreachable');
      return [];
    }
  }

  async getUserFills(userAddress: string | null, params?: { limit?: number; sinceMs?: number }): Promise<Array<{
    orderId: string;
    coin: string;
    sideLong: boolean;
    qty: number;
    priceUsd: number;
    feeUsd: number;
    timeMs: number;
    hash: string;
    /** HL fill direction verbatim ("Open Long", "Close Short", ...). */
    dir: string;
    /** Realized PnL on closing fills; null on opens. */
    closedPnlUsd: number | null;
    /** True when HL marks the fill as a liquidation. */
    liquidation: boolean;
  }>> {
    if (!this.isLiveTrading || !userAddress) return [];
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'userFills', user: userAddress }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as Array<{
        coin?: string;
        side?: string;
        px?: string;
        sz?: string;
        time?: number;
        hash?: string;
        oid?: number;
        fee?: string;
        dir?: string;
        closedPnl?: string;
        liquidation?: unknown;
      }> | null;
      if (!Array.isArray(data)) return [];
      const sinceMs = params?.sinceMs ?? 0;
      const limit = Math.max(1, Math.min(2000, params?.limit ?? 200));
      return data
        .filter((f) => f.coin && f.oid != null)
        .filter((f) => !sinceMs || Number(f.time ?? 0) > sinceMs)
        .slice(0, limit)
        .map((f) => ({
          orderId: 'hl_' + String(f.oid),
          coin: String(f.coin).toUpperCase(),
          sideLong: (f.side ?? '').toUpperCase() === 'B',
          qty: Number(f.sz ?? '0'),
          priceUsd: Number(f.px ?? '0'),
          feeUsd: Number(f.fee ?? '0'),
          timeMs: Number(f.time ?? 0),
          hash: String(f.hash ?? ''),
          dir: String(f.dir ?? ''),
          closedPnlUsd: f.closedPnl != null ? Number(f.closedPnl) : null,
          liquidation: f.liquidation != null,
        }));
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: user-fills unreachable');
      return [];
    }
  }

  async getUserState(userAddress: string | null): Promise<{
    equityUsd: number;
    marginUsedUsd: number;
    withdrawableUsd: number;
    accountValueUsd: number;
    positions: HlPosition[];
  }> {
    if (!this.isLiveTrading || !userAddress) {
      return { equityUsd: 0, marginUsedUsd: 0, withdrawableUsd: 0, accountValueUsd: 0, positions: [] };
    }
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: userAddress }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        return { equityUsd: 0, marginUsedUsd: 0, withdrawableUsd: 0, accountValueUsd: 0, positions: [] };
      }
      const data = (await res.json().catch(() => null)) as {
        marginSummary?: { accountValue?: string; totalMarginUsed?: string; totalRawUsd?: string };
        withdrawable?: string;
        assetPositions?: Parameters<typeof mapClearinghousePositions>[0];
      } | null;
      const accountValueUsd = Number(data?.marginSummary?.accountValue ?? '0') || 0;
      const marginUsedUsd = Number(data?.marginSummary?.totalMarginUsed ?? '0') || 0;
      const equityUsd = accountValueUsd;
      const withdrawableUsd = Number(data?.withdrawable ?? '0') || 0;
      const positions = mapClearinghousePositions(data?.assetPositions);
      return { equityUsd, marginUsedUsd, withdrawableUsd, accountValueUsd, positions };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'hyperliquid: user-state unreachable');
      return { equityUsd: 0, marginUsedUsd: 0, withdrawableUsd: 0, accountValueUsd: 0, positions: [] };
    }
  }

  /**
   * Read the user's open positions from the venue. Live: POST /info with
   * `clearinghouseState`. Demo: empty array — callers reconcile with the store's
   * `nb_market_positions` rows for the demo surface.
   */
  async getPositions(userAddress: string | null): Promise<HlPosition[]> {
    if (!this.isLiveTrading || !userAddress) return [];
    try {
      const res = await httpRequest(INFO_URL, {
        vendor: 'hyperliquid',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: userAddress }),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as {
        assetPositions?: Parameters<typeof mapClearinghousePositions>[0];
      } | null;
      return mapClearinghousePositions(data?.assetPositions);
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'hyperliquid: positions unreachable',
      );
      return [];
    }
  }
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

function mapMetaAndAssetCtxs(data: HlMetaAndAssetCtxs | null): HlMarket[] {
  if (!Array.isArray(data) || data.length < 2) return [];
  const [meta, ctxs] = data;
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  if (!Array.isArray(ctxs) || universe.length === 0) return [];

  const markets: HlMarket[] = [];
  for (let i = 0; i < universe.length; i++) {
    const asset = universe[i];
    const ctx = ctxs[i];
    if (!asset || !ctx || asset.isDelisted === true) continue;

    const coin = String(asset.name ?? '').trim().toUpperCase();
    if (!coin) continue;

    const priceUsd = positiveNumberOrNull(ctx.markPx) ?? positiveNumberOrNull(ctx.midPx);
    if (priceUsd === null) continue;

    markets.push({
      coin,
      priceUsd,
      change24hPct: pctChange(priceUsd, positiveNumberOrNull(ctx.prevDayPx)),
      maxLeverage: numberOrNull(asset.maxLeverage),
      dayVolumeUsd: numberOrNull(ctx.dayNtlVlm),
      openInterest: numberOrNull(ctx.openInterest),
      fundingRate: numberOrNull(ctx.funding),
      szDecimals: numberOrNull(asset.szDecimals),
    });
  }

  return markets
    .sort((a, b) => (b.dayVolumeUsd ?? 0) - (a.dayVolumeUsd ?? 0));
}

function demo(): HlMarket[] {
  return DEMO_MARKETS.map((m) => ({ ...m }));
}

export const hyperliquid = new HyperliquidAdapter();

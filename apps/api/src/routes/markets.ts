/**
 * Markets — Hyperliquid (perps) + Polymarket (prediction markets).
 *
 * READS are session-gated, eligibility-gated, and geo-gated. WRITES (Sprint 10
 * Item E) layer on additional hard guards on every POST:
 *   1. requireSession    — bearer JWT
 *   2. marketsGate       — features.markets must be on (else 403)
 *   3. region check      — live writes trust only Cloudflare country metadata
 *                          and return 451 region_blocked when blocked/unknown
 *   4. kill-switch       — `u.killSwitch` returns 423 account_frozen
 *
 * Demo execution remains available when a venue is not configured for live
 * trading. Once a venue reports `isLiveTrading`, routes must have a persisted
 * Privy wallet id before they call the adapter; otherwise they return 503
 * instead of recording a synthetic demo order. Every successful place-order
 * persists the row through `store.placeMarketOrder` so `/positions` can answer
 * without a venue call.
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireSession } from '../lib/auth.js';
import { env, features } from '../lib/env.js';
import { sendExpoPushToUser } from '../lib/expo-push.js';
import { hyperliquid, HL_USDC_TOKEN } from '../lib/markets/hyperliquid.js';
import { hyperliquidSpot } from '../lib/markets/hyperliquid-spot.js';
import { Hip3RateLimitError, hyperliquidHip3, HIP3_DEX_NAME } from '../lib/markets/hyperliquid-hip3.js';
import { cleanGtInterval, getTokenCandles } from '../lib/markets/gecko-terminal.js';
import { jupiter, JUPITER_SOL_MINT } from '../lib/markets/jupiter.js';
import { polymarket, type PmMarket } from '../lib/markets/polymarket.js';
import { readGlobalMetrics } from '../lib/markets/global-metrics.js';
import { pumpfun } from '../lib/markets/pumpfun.js';
import { xstocks } from '../lib/markets/xstocks.js';
import { deriveL2Credentials, type PmClobCreds } from '../lib/markets/pm-clob.js';
import { convertPmCollateral, enablePmTrading, getPmTradingStatus } from '../lib/markets/pm-approvals.js';
import {
  ensureBuilderDepositWallet,
  fundBuilderDepositWallet,
  getBuilderLaneFunder,
  getDepositWalletCollateralUsd,
  getDepositWalletStatus,
  pmBuilderLaneEnabled,
} from '../lib/markets/pm-relayer.js';
import { ProviderRateLimitError } from '../lib/markets/provider-errors.js';
import { isLiveWriteCountryAllowed, isRegionExemptUser } from '../lib/markets/region.js';
import { PolymarketSellInput } from '@nexa/shared-zod';
import {
  MarketPreflightError,
  type MarketAdapter,
  type MarketAdapterContext,
  type NormalizedOrderResult,
  type ParseResult,
} from '../lib/markets/types.js';
import { store } from '../store/index.js';
import type {
  LifecycleTransitionInput,
  MarketOrderCompletionInput,
  MarketOrderReservationResult,
  MarketOrderStatus,
  MarketPosition,
  MarketVenue,
  SessionUser,
} from '../store/types.js';
import { transferStore, type Transfer } from '../store/transfers.js';
import { marketsOrders, marketRouterRequests, marketRouterDuration } from '../lib/metrics.js';
import { configuredRateBps, recordFee } from '../lib/fees.js';
import { liveMeta, providerDemoMeta } from '../lib/sourced.js';
import { log } from '../lib/log.js';
import { ApiError } from '../lib/errors.js';
import { isSafeModeDisabled } from '../lib/safe-mode.js';
import {
  hlSignUserSignedAction,
  HL_USER_SIGN_CHAIN_ID,
  HL_HYPERLIQUID_CHAIN,
  nextHlNonce,
} from '../lib/markets/hl-signer.js';
import { ApproveBuilderFeeTypes } from '@nktkas/hyperliquid/api/exchange';
import {
  currentHlBuilderFeeTenths,
  ensureHlBuilderApproval,
  hlBuilderFeeEnabled,
} from '../lib/markets/hl-builder-approval.js';
import { walletService } from '../lib/chain/wallet.js';
import { readPortfolioBalances } from '../lib/chain/balances.js';
import { pmLeaderboardIndex, type PmLeaderboardSnapshotPayload } from '../store/polymarket-index.js';

export const marketRoutes = new Hono();

// 502/504 are reserved for real gateways: Cloudflare swallows origin 502/504
// and serves its own CORS-less error page, so the browser reads "Failed to
// fetch" instead of our JSON. Application failures use 422.
type InlineMarketErrorStatus = 403 | 409 | 412 | 422 | 423 | 429 | 451 | 503;

function marketError(
  c: Context,
  status: InlineMarketErrorStatus,
  code: string,
  details?: unknown,
  message?: string,
): Response {
  return c.json(
    {
      ok: false,
      error: {
        code,
        message: message ?? code,
        ...(details !== undefined ? { details } : {}),
      },
    },
    status,
  );
}

const CANCELLABLE_MARKET_ORDER_STATUSES: ReadonlySet<MarketOrderStatus> = new Set([
  'open',
  'resting',
  'partially_filled',
  'accepted',
]);

function canCancelMarketOrder(position: Pick<MarketPosition, 'status'>): boolean {
  return CANCELLABLE_MARKET_ORDER_STATUSES.has(position.status);
}

function orderNotCancellable(c: Context, position: Pick<MarketPosition, 'status'>): Response {
  return marketError(c, 409, 'order_not_cancellable', { status: position.status });
}

function assertCancellableOrder(c: Context, position: Pick<MarketPosition, 'status'>): Response | null {
  return canCancelMarketOrder(position) ? null : orderNotCancellable(c, position);
}

/**
 * Sprint 16 — public reads. The list endpoints for Hyperliquid + Polymarket
 * wrap upstream public APIs (`api.hyperliquid.xyz/info` and
 * `gamma-api.polymarket.com`). Any caller can already fetch the same data
 * direct from those endpoints, so requiring an auth session here adds no
 * security but blocks the landing page + visitor-mode app from rendering
 * market rows. Auth still wraps everything user-specific (positions, orders).
 */
/**
 * Shared, non-personalized market read paths — identical payload for every
 * caller. Source of truth for BOTH the session gate below (public = no auth)
 * AND the edge-cache middleware in index.ts (scale plan 1.1), so the two can
 * never drift: anything public here is by construction safe to edge-cache.
 */
export function isPublicMarketReadPath(path: string): boolean {
  return (
      // list endpoints
      /\/markets\/global\/?$/.test(path) ||
      /\/markets\/hyperliquid\/?$/.test(path) ||
      /\/markets\/hyperliquid-spot\/?$/.test(path) ||
      /\/markets\/hyperliquid-spot\/detail\/?$/.test(path) ||
      /\/markets\/hyperliquid-spot\/all-mids\/?$/.test(path) ||
      /\/markets\/jupiter\/?$/.test(path) ||
      /\/markets\/jupiter\/detail\/?$/.test(path) ||
      /\/markets\/jupiter\/prices\/?$/.test(path) ||
      /\/markets\/jupiter\/candles\/?$/.test(path) ||
      /\/markets\/stocks\/?$/.test(path) ||
      /\/markets\/stocks\/(perps|spot|detail|candles|all-mids)\/?$/.test(path) ||
      /\/markets\/polymarket\/?$/.test(path) ||
      // hyperliquid info proxies (static, declared before :coin)
      /\/markets\/hyperliquid\/(candles|all-mids|orderbook|recent-trades|funding-history)\/?$/.test(path) ||
      // single market detail — same upstream as list, no user data exposed.
      // Coin pattern is uppercase 1-12 chars (e.g. BTC, ETH, FARTCOIN); excludes
      // `positions`, `builder-status`, etc. PM market id is numeric.
      /\/markets\/hyperliquid\/[A-Z][A-Z0-9]{0,11}\/?$/.test(path) ||
      /\/markets\/polymarket\/\d+\/?$/.test(path) ||
      // Polymarket orderbook proxy at /markets/polymarket/:id/book
      /\/markets\/polymarket\/\d+\/book\/?$/.test(path) ||
      // Polymarket public holder leaderboard at /markets/polymarket/:id/top-traders
      /\/markets\/polymarket\/\d+\/top-traders\/?$/.test(path) ||
      /\/markets\/polymarket\/leaderboard\/?$/.test(path) ||
      /\/markets\/polymarket\/traders\/0x[0-9a-fA-F]{40}\/copy-intent\/?$/.test(path) ||
      // Sprint 20 — Collector Crypt cards list / collections / detail are
      // public (proxy upstream CC `/marketplace`). /positions, /trades/me,
      // and POST /buy stay authed (handled in routes/markets-cards.ts).
      // Hardening 2026-07-03: the detail pattern must NEVER swallow the
      // personalized sibling routes — `positions` matched the old id pattern,
      // which both bypassed the session gate here AND let the edge-cache
      // middleware stamp a per-user payload `public, s-maxage` (cross-user
      // leak once the CF cache rule is on). Negative lookahead pins it.
      /\/markets\/cards\/?$/.test(path) ||
      /\/markets\/cards\/collections\/?$/.test(path) ||
      /\/markets\/cards\/(?!positions\/?$|trades\b)[A-Za-z0-9_-]{4,64}\/?$/.test(path)
  );
}

marketRoutes.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const isPublic = c.req.method === 'GET' && isPublicMarketReadPath(path);
  if (isPublic) return next();
  return requireSession(c, next);
});

function isSafeModeAllowedMarketPost(path: string): boolean {
  return (
    path === '/markets/jupiter/quote' ||
    path === '/markets/hyperliquid/cancel' ||
    path === '/markets/hyperliquid/cancel-many' ||
    path === '/markets/hyperliquid-spot/cancel' ||
    path === '/markets/stocks/cancel' ||
    /^\/markets\/orders\/[^/]+\/cancel$/.test(path)
  );
}

marketRoutes.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (
    c.req.method === 'POST' &&
    isSafeModeDisabled('venueLiveTrading') &&
    !isSafeModeAllowedMarketPost(path)
  ) {
    return marketError(c, 503, 'venue_live_trading_disabled');
  }
  return next();
});

/** Eligibility guard — returns a 403 response when markets are disabled, else null. */
function marketsGate(_c: Context): Response | null {
  if (!features.markets) throw ApiError.forbidden('markets_unavailable');
  return null;
}

type Venue =
  | 'hyperliquid'
  | 'hyperliquid-spot'
  | 'hyperliquid-hip3'
  | 'jupiter'
  | 'xstocks'
  | 'polymarket';
type HlOrderType = 'market' | 'limit';
type HlTif = 'Ioc' | 'Gtc' | 'Alo';

const HL_PUBLIC_COIN_RE = /^[A-Za-z0-9._:/@-]{1,32}$/;
const HL_PUBLIC_DEX_RE = /^[A-Za-z0-9._:-]{1,32}$/;
const HL_PUBLIC_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M']);
// Interval → duration (ms), used to bucket older-history `end` params onto
// shared cache keys. `1M` uses 30d — close enough for key bucketing.
const HL_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
};
const MAX_HL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function cleanHlPublicCoin(raw: string | null | undefined): string {
  const coin = raw?.trim() ?? '';
  if (!coin) throw ApiError.badRequest('coin_required');
  if (!HL_PUBLIC_COIN_RE.test(coin)) throw ApiError.badRequest('invalid_coin');
  return coin;
}

function cleanHlPublicDex(raw: string | null | undefined): string | undefined {
  const dex = raw?.trim() ?? '';
  if (!dex) return undefined;
  if (!HL_PUBLIC_DEX_RE.test(dex)) throw ApiError.badRequest('invalid_dex');
  return dex;
}

function cleanHlPublicInterval(raw: string | null | undefined): string {
  const interval = raw?.trim() || '1h';
  if (!HL_PUBLIC_INTERVALS.has(interval)) throw ApiError.badRequest('invalid_interval');
  return interval;
}

function cleanHlLookback(raw: string | null | undefined): number {
  const lookback = Number(raw ?? 24 * 60 * 60 * 1000);
  if (!Number.isFinite(lookback) || lookback <= 0 || lookback > MAX_HL_LOOKBACK_MS) {
    throw ApiError.badRequest('invalid_lookback');
  }
  return Math.floor(lookback);
}

/**
 * Optional end-of-window for OLDER candle pages (backfill on left-scroll).
 * Absent → the live tip (returns undefined). Present values are bucketed down
 * to the interval boundary so slightly-different `end` asks from concurrent
 * viewers collapse onto shared cache keys. Rejects future/garbage values.
 */
function cleanHlCandleEnd(raw: string | null | undefined, interval: string): number | undefined {
  if (raw == null || raw === '') return undefined;
  const end = Number(raw);
  const now = Date.now();
  if (!Number.isFinite(end) || end <= 0) throw ApiError.badRequest('invalid_end');
  // A tip-ish end is just the live window; treat as absent so it shares the hot key.
  if (end >= now - 60_000) return undefined;
  const bucket = HL_INTERVAL_MS[interval] ?? 60_000;
  return Math.floor(end / bucket) * bucket;
}

function cleanSolanaMint(raw: string, field = 'mint'): string {
  const mint = raw.trim();
  if (!mint) throw ApiError.badRequest(`${field}_required`);
  if (!SOLANA_MINT_RE.test(mint)) throw ApiError.badRequest('invalid_mint');
  return mint;
}

function jupiterSwapVenue(inputMint: string, outputMint: string): Extract<MarketVenue, 'jupiter' | 'xstocks'> {
  return inputMint.startsWith('Xs') || outputMint.startsWith('Xs') ? 'xstocks' : 'jupiter';
}

function trustedWriteCountry(c: Context): string | null {
  const cf = c.req.header('cf-ipcountry')?.trim();
  if (cf) return cf.toUpperCase();
  if (env.NODE_ENV !== 'production') return c.req.header('X-Region')?.trim().toUpperCase() ?? null;
  return null;
}

/**
 * Tradability gate applied to EVERY POST. Returns a Response to short-circuit
 * the route when blocked, or null when the user is allowed to proceed.
 * KYC is not a hard trading block; live writes still keep the region check and
 * admin kill switch.
 */
function tradeGate(
  c: Context,
  u: SessionUser,
  opts: { venue: Venue; qtyUsd?: number; isLiveTrading: boolean },
): Response | null {
  if (u.killSwitch) {
    marketsOrders.inc({ venue: opts.venue, result: 'kill_switch' });
    return marketError(c, 423, 'account_frozen');
  }
  if (opts.isLiveTrading) {
    // Named internal test accounts fully bypass the region gate — including the
    // region_unknown path (a proxy/probe with no cf-ipcountry). The bypass
    // stays visible in metrics. Everyone else keeps the country check.
    if (isRegionExemptUser(u)) {
      marketsOrders.inc({ venue: opts.venue, result: 'region_exempt' });
    } else {
      const country = trustedWriteCountry(c);
      if (!country) {
        marketsOrders.inc({ venue: opts.venue, result: 'region_unknown' });
        return marketError(c, 451, 'region_unknown');
      }
      if (!isLiveWriteCountryAllowed(opts.venue, country)) {
        marketsOrders.inc({ venue: opts.venue, result: 'region_blocked' });
        return marketError(c, 451, 'region_blocked', { country });
      }
    }
  }
  void opts.qtyUsd;
  return null;
}

// Parsed v2 order shape — discriminated union matching HlOrderRequestV2 on
// the Neo client. Returned to the route handlers which forward to
// hyperliquid.placeOrder().
function cancelVenueIsLiveTrading(venue: MarketVenue): boolean {
  switch (venue) {
    case 'hyperliquid':
      return hyperliquid.isLiveTrading;
    case 'hyperliquid-spot':
      return hyperliquidSpot.isLiveTrading;
    case 'hyperliquid-hip3':
      return hyperliquidHip3.isLiveTrading;
    case 'polymarket':
      return polymarket.isLiveTrading;
    default:
      return false;
  }
}

type ParsedHlTpSlLeg = {
  triggerPriceUsd: number;
  isMarket: boolean;
  limitPriceUsd?: number;
};

type ParsedHlOrder =
  | { kind: 'market'; tif: 'Ioc'; takeProfit?: ParsedHlTpSlLeg; stopLoss?: ParsedHlTpSlLeg }
  | { kind: 'limit'; tif: HlTif; limitPriceUsd: number; takeProfit?: ParsedHlTpSlLeg; stopLoss?: ParsedHlTpSlLeg }
  | { kind: 'stopLimit'; tif: 'Gtc' | 'Ioc'; triggerPriceUsd: number; limitPriceUsd: number; stopKind: 'sl' | 'tp' }
  | { kind: 'twap'; durationMinutes: number; randomize: boolean };

function parseTif(raw: unknown, allowed: readonly HlTif[]): HlTif {
  if (raw == null) return allowed[0]!;
  const s = String(raw);
  if (!allowed.includes(s as HlTif)) {
    throw ApiError.badRequest('invalid_tif');
  }
  return s as HlTif;
}

function parseTpSlLeg(raw: unknown, label: 'takeProfit' | 'stopLoss'): ParsedHlTpSlLeg | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object') throw ApiError.badRequest('invalid_' + label);
  const o = raw as { triggerPriceUsd?: unknown; isMarket?: unknown; limitPriceUsd?: unknown };
  const triggerPriceUsd = Number(o.triggerPriceUsd ?? 0);
  if (!(triggerPriceUsd > 0)) throw ApiError.badRequest('invalid_' + label + '_trigger');
  const isMarket = Boolean(o.isMarket);
  const limitPriceUsd = o.limitPriceUsd == null ? undefined : Number(o.limitPriceUsd);
  if (!isMarket) {
    if (limitPriceUsd == null || !(limitPriceUsd > 0)) {
      throw ApiError.badRequest('invalid_' + label + '_limit');
    }
  }
  return { triggerPriceUsd, isMarket, limitPriceUsd };
}

function parseHlOrderShapeV2(body: Record<string, unknown>): ParsedHlOrder {
  // Discriminate on `kind` when present, otherwise fall back to legacy
  // `orderType` → kind mapping. Legacy `tif` honored if provided.
  const rawKind = body.kind == null ? undefined : String(body.kind);
  const kind = rawKind
    ? rawKind
    : String(body.orderType ?? 'market').toLowerCase() === 'limit'
    ? 'limit'
    : 'market';

  if (kind === 'market') {
    const tif = parseTif(body.tif, ['Ioc'] as const) as 'Ioc';
    return {
      kind: 'market',
      tif,
      takeProfit: parseTpSlLeg(body.takeProfit, 'takeProfit'),
      stopLoss: parseTpSlLeg(body.stopLoss, 'stopLoss'),
    };
  }
  if (kind === 'limit') {
    const limitPriceUsd = Number(body.limitPriceUsd ?? 0);
    if (!(limitPriceUsd > 0)) throw ApiError.badRequest('invalid_limit_price');
    const tif = parseTif(body.tif, ['Gtc', 'Ioc', 'Alo'] as const);
    return {
      kind: 'limit',
      tif,
      limitPriceUsd,
      takeProfit: parseTpSlLeg(body.takeProfit, 'takeProfit'),
      stopLoss: parseTpSlLeg(body.stopLoss, 'stopLoss'),
    };
  }
  if (kind === 'stopLimit') {
    const limitPriceUsd = Number(body.limitPriceUsd ?? 0);
    if (!(limitPriceUsd > 0)) throw ApiError.badRequest('invalid_limit_price');
    const triggerPriceUsd = Number(body.triggerPriceUsd ?? 0);
    if (!(triggerPriceUsd > 0)) throw ApiError.badRequest('invalid_trigger_price');
    const rawStop = String(body.stopKind ?? '');
    if (rawStop !== 'sl' && rawStop !== 'tp') throw ApiError.badRequest('invalid_stop_kind');
    const tif = parseTif(body.tif, ['Gtc', 'Ioc'] as const) as 'Gtc' | 'Ioc';
    return { kind: 'stopLimit', tif, triggerPriceUsd, limitPriceUsd, stopKind: rawStop };
  }
  if (kind === 'twap') {
    const durationMinutes = Math.floor(Number(body.durationMinutes ?? 0));
    if (!(durationMinutes >= 5 && durationMinutes <= 1440)) {
      throw ApiError.badRequest('invalid_twap_duration');
    }
    return { kind: 'twap', durationMinutes, randomize: Boolean(body.randomize) };
  }
  throw ApiError.badRequest('invalid_order_kind');
}

// Back-compat wrapper — preserves the old signature for legacy in-tree callers.
function parseHlOrderShape(
  body: { orderType?: unknown; tif?: unknown; limitPriceUsd?: unknown },
): { orderType: HlOrderType; tif: HlTif; limitPriceUsd?: number } {
  const parsed = parseHlOrderShapeV2(body as Record<string, unknown>);
  if (parsed.kind !== 'market' && parsed.kind !== 'limit') {
    throw ApiError.badRequest('legacy_parser_does_not_support_kind');
  }
  return {
    orderType: parsed.kind,
    tif: parsed.tif,
    limitPriceUsd: parsed.kind === 'limit' ? parsed.limitPriceUsd : undefined,
  };
}

function formatBpsAsPercent(bps: number): `${string}%` {
  const pct = bps / 100;
  return `${pct.toFixed(5).replace(/\.?0+$/, '')}%` as `${string}%`;
}

function venueFailure(c: Context, venue: Venue, op: 'order' | 'cancel' | 'sell', e: unknown): Response {
  marketsOrders.inc({ venue, result: 'venue_failed' });
  log.warn(
    { err: e instanceof Error ? e.message : String(e), venue, op },
    'markets: venue write failed',
  );
  if (e instanceof Hip3RateLimitError || e instanceof ProviderRateLimitError) {
    if (e.retryAfter) c.header('Retry-After', e.retryAfter);
    return marketError(c, 429, 'too_many_requests');
  }
  // Surface the venue's own reason (e.g. Hyperliquid's "Order must have
  // minimum value of $10.") so the ticket can show WHY instead of a code.
  const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 180);
  return marketError(
    c,
    422,
    op === 'cancel' ? 'venue_cancel_failed' : 'venue_order_failed',
    undefined,
    reason || undefined,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function completeAcceptedMarketOrder(
  venue: Venue,
  positionId: string,
  input: MarketOrderCompletionInput,
): Promise<MarketPosition> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await store.completeMarketOrder(positionId, input);
    } catch (err) {
      lastErr = err;
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          venue,
          positionId,
          externalRef: input.externalRef,
          attempt,
        },
        'markets: accepted venue order recording failed',
      );
      if (attempt < 3) await sleep(75 * attempt);
    }
  }

  const retry = setTimeout(() => {
    void store.completeMarketOrder(positionId, input).catch((err) => {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          venue,
          positionId,
          externalRef: input.externalRef,
        },
        'markets: delayed accepted order recording retry failed',
      );
    });
  }, 1_000);
  retry.unref?.();

  throw lastErr instanceof Error ? lastErr : new Error('market_order_recording_failed');
}

async function polymarketClobCredsForUser(u: SessionUser): Promise<PmClobCreds | null> {
  if (!polymarket.isLiveTrading) return null;
  if (u.pmClobKey && u.pmClobSecret && u.pmClobPassphrase) {
    return {
      key: u.pmClobKey,
      secret: u.pmClobSecret,
      passphrase: u.pmClobPassphrase,
    };
  }
  if (!u.privyWalletId || !u.privyWalletAddress) return null;
  const derived = await deriveL2Credentials(u.privyWalletId, u.privyWalletAddress);
  if (!derived) {
    log.warn({ userId: u.id }, 'polymarket: L2 derive failed');
    return null;
  }
  await store
    .setPmClobCredentials(u.id, derived, { force: true })
    .catch((err) =>
      log.error(
        { err: err instanceof Error ? err.message : String(err), userId: u.id },
        'polymarket: persist clob creds failed (continuing in-memory)',
      ),
    );
  return derived;
}

function recordingFailure(c: Context, venue: Venue, e: unknown): Response {
  marketsOrders.inc({ venue, result: 'recording_failed' });
  log.error(
    { err: e instanceof Error ? e.message : String(e), venue },
    'markets: venue order accepted but local recording failed',
  );
  return marketError(c, 503, 'order_recording_pending');
}

/**
 * Sprint 1 — lifecycle wrapping helper. Calls store.recordLifecycleTransition
 * and swallows any error so a flaky audit append never breaks the order write.
 * Returns the updated position (or null if the row vanished, which we just log).
 *
 * Use INSIDE every order route as the single audit-trail entry point so REST,
 * WSS, and the activity ledger see the same sequence.
 */
async function lifecycle(
  positionId: string | null | undefined,
  status: MarketOrderStatus,
  patch: Partial<LifecycleTransitionInput> = {},
): Promise<MarketPosition | null> {
  if (!positionId) return null;
  try {
    return await store.recordLifecycleTransition(positionId, { status, ...patch });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), positionId, status },
      'markets: lifecycle transition append failed',
    );
    return null;
  }
}

/**
 * Map adapter `result.state` (filled / resting / triggered / twap_active) to
 * the lifecycle vocabulary. Centralised so every venue route makes the same
 * choice. `triggered` (stopLimit) maps to `resting` since the order is parked
 * waiting for the trigger price — not yet filled.
 */
function mapResultStateToLifecycle(
  state: 'submitted' | 'filled' | 'resting' | 'triggered' | 'twap_active' | undefined,
): MarketOrderStatus {
  switch (state) {
    case 'submitted':
      return 'submitted';
    case 'resting':
    case 'triggered':
      return 'resting';
    case 'twap_active':
      return 'accepted';
    case 'filled':
    case undefined:
    default:
      return 'filled';
  }
}

function idempotencyKeyOf(c: Context): string | null {
  const raw = c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? '';
  const key = raw.trim();
  if (!key) return null;
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key;
}

function transferIdempotencyKey(scope: string, key: string): string {
  const scoped = `${scope}:${key}`;
  if (scoped.length <= 120) return scoped;
  return `${scope}:${createHash('sha256').update(key).digest('hex')}`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function recordSubmittedTransferComplete(
  transfer: Transfer,
  callId: string,
  eventPayload: Record<string, unknown>,
  auditFailureCode: string,
): Promise<Transfer> {
  const fallbackError = {
    code: auditFailureCode,
    message: 'venue transfer submitted; local persistence needs reconciliation',
    callId,
    reconciliationRequired: true,
  };
  let completed: Transfer;
  try {
    const updated = await transferStore.update(transfer.id, {
      status: 'complete',
      dstCallId: callId,
      error: null,
    });
    completed = updated ?? {
      ...transfer,
      status: 'complete',
      dstCallId: callId,
      error: null,
    };
  } catch (e) {
    fallbackError.message = messageOf(e);
    log.error(
      { err: fallbackError.message, transferId: transfer.id, callId },
      'markets: venue transfer submitted but completion persistence failed',
    );
    try {
      const marked = await transferStore.update(transfer.id, {
        status: 'complete',
        dstCallId: callId,
        error: fallbackError,
      });
      if (marked) return marked;
    } catch (markErr) {
      log.error(
        { err: messageOf(markErr), transferId: transfer.id, callId },
        'markets: failed to mark transfer reconciliation after submit',
      );
    }
    return {
      ...transfer,
      status: 'complete',
      dstCallId: callId,
      error: fallbackError,
    };
  }
  try {
    await transferStore.appendEvent(transfer.id, 'complete', { callId, ...eventPayload });
    return completed;
  } catch (e) {
    const error = {
      code: auditFailureCode,
      message: messageOf(e),
      callId,
      reconciliationRequired: true,
    };
    log.error(
      { err: error.message, transferId: transfer.id, callId },
      'markets: venue transfer submitted but audit append failed',
    );
    const marked = await transferStore.update(transfer.id, {
      status: 'complete',
      dstCallId: callId,
      error,
    });
    return marked ?? {
      ...transfer,
      status: 'complete',
      dstCallId: callId,
      error,
    };
  }
}

function replayCompletedTransfer(
  c: Context,
  transfer: Transfer,
  body: Record<string, unknown>,
  originalIntent: Record<string, unknown> | null,
): Response {
  const callId = transfer.dstCallId ?? transfer.srcCallId;
  if (originalIntent) {
    for (const [key, value] of Object.entries(originalIntent)) {
      const current = body[key];
      if (typeof value === 'number' && typeof current === 'number') {
        if (Math.abs(value - current) > 0.005) {
          return marketError(c, 409, 'idempotency_key_body_mismatch');
        }
      } else if (value !== current) {
        return marketError(c, 409, 'idempotency_key_body_mismatch');
      }
    }
  }
  if (transfer.status === 'complete' && callId) {
    return c.json({
      ok: true,
      callId,
      ...body,
      transfer,
      idempotent: true,
      replay: true,
    });
  }
  return marketError(c, 409, transfer.status === 'failed' ? 'idempotency_key_used' : 'transfer_in_progress', {
    transferId: transfer.id,
    status: transfer.status,
  });
}

async function replayTransferFromCreatedEvent(
  c: Context,
  transfer: Transfer,
  responseBody: Record<string, unknown>,
  currentIntent: Record<string, unknown>,
  intentKeys: string[],
): Promise<Response> {
  if (transfer.status !== 'complete') {
    return replayCompletedTransfer(c, transfer, responseBody, null);
  }
  const created = (await transferStore.listEvents(transfer.id))
    .find((event) => event.eventType === 'created');
  const payload = recordObject(created?.payload);
  if (!payload) return marketError(c, 409, 'idempotency_key_body_mismatch');
  const original = Object.fromEntries(intentKeys.map((key) => [key, payload[key]]));
  return replayCompletedTransfer(c, transfer, { ...responseBody, ...currentIntent }, original);
}

// Sprint 1 lifecycle: legacy 'open' plus the lifecycle "venue-accepted" set.
const REPLAYABLE_STATUSES = new Set(['open', 'filled', 'resting', 'partially_filled', 'accepted']);
// Statuses where the reservation is still in flight — block (409 order_in_progress).
const IN_FLIGHT_STATUSES = new Set(['pending', 'created', 'reserved', 'submitted']);

function replayOrBlockReservedOrder(c: Context, reservation: MarketOrderReservationResult, demo = false): Response {
  if (reservation.intentMismatch) {
    return marketError(c, 409, 'idempotency_key_body_mismatch');
  }
  const { position } = reservation;
  if (REPLAYABLE_STATUSES.has(position.status) && position.externalRef) {
    const filledQtyUsd = position.filledQtyUsd ?? (
      position.status === 'filled' || position.status === 'open' ? position.qtyUsd : 0
    );
    return c.json({
      ok: true,
      order: {
        orderId: position.externalRef,
        filledQtyUsd,
        entryPriceUsd: position.entryPriceUsd,
        state: position.status,
        demo,
        replay: true,
      },
      position,
    });
  }
  return marketError(
    c,
    409,
    IN_FLIGHT_STATUSES.has(position.status) ? 'order_in_progress' : 'idempotency_key_used',
  );
}

/**
 * Sprint 16.4 — wallet + backend-managed builder agreement. Replaces the blanket 503 that
 * Sprint 16.3 used as a deliberate stop-gap.
 *
 * Three checks in order:
 *   1. Venue is in live-trading mode (env-driven). Demo mode short-circuits.
 *   2. User has a persisted Privy wallet (auth flow caches at sign-in;
 *      legacy users without one trigger 503 to nudge re-sign-in).
 *   3. (Hyperliquid only) The backend has signed the one-time
 *      `approveBuilderFee` agreement for the current builder fee.
 *
 * Returns `null` if the order is cleared to proceed.
 */
async function liveTradingWalletGate(
  c: Context,
  venue: Venue,
  isLiveTrading: boolean,
  u: SessionUser,
): Promise<Response | null> {
  if (!isLiveTrading) return null;
  if (!u.privyWalletId || !u.privyWalletAddress) {
    marketsOrders.inc({ venue, result: 'wallet_unavailable' });
    return marketError(c, 503, 'trading_wallet_unavailable');
  }
  if (venue === 'hyperliquid' || venue === 'hyperliquid-hip3') {
    if (hlBuilderFeeEnabled()) {
      const approval = await ensureHlBuilderApproval({
        userId: u.id,
        walletId: u.privyWalletId,
        walletAddress: u.privyWalletAddress as `0x${string}`,
        approvedAt: u.hlBuilderApprovedAt ?? null,
        approvedMaxFeeTenthsBp: u.hlBuilderMaxFeeTenthsBp ?? null,
      });
      if (!approval.ok) {
        marketsOrders.inc({ venue, result: approval.code });
        return marketError(c, approval.status, approval.code, approval.details);
      }
    }
  }
  return null;
}

/* ── F093 MarketAdapter + parameterised handler (router-v2) ─────────────── */

/**
 * F093 Sprint 18 — Hyperliquid `MarketAdapter` wrapper. Owns parse + venue
 * call + push text; all orchestration (gates, idempotency, reservation, fee
 * recording, metric counters) lives in `handleAdapterPlaceOrder` below so
 * every venue stays in lockstep on the safety-critical path.
 */
interface HlAdapterInput {
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  leverage: number;
  kind: ParsedHlOrder['kind'];
  tif?: 'Ioc' | 'Gtc' | 'Alo';
  limitPriceUsd?: number;
  triggerPriceUsd?: number;
  stopKind?: 'sl' | 'tp';
  durationMinutes?: number;
  randomize?: boolean;
  takeProfit?: ParsedHlTpSlLeg;
  stopLoss?: ParsedHlTpSlLeg;
  reduceOnly: boolean;
}

const hyperliquidAdapter: MarketAdapter<HlAdapterInput> = {
  name: 'hyperliquid',
  get isLiveTrading() {
    return hyperliquid.isLiveTrading;
  },
  parseBody(body): ParseResult<HlAdapterInput> {
    const raw = (body ?? {}) as {
      coin?: string;
      sideLong?: boolean;
      qtyUsd?: number;
      leverage?: number;
      kind?: string;
      orderType?: 'market' | 'limit';
      limitPriceUsd?: number;
      triggerPriceUsd?: number;
      stopKind?: 'sl' | 'tp';
      durationMinutes?: number;
      randomize?: boolean;
      tif?: 'Ioc' | 'Gtc' | 'Alo';
      takeProfit?: unknown;
      stopLoss?: unknown;
      reduceOnly?: boolean;
    };
    const coin = String(raw.coin ?? '').trim().toUpperCase();
    if (!coin) return { ok: false, code: 'invalid_coin' };
    const qtyUsd = Number(raw.qtyUsd ?? 0);
    if (!(qtyUsd > 0)) return { ok: false, code: 'invalid_qty' };
    const reduceOnly = raw.reduceOnly === true;
    // reduceOnly is now passed through (close / take-profit / stop-loss semantics).
    const shape = parseHlOrderShapeV2(raw as Record<string, unknown>);
    return {
      ok: true,
      input: {
        coin,
        sideLong: Boolean(raw.sideLong),
        qtyUsd,
        leverage: Number(raw.leverage ?? 1),
        kind: shape.kind,
        tif: shape.kind === 'twap' ? undefined : shape.tif,
        limitPriceUsd: shape.kind === 'limit' || shape.kind === 'stopLimit' ? shape.limitPriceUsd : undefined,
        triggerPriceUsd: shape.kind === 'stopLimit' ? shape.triggerPriceUsd : undefined,
        stopKind: shape.kind === 'stopLimit' ? shape.stopKind : undefined,
        durationMinutes: shape.kind === 'twap' ? shape.durationMinutes : undefined,
        randomize: shape.kind === 'twap' ? shape.randomize : undefined,
        takeProfit: shape.kind === 'market' || shape.kind === 'limit' ? shape.takeProfit : undefined,
        stopLoss: shape.kind === 'market' || shape.kind === 'limit' ? shape.stopLoss : undefined,
        reduceOnly,
      },
    };
  },
  async placeOrder(input, ctx): Promise<NormalizedOrderResult> {
    const result = await hyperliquid.placeOrder({
      privyWalletId: ctx.privyWalletId,
      privyWalletAddress: ctx.privyWalletAddress,
      coin: input.coin,
      sideLong: input.sideLong,
      qtyUsd: input.qtyUsd,
      leverage: input.leverage,
      kind: input.kind,
      tif: input.tif,
      limitPriceUsd: input.limitPriceUsd,
      triggerPriceUsd: input.triggerPriceUsd,
      stopKind: input.stopKind,
      durationMinutes: input.durationMinutes,
      randomize: input.randomize,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      reduceOnly: input.reduceOnly,
    });
    return {
      orderId: result.orderId,
      symbol: input.coin,
      filledQtyUsd: result.filledQtyUsd,
      entryPriceUsd: result.entryPriceUsd,
      demo: result.demo,
      sideLong: input.sideLong,
      state: result.state,
      raw: result,
    };
  },
  pushFor(input, result) {
    return {
      title: `${input.coin} ${input.sideLong ? 'long' : 'short'} filled`,
      body: `$${result.filledQtyUsd.toFixed(2)} @ $${result.entryPriceUsd.toFixed(2)}`,
      link: '/portfolio',
      data: { venue: 'hyperliquid', coin: input.coin, orderId: result.orderId },
    };
  },
};

/* ── HL Spot adapter (router-v2) ─────────────────────────────────────────── */

interface HlSpotAdapterInput {
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  orderType: 'market' | 'limit';
  tif?: 'Ioc' | 'Gtc' | 'Alo';
  limitPriceUsd?: number;
  reduceOnly: boolean;
}

const hyperliquidSpotAdapter: MarketAdapter<HlSpotAdapterInput> = {
  name: 'hyperliquid-spot',
  get isLiveTrading() {
    return hyperliquidSpot.isLiveTrading;
  },
  parseBody(body): ParseResult<HlSpotAdapterInput> {
    const raw = (body ?? {}) as {
      coin?: string;
      sideLong?: boolean;
      qtyUsd?: number;
      orderType?: 'market' | 'limit';
      limitPriceUsd?: number;
      tif?: 'Ioc' | 'Gtc' | 'Alo';
      reduceOnly?: boolean;
    };
    const coin = String(raw.coin ?? '').trim();
    if (!coin) return { ok: false, code: 'invalid_coin' };
    const qtyUsd = Number(raw.qtyUsd ?? 0);
    if (!(qtyUsd > 0)) return { ok: false, code: 'invalid_qty' };
    const reduceOnly = raw.reduceOnly === true;
    // reduceOnly is now passed through (close / take-profit / stop-loss semantics).
    const shape = parseHlOrderShape(raw);
    return {
      ok: true,
      input: {
        coin,
        sideLong: Boolean(raw.sideLong),
        qtyUsd,
        orderType: shape.orderType,
        tif: shape.tif,
        limitPriceUsd: shape.limitPriceUsd,
        reduceOnly,
      },
    };
  },
  async placeOrder(input, ctx): Promise<NormalizedOrderResult> {
    const result = await hyperliquidSpot.placeOrder({
      privyWalletId: ctx.privyWalletId,
      privyWalletAddress: ctx.privyWalletAddress,
      coin: input.coin,
      sideLong: input.sideLong,
      qtyUsd: input.qtyUsd,
      orderType: input.orderType,
      tif: input.tif,
      limitPriceUsd: input.limitPriceUsd,
      reduceOnly: input.reduceOnly,
    });
    return {
      orderId: result.orderId,
      symbol: input.coin,
      filledQtyUsd: result.filledQtyUsd,
      entryPriceUsd: result.entryPriceUsd,
      demo: result.demo,
      sideLong: input.sideLong,
      state: result.state,
      raw: result,
    };
  },
  pushFor(input, result) {
    const resting = result.state === 'resting';
    return {
      title: `${input.coin} ${input.sideLong ? 'buy' : 'sell'} ${resting ? 'resting' : 'filled'}`,
      body: `$${(resting ? input.qtyUsd : result.filledQtyUsd).toFixed(2)} @ $${result.entryPriceUsd.toFixed(2)}`,
      link: '/portfolio',
      data: { venue: 'hyperliquid-spot', coin: input.coin, orderId: result.orderId },
    };
  },
};

/* ── HL HIP-3 (stocks) adapter (router-v2) ───────────────────────────────── */

interface Hip3AdapterInput {
  /** Resolved coin (already prefixed with HIP3_DEX_NAME if missing). */
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  leverage: number;
  orderType: 'market' | 'limit';
  tif?: 'Ioc' | 'Gtc' | 'Alo';
  limitPriceUsd?: number;
  reduceOnly: boolean;
}

const hyperliquidHip3Adapter: MarketAdapter<Hip3AdapterInput> = {
  name: 'hyperliquid-hip3',
  get isLiveTrading() {
    return hyperliquidHip3.isLiveTrading;
  },
  parseBody(body): ParseResult<Hip3AdapterInput> {
    const raw = (body ?? {}) as {
      coin?: string;
      sideLong?: boolean;
      qtyUsd?: number;
      leverage?: number;
      orderType?: 'market' | 'limit';
      limitPriceUsd?: number;
      tif?: 'Ioc' | 'Gtc' | 'Alo';
      reduceOnly?: boolean;
    };
    const rawCoin = String(raw.coin ?? '').trim();
    if (!rawCoin) return { ok: false, code: 'invalid_coin' };
    // Mirror v1: if the caller omits the dex prefix, attach the canonical
    // HIP-3 dex name. Tickers come through capitalised either way.
    const coin = rawCoin.includes(':') ? rawCoin : `${HIP3_DEX_NAME}:${rawCoin.toUpperCase()}`;
    const qtyUsd = Number(raw.qtyUsd ?? 0);
    if (!(qtyUsd > 0)) return { ok: false, code: 'invalid_qty' };
    const reduceOnly = raw.reduceOnly === true;
    // reduceOnly is now passed through (close / take-profit / stop-loss semantics).
    const shape = parseHlOrderShape(raw);
    return {
      ok: true,
      input: {
        coin,
        sideLong: Boolean(raw.sideLong),
        qtyUsd,
        leverage: Number(raw.leverage ?? 1),
        orderType: shape.orderType,
        tif: shape.tif,
        limitPriceUsd: shape.limitPriceUsd,
        reduceOnly,
      },
    };
  },
  async placeOrder(input, ctx): Promise<NormalizedOrderResult> {
    const result = await hyperliquidHip3.placeOrder({
      privyWalletId: ctx.privyWalletId,
      privyWalletAddress: ctx.privyWalletAddress,
      coin: input.coin,
      sideLong: input.sideLong,
      qtyUsd: input.qtyUsd,
      leverage: input.leverage,
      orderType: input.orderType,
      tif: input.tif,
      limitPriceUsd: input.limitPriceUsd,
      reduceOnly: input.reduceOnly,
    });
    return {
      orderId: result.orderId,
      symbol: input.coin,
      filledQtyUsd: result.filledQtyUsd,
      entryPriceUsd: result.entryPriceUsd,
      demo: result.demo,
      sideLong: input.sideLong,
      state: result.state,
      raw: result,
    };
  },
  pushFor(input, result) {
    return {
      title: `${input.coin} ${input.sideLong ? 'long' : 'short'} filled`,
      body: `$${result.filledQtyUsd.toFixed(2)} @ $${result.entryPriceUsd.toFixed(2)}`,
      link: '/portfolio',
      data: { venue: 'hyperliquid-hip3', coin: input.coin, orderId: result.orderId },
    };
  },
};

/* ── Jupiter (memes) adapter (router-v2) ─────────────────────────────────── */

interface JupiterAdapterInput {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  slippageBps?: number;
  quote?: unknown;
  venue: Extract<MarketVenue, 'jupiter' | 'xstocks'>;
  /** Pre-resolved abbreviated symbol used for reservation + position rows. */
  symbol: string;
}

const jupiterAdapter: MarketAdapter<JupiterAdapterInput> = {
  name: 'jupiter',
  get isLiveTrading() {
    return jupiter.isLiveTrading;
  },
  parseBody(body): ParseResult<JupiterAdapterInput> {
    const raw = (body ?? {}) as {
      inputMint?: string;
      outputMint?: string;
      amountAtomic?: string;
      slippageBps?: number;
      quote?: unknown;
    };
    const inputMint = cleanSolanaMint(String(raw.inputMint ?? JUPITER_SOL_MINT), 'input_mint');
    const outputMint = cleanSolanaMint(String(raw.outputMint ?? ''), 'output_mint');
    const amountAtomic = String(raw.amountAtomic ?? '').trim();
    if (!/^\d+$/.test(amountAtomic) || amountAtomic === '0') {
      return { ok: false, code: 'invalid_amount' };
    }
    return {
      ok: true,
      input: {
        inputMint,
        outputMint,
        amountAtomic,
        slippageBps: raw.slippageBps,
        quote: raw.quote,
        venue: jupiterSwapVenue(inputMint, outputMint),
        symbol: `${inputMint.slice(0, 4)}…→${outputMint.slice(0, 4)}…`,
      },
    };
  },
  async placeOrder(input, ctx): Promise<NormalizedOrderResult> {
    // Solana wallet provisioning — only required for live trading. Demo mode
    // returns a synthetic order without a real wallet.
    let solanaWalletId: string | null = null;
    let solanaWalletAddress: string | null = null;
    if (jupiter.isLiveTrading) {
      try {
        const wallet = await walletService.getOrCreateUserSolanaWallet(
          ctx.userId,
          ctx.privyDid,
        );
        if (wallet.live && wallet.address && wallet.walletId) {
          solanaWalletId = wallet.walletId;
          solanaWalletAddress = wallet.address;
          await store
            .setPrivySolWallet(ctx.userId, wallet.walletId, wallet.address)
            .catch((err) => {
              log.warn(
                { err: err instanceof Error ? err.message : String(err), userId: ctx.userId },
                'jupiter: failed to persist solana wallet',
              );
            });
        }
      } catch (e) {
        log.error(
          { err: e instanceof Error ? e.message : String(e), userId: ctx.userId },
          'jupiter: solana wallet provision failed',
        );
      }
      if (!solanaWalletId || !solanaWalletAddress) {
        throw new MarketPreflightError(503, 'solana_wallet_unavailable');
      }
    }
    const fresh = await jupiter.quote({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amountAtomic: input.amountAtomic,
      slippageBps: input.slippageBps,
    });
    const quoteForSwap = fresh?.quote ?? (!jupiter.isLiveTrading ? input.quote ?? null : null);
    if (!quoteForSwap) {
      throw new MarketPreflightError(422, 'quote_unavailable');
    }
    const inAmount = fresh?.inAmount ?? input.amountAtomic;
    const outAmount = fresh?.outAmount ?? '0';
    const result = await jupiter.swap({
      privyWalletId: solanaWalletId,
      userPublicKey: solanaWalletAddress,
      quote: quoteForSwap,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmount,
      outAmount,
    });
    // Jupiter platform fee notional is computed from `inAmount` when input is
    // USDC (only stablecoin we can price with no extra round-trip). Surface
    // that USD as `filledQtyUsd` so the v2 handler's fee recording matches v1.
    const filledQtyUsd =
      Number(inAmount) > 0 && input.inputMint === SOLANA_USDC_MINT
        ? Number(inAmount) / 1_000_000
        : 0;
    return {
      orderId: result.signature,
      symbol: input.symbol,
      filledQtyUsd,
      entryPriceUsd: 0,
      demo: result.demo,
      sideLong: true,
      state: result.demo || result.confirmed ? 'filled' : 'submitted',
      raw: result,
    };
  },
  pushFor(input, result) {
    const swapResult = result.raw as { demo: boolean; signature: string };
    const inAmt = (result.raw as { inAmount?: string }).inAmount ?? input.amountAtomic;
    const outAmt = (result.raw as { outAmount?: string }).outAmount ?? '0';
    return {
      title: 'Swap submitted',
      body: `${swapResult.demo ? 'Demo' : 'Live'} swap: ${inAmt} → ${outAmt}`,
      link: '/portfolio',
      data: {
        venue: input.venue,
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        signature: swapResult.signature,
      },
    };
  },
};

/* ── Polymarket adapter (router-v2) ──────────────────────────────────────── */

interface PolymarketAdapterInput {
  marketId: string;
  outcome: string;
  priceCents: number;
  qtyUsd: number;
}

function findPmOutcome(market: PmMarket, outcome: string): PmMarket['outcomes'][number] | null {
  const wantedLabel = outcome.trim().toLowerCase();
  const byLabel = market.outcomes.find((o) => o.label.trim().toLowerCase() === wantedLabel);
  if (byLabel) return byLabel;
  const idx = Number(outcome);
  return Number.isInteger(idx) && idx >= 0 && idx < market.outcomes.length ? market.outcomes[idx] ?? null : null;
}

const polymarketAdapter: MarketAdapter<PolymarketAdapterInput> = {
  name: 'polymarket',
  get isLiveTrading() {
    return polymarket.isLiveTrading;
  },
  parseBody(body): ParseResult<PolymarketAdapterInput> {
    const raw = (body ?? {}) as {
      marketId?: string;
      outcome?: string;
      priceCents?: number;
      qtyUsd?: number;
    };
    const marketId = String(raw.marketId ?? '').trim();
    const outcome = String(raw.outcome ?? '').trim();
    const priceCents = Number(raw.priceCents ?? 0);
    const qtyUsd = Number(raw.qtyUsd ?? 0);
    if (!marketId) return { ok: false, code: 'invalid_market' };
    if (!outcome) return { ok: false, code: 'invalid_outcome' };
    if (!(priceCents > 0 && priceCents < 100)) {
      return { ok: false, code: 'invalid_price' };
    }
    if (!(qtyUsd > 0)) return { ok: false, code: 'invalid_qty' };
    return { ok: true, input: { marketId, outcome, priceCents, qtyUsd } };
  },
  async placeOrder(input, ctx): Promise<NormalizedOrderResult> {
    // Preflight: resolve outcome → tokenId via the cached market read.
    // Live mode must fail closed (503) rather than place a synthetic demo
    // order; demo mode happily proceeds without a tokenId.
    let outcomeTokenId: string | null = null;
    try {
      const market = await polymarket.getMarket(input.marketId);
      if (market) {
        const out = findPmOutcome(market, input.outcome);
        outcomeTokenId = out?.tokenId ?? null;
      }
    } catch (e) {
      log.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          marketId: input.marketId,
          outcome: input.outcome,
        },
        'polymarket: tokenId lookup failed',
      );
    }
    if (polymarket.isLiveTrading && !outcomeTokenId) {
      throw new MarketPreflightError(503, 'polymarket_token_unavailable');
    }

    // Preflight: get-or-derive L2 CLOB credentials.
    let clobCreds: PmClobCreds | null = null;
    if (
      polymarket.isLiveTrading &&
      outcomeTokenId &&
      ctx.privyWalletId &&
      ctx.privyWalletAddress
    ) {
      const user = await store.user(ctx.userId);
      if (user.pmClobKey && user.pmClobSecret && user.pmClobPassphrase) {
        clobCreds = {
          key: user.pmClobKey,
          secret: user.pmClobSecret,
          passphrase: user.pmClobPassphrase,
        };
      } else {
        const derived = await deriveL2Credentials(ctx.privyWalletId, ctx.privyWalletAddress);
        if (derived) {
          await store
            .setPmClobCredentials(ctx.userId, derived, { force: true })
            .catch((err) =>
              log.error(
                {
                  err: err instanceof Error ? err.message : String(err),
                  userId: ctx.userId,
                },
                'polymarket: persist clob creds failed (continuing in-memory)',
              ),
            );
          clobCreds = derived;
        } else {
          log.warn({ userId: ctx.userId }, 'polymarket: L2 derive failed');
        }
      }
    }
    if (polymarket.isLiveTrading && !clobCreds) {
      throw new MarketPreflightError(503, 'polymarket_clob_credentials_unavailable');
    }

    const result = await polymarket.placeOrder({
      privyWalletId: ctx.privyWalletId,
      privyWalletAddress: ctx.privyWalletAddress,
      marketId: input.marketId,
      outcome: input.outcome,
      priceCents: input.priceCents,
      qtyUsd: input.qtyUsd,
      outcomeTokenId,
      clobCreds,
    });
    return {
      orderId: result.orderId,
      symbol: `${input.marketId}:${input.outcome}`,
      filledQtyUsd: result.filledQtyUsd,
      entryPriceUsd: result.priceCents / 100,
      demo: result.demo,
      sideLong: input.outcome.toUpperCase() !== 'NO',
      state: result.state,
      raw: result,
    };
  },
  pushFor(input, result) {
    const resting = result.state === 'resting';
    return {
      title: `${input.marketId}:${input.outcome} ${result.sideLong ? 'YES' : 'NO'} ${resting ? 'resting' : 'filled'}`,
      body: `$${(resting ? input.qtyUsd : result.filledQtyUsd).toFixed(2)} @ ${input.priceCents}c`,
      link: '/portfolio',
      data: { venue: 'polymarket', marketId: input.marketId, orderId: result.orderId },
    };
  },
};

/**
 * F093 Sprint 18 — parameterised place-order handler. Drop-in replacement
 * for the per-venue handler skeleton (validated against /hyperliquid/order).
 *
 * Mirrors the legacy response shape exactly: `{ ok: true, order: result.raw,
 * position }`. The adapter's `placeOrder` returns `NormalizedOrderResult`
 * (for orchestration use) plus a `raw` field (for the response body) so the
 * SDK + frontend continue to see byte-identical payloads.
 *
 * Gated by `MARKETS_ROUTER_V2` env flag — off by default; the per-venue
 * legacy handlers are still the default path until each venue's adapter
 * lands AND a shadow-test confirms response parity.
 */
async function handleAdapterPlaceOrder<TInput>(
  c: Context,
  adapter: MarketAdapter<TInput>,
): Promise<Response> {
  // F093 router-v2 observability: track outcome + latency by version + venue.
  // Cardinality is bounded: version ∈ {v2}, venue ∈ 6 venues, result is a
  // closed enum (no user/order ids). Pair with marketRouterRequests on the
  // v1 path so dashboards can A/B v1 vs v2 during canary rollout.
  const routerStart = performance.now();
  const recordRouterOutcome = (result: string): void => {
    marketRouterRequests.inc({ version: 'v2', venue: adapter.name, result });
    marketRouterDuration.observe(
      { version: 'v2', venue: adapter.name },
      (performance.now() - routerStart) / 1000,
    );
  };

  const blocked = marketsGate(c);
  if (blocked) { recordRouterOutcome('markets_gate_blocked'); return blocked; }
  const u = c.get('user');

  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = adapter.parseBody(rawBody);
  if (!parsed.ok) {
    recordRouterOutcome('parse_error');
    throw ApiError.badRequest(parsed.code, parsed.details);
  }
  const input = parsed.input;
  const orderVenue = (input as { venue?: MarketVenue }).venue ?? adapter.name;
  const qtyUsd = (input as { qtyUsd?: number }).qtyUsd ?? 0;

  const gate = tradeGate(c, u, {
    venue: orderVenue,
    qtyUsd,
    isLiveTrading: adapter.isLiveTrading,
  });
  if (gate) { recordRouterOutcome('trade_gate_blocked'); return gate; }
  const walletGate = adapter.name === 'jupiter'
    ? null
    : await liveTradingWalletGate(c, adapter.name, adapter.isLiveTrading, u);
  if (walletGate) { recordRouterOutcome('wallet_gate_blocked'); return walletGate; }

  const idempotencyKey = idempotencyKeyOf(c);
  if (adapter.isLiveTrading && !idempotencyKey) {
    recordRouterOutcome('idempotency_key_required');
    throw ApiError.badRequest('idempotency_key_required');
  }

  const ctx: MarketAdapterContext = {
    privyWalletId: u.privyWalletId ?? null,
    privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
    privyDid: u.privyDid ?? null,
    userId: u.id,
  };

  // Reservation goes in BEFORE the venue call. Adapter doesn't see this — it's
  // purely the orchestration's idempotency guard, identical across venues.
  // Symbol pre-reservation must come from the parsed input; adapters that
  // store the coin under a different key (e.g. polymarket marketId) override
  // by adding a `reservationSymbol` method later (kept open).
  const polymarketInput = adapter.name === 'polymarket'
    ? input as { marketId?: string; outcome?: string; priceCents?: number }
    : null;
  const preReserveSymbol = polymarketInput
    ? `${polymarketInput.marketId ?? ''}:${polymarketInput.outcome ?? ''}`
    : (input as { coin?: string; symbol?: string; marketId?: string }).coin ??
      (input as { symbol?: string }).symbol ??
      (input as { marketId?: string }).marketId ??
      '';
  const preReserveSideLong = polymarketInput
    ? String(polymarketInput.outcome ?? '').toUpperCase() !== 'NO'
    : (input as { sideLong?: boolean }).sideLong ?? false;
  const preReserveEntryPrice = polymarketInput
    ? Number(polymarketInput.priceCents ?? 0) / 100
    : (input as { limitPriceUsd?: number }).limitPriceUsd ?? 0;
  const reservation = idempotencyKey
    ? await store.reserveMarketOrder(u, {
        venue: orderVenue,
        symbol: preReserveSymbol,
        sideLong: preReserveSideLong,
        qtyUsd,
        entryPriceUsd: preReserveEntryPrice,
        externalRef: null,
        idempotencyKey,
      })
    : null;
  if (reservation && !reservation.fresh) {
    recordRouterOutcome('idempotency_replay');
    return replayOrBlockReservedOrder(c, reservation, !adapter.isLiveTrading);
  }
  if (reservation?.fresh) {
    await lifecycle(reservation.position.id, 'reserved');
  }

  let result: NormalizedOrderResult;
  try {
    await lifecycle(reservation?.position.id ?? null, 'submitted');
    result = await adapter.placeOrder(input, ctx);
  } catch (e) {
    if (reservation?.fresh) {
      await store.failMarketOrder(reservation.position.id).catch((err) => {
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            positionId: reservation.position.id,
            venue: orderVenue,
          },
          'markets-v2: failed to mark reservation failed',
        );
      });
    }
    // Adapter-thrown preflight failures (tokenId lookup, CLOB creds derive,
    // Solana wallet provisioning, etc.) carry their own status + code so
    // the v2 wire shape stays byte-identical to v1. Everything else falls
    // through to the generic 502 venueFailure path.
    if (e instanceof MarketPreflightError) {
      marketsOrders.inc({ venue: orderVenue, result: e.code });
      recordRouterOutcome('preflight_error');
      return marketError(c, e.statusCode, e.code);
    }
    recordRouterOutcome('venue_error');
    return venueFailure(c, adapter.name, 'order', e);
  }

  const terminalStatus = mapResultStateToLifecycle(result.state);
  const recordedQtyUsd = terminalStatus === 'filled' ? result.filledQtyUsd : qtyUsd;
  let position: MarketPosition;
  try {
    position = reservation
      ? await completeAcceptedMarketOrder(orderVenue, reservation.position.id, {
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
          symbol: result.symbol,
          sideLong: result.sideLong,
        })
      : await store.placeMarketOrder(u, {
          venue: orderVenue,
          symbol: result.symbol,
          sideLong: result.sideLong,
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
        });
  } catch (e) {
    recordRouterOutcome('recording_error');
    return recordingFailure(c, orderVenue, e);
  }
  const finalized = await lifecycle(position.id, terminalStatus, {
    externalOrderId: result.orderId,
    filledQtyUsd: result.filledQtyUsd > 0 ? result.filledQtyUsd : undefined,
    avgFillPriceUsd: result.filledQtyUsd > 0 ? result.entryPriceUsd : undefined,
    demo: result.demo,
    providerPayload: result.raw,
  });
  if (finalized) position = finalized;

  marketsOrders.inc({ venue: orderVenue, result: 'success' });
  recordRouterOutcome('success');
  {
    const rate = configuredRateBps(orderVenue);
    if (rate.bps > 0 && result.filledQtyUsd > 0) {
      recordFee({
        userId: u.id,
        venue: orderVenue,
        kind: rate.kind,
        notionalUsd: result.filledQtyUsd,
        rateBps: rate.bps,
        symbol: result.symbol,
        attempted: !result.demo,
      });
    }
  }

  const push = adapter.pushFor(input, result);
  void sendExpoPushToUser(u.id, push, { category: 'orders' });

  return c.json({ ok: true, order: result.raw, position });
}

/* ── Hyperliquid (perps) ─────────────────────────────────────────────────── */

marketRoutes.get('/hyperliquid', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const limitQ = Number(c.req.query('limit') ?? 500);
  const limit = Number.isFinite(limitQ) && limitQ > 0 && limitQ <= 1000 ? Math.floor(limitQ) : 500;
  const loaded = await _cachedLoad(`hl-list:${limit}`, 10_000, async () => {
    const result = await hyperliquid.getMarketsResult(limit);
    const sourced = result.source === 'live'
      ? liveMeta('hyperliquid', 'market-list')
      : providerDemoMeta('hyperliquid', 'market-list');
    return {
      source: result.source === 'live' ? 'hyperliquid' : 'demo',
      sourced,
      markets: result.markets,
    };
  });
  return c.json({
    ok: true,
    ...loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

// Builder-fee approval params — read-only legacy/debug metadata. The backend
// now owns approval signing, so this does not execute or submit anything.
// Static path declared before the :coin param so it isn't captured as a coin.
marketRoutes.get('/hyperliquid/builder-approval', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const maxFeeBps = Number(c.req.query('maxFeeBps') ?? 10);
  return c.json({ ok: true, params: hyperliquid.builderApprovalParams(maxFeeBps) });
});

/**
 * Sprint 16.4 — Builder approval status for the current user.
 *
 * Returns the backend-managed `approveBuilderFee` agreement status. The
 * current builder fee comes from env so the UI can display the fee, but it
 * must not prompt the user during order placement. `needsApproval` remains in
 * the response for old clients and is always false.
 */
marketRoutes.get('/hyperliquid/builder-status', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const tenths = currentHlBuilderFeeTenths();
  const currentFeeBps = tenths / 10; // 25 tenths-of-bp = 2.5 bps
  const builderAddress = env.HL_BUILDER_ADDRESS ?? null;
  const approvedAt = u.hlBuilderApprovedAt ?? null;
  const approvedMaxTenths = u.hlBuilderMaxFeeTenthsBp ?? null;
  const agreementCurrent = !hlBuilderFeeEnabled() || Boolean(
    approvedAt &&
    approvedMaxTenths !== null &&
    approvedMaxTenths >= tenths
  );
  return c.json({
    ok: true,
    builder: {
      address: builderAddress,
      currentFeeTenthsBp: tenths,
      currentFeeBps,
      currentFeeRate: formatBpsAsPercent(currentFeeBps),
      capBps: 10, // perps cap per HL docs
      backendManagedAgreement: true,
    },
    user: {
      approved: Boolean(approvedAt),
      approvedAt,
      approvedMaxFeeTenthsBp: approvedMaxTenths,
      agreementCurrent,
      hasPrivyWallet: Boolean(u.privyWalletId && u.privyWalletAddress),
    },
    needsApproval: false,
  });
});

/**
 * Sprint 16.4 — backend/manual compatibility path for `approveBuilderFee`
 * via the user's Privy server wallet. Normal users get this agreement during
 * account setup or the first live HL action; order placement must not prompt.
 *
 * Body: `{ maxFeeBps?: number }` — defaults to our env fee. Legacy callers
 * can request a higher cap, but this is never an order-time UI prompt.
 */
marketRoutes.post('/hyperliquid/approve-builder', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');

  if (!env.HL_BUILDER_ADDRESS) {
    return marketError(c, 503, 'builder_address_unset');
  }
  if (!features.privy) {
    return marketError(c, 503, 'privy_disabled');
  }

  // Provision wallet lazily if it wasn't cached at sign-in (legacy users).
  let walletId = u.privyWalletId ?? null;
  let walletAddress = u.privyWalletAddress ?? null;
  if (!walletId || !walletAddress) {
    try {
      const wallet = await walletService.getOrCreateUserWallet(u.id, u.privyDid ?? null);
      if (wallet.address && wallet.walletId) {
        walletId = wallet.walletId;
        walletAddress = wallet.address;
        await store.setPrivyWallet(u.id, walletId, walletAddress);
      }
    } catch (e) {
      log.error(
        { err: e instanceof Error ? e.message : String(e), userId: u.id },
        'approve-builder: wallet provision failed',
      );
    }
  }
  if (!walletId || !walletAddress) {
    return marketError(c, 503, 'wallet_unavailable');
  }

  const body = (await c.req.json().catch(() => ({}))) as { maxFeeBps?: number };
  const requestedMaxBps = Number(body.maxFeeBps ?? 0);
  const envTenths = currentHlBuilderFeeTenths();
  const envBps = envTenths / 10;
  // Cap at perps max (10 bps); floor at the env fee so we don't approve a
  // smaller-than-current rate by accident.
  const safeMaxBps = Math.max(envBps, Math.min(10, Number.isFinite(requestedMaxBps) ? requestedMaxBps : envBps));
  const maxFeeRate = formatBpsAsPercent(safeMaxBps);
  // Builder address must be lowercase per HL signing spec — the SDK
  // checksums on signing if we forget, but we send what we sign.
  const builderLower = env.HL_BUILDER_ADDRESS.toLowerCase() as `0x${string}`;

  const nonce = nextHlNonce();
  const action = {
    type: 'approveBuilderFee' as const,
    signatureChainId: HL_USER_SIGN_CHAIN_ID,
    hyperliquidChain: HL_HYPERLIQUID_CHAIN,
    maxFeeRate,
    builder: builderLower,
    nonce,
  };

  try {
    const signature = await hlSignUserSignedAction({
      walletId,
      walletAddress: walletAddress as `0x${string}`,
      action,
      types: ApproveBuilderFeeTypes,
    });

    const res = await fetch('https://api.hyperliquid.xyz/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, signature, nonce }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      response?: string | { type?: string };
    };

    if (!res.ok || data.status !== 'ok') {
      const reason = typeof data.response === 'string' ? data.response : 'rejected';
      log.warn(
        { status: res.status, reason, userId: u.id },
        'approve-builder: HL rejected',
      );
      return marketError(c, 422, 'approval_rejected', { reason });
    }

    // Persist the approval — record the maximum the user just signed for.
    const persistedTenths = Math.round(safeMaxBps * 10);
    await store.setHlBuilderApproval(u.id, persistedTenths);

    log.info(
      { userId: u.id, maxFeeBps: safeMaxBps, builder: builderLower },
      'approve-builder: persisted',
    );

    return c.json({
      ok: true,
      builder: { address: builderLower, maxFeeRate, maxFeeTenthsBp: persistedTenths },
      approvedAt: new Date().toISOString(),
    });
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e), userId: u.id },
      'approve-builder: failed',
    );
    return marketError(c, 422, 'approval_failed');
  }
});

marketRoutes.post('/hyperliquid/order', async (c) => {
  // F093 Sprint 18 — route through the unified MarketAdapter handler when
  // `MARKETS_ROUTER_V2=1`. The legacy per-venue path below stays the default
  // until each venue's adapter lands AND shadow-test confirms parity.
  if (env.MARKETS_ROUTER_V2) {
    return handleAdapterPlaceOrder(c, hyperliquidAdapter);
  }
  // F093 canary metric — count v1 entries so dashboards can A/B vs v2.
  // Outcome detail lives in markets_orders_total; v1 latency in
  // http_request_duration_seconds (route=/markets/hyperliquid/order).
  marketRouterRequests.inc({ version: 'v1', venue: 'hyperliquid', result: 'entered' });
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  // V2 body permits the new `kind`/trigger/twap/tpsl fields; legacy
  // orderType/limitPriceUsd/tif still accepted and mapped via parseHlOrderShapeV2.
  const body = (await c.req.json().catch(() => ({}))) as {
    coin?: string;
    sideLong?: boolean;
    qtyUsd?: number;
    leverage?: number;
    kind?: string;
    orderType?: 'market' | 'limit';
    limitPriceUsd?: number;
    triggerPriceUsd?: number;
    stopKind?: 'sl' | 'tp';
    durationMinutes?: number;
    randomize?: boolean;
    tif?: 'Ioc' | 'Gtc' | 'Alo';
    reduceOnly?: boolean;
    takeProfit?: unknown;
    stopLoss?: unknown;
  };
  const coin = String(body.coin ?? '').trim().toUpperCase();
  const qtyUsd = Number(body.qtyUsd ?? 0);
  if (!coin) throw ApiError.badRequest('invalid_coin');
  if (!(qtyUsd > 0)) throw ApiError.badRequest('invalid_qty');
  // V2 parser handles both new `kind` shape AND legacy `orderType`/`tif`.
  const parsed = parseHlOrderShapeV2(body as Record<string, unknown>);
  const reduceOnly = body.reduceOnly === true;
  // Hyperliquid rejects orders under $10 notional ("order must have minimum
  // value of $10" — raw venue 422, live-tested 2026-07-06). Fail fast with an
  // actionable code; reduce-only stays exempt so dust positions remain
  // closable. Live-only: demo flows keep exercising small synthetic orders.
  const HL_MIN_ORDER_USD = 10;
  if (hyperliquid.isLiveTrading && !reduceOnly && qtyUsd < HL_MIN_ORDER_USD) {
    marketsOrders.inc({ venue: 'hyperliquid', result: 'below_min_order' });
    return marketError(c, 422, 'hyperliquid_min_order_value', {
      minimumUsd: HL_MIN_ORDER_USD,
      requestedUsd: qtyUsd,
    });
  }
  const gate = tradeGate(c, u, { venue: 'hyperliquid', qtyUsd, isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;

  const idempotencyKey = idempotencyKeyOf(c);
  if (hyperliquid.isLiveTrading && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  const reservationLimitPx = parsed.kind === 'limit' || parsed.kind === 'stopLimit'
    ? parsed.limitPriceUsd
    : 0;
  const reservation = idempotencyKey
    ? await store.reserveMarketOrder(u, {
        venue: 'hyperliquid',
        symbol: coin,
        sideLong: Boolean(body.sideLong),
        qtyUsd,
        entryPriceUsd: reservationLimitPx,
        externalRef: null,
        idempotencyKey,
      })
    : null;
  if (reservation && !reservation.fresh) {
    return replayOrBlockReservedOrder(c, reservation, !hyperliquid.isLiveTrading);
  }
  // Sprint 1 lifecycle: record `reserved` only on the FRESH reservation so an
  // idempotent replay doesn't double-append to the audit trail.
  if (reservation?.fresh) {
    await lifecycle(reservation.position.id, 'reserved');
  }
  // `submitted` fires just before the venue call so consumers know we're
  // attempting (matters for resting orders where the venue may take seconds).
  await lifecycle(reservation?.position.id ?? null, 'submitted');
  let result: Awaited<ReturnType<typeof hyperliquid.placeOrder>>;
  try {
    result = await hyperliquid.placeOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin,
      sideLong: Boolean(body.sideLong),
      qtyUsd,
      leverage: Number(body.leverage ?? 1),
      kind: parsed.kind,
      tif: parsed.kind === 'twap' ? undefined : parsed.tif,
      limitPriceUsd: parsed.kind === 'limit' || parsed.kind === 'stopLimit' ? parsed.limitPriceUsd : undefined,
      triggerPriceUsd: parsed.kind === 'stopLimit' ? parsed.triggerPriceUsd : undefined,
      stopKind: parsed.kind === 'stopLimit' ? parsed.stopKind : undefined,
      durationMinutes: parsed.kind === 'twap' ? parsed.durationMinutes : undefined,
      randomize: parsed.kind === 'twap' ? parsed.randomize : undefined,
      takeProfit: parsed.kind === 'market' || parsed.kind === 'limit' ? parsed.takeProfit : undefined,
      stopLoss: parsed.kind === 'market' || parsed.kind === 'limit' ? parsed.stopLoss : undefined,
      reduceOnly,
    });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'rejected', {
        errorCode: 'venue_rejected',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      await store.failMarketOrder(reservation.position.id).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), positionId: reservation.position.id },
          'markets: failed to mark hyperliquid reservation failed',
        );
      });
    }
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
  const terminalStatus = mapResultStateToLifecycle(result.state);
  const recordedQtyUsd = terminalStatus === 'filled' ? result.filledQtyUsd : qtyUsd;
  let position: MarketPosition;
  try {
    position = reservation
      ? await completeAcceptedMarketOrder('hyperliquid', reservation.position.id, {
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
        })
      : await store.placeMarketOrder(u, {
          venue: 'hyperliquid',
          symbol: coin,
          sideLong: Boolean(body.sideLong),
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
        });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'failed', {
        errorCode: 'order_recording_pending',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return recordingFailure(c, 'hyperliquid', e);
  }
  // Map adapter result.state → lifecycle terminal/resting status, then append
  // the canonical lifecycle event. This is what NEO terminal + MAZE read.
  const finalized = await lifecycle(position.id, terminalStatus, {
    externalOrderId: result.orderId,
    filledQtyUsd: result.filledQtyUsd > 0 ? result.filledQtyUsd : undefined,
    avgFillPriceUsd: result.entryPriceUsd > 0 ? result.entryPriceUsd : undefined,
    demo: result.demo,
  });
  if (finalized) position = finalized;
  marketsOrders.inc({ venue: 'hyperliquid', result: 'success' });
  {
    const rate = configuredRateBps('hyperliquid');
    if (rate.bps > 0) {
      recordFee({
        userId: u.id,
        venue: 'hyperliquid',
        kind: rate.kind,
        notionalUsd: result.filledQtyUsd,
        rateBps: rate.bps,
        symbol: coin,
        attempted: !result.demo,
      });
    }
  }
  // Fire-and-forget push to the user's mobile devices. Failures log and do
  // not affect the HTTP response. v1 dispatch is direct from the route — v1.1
  // moves this behind an event bus + dedicated worker.
  void sendExpoPushToUser(u.id, {
    title: `${coin} ${body.sideLong ? 'long' : 'short'} filled`,
    body: `$${result.filledQtyUsd.toFixed(2)} @ $${result.entryPriceUsd.toFixed(2)}`,
    link: '/portfolio',
    data: { venue: 'hyperliquid', coin, orderId: result.orderId },
  }, { category: 'orders' });
  return c.json({ ok: true, order: result, position });
});

marketRoutes.post('/hyperliquid/cancel', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { externalRef?: string; coin?: string };
  const externalRef = String(body.externalRef ?? '').trim();
  const coin = String(body.coin ?? '').trim().toUpperCase();
  if (!externalRef) throw ApiError.badRequest('invalid_ref');
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  const existingPosition = (await store.listMarketPositions(u, 'hyperliquid')).find(
    (p) => p.externalRef === externalRef,
  );
  if (!existingPosition) {
    // TP/SL child legs are created venue-side by the parent order and never
    // get a local order row. When the ref parses as a venue oid and the
    // client supplied the coin, fall through to a venue-only cancel instead
    // of 404ing (audit A10). Anything else stays not_found.
    const looksLikeVenueOid = /^hl_\d+$/i.test(externalRef) || /^\d+$/.test(externalRef);
    if (!looksLikeVenueOid || !coin) throw ApiError.notFound('not_found');
    try {
      await hyperliquid.cancelOrder({
        privyWalletId: u.privyWalletId ?? null,
        privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
        coin,
        externalRef,
      });
    } catch (e) {
      return venueFailure(c, 'hyperliquid', 'cancel', e);
    }
    return c.json({ ok: true, position: null });
  }
  const cancelBlocked = assertCancellableOrder(c, existingPosition);
  if (cancelBlocked) return cancelBlocked;
  // Sprint 1 lifecycle — record the cancel intent before the venue call so
  // consumers see `cancel_requested` immediately (matters when the venue is
  // slow / the cancel hangs).
  await lifecycle(existingPosition.id, 'cancel_requested');
  try {
    await hyperliquid.cancelOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin: coin || existingPosition.symbol,
      externalRef,
    });
  } catch (e) {
    await lifecycle(existingPosition.id, 'failed', {
      errorCode: 'cancel_rejected',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return venueFailure(c, 'hyperliquid', 'cancel', e);
  }
  let position = await store.cancelMarketOrder(u, externalRef);
  if (!position) throw ApiError.notFound('not_found');
  const finalized = await lifecycle(position.id, 'canceled');
  if (finalized) position = finalized;
  return c.json({ ok: true, position });
});

// ──────────────────────────────────────────────────────────────────────────
// HL order-type expansion v2 — stub routes returning 503 not_implemented.
// Each phase past Phase 2 fills these in with real adapter calls + Privy
// server-wallet signing. Adapter stubs at hyperliquid.ts mirror these by name.
// ──────────────────────────────────────────────────────────────────────────

marketRoutes.post('/hyperliquid/cancel-many', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    cancels?: Array<{ coin?: string; orderId?: string }>;
  };
  const cancels = (body.cancels ?? [])
    .map((c2) => ({ coin: String(c2.coin ?? '').trim().toUpperCase(), orderId: String(c2.orderId ?? '').trim() }))
    .filter((c2) => c2.coin && c2.orderId);
  if (cancels.length === 0) throw ApiError.badRequest('invalid_cancels');
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  // Sprint 1 lifecycle: emit `cancel_requested` for each owned order BEFORE
  // the batch venue call so UI gets immediate feedback per order.
  const ownedPositions = await store.listMarketPositions(u, 'hyperliquid');
  const blockedOwnedCancel = cancels
    .map((r) => ownedPositions.find((p) => p.externalRef === r.orderId))
    .find((p): p is MarketPosition => p !== undefined && !canCancelMarketOrder(p));
  if (blockedOwnedCancel) return orderNotCancellable(c, blockedOwnedCancel);
  const cancelRequested = new Map<string, string>(); // orderId → positionId
  for (const r of cancels) {
    const pos = ownedPositions.find((p) => p.externalRef === r.orderId);
    if (pos) {
      cancelRequested.set(r.orderId, pos.id);
      await lifecycle(pos.id, 'cancel_requested');
    }
  }
  try {
    const result = await hyperliquid.cancelMany({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      cancels,
    });
    await Promise.all(
      result.results.map(async (r) => {
        const positionId = cancelRequested.get(r.orderId);
        if (r.ok) {
          await store.cancelMarketOrder(u, r.orderId).catch(() => null);
          if (positionId) await lifecycle(positionId, 'canceled');
        } else if (positionId) {
          await lifecycle(positionId, 'failed', {
            errorCode: r.error?.code ?? 'cancel_rejected',
            errorMessage: r.error?.message,
          });
        }
      }),
    );
    return c.json(result);
  } catch (e) {
    // Whole-batch failure → mark every cancel_requested back to failed.
    for (const positionId of cancelRequested.values()) {
      await lifecycle(positionId, 'failed', {
        errorCode: 'cancel_many_rejected',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return venueFailure(c, 'hyperliquid', 'cancel', e);
  }
});

marketRoutes.post('/hyperliquid/modify', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    coin?: string;
    orderId?: string;
    order?: Record<string, unknown>;
  };
  const coin = String(body.coin ?? '').trim().toUpperCase();
  const orderId = String(body.orderId ?? '').trim();
  if (!coin) throw ApiError.badRequest('invalid_coin');
  if (!orderId) throw ApiError.badRequest('invalid_order_id');
  if (!body.order || typeof body.order !== 'object') throw ApiError.badRequest('invalid_order');
  const parsed = parseHlOrderShapeV2(body.order);
  const qtyUsd = Number((body.order as { qtyUsd?: number }).qtyUsd ?? 0);
  if (!(qtyUsd > 0)) throw ApiError.badRequest('invalid_qty');
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  // Sprint 1 lifecycle: HL modify is a cancel+replace on the venue side. Find
  // the owned position by externalRef so we can record a transition. NOTE:
  // the modify adapter returns the SAME orderId on success, so the row's
  // externalRef doesn't change.
  const ownedPositions = await store.listMarketPositions(u, 'hyperliquid');
  const existingPosition = ownedPositions.find((p) => p.externalRef === orderId);
  await lifecycle(existingPosition?.id, 'submitted');
  try {
    const result = await hyperliquid.modifyOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin,
      orderId,
      order: {
        privyWalletId: null,
        privyWalletAddress: null,
        coin,
        sideLong: Boolean((body.order as { sideLong?: boolean }).sideLong),
        qtyUsd,
        leverage: Number((body.order as { leverage?: number }).leverage ?? 1),
        kind: parsed.kind,
        tif: parsed.kind === 'twap' ? undefined : parsed.tif,
        limitPriceUsd: parsed.kind === 'limit' || parsed.kind === 'stopLimit' ? parsed.limitPriceUsd : undefined,
        triggerPriceUsd: parsed.kind === 'stopLimit' ? parsed.triggerPriceUsd : undefined,
        stopKind: parsed.kind === 'stopLimit' ? parsed.stopKind : undefined,
        reduceOnly: Boolean((body.order as { reduceOnly?: boolean }).reduceOnly),
      },
    });
    // Modify accepted — order is back to `resting` with new params.
    await lifecycle(existingPosition?.id, 'resting', {
      externalOrderId: result.orderId,
      demo: result.demo,
    });
    return c.json({ ok: true, order: result });
  } catch (e) {
    await lifecycle(existingPosition?.id, 'failed', {
      errorCode: 'modify_rejected',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
});

marketRoutes.post('/hyperliquid/update-leverage', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    coin?: string;
    leverage?: number;
    isCross?: boolean;
  };
  const coin = String(body.coin ?? '').trim().toUpperCase();
  const leverage = Math.floor(Number(body.leverage ?? 0));
  if (!coin) throw ApiError.badRequest('invalid_coin');
  if (!(leverage > 0 && leverage <= 1000)) throw ApiError.badRequest('invalid_leverage');
  const isCross = body.isCross !== false;
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  try {
    await hyperliquid.updateLeverage({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin,
      leverage,
      isCross,
    });
    return c.json({ ok: true, leverage, isCross });
  } catch (e) {
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
});

marketRoutes.post('/hyperliquid/update-isolated-margin', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    coin?: string;
    amountUsd?: number;
    sideLong?: boolean;
  };
  const coin = String(body.coin ?? '').trim().toUpperCase();
  // Signed margin delta: positive adds to the isolated position, negative
  // removes. The adapter converts to HL's `ntli` int (6 decimals).
  const amountUsd = Number(body.amountUsd ?? 0);
  if (!coin) throw ApiError.badRequest('invalid_coin');
  if (!Number.isFinite(amountUsd) || amountUsd === 0 || Math.abs(amountUsd) > 10_000_000) {
    throw ApiError.badRequest('invalid_amount');
  }
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  try {
    const result = await hyperliquid.updateIsolatedMargin({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin,
      sideLong: body.sideLong !== false,
      amountUsd,
    });
    return c.json({ ok: true, coin, amountUsd, demo: result.demo });
  } catch (e) {
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
});

marketRoutes.post('/hyperliquid/usd-class-transfer', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    amountUsd?: number;
    toPerp?: boolean;
  };
  const amountUsd = Number(body.amountUsd ?? 0);
  if (!(amountUsd > 0)) throw ApiError.badRequest('invalid_amount');
  const amountTokenAtoms = BigInt(Math.round(amountUsd * 1_000_000));
  if (amountTokenAtoms <= 0n) throw ApiError.badRequest('amount_below_atom');
  const toPerp = Boolean(body.toPerp);
  const idempotencyKey = idempotencyKeyOf(c);
  if (hyperliquid.isLiveTrading && !idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  const transferInput = idempotencyKey
    ? await transferStore.create({
        userId: u.id,
        fromBucket: toPerp ? 'cash' : 'perps',
        toBucket: toPerp ? 'perps' : 'cash',
        fromChain: 'arbitrum',
        toChain: 'arbitrum',
        amountUsd,
        amountTokenAtoms: amountTokenAtoms.toString(),
        rail: 'internal',
        idempotencyKey: transferIdempotencyKey('hlclass', idempotencyKey),
      })
    : null;
  if (transferInput && !transferInput.fresh) {
    const { transfer } = transferInput;
    return await replayTransferFromCreatedEvent(c, transfer, {
      amountUsd: transfer.amountUsd,
      toPerp,
      demo: false,
    }, { amountUsd, toPerp }, ['amountUsd', 'toPerp']);
  }
  if (transferInput) {
    await transferStore.appendEvent(transferInput.transfer.id, 'created', {
      route: 'markets.hyperliquid.usdClassTransfer',
      amountUsd,
      toPerp,
    });
  }
  try {
    const result = await hyperliquid.usdClassTransfer({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      amountUsd,
      toPerp,
    });
    if (!transferInput) return c.json(result);
    const completed = await recordSubmittedTransferComplete(transferInput.transfer, result.callId, {
      amountUsd,
      toPerp,
    }, 'usd_class_transfer_audit_failed');
    return c.json({ ...result, transfer: completed ?? transferInput.transfer, idempotent: false, replay: false });
  } catch (e) {
    if (transferInput) {
      await transferStore.update(transferInput.transfer.id, {
        status: 'failed',
        error: {
          code: 'usd_class_transfer_failed',
          message: e instanceof Error ? e.message : String(e),
        },
      });
      await transferStore.appendEvent(transferInput.transfer.id, 'failed', {
        amountUsd,
        toPerp,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
});

marketRoutes.post('/hyperliquid/usd-send', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  if (!hyperliquid.isLiveTrading) {
    return marketError(c, 503, 'usd_send_disabled_in_demo');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    destination?: string;
    amountUsd?: number;
  };
  const destination = String(body.destination ?? '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(destination)) throw ApiError.badRequest('invalid_destination');
  const amountUsd = Number(body.amountUsd ?? 0);
  if (!(amountUsd > 0)) throw ApiError.badRequest('invalid_amount');
  const amountTokenAtoms = BigInt(Math.round(amountUsd * 1_000_000));
  if (amountTokenAtoms <= 0n) throw ApiError.badRequest('amount_below_atom');
  const idempotencyKey = idempotencyKeyOf(c);
  if (!idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  const { transfer, fresh } = await transferStore.create({
    userId: u.id,
    fromBucket: 'perps',
    toBucket: 'external',
    fromChain: 'arbitrum',
    toChain: 'arbitrum',
    amountUsd,
    amountTokenAtoms: amountTokenAtoms.toString(),
    rail: 'internal',
    idempotencyKey: transferIdempotencyKey('hlusdsend', idempotencyKey),
  });
  if (!fresh) {
    return await replayTransferFromCreatedEvent(c, transfer, {
      destination,
      amountUsd: transfer.amountUsd,
      demo: false,
    }, { destination, amountUsd }, ['destination', 'amountUsd']);
  }
  await transferStore.appendEvent(transfer.id, 'created', {
    route: 'markets.hyperliquid.usdSend',
    destination,
    amountUsd,
  });
  try {
    const result = await hyperliquid.usdSend({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      destination: destination as `0x${string}`,
      amountUsd,
    });
    const completed = await recordSubmittedTransferComplete(transfer, result.callId, {
      destination,
      amountUsd,
    }, 'usd_send_audit_failed');
    return c.json({ ...result, transfer: completed ?? transfer, idempotent: false, replay: false });
  } catch (e) {
    await transferStore.update(transfer.id, {
      status: 'failed',
      error: {
        code: 'usd_send_failed',
        message: e instanceof Error ? e.message : String(e),
      },
    });
    await transferStore.appendEvent(transfer.id, 'failed', {
      destination,
      amountUsd,
      error: e instanceof Error ? e.message : String(e),
    });
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
});

marketRoutes.post('/hyperliquid/transfer-to-dex', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    amountUsd?: number;
    sourceDex?: string;
    destinationDex?: string;
    token?: string;
  };
  const amountUsd = Number(body.amountUsd ?? 0);
  if (!(amountUsd > 0)) throw ApiError.badRequest('invalid_amount');
  const amountTokenAtoms = BigInt(Math.round(amountUsd * 1_000_000));
  if (amountTokenAtoms <= 0n) throw ApiError.badRequest('amount_below_atom');
  const sourceDex = String(body.sourceDex ?? '').trim();
  const destinationDex = body.destinationDex === undefined ? 'xyz' : String(body.destinationDex).trim();
  if (!/^[A-Za-z0-9._:-]{0,32}$/.test(sourceDex)) throw ApiError.badRequest('invalid_source_dex');
  if (!/^[A-Za-z0-9._:-]{0,32}$/.test(destinationDex)) throw ApiError.badRequest('invalid_destination_dex');
  if (!sourceDex && !destinationDex) throw ApiError.badRequest('invalid_destination_dex');
  if (sourceDex && sourceDex === destinationDex) throw ApiError.badRequest('invalid_destination_dex');
  const token = String(body.token ?? HL_USDC_TOKEN).trim();
  if (!/^[A-Z0-9]+:0x[a-fA-F0-9]{32,64}$/.test(token)) throw ApiError.badRequest('invalid_token');
  const idempotencyKey = idempotencyKeyOf(c);
  if (hyperliquid.isLiveTrading && !idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  const transferInput = idempotencyKey
    ? await transferStore.create({
        userId: u.id,
        fromBucket: 'perps',
        toBucket: 'perps',
        fromChain: 'arbitrum',
        toChain: 'arbitrum',
        amountUsd,
        amountTokenAtoms: amountTokenAtoms.toString(),
        rail: 'internal',
        idempotencyKey: transferIdempotencyKey('hldex', idempotencyKey),
      })
    : null;
  if (transferInput && !transferInput.fresh) {
    const { transfer } = transferInput;
    return await replayTransferFromCreatedEvent(c, transfer, {
      amountUsd: transfer.amountUsd,
      sourceDex,
      destinationDex,
      token,
      demo: false,
    }, { amountUsd, sourceDex, destinationDex, token }, ['amountUsd', 'sourceDex', 'destinationDex', 'token']);
  }
  if (transferInput) {
    await transferStore.appendEvent(transferInput.transfer.id, 'created', {
      route: 'markets.hyperliquid.transferToDex',
      amountUsd,
      sourceDex,
      destinationDex,
      token,
    });
  }
  try {
    const result = await hyperliquid.transferToDex({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      amountUsd,
      sourceDex,
      destinationDex,
      token,
    });
    if (!transferInput) return c.json(result);
    const completed = await recordSubmittedTransferComplete(transferInput.transfer, result.callId, {
      amountUsd,
      sourceDex,
      destinationDex,
      token,
    }, 'transfer_to_dex_audit_failed');
    return c.json({ ...result, transfer: completed ?? transferInput.transfer, idempotent: false, replay: false });
  } catch (e) {
    if (transferInput) {
      await transferStore.update(transferInput.transfer.id, {
        status: 'failed',
        error: {
          code: 'transfer_to_dex_failed',
          message: e instanceof Error ? e.message : String(e),
        },
      });
      await transferStore.appendEvent(transferInput.transfer.id, 'failed', {
        amountUsd,
        sourceDex,
        destinationDex,
        token,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
});

marketRoutes.post('/hyperliquid/withdraw', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  if (!hyperliquid.isLiveTrading) {
    // Demo trading mode — withdrawal would simulate but no funds move; reject
    // to avoid confusing users into thinking they withdrew.
    return marketError(c, 503, 'withdraw_disabled_in_demo');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    destination?: string;
    amountUsd?: number;
  };
  const destination = String(body.destination ?? '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(destination)) throw ApiError.badRequest('invalid_destination');
  const amountUsd = Number(body.amountUsd ?? 0);
  if (!(amountUsd > 0)) throw ApiError.badRequest('invalid_amount');
  const amountTokenAtoms = BigInt(Math.round(amountUsd * 1_000_000));
  if (amountTokenAtoms <= 0n) throw ApiError.badRequest('amount_below_atom');
  const idempotencyKey = idempotencyKeyOf(c);
  if (!idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const gate = tradeGate(c, u, { venue: 'hyperliquid', isLiveTrading: hyperliquid.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid', hyperliquid.isLiveTrading, u);
  if (walletGate) return walletGate;
  const { transfer, fresh } = await transferStore.create({
    userId: u.id,
    fromBucket: 'perps',
    toBucket: 'external',
    fromChain: 'arbitrum',
    toChain: 'arbitrum',
    amountUsd,
    amountTokenAtoms: amountTokenAtoms.toString(),
    rail: 'hl_withdraw',
    idempotencyKey: transferIdempotencyKey('hlwithdraw', idempotencyKey),
  });
  if (!fresh) {
    return await replayTransferFromCreatedEvent(c, transfer, {
      destination,
      amountUsd: transfer.amountUsd,
      demo: false,
    }, { destination, amountUsd }, ['destination', 'amountUsd']);
  }
  await transferStore.appendEvent(transfer.id, 'created', {
    route: 'markets.hyperliquid.withdraw',
    destination,
    amountUsd,
  });
  try {
    const result = await hyperliquid.withdraw3({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      destination: destination as `0x${string}`,
      amountUsd,
    });
    const completed = await recordSubmittedTransferComplete(transfer, result.callId, {
      destination,
      amountUsd,
    }, 'withdraw3_audit_failed');
    return c.json({ ...result, transfer: completed ?? transfer, idempotent: false, replay: false });
  } catch (e) {
    await transferStore.update(transfer.id, {
      status: 'failed',
      error: {
        code: 'withdraw3_failed',
        message: e instanceof Error ? e.message : String(e),
      },
    });
    await transferStore.appendEvent(transfer.id, 'failed', {
      destination,
      amountUsd,
      error: e instanceof Error ? e.message : String(e),
    });
    return venueFailure(c, 'hyperliquid', 'order', e);
  }
});

marketRoutes.get('/hyperliquid/open-orders', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const coin = (c.req.query('coin') ?? '').trim().toUpperCase() || undefined;
  const orders = await hyperliquid.getOpenOrders(u.privyWalletAddress ?? null, coin);
  return c.json({ ok: true, orders });
});

marketRoutes.get('/hyperliquid/user-fills', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const limit = boundedQueryInt(c.req.query('limit'), 200, 1, 500);
  const sinceMs = boundedQueryInt(c.req.query('sinceMs'), 0, 0, Number.MAX_SAFE_INTEGER);
  const fills = await hyperliquid.getUserFills(u.privyWalletAddress ?? null, { limit, sinceMs });
  return c.json({ ok: true, fills });
});

marketRoutes.get('/hyperliquid/user-state', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const state = await hyperliquid.getUserState(u.privyWalletAddress ?? null);
  return c.json({ ok: true, state });
});

marketRoutes.get('/hyperliquid/positions', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const positions = await store.listMarketPositions(u, 'hyperliquid');
  return c.json({ ok: true, positions });
});

/**
 * Hyperliquid `/info` proxy endpoints. Browsers (notably the Neo web preview
 * at neo.aiso.tools) can't hit api.hyperliquid.xyz directly because HL doesn't
 * send CORS headers for arbitrary origins. These routes wrap the public
 * `/info` POST endpoints with short in-memory TTL caches so the chart,
 * mid-ticker, orderbook, and trades panel all flow through NEXA.
 *
 * All four are public (no requireSession) — they're public market data.
 */
const _infoCache = new Map<string, { at: number; data: unknown }>();
const _infoInflight = new Map<string, Promise<unknown>>();

export function _resetMarketRouteCacheForTests(): void {
  _infoCache.clear();
  _infoInflight.clear();
}

interface CachedLoad<T> {
  data: T;
  cached: boolean;
  stale: boolean;
}

function _cacheGet(key: string, ttlMs: number): unknown | null {
  const hit = _infoCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) return null;
  return hit.data;
}

async function _cachedLoad<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  staleMs = 5 * 60_000,
): Promise<CachedLoad<T>> {
  const now = Date.now();
  const hit = _infoCache.get(key);
  if (hit && now - hit.at <= ttlMs) {
    return { data: hit.data as T, cached: true, stale: false };
  }

  let shared = true;
  let inflight = _infoInflight.get(key) as Promise<T> | undefined;
  if (!inflight) {
    shared = false;
    inflight = load()
      .then((data) => {
        _cacheSet(key, data);
        return data;
      })
      .finally(() => {
        _infoInflight.delete(key);
      });
    _infoInflight.set(key, inflight);
  }

  try {
    return { data: await inflight, cached: shared, stale: false };
  } catch (e) {
    if (hit && now - hit.at <= staleMs) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), key },
        'markets: serving stale cached read after upstream failure',
      );
      return { data: hit.data as T, cached: true, stale: true };
    }
    throw e;
  }
}

function _cacheSet(key: string, data: unknown) {
  _infoCache.set(key, { at: Date.now(), data });
  if (_infoCache.size > 500) {
    const cutoff = Date.now() - 60_000;
    for (const [k, v] of _infoCache) if (v.at < cutoff) _infoCache.delete(k);
    while (_infoCache.size > 500) _infoCache.delete(_infoCache.keys().next().value as string);
  }
}

function boundedQueryInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function optionalQueryInt(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

marketRoutes.get('/hyperliquid/candles', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = cleanHlPublicCoin(c.req.query('coin'));
  const interval = cleanHlPublicInterval(c.req.query('interval'));
  const lookbackMs = cleanHlLookback(c.req.query('lookback'));
  // Optional older-history page window (`end` = ms). Bucketed to the interval
  // so backfill pages share cache keys and don't fragment the store.
  const endMs = cleanHlCandleEnd(c.req.query('end'), interval);
  const key = `candles:${coin}:${interval}:${lookbackMs}:${endMs ?? 'live'}`;
  // Scale plan 1.7 — was raw _cacheGet/_cacheSet: 200 chart viewers hitting a
  // cold key sent 200 simultaneous HL calls. _cachedLoad single-flights the
  // miss and serves stale on upstream failure like every other hot read.
  // Older pages are immutable history → cache them far longer than the live tip.
  const ttl = endMs ? 5 * 60_000 : 10_000;
  const loaded = await _cachedLoad(key, ttl, () =>
    hyperliquid.getCandles(coin, interval, lookbackMs, endMs),
  );
  return c.json({ ok: true, candles: loaded.data, cached: loaded.cached, ...(loaded.stale ? { stale: true } : {}) });
});

marketRoutes.get('/hyperliquid/all-mids', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  // Scale plan 1.7 — single-flight the 1s-TTL miss (this is the hottest poll
  // key in the app) and keep serving the last mids on an upstream 429 blip.
  const loaded = await _cachedLoad('all-mids', 1_000, () => hyperliquid.getAllMids());
  return c.json({ ok: true, mids: loaded.data, cached: loaded.cached, ...(loaded.stale ? { stale: true } : {}) });
});

marketRoutes.get('/hyperliquid/orderbook', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = cleanHlPublicCoin(c.req.query('coin'));
  const dex = cleanHlPublicDex(c.req.query('dex'));
  const key = `book:${dex ?? ''}:${coin}`;
  const loaded = await _cachedLoad(key, 500, () => hyperliquid.getL2Book(coin, dex), 10_000);
  return c.json({
    ok: true,
    book: loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/hyperliquid/recent-trades', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = cleanHlPublicCoin(c.req.query('coin'));
  const dex = cleanHlPublicDex(c.req.query('dex'));
  const key = `trades:${dex ?? ''}:${coin}`;
  const loaded = await _cachedLoad(key, 2_000, () => hyperliquid.getRecentTrades(coin, dex), 15_000);
  return c.json({
    ok: true,
    trades: loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/**
 * Funding-rate history for the detail-page FundingHistory chart. 30s cache;
 * the chart refetches at 5-minute intervals so freshness isn't critical.
 */
marketRoutes.get('/hyperliquid/funding-history', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = cleanHlPublicCoin(c.req.query('coin'));
  const lookbackMs = cleanHlLookback(c.req.query('lookback'));
  const key = `funding-history:${coin}:${lookbackMs}`;
  const loaded = await _cachedLoad(key, 30_000, () => hyperliquid.getFundingHistory(coin, lookbackMs));
  return c.json({
    ok: true,
    history: loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/hyperliquid/:coin', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = c.req.param('coin');
  const loaded = await _cachedLoad(`hl-detail:${coin.toUpperCase()}`, 10_000, async () => {
    const market = await hyperliquid.getMarket(coin);
    if (!market) throw ApiError.notFound('not_found');
    const sourced = hyperliquid.isLive
      ? liveMeta('hyperliquid', 'market-detail')
      : providerDemoMeta('hyperliquid', 'market-detail');
    return { market, sourced };
  }, 60_000);
  return c.json({
    ok: true,
    source: hyperliquid.isLive ? 'hyperliquid' : 'demo',
    sourced: loaded.data.sourced,
    market: loaded.data.market,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/* ── Global market metrics (Fear & Greed + total mcap) ───────────────────── */

/**
 * Public read for the NEO pulse tiles: alternative.me Fear & Greed (current +
 * daily history) and CoinGecko total market cap (value, 24h %, BTC dominance,
 * observed sparkline series). Both legs fail soft to null; 2-min cache with a
 * 30-min stale window because neither source moves faster than that.
 */
marketRoutes.get('/global', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const loaded = await _cachedLoad('global-metrics', 120_000, () => readGlobalMetrics(), 30 * 60_000);
  return c.json({
    ok: true,
    fng: loaded.data.fng,
    mcap: loaded.data.mcap,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/* ── Polymarket (prediction markets, geo-gated) ──────────────────────────── */

marketRoutes.get('/polymarket', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const category = c.req.query('category')?.trim() || undefined;
  const limitQ = Number(c.req.query('limit') ?? 100);
  // 2026-06-21 — lifted ceiling to 5000 to expose the full active prediction
  // universe (Polymarket Gamma paginates 100/page, ~thousands active). Caller
  // chooses; default 100 keeps small-screen tabs snappy.
  const limit = Number.isFinite(limitQ) && limitQ > 0 && limitQ <= 5000 ? Math.floor(limitQ) : 100;
  // Scale plan 1.8 (2026-07-02) — `view=compact` drops `description` (41% of
  // the measured 215 KB list payload) and `related` (11%): list rows render
  // neither; both stay on the detail route. Default shape untouched so
  // existing clients keep working; the projection maps AFTER the cache so
  // both views share ONE upstream fetch per key.
  const compact = c.req.query('view') === 'compact';
  const loaded = await _cachedLoad(`pm-list:${category ?? 'all'}:${limit}`, 30_000, async () => {
    const result = await polymarket.getMarketsResult(limit, category);
    const sourced = result.source === 'live'
      ? liveMeta('polymarket', 'market-list')
      : providerDemoMeta('polymarket', 'market-list');
    return {
      source: result.source === 'live' ? 'polymarket' : 'demo',
      sourced,
      markets: result.markets,
    };
  });
  const markets = compact
    ? loaded.data.markets.map((m) => {
        // PmMarket declares both fields — plain destructure, no cast needed.
        const { description: _description, related: _related, ...rest } = m;
        return rest;
      })
    : loaded.data.markets;
  return c.json({
    ok: true,
    ...loaded.data,
    markets,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/**
 * Polymarket "best traders" leaderboard — live-computed from the top markets'
 * holders, enriched with each wallet's open-position PnL / value / win-rate from
 * the public data-api. Sprint 2 of the copy-trading surface. 5-minute cache —
 * a cold build fans out dozens of upstream calls.
 */
marketRoutes.get('/polymarket/leaderboard', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const sortQ = c.req.query('sort');
  const sort = (['pnl', 'value', 'winRate', 'realizedPnl'] as const).find((s) => s === sortQ) ?? 'pnl';
  const traderLimit = boundedQueryInt(c.req.query('limit'), 20, 1, 50);
  const marketLimit = boundedQueryInt(c.req.query('markets'), 5, 1, 20);
  const key = `pm-leaderboard:${sort}:${traderLimit}:${marketLimit}`;
  const cached = _cacheGet(key, 300_000);
  if (cached) return c.json({ ok: true, ...cached, cached: true });
  const persisted = await pmLeaderboardIndex.read(key);
  if (persisted) {
    _cacheSet(key, persisted.payload);
    return c.json({
      ok: true,
      ...persisted.payload,
      cached: true,
      persisted: true,
      stale: false,
    });
  }
  const loaded = await _cachedLoad(key, 300_000, async () => {
    const result = await polymarket.getLeaderboard({
      sort,
      traders: traderLimit,
      markets: marketLimit,
    });
    const sourced = result.source === 'live'
      ? liveMeta('polymarket', 'leaderboard')
      : providerDemoMeta('polymarket', 'leaderboard');
    const payload: PmLeaderboardSnapshotPayload = {
      source: result.source === 'live' ? 'polymarket' : 'demo',
      sourced,
      traders: result.traders,
    };
    if (payload.traders.length === 0) {
      const stale = await pmLeaderboardIndex.read(key, { allowStale: true });
      if (stale) return { payload: stale.payload, persisted: true, stale: true };
    }
    if (payload.traders.length > 0) {
      await pmLeaderboardIndex.write(key, payload, { ttlMs: 300_000 });
    }
    return { payload, persisted: false, stale: false };
  });
  return c.json({
    ok: true,
    ...loaded.data.payload,
    cached: loaded.cached || loaded.data.persisted,
    ...(loaded.data.persisted ? { persisted: true } : {}),
    ...(loaded.data.stale || loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.post('/polymarket/order', async (c) => {
  // F093 Sprint 18 — route through the unified MarketAdapter handler when
  // `MARKETS_ROUTER_V2=1`. Legacy v1 path below stays default until shadow
  // tests confirm byte-identical parity in production.
  if (env.MARKETS_ROUTER_V2) {
    return handleAdapterPlaceOrder(c, polymarketAdapter);
  }
  marketRouterRequests.inc({ version: 'v1', venue: 'polymarket', result: 'entered' });
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    marketId?: string;
    outcome?: string;
    priceCents?: number;
    qtyUsd?: number;
    copiedFrom?: string;
  };
  const marketId = String(body.marketId ?? '').trim();
  const outcome = String(body.outcome ?? '').trim();
  const priceCents = Number(body.priceCents ?? 0);
  const qtyUsd = Number(body.qtyUsd ?? 0);
  // Copy-trading attribution — display-only, so a malformed value degrades to
  // "not a copy" instead of rejecting the order.
  const copiedFrom = String(body.copiedFrom ?? '').trim().slice(0, 64) || null;
  if (!marketId) throw ApiError.badRequest('invalid_market');
  if (!outcome) throw ApiError.badRequest('invalid_outcome');
  if (!(priceCents > 0 && priceCents < 100)) {
    throw ApiError.badRequest('invalid_price');
  }
  if (!(qtyUsd > 0)) throw ApiError.badRequest('invalid_qty');
  const gate = tradeGate(c, u, { venue: 'polymarket', qtyUsd, isLiveTrading: polymarket.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'polymarket', polymarket.isLiveTrading, u);
  if (walletGate) return walletGate;

  const idempotencyKey = idempotencyKeyOf(c);
  if (polymarket.isLiveTrading && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  const reservation = idempotencyKey
    ? await store.reserveMarketOrder(u, {
        venue: 'polymarket',
        symbol: `${marketId}:${outcome}`,
        sideLong: outcome.toUpperCase() !== 'NO',
        qtyUsd,
        entryPriceUsd: priceCents / 100,
        externalRef: null,
        idempotencyKey,
        copiedFrom,
      })
    : null;
  if (reservation && !reservation.fresh) {
    return replayOrBlockReservedOrder(c, reservation, !polymarket.isLiveTrading);
  }
  // Sprint 2 lifecycle — record `reserved` only on the FRESH reservation.
  if (reservation?.fresh) {
    await lifecycle(reservation.position.id, 'reserved');
  }
  const failReservation = async (reason: string): Promise<void> => {
    if (!reservation?.fresh) return;
    // Sprint 2 lifecycle — record the preflight failure with venue-specific code
    // BEFORE the legacy failMarketOrder so the audit trail captures the why.
    await lifecycle(reservation.position.id, 'failed', {
      errorCode: `polymarket_${reason}`,
      errorMessage: reason,
    });
    await store.failMarketOrder(reservation.position.id).catch((err) => {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          positionId: reservation.position.id,
          reason,
        },
        'markets: failed to mark polymarket reservation failed',
      );
    });
  };

  // Audit 2026-06-19: pre-flight resolve outcome -> tokenId from market data.
  // The CLOB Order `tokenId` field is the OUTCOME token, not the condition id.
  // Live mode must fail closed instead of recording a synthetic demo order.
  let outcomeTokenId: string | null = null;
  try {
    const market = await polymarket.getMarket(marketId);
    if (market) {
      const out = findPmOutcome(market, outcome);
      outcomeTokenId = out?.tokenId ?? null;
    }
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), marketId, outcome },
      'polymarket: tokenId lookup failed',
    );
  }

  if (polymarket.isLiveTrading && !outcomeTokenId) {
    await failReservation('token_unavailable');
    marketsOrders.inc({ venue: 'polymarket', result: 'token_unavailable' });
    return marketError(c, 503, 'polymarket_token_unavailable');
  }

  // Audit 2026-06-19: get-or-derive L2 CLOB credentials for the user.
  // Cached on `nb_users.pm_clob_*` after first successful derive; subsequent
  // orders skip the EIP-712 round-trip. Returns null in demo mode.
  let clobCreds: PmClobCreds | null = null;
  if (
    polymarket.isLiveTrading &&
    outcomeTokenId &&
    u.privyWalletId &&
    u.privyWalletAddress
  ) {
    if (u.pmClobKey && u.pmClobSecret && u.pmClobPassphrase) {
      clobCreds = {
        key: u.pmClobKey,
        secret: u.pmClobSecret,
        passphrase: u.pmClobPassphrase,
      };
    } else {
      const derived = await deriveL2Credentials(u.privyWalletId, u.privyWalletAddress);
      if (derived) {
        await store
          .setPmClobCredentials(u.id, derived, { force: true })
          .catch((err) =>
            log.error(
              { err: err instanceof Error ? err.message : String(err), userId: u.id },
              'polymarket: persist clob creds failed (continuing in-memory)',
            ),
          );
        clobCreds = derived;
      } else {
        log.warn({ userId: u.id }, 'polymarket: L2 derive failed');
      }
    }
  }

  if (polymarket.isLiveTrading && !clobCreds) {
    await failReservation('clob_credentials_unavailable');
    marketsOrders.inc({ venue: 'polymarket', result: 'clob_credentials_unavailable' });
    return marketError(c, 503, 'polymarket_clob_credentials_unavailable');
  }

  // Sprint 2 lifecycle: `submitted` just before the venue call.
  await lifecycle(reservation?.position.id ?? null, 'submitted');
  // Builder Program lane (2026-07-06): engages ONLY when PM_BUILDER_LANE is
  // on AND the user's deposit wallet is verified deployed + approved. Null →
  // legacy lanes with byte-identical behavior.
  const builderLane =
    polymarket.isLiveTrading && u.privyWalletAddress && u.privyWalletId
      ? await getBuilderLaneFunder(u.privyWalletId, u.privyWalletAddress as `0x${string}`)
      : null;
  // Builder-lane orders settle from the DEPOSIT WALLET — pre-check its live
  // pUSD collateral so an underfunded order returns an actionable top-up
  // payload instead of the CLOB's raw "not enough balance / allowance" 422
  // (live-tested 2026-07-06: balance $0.47 vs order $0.62). Read failures
  // fall through to the venue: the pre-check must never block a fundable
  // order on an RPC hiccup.
  if (builderLane) {
    const balanceUsd = await getDepositWalletCollateralUsd(
      builderLane.funderAddress as `0x${string}`,
    ).catch((e: unknown) => {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), wallet: builderLane.funderAddress },
        'polymarket: balance pre-check unavailable — continuing to venue',
      );
      return null;
    });
    if (balanceUsd != null && qtyUsd > balanceUsd + 0.005) {
      await failReservation('insufficient_balance');
      marketsOrders.inc({ venue: 'polymarket', result: 'insufficient_balance' });
      return marketError(c, 422, 'insufficient_prediction_balance', {
        balanceUsd: Math.floor(balanceUsd * 100) / 100,
        requestedUsd: qtyUsd,
        shortfallUsd: Math.ceil((qtyUsd - balanceUsd) * 100) / 100,
      });
    }
  }
  let result: Awaited<ReturnType<typeof polymarket.placeOrder>>;
  try {
    result = await polymarket.placeOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      marketId,
      outcome,
      priceCents,
      qtyUsd,
      outcomeTokenId,
      clobCreds,
      lane: builderLane,
    });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'rejected', {
        errorCode: 'venue_rejected',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      await store.failMarketOrder(reservation.position.id).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), positionId: reservation.position.id },
          'markets: failed to mark polymarket reservation failed',
        );
      });
    }
    return venueFailure(c, 'polymarket', 'order', e);
  }
  const terminalStatus = mapResultStateToLifecycle(result.state);
  const recordedQtyUsd = terminalStatus === 'filled' ? result.filledQtyUsd : qtyUsd;
  let position: MarketPosition;
  try {
    position = reservation
      ? await completeAcceptedMarketOrder('polymarket', reservation.position.id, {
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.priceCents / 100,
          externalRef: result.orderId,
        })
      : await store.placeMarketOrder(u, {
          venue: 'polymarket',
          symbol: `${marketId}:${outcome}`,
          sideLong: outcome.toUpperCase() !== 'NO',
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.priceCents / 100,
          externalRef: result.orderId,
          copiedFrom,
        });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'failed', {
        errorCode: 'failed_local_recording',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return recordingFailure(c, 'polymarket', e);
  }
  const finalized = await lifecycle(position.id, terminalStatus, {
    externalOrderId: result.orderId,
    filledQtyUsd: result.filledQtyUsd > 0 ? result.filledQtyUsd : undefined,
    avgFillPriceUsd: result.filledQtyUsd > 0 ? result.priceCents / 100 : undefined,
    demo: result.demo,
    providerPayload: result,
  });
  if (finalized) position = finalized;
  marketsOrders.inc({ venue: 'polymarket', result: 'success' });
  {
    const rate = configuredRateBps('polymarket');
    if (rate.bps > 0 && result.filledQtyUsd > 0) {
      recordFee({
        userId: u.id,
        venue: 'polymarket',
        kind: rate.kind,
        notionalUsd: result.filledQtyUsd,
        rateBps: rate.bps,
        symbol: `${marketId}:${outcome}`,
        attempted: !result.demo,
      });
    }
  }
  void sendExpoPushToUser(u.id, {
    title: `Prediction ${terminalStatus === 'resting' ? 'resting' : 'filled'}: ${outcome}`,
    body: `$${(terminalStatus === 'resting' ? qtyUsd : result.filledQtyUsd).toFixed(2)} @ ${result.priceCents}c`,
    link: '/portfolio',
    data: { venue: 'polymarket', marketId, outcome, orderId: result.orderId },
  }, { category: 'orders' });
  return c.json({ ok: true, order: result, position });
});

/**
 * POST /markets/polymarket/sell — competitor sprint Lane A (2026-07-03).
 *
 * Closes the loop the buy route opened: sell/close an EXISTING position.
 * Anchored on positionId so the server derives the outcome token and shares
 * held from the stored row — a client can never sell tokens it doesn't hold.
 *
 * Bookkeeping model: the sell is its OWN lifecycle row (symbol
 * `SELL:<positionId>`, qtyUsd = the entry-usd portion being sold,
 * entryPriceUsd = the exit limit price). That gives idempotent replay
 * protection, activity/fills visibility, and resting-sell tracking for free.
 * The HOLDING row is reduced only on a CONFIRMED fill (atomic SQL guard —
 * two racing sells cannot oversell). Proceeds settle ON-CHAIN via the CLOB
 * (USDC.e to the user's wallet); the balances leg reads the chain, so there
 * is deliberately no internal ledger credit here.
 */
marketRoutes.post('/polymarket/sell', async (c) => {
  marketRouterRequests.inc({ version: 'v1', venue: 'polymarket', result: 'entered' });
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const parsed = PolymarketSellInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest('invalid_sell_input', parsed.error.flatten());
  const { positionId, limitPriceCents } = parsed.data;

  const holding = await store.getMarketPositionById(positionId);
  if (!holding || holding.userId !== u.id || holding.venue !== 'polymarket') {
    throw ApiError.notFound('position_not_found');
  }
  if (holding.symbol.startsWith('SELL:')) throw ApiError.badRequest('position_not_sellable');
  // 'partially_filled' deliberately NOT sellable yet: qtyUsd is the requested
  // notional, filledQtyUsd the actual fill — selling against qtyUsd would
  // submit more shares than the wallet holds once the fills worker starts
  // marking partial buys. Revisit together with that worker.
  if (!['open', 'filled'].includes(holding.status)) {
    // KNOWN LIMITATION: an idempotent retry of a sell that already FULLY
    // closed this holding lands here (holding is now 'closed') and reads as
    // position_not_sellable rather than a replay. Clients must treat this
    // code after a sell timeout as "refetch positions and verify" — the
    // sell row itself is visible in the orders feed.
    throw ApiError.badRequest('position_not_sellable');
  }
  if (!(holding.entryPriceUsd > 0)) throw ApiError.badRequest('position_entry_invalid');
  // Venue submits roundDown(shares, 2) (SDK rounding config) — compute the
  // books on the SAME rounded figure so proceeds/fees/reduce never book the
  // shaved fraction the venue didn't trade.
  const requestedQtyUsd = Math.min(parsed.data.qtyUsd ?? holding.qtyUsd, holding.qtyUsd);
  if (!(requestedQtyUsd > 0)) throw ApiError.badRequest('invalid_qty');
  const sizeShares = Math.floor((requestedQtyUsd / holding.entryPriceUsd) * 100) / 100;
  if (!(sizeShares >= 0.01)) throw ApiError.badRequest('sell_below_minimum');
  const sellQtyUsd = sizeShares * holding.entryPriceUsd;
  // Polymarket enforces a ~$1 minimum marketable order — fail with an
  // actionable code instead of a generic venue rejection.
  if (sizeShares * (limitPriceCents / 100) < 1) {
    throw ApiError.badRequest('sell_below_venue_minimum', { minProceedsUsd: 1 });
  }

  const gate = tradeGate(c, u, { venue: 'polymarket', qtyUsd: sellQtyUsd, isLiveTrading: polymarket.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'polymarket', polymarket.isLiveTrading, u);
  if (walletGate) return walletGate;

  const idempotencyKey = idempotencyKeyOf(c);
  if (polymarket.isLiveTrading && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  const sellSymbol = `SELL:${holding.id}`;
  const reservation = idempotencyKey
    ? await store.reserveMarketOrder(u, {
        venue: 'polymarket',
        symbol: sellSymbol,
        sideLong: holding.sideLong,
        qtyUsd: sellQtyUsd,
        entryPriceUsd: limitPriceCents / 100,
        externalRef: null,
        idempotencyKey,
      })
    : null;
  if (reservation && !reservation.fresh) {
    // Review fix (2026-07-03): the shared replay helper returns the BUY
    // response shape ({order, position: reservationRow}) — for sells that
    // would silently swap `position`'s meaning from "updated holding" to
    // "the SELL row" and misreport entry-usd as proceeds. ONLY a genuinely
    // FILLED sell replays as success; everything else (in-flight blocks,
    // failed/rejected/canceled) goes through the helper, whose 409 tells the
    // client to retry with a fresh key — replaying a failure as ok:true
    // would fire success toasts for a sell that never executed.
    if (reservation.intentMismatch || reservation.position.status !== 'filled') {
      return replayOrBlockReservedOrder(c, reservation, !polymarket.isLiveTrading);
    }
    const replayRow = reservation.position;
    const replayFilled = replayRow.filledQtyUsd ?? 0;
    return c.json({
      ok: true,
      replayed: true,
      order: {
        orderId: replayRow.externalRef ?? replayRow.id,
        filledQtyUsd: replayFilled,
        priceCents: Math.round(replayRow.entryPriceUsd * 100),
        demo: false,
        state: replayRow.status === 'filled' ? 'filled' : replayRow.status,
      },
      sellOrder: orderEnvelope(replayRow),
      position: await store.getMarketPositionById(positionId).then((p) => (p ? orderEnvelope(p) : null)),
    });
  }
  if (reservation?.fresh) {
    await lifecycle(reservation.position.id, 'reserved');
  }
  const failReservation = async (reason: string): Promise<void> => {
    if (!reservation?.fresh) return;
    await lifecycle(reservation.position.id, 'failed', {
      errorCode: `polymarket_${reason}`,
      errorMessage: reason,
    });
    await store.failMarketOrder(reservation.position.id).catch((err) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err), positionId: reservation.position.id, reason },
        'markets: failed to mark polymarket sell reservation failed',
      );
    });
  };

  // Oversell guard with insert-then-check serialization: our reservation row
  // is already visible, so of two truly concurrent sells each sees the other's
  // pending row — at least one fails here; both can never pass. Pending sell
  // rows count against the holding at their entry-usd denomination.
  // NOTE: listMarketOrders, NOT listMarketPositions — the positions lister
  // deliberately hides 'pending' pre-reservation rows from display, which
  // would make fresh reservations invisible to this fence.
  // Staleness escape (review fix): a pod crash between reserve and terminal
  // write would otherwise fence the holding FOREVER (reservation rows have
  // no externalRef, so cancel can't clear them). In-flight sells resolve in
  // seconds; rows older than 10 minutes in a pre-venue state are corpses.
  const FENCE_STALE_MS = 10 * 60_000;
  const pendingSells = (
    await store.listMarketOrders(u, {
      venue: 'polymarket',
      symbol: sellSymbol,
      statuses: ['pending', 'reserved', 'submitted', 'accepted', 'resting', 'partially_filled'],
    })
  ).filter(
    (p) =>
      p.id !== reservation?.position.id &&
      !(
        ['pending', 'reserved', 'submitted'].includes(p.status) &&
        Date.now() - Date.parse(p.createdAt) > FENCE_STALE_MS
      ),
  );
  const pendingQtyUsd = pendingSells.reduce((s, p) => s + p.qtyUsd, 0);
  if (pendingQtyUsd + sellQtyUsd > holding.qtyUsd + 0.000001) {
    await failReservation('oversell_blocked');
    marketsOrders.inc({ venue: 'polymarket', result: 'oversell_blocked' });
    throw ApiError.badRequest('sell_exceeds_holding', {
      heldQtyUsd: holding.qtyUsd,
      pendingSellQtyUsd: pendingQtyUsd,
    });
  }

  // Resolve the outcome token from the holding's symbol (`<marketId>:<outcome>`).
  const sepIdx = holding.symbol.indexOf(':');
  const marketId = sepIdx > 0 ? holding.symbol.slice(0, sepIdx) : holding.symbol;
  const outcome = sepIdx > 0 ? holding.symbol.slice(sepIdx + 1) : '';
  let outcomeTokenId: string | null = null;
  try {
    const market = await polymarket.getMarket(marketId);
    if (market) {
      const out = findPmOutcome(market, outcome);
      outcomeTokenId = out?.tokenId ?? null;
    }
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), marketId, outcome },
      'polymarket: sell tokenId lookup failed',
    );
  }
  if (polymarket.isLiveTrading && !outcomeTokenId) {
    await failReservation('token_unavailable');
    marketsOrders.inc({ venue: 'polymarket', result: 'token_unavailable' });
    return marketError(c, 503, 'polymarket_token_unavailable');
  }

  // L2 creds get-or-derive — mirrors the buy route block above (extraction
  // into a shared helper is noted cleanup; not refactoring live buy code in
  // the same PR that adds sell).
  let clobCreds: PmClobCreds | null = null;
  if (polymarket.isLiveTrading && outcomeTokenId && u.privyWalletId && u.privyWalletAddress) {
    if (u.pmClobKey && u.pmClobSecret && u.pmClobPassphrase) {
      clobCreds = { key: u.pmClobKey, secret: u.pmClobSecret, passphrase: u.pmClobPassphrase };
    } else {
      const derived = await deriveL2Credentials(u.privyWalletId, u.privyWalletAddress);
      if (derived) {
        await store
          .setPmClobCredentials(u.id, derived, { force: true })
          .catch((err) =>
            log.error(
              { err: err instanceof Error ? err.message : String(err), userId: u.id },
              'polymarket: persist clob creds failed (continuing in-memory)',
            ),
          );
        clobCreds = derived;
      } else {
        log.warn({ userId: u.id }, 'polymarket: L2 derive failed (sell)');
      }
    }
  }
  if (polymarket.isLiveTrading && !clobCreds) {
    await failReservation('clob_credentials_unavailable');
    marketsOrders.inc({ venue: 'polymarket', result: 'clob_credentials_unavailable' });
    return marketError(c, 503, 'polymarket_clob_credentials_unavailable');
  }

  await lifecycle(reservation?.position.id ?? null, 'submitted');
  // Builder Program lane — sells must ride the SAME identity that holds the
  // position: wallet-ready users sell from the deposit-wallet funder
  // (sigType 3 / POLY_1271).
  const builderSellLane =
    polymarket.isLiveTrading && u.privyWalletAddress && u.privyWalletId
      ? await getBuilderLaneFunder(u.privyWalletId, u.privyWalletAddress as `0x${string}`)
      : null;
  let result: Awaited<ReturnType<typeof polymarket.sellOrder>>;
  try {
    result = await polymarket.sellOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      outcomeTokenId,
      clobCreds,
      priceCents: limitPriceCents,
      sizeShares,
      lane: builderSellLane,
    });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'rejected', {
        errorCode: 'venue_rejected',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      await store.failMarketOrder(reservation.position.id).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), positionId: reservation.position.id },
          'markets: failed to mark polymarket sell reservation failed',
        );
      });
    }
    return venueFailure(c, 'polymarket', 'sell', e);
  }
  const terminalStatus = mapResultStateToLifecycle(result.state);
  let sellRow: MarketPosition;
  try {
    sellRow = reservation
      ? await completeAcceptedMarketOrder('polymarket', reservation.position.id, {
          qtyUsd: sellQtyUsd,
          entryPriceUsd: limitPriceCents / 100,
          externalRef: result.orderId,
        })
      : await store.placeMarketOrder(u, {
          venue: 'polymarket',
          symbol: sellSymbol,
          sideLong: holding.sideLong,
          qtyUsd: sellQtyUsd,
          entryPriceUsd: limitPriceCents / 100,
          externalRef: result.orderId,
        });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'failed', {
        errorCode: 'failed_local_recording',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return recordingFailure(c, 'polymarket', e);
  }
  const finalized = await lifecycle(sellRow.id, terminalStatus, {
    externalOrderId: result.orderId,
    filledQtyUsd: result.filledQtyUsd > 0 ? result.filledQtyUsd : undefined,
    avgFillPriceUsd: result.filledQtyUsd > 0 ? limitPriceCents / 100 : undefined,
    demo: result.demo,
    providerPayload: result,
  });
  if (finalized) sellRow = finalized;

  // Reduce the holding ONLY on a confirmed fill. FOK sells never rest, so a
  // successful venue call means the tokens are gone — the reduce must land.
  let updatedHolding: MarketPosition | null = holding;
  if (terminalStatus === 'filled') {
    updatedHolding = await store.reduceMarketPosition(u, holding.id, sellQtyUsd);
    if (!updatedHolding) {
      // The holding lost a reduce race (double-fire: another sell already
      // consumed it). Review fix (2026-07-03): this must NOT report ok —
      // in demo nothing real happened (clean conflict); in live the venue
      // filled and the books need reconciliation, which a fake success
      // would bury. Fail the sell row loudly and answer 409.
      await lifecycle(sellRow.id, 'failed', {
        errorCode: 'sell_reduce_conflict',
        errorMessage: 'holding already reduced/closed by a concurrent sell',
      });
      await store.failMarketOrder(sellRow.id).catch(() => null);
      log.error(
        { userId: u.id, positionId: holding.id, sellQtyUsd, orderId: result.orderId, demo: result.demo },
        'polymarket: sell filled but holding reduce failed — reconcile',
      );
      marketsOrders.inc({ venue: 'polymarket', result: 'sell_reduce_conflict' });
      throw ApiError.conflict('sell_reduce_conflict', { positionId: holding.id });
    }
  }

  marketsOrders.inc({ venue: 'polymarket', result: 'success' });
  {
    const rate = configuredRateBps('polymarket');
    if (rate.bps > 0 && result.filledQtyUsd > 0) {
      recordFee({
        userId: u.id,
        venue: 'polymarket',
        kind: rate.kind,
        notionalUsd: result.filledQtyUsd,
        rateBps: rate.bps,
        symbol: holding.symbol,
        attempted: !result.demo,
      });
    }
  }
  void sendExpoPushToUser(u.id, {
    title: `Prediction ${terminalStatus === 'resting' ? 'sell resting' : 'sold'}: ${outcome}`,
    body: `$${(terminalStatus === 'resting' ? (sizeShares * limitPriceCents) / 100 : result.filledQtyUsd).toFixed(2)} @ ${limitPriceCents}c`,
    link: '/portfolio',
    data: { venue: 'polymarket', marketId, outcome, orderId: result.orderId },
  }, { category: 'orders' });
  return c.json({
    ok: true,
    order: result,
    sellOrder: orderEnvelope(sellRow),
    position: updatedHolding ? orderEnvelope(updatedHolding) : null,
  });
});

/**
 * Polymarket on-chain trading approvals (Lane A follow-up, 2026-07-03).
 * GET  /polymarket/trading-status  → per-operator CTF + collateral approvals
 * POST /polymarket/enable-trading  → grant every missing approval in ONE
 *                                    gas-sponsored EIP-7702 batch (idempotent)
 * Operator set comes from the SDK's own contract config, so approvals can
 * never drift from what order signing targets. See lib/markets/pm-approvals.
 */
marketRoutes.get('/polymarket/trading-status', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const owner = (u.privyWalletAddress ?? null) as `0x${string}` | null;
  if (!owner) {
    return c.json({ ok: true, live: false, reason: 'no-wallet', approvals: [], missingCount: 0 });
  }
  const status = await getPmTradingStatus(owner);
  return c.json({ ok: true, owner, ...status });
});

marketRoutes.post('/polymarket/enable-trading', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const owner = (u.privyWalletAddress ?? null) as `0x${string}` | null;
  if (!owner) throw ApiError.badRequest('wallet_required');
  const result = await enablePmTrading(u.id, owner);
  marketsOrders.inc({ venue: 'polymarket', result: result.demo ? 'approvals_demo' : 'approvals_submitted' });
  return c.json({ ok: true, owner, ...result });
});

/**
 * Builder Program per-user DEPOSIT WALLET lane (2026-07-06). `builder-status`
 * derives the relayer wallet and reports on-chain readiness; `builder-setup`
 * deploys the wallet and submits every missing approval through Polymarket's
 * gasless relayer. NO user funds move on either endpoint — deploy and
 * approvals are relayer-paid, and orders only engage the lane after
 * `getBuilderLaneFunder` re-verifies readiness.
 */
marketRoutes.get('/polymarket/builder-status', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const owner = (u.privyWalletAddress ?? null) as `0x${string}` | null;
  if (!owner || !u.privyWalletId) {
    return c.json({ ok: true, laneEnabled: pmBuilderLaneEnabled(), ready: false, reason: 'no-wallet' });
  }
  const status = await getDepositWalletStatus(u.privyWalletId, owner);
  return c.json({
    ok: true,
    laneEnabled: pmBuilderLaneEnabled(),
    owner,
    wallet: status.wallet,
    deployed: status.deployed,
    missingErc20: status.missingErc20.length,
    missingCtf: status.missingCtf.length,
    ready: status.ready,
  });
});

marketRoutes.post('/polymarket/builder-setup', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const owner = (u.privyWalletAddress ?? null) as `0x${string}` | null;
  if (!owner || !u.privyWalletId) throw ApiError.badRequest('wallet_required');
  const result = await ensureBuilderDepositWallet(u.privyWalletId, owner);
  marketsOrders.inc({
    venue: 'polymarket',
    result: result.deployedNow ? 'builder_wallet_deployed' : 'builder_wallet_ready',
  });
  return c.json({
    ok: true,
    owner,
    wallet: result.wallet,
    deployedNow: result.deployedNow,
    approvalsSubmitted: result.approvalsSubmitted,
    ready: result.status.ready,
  });
});

/**
 * POST /polymarket/builder-fund — move pUSD collateral from the user's EOA
 * into their builder-lane DEPOSIT WALLET (full sweep unless `amountUsd` is
 * given). Third step of the Builder Program flow: setup deploys + approves,
 * wrap mints the pUSD, THIS parks it where sigType-3 orders can settle.
 */
marketRoutes.post('/polymarket/builder-fund', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const owner = (u.privyWalletAddress ?? null) as `0x${string}` | null;
  if (!owner || !u.privyWalletId) throw ApiError.badRequest('wallet_required');
  const body = (await c.req.json().catch(() => ({}))) as { amountUsd?: number };
  const amountUsd =
    typeof body.amountUsd === 'number' && body.amountUsd > 0 ? body.amountUsd : undefined;
  const result = await fundBuilderDepositWallet(u.id, u.privyWalletId, owner, amountUsd);
  marketsOrders.inc({ venue: 'polymarket', result: 'builder_wallet_funded' });
  return c.json({
    ok: true,
    owner,
    wallet: result.wallet,
    txHash: result.txHash,
    sponsored: result.sponsored,
    token: result.token,
    fundedUsd: Number(result.atoms) / 1e6,
  });
});

/**
 * pUSD collateral conversion (Lane A follow-up): the CLOB settles in pUSD,
 * a 1:1 wrapper over the USDC.e our funding rail delivers. wrap = fund
 * trading; unwrap = release to USDC.e for withdrawals. Gas-sponsored, one
 * signature, amount defaults to the full source balance.
 */
marketRoutes.post('/polymarket/wrap', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const owner = (u.privyWalletAddress ?? null) as `0x${string}` | null;
  if (!owner) throw ApiError.badRequest('wallet_required');
  const body = (await c.req.json().catch(() => ({}))) as { amountUsd?: number };
  const amountUsd = typeof body.amountUsd === 'number' && body.amountUsd > 0 ? body.amountUsd : undefined;
  const result = await convertPmCollateral(u.id, owner, 'wrap', amountUsd);
  return c.json({ ok: true, owner, ...result });
});

marketRoutes.post('/polymarket/unwrap', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const owner = (u.privyWalletAddress ?? null) as `0x${string}` | null;
  if (!owner) throw ApiError.badRequest('wallet_required');
  const body = (await c.req.json().catch(() => ({}))) as { amountUsd?: number };
  const amountUsd = typeof body.amountUsd === 'number' && body.amountUsd > 0 ? body.amountUsd : undefined;
  const result = await convertPmCollateral(u.id, owner, 'unwrap', amountUsd);
  return c.json({ ok: true, owner, ...result });
});

marketRoutes.get('/polymarket/positions', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  // SELL:* rows are sell ORDERS (Lane A), not holdings — surfacing them here
  // would render phantom positions and double the apparent exposure.
  const positions = (await store.listMarketPositions(u, 'polymarket')).filter(
    (p) => !p.symbol.startsWith('SELL:'),
  );
  return c.json({ ok: true, positions });
});

marketRoutes.get('/polymarket/traders/:wallet/copy-intent', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const wallet = c.req.param('wallet');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw ApiError.badRequest('invalid_wallet');
  const result = await polymarket.getCopyIntent(wallet);
  const sourced = result.source === 'live'
    ? liveMeta('polymarket', 'copy-intent')
    : providerDemoMeta('polymarket', 'copy-intent');
  return c.json({
    ok: true,
    source: result.source === 'live' ? 'polymarket' : 'demo',
    sourced,
    intent: result.intent,
  });
});

marketRoutes.get('/polymarket/:id', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const marketId = c.req.param('id');
  const loaded = await _cachedLoad(`pm-detail:${marketId}`, 30_000, async () => {
    const market = await polymarket.getMarket(marketId);
    if (!market) throw ApiError.notFound('not_found');
    const sourced = polymarket.isLive
      ? liveMeta('polymarket', 'market-detail')
      : providerDemoMeta('polymarket', 'market-detail');
    return { market, sourced };
  }, 60_000);
  return c.json({
    ok: true,
    source: polymarket.isLive ? 'polymarket' : 'demo',
    sourced: loaded.data.sourced,
    market: loaded.data.market,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/**
 * Polymarket CLOB orderbook proxy. Returns top-N bids / asks (cents + shares)
 * plus mid + spread for the requested outcome. 2s cache; book ticks fast but
 * we don't want to hammer the CLOB endpoint from every prediction-detail view.
 */
marketRoutes.get('/polymarket/:id/book', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const marketId = c.req.param('id');
  const outcome = c.req.query('outcome')?.trim() || undefined;
  const key = `pm-book:${marketId}:${outcome ?? 'first'}`;
  const loaded = await _cachedLoad(key, 2_000, async () => {
    const book = await polymarket.getOrderbook(marketId, outcome);
    return book ?? { bids: [], asks: [], midCents: null, spreadCents: null };
  }, 30_000);
  return c.json({
    ok: true,
    book: loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/**
 * Polymarket "top traders" — ranked top holders of each outcome token on a
 * market, from the public data-api /holders endpoint. Sprint 1 of the copy-
 * trading surface: live holder leaderboard, no index. 30s cache — holders move
 * slowly relative to the orderbook.
 */
marketRoutes.get('/polymarket/:id/top-traders', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const id = c.req.param('id');
  const limitQ = Number(c.req.query('limit') ?? 10);
  const limit = Number.isFinite(limitQ) && limitQ > 0 ? Math.min(Math.floor(limitQ), 50) : 10;
  const key = `pm-top-traders:${id}:${limit}`;
  const loaded = await _cachedLoad(key, 30_000, async () => {
    const result = await polymarket.getTopTraders(id, limit);
    const sourced = result.source === 'live'
      ? liveMeta('polymarket', 'top-traders')
      : providerDemoMeta('polymarket', 'top-traders');
    return {
      source: result.source === 'live' ? 'polymarket' : 'demo',
      sourced,
      outcomes: result.outcomes,
    };
  });
  return c.json({
    ok: true,
    ...loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/* ── Hyperliquid SPOT ────────────────────────────────────────────────────── */
/**
 * Spot is a distinct universe (307 active pairs) served by the same /info
 * endpoint with `type: 'spotMetaAndAssetCtxs'`. Trading hits the same
 * /exchange endpoint with asset id `10000 + universe.index` and NO builder
 * fee (perps-only feature). Canonical pair names contain `/` so the detail
 * route accepts `?coin=` via query string instead of a path param.
 */

marketRoutes.get('/hyperliquid-spot', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const limitQ = Number(c.req.query('limit') ?? 500);
  const limit = Number.isFinite(limitQ) && limitQ > 0 && limitQ <= 1000 ? Math.floor(limitQ) : 500;
  const loaded = await _cachedLoad(`hl-spot-list:${limit}`, 10_000, async () => {
    const result = await hyperliquidSpot.getMarketsResult(limit);
    const sourced = result.source === 'live'
      ? liveMeta('hyperliquid', 'market-list')
      : providerDemoMeta('hyperliquid', 'market-list');
    return {
      source: result.source === 'live' ? 'hyperliquid' : 'demo',
      sourced,
      markets: result.markets,
    };
  });
  return c.json({
    ok: true,
    ...loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/hyperliquid-spot/detail', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = (c.req.query('coin') ?? '').trim();
  if (!coin) throw ApiError.badRequest('coin_required');
  const loaded = await _cachedLoad(`hl-spot-detail:${coin}`, 10_000, async () => {
    const market = await hyperliquidSpot.getMarket(coin);
    if (!market) throw ApiError.notFound('not_found');
    const sourced = hyperliquidSpot.isLive
      ? liveMeta('hyperliquid', 'market-detail')
      : providerDemoMeta('hyperliquid', 'market-detail');
    return { market, sourced };
  }, 60_000);
  return c.json({
    ok: true,
    source: hyperliquidSpot.isLive ? 'hyperliquid' : 'demo',
    sourced: loaded.data.sourced,
    market: loaded.data.market,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/hyperliquid-spot/user-state', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const state = await hyperliquidSpot.getUserState(u.privyWalletAddress ?? null);
  return c.json({ ok: true, state });
});

marketRoutes.get('/hyperliquid-spot/positions', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const positions = await store.listMarketPositions(u, 'hyperliquid-spot');
  return c.json({ ok: true, positions });
});

marketRoutes.post('/hyperliquid-spot/order', async (c) => {
  // F093 Sprint 18 — route through the unified MarketAdapter handler when
  // `MARKETS_ROUTER_V2=1`. Legacy v1 path below stays default.
  if (env.MARKETS_ROUTER_V2) {
    return handleAdapterPlaceOrder(c, hyperliquidSpotAdapter);
  }
  marketRouterRequests.inc({ version: 'v1', venue: 'hyperliquid-spot', result: 'entered' });
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    coin?: string;
    sideLong?: boolean;
    qtyUsd?: number;
    orderType?: 'market' | 'limit';
    limitPriceUsd?: number;
    tif?: 'Ioc' | 'Gtc' | 'Alo';
    reduceOnly?: boolean;
  };
  const coin = String(body.coin ?? '').trim();
  const qtyUsd = Number(body.qtyUsd ?? 0);
  if (!coin) throw ApiError.badRequest('invalid_coin');
  if (!(qtyUsd > 0)) throw ApiError.badRequest('invalid_qty');
  const shape = parseHlOrderShape(body);
  // reduceOnly passes through to the adapter (close / take-profit / stop-loss flow).
  const gate = tradeGate(c, u, { venue: 'hyperliquid-spot', qtyUsd, isLiveTrading: hyperliquidSpot.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid-spot', hyperliquidSpot.isLiveTrading, u);
  if (walletGate) return walletGate;

  const idempotencyKey = idempotencyKeyOf(c);
  if (hyperliquidSpot.isLiveTrading && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  const reservation = idempotencyKey
    ? await store.reserveMarketOrder(u, {
        venue: 'hyperliquid-spot',
        symbol: coin,
        sideLong: Boolean(body.sideLong),
        qtyUsd,
        entryPriceUsd: shape.limitPriceUsd ?? 0,
        externalRef: null,
        idempotencyKey,
      })
    : null;
  if (reservation && !reservation.fresh) {
    return replayOrBlockReservedOrder(c, reservation, !hyperliquidSpot.isLiveTrading);
  }
  if (reservation?.fresh) {
    await lifecycle(reservation.position.id, 'reserved');
  }
  await lifecycle(reservation?.position.id ?? null, 'submitted');
  let result: Awaited<ReturnType<typeof hyperliquidSpot.placeOrder>>;
  try {
    result = await hyperliquidSpot.placeOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin,
      sideLong: Boolean(body.sideLong),
      qtyUsd,
      orderType: shape.orderType,
      tif: shape.tif,
      limitPriceUsd: shape.limitPriceUsd,
      reduceOnly: body.reduceOnly === true,
    });
  } catch (e) {
    if (reservation?.fresh) {
      await store.failMarketOrder(reservation.position.id).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), positionId: reservation.position.id },
          'markets: failed to mark hyperliquid-spot reservation failed',
        );
      });
    }
    return venueFailure(c, 'hyperliquid-spot', 'order', e);
  }
  const terminalStatus = mapResultStateToLifecycle(result.state);
  const recordedQtyUsd = terminalStatus === 'filled' ? result.filledQtyUsd : qtyUsd;
  let position: MarketPosition;
  try {
    position = reservation
      ? await completeAcceptedMarketOrder('hyperliquid-spot', reservation.position.id, {
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
        })
      : await store.placeMarketOrder(u, {
          venue: 'hyperliquid-spot',
          symbol: coin,
          sideLong: Boolean(body.sideLong),
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
        });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'failed', {
        errorCode: 'failed_local_recording',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return recordingFailure(c, 'hyperliquid-spot', e);
  }
  const finalized = await lifecycle(position.id, terminalStatus, {
    externalOrderId: result.orderId,
    filledQtyUsd: result.filledQtyUsd > 0 ? result.filledQtyUsd : undefined,
    avgFillPriceUsd: result.filledQtyUsd > 0 ? result.entryPriceUsd : undefined,
    demo: result.demo,
  });
  if (finalized) position = finalized;
  marketsOrders.inc({ venue: 'hyperliquid-spot', result: 'success' });
  const resting = terminalStatus === 'resting';
  void sendExpoPushToUser(u.id, {
    title: `${coin} ${body.sideLong ? 'buy' : 'sell'} ${resting ? 'resting' : 'filled'}`,
    body: `$${(resting ? qtyUsd : result.filledQtyUsd).toFixed(2)} @ $${result.entryPriceUsd.toFixed(2)}`,
    link: '/portfolio',
    data: { venue: 'hyperliquid-spot', coin, orderId: result.orderId },
  }, { category: 'orders' });
  return c.json({ ok: true, order: result, position });
});

marketRoutes.post('/hyperliquid-spot/cancel', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { externalRef?: string; coin?: string };
  const externalRef = String(body.externalRef ?? '').trim();
  const coin = String(body.coin ?? '').trim();
  if (!externalRef) throw ApiError.badRequest('invalid_ref');
  const gate = tradeGate(c, u, { venue: 'hyperliquid-spot', isLiveTrading: hyperliquidSpot.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid-spot', hyperliquidSpot.isLiveTrading, u);
  if (walletGate) return walletGate;
  const existingPosition = (await store.listMarketPositions(u, 'hyperliquid-spot')).find(
    (p) => p.externalRef === externalRef,
  );
  if (!existingPosition) throw ApiError.notFound('not_found');
  const cancelBlocked = assertCancellableOrder(c, existingPosition);
  if (cancelBlocked) return cancelBlocked;
  await lifecycle(existingPosition.id, 'cancel_requested');
  try {
    await hyperliquidSpot.cancelOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin: coin || existingPosition.symbol,
      externalRef,
    });
  } catch (e) {
    await lifecycle(existingPosition.id, 'failed', {
      errorCode: 'cancel_rejected',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return venueFailure(c, 'hyperliquid-spot', 'cancel', e);
  }
  let position = await store.cancelMarketOrder(u, externalRef);
  if (!position) throw ApiError.notFound('not_found');
  const finalized = await lifecycle(position.id, 'canceled');
  if (finalized) position = finalized;
  return c.json({ ok: true, position });
});

/**
 * Spot allMids proxy. Reuses the perp adapter's `getAllMids` — `allMids`
 * returns ALL HL markets (perps + spot) in one payload, so spot screens
 * can read it the same way the perps screen does. 1s cache.
 */
marketRoutes.get('/hyperliquid-spot/all-mids', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const cached = _cacheGet('all-mids', 1_000);
  if (cached) return c.json({ ok: true, mids: cached, cached: true });
  const mids = await hyperliquid.getAllMids();
  _cacheSet('all-mids', mids);
  return c.json({ ok: true, mids, cached: false });
});

/* ── Jupiter + Pump.fun (memes, Solana) ──────────────────────────────────── */
/**
 * Memes are served by a HYBRID stack:
 *   - Pump.fun frontend-api-v3 for discovery (rich metadata for fresh +
 *     migrated pump.fun-natives).
 *   - Jupiter Token API v2 for price/mcap enrichment + broader Solana memes
 *     (BONK, WIF, etc.).
 *   - Jupiter Swap v1 for execution. Jupiter routes through PumpSwap so
 *     bonding-curve and migrated tokens trade through one signing path.
 *   - Privy server-side Solana wallet for non-custodial signing — same
 *     surface Marinade + Mayan already use.
 */

marketRoutes.get('/jupiter', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const source = (c.req.query('source') ?? 'both').toLowerCase();
  const tag = c.req.query('tag')?.trim() || 'verified';
  const sort = (c.req.query('sort') ?? 'market_cap').toLowerCase();
  const migratedOnly = (c.req.query('migrated') ?? '').toLowerCase() === 'true';
  const limitQ = Number(c.req.query('limit') ?? 100);
  const offsetQ = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitQ) && limitQ > 0 && limitQ <= 500 ? Math.floor(limitQ) : 100;
  const offset = Number.isFinite(offsetQ) && offsetQ >= 0 ? Math.floor(offsetQ) : 0;
  const wantPump = source === 'pump' || source === 'both';
  const wantJup = source === 'jupiter' || source === 'both';

  const upstream = await _cachedLoad(
    `jupiter-list:${source}:${tag}:${sort}:${migratedOnly ? 'migrated' : 'all'}:${limit}:${offset}`,
    15_000,
    () => Promise.all([
      wantPump
        ? pumpfun.list({
            sort: sort === 'created' ? 'created_timestamp'
              : sort === 'recent' ? 'last_trade_timestamp'
              : sort === 'replies' ? 'reply_count'
              : sort === 'koth' ? 'king_of_the_hill_timestamp'
              : 'usd_market_cap',
            limit: Math.min(200, limit + offset),
            offset: 0,
            migratedOnly,
            includeNsfw: false,
          })
        : Promise.resolve(null),
      wantJup
        ? jupiter.list({ tag, limit: Math.min(500, limit + offset), offset: 0 })
        : Promise.resolve(null),
    ]),
  );
  const [pumpResult, jupResult] = upstream.data;

  type Row = {
    mint: string;
    symbol: string;
    name: string;
    imageUrl: string | null;
    priceUsd: number | null;
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    holderCount: number | null;
    decimals: number | null;
    volume24hUsd: number | null;
    priceChange24h: number | null;
    isVerified: boolean;
    tags: string[];
    organicScoreLabel: string | null;
    /** Where the metadata came from (or 'merged' if both sources agreed). */
    origin: 'pumpfun' | 'jupiter' | 'merged';
    migrated: boolean | null;
    bondingCurveProgress: number | null;
    pumpReplyCount: number | null;
    pumpKothAt: number | null;
    pumpCreatedAt: number | null;
    pumpLastTradeAt: number | null;
  };

  const byMint = new Map<string, Row>();

  if (jupResult) {
    for (const t of jupResult.tokens) {
      byMint.set(t.mint, {
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        imageUrl: t.icon,
        priceUsd: t.priceUsd,
        marketCapUsd: t.marketCapUsd,
        liquidityUsd: t.liquidityUsd,
        holderCount: t.holderCount,
        decimals: t.decimals,
        volume24hUsd: t.stats.volume24hUsd ?? null,
        priceChange24h: t.stats.priceChange24h ?? null,
        isVerified: t.isVerified,
        tags: t.tags,
        organicScoreLabel: t.organicScoreLabel,
        origin: 'jupiter',
        migrated: null,
        bondingCurveProgress: null,
        pumpReplyCount: null,
        pumpKothAt: null,
        pumpCreatedAt: null,
        pumpLastTradeAt: null,
      });
    }
  }

  if (pumpResult) {
    for (const m of pumpResult.memes) {
      const existing = byMint.get(m.mint);
      // Bonding-curve progress — pump.fun raises ~85 SOL to migrate, so
      // realSolReserves / 85 is a rough %.
      const progress = m.realSolReserves != null
        ? Math.max(0, Math.min(100, Math.round((m.realSolReserves / 85e9) * 100)))
        : null;
      if (existing) {
        existing.origin = 'merged';
        existing.migrated = m.migrated;
        existing.bondingCurveProgress = progress;
        existing.pumpReplyCount = m.replyCount;
        existing.pumpKothAt = m.kingOfTheHillAt;
        existing.pumpCreatedAt = m.createdAt;
        existing.pumpLastTradeAt = m.lastTradeAt;
        // Fall back to pump's USD mcap when Jupiter has no figure (fresh tokens).
        if (existing.marketCapUsd == null) existing.marketCapUsd = m.marketCapUsd ?? null;
        if (!existing.imageUrl) existing.imageUrl = m.imageUrl ?? null;
      } else {
        byMint.set(m.mint, {
          mint: m.mint,
          symbol: m.symbol,
          name: m.name,
          imageUrl: m.imageUrl ?? null,
          priceUsd: null,
          marketCapUsd: m.marketCapUsd ?? null,
          liquidityUsd: null,
          holderCount: null,
          decimals: 6,
          volume24hUsd: null,
          priceChange24h: null,
          isVerified: false,
          tags: ['pumpfun'],
          organicScoreLabel: null,
          origin: 'pumpfun',
          migrated: m.migrated,
          bondingCurveProgress: progress,
          pumpReplyCount: m.replyCount,
          pumpKothAt: m.kingOfTheHillAt,
          pumpCreatedAt: m.createdAt,
          pumpLastTradeAt: m.lastTradeAt,
        });
      }
    }
  }

  const all = Array.from(byMint.values()).sort((a, b) => {
    if (sort === 'recent') {
      return (b.pumpLastTradeAt ?? b.pumpCreatedAt ?? 0) - (a.pumpLastTradeAt ?? a.pumpCreatedAt ?? 0);
    }
    if (sort === 'created') {
      return (b.pumpCreatedAt ?? 0) - (a.pumpCreatedAt ?? 0);
    }
    if (sort === 'koth') {
      return (b.pumpKothAt ?? 0) - (a.pumpKothAt ?? 0);
    }
    if (sort === 'volume') {
      return (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0);
    }
    return (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0);
  });
  const sliced = all.slice(offset, offset + limit);

  const sourcedTag = (pumpResult?.source === 'live' || jupResult?.source === 'live') ? 'live' : 'demo';
  return c.json({
    ok: true,
    source: sourcedTag === 'live' ? 'jupiter' : 'demo',
    sourced: sourcedTag === 'live'
      ? liveMeta('jupiter' as never, 'market-list' as never)
      : providerDemoMeta('jupiter' as never, 'market-list' as never),
    pumpSource: pumpResult?.source ?? null,
    jupiterSource: jupResult?.source ?? null,
    tokens: sliced,
    total: all.length,
    cached: upstream.cached,
    ...(upstream.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/jupiter/detail', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const mint = cleanSolanaMint(c.req.query('mint') ?? '');
  const loaded = await _cachedLoad(`jup-detail:${mint}`, 15_000, async () => {
    const [jupToken, pumpCoin] = await Promise.all([
      jupiter.getToken(mint),
      pumpfun.getCoin(mint).catch(() => null),
    ]);
    if (!jupToken && !pumpCoin) throw ApiError.notFound('not_found');
    return { jupiter: jupToken, pump: pumpCoin };
  }, 60_000);
  return c.json({
    ok: true,
    source: jupiter.isLive ? 'jupiter' : 'demo',
    jupiter: loaded.data.jupiter,
    pump: loaded.data.pump,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/jupiter/prices', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const ids = (c.req.query('ids') ?? '').trim();
  if (!ids) return c.json({ ok: true, prices: {} });
  const seen = new Set<string>();
  const mints: string[] = [];
  for (const raw of ids.split(',')) {
    if (mints.length >= 100) break;
    const candidate = raw.trim();
    if (!candidate) continue;
    let mint: string;
    try {
      mint = cleanSolanaMint(candidate);
    } catch {
      continue;
    }
    if (seen.has(mint)) continue;
    seen.add(mint);
    mints.push(mint);
  }
  if (!mints.length) return c.json({ ok: true, prices: {} });
  const key = `jup-prices:${[...mints].sort().join(',')}`;
  const loaded = await _cachedLoad(key, 5_000, () => jupiter.prices(mints), 60_000);
  return c.json({
    ok: true,
    prices: loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/**
 * Meme/xStock OHLCV — GeckoTerminal top-pool candles (NEO register P2 #15).
 * HL-candle wire shape so clients reuse the existing chart path. `pool: null`
 * means no real market (sub-$100-liquidity pools are treated as none).
 */
marketRoutes.get('/jupiter/candles', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const mint = cleanSolanaMint((c.req.query('mint') ?? '').trim());
  const interval = cleanGtInterval(c.req.query('interval'));
  const loaded = await _cachedLoad(
    `gt-candles:${mint}:${interval}`,
    60_000,
    () => getTokenCandles(mint, interval),
    10 * 60_000,
  );
  return c.json({
    ok: true,
    pool: loaded.data.pool,
    candles: loaded.data.candles,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.post('/jupiter/quote', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    inputMint?: string;
    outputMint?: string;
    amountAtomic?: string;
    slippageBps?: number;
  };
  const inputMint = cleanSolanaMint(String(body.inputMint ?? JUPITER_SOL_MINT), 'input_mint');
  const outputMint = cleanSolanaMint(String(body.outputMint ?? ''), 'output_mint');
  const amountAtomic = String(body.amountAtomic ?? '').trim();
  if (!/^\d+$/.test(amountAtomic) || amountAtomic === '0') throw ApiError.badRequest('invalid_amount');
  const gate = tradeGate(c, u, { venue: 'jupiter', isLiveTrading: jupiter.isLiveTrading });
  if (gate) return gate;
  let quote: Awaited<ReturnType<typeof jupiter.quote>>;
  try {
    quote = await jupiter.quote({ inputMint, outputMint, amountAtomic, slippageBps: body.slippageBps });
  } catch (e) {
    if (e instanceof ProviderRateLimitError) {
      if (e.retryAfter) c.header('Retry-After', e.retryAfter);
      return marketError(c, 429, 'too_many_requests');
    }
    throw e;
  }
  if (!quote) return marketError(c, 422, 'quote_unavailable');
  return c.json(quote);
});

marketRoutes.post('/jupiter/swap', async (c) => {
  // F093 Sprint 18 — route through the unified MarketAdapter handler when
  // `MARKETS_ROUTER_V2=1`. Legacy v1 path below stays default.
  if (env.MARKETS_ROUTER_V2) {
    return handleAdapterPlaceOrder(c, jupiterAdapter);
  }
  marketRouterRequests.inc({ version: 'v1', venue: 'jupiter', result: 'entered' });
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    inputMint?: string;
    outputMint?: string;
    amountAtomic?: string;
    slippageBps?: number;
    quote?: unknown;
  };
  const inputMint = cleanSolanaMint(String(body.inputMint ?? JUPITER_SOL_MINT), 'input_mint');
  const outputMint = cleanSolanaMint(String(body.outputMint ?? ''), 'output_mint');
  const amountAtomic = String(body.amountAtomic ?? '').trim();
  if (!/^\d+$/.test(amountAtomic) || amountAtomic === '0') throw ApiError.badRequest('invalid_amount');
  const gate = tradeGate(c, u, { venue: 'jupiter', isLiveTrading: jupiter.isLiveTrading });
  if (gate) return gate;

  // Idempotency: required for live trading.
  const idempotencyKey = idempotencyKeyOf(c);
  if (jupiter.isLiveTrading && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }

  // Provision Solana wallet lazily.
  let solanaWalletId: string | null = null;
  let solanaWalletAddress: string | null = null;
  if (jupiter.isLiveTrading) {
    try {
      const wallet = await walletService.getOrCreateUserSolanaWallet(u.id, u.privyDid ?? null);
      if (wallet.live && wallet.address && wallet.walletId) {
        solanaWalletId = wallet.walletId;
        solanaWalletAddress = wallet.address;
        await store.setPrivySolWallet(u.id, wallet.walletId, wallet.address).catch((err) => {
          log.warn(
            { err: err instanceof Error ? err.message : String(err), userId: u.id },
            'jupiter: failed to persist solana wallet',
          );
        });
      }
    } catch (e) {
      log.error(
        { err: e instanceof Error ? e.message : String(e), userId: u.id },
        'jupiter: solana wallet provision failed',
      );
    }
    if (!solanaWalletId || !solanaWalletAddress) {
      marketsOrders.inc({ venue: 'jupiter', result: 'wallet_unavailable' });
      return marketError(c, 503, 'solana_wallet_unavailable');
    }
  }

  let fresh: Awaited<ReturnType<typeof jupiter.quote>>;
  try {
    fresh = await jupiter.quote({ inputMint, outputMint, amountAtomic, slippageBps: body.slippageBps });
  } catch (e) {
    if (e instanceof ProviderRateLimitError) {
      if (e.retryAfter) c.header('Retry-After', e.retryAfter);
      return marketError(c, 429, 'too_many_requests');
    }
    throw e;
  }
  const quoteForSwap = fresh?.quote ?? (!jupiter.isLiveTrading ? body.quote ?? null : null);
  if (!quoteForSwap) return marketError(c, 422, 'quote_unavailable');
  const inAmount = (fresh?.inAmount) ?? amountAtomic;
  const outAmount = (fresh?.outAmount) ?? '0';
  const swapVenue = jupiterSwapVenue(inputMint, outputMint);

  // Reserve before the venue call so retries with the same idempotency key
  // replay instead of double-spending.
  const symbol = `${inputMint.slice(0, 4)}…→${outputMint.slice(0, 4)}…`;
  const reservation = idempotencyKey
    ? await store.reserveMarketOrder(u, {
        venue: swapVenue,
        symbol,
        sideLong: true, // buying the output mint
        qtyUsd: 0,      // populated post-fill once we know the USD value
        entryPriceUsd: 0,
        externalRef: null,
        idempotencyKey,
      })
    : null;
  if (reservation && !reservation.fresh) {
    return replayOrBlockReservedOrder(c, reservation, !jupiter.isLiveTrading);
  }
  // Sprint 2 lifecycle: Jupiter swap = quote → submit → fill. The quote was
  // already fetched above; we record `reserved` (post-quote) then `submitted`
  // (about to sign+broadcast).
  if (reservation?.fresh) {
    await lifecycle(reservation.position.id, 'reserved', {
      providerPayload: { inputMint, outputMint, inAmount, outAmount },
    });
  }
  await lifecycle(reservation?.position.id ?? null, 'submitted');

  let result: Awaited<ReturnType<typeof jupiter.swap>>;
  try {
    result = await jupiter.swap({
      privyWalletId: solanaWalletId,
      userPublicKey: solanaWalletAddress,
      quote: quoteForSwap,
      inputMint,
      outputMint,
      inAmount,
      outAmount,
    });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'failed', {
        errorCode: 'jupiter_swap_failed',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      await store.failMarketOrder(reservation.position.id).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), positionId: reservation.position.id },
          'markets: failed to mark jupiter reservation failed',
        );
      });
    }
    return venueFailure(c, 'jupiter', 'order', e);
  }

  let position: MarketPosition;
  try {
    position = reservation
      ? await completeAcceptedMarketOrder(swapVenue, reservation.position.id, {
          qtyUsd: 0,
          entryPriceUsd: 0,
          externalRef: result.signature,
        })
      : await store.placeMarketOrder(u, {
          venue: swapVenue,
          symbol,
          sideLong: true,
          qtyUsd: 0,
          entryPriceUsd: 0,
          externalRef: result.signature,
        });
  } catch (e) {
    if (reservation?.fresh) {
      await lifecycle(reservation.position.id, 'failed', {
        errorCode: 'failed_local_recording',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return recordingFailure(c, swapVenue, e);
  }
  // Jupiter swaps are atomic only after validator confirmation. A live
  // broadcast that times out confirmation keeps the signature but remains
  // submitted so retries cannot double-spend with the same idempotency key.
  const finalStatus: MarketOrderStatus = result.demo || result.confirmed ? 'filled' : 'submitted';
  const finalized = await lifecycle(position.id, finalStatus, {
    externalOrderId: result.signature,
    demo: !jupiter.isLiveTrading,
  });
  if (finalized) position = finalized;
  marketsOrders.inc({ venue: swapVenue, result: 'success' });
  {
    // Jupiter platform fee is taken by Jupiter in the OUTPUT token and
    // routed to JUPITER_PLATFORM_FEE_ACCOUNT. We can't price the output USD
    // perfectly from the route layer, so we approximate notional as the
    // input USD when the input is a stablecoin; otherwise we leave notional
    // at 0 and the fee tracker still records the attempt (counter).
    const rate = configuredRateBps(swapVenue);
    if (rate.bps > 0) {
      const notional = Number(inAmount) > 0 && inputMint === SOLANA_USDC_MINT
        ? Number(inAmount) / 1_000_000
        : 0;
      recordFee({
        userId: u.id,
        venue: swapVenue,
        kind: rate.kind,
        notionalUsd: notional,
        rateBps: rate.bps,
        symbol: outputMint,
        attempted: !result.demo,
      });
    }
  }
  void sendExpoPushToUser(u.id, {
    title: `Swap submitted`,
    body: `${result.demo ? 'Demo' : 'Live'} swap: ${inAmount} → ${outAmount}`,
    link: '/portfolio',
    data: { venue: swapVenue, inputMint, outputMint, signature: result.signature },
  }, { category: 'orders' });
  return c.json({ ok: true, order: result, position });
});

marketRoutes.get('/jupiter/positions', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const positions = await store.listMarketPositions(u, 'jupiter');
  return c.json({ ok: true, positions });
});

/* ── Stocks: trade.xyz (HIP-3 perps) + Backed Finance xStocks (Solana spot) ─ */
/**
 * Two-rail stocks venue:
 *   - PERPS via Hyperliquid HIP-3 / trade.xyz (`xyz` DEX): 93 tokenized
 *     equity + commodity + FX + index perps, leverage up to 30x, 24/7,
 *     same /exchange endpoint as canonical HL with a `100_000 + idx` asset
 *     offset. S&P 500 perp officially licensed from S&P Dow Jones (Mar 2026).
 *   - SPOT via Backed Finance xStocks: 131 Solana SPL Token-2022 mints
 *     (AAPLx, TSLAx, NVDAx, SPYx, …) traded through Jupiter Swap. Reuses
 *     the existing `/markets/jupiter/{quote,swap}` flow — no new signing
 *     path needed.
 */

marketRoutes.get('/stocks', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const limitQ = Number(c.req.query('limit') ?? 200);
  const limit = Number.isFinite(limitQ) && limitQ > 0 && limitQ <= 500 ? Math.floor(limitQ) : 200;
  const loaded = await _cachedLoad(
    `stocks-list:${limit}`,
    15_000,
    () => Promise.all([
      hyperliquidHip3.getMarketsResult(limit),
      xstocks.list({ limit }),
    ]),
  );
  const [perpResult, spotResult] = loaded.data;
  return c.json({
    ok: true,
    perpSource: perpResult.source,
    spotSource: spotResult.source,
    perps: perpResult.markets,
    spot: spotResult.stocks,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/stocks/perps', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const limitQ = Number(c.req.query('limit') ?? 500);
  const limit = Number.isFinite(limitQ) && limitQ > 0 && limitQ <= 500 ? Math.floor(limitQ) : 500;
  const loaded = await _cachedLoad(`stocks-perps:${limit}`, 10_000, () => hyperliquidHip3.getMarketsResult(limit));
  const result = loaded.data;
  return c.json({
    ok: true,
    source: result.source === 'live' ? 'hyperliquid-hip3' : 'demo',
    sourced: result.source === 'live'
      ? liveMeta('hyperliquid' as never, 'market-list' as never)
      : providerDemoMeta('hyperliquid' as never, 'market-list' as never),
    dex: HIP3_DEX_NAME,
    markets: result.markets,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

marketRoutes.get('/stocks/spot', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const categoryRaw = (c.req.query('category') ?? '').trim().toLowerCase();
  const allowedCategories = new Set(['stock', 'etf', 'commodity', 'crypto-adjacent']);
  const category = allowedCategories.has(categoryRaw)
    ? (categoryRaw as 'stock' | 'etf' | 'commodity' | 'crypto-adjacent')
    : undefined;
  const limitQ = Number(c.req.query('limit') ?? 200);
  const limit = Number.isFinite(limitQ) && limitQ > 0 && limitQ <= 500 ? Math.floor(limitQ) : 200;
  const loaded = await _cachedLoad(
    `stocks-spot:${category ?? 'all'}:${limit}`,
    30_000,
    () => xstocks.list({ category, limit }),
  );
  const result = loaded.data;
  return c.json({
    ok: true,
    source: result.source === 'live' ? 'xstocks' : 'demo',
    sourced: result.source === 'live'
      ? liveMeta('jupiter' as never, 'market-list' as never)
      : providerDemoMeta('jupiter' as never, 'market-list' as never),
    stocks: result.stocks,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/**
 * Single-market detail. `coin=xyz:AAPL` resolves an HIP-3 perp; `mint=Xs...`
 * resolves an xStock SPL token. Either parameter is required.
 */
marketRoutes.get('/stocks/detail', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = (c.req.query('coin') ?? '').trim();
  const mint = (c.req.query('mint') ?? '').trim();
  if (!coin && !mint) throw ApiError.badRequest('coin_or_mint_required');
  if (coin) {
    const loaded = await _cachedLoad(`stocks-detail-perp:${coin}`, 15_000, async () => {
      const market = await hyperliquidHip3.getMarket(coin);
      if (!market) throw ApiError.notFound('not_found');
      return market;
    }, 60_000);
    return c.json({
      ok: true,
      kind: 'perp',
      market: loaded.data,
      cached: loaded.cached,
      ...(loaded.stale ? { stale: true } : {}),
    });
  }
  const loaded = await _cachedLoad(`stocks-detail-spot:${mint}`, 30_000, async () => {
    const stock = await xstocks.getStock(mint);
    if (!stock) throw ApiError.notFound('not_found');
    return stock;
  }, 60_000);
  return c.json({
    ok: true,
    kind: 'spot',
    stock: loaded.data,
    cached: loaded.cached,
    ...(loaded.stale ? { stale: true } : {}),
  });
});

/**
 * Candle snapshot proxy for HIP-3 stocks. Same shape as `/hyperliquid/candles`
 * but routed to the `xyz` dex. 10s cache.
 */
marketRoutes.get('/stocks/candles', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const coin = (c.req.query('coin') ?? '').trim();
  if (!coin) throw ApiError.badRequest('coin_required');
  const interval = cleanHlPublicInterval(c.req.query('interval'));
  const lookbackMs = cleanHlLookback(c.req.query('lookback'));
  const endMs = cleanHlCandleEnd(c.req.query('end'), interval);
  const key = `hip3-candles:${coin}:${interval}:${lookbackMs}:${endMs ?? 'live'}`;
  // Older pages are immutable history — cache them far longer than the live tip.
  const cached = _cacheGet(key, endMs ? 5 * 60_000 : 10_000);
  if (cached) return c.json({ ok: true, candles: cached, cached: true });
  const candles = await hyperliquidHip3.getCandles(coin, interval, lookbackMs, endMs);
  _cacheSet(key, candles);
  return c.json({ ok: true, candles, cached: false });
});

/**
 * allMids proxy for the xyz DEX. 1s cache. Returns `{ "xyz:AAPL": "295.79", ... }`
 * for every HIP-3 market.
 */
marketRoutes.get('/stocks/all-mids', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const cached = _cacheGet('hip3-all-mids', 1_000);
  if (cached) return c.json({ ok: true, mids: cached, cached: true });
  const mids = await hyperliquidHip3.getAllMids();
  _cacheSet('hip3-all-mids', mids);
  return c.json({ ok: true, mids, cached: false });
});

/**
 * Place an HIP-3 perp order. Same shape as `/markets/hyperliquid/order` —
 * relies on the user having a builder-fee approval already (the canonical
 * `/markets/hyperliquid/builder-status` endpoint covers this since trade.xyz
 * shares the HL builder model).
 */
marketRoutes.post('/stocks/order', async (c) => {
  // F093 Sprint 18 — route through the unified MarketAdapter handler when
  // `MARKETS_ROUTER_V2=1`. Legacy v1 path below stays default.
  if (env.MARKETS_ROUTER_V2) {
    return handleAdapterPlaceOrder(c, hyperliquidHip3Adapter);
  }
  marketRouterRequests.inc({ version: 'v1', venue: 'hyperliquid-hip3', result: 'entered' });
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    coin?: string;
    sideLong?: boolean;
    qtyUsd?: number;
    leverage?: number;
    orderType?: 'market' | 'limit';
    limitPriceUsd?: number;
    tif?: 'Ioc' | 'Gtc' | 'Alo';
    reduceOnly?: boolean;
  };
  const rawCoin = String(body.coin ?? '').trim();
  const coin = rawCoin.includes(':') ? rawCoin : `${HIP3_DEX_NAME}:${rawCoin.toUpperCase()}`;
  const qtyUsd = Number(body.qtyUsd ?? 0);
  if (!rawCoin) throw ApiError.badRequest('invalid_coin');
  if (!(qtyUsd > 0)) throw ApiError.badRequest('invalid_qty');
  const shape = parseHlOrderShape(body);
  // reduceOnly passes through to the adapter (close / take-profit / stop-loss flow).
  const gate = tradeGate(c, u, { venue: 'hyperliquid-hip3', qtyUsd, isLiveTrading: hyperliquidHip3.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid-hip3', hyperliquidHip3.isLiveTrading, u);
  if (walletGate) return walletGate;

  const idempotencyKey = idempotencyKeyOf(c);
  if (hyperliquidHip3.isLiveTrading && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  const reservation = idempotencyKey
    ? await store.reserveMarketOrder(u, {
        venue: 'hyperliquid-hip3',
        symbol: coin,
        sideLong: Boolean(body.sideLong),
        qtyUsd,
        entryPriceUsd: shape.limitPriceUsd ?? 0,
        externalRef: null,
        idempotencyKey,
      })
    : null;
  if (reservation && !reservation.fresh) {
    return replayOrBlockReservedOrder(c, reservation, !hyperliquidHip3.isLiveTrading);
  }
  let result: Awaited<ReturnType<typeof hyperliquidHip3.placeOrder>>;
  try {
    result = await hyperliquidHip3.placeOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin,
      sideLong: Boolean(body.sideLong),
      qtyUsd,
      leverage: Number(body.leverage ?? 1),
      orderType: shape.orderType,
      tif: shape.tif,
      limitPriceUsd: shape.limitPriceUsd,
      reduceOnly: body.reduceOnly === true,
    });
  } catch (e) {
    if (reservation?.fresh) {
      await store.failMarketOrder(reservation.position.id).catch(() => undefined);
    }
    return venueFailure(c, 'hyperliquid-hip3', 'order', e);
  }
  const terminalStatus = mapResultStateToLifecycle(result.state);
  const recordedQtyUsd = terminalStatus === 'filled' ? result.filledQtyUsd : qtyUsd;
  let position: MarketPosition;
  try {
    position = reservation
      ? await completeAcceptedMarketOrder('hyperliquid-hip3', reservation.position.id, {
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
        })
      : await store.placeMarketOrder(u, {
          venue: 'hyperliquid-hip3',
          symbol: coin,
          sideLong: Boolean(body.sideLong),
          qtyUsd: recordedQtyUsd,
          entryPriceUsd: result.entryPriceUsd,
          externalRef: result.orderId,
        });
  } catch (e) {
    return recordingFailure(c, 'hyperliquid-hip3', e);
  }
  const finalized = await lifecycle(position.id, terminalStatus, {
    externalOrderId: result.orderId,
    filledQtyUsd: result.filledQtyUsd > 0 ? result.filledQtyUsd : undefined,
    avgFillPriceUsd: result.filledQtyUsd > 0 ? result.entryPriceUsd : undefined,
    demo: result.demo,
  });
  if (finalized) position = finalized;
  marketsOrders.inc({ venue: 'hyperliquid-hip3', result: 'success' });
  {
    const rate = configuredRateBps('hyperliquid-hip3');
    if (rate.bps > 0) {
      recordFee({
        userId: u.id,
        venue: 'hyperliquid-hip3',
        kind: rate.kind,
        notionalUsd: result.filledQtyUsd,
        rateBps: rate.bps,
        symbol: coin,
        attempted: !result.demo,
      });
    }
  }
  const resting = terminalStatus === 'resting';
  void sendExpoPushToUser(u.id, {
    title: `${coin} ${body.sideLong ? 'long' : 'short'} ${resting ? 'resting' : 'filled'}`,
    body: `$${(resting ? qtyUsd : result.filledQtyUsd).toFixed(2)} @ $${result.entryPriceUsd.toFixed(2)}`,
    link: '/portfolio',
    data: { venue: 'hyperliquid-hip3', coin, orderId: result.orderId },
  }, { category: 'orders' });
  return c.json({ ok: true, order: result, position });
});

marketRoutes.post('/stocks/cancel', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { externalRef?: string; coin?: string };
  const externalRef = String(body.externalRef ?? '').trim();
  const coin = String(body.coin ?? '').trim();
  if (!externalRef) throw ApiError.badRequest('invalid_ref');
  const gate = tradeGate(c, u, { venue: 'hyperliquid-hip3', isLiveTrading: hyperliquidHip3.isLiveTrading });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, 'hyperliquid-hip3', hyperliquidHip3.isLiveTrading, u);
  if (walletGate) return walletGate;
  const existingPosition = (await store.listMarketPositions(u, 'hyperliquid-hip3')).find(
    (p) => p.externalRef === externalRef,
  );
  if (!existingPosition) throw ApiError.notFound('not_found');
  const cancelBlocked = assertCancellableOrder(c, existingPosition);
  if (cancelBlocked) return cancelBlocked;
  await lifecycle(existingPosition.id, 'cancel_requested');
  try {
    await hyperliquidHip3.cancelOrder({
      privyWalletId: u.privyWalletId ?? null,
      privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
      coin: coin || existingPosition.symbol,
      externalRef,
    });
  } catch (e) {
    await lifecycle(existingPosition.id, 'failed', {
      errorCode: 'cancel_rejected',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return venueFailure(c, 'hyperliquid-hip3', 'cancel', e);
  }
  let position = await store.cancelMarketOrder(u, externalRef);
  if (!position) throw ApiError.notFound('not_found');
  const finalized = await lifecycle(position.id, 'canceled');
  if (finalized) position = finalized;
  return c.json({ ok: true, position });
});

marketRoutes.get('/stocks/positions', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const includeLive = c.req.query('includeLive') === '1';
  const [hip3, xs, livePerps] = await Promise.all([
    store.listMarketPositions(u, 'hyperliquid-hip3'),
    store.listMarketPositions(u, 'xstocks'),
    includeLive ? hyperliquidHip3.getPositions(u.privyWalletAddress ?? null) : Promise.resolve([]),
  ]);
  return c.json({ ok: true, perps: hip3, spot: xs, livePerps });
});

// ────────────────────────────────────────────────────────────────────────────
// Sprint 2 — shared cross-venue order / position / fill surface. NEO terminal
// + MAZE compact activity both read from these endpoints so the wire shape is
// venue-agnostic. Per-venue write routes (above) stay where they are; this
// section is READ-only plus one cross-venue cancel dispatcher.
// ────────────────────────────────────────────────────────────────────────────

/** Map a MarketPosition row → the lifecycle-aware order envelope returned to clients. */
function orderEnvelope(p: MarketPosition): Record<string, unknown> {
  return {
    id: p.id,
    venue: p.venue,
    symbol: p.symbol,
    sideLong: p.sideLong,
    status: p.status,
    qtyUsd: p.qtyUsd,
    entryPriceUsd: p.entryPriceUsd,
    filledQtyUsd: p.filledQtyUsd ?? null,
    avgFillPriceUsd: p.avgFillPriceUsd ?? null,
    externalRef: p.externalRef ?? null,
    externalOrderId: p.externalRef ?? null,
    // Copy-trading attribution — NEO's predictions list renders this; the
    // summary aggregate must not silently drop it vs the per-venue routes.
    copiedFrom: p.copiedFrom ?? null,
    errorCode: p.errorCode ?? null,
    errorMessage: p.errorMessage ?? null,
    submittedAt: p.submittedAt ?? null,
    acceptedAt: p.acceptedAt ?? null,
    filledAt: p.filledAt ?? null,
    canceledAt: p.canceledAt ?? null,
    failedAt: p.failedAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? p.createdAt,
  };
}

const ORDER_VENUES: ReadonlySet<string> = new Set<MarketVenue>([
  'hyperliquid',
  'hyperliquid-spot',
  'hyperliquid-hip3',
  'jupiter',
  'polymarket',
  'xstocks',
]);

function parseStatusList(raw: string | undefined): MarketOrderStatus[] | undefined {
  if (!raw) return undefined;
  const allowed: ReadonlySet<MarketOrderStatus> = new Set([
    'created', 'reserved', 'submitted', 'accepted', 'partially_filled', 'filled',
    'resting', 'cancel_requested', 'canceled', 'expired', 'rejected', 'failed',
    'reconciled', 'pending', 'open', 'closed',
  ] as MarketOrderStatus[]);
  return raw.split(',').map((s) => s.trim()).filter((s): s is MarketOrderStatus => allowed.has(s as MarketOrderStatus));
}

/** GET /markets/orders — cross-venue order history with filters. */
marketRoutes.get('/orders', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const q = c.req.query();
  const venue = q.venue && ORDER_VENUES.has(q.venue) ? (q.venue as MarketVenue) : undefined;
  const symbol = q.symbol?.trim() || undefined;
  const statuses = parseStatusList(q.status);
  const fromMs = optionalQueryInt(q.from, 0, Number.MAX_SAFE_INTEGER);
  const toMs = optionalQueryInt(q.to, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedQueryInt(q.limit, 100, 1, 500);
  const rows = await store.listMarketOrders(u, { venue, symbol, statuses, fromMs, toMs, limit });
  return c.json({ ok: true, orders: rows.map(orderEnvelope) });
});

/** GET /markets/orders/:id — single order with the full lifecycle audit trail. */
marketRoutes.get('/orders/:id', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const id = c.req.param('id');
  const row = await store.getMarketPositionById(id);
  if (!row || row.userId !== u.id) throw ApiError.notFound('not_found');
  return c.json({
    ok: true,
    order: {
      ...orderEnvelope(row),
      lifecycleEvents: row.lifecycleEvents ?? [],
    },
  });
});

/** GET /markets/positions — cross-venue holdings rollup (current state, not history). */
marketRoutes.get('/positions', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  // SELL:* rows are sell ORDERS (Lane A), not holdings — the web terminal
  // renders this list as "open positions", so a filled sell must not appear
  // as a phantom position equal to the amount sold.
  const rows = (await store.listMarketPositions(u)).filter((p) => !p.symbol.startsWith('SELL:'));
  return c.json({ ok: true, positions: rows.map(orderEnvelope) });
});

/**
 * GET /markets/portfolio/summary — scale plan 0.6 (2026-07-02). One call
 * replacing the SIX parallel polls the NEO portfolio hook fired (user-state,
 * spot user-state, spot/jupiter/polymarket positions, balances): at 1k
 * concurrent Home viewers that was 18 req/min/user of pure fan-out. Each leg
 * fails soft (null) so one venue blip never blanks the whole portfolio.
 */
marketRoutes.get('/portfolio/summary', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const hlUser = u.privyWalletAddress ?? null;
  const [positions, hlState, spotState, balances, hip3State] = await Promise.all([
    // Hardening 2026-07-03: EVERY leg fails soft — a store hiccup on the
    // positions read must not 500 the whole aggregate (that was the exact
    // failure this route exists to prevent).
    store.listMarketPositions(u).catch((): Awaited<ReturnType<typeof store.listMarketPositions>> | null => null),
    hlUser ? hyperliquid.getUserState(hlUser).catch(() => null) : Promise.resolve(null),
    hlUser ? hyperliquidSpot.getUserState(hlUser).catch(() => null) : Promise.resolve(null),
    (async () => {
      const [evm, sol] = await Promise.all([
        // Pass the known privyDid: `null` forces a redundant store.user()
        // refetch inside resolvePrivyDid on every summary poll.
        walletService.getOrCreateUserWallet(u.id, u.privyDid ?? null),
        walletService.getOrCreateUserSolanaWallet(u.id, u.privyDid ?? null),
      ]);
      return readPortfolioBalances({
        evmAddress: evm.address as `0x${string}`,
        solanaAddress: sol.address,
      });
    })().catch(() => null),
    // HIP-3 builder-dex (xyz) equity — a SEPARATE clearinghouse the default
    // user-state read never sees (found 2026-07-05: $3.22 of AAPL collateral
    // invisible to TOTAL EQUITY).
    hlUser ? hyperliquidHip3.getUserState(hlUser).catch((): null => null) : Promise.resolve(null),
  ]);
  // No-leak contract: financial payloads carry a sourced envelope, and a
  // failed leg is EXPLICIT — a client must be able to tell "venue returned
  // zero" from "venue read failed" (legs.<name> === 'failed').
  const live = hyperliquid.isLiveTrading;
  return c.json({
    ok: true,
    sourced: live ? liveMeta('hyperliquid', 'portfolio-summary') : providerDemoMeta('hyperliquid', 'portfolio-summary'),
    legs: {
      positions: positions === null ? 'failed' : 'ok',
      hyperliquid: hlUser ? (hlState === null ? 'failed' : 'ok') : 'no-wallet',
      hyperliquidSpot: hlUser ? (spotState === null ? 'failed' : 'ok') : 'no-wallet',
      hyperliquidHip3: hlUser ? (hip3State === null ? 'failed' : 'ok') : 'no-wallet',
      balances: balances === null ? 'failed' : 'ok',
      cash: 'ok',
    },
    // SELL:* rows are sell ORDERS (Lane A), not holdings — the portfolio
    // aggregate must not render them as phantom positions.
    positions: (positions ?? []).filter((p) => !p.symbol.startsWith('SELL:')).map(orderEnvelope),
    hyperliquid: hlState,
    hyperliquidSpot: spotState,
    hyperliquidHip3: hip3State,
    balances,
    // App cash ledger (nb_user_state) — the leg that made "total net worth"
    // impossible from one call. Session-hydrated, so it can't fail
    // independently. NOTE: a separate accounting world from on-chain until
    // ledger reconciliation lands (ADR pending) — clients render it as its
    // own labeled line, never blindly summed into on-chain totals.
    cash: { balUsd: u.balUsd, eurUsd: u.eurUsd, earnUsd: u.earnUsd },
  });
});

/**
 * GET /markets/fills — cross-venue fills feed: Hyperliquid (venue API),
 * Polymarket (public data-api trades), Jupiter/xStocks (lifecycle store —
 * atomic swaps fill at execute time). Merged + sorted desc by timeMs.
 */
marketRoutes.get('/fills', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const q = c.req.query();
  const limit = boundedQueryInt(q.limit, 200, 1, 1000);
  const sinceMs = optionalQueryInt(q.from, 0, Number.MAX_SAFE_INTEGER);
  const hlUser = u.privyWalletAddress ?? null;
  // Cross-venue fills (2026-07-02): HL from the venue API (resting orders
  // fill server-side), Polymarket from the public data-api trades feed, and
  // Jupiter/xStocks from our own lifecycle store — atomic swaps fill at
  // execute time, so the ledger IS the fills truth for those venues.
  const [hlFills, pmFills, jupPositions, xsPositions] = await Promise.all([
    hlUser ? hyperliquid.getUserFills(hlUser, { limit, sinceMs }) : Promise.resolve([]),
    hlUser ? polymarket.getUserFills(hlUser, { limit, sinceMs }) : Promise.resolve([]),
    store.listMarketPositions(u, 'jupiter'),
    store.listMarketPositions(u, 'xstocks'),
  ]);
  const swapFills = [...jupPositions, ...xsPositions]
    .filter((p) => p.status === 'filled' && p.externalRef)
    .map((p) => {
      const filledMs = Date.parse(p.filledAt ?? p.createdAt);
      return {
        orderId: p.externalRef as string,
        coin: p.symbol,
        sideLong: p.sideLong,
        qty: p.entryPriceUsd > 0 ? p.qtyUsd / p.entryPriceUsd : p.qtyUsd,
        priceUsd: p.entryPriceUsd,
        feeUsd: 0,
        timeMs: Number.isFinite(filledMs) ? filledMs : 0,
        hash: p.externalRef as string,
        venue: p.venue,
      };
    })
    .filter((f) => f.timeMs >= (sinceMs ?? 0));
  const merged = [
    ...hlFills.map((f) => ({ ...f, venue: 'hyperliquid' as const })),
    ...pmFills.map((f) => ({ ...f, venue: 'polymarket' as const })),
    ...swapFills,
  ]
    .sort((a, b) => b.timeMs - a.timeMs)
    .slice(0, limit);
  return c.json({ ok: true, fills: merged });
});

/**
 * POST /markets/orders/:id/cancel — cross-venue cancel by internal order id.
 * Resolves (venue, externalRef) from the row, dispatches to the venue's cancel
 * adapter, records the lifecycle transition. Replaces N per-venue cancel routes
 * with one canonical dispatcher; the per-venue write routes (above) still work
 * for callers that already use them.
 */
marketRoutes.post('/orders/:id/cancel', async (c) => {
  const blocked = marketsGate(c);
  if (blocked) return blocked;
  const u = c.get('user');
  const id = c.req.param('id');
  const row = await store.getMarketPositionById(id);
  if (!row || row.userId !== u.id) throw ApiError.notFound('not_found');
  if (!row.externalRef) throw ApiError.badRequest('cancel_missing_external_ref');
  const cancelSupported = row.venue === 'hyperliquid'
    || row.venue === 'hyperliquid-spot'
    || row.venue === 'hyperliquid-hip3'
    || row.venue === 'polymarket';
  if (!cancelSupported) {
    return marketError(c, 412, 'cancel_unsupported_for_venue');
  }
  const isLiveCancel = cancelVenueIsLiveTrading(row.venue);
  const gate = tradeGate(c, u, { venue: row.venue, isLiveTrading: isLiveCancel });
  if (gate) return gate;
  const walletGate = await liveTradingWalletGate(c, row.venue, isLiveCancel, u);
  if (walletGate) return walletGate;
  const cancelBlocked = assertCancellableOrder(c, row);
  if (cancelBlocked) return cancelBlocked;

  let pmClobCreds: PmClobCreds | null = null;
  if (
    row.venue === 'polymarket' &&
    polymarket.isLiveTrading &&
    !row.externalRef.startsWith('pm_demo_')
  ) {
    pmClobCreds = await polymarketClobCredsForUser(u);
    if (!pmClobCreds) {
      return marketError(c, 503, 'polymarket_clob_credentials_unavailable');
    }
  }

  await lifecycle(row.id, 'cancel_requested');
  try {
    if (row.venue === 'hyperliquid') {
      await hyperliquid.cancelOrder({
        privyWalletId: u.privyWalletId ?? null,
        privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
        coin: row.symbol,
        externalRef: row.externalRef,
      });
    } else if (row.venue === 'hyperliquid-spot') {
      await hyperliquidSpot.cancelOrder({
        privyWalletId: u.privyWalletId ?? null,
        privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
        coin: row.symbol,
        externalRef: row.externalRef,
      });
    } else if (row.venue === 'hyperliquid-hip3') {
      await hyperliquidHip3.cancelOrder({
        privyWalletId: u.privyWalletId ?? null,
        privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
        coin: row.symbol,
        externalRef: row.externalRef,
      });
    } else if (row.venue === 'polymarket') {
      await polymarket.cancelOrder({
        privyWalletId: u.privyWalletId ?? null,
        privyWalletAddress: (u.privyWalletAddress ?? null) as `0x${string}` | null,
        externalRef: row.externalRef,
        clobCreds: pmClobCreds,
      });
    } else {
      throw new Error('unsupported_cancel_venue');
    }
  } catch (e) {
    await lifecycle(row.id, 'failed', {
      errorCode: 'cancel_rejected',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return venueFailure(c, row.venue as Venue, 'cancel', e);
  }
  const closed = await store.cancelMarketOrder(u, row.externalRef);
  const finalized = await lifecycle(row.id, 'canceled');
  return c.json({ ok: true, position: orderEnvelope(finalized ?? closed ?? row) });
});

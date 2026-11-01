/**
 * Polymarket market-data adapter — read-only prediction-market odds.
 *
 * Live reads hit the public, no-auth Gamma API
 * (GET https://gamma-api.polymarket.com/events). Gated behind features.markets
 * and, like the chain adapters, every network call degrades to a stable demo
 * sample on any error so the demo surface never throws.
 *
 * Polymarket is geo-restricted (US/UK/EU and others blocked). isRegionAllowed
 * encodes the blocked ISO-3166 alpha-2 codes for the UI to gate trading on; an
 * unknown/null country is treated as allowed in demo so local dev isn't blocked.
 * This is read-only data only — no trading is performed here.
 *
 * Gamma quirk: outcomes / outcomePrices come back as JSON-encoded STRINGS
 * (e.g. "[\"Yes\",\"No\"]" and "[\"0.62\",\"0.38\"]"), so we parse defensively.
 *
 * Docs: https://docs.polymarket.com
 *
 * ──────────────────────────────────────────────────────────────────────────
 * F100 Sprint 18 — TRANSITIVE DEPENDENCY, NOT ON RUNTIME PATH
 *
 * `@polymarket/clob-client-v2@1.0.6` installs `elliptic@6.6.1` via its
 * `@ethersproject/wallet@5.8.0` → `@ethersproject/signing-key@5.8.0` chain.
 * `elliptic@6.6.1` carries CVE-2025-14505
 * (https://github.com/advisories/GHSA-848j-6mx2-7j84) — incorrect ECDSA
 * signatures and conditional private-key exposure when an attacker obtains
 * both a faulty and a correct signature for the same inputs. Severity Low
 * (CVSS 2.9); no patched version available at the time of this writing.
 *
 * **NEXA's Polymarket signing path does NOT use this library.**
 *
 * We pass a custom Ethers-shaped signer (`privyClobSigner` in
 * `pm-clob.ts:235-251`) whose `_signTypedData` calls Privy's wallet API.
 * Polymarket's SDK detects the supplied `_signTypedData` and invokes it
 * directly — order construction + hashing run through viem, never through
 * `ethers.Wallet` / `SigningKey` / `elliptic`. The runtime call path is:
 *
 *   client.createAndPostOrder
 *   → buildOrderSignature
 *   → signTypedDataWithSigner
 *   → privyClobSigner._signTypedData (pm-clob.ts:240)
 *   → signTypedDataWithPrivy (privy.ts)
 *   → Privy wallet API
 *
 * Classification: dependency-hygiene finding. The advisory is not
 * reachable in the currently audited Polymarket order-signing path; we
 * are not making a broader claim about every future SDK path.
 *
 * Remediation (preferred, low priority):
 *   1. Add Dependabot or Renovate so transitive bumps land automatically.
 *      Our weekly `pnpm audit` step runs against a frozen lockfile and
 *      does NOT update deps on its own.
 *   2. Plan a migration to the unified `@polymarket/client` package once
 *      we move CI to Node 24 (currently Node 22; see
 *      `.github/workflows/build-and-push.yml`). `@polymarket/client`
 *      makes ethers v5 an optional peer dep with separate Privy / viem
 *      entry points.
 *   3. Optionally: ask Polymarket maintainers to make the
 *      `@ethersproject/*` dependencies optional in `clob-client-v2`.
 *
 * Do NOT file the original `POLYMARKET-CVE-ISSUE-DRAFT.md` issue body —
 * it described an inaccurate signing path. See that file for the
 * retraction note.
 *
 * Tracked in TECH_DEBT_AUDIT.md as F100 (Low / corrected 2026-06-22).
 * ──────────────────────────────────────────────────────────────────────────
 */

import { randomBytes } from 'node:crypto';
import { features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import { cancelClobOrder, submitClobLimitBuyOrder, submitClobLimitSellOrder, type ClobLane, type PmClobCreds, type PmClobSubmitResult } from './pm-clob.js';

const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export interface PmOrderInput {
  privyWalletId: string | null;
  /** Sprint 16.4 — Privy wallet EVM address (maker on the CLOB order). */
  privyWalletAddress: `0x${string}` | null;
  marketId: string;
  /** Outcome label ("Yes"/"No") or numeric index — opaque to us. */
  outcome: string;
  /** Limit price in cents (1..99). */
  priceCents: number;
  qtyUsd: number;
  /**
   * Audit 2026-06-19 — the CLOB outcome `tokenId` (resolved by the route from
   * the market's `outcomes[i].tokenId` via Gamma's `clobTokenIds`). REQUIRED
   * for live trading. Null/missing → demo fallback (never silent failure on
   * a wrong tokenId).
   */
  outcomeTokenId?: string | null;
  /**
   * Audit 2026-06-19 — per-user CLOB L2 credentials. Resolved by the route via
   * `getOrDeriveCreds()` (read from `nb_users` or freshly derived). Null when
   * absent → demo fallback.
   */
  clobCreds?: PmClobCreds | null;
  /**
   * Builder Program lane (2026-07-05) — resolved by the route via
   * pm-relayer.getBuilderLaneFunder(). When set, the order rides the builder
   * lane funder (signatureType 3, POLY_1271 — see pm-clob.ts) and carries our
   * builderCode. Null → legacy lanes (env clobFunderOverride() or bare EOA), unchanged.
   */
  lane?: ClobLane | null;
}

export interface PmOrderResult {
  orderId: string;
  filledQtyUsd: number;
  /** Price actually crossed at (cents). Falls back to the limit price. */
  priceCents: number;
  demo: boolean;
  state?: 'filled' | 'resting';
}

export interface PmPosition {
  marketId: string;
  outcome: string;
  qtyUsd: number;
  /** Average entry price in cents. */
  priceCents: number;
}

const DEFAULT_LIMIT = 20;

/**
 * ISO-3166 alpha-2 codes where Polymarket trading is blocked. Read-only data may
 * still be shown; this gates the trade action in the UI. Exported so the route
 * layer + UI region-pill can read from one source of truth.
 */
export const POLY_BLOCKED: ReadonlySet<string> = new Set([
  'US', // United States
  'GB', // United Kingdom
  'DE', // Germany
  'FR', // France
  'IT', // Italy
  'JP', // Japan
  'SG', // Singapore
  'AU', // Australia
  'BE', // Belgium
  'PL', // Poland
  'RU', // Russia
  'IR', // Iran
  'KP', // North Korea
]);
const BLOCKED = POLY_BLOCKED;

function clobStatusFilled(status: string | null): boolean {
  const s = (status ?? '').trim().toLowerCase();
  return s === 'filled' || s === 'matched' || s === 'filled_or_killed';
}

export interface PmMarket {
  id: string;
  question: string;
  outcomes: Array<{
    label: string;
    pricePct: number;
    marketId?: string;
    conditionId?: string;
    tokenId?: string | null;
  }>;
  /** ISO timestamp the market closes, or null when open-ended / unknown. */
  closesAt: string | null;
  /**
   * ISO timestamp the underlying game/event starts (sports markets carry it
   * via Gamma's `gameStartTime`). Started + still-open ⇒ genuinely LIVE.
   */
  gameStartTime?: string | null;
  imageUrl?: string | null;
  category?: string | null;
  tags?: string[];
  isNegRisk?: boolean;
  isMultiOutcome?: boolean;
  /** Markdown blob from Gamma's `description` field. */
  description?: string | null;
  /** 24h volume in USD. */
  volume24hUsd?: number | null;
  /** Total liquidity in USD. */
  liquidityUsd?: number | null;
  /**
   * Other markets in the same Gamma event (multi-outcome), used to render the
   * "Related markets" accordion. Populated on getMarket() only.
   */
  related?: Array<{ id: string; question: string; pricePct: number | null }>;
}
type MarketDataSource = 'live' | 'provider-demo';
export interface PmMarketsResult {
  source: MarketDataSource;
  markets: PmMarket[];
}

/** A top holder (≈ "top trader") of one outcome token on a market. */
export interface PmTopTrader {
  wallet: string;
  name: string | null;
  amount: number;
  outcomeIndex: number;
  verified: boolean;
}
export interface PmTopTradersResult {
  source: MarketDataSource;
  outcomes: Array<{ tokenId: string; holders: PmTopTrader[] }>;
}

/** One ranked trader on the live "best traders" leaderboard. */
export interface PmLeaderboardEntry {
  wallet: string;
  name: string | null;
  /** Sum of open-position cash PnL (USD). */
  pnl: number;
  /** Sum of realized PnL (USD). */
  realizedPnl: number;
  /** Sum of current open-position value (USD) — portfolio-in-markets proxy. */
  value: number;
  /** Open position count. */
  positions: number;
  /** Share of open positions currently in profit (0..1), or null if none. */
  winRate: number | null;
}
export interface PmLeaderboardResult {
  source: MarketDataSource;
  traders: PmLeaderboardEntry[];
}
export type PmLeaderboardSort = 'pnl' | 'value' | 'winRate' | 'realizedPnl';

export interface PmCopyIntent {
  wallet: string;
  marketId: string;
  outcome: string;
  outcomeIndex: number;
  title: string;
  slug: string | null;
  icon: string | null;
  conditionId: string | null;
  asset: string | null;
  oppositeAsset: string | null;
  currentValueUsd: number;
  suggestedQtyUsd: number;
  entryPriceCents: number | null;
  currentPriceCents: number | null;
  pnlUsd: number;
  sizeShares: number;
  endDate: string | null;
  negativeRisk: boolean;
}
export interface PmCopyIntentResult {
  source: MarketDataSource;
  intent: PmCopyIntent | null;
}

/** Polymarket data-api `/positions` row — only the fields we aggregate. */
interface PmPositionRow {
  asset?: string | number;
  conditionId?: string;
  cashPnl?: number | string;
  realizedPnl?: number | string;
  currentValue?: number | string;
  curPrice?: number | string;
  avgPrice?: number | string;
  size?: number | string;
  title?: string;
  slug?: string;
  icon?: string;
  eventId?: string | number;
  outcome?: string;
  outcomeIndex?: number | string;
  oppositeAsset?: string | number;
  endDate?: string;
  negativeRisk?: boolean;
}

/**
 * Wallets whose nominal value / PnL exceed this are almost always an artifact of
 * holding billions of sub-cent longshot shares (size × ~$0.001 balloons the
 * notional). They are not real copy-trade targets, so the leaderboard excludes
 * them. v1 heuristic — the persistent index will price positions against book
 * liquidity instead of nominal currentValue.
 */
const MAX_PLAUSIBLE_USD = 50_000_000;
const LEADERBOARD_CACHE_MS = 60_000;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function leaderboardSortValue(e: PmLeaderboardEntry, sort: PmLeaderboardSort): number {
  switch (sort) {
    case 'value':
      return e.value;
    case 'winRate':
      return e.winRate ?? -1;
    case 'realizedPnl':
      return e.realizedPnl;
    case 'pnl':
    default:
      return e.pnl;
  }
}

function suggestedCopyQty(valueUsd: number): number {
  if (!(valueUsd > 0)) return 1;
  const qty = Math.min(25, Math.max(1, valueUsd * 0.01));
  return Math.round(qty * 100) / 100;
}

/** Bounded-concurrency map — runs `fn` over `items` in fixed-size batches. */
async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

/** Polymarket data-api `/holders` row — defensive; only the fields we read. */
interface PmHoldersGroup {
  token?: string;
  holders?: Array<{
    proxyWallet?: string;
    name?: string;
    pseudonym?: string;
    displayUsernamePublic?: boolean;
    amount?: number | string;
    outcomeIndex?: number;
    verified?: boolean;
  }>;
}

/** Stable demo sample — used when markets are disabled or the API is unreachable. */
const DEMO_MARKETS: readonly PmMarket[] = [
  {
    id: 'demo-btc-100k',
    question: 'Will BTC close above $100k this month?',
    outcomes: [
      { label: 'Yes', pricePct: 62 },
      { label: 'No', pricePct: 38 },
    ],
    closesAt: null,
  },
  {
    id: 'demo-fed-q3',
    question: 'Will the Fed cut rates in Q3?',
    outcomes: [
      { label: 'Yes', pricePct: 44 },
      { label: 'No', pricePct: 56 },
    ],
    closesAt: null,
  },
];

/** Gamma market row — only the fields we read; all optional/defensive. */
interface GammaMarket {
  id?: string | number;
  conditionId?: string;
  question?: string;
  title?: string;
  groupItemTitle?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  tokenIds?: string | string[];
  endDate?: string;
  endDateIso?: string;
  /** Sports markets: "2026-07-03 05:40:00+00" (SQL-ish, not ISO). */
  gameStartTime?: string;
  image?: string;
  icon?: string;
  category?: string | { label?: string; name?: string };
  tags?: Array<{ label?: string; name?: string; slug?: string }>;
  negRisk?: boolean | string;
}

interface GammaEvent {
  id?: string | number;
  title?: string;
  question?: string;
  description?: string;
  image?: string;
  icon?: string;
  category?: string | { label?: string; name?: string };
  tags?: Array<{ label?: string; name?: string; slug?: string }>;
  negRisk?: boolean | string;
  markets?: GammaMarket[];
  endDate?: string;
  endDateIso?: string;
  volume?: number | string;
  volume24hr?: number | string;
  liquidity?: number | string;
}

export class PolymarketAdapter {
  private readonly leaderboardCache = new Map<string, { expiresAt: number; result: PmLeaderboardResult }>();

  get isLive(): boolean {
    return features.markets;
  }

  /**
   * Feature-level gate for live CLOB trading. The per-USER gate (Privy wallet
   * + persisted L2 credentials + resolved outcome tokenId) lives in `placeOrder`
   * itself: if any prereq is missing on a specific request, we fall back to
   * the demo path so no half-live order leaks.
   *
   * Audit 2026-06-19 — was hardcoded `false` while the L2 derive flow was a
   * gap (Sprint 16.4 audit). With `pm-clob.ts` shipped, we flip the feature
   * gate live and rely on the per-user prereq check below.
   */
  get isLiveTrading(): boolean {
    return features.markets && features.privy;
  }

  /**
   * Whether Polymarket trading is allowed from a country. Blocked ISO codes →
   * false; null/unknown → true (treated as allowed in demo so dev isn't gated).
   */
  isRegionAllowed(country: string | null): boolean {
    if (!country) return true;
    return !BLOCKED.has(country.trim().toUpperCase());
  }

  /**
   * Place a CLOB limit order.
   *
   * Demo mode returns a synthetic order for the product surface. Live mode
   * submits through `pm-clob.ts`; token id, wallet, and L2 credentials must be
   * present or the request fails closed before a local position is recorded.
   */
  async placeOrder(input: PmOrderInput): Promise<PmOrderResult> {
    if (!this.isLiveTrading) {
      return {
        orderId: 'pm_demo_' + hex(8),
        filledQtyUsd: input.qtyUsd,
        priceCents: input.priceCents,
        demo: true,
        state: 'filled',
      };
    }
    if (
      !input.privyWalletId ||
      !input.privyWalletAddress ||
      !input.outcomeTokenId ||
      !input.clobCreds
    ) {
      throw new Error('polymarket_live_prereq_missing');
    }
    const submitted = await submitClobLimitBuyOrder({
      privyWalletId: input.privyWalletId,
      privyWalletAddress: input.privyWalletAddress,
      creds: input.clobCreds,
      tokenId: input.outcomeTokenId,
      priceCents: input.priceCents,
      qtyUsd: input.qtyUsd,
      lane: input.lane ?? null,
    });
    const filled = clobStatusFilled(submitted.status);
    return {
      orderId: submitted.orderId,
      filledQtyUsd: filled ? input.qtyUsd : 0,
      priceCents: input.priceCents,
      demo: false,
      state: filled ? 'filled' : 'resting',
    };
  }

  /**
   * Sell outcome tokens the user already holds (competitor sprint Lane A,
   * 2026-07-03). Mirrors `placeOrder`'s demo/live split and fail-closed
   * prereqs; size is SHARE-denominated (the route derives shares from the
   * stored position). `filledQtyUsd` in the result is the PROCEEDS notional
   * (shares × price) so callers can render "sold $X".
   */
  async sellOrder(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    /** CLOB outcome tokenId — resolved by the route from the position's market. */
    outcomeTokenId?: string | null;
    clobCreds?: PmClobCreds | null;
    /** Limit price in cents (1..99). */
    priceCents: number;
    /** Outcome tokens to dispose — position qtyUsd / entryPriceUsd. */
    sizeShares: number;
    /** Builder Program lane — see PmOrderInput.lane. */
    lane?: ClobLane | null;
  }): Promise<PmOrderResult> {
    const proceedsUsd = (input.sizeShares * input.priceCents) / 100;
    if (!this.isLiveTrading) {
      return {
        orderId: 'pm_demo_sell_' + hex(8),
        filledQtyUsd: proceedsUsd,
        priceCents: input.priceCents,
        demo: true,
        state: 'filled',
      };
    }
    if (
      !input.privyWalletId ||
      !input.privyWalletAddress ||
      !input.outcomeTokenId ||
      !input.clobCreds
    ) {
      throw new Error('polymarket_live_prereq_missing');
    }
    let submitted: PmClobSubmitResult;
    try {
      submitted = await submitClobLimitSellOrder({
        privyWalletId: input.privyWalletId,
        privyWalletAddress: input.privyWalletAddress,
        creds: input.clobCreds,
        tokenId: input.outcomeTokenId,
        priceCents: input.priceCents,
        sizeShares: input.sizeShares,
        lane: input.lane ?? null,
      });
    } catch (e) {
      // Map the CLOB's allowance rejection to an actionable code: sells move
      // CTF ERC-1155 outcome tokens, which requires a one-time
      // setApprovalForAll to the exchange that NO flow provisions yet.
      // Surfacing the generic venue error would hide the real fix from users.
      const msg = e instanceof Error ? e.message : String(e);
      if (/allowance|not enough balance/i.test(msg)) {
        throw new Error('polymarket_ctf_approval_required', { cause: e });
      }
      throw e;
    }
    const filled = clobStatusFilled(submitted.status);
    if (!filled) {
      // FOK can never rest. Any non-filled success status ('delayed' in
      // delay-enabled in-play markets, 'live', ...) is an outcome we cannot
      // confirm without an order-status poller — recording it as a resting
      // row would create a permanently unresolvable phantom. Fail closed
      // with an explicit code; delay-market sells ship with the fills worker.
      throw new Error(`polymarket_sell_not_immediate:${submitted.status ?? 'unknown'}`);
    }
    // Proceeds are computed at the LIMIT price, not read back from the venue
    // (the submit result carries only orderId+status). With FOK this is
    // quantity-exact — all-or-nothing — and price-CONSERVATIVE: a fill that
    // crosses better than the limit understates proceeds, never overstates.
    // Reading actual matched prices arrives with the fills worker.
    return {
      orderId: submitted.orderId,
      filledQtyUsd: proceedsUsd,
      priceCents: input.priceCents,
      demo: false,
      state: 'filled',
    };
  }

  async cancelOrder(input: {
    privyWalletId: string | null;
    privyWalletAddress: `0x${string}` | null;
    externalRef: string;
    clobCreds?: PmClobCreds | null;
  }): Promise<{ ok: true; demo: boolean }> {
    if (!this.isLiveTrading || input.externalRef.startsWith('pm_demo_')) {
      return { ok: true, demo: true };
    }
    if (!input.privyWalletId || !input.privyWalletAddress || !input.clobCreds) {
      throw new Error('polymarket_live_prereq_missing');
    }
    await cancelClobOrder({
      privyWalletId: input.privyWalletId,
      privyWalletAddress: input.privyWalletAddress,
      creds: input.clobCreds,
      orderId: input.externalRef,
    });
    return { ok: true, demo: false };
  }

  /**
   * Positions reconciliation. Audit 2026-06-19 — the previous live HTTP path
   * here sent only the legacy `POLY_API_KEY` header without the full L2 HMAC,
   * so the CLOB endpoint silently 401'd and the adapter swallowed the failure
   * into an empty array. The route layer already reads positions from the
   * local `nb_market_positions` table (mirrored on every successful
   * `placeOrder`), so the live HTTP read added no value beyond cache.
   *
   * We now always return `[]` and let the route's local-store reconciliation
   * be the source of truth. If we ever want to surface fills the route layer
   * doesn't see (e.g. cancels on the Polymarket UI), we'd wire `clobCreds` in
   * and call `buildL2Headers` here — same shape as `placeOrder`.
   */
  async getPositions(_userAddress: string | null): Promise<PmPosition[]> {
    return [];
  }

  /**
   * Active, open events. Live: GET Gamma events sorted by 24h volume and map
   * event metadata plus leading outcomes. Disabled or on any error: demo.
   *
   * `category` (case-insensitive) filters the returned set against
   * `PmMarket.category`. When set, the upstream fetch widens to up to 200 rows
   * before filtering so categories with lower 24h volume (e.g. Sports) aren't
   * starved out of the top-N by crypto/politics events.
   */
  async getMarketsResult(limit = DEFAULT_LIMIT, category?: string): Promise<PmMarketsResult> {
    if (!this.isLive) return { source: 'provider-demo', markets: demo() };
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    const wantCategory = category?.trim().toLowerCase();
    // Polymarket Gamma /events caps each page at 100 even when limit>100 is
    // requested. To return up to 500 (or more when a category needs deeper
    // sampling), page via offset until we either fill the request or the
    // upstream stops returning rows. 2026-06-20 — see observation 45689.
    const target = wantCategory ? Math.max(n, 600) : n;
    const PAGE_SIZE = 100;
    try {
      const markets: PmMarket[] = [];
      const seen = new Set<string>();
      let offset = 0;
      let pages = 0;
      const MAX_PAGES = 50;
      while (markets.length < target && pages < MAX_PAGES) {
        const pageLimit = wantCategory ? PAGE_SIZE : Math.min(PAGE_SIZE, target - markets.length);
        const params = new URLSearchParams({
          active: 'true',
          closed: 'false',
          archived: 'false',
          order: 'volume24hr',
          ascending: 'false',
          limit: String(pageLimit),
          offset: String(offset),
        });
        const url = `${GAMMA_EVENTS_URL}?${params.toString()}`;
        const res = await httpRequest(url, {
          vendor: 'polymarket',
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 8_000,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          log.warn({ status: res.status, text, offset }, 'polymarket: markets page rejected');
          break;
        }
        const data = (await res.json().catch(() => null)) as GammaEvent[] | { events?: GammaEvent[] } | null;
        const rows = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : null;
        if (!rows || rows.length === 0) break;
        let pageMatched = 0;
        for (const row of rows) {
          const m = mapEvent(row);
          if (!m || seen.has(m.id)) continue;
          if (wantCategory) {
            const cat = m.category?.toLowerCase() ?? '';
            const tagMatch = (m.tags ?? []).some((t) => t.toLowerCase() === wantCategory);
            if (cat !== wantCategory && !tagMatch) continue;
          }
          seen.add(m.id);
          markets.push(m);
          pageMatched++;
          if (markets.length >= target) break;
        }
        pages++;
        offset += pageLimit;
        // If this page yielded no new matches AND we've already paged a fair
        // bit, stop — the tail is unlikely to flip.
        if (rows.length < pageLimit) break;
        if (wantCategory && pageMatched === 0 && pages >= 4) break;
      }
      if (markets.length === 0 && !wantCategory) {
        return { source: 'provider-demo', markets: demo() };
      }
      return { source: 'live', markets: markets.slice(0, n) };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'polymarket: markets unreachable — demo fallback',
      );
      return { source: 'provider-demo', markets: demo() };
    }
  }

  async getMarkets(limit = DEFAULT_LIMIT, category?: string): Promise<PmMarket[]> {
    return (await this.getMarketsResult(limit, category)).markets;
  }

  /**
   * A single market by id. Tries Gamma's direct `/events/:id` endpoint first
   * (fast, no pagination); falls back to a wide list scan with deeper paging
   * for markets returned by id-less searches (slug etc).
   */
  async getMarket(id: string): Promise<PmMarket | null> {
    const want = id.trim();
    if (!want) return null;
    if (this.isLive) {
      try {
        const url = `${GAMMA_EVENTS_URL}/${encodeURIComponent(want)}`;
        const res = await httpRequest(url, {
          vendor: 'polymarket',
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 8_000,
        });
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as GammaEvent | null;
          if (data && (data.id != null || data.title || data.markets)) {
            const m = mapEvent(data);
            if (m) return m;
          }
        }
      } catch {
        // network — fall through to list scan
      }
    }
    // Deep fallback — page through the top markets until we find a match.
    const markets = await this.getMarkets(500);
    return markets.find((m) => m.id === want) ?? null;
  }

  /**
   * Polymarket CLOB orderbook for a single outcome on a market. We resolve the
   * outcome (label, e.g. "Yes" / "No") into the CLOB tokenId via the market's
   * `outcomes[i].tokenId`, then hit `https://clob.polymarket.com/book?token_id=...`
   * which is publicly readable (no auth required).
   *
   * Returns the top-N bids + asks, the mid in cents, and the spread in cents.
   * `null` on any failure. The route returns an empty book payload in that
   * case and the UI gracefully degrades.
   */
  async getOrderbook(
    marketId: string,
    outcomeLabel?: string,
  ): Promise<{
    bids: Array<{ priceCents: number; sizeShares: number }>;
    asks: Array<{ priceCents: number; sizeShares: number }>;
    midCents: number | null;
    spreadCents: number | null;
  } | null> {
    if (!this.isLive) return null;
    const market = await this.getMarket(marketId);
    if (!market || market.outcomes.length === 0) return null;
    const want = (outcomeLabel ?? market.outcomes[0]?.label ?? '').trim().toLowerCase();
    const outcome =
      market.outcomes.find((o) => (o.label ?? '').toLowerCase() === want) ??
      market.outcomes[0];
    const tokenId = outcome?.tokenId;
    if (!tokenId) return null;
    try {
      const res = await httpRequest(
        `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
        {
          vendor: 'polymarket',
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 6_000,
          maxAttempts: 2,
        },
      );
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        bids?: Array<{ price: string; size: string }>;
        asks?: Array<{ price: string; size: string }>;
      } | null;
      if (!data) return null;
      const bids = (data.bids ?? [])
        .map((l) => ({
          priceCents: Math.round(Number(l.price) * 100),
          sizeShares: Number(l.size) || 0,
        }))
        .filter((l) => Number.isFinite(l.priceCents) && l.sizeShares > 0)
        // Highest bid first.
        .sort((a, b) => b.priceCents - a.priceCents)
        .slice(0, 25);
      const asks = (data.asks ?? [])
        .map((l) => ({
          priceCents: Math.round(Number(l.price) * 100),
          sizeShares: Number(l.size) || 0,
        }))
        .filter((l) => Number.isFinite(l.priceCents) && l.sizeShares > 0)
        // Lowest ask first.
        .sort((a, b) => a.priceCents - b.priceCents)
        .slice(0, 25);
      const topBid = bids[0]?.priceCents;
      const topAsk = asks[0]?.priceCents;
      const midCents =
        topBid != null && topAsk != null ? (topBid + topAsk) / 2 : null;
      const spreadCents =
        topBid != null && topAsk != null ? topAsk - topBid : null;
      return { bids, asks, midCents, spreadCents };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), marketId, outcomeLabel },
        'polymarket: orderbook fetch failed',
      );
      return null;
    }
  }

  /**
   * Top holders (≈ "top traders") of a market's outcome tokens, from the public
   * Polymarket data-api `/holders?market=<conditionId>` endpoint. Resolves the
   * market's conditionId via getMarket() — same shape as getOrderbook resolving
   * the tokenId — then maps the per-outcome holder groups to a normalized shape.
   * Sprint 1 of the copy-trading surface: ranked live holders, no index needed.
   * Degrades to an empty (live-less) result on any error — never throws.
   */
  async getTopTraders(marketId: string, limit = 10): Promise<PmTopTradersResult> {
    if (!this.isLive) return { source: 'provider-demo', outcomes: [] };
    const market = await this.getMarket(marketId);
    const conditionId = market?.outcomes.find((o) => o.conditionId)?.conditionId ?? null;
    if (!conditionId) return { source: 'provider-demo', outcomes: [] };
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
    try {
      const res = await httpRequest(
        `https://data-api.polymarket.com/holders?market=${encodeURIComponent(conditionId)}&limit=${n}`,
        {
          vendor: 'polymarket',
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 8_000,
          maxAttempts: 2,
        },
      );
      if (!res.ok) return { source: 'provider-demo', outcomes: [] };
      const data = (await res.json().catch(() => null)) as PmHoldersGroup[] | null;
      if (!Array.isArray(data)) return { source: 'provider-demo', outcomes: [] };
      const outcomes = data.map((group) => ({
        tokenId: String(group.token ?? ''),
        holders: (Array.isArray(group.holders) ? group.holders : [])
          .map((h) => {
            const name = h.displayUsernamePublic === false
              ? null
              : stringOrNull(h.name) ?? stringOrNull(h.pseudonym);
            return {
              wallet: String(h.proxyWallet ?? ''),
              name,
              amount: Number(h.amount) || 0,
              outcomeIndex: Number(h.outcomeIndex) || 0,
              verified: h.verified === true,
            };
          })
          .filter((h) => h.wallet)
          .slice(0, n),
      }));
      return { source: 'live', outcomes };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), marketId },
        'polymarket: top-traders fetch failed',
      );
      return { source: 'provider-demo', outcomes: [] };
    }
  }

  /**
   * Live-computed "best traders" leaderboard. Walks the top markets' holders to
   * build a wallet universe, then pulls each wallet's open positions from the
   * public data-api `/positions` endpoint to compute PnL, realized PnL, value,
   * and win-rate (share of positions in profit). Ranks by the requested key.
   * Bounded + parallel; meant to sit behind a multi-minute route cache — this
   * is the Sprint-2 v1 of the index, computed on demand rather than crawled.
   * Degrades to an empty (live-less) result on any error — never throws.
   */
  async getLeaderboard(
    opts: { markets?: number; traders?: number; sort?: PmLeaderboardSort } = {},
  ): Promise<PmLeaderboardResult> {
    if (!this.isLive) return { source: 'provider-demo', traders: [] };
    const marketCount = clampInt(opts.markets, 5, 1, 20);
    const traderCount = clampInt(opts.traders, 20, 1, 50);
    const sort: PmLeaderboardSort = opts.sort ?? 'pnl';
    const cacheKey = `${marketCount}:${traderCount}:${sort}`;
    const cached = this.leaderboardCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    try {
      const markets = (await this.getMarketsResult(marketCount)).markets;
      const conditionIds = markets
        .map((m) => m.outcomes.find((o) => o.conditionId)?.conditionId)
        .filter((cid): cid is string => Boolean(cid));
      // Wallet universe from the top markets' holders (deduped, first-seen order).
      const holderLists = await mapPool(conditionIds, 5, (cid) => this.fetchHolderWallets(cid, 10));
      const names = new Map<string, string | null>();
      const order: string[] = [];
      for (const list of holderLists) {
        for (const h of list) {
          if (!names.has(h.wallet)) {
            names.set(h.wallet, h.name);
            order.push(h.wallet);
          }
        }
      }
      // Bound the per-wallet fan-out (over-fetch a little, then rank + trim).
      const candidates = order.slice(0, Math.min(order.length, traderCount * 2));
      const entries = await mapPool(candidates, 6, (wallet) =>
        this.fetchWalletStats(wallet, names.get(wallet) ?? null),
      );
      const traders = entries
        .filter(
          (e): e is PmLeaderboardEntry =>
            e !== null &&
            e.positions > 0 &&
            Math.abs(e.pnl) <= MAX_PLAUSIBLE_USD &&
            e.value <= MAX_PLAUSIBLE_USD,
        )
        .sort((a, b) => leaderboardSortValue(b, sort) - leaderboardSortValue(a, sort))
        .slice(0, traderCount);
      if (traders.length === 0) return { source: 'provider-demo', traders: [] };
      const result = { source: 'live' as const, traders };
      this.leaderboardCache.set(cacheKey, { expiresAt: Date.now() + LEADERBOARD_CACHE_MS, result });
      return result;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'polymarket: leaderboard build failed',
      );
      return { source: 'provider-demo', traders: [] };
    }
  }

  async getCopyIntent(wallet: string): Promise<PmCopyIntentResult> {
    if (!this.isLive) return { source: 'provider-demo', intent: null };
    try {
      const rows = await this.fetchWalletPositions(wallet);
      const best = rows
        .filter((r) => {
          const value = Number(r.currentValue) || 0;
          const price = Number(r.curPrice) || 0;
          return value > 0 && price > 0 && Boolean(r.eventId) && Boolean(r.outcome);
        })
        .sort((a, b) => (Number(b.currentValue) || 0) - (Number(a.currentValue) || 0))[0];
      if (!best) return { source: 'provider-demo', intent: null };
      const valueUsd = Number(best.currentValue) || 0;
      const avgPrice = Number(best.avgPrice);
      const curPrice = Number(best.curPrice);
      return {
        source: 'live',
        intent: {
          wallet,
          marketId: String(best.eventId),
          outcome: String(best.outcome),
          outcomeIndex: Number(best.outcomeIndex) || 0,
          title: String(best.title ?? 'Polymarket position'),
          slug: best.slug ? String(best.slug) : null,
          icon: best.icon ? String(best.icon) : null,
          conditionId: best.conditionId ? String(best.conditionId) : null,
          asset: best.asset != null ? String(best.asset) : null,
          oppositeAsset: best.oppositeAsset != null ? String(best.oppositeAsset) : null,
          currentValueUsd: valueUsd,
          suggestedQtyUsd: suggestedCopyQty(valueUsd),
          entryPriceCents: Number.isFinite(avgPrice) ? Math.round(avgPrice * 10_000) / 100 : null,
          currentPriceCents: Number.isFinite(curPrice) ? Math.round(curPrice * 10_000) / 100 : null,
          pnlUsd: Number(best.cashPnl) || 0,
          sizeShares: Number(best.size) || 0,
          endDate: best.endDate ? String(best.endDate) : null,
          negativeRisk: Boolean(best.negativeRisk),
        },
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), wallet },
        'polymarket: copy intent failed',
      );
      return { source: 'provider-demo', intent: null };
    }
  }

  /** Top holder wallets for one market's outcome tokens (flattened, with names). */
  private async fetchHolderWallets(
    conditionId: string,
    limit: number,
  ): Promise<Array<{ wallet: string; name: string | null }>> {
    try {
      const res = await httpRequest(
        `https://data-api.polymarket.com/holders?market=${encodeURIComponent(conditionId)}&limit=${limit}`,
        {
          vendor: 'polymarket',
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 8_000,
          maxAttempts: 2,
        },
      );
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as PmHoldersGroup[] | null;
      if (!Array.isArray(data)) return [];
      const out: Array<{ wallet: string; name: string | null }> = [];
      for (const group of data) {
        for (const h of Array.isArray(group.holders) ? group.holders : []) {
          const wallet = String(h.proxyWallet ?? '');
          const name = h.displayUsernamePublic === false
            ? null
            : stringOrNull(h.name) ?? stringOrNull(h.pseudonym);
          if (wallet) out.push({ wallet, name });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Per-wallet PnL / value / win-rate from the public `/positions` endpoint. */
  private async fetchWalletStats(
    wallet: string,
    name: string | null,
  ): Promise<PmLeaderboardEntry | null> {
    try {
      const rows = await this.fetchWalletPositions(wallet);
      if (rows.length === 0) return null;
      let pnl = 0;
      let realizedPnl = 0;
      let value = 0;
      let wins = 0;
      for (const r of rows) {
        const cash = Number(r.cashPnl) || 0;
        pnl += cash;
        realizedPnl += Number(r.realizedPnl) || 0;
        value += Number(r.currentValue) || 0;
        if (cash > 0) wins += 1;
      }
      return {
        wallet,
        name,
        pnl,
        realizedPnl,
        value,
        positions: rows.length,
        winRate: rows.length > 0 ? wins / rows.length : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Unified-fills source — the user's executed CLOB trades from the public
   * data-api (keyless, same family as /positions and /holders). Rows map onto
   * the cross-venue fill shape served by GET /markets/fills. `coin` carries
   * the outcome (Yes/No/…); the market question rides in `market` so clients
   * can label prediction fills meaningfully.
   */
  async getUserFills(
    wallet: string | null,
    params?: { limit?: number; sinceMs?: number },
  ): Promise<
    Array<{
      orderId: string;
      coin: string;
      sideLong: boolean;
      qty: number;
      priceUsd: number;
      feeUsd: number;
      timeMs: number;
      hash: string;
      market: string | null;
    }>
  > {
    if (!this.isLive || !wallet) return [];
    const limit = Math.max(1, Math.min(500, Math.floor(params?.limit ?? 200)));
    try {
      const res = await httpRequest(
        `https://data-api.polymarket.com/trades?user=${encodeURIComponent(wallet)}&limit=${limit}`,
        {
          vendor: 'polymarket',
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 8_000,
          maxAttempts: 2,
        },
      );
      if (!res.ok) return [];
      const rows = (await res.json().catch(() => null)) as PmTradeRow[] | null;
      if (!Array.isArray(rows)) return [];
      const sinceMs = params?.sinceMs ?? 0;
      const fills: Array<{
        orderId: string;
        coin: string;
        sideLong: boolean;
        qty: number;
        priceUsd: number;
        feeUsd: number;
        timeMs: number;
        hash: string;
        market: string | null;
      }> = [];
      for (const row of rows) {
        const timeMs = Number(row.timestamp ?? 0) * 1000;
        const size = Number(row.size ?? 0);
        const price = Number(row.price ?? 0);
        if (!(timeMs > 0) || !(size > 0) || timeMs < sinceMs) continue;
        const hash = typeof row.transactionHash === 'string' ? row.transactionHash : '';
        const fallbackId =
          typeof row.name === 'string' && row.name ? row.name : `${row.conditionId ?? 'pm'}:${timeMs}`;
        fills.push({
          orderId: hash || fallbackId,
          coin: typeof row.outcome === 'string' && row.outcome ? row.outcome : 'YES',
          sideLong: String(row.side ?? '').toUpperCase() === 'BUY',
          qty: size,
          priceUsd: price,
          feeUsd: 0,
          timeMs,
          hash,
          market: typeof row.title === 'string' ? row.title : null,
        });
      }
      return fills;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'polymarket: getUserFills failed',
      );
      return [];
    }
  }

  private async fetchWalletPositions(wallet: string): Promise<PmPositionRow[]> {
    const res = await httpRequest(
      `https://data-api.polymarket.com/positions?user=${encodeURIComponent(wallet)}&limit=500`,
      {
        vendor: 'polymarket',
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: 8_000,
        maxAttempts: 2,
      },
    );
    if (!res.ok) return [];
    const rows = (await res.json().catch(() => null)) as PmPositionRow[] | null;
    return Array.isArray(rows) ? rows : [];
  }
}

/** Polymarket data-api `/trades` row — only the fields the fills feed maps. */
interface PmTradeRow {
  transactionHash?: string;
  name?: string;
  conditionId?: string;
  side?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  title?: string;
  outcome?: string;
}

/** Map one Gamma row → PmMarket, or null if it lacks a usable question/outcomes. */
type PmOutcome = PmMarket['outcomes'][number];

interface EventMarketMeta {
  id: string;
  question: string;
  closesAt: string | null;
  imageUrl: string | null;
  category: string | null;
  tags: string[];
  isNegRisk: boolean;
  isMultiOutcome: boolean;
}

function mapEvent(row: GammaEvent): PmMarket | null {
  if (!row || typeof row !== 'object') return null;
  const eventMarkets = Array.isArray(row.markets) ? row.markets : [];
  const firstMarket = eventMarkets[0];
  const question =
    stringOrNull(row.title) ??
    stringOrNull(row.question) ??
    stringOrNull(firstMarket?.question);
  if (!question) return null;

  const imageUrl =
    stringOrNull(row.image) ??
    stringOrNull(row.icon) ??
    stringOrNull(firstMarket?.image) ??
    stringOrNull(firstMarket?.icon);
  const category = categoryLabel(row.category) ?? categoryLabel(firstMarket?.category);
  const tags = tagLabels(row.tags);
  const isNegRisk = boolish(row.negRisk) || eventMarkets.some((m) => boolish(m.negRisk));
  const isMultiOutcome = isNegRisk && eventMarkets.length > 1;
  const closesAt = row.endDate ?? row.endDateIso ?? firstMarket?.endDate ?? firstMarket?.endDateIso ?? null;
  const eventId = String(row.id ?? firstMarket?.id ?? firstMarket?.conditionId ?? question);

  const description = stringOrNull(row.description);
  const volume24hUsd = Number(row.volume24hr ?? row.volume ?? NaN);
  const liquidityUsd = Number(row.liquidity ?? NaN);
  const gameStartTime = normalizeGammaTimestamp(
    eventMarkets.find((m) => m.gameStartTime)?.gameStartTime,
  );
  const eventExtras = {
    description,
    volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : null,
    liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : null,
    gameStartTime,
  };

  if (isMultiOutcome) {
    const outcomes = eventMarkets
      .map((market) => mapLeadingOutcome(market))
      .filter((outcome): outcome is PmOutcome => outcome !== null)
      .sort((a, b) => b.pricePct - a.pricePct)
      .slice(0, 4);
    if (outcomes.length === 0) return null;
    const related = eventMarkets
      .map((m) => {
        const out = mapLeadingOutcome(m);
        if (!out) return null;
        const id = String(m.id ?? m.conditionId ?? '');
        if (!id || id === eventId) return null;
        return { id, question: out.label, pricePct: out.pricePct };
      })
      .filter((r): r is { id: string; question: string; pricePct: number } => r !== null)
      .slice(0, 12);
    return {
      id: eventId,
      question,
      outcomes,
      closesAt,
      imageUrl,
      category,
      tags,
      isNegRisk,
      isMultiOutcome,
      related,
      ...eventExtras,
    };
  }

  if (!firstMarket) return null;
  const mapped = mapMarket(firstMarket, {
    id: eventId,
    question,
    closesAt,
    imageUrl,
    category,
    tags,
    isNegRisk,
    isMultiOutcome,
  });
  if (!mapped) return null;
  return { ...mapped, ...eventExtras };
}

function mapMarket(row: GammaMarket, meta?: EventMarketMeta): PmMarket | null {
  if (!row || typeof row !== 'object') return null;
  const question = meta?.question ?? stringOrNull(row.question) ?? stringOrNull(row.title) ?? '';
  if (!question) return null;

  const labels = parseStringArray(row.outcomes);
  const prices = parseStringArray(row.outcomePrices);
  const tokenIds = parseStringArray(row.clobTokenIds ?? row.tokenIds);
  if (labels.length === 0) return null;

  const marketId = String(row.id ?? row.conditionId ?? question);
  const outcomes: PmOutcome[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label) continue;
    const raw = prices[i];
    const price = raw === undefined ? NaN : Number(raw);
    // Gamma prices are 0..1 probabilities; render as a rounded percent.
    const pricePct = Number.isFinite(price) ? Math.round(price * 100) : 0;
    outcomes.push({
      label,
      pricePct,
      marketId,
      conditionId: row.conditionId,
      tokenId: tokenIds[i] ?? null,
    });
  }
  if (outcomes.length === 0) return null;

  const id = meta?.id ?? marketId;
  const closesAt = meta?.closesAt ?? row.endDate ?? row.endDateIso ?? null;
  return {
    id,
    question,
    outcomes,
    closesAt,
    imageUrl: meta?.imageUrl ?? stringOrNull(row.image) ?? stringOrNull(row.icon),
    category: meta?.category ?? categoryLabel(row.category),
    tags: meta?.tags ?? tagLabels(row.tags),
    isNegRisk: meta?.isNegRisk ?? boolish(row.negRisk),
    isMultiOutcome: meta?.isMultiOutcome ?? false,
  };
}

function mapLeadingOutcome(row: GammaMarket): PmOutcome | null {
  const labels = parseStringArray(row.outcomes);
  const prices = parseStringArray(row.outcomePrices);
  const tokenIds = parseStringArray(row.clobTokenIds ?? row.tokenIds);
  if (labels.length === 0) return null;

  const yesIndex = labels.findIndex((label) => label.trim().toLowerCase() === 'yes');
  const index = yesIndex >= 0 ? yesIndex : bestPriceIndex(prices);
  const marketId = String(row.id ?? row.conditionId ?? row.question ?? '');
  if (!marketId) return null;
  const label =
    stringOrNull(row.groupItemTitle) ??
    stringOrNull(row.title) ??
    compactQuestionLabel(row.question) ??
    labels[index] ??
    null;
  if (!label) return null;

  const price = Number(prices[index] ?? NaN);
  return {
    label,
    pricePct: Number.isFinite(price) ? Math.round(price * 100) : 0,
    marketId,
    conditionId: row.conditionId,
    tokenId: tokenIds[index] ?? null,
  };
}

function bestPriceIndex(prices: string[]): number {
  let bestIndex = 0;
  let best = Number.NEGATIVE_INFINITY;
  prices.forEach((raw, index) => {
    const price = Number(raw);
    if (Number.isFinite(price) && price > best) {
      best = price;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function compactQuestionLabel(question: string | undefined): string | null {
  const value = stringOrNull(question);
  if (!value) return null;
  return value
    .replace(/^will\s+/i, '')
    .replace(/\?$/, '')
    .trim() || null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Gamma timestamps come in two shapes: ISO ("2026-07-03T05:40:00Z") and the
 * SQL-ish "2026-07-03 05:40:00+00" used by sports `gameStartTime`. Normalize
 * both to ISO; null when unparseable. Exported for spec coverage.
 */
export function normalizeGammaTimestamp(raw: string | undefined): string | null {
  const value = stringOrNull(raw);
  if (!value) return null;
  const candidate = value.includes('T') ? value : value.replace(' ', 'T').replace(/\+00$/, 'Z');
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function boolish(value: boolean | string | undefined): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}

function categoryLabel(value: GammaMarket['category']): string | null {
  if (typeof value === 'string') return stringOrNull(value);
  return stringOrNull(value?.label) ?? stringOrNull(value?.name);
}

function tagLabels(tags: GammaMarket['tags']): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => stringOrNull(tag.label) ?? stringOrNull(tag.name) ?? stringOrNull(tag.slug))
    .filter((tag): tag is string => tag !== null);
}

/**
 * Accept either a real array or Gamma's JSON-encoded string form
 * (e.g. "[\"Yes\",\"No\"]"). Returns [] on anything unparseable.
 */
function parseStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function demo(): PmMarket[] {
  return DEMO_MARKETS.map((m) => ({
    ...m,
    outcomes: m.outcomes.map((o) => ({ ...o })),
  }));
}

export const polymarket = new PolymarketAdapter();

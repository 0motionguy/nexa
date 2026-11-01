/**
 * Yields landscape — per-asset "best yield" aggregator.
 *
 * Fans out across:
 *   1. First-party adapters we already custody / can route deposits through:
 *        Morpho (USDC on Base), Aave v3 (USDC on Base), Compound III (USDC on Base),
 *        yoUSD (USDC on Base), Ethena (sUSDe — informational), Marinade (SOL),
 *        Jupiter Lend (USDC + USDT on Solana — informational).
 *   2. DefiLlama Yields API (`https://yields.llama.fi/pools`) — the only free,
 *      no-auth, cross-protocol firehose that covers WBTC/cbBTC/wETH supply
 *      rates across every chain. We use it ONLY for assets/venues where we
 *      don't have a first-party adapter, so the rate is read fresh per asset
 *      without proliferating duplicate REST clients per chain.
 *
 * Output: one row per supported asset (USDC, USDT, SOL, BTC, ETH, sUSDe-equiv)
 * showing the top three venues by APY, with:
 *   - whether NEXA can deposit on-platform (first-party adapter) or only
 *     deep-link the user to the venue's own page
 *   - TVL signal (so the UI can mark "thin liquidity" warnings)
 *   - source URL for the user to read more
 *
 * The route layer caches this snapshot for 60s — DefiLlama refreshes hourly
 * and our adapters poll on-chain reads which are expensive at scale.
 */

import { env } from '../env.js';
import { log } from '../log.js';

export type LandingAsset = 'USDC' | 'USDT' | 'SOL' | 'BTC' | 'ETH' | 'sUSDe';

export type DepositMode =
  | 'native'              // first-party adapter — we can deposit on-platform
  | 'deeplink'            // read-only tile — user opens the venue's own page
  | 'informational';      // listed for comparison only — no CTA wired yet

export interface YieldRow {
  asset: LandingAsset;
  venue: string;
  chain: string;
  apyBps: number;
  apyBaseBps: number | null;
  apyRewardBps: number | null;
  tvlUsd: number | null;
  /** Where the user goes (deep-link) — null when handled by NEXA's own deposit route. */
  url: string | null;
  /** How NEXA can interact with this venue. */
  mode: DepositMode;
  /** Sortable risk hint: lower = safer / more battle-tested. */
  riskBand: 'A' | 'B' | 'C';
  /** Optional verbatim warning the UI should surface alongside the row. */
  note?: string;
}

export interface AssetLanding {
  asset: LandingAsset;
  /** Sorted by APY desc, top 3. Includes both native + deeplink venues. */
  picks: YieldRow[];
  /** Highest APY pick, regardless of mode. Equal to picks[0]. */
  bestApyBps: number;
  /** The highest-APY pick where mode === 'native' — what the user can
   *  actually do in-app right now. Null when no native venue is available
   *  for this asset (e.g. BTC, ETH today). UI surfaces this as a secondary
   *  row so deeplink-only top picks always have an in-app counterpoint. */
  bestNative: YieldRow | null;
  readAt: string;
}

interface LlamaPool {
  chain?: string;
  project?: string;
  symbol?: string;
  tvlUsd?: number;
  apy?: number;
  apyBase?: number;
  apyReward?: number;
  pool?: string;
  url?: string;
}

interface LlamaResponse {
  status?: string;
  data?: LlamaPool[];
}

const DEFAULT_LLAMA_URL = 'https://yields.llama.fi/pools';

/* Minimum TVL per asset before a pool is recommendable. Thin pools have
   inflated APY (a $3k pool with $100 of rewards/year prints 1700% APY) and
   can vanish under any sized deposit — surfacing them in the landing would
   actively mislead users. Numbers are calibrated to "you could meaningfully
   deposit without moving the rate". */
const ASSET_TVL_FLOOR_USD: Record<LandingAsset, number> = {
  USDC: 5_000_000,   // $5M — the smallest reputable USDC pool
  USDT: 5_000_000,
  SOL:  1_000_000,
  BTC:  5_000_000,
  ETH:  5_000_000,
  sUSDe: 1_000_000,
};

/* Per-asset filter rules over the DefiLlama feed. We're conservative: only
   include protocols + chains we're willing to recommend, filter "supply 0%
   APY" collateral rows, AND require meaningful TVL so we don't surface
   bait-rate pools that can't absorb a real deposit.
   Underscore-prefixed because the public landing has been flipped to
   native-only (2026-06-22 product call); these filters stay defined so an
   admin / explore view can re-use them, or so we can re-enable deeplinks
   when each non-native venue gains its own adapter. */
const _ASSET_FILTERS: Record<LandingAsset, (p: LlamaPool) => boolean> = {
  USDC: (p) =>
    /^usdc(\.e)?$/i.test(p.symbol ?? '') &&
    (p.apy ?? 0) > 0.1 &&
    (p.tvlUsd ?? 0) >= ASSET_TVL_FLOOR_USD.USDC,
  USDT: (p) => /^usdt$/i.test(p.symbol ?? '') && (p.apy ?? 0) > 0.1 && (p.tvlUsd ?? 0) >= ASSET_TVL_FLOOR_USD.USDT,
  SOL:  (p) => /^sol$/i.test(p.symbol ?? '') && (p.apy ?? 0) > 0.1 && (p.tvlUsd ?? 0) >= ASSET_TVL_FLOOR_USD.SOL,
  BTC:  (p) => /^(wbtc|cbbtc|tbtc|lbtc)$/i.test(p.symbol ?? '') && (p.apy ?? 0) > 0.01 && (p.tvlUsd ?? 0) >= ASSET_TVL_FLOOR_USD.BTC,
  ETH:  (p) => /^(weth|eth)$/i.test(p.symbol ?? '') && (p.apy ?? 0) > 0.1 && (p.tvlUsd ?? 0) >= ASSET_TVL_FLOOR_USD.ETH,
  sUSDe: (p) => /^susde$/i.test(p.symbol ?? '') && (p.apy ?? 0) > 0.1 && (p.tvlUsd ?? 0) >= ASSET_TVL_FLOOR_USD.sUSDe,
};

/* Venues we're happy to surface. A whitelist beats a blacklist because new
   protocols launch every week and many are unverified / honeypot-adjacent.
   Underscore-prefixed for the same reason as _ASSET_FILTERS above — kept
   defined for future re-enable of deeplinks once each venue has a native
   adapter (or for an admin/explore view). */
const _VENUE_WHITELIST = new Set([
  'aave-v3',
  'aave-v2',
  'morpho-blue',
  'morpho-vault',
  'compound-v3',
  'compound-iii',
  'spark',
  'fluid-lending',
  'fluid',
  'jupiter-lend',
  'kamino-lend',
  'marginfi',
  'save-finance',
  'solend',
  'yo-protocol',
  'sky-savings-rate',
  'sky-lending',
  'ethena-usde',
  'ethena',
]);

/* Risk bands: A = battle-tested ($100M+ TVL years, multiple audits),
   B = established but younger (Morpho-V2, Spark, Fluid, Jupiter Lend),
   C = newer or known incident (Save = post-Solend incident, smaller pools). */
const VENUE_RISK: Record<string, 'A' | 'B' | 'C'> = {
  'aave-v3': 'A',
  'aave-v2': 'A',
  'compound-v3': 'A',
  'compound-iii': 'A',
  'morpho-blue': 'B',
  'morpho-vault': 'B',
  'spark': 'B',
  'sky-savings-rate': 'B',
  'sky-lending': 'B',
  'fluid-lending': 'B',
  'fluid': 'B',
  'jupiter-lend': 'B',
  'kamino-lend': 'B',
  'marginfi': 'B',
  'yo-protocol': 'B',
  'ethena': 'B',
  'ethena-usde': 'B',
  'save-finance': 'C',
  'solend': 'C',
};

function bpsFromDecimal(d: number | null | undefined): number | null {
  if (d == null || !Number.isFinite(d)) return null;
  // DefiLlama returns APY as a percent (0..100), not a 0..1 decimal.
  return Math.round(d * 100);
}

function prettyVenue(project: string): string {
  return project
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

// Kept defined alongside _ASSET_FILTERS / _VENUE_WHITELIST for the same
// "we may re-surface deeplinks later when each has a native adapter" reason.
function _llamaToYieldRow(p: LlamaPool, asset: LandingAsset, mode: DepositMode): YieldRow {
  const project = (p.project ?? '').toLowerCase();
  const apyBps = bpsFromDecimal(p.apy) ?? 0;
  const note: string | undefined =
    VENUE_RISK[project] === 'C'
      ? 'Smaller TVL or post-incident venue — size cautiously.'
      : undefined;
  return {
    asset,
    venue: prettyVenue(p.project ?? 'Unknown'),
    chain: p.chain ?? 'unknown',
    apyBps,
    apyBaseBps: bpsFromDecimal(p.apyBase),
    apyRewardBps: bpsFromDecimal(p.apyReward),
    tvlUsd: typeof p.tvlUsd === 'number' ? p.tvlUsd : null,
    url: p.url ?? null,
    mode,
    riskBand: VENUE_RISK[project] ?? 'C',
    ...(note ? { note } : {}),
  };
}

export async function fetchLlamaPools(opts: {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
} = {}): Promise<LlamaPool[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? env.DEFILLAMA_YIELDS_URL ?? DEFAULT_LLAMA_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'yields-landscape: DefiLlama returned non-200');
      return [];
    }
    const body = (await res.json().catch(() => null)) as LlamaResponse | null;
    if (!body || !Array.isArray(body.data)) {
      log.warn({ }, 'yields-landscape: DefiLlama returned empty data array');
      return [];
    }
    return body.data;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'yields-landscape: DefiLlama fetch failed — empty landscape',
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function pickTopN(rows: YieldRow[], n: number): YieldRow[] {
  return [...rows].sort((a, b) => b.apyBps - a.apyBps).slice(0, n);
}

/**
 * Build the landing snapshot. The first-party adapter rates are passed in
 * so the orchestrator stays pure — the route layer is responsible for
 * fanning out to the right APY readers and resolving them in parallel.
 */
export interface FirstPartyApy {
  asset: LandingAsset;
  venue: string;
  chain: string;
  apyBps: number;
  tvlUsd: number | null;
  /** When true, the user can earn through NEXA's own deposit flow. */
  hasNativeDeposit: boolean;
  /** Optional deep-link if we don't have native deposit. */
  url?: string;
  riskBand?: 'A' | 'B' | 'C';
}

export function buildLandingFromSources(
  firstParty: FirstPartyApy[],
  llamaPools: LlamaPool[],
): AssetLanding[] {
  const readAt = new Date().toISOString();
  const assets: LandingAsset[] = ['USDC', 'USDT', 'SOL', 'BTC', 'ETH', 'sUSDe'];

  return assets.map((asset) => {
    const firstPartyRows: YieldRow[] = firstParty
      .filter((p) => p.asset === asset)
      .map((p) => ({
        asset,
        venue: p.venue,
        chain: p.chain,
        apyBps: p.apyBps,
        apyBaseBps: null,
        apyRewardBps: null,
        tvlUsd: p.tvlUsd,
        url: p.url ?? null,
        mode: p.hasNativeDeposit ? 'native' : 'deeplink',
        riskBand: p.riskBand ?? 'B',
      }));

    // Native-only landing surface — DefiLlama-sourced rows are intentionally
    // NOT included as deeplinks. Product call 2026-06-22: every row in the
    // earn landing must be something NEXA can deposit through natively. If
    // an asset has no native adapter yet, its `picks` array is empty (UI
    // renders a "Coming soon" placeholder for that asset). New native
    // venues land here only when their adapter exposes depositUsd/withdrawUsd.
    const nativeOnlyRows = firstPartyRows.filter((r) => r.mode === 'native');
    const all = pickTopN(nativeOnlyRows, 3);
    const bestNative = nativeOnlyRows.sort((a, b) => b.apyBps - a.apyBps)[0] ?? null;
    // `llamaPools` is still fetched (we may surface it elsewhere — e.g. an
    // "Explore" tab or admin-only competitive view) but is excluded from the
    // user-facing landing on purpose.
    void llamaPools;
    return {
      asset,
      picks: all,
      bestApyBps: all[0]?.apyBps ?? 0,
      bestNative,
      readAt,
    };
  });
}

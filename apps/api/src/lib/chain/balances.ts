/**
 * Multi-chain USDC balance reads (Sprint 19).
 *
 * Powers the /balances aggregate that the Trade-tab Portfolio reads from.
 * Per-chain `eth_call` against the native USDC contract for EVM legs;
 * `getTokenAccountsByOwner` against the SPL USDC mint for Solana.
 *
 * All reads are best-effort + bounded — if a chain RPC is unreachable, that
 * chain's leg returns 0 with a warn log rather than failing the whole
 * portfolio response. Tests can stub these via process.env['VITEST'].
 *
 * RPC URLs (defaults are public endpoints; override via env in production):
 *   - ARBITRUM_RPC_URL  (default: https://arb1.arbitrum.io/rpc)
 *   - POLYGON_RPC_URL   (default: https://polygon-bor-rpc.publicnode.com)
 *   - BASE_RPC_URL      (default: https://mainnet.base.org)
 *   - OPTIMISM_RPC_URL  (default: https://mainnet.optimism.io)
 *   - SOLANA_RPC_URL / HELIUS_RPC_URL  (default: https://api.mainnet-beta.solana.com)
 */

import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { arbitrum, base, polygon } from 'viem/chains';
import { env } from '../env.js';
import { log } from '../log.js';
import { USDC_BY_CHAIN } from './cctp.js';
import type { Chain } from '../bridge-router.js';
import { hyperliquidSpot } from '../markets/hyperliquid-spot.js';

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

const DEFAULT_RPC: Partial<Record<Chain, string>> = {
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://mainnet.base.org',
};

function rpcUrlFor(chain: Chain): string | undefined {
  switch (chain) {
    case 'arbitrum':
      return env.ARBITRUM_RPC_URL ?? DEFAULT_RPC.arbitrum;
    case 'polygon':
      return env.POLYGON_RPC_URL ?? DEFAULT_RPC.polygon;
    case 'base':
      return env.BASE_RPC_URL ?? DEFAULT_RPC.base;
    default:
      return undefined;
  }
}

function viemChainFor(chain: Chain) {
  switch (chain) {
    case 'arbitrum': return arbitrum;
    case 'polygon': return polygon;
    case 'base': return base;
    default: return undefined;
  }
}

/** USDC has 6 decimals on every chain we care about. atoms → USD float. */
function usdcAtomsToUsd(atoms: bigint): number {
  // Use string conversion to avoid bigint→number precision loss on huge balances.
  const s = atoms.toString();
  if (s.length <= 6) return Number(atoms) / 1_000_000;
  const whole = s.slice(0, s.length - 6);
  const frac = s.slice(-6);
  return Number(whole) + Number(frac) / 1_000_000;
}

/**
 * Per-chain RPC timeout. Public RPCs can hang; viem's default has no upper
 * bound for the round-trip. 5s is generous for balanceOf (single static call).
 */
const RPC_TIMEOUT_MS = 5000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * USDC balance on a single EVM chain for a 0x address. Returns USD float, or
 * **null when the read failed** (RPC error/timeout/unregistered chain).
 *
 * Scale plan 1.3 (2026-07-02): failures used to return 0 — on a money app a
 * public-RPC 429 silently rendered a $0 balance. Null lets the aggregate
 * serve the last-known-good value with an explicit `degraded` flag instead.
 */
export async function getUsdcEvmBalance(chain: Chain, address: Hex): Promise<number | null> {
  if (process.env['VITEST']) return 0;
  const usdcAddress = USDC_BY_CHAIN[chain];
  const rpcUrl = rpcUrlFor(chain);
  const viemChain = viemChainFor(chain);
  if (!usdcAddress || !rpcUrl || !viemChain) {
    log.warn({ chain }, 'balances: chain not in EVM USDC registry');
    return null;
  }
  try {
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS }),
    });
    const atoms = (await withTimeout(
      client.readContract({
        address: usdcAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
      }) as Promise<bigint>,
      RPC_TIMEOUT_MS,
      `${chain} USDC.balanceOf`,
    ));
    return usdcAtomsToUsd(atoms);
  } catch (e) {
    log.warn(
      { chain, address, err: e instanceof Error ? e.message : String(e) },
      'balances: USDC balanceOf failed',
    );
    return null;
  }
}

/**
 * pUSD — Polymarket's collateral token ("Polymarket USD", 6 decimals,
 * verified on-chain 2026-07-03): a 1:1 ERC-20 wrapper over USDC.e minted
 * via the CollateralOnramp. All CLOB trading settles in pUSD, so a user who
 * wrapped (or received sell proceeds) holds pUSD, not USDC.e — the
 * predictions bucket must count BOTH or wrapped funds render as $0.
 * Source: docs.polymarket.com/concepts/pusd.md + clob-client-v2 config.
 */
const PUSD_POLYGON: Hex = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

/**
 * Bridged USDC.e — the ONLY asset Polymarket's CollateralOnramp wraps
 * (docs.polymarket.com/concepts/pusd.md, verified 2026-07-05). CCTP delivers
 * NATIVE USDC (`USDC_BY_CHAIN.polygon` = 0x3c499c…), so a depositor
 * mid-funnel legitimately holds native, USDC.e, or pUSD.
 */
const USDCE_POLYGON: Hex = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** balanceOf(token) on Polygon → USD float, null on failure (STRICT). */
async function polygonTokenUsd(
  rpcUrl: string,
  token: Hex,
  address: Hex,
  label: string,
): Promise<number | null> {
  try {
    const client = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS }),
    });
    const atoms = await withTimeout(
      client.readContract({
        address: token,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
      }) as Promise<bigint>,
      RPC_TIMEOUT_MS,
      label,
    );
    return usdcAtomsToUsd(atoms);
  } catch (e) {
    log.warn(
      { address, err: e instanceof Error ? e.message : String(e) },
      `balances: ${label} failed`,
    );
    return null;
  }
}

/**
 * Predictions leg = native USDC + USDC.e + pUSD on Polygon (deposit-lane
 * close-out 2026-07-05: CCTP delivers native, the onramp wraps USDC.e, the
 * CLOB settles pUSD — the bucket must count all three or deposits render $0
 * mid-funnel). Fails STRICT: if any read fails the whole leg is null
 * (last-known-good + degraded) — reporting a partial sum as fresh would
 * silently understate a money balance.
 */
export async function getPolygonPredictionsBalance(address: Hex): Promise<number | null> {
  if (process.env['VITEST']) return 0;
  const rpcUrl = rpcUrlFor('polygon');
  if (!rpcUrl) return null;
  const [native, usdce, pusd] = await Promise.all([
    getUsdcEvmBalance('polygon', address),
    polygonTokenUsd(rpcUrl, USDCE_POLYGON, address, 'polygon USDC.e balanceOf'),
    polygonTokenUsd(rpcUrl, PUSD_POLYGON, address, 'polygon pUSD.balanceOf'),
  ]);
  if (native === null || usdce === null || pusd === null) return null;
  return native + usdce + pusd;
}

/** SPL USDC mint on Solana mainnet. */
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * USDC SPL balance for a Solana base58 address. Returns USD float.
 * Sums across ALL token accounts owned by the address with the USDC mint
 * (most wallets have exactly one, but ATA + non-ATA can coexist).
 *
 * Hardened with the same 5s timeout as EVM reads — public mainnet-beta can
 * be slow under load.
 */
export async function getUsdcSolanaBalance(address: string): Promise<number | null> {
  if (process.env['VITEST']) return 0;
  // `??` doesn't fall back on empty strings, but our .env-loader passes empty
  // strings for unset keys. Use `||` so HELIUS_RPC_URL='' falls through to
  // SOLANA_RPC_URL and ultimately the public mainnet default.
  const rpcUrl = env.HELIUS_RPC_URL || env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  try {
    const web3 = await import('@solana/web3.js');
    const connection = new web3.Connection(rpcUrl, { commitment: 'confirmed' });
    const owner = new web3.PublicKey(address);
    const mint = new web3.PublicKey(SOLANA_USDC_MINT);
    const accounts = await withTimeout(
      connection.getParsedTokenAccountsByOwner(owner, { mint }),
      RPC_TIMEOUT_MS,
      'solana getParsedTokenAccountsByOwner',
    );
    let total = 0;
    for (const a of accounts.value) {
      const info = a.account.data.parsed?.info as
        | { tokenAmount?: { uiAmount?: number | null } }
        | undefined;
      total += info?.tokenAmount?.uiAmount ?? 0;
    }
    return total;
  } catch (e) {
    // Solana RPC errors often come back as non-JSON 4xx responses. Surface
    // the prefix so log readers can spot 401/429 patterns at a glance.
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(
      { address, err: msg.slice(0, 200) },
      'balances: Solana USDC balance fetch failed',
    );
    return null;
  }
}

export interface PortfolioBalances {
  totalUsd: number;
  buckets: {
    perps: { usd: number; chain: 'arbitrum'; sources: { arbitrum: number; hyperliquidSpot: number } };
    predictions: { usd: number; chain: 'polygon' };
    memes: { usd: number; chain: 'solana' };
    cash: { usd: number; chain: 'base' };
  };
  byChain: {
    arbitrum: number;
    polygon: number;
    base: number;
    solana: number;
    hyperliquidSpot: number;
  };
  wallets: {
    evm: string;
    solana: string;
  };
  live: boolean;
  /** Set when this payload came from the short-lived in-memory cache. */
  cached?: boolean;
  /**
   * Scale plan 1.3 — set when ≥1 chain read failed this cycle and its value
   * was served from the last-known-good snapshot (or 0 if never read). A
   * money app must never render a silent fake $0.
   */
  degraded?: boolean;
  /** The chains whose values are stale/last-known-good this cycle. */
  staleChains?: string[];
}

/** Per-chain leg results: number = fresh read, null = read failed this cycle. */
export interface BalanceLegs {
  arbitrum: number | null;
  polygon: number | null;
  base: number | null;
  solana: number | null;
  hyperliquidSpot: number | null;
}

/**
 * Pure merge of this cycle's leg reads with the last-known-good snapshot.
 * Failed legs (null) fall back to the previous value for that chain (or 0
 * when none exists) and are reported in `staleChains` + `degraded`.
 * Exported for unit tests.
 */
export function mergePortfolioLegs(
  legs: BalanceLegs,
  lastGood: PortfolioBalances | undefined,
  wallets: { evm: string; solana: string },
): PortfolioBalances {
  const staleChains: string[] = [];
  const resolve = (key: keyof BalanceLegs): number => {
    const fresh = legs[key];
    if (fresh !== null) return fresh;
    staleChains.push(key);
    return lastGood?.byChain[key] ?? 0;
  };
  const arb = resolve('arbitrum');
  const poly = resolve('polygon');
  const baseUsd = resolve('base');
  const sol = resolve('solana');
  const hlSpot = resolve('hyperliquidSpot');
  const perpsUsd = arb + hlSpot;
  const totalUsd = perpsUsd + poly + baseUsd + sol;
  return {
    totalUsd,
    buckets: {
      perps: { usd: perpsUsd, chain: 'arbitrum', sources: { arbitrum: arb, hyperliquidSpot: hlSpot } },
      predictions: { usd: poly, chain: 'polygon' },
      memes: { usd: sol, chain: 'solana' },
      cash: { usd: baseUsd, chain: 'base' },
    },
    byChain: { arbitrum: arb, polygon: poly, base: baseUsd, solana: sol, hyperliquidSpot: hlSpot },
    wallets,
    live: !process.env['VITEST'],
    ...(staleChains.length > 0 ? { degraded: true, staleChains } : {}),
  };
}

/**
 * In-memory cache for /balances. Per-user keyed; 10s TTL. Cuts RPC volume
 * by ~90% for users polling the Trade Portfolio. Survives a single API
 * process only — fine because each process trivially recomputes on miss.
 *
 * Cache key includes both wallet addresses so a wallet rotation (rare) busts
 * automatically. No explicit invalidator — the 10s TTL is short enough that
 * a freshly-completed transfer becomes visible within one tab refresh.
 */
interface CacheEntry {
  expiresAt: number;
  /** Wall-clock of the fan-out that produced `payload` — bounds the SWR window. */
  fetchedAt: number;
  payload: PortfolioBalances;
}
const balancesCache = new Map<string, CacheEntry>();
// Scale plan 1.3 — 10s → 30s: NEO polls portfolio every 15-30s per user, so a
// 30s TTL collapses each user's polling to ≤1 RPC fan-out per window without
// making a completed transfer feel slow (client refetch after mutations
// invalidates by hitting the route anyway; a fresh window follows within 30s).
const BALANCES_TTL_MS = 30_000;

/**
 * Stale-while-revalidate window (reconnect/latency hardening 2026-07-19,
 * HANDOVER-2026-07-19-RPC-PARITY): between TTL expiry and this bound we
 * answer from the retained snapshot INSTANTLY and refresh behind the
 * response — the authed p95 driver was cold fan-outs paying the slowest
 * vendor leg inline. Past the window (user went idle) the read blocks as
 * before, so a returning session never sees minutes-old money.
 */
const BALANCES_SWR_MS = 60_000;

/** Coalesce concurrent fan-outs per wallet pair — one RPC storm, N awaiters. */
const inflightReads = new Map<string, Promise<PortfolioBalances>>();

/**
 * Last-known-good snapshot per wallet pair — retained past the TTL so a
 * failing RPC serves yesterday's truth flagged `degraded` instead of a fake
 * $0. Bounded with the same sweep as the TTL cache.
 */
const lastGoodCache = new Map<string, PortfolioBalances>();

function cacheKey(evmAddress: string, solanaAddress: string): string {
  return `${evmAddress.toLowerCase()}::${solanaAddress}`;
}

/** Test/admin hook: drop every cached payload (e.g. on wallet rotation). */
export function clearBalancesCache(): void {
  balancesCache.clear();
  lastGoodCache.clear();
  inflightReads.clear();
}

async function getHyperliquidSpotUsdcBalance(address: Hex): Promise<number | null> {
  try {
    const state = await hyperliquidSpot.getUserState(address);
    return Number.isFinite(state.usdcUsd) && state.usdcUsd > 0 ? state.usdcUsd : 0;
  } catch (e) {
    log.warn(
      { address, err: e instanceof Error ? e.message : String(e) },
      'balances: Hyperliquid Spot USDC balance fetch failed',
    );
    return null;
  }
}

/**
 * Fan-out USDC balance reads across every chain in the portfolio. All chains
 * are queried in parallel; one slow leg doesn't block the others.
 *
 * Three-layer read path (2026-07-19 hardening):
 *   1. In-memory 30s TTL keyed on the wallet pair (cuts RPC volume).
 *   2. Stale-while-revalidate to BALANCES_SWR_MS: an expired-but-recent
 *      snapshot answers instantly, the fan-out refreshes behind the
 *      response. `forceFresh` opts money-movement callers out of layer 2 —
 *      they must never validate against the stale path.
 *   3. Concurrent misses coalesce onto ONE inflight fan-out; per-chain
 *      timeout (RPC_TIMEOUT_MS) caps tail latency on the true cold path.
 *
 * `live` = true outside Vitest. Even default RPC URLs hit real mainnet
 * providers; Vitest stubs those reads to zero.
 */
export async function readPortfolioBalances(
  args: {
    evmAddress: Hex;
    solanaAddress: string;
  },
  opts?: {
    /**
     * Skip the stale-while-revalidate serve (layer 2). TTL-fresh cache hits
     * are still returned — identical to the pre-SWR contract every caller
     * had. Set this on reads that gate money movement.
     */
    forceFresh?: boolean;
  },
): Promise<PortfolioBalances> {
  const key = cacheKey(args.evmAddress, args.solanaAddress);
  const now = Date.now();
  const hit = balancesCache.get(key);
  if (hit && hit.expiresAt > now) {
    return { ...hit.payload, cached: true };
  }
  // SWR: the entry outlived its TTL but the wallet was read recently —
  // answer from the snapshot NOW, refresh behind the response. This is what
  // takes the authed portfolio path off the slowest vendor leg
  // (HANDOVER-2026-07-19-RPC-PARITY: authed p95 pinned at 937ms by inline
  // cold fan-outs).
  if (!opts?.forceFresh && hit && now - hit.fetchedAt <= BALANCES_SWR_MS) {
    void refreshPortfolioBalances(key, args).catch((err: unknown) => {
      log.debug({ err }, 'balances: background revalidate failed — snapshot stands');
    });
    return { ...hit.payload, cached: true };
  }
  return refreshPortfolioBalances(key, args);
}

/**
 * The actual fan-out — all chains in parallel, merged against last-known-
 * good, cached. Coalesced: concurrent misses for the same wallet pair share
 * ONE read (reconnect bursts previously ran a full RPC storm each).
 */
function refreshPortfolioBalances(
  key: string,
  args: { evmAddress: Hex; solanaAddress: string },
): Promise<PortfolioBalances> {
  const inflight = inflightReads.get(key);
  if (inflight) return inflight;
  const read = (async (): Promise<PortfolioBalances> => {
    const [arb, poly, baseUsd, sol, hyperliquidSpotUsd] = await Promise.all([
      getUsdcEvmBalance('arbitrum', args.evmAddress),
      // Predictions = USDC.e + pUSD (Polymarket's collateral wrapper) — a user
      // who wrapped for trading still sees their full bucket.
      getPolygonPredictionsBalance(args.evmAddress),
      getUsdcEvmBalance('base', args.evmAddress),
      getUsdcSolanaBalance(args.solanaAddress),
      getHyperliquidSpotUsdcBalance(args.evmAddress),
    ]);
    const payload = mergePortfolioLegs(
      { arbitrum: arb, polygon: poly, base: baseUsd, solana: sol, hyperliquidSpot: hyperliquidSpotUsd },
      lastGoodCache.get(key),
      { evm: args.evmAddress, solana: args.solanaAddress },
    );
    const done = Date.now();
    balancesCache.set(key, { expiresAt: done + BALANCES_TTL_MS, fetchedAt: done, payload });
    // The merged payload carries the best-known value per chain, so it IS the
    // next last-known-good snapshot (stale legs keep their previous values).
    lastGoodCache.set(key, payload);
    // Bounded growth: if cache somehow leaks (e.g. address churn), evict the
    // oldest 25% when over 500 entries. Cheap O(n) sweep amortized.
    if (balancesCache.size > 500) {
      const sorted = [...balancesCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < Math.floor(sorted.length / 4); i++) {
        balancesCache.delete(sorted[i]![0]);
        lastGoodCache.delete(sorted[i]![0]);
      }
    }
    return payload;
  })();
  const tracked = read.finally(() => {
    // Guard: clearBalancesCache() may have dropped us mid-flight and a newer
    // read may already be tracked — never delete someone else's entry.
    if (inflightReads.get(key) === tracked) inflightReads.delete(key);
  });
  inflightReads.set(key, tracked);
  return tracked;
}

// Scale plan 1.3 — dedicated RPC keys exist in env; surface (once, at boot)
// any production chain still riding a public default so ops sees exactly
// which env var to set. Public endpoints 429 under portfolio fan-out and
// were the projected first breakage at ~400 concurrent viewers.
if (env.NODE_ENV === 'production' && !process.env['VITEST']) {
  const publicDefaults: string[] = [];
  if (!env.ARBITRUM_RPC_URL) publicDefaults.push('ARBITRUM_RPC_URL');
  if (!env.POLYGON_RPC_URL) publicDefaults.push('POLYGON_RPC_URL');
  if (!env.BASE_RPC_URL) publicDefaults.push('BASE_RPC_URL');
  if (!(env.HELIUS_RPC_URL || env.SOLANA_RPC_URL || env.CHAINSTACK_SOLANA_RPC_URL)) {
    publicDefaults.push('SOLANA_RPC_URL');
  }
  if (publicDefaults.length > 0) {
    log.warn(
      { missing: publicDefaults },
      'balances: production is reading these chains via PUBLIC rpc defaults — set dedicated keys before scale',
    );
  }
}

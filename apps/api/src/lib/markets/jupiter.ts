/**
 * Jupiter adapter — Solana DEX aggregation.
 *
 * Two surfaces:
 *   1. Read — Token API v2 (`/tokens/v2/...`) for enrichment with USD price,
 *      market cap, organic score, tags. Used to enrich pump.fun discovery
 *      data with stable price + a broader meme universe (BONK, WIF, etc.).
 *   2. Write — Swap API v1 (`/swap/v1/quote` + `/swap/v1/swap`) for routing
 *      and execution. Trades route through every Solana DEX Jupiter indexes,
 *      including PumpSwap so bonding-curve pump.fun tokens trade through one
 *      signing path with migrated tokens.
 *
 * Live trading requires features.markets + features.privy + a user with a
 * Privy Solana embedded wallet (auto-provisioned via walletService).
 *
 * Docs: https://developers.jup.ag
 */

import { randomBytes } from 'node:crypto';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import { resolveSolanaRpcUrl } from '../chain/solana-tx.js';
import { signSolanaTransactionWithPrivy } from '../privy.js';
import { ProviderRateLimitError, throwIfProviderRateLimited } from './provider-errors.js';
import { normalizeIpfsUrl } from './ipfs-url.js';

/**
 * Jupiter API host. Keyless traffic rides the shared `lite-api.jup.ag` pool
 * (heavily rate-limited — live /quote 429 storms, 2026-07-06); setting
 * `JUPITER_API_KEY` moves everything to `api.jup.ag` with the key in
 * `x-api-key` (https://dev.jup.ag/docs/api-setup).
 */
function jupiterBase(): string {
  return env.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
}

function jupiterHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    accept: 'application/json',
    ...(env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {}),
    ...(extra ?? {}),
  };
}

/** SPL Token-2022 program id — see {@link JupiterAdapter.usesToken2022}. */
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuE';

/** Quote cache tuning — fresh window, stale-serve window, entry cap. */
const QUOTE_FRESH_MS = 3_000;
const QUOTE_STALE_MS = 30_000;
const QUOTE_CACHE_MAX = 256;

/**
 * Platform fee NEXA collects on every Jupiter swap, in basis points.
 * Driven by env so we can dial the rate without redeploying. Set to 50
 * (0.50%) in production for memes + xStocks; Jupiter caps at 100 bps.
 * Fee is collected in the OUTPUT token at JUPITER_PLATFORM_FEE_ACCOUNT
 * (the receiver's ATA for that mint, or a wSOL ATA for SOL outputs).
 */
function nexaPlatformFeeBps(): number {
  return env.JUPITER_PLATFORM_FEE_BPS ?? 0;
}
function nexaFeeAccount(): string | null {
  return env.JUPITER_PLATFORM_FEE_ACCOUNT ?? null;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupTokenStats {
  priceChange1h?: number | null;
  priceChange24h?: number | null;
  volume24hUsd?: number | null;
  numBuys24h?: number | null;
  numSells24h?: number | null;
}

export interface JupToken {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  decimals: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  organicScoreLabel: 'high' | 'medium' | 'low' | 'unknown' | null;
  isVerified: boolean;
  tags: string[];
  stats: JupTokenStats;
}

interface JupRawStats {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
}

interface JupRawToken {
  id?: string;
  symbol?: string;
  name?: string;
  icon?: string;
  decimals?: number;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  holderCount?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  tags?: string[];
  stats1h?: JupRawStats;
  stats24h?: JupRawStats;
}

type MarketDataSource = 'live' | 'provider-demo';

export interface JupListResult {
  source: MarketDataSource;
  tokens: JupToken[];
}

export interface JupPriceMap {
  [mint: string]: { priceUsd: number | null; priceChange24h: number | null };
}

export interface JupQuoteRequest {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  slippageBps?: number;
}

export interface JupQuoteResponse {
  ok: true;
  /** Raw Jupiter quote — pass back to /swap as `quoteResponse`. */
  quote: unknown;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: Array<{ label: string }>;
}

export type JupSwapResult =
  | {
      ok: true;
      signature: string;
      confirmed: boolean;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      demo: false;
    }
  | { ok: true; signature: string; confirmed: false; inputMint: string; outputMint: string; inAmount: string; outAmount: string; demo: true };

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function mapStats(raw: JupRawStats | undefined): { priceChange: number | null; volume: number | null; numBuys: number | null; numSells: number | null } {
  if (!raw) return { priceChange: null, volume: null, numBuys: null, numSells: null };
  const buy = typeof raw.buyVolume === 'number' ? raw.buyVolume : 0;
  const sell = typeof raw.sellVolume === 'number' ? raw.sellVolume : 0;
  const volume = buy + sell > 0 ? buy + sell : null;
  return {
    priceChange: typeof raw.priceChange === 'number' ? raw.priceChange : null,
    volume,
    numBuys: typeof raw.numBuys === 'number' ? raw.numBuys : null,
    numSells: typeof raw.numSells === 'number' ? raw.numSells : null,
  };
}

function mapToken(raw: JupRawToken | null | undefined): JupToken | null {
  if (!raw?.id || !raw?.symbol) return null;
  const decimals = typeof raw.decimals === 'number' ? raw.decimals : 9;
  const stats1h = mapStats(raw.stats1h);
  const stats24h = mapStats(raw.stats24h);
  const labelRaw = (raw.organicScoreLabel ?? '').toLowerCase();
  const organicScoreLabel: JupToken['organicScoreLabel'] =
    labelRaw === 'high' || labelRaw === 'medium' || labelRaw === 'low'
      ? labelRaw
      : labelRaw
      ? 'unknown'
      : null;
  return {
    mint: raw.id,
    symbol: raw.symbol,
    name: raw.name?.trim() || raw.symbol,
    // Jupiter metadata still carries Cloudflare's dead IPFS gateways for
    // pump-era tokens — rewrite onto a live one (ERR_NAME_NOT_RESOLVED, 2026-07-06).
    icon: normalizeIpfsUrl(raw.icon?.trim() || null),
    decimals,
    priceUsd: typeof raw.usdPrice === 'number' ? raw.usdPrice : null,
    marketCapUsd: typeof raw.mcap === 'number' ? raw.mcap : null,
    fdvUsd: typeof raw.fdv === 'number' ? raw.fdv : null,
    liquidityUsd: typeof raw.liquidity === 'number' ? raw.liquidity : null,
    holderCount: typeof raw.holderCount === 'number' ? raw.holderCount : null,
    organicScoreLabel,
    isVerified: raw.isVerified === true,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    stats: {
      priceChange1h: stats1h.priceChange,
      priceChange24h: stats24h.priceChange,
      volume24hUsd: stats24h.volume,
      numBuys24h: stats24h.numBuys,
      numSells24h: stats24h.numSells,
    },
  };
}

const DEMO_TOKENS: readonly JupToken[] = [
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', icon: null, decimals: 5, priceUsd: 0.00002, marketCapUsd: 1_300_000_000, fdvUsd: null, liquidityUsd: 50_000_000, holderCount: 700_000, organicScoreLabel: 'high', isVerified: true, tags: ['meme', 'verified'], stats: { priceChange1h: null, priceChange24h: 1.2, volume24hUsd: 20_000_000, numBuys24h: null, numSells24h: null } },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', name: 'dogwifhat', icon: null, decimals: 6, priceUsd: 2.6, marketCapUsd: 2_500_000_000, fdvUsd: null, liquidityUsd: 80_000_000, holderCount: 220_000, organicScoreLabel: 'high', isVerified: true, tags: ['meme', 'verified'], stats: { priceChange1h: null, priceChange24h: -3.1, volume24hUsd: 35_000_000, numBuys24h: null, numSells24h: null } },
];

function demoTokens(): JupToken[] {
  return DEMO_TOKENS.map((t) => ({ ...t, stats: { ...t.stats }, tags: [...t.tags] }));
}

export class JupiterAdapter {
  /** quote() memo — see QUOTE_FRESH_MS / QUOTE_STALE_MS / QUOTE_CACHE_MAX. */
  private quoteCache = new Map<string, { at: number; value: JupQuoteResponse }>();
  private quoteInFlight = new Map<string, Promise<JupQuoteResponse | null>>();
  /** mint → owning token program id (immutable on-chain, cached forever). */
  private mintOwnerCache = new Map<string, string | null>();

  /** Test hook — drops memoized quotes + mint owners. */
  _resetCachesForTests(): void {
    this.quoteCache.clear();
    this.quoteInFlight.clear();
    this.mintOwnerCache.clear();
  }

  get isLive(): boolean {
    return features.markets;
  }

  get isLiveTrading(): boolean {
    return Boolean(features.markets && features.privy && features.jupiterSwaps && features.solanaRpc);
  }

  /**
   * Token list by tag. Jupiter v2 supports `?query=` with a single tag value:
   * `verified` (full ~4k set), `launchpad` (pump.fun-launched, etc.). Multi-tag
   * comma queries return 400 — for memes we filter the verified set in-memory.
   */
  async list(opts: { tag?: string; limit?: number; offset?: number } = {}): Promise<JupListResult> {
    if (!this.isLive) return { source: 'provider-demo', tokens: demoTokens() };
    const tag = (opts.tag ?? 'verified').trim();
    const lower = tag.toLowerCase();
    const isMemeQuery = lower === 'meme' || lower === 'memes';
    const upstreamTag = isMemeQuery ? 'verified' : tag;
    const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 200)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    try {
      const url = `${jupiterBase()}/tokens/v2/tag?query=${encodeURIComponent(upstreamTag)}`;
      const res = await httpRequest(url, {
        vendor: 'jupiter',
        method: 'GET',
        headers: jupiterHeaders(),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        log.warn({ status: res.status, tag: upstreamTag }, 'jupiter: tag query rejected');
        return { source: 'provider-demo', tokens: demoTokens() };
      }
      const data = (await res.json().catch(() => null)) as JupRawToken[] | null;
      if (!Array.isArray(data) || data.length === 0) {
        return { source: 'provider-demo', tokens: demoTokens() };
      }
      const mapped = data
        .map(mapToken)
        .filter((t): t is JupToken => t !== null);
      // `meme` isn't queryable upstream — filter the verified set in-memory.
      const filtered = isMemeQuery
        ? mapped.filter((t) => t.tags.map((x) => x.toLowerCase()).includes('meme'))
        : mapped;
      const sorted = filtered.sort((a, b) => (b.stats.volume24hUsd ?? 0) - (a.stats.volume24hUsd ?? 0));
      const sliced = sorted.slice(offset, offset + limit);
      return { source: 'live', tokens: sliced };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), tag: upstreamTag },
        'jupiter: list unreachable — demo fallback',
      );
      return { source: 'provider-demo', tokens: demoTokens() };
    }
  }

  /**
   * Search by symbol / name / mint. Returns up to `limit` matches with the
   * same enrichment as `list`. Used to enrich a pump.fun discovery row with
   * Jupiter's stable USD price + tags.
   */
  async search(query: string, limit = 8): Promise<JupToken[]> {
    if (!this.isLive) return demoTokens().slice(0, limit);
    const q = query.trim();
    if (!q) return [];
    try {
      const url = `${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(q)}&limit=${limit}`;
      const res = await httpRequest(url, {
        vendor: 'jupiter',
        method: 'GET',
        headers: jupiterHeaders(),
        timeoutMs: 6_000,
        maxAttempts: 2,
      });
      if (!res.ok) return [];
      const data = (await res.json().catch(() => null)) as JupRawToken[] | null;
      return Array.isArray(data)
        ? data.map(mapToken).filter((t): t is JupToken => t !== null)
        : [];
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), query: q },
        'jupiter: search failed',
      );
      return [];
    }
  }

  /**
   * Spot price + 24h change for a batch of mints. Used by the frontend
   * polling hook to patch live prices into a viewport-budgeted set.
   * Batches input mints in chunks of 50 to stay under URL length limits.
   */
  async prices(mints: string[]): Promise<JupPriceMap> {
    if (!this.isLive || mints.length === 0) return {};
    const seen = new Set<string>();
    const cleaned = mints
      .map((m) => m?.trim())
      .filter((m): m is string => Boolean(m) && !seen.has(m) && (seen.add(m), true));
    const out: JupPriceMap = {};
    const CHUNK = 50;
    for (let i = 0; i < cleaned.length; i += CHUNK) {
      const chunk = cleaned.slice(i, i + CHUNK);
      try {
        // Use the token search by id list — it returns full token records
        // including current price + 24h price change. Lighter than calling
        // search() per mint and matches the structure of `list()`.
        const url = `${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(chunk.join(','))}`;
        const res = await httpRequest(url, {
          vendor: 'jupiter',
          method: 'GET',
          headers: jupiterHeaders(),
          timeoutMs: 6_000,
          maxAttempts: 1,
        });
        if (!res.ok) continue;
        const data = (await res.json().catch(() => null)) as JupRawToken[] | null;
        if (!Array.isArray(data)) continue;
        for (const raw of data) {
          if (!raw?.id) continue;
          out[raw.id] = {
            priceUsd: typeof raw.usdPrice === 'number' ? raw.usdPrice : null,
            priceChange24h: typeof raw.stats24h?.priceChange === 'number' ? raw.stats24h.priceChange : null,
          };
        }
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), chunkSize: chunk.length },
          'jupiter: prices chunk failed',
        );
      }
    }
    return out;
  }

  /** Single-token fetch — used by the detail screen. */
  async getToken(mint: string): Promise<JupToken | null> {
    const results = await this.search(mint, 1);
    return results[0] ?? null;
  }

  /**
   * Swap quote. Returns the raw Jupiter quote envelope plus the highlights
   * the UI needs (in/out amount, price impact, route labels). The same
   * envelope is passed back to `swap()` verbatim — Jupiter expects an
   * unaltered quoteResponse on /swap.
   */
  async quote(input: JupQuoteRequest): Promise<JupQuoteResponse | null> {
    if (!this.isLive) return null;
    const slippage = Math.max(1, Math.min(5000, Math.floor(input.slippageBps ?? 300)));
    const feeBps = nexaPlatformFeeBps();
    const platformFeeBps = feeBps > 0 && nexaFeeAccount() ? feeBps : 0;
    // Hot path — the buy sheet re-quotes on every amount change and the free
    // lite-api tier 429s under that load (live storm 2026-07-06). A 3s fresh
    // TTL + in-flight coalescing collapses identical quotes to one upstream
    // call, and a ≤30s stale quote serves through rate-limit windows.
    const key = [input.inputMint, input.outputMint, input.amountAtomic, slippage, platformFeeBps].join('|');
    const now = Date.now();
    const hit = this.quoteCache.get(key);
    if (hit && now - hit.at <= QUOTE_FRESH_MS) return hit.value;
    const inFlight = this.quoteInFlight.get(key);
    if (inFlight) return inFlight;
    const pending = this.fetchQuote(input, slippage, platformFeeBps)
      .then((value) => {
        if (value) this.storeQuote(key, value);
        return value;
      })
      .catch((e) => {
        if (e instanceof ProviderRateLimitError && hit && now - hit.at <= QUOTE_STALE_MS) {
          log.warn({ inputMint: input.inputMint, outputMint: input.outputMint }, 'jupiter: rate limited — serving stale quote');
          return hit.value;
        }
        throw e;
      })
      .finally(() => {
        this.quoteInFlight.delete(key);
      });
    this.quoteInFlight.set(key, pending);
    return pending;
  }

  /** FIFO-capped insert — Map iterates in insertion order. */
  private storeQuote(key: string, value: JupQuoteResponse): void {
    if (this.quoteCache.size >= QUOTE_CACHE_MAX && !this.quoteCache.has(key)) {
      const oldest = this.quoteCache.keys().next().value;
      if (oldest !== undefined) this.quoteCache.delete(oldest);
    }
    this.quoteCache.set(key, { at: Date.now(), value });
  }

  private async fetchQuote(
    input: JupQuoteRequest,
    slippageBps: number,
    platformFeeBps: number,
  ): Promise<JupQuoteResponse | null> {
    const params = new URLSearchParams({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amount: input.amountAtomic,
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: 'true',
    });
    if (platformFeeBps > 0) {
      params.set('platformFeeBps', String(platformFeeBps));
    }
    try {
      const res = await httpRequest(`${jupiterBase()}/swap/v1/quote?${params.toString()}`, {
        vendor: 'jupiter',
        method: 'GET',
        headers: jupiterHeaders(),
        timeoutMs: 8_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        throwIfProviderRateLimited(res, 'jupiter');
        log.warn({ status: res.status, input }, 'jupiter: quote rejected');
        return null;
      }
      const quote = (await res.json().catch(() => null)) as {
        inAmount?: string;
        outAmount?: string;
        priceImpactPct?: string;
        routePlan?: Array<{ swapInfo?: { label?: string } }>;
      } | null;
      if (!quote || !quote.outAmount) return null;
      return {
        ok: true,
        quote,
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        inAmount: quote.inAmount ?? input.amountAtomic,
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct ?? '0',
        routePlan: (quote.routePlan ?? []).map((step) => ({
          label: step.swapInfo?.label ?? 'unknown',
        })),
      };
    } catch (e) {
      if (e instanceof ProviderRateLimitError) throw e;
      log.warn(
        { err: e instanceof Error ? e.message : String(e), input },
        'jupiter: quote failed',
      );
      return null;
    }
  }

  /**
   * Owning token program for a mint (immutable on-chain → cached). Null when
   * no RPC is configured or the read fails.
   */
  private async mintOwnerProgram(mint: string): Promise<string | null> {
    if (mint === SOL_MINT) return null; // native SOL wrap — classic SPL path
    if (this.mintOwnerCache.has(mint)) return this.mintOwnerCache.get(mint) ?? null;
    const rpcUrl = resolveSolanaRpcUrl();
    if (!rpcUrl) return null;
    try {
      const web3 = await import('@solana/web3.js');
      const connection = new web3.Connection(rpcUrl, 'confirmed');
      const info = await connection.getAccountInfo(new web3.PublicKey(mint));
      const owner = info?.owner?.toBase58() ?? null;
      this.mintOwnerCache.set(mint, owner);
      return owner;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), mint },
        'jupiter: mint owner lookup failed',
      );
      return null;
    }
  }

  /**
   * True when the mint is owned by SPL Token-2022. Falls back to the
   * pump.fun vanity suffix (`…pump`) when the RPC read is unavailable —
   * disabling shared accounts is always valid, just less account-efficient,
   * so the heuristic only ever errs safe.
   */
  private async usesToken2022(mint: string): Promise<boolean> {
    const owner = await this.mintOwnerProgram(mint);
    if (owner !== null) return owner === TOKEN_2022_PROGRAM_ID;
    return /pump$/i.test(mint);
  }

  /**
   * Execute a swap. Pipeline: ask Jupiter for the signed-ready
   * `swapTransaction` (VersionedTransaction, base64), sign it with the
   * user's Privy Solana wallet via the message hash, broadcast on Solana
   * mainnet, return the signature.
   *
   * Demo path returns a synthetic `jup_demo_*` signature so the route + store
   * flow stay exercisable.
   */
  async swap(input: {
    privyWalletId: string | null;
    userPublicKey: string | null;
    quote: unknown;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
  }): Promise<JupSwapResult> {
    if (!this.isLiveTrading || !input.privyWalletId || !input.userPublicKey) {
      return {
        ok: true,
        signature: 'jup_demo_' + hex(16),
        confirmed: false,
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        inAmount: input.inAmount,
        outAmount: input.outAmount,
        demo: true,
      };
    }

    // Build the swap tx via Jupiter. When platform fee is enabled, pass
    // the NEXA fee account so Jupiter inserts the fee transfer instruction
    // into the assembled tx. Jupiter routes the fee in the OUTPUT token.
    const feeBps = nexaPlatformFeeBps();
    const feeAccount = nexaFeeAccount();
    const collectsFee = feeBps > 0 && feeAccount !== null;
    // Token-2022 legs (pump.fun-era mints) cannot route through Jupiter's
    // shared program accounts — simulation dies inside the Token-2022
    // program with 6014/0x177e `IncorrectTokenProgramID` (live-tested on
    // ANSEM, 2026-07-06). Detect by mint owner and drop to per-user accounts.
    const [inputToken2022, outputToken2022] = await Promise.all([
      this.usesToken2022(input.inputMint),
      this.usesToken2022(input.outputMint),
    ]);
    const useSharedAccounts = !(inputToken2022 || outputToken2022);
    const swapBody: Record<string, unknown> = {
      quoteResponse: input.quote,
      userPublicKey: input.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Auto priority fee — Jupiter computes from recent fees + network
      // congestion. Capped via `prioritizationFeeLamports.maxLamports`.
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 5_000_000,
          priorityLevel: 'high',
        },
      },
    };
    if (collectsFee) {
      swapBody.feeAccount = feeAccount;
    }
    if (!useSharedAccounts) {
      swapBody.useSharedAccounts = false;
      log.info(
        { inputMint: input.inputMint, outputMint: input.outputMint },
        'jupiter: token-2022 leg — shared accounts disabled',
      );
    }
    let swapTransaction: string | null;
    try {
      const res = await httpRequest(`${jupiterBase()}/swap/v1/swap`, {
        vendor: 'jupiter',
        method: 'POST',
        headers: jupiterHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(swapBody),
        timeoutMs: 12_000,
        maxAttempts: 2,
      });
      if (!res.ok) {
        throwIfProviderRateLimited(res, 'jupiter');
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'jupiter: swap build rejected');
        throw new Error('swap_build_rejected');
      }
      const data = (await res.json().catch(() => null)) as { swapTransaction?: string } | null;
      swapTransaction = data?.swapTransaction ?? null;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'jupiter: swap build failed',
      );
      throw e;
    }
    if (!swapTransaction) throw new Error('swap_build_empty');

    const rpcUrl = resolveSolanaRpcUrl();
    if (!rpcUrl) throw new Error('rpc_unavailable');

    // Sign the full VersionedTransaction (purpose-built Privy signTransaction —
    // the signMessage path produced signatures that don't verify) and broadcast.
    try {
      const web3 = await import('@solana/web3.js');
      const txBytes = Buffer.from(swapTransaction, 'base64');
      const versionedTx = web3.VersionedTransaction.deserialize(txBytes);
      const signed = await signSolanaTransactionWithPrivy(input.privyWalletId, versionedTx);
      if (!signed) throw new Error('privy_signature_unavailable');
      // signedTransaction is a VersionedTransaction (or a base64 string per SDK
      // version); normalize to the raw wire bytes for broadcast.
      const rawSigned =
        typeof signed === 'string'
          ? Buffer.from(signed, 'base64')
          : (signed as InstanceType<typeof web3.VersionedTransaction>).serialize();

      const connection = new web3.Connection(rpcUrl, 'confirmed');
      const signature = await connection.sendRawTransaction(rawSigned, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      // Best-effort confirm; the signature is the authoritative receipt.
      let confirmed = false;
      try {
        const result = await Promise.race([
          connection.confirmTransaction(signature, 'confirmed'),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
        ]);
        confirmed = result !== 'timeout' && result.value.err == null;
      } catch {
        // confirm threw — tx may still land; signature is the receipt.
      }
      return {
        ok: true,
        signature,
        confirmed,
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        inAmount: input.inAmount,
        outAmount: input.outAmount,
        demo: false,
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'jupiter: swap sign+send failed',
      );
      throw e;
    }
  }
}

export const jupiter = new JupiterAdapter();
export const JUPITER_SOL_MINT = SOL_MINT;

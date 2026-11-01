/**
 * NEXA API client — thin typed fetch wrapper with session-token storage.
 *
 * Base resolution:
 *   dev   → /api (vite proxy → localhost:8090)
 *   prod  -> https://api.maze.bank
 *
 * The app runs LIVE when a session token exists and /auth/me answers;
 * otherwise it falls back to the local in-page ledger (offline/demo).
 */

import type { z } from 'zod';
import type {
  ApiKey,
  ApiKeyCreated,
  BridgeTransfer,
  CheckoutView,
  Offer,
  PayInput,
  PayoutMethod,
  PayoutMethodCreateInput,
} from '@nexa/shared-zod';

/** Create input on the *wire* — fields with schema defaults are optional here
 * (the API applies them). z.input reflects that; z.infer (OfferInput) does not.
 * The schema is referenced in a type-only position so nothing is bundled. */
export type OfferCreateInput = z.input<typeof import('@nexa/shared-zod').OfferInput>;

/**
 * Sprint 16 — same-origin /api is the right default everywhere now. Caddy
 * proxies maze.aiso.tools/api/* → neobank-api:8090, so the bundle works on
 * any host that fronts the same Caddy. `VITE_NEXA_API_BASE` still wins when
 * set (cross-origin previews, local API on a different port).
 */
const configuredApiBase = import.meta.env.VITE_NEXA_API_BASE?.trim().replace(/\/+$/, '');
function defaultApiBase(): string {
  if (typeof window === 'undefined') return '/api';
  const host = window.location.hostname.toLowerCase();
  if (host === 'maze.bank' || host.endsWith('.maze.bank')) return 'https://api.maze.bank';
  return '/api';
}
export const API_BASE: string = configuredApiBase || defaultApiBase();

const TOKEN_KEY = 'nexa.session';
/**
 * C1 — localStorage breadcrumb, NOT a credential. The real session lives in
 * the httpOnly `nexa_session` cookie (XSS-unreadable); the Bearer mirror in
 * sessionStorage dies with the tab. This flag only records "a session was
 * minted here once" so a fresh PWA launch knows whether the cookie-resume
 * probe (POST /auth/refresh) is worth one round trip. First-time visitors
 * skip the probe and paint the sign-in screen instantly.
 */
const SESSION_HINT_KEY = 'nexa.hasSession';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode — session-less fallback */
  }
  try {
    if (token) localStorage.setItem(SESSION_HINT_KEY, '1');
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    /* private mode */
  }
}

/** True when a session was minted on this device and never explicitly ended. */
export function hasSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export interface ApiError {
  ok: false;
  error: string | { code?: string; message?: string; details?: unknown };
  message?: string;
}

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function shouldResetMarketOrderAttempt(e: unknown): boolean {
  if (!(e instanceof ApiFailure)) return false;
  if (e.code === 'order_recording_pending' || e.code === 'order_in_progress') return false;
  if (e.code === 'venue_order_failed' || e.code === 'idempotency_key_used') return true;
  if (e.status >= 500 || e.status === 409) return false;
  return true;
}

export function authMePathForBrowserPath(
  pathname = typeof window === 'undefined' ? '' : window.location.pathname,
): string {
  return pathname === '/claim' || pathname.startsWith('/claim/') ? '/auth/me?claim=1' : '/auth/me';
}

function retryAfterMsFromHeader(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function failureFromBody(
  status: number,
  data: Partial<ApiError>,
  fallbackMessage: string,
  retryAfterMs?: number,
): ApiFailure {
  const error = data.error;
  if (error && typeof error === 'object') {
    const details = error.details;
    const policyCode =
      details && typeof details === 'object' && 'policyCode' in details
        ? String((details as { policyCode: unknown }).policyCode)
        : null;
    return new ApiFailure(
      status,
      policyCode ?? error.code ?? 'request_failed',
      error.message ?? fallbackMessage,
      details,
      retryAfterMs,
    );
  }
  return new ApiFailure(
    status,
    typeof error === 'string' ? error : 'request_failed',
    data.message ?? fallbackMessage,
    undefined,
    retryAfterMs,
  );
}

async function parseApiResponseBody<T>(res: Response): Promise<T & Partial<ApiError>> {
  const text = await res.text();
  if (!text) return {} as T & Partial<ApiError>;
  try {
    return JSON.parse(text) as T & Partial<ApiError>;
  } catch {
    return {
      ok: false,
      error: { code: 'request_failed', message: text || res.statusText },
      message: text || res.statusText,
    } as T & Partial<ApiError>;
  }
}

/**
 * F043 — when the server says 401, clear the stale session token and
 * broadcast a navigation request so the host page can route to s01 (the
 * sign-in screen). Custom event keeps this lib decoupled from the router.
 * `auth/me` is the only path that LEGITIMATELY 401s in normal use (boot
 * before sign-in); the caller handles that by passing noAuth or catching.
 */
function handleAuthFailure(): void {
  setToken(null);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nexa:auth-required', { detail: { reason: '401' } }));
  }
}

/**
 * F043 — retry policy for idempotent verbs (GET/HEAD) on transient failures
 * (5xx, network error, timeout). Bounded at 3 attempts with 200/400 ms
 * back-off. Non-idempotent verbs (POST/PATCH/DELETE) NEVER retry — they
 * could double-debit.
 */
const MAX_ATTEMPTS_IDEMPOTENT = 3;

function isIdempotentMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || (status >= 500 && status < 600);
}

async function api<T>(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
    timeoutMs?: number;
    noAuth?: boolean;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
  const maxAttempts = isIdempotentMethod(method) ? MAX_ATTEMPTS_IDEMPOTENT : 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 6000);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(init?.headers ?? {}) };
      const token = getToken();
      if (token && !init?.noAuth) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(API_BASE + path, {
        method,
        headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : null,
        signal: ctrl.signal,
      });
      const data = await parseApiResponseBody<T>(res);
      const retryAfterMs = retryAfterMsFromHeader(res.headers.get('Retry-After'));
      if (res.status === 401 && !init?.noAuth) {
        handleAuthFailure();
        throw failureFromBody(res.status, data, 'Session expired.', retryAfterMs);
      }
      if (!res.ok || data.ok === false) {
        if (isRetryableStatus(res.status) && attempt < maxAttempts) {
          lastError = failureFromBody(res.status, data, 'Request failed.', retryAfterMs);
          // fall through to retry below
        } else {
          throw failureFromBody(res.status, data, 'Request failed.', retryAfterMs);
        }
      } else {
        return data;
      }
    } catch (e) {
      // AbortError / network error / 5xx retryable wrapper above
      if (e instanceof ApiFailure && !isRetryableStatus(e.status)) throw e;
      if (attempt >= maxAttempts) throw e;
      lastError = e;
    } finally {
      window.clearTimeout(timer);
    }
    // Exponential backoff before the next attempt.
    await new Promise((r) => window.setTimeout(r, 200 * attempt));
  }
  // Should be unreachable, but TS needs a definite return.
  throw lastError ?? new Error('api: exhausted retries with no recorded error');
}

function clientIdempotencyKey(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}:${id}`;
}

/* ── typed surface (the subset the app consumes) ── */

export interface ServerActivity {
  id: string;
  n: string;
  s: string;
  a: string;
  k: string;
  pos?: boolean;
  logo?: string;
  at: string;
  status?: 'pending' | 'submitted' | 'confirmed' | 'failed' | string;
  venue?: string;
  signer?: string;
  txHash?: string;
  chain?: string;
  explorerUrl?: string;
}

export interface ServerAgent {
  id: string;
  name: string;
  state: string;
  balanceUsd: number;
  spentTodayUsd: number;
  policy: { perDayCapUsd: number; perTxCapUsd: number; endpointAllowlist: string[] };
}

export interface EarnConfigPatch {
  earnByDefault?: boolean;
  autoDivestOnSpend?: boolean;
  divestThresholdUsd?: number;
}

export interface EarnConfig {
  earnByDefault: boolean;
  autoDivestOnSpend: boolean;
  divestThresholdUsd: number;
}

export interface SpendMonthlyResponse {
  ok: true;
  month: string;
  totalUsd: number;
  categories: Array<{ key: string; label: string; totalUsd: number }>;
}

/**
 * Phase 1 earn router — the user picks one of two tiers; the API resolves
 * each tier to a concrete adapter at request time.
 *   'standard'     → Morpho (Steakhouse-curated USDC vault on Base)
 *   'higher_yield' → highest risk-weighted APY across yoUSD/Aave/Compound/Morpho
 */
export type VaultTier = 'standard' | 'higher_yield';
type SwapChainWire = 'base' | 'gnosis' | 'polygon' | 'optimism' | 'arbitrum' | 'solana';
type SwapTokenWire = 'USDC' | 'EURC' | 'EURe' | 'USDT' | 'SOL' | 'mSOL';
type SwapSourceWire = 'socket' | 'lifi' | 'mayan' | 'demo';
export type EarnAdapterName =
  | 'morpho'
  | 'morpho-high-yield'
  | 'yousd'
  | 'aave'
  | 'compound'
  | 'marinade'
  | 'ethena';
export interface EarnAdapterSummary {
  name: EarnAdapterName;
  apyBps: number;
  isLive: boolean;
  available: boolean;
  /** Sprint 15 — source envelope for badge rendering. */
  sourced?: SourcedValueMetaWire;
}

export interface MeResponse {
  ok: true;
  user: { id: string; email: string; name: string };
  /** eurUsd — EUR cash (EURC) credited by Swap; rendered under Total balance
   *  whenever it is > 0 so a USD→EUR swap never reads as vanished money. */
  balance: { balUsd: number; eurUsd?: number; earnUsd: number; earnApy: number };
  earnConfig?: EarnConfig;
}

type PortfolioBucket = 'cash' | 'perps' | 'predictions' | 'memes' | 'stocks-spot';
export interface PortfolioBalancesResponse {
  ok: true;
  totalUsd: number;
  buckets: Record<PortfolioBucket, { usd: number; chain: string; sources?: Record<string, number> }>;
  byChain: Record<string, number>;
  wallets: { evm: string; solana: string };
}

/* ── /transfers — bucket→bucket cross-chain settlement (CCTP / Mayan) ───── */

export type TransferBucketWire = PortfolioBucket;
export type TransferStatusWire =
  | 'created'
  | 'hl_withdrawing'
  | 'burning'
  | 'attesting'
  | 'minting'
  | 'hl_depositing'
  | 'depositing'
  | 'complete'
  | 'failed';
export interface TransferWire {
  id: string;
  fromBucket: TransferBucketWire;
  toBucket: TransferBucketWire;
  fromChain: string;
  toChain: string;
  amountUsd: number;
  rail: 'cctp' | 'mayan' | 'internal' | 'hl_bridge' | string;
  status: TransferStatusWire | string;
  srcTxHash?: string | null;
  dstTxHash?: string | null;
  feesUsd?: number;
  error?: { code: string; message?: string } | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface InternalTransferReceiptWire {
  ok: true;
  transferId: string;
  status: TransferStatusWire | string;
  rail: string;
  fromBucket: TransferBucketWire;
  toBucket: TransferBucketWire;
  /** NET amount the destination receives (gross minus skim). */
  amountUsd: number;
  requestedUsd: number;
  feeUsd: number;
  feeBps: number;
  etaSec: number;
  idempotent: boolean;
  demo: boolean;
}

/** GET /markets/portfolio/summary — every leg fails soft (legs.<name>==='failed'). */
/** A live Hyperliquid clearinghouse position (from getUserState → portfolio
 *  summary). `liquidationPriceUsd` is the venue's authoritative liq price —
 *  null when the venue omits it — vs. the order form's client-side estimate. */
export interface HlLivePositionWire {
  coin: string;
  sideLong: boolean;
  qty: number;
  qtyUsd: number;
  entryPriceUsd: number;
  unrealizedPnlUsd: number;
  leverage: number;
  liquidationPriceUsd: number | null;
}
export interface HlAccountStateWire {
  equityUsd: number;
  marginUsedUsd: number;
  withdrawableUsd: number;
  accountValueUsd: number;
  positions: HlLivePositionWire[];
}
export interface PortfolioSummaryResponse {
  ok: true;
  sourced?: SourcedValueMetaWire;
  legs: Record<'positions' | 'hyperliquid' | 'hyperliquidSpot' | 'hyperliquidHip3' | 'balances', 'ok' | 'failed' | 'no-wallet'> & {
    cash?: 'ok';
  };
  positions: MarketPositionWire[];
  hyperliquid: HlAccountStateWire | null;
  hyperliquidSpot: { usdcUsd: number; balances: Array<{ coin: string; total: number; hold: number }>; live?: boolean } | null;
  hyperliquidHip3: HlAccountStateWire | null;
  balances: Omit<PortfolioBalancesResponse, 'ok'> | null;
  /** App cash ledger — separate accounting world from on-chain (labeled line, not summed). */
  cash?: { balUsd: number; eurUsd: number; earnUsd: number };
}

export interface LiveMeResponse extends MeResponse {
  kycStatus?: 'none' | 'pending' | 'verified' | 'failed' | string;
  card?: {
    last4: string;
    network: string;
    kind: string;
    frozen: boolean;
    dayLimitUsd: number;
    demo?: boolean;
  } | null;
  virtualAccounts?: {
    us?: { number: string | null; routing: string | null } | null;
    eu?: { iban: string | null; bic: string | null } | null;
  };
  wallet?: { baseAddress: string | null; solanaAddress?: string | null };
  earn?: { apyBps: number | null; posUsd: number };
  agents?: { count: number; killSwitch: boolean };
}

export interface HealthzResponse {
  ok: true;
  demo: boolean;
  name: string;
  version: string;
  backend: 'in-memory' | 'postgres';
  db: string;
  redis: string;
  features: { privy: boolean; resend: boolean; chain: boolean; lifi: boolean; push?: boolean };
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface CardResponse {
  ok: true;
  frozen: boolean;
  dayLimitUsd: number;
  last4: string | null;
  network: string | null;
  safeAddress: string | null;
  demo: boolean;
  card: LiveMeResponse['card'];
}

export interface CardsListOptions {
  collection?: string;
  sort?: 'trending' | 'floor' | 'recent' | 'movers';
  cursor?: string;
  limit?: number;
}

export interface CollectorCardWire {
  id: string;
  nftAddress: string;
  name: string;
  imageUrl?: string | null;
  priceUsdc: number;
  collection?: string | null;
  gradeLabel?: string | null;
  tokenStandard: 'Pnft' | 'Cnft' | 'Nft' | 'Core';
  ownerWallet?: string | null;
  listedAt?: string | null;
}

export interface CollectorCardTradeWire {
  id: string;
  side: string;
  nftAddress: string;
  cardId: string;
  name: string | null;
  imageUrl: string | null;
  priceUsdc: number;
  signature: string | null;
  status: string;
  createdAt: string;
}

export interface CardsBuyInput {
  cardId: string;
  nftAddress: string;
  expectedPriceUsdc: number;
  tokenStandard: CollectorCardWire['tokenStandard'];
  name?: string;
  imageUrl?: string;
}

export const nexaApi = {
  authStart: (email: string) =>
    api<{ ok: true; challengeId: string }>('/auth/start', { body: { email } }),
  authVerify: (challengeId: string, code: string) =>
    api<{ ok: true; token: string; user: { id: string; email: string; name: string } }>(
      '/auth/verify',
      { body: { challengeId, code } },
    ),
  me: () => api<MeResponse>(authMePathForBrowserPath()),
  liveMe: () => api<LiveMeResponse>('/ledger/me'),
  balances: () => api<PortfolioBalancesResponse>('/balances'),
  transfers: {
    /** POST /transfers/internal — requires an Idempotency-Key; net/fee split
     *  comes back on the receipt. Money moves take ~90s on CCTP legs. */
    createInternal: (
      body: { fromBucket: TransferBucketWire; toBucket: TransferBucketWire; amountUsd: number },
      opts: { idempotencyKey: string },
    ) =>
      api<InternalTransferReceiptWire>('/transfers/internal', {
        body,
        headers: { 'Idempotency-Key': opts.idempotencyKey },
        // The bridge state machine runs async; the POST itself returns fast
        // but can sit behind wallet provisioning on first use.
        timeoutMs: 20_000,
      }),
    get: (id: string) =>
      api<{ ok: true; transfer: TransferWire; events: Array<{ eventType: string; payload?: unknown; createdAt?: string }> }>(
        `/transfers/${encodeURIComponent(id)}`,
      ),
    list: (limit = 20) => api<{ ok: true; transfers: TransferWire[] }>(`/transfers?limit=${limit}`),
  },
  healthz: () => api<HealthzResponse>('/healthz'),
  authPrivyVerify: (accessToken: string) =>
    api<{ ok: true; token: string; user: { id: string; email: string; name: string } }>(
      '/auth/privy-verify',
      { body: { accessToken } },
    ),
  /**
   * C1 — mint a fresh 30-day token + httpOnly cookie for the current session.
   * `probe: true` is the PWA cold-boot path: no Bearer attached (there is
   * none — sessionStorage died with the old tab; the cookie authenticates)
   * and a 401 throws quietly instead of broadcasting nexa:auth-required.
   */
  authRefresh: (opts?: { probe?: boolean }) =>
    api<{ ok: true; token: string; expiresAt: number; user: { id: string; email: string; name: string } }>(
      '/auth/refresh',
      { method: 'POST', noAuth: opts?.probe === true },
    ),
  /** C1 — clear the httpOnly session cookie server-side (shared devices). */
  authSignout: () => api<{ ok: true }>('/auth/signout', { method: 'POST' }),
  activity: () => api<{ ok: true; activity: ServerActivity[] }>('/ledger/activity'),
  spendMonthly: () => api<SpendMonthlyResponse>('/spend/monthly'),
  pushVapidPublicKey: () => api<{ ok: true; publicKey: string }>('/push/vapid-public-key'),
  pushSubscribe: (subscription: PushSubscriptionPayload) =>
    api<{ ok: true; subscribed: true; id: string }>('/push/subscribe', { body: subscription }),
  pushUnsubscribe: (endpoint: string) =>
    api<{ ok: true; deleted: boolean }>('/push/subscribe', { method: 'DELETE', body: { endpoint } }),
  send: (amountUsd: number, to: string, opts?: { idempotencyKey?: string }) =>
    api<{ ok: true; claim: boolean; claimSlug: string | null; claimUrl: string | null; balUsd: number; activityId: string; message: string }>('/payments/send', {
      body: { amountUsd, to },
      ...(opts?.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
    }),
  topup: (amountUsd: number, label?: string) =>
    api<{ ok: true; balUsd: number }>('/payments/topup', {
      body: label ? { amountUsd, label } : { amountUsd },
    }),
  requestLink: (amountUsd: number, note: string) =>
    api<{ ok: true; url: string }>('/payments/request-link', { body: { amountUsd, note } }),
  /** Sprint 10 Item A — partial-patch user's auto-earn config. */
  configureEarn: (patch: EarnConfigPatch) =>
    api<{ ok: true; config: EarnConfig }>('/earn/configure', { body: patch }),
  earnDeposit: (amountUsd: number, tier?: VaultTier, opts?: { idempotencyKey?: string }) =>
    api<{ ok: true; balUsd: number; earnUsd: number; txHash: string | null; adapter: string | null; source: string }>(
      '/earn/deposit',
      {
        body: tier ? { amountUsd, tier } : { amountUsd },
        ...(opts?.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
      },
    ),
  earnWithdraw: (amountUsd: number, tier?: VaultTier, opts?: { idempotencyKey?: string }) =>
    api<{ ok: true; balUsd: number; earnUsd: number; txHash: string | null; adapter: string | null; source: string }>(
      '/earn/withdraw',
      {
        body: tier ? { amountUsd, tier } : { amountUsd },
        ...(opts?.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
      },
    ),
  /** Phase 1 — protocol comparison view: Standard tier + Higher-Yield tier + blended APY. */
  earnProtocols: () =>
    api<{
      ok: true;
      standard: EarnAdapterSummary;
      higherYield: EarnAdapterSummary;
      blendedApy: number;
      adapters: EarnAdapterSummary[];
      sourced?: SourcedValueMetaWire;
    }>('/earn/protocols'),
  /** Phase 1 — persist the user's vault tier preference (Morpho-standard vs higher-yield). */
  setEarnTier: (tier: VaultTier) =>
    api<{ ok: true; tier: VaultTier }>('/earn/tier', { body: { tier } }),
  /** Ethena sUSDe headline tile — live APY + deposit deep-link (no NEXA custody). */
  earnEthena: () =>
    api<{
      ok: true;
      apyBps: number;
      depositUrl: string;
      riskCopy: string;
      readAt: string;
    }>('/earn/ethena', { method: 'GET' }),
  /** Jupiter Lend headline tile — Solana USDC/USDT supply APY + deep-link. */
  earnJupiterLend: (asset: 'USDC' | 'USDT' = 'USDC') =>
    api<{
      ok: true;
      asset: 'USDC' | 'USDT';
      apyBps: number;
      tvlUsd: number | null;
      depositUrl: string;
      riskCopy: string;
      readAt: string;
    }>(`/earn/jupiter-lend?asset=${asset}`, { method: 'GET' }),
  /** Best-yield landscape — top venues per asset across every integrated source. */
  earnLanding: () =>
    api<{
      ok: true;
      cached?: boolean;
      landscape: Array<{
        asset: 'USDC' | 'USDT' | 'SOL' | 'BTC' | 'ETH' | 'sUSDe';
        picks: Array<EarnLandingPickWire>;
        bestApyBps: number;
        bestNative: EarnLandingPickWire | null;
        readAt: string;
      }>;
    }>('/earn/landing', { method: 'GET' }),
  swapQuote: (input: {
    amount: number;
    direction?: 'usd-eur' | 'eur-usd';
    fromChain?: SwapChainWire;
    toChain?: SwapChainWire;
    fromToken?: SwapTokenWire;
    toToken?: SwapTokenWire;
    enableRefuel?: boolean;
  }) => {
    const q = new URLSearchParams();
    q.set('amount', String(input.amount));
    if (input.direction) q.set('direction', input.direction);
    if (input.fromChain) q.set('fromChain', input.fromChain);
    if (input.toChain) q.set('toChain', input.toChain);
    if (input.fromToken) q.set('fromToken', input.fromToken);
    if (input.toToken) q.set('toToken', input.toToken);
    if (input.enableRefuel !== undefined) q.set('enableRefuel', String(input.enableRefuel));
    return api<{
      ok: true;
      amount: number;
      direction: 'usd-eur' | 'eur-usd';
      fromChain: SwapChainWire;
      toChain: SwapChainWire;
      fromToken: SwapTokenWire;
      toToken: SwapTokenWire;
      rate: number;
      out: number;
      fees: number;
      refuelGasUsd: number | null;
      source: SwapSourceWire;
      sourced?: SourcedValueMetaWire;
    }>(`/swap/quote?${q.toString()}`);
  },
  swapExecute: (
    amount: number,
    direction: 'usd-eur' | 'eur-usd',
    opts?: {
      fromChain?: SwapChainWire;
      toChain?: SwapChainWire;
      fromToken?: SwapTokenWire;
      toToken?: SwapTokenWire;
      enableRefuel?: boolean;
      idempotencyKey?: string;
    },
  ) => {
    const { idempotencyKey, ...bodyOpts } = opts ?? {};
    return api<{
      ok: true;
      out: number;
      rate: number;
      fees: number;
      balUsd: number;
      txHash: string | null;
      source: SwapSourceWire;
    }>('/swap/execute', {
      body: { amount, direction, ...bodyOpts },
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  },
  cardFreeze: (frozen: boolean) =>
    api<{ ok: true; frozen: boolean }>('/card/freeze', { body: { frozen } }),
  cardLimit: (dayLimitUsd: number) =>
    api<{ ok: true; dayLimitUsd: number }>('/card/limit', { body: { dayLimitUsd } }),
  card: () => api<CardResponse>('/card'),
  agents: () => api<{ ok: true; killSwitch: boolean; agents: ServerAgent[] }>('/agent'),
  agentCreate: (name: string, perDayCapUsd: number, perTxCapUsd: number) =>
    api<{ ok: true; agent: ServerAgent }>('/agent/create', {
      body: { name, perDayCapUsd, perTxCapUsd },
    }),
  agentFund: (idOrName: string, amountUsd: number, opts?: { idempotencyKey?: string }) =>
    api<{ ok: true; agent: ServerAgent; balUsd: number }>(
      `/agent/${encodeURIComponent(idOrName)}/fund`,
      {
        body: { amountUsd },
        ...(opts?.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
      },
    ),
  killSwitch: (on: boolean) =>
    api<{ ok: true; killSwitch: boolean }>('/agent/kill-switch', { body: { on } }),
  approveOnce: (
    idOrName: string,
    endpoint: string,
    amountUsd: number,
    reason: string,
    opts?: { idempotencyKey?: string },
  ) =>
    api<{ ok: true }>(`/agent/${encodeURIComponent(idOrName)}/approve-once`, {
      body: { endpoint, amountUsd, reason },
      ...(opts?.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
    }),

  /* ── get-paid facilitator: offers (authed) + hosted checkout (public) ── */

  /** Seller creates a shareable offer. Authed — reuses the Bearer session. */
  createOffer: (input: OfferCreateInput) =>
    api<{ ok: true; offer: Offer }>('/offers', { body: input }),
  /** Seller lists their offers. Authed. */
  listOffers: () => api<{ ok: true; offers: Offer[] }>('/offers'),
  /** Public checkout projection (no seller PII). No auth header sent. */
  getCheckout: (id: string) =>
    api<{ ok: true; checkout: CheckoutView }>(`/checkout/${encodeURIComponent(id)}`, {
      noAuth: true,
    }),
  /**
   * Public checkout pay. When a session token is in storage, it's threaded as
   * the Bearer (the API switches to 'balance' mode and debits balUsd). With no
   * token, the API falls back to 'demo' under DEMO_MODE=1, or rejects 401.
   *
   * Stack upgrades Phase 4 — accepts { method: 'card' } (Stripe redirect) and
   * { method: 'bank_topup' } (Bridge virtual-account wire). Both branches
   * return shape-different bodies; callers discriminate on the `method` field.
   */
  payCheckout: (id: string, body: PayInput) =>
    api<{
      ok: true;
      paymentId?: string;
      status?: 'paid';
      fulfillment?: { kind: 'url' | 'message' | 'none'; value: string | null };
      method?: 'card' | 'bank_topup';
      redirectUrl?: string;
      sessionId?: string;
      demo?: boolean;
      accountNumber?: string | null;
      routingNumber?: string | null;
      bankName?: string;
      livemode?: boolean;
      amountUsd?: number;
      note?: string;
    }>(`/checkout/${encodeURIComponent(id)}/pay`, { body }),

  /** Poll the persisted Stripe session row after Stripe redirects the buyer back
   *  to /checkout/return. Status walks pending → completed | failed | expired.
   *  Sprint 13 COMMIT 5 (SR1) — buyerEmail is required so the public endpoint
   *  can verify the caller knows the email this session was created for. */
  checkoutSessionStatus: (sessionId: string, buyerEmail: string) =>
    api<{
      ok: true;
      sessionId: string;
      status: 'pending' | 'completed' | 'expired' | 'failed';
      amountUsd: number;
      offerId: string;
      completedAt: string | null;
    }>(
      `/checkout/session-status?id=${encodeURIComponent(sessionId)}&buyerEmail=${encodeURIComponent(buyerEmail)}`,
      { noAuth: true },
    ),

  /* ── Sprint 10 Item B — Bridge offramp client methods ── */

  /** List the signed-in user's registered payout destinations. Authed. */
  payoutMethods: () =>
    api<{ ok: true; methods: PayoutMethod[] }>('/bridge/payout-methods'),
  /** Register a new payout destination on the user's Bridge customer. Authed. */
  createPayoutMethod: (input: PayoutMethodCreateInput) =>
    api<{ ok: true; method: PayoutMethod }>('/bridge/payout-method', { body: input }),
  /** Initiate an offramp transfer from balUsd to a registered payout method. */
  bridgeWithdraw: (input: { payoutMethodId: string; amountUsd: number }, opts?: { idempotencyKey?: string }) =>
    api<{ ok: true; transfer: BridgeTransfer }>('/bridge/withdraw', {
      body: input,
      headers: { 'Idempotency-Key': opts?.idempotencyKey ?? clientIdempotencyKey('bridge-withdraw') },
    }),

  /* TradingView snapshot proxy — wraps @mathieuc/tradingview on the API side
     and returns OHLC candles for any TV symbol (e.g. BINANCE:BTCUSDT). Used by
     the s27d market detail chart. Falls back to direct upstream feeds when
     unavailable. */
  tv: {
    snapshot: (symbol: string, timeframe: string, range: number) =>
      api<{
        ok: true;
        source: 'tradingview' | 'tradingview-cache';
        symbol: string;
        timeframe: string;
        infos: { description: string; exchange: string; short_name: string; type: string; currency_id: string; pricescale: number; minmov: number };
        candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
      }>(`/tv/snapshot?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&range=${range}`),
  },

  /* ── Sprint 10 Item E — markets trading (geo-gated server-side) ── */

  markets: {
    positions: () =>
      api<{ ok: true; positions: MarketPositionWire[] }>('/markets/positions'),
    portfolioSummary: () =>
      api<PortfolioSummaryResponse>('/markets/portfolio/summary'),
    cancelOrder: (positionId: string) =>
      api<{ ok: true; position: MarketPositionWire }>(
        `/markets/orders/${encodeURIComponent(positionId)}/cancel`,
        { method: 'POST' },
      ),
    cards: {
      list: (opts?: CardsListOptions) => {
        const params = new URLSearchParams();
        if (opts?.collection) params.set('collection', opts.collection);
        if (opts?.sort) params.set('sort', opts.sort);
        if (opts?.cursor) params.set('cursor', opts.cursor);
        if (opts?.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return api<{
          ok: true;
          items: CollectorCardWire[];
          total?: number;
          cursor?: string | null;
          totalPages?: number;
          sourced?: SourcedValueMetaWire;
        }>(`/markets/cards${qs ? `?${qs}` : ''}`, { noAuth: true });
      },
      collections: () =>
        api<{ ok: true; collections: string[]; sourced?: SourcedValueMetaWire }>(
          '/markets/cards/collections',
          { noAuth: true },
        ),
      detail: (id: string) =>
        api<{ ok: true; card: CollectorCardWire; sourced?: SourcedValueMetaWire }>(
          `/markets/cards/${encodeURIComponent(id)}`,
          { noAuth: true },
        ),
      positions: () =>
        api<{ ok: true; items: CollectorCardWire[]; wallet?: string | null; sourced?: SourcedValueMetaWire }>(
          '/markets/cards/positions',
        ),
      trades: () =>
        api<{ ok: true; trades: CollectorCardTradeWire[] }>('/markets/cards/trades/me'),
      buy: (body: CardsBuyInput, opts?: { idempotencyKey?: string }) =>
        api<{
          ok: true;
          tradeId: string;
          signature: string;
          confirmed: boolean;
          nftAddress: string;
          pricePaidUsdc: number;
          solscanUrl: string;
          sourced?: SourcedValueMetaWire;
        }>('/markets/cards/buy', {
          body,
          ...(opts?.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
        }),
    },

    hyperliquid: {
      /** Sprint 15 — read-only market list (geo-tolerant, public surface). */
      list: () =>
        api<{
          ok: true;
          source: 'hyperliquid' | 'demo';
          sourced?: SourcedValueMetaWire;
          markets: Array<{
            coin: string;
            priceUsd: number;
            change24hPct: number | null;
            maxLeverage?: number | null;
            dayVolumeUsd?: number | null;
            openInterest?: number | null;
            fundingRate?: number | null;
          }>;
        }>('/markets/hyperliquid'),
      candles: (coin: string, opts?: { interval?: string; lookbackMs?: number }) => {
        const params = new URLSearchParams({ coin });
        if (opts?.interval) params.set('interval', opts.interval);
        if (opts?.lookbackMs) params.set('lookback', String(opts.lookbackMs));
        return api<{
          ok: true;
          candles: Array<{ t: number; T: number; o: string; h: string; l: string; c: string; v?: string }>;
        }>(`/markets/hyperliquid/candles?${params.toString()}`);
      },
      orderbook: (coin: string, opts?: { dex?: string }) => {
        const params = new URLSearchParams({ coin });
        if (opts?.dex) params.set('dex', opts.dex);
        return api<{
          ok: true;
          book: { levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>] };
        }>(`/markets/hyperliquid/orderbook?${params.toString()}`);
      },
      recentTrades: (coin: string, opts?: { dex?: string }) => {
        const params = new URLSearchParams({ coin });
        if (opts?.dex) params.set('dex', opts.dex);
        return api<{
          ok: true;
          trades: Array<{ px: string; sz: string; side: 'A' | 'B'; time: number }>;
        }>(`/markets/hyperliquid/recent-trades?${params.toString()}`);
      },
      /**
       * Sprint 16.4 — backend-managed builder agreement state for the current
       * user. `needsApproval` is kept for old clients and should be false.
       */
      builderStatus: () =>
        api<{
          ok: true;
          builder: {
            address: string | null;
            currentFeeTenthsBp: number;
            currentFeeBps: number;
            currentFeeRate: string;
            capBps: number;
            backendManagedAgreement?: boolean;
          };
          user: {
            approved: boolean;
            approvedAt: string | null;
            approvedMaxFeeTenthsBp: number | null;
            agreementCurrent?: boolean;
            hasPrivyWallet: boolean;
          };
          needsApproval: boolean;
        }>('/markets/hyperliquid/builder-status'),
      /**
       * Sprint 16.4 — legacy/manual fallback. Normal users get the
       * `approveBuilderFee` agreement signed by the backend during account
       * setup or the first live HL action.
       */
      approveBuilder: (body: { maxFeeBps?: number } = {}) =>
        api<{
          ok: true;
          builder: { address: string; maxFeeRate: string; maxFeeTenthsBp: number };
          approvedAt: string;
        }>('/markets/hyperliquid/approve-builder', { body }),
      placeOrder: (
        body: {
          coin: string;
          sideLong: boolean;
          qtyUsd: number;
          leverage: number;
          kind?: 'market' | 'limit' | 'stopLimit' | 'twap';
          orderType?: 'market' | 'limit';
          limitPriceUsd?: number;
          triggerPriceUsd?: number;
          stopKind?: 'sl' | 'tp';
          durationMinutes?: number;
          randomize?: boolean;
          tif?: 'Ioc' | 'Gtc' | 'Alo';
          reduceOnly?: boolean;
          takeProfit?: { triggerPriceUsd: number; limitPriceUsd?: number };
          stopLoss?: { triggerPriceUsd: number; limitPriceUsd?: number };
        },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<{
          ok: true;
          order: {
            orderId: string;
            filledQtyUsd: number;
            entryPriceUsd: number;
            demo: boolean;
            state?: 'filled' | 'resting' | 'triggered' | 'twap_active';
            legs?: { tp?: { orderId: string }; sl?: { orderId: string } };
          };
          position: MarketPositionWire;
        }>(
          '/markets/hyperliquid/order',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      cancelOrder: (body: { externalRef: string; coin?: string }, opts?: { region?: string }) =>
        api<{ ok: true; position: MarketPositionWire }>(
          '/markets/hyperliquid/cancel',
          { body, ...(opts?.region ? { headers: { 'X-Region': opts.region } as Record<string, string> } : {}) },
        ),
      /**
       * Cancel+replace a resting order on the venue (same orderId on
       * success). `orderId` is the venue ref (`hl_<oid>` / externalRef on
       * the position row), not our position id. The server preserves the
       * RESTING order's remaining size, side, TIF, and reduce-only — a
       * modify moves the price; qtyUsd/tif here satisfy route validation
       * but do not resize or re-type the order.
       */
      modifyOrder: (body: {
        coin: string;
        orderId: string;
        order: {
          sideLong: boolean;
          qtyUsd: number;
          leverage?: number;
          kind?: 'limit' | 'stopLimit';
          tif?: 'Ioc' | 'Gtc' | 'Alo';
          limitPriceUsd?: number;
          triggerPriceUsd?: number;
          stopKind?: 'sl' | 'tp';
          reduceOnly?: boolean;
        };
      }) =>
        api<{
          ok: true;
          order: {
            orderId: string;
            filledQtyUsd: number;
            entryPriceUsd: number;
            demo: boolean;
            state?: 'filled' | 'resting' | 'triggered' | 'twap_active';
          };
        }>('/markets/hyperliquid/modify', { body }),
      positions: () =>
        api<{ ok: true; positions: MarketPositionWire[] }>('/markets/hyperliquid/positions'),
      /** Signed margin delta for an isolated position: positive adds, negative removes. */
      updateIsolatedMargin: (body: { coin: string; amountUsd: number; sideLong?: boolean }) =>
        api<{ ok: true; coin: string; amountUsd: number; demo: boolean }>(
          '/markets/hyperliquid/update-isolated-margin',
          { body },
        ),
      usdClassTransfer: (
        body: { amountUsd: number; toPerp: boolean },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<HyperliquidTransferWire>(
          '/markets/hyperliquid/usd-class-transfer',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      usdSend: (
        body: { destination: string; amountUsd: number },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<HyperliquidTransferWire>(
          '/markets/hyperliquid/usd-send',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      transferToDex: (
        body: { amountUsd: number; sourceDex?: string; destinationDex?: string; token?: string },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<HyperliquidDexTransferWire>(
          '/markets/hyperliquid/transfer-to-dex',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      withdraw: (
        body: { destination: string; amountUsd: number },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<HyperliquidTransferWire>(
          '/markets/hyperliquid/withdraw',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
    },

    /* HL Spot — 307 SPL pairs on Hyperliquid. Same signing path as perps but
       no leverage, no funding, asset id is 10000 + universe.index server-side.
       Wire field is `displayName` (e.g. "PURR/USDC"), not `pair`. */
    hyperliquidSpot: {
      list: () =>
        api<{
          ok: true;
          source: 'hyperliquid' | 'hyperliquid-spot' | 'demo';
          markets: Array<{
            coin: string;            // "@N" canonical form
            displayName: string;     // human-friendly e.g. "PURR/USDC"
            baseToken: string;
            quoteToken: string;
            priceUsd: number;
            change24hPct: number | null;
            dayVolumeUsd?: number | null;
            index?: number;
            isCanonical?: boolean;
          }>;
        }>('/markets/hyperliquid-spot'),
      detail: (coin: string) =>
        api<{
          ok: true;
          market: {
            coin: string;
            displayName: string;
            priceUsd: number;
            change24hPct: number | null;
            dayVolumeUsd?: number | null;
          };
        }>(`/markets/hyperliquid-spot/detail?coin=${encodeURIComponent(coin)}`),
      placeOrder: (
        body: {
          coin: string;                      // "@N"
          sideLong: boolean;                 // true=buy, false=sell
          qtyUsd: number;
          orderType?: 'market' | 'limit';
          limitPriceUsd?: number;
          tif?: 'Ioc' | 'Gtc' | 'Alo';
          reduceOnly?: boolean;
        },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<{
          ok: true;
          order: {
            orderId: string;
            filledQtyUsd: number;
            entryPriceUsd: number;
            demo: boolean;
            state?: 'filled' | 'resting';
          };
          position: MarketPositionWire;
        }>(
          '/markets/hyperliquid-spot/order',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      cancelOrder: (body: { externalRef: string; coin?: string }, opts?: { region?: string }) =>
        api<{ ok: true; position: MarketPositionWire }>(
          '/markets/hyperliquid-spot/cancel',
          { body, ...(opts?.region ? { headers: { 'X-Region': opts.region } as Record<string, string> } : {}) },
        ),
      positions: () =>
        api<{ ok: true; positions: MarketPositionWire[] }>('/markets/hyperliquid-spot/positions'),
    },

    /* Stocks — two rails, one namespace.
       Perps via trade.xyz HIP-3 (xyz:TICKER, up to 50× leverage, EVM-signed).
       Spot via Backed Finance xStocks (SPL Token-2022, Jupiter swap path). */
    stocks: {
      // Aggregator surface — returns both rails in one call so the Stocks
      // landing screen can light up perps + spot in parallel.
      list: () =>
        api<{
          ok: true;
          perpSource: 'hyperliquid-hip3' | 'demo';
          spotSource: 'xstocks' | 'demo';
          perps: Array<{
            coin: string;
            ticker: string;
            category?: string;
            priceUsd: number;
            change24hPct: number | null;
            maxLeverage: number | null;
            dayVolumeUsd: number | null;
            openInterest?: number | null;
            fundingRate?: number | null;
            index?: number;
          }>;
          spot: Array<{
            mint: string;
            ticker: string;
            symbolX?: string;
            name?: string | null;
            category?: string;
            priceUsd: number;
            priceChange24h: number | null;
            marketCapUsd?: number | null;
          }>;
        }>('/markets/stocks'),
      perps: () =>
        api<{
          ok: true;
          source: 'hyperliquid-hip3' | 'demo';
          dex?: string;
          markets: Array<{
            coin: string;
            ticker: string;
            category?: string;
            priceUsd: number;
            change24hPct: number | null;
            maxLeverage: number | null;
            dayVolumeUsd: number | null;
            openInterest?: number | null;
            fundingRate?: number | null;
            index?: number;
          }>;
        }>('/markets/stocks/perps'),
      spot: () =>
        api<{
          ok: true;
          source: 'xstocks' | 'demo';
          // Backend wraps Backed xStocks under `stocks:` (not `markets:`) and
          // names the 24h delta `priceChange24h` (not `change24hPct`). Match
          // the wire contract exactly — re-keying belongs in the consumer.
          stocks: Array<{
            mint: string;
            ticker: string;
            symbolX?: string;
            name?: string | null;
            category?: string;
            icon?: string | null;
            decimals?: number;
            priceUsd: number;
            priceChange24h: number | null;
            marketCapUsd?: number | null;
            liquidityUsd?: number | null;
            volume24hUsd?: number | null;
            tags?: string[];
          }>;
        }>('/markets/stocks/spot'),
      candles: (coin: string, opts?: { interval?: string; lookbackMs?: number }) => {
        const params = new URLSearchParams({ coin });
        if (opts?.interval) params.set('interval', opts.interval);
        if (opts?.lookbackMs) params.set('lookback', String(opts.lookbackMs));
        return api<{
          ok: true;
          candles: Array<{ t: number; T: number; o: string; h: string; l: string; c: string; v?: string }>;
        }>(`/markets/stocks/candles?${params.toString()}`);
      },
      placeOrder: (
        body: {
          coin: string;                     // xyz:TSLA
          sideLong: boolean;
          qtyUsd: number;
          leverage: number;
          orderType?: 'market' | 'limit';
          limitPriceUsd?: number;
          tif?: 'Ioc' | 'Gtc' | 'Alo';
        },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<{ ok: true; order: { orderId: string; demo: boolean }; position: MarketPositionWire }>(
          '/markets/stocks/order',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      positions: (opts?: { includeLive?: boolean }) =>
        api<{
          ok: true;
          perps: MarketPositionWire[];
          spot: MarketPositionWire[];
          livePerps: Array<{ coin: string; sideLong: boolean; qtyUsd: number; entryPriceUsd: number }>;
        }>(`/markets/stocks/positions${opts?.includeLive ? '?includeLive=1' : ''}`),
    },

    /* Jupiter — Solana DEX aggregator. Drives the memes tab AND xStock spot
       (same swap path, just a different output mint). Two-step UX: quote
       first, then submit the signed swap. Wire fields are `imageUrl` and
       `priceChange24h`, not `logoUrl`/`change24hPct` — consumers re-key. */
    jupiter: {
      list: (opts?: { tag?: 'meme' | 'verified'; limit?: number }) => {
        const params = new URLSearchParams();
        if (opts?.tag) params.set('tag', opts.tag);
        if (opts?.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return api<{
          ok: true;
          source: 'jupiter' | 'demo';
          tokens: Array<{
            mint: string;
            symbol: string;
            name: string;
            imageUrl?: string | null;
            priceUsd: number | null;
            priceChange24h: number | null;
            marketCapUsd?: number | null;
            liquidityUsd?: number | null;
            volume24hUsd?: number | null;
            decimals?: number;
            isVerified?: boolean;
            tags?: string[];
            organicScoreLabel?: string;
            origin?: string;
          }>;
        }>(`/markets/jupiter${qs ? `?${qs}` : ''}`);
      },
      detail: (mint: string) =>
        api<{
          ok: true;
          token: {
            mint: string;
            symbol: string;
            name: string;
            logoUrl?: string | null;
            priceUsd: number | null;
            change24hPct: number | null;
            marketCapUsd?: number | null;
            liquidityUsd?: number | null;
          };
        }>(`/markets/jupiter/detail?mint=${encodeURIComponent(mint)}`),
      prices: (mints: string[]) =>
        api<{ ok: true; prices: Record<string, { priceUsd: number | null; ts: number }> }>(
          `/markets/jupiter/prices?ids=${encodeURIComponent(mints.join(','))}`,
        ),
      quote: (body: {
        inputMint: string;
        outputMint: string;
        amountAtomic: string;             // base-unit string ("1000000" for 1 USDC)
        slippageBps?: number;
      }) =>
        api<{
          ok: true;
          quote: {
            inAmount: string;
            outAmount: string;
            priceImpactPct: number;
            routePlan: Array<{ swapInfo: { ammKey: string; label: string } }>;
            slippageBps: number;
          };
        }>('/markets/jupiter/quote', { body }),
      swap: (
        body: {
          inputMint: string;
          outputMint: string;
          amountAtomic: string;
          slippageBps?: number;
          quote?: unknown;                  // pass through the prior /quote result
        },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<{
          ok: true;
          order: { orderId: string; demo: boolean };
          position: MarketPositionWire;
        }>(
          '/markets/jupiter/swap',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      positions: () =>
        api<{ ok: true; positions: MarketPositionWire[] }>('/markets/jupiter/positions'),
    },

    polymarket: {
      /** Sprint 15 — read-only market list (geo-gated to 451 when blocked). */
      list: (opts?: { region?: string; category?: string; limit?: number }) => {
        const params = new URLSearchParams();
        if (opts?.limit) params.set('limit', String(opts.limit));
        const category = opts?.category?.trim();
        if (category) params.set('category', category);
        const qs = params.toString();
        return api<{
          ok: true;
          source: 'polymarket' | 'demo';
          sourced?: SourcedValueMetaWire;
          markets: Array<{
            id: string;
            question: string;
            outcomes: Array<{
              label: string;
              pricePct: number;
              marketId?: string;
              conditionId?: string;
              tokenId?: string | null;
            }>;
            closesAt: string | null;
            imageUrl?: string | null;
            category?: string | null;
            tags?: string[];
            isNegRisk?: boolean;
            isMultiOutcome?: boolean;
            volume24hUsd?: number | null;
          }>;
        }>(`/markets/polymarket${qs ? `?${qs}` : ''}`, {
          ...(opts?.region ? { headers: { 'X-Region': opts.region } as Record<string, string> } : {}),
        });
      },
      /** Lane C — live-computed best-traders leaderboard (public, 5-min server cache). */
      leaderboard: (opts?: { sort?: 'pnl' | 'value' | 'winRate' | 'realizedPnl'; limit?: number }) => {
        const params = new URLSearchParams();
        if (opts?.sort) params.set('sort', opts.sort);
        if (opts?.limit) params.set('limit', String(opts.limit));
        const qs = params.toString();
        return api<{
          ok: true;
          source: 'polymarket' | 'demo';
          sourced?: SourcedValueMetaWire;
          traders: Array<{
            wallet: string;
            name: string | null;
            pnl: number;
            realizedPnl: number;
            value: number;
            positions: number;
            winRate: number | null;
          }>;
        }>(`/markets/polymarket/leaderboard${qs ? `?${qs}` : ''}`);
      },
      /** Lane C — a trader's best open position rendered as an order prefill. */
      copyIntent: (wallet: string) =>
        api<{
          ok: true;
          source: 'polymarket' | 'demo';
          sourced?: SourcedValueMetaWire;
          intent: {
            wallet: string;
            marketId: string;
            outcome: string;
            outcomeIndex: number;
            title: string;
            slug: string | null;
            icon: string | null;
            currentValueUsd: number;
            suggestedQtyUsd: number;
            entryPriceCents: number | null;
            currentPriceCents: number | null;
            pnlUsd: number;
            endDate: string | null;
          } | null;
        }>(`/markets/polymarket/traders/${wallet}/copy-intent`),
      placeOrder: (
        body: { marketId: string; outcome: string; priceCents: number; qtyUsd: number; copiedFrom?: string },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<{ ok: true; order: { orderId: string; demo: boolean }; position: MarketPositionWire }>(
          '/markets/polymarket/order',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      sell: (
        body: { positionId: string; qtyUsd?: number; limitPriceCents: number },
        opts?: { region?: string; idempotencyKey?: string },
      ) => {
        const headers: Record<string, string> = {};
        if (opts?.region) headers['X-Region'] = opts.region;
        if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return api<{
          ok: true;
          order: { orderId: string; demo: boolean };
          sellOrder: MarketPositionWire;
          position: MarketPositionWire | null;
        }>(
          '/markets/polymarket/sell',
          { body, ...(Object.keys(headers).length ? { headers } : {}) },
        );
      },
      positions: (opts?: { region?: string }) =>
        api<{ ok: true; positions: MarketPositionWire[] }>('/markets/polymarket/positions', {
          ...(opts?.region ? { headers: { 'X-Region': opts.region } as Record<string, string> } : {}),
        }),
    },
  },

  /* ── Sprint 10 Item F — campaigns + perks (constants in lib/campaigns/perks.ts) ── */

  campaigns: {
    list: (opts?: { status?: 'active' | 'closed' }) =>
      api<{ ok: true; campaigns: CampaignWire[] }>(
        '/campaigns' + (opts?.status ? `?status=${opts.status}` : ''),
      ),
    create: (body: {
      title: string;
      brand: string;
      baseUsd: number;
      bonusTiers: Array<{ viewsThreshold: number; bonusUsd: number }>;
      topPrizeUsd?: number;
      endAt?: string | null;
    }) => api<{ ok: true; campaign: CampaignWire }>('/campaigns', { body }),
    get: (id: string) =>
      api<{ ok: true; campaign: CampaignWire }>(`/campaigns/${encodeURIComponent(id)}`),
    submit: (
      id: string,
      body: { clipUrl: string; platform: 'tiktok' | 'instagram' | 'youtube' | 'x'; viewsAttested: number },
    ) =>
      api<{ ok: true; submission: CampaignSubmissionWire }>(
        `/campaigns/${encodeURIComponent(id)}/submit`,
        { body },
      ),
    admin: {
      /** Admin agent-key required (not the session token). */
      approve: (id: string, subId: string, body: { viewsVerified: number }, adminKey: string) =>
        approvedFetch<{ ok: true; submission: CampaignSubmissionWire }>(
          `/campaigns/${encodeURIComponent(id)}/submissions/${encodeURIComponent(subId)}/approve`,
          adminKey,
          body,
        ),
      /** Admin agent-key required. Returns the computed payout + tier multiplier. */
      releaseBonus: (id: string, subId: string, adminKey: string) =>
        approvedFetch<{
          ok: true;
          submission: CampaignSubmissionWire;
          paidUsd: number;
          tier: 'starter' | 'rising' | 'top';
          multiplier: number;
        }>(
          `/campaigns/${encodeURIComponent(id)}/submissions/${encodeURIComponent(subId)}/release-bonus`,
          adminKey,
        ),
    },
  },

  perks: () =>
    api<{
      ok: true;
      tier: 'starter' | 'rising' | 'top';
      points: number;
      multiplier: number;
      lifetimeEarnedUsd: number;
      nextTierAt: number | null;
    }>('/perks'),

  /* ── deposit / onramp surface ──
     `depositAddress` is the cheapest path to fund an account: returns the
     user's Privy receive address for the right chain given the trading
     bucket. Provisions a Solana wallet lazily on first call for memes /
     stocks-spot buckets so users see a real address immediately. */
  depositAddress: (
    bucket: 'cash' | 'perps' | 'predictions' | 'memes' | 'stocks-spot' = 'cash',
  ) =>
    api<{
      ok: true;
      bucket: string;
      chain: string;                  // base | arbitrum | polygon | solana
      network: 'evm' | 'solana';
      address: string;
      walletId: string;
      tokens: string[];               // accepted token symbols on this chain
      live: boolean;                  // false → demo / Privy unwired
    }>(`/onramp/deposit-address?bucket=${encodeURIComponent(bucket)}`),

  /* ── developer surface: API keys (authed) ── */

  /** Mint a key. Returns the FULL key incl. the one-time `secret`. Authed. */
  createApiKey: (input: { label?: string | null; livemode: boolean }) =>
    api<ApiKeyCreated>('/keys', { body: input }),
  /** List this user's keys — masked (no `secret`). Authed. */
  listApiKeys: () => api<{ object: 'list'; data: ApiKey[] }>('/keys'),
  /** Revoke a key by id. Authed. */
  revokeApiKey: (id: string) =>
    api<{ ok: true }>(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ── Sprint 15 — System / Docs surface (unauthed) ── */

  /** Provider registry — every vendor + status. Drives "More → System / Docs". */
  systemProviders: () =>
    api<ProvidersWireResponse>('/system/providers', { noAuth: true }),
  /** Snapshot of live data-source freshness keyed by (provider, metric). */
  systemDataSources: () =>
    api<DataSourcesWireResponse>('/system/data-sources', { noAuth: true }),
  /**
   * Same as /healthz under the versioned namespace so the UI has one entry
   * point. Sprint 17 F070 — anonymous callers receive only {ok, name,
   * fetchedAt}; the in-app System screen authenticates and gets the full
   * feature matrix.
   */
  systemHealth: () =>
    api<{
      ok: true;
      name: string;
      fetchedAt: string;
      demo?: boolean;
      backend?: 'in-memory' | 'postgres';
      features?: Record<string, boolean>;
    }>('/system/health'),

  /* ── Sprint 15 — Onramp (Stripe Crypto Onramp) ── */

  /** Create a Stripe Crypto Onramp session and get the hosted-page redirect URL. */
  onrampStripeSession: (
    amountUsd: number,
    destinationNetwork: 'base' | 'ethereum' | 'polygon' | 'optimism' | 'arbitrum' = 'base',
  ) =>
    api<{
      ok: true;
      sessionId: string;
      redirectUrl: string;
      destinationNetwork: string;
      walletAddress: string;
      amountUsd: number;
      demo: boolean;
      sourced?: SourcedValueMetaWire;
    }>('/onramp/stripe/session', { body: { amountUsd, destinationNetwork } }),
  /** Status probe — does this preview have a live Stripe key? */
  onrampStripeStatus: () =>
    api<{
      ok: true;
      available: boolean;
      provider: string;
      sourced: SourcedValueMetaWire;
    }>('/onramp/stripe/status', { noAuth: true }),
  /** Close the synthetic demo loop — credits the ledger by amount cents. */
  onrampDemoSuccess: (amountCents: number) =>
    api<{
      ok: true;
      balUsd: number;
      amountUsd: number;
      sourced: SourcedValueMetaWire;
    }>(`/onramp/demo-success?amount=${amountCents}`),

  /* ── Sprint 15 — Monerium (EUR / EURe / SEPA on Gnosis) ── */

  moneriumStatus: () =>
    api<{
      ok: true;
      provider: 'monerium';
      available: boolean;
      chain: 'gnosis';
      sourced: SourcedValueMetaWire;
    }>('/monerium/status', { noAuth: true }),
  moneriumProfile: () =>
    api<{
      ok: true;
      iban: string;
      bic: string;
      profileId: string;
      kycStatus: 'pending' | 'verified' | 'failed';
      walletAddress: string;
      sourced: SourcedValueMetaWire;
    }>('/monerium/profile'),
  moneriumOfframp: (amountEur: number, reference?: string) =>
    api<{
      ok: true;
      orderId: string;
      state: 'placed' | 'processed' | 'rejected' | 'expired';
      amountEur: number;
      walletAddress: string;
      sourced: SourcedValueMetaWire;
    }>('/monerium/offramp', { body: reference ? { amountEur, reference } : { amountEur } }),
};

/* ── Sprint 15 — sourced-value + provider registry wire shapes ───────────── */
export type DataSourceKind =
  | 'live'
  | 'sandbox'
  | 'cached-live'
  | 'provider-demo'
  | 'unavailable'
  | 'error';
export interface SourcedValueMetaWire {
  source: DataSourceKind;
  provider: string;
  fetchedAt: string | null;
  ttlSeconds?: number;
  docsUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type ProviderStatus =
  | 'live'
  | 'sandbox'
  | 'gated'
  | 'docs-only'
  | 'missing-keys'
  | 'disabled';
export type ProviderCategory =
  | 'wallet'
  | 'kyc'
  | 'onramp'
  | 'offramp'
  | 'stablecoin'
  | 'swap'
  | 'defi-yield'
  | 'card'
  | 'agent-wallet'
  | 'x402'
  | 'markets'
  | 'tokenized-stocks'
  | 'observability'
  | 'email'
  | 'persistence'
  | 'auth';
export interface ProviderRegistryEntryWire {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  envVars: string[];
  backendFiles: string[];
  frontendScreens: string[];
  publicDocsUrl: string | null;
  internalDocsPath: string | null;
  lastCheckedAt: string | null;
  dataFreshnessTtlSeconds?: number;
  demoFallbackAllowed: boolean;
  notes?: string;
}
export interface ProvidersWireResponse {
  ok: true;
  fetchedAt: string;
  providers: ProviderRegistryEntryWire[];
}
export interface DataSourceEntryWire {
  id: string;
  domain: string;
  metric: string;
  meta: SourcedValueMetaWire;
  screens: string[];
}
export interface DataSourcesWireResponse {
  ok: true;
  fetchedAt: string;
  sources: DataSourceEntryWire[];
}

/* ── markets/campaigns/perks wire shapes (manual to avoid pulling shared-zod runtime) ── */

export interface EarnLandingPickWire {
  asset: string;
  venue: string;
  chain: string;
  apyBps: number;
  apyBaseBps: number | null;
  apyRewardBps: number | null;
  tvlUsd: number | null;
  url: string | null;
  mode: 'native' | 'deeplink' | 'informational';
  riskBand: 'A' | 'B' | 'C';
  note?: string;
}

export type MarketVenueWire =
  | 'hyperliquid'
  | 'hyperliquid-spot'
  | 'hyperliquid-hip3'
  | 'jupiter'
  | 'xstocks'
  | 'polymarket';

export type MarketPositionStatusWire =
  | 'pending'
  | 'open'
  | 'closed'
  | 'created'
  | 'reserved'
  | 'submitted'
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'resting'
  | 'cancel_requested'
  | 'canceled'
  | 'expired'
  | 'rejected'
  | 'failed'
  | 'reconciled';

export interface MarketLifecycleEventWire {
  status: MarketPositionStatusWire;
  ts: string;
  externalOrderId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  providerPayload?: unknown;
}

export interface MarketPositionWire {
  id: string;
  userId?: string;
  venue: MarketVenueWire;
  symbol: string;
  sideLong: boolean;
  qtyUsd: number;
  entryPriceUsd: number;
  status: MarketPositionStatusWire;
  externalRef: string | null;
  externalOrderId?: string | null;
  createdAt: string;
  lifecycleEvents?: MarketLifecycleEventWire[];
  avgFillPriceUsd?: number | null;
  filledQtyUsd?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  submittedAt?: string | null;
  acceptedAt?: string | null;
  filledAt?: string | null;
  canceledAt?: string | null;
  failedAt?: string | null;
  updatedAt?: string;
}

export interface MarketTransferWire {
  id: string;
  userId?: string;
  fromBucket: string;
  toBucket: string;
  fromChain: string;
  toChain: string;
  amountUsd: number;
  amountTokenAtoms: string;
  token: string;
  rail: string;
  status: string;
  srcTxHash?: string | null;
  dstTxHash?: string | null;
  srcCallId?: string | null;
  dstCallId?: string | null;
  feesUsd?: number;
  error?: unknown;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HyperliquidTransferWire {
  ok: true;
  callId: string | null;
  amountUsd: number;
  destination?: string;
  toPerp?: boolean;
  demo: boolean;
  transfer?: MarketTransferWire;
  idempotent?: boolean;
  replay?: boolean;
}

export interface HyperliquidDexTransferWire extends HyperliquidTransferWire {
  sourceDex: string;
  destinationDex: string;
  token: string;
}

export interface CampaignWire {
  id: string;
  creatorId: string;
  title: string;
  brand: string;
  baseUsd: number;
  bonusTiers: Array<{ viewsThreshold: number; bonusUsd: number }>;
  topPrizeUsd: number;
  status: 'active' | 'closed';
  endAt: string | null;
  createdAt: string;
}

export interface CampaignSubmissionWire {
  id: string;
  campaignId: string;
  userId: string;
  clipUrl: string;
  platform: 'tiktok' | 'instagram' | 'youtube' | 'x';
  viewsAttested: number;
  viewsVerified: number;
  status: 'submitted' | 'approved' | 'paid' | 'rejected';
  paidUsd: number;
  approvedAt: string | null;
  createdAt: string;
}

/**
 * Admin-key fetch — sends the admin key as `X-Nexa-Key` instead of the session
 * token so the campaigns admin routes accept it. Mirrors the surface of `api`
 * but doesn't read sessionStorage.
 */
async function approvedFetch<T>(path: string, adminKey: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Nexa-Key': adminKey },
      body: body !== undefined ? JSON.stringify(body) : null,
      signal: ctrl.signal,
    });
    const data = await parseApiResponseBody<T>(res);
    if (!res.ok || data.ok === false) {
      throw failureFromBody(
        res.status,
        data,
        'Admin request failed.',
        retryAfterMsFromHeader(res.headers.get('Retry-After')),
      );
    }
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * SSE stream of new ledger rows with exponential-backoff reconnect.
 *
 * EventSource cannot set headers, so each connection mints a short-lived
 * stream ticket and puts only that ticket in the query string.
 * The returned disposer aborts the active connection and prevents future
 * reconnect attempts.
 */
export function openActivityStream(
  onRow: (row: ServerActivity) => void,
  onStatus?: (status: 'open' | 'down') => void,
): { close: () => void } | null {
  const token = getToken();
  if (!token) return null;
  let es: EventSource | null = null;
  let attempt = 0;
  let timer: number | null = null;
  let closed = false;

  async function mintStreamTicket(): Promise<string> {
    const res = await fetch(`${API_BASE}/v1/stream/ticket`, {
      method: 'POST',
      credentials: 'include',
      headers: { authorization: `Bearer ${token}` },
    });
    // 404 = the realtime hub is not mounted on this deployment. That is
    // permanent for the session — without it the reconnect loop polls a dead
    // route every 30s for as long as the tab lives.
    if (res.status === 404) {
      closed = true;
      onStatus?.('down');
      throw new Error('activity stream unavailable (hub disabled)');
    }
    if (!res.ok) throw new Error(`activity ticket failed: ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error('activity ticket missing');
    return body.token;
  }

  async function connect(): Promise<void> {
    if (closed) return;
    try {
      const ticket = await mintStreamTicket();
      if (closed) return;
      const url = `${API_BASE}/ledger/activity/stream?token=${encodeURIComponent(ticket)}`;
      es = new EventSource(url);
    } catch {
      scheduleReconnect();
      return;
    }
    es.addEventListener('open', () => {
      attempt = 0;
      onStatus?.('open');
    });
    es.addEventListener('activity', (e) => {
      attempt = 0;
      try {
        onRow(JSON.parse((e as MessageEvent).data) as ServerActivity);
      } catch {
        /* malformed frame */
      }
    });
    es.addEventListener('ping', () => {
      attempt = 0;
    });
    es.addEventListener('error', () => {
      if (es) {
        es.close();
        es = null;
      }
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (closed) return;
    onStatus?.('down');
    attempt = Math.min(attempt + 1, 6);
    const delay = Math.min(30_000, 500 * 2 ** attempt);
    timer = window.setTimeout(connect, delay);
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (es) {
        es.close();
        es = null;
      }
    },
  };
}

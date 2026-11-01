/**
 * @nexa/sdk — TypeScript client for the Neo Bank / NEXA public API.
 *
 * Zero runtime deps (uses global fetch). Works in Node 20+, modern browsers,
 * and Bun. Authenticate with either a session JWT (mobile/web client) or
 * an sk_test_/sk_live_ API key (server-to-server).
 *
 * ```ts
 * import { NexaClient } from '@nexa/sdk';
 *
 * const nx = new NexaClient({
 *   baseUrl: 'https://nexa.aiso.tools',
 *   apiKey: process.env.NEXA_API_KEY, // sk_live_...
 * });
 *
 * const profile = await nx.me.profile();
 * const perps   = await nx.markets.hyperliquid.list();
 * const stocks  = await nx.markets.stocks.list();
 * ```
 *
 * See docs/API.md for the wire reference and docs/FEES.md for the revenue
 * model across venues.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * F088 Sprint 18 — type-drift migration (IN PROGRESS)
 *
 * The response types below this header are hand-maintained and have been
 * observed to drift from the actual server shape (`MeProfile.trading` is the
 * canonical case — typed as `Record<string, Record<string, unknown>>` here
 * but returned as a typed per-venue shape by the server).
 *
 * The migration path:
 *   1. `pnpm --filter @nexa/sdk add -D openapi-typescript` (one-time human ask).
 *   2. With API running, `pnpm --filter @nexa/sdk gen:types` emits
 *      `src/generated/api-schema.ts` from `/v1/openapi.json`.
 *   3. Replace each hand-maintained response interface below with the
 *      corresponding `paths['/<route>']['get'|'post']['responses'][200]`
 *      slice. Compile errors surface server↔client drift.
 *
 * Until step 1 is approved, this file stays the source of truth and the
 * generator scaffolding sits idle. See `scripts/gen-openapi-types.mjs`.
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { paths } from './generated/api-schema.js';

export interface NexaClientOptions {
  /** Base URL of the NEXA API. Default https://nexa.aiso.tools */
  baseUrl?: string;
  /**
   * Session JWT from /auth/verify OR an API key like `sk_test_…` / `sk_live_…`.
   * The wire treats both identically — Bearer token.
   */
  apiKey?: string;
  /** Optional fetch override for tests or for environments without global fetch. */
  fetch?: typeof fetch;
  /** Default request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /**
   * F096 Sprint 18 — cookie credentials policy for browser callers.
   *
   *   - 'omit' (default for native / server-to-server): no cookies sent.
   *   - 'same-origin': send cookies only on same-origin requests.
   *   - 'include': send cookies cross-origin. Use this in the web/PWA
   *     when the SDK base URL differs from the page origin (e.g. PWA on
   *     `app.maze.bank` calling API at `nexa.aiso.tools`). Pair with a
   *     server-side CORS allowlist + `Access-Control-Allow-Credentials: true`.
   *
   * When the httpOnly session cookie is in play (browser sign-in via
   * /auth/verify), set this to 'include' (cross-origin) or 'same-origin'
   * so the SDK can authenticate without mirroring the JWT into local
   * storage. Native callers in React Native should leave it unset and
   * keep the Bearer token in SecureStore.
   */
  credentials?: 'omit' | 'same-origin' | 'include';
}

export class NexaError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    public details: unknown,
    public retryAfterMs?: number,
  ) {
    super(`nexa ${status} ${code ?? ''}`);
  }
}

interface RequestInitX {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Optional per-request override of the client default. */
  apiKey?: string;
  /** Optional idempotency key — required by NEXA on every POST trade route. */
  idempotencyKey?: string;
  /** Optional raw headers for route-specific trusted metadata in non-production tests. */
  headers?: Record<string, string>;
  /** Convenience alias for the API's X-Region header. */
  region?: string;
  timeoutMs?: number;
}

export type LiveWriteOptions =
  | string
  | { idempotencyKey: string; region?: string; headers?: Record<string, string> };

function liveWriteInit(options: LiveWriteOptions): Pick<RequestInitX, 'idempotencyKey' | 'region' | 'headers'> {
  if (typeof options === 'string') return { idempotencyKey: options };
  return {
    idempotencyKey: options.idempotencyKey,
    ...(options.region ? { region: options.region } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  };
}

export class NexaClient {
  private baseUrl: string;
  private apiKey?: string;
  private fetchFn: typeof fetch;
  private defaultTimeout: number;
  private credentials?: RequestCredentials;

  constructor(opts: NexaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://nexa.aiso.tools').replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.defaultTimeout = opts.timeoutMs ?? 30_000;
    this.credentials = opts.credentials;
    if (!this.fetchFn) {
      throw new Error('NexaClient: global fetch is unavailable. Pass `opts.fetch` (e.g. node-fetch).');
    }
  }

  // ── Per-resource namespaces ─────────────────────────────────────────

  readonly me = {
    /** Unified per-user profile + trading eligibility + balances + fee config. */
    profile: () => this.req<MeProfile>('/me/profile'),
    /** Recent fees collected on this user's behalf, aggregated by venue. */
    fees: () => this.req<MeFees>('/me/fees'),
  };

  readonly auth = {
    /** Send OTP to email. Returns challengeId for /verify. */
    start: (email: string) =>
      this.req<AuthStart>('/auth/start', {
        method: 'POST',
        body: { email },
      }),
    /** Verify the OTP. Returns the session JWT + expiry. */
    verify: (challengeId: string, code: string) =>
      this.req<AuthVerify>('/auth/verify', { method: 'POST', body: { challengeId, code } }),
    /** Current session — same shape as /me/profile.user. */
    me: () => this.req<AuthMe>('/auth/me'),
  };

  readonly balances = {
    /** Per-chain USDC balances aggregated into NEXA portfolio buckets. */
    get: () => this.req<PortfolioBalancesResponse>('/balances'),
  };

  readonly payments = {
    send: (body: PaymentSendRequest, idempotencyKey: string) =>
      this.req<PaymentSendResponse>('/payments/send', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    requestLink: (body: PaymentRequestLinkRequest) =>
      this.req<PaymentRequestLinkResponse>('/payments/request-link', {
        method: 'POST',
        body,
      }),
    demoTopup: (body: PaymentTopupRequest) =>
      this.req<PaymentTopupResponse>('/payments/topup', {
        method: 'POST',
        body,
      }),
  };

  readonly earn = {
    deposit: (body: EarnAmountRequest, idempotencyKey: string) =>
      this.req<EarnMoveResponse>('/earn/deposit', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    withdraw: (body: EarnAmountRequest, idempotencyKey: string) =>
      this.req<EarnMoveResponse>('/earn/withdraw', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    configure: (body: EarnConfigRequest) =>
      this.req<EarnConfigResponse>('/earn/configure', {
        method: 'POST',
        body,
      }),
    tier: (tier: VaultTier) =>
      this.req<{ ok: true; tier: VaultTier }>('/earn/tier', {
        method: 'POST',
        body: { tier },
      }),
    marinadeStake: (body: MarinadeStakeRequest) =>
      this.req<MarinadeActionResponse>('/earn/marinade/stake', {
        method: 'POST',
        body,
      }),
    marinadeUnstake: (body: MarinadeUnstakeRequest) =>
      this.req<MarinadeActionResponse>('/earn/marinade/unstake', {
        method: 'POST',
        body,
      }),
  };

  readonly swap = {
    quote: (opts: SwapQuoteRequest) =>
      this.req<SwapQuoteResponse>('/swap/quote', {
        query: {
          amount: opts.amount,
          direction: opts.direction,
          fromChain: opts.fromChain,
          toChain: opts.toChain,
          fromToken: opts.fromToken,
          toToken: opts.toToken,
          enableRefuel: opts.enableRefuel,
        },
      }),
    execute: (body: SwapExecuteRequest, idempotencyKey: string) =>
      this.req<SwapExecuteResponse>('/swap/execute', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
  };

  readonly onramp = {
    depositAddress: (bucket: TransferBucket) =>
      this.req<OnrampDepositAddressResponse>('/onramp/deposit-address', {
        query: { bucket },
      }),
    onramperSession: (body: OnramperSessionRequest) =>
      this.req<OnramperSessionResponse>('/onramp/onramper/session', {
        method: 'POST',
        body,
      }),
    stripeSession: (body: StripeOnrampSessionRequest) =>
      this.req<StripeOnrampSessionResponse>('/onramp/stripe/session', {
        method: 'POST',
        body,
      }),
  };

  readonly monerium = {
    profile: () => this.req<MoneriumProfileResponse>('/monerium/profile'),
    offramp: (body: MoneriumOfframpRequest) =>
      this.req<MoneriumOfframpResponse>('/monerium/offramp', {
        method: 'POST',
        body,
      }),
  };

  readonly transfers = {
    /** Deposit address for a portfolio bucket. */
    depositAddress: (bucket: TransferBucket) =>
      this.req<TransferDepositAddressResponse>('/transfers/onramp/deposit-address', {
        query: { bucket },
      }),
    /** Move USDC between NEXA portfolio buckets. Live calls require idempotency. */
    internal: (body: InternalTransferRequest, idempotencyKey: string) =>
      this.req<InternalTransferResponse>('/transfers/internal', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    /** Send Base USDC from the user's server wallet to an external EVM address. */
    external: (body: ExternalTransferRequest, idempotencyKey: string) =>
      this.req<ExternalTransferResponse>('/transfers/external', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    /** Push Arbitrum wallet USDC into Hyperliquid Bridge2. */
    hlDeposit: (body: HlDepositRequest, idempotencyKey: string) =>
      this.req<HlDepositResponse>('/transfers/hl-deposit', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    list: (limit = 20) =>
      this.req<{ ok: true; transfers: TransferRecord[] }>('/transfers', { query: { limit } }),
    get: (id: string) =>
      this.req<{ ok: true; transfer: TransferRecord; events: TransferEvent[] }>(`/transfers/${id}`),
  };

  readonly card = {
    get: () => this.req<CardStateResponse>('/card'),
    order: (idempotencyKey: string) =>
      this.req<CardOrderResponse>('/card/order', {
        method: 'POST',
        idempotencyKey,
      }),
    topup: (body: CardTopupRequest, idempotencyKey: string) =>
      this.req<CardTopupResponse>('/card/topup', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    freeze: (frozen: boolean) =>
      this.req<{ ok: true; frozen: boolean }>('/card/freeze', {
        method: 'POST',
        body: { frozen },
      }),
    limit: (dayLimitUsd: number) =>
      this.req<{ ok: true; dayLimitUsd: number }>('/card/limit', {
        method: 'POST',
        body: { dayLimitUsd },
      }),
  };

  readonly agents = {
    list: () => this.req<AgentListResponse>('/agent'),
    create: (body: AgentCreateRequest) =>
      this.req<AgentCreateResponse>('/agent/create', {
        method: 'POST',
        body,
      }),
    killSwitch: (on: boolean) =>
      this.req<{ ok: true; killSwitch: boolean }>('/agent/kill-switch', {
        method: 'POST',
        body: { on },
      }),
    fund: (agentId: string, amountUsd: number, idempotencyKey: string) =>
      this.req<AgentActionResponse>(`/agent/${encodeURIComponent(agentId)}/fund`, {
        method: 'POST',
        body: { amountUsd },
        idempotencyKey,
      }),
    defund: (agentId: string) =>
      this.req<AgentActionResponse>(`/agent/${encodeURIComponent(agentId)}/defund`, {
        method: 'POST',
      }),
    pause: (agentId: string, paused: boolean) =>
      this.req<AgentActionResponse>(`/agent/${encodeURIComponent(agentId)}/pause`, {
        method: 'POST',
        body: { paused },
      }),
    policy: (agentId: string, body: AgentPolicyRequest) =>
      this.req<AgentActionResponse>(`/agent/${encodeURIComponent(agentId)}/policy`, {
        method: 'POST',
        body,
      }),
    approveOnce: (agentId: string, body: AgentApproveOnceRequest, idempotencyKey: string) =>
      this.req<{ ok: true; receipt: unknown }>(`/agent/${encodeURIComponent(agentId)}/approve-once`, {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    card: (agentId: string, idempotencyKey: string) =>
      this.req<AgentCardResponse>(`/agent/${encodeURIComponent(agentId)}/card`, {
        method: 'POST',
        idempotencyKey,
      }),
    bank: (agentId: string, idempotencyKey: string) =>
      this.req<AgentBankResponse>(`/agent/${encodeURIComponent(agentId)}/bank`, {
        method: 'POST',
        idempotencyKey,
      }),
  };

  readonly markets = {
    positions: () =>
      this.req<{ ok: true; positions: MarketPosition[] }>('/markets/positions'),
    fills: (opts: { limit?: number } = {}) =>
      this.req<{ ok: true; fills: MarketFill[] }>('/markets/fills', { query: opts }),
    cancelOrder: (positionId: string, options?: LiveWriteOptions) =>
      this.req<{ ok: true; position: MarketPosition }>(
        `/markets/orders/${encodeURIComponent(positionId)}/cancel`,
        { method: 'POST', ...(options ? liveWriteInit(options) : {}) },
      ),
    hyperliquid: {
      list: (limit?: number) =>
        this.req<{ ok: true; source: string; markets: HlMarket[] }>(`/markets/hyperliquid`, {
          query: { limit },
        }),
      detail: (coin: string) => this.req<{ ok: true; market: HlMarket }>(`/markets/hyperliquid/${coin}`),
      builderStatus: () => this.req<HlBuilderStatusResponse>('/markets/hyperliquid/builder-status'),
      approveBuilder: (body: { maxFeeBps?: number } = {}) =>
        this.req<HlBuilderApprovalResponse>('/markets/hyperliquid/approve-builder', {
          method: 'POST',
          body,
        }),
      placeOrder: (body: HlOrderRequest, options: LiveWriteOptions) =>
        this.req<HlOrderResponse>('/markets/hyperliquid/order', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      positions: () =>
        this.req<{ ok: true; positions: MarketPosition[] }>('/markets/hyperliquid/positions'),
      usdClassTransfer: (body: HlUsdClassTransferRequest, options: LiveWriteOptions) =>
        this.req<HlTransferResponse>('/markets/hyperliquid/usd-class-transfer', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      usdSend: (body: HlUsdSendRequest, options: LiveWriteOptions) =>
        this.req<HlTransferResponse>('/markets/hyperliquid/usd-send', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      transferToDex: (body: HlTransferToDexRequest, options: LiveWriteOptions) =>
        this.req<HlDexTransferResponse>('/markets/hyperliquid/transfer-to-dex', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      withdraw: (body: HlWithdrawRequest, options: LiveWriteOptions) =>
        this.req<HlTransferResponse>('/markets/hyperliquid/withdraw', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
    },
    hyperliquidSpot: {
      list: (limit = 500) =>
        this.req<{ ok: true; markets: HlSpotMarket[] }>(`/markets/hyperliquid-spot`, { query: { limit } }),
      detail: (coin: string) =>
        this.req<{ ok: true; market: HlSpotMarket }>(`/markets/hyperliquid-spot/detail`, { query: { coin } }),
      placeOrder: (body: HlSpotOrderRequest, options: LiveWriteOptions) =>
        this.req<HlSpotOrderResponse>('/markets/hyperliquid-spot/order', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      positions: () =>
        this.req<{ ok: true; positions: MarketPosition[] }>('/markets/hyperliquid-spot/positions'),
    },
    stocks: {
      list: (limit = 200) =>
        this.req<{ ok: true; perps: Hip3Market[]; spot: XStock[] }>(`/markets/stocks`, { query: { limit } }),
      perps: (limit = 500) =>
        this.req<{ ok: true; markets: Hip3Market[]; dex: string }>(`/markets/stocks/perps`, {
          query: { limit },
        }),
      spot: (opts: { category?: string; limit?: number } = {}) =>
        this.req<{ ok: true; stocks: XStock[] }>(`/markets/stocks/spot`, { query: opts }),
      candles: (coin: string, interval = '1h', lookbackMs?: number) =>
        this.req<{ ok: true; candles: Candle[] }>(`/markets/stocks/candles`, {
          query: { coin, interval, lookback: lookbackMs },
        }),
      placeOrder: (body: Hip3OrderRequest, options: LiveWriteOptions) =>
        this.req<Hip3OrderResponse>('/markets/stocks/order', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      positions: (opts: { includeLive?: boolean } = {}) =>
        this.req<{ ok: true; perps: MarketPosition[]; spot: MarketPosition[]; livePerps: Hip3Position[] }>(
          '/markets/stocks/positions',
          { query: { includeLive: opts.includeLive ? '1' : undefined } },
        ),
    },
    jupiter: {
      list: (opts: JupiterListOpts = {}) =>
        this.req<{ ok: true; tokens: MemeToken[]; total: number }>(`/markets/jupiter`, {
          query: {
            source: opts.source,
            tag: opts.tag,
            sort: opts.sort,
            migrated: opts.migrated,
            limit: opts.limit,
            offset: opts.offset,
          },
        }),
      prices: (mints: string[]) =>
        this.req<{ ok: true; prices: Record<string, { priceUsd: number | null; priceChange24h: number | null }> }>(
          `/markets/jupiter/prices`,
          { query: { ids: mints.slice(0, 100).join(',') } },
        ),
      quote: (body: JupQuoteRequest) =>
        this.req<JupQuoteResponse>('/markets/jupiter/quote', { method: 'POST', body }),
      swap: (body: JupSwapRequest, options: LiveWriteOptions) =>
        this.req<JupSwapResponse>('/markets/jupiter/swap', { method: 'POST', body, ...liveWriteInit(options) }),
      positions: () =>
        this.req<{ ok: true; positions: MarketPosition[] }>('/markets/jupiter/positions'),
    },
    polymarket: {
      list: (opts: { category?: string; limit?: number } = {}) =>
        this.req<{ ok: true; markets: PmMarket[] }>(`/markets/polymarket`, { query: opts }),
      detail: (id: string) => this.req<{ ok: true; market: PmMarket }>(`/markets/polymarket/${id}`),
      orderbook: (id: string, outcome?: string) =>
        this.req<{ ok: true; book: { bids: BookLevel[]; asks: BookLevel[] } }>(
          `/markets/polymarket/${id}/book`,
          { query: { outcome } },
        ),
      topTraders: (id: string, limit?: number) =>
        this.req<PmTopTradersResponse>(`/markets/polymarket/${id}/top-traders`, {
          query: { limit },
        }),
      placeOrder: (body: PmOrderRequest, options: LiveWriteOptions) =>
        this.req<PmOrderResponse>('/markets/polymarket/order', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      sell: (body: PmSellRequest, options: LiveWriteOptions) =>
        this.req<PmOrderResponse>('/markets/polymarket/sell', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
      positions: () =>
        this.req<{ ok: true; positions: MarketPosition[] }>('/markets/polymarket/positions'),
    },
    cards: {
      list: (opts: { collection?: string; sort?: string; cursor?: string; limit?: number } = {}) =>
        this.req<{ ok: true; items: CollectorCard[]; nextCursor: string | null; total: number }>(
          '/markets/cards',
          { query: opts },
        ),
      collections: () =>
        this.req<{ ok: true; collections: string[] }>('/markets/cards/collections'),
      detail: (id: string) =>
        this.req<{ ok: true; card: CollectorCard }>(`/markets/cards/${encodeURIComponent(id)}`),
      positions: () =>
        this.req<{ ok: true; positions: MarketPosition[] }>('/markets/cards/positions'),
      trades: () =>
        this.req<{ ok: true; trades: unknown[] }>('/markets/cards/trades/me'),
      buy: (body: CollectorCardBuyRequest, options: LiveWriteOptions) =>
        this.req<CollectorCardBuyResponse>('/markets/cards/buy', {
          method: 'POST',
          body,
          ...liveWriteInit(options),
        }),
    },
  };

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Public escape hatch. If a newer endpoint isn't in the typed surface
   * yet, call it raw — same auth, same error handling.
   */
  async request<T = unknown>(path: string, init: RequestInitX = {}): Promise<T> {
    return this.req<T>(path, init);
  }

  private async req<T>(path: string, init: RequestInitX = {}): Promise<T> {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : '/' + path));
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
    const key = init.apiKey ?? this.apiKey;
    if (key) headers['Authorization'] = `Bearer ${key}`;
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    if (init.region) headers['X-Region'] = init.region;
    const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? this.defaultTimeout;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: init.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
        // F096 — only set credentials when the caller opted in; React Native
        // fetch ignores it (and warns on some versions), so the default `undefined`
        // is the right shape for native callers.
        ...(this.credentials ? { credentials: this.credentials } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const code = isObj(parsed) && isObj(parsed.error) ? String(parsed.error.code ?? '') : undefined;
      throw new NexaError(res.status, code, parsed, retryAfterMsFromHeader(res.headers.get('Retry-After')));
    }
    return parsed as T;
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function retryAfterMsFromHeader(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

// ── Wire types (intentionally narrow — re-export for advanced users) ──

export type MeProfile = paths['/me/profile']['get']['responses'][200]['content']['application/json'];
export type MeFees = paths['/me/fees']['get']['responses'][200]['content']['application/json'];
export type FeeEvent = MeFees['recent'][number];
export type AuthStart = paths['/auth/start']['post']['responses'][200]['content']['application/json'];
export type AuthVerify = paths['/auth/verify']['post']['responses'][200]['content']['application/json'];
export type AuthMe = paths['/auth/me']['get']['responses'][200]['content']['application/json'];

export type TransferBucket = 'perps' | 'predictions' | 'memes' | 'cash' | 'stocks-spot';
export type TransferBucketWire = TransferBucket | 'external';
export type TransferChain = 'arbitrum' | 'polygon' | 'solana' | 'base' | 'optimism';
export type TransferRail = 'cctp' | 'mayan' | 'socket' | 'lifi' | 'hl_bridge' | 'hl_withdraw' | 'internal';
export type TransferStatus =
  | 'created'
  | 'burning'
  | 'attesting'
  | 'minting'
  | 'depositing'
  | 'hl_depositing'
  | 'hl_withdrawing'
  | 'complete'
  | 'failed';

export interface PortfolioBalancesResponse {
  ok: true;
  totalUsd: number;
  buckets: Record<TransferBucket, { usd: number; chain: TransferChain; sources?: Record<string, number> }>;
  byChain: Record<string, number>;
  wallets: { evm: string; solana: string };
  live: boolean;
  cached?: boolean;
  sourced?: unknown;
}

export interface TransferDepositAddressResponse {
  ok: true;
  bucket: TransferBucket;
  bucketLabel: string;
  chain: TransferChain;
  address: string;
  token: 'USDC';
  live: boolean;
  memo: string | null;
}

export interface InternalTransferRequest {
  fromBucket: TransferBucket;
  toBucket: TransferBucket;
  amountUsd: number;
  idempotencyKey?: string;
}

export interface InternalTransferResponse {
  ok: true;
  transferId: string;
  status: TransferStatus;
  rail: TransferRail;
  fromBucket: TransferBucket;
  toBucket: TransferBucket;
  amountUsd: number;
  requestedUsd: number;
  feeUsd: number;
  feeBps: number;
  etaSec: number;
  idempotent: boolean;
  demo: boolean;
  sourced?: unknown;
}

export interface HlDepositRequest {
  amountUsd?: number;
  idempotencyKey?: string;
}

export interface HlDepositResponse {
  ok: true;
  transferId: string;
  status: TransferStatus;
  /** Null when the deposit was journaled without a definite on-chain submit. */
  callId: string | null;
  amountUsd: number;
  demo: boolean;
  idempotent: boolean;
  /** Present when dispatch outcome is unknown (crash/timeout window); reconcile before retrying. */
  submittedUnknown?: boolean;
  sourced?: unknown;
}

export interface TransferRecord {
  id: string;
  userId: string;
  fromBucket: TransferBucketWire;
  toBucket: TransferBucketWire;
  fromChain: TransferChain;
  toChain: TransferChain;
  amountUsd: number;
  amountTokenAtoms: string;
  token: string;
  rail: TransferRail;
  status: TransferStatus;
  srcTxHash: string | null;
  dstTxHash: string | null;
  srcCallId: string | null;
  dstCallId: string | null;
  cctpMessageHash?: string | null;
  cctpMessageBody?: string | null;
  cctpAttestation?: string | null;
  feesUsd: number;
  error: unknown;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransferEvent {
  id: string;
  transferId: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface PaymentSendRequest {
  amountUsd: number;
  to: string;
}

export interface PaymentSendResponse {
  ok: true;
  claim: boolean;
  claimSlug: string | null;
  claimUrl: string | null;
  balUsd: number;
  activityId: string;
  message: string;
}

export interface PaymentRequestLinkRequest {
  amountUsd: number;
  note?: string;
}

export interface PaymentRequestLinkResponse {
  ok: true;
  url: string;
  amountUsd: number;
  note: string;
  expiresInDays: number;
  oneTime: boolean;
}

export interface PaymentTopupRequest {
  amountUsd: number;
  label?: string;
}

export interface PaymentTopupResponse {
  ok: true;
  balUsd: number;
}

export type VaultTier = 'standard' | 'higherYield';

export interface EarnAmountRequest {
  amountUsd: number;
  tier?: VaultTier;
  idempotencyKey?: string;
}

export interface EarnMoveResponse {
  ok: true;
  balUsd: number;
  earnUsd: number;
  txHash: string | null;
  adapter: string | null;
  source: string;
}

export interface EarnConfigRequest {
  earnByDefault?: boolean;
  autoDivestOnSpend?: boolean;
  divestThresholdUsd?: number;
}

export interface EarnConfigResponse {
  ok: true;
  config: {
    earnByDefault: boolean;
    autoDivestOnSpend: boolean;
    divestThresholdUsd: number;
  };
}

export interface MarinadeStakeRequest {
  amountSol: number;
}

export interface MarinadeUnstakeRequest {
  amountMSol: number;
  immediate?: boolean;
}

export interface MarinadeActionResponse {
  ok: boolean;
  signature?: string;
  confirmed?: boolean;
  mSolMint?: string;
  via?: string;
  walletAddress?: string;
  error?: { code: string; message: string };
  sourced?: unknown;
}

export type SwapChain = 'base' | 'gnosis' | 'polygon' | 'optimism' | 'arbitrum' | 'solana';
export type SwapToken = 'USDC' | 'EURC' | 'EURe' | 'USDT' | 'SOL' | 'mSOL';
export type SwapDirection = 'usd-eur' | 'eur-usd';

export interface SwapQuoteRequest {
  amount: number;
  direction?: SwapDirection;
  fromChain?: SwapChain;
  toChain?: SwapChain;
  fromToken?: SwapToken;
  toToken?: SwapToken;
  enableRefuel?: boolean;
}

export interface SwapQuoteResponse {
  ok: boolean;
  amount: number;
  direction: SwapDirection;
  fromChain: SwapChain;
  toChain: SwapChain;
  fromToken: SwapToken;
  toToken: SwapToken;
  rate: number;
  out: number;
  fees: number;
  refuelGasUsd?: number | null;
  source: string;
  sourced?: unknown;
  error?: { code: string; message: string };
}

export interface SwapExecuteRequest extends SwapQuoteRequest {
  idempotencyKey?: string;
}

export interface SwapExecuteResponse {
  ok: boolean;
  out?: number;
  rate?: number;
  fees?: number;
  balUsd?: number;
  txHash?: string | null;
  source?: string;
  transferId?: string;
  idempotent?: boolean;
  transfer?: TransferRecord;
  error?: { code: string; message: string };
  sourced?: unknown;
}

export interface OnrampDepositAddressResponse {
  ok: true;
  bucket: TransferBucket;
  chain: string;
  network: 'evm' | 'solana';
  address: string;
  walletId: string | null;
  tokens: string[];
  live: boolean;
  sourced?: unknown;
}

export interface OnramperSessionRequest {
  amountUsd?: number;
  bucket?: TransferBucket;
}

export interface OnramperSessionResponse {
  ok: true;
  widgetUrl: string;
  bucket: TransferBucket;
  chain: string;
  walletAddress: string;
  demo: boolean;
  sourced?: unknown;
}

export interface StripeOnrampSessionRequest {
  amountUsd: number;
  destinationNetwork?: 'base' | 'ethereum' | 'polygon' | 'optimism' | 'arbitrum';
}

export interface StripeOnrampSessionResponse {
  ok: true;
  sessionId: string;
  redirectUrl: string;
  destinationNetwork: string;
  walletAddress: string;
  amountUsd: number;
  demo: boolean;
  sourced?: unknown;
}

export interface MoneriumProfileResponse {
  ok: boolean;
  profile?: unknown;
  error?: { code: string; message: string };
  sourced?: unknown;
}

export interface MoneriumOfframpRequest {
  amountEur: number;
  reference?: string;
}

export interface MoneriumOfframpResponse {
  ok: boolean;
  transfer?: unknown;
  error?: { code: string; message: string };
  sourced?: unknown;
}

export interface ExternalTransferRequest {
  chain: 'base';
  destinationAddress: string;
  amountUsd: number;
  idempotencyKey?: string;
}

export interface ExternalTransferResponse {
  ok: true;
  transferId: string;
  status: TransferStatus;
  chain: 'base';
  destinationAddress: string;
  amountUsd: number;
  txHash: string | null;
  demo: boolean;
  idempotent: boolean;
  /** Present when dispatch outcome is unknown (crash/timeout window); reconcile before retrying. */
  submittedUnknown?: boolean;
  sourced?: unknown;
}

export interface CardStateResponse {
  ok: true;
  card: {
    kind: string;
    last4: string | null;
    network: string | null;
    frozen: boolean;
    dayLimitUsd: number;
    demo?: boolean;
  } | null;
  sourced?: unknown;
}

export interface CardOrderResponse {
  ok: true;
  last4: string;
  network: string;
  pan: string | null;
  safeAddress: string | null;
  demo: boolean;
  sourced?: unknown;
}

export interface CardTopupRequest {
  amountUsd: number;
  idempotencyKey?: string;
}

export interface CardTopupResponse {
  ok: true;
  transferId?: string;
  activityId?: string;
  balUsd?: number;
  demo?: boolean;
  sourced?: unknown;
}

export interface AgentRecord {
  id: string;
  name: string;
  balanceUsd: number;
  paused?: boolean;
  perDayCapUsd?: number;
  perTxCapUsd?: number;
  endpointAllowlist?: string[];
}

export interface AgentListResponse {
  ok: true;
  killSwitch: boolean;
  agents: AgentRecord[];
}

export interface AgentCreateRequest {
  name: string;
  perDayCapUsd?: number;
  perTxCapUsd?: number;
  endpointAllowlist?: string[];
}

export interface AgentCreateResponse {
  ok: true;
  agent: AgentRecord;
  walletAddress: string | null;
}

export interface AgentActionResponse {
  ok: true;
  agent: AgentRecord;
  balUsd?: number;
}

export interface AgentPolicyRequest {
  perDayCapUsd?: number;
  perTxCapUsd?: number;
  endpointAllowlist?: string[];
  humanApprovalThresholdUsd?: number;
  expiresAt?: string | null;
}

export interface AgentApproveOnceRequest {
  endpoint: string;
  amountUsd: number;
  reason: string;
}

export interface AgentCardResponse {
  ok: true;
  agentId: string;
  last4: string;
  network: string;
  demo: boolean;
}

export interface AgentBankResponse {
  ok: true;
  accountNumber: string;
  routingNumber: string;
}

export interface HlMarket {
  coin: string;
  priceUsd: number;
  change24hPct: number | null;
  maxLeverage?: number | null;
  dayVolumeUsd?: number | null;
  openInterest?: number | null;
  fundingRate?: number | null;
}

export interface HlOrderRequest {
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
}

export interface HlOrderResponse {
  ok: boolean;
  order?: {
    orderId: string;
    filledQtyUsd: number;
    entryPriceUsd: number;
    demo: boolean;
    state?: 'filled' | 'resting' | 'triggered' | 'twap_active';
    legs?: { tp?: { orderId: string }; sl?: { orderId: string } };
  };
  error?: { code: string; message: string };
}

export interface HlBuilderStatusResponse {
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
  needsApproval: false;
}

export interface HlBuilderApprovalResponse {
  ok: true;
  builder: { address: string; maxFeeRate: string; maxFeeTenthsBp: number };
  approvedAt: string;
}

export interface HlUsdClassTransferRequest {
  amountUsd: number;
  toPerp: boolean;
}

export interface HlUsdSendRequest {
  destination: string;
  amountUsd: number;
}

export interface HlTransferToDexRequest {
  amountUsd: number;
  sourceDex?: string;
  destinationDex?: string;
  token?: string;
}

export interface HlWithdrawRequest {
  destination: string;
  amountUsd: number;
}

export interface HlTransferRecord {
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

export interface HlTransferResponse {
  ok: true;
  callId: string | null;
  amountUsd: number;
  destination?: string;
  toPerp?: boolean;
  demo: boolean;
  transfer?: HlTransferRecord;
  idempotent?: boolean;
  replay?: boolean;
}

export interface HlDexTransferResponse extends HlTransferResponse {
  sourceDex: string;
  destinationDex: string;
  token: string;
}

export interface HlSpotMarket {
  coin: string;
  displayName: string;
  baseToken: string;
  quoteToken: string;
  priceUsd: number;
  change24hPct: number | null;
  dayVolumeUsd?: number | null;
}

export interface HlSpotOrderRequest {
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  orderType?: 'market' | 'limit';
  limitPriceUsd?: number;
  tif?: 'Ioc' | 'Gtc' | 'Alo';
  reduceOnly?: boolean;
}

export interface HlSpotOrderResponse {
  ok: boolean;
  order?: {
    orderId: string;
    filledQtyUsd: number;
    entryPriceUsd: number;
    demo: boolean;
    state?: 'filled' | 'resting';
  };
  error?: { code: string; message: string };
}

export interface Hip3Market {
  coin: string;
  ticker: string;
  category: 'stock' | 'index' | 'commodity' | 'fx' | 'other';
  priceUsd: number;
  change24hPct: number | null;
  maxLeverage?: number | null;
  dayVolumeUsd?: number | null;
}

export interface Hip3OrderRequest {
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  leverage: number;
  orderType?: 'market' | 'limit';
  limitPriceUsd?: number;
  tif?: 'Ioc' | 'Gtc' | 'Alo';
  reduceOnly?: boolean;
}

export interface Hip3OrderResponse {
  ok: boolean;
  order?: {
    orderId: string;
    filledQtyUsd: number;
    entryPriceUsd: number;
    demo: boolean;
    state?: 'filled' | 'resting';
  };
  error?: { code: string; message: string };
}

export interface Hip3Position {
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
  entryPriceUsd: number;
}

export interface XStock {
  mint: string;
  ticker: string;
  symbolX: string;
  name: string;
  category: 'stock' | 'etf' | 'commodity' | 'crypto-adjacent';
  icon: string | null;
  decimals: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
}

export interface MemeToken {
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  priceChange24h: number | null;
  origin: 'pumpfun' | 'jupiter' | 'merged';
}

export interface JupiterListOpts {
  source?: 'pump' | 'jupiter' | 'both';
  tag?: string;
  sort?: 'market_cap' | 'volume' | 'recent' | 'koth';
  migrated?: boolean;
  limit?: number;
  offset?: number;
}

export interface JupQuoteRequest {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  slippageBps?: number;
}

export interface JupQuoteResponse {
  ok: true;
  quote: unknown;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { label: string }[];
}

export interface JupSwapRequest extends JupQuoteRequest {
  quote?: unknown;
}

export interface JupSwapResponse {
  ok: boolean;
  order?: {
    signature: string;
    confirmed: boolean;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    demo: boolean;
  };
  error?: { code: string; message: string };
}

export interface PmMarket {
  id: string;
  question: string;
  outcomes: { label: string; pricePct: number; tokenId?: string | null }[];
  closesAt: string | null;
  imageUrl?: string | null;
  category?: string | null;
  volume24hUsd?: number | null;
}

export interface PmOrderRequest {
  marketId: string;
  outcome: string;
  priceCents: number;
  qtyUsd: number;
}

export interface PmOrderResponse {
  ok: boolean;
  order?: {
    orderId: string;
    filledQtyUsd: number;
    priceCents: number;
    demo: boolean;
    state?: 'filled' | 'resting';
  };
  position?: MarketPosition;
  error?: { code: string; message: string };
}

export interface PmSellRequest {
  positionId: string;
  limitPriceCents: number;
  qtyUsd: number;
}

export interface PmTopTrader {
  wallet: string;
  name: string | null;
  amount: number;
  outcomeIndex: number;
  verified: boolean;
}

export interface PmTopTradersResponse {
  ok: boolean;
  source: 'polymarket' | 'demo';
  outcomes: { tokenId: string; holders: PmTopTrader[] }[];
  cached?: boolean;
}

export interface MarketPosition {
  id: string;
  venue: string;
  symbol: string;
  sideLong: boolean;
  qtyUsd: number;
  entryPriceUsd: number;
  externalRef: string | null;
  externalOrderId?: string | null;
  status: string;
  createdAt: string;
}

export interface MarketFill {
  id: string;
  venue: string;
  symbol: string;
  sideLong: boolean;
  qtyUsd: number;
  priceUsd: number;
  feeUsd: number;
  externalRef: string | null;
  createdAt: string;
}

export interface CollectorCard {
  id: string;
  name: string;
  collection: string;
  nftAddress: string;
  priceUsdc: number;
  imageUrl: string | null;
  tokenStandard: string;
  gradeLabel?: string | null;
  sellerWallet?: string | null;
  saleHistory?: unknown[];
}

export interface CollectorCardBuyRequest {
  cardId: string;
  nftAddress: string;
  expectedPriceUsdc: number;
  tokenStandard?: string;
  name?: string;
  imageUrl?: string;
}

export interface CollectorCardBuyResponse {
  ok: true;
  tradeId: string;
  provider: string;
  demo: boolean;
  sourced?: unknown;
}

export interface BookLevel {
  priceCents: number;
  sizeShares: number;
}

export interface Candle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

/**
 * F088 Sprint 18 — generated type surface.
 *
 * Re-exported from `./generated/api-schema.ts` (run `pnpm gen:types` to
 * refresh). Today the registry in `apps/api/src/lib/openapi.ts` covers the
 * `/v1/*` paths (offers, payments, sub-accounts, payouts, subscriptions,
 * balance); `/me/*` and `/markets/*` will follow in a focused PR that
 * extends the registry.
 *
 * Consumers that want a typed v1 request/response shape can pull the slice
 * directly:
 *
 * ```ts
 * import type { ApiSchema } from '@nexa/sdk';
 *
 * type Offer = ApiSchema['components']['schemas']['Offer'];
 * type CreatePaymentBody =
 *   ApiSchema['paths']['/v1/payments']['post']['requestBody']['content']['application/json'];
 * ```
 *
 * `ApiSchemaPaths` is a convenience alias for the same operation map.
 */
export type {
  paths,
  paths as ApiSchemaPaths,
  components,
  components as ApiSchemaComponents,
  operations,
} from './generated/api-schema.js';

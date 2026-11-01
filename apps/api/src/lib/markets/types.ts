/**
 * F093 Sprint 18 — unified `MarketAdapter` contract.
 *
 * The six venue order handlers in `routes/markets.ts` (Hyperliquid perps, HL
 * spot, HIP-3 stocks, xStocks, Jupiter memes, Polymarket predictions, plus
 * PumpFun) all repeat the same skeleton:
 *
 *    body parse + validation
 *  → gate (markets / trade / live-wallet)
 *  → idempotency-keyed reservation
 *  → venue.placeOrder
 *  → record-or-rollback
 *  → recordFee
 *  → expo push
 *
 * Only the parsing, the venue API call shape, and the push text vary. This
 * interface captures the per-venue variance so the orchestration above can
 * live in ONE parameterised handler (see `router-v2.ts`).
 *
 * Modelled on the existing `BridgeAdapter` ([lib/bridge-router.ts:72-76])
 * and `CardIssuer` ([lib/card/types.ts:57-77]) patterns — `readonly name`,
 * `readonly isLive`-style flag, plus per-venue operations.
 *
 * Rollout: gated behind the `MARKETS_ROUTER_V2` env flag. The existing
 * per-venue handlers stay live (and are the default) until each venue has
 * a `MarketAdapter` wrapper landed AND a shadow-test confirms identical
 * responses. After the cutover the legacy handlers come out.
 */

/**
 * Subset of route-layer `Venue` covered by the v2 router. PumpFun lives in a
 * separate routing scope today and isn't part of the F093 cutover; once it
 * adopts a `MarketAdapter` wrapper, add it here and to the route-layer
 * `Venue` / `FeeVenue` / `MarketVenue` unions in lockstep.
 */
export type MarketVenueName =
  | 'hyperliquid'
  | 'hyperliquid-spot'
  | 'hyperliquid-hip3'
  | 'jupiter'
  | 'polymarket'
  | 'xstocks';

/** Parse result — null when the body is invalid (caller emits 400). */
export type ParseResult<TInput> =
  | { ok: true; input: TInput }
  | { ok: false; code: string; details?: unknown };

/**
 * The slice of the place-order result the router-v2 handler needs for
 * recording, fees, and push notifications. Each adapter normalises its
 * venue-specific result shape to this envelope.
 */
export interface NormalizedOrderResult {
  /** Venue's order id (e.g. HL oid as `hl_${oid}`, PM ID, Jupiter txHash). */
  orderId: string;
  /** Symbol used for fee labelling + push body (coin / token / market id). */
  symbol: string;
  /** USD notional actually filled. Used for fee notional + push body. */
  filledQtyUsd: number;
  /** Entry price USD. Used for the position record + push body. */
  entryPriceUsd: number;
  /** True when the venue returned a synthetic demo result. */
  demo: boolean;
  /** Long/short flag carried through for the position record + push title. */
  sideLong: boolean;
  /** Venue execution state. Undefined means the legacy filled behavior. */
  state?: 'submitted' | 'filled' | 'resting' | 'triggered' | 'twap_active';
  /**
   * Adapter-passthrough payload the route emits verbatim under `order` in the
   * JSON response so the legacy shape stays byte-identical to the v1 handler.
   */
  raw: unknown;
}

/**
 * A `MarketAdapter` is a thin facade over the existing per-venue module
 * (hyperliquid.ts, polymarket.ts, …). The facade owns:
 *   - body parsing + validation
 *   - the venue-specific `placeOrder` signature
 *   - the result → NormalizedOrderResult mapping
 *
 * It does NOT own gating, idempotency, reservation, fee recording, or push
 * dispatch — those live in `router-v2.handlePlaceOrder` so all venues stay
 * in lockstep on safety-critical paths.
 */
export interface MarketAdapter<TInput = unknown> {
  readonly name: MarketVenueName;

  /** Trading-live check (mirrors the venue module's `isLiveTrading` flag). */
  readonly isLiveTrading: boolean;

  /**
   * Validate + shape the request body into venue-specific input. Returning
   * `{ ok: false, code }` causes the router to respond with `400 ${code}`.
   */
  parseBody(body: unknown): ParseResult<TInput>;

  /**
   * Execute the order against the venue. May throw — router-v2 catches and
   * rolls back the reservation. Returns the normalized envelope plus an
   * adapter-shaped `raw` payload that the route response surfaces verbatim.
   */
  placeOrder(input: TInput, ctx: MarketAdapterContext): Promise<NormalizedOrderResult>;

  /** Build the push-notification text for this venue's filled order. */
  pushFor(input: TInput, result: NormalizedOrderResult): {
    title: string;
    body: string;
    link: string;
    data: Record<string, unknown>;
  };
}

/** Per-request context the router hands the adapter. */
export interface MarketAdapterContext {
  privyWalletId: string | null;
  privyWalletAddress: `0x${string}` | null;
  privyDid: string | null;
  userId: string;
}

/**
 * Thrown from inside `MarketAdapter.placeOrder` when a venue-specific preflight
 * step (token-id lookup, CLOB credentials derive, Solana wallet provisioning,
 * quote fetch) fails. The router-v2 handler catches these BEFORE the generic
 * `venueFailure` 502 path and emits `marketError(c, statusCode, code)` to keep
 * the legacy v1 wire shape byte-identical.
 *
 * Codes used by today's adapters:
 *   - `solana_wallet_unavailable` (jupiter, 503)
 *   - `quote_unavailable` (jupiter, 422)
 *   - `polymarket_token_unavailable` (polymarket, 503)
 *   - `polymarket_clob_credentials_unavailable` (polymarket, 503)
 *
 * Application failures must NOT use 502/504: Cloudflare replaces origin
 * 502/504 responses with its own bare error page (no CORS headers), which
 * the browser surfaces as an opaque "Failed to fetch". 422 passes through.
 */
export class MarketPreflightError extends Error {
  readonly statusCode: 422 | 503;
  readonly code: string;
  constructor(statusCode: 422 | 503, code: string) {
    super(code);
    this.name = 'MarketPreflightError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

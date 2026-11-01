/**
 * Realtime fan-out hub — public contract.
 *
 * Parallel to the per-request `MarketAdapter` at `lib/markets/types.ts`. A
 * `MarketAdapter` is short-lived order placement with a `MarketPreflightError`
 * envelope; a `RealtimeAdapter` is long-lived pre-auth pub/sub that owns the
 * ONLY upstream WebSocket to a venue per pod and fans events out to many
 * clients via the central `Hub`.
 *
 * Two interfaces, sibling concerns — a venue module is free to implement both.
 *
 * Topic grammar lives in `topic.ts`. Every emitted event carries `topic` so
 * the hub can route by string match without re-parsing.
 *
 * WS everywhere: every adapter's steady-state path is a WebSocket. REST is
 * reserved for cold-start snapshot fill (`snapshot()`) and circuit-breaker
 * fallback only.
 */

import type { Hub } from './hub.js';

/* ── venue tags ──────────────────────────────────────────────────────────── */

/**
 * Venue tag — short, lowercase, hyphenated. Becomes the second segment of
 * every topic ("ticker:hl:BTC"). Add new tags here in lockstep with new
 * adapters in `venues/`.
 */
export type VenueTag =
  | 'hl'         // Hyperliquid perps + spot + HIP-3
  | 'pm'         // Polymarket CLOB
  | 'pyth'       // Pyth Hermes (blue-chip tokens + US equities)
  | 'helius'     // Solana account-state stream (long-tail memes)
  | 'jup'        // Jupiter (REST snapshot fill only — not a steady-state stream)
  | 'yahoo'      // Yahoo Finance (REST snapshot fallback for equities)
  | 'tv'         // Mathieu2301 @mathieuc/tradingview WS proxy — REST snapshot only
                 // (broad symbol catalog: forex, indices, long-tail equities)
  | 'rest'       // Generic REST fallback when an adapter's WS is breaker-open
  | 'nexa';      // In-process events (order lifecycle publisher fan-out)

/* ── topic grammar (string form parsed by topic.ts) ───────────────────────── */

export type Interval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

export type TopicKind = 'ticker' | 'candle' | 'book' | 'trades' | 'stock' | 'meme' | 'predictions';

/**
 * Stringly-typed topic. The grammar is enforced by `topic.parse()` / `format()`.
 *
 * Examples:
 *   ticker:hl:BTC                 — Hyperliquid BTC mid price tick stream
 *   candle:hl:BTC:1m              — Hyperliquid BTC 1-minute candles
 *   book:hl:BTC:50                — Hyperliquid BTC order book, top-50 depth
 *   trades:hl:BTC                 — Hyperliquid BTC trade tape
 *   predictions:pm:0x123…         — Polymarket prediction token feed
 *   ticker:pyth:SOL               — Pyth Hermes SOL price
 *   stock:pyth:AAPL               — Pyth Hermes AAPL equity price
 *   meme:helius:<mint>            — Helius pool-state derived meme price
 */
export type Topic = string & { readonly __brand: 'Topic' };

/* ── event union ─────────────────────────────────────────────────────────── */

interface BaseEvent {
  readonly topic: Topic;
  /** Unix ms at the venue when the event was published. */
  readonly ts: number;
  /**
   * Age of the upstream tick at the moment the hub forwarded it to clients,
   * in milliseconds. Clients use this to dim/grey out stale prices instead of
   * lying. >1000 = visibly stale, >5000 = the UI should flag the row.
   */
  readonly lastTickAgeMs: number;
  /** Which venue (or fallback) produced this event. */
  readonly src: VenueTag;
  /**
   * True when the hub emitted this event from a fallback path (REST snapshot
   * during breaker-open, after-hours snapshot, etc.) rather than the live WS.
   * Always false on the happy path.
   */
  readonly stale?: boolean;
}

export interface TickEvent extends BaseEvent {
  readonly t: 'tick';
  /** Price in venue-native quote units (USD for most, USDC for SOL DEX). */
  readonly px: number;
}

export interface CandleEvent extends BaseEvent {
  readonly t: 'candle';
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  /** True once the candle is closed (won't be updated further). */
  readonly closed: boolean;
}

export type BookLevel = readonly [px: number, sz: number];

export interface BookEvent extends BaseEvent {
  readonly t: 'book';
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  /** Monotonic upstream sequence for gap detection. 0 if the venue doesn't expose one. */
  readonly seq: number;
}

export interface TradeEvent extends BaseEvent {
  readonly t: 'trade';
  readonly px: number;
  readonly sz: number;
  readonly side: 'buy' | 'sell';
}

/**
 * Per-user order lifecycle event. Fan-out by `apps/api/src/realtime/venues/
 * orders.ts` on the priv-namespaced topic `priv:<userId>:orders`. Mirrors the
 * `OrderEvent` shape in `@nexa/shared-zod/realtime`.
 */
export type MarketOrderStatus =
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

export type MarketVenue =
  | 'hyperliquid'
  | 'hyperliquid-spot'
  | 'hyperliquid-hip3'
  | 'jupiter'
  | 'xstocks'
  | 'polymarket';

export interface OrderEvent extends BaseEvent {
  readonly t: 'order';
  readonly orderId: string;
  readonly marketVenue: MarketVenue;
  readonly symbol: string;
  readonly status: MarketOrderStatus;
  readonly sideLong: boolean;
  readonly qtyUsd: number;
  readonly filledQtyUsd?: number | null;
  readonly avgFillPriceUsd?: number | null;
  readonly externalOrderId?: string | null;
  readonly errorCode?: string | null;
}

/**
 * Compact per-position snapshot embedded in an `AccountEvent`. Field names
 * mirror `HlPosition` (`lib/markets/hyperliquid.ts`) plus the liquidation
 * price webData2 carries that the REST clearinghouse mapper drops.
 */
export interface AccountPosition {
  readonly coin: string;
  readonly sideLong: boolean;
  /** Signed-size magnitude in the base coin (e.g. 0.0053 BTC). */
  readonly qty: number;
  readonly qtyUsd: number;
  readonly entryPriceUsd: number;
  readonly unrealizedPnlUsd: number;
  readonly leverage: number;
  readonly liquidationPriceUsd: number | null;
}

/**
 * Per-user account/margin/positions snapshot from Hyperliquid's `webData2`
 * stream. Fan-out on the priv-namespaced topic `priv:<userId>:account` by
 * `venues/hyperliquid-user.ts` (behind `HL_USER_STREAMS`). Mirrors the
 * `AccountEvent` shape in `@nexa/shared-zod/realtime`.
 */
export interface AccountEvent extends BaseEvent {
  readonly t: 'account';
  readonly equityUsd: number;
  readonly marginUsedUsd: number;
  readonly withdrawableUsd: number;
  readonly accountValueUsd: number;
  readonly positions: readonly AccountPosition[];
}

/**
 * Per-user trade fill from Hyperliquid's `userFills` stream. Fan-out on
 * `priv:<userId>:fills`. `orderId` uses the same `hl_<oid>` form as the REST
 * fills mapper (`hyperliquid.ts` getUserFills) so consumers can correlate.
 */
export interface FillEvent extends BaseEvent {
  readonly t: 'fill';
  readonly orderId: string;
  readonly coin: string;
  readonly sideLong: boolean;
  readonly px: number;
  readonly sz: number;
  readonly feeUsd: number;
  readonly closedPnlUsd: number | null;
  /** Venue direction label, e.g. "Open Long" / "Close Short". */
  readonly dir: string;
  readonly hash: string;
  readonly liquidation: boolean;
}

export type FeedEvent =
  | TickEvent
  | CandleEvent
  | BookEvent
  | TradeEvent
  | OrderEvent
  | AccountEvent
  | FillEvent;

/* ── adapter contract ────────────────────────────────────────────────────── */

/**
 * Health snapshot a venue exposes to the hub's `/v1/feeds/health` summarizer.
 * Cheap to compute — the hub may pull every 5s.
 */
export interface VenueHealth {
  /** WS state from the adapter's point of view. */
  readonly ws: 'open' | 'connecting' | 'reconnecting' | 'closed' | 'open-degraded';
  /** Circuit breaker state. */
  readonly breakerState: 'closed' | 'half-open' | 'open';
  /** ms since the last event of ANY topic on this venue. -1 if no event yet. */
  readonly lastEventAgeMs: number;
  /** Active client-facing subscriptions on this venue (sum across topics). */
  readonly subscriberCount: number;
  /**
   * Which upstream is currently producing events: the adapter's primary WS,
   * a registered fallback adapter, or the REST snapshot path during outage.
   */
  readonly upstream: 'primary' | 'fallback' | 'rest';
}

/**
 * A `RealtimeAdapter` owns the upstream WebSocket(s) for one venue and emits
 * normalized `FeedEvent`s into the central hub. Lifecycle:
 *
 *   `start(hub)` → open upstream, register breaker, begin emitting
 *   `subscribe(topic)` → ref-count++, opens upstream sub when first
 *   `unsubscribe(topic)` → ref-count--, closes upstream sub when last
 *   `snapshot(topic)` → REST-fill for cold-start / reconnect replay
 *   `stop()` → close everything
 *
 * Throwing from `start()` or `subscribe()` blocks the registry. Errors mid-
 * stream go through the breaker, not to the hub.
 */
export interface RealtimeAdapter {
  readonly venue: VenueTag;

  start(hub: Hub): Promise<void>;
  stop(): Promise<void>;

  /** Idempotent. Increments ref-count; opens upstream sub on 0→1 transition. */
  subscribe(topic: Topic): void;
  /** Decrements ref-count; closes upstream sub on 1→0 transition. */
  unsubscribe(topic: Topic): void;

  /**
   * Cold-start / reconnect snapshot. May make REST calls. Returns the latest
   * known event(s) for this topic — typically one TickEvent (latest mid), or
   * up to ~500 CandleEvents for a candle topic. Used to seed the hub's last-
   * known cache so a freshly-connected client gets immediate data without
   * waiting for the next WS tick.
   */
  snapshot(topic: Topic): Promise<FeedEvent[]>;

  /** Cheap health probe surfaced via `/v1/feeds/health`. */
  healthSnapshot(): VenueHealth;
}

/* ── client-facing wire protocol (server ↔ client over /v1/stream) ───────── */

/**
 * Inbound from clients. The router validates shape + applies per-client caps
 * (max topics, msg rate) before forwarding to the hub.
 */
export type ClientOp =
  | { readonly op: 'sub'; readonly topics: readonly Topic[] }
  | { readonly op: 'unsub'; readonly topics: readonly Topic[] }
  | { readonly op: 'ping' };

/**
 * Outbound to clients. Events flow through as-is; errors get a typed envelope
 * so clients can react without parsing strings.
 */
export type ServerOp =
  | FeedEvent
  | { readonly op: 'pong'; readonly ts: number }
  | { readonly op: 'err'; readonly code: ServerErrCode; readonly topic?: Topic }
  | { readonly op: 'ready'; readonly accepted: readonly Topic[]; readonly serverVersion: string };

export type ServerErrCode =
  | 'unauthorized'
  | 'topic_invalid'
  | 'topic_cap_exceeded'
  | 'rate_limited'
  | 'venue_unavailable'
  | 'denied_acl'
  | 'internal';

/**
 * Wire-shape types shared with the server's realtime hub.
 *
 * Kept structurally identical to `apps/api/src/realtime/types.ts` so that NEO
 * (Expo) and MAZE (Vite web) both speak the same protocol the server emits.
 * When the OpenAPI codegen lands (F088), this file is regenerated from the
 * server's Zod schemas — for now it's a hand-mirrored copy with the same
 * shape, deliberately verbatim so a future codegen replacement is a no-op
 * for callers.
 *
 * Re-import-safe: this module has no runtime dependencies, so consuming it
 * from React Native (Hermes) or browser (any bundler) costs nothing at
 * runtime.
 */

export type VenueTag =
  | 'hl'
  | 'pm'
  | 'pyth'
  | 'helius'
  | 'jup'
  | 'yahoo'
  | 'tv'
  | 'rest'
  | 'nexa';

export type Interval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

export type TopicKind = 'ticker' | 'candle' | 'book' | 'trades' | 'stock' | 'meme' | 'predictions';

export type Topic = string & { readonly __brand: 'Topic' };

interface BaseEvent {
  readonly topic: Topic;
  readonly ts: number;
  readonly lastTickAgeMs: number;
  readonly src: VenueTag;
  readonly stale?: boolean;
}

export interface TickEvent extends BaseEvent {
  readonly t: 'tick';
  readonly px: number;
}

export interface CandleEvent extends BaseEvent {
  readonly t: 'candle';
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly closed: boolean;
}

export type BookLevel = readonly [px: number, sz: number];

export interface BookEvent extends BaseEvent {
  readonly t: 'book';
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly seq: number;
}

export interface TradeEvent extends BaseEvent {
  readonly t: 'trade';
  readonly px: number;
  readonly sz: number;
  readonly side: 'buy' | 'sell';
}

/**
 * Order lifecycle event — fans out on the priv-namespaced topic
 * `priv:<userId>:orders`. Mirror of `apps/api/src/realtime/types.ts`
 * `OrderEvent` (kept hand-mirrored for the zero-runtime-zod constraint).
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
 * Compact per-position snapshot embedded in an `AccountEvent`. Mirror of
 * `apps/api/src/realtime/types.ts` `AccountPosition`.
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
 * Per-user account snapshot from Hyperliquid webData2 — fans out on
 * `priv:<userId>:account`. Mirror of the server `AccountEvent`.
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
 * Per-user trade fill from Hyperliquid userFills — fans out on
 * `priv:<userId>:fills`. Mirror of the server `FillEvent`.
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

/* ── client → server ops ─────────────────────────────────────────────────── */

export type ClientOp =
  | { readonly op: 'sub'; readonly topics: readonly Topic[] }
  | { readonly op: 'unsub'; readonly topics: readonly Topic[] }
  | { readonly op: 'ping' };

/* ── server → client envelope (SSE / WS) ─────────────────────────────────── */

export type ServerErrCode =
  | 'unauthorized'
  | 'topic_invalid'
  | 'topic_cap_exceeded'
  | 'rate_limited'
  | 'venue_unavailable'
  | 'denied_acl'
  | 'internal';

export type ServerOp =
  | FeedEvent
  | { readonly op: 'pong'; readonly ts: number }
  | { readonly op: 'err'; readonly code: ServerErrCode; readonly topic?: Topic }
  | { readonly op: 'ready'; readonly accepted: readonly Topic[]; readonly serverVersion: string };

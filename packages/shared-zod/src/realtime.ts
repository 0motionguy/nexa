/**
 * Realtime hub wire schemas — single source of truth for the protocol that
 * flows between `apps/api/src/realtime/*` (server) and `@nexa/realtime-client`
 * (NEO + MAZE).
 *
 * The server's `apps/api/src/realtime/types.ts` re-exports the inferred types
 * from this module so there's exactly one definition of `FeedEvent` /
 * `ClientOp` / `ServerOp` in the runtime path.
 *
 * `@nexa/realtime-client` keeps a hand-mirrored TS-only copy of these types
 * (its `types.ts` carries the rationale) so the mobile bundle doesn't pull
 * in zod at runtime. A type-level isomorphism check in
 * `apps/api/src/realtime/realtime.spec.ts` guards drift between the two.
 *
 * The full topic grammar (kind:venue:symbol[:param]) is enforced by
 * `apps/api/src/realtime/topic.ts` at the router boundary. The schemas here
 * only assert the surrounding envelope.
 */

import { z } from 'zod';

/* ── venue + topic primitives ─────────────────────────────────────────────── */

export const VenueTagZ = z.enum([
  'hl',     // Hyperliquid perps + spot + HIP-3
  'pm',     // Polymarket CLOB
  'pyth',   // Pyth Hermes (blue-chip tokens + US equities)
  'helius', // Solana account-state stream (long-tail memes)
  'jup',    // Jupiter (REST snapshot fill only)
  'yahoo',  // Yahoo Finance (REST snapshot fallback for equities)
  'tv',     // @mathieuc/tradingview WS proxy (REST snapshot only)
  'rest',   // Generic REST fallback when an adapter's WS is breaker-open
  'nexa',   // In-process events (e.g. order lifecycle publisher fan-out)
]);
export type VenueTag = z.infer<typeof VenueTagZ>;

export const IntervalZ = z.enum([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);
export type Interval = z.infer<typeof IntervalZ>;

export const TopicKindZ = z.enum([
  'ticker',
  'candle',
  'book',
  'trades',
  'stock',
  'meme',
  'predictions',
]);
export type TopicKind = z.infer<typeof TopicKindZ>;

/**
 * Branded topic string. Content validation (grammar enforcement) is performed
 * by `topic.parse()` at the router boundary; here we only assert it's a
 * non-empty string within the upper length cap that `topic.ts` accepts.
 */
export const TopicZ = z.string().min(1).max(256).brand<'Topic'>();
export type Topic = z.infer<typeof TopicZ>;

/* ── feed event union ─────────────────────────────────────────────────────── */

const BaseEventZ = z.object({
  topic: TopicZ,
  /** Unix ms at the venue when the event was published. */
  ts: z.number().int().nonnegative(),
  /**
   * Age of the upstream tick at hub-forward time, in ms. Clients use this
   * to dim/grey stale rows. >1000 = visibly stale, >5000 = the UI should flag.
   */
  lastTickAgeMs: z.number().int().nonnegative(),
  src: VenueTagZ,
  /**
   * True when the hub emitted this event from a fallback path (REST snapshot
   * during breaker-open, after-hours snapshot, etc.) rather than the live WS.
   */
  stale: z.boolean().optional(),
});

export const TickEventZ = BaseEventZ.extend({
  t: z.literal('tick'),
  /** Price in venue-native quote units. */
  px: z.number(),
});
export type TickEvent = z.infer<typeof TickEventZ>;

export const CandleEventZ = BaseEventZ.extend({
  t: z.literal('candle'),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
  /** True once the candle is closed (won't be updated further). */
  closed: z.boolean(),
});
export type CandleEvent = z.infer<typeof CandleEventZ>;

export const BookLevelZ = z.tuple([z.number(), z.number()]);
export type BookLevel = z.infer<typeof BookLevelZ>;

export const BookEventZ = BaseEventZ.extend({
  t: z.literal('book'),
  bids: z.array(BookLevelZ),
  asks: z.array(BookLevelZ),
  /** Monotonic upstream sequence for gap detection. 0 if the venue doesn't expose one. */
  seq: z.number().int().nonnegative(),
});
export type BookEvent = z.infer<typeof BookEventZ>;

export const TradeEventZ = BaseEventZ.extend({
  t: z.literal('trade'),
  px: z.number(),
  sz: z.number(),
  side: z.enum(['buy', 'sell']),
});
export type TradeEvent = z.infer<typeof TradeEventZ>;

/**
 * Market order lifecycle status — mirrors `MarketOrderStatus` in
 * `apps/api/src/store/types.ts`. The Sprint 1 lifecycle work extended the
 * legacy four-value status to this richer set so the UI can render every
 * audit transition (reserved → submitted → accepted → filled etc.).
 */
export const MarketOrderStatusZ = z.enum([
  'pending',
  'open',
  'closed',
  'created',
  'reserved',
  'submitted',
  'accepted',
  'partially_filled',
  'filled',
  'resting',
  'cancel_requested',
  'canceled',
  'expired',
  'rejected',
  'failed',
  'reconciled',
]);
export type MarketOrderStatus = z.infer<typeof MarketOrderStatusZ>;

export const MarketVenueZ = z.enum([
  'hyperliquid',
  'hyperliquid-spot',
  'hyperliquid-hip3',
  'jupiter',
  'xstocks',
  'polymarket',
]);
export type MarketVenue = z.infer<typeof MarketVenueZ>;

/**
 * Per-user order lifecycle event. Fan-out target is
 * `priv:<userId>:orders` — one subscription, every event for that user.
 * Consumers filter by `orderId` to update specific rows.
 *
 * Wired by `apps/api/src/realtime/venues/orders.ts`, which subscribes to
 * the in-process `lifecyclePublisher` (see
 * `apps/api/src/lib/lifecycle/publisher.ts`) and republishes each
 * envelope into the hub as an `OrderEvent` on the corresponding
 * priv-namespaced topic.
 */
export const OrderEventZ = BaseEventZ.extend({
  t: z.literal('order'),
  orderId: z.string().uuid(),
  marketVenue: MarketVenueZ,
  symbol: z.string().min(1),
  status: MarketOrderStatusZ,
  sideLong: z.boolean(),
  qtyUsd: z.number(),
  filledQtyUsd: z.number().nullable().optional(),
  avgFillPriceUsd: z.number().nullable().optional(),
  externalOrderId: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
});
export type OrderEvent = z.infer<typeof OrderEventZ>;

/**
 * Compact per-position snapshot embedded in an `AccountEvent`. Field names
 * mirror the server's `HlPosition` mapper plus the liquidation price that
 * webData2 carries.
 */
export const AccountPositionZ = z.object({
  coin: z.string().min(1),
  sideLong: z.boolean(),
  /** Signed-size magnitude in the base coin (e.g. 0.0053 BTC). */
  qty: z.number(),
  qtyUsd: z.number(),
  entryPriceUsd: z.number(),
  unrealizedPnlUsd: z.number(),
  leverage: z.number(),
  liquidationPriceUsd: z.number().nullable(),
});
export type AccountPosition = z.infer<typeof AccountPositionZ>;

/**
 * Per-user account/margin/positions snapshot from Hyperliquid's `webData2`
 * stream. Fan-out target is `priv:<userId>:account` (server:
 * `realtime/venues/hyperliquid-user.ts`, behind `HL_USER_STREAMS`).
 */
export const AccountEventZ = BaseEventZ.extend({
  t: z.literal('account'),
  equityUsd: z.number(),
  marginUsedUsd: z.number(),
  withdrawableUsd: z.number(),
  accountValueUsd: z.number(),
  positions: z.array(AccountPositionZ),
});
export type AccountEvent = z.infer<typeof AccountEventZ>;

/**
 * Per-user trade fill from Hyperliquid's `userFills` stream. Fan-out target
 * is `priv:<userId>:fills`. `orderId` uses the same `hl_<oid>` form as the
 * REST fills mapper so consumers can correlate rows.
 */
export const FillEventZ = BaseEventZ.extend({
  t: z.literal('fill'),
  orderId: z.string().min(1),
  coin: z.string().min(1),
  sideLong: z.boolean(),
  px: z.number(),
  sz: z.number(),
  feeUsd: z.number(),
  closedPnlUsd: z.number().nullable(),
  /** Venue direction label, e.g. "Open Long" / "Close Short". */
  dir: z.string(),
  hash: z.string(),
  liquidation: z.boolean(),
});
export type FillEvent = z.infer<typeof FillEventZ>;

export const FeedEventZ = z.discriminatedUnion('t', [
  TickEventZ,
  CandleEventZ,
  BookEventZ,
  TradeEventZ,
  OrderEventZ,
  AccountEventZ,
  FillEventZ,
]);
export type FeedEvent = z.infer<typeof FeedEventZ>;

/* ── client → server ops ──────────────────────────────────────────────────── */

const SubOpZ = z.object({
  op: z.literal('sub'),
  topics: z.array(TopicZ),
});

const UnsubOpZ = z.object({
  op: z.literal('unsub'),
  topics: z.array(TopicZ),
});

const PingOpZ = z.object({
  op: z.literal('ping'),
});

export const ClientOpZ = z.discriminatedUnion('op', [SubOpZ, UnsubOpZ, PingOpZ]);
export type ClientOp = z.infer<typeof ClientOpZ>;

/* ── server → client ops ──────────────────────────────────────────────────── */

export const ServerErrCodeZ = z.enum([
  'unauthorized',
  'topic_invalid',
  'topic_cap_exceeded',
  'rate_limited',
  'venue_unavailable',
  'denied_acl',
  'internal',
]);
export type ServerErrCode = z.infer<typeof ServerErrCodeZ>;

const PongZ = z.object({
  op: z.literal('pong'),
  ts: z.number().int().nonnegative(),
});

const ErrZ = z.object({
  op: z.literal('err'),
  code: ServerErrCodeZ,
  topic: TopicZ.optional(),
});

const ReadyZ = z.object({
  op: z.literal('ready'),
  accepted: z.array(TopicZ),
  serverVersion: z.string().min(1),
});

/**
 * `ServerOp` is the union of every payload the server may emit. `FeedEvent`s
 * are discriminated on `t`; the control envelopes (pong/err/ready) are
 * discriminated on `op`. We use `z.union` instead of `z.discriminatedUnion`
 * because the two halves use different discriminator keys.
 */
export const ServerOpZ = z.union([FeedEventZ, PongZ, ErrZ, ReadyZ]);
export type ServerOp = z.infer<typeof ServerOpZ>;

/* ── venue health snapshot (mirrored on /healthz + /v1/feeds/health) ──────── */

export const VenueHealthZ = z.object({
  ws: z.enum(['open', 'connecting', 'reconnecting', 'closed', 'open-degraded']),
  breakerState: z.enum(['closed', 'half-open', 'open']),
  lastEventAgeMs: z.number().int(),
  subscriberCount: z.number().int().nonnegative(),
  upstream: z.enum(['primary', 'fallback', 'rest']),
});
export type VenueHealth = z.infer<typeof VenueHealthZ>;

/**
 * Non-fatal realtime section embedded in `/healthz` so Caddy/Cloudflare
 * uplinks see realtime status without it flipping the pod-level `ok` flag.
 * A provider reconnect is normal and must not drain the pod.
 */
export const HealthzRealtimeZ = z.union([
  z.object({
    disabled: z.literal(true),
  }),
  z.object({
    hyperliquid: VenueHealthZ.optional(),
    polymarket: VenueHealthZ.optional(),
    clients: z.number().int().nonnegative(),
  }),
]);
export type HealthzRealtime = z.infer<typeof HealthzRealtimeZ>;

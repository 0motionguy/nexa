/**
 * Topic grammar — client-side mirror of `apps/api/src/realtime/topic.ts`.
 *
 * Hand-mirrored verbatim (same set of kinds + venues + intervals + caps) so
 * malformed topics fail FAST on the client without round-tripping the server.
 * When the codegen lands the server module becomes the source of truth and
 * this becomes its generated counterpart.
 */

import type { Interval, Topic, TopicKind, VenueTag } from './types.js';

const KIND_SET: ReadonlySet<TopicKind> = new Set<TopicKind>([
  'ticker',
  'candle',
  'book',
  'trades',
  'stock',
  'meme',
  'predictions',
]);

// NOTE: 'nexa' is deliberately ABSENT — it exists in VenueTag only as a
// provenance label (OrderEvent.src, priv-topic metrics), never as a
// subscribable public venue. The server set (apps/api) matches.
const VENUE_SET: ReadonlySet<VenueTag> = new Set<VenueTag>([
  'hl',
  'pm',
  'pyth',
  'helius',
  'jup',
  'yahoo',
  'tv',
  'rest',
]);

const INTERVAL_SET: ReadonlySet<Interval> = new Set<Interval>([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '8h', '12h',
  '1d', '3d', '1w', '1M',
]);

const SYMBOL_MAX = 96;
const DEPTH_MAX = 1000;

export interface ParsedTopic {
  readonly kind: TopicKind;
  readonly venue: VenueTag;
  readonly symbol: string;
  readonly interval?: Interval;
  readonly depth?: number;
}

export function parse(raw: string): ParsedTopic | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 256) return null;

  const parts = raw.split(':');
  if (parts.length < 3) return null;

  const [kindStr, venueStr] = parts;

  if (!KIND_SET.has(kindStr as TopicKind)) return null;
  if (!VENUE_SET.has(venueStr as VenueTag)) return null;

  const kind = kindStr as TopicKind;
  const venue = venueStr as VenueTag;

  // Tolerant middle-join: venue symbols may themselves contain `:` (HIP-3
  // builder-dex coins are literally `xyz:SKHX`). Param kinds (`candle`/`book`)
  // peel their REQUIRED, validated param off the END; everything between the
  // venue and the param is the symbol. Non-param kinds treat the entire tail
  // as the symbol. Every previously-valid topic parses identically.
  if (kind === 'candle') {
    if (parts.length < 4) return null;
    const interval = parts[parts.length - 1] as Interval;
    if (!INTERVAL_SET.has(interval)) return null;
    const symbol = parts.slice(2, -1).join(':');
    if (!symbol || symbol.length > SYMBOL_MAX) return null;
    return { kind, venue, symbol, interval };
  }
  if (kind === 'book') {
    if (parts.length < 4) return null;
    const depth = Number(parts[parts.length - 1]);
    if (!Number.isInteger(depth) || depth <= 0 || depth > DEPTH_MAX) return null;
    const symbol = parts.slice(2, -1).join(':');
    if (!symbol || symbol.length > SYMBOL_MAX) return null;
    return { kind, venue, symbol, depth };
  }
  const symbol = parts.slice(2).join(':');
  if (!symbol || symbol.length > SYMBOL_MAX) return null;
  return { kind, venue, symbol };
}

export function format(p: ParsedTopic): Topic {
  if (p.kind === 'candle') {
    if (!p.interval) throw new Error('format: candle topic requires interval');
    return `candle:${p.venue}:${p.symbol}:${p.interval}` as Topic;
  }
  if (p.kind === 'book') {
    if (!p.depth) throw new Error('format: book topic requires depth');
    return `book:${p.venue}:${p.symbol}:${p.depth}` as Topic;
  }
  return `${p.kind}:${p.venue}:${p.symbol}` as Topic;
}

export function isValid(raw: string): boolean {
  return parse(raw) !== null;
}

/* ── ergonomic constructors so callers don't string-template manually ────── */

export const tickerTopic = (venue: VenueTag, symbol: string): Topic =>
  format({ kind: 'ticker', venue, symbol });

export const candleTopic = (venue: VenueTag, symbol: string, interval: Interval): Topic =>
  format({ kind: 'candle', venue, symbol, interval });

export const bookTopic = (venue: VenueTag, symbol: string, depth: number): Topic =>
  format({ kind: 'book', venue, symbol, depth });

export const tradesTopic = (venue: VenueTag, symbol: string): Topic =>
  format({ kind: 'trades', venue, symbol });

export const predictionsTopic = (tokenId: string): Topic =>
  format({ kind: 'predictions', venue: 'pm', symbol: tokenId });

export const stockTopic = (ticker: string): Topic =>
  format({ kind: 'stock', venue: 'pyth', symbol: ticker });

/**
 * Sprint 1 lifecycle bridge — priv-namespaced topic that delivers every
 * order lifecycle event for the authenticated user. ACL is enforced
 * server-side; only the matching session userId may subscribe.
 *
 * Wire format: `priv:<userId>:orders`. Consumers receive `OrderEvent`
 * payloads (see types.ts) — filter by `event.orderId` to update specific
 * rows / sheets without per-order subscriptions.
 */
export const privOrdersTopic = (userId: string): Topic => {
  if (!userId) throw new Error('privOrdersTopic: userId required');
  return `priv:${userId}:orders` as Topic;
};

/**
 * Hyperliquid webData2 account snapshots (`AccountEvent` payloads). Same
 * per-user ACL as `privOrdersTopic`. Silent unless the server runs with
 * `HL_USER_STREAMS=1`.
 */
export const privAccountTopic = (userId: string): Topic => {
  if (!userId) throw new Error('privAccountTopic: userId required');
  return `priv:${userId}:account` as Topic;
};

/** Hyperliquid userFills (`FillEvent` payloads). Same ACL + flag as above. */
export const privFillsTopic = (userId: string): Topic => {
  if (!userId) throw new Error('privFillsTopic: userId required');
  return `priv:${userId}:fills` as Topic;
};

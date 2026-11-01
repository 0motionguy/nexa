/**
 * Topic grammar — single source of truth for the strings that flow over the
 * wire between the hub and connected clients.
 *
 * Grammar (each `:`-separated):
 *   <kind>:<venue>:<symbol>[:<param>]
 *
 * - kind   ∈ {ticker, candle, book, trades, stock, meme, predictions}
 * - venue  ∈ VenueTag (hl, pm, pyth, helius, jup, yahoo, rest)
 * - symbol non-empty, no `:` characters, length ≤ 96
 * - param  optional, kind-specific:
 *     candle → Interval (1m/5m/1h/…)
 *     book   → positive integer depth (10/25/50/100)
 *     others → must be absent
 *
 * `parse` returns `null` on any deviation. The router uses parse-then-emit
 * `topic_invalid` so malformed strings never reach venue adapters.
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
  /** Defined only for `candle` topics. */
  readonly interval?: Interval;
  /** Defined only for `book` topics. */
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

  // ticker | trades | stock | meme | predictions → whole tail is the symbol
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

/** Type-asserting helper for tests + internal callers that built a valid string. */
export function asTopic(raw: string): Topic {
  if (!parse(raw)) throw new Error(`asTopic: invalid topic "${raw}"`);
  return raw as Topic;
}

/** Cheap predicate when you don't need the parsed structure. */
export function isValid(raw: string): boolean {
  return parse(raw) !== null;
}

/**
 * Per-user ACL convention for "private" topics.
 *
 * Today's grammar only covers public market data — no topic carries a per-
 * user signal. The hub design allows that to change without rewiring the
 * router by reserving the `priv:` prefix:
 *
 *     priv:<userId>:<kind>:<...>
 *
 * The SSE/WS handler MUST validate that the prefix matches the authenticated
 * session before calling `hub.subscribe`; otherwise any authed user would be
 * able to read any other user's private feed (positions, fills, alerts,
 * future webhook deliveries) by guessing the userId.
 *
 * Returns:
 *   - null            if the topic is not a `priv:` topic (skip the check)
 *   - { userId, rest } if the prefix is well-formed
 *
 * A malformed `priv:` topic (no userId segment, empty rest) returns
 * `{ userId: '', rest: '' }` so the caller can reject it as "denied" rather
 * than treat it as a public topic. The router currently routes through
 * `parse()` for the public-grammar check; this helper is a complementary
 * gate that runs FIRST on the raw string.
 */
export interface PrivPrefix {
  readonly userId: string;
  readonly rest: string;
}

const PRIV_PREFIX = 'priv:';

export function parsePrivTopic(raw: string): PrivPrefix | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith(PRIV_PREFIX)) return null;
  const tail = raw.slice(PRIV_PREFIX.length);
  const colon = tail.indexOf(':');
  if (colon < 0) return { userId: tail, rest: '' };
  return { userId: tail.slice(0, colon), rest: tail.slice(colon + 1) };
}

/**
 * Sprint 1 lifecycle bridge — recognized priv-namespaced topic kinds. Used
 * by router/SSE + ws-server to accept these topics through the hub WITHOUT
 * routing through the public `parse()` grammar (priv topics are opaque to
 * adapters; they're fed by the in-process lifecycle publisher).
 *
 * Kinds:
 *   orders  — every order lifecycle event for that user (in-process publisher)
 *   account — Hyperliquid webData2 account/margin/positions snapshots
 *   fills   — Hyperliquid userFills trade fills
 * (`account` + `fills` are fed by `venues/hyperliquid-user.ts` behind
 * `HL_USER_STREAMS`; with the flag off they are valid-but-silent topics.)
 */
const PRIV_TOPIC_KINDS = new Set(['orders', 'account', 'fills']);

export type PrivTopicKind = 'orders' | 'account' | 'fills';

export interface ValidatedPrivTopic {
  readonly userId: string;
  readonly kind: PrivTopicKind;
}

/**
 * Return the validated priv-topic descriptor IF `raw` matches the
 * `priv:<userId>:<kind>` form AND the kind is recognized. Returns null for
 * any other topic shape so callers can fall back to the public grammar.
 */
export function parsePrivKindTopic(raw: string): ValidatedPrivTopic | null {
  const priv = parsePrivTopic(raw);
  if (!priv) return null;
  if (!priv.userId || !PRIV_TOPIC_KINDS.has(priv.rest)) return null;
  return { userId: priv.userId, kind: priv.rest as PrivTopicKind };
}

/** Builder so callers don't hand-template the `priv:<userId>:orders` string. */
export function privOrdersTopic(userId: string): Topic {
  if (!userId) throw new Error('privOrdersTopic: userId required');
  return `priv:${userId}:orders` as Topic;
}

/** Builder for the webData2 account-snapshot topic. */
export function privAccountTopic(userId: string): Topic {
  if (!userId) throw new Error('privAccountTopic: userId required');
  return `priv:${userId}:account` as Topic;
}

/** Builder for the userFills topic. */
export function privFillsTopic(userId: string): Topic {
  if (!userId) throw new Error('privFillsTopic: userId required');
  return `priv:${userId}:fills` as Topic;
}

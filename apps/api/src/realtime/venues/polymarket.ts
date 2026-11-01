/**
 * Polymarket realtime adapter — sole upstream CLOB WebSocket per pod.
 *
 * Owns one connection to `wss://ws-subscriptions-clob.polymarket.com/ws/market`
 * and demuxes its `book` / `price_change` / `last_trade_price` /
 * `best_bid_ask` / `tick_size_change` frames into normalised `FeedEvent`s the
 * central `Hub` fans out to many clients.
 *
 * Topics handled (see `topic.ts`):
 *   predictions:pm:<tokenId>     — mid / last-trade tick stream
 *   book:pm:<tokenId>:<depth>    — orderbook snapshot+deltas, truncated
 *   trades:pm:<tokenId>          — trade tape
 *
 * Subscription model. CLOB batches token ids into one
 * `{ type: "market", assets_ids: [...] }` frame and does NOT support per-id
 * unsubscribe — to drop one id we resend the full active set. Mirrors
 * `neo/lib/polymarket-ws.ts` (the client): track the set, debounce sub/unsub
 * by 200ms, resubmit the full subscribe frame.
 *
 * Steady-state path is WebSocket. REST (`https://clob.polymarket.com/book`
 * by tokenId) is only touched on `snapshot()` calls or breaker-open fills.
 */

import { CircuitBreaker } from '../breaker.js';
import { StallWatchdog } from '../stall-watchdog.js';
import type { Hub } from '../hub.js';
import { parse } from '../topic.js';
import type {
  BookEvent, BookLevel, FeedEvent, RealtimeAdapter,
  TickEvent, Topic, TradeEvent, VenueHealth, VenueTag,
} from '../types.js';
import {
  feedBreakerState, feedDisconnectTotal, feedReconnectAttemptsTotal,
  feedTickLagMs, hubMessagesInTotal, snapshotFillDurationMs,
} from '../metrics.js';
import { log } from '../../lib/log.js';
import { httpRequest } from '../../lib/http.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';
const HEARTBEAT_INTERVAL_MS = 8_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const SUB_DEBOUNCE_MS = 200;
const DEFAULT_BOOK_DEPTH = 25;

/* ── upstream message shapes (subset of `neo/lib/polymarket-ws.ts`) ───────── */

interface PmLevel { readonly price: string; readonly size: string }
interface PmBookMsg {
  readonly event_type: 'book';
  readonly asset_id: string;
  readonly bids: readonly PmLevel[];
  readonly asks: readonly PmLevel[];
  readonly timestamp?: string;
  readonly hash?: string;
}
interface PmPriceChangeEntry {
  readonly asset_id: string;
  readonly price: string;
  readonly size: string;
  readonly side: 'BUY' | 'SELL';
  readonly hash?: string;
}
interface PmPriceChangeMsg {
  readonly event_type: 'price_change';
  readonly price_changes: readonly PmPriceChangeEntry[];
  readonly timestamp?: string;
}
interface PmLastTradeMsg {
  readonly event_type: 'last_trade_price';
  readonly asset_id: string;
  readonly price: string;
  readonly size: string;
  readonly side: 'BUY' | 'SELL';
  readonly timestamp?: string;
}
interface PmBestBidAskMsg {
  readonly event_type: 'best_bid_ask';
  readonly asset_id: string;
  readonly best_bid: string;
  readonly best_ask: string;
  readonly timestamp?: string;
}
interface PmTickSizeChangeMsg {
  readonly event_type: 'tick_size_change';
  readonly asset_id: string;
}
type PmWsMsg = PmBookMsg | PmPriceChangeMsg | PmLastTradeMsg | PmBestBidAskMsg | PmTickSizeChangeMsg;

/* ── ws iface (works across `ws` package + globalThis.WebSocket) ──────────── */

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  onopen: ((this: MinimalWebSocket, ev: unknown) => void) | null;
  onclose: ((this: MinimalWebSocket, ev: unknown) => void) | null;
  onerror: ((this: MinimalWebSocket, ev: unknown) => void) | null;
  onmessage: ((this: MinimalWebSocket, ev: { data: unknown }) => void) | null;
}
interface WebSocketCtor { new (url: string): MinimalWebSocket }

function getWebSocketCtor(): WebSocketCtor {
  const native = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (native) return native;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('ws') as { WebSocket: WebSocketCtor } | WebSocketCtor;
  return (mod as { WebSocket?: WebSocketCtor }).WebSocket ?? (mod as WebSocketCtor);
}

/* ── in-memory book per tokenId ───────────────────────────────────────────── */

interface BookState {
  readonly bids: Map<number, number>;
  readonly asks: Map<number, number>;
  midPx: number | null;
  seq: number;
  upstreamTsMs: number;
}

function emptyBook(): BookState {
  return { bids: new Map(), asks: new Map(), midPx: null, seq: 0, upstreamTsMs: 0 };
}

function num(s: string | number | undefined): number {
  return typeof s === 'number' ? s : typeof s === 'string' ? Number(s) : NaN;
}

/** Polymarket timestamps come as strings; sometimes seconds, sometimes ms. */
function normaliseUpstreamTs(raw: string | number | undefined): number {
  const n = num(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function topBidsAsks(book: BookState, depth: number): { bids: BookLevel[]; asks: BookLevel[] } {
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  const sortedBids = [...book.bids.entries()].sort((a, b) => b[0] - a[0]);
  for (const [px, sz] of sortedBids) {
    if (sz <= 0) continue;
    bids.push([px, sz] as const);
    if (bids.length >= depth) break;
  }
  const sortedAsks = [...book.asks.entries()].sort((a, b) => a[0] - b[0]);
  for (const [px, sz] of sortedAsks) {
    if (sz <= 0) continue;
    asks.push([px, sz] as const);
    if (asks.length >= depth) break;
  }
  return { bids, asks };
}

function recomputeMid(book: BookState): void {
  let topBid: number | null = null;
  for (const [px, sz] of book.bids) if (sz > 0 && (topBid === null || px > topBid)) topBid = px;
  let topAsk: number | null = null;
  for (const [px, sz] of book.asks) if (sz > 0 && (topAsk === null || px < topAsk)) topAsk = px;
  if (topBid !== null && topAsk !== null) book.midPx = (topBid + topAsk) / 2;
}

/** Best-effort monotonic-ish seq from CLOB `hash` field. */
function hashToSeq(hash: string | undefined): number {
  if (!hash) return 0;
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* ── adapter ──────────────────────────────────────────────────────────────── */

export class PolymarketRealtimeAdapter implements RealtimeAdapter {
  readonly venue: VenueTag = 'pm' as const;

  private hub: Hub | null = null;
  private ws: MinimalWebSocket | null = null;
  private wsState: VenueHealth['ws'] = 'closed';
  private upstream: VenueHealth['upstream'] = 'primary';
  private readonly subsByToken = new Map<string, Set<Topic>>();
  private readonly books = new Map<string, BookState>();
  /**
   * Red-team C2-PM. Polymarket's WS can deliver `price_change` deltas BEFORE
   * the first `book` snapshot lands — applying those to an empty book makes
   * the published mid/spread reflect 1-side liquidity for that race window
   * (looks like a hard depeg to the consumer). We defer all per-token emits
   * until at least one `book` snapshot has populated `books.get(tokenId)`.
   *
   * Tokens enter the set on `onBookSnapshot` and exit on unsubscribe-from-zero
   * (so a resubscribe after we forgot the token starts the gate fresh).
   */
  private readonly bookReady = new Set<string>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private subDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventTs = 0;
  /**
   * Epoch ms of the last socket open; -1 before the first. Folded into the
   * watchdog clock because `StallWatchdog.tick()` skips while the clock is
   * negative — without this seed a socket that connects but never delivers a
   * frame can NEVER stall (r8 sweep, defect-3 class). Also grants each fresh
   * socket one full stall budget before judgment.
   */
  private lastOpenAt = -1;
  /**
   * Epoch ms of the last PONG heartbeat reply; -1 before the first. PONGs
   * are deliberately excluded from `lastEventTs` (they are not market data)
   * but they DO prove transport liveness, so they feed the watchdog clock:
   * PM markets can be legitimately silent for minutes (thin books,
   * overnight), and this venue has ONE breaker shared by every PM topic on
   * the pod. Without PONG liveness a single quiet — or attacker-chosen
   * dead — token subscription would trip that shared breaker on a loop and
   * black out PM realtime for everyone (r8 review finding). A genuinely
   * dead socket answers no PONGs despite 8s PINGs and still stalls.
   */
  private lastPongAt = -1;
  private started = false;
  private stopped = false;

  private readonly breaker = new CircuitBreaker({
    failureThreshold: 5,
    windowMs: 30_000,
    baseCooldownMs: 30_000,
    maxCooldownMs: 5 * 60_000,
    onOpen: () => {
      this.upstream = 'rest';
      feedBreakerState.set({ venue: this.venue }, 2);
      log.warn({ venue: this.venue }, 'pm-realtime: breaker open — degraded to last-known');
      this.emitStaleForAllTopics();
    },
    onHalfOpen: () => {
      feedBreakerState.set({ venue: this.venue }, 1);
      if (!this.ws) this.connect();
    },
    onClose: () => {
      this.upstream = this.ws ? 'primary' : 'rest';
      feedBreakerState.set({ venue: this.venue }, 0);
    },
  });

  /**
   * Stall watchdog — CLOB books update on every trade. 30s of silence on
   * active subs is suspicious; 60s is a stall. Polymarket markets can be
   * thin so we pick a more conservative threshold than HL.
   *
   * Clock = last data frame OR last socket open OR last PONG, whichever is
   * newest. Data silence alone must never trip the shared venue breaker
   * while the transport is demonstrably alive (PONGs flowing): that would
   * let one thin/dead-token subscription — token ids are client-supplied —
   * DoS every PM topic on the pod. Gated on an OPEN socket so the watchdog
   * cannot re-punish a socket it already closed nor assassinate the
   * breaker's half-open reconnect probe before `onopen` (r8 review).
   */
  private readonly stallWatchdog = new StallWatchdog({
    stallMs: 60_000,
    checkMs: 10_000,
    hasActiveSubs: () => this.subsByToken.size > 0,
    isStreamOpen: () => this.wsState === 'open',
    getLastEventAt: () =>
      Math.max(this.lastEventTs || -1, this.lastOpenAt, this.lastPongAt),
    onStall: () => {
      log.warn({ venue: this.venue, ageMs: Date.now() - this.lastEventTs }, 'pm-rt: stall detected');
      for (let i = 0; i < 5; i++) this.breaker.noteFailure();
      try { this.ws?.close(); } catch { /* noop */ }
    },
  });

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  async start(hub: Hub): Promise<void> {
    if (this.started) return;
    this.hub = hub;
    this.started = true;
    this.stopped = false;
    feedBreakerState.set({ venue: this.venue }, 0);
    this.stallWatchdog.start();
    // Lazy WS: open on first subscribe().
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopped = true;
    this.started = false;
    this.stallWatchdog.stop();
    this.clearTimers();
    this.breaker.dispose();
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    this.wsState = 'closed';
    this.subsByToken.clear();
    this.books.clear();
    this.bookReady.clear();
    this.hub = null;
  }

  /* ── sub / unsub ──────────────────────────────────────────────────────── */

  subscribe(topic: Topic): void {
    const parsed = parse(topic);
    if (!parsed || parsed.venue !== 'pm' || !parsed.symbol) return;
    const tokenId = parsed.symbol;
    let set = this.subsByToken.get(tokenId);
    const wasEmpty = !set;
    if (!set) { set = new Set(); this.subsByToken.set(tokenId, set); }
    set.add(topic);
    if (wasEmpty) this.books.set(tokenId, emptyBook());
    if (!this.ws && !this.breaker.isOpen()) this.connect();
    this.scheduleResubscribe();
  }

  unsubscribe(topic: Topic): void {
    const parsed = parse(topic);
    if (!parsed || parsed.venue !== 'pm') return;
    const set = this.subsByToken.get(parsed.symbol);
    if (!set) return;
    set.delete(topic);
    if (set.size === 0) {
      this.subsByToken.delete(parsed.symbol);
      this.books.delete(parsed.symbol);
      // Drop the book-ready marker so a fresh resubscribe re-enters the
      // pre-snapshot guard correctly (Polymarket resends the book snapshot
      // on every cmd:subscribe, but only if we're actually re-subscribing).
      this.bookReady.delete(parsed.symbol);
    }
    this.scheduleResubscribe();
  }

  /* ── snapshot (REST one-shot for cold-start fill) ─────────────────────── */

  async snapshot(topic: Topic): Promise<FeedEvent[]> {
    const parsed = parse(topic);
    if (!parsed || parsed.venue !== 'pm' || !parsed.symbol) return [];
    const tokenId = parsed.symbol;
    // No public historical trade tape — clients see live trades only.
    if (parsed.kind === 'trades') return [];

    const end = snapshotFillDurationMs.startTimer({ venue: this.venue });
    try {
      const data = await this.fetchOrderbook(tokenId);
      end();
      if (!data) return [];

      // Seed the in-memory book so subsequent deltas land on a real state.
      const book = this.books.get(tokenId) ?? emptyBook();
      book.bids.clear();
      book.asks.clear();
      for (const lvl of data.bids) book.bids.set(lvl.priceDollars, lvl.size);
      for (const lvl of data.asks) book.asks.set(lvl.priceDollars, lvl.size);
      recomputeMid(book);
      book.upstreamTsMs = Date.now();
      this.books.set(tokenId, book);

      const ts = Date.now();
      if (parsed.kind === 'book') {
        const depth = parsed.depth ?? DEFAULT_BOOK_DEPTH;
        const { bids, asks } = topBidsAsks(book, depth);
        const event: BookEvent = {
          topic, ts, lastTickAgeMs: 0, src: 'pm', stale: true,
          t: 'book', bids, asks, seq: book.seq,
        };
        return [event];
      }
      if (parsed.kind === 'predictions' && book.midPx !== null) {
        const event: TickEvent = {
          topic, ts, lastTickAgeMs: 0, src: 'pm', stale: true,
          t: 'tick', px: book.midPx,
        };
        return [event];
      }
      return [];
    } catch (err) {
      end();
      log.warn(
        { err: err instanceof Error ? err.message : String(err), tokenId },
        'pm-realtime: snapshot fill failed',
      );
      return [];
    }
  }

  /* ── health ───────────────────────────────────────────────────────────── */

  healthSnapshot(): VenueHealth {
    return {
      ws: this.wsState,
      breakerState: this.breaker.getState(),
      lastEventAgeMs: this.lastEventTs === 0 ? -1 : Date.now() - this.lastEventTs,
      subscriberCount: this.subsByToken.size,
      upstream: this.upstream,
    };
  }

  /* ── ws plumbing ──────────────────────────────────────────────────────── */

  private connect(): void {
    if (this.ws || this.stopped) return;
    this.wsState = 'connecting';
    feedReconnectAttemptsTotal.inc({ venue: this.venue });

    let ws: MinimalWebSocket;
    try {
      ws = new (getWebSocketCtor())(WS_URL);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'pm-realtime: ws constructor threw',
      );
      this.breaker.noteFailure();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.wsState = 'open';
      this.lastOpenAt = Date.now();
      this.upstream = 'primary';
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.flushSubscribe();
      this.breaker.noteSuccess();
    };
    ws.onmessage = (ev) => { this.handleFrame(ev.data); };
    ws.onerror = () => { /* onclose runs after; reconnect there */ };
    ws.onclose = () => {
      const hadConnection = this.wsState === 'open';
      this.wsState = 'closed';
      this.ws = null;
      this.clearHeartbeat();
      // Drop bookReady on socket loss. Polymarket replays the book snapshot
      // on every cmd:subscribe, so after reconnect the new snapshot will
      // re-flip the gate. Without this, a price_change frame in the brief
      // window between reconnect and the new book snapshot would be applied
      // on top of stale state from before the disconnect.
      this.bookReady.clear();
      if (this.stopped) return;
      feedDisconnectTotal.inc({
        venue: this.venue,
        reason: hadConnection ? 'remote' : 'handshake',
      });
      this.breaker.noteFailure();
      if (this.subsByToken.size > 0) {
        this.wsState = 'reconnecting';
        this.scheduleReconnect();
      }
    };
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw === 'string' && raw.trim().toUpperCase() === 'PONG') {
      // Transport liveness only — never market data (see lastPongAt).
      this.lastPongAt = Date.now();
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(typeof raw === 'string' ? raw : String(raw)); }
    catch { return; }
    const list = Array.isArray(payload) ? payload : [payload];
    for (const msg of list) this.dispatch(msg as PmWsMsg | null);
  }

  private dispatch(msg: PmWsMsg | null): void {
    if (!msg || typeof msg !== 'object' || !('event_type' in msg)) return;
    try {
      switch (msg.event_type) {
        case 'book': this.onBookSnapshot(msg); break;
        case 'price_change': this.onPriceChange(msg); break;
        case 'last_trade_price': this.onLastTrade(msg); break;
        case 'best_bid_ask': this.onBestBidAsk(msg); break;
        case 'tick_size_change': break; // no emission
      }
      this.breaker.noteSuccess();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), event_type: msg.event_type },
        'pm-realtime: dispatch threw',
      );
      this.breaker.noteFailure();
    }
  }

  /* ── frame handlers ───────────────────────────────────────────────────── */

  private onBookSnapshot(msg: PmBookMsg): void {
    const tokenId = msg.asset_id;
    if (!tokenId || !this.subsByToken.has(tokenId)) return;
    const book = this.books.get(tokenId) ?? emptyBook();
    book.bids.clear();
    book.asks.clear();
    for (const lvl of msg.bids ?? []) {
      const px = num(lvl.price), sz = num(lvl.size);
      if (Number.isFinite(px) && Number.isFinite(sz) && sz > 0) book.bids.set(px, sz);
    }
    for (const lvl of msg.asks ?? []) {
      const px = num(lvl.price), sz = num(lvl.size);
      if (Number.isFinite(px) && Number.isFinite(sz) && sz > 0) book.asks.set(px, sz);
    }
    recomputeMid(book);
    book.seq = hashToSeq(msg.hash) || book.seq + 1;
    book.upstreamTsMs = normaliseUpstreamTs(msg.timestamp);
    this.books.set(tokenId, book);
    // Mark the token "book-ready" so subsequent price_change emits aren't
    // suppressed by the C2-PM guard below.
    this.bookReady.add(tokenId);
    this.emitBookForToken(tokenId, book, false);
    this.emitTickForToken(tokenId, book, false);
  }

  private onPriceChange(msg: PmPriceChangeMsg): void {
    const upstreamTsMs = normaliseUpstreamTs(msg.timestamp);
    const touched = new Set<string>();
    for (const entry of msg.price_changes ?? []) {
      const tokenId = entry.asset_id;
      if (!tokenId || !this.subsByToken.has(tokenId)) continue;
      // C2-PM guard: drop deltas that arrive before the first book snapshot.
      // Applying a price_change to an empty book reports a one-sided market
      // (∞ spread, NaN mid) until the snapshot lands. Polymarket emits the
      // book snapshot reliably right after `cmd:subscribe`; the gap is short.
      if (!this.bookReady.has(tokenId)) continue;
      const book = this.books.get(tokenId) ?? emptyBook();
      const px = num(entry.price), sz = num(entry.size);
      if (!Number.isFinite(px)) continue;
      const side = entry.side === 'SELL' ? book.asks : book.bids;
      if (!Number.isFinite(sz) || sz <= 0) side.delete(px);
      else side.set(px, sz);
      book.seq = hashToSeq(entry.hash) || book.seq + 1;
      if (upstreamTsMs) book.upstreamTsMs = upstreamTsMs;
      this.books.set(tokenId, book);
      touched.add(tokenId);
    }
    for (const tokenId of touched) {
      const book = this.books.get(tokenId);
      if (!book) continue;
      recomputeMid(book);
      this.emitBookForToken(tokenId, book, false);
      this.emitTickForToken(tokenId, book, false);
    }
  }

  private onLastTrade(msg: PmLastTradeMsg): void {
    const tokenId = msg.asset_id;
    if (!tokenId || !this.subsByToken.has(tokenId)) return;
    const px = num(msg.price), sz = num(msg.size);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) return;
    const tsUpstream = normaliseUpstreamTs(msg.timestamp);
    const ts = Date.now();
    const lastTickAgeMs = tsUpstream ? Math.max(0, ts - tsUpstream) : 0;

    if (this.hasTopicSubscribed(tokenId, 'trades')) {
      this.publish({
        topic: `trades:pm:${tokenId}` as Topic,
        ts, lastTickAgeMs, src: 'pm',
        t: 'trade', px, sz,
        side: msg.side === 'BUY' ? 'buy' : 'sell',
      } satisfies TradeEvent, 'trades', lastTickAgeMs);
    }

    // Strongest "price moved" signal when BBO frames are sparse — also emit
    // a tick on the predictions topic.
    const book = this.books.get(tokenId);
    if (book) {
      book.upstreamTsMs = tsUpstream || book.upstreamTsMs;
      if (book.midPx === null) book.midPx = px;
    }
    if (this.hasTopicSubscribed(tokenId, 'predictions')) {
      this.publish({
        topic: `predictions:pm:${tokenId}` as Topic,
        ts, lastTickAgeMs, src: 'pm',
        t: 'tick', px,
      } satisfies TickEvent, 'predictions', lastTickAgeMs);
    }
  }

  private onBestBidAsk(msg: PmBestBidAskMsg): void {
    const tokenId = msg.asset_id;
    if (!tokenId || !this.subsByToken.has(tokenId)) return;
    const bid = num(msg.best_bid), ask = num(msg.best_ask);
    const book = this.books.get(tokenId) ?? emptyBook();
    if (Number.isFinite(bid) && Number.isFinite(ask)) book.midPx = (bid + ask) / 2;
    const tsUpstream = normaliseUpstreamTs(msg.timestamp);
    if (tsUpstream) book.upstreamTsMs = tsUpstream;
    this.books.set(tokenId, book);
    this.emitTickForToken(tokenId, book, false);
  }

  /* ── emitters ─────────────────────────────────────────────────────────── */

  private emitBookForToken(tokenId: string, book: BookState, stale: boolean): void {
    const topics = this.subsByToken.get(tokenId);
    if (!topics) return;
    const ts = Date.now();
    const lastTickAgeMs = book.upstreamTsMs ? Math.max(0, ts - book.upstreamTsMs) : 0;
    for (const topic of topics) {
      if (!topic.startsWith('book:pm:')) continue;
      const depth = parse(topic)?.depth ?? DEFAULT_BOOK_DEPTH;
      const { bids, asks } = topBidsAsks(book, depth);
      this.publish({
        topic, ts, lastTickAgeMs, src: 'pm', stale,
        t: 'book', bids, asks, seq: book.seq,
      } satisfies BookEvent, 'book', lastTickAgeMs);
    }
  }

  private emitTickForToken(tokenId: string, book: BookState, stale: boolean): void {
    if (book.midPx === null) return;
    if (!this.hasTopicSubscribed(tokenId, 'predictions')) return;
    const ts = Date.now();
    const lastTickAgeMs = book.upstreamTsMs ? Math.max(0, ts - book.upstreamTsMs) : 0;
    this.publish({
      topic: `predictions:pm:${tokenId}` as Topic,
      ts, lastTickAgeMs, src: 'pm', stale,
      t: 'tick', px: book.midPx,
    } satisfies TickEvent, 'predictions', lastTickAgeMs);
  }

  private emitStaleForAllTopics(): void {
    for (const [tokenId, book] of this.books) {
      this.emitBookForToken(tokenId, book, true);
      this.emitTickForToken(tokenId, book, true);
    }
  }

  private hasTopicSubscribed(tokenId: string, kind: 'book' | 'trades' | 'predictions'): boolean {
    const topics = this.subsByToken.get(tokenId);
    if (!topics) return false;
    for (const t of topics) if (t.startsWith(`${kind}:pm:`)) return true;
    return false;
  }

  private publish(event: FeedEvent, kindLabel: string, lastTickAgeMs: number): void {
    if (!this.hub) return;
    this.lastEventTs = Date.now();
    hubMessagesInTotal.inc({ venue: this.venue, topic_kind: kindLabel });
    feedTickLagMs.observe({ venue: this.venue, topic_kind: kindLabel }, lastTickAgeMs);
    this.hub.publish(event);
  }

  /* ── subscribe-frame debounce + flush ─────────────────────────────────── */

  private scheduleResubscribe(): void {
    if (this.subDebounceTimer) return;
    this.subDebounceTimer = setTimeout(() => {
      this.subDebounceTimer = null;
      this.flushSubscribe();
    }, SUB_DEBOUNCE_MS);
    (this.subDebounceTimer as { unref?: () => void }).unref?.();
  }

  private flushSubscribe(): void {
    if (!this.ws || this.wsState !== 'open') return;
    const ids = [...this.subsByToken.keys()];
    if (ids.length === 0) return;
    // CLOB does not support per-id unsubscribe — re-send the full set as a
    // fresh `market` subscribe. Mirrors `neo/lib/polymarket-ws.ts`.
    try {
      this.ws.send(JSON.stringify({
        assets_ids: ids,
        type: 'market',
        custom_feature_enabled: true,
      }));
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'pm-realtime: subscribe send failed',
      );
    }
  }

  /* ── heartbeat + reconnect ────────────────────────────────────────────── */

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.wsState !== 'open') return;
      try { this.ws.send('PING'); } catch { /* noop */ }
    }, HEARTBEAT_INTERVAL_MS);
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const backoff = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subsByToken.size === 0 || this.stopped) return;
      // Breaker-open: half-open transition will reopen the WS via onHalfOpen.
      if (this.breaker.isOpen()) return;
      this.connect();
    }, backoff);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.subDebounceTimer) { clearTimeout(this.subDebounceTimer); this.subDebounceTimer = null; }
  }

  /* ── REST fill (snapshot only) ────────────────────────────────────────── */

  private async fetchOrderbook(tokenId: string): Promise<{
    bids: Array<{ priceDollars: number; size: number }>;
    asks: Array<{ priceDollars: number; size: number }>;
  } | null> {
    const url = `${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`;
    const res = await httpRequest(url, {
      vendor: 'polymarket',
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 6_000,
      maxAttempts: 2,
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    } | null;
    if (!data) return null;
    const bids = (data.bids ?? [])
      .map((l) => ({ priceDollars: Number(l.price), size: Number(l.size) }))
      .filter((l) => Number.isFinite(l.priceDollars) && l.size > 0)
      .sort((a, b) => b.priceDollars - a.priceDollars);
    const asks = (data.asks ?? [])
      .map((l) => ({ priceDollars: Number(l.price), size: Number(l.size) }))
      .filter((l) => Number.isFinite(l.priceDollars) && l.size > 0)
      .sort((a, b) => a.priceDollars - b.priceDollars);
    return { bids, asks };
  }
}

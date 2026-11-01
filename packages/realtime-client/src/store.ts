/**
 * Vanilla event store for the realtime client.
 *
 * Single source of truth for "the latest event per topic" plus a thin
 * subscribe/dispatch surface. Intentionally has NO React or Zustand
 * dependency so it works in any environment (Hermes / browser / Node
 * tests) and so NEO + MAZE can adopt it today with their existing hook
 * patterns. React + Zustand bindings live in a sibling module that lands
 * once `react` and `zustand` peer deps are installed.
 *
 * Shape:
 *   - `ticks`, `candles`, `books`, `trades` — last-known maps keyed by
 *     `Topic` for fast O(1) reads and predictable selector identity.
 *   - `subscribe(topic, listener)` — fires the listener whenever an event
 *     for the topic is dispatched. Returns an `unsubscribe` thunk.
 *   - `dispatch(event)` — write the latest into the appropriate map, then
 *     fan out to listeners on that topic.
 *   - `get(topic)` — current snapshot for that topic, or `undefined`.
 *   - `clear()` — wipe everything (used on connection reset).
 *
 * The store does NOT manage hub subscriptions itself — that's the
 * `RealtimeClient` orchestrator's job. The store only cares about local
 * cache + listener fan-out.
 */

import type {
  AccountEvent,
  BookEvent,
  CandleEvent,
  FeedEvent,
  FillEvent,
  OrderEvent,
  TickEvent,
  Topic,
  TradeEvent,
} from './types.js';

export type Listener = (event: FeedEvent) => void;

export interface StoreSnapshot {
  readonly ticks: ReadonlyMap<Topic, TickEvent>;
  readonly candles: ReadonlyMap<Topic, CandleEvent>;
  readonly books: ReadonlyMap<Topic, BookEvent>;
  readonly trades: ReadonlyMap<Topic, TradeEvent>;
  /** Sprint 1 lifecycle bridge — last OrderEvent per priv-orders topic. */
  readonly orders: ReadonlyMap<Topic, OrderEvent>;
  /** ADR-0004 pt2 — last HL account snapshot per priv-account topic. */
  readonly accounts: ReadonlyMap<Topic, AccountEvent>;
  /** ADR-0004 pt2 — last HL fill per priv-fills topic. */
  readonly fills: ReadonlyMap<Topic, FillEvent>;
}

export class RealtimeStore {
  private readonly ticks = new Map<Topic, TickEvent>();
  private readonly candles = new Map<Topic, CandleEvent>();
  private readonly books = new Map<Topic, BookEvent>();
  private readonly trades = new Map<Topic, TradeEvent>();
  private readonly orders = new Map<Topic, OrderEvent>();
  private readonly accounts = new Map<Topic, AccountEvent>();
  private readonly fills = new Map<Topic, FillEvent>();
  private readonly listeners = new Map<Topic, Set<Listener>>();

  /** Last event of any kind that landed on the topic (returns the typed shape). */
  get(topic: Topic): FeedEvent | undefined {
    return this.ticks.get(topic)
      ?? this.candles.get(topic)
      ?? this.books.get(topic)
      ?? this.trades.get(topic)
      ?? this.orders.get(topic)
      ?? this.accounts.get(topic)
      ?? this.fills.get(topic);
  }

  /** Most recent tick, if any. Typed return keeps `px` accessible without a guard. */
  getTick(topic: Topic): TickEvent | undefined {
    return this.ticks.get(topic);
  }

  getCandle(topic: Topic): CandleEvent | undefined {
    return this.candles.get(topic);
  }

  getBook(topic: Topic): BookEvent | undefined {
    return this.books.get(topic);
  }

  getTrade(topic: Topic): TradeEvent | undefined {
    return this.trades.get(topic);
  }

  getOrder(topic: Topic): OrderEvent | undefined {
    return this.orders.get(topic);
  }

  /** Most recent HL account snapshot on a priv-account topic, if any. */
  getAccount(topic: Topic): AccountEvent | undefined {
    return this.accounts.get(topic);
  }

  /** Most recent HL fill on a priv-fills topic, if any. A render value —
   *  callers own any side effect (toast). The hub never seed-replays fills,
   *  so reading this on mount cannot re-fire a stale toast. */
  getFill(topic: Topic): FillEvent | undefined {
    return this.fills.get(topic);
  }

  /**
   * Subscribe to event flow on a topic. Returns a thunk that unregisters
   * the listener — call it from React's `useEffect` cleanup, or from a
   * Vue `onUnmounted`, or wherever the component lives.
   *
   * Listeners receive the typed `FeedEvent`. Filter or narrow at the call
   * site if you only care about ticks vs candles.
   */
  subscribe(topic: Topic, listener: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      const cur = this.listeners.get(topic);
      if (!cur) return;
      cur.delete(listener);
      if (cur.size === 0) this.listeners.delete(topic);
    };
  }

  /** Number of active listeners on a topic (debug + tests). */
  listenerCount(topic: Topic): number {
    return this.listeners.get(topic)?.size ?? 0;
  }

  /**
   * Cache the event under its kind-specific map and fan out to listeners
   * on that exact topic. Different kinds for the same topic overwrite each
   * other in the unified `get()` view but each `getX()` getter stays
   * truthful.
   */
  dispatch(event: FeedEvent): boolean {
    // Fills are one-shot deltas: every fill must reach listeners even when a
    // venue batches them out of timestamp order. All other feed shapes are
    // latest-state streams and must not regress the rendered cache.
    const current = event.t === 'fill' ? undefined : this.getForKind(event);
    const replaceLatest = !current || shouldReplaceLatest(current, event);
    if (event.t !== 'fill' && event.t !== 'trade' && !replaceLatest) return false;
    switch (event.t) {
      case 'tick':
        this.ticks.set(event.topic, event);
        break;
      case 'candle':
        this.candles.set(event.topic, event);
        break;
      case 'book':
        this.books.set(event.topic, event);
        break;
      case 'trade':
        if (replaceLatest) this.trades.set(event.topic, event);
        break;
      case 'order':
        this.orders.set(event.topic, event);
        break;
      case 'account':
        this.accounts.set(event.topic, event);
        break;
      case 'fill':
        this.fills.set(event.topic, event);
        break;
    }
    const set = this.listeners.get(event.topic);
    if (!set) return true;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // Listener errors are isolated — one bad listener can't break the bus.
      }
    }
    return true;
  }

  private getForKind(event: FeedEvent): FeedEvent | undefined {
    switch (event.t) {
      case 'tick': return this.ticks.get(event.topic);
      case 'candle': return this.candles.get(event.topic);
      case 'book': return this.books.get(event.topic);
      case 'trade': return this.trades.get(event.topic);
      case 'order': return this.orders.get(event.topic);
      case 'account': return this.accounts.get(event.topic);
      case 'fill': return this.fills.get(event.topic);
    }
  }

  /** Drop all cached state. Used on transport reset or sign-out. */
  clear(): void {
    this.ticks.clear();
    this.candles.clear();
    this.books.clear();
    this.trades.clear();
    this.orders.clear();
    this.accounts.clear();
    this.fills.clear();
    // Listeners are intentionally NOT cleared — components are still mounted
    // and would lose their subscriptions; instead the transport will
    // re-deliver snapshots once the connection comes back.
  }

  /** Read-only view useful for testing + debug. */
  snapshot(): StoreSnapshot {
    return {
      ticks: this.ticks,
      candles: this.candles,
      books: this.books,
      trades: this.trades,
      orders: this.orders,
      accounts: this.accounts,
      fills: this.fills,
    };
  }
}

function shouldReplaceLatest(current: FeedEvent, next: FeedEvent): boolean {
  const currentStale = current.stale === true;
  const nextStale = next.stale === true;
  if (currentStale !== nextStale) return currentStale;
  if (next.ts < current.ts) return false;
  if (
    next.ts === current.ts &&
    current.t === 'book' &&
    next.t === 'book' &&
    current.seq > 0 &&
    next.seq > 0 &&
    next.seq < current.seq
  ) return false;
  return true;
}

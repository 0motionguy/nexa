/**
 * Hook surface — one hook per topic kind. Each hook:
 *   1. Reads the `RealtimeClient` from context.
 *   2. Calls `client.acquire(topic)` on mount and the returned release
 *      thunk on unmount, so the underlying transport's subscribe set is
 *      ref-counted automatically.
 *   3. Subscribes to the store via `useSyncExternalStore` so React's
 *      concurrent renderer gets tear-free reads and selector identity is
 *      tied to the topic + kind, not the whole store.
 *
 * Selectors return `undefined` while the snapshot hasn't landed yet —
 * consumers should render a skeleton or last-known shape from elsewhere.
 *
 * All hooks tolerate a missing provider by returning `undefined` and
 * doing nothing on mount; this keeps tests + storybook trivial without
 * requiring every test to wrap a provider.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { RealtimeContext } from './context.js';
import {
  bookTopic,
  candleTopic,
  predictionsTopic,
  privAccountTopic,
  privFillsTopic,
  privOrdersTopic,
  stockTopic,
  tickerTopic,
  tradesTopic,
} from '../topic.js';
import type {
  AccountEvent,
  BookEvent,
  CandleEvent,
  FillEvent,
  Interval,
  OrderEvent,
  TickEvent,
  Topic,
  TradeEvent,
  VenueTag,
} from '../types.js';
import type { RealtimeClient } from '../RealtimeClient.js';

/** Returns the client mounted by the nearest `<RealtimeProvider>` (or null). */
export function useRealtimeClient(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

/* ── core selector hook (private but reused by every hook below) ─────────── */

type Selector<T> = (client: RealtimeClient | null) => T;

function useTopicSelector<T>(topic: Topic | null, select: Selector<T>): T {
  const client = useContext(RealtimeContext);

  // Acquire ref-count + release on unmount; null topic = no-op.
  useEffect(() => {
    if (!client || !topic) return;
    const release = client.acquire(topic);
    return release;
  }, [client, topic]);

  const subscribe = (notify: () => void): (() => void) => {
    if (!client || !topic) return () => {};
    return client.onTopic(topic, () => notify());
  };

  const getSnapshot = (): T => select(client);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ── public hooks ────────────────────────────────────────────────────────── */

/**
 * Live ticker for the given symbol on the given venue. Default venue is
 * Hyperliquid so existing call sites can pass just the symbol.
 */
export function useTicker(
  symbol: string | null,
  venue: VenueTag = 'hl',
): TickEvent | undefined {
  const topic = symbol ? tickerTopic(venue, symbol) : null;
  return useTopicSelector(topic, (client) => (topic ? client?.getTick(topic) : undefined));
}

/** Pyth Hermes is the default for `useStockPrice` — Pyth feeds equities. */
export function useStockPrice(ticker: string | null): TickEvent | undefined {
  const topic = ticker ? stockTopic(ticker) : null;
  return useTopicSelector(topic, (client) => (topic ? client?.getTick(topic) : undefined));
}

/** Polymarket prediction-market token. `tokenId` is the CLOB asset id (hex). */
export function usePredictionPrice(tokenId: string | null): TickEvent | undefined {
  const topic = tokenId ? predictionsTopic(tokenId) : null;
  return useTopicSelector(topic, (client) => (topic ? client?.getTick(topic) : undefined));
}

/**
 * Candle stream. Default venue HL. Returns the latest candle for the
 * requested interval — for a full history seed, pull from REST once at
 * mount and let `useCandles` deliver deltas after that.
 */
export function useCandle(
  symbol: string | null,
  interval: Interval,
  venue: VenueTag = 'hl',
): CandleEvent | undefined {
  const topic = symbol ? candleTopic(venue, symbol, interval) : null;
  return useTopicSelector(topic, (client) => (topic ? client?.getCandle(topic) : undefined));
}

/**
 * Live orderbook. Depth defaults to 25 — same as the existing client-side
 * book components in NEO/MAZE. Returns the most recent normalized
 * `BookEvent` truncated to that depth.
 */
export function useOrderbook(
  symbol: string | null,
  depth = 25,
  venue: VenueTag = 'hl',
): BookEvent | undefined {
  const topic = symbol ? bookTopic(venue, symbol, depth) : null;
  return useTopicSelector(topic, (client) => (topic ? client?.getBook(topic) : undefined));
}

/**
 * Most recent trade tick. The hub-emitted `TradeEvent` is the latest fill;
 * components wanting a tape buffer should append to a local array on each
 * change (React's `useSyncExternalStore` re-fires on every event).
 */
export function useTradeTick(
  symbol: string | null,
  venue: VenueTag = 'hl',
): TradeEvent | undefined {
  const topic = symbol ? tradesTopic(venue, symbol) : null;
  return useTopicSelector(topic, (client) => (topic ? client?.getTrade(topic) : undefined));
}

/**
 * Sprint 1 lifecycle bridge — subscribes to `priv:<userId>:orders` and
 * fires `onEvent` for every order transition belonging to that user.
 *
 * The hook returns the LAST OrderEvent (useful for components that display
 * the freshest state). For Order History list updates, pass `onEvent` and
 * mutate the React Query cache there — list rows shouldn't re-render off
 * the hook's return value (only the row whose `orderId` matches the event
 * needs to update). Tolerates a missing provider (returns undefined, never
 * calls `onEvent`).
 */
export function useOrderUpdates(
  userId: string | null,
  onEvent?: (event: OrderEvent) => void,
): OrderEvent | undefined {
  const client = useContext(RealtimeContext);
  const topic = userId ? privOrdersTopic(userId) : null;

  useEffect(() => {
    if (!client || !topic) return;
    const release = client.acquire(topic);
    return release;
  }, [client, topic]);

  useEffect(() => {
    if (!client || !topic || !onEvent) return;
    const unsub = client.onTopic(topic, (event) => {
      if (event.t === 'order') onEvent(event);
    });
    return unsub;
  }, [client, topic, onEvent]);

  const subscribe = (notify: () => void): (() => void) => {
    if (!client || !topic) return () => {};
    return client.onTopic(topic, (event) => {
      if (event.t === 'order') notify();
    });
  };
  const getSnapshot = (): OrderEvent | undefined =>
    topic ? client?.getOrder(topic) : undefined;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * ADR-0004 pt2 — subscribe to the signed-in user's HL account snapshots
 * (`priv:<uid>:account`, fed by the webData2 stream). Mirrors
 * `useOrderUpdates`: fires `onEvent` for each snapshot and returns the last
 * one as a render value. Silent unless the server runs `HL_USER_STREAMS=1`.
 * Tolerates a missing provider (returns undefined, never calls `onEvent`).
 */
export function useAccountUpdates(
  userId: string | null,
  onEvent?: (event: AccountEvent) => void,
): AccountEvent | undefined {
  const client = useContext(RealtimeContext);
  const topic = userId ? privAccountTopic(userId) : null;

  useEffect(() => {
    if (!client || !topic) return;
    const release = client.acquire(topic);
    return release;
  }, [client, topic]);

  useEffect(() => {
    if (!client || !topic || !onEvent) return;
    const unsub = client.onTopic(topic, (event) => {
      if (event.t === 'account') onEvent(event);
    });
    return unsub;
  }, [client, topic, onEvent]);

  const subscribe = (notify: () => void): (() => void) => {
    if (!client || !topic) return () => {};
    return client.onTopic(topic, (event) => {
      if (event.t === 'account') notify();
    });
  };
  const getSnapshot = (): AccountEvent | undefined =>
    topic ? client?.getAccount(topic) : undefined;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * ADR-0004 pt2 — subscribe to the signed-in user's HL fills
 * (`priv:<uid>:fills`, fed by the userFills stream). Mirrors
 * `useOrderUpdates`; the returned value is the LAST fill (a render value,
 * not a side effect) — callers own any toast. The hub never seed-replays
 * fills, so reading this on mount cannot re-fire a stale toast.
 */
export function useFills(
  userId: string | null,
  onEvent?: (event: FillEvent) => void,
): FillEvent | undefined {
  const client = useContext(RealtimeContext);
  const topic = userId ? privFillsTopic(userId) : null;

  useEffect(() => {
    if (!client || !topic) return;
    const release = client.acquire(topic);
    return release;
  }, [client, topic]);

  useEffect(() => {
    if (!client || !topic || !onEvent) return;
    const unsub = client.onTopic(topic, (event) => {
      if (event.t === 'fill') onEvent(event);
    });
    return unsub;
  }, [client, topic, onEvent]);

  const subscribe = (notify: () => void): (() => void) => {
    if (!client || !topic) return () => {};
    return client.onTopic(topic, (event) => {
      if (event.t === 'fill') notify();
    });
  };
  const getSnapshot = (): FillEvent | undefined =>
    topic ? client?.getFill(topic) : undefined;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ── multi-topic batch ───────────────────────────────────────────────────── */

/**
 * Multi-symbol ticker hook. Each symbol is acquired/released independently,
 * so adding or removing one mid-render is cheap. Returns a map keyed by
 * topic so list-row components can read by index without thrashing
 * selector identity.
 *
 * Defaults to Hyperliquid; pass `venue` to switch sources for the whole
 * batch (e.g. `useTickerBatch(['SOL','JUP'], 'pyth')`).
 */
export function useTickerBatch(
  symbols: readonly string[],
  venue: VenueTag = 'hl',
): ReadonlyMap<Topic, TickEvent> {
  const client = useContext(RealtimeContext);

  // Stable topic list — recomputed only when the symbol SET (or venue) changes,
  // not on every render. Without this, `subscribe`/`getSnapshot` below capture a
  // fresh `topics` each render and `useSyncExternalStore` tears down + re-adds
  // every listener every render (200 listeners on a 200-row screen).
  const key = symbols.join('|');
  const topics = useMemo<readonly Topic[]>(
    () => (key ? key.split('|').map((s) => tickerTopic(venue, s)) : []),
    [key, venue],
  );

  useEffect(() => {
    if (!client) return;
    const releases = topics.map((t) => client.acquire(t));
    return () => releases.forEach((r) => r());
  }, [client, topics]);

  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      if (!client) return () => {};
      const unsubs = topics.map((t) => client.onTopic(t, () => notify()));
      return () => unsubs.forEach((u) => u());
    },
    [client, topics],
  );

  // Cache the snapshot Map by reference. `useSyncExternalStore` re-renders
  // whenever `getSnapshot` returns a value that isn't `Object.is`-equal to the
  // previous one, so a fresh Map every call forced a render on every notify
  // (and tripped React's "getSnapshot should be cached" guard). Rebuild only
  // when a tracked topic's TickEvent reference actually changes — store ticks
  // are immutable, so reference identity is a sound change signal.
  const cacheRef = useRef<{ topics: readonly Topic[]; map: ReadonlyMap<Topic, TickEvent> } | null>(null);
  const getSnapshot = useCallback((): ReadonlyMap<Topic, TickEvent> => {
    if (!client) return EMPTY_MAP;
    const cached = cacheRef.current;
    if (cached && cached.topics === topics) {
      let unchanged = true;
      for (const t of topics) {
        if (client.getTick(t) !== cached.map.get(t)) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return cached.map;
    }
    const m = new Map<Topic, TickEvent>();
    for (const t of topics) {
      const tick = client.getTick(t);
      if (tick) m.set(t, tick);
    }
    cacheRef.current = { topics, map: m };
    return m;
  }, [client, topics]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const EMPTY_MAP: ReadonlyMap<Topic, TickEvent> = new Map();

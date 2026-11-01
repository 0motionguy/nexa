/**
 * Realtime client surface — store + ref-count + topic grammar invariants.
 *
 * Transport-level concerns are not exercised here (EventSource is platform
 * code we wrap, not own); the orchestrator owns the rebuild contract and is
 * covered by an SSE-mocked spec in the consumer apps. This spec keeps the
 * pieces other modules depend on honest:
 *
 *   - Topic grammar matches the server's contract byte-for-byte.
 *   - The store fans events to the right listeners and caches kind-correctly.
 *   - The ref-counter fires its 0↔1 transitions exactly once per edge.
 */

import { describe, expect, it } from 'vitest';

import { RealtimeStore } from '../../../../packages/realtime-client/src/store.js';
import { RefCountSet } from '../../../../packages/realtime-client/src/refcount.js';
import {
  bookTopic,
  candleTopic,
  format,
  isValid,
  parse,
  predictionsTopic,
  stockTopic,
  tickerTopic,
  tradesTopic,
} from '../../../../packages/realtime-client/src/topic.js';
import type {
  BookEvent,
  CandleEvent,
  TickEvent,
  Topic,
  TradeEvent,
} from '../../../../packages/realtime-client/src/types.js';

/* topic.ts is hand-mirrored from the server. asTopic is server-only; this
 * mirror exposes the same thing via the constructors above, so a tiny shim
 * keeps the test surface readable. */
function topic(raw: string): Topic {
  if (!isValid(raw)) throw new Error(`invalid topic: ${raw}`);
  return raw as Topic;
}

describe('topic grammar (client mirror)', () => {
  it('parse accepts the same set the server accepts', () => {
    expect(parse('ticker:hl:BTC')).toMatchObject({ kind: 'ticker', venue: 'hl', symbol: 'BTC' });
    expect(parse('candle:hl:BTC:1m')).toMatchObject({ interval: '1m' });
    expect(parse('book:pm:0xabc:25')).toMatchObject({ depth: 25 });
    expect(parse('predictions:pm:0xdef')).toMatchObject({ kind: 'predictions' });
    expect(parse('stock:pyth:AAPL')).toMatchObject({ venue: 'pyth' });
  });

  it('parse rejects malformed strings', () => {
    expect(parse('')).toBeNull();
    expect(parse('book:hl:BTC')).toBeNull();
    expect(parse('candle:hl:BTC:7m')).toBeNull();
  });

  it('format() round-trips through parse()', () => {
    const cases = [
      'ticker:hl:BTC',
      'candle:hl:BTC:1m',
      'book:pm:0xabc:25',
      'trades:hl:ETH',
    ];
    for (const raw of cases) {
      const p = parse(raw);
      expect(p, raw).not.toBeNull();
      expect(format(p!)).toBe(raw);
    }
  });

  it('constructors emit valid topics', () => {
    expect(tickerTopic('hl', 'BTC')).toBe('ticker:hl:BTC');
    expect(candleTopic('hl', 'BTC', '1m')).toBe('candle:hl:BTC:1m');
    expect(bookTopic('pm', '0xabc', 25)).toBe('book:pm:0xabc:25');
    expect(tradesTopic('hl', 'ETH')).toBe('trades:hl:ETH');
    expect(predictionsTopic('0xdef')).toBe('predictions:pm:0xdef');
    expect(stockTopic('AAPL')).toBe('stock:pyth:AAPL');
  });

});

/* ── RealtimeStore ────────────────────────────────────────────────────────── */

function tickEvent(t: Topic, px: number): TickEvent {
  return { t: 'tick', topic: t, px, ts: Date.now(), lastTickAgeMs: 0, src: 'hl' };
}
function candleEvent(t: Topic): CandleEvent {
  return {
    t: 'candle', topic: t, ts: Date.now(), lastTickAgeMs: 0, src: 'hl',
    o: 1, h: 1, l: 1, c: 1, v: 1, closed: false,
  };
}
function bookEvent(t: Topic): BookEvent {
  return {
    t: 'book', topic: t, ts: Date.now(), lastTickAgeMs: 0, src: 'hl',
    bids: [[1, 1]], asks: [[2, 1]], seq: 0,
  };
}
function tradeEvent(t: Topic): TradeEvent {
  return {
    t: 'trade', topic: t, ts: Date.now(), lastTickAgeMs: 0, src: 'hl',
    px: 1, sz: 1, side: 'buy',
  };
}

describe('RealtimeStore', () => {
  it('dispatch caches the latest per kind keyed by topic', () => {
    const store = new RealtimeStore();
    const t = topic('ticker:hl:BTC');
    store.dispatch(tickEvent(t, 1));
    store.dispatch(tickEvent(t, 2));
    expect(store.getTick(t)?.px).toBe(2);
  });

  it('dispatch fans to per-topic listeners exactly', () => {
    const store = new RealtimeStore();
    const t1 = topic('ticker:hl:BTC');
    const t2 = topic('ticker:hl:ETH');
    const a: TickEvent[] = [];
    const b: TickEvent[] = [];
    store.subscribe(t1, (e) => a.push(e as TickEvent));
    store.subscribe(t2, (e) => b.push(e as TickEvent));
    store.dispatch(tickEvent(t1, 100));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('subscribe returns an unsubscribe thunk', () => {
    const store = new RealtimeStore();
    const t = topic('ticker:hl:BTC');
    const captured: TickEvent[] = [];
    const unsub = store.subscribe(t, (e) => captured.push(e as TickEvent));
    store.dispatch(tickEvent(t, 1));
    unsub();
    store.dispatch(tickEvent(t, 2));
    expect(captured).toHaveLength(1);
    expect(store.listenerCount(t)).toBe(0);
  });

  it('one listener throwing does not break the bus', () => {
    const store = new RealtimeStore();
    const t = topic('ticker:hl:BTC');
    let bGotCalled = false;
    store.subscribe(t, () => { throw new Error('boom'); });
    store.subscribe(t, () => { bGotCalled = true; });
    expect(() => store.dispatch(tickEvent(t, 1))).not.toThrow();
    expect(bGotCalled).toBe(true);
  });

  it('caches each kind independently', () => {
    const store = new RealtimeStore();
    const t = topic('ticker:hl:BTC');
    store.dispatch(tickEvent(t, 5));
    store.dispatch(candleEvent(t));
    store.dispatch(bookEvent(t));
    store.dispatch(tradeEvent(t));
    expect(store.getTick(t)?.px).toBe(5);
    expect(store.getCandle(t)?.t).toBe('candle');
    expect(store.getBook(t)?.t).toBe('book');
    expect(store.getTrade(t)?.t).toBe('trade');
  });

  it('clear wipes cached events but preserves listeners', () => {
    const store = new RealtimeStore();
    const t = topic('ticker:hl:BTC');
    const seen: TickEvent[] = [];
    store.subscribe(t, (e) => seen.push(e as TickEvent));
    store.dispatch(tickEvent(t, 1));
    store.clear();
    expect(store.get(t)).toBeUndefined();
    store.dispatch(tickEvent(t, 2));
    expect(seen).toHaveLength(2); // listener still wired
  });
});

/* ── RefCountSet ──────────────────────────────────────────────────────────── */

describe('RefCountSet', () => {
  it('acquire reports the 0→1 transition on first hit only', () => {
    const refs = new RefCountSet();
    const t = topic('ticker:hl:BTC');
    expect(refs.acquire(t)).toBe(true);
    expect(refs.acquire(t)).toBe(false);
    expect(refs.acquire(t)).toBe(false);
    expect(refs.countFor(t)).toBe(3);
  });

  it('release reports the 1→0 transition on last drop only', () => {
    const refs = new RefCountSet();
    const t = topic('ticker:hl:BTC');
    refs.acquire(t); refs.acquire(t);
    expect(refs.release(t)).toBe(false);
    expect(refs.release(t)).toBe(true);
    expect(refs.countFor(t)).toBe(0);
  });

  it('release on an unheld topic is a no-op', () => {
    const refs = new RefCountSet();
    const t = topic('ticker:hl:BTC');
    expect(refs.release(t)).toBe(false);
  });

  it('tracks active topics and totals across many keys', () => {
    const refs = new RefCountSet();
    const a = topic('ticker:hl:BTC');
    const b = topic('candle:hl:ETH:1m');
    refs.acquire(a); refs.acquire(a); refs.acquire(b);
    expect(refs.total()).toBe(3);
    expect(new Set(refs.activeTopics())).toEqual(new Set([a, b]));
  });

  it('clear resets to zero across the board', () => {
    const refs = new RefCountSet();
    const a = topic('ticker:hl:BTC');
    refs.acquire(a); refs.acquire(a);
    refs.clear();
    expect(refs.total()).toBe(0);
    expect(refs.activeTopics()).toEqual([]);
  });
});

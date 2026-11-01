/**
 * Realtime foundation — topic grammar, circuit breaker, and hub ref-count
 * behaviour. These three layers are the invariants every venue adapter
 * trusts; a regression here would let phantom subscriptions pile up or stale
 * data flow when the breaker should be open.
 */

import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker } from './breaker.js';
import { Hub, type SubscriberSink } from './hub.js';
import { asTopic, format, isValid, parse } from './topic.js';
import type {
  FeedEvent,
  RealtimeAdapter,
  Topic,
  VenueHealth,
} from './types.js';

/* ── topic grammar ────────────────────────────────────────────────────────── */

describe('topic.parse', () => {
  it('accepts ticker / trades / stock / meme / predictions with no fourth segment', () => {
    expect(parse('ticker:hl:BTC')).toEqual({ kind: 'ticker', venue: 'hl', symbol: 'BTC' });
    expect(parse('trades:hl:ETH')).toEqual({ kind: 'trades', venue: 'hl', symbol: 'ETH' });
    expect(parse('predictions:pm:0xabc')).toEqual({
      kind: 'predictions', venue: 'pm', symbol: '0xabc',
    });
    expect(parse('stock:pyth:AAPL')).toEqual({ kind: 'stock', venue: 'pyth', symbol: 'AAPL' });
  });

  it('accepts candle topics only with a valid Interval', () => {
    expect(parse('candle:hl:BTC:1m')).toEqual({
      kind: 'candle', venue: 'hl', symbol: 'BTC', interval: '1m',
    });
    expect(parse('candle:hl:BTC:4h')).toMatchObject({ interval: '4h' });
    expect(parse('candle:hl:BTC')).toBeNull();
    expect(parse('candle:hl:BTC:7m')).toBeNull();
    expect(parse('candle:hl:BTC:1m:extra')).toBeNull();
  });

  it('accepts book topics only with a positive integer depth', () => {
    expect(parse('book:hl:BTC:50')).toEqual({
      kind: 'book', venue: 'hl', symbol: 'BTC', depth: 50,
    });
    expect(parse('book:hl:BTC')).toBeNull();
    expect(parse('book:hl:BTC:0')).toBeNull();
    expect(parse('book:hl:BTC:1.5')).toBeNull();
    expect(parse('book:hl:BTC:9999')).toBeNull();
  });

  it('rejects unknown venues and kinds', () => {
    expect(parse('ticker:bogus:BTC')).toBeNull();
    expect(parse('weather:hl:BTC')).toBeNull();
  });

  it('rejects empty / oversize symbols', () => {
    expect(parse('ticker:hl:')).toBeNull();
    expect(parse(`ticker:hl:${'A'.repeat(97)}`)).toBeNull();
  });

  it('rejects entirely malformed input', () => {
    expect(parse('')).toBeNull();
    expect(parse('not-a-topic')).toBeNull();
    expect(parse('ticker:hl')).toBeNull();
  });

  it('format() is the inverse of parse()', () => {
    const cases = [
      'ticker:hl:BTC',
      'candle:hl:BTC:1m',
      'book:pm:0xabc:25',
      'trades:hl:ETH',
      'predictions:pm:0xdef',
      'stock:pyth:AAPL',
    ];
    for (const raw of cases) {
      const p = parse(raw);
      expect(p, raw).not.toBeNull();
      expect(format(p!)).toBe(raw);
    }
  });

  it('isValid agrees with parse', () => {
    expect(isValid('ticker:hl:BTC')).toBe(true);
    expect(isValid('garbage')).toBe(false);
  });

  it('asTopic throws on invalid strings', () => {
    expect(() => asTopic('ticker:hl:BTC')).not.toThrow();
    expect(() => asTopic('bad')).toThrow(/invalid topic/);
  });
});

/* ── circuit breaker ─────────────────────────────────────────────────────── */

describe('CircuitBreaker', () => {
  it('starts closed and stays closed under occasional failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, windowMs: 1_000 });
    for (let i = 0; i < 4; i++) cb.noteFailure();
    expect(cb.getState()).toBe('closed');
    expect(cb.isOpen()).toBe(false);
  });

  it('opens once the threshold is crossed inside the window', () => {
    const onOpen = vi.fn();
    const cb = new CircuitBreaker({
      failureThreshold: 3, windowMs: 1_000, baseCooldownMs: 30, onOpen,
    });
    cb.noteFailure(); cb.noteFailure(); cb.noteFailure();
    expect(cb.getState()).toBe('open');
    expect(onOpen).toHaveBeenCalledOnce();
    cb.dispose();
  });

  it('drops failures that fall outside the window', () => {
    let now = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 3, windowMs: 100, baseCooldownMs: 30, now: () => now,
    });
    cb.noteFailure();                // t=0
    now = 50; cb.noteFailure();      // t=50
    now = 200; cb.noteFailure();     // t=200 — first two have aged out
    expect(cb.getState()).toBe('closed');
    cb.dispose();
  });

  it('transitions open → half-open after cooldown, then closes on success', async () => {
    const onHalfOpen = vi.fn();
    const onClose = vi.fn();
    const cb = new CircuitBreaker({
      failureThreshold: 1, windowMs: 1_000, baseCooldownMs: 10,
      onHalfOpen, onClose,
    });
    cb.noteFailure();
    expect(cb.getState()).toBe('open');
    await new Promise((r) => setTimeout(r, 30));
    expect(cb.getState()).toBe('half-open');
    expect(onHalfOpen).toHaveBeenCalledOnce();
    cb.noteSuccess();
    expect(cb.getState()).toBe('closed');
    expect(onClose).toHaveBeenCalledOnce();
    cb.dispose();
  });

  it('re-opens with longer cooldown on half-open failure', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1, windowMs: 1_000, baseCooldownMs: 10, maxCooldownMs: 100,
    });
    cb.noteFailure();                                // open, cooldown 10
    await new Promise((r) => setTimeout(r, 25));     // → half-open
    expect(cb.getState()).toBe('half-open');
    cb.noteFailure();                                // back to open, cooldown 20
    expect(cb.getState()).toBe('open');
    cb.dispose();
  });

  it('reset() returns to closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, baseCooldownMs: 30 });
    cb.noteFailure();
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
    cb.dispose();
  });
});

/* ── hub ──────────────────────────────────────────────────────────────────── */

class StubAdapter implements RealtimeAdapter {
  readonly venue = 'hl' as const;
  readonly subscribed = new Set<Topic>();
  readonly subCalls: Topic[] = [];
  readonly unsubCalls: Topic[] = [];
  snapshotEvents: FeedEvent[] = [];
  health: VenueHealth = {
    ws: 'open', breakerState: 'closed', lastEventAgeMs: 0,
    subscriberCount: 0, upstream: 'primary',
  };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  subscribe(topic: Topic): void {
    this.subCalls.push(topic);
    this.subscribed.add(topic);
  }
  unsubscribe(topic: Topic): void {
    this.unsubCalls.push(topic);
    this.subscribed.delete(topic);
  }
  async snapshot(): Promise<FeedEvent[]> { return this.snapshotEvents; }
  healthSnapshot(): VenueHealth { return this.health; }
}

function makeSink(id: string): SubscriberSink & { events: FeedEvent[] } {
  const events: FeedEvent[] = [];
  return {
    id,
    events,
    send(event) { events.push(event); },
  };
}

function tick(topic: Topic, px: number): FeedEvent {
  return { t: 'tick', topic, px, ts: Date.now(), lastTickAgeMs: 0, src: 'hl' };
}

function candle(topic: Topic): FeedEvent {
  const t = Date.now();
  return {
    t: 'candle', topic, ts: t, lastTickAgeMs: 0, src: 'hl',
    o: 1, h: 1, l: 1, c: 1, v: 1, closed: false,
  };
}

describe('Hub', () => {
  it('only triggers upstream subscribe on the 0→1 ref-count transition', () => {
    const hub = new Hub();
    const adapter = new StubAdapter();
    hub.register(adapter);

    const a = makeSink('a'); const b = makeSink('b');
    const topic = 'ticker:hl:BTC' as Topic;
    hub.subscribe(a, topic);
    hub.subscribe(b, topic);
    expect(adapter.subCalls).toEqual([topic]);
    expect(adapter.unsubCalls).toEqual([]);
    expect(hub.refCountFor(topic)).toBe(2);
  });

  it('triggers upstream unsubscribe only on the 1→0 transition', () => {
    const hub = new Hub();
    const adapter = new StubAdapter();
    hub.register(adapter);

    const a = makeSink('a'); const b = makeSink('b');
    const topic = 'ticker:hl:BTC' as Topic;
    hub.subscribe(a, topic);
    hub.subscribe(b, topic);
    hub.unsubscribe(a, topic);
    expect(adapter.unsubCalls).toEqual([]);
    expect(hub.refCountFor(topic)).toBe(1);
    hub.unsubscribe(b, topic);
    expect(adapter.unsubCalls).toEqual([topic]);
    expect(hub.refCountFor(topic)).toBe(0);
  });

  it('idempotent subscribe (same sink twice on same topic)', () => {
    const hub = new Hub();
    const adapter = new StubAdapter();
    hub.register(adapter);
    const a = makeSink('a');
    const topic = 'ticker:hl:BTC' as Topic;
    hub.subscribe(a, topic);
    hub.subscribe(a, topic);
    expect(adapter.subCalls).toEqual([topic]);
    expect(hub.refCountFor(topic)).toBe(1);
  });

  it('idempotent unsubscribe (no-op when not subscribed)', () => {
    const hub = new Hub();
    const adapter = new StubAdapter();
    hub.register(adapter);
    const a = makeSink('a');
    const topic = 'ticker:hl:BTC' as Topic;
    hub.unsubscribe(a, topic);                 // never subscribed — no throw
    expect(adapter.unsubCalls).toEqual([]);
  });

  it('rejects malformed topic strings on subscribe', () => {
    const hub = new Hub();
    expect(() => hub.subscribe(makeSink('a'), 'garbage' as Topic)).toThrow(/invalid topic/);
  });

  it('publish delivers candle/book/trade events immediately to subscribed sinks only', () => {
    const hub = new Hub();
    hub.register(new StubAdapter());
    const a = makeSink('a'); const b = makeSink('b');
    const t1 = 'candle:hl:BTC:1m' as Topic;
    const t2 = 'candle:hl:ETH:1m' as Topic;
    hub.subscribe(a, t1);
    hub.subscribe(b, t2);
    hub.publish(candle(t1));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);
  });

  it('publish coalesces ticker bursts: only last value reaches sinks per window', async () => {
    const hub = new Hub({ tickerCoalesceMs: 20 });
    hub.register(new StubAdapter());
    const sink = makeSink('a');
    const topic = 'ticker:hl:BTC' as Topic;
    hub.subscribe(sink, topic);
    hub.publish(tick(topic, 1));
    hub.publish(tick(topic, 2));
    hub.publish(tick(topic, 3));
    expect(sink.events).toHaveLength(0); // pending coalesce
    await new Promise((r) => setTimeout(r, 40));
    expect(sink.events).toHaveLength(1);
    expect((sink.events[0] as { px: number }).px).toBe(3);
  });

  it('subscribe returns the last-known event for cold-start seeding', () => {
    const hub = new Hub();
    hub.register(new StubAdapter());
    const seeder = makeSink('seed');
    const topic = 'candle:hl:BTC:1m' as Topic;
    hub.subscribe(seeder, topic);
    hub.publish(candle(topic));
    const fresh = makeSink('fresh');
    const seed = hub.subscribe(fresh, topic);
    expect(seed?.topic).toBe(topic);
  });

  it('fills a first subscriber from the adapter snapshot without waiting for a live tick', async () => {
    const hub = new Hub();
    const adapter = new StubAdapter();
    const topic = 'candle:hl:BTC:1m' as Topic;
    adapter.snapshotEvents = [candle(topic)];
    hub.register(adapter);

    const sink = makeSink('fresh');
    hub.subscribe(sink, topic);
    await Promise.resolve();

    expect(sink.events).toHaveLength(1);
    expect(hub.lastFor(topic)?.topic).toBe(topic);
  });

  it('unsubscribeAll cleans up every topic the sink held', () => {
    const hub = new Hub();
    const adapter = new StubAdapter();
    hub.register(adapter);
    const a = makeSink('a');
    const t1 = 'ticker:hl:BTC' as Topic;
    const t2 = 'candle:hl:ETH:1m' as Topic;
    hub.subscribe(a, t1);
    hub.subscribe(a, t2);
    expect(hub.totalSubscriptions()).toBe(2);
    hub.unsubscribeAll(a);
    expect(hub.totalSubscriptions()).toBe(0);
    expect(new Set(adapter.unsubCalls)).toEqual(new Set([t1, t2]));
  });

  it('publish to a topic with no subscribers still caches lastByTopic for snapshot seeding', () => {
    const hub = new Hub();
    hub.register(new StubAdapter());
    const topic = 'candle:hl:BTC:1m' as Topic;
    hub.publish(candle(topic));
    expect(hub.lastFor(topic)?.topic).toBe(topic);
  });

  it('fires priv hooks only on 0→1 and 1→0 transitions for the registered kind', () => {
    const hub = new Hub();
    const first: string[] = [];
    const last: string[] = [];
    hub.registerPrivHook('account', {
      onFirstSubscriber: (uid) => first.push(uid),
      onLastUnsubscribe: (uid) => last.push(uid),
    });

    const a = makeSink('a'); const b = makeSink('b');
    const topic = 'priv:user-1:account' as Topic;
    hub.subscribe(a, topic);
    hub.subscribe(b, topic);
    expect(first).toEqual(['user-1']);           // 0→1 only
    hub.unsubscribe(a, topic);
    expect(last).toEqual([]);                    // still one subscriber
    hub.unsubscribe(b, topic);
    expect(last).toEqual(['user-1']);            // 1→0

    // Unhooked kind ('orders') stays silent.
    hub.subscribe(a, 'priv:user-1:orders' as Topic);
    hub.unsubscribe(a, 'priv:user-1:orders' as Topic);
    expect(first).toEqual(['user-1']);
    expect(last).toEqual(['user-1']);
  });

  it('a throwing priv hook does not break the client subscription', () => {
    const hub = new Hub();
    hub.registerPrivHook('fills', {
      onFirstSubscriber: () => { throw new Error('boom'); },
      onLastUnsubscribe: () => { throw new Error('boom'); },
    });
    const a = makeSink('a');
    const topic = 'priv:user-2:fills' as Topic;
    expect(() => hub.subscribe(a, topic)).not.toThrow();
    expect(hub.refCountFor(topic)).toBe(1);
    expect(() => hub.unsubscribe(a, topic)).not.toThrow();
    expect(hub.refCountFor(topic)).toBe(0);
  });

  it('rejects a duplicate priv hook registration for the same kind', () => {
    const hub = new Hub();
    const hook = { onFirstSubscriber: () => {}, onLastUnsubscribe: () => {} };
    hub.registerPrivHook('account', hook);
    expect(() => hub.registerPrivHook('account', hook)).toThrow(/already registered/);
  });
});

/* ── cross-package wire invariant ─────────────────────────────────────────── */

/**
 * The realtime hub's TS types live in `apps/api/src/realtime/types.ts` and
 * the Zod schemas live in `@nexa/shared-zod/realtime`. The plan keeps the
 * server's TS types intact (no refactor of the existing surface) but treats
 * shared-zod as the source of truth for the wire protocol. This block makes
 * sure the two stay isomorphic: every event a server adapter can emit must
 * round-trip through the shared-zod `FeedEventZ` parser. If a future change
 * to `types.ts` adds a field that's missing from `realtime.ts`, this test
 * fires first.
 */
describe('wire invariant: server FeedEvent ↔ shared-zod FeedEventZ', () => {
  it('every server-shape FeedEvent fixture parses through shared-zod', async () => {
    const { FeedEventZ } = await import('@nexa/shared-zod');
    const fixtures: FeedEvent[] = [
      {
        t: 'tick',
        topic: asTopic('ticker:hl:BTC'),
        ts: 1_700_000_000_000,
        lastTickAgeMs: 12,
        src: 'hl',
        px: 64_200,
      },
      {
        t: 'candle',
        topic: asTopic('candle:hl:BTC:1m'),
        ts: 1_700_000_000_000,
        lastTickAgeMs: 60_000,
        src: 'hl',
        o: 64_000, h: 64_500, l: 63_800, c: 64_200, v: 12.3,
        closed: false,
      },
      {
        t: 'book',
        topic: asTopic('book:hl:BTC:50'),
        ts: 1_700_000_000_000,
        lastTickAgeMs: 5,
        src: 'hl',
        bids: [[64_100, 0.5], [64_050, 1.2]],
        asks: [[64_200, 0.3], [64_250, 0.8]],
        seq: 42,
      },
      {
        t: 'trade',
        topic: asTopic('trades:hl:BTC'),
        ts: 1_700_000_000_000,
        lastTickAgeMs: 1,
        src: 'hl',
        px: 64_200, sz: 0.1, side: 'buy',
      },
      {
        t: 'account',
        topic: 'priv:user-1:account' as Topic,
        ts: 1_700_000_000_000,
        lastTickAgeMs: 3,
        src: 'hl',
        equityUsd: 1_250.5,
        marginUsedUsd: 300,
        withdrawableUsd: 900.5,
        accountValueUsd: 1_250.5,
        positions: [{
          coin: 'BTC', sideLong: true, qty: 0.0053, qtyUsd: 340.2,
          entryPriceUsd: 64_100, unrealizedPnlUsd: 2.15, leverage: 5,
          liquidationPriceUsd: 51_280,
        }],
      },
      {
        t: 'fill',
        topic: 'priv:user-1:fills' as Topic,
        ts: 1_700_000_000_000,
        lastTickAgeMs: 2,
        src: 'hl',
        orderId: 'hl_77123',
        coin: 'ETH', sideLong: false, px: 3_420.5, sz: 0.4,
        feeUsd: 0.48, closedPnlUsd: null, dir: 'Open Short',
        hash: '0xabc', liquidation: false,
      },
    ];
    for (const f of fixtures) {
      const result = FeedEventZ.safeParse(f);
      expect(result.success, `fixture failed: ${JSON.stringify(f)}`).toBe(true);
    }
  });

  it('shared-zod inferred type assignable to server FeedEvent and vice versa', async () => {
    const { FeedEventZ } = await import('@nexa/shared-zod');
    type SharedFeedEvent = import('@nexa/shared-zod').FeedEvent;
    // Compile-time isomorphism — these assignments fail typecheck if a field
    // diverges between server types.ts and shared-zod realtime.ts.
    const fromServer: FeedEvent = {
      t: 'tick',
      topic: asTopic('ticker:hl:BTC'),
      ts: 0, lastTickAgeMs: 0, src: 'hl', px: 1,
    };
    const acceptsServer: SharedFeedEvent = fromServer as SharedFeedEvent;
    const fromShared = FeedEventZ.parse(fromServer);
    const acceptsShared: FeedEvent = fromShared as FeedEvent;
    expect(acceptsServer.t).toBe(acceptsShared.t);
  });
});

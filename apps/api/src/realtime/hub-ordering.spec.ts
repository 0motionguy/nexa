import { describe, expect, it } from 'vitest';

import { Hub, type SubscriberSink } from './hub.js';
import type {
  BookEvent,
  CandleEvent,
  FeedEvent,
  RealtimeAdapter,
  Topic,
  TradeEvent,
  VenueHealth,
} from './types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class SnapshotAdapter implements RealtimeAdapter {
  readonly venue = 'hl' as const;
  readonly snapshots: Promise<FeedEvent[]>[] = [];
  readonly unsubscribed: Topic[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  subscribe(): void {}
  unsubscribe(topic: Topic): void { this.unsubscribed.push(topic); }
  async snapshot(): Promise<FeedEvent[]> { return this.snapshots.shift() ?? []; }
  healthSnapshot(): VenueHealth {
    return {
      ws: 'open', breakerState: 'closed', lastEventAgeMs: 0,
      subscriberCount: 0, upstream: 'primary',
    };
  }
}

function sink(): SubscriberSink & { events: FeedEvent[] } {
  const events: FeedEvent[] = [];
  return { id: 'sink', events, send: (event) => events.push(event) };
}

function candle(topic: Topic, ts: number, close: number, stale = false): CandleEvent {
  return {
    t: 'candle', topic, ts, lastTickAgeMs: stale ? 10_000 : 0,
    src: stale ? 'rest' : 'hl', stale, o: close, h: close, l: close,
    c: close, v: 1, closed: false,
  };
}

function book(topic: Topic, ts: number, seq: number): BookEvent {
  return {
    t: 'book', topic, ts, lastTickAgeMs: 0, src: 'hl', seq,
    bids: [[100, 1]], asks: [[101, 1]],
  };
}

function trade(topic: Topic, ts: number, px: number): TradeEvent {
  return {
    t: 'trade', topic, ts, lastTickAgeMs: 0, src: 'hl', px, sz: 1, side: 'buy',
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Hub event ordering', () => {
  it('rejects older frames and a stale fallback after fresh live state', () => {
    const hub = new Hub();
    const adapter = new SnapshotAdapter();
    hub.register(adapter);
    const topic = 'candle:hl:BTC:1m' as Topic;
    const target = sink();
    hub.subscribe(target, topic);

    const fresh = candle(topic, 200, 200);
    hub.publish(fresh);
    hub.publish(candle(topic, 100, 100));
    hub.publish(candle(topic, 300, 300, true));

    expect(target.events).toEqual([fresh]);
    expect(hub.lastFor(topic)).toBe(fresh);
  });

  it('uses book sequence to reject a regression at the same timestamp', () => {
    const hub = new Hub();
    const adapter = new SnapshotAdapter();
    hub.register(adapter);
    const topic = 'book:hl:BTC:25' as Topic;
    const target = sink();
    hub.subscribe(target, topic);

    const latest = book(topic, 200, 12);
    hub.publish(latest);
    hub.publish(book(topic, 200, 11));

    expect(target.events).toEqual([latest]);
    expect(hub.lastFor(topic)).toBe(latest);
  });

  it('delivers every trade delta without letting an older print regress the seed', () => {
    const hub = new Hub();
    const adapter = new SnapshotAdapter();
    hub.register(adapter);
    const topic = 'trades:hl:BTC' as Topic;
    const target = sink();
    hub.subscribe(target, topic);
    const newer = trade(topic, 200, 200);
    const older = trade(topic, 100, 100);

    hub.publish(newer);
    hub.publish(older);

    expect(target.events).toEqual([newer, older]);
    expect(hub.lastFor(topic)).toBe(newer);
  });

  it('does not deliver a snapshot after a live delta wins the cold-start race', async () => {
    const hub = new Hub();
    const adapter = new SnapshotAdapter();
    const pending = deferred<FeedEvent[]>();
    adapter.snapshots.push(pending.promise);
    hub.register(adapter);
    const topic = 'candle:hl:BTC:1m' as Topic;
    const target = sink();

    hub.subscribe(target, topic);
    const live = candle(topic, 200, 200);
    hub.publish(live);
    pending.resolve([candle(topic, 300, 300)]);
    await settle();

    expect(target.events).toEqual([live]);
    expect(hub.lastFor(topic)).toBe(live);
  });

  it('invalidates an in-flight snapshot when the final subscriber leaves', async () => {
    const hub = new Hub();
    const adapter = new SnapshotAdapter();
    const oldSnapshot = deferred<FeedEvent[]>();
    const newSnapshot = deferred<FeedEvent[]>();
    adapter.snapshots.push(oldSnapshot.promise, newSnapshot.promise);
    hub.register(adapter);
    const topic = 'candle:hl:BTC:1m' as Topic;
    const first = sink();
    const second = sink();

    hub.subscribe(first, topic);
    hub.unsubscribe(first, topic);
    hub.subscribe(second, topic);
    const current = candle(topic, 200, 200);
    newSnapshot.resolve([current]);
    await settle();
    oldSnapshot.resolve([candle(topic, 300, 300)]);
    await settle();

    expect(adapter.unsubscribed).toEqual([topic]);
    expect(second.events).toEqual([current]);
    expect(hub.lastFor(topic)).toBe(current);
  });
});

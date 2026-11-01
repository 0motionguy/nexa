import { describe, expect, it, vi } from 'vitest';

import { RealtimeStore } from './store.js';
import type { BookEvent, FillEvent, TickEvent, Topic, TradeEvent } from './types.js';

const tickTopic = 'ticker:hl:BTC' as Topic;

function tick(ts: number, px: number, stale = false): TickEvent {
  return {
    t: 'tick', topic: tickTopic, ts, lastTickAgeMs: stale ? 10_000 : 0,
    src: stale ? 'rest' : 'hl', stale, px,
  };
}

describe('RealtimeStore event ordering', () => {
  it('does not regress cached state or notify listeners for older/stale frames', () => {
    const store = new RealtimeStore();
    const listener = vi.fn();
    store.subscribe(tickTopic, listener);
    const fresh = tick(200, 200);

    store.dispatch(fresh);
    store.dispatch(tick(100, 100));
    store.dispatch(tick(300, 300, true));

    expect(store.getTick(tickTopic)).toBe(fresh);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(fresh);
  });

  it('lets fresh live state replace a newer-timestamped stale seed', () => {
    const store = new RealtimeStore();
    const stale = tick(300, 300, true);
    const fresh = tick(200, 200);
    store.dispatch(stale);
    store.dispatch(fresh);
    expect(store.getTick(tickTopic)).toBe(fresh);
  });

  it('rejects a lower book sequence at the same timestamp', () => {
    const store = new RealtimeStore();
    const topic = 'book:hl:BTC:25' as Topic;
    const event = (seq: number): BookEvent => ({
      t: 'book', topic, ts: 200, lastTickAgeMs: 0, src: 'hl', seq,
      bids: [[100, 1]], asks: [[101, 1]],
    });
    const latest = event(12);
    store.dispatch(latest);
    store.dispatch(event(11));
    expect(store.getBook(topic)).toBe(latest);
  });

  it('still delivers out-of-order fills because they are one-shot deltas', () => {
    const store = new RealtimeStore();
    const topic = 'priv:user-1:fills' as Topic;
    const listener = vi.fn();
    store.subscribe(topic, listener);
    const fill = (ts: number, orderId: string): FillEvent => ({
      t: 'fill', topic, ts, lastTickAgeMs: 0, src: 'hl', orderId,
      coin: 'BTC', sideLong: true, px: 100, sz: 1, feeUsd: 0,
      closedPnlUsd: null, dir: 'Open Long', hash: orderId, liquidation: false,
    });

    store.dispatch(fill(200, 'hl_2'));
    store.dispatch(fill(100, 'hl_1'));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('delivers every trade delta without regressing the latest-trade cache', () => {
    const store = new RealtimeStore();
    const topic = 'trades:hl:BTC' as Topic;
    const listener = vi.fn();
    store.subscribe(topic, listener);
    const trade = (ts: number, px: number): TradeEvent => ({
      t: 'trade', topic, ts, lastTickAgeMs: 0, src: 'hl', px, sz: 1, side: 'buy',
    });
    const newer = trade(200, 200);
    const older = trade(100, 100);

    store.dispatch(newer);
    store.dispatch(older);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getTrade(topic)).toBe(newer);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ClientOpZ,
  FeedEventZ,
  ServerOpZ,
  HealthzRealtimeZ,
  VenueHealthZ,
} from './realtime.js';

describe('realtime wire schemas', () => {
  it('parses a TickEvent fixture', () => {
    const tick = {
      t: 'tick',
      topic: 'ticker:hl:BTC',
      ts: 1_700_000_000_000,
      lastTickAgeMs: 12,
      src: 'hl',
      px: 64_212.5,
    };
    const out = FeedEventZ.parse(tick);
    expect(out.t).toBe('tick');
    if (out.t === 'tick') expect(out.px).toBe(64_212.5);
  });

  it('parses a CandleEvent fixture', () => {
    const candle = {
      t: 'candle',
      topic: 'candle:hl:BTC:1m',
      ts: 1_700_000_000_000,
      lastTickAgeMs: 60_000,
      src: 'hl',
      o: 64_000, h: 64_500, l: 63_800, c: 64_200, v: 12.3,
      closed: false,
    };
    expect(FeedEventZ.parse(candle).t).toBe('candle');
  });

  it('parses a BookEvent fixture', () => {
    const book = {
      t: 'book',
      topic: 'book:hl:BTC:50',
      ts: 1_700_000_000_000,
      lastTickAgeMs: 5,
      src: 'hl',
      bids: [[64_100, 0.5], [64_050, 1.2]],
      asks: [[64_200, 0.3], [64_250, 0.8]],
      seq: 12345,
    };
    expect(FeedEventZ.parse(book).t).toBe('book');
  });

  it('parses a TradeEvent fixture', () => {
    const trade = {
      t: 'trade',
      topic: 'trades:hl:BTC',
      ts: 1_700_000_000_000,
      lastTickAgeMs: 1,
      src: 'hl',
      px: 64_200, sz: 0.1, side: 'buy',
    };
    expect(FeedEventZ.parse(trade).t).toBe('trade');
  });

  it('parses an AccountEvent fixture (webData2 snapshot)', () => {
    const account = {
      t: 'account',
      topic: 'priv:user-1:account',
      ts: 1_700_000_000_000,
      lastTickAgeMs: 3,
      src: 'hl',
      equityUsd: 1_250.5,
      marginUsedUsd: 300,
      withdrawableUsd: 900.5,
      accountValueUsd: 1_250.5,
      positions: [{
        coin: 'BTC',
        sideLong: true,
        qty: 0.0053,
        qtyUsd: 340.2,
        entryPriceUsd: 64_100,
        unrealizedPnlUsd: 2.15,
        leverage: 5,
        liquidationPriceUsd: 51_280,
      }],
    };
    const out = FeedEventZ.parse(account);
    expect(out.t).toBe('account');
    if (out.t === 'account') {
      expect(out.withdrawableUsd).toBe(900.5);
      expect(out.positions[0]?.liquidationPriceUsd).toBe(51_280);
    }
  });

  it('parses a FillEvent fixture and rejects one missing coin', () => {
    const fill = {
      t: 'fill',
      topic: 'priv:user-1:fills',
      ts: 1_700_000_000_000,
      lastTickAgeMs: 2,
      src: 'hl',
      orderId: 'hl_77123',
      coin: 'ETH',
      sideLong: false,
      px: 3_420.5,
      sz: 0.4,
      feeUsd: 0.48,
      closedPnlUsd: null,
      dir: 'Open Short',
      hash: '0xabc',
      liquidation: false,
    };
    const out = FeedEventZ.parse(fill);
    expect(out.t).toBe('fill');
    if (out.t === 'fill') expect(out.orderId).toBe('hl_77123');
    expect(() => FeedEventZ.parse({ ...fill, coin: undefined })).toThrow();
  });

  it('rejects an event with unknown discriminator', () => {
    expect(() => FeedEventZ.parse({
      t: 'bogus', topic: 'ticker:hl:BTC', ts: 0, lastTickAgeMs: 0, src: 'hl',
    })).toThrow();
  });

  it('rejects a TickEvent missing px', () => {
    expect(() => FeedEventZ.parse({
      t: 'tick', topic: 'ticker:hl:BTC', ts: 0, lastTickAgeMs: 0, src: 'hl',
    })).toThrow();
  });

  it('parses a sub ClientOp', () => {
    const op = ClientOpZ.parse({ op: 'sub', topics: ['ticker:hl:BTC', 'candle:hl:BTC:1m'] });
    expect(op.op).toBe('sub');
    if (op.op === 'sub') expect(op.topics).toHaveLength(2);
  });

  it('parses an unsub ClientOp', () => {
    expect(ClientOpZ.parse({ op: 'unsub', topics: ['ticker:hl:BTC'] }).op).toBe('unsub');
  });

  it('parses a ping ClientOp', () => {
    expect(ClientOpZ.parse({ op: 'ping' }).op).toBe('ping');
  });

  it('rejects a ClientOp with bad op discriminator', () => {
    expect(() => ClientOpZ.parse({ op: 'unknown', topics: [] })).toThrow();
  });

  it('parses ServerOp ready / pong / err envelopes', () => {
    expect(ServerOpZ.parse({ op: 'ready', accepted: ['ticker:hl:BTC'], serverVersion: '1' })).toBeTruthy();
    expect(ServerOpZ.parse({ op: 'pong', ts: 1_700_000_000_000 })).toBeTruthy();
    expect(ServerOpZ.parse({ op: 'err', code: 'unauthorized' })).toBeTruthy();
    expect(ServerOpZ.parse({ op: 'err', code: 'topic_invalid', topic: 'ticker:hl:BTC' })).toBeTruthy();
  });

  it('ServerOp also accepts any FeedEvent', () => {
    const tick = {
      t: 'tick',
      topic: 'ticker:hl:BTC',
      ts: 0, lastTickAgeMs: 0, src: 'hl', px: 1,
    };
    expect(ServerOpZ.parse(tick)).toBeTruthy();
  });

  it('parses VenueHealth + HealthzRealtime', () => {
    const venue = VenueHealthZ.parse({
      ws: 'open',
      breakerState: 'closed',
      lastEventAgeMs: 12,
      subscriberCount: 3,
      upstream: 'primary',
    });
    expect(venue.ws).toBe('open');
    expect(HealthzRealtimeZ.parse({ disabled: true })).toEqual({ disabled: true });
    expect(HealthzRealtimeZ.parse({
      hyperliquid: venue,
      polymarket: venue,
      clients: 5,
    })).toMatchObject({ clients: 5 });
  });
});

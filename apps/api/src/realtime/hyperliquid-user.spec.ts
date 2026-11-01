/**
 * HlUserStreamManager — ADR-0004 part 2 unit coverage on injected fake
 * sockets. No network: the fake WS records outbound JSON and lets tests push
 * upstream frames. Address resolution is injected so the store never boots.
 */

import { describe, expect, it, vi } from 'vitest';
import { Hub, type SubscriberSink } from './hub.js';
import { HlUserStreamManager, type WsLike } from './venues/hyperliquid-user.js';
import { privAccountTopic, privFillsTopic } from './topic.js';
import type { FeedEvent } from './types.js';

class FakeWs implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  readyState = 0; // CONNECTING
  readonly sent: unknown[] = [];
  closed = false;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.({ code: 1000 });
  }

  /** Test helper — flip to OPEN and fire onopen. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Test helper — deliver one upstream frame. */
  frame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  subsOfType(type: string): unknown[] {
    return this.sent.filter(
      (m) => (m as { method?: string; subscription?: { type?: string } }).method === 'subscribe'
        && (m as { subscription?: { type?: string } }).subscription?.type === type,
    );
  }
}

interface Rig {
  hub: Hub;
  mgr: HlUserStreamManager;
  sockets: FakeWs[];
  attach(userId: string, kind: 'account' | 'fills'): Promise<void>;
  sink(id: string): SubscriberSink & { events: FeedEvent[] };
}

function makeRig(opts: {
  addresses?: Record<string, string | null>;
  maxUsersPerShard?: number;
  maxShards?: number;
} = {}): Rig {
  const hub = new Hub();
  const sockets: FakeWs[] = [];
  const addresses = opts.addresses ?? { 'user-1': '0xAbC1', 'user-2': '0xAbC2' };
  const mgr = new HlUserStreamManager({
    wsFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      // Open on the next microtask so subscribe replay via onopen is exercised.
      queueMicrotask(() => ws.open());
      return ws;
    },
    resolveAddress: async (userId) => addresses[userId] ?? null,
    maxUsersPerShard: opts.maxUsersPerShard,
    maxShards: opts.maxShards,
  });
  hub.registerPrivHook('account', mgr.hookFor('account'));
  hub.registerPrivHook('fills', mgr.hookFor('fills'));
  mgr.start(hub);
  return {
    hub,
    mgr,
    sockets,
    // Hooks are fire-and-forget; tests await the async attach via a tick.
    attach: async (userId, kind) => {
      hub.subscribe(makeSink(`sink-${userId}-${kind}`), (kind === 'account'
        ? privAccountTopic(userId)
        : privFillsTopic(userId)));
      await flush();
    },
    sink: makeSink,
  };
}

function makeSink(id: string): SubscriberSink & { events: FeedEvent[] } {
  const events: FeedEvent[] = [];
  return { id, events, send: (e) => { events.push(e); } };
}

/** Drain microtasks + the queueMicrotask-opened sockets. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const CLEARINGHOUSE_STATE_FRAME = {
  channel: 'clearinghouseState',
  data: {
    user: '0xabc1',
    clearinghouseState: {
      marginSummary: { accountValue: '1250.5', totalMarginUsed: '300' },
      withdrawable: '900.5',
      assetPositions: [
        {
          position: {
            coin: 'BTC',
            szi: '0.0053',
            entryPx: '64100',
            positionValue: '340.2',
            unrealizedPnl: '2.15',
            liquidationPx: '51280',
            leverage: { value: 5 },
          },
        },
        // Flat position rows (szi 0) must be skipped.
        { position: { coin: 'ETH', szi: '0', entryPx: '3400' } },
      ],
    },
  },
};

const FILLS_FRAME = {
  channel: 'userFills',
  data: {
    user: '0xabc1',
    isSnapshot: false,
    fills: [{
      coin: 'eth',
      px: '3420.5',
      sz: '0.4',
      side: 'A',
      time: Date.now() - 50,
      dir: 'Open Short',
      closedPnl: '0.0',
      hash: '0xdead',
      oid: 77_123,
      fee: '0.48',
    }],
  },
};

describe('HlUserStreamManager', () => {
  it('subscribes clearinghouseState + userFills upstream per kind and demuxes into priv topics', async () => {
    const rig = makeRig();
    const accountSink = rig.sink('acc');
    const fillsSink = rig.sink('fil');
    rig.hub.subscribe(accountSink, privAccountTopic('user-1'));
    rig.hub.subscribe(fillsSink, privFillsTopic('user-1'));
    await flush();

    expect(rig.sockets).toHaveLength(1);
    const ws = rig.sockets[0]!;
    expect(ws.subsOfType('clearinghouseState')).toEqual([
      { method: 'subscribe', subscription: { type: 'clearinghouseState', user: '0xAbC1' } },
    ]);
    expect(ws.subsOfType('userFills')).toHaveLength(1);

    ws.frame(CLEARINGHOUSE_STATE_FRAME);
    expect(accountSink.events).toHaveLength(1);
    const acc = accountSink.events[0]!;
    expect(acc.t).toBe('account');
    if (acc.t === 'account') {
      expect(acc.withdrawableUsd).toBe(900.5);
      expect(acc.equityUsd).toBe(1250.5);
      expect(acc.marginUsedUsd).toBe(300);
      expect(acc.positions).toHaveLength(1); // flat ETH row skipped
      expect(acc.positions[0]).toMatchObject({
        coin: 'BTC', sideLong: true, leverage: 5, liquidationPriceUsd: 51_280,
      });
    }

    ws.frame(FILLS_FRAME);
    expect(fillsSink.events).toHaveLength(1);
    const fill = fillsSink.events[0]!;
    expect(fill.t).toBe('fill');
    if (fill.t === 'fill') {
      expect(fill.orderId).toBe('hl_77123');
      expect(fill.coin).toBe('ETH');
      expect(fill.sideLong).toBe(false); // side 'A' = sell
      expect(fill.feeUsd).toBe(0.48);
    }
  });

  it('skips userFills snapshot frames (history replay is REST, not live events)', async () => {
    const rig = makeRig();
    const fillsSink = rig.sink('fil');
    rig.hub.subscribe(fillsSink, privFillsTopic('user-1'));
    await flush();
    const ws = rig.sockets[0]!;
    ws.frame({ ...FILLS_FRAME, data: { ...FILLS_FRAME.data, isSnapshot: true } });
    expect(fillsSink.events).toHaveLength(0);
    ws.frame(FILLS_FRAME);
    expect(fillsSink.events).toHaveLength(1);
  });

  it('only attaches the subscribed kind upstream; second kind adds a sub without a new socket', async () => {
    const rig = makeRig();
    rig.hub.subscribe(rig.sink('a'), privAccountTopic('user-1'));
    await flush();
    const ws = rig.sockets[0]!;
    expect(ws.subsOfType('clearinghouseState')).toHaveLength(1);
    expect(ws.subsOfType('userFills')).toHaveLength(0);

    rig.hub.subscribe(rig.sink('f'), privFillsTopic('user-1'));
    await flush();
    expect(rig.sockets).toHaveLength(1);
    expect(ws.subsOfType('userFills')).toHaveLength(1);
  });

  it('detach sends upstream unsubscribe and closes an empty shard', async () => {
    const rig = makeRig();
    const sink = rig.sink('a');
    rig.hub.subscribe(sink, privAccountTopic('user-1'));
    await flush();
    const ws = rig.sockets[0]!;

    rig.hub.unsubscribe(sink, privAccountTopic('user-1'));
    const unsubs = ws.sent.filter((m) => (m as { method?: string }).method === 'unsubscribe');
    expect(unsubs).toEqual([
      { method: 'unsubscribe', subscription: { type: 'clearinghouseState', user: '0xAbC1' } },
    ]);
    expect(ws.closed).toBe(true);
    expect(rig.mgr.streamedUserCount()).toBe(0);
  });

  it('shards: the (maxUsersPerShard+1)-th user lands on a second socket', async () => {
    const addresses: Record<string, string> = {};
    for (let i = 0; i < 3; i++) addresses[`u${i}`] = `0x000${i}`;
    const rig = makeRig({ addresses, maxUsersPerShard: 2, maxShards: 2 });
    for (let i = 0; i < 3; i++) await rig.attach(`u${i}`, 'account');
    expect(rig.sockets).toHaveLength(2);
    expect(rig.mgr.shardCount()).toBe(2);
    expect(rig.mgr.streamedUserCount()).toBe(3);
  });

  it('declines users past the shard cap with a single warn (poll fallback)', async () => {
    const addresses: Record<string, string> = {};
    for (let i = 0; i < 3; i++) addresses[`u${i}`] = `0x000${i}`;
    const rig = makeRig({ addresses, maxUsersPerShard: 1, maxShards: 2 });
    for (let i = 0; i < 3; i++) await rig.attach(`u${i}`, 'account');
    expect(rig.mgr.streamedUserCount()).toBe(2);
    expect(rig.sockets).toHaveLength(2);
  });

  it('users without a wallet address are ignored (no socket, no events)', async () => {
    const rig = makeRig({ addresses: { 'user-1': null } });
    await rig.attach('user-1', 'account');
    expect(rig.sockets).toHaveLength(0);
    expect(rig.mgr.streamedUserCount()).toBe(0);
  });

  it('re-subscribes every user kind after a reconnect', async () => {
    vi.useFakeTimers();
    try {
      const hub = new Hub();
      const sockets: FakeWs[] = [];
      const mgr = new HlUserStreamManager({
        wsFactory: () => {
          const ws = new FakeWs();
          sockets.push(ws);
          return ws;
        },
        resolveAddress: async () => '0xAbC1',
      });
      hub.registerPrivHook('account', mgr.hookFor('account'));
      hub.registerPrivHook('fills', mgr.hookFor('fills'));
      mgr.start(hub);

      hub.subscribe(makeSink('a'), privAccountTopic('user-1'));
      hub.subscribe(makeSink('f'), privFillsTopic('user-1'));
      await vi.runOnlyPendingTimersAsync();
      const ws1 = sockets[0]!;
      ws1.open();
      expect(ws1.subsOfType('clearinghouseState')).toHaveLength(1);
      expect(ws1.subsOfType('userFills')).toHaveLength(1);

      // Drop the socket — a reconnect should be scheduled with backoff.
      ws1.readyState = 3;
      ws1.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(sockets).toHaveLength(2);
      const ws2 = sockets[1]!;
      ws2.open();
      expect(ws2.subsOfType('clearinghouseState')).toHaveLength(1);
      expect(ws2.subsOfType('userFills')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frames for unknown addresses are dropped (no cross-user leak path)', async () => {
    const rig = makeRig();
    const sink = rig.sink('a');
    rig.hub.subscribe(sink, privAccountTopic('user-1'));
    await flush();
    rig.sockets[0]!.frame({
      ...CLEARINGHOUSE_STATE_FRAME,
      data: { ...CLEARINGHOUSE_STATE_FRAME.data, user: '0xUNKNOWN' },
    });
    expect(sink.events).toHaveLength(0);
  });

  it('drops byte-identical clearinghouseState frames (idle accounts publish once)', async () => {
    const rig = makeRig();
    const sink = rig.sink('acc');
    rig.hub.subscribe(sink, privAccountTopic('user-1'));
    await flush();
    const ws = rig.sockets[0]!;
    ws.frame(CLEARINGHOUSE_STATE_FRAME);
    ws.frame(CLEARINGHOUSE_STATE_FRAME);
    expect(sink.events).toHaveLength(1);
    // A real change (withdrawable moved) publishes again.
    ws.frame({
      ...CLEARINGHOUSE_STATE_FRAME,
      data: {
        ...CLEARINGHOUSE_STATE_FRAME.data,
        clearinghouseState: {
          ...CLEARINGHOUSE_STATE_FRAME.data.clearinghouseState,
          withdrawable: '850.0',
        },
      },
    });
    expect(sink.events).toHaveLength(2);
  });

  it('unsubscribe→resubscribe during address resolution does not kill the new attach', async () => {
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => { release = r; });
    const hub = new Hub();
    const sockets: FakeWs[] = [];
    let resolveCalls = 0;
    const mgr = new HlUserStreamManager({
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        queueMicrotask(() => ws.open());
        return ws;
      },
      // First call blocks on the gate (attach#1 in flight); later calls
      // resolve immediately (attach#2 after the rapid resubscribe).
      resolveAddress: async () => {
        resolveCalls++;
        if (resolveCalls === 1) return gate;
        return '0xAbC1';
      },
    });
    hub.registerPrivHook('account', mgr.hookFor('account'));
    mgr.start(hub);

    const sink = makeSink('a');
    hub.subscribe(sink, privAccountTopic('user-1'));       // attach#1 pending on gate
    hub.unsubscribe(sink, privAccountTopic('user-1'));     // detach removes the entry
    hub.subscribe(sink, privAccountTopic('user-1'));       // attach#2 resolves fast
    await flush();
    expect(mgr.streamedUserCount()).toBe(1);

    release('0xAbC1');                                     // attach#1 finally resolves
    await flush();
    // The stale attach must not tear down attach#2's stream.
    expect(mgr.streamedUserCount()).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.subsOfType('clearinghouseState')).toHaveLength(1);
  });

  it('stop() tears down every shard and clears demand', async () => {
    const rig = makeRig();
    rig.hub.subscribe(rig.sink('a'), privAccountTopic('user-1'));
    await flush();
    expect(rig.sockets).toHaveLength(1);
    rig.mgr.stop();
    expect(rig.sockets[0]!.closed).toBe(true);
    expect(rig.mgr.streamedUserCount()).toBe(0);
    expect(rig.mgr.shardCount()).toBe(0);
  });
});

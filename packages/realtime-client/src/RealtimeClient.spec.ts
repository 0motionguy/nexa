import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealtimeClient } from './RealtimeClient.js';
import type { Topic } from './types.js';

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((this: FakeWebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: FakeWebSocket, ev: { data: string }) => unknown) | null = null;
  onerror: ((this: FakeWebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: FakeWebSocket, ev: { code?: number; reason?: string }) => unknown) | null = null;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({} as Event);
    });
  }

  send(data: string): void { this.sent.push(data); }

  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

function topic(raw: string): Topic { return raw as Topic; }

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  sockets.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RealtimeClient', () => {
  it('uses one WS and sends sub/unsub frames for topic churn', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const client = new RealtimeClient({ baseUrl: 'http://localhost', token: 'ticket', debounceMs: 1 });
    const releaseBtc = client.acquire(topic('ticker:hl:BTC'));

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('ws://localhost/ws/markets?token=ticket');
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ op: 'sub', topics: ['ticker:hl:BTC'] });

    const releaseEth = client.acquire(topic('ticker:hl:ETH'));
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ op: 'sub', topics: ['ticker:hl:ETH'] });

    releaseEth();
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ op: 'unsub', topics: ['ticker:hl:ETH'] });

    releaseBtc();
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    client.close();
  });

  it('resolves a browser-relative API base before opening WS', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'https:', host: 'neo.aiso.tools' });

    const client = new RealtimeClient({ baseUrl: '/api', token: 'ticket', debounceMs: 1 });
    const release = client.acquire(topic('ticker:hl:BTC'));

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://neo.aiso.tools/api/ws/markets?token=ticket');

    release();
    client.close();
  });
});

describe('RealtimeStore — account/fill caching (ADR-0004 pt2)', () => {
  const accountEvent = {
    t: 'account' as const,
    topic: 'priv:u1:account' as Topic,
    ts: 1,
    lastTickAgeMs: 0,
    src: 'hl' as const,
    equityUsd: 1_250.5,
    marginUsedUsd: 300,
    withdrawableUsd: 900.5,
    accountValueUsd: 1_250.5,
    positions: [],
  };
  const fillEvent = {
    t: 'fill' as const,
    topic: 'priv:u1:fills' as Topic,
    ts: 2,
    lastTickAgeMs: 0,
    src: 'hl' as const,
    orderId: 'hl_1',
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

  it('caches account/fill and surfaces them via getAccount/getFill + get()', async () => {
    const { RealtimeStore } = await import('./store.js');
    const store = new RealtimeStore();

    store.dispatch(accountEvent);
    store.dispatch(fillEvent);

    expect(store.getAccount(accountEvent.topic)).toBe(accountEvent);
    expect(store.getFill(fillEvent.topic)).toBe(fillEvent);
    expect(store.get(accountEvent.topic)).toBe(accountEvent);
    expect(store.get(fillEvent.topic)).toBe(fillEvent);
    expect(store.snapshot().accounts.get(accountEvent.topic)).toBe(accountEvent);
    expect(store.snapshot().fills.get(fillEvent.topic)).toBe(fillEvent);
  });

  it('fans account/fill out to topic listeners', async () => {
    const { RealtimeStore } = await import('./store.js');
    const store = new RealtimeStore();
    const seen: string[] = [];
    store.subscribe(accountEvent.topic, (e) => seen.push(e.t));
    store.subscribe(fillEvent.topic, (e) => seen.push(e.t));
    store.dispatch(accountEvent);
    store.dispatch(fillEvent);
    expect(seen).toEqual(['account', 'fill']);
  });

  it('clear() empties the account/fill caches', async () => {
    const { RealtimeStore } = await import('./store.js');
    const store = new RealtimeStore();
    store.dispatch(accountEvent);
    store.dispatch(fillEvent);
    store.clear();
    expect(store.getAccount(accountEvent.topic)).toBeUndefined();
    expect(store.getFill(fillEvent.topic)).toBeUndefined();
  });

  it('suspend() parks the socket keeping intents; resume() reopens the full set', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const client = new RealtimeClient({ baseUrl: 'http://localhost', token: 'ticket', debounceMs: 1 });
    client.acquire(topic('ticker:hl:BTC'));
    client.acquire(topic('ticker:hl:ETH'));
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);

    // resume() before any suspend is a no-op — no accidental rebuild.
    client.resume();
    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(1);

    client.suspend();
    expect(client.isSuspended()).toBe(true);
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    // Intents survive the park.
    expect(client.totalSubscriptions()).toBe(2);

    // Topic churn + credential rotation while parked must not build a transport.
    client.acquire(topic('predictions:pm:123'));
    client.setToken('ticket2', { reconnectNow: true });
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);
    expect(client.totalSubscriptions()).toBe(3);

    client.resume();
    await flushMicrotasks();
    expect(client.isSuspended()).toBe(false);
    expect(sockets).toHaveLength(2);
    // Reopened with the retained topics AND the token rotated while parked.
    expect(sockets[1]!.url).toBe('ws://localhost/ws/markets?token=ticket2');
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      op: 'sub',
      topics: ['ticker:hl:BTC', 'ticker:hl:ETH', 'predictions:pm:123'],
    });
    client.close();
  });

  it('onFrame() taps every inbound event, isolates throwers, detaches cleanly', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const client = new RealtimeClient({ baseUrl: 'http://localhost', token: 'ticket', debounceMs: 1 });
    client.acquire(topic('ticker:hl:BTC'));
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    const seen: string[] = [];
    client.onFrame(() => { throw new Error('bad tap'); });
    const off = client.onFrame((event) => seen.push(`${event.topic}@${(event as { px?: number }).px}`));

    const frame = (px: number) => JSON.stringify({
      t: 'tick', topic: 'ticker:hl:BTC', ts: Date.now(), lastTickAgeMs: 0, src: 'hl', px,
    });
    sockets[0]!.onmessage?.({ data: frame(100_000) });
    // Thrower is isolated: sibling tap AND store dispatch both saw the event.
    expect(seen).toEqual(['ticker:hl:BTC@100000']);
    expect(client.getTick(topic('ticker:hl:BTC'))?.px).toBe(100_000);

    off();
    sockets[0]!.onmessage?.({ data: frame(100_001) });
    expect(seen).toHaveLength(1);
    expect(client.getTick(topic('ticker:hl:BTC'))?.px).toBe(100_001);
    client.close();
  });

  it('suspend() parks the socket keeping intents; resume() reopens the full set', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const client = new RealtimeClient({ baseUrl: 'http://localhost', token: 'ticket', debounceMs: 1 });
    client.acquire(topic('ticker:hl:BTC'));
    client.acquire(topic('ticker:hl:ETH'));
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);

    // resume() before any suspend is a no-op — no accidental rebuild.
    client.resume();
    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(1);

    client.suspend();
    expect(client.isSuspended()).toBe(true);
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    // Intents survive the park.
    expect(client.totalSubscriptions()).toBe(2);

    // Topic churn + credential rotation while parked must not build a transport.
    client.acquire(topic('predictions:pm:123'));
    client.setToken('ticket2', { reconnectNow: true });
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);
    expect(client.totalSubscriptions()).toBe(3);

    client.resume();
    await flushMicrotasks();
    expect(client.isSuspended()).toBe(false);
    expect(sockets).toHaveLength(2);
    // Reopened with the retained topics AND the token rotated while parked.
    expect(sockets[1]!.url).toBe('ws://localhost/ws/markets?token=ticket2');
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      op: 'sub',
      topics: ['ticker:hl:BTC', 'ticker:hl:ETH', 'predictions:pm:123'],
    });
    client.close();
  });

  it('onFrame() taps every inbound event, isolates throwers, detaches cleanly', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const client = new RealtimeClient({ baseUrl: 'http://localhost', token: 'ticket', debounceMs: 1 });
    client.acquire(topic('ticker:hl:BTC'));
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    const seen: string[] = [];
    client.onFrame(() => { throw new Error('bad tap'); });
    const off = client.onFrame((event) => seen.push(`${event.topic}@${(event as { px?: number }).px}`));

    const frame = (px: number) => JSON.stringify({
      t: 'tick', topic: 'ticker:hl:BTC', ts: Date.now(), lastTickAgeMs: 0, src: 'hl', px,
    });
    sockets[0]!.onmessage?.({ data: frame(100_000) });
    // Thrower is isolated: sibling tap AND store dispatch both saw the event.
    expect(seen).toEqual(['ticker:hl:BTC@100000']);
    expect(client.getTick(topic('ticker:hl:BTC'))?.px).toBe(100_000);

    off();
    sockets[0]!.onmessage?.({ data: frame(100_001) });
    expect(seen).toHaveLength(1);
    expect(client.getTick(topic('ticker:hl:BTC'))?.px).toBe(100_001);
    client.close();
  });
});

/**
 * WS-P0-2 (wave 3) — shared lifecycle bus tests.
 *
 * Proves the cross-pod fan-out contract without a real Redis: a minimal
 * in-memory fake implements the `xadd` / `xread` stream semantics the bus
 * relies on (same spirit as the ioredis mocks in `lib/rate-limit.spec.ts`).
 *
 * Covered:
 *   - publish → consume round-trip reaches a real Hub sink (Redis configured);
 *   - the dedupe LRU suppresses a replayed uuid;
 *   - Redis-absent fallback delivers through the in-process publisher;
 *   - a publish (XADD) failure never throws into the caller + is counted;
 *   - MAXLEN ~ <env> is passed through on every XADD;
 *   - a real producer emit site (InMemoryMarkets.recordLifecycleTransition)
 *     publishes to the bus — and does NOT also emit in-process — when Redis
 *     is configured.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub, type SubscriberSink } from './hub.js';
import { privOrdersTopic } from './topic.js';
import type { FeedEvent } from './types.js';
import {
  LIFECYCLE_EVENT_TYPE,
  LIFECYCLE_STREAM_KEY,
  type LifecycleBusEvent,
  type LifecycleBusRedis,
  __injectBusRedisForTests,
  __resetLifecycleBusForTests,
  publishLifecycleEvent,
  startLifecycleConsumer,
} from './lifecycle-bus.js';
import { lifecycleEventsDropped } from './metrics.js';
import { lifecyclePublisher, type LifecycleEnvelope } from '../lib/lifecycle/publisher.js';

/* ── helpers ─────────────────────────────────────────────────────────────── */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await sleep(5);
  }
}

function makeEnvelope(overrides: Partial<LifecycleEnvelope> = {}): LifecycleEnvelope {
  const baseTs = 1_700_000_000_000;
  return {
    orderId: 'b48ef452-ea9a-4d66-980a-33e8d20af3a7',
    userId: 'b48ef452-ea9b-4d66-980a-33e8d20af3a7',
    venue: 'hyperliquid',
    symbol: 'BTC',
    status: 'filled',
    sideLong: true,
    qtyUsd: 25,
    filledQtyUsd: 25,
    avgFillPriceUsd: 64_212.5,
    externalOrderId: '12345',
    demo: false,
    ts: baseTs,
    event: {
      status: 'filled',
      ts: new Date(baseTs).toISOString(),
      externalOrderId: '12345',
    },
    ...overrides,
  };
}

/**
 * In-memory fake of the Redis stream commands the bus uses. Entry ids are
 * `"1","2",…` so "after cursor C" is a plain index cut at `Number(C)`; `$`
 * snapshots the current tail (only later appends match), `'0'` reads from the
 * beginning. `xread` emulates BLOCK with a ≤10ms wait so an empty tail returns
 * null promptly and the consumer loop stays responsive to stop.
 */
function makeFakeStream(): LifecycleBusRedis & {
  xadd: ReturnType<typeof vi.fn>;
  xread: ReturnType<typeof vi.fn>;
  entries: Array<{ id: string; fields: string[] }>;
} {
  const entries: Array<{ id: string; fields: string[] }> = [];

  const xadd = vi.fn(async (...args: Array<string | number>): Promise<string | null> => {
    const starIdx = args.indexOf('*');
    const fields = args.slice(starIdx + 1).map(String);
    const id = String(entries.length + 1);
    entries.push({ id, fields });
    // Approximate MAXLEN trim (mirrors `MAXLEN ~ N`).
    const maxlenIdx = args.indexOf('MAXLEN');
    if (maxlenIdx >= 0) {
      const n = Number(args[maxlenIdx + 2]);
      if (Number.isFinite(n) && entries.length > n) entries.splice(0, entries.length - n);
    }
    return id;
  });

  const xread = vi.fn(
    async (
      ...args: Array<string | number>
    ): Promise<Array<[string, Array<[string, string[]]>]> | null> => {
      const streamsIdx = args.indexOf('STREAMS');
      const key = String(args[streamsIdx + 1]);
      const cursor = String(args[streamsIdx + 2]);
      const countIdx = args.indexOf('COUNT');
      const count = countIdx >= 0 ? Number(args[countIdx + 1]) : entries.length;
      const blockIdx = args.indexOf('BLOCK');
      const blockMs = blockIdx >= 0 ? Number(args[blockIdx + 1]) : 0;

      const startIndex = cursor === '$' ? entries.length : Number(cursor) || 0;
      const take = (): Array<[string, string[]]> =>
        entries.slice(startIndex, startIndex + count).map((e) => [e.id, e.fields]);

      let matched = take();
      if (matched.length === 0 && blockMs > 0) {
        await sleep(Math.min(blockMs, 10));
        matched = take();
      }
      return matched.length > 0 ? [[key, matched]] : null;
    },
  );

  return { xadd, xread, entries } as unknown as LifecycleBusRedis & {
    xadd: ReturnType<typeof vi.fn>;
    xread: ReturnType<typeof vi.fn>;
    entries: Array<{ id: string; fields: string[] }>;
  };
}

async function droppedCount(reason: string): Promise<number> {
  const m = await lifecycleEventsDropped.get();
  return m.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

function captureHub(userId: string): { hub: Hub; captured: FeedEvent[] } {
  const hub = new Hub();
  const captured: FeedEvent[] = [];
  const sink: SubscriberSink = { id: `sink-${userId}`, send: (e) => captured.push(e) };
  hub.subscribe(sink, privOrdersTopic(userId));
  return { hub, captured };
}

afterEach(async () => {
  __resetLifecycleBusForTests();
  lifecyclePublisher.removeAllListeners();
  // Let any parked consumer loop unwind before the next case.
  await sleep(20);
  vi.restoreAllMocks();
});

/* ── configured-Redis path ───────────────────────────────────────────────── */

describe('lifecycle-bus — Redis configured', () => {
  it('publish → stream → consumer forwards into the local hub', async () => {
    const fake = makeFakeStream();
    __injectBusRedisForTests(fake);
    const env = makeEnvelope();
    const { hub, captured } = captureHub(env.userId);

    // Publish first, then tail from the beginning — deterministic, no race on `$`.
    publishLifecycleEvent(env);
    await sleep(2); // let the fire-and-forget XADD settle
    expect(fake.entries).toHaveLength(1);

    startLifecycleConsumer(hub, { fromId: '0' });
    await waitFor(() => captured.length === 1);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.t).toBe('order');
    if (captured[0]!.t === 'order') {
      expect(captured[0]!.orderId).toBe(env.orderId);
      expect(captured[0]!.status).toBe('filled');
      expect(captured[0]!.topic).toBe(privOrdersTopic(env.userId));
    }
  });

  it('dedupes a replayed uuid — same event id delivered once', async () => {
    const fake = makeFakeStream();
    __injectBusRedisForTests(fake);
    const env = makeEnvelope();
    const { hub, captured } = captureHub(env.userId);

    // Two distinct stream entries carrying the SAME bus event id (a producer
    // retry / replay). The dedupe LRU must collapse them to one delivery.
    const busEvent: LifecycleBusEvent = {
      id: 'fixed-duplicate-id',
      userId: env.userId,
      type: LIFECYCLE_EVENT_TYPE,
      payload: env,
      at: env.ts,
    };
    const raw = JSON.stringify(busEvent);
    await fake.xadd(LIFECYCLE_STREAM_KEY, '*', 'data', raw);
    await fake.xadd(LIFECYCLE_STREAM_KEY, '*', 'data', raw);
    expect(fake.entries).toHaveLength(2);

    startLifecycleConsumer(hub, { fromId: '0' });
    await waitFor(() => captured.length >= 1);
    await sleep(20); // give the loop a chance to (not) deliver the duplicate

    expect(captured).toHaveLength(1);
    expect(await droppedCount('duplicate')).toBeGreaterThanOrEqual(1);
  });

  it('passes MAXLEN ~ <env default 10000> through on every XADD', async () => {
    const fake = makeFakeStream();
    __injectBusRedisForTests(fake);

    publishLifecycleEvent(makeEnvelope());
    await sleep(2);

    expect(fake.xadd).toHaveBeenCalledTimes(1);
    expect(fake.xadd).toHaveBeenCalledWith(
      LIFECYCLE_STREAM_KEY,
      'MAXLEN',
      '~',
      '10000',
      '*',
      'data',
      expect.any(String),
    );
  });

  it('an XADD failure never throws into the caller and is counted', async () => {
    const failing: LifecycleBusRedis = {
      xadd: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      xread: vi.fn().mockResolvedValue(null),
    };
    __injectBusRedisForTests(failing);
    const before = await droppedCount('publish_error');

    // The money mutation this rides behind must not see the rejection.
    expect(() => publishLifecycleEvent(makeEnvelope())).not.toThrow();
    await sleep(5); // let the rejected promise's catch run

    expect(await droppedCount('publish_error')).toBe(before + 1);
  });

  it('does not double-deliver: configured Redis routes to the stream, not the in-process emitter', async () => {
    const fake = makeFakeStream();
    __injectBusRedisForTests(fake);
    const inProc = vi.fn();
    lifecyclePublisher.onLifecycle(inProc);

    publishLifecycleEvent(makeEnvelope());
    await sleep(2);

    expect(fake.xadd).toHaveBeenCalledTimes(1);
    expect(inProc).not.toHaveBeenCalled();
  });
});

/* ── demo / dev fallback path ────────────────────────────────────────────── */

describe('lifecycle-bus — Redis absent (demo/dev fallback)', () => {
  it('publish falls back to the in-process publisher (unchanged single-pod behavior)', async () => {
    // No injection + vitest runs with REDIS_URL unset → getPublisherRedis()
    // returns null → in-process emit.
    __resetLifecycleBusForTests();
    const received: LifecycleEnvelope[] = [];
    const off = lifecyclePublisher.onLifecycle((e) => received.push(e));
    const env = makeEnvelope();

    publishLifecycleEvent(env);

    expect(received).toHaveLength(1);
    expect(received[0]!.orderId).toBe(env.orderId);
    off();
  });

  it('consumer falls back to the in-process bridge and still fans out to the hub', async () => {
    __resetLifecycleBusForTests();
    const env = makeEnvelope();
    const { hub, captured } = captureHub(env.userId);

    startLifecycleConsumer(hub); // no Redis → attaches the in-process bridge
    publishLifecycleEvent(env); // in-process emit → bridge → hub

    expect(captured).toHaveLength(1);
    expect(captured[0]!.t).toBe('order');
  });
});

/* ── producer regression (real emit site) ────────────────────────────────── */

describe('lifecycle-bus — producer publishes to the bus when Redis is configured', () => {
  it('InMemoryMarkets.recordLifecycleTransition XADDs to the stream', async () => {
    const { InMemoryMarkets } = await import('../store/in-memory/markets.js');
    const { seedUser } = await import('../store/core/in-memory-state.js');
    type InMemoryState = import('../store/core/in-memory-state.js').InMemoryState;

    const user = seedUser('prod@bus.test', 'Prod');
    const state = { usersById: new Map([[user.id, user]]) } as unknown as InMemoryState;
    const markets = new InMemoryMarkets(state);
    const pos = await markets.placeMarketOrder(user, {
      venue: 'hyperliquid',
      symbol: 'BTC',
      sideLong: true,
      qtyUsd: 50,
      entryPriceUsd: 60_000,
    });

    const fake = makeFakeStream();
    __injectBusRedisForTests(fake);
    const inProc = vi.fn();
    const off = lifecyclePublisher.onLifecycle(inProc);

    await markets.recordLifecycleTransition(pos.id, { status: 'filled', demo: false });
    await sleep(5);
    off();

    // Producer routed through the bus (XADD) and did NOT also emit in-process.
    expect(fake.xadd).toHaveBeenCalledTimes(1);
    expect(fake.xadd.mock.calls[0]![0]).toBe(LIFECYCLE_STREAM_KEY);
    expect(inProc).not.toHaveBeenCalled();

    // The XADD payload is a well-formed bus event for this order.
    const dataArg = fake.xadd.mock.calls[0]!.at(-1) as string;
    const parsed = JSON.parse(dataArg) as LifecycleBusEvent;
    expect(parsed.type).toBe(LIFECYCLE_EVENT_TYPE);
    expect(parsed.userId).toBe(user.id);
    expect(parsed.payload.orderId).toBe(pos.id);
    expect(parsed.payload.status).toBe('filled');
  });
});

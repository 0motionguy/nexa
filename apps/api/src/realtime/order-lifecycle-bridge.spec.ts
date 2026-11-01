/**
 * Sprint 1 lifecycle bridge — verify the publisher → hub fan-out.
 *
 * The bridge is the only consumer the Sprint 1 publisher names by file path;
 * a regression here means order status changes stop reaching NEO + MAZE in
 * realtime. Tests are run in isolation per test so we don't leak listeners
 * across cases.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Hub, type SubscriberSink } from './hub.js';
import {
  envelopeToFeedEvent,
  startOrderLifecycleBridge,
  stopOrderLifecycleBridge,
} from './order-lifecycle-bridge.js';
import { privOrdersTopic } from './topic.js';
import { lifecyclePublisher, type LifecycleEnvelope } from '../lib/lifecycle/publisher.js';
import type { FeedEvent } from './types.js';

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

describe('envelopeToFeedEvent', () => {
  it('shapes the lifecycle envelope into a wire-protocol OrderEvent', () => {
    const env = makeEnvelope();
    const event = envelopeToFeedEvent(env);
    expect(event.t).toBe('order');
    expect(event.topic).toBe(`priv:${env.userId}:orders`);
    expect(event.orderId).toBe(env.orderId);
    expect(event.marketVenue).toBe('hyperliquid');
    expect(event.status).toBe('filled');
    expect(event.qtyUsd).toBe(25);
    expect(event.filledQtyUsd).toBe(25);
    expect(event.avgFillPriceUsd).toBe(64_212.5);
    expect(event.externalOrderId).toBe('12345');
    expect(event.src).toBe('nexa');
  });

  it('preserves the publish ts and computes a non-negative lastTickAgeMs', () => {
    const env = makeEnvelope({ ts: Date.now() - 100 });
    const event = envelopeToFeedEvent(env);
    expect(event.ts).toBe(env.ts);
    expect(event.lastTickAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('nulls absent optional fields rather than dropping them from the envelope', () => {
    const env = makeEnvelope({
      filledQtyUsd: undefined,
      avgFillPriceUsd: undefined,
      externalOrderId: undefined,
      errorCode: undefined,
    });
    const event = envelopeToFeedEvent(env);
    expect(event.filledQtyUsd).toBeNull();
    expect(event.avgFillPriceUsd).toBeNull();
    expect(event.externalOrderId).toBeNull();
    expect(event.errorCode).toBeNull();
  });
});

describe('startOrderLifecycleBridge', () => {
  afterEach(() => {
    stopOrderLifecycleBridge();
    lifecyclePublisher.removeAllListeners();
  });

  it('republishes lifecycle envelopes into the hub on the priv-orders topic', () => {
    const hub = new Hub();
    startOrderLifecycleBridge(hub);

    const sink: SubscriberSink = (() => {
      const captured: FeedEvent[] = [];
      return {
        id: 'sink-test-1',
        send(event) { captured.push(event); },
        captured,
      } as unknown as SubscriberSink & { captured: FeedEvent[] };
    })();
    const captured = (sink as unknown as { captured: FeedEvent[] }).captured;

    const env = makeEnvelope();
    hub.subscribe(sink, privOrdersTopic(env.userId));
    lifecyclePublisher.publish(env);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.t).toBe('order');
    if (captured[0]!.t === 'order') {
      expect(captured[0]!.orderId).toBe(env.orderId);
      expect(captured[0]!.status).toBe('filled');
    }
  });

  it('is idempotent — calling start twice does not double-fire to subscribers', () => {
    const hub = new Hub();
    startOrderLifecycleBridge(hub);
    startOrderLifecycleBridge(hub);

    const captured: FeedEvent[] = [];
    const sink: SubscriberSink = { id: 'sink-test-2', send: (e) => captured.push(e) };
    const env = makeEnvelope();
    hub.subscribe(sink, privOrdersTopic(env.userId));
    lifecyclePublisher.publish(env);
    expect(captured).toHaveLength(1);
  });

  it('only emits to the matching user\'s topic — cross-user isolation', () => {
    const hub = new Hub();
    startOrderLifecycleBridge(hub);

    const userAEvents: FeedEvent[] = [];
    const userBEvents: FeedEvent[] = [];
    const sinkA: SubscriberSink = { id: 'sink-A', send: (e) => userAEvents.push(e) };
    const sinkB: SubscriberSink = { id: 'sink-B', send: (e) => userBEvents.push(e) };
    const userAId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const userBId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    hub.subscribe(sinkA, privOrdersTopic(userAId));
    hub.subscribe(sinkB, privOrdersTopic(userBId));

    // User A places an order — only sinkA should see it.
    lifecyclePublisher.publish(makeEnvelope({ userId: userAId, orderId: 'order-A' }));
    expect(userAEvents).toHaveLength(1);
    expect(userBEvents).toHaveLength(0);

    // User B's turn — sinkA is left alone.
    lifecyclePublisher.publish(makeEnvelope({ userId: userBId, orderId: 'order-B' }));
    expect(userAEvents).toHaveLength(1);
    expect(userBEvents).toHaveLength(1);
  });
});

describe('privOrdersTopic + parsePrivKindTopic', () => {
  it('round-trips a userId through builder + parser', async () => {
    const { parsePrivKindTopic } = await import('./topic.js');
    const userId = 'b48ef452-ea9a-4d66-980a-33e8d20af3a7';
    const topic = privOrdersTopic(userId);
    expect(topic).toBe(`priv:${userId}:orders`);
    const parsed = parsePrivKindTopic(topic as unknown as string);
    expect(parsed).toEqual({ userId, kind: 'orders' });
  });

  it('rejects unknown priv kinds', async () => {
    const { parsePrivKindTopic } = await import('./topic.js');
    expect(parsePrivKindTopic('priv:user-1:bogus')).toBeNull();
  });

  it('accepts the ADR-0004 user-stream kinds via their builders', async () => {
    const { parsePrivKindTopic, privAccountTopic, privFillsTopic } = await import('./topic.js');
    const userId = 'b48ef452-ea9a-4d66-980a-33e8d20af3a7';
    expect(parsePrivKindTopic(privAccountTopic(userId) as unknown as string))
      .toEqual({ userId, kind: 'account' });
    expect(parsePrivKindTopic(privFillsTopic(userId) as unknown as string))
      .toEqual({ userId, kind: 'fills' });
  });

  it('rejects malformed priv topics', async () => {
    const { parsePrivKindTopic } = await import('./topic.js');
    expect(parsePrivKindTopic('not-a-priv-topic')).toBeNull();
    expect(parsePrivKindTopic('priv::orders')).toBeNull(); // empty userId
  });
});

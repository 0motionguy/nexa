/**
 * Order lifecycle → realtime hub bridge.
 *
 * Subscribes to the in-process `lifecyclePublisher`
 * (`apps/api/src/lib/lifecycle/publisher.ts`) and fans every envelope out
 * to the realtime hub on the priv-namespaced topic
 * `priv:<userId>:orders`. NEO Order History (and any future Order Detail
 * Sheet live updates) consume this via `useOrderUpdates(userId)` in the
 * `@nexa/realtime-client/react` package.
 *
 * Why not a `RealtimeAdapter`?
 * - The `RealtimeAdapter` contract is for venue WebSockets the hub
 *   reference-counts. Lifecycle events are fed by an EventEmitter, not a
 *   subscribable upstream — there's no "open upstream socket on first
 *   subscribe / close on last" semantics. Calling `adapter.subscribe(topic)`
 *   for a priv topic would be a no-op anyway because the hub already skips
 *   the adapter call for priv topics (see `hub.subscribe`).
 * - This bridge starts once per pod, listens forever, and publishes to
 *   whatever priv topic a subscriber happens to be on. Cheap; zero impact
 *   on the existing adapter lifecycle.
 *
 * ACL is enforced at the transport layer (`ws-server.ts` and `router.ts`
 * SSE handler both check `parsePrivTopic(topic).userId === sessionUserId`).
 * The bridge itself emits to the correct user's topic — it doesn't gate.
 */

import { lifecyclePublisher, type LifecycleEnvelope } from '../lib/lifecycle/publisher.js';
import { log } from '../lib/log.js';
import type { Hub } from './hub.js';
import type { OrderEvent, Topic } from './types.js';

let unsubscribe: (() => void) | null = null;

/**
 * Idempotent. Attaches a single listener to the lifecycle publisher and
 * republishes each envelope into the hub. Call once at hub start; calling
 * again before `stopOrderLifecycleBridge` is a no-op.
 */
export function startOrderLifecycleBridge(hub: Hub): void {
  if (unsubscribe) return;
  unsubscribe = lifecyclePublisher.onLifecycle((envelope) => {
    try {
      const event = envelopeToFeedEvent(envelope);
      hub.publish(event);
    } catch (err) {
      // Never let a hub-side failure break the order write path; the
      // publisher already swallows listener throws but be defensive.
      log.warn(
        { err: err instanceof Error ? err.message : String(err), orderId: envelope.orderId },
        'order-lifecycle-bridge: hub publish failed',
      );
    }
  });
  log.debug('order-lifecycle-bridge: attached');
}

/** Idempotent teardown. Used by tests + graceful shutdown hooks. */
export function stopOrderLifecycleBridge(): void {
  if (!unsubscribe) return;
  unsubscribe();
  unsubscribe = null;
}

/**
 * Shape the in-process lifecycle envelope into the wire-protocol `OrderEvent`
 * the realtime hub fans out. Exported for tests that need to verify the
 * exact wire payload without spinning up the publisher.
 */
export function envelopeToFeedEvent(envelope: LifecycleEnvelope): OrderEvent {
  const topic = `priv:${envelope.userId}:orders` as Topic;
  const now = Date.now();
  return {
    t: 'order',
    topic,
    ts: envelope.ts,
    lastTickAgeMs: Math.max(0, now - envelope.ts),
    src: 'nexa',
    orderId: envelope.orderId,
    marketVenue: envelope.venue,
    symbol: envelope.symbol,
    status: envelope.status,
    sideLong: envelope.sideLong,
    qtyUsd: envelope.qtyUsd,
    filledQtyUsd: envelope.filledQtyUsd ?? null,
    avgFillPriceUsd: envelope.avgFillPriceUsd ?? null,
    externalOrderId: envelope.externalOrderId ?? null,
    errorCode: envelope.errorCode ?? null,
  };
}

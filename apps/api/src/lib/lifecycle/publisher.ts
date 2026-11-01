/**
 * Sprint 1 — in-process market lifecycle publisher.
 *
 * Sits between the store's `recordLifecycleTransition` and any future
 * realtime fan-out. Backed by a plain Node EventEmitter so:
 *
 *   - The store layer is decoupled from the realtime hub. Lifecycle events
 *     emit even if no subscriber exists, so we don't depend on the parallel-
 *     session realtime work being wired before this ships.
 *   - The realtime hub (or any other consumer) subscribes via `onLifecycle`
 *     and fans out to its own topics (`priv:<userId>:order:<orderId>` once
 *     the hub registers the new topic kind).
 *   - Tests can spy on emissions without spinning up the hub.
 *
 * The event payload matches the WSS lifecycle contract documented in the
 * Sprint plan — every consumer (NEO terminal, MAZE activity card) reads the
 * same shape regardless of transport.
 */

import { EventEmitter } from 'node:events';
import type { LifecycleEvent, MarketOrderStatus, MarketPosition, MarketVenue } from '../../store/types.js';
import { log } from '../log.js';

/**
 * Wire payload — what every consumer of a lifecycle event sees. Mirrors the
 * Sprint plan's "WSS lifecycle events" contract. Stays narrow on purpose; the
 * Order Detail Sheet reads the full lifecycleEvents[] from REST, not WSS.
 */
export interface LifecycleEnvelope {
  /** Internal `nbMarketPositions.id`. */
  orderId: string;
  /** Authenticated user this event belongs to. */
  userId: string;
  /** Venue tag — same union as `MarketVenue`. */
  venue: MarketVenue;
  /** Market symbol (HL coin, polymarket "marketId:outcome", jupiter "USDC→SOL"). */
  symbol: string;
  /** New status from the transition. */
  status: MarketOrderStatus;
  /** Side — long for buy/positive-delta, short for sell/negative. */
  sideLong: boolean;
  /** USD notional of the original intent. */
  qtyUsd: number;
  /** Filled USD notional so far (cumulative). */
  filledQtyUsd?: number;
  /** Volume-weighted average fill price. */
  avgFillPriceUsd?: number;
  /** Venue-assigned order id (HL oid, PM id, Jupiter tx hash). */
  externalOrderId?: string;
  /** True when this was a demo / paper path (no live venue call). */
  demo: boolean;
  /** Error code on failed / rejected transitions. */
  errorCode?: string;
  /** ms since epoch — fan-out consumers may need to coalesce by time. */
  ts: number;
  /** The single audit entry that was just appended (carries providerPayload). */
  event: LifecycleEvent;
}

export type LifecycleListener = (envelope: LifecycleEnvelope) => void;

const EVENT_NAME = 'lifecycle';

class LifecyclePublisher {
  private readonly bus = new EventEmitter();

  constructor() {
    // Raise the listener cap a little — the realtime hub will subscribe once,
    // plus the activity-ledger writer (Sprint 3), plus a few test listeners.
    this.bus.setMaxListeners(64);
  }

  /**
   * Subscribe to every lifecycle envelope. Returns an unsubscribe function.
   * Listeners should be cheap — push the envelope to a queue / topic, don't
   * do REST work synchronously.
   */
  onLifecycle(listener: LifecycleListener): () => void {
    this.bus.on(EVENT_NAME, listener);
    return () => {
      this.bus.off(EVENT_NAME, listener);
    };
  }

  /**
   * Called by `recordLifecycleTransition` after the row is updated.
   *
   * `demo` is inferred from the venue-side write path; passing it through here
   * keeps the store free of demo-mode knowledge.
   */
  publish(envelope: LifecycleEnvelope): void {
    try {
      this.bus.emit(EVENT_NAME, envelope);
    } catch (e) {
      // Never let a listener crash break the order write path.
      log.warn(
        { err: e instanceof Error ? e.message : String(e), orderId: envelope.orderId, status: envelope.status },
        'lifecycle: listener threw',
      );
    }
  }

  /** Test-only: wipe all listeners. */
  removeAllListeners(): void {
    this.bus.removeAllListeners(EVENT_NAME);
  }

  /** For diagnostics — how many subscribers are attached. */
  listenerCount(): number {
    return this.bus.listenerCount(EVENT_NAME);
  }
}

/**
 * Process-wide singleton. The store calls `publish`; consumers (realtime hub
 * adapter, activity ledger writer, tests) call `onLifecycle`.
 */
export const lifecyclePublisher = new LifecyclePublisher();

/**
 * Build a {@link LifecycleEnvelope} from a freshly-updated MarketPosition + the
 * specific event that was appended. Centralized here so every transition emits
 * the same wire shape.
 */
export function envelopeFromPosition(
  position: MarketPosition,
  event: LifecycleEvent,
  demo: boolean,
): LifecycleEnvelope {
  return {
    orderId: position.id,
    userId: position.userId,
    venue: position.venue,
    symbol: position.symbol,
    status: event.status,
    sideLong: position.sideLong,
    qtyUsd: position.qtyUsd,
    filledQtyUsd: position.filledQtyUsd ?? undefined,
    avgFillPriceUsd: position.avgFillPriceUsd ?? undefined,
    externalOrderId: event.externalOrderId ?? position.externalRef ?? undefined,
    demo,
    errorCode: event.errorCode ?? undefined,
    ts: Date.parse(event.ts),
    event,
  };
}

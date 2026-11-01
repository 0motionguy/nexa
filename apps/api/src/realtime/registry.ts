/**
 * Per-pod realtime hub singleton + venue wiring.
 *
 * One `Hub` per process, lazily constructed on first access. Venues register
 * before `start()` is called the first time. Idle pods (no client connected
 * the hub) still register venues — adapters start their internal state
 * machines but do NOT eagerly open upstream sockets. The first client
 * subscribe triggers `adapter.subscribe(topic)` which is what actually opens
 * the upstream WS (see each venue's `ensureOpen` / equivalent).
 *
 * Future venues (`pyth-hermes`, `helius-sol`, `jupiter` snapshot helper) plug
 * in here in the order their files land — keep this file as the only place
 * the hub learns about a new venue.
 */

import { Hub } from './hub.js';
import { startLifecycleConsumer, stopLifecycleConsumer } from './lifecycle-bus.js';
import { HeliusSolRealtimeAdapter } from './venues/helius-sol.js';
import { HlUserStreamManager } from './venues/hyperliquid-user.js';
import { HyperliquidRealtimeAdapter } from './venues/hyperliquid.js';
import { PolymarketRealtimeAdapter } from './venues/polymarket.js';
import { PythHermesRealtimeAdapter } from './venues/pyth-hermes.js';
import { TradingViewRealtimeAdapter } from './venues/tradingview.js';
import { env } from '../lib/env.js';

let cached: Hub | null = null;
let started = false;
let userStreams: HlUserStreamManager | null = null;

/**
 * Returns the per-pod hub. First call constructs + registers venues; later
 * calls return the same instance. Does NOT call `hub.start()` — call
 * `ensureStarted()` for that.
 *
 * Venue order is the priority order the SDK / health summarizer iterates
 * in; HL + PM are the highest-traffic upstreams, Pyth is the equity + SOL
 * blue-chip backbone, Helius covers long-tail memes via on-chain pool reads.
 */
export function getHub(): Hub {
  if (cached) return cached;
  const hub = new Hub({
    // Dead-sink cleanup: a sink whose `send` throws (closed socket, GC'd
    // EventSource, etc.) gets evicted on the next publish. Without this,
    // the hub keeps iterating dead sinks forever, leaking topic
    // subscriptions + CPU per upstream tick. The router's `onAbort` would
    // normally clean up, but on some edge-case browser disconnects it
    // never fires — this is the safety net.
    onSendError: (sinkId) => {
      const sinkRecord = hub.findSinkById(sinkId);
      if (sinkRecord) hub.unsubscribeAll(sinkRecord);
    },
  });
  hub.register(new HyperliquidRealtimeAdapter());
  hub.register(new PolymarketRealtimeAdapter());
  hub.register(new PythHermesRealtimeAdapter());
  hub.register(new HeliusSolRealtimeAdapter());
  hub.register(new TradingViewRealtimeAdapter());
  // ADR-0004 part 2 — per-user webData2/userFills streaming. With the flag
  // off (default) the priv kinds `account`/`fills` remain valid-but-silent
  // topics, exactly like `orders` with no lifecycle traffic.
  if (env.HL_USER_STREAMS) {
    userStreams = new HlUserStreamManager();
    hub.registerPrivHook('account', userStreams.hookFor('account'));
    hub.registerPrivHook('fills', userStreams.hookFor('fills'));
  }
  cached = hub;
  return hub;
}

/**
 * Idempotent. Calls `hub.start()` on first invocation so adapters can wire
 * their internal state machines (breaker + reconnect timer scaffolding).
 * Upstream sockets remain closed until a client subscribes — see each
 * adapter's lazy open path.
 */
export async function ensureStarted(): Promise<Hub> {
  const hub = getHub();
  if (started) return hub;
  started = true;
  await hub.start();
  // WS-P0-2 (wave 3) — attach this pod's lifecycle consumer so order/fill
  // transitions fan out as `priv:<userId>:orders` events. With Redis it tails
  // the shared `nb:lifecycle:events` stream (cross-pod); without Redis it
  // falls back to the in-process bridge (unchanged single-pod behavior).
  startLifecycleConsumer(hub);
  userStreams?.start(hub);
  return hub;
}

/** Shut down the hub. Used by tests + graceful shutdown hooks in `index.ts`. */
export async function shutdown(): Promise<void> {
  if (!cached) return;
  const hub = cached;
  cached = null;
  started = false;
  stopLifecycleConsumer();
  userStreams?.stop();
  userStreams = null;
  await hub.stop();
}

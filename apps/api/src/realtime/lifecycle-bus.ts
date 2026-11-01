/**
 * WS-P0-2 (wave 3) — shared lifecycle event bus.
 *
 * ## The problem this closes
 *
 * Private order/fill/account lifecycle events were emitted through the
 * in-process `lifecyclePublisher` (`lib/lifecycle/publisher.ts`, a Node
 * EventEmitter) into the *current pod's* realtime hub via
 * `order-lifecycle-bridge`. That only fans out to sockets on the same
 * process. With >1 API replica (or a worker mutating an order) a user
 * connected to pod B never receives the event for an order mutated on pod A.
 *
 * ## The fix
 *
 * Producers publish every lifecycle envelope to a Redis stream
 * (`nb:lifecycle:events`). Each pod runs a tail consumer that reads new
 * entries and forwards them into its *own* local hub — so every pod delivers
 * to its own sockets. The stream is the cross-pod carrier; the hub stays the
 * per-pod fan-out.
 *
 * ## Fallback / fail-closed posture (wave-2 aligned)
 *
 *   - **Redis unconfigured (demo/dev):** `publishLifecycleEvent` falls back to
 *     the direct in-process emit (`lifecyclePublisher.publish`) and
 *     `startLifecycleConsumer` attaches the old in-process bridge. Single-pod,
 *     so there is no cross-pod gap — behavior is byte-for-byte unchanged.
 *   - **Redis configured:** ALL delivery rides the stream. We do NOT also emit
 *     in-process (the local hub is fed by the tail consumer), so there is no
 *     double-delivery — the old emit path is *replaced* by the bus, not
 *     duplicated.
 *   - **A Redis publish failure must never fail the money mutation.** XADD is
 *     fire-and-forget: a rejection is logged + counted (`dropped_total`), never
 *     thrown into the caller. REST remains reconciliation truth.
 *
 * Delivery guarantee is at-least-once into local hubs; a small per-consumer
 * dedupe LRU (keyed on the event uuid) suppresses a replayed entry. No
 * stronger guarantee is claimed.
 */

import { randomUUID } from 'node:crypto';
import { env, features } from '../lib/env.js';
import { log } from '../lib/log.js';
import { makeRedis, type RedisClient } from '../lib/redis.js';
import { lifecyclePublisher, type LifecycleEnvelope } from '../lib/lifecycle/publisher.js';
import {
  envelopeToFeedEvent,
  startOrderLifecycleBridge,
  stopOrderLifecycleBridge,
} from './order-lifecycle-bridge.js';
import type { Hub } from './hub.js';
import {
  lifecycleConsumerLagSeconds,
  lifecycleEventsConsumed,
  lifecycleEventsDropped,
  lifecycleEventsPublished,
} from './metrics.js';

/** Redis stream key every producer XADDs onto. */
export const LIFECYCLE_STREAM_KEY = 'nb:lifecycle:events';

/**
 * Discriminant for the only lifecycle payload kind today (order/position
 * transitions — the envelope also carries transfer/account context via its
 * venue + status). Future private kinds can ride the same stream under a new
 * `type` without a schema change; the consumer skips unknown types.
 */
export const LIFECYCLE_EVENT_TYPE = 'lifecycle';

/**
 * The stream envelope — JSON-serialized into the single `data` field of each
 * XADD entry. `payload` is the in-process {@link LifecycleEnvelope}, so the
 * consumer can reuse `envelopeToFeedEvent` unchanged.
 */
export interface LifecycleBusEvent {
  /** Dedupe key — a fresh uuid per publish. */
  id: string;
  /** Owning user (mirrors payload.userId; hoisted for cheap routing/filtering). */
  userId: string;
  /** Payload discriminant — {@link LIFECYCLE_EVENT_TYPE}. */
  type: string;
  /** The in-process lifecycle envelope. */
  payload: LifecycleEnvelope;
  /** ms-since-epoch the event was produced (mirrors payload.ts) — lag source. */
  at: number;
}

/**
 * Minimal structural contract the bus needs from a Redis client. ioredis'
 * `Redis` satisfies this (cast once at the boundary); test fakes implement it
 * directly with in-memory arrays.
 */
export interface LifecycleBusRedis {
  xadd(...args: Array<string | number>): Promise<string | null>;
  xread(
    ...args: Array<string | number>
  ): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

/* ── tunables ────────────────────────────────────────────────────────────── */

/** XREAD BLOCK window (ms). The loop wakes at least this often to re-check `running`. */
const BLOCK_MS = 5_000;
/** Max entries pulled per XREAD. */
const READ_COUNT = 256;
/** Backoff after a failed XREAD before retrying, so a dead Redis doesn't hot-loop. */
const READ_RETRY_MS = 1_000;
/** Per-consumer dedupe window — suppresses a replayed uuid. */
const DEDUPE_MAX = 4_096;

/* ── dedupe (small FIFO LRU) ─────────────────────────────────────────────── */

interface DedupeLru {
  has(id: string): boolean;
  add(id: string): void;
}

/**
 * Insertion-ordered dedupe set capped at {@link DEDUPE_MAX}. A duplicate is
 * dropped *before* it would be re-added, so plain FIFO eviction of the oldest
 * id is the correct policy for a stream tail (no refresh-on-hit needed).
 */
function makeDedupe(): DedupeLru {
  const seen = new Set<string>();
  return {
    has: (id) => seen.has(id),
    add: (id) => {
      seen.add(id);
      if (seen.size > DEDUPE_MAX) {
        const oldest = seen.values().next().value as string | undefined;
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
  };
}

/* ── Redis resolution (with a test seam) ─────────────────────────────────── */

/** Test seam — when set, both publisher + consumer use this instead of ioredis. */
let injectedRedis: LifecycleBusRedis | null = null;

/** Lazily-resolved publisher connection (shared across XADDs). */
let publisherRedis: LifecycleBusRedis | null = null;
let publisherResolved = false;

function busConfigured(): boolean {
  return features.redis && Boolean(env.REDIS_URL);
}

function getPublisherRedis(): LifecycleBusRedis | null {
  if (injectedRedis) return injectedRedis;
  if (publisherResolved) return publisherRedis;
  publisherResolved = true;
  if (!busConfigured()) return null;
  const client = makeRedis(env.REDIS_URL);
  publisherRedis = client ? asBusRedis(client) : null;
  return publisherRedis;
}

/**
 * A *dedicated* connection for the consumer's blocking XREAD (a client parked
 * in XREAD BLOCK can't serve other commands, so it must not share the
 * publisher socket). Injected fake short-circuits both roles onto one object.
 */
function makeConsumerRedis(): LifecycleBusRedis | null {
  if (injectedRedis) return injectedRedis;
  if (!busConfigured()) return null;
  const client = makeRedis(env.REDIS_URL);
  return client ? asBusRedis(client) : null;
}

/** Single structural-cast boundary: ioredis' rich `xadd`/`xread` overloads → the minimal contract. */
function asBusRedis(client: RedisClient): LifecycleBusRedis {
  return client as unknown as LifecycleBusRedis;
}

/* ── publish (producer-facing) ───────────────────────────────────────────── */

/**
 * Publish one lifecycle envelope. Every producer (store mutation path used by
 * API routes AND workers) calls this instead of `lifecyclePublisher.publish`.
 *
 *   - Redis unconfigured → in-process emit (unchanged single-pod behavior).
 *   - Redis configured   → XADD to the shared stream (MAXLEN ~ env). No
 *     in-process emit (the local hub is fed by the tail consumer).
 *
 * Never throws into the caller: a publish failure is logged + counted so the
 * money mutation it rides behind is never blocked by a degraded Redis.
 */
export function publishLifecycleEvent(envelope: LifecycleEnvelope): void {
  const redis = getPublisherRedis();
  if (!redis) {
    // Demo / dev — no cross-pod gap to close; keep the pre-bus emit path.
    lifecyclePublisher.publish(envelope);
    return;
  }

  const busEvent: LifecycleBusEvent = {
    id: randomUUID(),
    userId: envelope.userId,
    type: LIFECYCLE_EVENT_TYPE,
    payload: envelope,
    at: envelope.ts,
  };

  let data: string;
  try {
    data = JSON.stringify(busEvent);
  } catch (err) {
    lifecycleEventsDropped.inc({ reason: 'serialize_error' });
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orderId: envelope.orderId },
      'lifecycle-bus: serialize failed',
    );
    return;
  }

  // Fire-and-forget XADD with an approximate MAXLEN trim. A rejection must not
  // surface into the money mutation — swallow + count.
  void Promise.resolve(
    redis.xadd(
      LIFECYCLE_STREAM_KEY,
      'MAXLEN',
      '~',
      String(env.LIFECYCLE_STREAM_MAXLEN),
      '*',
      'data',
      data,
    ),
  )
    .then(() => {
      lifecycleEventsPublished.inc();
    })
    .catch((err: unknown) => {
      lifecycleEventsDropped.inc({ reason: 'publish_error' });
      log.warn(
        { err: err instanceof Error ? err.message : String(err), orderId: envelope.orderId },
        'lifecycle-bus: XADD failed (money mutation unaffected; REST remains truth)',
      );
    });
}

/* ── consume (per-pod tail) ──────────────────────────────────────────────── */

interface ConsumerState {
  running: boolean;
  /** null in the in-process fallback path (no Redis). */
  redis: LifecycleBusRedis | null;
  dedupe: DedupeLru;
  /** true when we created the connection and must close it on stop. */
  ownsRedis: boolean;
}

let consumer: ConsumerState | null = null;

export interface StartConsumerOptions {
  /**
   * Stream id to begin tailing from. Default `$` — only events added after
   * boot, the correct per-pod tail (avoids replaying stream history into every
   * reconnecting pod). Tests pass `'0'` to read from the beginning
   * deterministically.
   */
  fromId?: string;
}

/**
 * Start this pod's lifecycle consumer. Idempotent — a second call before
 * {@link stopLifecycleConsumer} is a no-op. Replaces the old direct
 * `startOrderLifecycleBridge(hub)` call in `registry.ts`.
 *
 *   - Redis unconfigured → attach the in-process bridge (unchanged behavior).
 *   - Redis configured   → tail `nb:lifecycle:events`, dedupe, forward into
 *     the local hub exactly like the old emitter did.
 */
export function startLifecycleConsumer(hub: Hub, opts: StartConsumerOptions = {}): void {
  if (consumer) return;
  const redis = makeConsumerRedis();
  if (!redis) {
    startOrderLifecycleBridge(hub);
    consumer = { running: true, redis: null, dedupe: makeDedupe(), ownsRedis: false };
    log.debug('lifecycle-bus: consumer using in-process bridge (Redis unconfigured)');
    return;
  }
  const state: ConsumerState = {
    running: true,
    redis,
    dedupe: makeDedupe(),
    ownsRedis: injectedRedis === null,
  };
  consumer = state;
  void runConsumerLoop(hub, state, opts.fromId ?? '$');
  log.debug('lifecycle-bus: consumer tailing Redis stream');
}

/** Idempotent teardown. Used by tests + graceful shutdown (registry.shutdown). */
export function stopLifecycleConsumer(): void {
  if (!consumer) return;
  const state = consumer;
  consumer = null;
  state.running = false;
  if (state.redis === null) {
    stopOrderLifecycleBridge();
    return;
  }
  if (state.ownsRedis && state.redis !== injectedRedis) {
    try {
      state.redis.disconnect?.();
    } catch {
      /* best-effort */
    }
  }
}

async function runConsumerLoop(hub: Hub, state: ConsumerState, fromId: string): Promise<void> {
  const redis = state.redis;
  if (!redis) return;
  let cursor = fromId;
  while (state.running) {
    let res: Array<[string, Array<[string, string[]]>]> | null;
    try {
      res = await redis.xread(
        'BLOCK',
        BLOCK_MS,
        'COUNT',
        READ_COUNT,
        'STREAMS',
        LIFECYCLE_STREAM_KEY,
        cursor,
      );
    } catch (err) {
      if (!state.running) break;
      lifecycleEventsDropped.inc({ reason: 'read_error' });
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'lifecycle-bus: XREAD failed; retrying',
      );
      await sleep(READ_RETRY_MS);
      continue;
    }
    if (!res) continue; // BLOCK timed out — no new entries
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        cursor = id;
        forwardEntry(hub, fields, state.dedupe);
      }
    }
  }
}

/**
 * Decode one stream entry and forward it into the local hub. Exported for a
 * focused dedupe/forward unit test; the loop calls it per entry.
 */
export function forwardEntry(hub: Hub, fields: string[], dedupe: DedupeLru): void {
  const raw = readDataField(fields);
  if (raw === null) {
    lifecycleEventsDropped.inc({ reason: 'malformed' });
    return;
  }
  let evt: LifecycleBusEvent;
  try {
    evt = JSON.parse(raw) as LifecycleBusEvent;
  } catch {
    lifecycleEventsDropped.inc({ reason: 'malformed' });
    return;
  }
  if (!evt || evt.type !== LIFECYCLE_EVENT_TYPE || !evt.payload) {
    lifecycleEventsDropped.inc({ reason: 'unknown_type' });
    return;
  }
  if (dedupe.has(evt.id)) {
    lifecycleEventsDropped.inc({ reason: 'duplicate' });
    return;
  }
  dedupe.add(evt.id);
  try {
    hub.publish(envelopeToFeedEvent(evt.payload));
    lifecycleEventsConsumed.inc();
    lifecycleConsumerLagSeconds.set(Math.max(0, (Date.now() - evt.at) / 1000));
  } catch (err) {
    lifecycleEventsDropped.inc({ reason: 'forward_error' });
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orderId: evt.payload?.orderId },
      'lifecycle-bus: hub publish failed',
    );
  }
}

/** Redis stream entry fields are a flat `[k, v, k, v, ...]` array — pull `data`. */
function readDataField(fields: string[]): string | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === 'data') return fields[i + 1] ?? null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── test seams ──────────────────────────────────────────────────────────── */

/** Test-only: inject a fake Redis for both publisher + consumer roles. */
export function __injectBusRedisForTests(client: LifecycleBusRedis | null): void {
  injectedRedis = client;
  publisherResolved = false;
  publisherRedis = null;
}

/** Test-only: expose the dedupe factory so a forward test can supply its own window. */
export function __makeDedupeForTests(): DedupeLru {
  return makeDedupe();
}

/** Test-only: full reset between cases (clears injection, consumer, publisher singleton). */
export function __resetLifecycleBusForTests(): void {
  stopLifecycleConsumer();
  injectedRedis = null;
  publisherResolved = false;
  publisherRedis = null;
}

/**
 * Central realtime hub. Sits between venue adapters (upstream) and connected
 * clients (downstream).
 *
 *   ┌────────────┐  publish      ┌─────┐  fan-out   ┌──────────────┐
 *   │ Adapter A  │ ────────────▶ │ Hub │ ────────▶ │ Clients (N)  │
 *   │ Adapter B  │ ────────────▶ │     │           └──────────────┘
 *   └────────────┘               └─────┘
 *
 * Responsibilities:
 *   1. Per-topic ref-count: clients sub/unsub; the hub calls
 *      `adapter.subscribe(topic)` on 0→1 transitions and `unsubscribe` on
 *      1→0 transitions. One upstream subscription per topic per pod.
 *   2. Per-topic last-known cache: every event is stored as `lastByTopic`
 *      so a newly-connected client gets immediate seed without waiting for
 *      the next upstream tick.
 *   3. Coalesce ticker bursts: ticker events flow through a `Coalescer`
 *      (last-write-wins per 100ms by default). Candles/books/trades skip
 *      coalesce — they're already lower frequency or shape-critical.
 *   4. Fan-out to subscribed clients: each client owns a `SubscriberSink`
 *      and the hub iterates `subsByTopic.get(topic)` on each emit.
 *   5. Adapter registry: known venue tag → adapter instance. New venues
 *      register before `start()`.
 *
 * NOT responsible for: auth, JWT validation, WS framing, SSE encoding —
 * those live in `router.ts`. The hub speaks pure FeedEvent objects.
 */

import { Coalescer } from './backpressure.js';
import type { FeedEvent, RealtimeAdapter, Topic, VenueTag } from './types.js';
import { parse, parsePrivKindTopic, type PrivTopicKind } from './topic.js';

/**
 * Demand signal for priv-namespaced topics. Priv topics skip the venue
 * adapter path (there is no public-grammar venue to route to), so upstream
 * producers that need per-user subscriptions — e.g. the Hyperliquid
 * webData2/userFills manager — register a hook per kind and get told when a
 * user's topic gains its first subscriber / loses its last one. Hooks must
 * not throw; the hub treats them as fire-and-forget.
 */
export interface PrivSubscriptionHook {
  onFirstSubscriber(userId: string): void;
  onLastUnsubscribe(userId: string): void;
}

/** What a connected client looks like from the hub's point of view. */
export interface SubscriberSink {
  /** Stable identifier for logging / metrics. */
  readonly id: string;
  /**
   * Called for every event on a topic this sink is subscribed to. Must not
   * throw — the hub catches and increments a drop counter if it does.
   */
  send(event: FeedEvent): void;
}

export interface HubOptions {
  /** Coalesce ticker events to this cadence. Default 100ms. */
  tickerCoalesceMs?: number;
  /** Time source for tests. */
  now?: () => number;
  /** Called when a sink.send() throws — useful for dead-socket cleanup. */
  onSendError?: (sinkId: string, err: unknown) => void;
}

export class Hub {
  private readonly adapters = new Map<VenueTag, RealtimeAdapter>();
  /** topic → set of sinks subscribed to it. */
  private readonly subsByTopic = new Map<Topic, Set<SubscriberSink>>();
  /** topic → ref count (= subsByTopic.get(topic)?.size, kept for clarity). */
  private readonly refCount = new Map<Topic, number>();
  /** topic → last event (for snapshot-on-connect). */
  private readonly lastByTopic = new Map<Topic, FeedEvent>();
  /** Live-event revision captured when a cold snapshot starts. */
  private readonly liveRevisionByTopic = new Map<Topic, number>();
  /** Unique generation for the current first-to-last subscriber lifetime. */
  private readonly snapshotGenerationByTopic = new Map<Topic, number>();
  private nextSnapshotGeneration = 0;
  /** Coalescer for `ticker:*` topics only. */
  private readonly tickerCoalesce: Coalescer;
  /** priv-topic kind → demand hook (see `PrivSubscriptionHook`). */
  private readonly privHooks = new Map<PrivTopicKind, PrivSubscriptionHook>();
  private readonly opts: Required<HubOptions>;
  private started = false;

  constructor(options: HubOptions = {}) {
    this.opts = {
      tickerCoalesceMs: options.tickerCoalesceMs ?? 100,
      now: options.now ?? (() => Date.now()),
      onSendError: options.onSendError ?? (() => {}),
    };
    this.tickerCoalesce = new Coalescer({
      windowMs: this.opts.tickerCoalesceMs,
      onFlush: (topic, event) => this.deliverNow(topic, event),
    });
  }

  /* ── adapter registry ──────────────────────────────────────────────────── */

  register(adapter: RealtimeAdapter): void {
    if (this.adapters.has(adapter.venue)) {
      throw new Error(`Hub.register: venue "${adapter.venue}" already registered`);
    }
    this.adapters.set(adapter.venue, adapter);
  }

  getAdapter(venue: VenueTag): RealtimeAdapter | undefined {
    return this.adapters.get(venue);
  }

  /**
   * Register the demand hook for one priv-topic kind. One hook per kind —
   * a second registration for the same kind throws (mirrors `register`).
   */
  registerPrivHook(kind: PrivTopicKind, hook: PrivSubscriptionHook): void {
    if (this.privHooks.has(kind)) {
      throw new Error(`Hub.registerPrivHook: kind "${kind}" already registered`);
    }
    this.privHooks.set(kind, hook);
  }

  listAdapters(): readonly RealtimeAdapter[] {
    return [...this.adapters.values()];
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await Promise.all([...this.adapters.values()].map((a) => a.start(this)));
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.tickerCoalesce.dispose();
    await Promise.all([...this.adapters.values()].map((a) => a.stop()));
    this.subsByTopic.clear();
    this.refCount.clear();
    this.lastByTopic.clear();
    this.liveRevisionByTopic.clear();
    this.snapshotGenerationByTopic.clear();
  }

  /* ── subscribe/unsubscribe (client-facing) ──────────────────────────────── */

  /**
   * Add `sink` as a subscriber to `topic`. Idempotent per (sink, topic).
   * Triggers `adapter.subscribe(topic)` on the 0→1 ref-count transition.
   * Returns the last-known event for the topic if one is cached, so the
   * caller can seed the client with `sink.send(snapshot)` immediately.
   */
  subscribe(sink: SubscriberSink, topic: Topic): FeedEvent | undefined {
    // Priv-namespaced topics (e.g. `priv:<userId>:orders` from the Sprint 1
    // lifecycle bridge) are valid but skip the public grammar — they're fed
    // by in-process publishers, not venue adapters. ACL is enforced in the
    // transport layer (ws-server.ts, router.ts).
    const privKind = parsePrivKindTopic(topic);
    const parsed = privKind ? null : parse(topic);
    if (!privKind && !parsed) throw new Error(`Hub.subscribe: invalid topic "${topic}"`);

    let set = this.subsByTopic.get(topic);
    if (!set) {
      set = new Set();
      this.subsByTopic.set(topic, set);
    }
    if (set.has(sink)) return this.lastByTopic.get(topic);
    set.add(sink);

    const prev = this.refCount.get(topic) ?? 0;
    this.refCount.set(topic, prev + 1);

    if (prev === 0 && privKind) {
      try {
        this.privHooks.get(privKind.kind)?.onFirstSubscriber(privKind.userId);
      } catch {
        // Hooks are fire-and-forget — a throwing producer must not break the
        // client's subscription (the topic simply stays silent).
      }
    }

    if (prev === 0 && parsed) {
      const adapter = this.adapters.get(parsed.venue);
      if (!adapter) {
        // No adapter for this venue — leave the subscription bookkeeping in
        // place so unsubscribe paths still work; the topic just stays silent.
        return this.lastByTopic.get(topic);
      }
      const snapshotGeneration = ++this.nextSnapshotGeneration;
      const liveRevision = this.liveRevisionByTopic.get(topic) ?? 0;
      this.snapshotGenerationByTopic.set(topic, snapshotGeneration);
      try {
        adapter.subscribe(topic);
        void this.fillSnapshot(adapter, topic, snapshotGeneration, liveRevision);
      } catch (err) {
        // Roll back the ref bump so a transient adapter throw doesn't pin a
        // phantom subscription forever.
        set.delete(sink);
        if (set.size === 0) this.subsByTopic.delete(topic);
        this.refCount.delete(topic);
        this.snapshotGenerationByTopic.delete(topic);
        throw err;
      }
    }

    return this.lastByTopic.get(topic);
  }

  private async fillSnapshot(
    adapter: RealtimeAdapter,
    topic: Topic,
    generation: number,
    liveRevision: number,
  ): Promise<void> {
    try {
      const events = await adapter.snapshot(topic);
      // Snapshot and live subscription start together so no upstream gap is
      // created. A live frame wins that race; otherwise the REST result would
      // be delivered after the delta. The generation also invalidates an old
      // request across a complete unsubscribe/resubscribe cycle.
      if (
        this.refCountFor(topic) === 0 ||
        this.snapshotGenerationByTopic.get(topic) !== generation ||
        (this.liveRevisionByTopic.get(topic) ?? 0) !== liveRevision
      ) return;
      for (const event of events) {
        if (event.topic === topic) this.publishSnapshot(event);
      }
    } catch {
      // ponytail: snapshot fill is best-effort; live streams still carry the topic.
    }
  }

  /**
   * Remove `sink` from `topic`. Idempotent. Triggers `adapter.unsubscribe`
   * on the 1→0 ref-count transition.
   */
  unsubscribe(sink: SubscriberSink, topic: Topic): void {
    const set = this.subsByTopic.get(topic);
    if (!set || !set.has(sink)) return;
    set.delete(sink);
    const prev = this.refCount.get(topic) ?? 0;
    const next = Math.max(0, prev - 1);
    this.refCount.set(topic, next);

    if (next === 0) {
      this.subsByTopic.delete(topic);
      this.refCount.delete(topic);
      // Evict from the last-known cache. Without this, long-running hubs
      // accumulate one BookEvent (≈ 2-4KB) per topic ever subscribed even
      // after every client unsubscribes. With 10k unique churned topics/day
      // (HIP-3 long tail, expiring PM markets) that's ≈ 30MB/day monotonic.
      // Trade-off: a new subscriber to a recently-evicted topic loses its
      // cold-start seed — the next upstream tick rebuilds it.
      this.lastByTopic.delete(topic);
      this.liveRevisionByTopic.delete(topic);
      this.snapshotGenerationByTopic.delete(topic);
      // Priv topics have no adapter — notify the kind's demand hook instead.
      const privKind = parsePrivKindTopic(topic);
      if (privKind) {
        try {
          this.privHooks.get(privKind.kind)?.onLastUnsubscribe(privKind.userId);
        } catch {
          // Fire-and-forget — see subscribe().
        }
        return;
      }
      const parsed = parse(topic);
      if (parsed) {
        const adapter = this.adapters.get(parsed.venue);
        try {
          adapter?.unsubscribe(topic);
        } catch {
          // Adapter teardown errors are tolerated — the upstream will be
          // re-opened next time someone subs.
        }
      }
    }
  }

  /** Drop every subscription this sink holds (used on disconnect). */
  unsubscribeAll(sink: SubscriberSink): void {
    for (const topic of [...this.subsByTopic.keys()]) {
      const set = this.subsByTopic.get(topic);
      if (set?.has(sink)) this.unsubscribe(sink, topic);
    }
  }

  /* ── publish (adapter-facing) ───────────────────────────────────────────── */

  /**
   * Adapters call this for every normalized event. The hub caches the latest
   * per topic and fans out to subscribed sinks. Ticker events are coalesced
   * to ≤ 1/windowMs per topic; everything else delivers immediately.
   */
  publish(event: FeedEvent): void {
    // Fills are one-shot deltas, not snapshots — caching one would replay a
    // stale "filled ✓" to every reconnecting client as its cold-start seed.
    if (event.t === 'trade') {
      const current = this.lastByTopic.get(event.topic);
      if (!current || shouldReplaceLatest(current, event)) {
        this.lastByTopic.set(event.topic, event);
      }
      // Trades are one-shot tape entries. Deliver every print, but only let a
      // newer one become the reconnect seed. Any live print still invalidates
      // an in-flight REST history fill.
      this.liveRevisionByTopic.set(
        event.topic,
        (this.liveRevisionByTopic.get(event.topic) ?? 0) + 1,
      );
      this.deliverNow(event.topic, event);
      return;
    }
    if (event.t !== 'fill') {
      const current = this.lastByTopic.get(event.topic);
      if (current && !shouldReplaceLatest(current, event)) return;
      this.lastByTopic.set(event.topic, event);
      this.liveRevisionByTopic.set(
        event.topic,
        (this.liveRevisionByTopic.get(event.topic) ?? 0) + 1,
      );
    }
    if (event.t === 'tick') {
      this.tickerCoalesce.push(event.topic, event);
      return;
    }
    this.deliverNow(event.topic, event);
  }

  private publishSnapshot(event: FeedEvent): void {
    const current = this.lastByTopic.get(event.topic);
    if (event.t === 'trade') {
      if (!current || shouldReplaceLatest(current, event)) {
        this.lastByTopic.set(event.topic, event);
      }
      this.deliverNow(event.topic, event);
      return;
    }
    if (current && !shouldReplaceLatest(current, event)) return;
    this.lastByTopic.set(event.topic, event);
    this.deliverNow(event.topic, event);
  }

  private deliverNow(topic: Topic, event: FeedEvent): void {
    const set = this.subsByTopic.get(topic);
    if (!set || set.size === 0) return;
    for (const sink of set) {
      try {
        sink.send(event);
      } catch (err) {
        this.opts.onSendError(sink.id, err);
      }
    }
  }

  /* ── introspection (health endpoint, tests) ─────────────────────────────── */

  /** Current ref count for a topic (0 if no subscribers). */
  refCountFor(topic: Topic): number {
    return this.refCount.get(topic) ?? 0;
  }

  /** Total distinct topics with at least one subscriber. */
  activeTopicCount(): number {
    return this.subsByTopic.size;
  }

  /** Total subscriber-topic pairs (sum across topics). */
  totalSubscriptions(): number {
    let n = 0;
    for (const set of this.subsByTopic.values()) n += set.size;
    return n;
  }

  /** Last event seen on a topic, or undefined if none. */
  lastFor(topic: Topic): FeedEvent | undefined {
    return this.lastByTopic.get(topic);
  }

  /** All topics currently subscribed by at least one sink. */
  activeTopics(): readonly Topic[] {
    return [...this.subsByTopic.keys()];
  }

  /**
   * Look up a sink by its id. Used by the `onSendError` callback to convert
   * a sink id (the only thing it gets) back into a sink reference so it
   * can call `unsubscribeAll`. O(active subscribers) — acceptable because
   * onSendError fires only on dead sockets, not on the hot path.
   */
  findSinkById(sinkId: string): SubscriberSink | undefined {
    for (const set of this.subsByTopic.values()) {
      for (const sink of set) {
        if (sink.id === sinkId) return sink;
      }
    }
    return undefined;
  }
}

/**
 * Live data outranks fallback snapshots even when their clocks differ. Once
 * source quality is equal, venue time is monotonic; books add their upstream
 * sequence as a tie-breaker. Equal timestamps stay writable so an open
 * candle or account snapshot can legitimately update in place.
 */
function shouldReplaceLatest(current: FeedEvent, next: FeedEvent): boolean {
  const currentStale = current.stale === true;
  const nextStale = next.stale === true;
  if (currentStale !== nextStale) return currentStale;
  if (next.ts < current.ts) return false;
  if (
    next.ts === current.ts &&
    current.t === 'book' &&
    next.t === 'book' &&
    current.seq > 0 &&
    next.seq > 0 &&
    next.seq < current.seq
  ) return false;
  return true;
}

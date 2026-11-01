/**
 * Backpressure primitives: per-topic coalesce and per-client caps.
 *
 * Two distinct concerns kept in one file because they share no upstream
 * dependencies and both protect the hub from overload:
 *
 *   - `Coalescer`: last-write-wins per topic on a fixed-interval flush.
 *     Hyperliquid `allMids` can fire dozens of updates per second per mid;
 *     downstream UIs can't paint that fast and don't need to. We collapse to
 *     ≤ 1 update per `windowMs` per topic. Books/trades skip coalesce; only
 *     tickers and candle "open" updates get it.
 *
 *   - `ClientLimiter`: per-client topic cap + sliding-window msg-rate cap.
 *     Drops sub requests over the cap, drops inbound `op` messages over the
 *     rate cap. Inbound only — outbound flow control is the WS framing layer.
 */

import type { FeedEvent, Topic } from './types.js';

/* ── Coalescer ────────────────────────────────────────────────────────────── */

export type CoalescerOptions = {
  /** Flush window. Picked per topic kind by the hub. */
  windowMs: number;
  /** Called for each (topic, latest event) at flush time. */
  onFlush: (topic: Topic, event: FeedEvent) => void;
  /** Time source for tests. */
  now?: () => number;
};

/**
 * Collapses bursts of events on the same topic. The hub calls `push(topic, e)`
 * for every upstream tick; the coalescer keeps only the latest per topic and
 * flushes them every `windowMs`. Topics with no new events between flushes
 * cost nothing.
 */
export class Coalescer {
  private latest = new Map<Topic, FeedEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private readonly onFlush: (topic: Topic, event: FeedEvent) => void;

  constructor(opts: CoalescerOptions) {
    this.windowMs = opts.windowMs;
    this.onFlush = opts.onFlush;
  }

  push(topic: Topic, event: FeedEvent): void {
    this.latest.set(topic, event);
    if (!this.flushTimer) this.scheduleFlush();
  }

  /** Force flush immediately. Used on shutdown + when a client first connects. */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.latest.size === 0) return;
    const batch = this.latest;
    this.latest = new Map();
    for (const [topic, event] of batch) this.onFlush(topic, event);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.latest.clear();
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, this.windowMs);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }
}

/* ── ClientLimiter ────────────────────────────────────────────────────────── */

export interface ClientLimiterOptions {
  /** Max distinct topics one client may hold a subscription on. */
  maxTopics: number;
  /** Sliding-window inbound msg rate cap (per client). */
  maxMsgsPerSec: number;
  now?: () => number;
}

/**
 * Per-connection limiter. The router instantiates one per upgrade and calls
 * `trySub(topic)` / `tryMsg()` before forwarding to the hub. Drops do NOT
 * disconnect — the router sends `{op:'err', code:'rate_limited'|'topic_cap_exceeded'}`
 * and keeps the socket open so transient bursts don't reset state.
 */
export class ClientLimiter {
  private topics = new Set<Topic>();
  private msgTimes: number[] = [];
  private readonly opts: Required<ClientLimiterOptions>;

  constructor(opts: ClientLimiterOptions) {
    this.opts = {
      maxTopics: opts.maxTopics,
      maxMsgsPerSec: opts.maxMsgsPerSec,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /**
   * Returns `true` and records the topic if accepting it stays under the cap;
   * `false` if the cap would be exceeded (router emits `topic_cap_exceeded`).
   * Idempotent: re-subscribing to an already-held topic returns `true`.
   */
  trySub(topic: Topic): boolean {
    if (this.topics.has(topic)) return true;
    if (this.topics.size >= this.opts.maxTopics) return false;
    this.topics.add(topic);
    return true;
  }

  /** Release a topic. Idempotent. */
  unsub(topic: Topic): void {
    this.topics.delete(topic);
  }

  /** All held topics, for shutdown teardown. */
  heldTopics(): readonly Topic[] {
    return [...this.topics];
  }

  /**
   * Counts an inbound message against the per-second cap. Returns `true` when
   * the message is allowed, `false` when it should be dropped.
   */
  tryMsg(): boolean {
    const now = this.opts.now();
    const cutoff = now - 1_000;
    while (this.msgTimes.length && (this.msgTimes[0] as number) < cutoff) {
      this.msgTimes.shift();
    }
    if (this.msgTimes.length >= this.opts.maxMsgsPerSec) return false;
    this.msgTimes.push(now);
    return true;
  }

  /** For test + observability. */
  topicCount(): number {
    return this.topics.size;
  }
}

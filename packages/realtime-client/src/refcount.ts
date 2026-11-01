/**
 * Per-topic reference counter for the client orchestrator. When the count
 * for a topic crosses 0 → 1 the orchestrator opens a transport subscription;
 * when it crosses 1 → 0 it closes (or, for SSE, schedules a reconnect with
 * the reduced topic set since EventSource is one-way).
 *
 * Pure data + counter math — no async, no network, no platform deps. Lets
 * tests assert subscribe/release behaviour without spinning up a transport.
 */

import type { Topic } from './types.js';

export class RefCountSet {
  private readonly counts = new Map<Topic, number>();

  /**
   * Increment the counter for a topic. Returns `true` if the count just
   * crossed 0 → 1 (caller should open the upstream subscription).
   */
  acquire(topic: Topic): boolean {
    const prev = this.counts.get(topic) ?? 0;
    this.counts.set(topic, prev + 1);
    return prev === 0;
  }

  /**
   * Decrement. Returns `true` if the count just crossed 1 → 0 (caller
   * should close the upstream subscription). No-op when already at 0.
   */
  release(topic: Topic): boolean {
    const prev = this.counts.get(topic) ?? 0;
    if (prev <= 1) {
      this.counts.delete(topic);
      return prev === 1;
    }
    this.counts.set(topic, prev - 1);
    return false;
  }

  /** Current count (0 when never acquired). */
  countFor(topic: Topic): number {
    return this.counts.get(topic) ?? 0;
  }

  /** Snapshot of all topics with a count > 0. */
  activeTopics(): readonly Topic[] {
    return [...this.counts.keys()];
  }

  /** Total count across all topics (= sum of values). */
  total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }

  clear(): void {
    this.counts.clear();
  }
}

/**
 * Per-adapter stall watchdog.
 *
 * Closes the "looks healthy but actually stale" gap the red team flagged:
 * the circuit breaker fires only on `noteFailure()` calls, which are
 * triggered by upstream errors (close, parse failure, fetch reject). But
 * upstream venues can keep the TCP socket alive — sending pongs, acking
 * subscriptions — while silently dropping all real event traffic. Without
 * a watchdog, `breaker.isOpen()` stays `false`, `wsState` stays `'open'`,
 * and clients see the seeded `lastByTopic` value forever.
 *
 * Each adapter spins one of these up in `start()` and tears it down in
 * `stop()`. The watchdog never opens the breaker directly; it just calls
 * `noteFailure()` enough times to trip it (the breaker's failureThreshold
 * is the venue's choice). The adapter's existing `onOpen` callback then
 * runs the dim-stale fallback path uniformly with every other breaker
 * trip — no special-casing.
 *
 * Cost: one `setInterval` per active adapter. Cleared on stop.
 */

export interface StallWatchdogOptions {
  /**
   * Age in ms past which the adapter is considered stalled. Should be
   * substantially larger than the venue's natural inter-event gap — for
   * HL allMids that's ~50ms, for PM CLOB books that's ~1-5s, for Pyth
   * Hermes equity that's up to 1s. Default 15000ms accommodates the
   * slowest venue with margin.
   */
  stallMs?: number;
  /** How often to re-check. Default 5000ms. */
  checkMs?: number;
  /** Returns true when the adapter has at least one active subscription. */
  hasActiveSubs: () => boolean;
  /** Returns the Unix ms timestamp of the most recent event for ANY topic. */
  getLastEventAt: () => number;
  /**
   * Returns true while the underlying stream is actually open. When it
   * returns false the tick is skipped entirely. Default: always true.
   *
   * This gate exists because a stall verdict is only meaningful for an OPEN
   * stream. Without it (r8 review finding) the watchdog keeps firing on a
   * stale clock after its own `onStall` closed the socket — and, worse, can
   * fire in the window between the breaker's half-open transition and the
   * reconnect's `onopen`, which `noteFailure()`s the half-open probe before
   * the socket ever finishes connecting. On a venue with one shared breaker
   * that turns a single quiet subscription into a venue-wide outage loop
   * with escalating cooldowns. Closed/connecting streams are the breaker's
   * and reconnect ladder's business, not the watchdog's.
   *
   * NOTE: HL's socket-level watchdog intentionally does NOT set this — it
   * owns the wedged-CONNECTING case by design and recovers via its own
   * escalation ladder rather than raw breaker trips.
   */
  isStreamOpen?: () => boolean;
  /**
   * Called when stall is detected. Adapter wires this to its `CircuitBreaker`
   * via N consecutive `noteFailure()` calls so the breaker actually trips
   * even if it's not at the per-call threshold yet.
   */
  onStall: () => void;
  /** Time source override for tests. */
  now?: () => number;
}

export class StallWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<StallWatchdogOptions>;

  constructor(options: StallWatchdogOptions) {
    this.opts = {
      stallMs: options.stallMs ?? 15_000,
      checkMs: options.checkMs ?? 5_000,
      hasActiveSubs: options.hasActiveSubs,
      getLastEventAt: options.getLastEventAt,
      isStreamOpen: options.isStreamOpen ?? (() => true),
      onStall: options.onStall,
      now: options.now ?? (() => Date.now()),
    };
  }

  /** Begin watching. Idempotent — calling twice keeps the existing timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.checkMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Public so tests can drive the watchdog without sleeping. */
  tick(): void {
    if (!this.opts.hasActiveSubs()) return;
    if (!this.opts.isStreamOpen()) return; // stall is only meaningful while open
    const last = this.opts.getLastEventAt();
    if (last < 0) return; // never had an event — adapter hasn't received one yet
    const age = this.opts.now() - last;
    if (age >= this.opts.stallMs) {
      try {
        this.opts.onStall();
      } catch {
        // Watchdog never throws into the event loop.
      }
    }
  }
}

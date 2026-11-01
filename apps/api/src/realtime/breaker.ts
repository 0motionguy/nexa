/**
 * Per-venue circuit breaker.
 *
 * States:
 *   closed     — normal; failures count toward the trip threshold
 *   open       — upstream is failing; calls short-circuit; a cooldown timer
 *                eventually transitions to half-open
 *   half-open  — one probe is allowed; success → closed, failure → open
 *
 * Trip policy: N failures within W ms → open. Cooldown grows exponentially on
 * consecutive opens (back-off), capped.
 *
 * Side-effect free except for state mutations + callbacks. The hub wires
 * `onOpen` / `onHalfOpen` / `onClose` to switch upstream sources (primary WS
 * → REST fallback → primary WS again).
 *
 * No timers run while there are no failures. `noteFailure()` schedules; the
 * cooldown timer self-clears.
 */

type State = 'closed' | 'half-open' | 'open';

export interface BreakerOptions {
  /** Failures within `windowMs` that trip the breaker. */
  failureThreshold: number;
  /** Sliding window length, ms. */
  windowMs: number;
  /** First cooldown after open. */
  baseCooldownMs: number;
  /** Cap on cooldown after consecutive opens. */
  maxCooldownMs: number;
  /** Callbacks. */
  onOpen?: () => void;
  onHalfOpen?: () => void;
  onClose?: () => void;
  /** Time source — override in tests. Returns ms. */
  now?: () => number;
}

const DEFAULTS = {
  failureThreshold: 5,
  windowMs: 30_000,
  baseCooldownMs: 30_000,
  maxCooldownMs: 5 * 60_000,
} as const;

export class CircuitBreaker {
  private state: State = 'closed';
  private failures: number[] = [];
  private cooldownMs: number;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Once disposed, all state-mutating methods short-circuit to no-op. Without
   * this, a late-arriving `noteSuccess()` from a since-shut-down adapter
   * could fire `onClose` callbacks after the adapter has torn down — leaking
   * metrics writes and breaking the "stopped means stopped" invariant.
   */
  private disposed = false;
  private readonly opts: Required<Omit<BreakerOptions, 'onOpen' | 'onHalfOpen' | 'onClose'>> & {
    onOpen?: () => void;
    onHalfOpen?: () => void;
    onClose?: () => void;
  };

  constructor(options: Partial<BreakerOptions> = {}) {
    this.opts = {
      failureThreshold: options.failureThreshold ?? DEFAULTS.failureThreshold,
      windowMs: options.windowMs ?? DEFAULTS.windowMs,
      baseCooldownMs: options.baseCooldownMs ?? DEFAULTS.baseCooldownMs,
      maxCooldownMs: options.maxCooldownMs ?? DEFAULTS.maxCooldownMs,
      now: options.now ?? (() => Date.now()),
      onOpen: options.onOpen,
      onHalfOpen: options.onHalfOpen,
      onClose: options.onClose,
    };
    this.cooldownMs = this.opts.baseCooldownMs;
  }

  /** Current state. */
  getState(): State {
    return this.state;
  }

  /** True when calls should short-circuit (no upstream call should be made). */
  isOpen(): boolean {
    return this.state === 'open';
  }

  /**
   * Record a successful upstream call. In half-open this closes the breaker
   * and resets cooldown; in closed it trims old failures from the window.
   */
  noteSuccess(): void {
    if (this.disposed) return;
    if (this.state === 'half-open') {
      this.close();
      return;
    }
    if (this.state === 'closed') this.trim();
  }

  /**
   * Record a failed upstream call. In closed it counts toward trip threshold.
   * In half-open it immediately re-opens with longer cooldown. In open it's
   * a no-op (calls shouldn't reach here when open).
   */
  noteFailure(): void {
    if (this.disposed) return;
    if (this.state === 'open') return;
    if (this.state === 'half-open') {
      this.open(/* doubleCooldown */ true);
      return;
    }
    const now = this.opts.now();
    this.failures.push(now);
    this.trim();
    if (this.failures.length >= this.opts.failureThreshold) {
      this.open();
    }
  }

  /** Force-close. Useful in tests or after an operator clears an incident. */
  reset(): void {
    if (this.disposed) return;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.failures = [];
    this.cooldownMs = this.opts.baseCooldownMs;
    const wasOpen = this.state !== 'closed';
    this.state = 'closed';
    if (wasOpen) this.opts.onClose?.();
  }

  /** Stop any pending cooldown timer (call when shutting down the venue). */
  dispose(): void {
    this.disposed = true;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private trim(): void {
    const cutoff = this.opts.now() - this.opts.windowMs;
    while (this.failures.length && (this.failures[0] as number) < cutoff) {
      this.failures.shift();
    }
  }

  private open(doubleCooldown = false): void {
    this.state = 'open';
    this.failures = [];
    if (doubleCooldown) {
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.opts.maxCooldownMs);
    }
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.toHalfOpen();
    }, this.cooldownMs);
    // unref so the timer doesn't hold the process open during shutdown
    (this.cooldownTimer as { unref?: () => void }).unref?.();
    this.opts.onOpen?.();
  }

  private toHalfOpen(): void {
    this.state = 'half-open';
    this.opts.onHalfOpen?.();
  }

  private close(): void {
    this.state = 'closed';
    this.failures = [];
    this.cooldownMs = this.opts.baseCooldownMs;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.opts.onClose?.();
  }
}

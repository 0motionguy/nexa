/**
 * Single-RAF coalescer for chart updates.
 *
 * Live ticker streams can emit 20-50 events per second per topic; calling
 * `series.update(bar)` on every event triggers a render per tick and floors
 * scroll perf. The batcher debounces all writes to one per animation frame:
 * each `enqueue(key, value)` overwrites whatever was queued for that key,
 * then a single `requestAnimationFrame` callback flushes the final value.
 *
 * Platform fallback: when `requestAnimationFrame` is missing (Node tests,
 * non-DOM environments), we fall back to `setTimeout(0)` — perf doesn't
 * matter outside a browser.
 */

export type Flush<TValue> = (key: string, value: TValue) => void;

interface SchedulerLike {
  request(cb: () => void): number;
  cancel(handle: number): void;
}

function pickScheduler(): SchedulerLike {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  const caf = (globalThis as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame;
  if (raf && caf) return { request: (cb) => raf(cb), cancel: (h) => caf(h) };
  return {
    request: (cb) => setTimeout(cb, 0) as unknown as number,
    cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
}

export class RafBatcher<TValue> {
  private pending = new Map<string, TValue>();
  private handle: number | null = null;
  private readonly scheduler = pickScheduler();
  constructor(private readonly flush: Flush<TValue>) {}

  enqueue(key: string, value: TValue): void {
    this.pending.set(key, value);
    if (this.handle !== null) return;
    this.handle = this.scheduler.request(() => {
      this.handle = null;
      // CRITICAL: capture a fresh Map and reassign BEFORE iterating. Aliasing
      // `snapshot = this.pending` then calling `.clear()` empties both refs
      // (they're the same object) and the iteration runs over zero entries —
      // every chart update is silently dropped. Move-and-swap pattern below.
      const snapshot = this.pending;
      this.pending = new Map();
      for (const [k, v] of snapshot) {
        try {
          this.flush(k, v);
        } catch {
          // One bad flush shouldn't break the queue; skip and continue.
        }
      }
    });
  }

  cancel(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
    this.pending.clear();
  }
}

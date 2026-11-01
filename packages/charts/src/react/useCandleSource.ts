/**
 * Bridge from `@nexa/realtime-client` to the chart's `CandleSource`. Turns
 * a `useCandle` hook into a stable `{ kind: 'live', history, subscribe }`
 * object the `<Chart>` component understands.
 *
 * Requires the consumer to have wrapped the tree in a `<RealtimeProvider>`.
 * If they haven't (e.g. unit tests, static screenshots, replay mode) the
 * hook degrades to a static source — no errors thrown.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Candle, CandleSource, Interval } from '../types.js';

/* The realtime-client peer dep is intentionally optional. We dynamic-import
 * it lazily so trees without it (tests, static print) don't fail. The
 * consumer imports this hook explicitly when they want live data.
 *
 * `venue` is intentionally typed as a string here so consumers can pass
 * the realtime-client `useCandle` hook directly — its strict `VenueTag`
 * union is structurally a string and the chart side doesn't need the tag
 * narrowing. */
type UseCandleHook = (
  symbol: string | null,
  interval: Interval,
  venue?: any,
) => { o: number; h: number; l: number; c: number; v: number; ts: number; closed: boolean } | undefined;

/**
 * Build a stable `CandleSource` keyed by (symbol, interval, venue). The
 * `subscribe` callback bridges the React store update into the chart's
 * RAF-batched update loop without re-rendering the consumer tree.
 *
 * Pass `history` from a one-shot REST snapshot at the call site — typically
 * the same `useQuery` you'd use for the initial seed. The hub takes over
 * on the first WS delta.
 */
export function useLiveCandleSource(opts: {
  symbol: string;
  interval: Interval;
  venue?: string;
  history: readonly Candle[];
  useCandle: UseCandleHook;
  /**
   * Optional older-history pager. The chart calls it with the oldest loaded
   * open-time when the user scrolls past the left edge; resolve with the
   * older page (empty = no more). See the GLOBAL chart contract in
   * chartSettings.ts. Kept in a ref so passing a fresh closure per render
   * doesn't churn the memoized source.
   */
  loadOlder?: (beforeTs: number) => Promise<readonly Candle[]>;
}): CandleSource {
  const latest = opts.useCandle(opts.symbol, opts.interval, opts.venue);
  const subscribersRef = useRef<Set<(c: Candle) => void>>(new Set());
  const loadOlderRef = useRef(opts.loadOlder);
  loadOlderRef.current = opts.loadOlder;

  // Notify subscribers whenever the realtime-client emits a fresh candle.
  // We DON'T re-render the chart on every tick (subscribers are the chart's
  // RAF batcher, not React).
  useEffect(() => {
    if (!latest) return;
    const candle: Candle = {
      t: latest.ts,
      o: latest.o,
      h: latest.h,
      l: latest.l,
      c: latest.c,
      v: latest.v,
      closed: latest.closed,
    };
    for (const fn of subscribersRef.current) fn(candle);
  }, [latest]);

  return useMemo<CandleSource>(
    () => ({
      kind: 'live',
      history: opts.history,
      subscribe: (onTick) => {
        subscribersRef.current.add(onTick);
        return () => { subscribersRef.current.delete(onTick); };
      },
      loadOlder: (beforeTs) => loadOlderRef.current?.(beforeTs) ?? Promise.resolve([]),
    }),
    [opts.history],
  );
}

/**
 * GLOBAL chart behavior contract — the single source of truth for how every
 * trading product (perps, HIP-3 stocks, spot, desktop pro chart, NEO's native
 * WebView chart) loads candle history and handles scroll/zoom gestures.
 *
 *   - initial history: at least 2 full days on EVERY interval (target 420 bars)
 *   - scroll-left past the loaded edge backfills older pages (360 bars/page)
 *   - any single candle request stays inside the API proxy clamp (30d)
 *   - the price rail is mouse-wheel scalable; time-axis wheel zoom stays on
 *
 * NEO mirrors these values in `neo/lib/charts/chartSettings.ts` for the
 * native (Metro) bundle — keep the two files in sync when editing.
 */

import type { Interval } from './types.js';

/** Product floor: every chart opens with at least two full days of history. */
export const CHART_MIN_INITIAL_MS = 2 * 24 * 60 * 60 * 1000;

/** Preferred initial depth in bars — deeper than any viewport so the first
 *  left-scroll never hits the edge immediately. */
export const CHART_TARGET_INITIAL_BARS = 420;

/** Bars fetched per older-history page when the user scrolls past the left edge. */
export const CHART_BACKFILL_PAGE_BARS = 360;

/** Hard per-request window — mirrors the NEXA API candle clamp
 *  (`MAX_HL_LOOKBACK_MS` in routes/markets.ts); larger asks 400 upstream. */
export const CHART_MAX_REQUEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Backfill triggers when fewer than this many bars remain left of the viewport. */
export const CHART_BACKFILL_TRIGGER_BARS = 60;

/** Synthetic axis-drag pixels per wheel notch for price-scale zoom. */
export const PRICE_AXIS_WHEEL_STEP_PX = 56;

/** Bar duration in ms. `1M` uses 30d — close enough for window math. */
export function intervalMs(interval: Interval | string): number {
  switch (interval) {
    case '1m': return 60_000;
    case '3m': return 3 * 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '30m': return 30 * 60_000;
    case '1h': return 3_600_000;
    case '2h': return 2 * 3_600_000;
    case '4h': return 4 * 3_600_000;
    case '8h': return 8 * 3_600_000;
    case '12h': return 12 * 3_600_000;
    case '1d': return 86_400_000;
    case '3d': return 3 * 86_400_000;
    case '1w': return 7 * 86_400_000;
    case '1M': return 30 * 86_400_000;
    default: return 3_600_000;
  }
}

/** Initial candle window: >= 2 days, target 420 bars, <= the proxy clamp. */
export function initialLookbackMs(interval: Interval | string): number {
  const byBars = CHART_TARGET_INITIAL_BARS * intervalMs(interval);
  return Math.min(CHART_MAX_REQUEST_WINDOW_MS, Math.max(CHART_MIN_INITIAL_MS, byBars));
}

/** Window for one older-history page. */
export function backfillWindowMs(interval: Interval | string): number {
  const byBars = CHART_BACKFILL_PAGE_BARS * intervalMs(interval);
  return Math.min(CHART_MAX_REQUEST_WINDOW_MS, Math.max(intervalMs(interval), byBars));
}

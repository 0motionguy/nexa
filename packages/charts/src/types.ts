/**
 * Shared types for the charts package. Intentionally narrow: a `Candle` is
 * a thin slice of CandleEvent that the chart actually needs, and an
 * `IndicatorSpec` is the union of every built-in study with its parameters.
 *
 * Decoupled from `@nexa/realtime-client` shapes so the chart can also be
 * driven by a one-shot REST snapshot (no realtime hub) — useful for
 * print/export, server-side render, and unit tests.
 */

export type Interval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

/**
 * Universal candle shape. `t` is the candle's open time in unix ms.
 * `closed` is informational — the renderer doesn't need it but caller
 * code (replay mode, last-bar update path) does.
 */
export interface Candle {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly closed: boolean;
}

/** Single time-indexed scalar — what indicator functions emit. */
export interface Point {
  readonly t: number;
  readonly v: number;
}

/* ── indicator specs ─────────────────────────────────────────────────────── */

interface IndicatorBase {
  /** Stable identifier per chart instance (re-render-safe selector). */
  readonly id: string;
  /**
   * Which pane to render on. 0 = price pane (main). 1+ = sub-pane created
   * lazily for indicators that don't make sense on the same scale (RSI,
   * MACD, Stoch). For `volume` the renderer defaults to its own pane.
   */
  readonly pane?: number;
  /**
   * Color override. Accepts hex, rgb(a), or a CSS-var reference like
   * `var(--accent)`. The theme adapter resolves vars at apply time.
   */
  readonly color?: string;
  /** Line / histogram width in CSS pixels. */
  readonly lineWidth?: 1 | 2 | 3 | 4;
}

export interface EmaSpec extends IndicatorBase {
  readonly kind: 'ema';
  readonly period: number;
}
export interface SmaSpec extends IndicatorBase {
  readonly kind: 'sma';
  readonly period: number;
}
export interface WmaSpec extends IndicatorBase {
  readonly kind: 'wma';
  readonly period: number;
}
export interface VwapSpec extends IndicatorBase {
  readonly kind: 'vwap';
  /** Reset window: `session` resets at each new UTC day, `cumulative` never. */
  readonly window?: 'session' | 'cumulative';
}
export interface RsiSpec extends IndicatorBase {
  readonly kind: 'rsi';
  readonly period: number;
}
export interface MacdSpec extends IndicatorBase {
  readonly kind: 'macd';
  readonly fast: number;
  readonly slow: number;
  readonly signal: number;
}
export interface BollingerSpec extends IndicatorBase {
  readonly kind: 'bollinger';
  readonly period: number;
  readonly stdDev: number;
}
export interface AtrSpec extends IndicatorBase {
  readonly kind: 'atr';
  readonly period: number;
}
export interface VolumeSpec extends IndicatorBase {
  readonly kind: 'volume';
}

export type IndicatorSpec =
  | EmaSpec | SmaSpec | WmaSpec | VwapSpec
  | RsiSpec | MacdSpec | BollingerSpec | AtrSpec | VolumeSpec;

/* ── chart props ─────────────────────────────────────────────────────────── */

export type ChartType =
  | 'candles'
  | 'bars'
  | 'line'
  | 'area'
  | 'baseline'
  | 'heikinAshi';

/**
 * Theme tokens accepted by the chart. Values may be raw colors or
 * `var(--token)` references that the theme adapter resolves at apply time.
 */
export interface ChartTheme {
  readonly background: string;
  readonly text: string;
  readonly grid: string;
  readonly border: string;
  readonly up: string;
  readonly down: string;
  readonly accent: string;
  readonly crosshair: string;
}

export interface ChartPositionLine {
  readonly price: number;
  readonly sideLong: boolean;
  readonly label?: string;
}

export type CandleSource =
  | { readonly kind: 'static'; readonly candles: readonly Candle[] }
  | {
      readonly kind: 'live';
      /** Historical seed delivered up-front. */
      readonly history: readonly Candle[];
      /**
       * Returns an unsubscribe thunk. Called once per mount; the listener
       * is invoked for every incremental candle update from the upstream.
       */
      readonly subscribe: (onTick: (candle: Candle) => void) => () => void;
      /** Optional pagination — call when the chart scrolls past the left edge. */
      readonly loadOlder?: (beforeTs: number) => Promise<readonly Candle[]>;
    };

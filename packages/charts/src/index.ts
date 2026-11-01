/**
 * `@nexa/charts` — top-tier chart package, shared between NEO and MAZE/NEXA.
 *
 * Public surface:
 *   <Chart>                — the single React component
 *   useLiveCandleSource    — bridge from realtime-client into <Chart>'s source
 *   { ema, sma, rsi, ... } — pure indicator math (sub-export)
 *
 * Internals (engine factory, theme adapter, heikin-ashi transform, RAF
 * batcher) are exposed for advanced use — most consumers won't need them.
 */

export { Chart, type ChartProps } from './react/Chart.js';
export { useLiveCandleSource } from './react/useCandleSource.js';

export type {
  AtrSpec,
  BollingerSpec,
  Candle,
  CandleSource,
  ChartTheme,
  ChartType,
  ChartPositionLine,
  EmaSpec,
  IndicatorSpec,
  Interval,
  MacdSpec,
  Point,
  RsiSpec,
  SmaSpec,
  VwapSpec,
  VolumeSpec,
  WmaSpec,
} from './types.js';

export {
  createEngine,
  type CreateEngineOptions,
  Engine,
} from './engine/createEngine.js';

// GLOBAL chart behavior contract — history depth, backfill paging, and the
// scroll/zoom gesture rules every trading product applies.
export {
  CHART_BACKFILL_PAGE_BARS,
  CHART_BACKFILL_TRIGGER_BARS,
  CHART_MAX_REQUEST_WINDOW_MS,
  CHART_MIN_INITIAL_MS,
  CHART_TARGET_INITIAL_BARS,
  PRICE_AXIS_WHEEL_STEP_PX,
  backfillWindowMs,
  initialLookbackMs,
  intervalMs,
} from './chartSettings.js';

export { heikinAshi } from './engine/heikinAshi.js';
export { RafBatcher } from './engine/rafBatcher.js';
export {
  DEFAULT_DARK_THEME,
  candleColors,
  resolveTheme,
  themeToOptions,
} from './engine/themeAdapter.js';

// Drawing primitives — pure math, no DOM or React. See drawings/README in
// the source file for the layering plan (math → react adapter → server).
export {
  trendLinePixelDistance,
  fibLevels,
  FIB_DEFAULT_RATIOS,
  rectanglePixelBounds,
  rectangleHitTest,
  abcdMetrics,
} from './drawings/index.js';
export type {
  DataPoint,
  PixelPoint,
  Projection,
  TrendLineModel,
  FibRetracementModel,
  RectangleModel,
  AbcdModel,
  DrawingModel,
} from './drawings/index.js';

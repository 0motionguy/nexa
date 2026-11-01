/**
 * Chart drawings — public surface.
 *
 * Layered as:
 *   - `geometry.ts` (this directory) — pure math primitives. No DOM, no React.
 *     Caller supplies the price↔pixel projection and gets back distances,
 *     bounds, levels, ratios. Tested in `drawings.spec.ts`.
 *   - `react/` (next iteration) — pointer state machine + lightweight-charts
 *     `attachPrimitive` adapter. Wraps the math above with a `<DrawingLayer />`
 *     React component. Requires a running chart, so unit-test surface is
 *     limited; pin behavior with browser snapshot in the integration suite.
 *   - server `/v1/charts/drawings` (next iteration) — durable storage. JSON-
 *     serializable model shapes already; persistence is a small REST + drizzle
 *     `nb_chart_drawings` migration on top.
 *
 * Each model carries a `kind: '...'` discriminator so the renderer can switch
 * once instead of three rounds of instanceof / "in" checks.
 */

export type {
  DataPoint,
  PixelPoint,
  Projection,
  TrendLineModel,
  FibRetracementModel,
  RectangleModel,
  AbcdModel,
} from './geometry.js';

export {
  trendLinePixelDistance,
  fibLevels,
  FIB_DEFAULT_RATIOS,
  rectanglePixelBounds,
  rectangleHitTest,
  abcdMetrics,
} from './geometry.js';

import type {
  TrendLineModel,
  FibRetracementModel,
  RectangleModel,
  AbcdModel,
} from './geometry.js';

/**
 * Discriminated union of every drawing kind. Stored shape on the server is
 * exactly this — a JSON-serializable bag with a `kind` tag. The renderer
 * dispatches on `kind`; persistence stores `JSON.stringify(model)`.
 */
export type DrawingModel =
  | TrendLineModel
  | FibRetracementModel
  | RectangleModel
  | AbcdModel;

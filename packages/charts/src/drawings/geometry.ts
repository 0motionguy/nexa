/**
 * Pure-math geometry primitives for chart drawings.
 *
 * Every function in this module is deterministic, side-effect-free, and unit-
 * tested. It owns the price↔pixel math; the React + lightweight-charts plugin
 * wiring (next module up) consumes these helpers and never re-derives them.
 *
 * Coordinate model:
 *   - "data space" = { time: ms-unix, price: number } — what the user clicks on.
 *   - "pixel space" = { x: px, y: px } — what we render and hit-test against.
 *
 * The price↔pixel projection is supplied by the caller (lightweight-charts
 * exposes it via `priceScale.priceToCoordinate` and `timeScale.timeToCoordinate`).
 * Pure math here means tests can supply any projection without mounting a chart.
 */

/** A point in data space (`t` is ms-unix, `p` is price). */
export interface DataPoint { t: number; p: number }

/** A point in pixel space. */
export interface PixelPoint { x: number; y: number }

/** A pure projection from data → pixels, supplied by the caller. */
export interface Projection {
  toX: (t: number) => number;
  toY: (p: number) => number;
}

/* ── Trend line ─────────────────────────────────────────────────────────── */

export interface TrendLineModel {
  kind: 'trendLine';
  /** Anchor endpoints in data space. */
  a: DataPoint;
  b: DataPoint;
}

/**
 * Distance from a pixel point `q` to the line segment between projected
 * endpoints of the trend line. Returns Infinity if the segment is degenerate
 * (a === b). Used as the hit-test: a click within `tolerancePx` of the line
 * selects it for editing.
 *
 * Classic point-to-segment formula, projected into pixel space first so the
 * tolerance is in screen units (the user's mental model of "did I click on
 * the line").
 */
export function trendLinePixelDistance(
  model: TrendLineModel,
  q: PixelPoint,
  proj: Projection,
): number {
  const ax = proj.toX(model.a.t), ay = proj.toY(model.a.p);
  const bx = proj.toX(model.b.t), by = proj.toY(model.b.p);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Number.POSITIVE_INFINITY;
  // Project q onto the line, clamp the parameter to [0,1] (segment), then
  // compute the Euclidean distance to the projected point.
  const t = Math.max(0, Math.min(1, ((q.x - ax) * dx + (q.y - ay) * dy) / len2));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(q.x - px, q.y - py);
}

/* ── Fibonacci retracement ──────────────────────────────────────────────── */

export interface FibRetracementModel {
  kind: 'fib';
  /** Swing low (typically the LATER point in time for a retracement). */
  low: DataPoint;
  /** Swing high (typically the EARLIER point in time). */
  high: DataPoint;
  /** Override the default ratio levels (0, 0.236, 0.382, 0.5, 0.618, 0.786, 1). */
  ratios?: readonly number[];
}

/** Standard Fibonacci retracement ratios. */
export const FIB_DEFAULT_RATIOS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/**
 * Compute the price for each fib ratio between `low.p` and `high.p`.
 * The ratio is taken from `high` toward `low`, so ratio=0 = high price and
 * ratio=1 = low price (matches how every chart tool draws Fib retracements).
 *
 * Returns an array of `{ ratio, price }` ordered by the input `ratios` (default
 * order is descending — 0 first, 1 last, which renders cleanly top-down).
 */
export function fibLevels(
  model: FibRetracementModel,
): Array<{ ratio: number; price: number }> {
  const ratios = model.ratios ?? FIB_DEFAULT_RATIOS;
  const span = model.high.p - model.low.p;
  return ratios.map((r) => ({ ratio: r, price: model.high.p - r * span }));
}

/* ── Rectangle ──────────────────────────────────────────────────────────── */

export interface RectangleModel {
  kind: 'rect';
  a: DataPoint;
  b: DataPoint;
}

/**
 * Pixel bounding box of a rectangle drawing, normalized so `x1 ≤ x2` and
 * `y1 ≤ y2` regardless of how the user drew it (top-left or bottom-right
 * anchor first).
 */
export function rectanglePixelBounds(
  model: RectangleModel,
  proj: Projection,
): { x1: number; y1: number; x2: number; y2: number } {
  const ax = proj.toX(model.a.t), ay = proj.toY(model.a.p);
  const bx = proj.toX(model.b.t), by = proj.toY(model.b.p);
  return {
    x1: Math.min(ax, bx),
    y1: Math.min(ay, by),
    x2: Math.max(ax, bx),
    y2: Math.max(ay, by),
  };
}

/** True if pixel point `q` lies inside the rectangle (including borders). */
export function rectangleHitTest(
  model: RectangleModel,
  q: PixelPoint,
  proj: Projection,
): boolean {
  const b = rectanglePixelBounds(model, proj);
  return q.x >= b.x1 && q.x <= b.x2 && q.y >= b.y1 && q.y <= b.y2;
}

/* ── ABCD ───────────────────────────────────────────────────────────────── */

export interface AbcdModel {
  kind: 'abcd';
  a: DataPoint;
  b: DataPoint;
  c: DataPoint;
  d: DataPoint;
}

/**
 * AB and CD legs of an ABCD pattern, used by traders to verify the BC
 * retracement ratio and the CD projection ratio.
 *
 * Returns:
 *   - `ab`     : signed price move from A to B
 *   - `cd`     : signed price move from C to D
 *   - `bcRatio`: |BC| / |AB| (retracement; ideally 0.382–0.886)
 *   - `cdRatio`: |CD| / |AB| (projection; ideally 1.0–1.618 of AB)
 *
 * `bcRatio` and `cdRatio` are Infinity when AB or BC are zero, respectively.
 * The caller decides what to highlight in the UI (a 0.618 BC and 1.272 CD is
 * the textbook AB=CD; anything else just renders the geometry).
 */
export function abcdMetrics(model: AbcdModel): {
  ab: number; bc: number; cd: number;
  bcRatio: number; cdRatio: number;
} {
  const ab = model.b.p - model.a.p;
  const bc = model.c.p - model.b.p;
  const cd = model.d.p - model.c.p;
  const bcRatio = ab === 0 ? Number.POSITIVE_INFINITY : Math.abs(bc) / Math.abs(ab);
  const cdRatio = ab === 0 ? Number.POSITIVE_INFINITY : Math.abs(cd) / Math.abs(ab);
  return { ab, bc, cd, bcRatio, cdRatio };
}

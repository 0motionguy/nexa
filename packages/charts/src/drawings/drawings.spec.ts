import { describe, expect, it } from 'vitest';
import {
  abcdMetrics,
  FIB_DEFAULT_RATIOS,
  fibLevels,
  rectangleHitTest,
  rectanglePixelBounds,
  trendLinePixelDistance,
  type Projection,
} from './geometry.js';

/**
 * Synthetic projection where time-ms maps to x and price maps to y with a
 * fixed scale. Plain enough that hand-computed expected values are obvious.
 */
function makeProjection(opts: { tToX?: number; pToY?: number } = {}): Projection {
  const tToX = opts.tToX ?? 0.001;     // 1ms → 0.001px
  const pToY = opts.pToY ?? -10;       // price up → y down (chart-style)
  return {
    toX: (t) => t * tToX,
    toY: (p) => p * pToY,
  };
}

describe('trendLinePixelDistance', () => {
  const proj = makeProjection({ tToX: 1, pToY: -1 });

  it('is zero when the point lies exactly on the segment endpoint', () => {
    const model = { kind: 'trendLine' as const, a: { t: 0, p: 0 }, b: { t: 100, p: 0 } };
    expect(trendLinePixelDistance(model, { x: 0, y: 0 }, proj)).toBe(0);
    expect(trendLinePixelDistance(model, { x: 100, y: 0 }, proj)).toBe(0);
  });

  it('is zero at the midpoint of a horizontal segment', () => {
    const model = { kind: 'trendLine' as const, a: { t: 0, p: 0 }, b: { t: 100, p: 0 } };
    expect(trendLinePixelDistance(model, { x: 50, y: 0 }, proj)).toBe(0);
  });

  it('measures perpendicular distance to a horizontal segment', () => {
    const model = { kind: 'trendLine' as const, a: { t: 0, p: 0 }, b: { t: 100, p: 0 } };
    // y axis is inverted (price up → y down) so price=0 is y=0; a click 10px below the line:
    expect(trendLinePixelDistance(model, { x: 50, y: 10 }, proj)).toBe(10);
  });

  it('clamps to the closer endpoint when the click is past the segment', () => {
    const model = { kind: 'trendLine' as const, a: { t: 0, p: 0 }, b: { t: 100, p: 0 } };
    // Click is at x=200, y=0 — line ends at x=100,y=0. Distance is 100.
    expect(trendLinePixelDistance(model, { x: 200, y: 0 }, proj)).toBe(100);
    // Click is at x=-50, y=0 — line starts at x=0,y=0. Distance is 50.
    expect(trendLinePixelDistance(model, { x: -50, y: 0 }, proj)).toBe(50);
  });

  it('returns Infinity for a degenerate (a==b) segment', () => {
    const model = { kind: 'trendLine' as const, a: { t: 10, p: 5 }, b: { t: 10, p: 5 } };
    expect(trendLinePixelDistance(model, { x: 11, y: 5 }, proj)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('fibLevels', () => {
  it('computes the standard 7 ratios between low.p and high.p', () => {
    const model = {
      kind: 'fib' as const,
      low: { t: 0, p: 100 },
      high: { t: 0, p: 200 },
    };
    const levels = fibLevels(model);
    expect(levels).toHaveLength(7);
    expect(levels.map((l) => l.ratio)).toEqual(FIB_DEFAULT_RATIOS);
    // ratio=0 = the high price; ratio=1 = the low price
    expect(levels[0]!).toEqual({ ratio: 0, price: 200 });
    expect(levels[6]!).toEqual({ ratio: 1, price: 100 });
  });

  it('produces the canonical 0.382, 0.5, 0.618 retracement levels', () => {
    // Range 100–200. Expected mid levels:
    //   0.382 → 200 - 100*0.382 = 161.8
    //   0.5   → 150
    //   0.618 → 200 - 61.8 = 138.2
    const levels = fibLevels({
      kind: 'fib',
      low: { t: 0, p: 100 },
      high: { t: 0, p: 200 },
    });
    const byRatio = Object.fromEntries(levels.map((l) => [l.ratio, l.price]));
    expect(byRatio[0.382]).toBeCloseTo(161.8, 6);
    expect(byRatio[0.5]).toBe(150);
    expect(byRatio[0.618]).toBeCloseTo(138.2, 6);
  });

  it('honors a custom ratio set when provided', () => {
    const levels = fibLevels({
      kind: 'fib',
      low: { t: 0, p: 0 },
      high: { t: 0, p: 100 },
      ratios: [0, 0.5, 1, 1.618],
    });
    const prices = levels.map((l) => l.price);
    expect(prices[0]).toBe(100);
    expect(prices[1]).toBe(50);
    expect(prices[2]).toBe(0);
    // 1.618 ratio extends below the low, classic Fib extension target.
    expect(prices[3]).toBeCloseTo(-61.8, 6);
  });

  it('flips the spread when high.p < low.p (descending swing)', () => {
    // Inverted swing — high=50, low=150. Ratio 1 should still land on low.
    const levels = fibLevels({
      kind: 'fib',
      low: { t: 0, p: 150 },
      high: { t: 0, p: 50 },
    });
    expect(levels[0]!.price).toBe(50);   // ratio=0 → high
    expect(levels[6]!.price).toBe(150);  // ratio=1 → low
  });
});

describe('rectanglePixelBounds + rectangleHitTest', () => {
  const proj = makeProjection({ tToX: 1, pToY: -1 });

  it('normalizes corners regardless of which anchor was clicked first', () => {
    const drawn = rectanglePixelBounds(
      { kind: 'rect', a: { t: 100, p: 50 }, b: { t: 50, p: 100 } },
      proj,
    );
    expect(drawn.x1).toBe(50);
    expect(drawn.x2).toBe(100);
    // y-axis inverted: p=50 → y=-50, p=100 → y=-100, so min=-100 max=-50
    expect(drawn.y1).toBe(-100);
    expect(drawn.y2).toBe(-50);
  });

  it('hit-tests inside, on border, and outside', () => {
    const model = { kind: 'rect' as const, a: { t: 0, p: 0 }, b: { t: 100, p: -100 } };
    // Bounds: x [0,100], y [0, 100] (price -100 maps to y=100)
    expect(rectangleHitTest(model, { x: 50, y: 50 }, proj)).toBe(true);   // center
    expect(rectangleHitTest(model, { x: 0, y: 0 }, proj)).toBe(true);     // corner
    expect(rectangleHitTest(model, { x: 100, y: 100 }, proj)).toBe(true); // far corner
    expect(rectangleHitTest(model, { x: 101, y: 50 }, proj)).toBe(false); // just outside x
    expect(rectangleHitTest(model, { x: 50, y: 101 }, proj)).toBe(false); // just outside y
    expect(rectangleHitTest(model, { x: -1, y: -1 }, proj)).toBe(false);  // far outside
  });
});

describe('abcdMetrics', () => {
  it('computes the canonical AB=CD pattern (1.0 BC retracement, 1.0 CD projection)', () => {
    // A → B up 10. B → C back down 10. C → D up 10. Symmetric pattern.
    const m = abcdMetrics({
      kind: 'abcd',
      a: { t: 0, p: 100 },
      b: { t: 1, p: 110 },
      c: { t: 2, p: 100 },
      d: { t: 3, p: 110 },
    });
    expect(m.ab).toBe(10);
    expect(m.bc).toBe(-10);
    expect(m.cd).toBe(10);
    expect(m.bcRatio).toBe(1);
    expect(m.cdRatio).toBe(1);
  });

  it('flags a typical 0.618 BC retracement + 1.272 CD projection', () => {
    const m = abcdMetrics({
      kind: 'abcd',
      a: { t: 0, p: 100 },
      b: { t: 1, p: 110 },        // AB = +10
      c: { t: 2, p: 110 - 6.18 }, // BC = -6.18 → bcRatio = 0.618
      d: { t: 3, p: (110 - 6.18) + 12.72 }, // CD = +12.72 → cdRatio = 1.272
    });
    expect(m.bcRatio).toBeCloseTo(0.618, 4);
    expect(m.cdRatio).toBeCloseTo(1.272, 4);
  });

  it('returns Infinity for ratios when AB is zero (degenerate)', () => {
    const m = abcdMetrics({
      kind: 'abcd',
      a: { t: 0, p: 100 },
      b: { t: 1, p: 100 },  // AB = 0
      c: { t: 2, p: 90 },
      d: { t: 3, p: 105 },
    });
    expect(m.bcRatio).toBe(Number.POSITIVE_INFINITY);
    expect(m.cdRatio).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('drawings: JSON serialization round-trip', () => {
  // The server's `nb_chart_drawings` payload column stores `JSON.stringify(model)`.
  // Pin that the discriminator survives round-trip so the renderer's switch is
  // never silently broken by a future field rename.
  it('round-trips a TrendLine through JSON', () => {
    const original = { kind: 'trendLine' as const, a: { t: 1_700_000_000_000, p: 50 }, b: { t: 1_700_000_500_000, p: 75 } };
    const decoded = JSON.parse(JSON.stringify(original));
    expect(decoded).toEqual(original);
  });

  it('round-trips a Fib retracement with custom ratios', () => {
    const original = {
      kind: 'fib' as const,
      low: { t: 0, p: 100 },
      high: { t: 1, p: 200 },
      ratios: [0, 0.382, 0.618, 1],
    };
    const decoded = JSON.parse(JSON.stringify(original));
    expect(decoded).toEqual(original);
  });

  it('round-trips a Rectangle', () => {
    const original = { kind: 'rect' as const, a: { t: 0, p: 0 }, b: { t: 100, p: 100 } };
    const decoded = JSON.parse(JSON.stringify(original));
    expect(decoded).toEqual(original);
  });

  it('round-trips an ABCD', () => {
    const original = {
      kind: 'abcd' as const,
      a: { t: 0, p: 0 }, b: { t: 1, p: 10 },
      c: { t: 2, p: 5 }, d: { t: 3, p: 12 },
    };
    const decoded = JSON.parse(JSON.stringify(original));
    expect(decoded).toEqual(original);
  });
});

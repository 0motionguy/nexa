/**
 * `<Chart>` — the single React component every venue + screen uses.
 *
 * Props
 *   source       Static `{ kind: 'static', candles }` or `{ kind: 'live', history, subscribe, loadOlder? }`
 *   type         Render kind: 'candles' (default), 'heikinAshi', or anything from the engine factory
 *   indicators   Array of `IndicatorSpec`. The component computes each and pushes onto the engine.
 *   theme        ChartTheme (defaults to project dark theme).
 *   height       Container height in px (default 360).
 *   showVolume   Render a volume pane below the price pane (default true).
 *   onCrosshair  Optional callback receiving the hovered candle (for tooltips).
 *
 * Behaviour
 *   - First render: lazy-imports lightweight-charts, mounts the engine.
 *   - Source change: `setCandles` on the existing engine — no canvas
 *     teardown, no flash. The "jank-free interval swap" path.
 *   - Live updates: streamed through the RAF batcher so 50 ticks/sec land
 *     as one repaint per frame.
 *   - Indicator change: removed + re-added incrementally (most apps only
 *     toggle one at a time; full rebuild is cheap).
 *   - Theme change: applies live without rebuilding the engine.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ISeriesApi } from 'lightweight-charts';
import type {
  Candle,
  CandleSource,
  ChartPositionLine,
  ChartTheme,
  IndicatorSpec,
} from '../types.js';
import { heikinAshi } from '../engine/heikinAshi.js';
import { RafBatcher } from '../engine/rafBatcher.js';
import { createEngine, type Engine } from '../engine/createEngine.js';
import { DEFAULT_DARK_THEME, themeToOptions } from '../engine/themeAdapter.js';
import { CHART_BACKFILL_TRIGGER_BARS } from '../chartSettings.js';
import {
  atr, bollinger, ema, macd, rsi, sma, vwap, wma,
} from '../indicators/index.js';

export interface ChartProps {
  source: CandleSource;
  type?: 'candles' | 'heikinAshi';
  indicators?: readonly IndicatorSpec[];
  theme?: ChartTheme;
  height?: number;
  showVolume?: boolean;
  onCrosshair?: (candle: Candle | null) => void;
  positionLine?: ChartPositionLine | null;
  /** Resting-order lines (dashed, one per open TP/SL/limit) drawn distinct
   *  from the single filled-entry positionLine. */
  orderLines?: readonly ChartPositionLine[];
  onPositionLineDrag?: (price: number) => void;
  onPositionLineCommit?: (price: number) => void;
  className?: string;
}

export function Chart(props: ChartProps): React.ReactNode {
  const {
    source,
    type = 'candles',
    indicators = EMPTY_INDICATORS,
    theme = DEFAULT_DARK_THEME,
    height = 360,
    showVolume = true,
    positionLine = null,
    orderLines = EMPTY_ORDER_LINES,
    onPositionLineDrag,
    onPositionLineCommit,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const seriesByIdRef = useRef<Map<string, ISeriesApi<'Line' | 'Histogram'>[]>>(new Map());
  const positionLineRef = useRef<ChartPositionLine | null>(positionLine);
  const dragRef = useRef<{ active: boolean; price: number | null }>({ active: false, price: null });
  // Seam bookkeeping for viewport-preserving left-prepend (backfill).
  const seamRef = useRef<{ firstTs: number | null; lastTs: number | null }>({ firstTs: null, lastTs: null });
  const [ready, setReady] = useState(false);

  /* ── candles: derive once per source change, including HA transform ──── */
  const baseCandles = useMemo(() => {
    if (source.kind === 'static') return source.candles;
    return source.history;
  }, [source]);

  const candles = useMemo(
    () => (type === 'heikinAshi' ? heikinAshi(baseCandles) : baseCandles),
    [baseCandles, type],
  );

  const candleByTime = useMemo(() => {
    const byTime = new Map<number, Candle>();
    for (const candle of candles) byTime.set(candle.t, candle);
    return byTime;
  }, [candles]);

  /* ── engine lifecycle ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let local: Engine | null = null;
    void createEngine({ container: containerRef.current, theme, height }).then((eng) => {
      if (disposed) { eng.destroy(); return; }
      local = eng;
      engineRef.current = eng;
      setReady(true);
    });
    return () => {
      disposed = true;
      seriesByIdRef.current.clear();
      local?.destroy();
      engineRef.current = null;
      setReady(false);
    };
    // The engine is rebuilt only on container or height swaps. Theme + source
    // changes propagate through dedicated effects below.
  }, []);

  /* ── theme apply ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;
    eng.chart.applyOptions(themeToOptions(theme));
    eng.setCandleColors(theme);
  }, [theme, ready]);

  useEffect(() => {
    positionLineRef.current = positionLine;
  }, [positionLine]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;
    eng.setPositionLine(positionLine);
  }, [positionLine, ready]);

  /* ── resting-order lines (TP / SL / limit) ────────────────────────────── */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;
    eng.setOrderLines(orderLines);
  }, [orderLines, ready]);

  /* ── candle data (jank-free swap on source change) ────────────────────── */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;

    // Viewport-preserving left-prepend: when the tail is unchanged but older
    // bars appeared in front (a backfill page merged upstream), shift the
    // logical range by exactly the count added so the bars under the cursor
    // stay put instead of the chart jumping. Every other change (interval
    // swap, live tail growth, fresh series) takes the plain setCandles path.
    const seam = seamRef.current;
    const firstBar = candles[0];
    const lastBar = candles[candles.length - 1];
    const nextFirst = firstBar ? firstBar.t : null;
    const nextLast = lastBar ? lastBar.t : null;
    const seamFirst = seam.firstTs;
    let prepended = 0;
    if (
      seamFirst != null && seam.lastTs != null &&
      nextFirst != null && nextLast === seam.lastTs && nextFirst < seamFirst
    ) {
      let bar = candles[prepended];
      while (bar && bar.t < seamFirst) {
        prepended += 1;
        bar = candles[prepended];
      }
    }
    seam.firstTs = nextFirst;
    seam.lastTs = nextLast;

    if (prepended > 0) eng.applyHistoryPrepend(candles, prepended);
    else eng.setCandles(candles);
    if (showVolume) eng.setVolume(candles, theme);
    else eng.setVolume(null);
  }, [candles, showVolume, theme, ready]);

  /* ── price-axis wheel zoom (GLOBAL scroll contract) ───────────────────── */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;
    return eng.attachPriceAxisWheel();
  }, [ready]);

  /* ── older-history backfill on scroll past the left edge ──────────────── */
  const oldestTsRef = useRef<number | null>(null);
  oldestTsRef.current = candles[0]?.t ?? null;
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready || source.kind !== 'live') return;
    const loadOlder = source.loadOlder;
    if (!loadOlder) return;
    const timeScale = eng.chart.timeScale();
    let inFlight = false;
    let exhausted = false;
    const handler = (range: { from: number; to: number } | null): void => {
      if (!range || inFlight || exhausted) return;
      // `from` is a logical bar index; < trigger means the left edge is near.
      if (range.from >= CHART_BACKFILL_TRIGGER_BARS) return;
      const oldest = oldestTsRef.current;
      if (oldest == null) return;
      inFlight = true;
      void Promise.resolve(loadOlder(oldest))
        .then((older) => { if (!older || older.length === 0) exhausted = true; })
        .catch(() => { /* transient — allow retry on the next left-scroll */ })
        .finally(() => { inFlight = false; });
    };
    timeScale.subscribeVisibleLogicalRangeChange(handler);
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(handler);
  }, [source, ready]);

  /* ── live updates ────────────────────────────────────────────────────── */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready || source.kind !== 'live') return;

    const batcher = new RafBatcher<Candle>((_, candle) => {
      const c = type === 'heikinAshi' ? heikinAshi([candle])[0] : candle;
      if (!c) return;
      eng.updateCandle(c);
      if (showVolume) eng.updateVolume(c, theme);
    });

    const unsub = source.subscribe((candle) => {
      // Single-key batcher: live source emits at most one candle per topic.
      batcher.enqueue('latest', candle);
    });

    return () => {
      unsub();
      batcher.cancel();
    };
  }, [source, type, ready, showVolume, theme]);

  /* ── indicators ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;
    // Remove every previously-added indicator series; replay the current
    // spec list. Simpler than diffing and fine for the typical < 10 specs.
    for (const series of seriesByIdRef.current.values()) {
      for (const s of series) eng.removeSeries(s);
    }
    seriesByIdRef.current.clear();

    for (const spec of indicators) {
      const seriesList = renderIndicator(eng, candles, spec, theme);
      seriesByIdRef.current.set(spec.id, seriesList);
    }
  }, [indicators, candles, theme, ready]);

  /* ── crosshair tooltip ───────────────────────────────────────────────── */
  const onCrosshair = props.onCrosshair;
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready || !onCrosshair) return;
    const handler = (param: { time?: unknown; point?: unknown }): void => {
      if (!param.time || !param.point) { onCrosshair(null); return; }
      const ts = Number(param.time) * 1000;
      const matched = candleByTime.get(ts) ?? null;
      onCrosshair(matched);
    };
    eng.chart.subscribeCrosshairMove(handler);
    return () => eng.chart.unsubscribeCrosshairMove(handler);
  }, [candleByTime, ready, onCrosshair]);

  function priceFromPointer(e: ReactPointerEvent<HTMLDivElement>): number | null {
    const eng = engineRef.current;
    const el = containerRef.current;
    if (!eng || !el) return null;
    const rect = el.getBoundingClientRect();
    return eng.coordinateToPrice(e.clientY - rect.top);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    const eng = engineRef.current;
    const line = positionLineRef.current;
    const el = containerRef.current;
    if (!eng || !line || !el) return;
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const lineY = eng.priceToCoordinate(line.price);
    if (lineY == null || Math.abs(y - lineY) > 14) return;
    dragRef.current = { active: true, price: line.price };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture can fail if the browser already released this pointer.
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!dragRef.current.active) return;
    const eng = engineRef.current;
    const line = positionLineRef.current;
    const price = priceFromPointer(e);
    if (!eng || !line || price == null || !Number.isFinite(price) || price <= 0) return;
    dragRef.current.price = price;
    eng.setPositionLine({ ...line, price });
    onPositionLineDrag?.(price);
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!dragRef.current.active) return;
    const price = dragRef.current.price;
    dragRef.current = { active: false, price: null };
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // The pointer may already be released after a cancel event.
    }
    if (price != null) onPositionLineCommit?.(price);
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      ref={containerRef}
      className={props.className}
      onPointerDownCapture={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ width: '100%', height, cursor: positionLine ? 'ns-resize' : undefined }}
    />
  );
}

const EMPTY_INDICATORS: readonly IndicatorSpec[] = Object.freeze([]);
const EMPTY_ORDER_LINES: readonly ChartPositionLine[] = Object.freeze([]);

/* ── indicator renderer ──────────────────────────────────────────────────── */

function renderIndicator(
  engine: Engine,
  candles: readonly Candle[],
  spec: IndicatorSpec,
  theme: ChartTheme,
): ISeriesApi<'Line' | 'Histogram'>[] {
  const color = spec.color ?? theme.accent;
  const width = spec.lineWidth ?? 2;

  switch (spec.kind) {
    case 'ema': {
      const series = engine.addLineOverlay(ema(candles, spec.period), color, spec.pane ?? 0, width);
      return [series];
    }
    case 'sma': {
      const series = engine.addLineOverlay(sma(candles, spec.period), color, spec.pane ?? 0, width);
      return [series];
    }
    case 'wma': {
      const series = engine.addLineOverlay(wma(candles, spec.period), color, spec.pane ?? 0, width);
      return [series];
    }
    case 'vwap': {
      const series = engine.addLineOverlay(
        vwap(candles, spec.window ?? 'session'), color, spec.pane ?? 0, width,
      );
      return [series];
    }
    case 'bollinger': {
      const { middle, upper, lower } = bollinger(candles, spec.period, spec.stdDev);
      return [
        engine.addLineOverlay(middle, color, spec.pane ?? 0, width),
        engine.addLineOverlay(upper, color, spec.pane ?? 0, 1),
        engine.addLineOverlay(lower, color, spec.pane ?? 0, 1),
      ];
    }
    case 'rsi': {
      const paneIdx = spec.pane ?? engine.ensurePane();
      return [engine.addLineOverlay(rsi(candles, spec.period), color, paneIdx, width)];
    }
    case 'macd': {
      const paneIdx = spec.pane ?? engine.ensurePane();
      const { macd: macdLine, signal, histogram } = macd(candles, spec.fast, spec.slow, spec.signal);
      const seriesA = engine.addLineOverlay(macdLine, color, paneIdx, width);
      const seriesB = engine.addLineOverlay(signal, theme.crosshair, paneIdx, 1);
      // Histogram as a low-key overlay; engine doesn't yet expose histogram
      // adds for arbitrary panes, so render it as a line for now.
      const seriesC = engine.addLineOverlay(histogram, theme.up, paneIdx, 1);
      return [seriesA, seriesB, seriesC];
    }
    case 'atr': {
      const paneIdx = spec.pane ?? engine.ensurePane();
      return [engine.addLineOverlay(atr(candles, spec.period), color, paneIdx, width)];
    }
    case 'volume':
      // Volume is rendered by the engine's built-in volume pane; the spec
      // is a no-op at the indicator layer.
      return [];
  }
}

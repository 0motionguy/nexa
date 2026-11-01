/**
 * Engine factory — lazy wrapper around lightweight-charts.
 *
 * Why lazy: lightweight-charts is ~80KB minified. Dynamic-importing it keeps
 * it out of the initial bundle so chartless screens (home, settings, swap
 * forms) don't pay for it. The factory returns a promise consumers can
 * `await` before mounting the engine.
 *
 * Why a wrapper at all: lightweight-charts v5's API has a couple of rough
 * edges (the series-pane assignment dance, the v5-only multi-pane setup)
 * that the engine abstracts so the React layer reads cleanly.
 */

import type {
  CandlestickData,
  HistogramData,
  IChartApi,
  IPaneApi,
  IPriceLine,
  ISeriesApi,
  LineData,
  Time,
} from 'lightweight-charts';

import type { Candle, ChartPositionLine, ChartTheme } from '../types.js';
import { candleRange, sameCandleRange, type CandleRange } from './rangeLines.js';
import { candleColors, themeToOptions } from './themeAdapter.js';

/** Lazy-load lightweight-charts. */
async function importLightweight(): Promise<typeof import('lightweight-charts')> {
  return import('lightweight-charts');
}

export interface CreateEngineOptions {
  container: HTMLElement;
  theme: ChartTheme;
  height?: number;
}

/** Wraps the chart api with helpers tailored for our render loop. */
export class Engine {
  constructor(
    public readonly chart: IChartApi,
    private readonly lib: typeof import('lightweight-charts'),
    public readonly mainPane: IPaneApi<Time>,
    private readonly priceSeries: ISeriesApi<'Candlestick'>,
    private volumeSeries: ISeriesApi<'Histogram'> | null,
    private readonly theme: ChartTheme,
  ) {}

  private range: CandleRange | null = null;
  private highLine: IPriceLine | null = null;
  private lowLine: IPriceLine | null = null;
  private positionLine: IPriceLine | null = null;
  private positionLineSideLong: boolean | null = null;
  private orderLines: IPriceLine[] = [];

  /** Replace the entire candle series — jank-free interval swap path. */
  setCandles(candles: readonly Candle[]): void {
    const data: CandlestickData<Time>[] = candles.map((c) => ({
      time: (c.t / 1000) as Time,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));
    this.priceSeries.setData(data);
    this.setRangeLines(candleRange(candles));
  }

  /**
   * Prepend an older history page without moving the viewport (GLOBAL chart
   * contract — chartSettings.ts). `candles` is the FULL merged series (older
   * page + previous data); `addedBefore` is how many bars were inserted in
   * front. The visible logical range shifts by exactly that count so the
   * bars under the cursor stay put while history loads behind them.
   */
  applyHistoryPrepend(candles: readonly Candle[], addedBefore: number): void {
    const ts = this.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    this.setCandles(candles);
    if (range && addedBefore > 0) {
      ts.setVisibleLogicalRange({ from: range.from + addedBefore, to: range.to + addedBefore });
    }
  }

  /** Apply a single incremental update — call from the RAF batcher. */
  updateCandle(candle: Candle): void {
    this.priceSeries.update({
      time: (candle.t / 1000) as Time,
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
    });
    this.extendRangeLines(candle);
  }

  setCandleColors(theme: ChartTheme): void {
    this.priceSeries.applyOptions(candleColors(theme));
  }

  setPositionLine(line: ChartPositionLine | null): void {
    if (!line || !Number.isFinite(line.price) || line.price <= 0) {
      if (this.positionLine) this.priceSeries.removePriceLine(this.positionLine);
      this.positionLine = null;
      this.positionLineSideLong = null;
      return;
    }
    const title = line.label ?? (line.sideLong ? 'LONG' : 'SHORT');
    if (this.positionLine && this.positionLineSideLong === line.sideLong) {
      this.positionLine.applyOptions({ price: line.price, title });
      return;
    }
    if (this.positionLine) this.priceSeries.removePriceLine(this.positionLine);
    this.positionLine = this.priceSeries.createPriceLine({
      price: line.price,
      color: line.sideLong ? this.theme.up : this.theme.down,
      lineWidth: 2,
      lineStyle: this.lib.LineStyle.Dashed,
      axisLabelVisible: true,
      title,
    });
    this.positionLineSideLong = line.sideLong;
  }

  /**
   * Replace the set of resting-order lines (dashed, one per open order).
   * Distinct from `setPositionLine` — a position is the single filled
   * entry; order lines mark where GTC/ALO limits are waiting on the book.
   */
  setOrderLines(lines: readonly ChartPositionLine[]): void {
    for (const l of this.orderLines) this.priceSeries.removePriceLine(l);
    this.orderLines = [];
    for (const line of lines) {
      if (!Number.isFinite(line.price) || line.price <= 0) continue;
      this.orderLines.push(
        this.priceSeries.createPriceLine({
          price: line.price,
          color: line.sideLong ? this.theme.up : this.theme.down,
          lineWidth: 1,
          lineStyle: this.lib.LineStyle.Dashed,
          axisLabelVisible: true,
          title: line.label ?? (line.sideLong ? 'BUY' : 'SELL'),
        }),
      );
    }
  }

  priceToCoordinate(price: number): number | null {
    return this.priceSeries.priceToCoordinate(price);
  }

  coordinateToPrice(y: number): number | null {
    return this.priceSeries.coordinateToPrice(y);
  }

  private dragLine: IPriceLine | null = null;

  /**
   * Ghost line that tracks the pointer during a drag-to-modify gesture on a
   * resting-order line. Dotted so it reads as "proposed", never persisted —
   * callers clear it with `null` on pointer-up regardless of outcome.
   */
  setDragLine(line: ChartPositionLine | null): void {
    if (!line || !Number.isFinite(line.price) || line.price <= 0) {
      if (this.dragLine) this.priceSeries.removePriceLine(this.dragLine);
      this.dragLine = null;
      return;
    }
    const title = line.label ?? (line.sideLong ? 'BUY →' : 'SELL →');
    if (this.dragLine) {
      this.dragLine.applyOptions({ price: line.price, title });
      return;
    }
    this.dragLine = this.priceSeries.createPriceLine({
      price: line.price,
      color: line.sideLong ? this.theme.up : this.theme.down,
      lineWidth: 2,
      lineStyle: this.lib.LineStyle.Dotted,
      axisLabelVisible: true,
      title,
    });
  }

  /**
   * Toggle the chart's own pan/zoom handling. Off while a drag-to-modify
   * gesture owns the pointer so moving an order line doesn't also pan the
   * chart underneath it. Restoring passes the exact creation-time granular
   * configs back — `handleScroll: true` would expand to all-true and flip
   * deliberate choices like `vertTouchDrag: false` (page scroll on mobile).
   */
  setInteractionEnabled(enabled: boolean): void {
    if (!enabled) {
      this.chart.applyOptions({ handleScroll: false, handleScale: false });
      return;
    }
    this.chart.applyOptions({
      handleScroll: GESTURE_SCROLL_OPTIONS,
      handleScale: GESTURE_SCALE_OPTIONS,
    });
  }

  /** Enable / disable the volume histogram pane. */
  setVolume(candles: readonly Candle[] | null, theme: ChartTheme = this.theme): void {
    if (candles === null) {
      if (this.volumeSeries) {
        this.chart.removeSeries(this.volumeSeries);
        this.volumeSeries = null;
      }
      return;
    }
    if (!this.volumeSeries) {
      // Volume gets its own pane below the main price pane.
      const pane = this.chart.addPane();
      pane.setStretchFactor(1);
      this.volumeSeries = this.chart.addSeries(this.lib.HistogramSeries, {
        priceFormat: { type: 'volume' },
      });
      // Move onto the volume pane. Pane index 0 is main; new pane gets the
      // last index assigned by the lib.
      const paneIdx = this.chart.panes().length - 1;
      this.volumeSeries.moveToPane(paneIdx);
    }
    const data: HistogramData<Time>[] = candles.map((c) => ({
      time: (c.t / 1000) as Time,
      value: c.v,
      color: c.c >= c.o ? theme.up : theme.down,
    }));
    this.volumeSeries.setData(data);
  }

  /** Push the volume bar for the latest candle without rebuilding the series. */
  updateVolume(candle: Candle, theme: ChartTheme = this.theme): void {
    if (!this.volumeSeries) return;
    this.volumeSeries.update({
      time: (candle.t / 1000) as Time,
      value: candle.v,
      color: candle.c >= candle.o ? theme.up : theme.down,
    });
  }

  /**
   * Add a line overlay series on a specific pane (price pane by default).
   * Returns a handle the caller can later update or remove.
   */
  addLineOverlay(
    points: readonly { t: number; v: number }[],
    color: string,
    paneIdx = 0,
    lineWidth: 1 | 2 | 3 | 4 = 2,
  ): ISeriesApi<'Line'> {
    const series = this.chart.addSeries(this.lib.LineSeries, {
      color,
      lineWidth,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    if (paneIdx !== 0) series.moveToPane(paneIdx);
    series.setData(points.map<LineData<Time>>((p) => ({ time: (p.t / 1000) as Time, value: p.v })));
    return series;
  }

  removeSeries(series: ISeriesApi<'Line' | 'Histogram'>): void {
    this.chart.removeSeries(series);
  }

  private extendRangeLines(candle: Candle): void {
    if (!this.range) {
      this.setRangeLines(candleRange([candle]));
      return;
    }
    const high = Number.isFinite(candle.h) ? Math.max(this.range.high, candle.h) : this.range.high;
    const low = Number.isFinite(candle.l) ? Math.min(this.range.low, candle.l) : this.range.low;
    if (high !== this.range.high || low !== this.range.low) this.setRangeLines({ high, low });
  }

  private setRangeLines(range: CandleRange | null): void {
    if (sameCandleRange(this.range, range)) return;
    this.range = range;
    if (!range) {
      if (this.highLine) this.priceSeries.removePriceLine(this.highLine);
      if (this.lowLine) this.priceSeries.removePriceLine(this.lowLine);
      this.highLine = null;
      this.lowLine = null;
      return;
    }
    if (this.highLine && this.lowLine) {
      this.highLine.applyOptions({ price: range.high });
      this.lowLine.applyOptions({ price: range.low });
      return;
    }
    if (this.highLine) this.priceSeries.removePriceLine(this.highLine);
    if (this.lowLine) this.priceSeries.removePriceLine(this.lowLine);
    this.highLine = this.priceSeries.createPriceLine({
      price: range.high,
      color: this.theme.up,
      lineWidth: 1,
      lineStyle: this.lib.LineStyle.Dotted,
      axisLabelVisible: true,
      title: 'H',
    });
    this.lowLine = this.priceSeries.createPriceLine({
      price: range.low,
      color: this.theme.down,
      lineWidth: 1,
      lineStyle: this.lib.LineStyle.Dotted,
      axisLabelVisible: true,
      title: 'L',
    });
  }

  /**
   * GLOBAL scroll contract (chartSettings.ts): wheeling over the price rail
   * must zoom the PRICE scale, matching the time-zoom the chart body already
   * has on wheel. lightweight-charts only rescales price on an axis DRAG, so
   * this adds the missing wheel affordance using the public price-scale API
   * (getVisibleRange / setVisibleRange / setAutoScale) — no synthetic DOM
   * events, no private internals. Capture-phase + preventDefault so the lib's
   * own wheel handler (time zoom) never also fires for a price-rail wheel.
   * Zooms around the cursor's price when it maps, else the range midpoint.
   * Returns a detach thunk.
   */
  attachPriceAxisWheel(): () => void {
    const root = this.chart.chartElement();
    const scale = this.chart.priceScale('right');
    const onWheel = (e: WheelEvent): void => {
      const rect = root.getBoundingClientRect();
      const axisWidth = scale.width();
      // Only when the pointer is over the right price rail.
      if (axisWidth <= 0 || e.clientX < rect.right - axisWidth) return;
      const range = scale.getVisibleRange();
      if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1; // wheel down = zoom out
      const lo = Math.min(range.from, range.to);
      const hi = Math.max(range.from, range.to);
      const pivotRaw = this.coordinateToPrice(e.clientY - rect.top);
      const pivot = pivotRaw != null && pivotRaw >= lo && pivotRaw <= hi ? pivotRaw : (lo + hi) / 2;
      const nextLo = pivot - (pivot - lo) * factor;
      const nextHi = pivot + (hi - pivot) * factor;
      if (!(nextHi > nextLo)) return;
      scale.setAutoScale(false);
      scale.setVisibleRange({ from: nextLo, to: nextHi });
    };
    root.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => root.removeEventListener('wheel', onWheel, { capture: true });
  }

  /** Create or reuse a sub-pane (e.g. RSI / MACD). Index returned is the new pane's. */
  ensurePane(): number {
    const pane = this.chart.addPane();
    pane.setStretchFactor(1);
    return this.chart.panes().length - 1;
  }

  destroy(): void {
    this.chart.remove();
  }
}

/** Creation-time gesture configs — also what setInteractionEnabled(true)
 *  restores, so a drag round-trip never changes gesture behavior. */
const GESTURE_SCROLL_OPTIONS = {
  mouseWheel: true,
  pressedMouseMove: true,
  horzTouchDrag: true,
  vertTouchDrag: false,
} as const;
const GESTURE_SCALE_OPTIONS = {
  mouseWheel: true,
  pinch: true,
  axisPressedMouseMove: { time: true, price: true },
  axisDoubleClickReset: { time: true, price: true },
} as const;

export async function createEngine(opts: CreateEngineOptions): Promise<Engine> {
  const lib = await importLightweight();
  const themeOptions = themeToOptions(opts.theme) as Record<string, unknown>;
  const chart = lib.createChart(opts.container, {
    width: opts.container.clientWidth,
    height: opts.height ?? 360,
    autoSize: true,
    handleScroll: GESTURE_SCROLL_OPTIONS,
    handleScale: GESTURE_SCALE_OPTIONS,
    kineticScroll: { touch: true, mouse: true },
    ...themeOptions,
    rightPriceScale: {
      ...(themeOptions.rightPriceScale as Record<string, unknown>),
      scaleMargins: { top: 0.08, bottom: 0.18 },
      alignLabels: true,
      ticksVisible: true,
    },
    timeScale: {
      ...(themeOptions.timeScale as Record<string, unknown>),
      rightOffset: 8,
      barSpacing: 7,
      minBarSpacing: 1,
      lockVisibleTimeRangeOnResize: true,
      rightBarStaysOnScroll: true,
      shiftVisibleRangeOnNewBar: true,
      timeVisible: true,
      secondsVisible: false,
    },
  });
  const priceSeries = chart.addSeries(lib.CandlestickSeries, candleColors(opts.theme));
  const mainPane = chart.panes()[0] as IPaneApi<Time>;
  return new Engine(chart, lib, mainPane, priceSeries, null, opts.theme);
}

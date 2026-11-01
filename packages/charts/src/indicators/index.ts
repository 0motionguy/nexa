/**
 * Public indicator surface. Each function takes a candle array + parameters
 * and returns one or more time-aligned `Point` series. Pure — no side
 * effects, no rendering. The React `<Chart>` layer maps `IndicatorSpec`s
 * to series.update() calls; consumers can also call these directly for
 * one-off chart-less computations (alerts, screeners, back-tests).
 */

export { ema } from './ema.js';
export { sma } from './sma.js';
export { wma } from './wma.js';
export { vwap } from './vwap.js';
export { rsi } from './rsi.js';
export { atr } from './atr.js';
export { bollinger, type BollingerOutput } from './bollinger.js';
export { macd, type MacdOutput } from './macd.js';

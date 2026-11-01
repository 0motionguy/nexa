/**
 * Theme adapter — resolves CSS-var-style references into the concrete color
 * strings lightweight-charts expects, and projects a `ChartTheme` onto its
 * options surface.
 *
 * Why this matters: the project uses CSS variables (`--accent-edge`,
 * `--surface-2`, etc.) for cross-theme color tokens. The chart can't read
 * CSS vars natively (lightweight-charts doesn't run a stylesheet lookup),
 * so we resolve them at apply time against the document's computed style.
 *
 * In headless environments (Node tests, SSR, native WebView bridge) the
 * resolver falls back to the value verbatim — callers should pass real
 * colors rather than var refs in those cases.
 */

import type { ChartTheme } from '../types.js';

const VAR_RE = /^var\(--([a-zA-Z0-9_-]+)\)$/;

function resolveCssVar(value: string): string {
  const match = VAR_RE.exec(value.trim());
  if (!match) return value;
  const tokenName = `--${match[1] ?? ''}`;
  const doc = (globalThis as { document?: { documentElement?: Element } }).document;
  const root = doc?.documentElement;
  const get = (globalThis as {
    getComputedStyle?: (el: Element) => { getPropertyValue(name: string): string };
  }).getComputedStyle;
  if (!root || !get) return value;
  const resolved = get(root).getPropertyValue(tokenName).trim();
  return resolved || value;
}

export function resolveTheme(theme: ChartTheme): ChartTheme {
  return {
    background: resolveCssVar(theme.background),
    text: resolveCssVar(theme.text),
    grid: resolveCssVar(theme.grid),
    border: resolveCssVar(theme.border),
    up: resolveCssVar(theme.up),
    down: resolveCssVar(theme.down),
    accent: resolveCssVar(theme.accent),
    crosshair: resolveCssVar(theme.crosshair),
  };
}

/**
 * Build the lightweight-charts `ChartOptions` shape from a resolved theme.
 * Returned as a loose record so the caller can `applyOptions(themeToOptions(...))`
 * without leaking lightweight-charts internals into the public API.
 */
export function themeToOptions(theme: ChartTheme): Record<string, unknown> {
  const t = resolveTheme(theme);
  return {
    layout: {
      background: { type: 'solid', color: t.background },
      textColor: t.text,
    },
    grid: {
      vertLines: { color: t.grid },
      horzLines: { color: t.grid },
    },
    crosshair: {
      vertLine: { color: t.crosshair, width: 1, style: 0 },
      horzLine: { color: t.crosshair, width: 1, style: 0 },
    },
    rightPriceScale: { borderColor: t.border },
    timeScale: { borderColor: t.border },
  };
}

/**
 * Color overrides per candlestick series — shipped as a separate function
 * because the candle series takes its color set on `applyOptions` directly,
 * not via the chart-level layout.
 */
export function candleColors(theme: ChartTheme): Record<string, string> {
  const t = resolveTheme(theme);
  return {
    upColor: t.up,
    downColor: t.down,
    borderUpColor: t.up,
    borderDownColor: t.down,
    wickUpColor: t.up,
    wickDownColor: t.down,
  };
}

/** Sensible dark-theme default — matches the project's `dark-theme-pattern`. */
export const DEFAULT_DARK_THEME: ChartTheme = {
  background: 'var(--surface-2)',
  text: 'var(--fg)',
  grid: 'var(--border)',
  border: 'var(--border)',
  up: 'var(--success)',
  down: 'var(--danger)',
  accent: 'var(--accent-edge)',
  crosshair: 'var(--meta)',
};

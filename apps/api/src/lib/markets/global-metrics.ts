/**
 * Global crypto market metrics — Fear & Greed index (alternative.me) + total
 * market cap (CoinGecko /global). Both are keyless public APIs; both legs fail
 * soft to `null` so the route always answers and the UI renders an honest "—"
 * for a missing leg instead of demo numbers.
 *
 *   - alternative.me /fng returns the current index plus a free DAILY history
 *     (one point per day) — enough for the meter + trend.
 *   - CoinGecko /global returns current total mcap, 24h change %, and BTC
 *     dominance, but NO free history. The sparkline series is an in-process
 *     ring buffer of observed values (real observations, ~5-min cadence,
 *     24h window). It resets on deploy and rebuilds — never synthesized.
 */

import { features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';

const FNG_URL = 'https://api.alternative.me/fng/?limit=48';
const COINGECKO_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';

export interface FngMetrics {
  /** 0..100. */
  value: number;
  /** Upstream label, e.g. "Extreme Fear" / "Neutral" / "Greed". */
  classification: string;
  updatedAt: string;
  /** Daily points, oldest → newest, epoch ms. */
  history: Array<{ t: number; value: number }>;
}

export interface McapMetrics {
  totalUsd: number;
  change24hPct: number | null;
  btcDominancePct: number | null;
  updatedAt: string;
  /** Observed points, oldest → newest, epoch ms. Empty right after a deploy. */
  series: Array<{ t: number; usd: number }>;
}

export interface GlobalMetrics {
  fng: FngMetrics | null;
  mcap: McapMetrics | null;
}

/** alternative.me /fng payload — defensive, only the fields we read. */
interface FngPayload {
  data?: Array<{
    value?: string | number;
    value_classification?: string;
    timestamp?: string | number;
  }>;
}

/** CoinGecko /global payload — defensive, only the fields we read. */
interface CoinGeckoGlobalPayload {
  data?: {
    total_market_cap?: Record<string, number>;
    market_cap_change_percentage_24h_usd?: number;
    market_cap_percentage?: Record<string, number>;
    updated_at?: number;
  };
}

export function mapFngPayload(payload: FngPayload | null): FngMetrics | null {
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const current = rows[0];
  const value = Number(current?.value);
  if (!Number.isFinite(value)) return null;
  const tsSec = Number(current?.timestamp);
  const history = rows
    .map((r) => ({ t: Number(r.timestamp) * 1000, value: Number(r.value) }))
    .filter((p) => Number.isFinite(p.t) && p.t > 0 && Number.isFinite(p.value))
    .sort((a, b) => a.t - b.t);
  return {
    value,
    classification:
      typeof current?.value_classification === 'string' && current.value_classification.trim()
        ? current.value_classification.trim()
        : fngClassification(value),
    updatedAt: new Date(Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : Date.now()).toISOString(),
    history,
  };
}

/** Fallback label when the upstream omits one — same bands alternative.me uses. */
export function fngClassification(value: number): string {
  if (value <= 25) return 'Extreme Fear';
  if (value <= 45) return 'Fear';
  if (value <= 55) return 'Neutral';
  if (value <= 75) return 'Greed';
  return 'Extreme Greed';
}

export function mapGlobalPayload(
  payload: CoinGeckoGlobalPayload | null,
  series: Array<{ t: number; usd: number }>,
): McapMetrics | null {
  const d = payload?.data;
  const totalUsd = Number(d?.total_market_cap?.usd);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return null;
  const change = Number(d?.market_cap_change_percentage_24h_usd);
  const btcDom = Number(d?.market_cap_percentage?.btc);
  const updatedSec = Number(d?.updated_at);
  return {
    totalUsd,
    change24hPct: Number.isFinite(change) ? change : null,
    btcDominancePct: Number.isFinite(btcDom) ? btcDom : null,
    updatedAt: new Date(
      Number.isFinite(updatedSec) && updatedSec > 0 ? updatedSec * 1000 : Date.now(),
    ).toISOString(),
    series,
  };
}

/* ── mcap series ring buffer (per-process, 24h window) ─────────────────── */

const SERIES_MIN_GAP_MS = 4 * 60_000;
const SERIES_WINDOW_MS = 24 * 3_600_000;
const SERIES_MAX_POINTS = 320;

const mcapSeries: Array<{ t: number; usd: number }> = [];

/** Append an observation if the last one is old enough; prune the window.
 *  Exported for tests — `series` defaults to the module buffer. */
export function pushMcapPoint(
  usd: number,
  now = Date.now(),
  series: Array<{ t: number; usd: number }> = mcapSeries,
): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const last = series[series.length - 1];
  if (last && now - last.t < SERIES_MIN_GAP_MS) return;
  series.push({ t: now, usd });
  const cutoff = now - SERIES_WINDOW_MS;
  let head = series[0];
  while (head && (head.t < cutoff || series.length > SERIES_MAX_POINTS)) {
    series.shift();
    head = series[0];
  }
}

/* ── fetchers (fail soft) ──────────────────────────────────────────────── */

async function fetchFng(): Promise<FngMetrics | null> {
  try {
    const res = await httpRequest(FNG_URL, {
      vendor: 'alternative-me',
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 8_000,
      maxAttempts: 2,
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as FngPayload | null;
    return mapFngPayload(payload);
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'global-metrics: fear&greed fetch failed',
    );
    return null;
  }
}

async function fetchMcap(): Promise<McapMetrics | null> {
  try {
    const res = await httpRequest(COINGECKO_GLOBAL_URL, {
      vendor: 'coingecko',
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 8_000,
      maxAttempts: 2,
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as CoinGeckoGlobalPayload | null;
    const mapped = mapGlobalPayload(payload, mcapSeries);
    if (mapped) pushMcapPoint(mapped.totalUsd);
    // Re-read the buffer AFTER the push so the fresh point is included.
    return mapped ? { ...mapped, series: [...mcapSeries] } : null;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'global-metrics: coingecko global fetch failed',
    );
    return null;
  }
}

/* ── self-warm loop ────────────────────────────────────────────────────── */
// The sparkline is only as good as the buffer. A lazy, unref'd 5-min interval
// keeps observations flowing once the first request arrives, so the series
// stays continuous through idle periods without needing a worker process.

let warmLoop: ReturnType<typeof setInterval> | null = null;

function ensureWarmLoop(): void {
  if (warmLoop || !features.markets) return;
  warmLoop = setInterval(() => {
    void fetchMcap();
  }, 5 * 60_000);
  warmLoop.unref?.();
}

/** Test hook — stops the warm loop so vitest doesn't hold the process open. */
export function _stopGlobalMetricsWarmLoopForTests(): void {
  if (warmLoop) clearInterval(warmLoop);
  warmLoop = null;
}

/* ── entrypoint ────────────────────────────────────────────────────────── */

export async function readGlobalMetrics(): Promise<GlobalMetrics> {
  ensureWarmLoop();
  const [fng, mcap] = await Promise.all([fetchFng(), fetchMcap()]);
  return { fng, mcap };
}

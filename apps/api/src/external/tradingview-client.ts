/**
 * Thin async wrapper around @mathieuc/tradingview — Mathieu2301's
 * unofficial Tradingview WS client (https://github.com/Mathieu2301/TradingView-API).
 *
 * Why this lives in `external/`: the library is a third-party socket emulator,
 * not a vendor we own. It can break if TV changes their protocol — failures
 * here MUST NOT crash anything. Every entry-point returns a Promise that
 * rejects with a tagged Error string the route layer can downgrade to a 502.
 *
 * Caveats:
 *   - Library has no TypeScript types; we narrow at the boundary.
 *   - Every call opens its own WS, waits for the first chart update, then
 *     closes. There is no shared persistent connection (KISS for now; revisit
 *     if call volume justifies pooling).
 *   - Tradingview's free tier may rate-limit at the IP level. Pair with the
 *     in-memory cache in routes/tv.ts to avoid hammering on hot symbols.
 */
import { createRequire } from 'node:module';

const requireTradingView = createRequire(import.meta.url);
const TradingView = requireTradingView('@mathieuc/tradingview') as { Client: new () => LooseRecord };
type TradingViewProtocol = {
  parseWSPacket: (payload: unknown) => unknown;
};
let tvProtocolPatched = false;

function toWsString(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof Buffer !== 'undefined') {
    if (payload instanceof ArrayBuffer) {
      return Buffer.from(payload).toString('utf8');
    }
    if (ArrayBuffer.isView(payload)) {
      const view = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      return Buffer.from(view).toString('utf8');
    }
    if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  }
  return String(payload);
}

function patchTradingViewProtocolParser(): void {
  if (tvProtocolPatched) return;
  let protocol: TradingViewProtocol | null;
  try {
    protocol = requireTradingView('@mathieuc/tradingview/src/protocol') as TradingViewProtocol;
  } catch {
    protocol = null;
  }
  if (!protocol || typeof protocol.parseWSPacket !== 'function') return;
  const original = protocol.parseWSPacket;
  protocol.parseWSPacket = (payload: unknown): unknown => original(toWsString(payload));
  tvProtocolPatched = true;
}

interface TvPeriod {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TvCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TvSymbolInfo {
  description: string;
  exchange: string;
  short_name: string;
  type: string;
  currency_id: string;
  pricescale: number;
  minmov: number;
}

export interface TvSnapshot {
  symbol: string;
  timeframe: string;
  infos: TvSymbolInfo;
  candles: TvCandle[];
}

const DEFAULT_TIMEOUT_MS = 15_000;

type LooseRecord = Record<string, unknown> & { [k: string]: any };

function safeInfos(infos: LooseRecord | undefined): TvSymbolInfo {
  return {
    description: typeof infos?.description === 'string' ? infos.description : '',
    exchange: typeof infos?.exchange === 'string' ? infos.exchange : '',
    short_name: typeof infos?.short_name === 'string' ? infos.short_name : '',
    type: typeof infos?.type === 'string' ? infos.type : '',
    currency_id: typeof infos?.currency_id === 'string' ? infos.currency_id : '',
    pricescale: typeof infos?.pricescale === 'number' ? infos.pricescale : 100,
    minmov: typeof infos?.minmov === 'number' ? infos.minmov : 1,
  };
}

export async function fetchTradingViewSnapshot(
  symbol: string,
  timeframe = 'D',
  range = 200,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TvSnapshot> {
  patchTradingViewProtocolParser();
  return new Promise<TvSnapshot>((resolve, reject) => {
    let done = false;
    let client: LooseRecord;
    let chart: LooseRecord;
    try {
      client = new TradingView.Client() as LooseRecord;
      chart = new client.Session.Chart() as LooseRecord;
    } catch (e) {
      reject(new Error(`tv_init_failed: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    const cleanup = () => {
      try { (chart.delete as () => void)(); } catch { /* ignore */ }
      try { (client.end as () => void)(); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('tv_timeout'));
    }, timeoutMs);

    (chart.onError as (cb: (...err: unknown[]) => void) => void)((...err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`tv_error: ${err.map((e) => String(e)).join(' ')}`));
    });

    (chart.onUpdate as (cb: () => void) => void)(() => {
      if (done) return;
      const periods = (chart.periods as TvPeriod[] | undefined) ?? [];
      if (periods.length === 0) return;
      done = true;
      clearTimeout(timer);
      const cut = periods.slice(-range).map<TvCandle>((p) => ({
        time: Number(p.time),
        open: Number(p.open),
        high: Number(p.high),
        low: Number(p.low),
        close: Number(p.close),
        volume: Number(p.volume),
      }));
      const infos = safeInfos(chart.infos as LooseRecord | undefined);
      const result: TvSnapshot = { symbol, timeframe, infos, candles: cut };
      cleanup();
      resolve(result);
    });

    try {
      (chart.setMarket as (sym: string, opts: { timeframe: string; range?: number }) => void)(symbol, {
        timeframe,
        range,
      });
    } catch (e) {
      done = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`tv_setMarket_failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

export async function fetchTradingViewQuote(symbol: string, timeoutMs = 10_000) {
  const snap = await fetchTradingViewSnapshot(symbol, 'D', 1, timeoutMs);
  const last = snap.candles.at(-1);
  return {
    symbol,
    description: snap.infos.description,
    exchange: snap.infos.exchange,
    currency: snap.infos.currency_id,
    price: last?.close ?? null,
    asOf: last?.time ?? null,
  };
}

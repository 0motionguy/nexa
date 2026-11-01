/**
 * TradingView realtime venue — REST-snapshot-only.
 *
 * Wraps the existing `@mathieuc/tradingview` proxy at
 * `external/tradingview-client.ts` (Mathieu2301's unofficial TradingView WS
 * scraper) and exposes it as a `RealtimeAdapter`. Unlike the four streaming
 * venues, this adapter has NO upstream socket of its own:
 *
 *   - `subscribe(topic)`     — accepted bookkeeping only; nothing opens.
 *   - `unsubscribe(topic)`   — bookkeeping only.
 *   - `snapshot(topic)`      — the actual work; one TradingView WS session
 *                              is opened per call, candles pulled, session
 *                              closed. Cached at the route level for the
 *                              hub's last-known seed.
 *   - `healthSnapshot()`     — always `ws:'closed', upstream:'rest'` so the
 *                              health summarizer is honest about the path.
 *
 * Why no live stream:
 *   TradingView rate-limits per-IP heavily and breaks its protocol every
 *   few months. A pod-wide singleton WS scrape would last weeks at best.
 *   The existing route already uses TV as a polled REST source (with a
 *   cache); this adapter folds that into the hub so consumers can ask via
 *   topic instead of via `/tv/snapshot`.
 *
 * Topics handled (parsed by `topic.ts`):
 *   candle:tv:<EXCHANGE.TICKER>:<interval>   e.g. candle:tv:NASDAQ.AAPL:1d
 *   ticker:tv:<EXCHANGE.TICKER>              e.g. ticker:tv:FX.EURUSD
 *   stock:tv:<EXCHANGE.TICKER>               same as ticker but kind='stock'
 *
 * Symbol grammar:
 *   The topic grammar disallows `:` inside the symbol (it's the separator).
 *   TV's native symbol form is `EXCHANGE:TICKER` — we use `.` in topics
 *   and translate to `:` at the adapter boundary. So `NASDAQ.AAPL` ↔
 *   `NASDAQ:AAPL` on the upstream call. Symbols without exchange prefix
 *   (e.g. `AAPL`) are passed through verbatim — TradingView resolves them.
 *
 * Where this lives in the venue stack:
 *   Pyth covers ~80 US equities + blue-chip crypto for free WS.
 *   HL covers perps + HL spot + HIP-3 stocks.
 *   Polymarket covers predictions.
 *   Helius covers long-tail SOL memes via pool reads.
 *   TV covers the gaps: forex pairs, indices, commodities, long-tail
 *   stocks Pyth doesn't index. The chart package uses this venue when no
 *   other adapter can satisfy the symbol.
 */

import { CircuitBreaker } from '../breaker.js';
import { log } from '../../lib/log.js';
import {
  fetchTradingViewQuote,
  fetchTradingViewSnapshot,
} from '../../external/tradingview-client.js';
import {
  feedBreakerState,
  hubMessagesInTotal,
  snapshotFillDurationMs,
} from '../metrics.js';
import { parse } from '../topic.js';
import type { Hub } from '../hub.js';
import type {
  CandleEvent,
  FeedEvent,
  Interval,
  RealtimeAdapter,
  TickEvent,
  Topic,
  VenueHealth,
} from '../types.js';

const VENUE = 'tv' as const;

/**
 * Map the project's `Interval` codes to TradingView's timeframe argument.
 * Unsupported intervals (8h, currently 3d) return `null` so the snapshot
 * call short-circuits with an empty payload instead of asking TV for a
 * timeframe it doesn't accept.
 */
const INTERVAL_TO_TV: Readonly<Record<Interval, string | null>> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '8h': null,   // TradingView does not offer an 8-hour timeframe
  '12h': '720',
  '1d': 'D',
  '3d': null,   // dropped to avoid lossy resampling — callers should use 1d
  '1w': 'W',
  '1M': 'M',
};

/**
 * Topic symbols use `.` as the exchange separator (`NASDAQ.AAPL`) because
 * `:` is the topic delimiter. The adapter rewrites them back to TV's
 * native `EXCHANGE:TICKER` form before calling the helper.
 */
function toTradingViewSymbol(topicSymbol: string): string {
  return topicSymbol.includes('.') ? topicSymbol.replace('.', ':') : topicSymbol;
}

export class TradingViewRealtimeAdapter implements RealtimeAdapter {
  readonly venue = VENUE;
  private readonly refs = new Map<Topic, number>();
  private hub: Hub | null = null;
  private lastEventTs: number = -1;
  private readonly breaker: CircuitBreaker;

  constructor() {
    this.breaker = new CircuitBreaker({
      failureThreshold: 5,
      windowMs: 30_000,
      baseCooldownMs: 30_000,
      maxCooldownMs: 5 * 60_000,
      onOpen: () => feedBreakerState.set({ venue: VENUE }, 2),
      onHalfOpen: () => feedBreakerState.set({ venue: VENUE }, 1),
      onClose: () => feedBreakerState.set({ venue: VENUE }, 0),
    });
    feedBreakerState.set({ venue: VENUE }, 0);
  }

  async start(hub: Hub): Promise<void> {
    this.hub = hub;
  }

  async stop(): Promise<void> {
    this.breaker.dispose();
    this.refs.clear();
    this.hub = null;
  }

  subscribe(topic: Topic): void {
    this.refs.set(topic, (this.refs.get(topic) ?? 0) + 1);
  }

  unsubscribe(topic: Topic): void {
    const prev = this.refs.get(topic) ?? 0;
    if (prev <= 1) this.refs.delete(topic);
    else this.refs.set(topic, prev - 1);
  }

  /**
   * Pull a fresh snapshot from TradingView. The hub caches the result on
   * `lastByTopic` so reconnects + cold-start clients reuse it without
   * re-hitting TV. Failures route through the breaker.
   */
  async snapshot(topic: Topic): Promise<FeedEvent[]> {
    if (this.breaker.isOpen()) return [];
    const parsed = parse(topic);
    if (!parsed || parsed.venue !== VENUE) return [];

    const end = snapshotFillDurationMs.startTimer({ venue: VENUE });
    try {
      const sym = toTradingViewSymbol(parsed.symbol);

      if (parsed.kind === 'candle') {
        if (!parsed.interval) return [];
        const tvTimeframe = INTERVAL_TO_TV[parsed.interval];
        if (!tvTimeframe) {
          log.warn({ topic, interval: parsed.interval }, 'tv:interval-unsupported');
          return [];
        }
        const snap = await fetchTradingViewSnapshot(sym, tvTimeframe, 200);
        const now = Date.now();
        const candles: CandleEvent[] = snap.candles.map((p) => ({
          t: 'candle' as const,
          topic,
          ts: Number(p.time) * 1000,
          lastTickAgeMs: Math.max(0, now - Number(p.time) * 1000),
          src: VENUE,
          o: p.open,
          h: p.high,
          l: p.low,
          c: p.close,
          v: p.volume,
          closed: true,
        }));
        this.lastEventTs = now;
        this.breaker.noteSuccess();
        hubMessagesInTotal.inc({ venue: VENUE, topic_kind: 'candle' }, candles.length);
        return candles;
      }

      if (parsed.kind === 'ticker' || parsed.kind === 'stock') {
        const q = await fetchTradingViewQuote(sym);
        if (q.price == null || q.asOf == null) return [];
        const ts = Number(q.asOf) * 1000;
        const event: TickEvent = {
          t: 'tick',
          topic,
          ts,
          lastTickAgeMs: Math.max(0, Date.now() - ts),
          src: VENUE,
          px: q.price,
        };
        this.lastEventTs = Date.now();
        this.breaker.noteSuccess();
        hubMessagesInTotal.inc({ venue: VENUE, topic_kind: parsed.kind }, 1);
        return [event];
      }

      // `book` / `trades` / `meme` / `predictions` aren't TV's job.
      return [];
    } catch (err) {
      this.breaker.noteFailure();
      log.warn({ topic, err }, 'tv:snapshot-failed');
      return [];
    } finally {
      end();
    }
  }

  healthSnapshot(): VenueHealth {
    let subs = 0;
    for (const n of this.refs.values()) subs += n;
    return {
      // TradingView has no live WS we own — REST-only by design.
      ws: 'closed',
      breakerState: this.breaker.getState(),
      lastEventAgeMs: this.lastEventTs < 0 ? -1 : Math.max(0, Date.now() - this.lastEventTs),
      subscriberCount: subs,
      upstream: 'rest',
    };
  }
}

let cached: TradingViewRealtimeAdapter | null = null;

export function getTradingViewRealtimeAdapter(): TradingViewRealtimeAdapter {
  if (!cached) cached = new TradingViewRealtimeAdapter();
  return cached;
}

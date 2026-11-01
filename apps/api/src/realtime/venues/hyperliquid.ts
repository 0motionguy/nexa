/**
 * Hyperliquid realtime adapter — owns the SOLE upstream WebSocket per pod
 * (`wss://api.hyperliquid.xyz/ws`), demultiplexes upstream channels, and
 * publishes normalized `FeedEvent`s into the central `Hub`.
 *
 * Sibling to the per-request `HyperliquidAdapter` at
 * `lib/markets/hyperliquid.ts`: that one is short-lived REST for order
 * placement and market reads; this one is long-lived pub/sub. Both share the
 * REST helpers via the singleton `hyperliquid` instance — this file reuses
 * `getAllMids` / `getCandles` / `getL2Book` / `getRecentTrades` for the
 * cold-start `snapshot()` path and never duplicates upstream wire formats.
 *
 * Topics handled here (parsed by `topic.ts`, format `<kind>:hl:<sym>[:<p>]`):
 *
 *   ticker:hl:<COIN>          → upstream { type: "allMids" }, emit one
 *                                TickEvent per coin whose mid moved
 *   candle:hl:<COIN>:<i>      → upstream { type: "candle", coin, interval }
 *   book:hl:<COIN>:<depth>    → upstream { type: "l2Book", coin }
 *   trades:hl:<COIN>          → upstream { type: "trades", coin }
 *
 * WS-everywhere policy:
 *   The steady-state path is the single upstream WS. REST is reserved for
 *   `snapshot()` (cold-start seed delivered by the hub to newly-connected
 *   clients) and the breaker-open path (one synthetic stale TickEvent per
 *   active ticker topic so the UI dims immediately and stops trusting
 *   stale prices).
 *
 * Lifecycle:
 *   `start(hub)`     — register breaker; do NOT eagerly open the WS.
 *                      The first `subscribe()` triggers `ensureOpen()` so
 *                      idle pods don't hold a socket.
 *   `subscribe()`    — ref-count++, emits upstream subscribe on 0→1.
 *   `unsubscribe()`  — ref-count--, emits upstream unsubscribe on 1→0.
 *   `snapshot()`     — REST one-shot fill; returns events the hub caches.
 *   `stop()`         — close WS, dispose breaker, clear timers, no throws.
 *
 * Reconnect: exponential backoff 1s → 2s → 4s → 8s → 16s → 30s cap, reset
 * on a successful open. Every active upstream sub is re-emitted on re-open.
 *
 * Breaker: 5 errors in 30s → open. base cooldown 30s, max 5min.
 * - onOpen   : emit one `TickEvent{stale:true, src:'rest'}` per active
 *              ticker topic from the cached last-known so the UI dims.
 * - onClose  : back to normal; next message is a fresh tick.
 */

import { CircuitBreaker } from '../breaker.js';
import { StallWatchdog } from '../stall-watchdog.js';
import {
  feedBreakerState,
  feedDisconnectTotal,
  feedReconnectAttemptsTotal,
  feedTickLagMs,
  hubMessagesInTotal,
  snapshotFillDurationMs,
} from '../metrics.js';
import { parse } from '../topic.js';
import type {
  BookEvent,
  BookLevel,
  CandleEvent,
  FeedEvent,
  Interval,
  RealtimeAdapter,
  TickEvent,
  Topic,
  TradeEvent,
  VenueHealth,
} from '../types.js';
import type { Hub } from '../hub.js';
import { hyperliquid } from '../../lib/markets/hyperliquid.js';
import { HL_WS_URL } from '../../lib/markets/hl-config.js';
import { log } from '../../lib/log.js';

/* ── upstream wire shapes (narrow `unknown` against these) ────────────────── */

interface UpstreamFrame {
  channel?: string;
  data?: unknown;
}

interface AllMidsData {
  mids?: Record<string, string>;
}

interface CandleData {
  s: string;     // symbol
  i: string;     // interval
  t: number;     // open time (ms)
  T: number;     // close time (ms)
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

interface L2BookData {
  coin: string;
  time?: number;
  seqNum?: number;
  levels?: ReadonlyArray<ReadonlyArray<{ px: string; sz: string; n?: number }>>;
}

interface TradeRow {
  coin: string;
  side: 'A' | 'B';   // 'A' = aggressor was the seller (ask hit), 'B' = aggressor was buyer (bid lifted)
  px: string;
  sz: string;
  time: number;
  hash?: string;
  tid?: number;
}

/* ── constants ────────────────────────────────────────────────────────────── */

const VENUE = 'hl' as const;
const WS_URL = HL_WS_URL;

/** Exponential backoff sequence in ms, capped at 30s. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * HL closes any connection with no CLIENT-inbound message for 60s — measured
 * exactly (60.000s open→close cycle, r6 diagnostic 2026-07-16). Server→client
 * data frames do not reset that clock; only client traffic does. Ping at half
 * the deadline. The `pong` branch in handleFrame is the (previously dead)
 * reply path.
 */
const PING_INTERVAL_MS = 30_000;

/** Breaker tunables — 5 errors in 30s → open, 30s base cooldown, 5min cap. */
const BREAKER_OPTS = {
  failureThreshold: 5,
  windowMs: 30_000,
  baseCooldownMs: 30_000,
  maxCooldownMs: 5 * 60_000,
} as const;

/** prom-client gauge mapping for the breaker state. */
const BREAKER_STATE_GAUGE: Record<'closed' | 'half-open' | 'open', number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/* ── adapter ──────────────────────────────────────────────────────────────── */

type WsState = 'open' | 'connecting' | 'reconnecting' | 'closed' | 'open-degraded';

interface ParsedHlTopic {
  topic: Topic;
  kind: 'ticker' | 'candle' | 'book' | 'trades';
  coin: string;
  interval?: Interval;
  depth?: number;
}

/**
 * One instance per process — registered with the hub before `hub.start()`.
 * Holds the ONLY upstream WS to api.hyperliquid.xyz.
 */
export class HyperliquidRealtimeAdapter implements RealtimeAdapter {
  readonly venue = VENUE;

  private hub: Hub | null = null;
  private ws: WebSocket | null = null;
  private wsState: WsState = 'closed';

  /** topic → ref count. Sole source of truth for upstream sub/unsub. */
  private readonly refs = new Map<Topic, number>();
  /** topic → parsed form, cached so we don't re-parse on every event. */
  private readonly parsedByTopic = new Map<Topic, ParsedHlTopic>();

  /** Last tick price per coin — used to deduplicate allMids broadcasts. */
  private readonly lastMidByCoin = new Map<string, number>();

  /**
   * Distinct ticker topics currently referenced. allMids is ONE shared
   * upstream channel: subscribe when this rises 0→1, unsubscribe only when
   * it falls back to 0. Before this counter existed, EVERY ticker topic
   * whose per-topic refcount hit zero sent a global allMids unsubscribe and
   * silently killed tick flow for every still-referenced ticker topic
   * (gate-1 r4 zero-tick incident, 2026-07-15).
   */
  private tickerTopicCount = 0;

  /** Last event timestamp on any topic (epoch ms). -1 until first event. */
  private lastEventAt = -1;

  /**
   * Last connection ATTEMPT (epoch ms). Feeds the stall watchdog as a grace
   * anchor — a fresh/reconnecting socket is judged from `max(lastEventAt,
   * lastOpenAt)`, never from pre-open silence (r6: a stale lastEventAt from
   * the idle period tripped the watchdog ~1s after a healthy open and
   * silently closed it). Kept SEPARATE from lastEventAt so healthSnapshot
   * and the r4 rule — only real event channels advance the event clock —
   * stay exact. Anchoring at attempt (not onopen) doubles as a 15s connect
   * timeout: a socket wedged in CONNECTING gets stall-closed + reconnected.
   */
  private lastOpenAt = -1;

  /**
   * Last frame on the allMids channel SPECIFICALLY (epoch ms). The socket
   * watchdog's clock advances on ANY event channel, so flowing trades mask a
   * dead allMids subscription (r7 probe: 7 ticks then 79.7s of silence with
   * 308 live trades and zero socket closes). allMids is constant-rate by
   * design (~20Hz whenever HL lists anything), so channel silence with an
   * active ticker ref is a subscription-level failure even while the socket
   * is demonstrably alive — it gets its own clock and its own watchdog.
   */
  private lastAllMidsAt = -1;
  /**
   * Epoch ms of the last in-place allMids resubscribe attempt; -1 when the
   * ladder is reset. Doubles as the escalation flag: a stall with this set
   * means the cheap fix already had one full stall budget and failed → the
   * next rung is a socket recycle. Cleared by the next allMids frame and on
   * every fresh socket.
   */
  private allMidsResubAt = -1;

  /** Reconnect bookkeeping. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Monotonic socket id — carried on every lifecycle log line so overlapping
   * sockets (r6: double-open) are attributable in forensics.
   */
  private socketSeq = 0;
  /** Keepalive against HL's 60s client-inbound idle kill. Per-socket. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Circuit breaker — wired so breaker.open switches `upstream` to 'rest'. */
  private readonly breaker = new CircuitBreaker({
    failureThreshold: BREAKER_OPTS.failureThreshold,
    windowMs: BREAKER_OPTS.windowMs,
    baseCooldownMs: BREAKER_OPTS.baseCooldownMs,
    maxCooldownMs: BREAKER_OPTS.maxCooldownMs,
    onOpen: () => this.onBreakerOpen(),
    onHalfOpen: () => this.onBreakerHalfOpen(),
    onClose: () => this.onBreakerClose(),
  });

  /** Which upstream is currently producing events. */
  private upstream: 'primary' | 'rest' = 'primary';

  /**
   * Stall watchdog: closes the "TCP-alive-but-no-events" gap. HL's allMids
   * runs ~20Hz on a healthy upstream; 15s of silence on an actively-
   * subscribed feed is a stall. Force-trips the breaker via N consecutive
   * `noteFailure()` so it actually opens (threshold is 5).
   */
  private readonly stallWatchdog = new StallWatchdog({
    stallMs: 15_000,
    checkMs: 5_000,
    hasActiveSubs: () => this.refs.size > 0,
    // Effective stall clock = last real event OR last connection attempt,
    // whichever is newer (grace for fresh sockets; see lastOpenAt).
    getLastEventAt: () => Math.max(this.lastEventAt, this.lastOpenAt),
    onStall: () => {
      log.warn(
        { ageMs: Date.now() - Math.max(this.lastEventAt, this.lastOpenAt) },
        'hl-rt: stall detected',
      );
      this.escalateStall();
    },
  });

  /**
   * allMids channel watchdog — closes the r7 gap (2026-07-16): the socket
   * watchdog keys on ANY event channel, so live trades masked a dead allMids
   * subscription indefinitely. Gated on ticker refs + an open socket; the
   * whole-socket cases (dead socket, wedged CONNECTING) stay owned by
   * `stallWatchdog` above. Ladder: in-place resubscribe first (cheap, no
   * churn, keeps sibling channels' frames flowing); if allMids is still
   * silent one full stall budget later, recycle the socket via the shared
   * escalation path.
   */
  private readonly allMidsWatchdog = new StallWatchdog({
    stallMs: 15_000,
    checkMs: 5_000,
    hasActiveSubs: () => this.tickerTopicCount > 0 && this.wsState === 'open',
    // Clock: last allMids frame OR connection attempt (fresh-socket grace)
    // OR last resub attempt (gives the cheap rung its own full budget).
    getLastEventAt: () => Math.max(this.lastAllMidsAt, this.lastOpenAt, this.allMidsResubAt),
    onStall: () => {
      const base = Math.max(this.lastAllMidsAt, this.lastOpenAt);
      if (this.allMidsResubAt < 0) {
        this.allMidsResubAt = Date.now();
        log.warn(
          { ageMs: Date.now() - base, trades: 'flowing-or-idle' },
          'hl-rt: allMids channel stall — resubscribing in place',
        );
        // unsubscribe→subscribe: HL treats a duplicate subscribe as a no-op
        // ack on some gateways; the explicit teardown forces server-side
        // re-registration either way. Both are silent no-ops if the socket
        // raced shut between the gate check and here.
        this.sendJson({ method: 'unsubscribe', subscription: { type: 'allMids' } });
        this.sendJson({ method: 'subscribe', subscription: { type: 'allMids' } });
        return;
      }
      log.warn(
        { resubAgeMs: Date.now() - this.allMidsResubAt, ageMs: Date.now() - base },
        'hl-rt: allMids still silent after in-place resubscribe — recycling socket',
      );
      this.escalateStall();
    },
  });

  /**
   * Shared stall escalation — socket recycle + self-scheduled reconnect +
   * guarded breaker trip. Ordering is load-bearing (spec T3): recovery
   * actions run BEFORE the breaker trip because onBreakerOpen executes
   * hub/telemetry code synchronously inside noteFailure() and a throw there
   * used to strand the stalled socket with no reconnect.
   */
  private escalateStall(): void {
    // Force-close the socket — keeping it open while breaker is "open"
    // confuses the upstream tag in healthSnapshot and lets stale frames
    // continue to arrive if the upstream eventually wakes up.
    this.closeSocket('stall');
    // Recovery must not depend on incidental subscribe churn: with steady
    // subscribers and no churn, a stalled feed stayed dead until the next
    // organic subscribe() (r6 finding). Reopen on the standard backoff.
    if (this.refs.size > 0) this.scheduleReconnect();
    try {
      for (let i = 0; i < BREAKER_OPTS.failureThreshold; i++) this.breaker.noteFailure();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'hl-rt: breaker trip threw');
    }
  }

  /* ── lifecycle ──────────────────────────────────────────────────────────── */

  async start(hub: Hub): Promise<void> {
    this.hub = hub;
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.closed);
    this.stallWatchdog.start();
    this.allMidsWatchdog.start();
    // Lazy WS open — first subscribe() opens the socket.
  }

  async stop(): Promise<void> {
    this.stallWatchdog.stop();
    this.allMidsWatchdog.stop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.breaker.dispose();
    this.closeSocket('shutdown');
    this.refs.clear();
    this.parsedByTopic.clear();
    this.lastMidByCoin.clear();
    this.tickerTopicCount = 0;
    this.hub = null;
  }

  /* ── subscribe / unsubscribe (hub-facing) ───────────────────────────────── */

  subscribe(topic: Topic): void {
    const parsed = this.parseOrNull(topic);
    if (!parsed) return;

    const prev = this.refs.get(topic) ?? 0;
    this.refs.set(topic, prev + 1);
    if (prev === 0) {
      this.parsedByTopic.set(topic, parsed);
      this.ensureOpen();
      if (parsed.kind === 'ticker') {
        // allMids covers every coin — subscribe upstream only for the first
        // ticker topic; later ticker topics just join the existing stream.
        this.tickerTopicCount += 1;
        if (this.tickerTopicCount === 1) this.sendUpstreamSubscribe(parsed);
      } else {
        this.sendUpstreamSubscribe(parsed);
      }
    }
  }

  unsubscribe(topic: Topic): void {
    const prev = this.refs.get(topic) ?? 0;
    if (prev <= 0) return;
    const next = prev - 1;
    if (next > 0) {
      this.refs.set(topic, next);
      return;
    }
    this.refs.delete(topic);
    const parsed = this.parsedByTopic.get(topic);
    this.parsedByTopic.delete(topic);
    if (!parsed) return;
    if (parsed.kind === 'ticker') {
      // Shared channel: only the LAST ticker topic tears allMids down.
      this.tickerTopicCount = Math.max(0, this.tickerTopicCount - 1);
      if (this.tickerTopicCount === 0) this.sendUpstreamUnsubscribe(parsed);
      return;
    }
    this.sendUpstreamUnsubscribe(parsed);
  }

  /* ── snapshot (REST cold-start fill) ────────────────────────────────────── */

  async snapshot(topic: Topic): Promise<FeedEvent[]> {
    const parsed = this.parseOrNull(topic);
    if (!parsed) return [];
    const endTimer = snapshotFillDurationMs.startTimer({ venue: VENUE });
    try {
      switch (parsed.kind) {
        case 'ticker':  return await this.snapshotTicker(parsed);
        case 'candle':  return await this.snapshotCandle(parsed);
        case 'book':    return await this.snapshotBook(parsed);
        case 'trades':  return await this.snapshotTrades(parsed);
      }
    } catch (err) {
      log.warn({ err: errMsg(err), topic }, 'hl-rt: snapshot failed');
      return [];
    } finally {
      endTimer();
    }
  }

  /* ── health ─────────────────────────────────────────────────────────────── */

  healthSnapshot(): VenueHealth {
    let total = 0;
    for (const n of this.refs.values()) total += n;
    return {
      ws: this.wsState,
      breakerState: this.breaker.getState(),
      lastEventAgeMs: this.lastEventAt < 0 ? -1 : Math.max(0, Date.now() - this.lastEventAt),
      subscriberCount: total,
      upstream: this.upstream,
    };
  }

  /* ── WS plumbing ────────────────────────────────────────────────────────── */

  private ensureOpen(): void {
    if (this.ws || this.wsState === 'connecting') return;
    // 'reconnecting' is only genuinely in-flight while a backoff timer is
    // pending. A stale 'reconnecting' with no timer (ctor threw while refs
    // was momentarily 0) must not block reopening forever.
    if (this.wsState === 'reconnecting' && this.reconnectTimer) return;
    this.openSocket();
  }

  private openSocket(): void {
    this.wsState = this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
    const sid = ++this.socketSeq;
    const openedAt = Date.now();
    this.lastOpenAt = openedAt;
    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch (err) {
      log.warn({ err: errMsg(err), sid }, 'hl-rt: WebSocket constructor threw');
      this.handleSocketFailure('ctor');
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) {
        // Superseded before the handshake finished — close the orphan
        // actively instead of leaving it to HL's idle reaper.
        log.info({ sid }, 'hl-rt: stale socket open — closing');
        try { socket.close(1000, 'superseded'); } catch { /* best-effort */ }
        return;
      }
      this.wsState = 'open';
      this.reconnectAttempt = 0;
      // Fresh socket ⇒ fresh escalation ladder. lastAllMidsAt stays untouched
      // (mirrors the lastEventAt rule); grace comes from lastOpenAt.
      this.allMidsResubAt = -1;
      // Fresh-socket grace is anchored on lastOpenAt (set at connection
      // attempt in openSocket) — lastEventAt stays untouched here so the
      // r4 rule and healthSnapshot's "-1 until first real event" hold.
      this.startPing(socket);
      log.info(
        { sid, topics: this.parsedByTopic.size, tickerTopics: this.tickerTopicCount },
        'hl-rt: upstream open',
      );
      // Re-arm every active upstream subscription — allMids exactly once
      // (shared channel), per-coin channels once per parsed topic.
      let allMidsSent = false;
      for (const parsed of this.parsedByTopic.values()) {
        if (parsed.kind === 'ticker') {
          if (!allMidsSent) {
            this.sendUpstreamSubscribe(parsed);
            allMidsSent = true;
          }
          continue;
        }
        this.sendUpstreamSubscribe(parsed);
      }
      this.breaker.noteSuccess();
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (this.ws !== socket) return; // orphan frames must not touch live state
      this.handleFrame(ev.data);
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      // The close handler runs immediately after — let it handle reconnect.
      this.breaker.noteFailure();
    };

    socket.onclose = (ev) => {
      const code = (ev as WsCloseLike).code;
      const reason = describeCloseReason(ev as WsCloseLike);
      if (this.ws !== socket) {
        // An orphaned socket (already replaced) finished dying. NEVER touch
        // live state from here — r5/r6 flap: this exact clobber (`this.ws =
        // null` + reconnect scheduled on top of a healthy replacement)
        // self-sustained a ~1s open/close metronome under load.
        log.info(
          { sid, code, reason, aliveMs: Date.now() - openedAt },
          'hl-rt: stale socket closed',
        );
        return;
      }
      this.stopPing();
      feedDisconnectTotal.inc({ venue: VENUE, reason });
      // r4 lesson: this path was logless — a 2-minute upstream outage left
      // zero log evidence. Metrics alone don't survive a container restart.
      // NB: undici reports even a local clean close() as code 1006 — log the
      // code, but never read "abnormal" as proof of a remote drop (r6).
      log.warn(
        {
          sid,
          code,
          reason,
          aliveMs: Date.now() - openedAt,
          refs: this.refs.size,
          willReconnect: this.refs.size > 0,
        },
        'hl-rt: upstream closed',
      );
      this.ws = null;
      // Only schedule reconnect if there are still active topics; otherwise
      // stay quiet — `ensureOpen()` reopens on next subscribe.
      if (this.refs.size === 0) {
        this.wsState = 'closed';
        return;
      }
      this.scheduleReconnect();
    };
  }

  private closeSocket(reason: string): void {
    this.stopPing();
    const socket = this.ws;
    // Null the ref FIRST: the socket's own onclose then takes the
    // stale-socket branch (logged, no state clobber) instead of the old
    // detach-and-die-invisibly path — r6: silent stall-closes left zero
    // evidence and made the double-open unattributable for two runs.
    this.ws = null;
    this.wsState = 'closed';
    if (!socket) return;
    try {
      socket.close(1000, reason);
    } catch {
      // Best-effort close — ignore.
    }
  }

  /**
   * Keepalive against HL's 60s client-inbound idle kill (see
   * PING_INTERVAL_MS). Bound to one socket: a superseded socket's timer
   * self-cancels instead of pinging through a stale reference.
   */
  private startPing(socket: WebSocket): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws !== socket) {
        this.stopPing();
        return;
      }
      this.sendJson({ method: 'ping' });
    }, PING_INTERVAL_MS);
    (this.pingTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx];
    this.reconnectAttempt++;
    this.wsState = 'reconnecting';
    feedReconnectAttemptsTotal.inc({ venue: VENUE });
    log.info({ attempt: this.reconnectAttempt, delayMs: delay }, 'hl-rt: reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private handleSocketFailure(kind: string): void {
    this.breaker.noteFailure();
    if (this.refs.size > 0) {
      this.scheduleReconnect();
      return;
    }
    // No active topics: park the state machine CLOSED. Leaving wsState at
    // 'connecting'/'reconnecting' with no pending timer makes ensureOpen()
    // treat the socket as in-flight forever — a permanent wedge that only a
    // process restart clears.
    log.warn({ kind }, 'hl-rt: socket failure with no active topics — parking closed');
    this.wsState = 'closed';
  }

  /**
   * Send `{method:'subscribe', subscription:{...}}` for one parsed topic.
   * Silent if the WS isn't open — the onopen handler replays from `parsedByTopic`.
   */
  private sendUpstreamSubscribe(parsed: ParsedHlTopic): void {
    const sub = this.toUpstreamSub(parsed);
    if (!sub) return;
    this.sendJson({ method: 'subscribe', subscription: sub });
  }

  private sendUpstreamUnsubscribe(parsed: ParsedHlTopic): void {
    const sub = this.toUpstreamSub(parsed);
    if (!sub) return;
    this.sendJson({ method: 'unsubscribe', subscription: sub });
  }

  private toUpstreamSub(parsed: ParsedHlTopic): Record<string, unknown> | null {
    switch (parsed.kind) {
      case 'ticker':  return { type: 'allMids' };
      case 'candle':  return { type: 'candle', coin: parsed.coin, interval: parsed.interval };
      case 'book':    return { type: 'l2Book', coin: parsed.coin };
      case 'trades':  return { type: 'trades', coin: parsed.coin };
    }
  }

  private sendJson(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'hl-rt: WS send failed');
      this.breaker.noteFailure();
    }
  }

  /* ── upstream frame demux ───────────────────────────────────────────────── */

  private handleFrame(raw: unknown): void {
    let parsed: UpstreamFrame;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as UpstreamFrame;
    } catch {
      return;
    }
    const channel = parsed?.channel;
    if (typeof channel !== 'string') return;
    const data = parsed.data;
    if (data == null) return;

    // Only real event channels feed the stall watchdog. subscriptionResponse
    // acks and pongs keep the TCP path warm while saying nothing about event
    // flow — counting them re-opens exactly the "alive but silent" gap the
    // watchdog exists to close (r4: allMids dead, pongs flowing, no stall).
    if (channel === 'allMids' || channel === 'candle' || channel === 'l2Book' || channel === 'trades') {
      this.lastEventAt = Date.now();
      if (channel === 'allMids') {
        // Channel-specific clock + ladder reset: one allMids frame proves the
        // subscription is live again, so the next stall starts back at the
        // cheap rung (in-place resubscribe), not at socket recycle.
        this.lastAllMidsAt = this.lastEventAt;
        this.allMidsResubAt = -1;
      }
    }

    switch (channel) {
      case 'allMids':       this.onAllMids(data); break;
      case 'candle':        this.onCandle(data); break;
      case 'l2Book':        this.onL2Book(data); break;
      case 'trades':        this.onTrades(data); break;
      case 'subscriptionResponse':
      case 'pong':
        // Acknowledgements / heartbeats — no event emission.
        break;
      default:
        // Unknown channel — quietly ignore; HL adds new ones over time.
        break;
    }
  }

  private onAllMids(data: unknown): void {
    const mids = (data as AllMidsData).mids;
    if (!mids || typeof mids !== 'object') return;
    const now = Date.now();
    for (const coin of Object.keys(mids)) {
      const topic = `ticker:hl:${coin}` as Topic;
      if (!this.refs.has(topic)) continue;
      const px = Number(mids[coin]);
      if (!Number.isFinite(px) || px <= 0) continue;
      const prev = this.lastMidByCoin.get(coin);
      if (prev === px) continue;
      this.lastMidByCoin.set(coin, px);
      const ev: TickEvent = {
        t: 'tick',
        topic,
        ts: now,
        lastTickAgeMs: 0,
        src: VENUE,
        px,
      };
      this.publish(ev, 'ticker');
    }
  }

  private onCandle(data: unknown): void {
    const c = data as Partial<CandleData>;
    if (typeof c?.s !== 'string' || typeof c?.i !== 'string') return;
    const interval = c.i as Interval;
    const topic = `candle:hl:${c.s}:${interval}` as Topic;
    if (!this.refs.has(topic)) return;
    const o = Number(c.o); const h = Number(c.h); const l = Number(c.l);
    const cl = Number(c.c); const v = Number(c.v);
    if (![o, h, l, cl, v].every(Number.isFinite)) return;
    const ts = Number(c.t) || Date.now();
    const closeT = Number(c.T) || ts;
    // Sanity guard against a hostile / clock-skewed upstream that ships a
    // candle with `t > T` (negative duration) or timestamps wildly out of
    // band. lightweight-charts sorts by `t`; a candle dated year 285,427
    // would scale the X-axis off-screen for every chart consuming this feed.
    const now = Date.now();
    if (ts > closeT) return;
    if (ts < now - 86_400_000 * 365 * 5) return;     // > 5 years stale = bogus
    if (ts > now + 60_000) return;                    // > 1min future = clock skew abuse
    if (closeT > now + 86_400_000) return;            // > 1 day future = malformed
    const ev: CandleEvent = {
      t: 'candle',
      topic,
      ts: closeT,
      lastTickAgeMs: Math.max(0, Date.now() - closeT),
      src: VENUE,
      o, h, l, c: cl, v,
      // HL semantics: when the candle update has reached the close-time, the
      // bucket is finalized. Live updates within the bucket still carry the
      // forward close-time; HL flips to a new (t, T) pair when a new bucket
      // opens. We treat T <= now as "closed" in the strictest sense.
      closed: closeT > 0 && closeT <= Date.now(),
    };
    this.publish(ev, 'candle');
  }

  private onL2Book(data: unknown): void {
    const b = data as Partial<L2BookData>;
    if (typeof b?.coin !== 'string' || !Array.isArray(b.levels) || b.levels.length < 2) return;
    // Match the requested depth from one of the active book topics. HL only
    // streams one l2Book per coin, regardless of depth — we fan out into
    // each subscribed depth bucket.
    const bids = mapLevels(b.levels[0]);
    const asks = mapLevels(b.levels[1]);
    const ts = Number(b.time) || Date.now();
    const seq = Number(b.seqNum) || 0;
    for (const [topic, parsed] of this.parsedByTopic) {
      if (parsed.kind !== 'book' || parsed.coin !== b.coin) continue;
      const depth = parsed.depth ?? bids.length;
      const ev: BookEvent = {
        t: 'book',
        topic,
        ts,
        lastTickAgeMs: Math.max(0, Date.now() - ts),
        src: VENUE,
        bids: bids.slice(0, depth),
        asks: asks.slice(0, depth),
        seq,
      };
      this.publish(ev, 'book');
    }
  }

  private onTrades(data: unknown): void {
    const rows = Array.isArray(data) ? (data as TradeRow[]) : null;
    if (!rows) return;
    for (const row of rows) {
      if (typeof row?.coin !== 'string') continue;
      const topic = `trades:hl:${row.coin}` as Topic;
      if (!this.refs.has(topic)) continue;
      const px = Number(row.px);
      const sz = Number(row.sz);
      const ts = Number(row.time) || Date.now();
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      // HL `side`: 'A' = ask side (aggressor sold) → tape side is 'sell';
      //           'B' = bid side (aggressor bought) → tape side is 'buy'.
      const side: 'buy' | 'sell' = row.side === 'B' ? 'buy' : 'sell';
      const ev: TradeEvent = {
        t: 'trade',
        topic,
        ts,
        lastTickAgeMs: Math.max(0, Date.now() - ts),
        src: VENUE,
        px, sz, side,
      };
      this.publish(ev, 'trades');
    }
  }

  /* ── snapshot helpers ───────────────────────────────────────────────────── */

  private async snapshotTicker(parsed: ParsedHlTopic): Promise<FeedEvent[]> {
    const mids = await hyperliquid.getAllMids();
    const raw = mids[parsed.coin];
    if (raw == null) return [];
    const px = Number(raw);
    if (!Number.isFinite(px) || px <= 0) return [];
    const now = Date.now();
    const ev: TickEvent = {
      t: 'tick',
      topic: parsed.topic,
      ts: now,
      lastTickAgeMs: 0,
      src: 'rest',
      px,
    };
    return [ev];
  }

  private async snapshotCandle(parsed: ParsedHlTopic): Promise<FeedEvent[]> {
    if (!parsed.interval) return [];
    const rows = await hyperliquid.getCandles(parsed.coin, parsed.interval);
    const out: CandleEvent[] = [];
    const now = Date.now();
    for (const r of rows) {
      const ts = Number(r.T) || Number(r.t) || now;
      out.push({
        t: 'candle',
        topic: parsed.topic,
        ts,
        lastTickAgeMs: Math.max(0, now - ts),
        src: 'rest',
        o: Number(r.o),
        h: Number(r.h),
        l: Number(r.l),
        c: Number(r.c),
        v: Number(r.v),
        closed: ts <= now,
      });
    }
    return out;
  }

  private async snapshotBook(parsed: ParsedHlTopic): Promise<FeedEvent[]> {
    const book = await hyperliquid.getL2Book(parsed.coin);
    if (!book?.levels || book.levels.length < 2) return [];
    const depth = parsed.depth ?? 50;
    const ts = Number(book.time) || Date.now();
    const ev: BookEvent = {
      t: 'book',
      topic: parsed.topic,
      ts,
      lastTickAgeMs: Math.max(0, Date.now() - ts),
      src: 'rest',
      bids: mapLevels(book.levels[0]).slice(0, depth),
      asks: mapLevels(book.levels[1]).slice(0, depth),
      seq: 0,
    };
    return [ev];
  }

  private async snapshotTrades(parsed: ParsedHlTopic): Promise<FeedEvent[]> {
    const rows = await hyperliquid.getRecentTrades(parsed.coin);
    const now = Date.now();
    const out: TradeEvent[] = [];
    for (const row of rows) {
      const px = Number(row.px);
      const sz = Number(row.sz);
      const ts = Number(row.time) || now;
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      out.push({
        t: 'trade',
        topic: parsed.topic,
        ts,
        lastTickAgeMs: Math.max(0, now - ts),
        src: 'rest',
        px, sz,
        side: row.side === 'B' ? 'buy' : 'sell',
      });
    }
    return out;
  }

  /* ── breaker transitions ────────────────────────────────────────────────── */

  private onBreakerOpen(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.open);
    this.upstream = 'rest';
    this.wsState = 'open-degraded';
    // Dim every active ticker topic so the UI greys out stale prices.
    if (!this.hub) return;
    const now = Date.now();
    for (const [topic, parsed] of this.parsedByTopic) {
      if (parsed.kind !== 'ticker') continue;
      // The whole body is guarded: onBreakerOpen fires synchronously inside
      // breaker.noteFailure(), so a throw here would propagate into whatever
      // tripped the breaker (onStall recovery, frame handlers). Stale-price
      // dimming is best-effort telemetry — it must never abort recovery.
      try {
        const last = this.hub.lastFor(topic);
        if (!last || last.t !== 'tick') continue;
        const ev: TickEvent = {
          t: 'tick',
          topic,
          ts: now,
          lastTickAgeMs: Math.max(0, now - last.ts),
          src: 'rest',
          stale: true,
          px: last.px,
        };
        this.hub.publish(ev);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'hl-rt: breaker-open stale emit failed');
      }
    }
  }

  private onBreakerHalfOpen(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE['half-open']);
    // Try the upstream again — the next successful frame closes the breaker.
    if (this.refs.size > 0) this.ensureOpen();
  }

  private onBreakerClose(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.closed);
    this.upstream = 'primary';
    if (this.ws && this.wsState === 'open-degraded') this.wsState = 'open';
  }

  /* ── publish helper ─────────────────────────────────────────────────────── */

  private publish(event: FeedEvent, kind: 'ticker' | 'candle' | 'book' | 'trades'): void {
    hubMessagesInTotal.inc({ venue: VENUE, topic_kind: kind });
    feedTickLagMs.observe({ venue: VENUE, topic_kind: kind }, event.lastTickAgeMs);
    if (!this.hub) return;
    try {
      this.hub.publish(event);
    } catch (err) {
      log.warn({ err: errMsg(err), topic: event.topic }, 'hl-rt: hub.publish threw');
    }
  }

  /* ── parse cache ────────────────────────────────────────────────────────── */

  private parseOrNull(topic: Topic): ParsedHlTopic | null {
    const cached = this.parsedByTopic.get(topic);
    if (cached) return cached;
    const p = parse(topic);
    if (!p || p.venue !== VENUE) return null;
    if (p.kind !== 'ticker' && p.kind !== 'candle' && p.kind !== 'book' && p.kind !== 'trades') {
      return null;
    }
    return {
      topic,
      kind: p.kind,
      coin: p.symbol,
      interval: p.interval,
      depth: p.depth,
    };
  }
}

/* ── pure helpers ─────────────────────────────────────────────────────────── */

function mapLevels(
  raw: ReadonlyArray<{ px: string; sz: string; n?: number }> | undefined,
): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const lvl of raw) {
    const px = Number(lvl?.px);
    const sz = Number(lvl?.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    out.push([px, sz] as const);
  }
  return out;
}

/**
 * Duck-typed shape we accept from socket.onclose payloads. Node 22's global
 * WebSocket close event isn't lib.dom.d.ts `CloseEvent`; we only read `code`,
 * so structural typing keeps us portable across both. Exported for the
 * sibling user-stream manager (`hyperliquid-user.ts`) so the hl-user venue's
 * disconnect metric keeps the same close-code dimension as this one.
 */
export interface WsCloseLike { readonly code?: number }

export function describeCloseReason(ev: WsCloseLike | null | undefined): string {
  if (!ev) return 'unknown';
  const code = typeof ev.code === 'number' ? ev.code : 0;
  if (code === 1000) return 'normal';
  if (code === 1001) return 'going-away';
  if (code === 1006) return 'abnormal';
  if (code === 1011) return 'server-error';
  if (code >= 4000) return `app-${code}`;
  return `code-${code}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Singleton accessor — one upstream WS per process. */
let singleton: HyperliquidRealtimeAdapter | null = null;
export function getHyperliquidRealtimeAdapter(): HyperliquidRealtimeAdapter {
  if (!singleton) singleton = new HyperliquidRealtimeAdapter();
  return singleton;
}

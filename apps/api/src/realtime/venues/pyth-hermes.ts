/**
 * Pyth Hermes realtime adapter — sole upstream SSE stream per pod.
 *
 * Sibling to `hyperliquid.ts` and `polymarket.ts`. Pyth Network's Hermes
 * service publishes first-party oracle prices for two universes through a
 * single endpoint: blue-chip crypto / SOL ecosystem tokens AND US equities.
 * Both arrive on the same wire identified by a 32-byte `price_id`; the
 * adapter holds a static symbol -> price_id map and translates back.
 *
 * Topics handled (see `topic.ts`):
 *   ticker:pyth:<SYMBOL>    crypto / blue-chip tick stream (SOL, BTC, ...)
 *   meme:pyth:<SYMBOL>      meme tokens Pyth covers (BONK, WIF, PYTH) —
 *                           same upstream id as ticker:; one feed fans to
 *                           both kinds when both are subscribed.
 *   stock:pyth:<TICKER>     US equity tick stream (AAPL, TSLA, ...)
 *
 * Transport: SSE, not WS. Hermes recommends the SSE endpoint; native
 * `fetch` + `ReadableStream` is simpler than ws under Node 22. One
 * inflight request per process. When the active price-id set changes
 * the adapter aborts the request and reopens with the new query string,
 * debounced 200ms to coalesce subscription bursts.
 *
 * Lifecycle: `start(hub)` registers the breaker but lazy-opens the stream;
 * `subscribe`/`unsubscribe` adjust the active set and schedule reopens;
 * `snapshot()` is a one-shot REST fill; `stop()` aborts cleanly.
 *
 * Reconnect: exponential backoff 1s -> 30s cap on abnormal close.
 * Breaker: 5 errors in 30s -> open (30s base cooldown, 5min cap). On open
 * the hub fans one stale TickEvent (src:'rest') per active topic from the
 * last-known cache so the UI dims; onClose restores normal flow.
 */

import { CircuitBreaker } from '../breaker.js';
import { StallWatchdog } from '../stall-watchdog.js';
import type { Hub } from '../hub.js';
import { parse } from '../topic.js';
import type {
  FeedEvent,
  RealtimeAdapter,
  TickEvent,
  Topic,
  TopicKind,
  VenueHealth,
} from '../types.js';
import {
  feedBreakerState,
  feedDisconnectTotal,
  feedReconnectAttemptsTotal,
  feedTickLagMs,
  hubMessagesInTotal,
  snapshotFillDurationMs,
} from '../metrics.js';
import { log } from '../../lib/log.js';
import { env } from '../../lib/env.js';

/* ── constants ────────────────────────────────────────────────────────────── */

const VENUE = 'pyth' as const;

/** Topic kinds Pyth Hermes can satisfy. */
type PythTopicKind = Extract<TopicKind, 'ticker' | 'stock' | 'meme'>;

/** Exponential reconnect backoff in ms, capped at 30s. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** Debounce window for active-id set churn — coalesces subscription bursts. */
const REOPEN_DEBOUNCE_MS = 200;

/** Breaker tunables: 5 failures within 30s -> open; 30s base, 5min cap. */
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

/**
 * Symbol -> { priceId, kinds } catalog. priceId is lower-case hex without
 * `0x` (Pyth REST tolerates either; we strip in `normalizeId`). `kinds` is
 * which topic kinds the symbol is allowed to back: crypto -> ticker, SOL
 * memes -> ticker + meme, equities -> stock. Canonical id list lives at
 * https://www.pyth.network/developers/price-feed-ids — entries below
 * tagged TODO have not yet been re-verified against the live catalog and
 * should be confirmed before relying on them.
 */
interface PythFeedEntry {
  readonly priceId: string;
  readonly kinds: readonly PythTopicKind[];
}
const SYMBOL_CATALOG: Record<string, PythFeedEntry> = {
  // crypto / SOL ecosystem
  BTC:  { priceId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', kinds: ['ticker'] },
  ETH:  { priceId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', kinds: ['ticker'] },
  SOL:  { priceId: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', kinds: ['ticker'] },
  USDC: { priceId: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a', kinds: ['ticker'] },
  USDT: { priceId: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b', kinds: ['ticker'] },
  JUP:  { priceId: '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996', kinds: ['ticker'] },
  JTO:  { priceId: '0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2', kinds: ['ticker'] },
  BONK: { priceId: '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419', kinds: ['ticker', 'meme'] },
  WIF:  { priceId: '0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc', kinds: ['ticker', 'meme'] },
  PYTH: { priceId: '0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff', kinds: ['ticker', 'meme'] },
  RAY:  { priceId: '0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a', kinds: ['ticker'] },
  ORCA: { priceId: '0x37505261e557e251290b8c8899453064e8d760ed5c65a779726f2490980da74c', kinds: ['ticker'] },
  // MNGO removed: the placeholder all-zero priceId was being sent verbatim
  // to Hermes which silently dropped it — subscribers saw an empty topic.
  // Re-add when the real Pyth feed id is verified at
  // https://www.pyth.network/developers/price-feed-ids.
  RNDR: { priceId: '0xab7347771135fc733f8f38db462ba085ed3309955f42554a14fa13e855ac0e2f', kinds: ['ticker'] },
  HYPE: { priceId: '0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b', kinds: ['ticker'] },
  AVAX: { priceId: '0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7', kinds: ['ticker'] },
  ARB:  { priceId: '0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5', kinds: ['ticker'] },
  OP:   { priceId: '0x385f64d993f7b77d8182ed5003d97c60aa3361f3cecfe711544d2d59165e9bdf', kinds: ['ticker'] },
  LINK: { priceId: '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221', kinds: ['ticker'] },
  UNI:  { priceId: '0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501', kinds: ['ticker'] },
  AAVE: { priceId: '0x2b9ab1e972a281585084148ba1389800799bd4be63b957507db1349314e47445', kinds: ['ticker'] },
  // US equities
  AAPL:  { priceId: '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688', kinds: ['stock'] },
  TSLA:  { priceId: '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1', kinds: ['stock'] },
  NVDA:  { priceId: '0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593', kinds: ['stock'] },
  MSFT:  { priceId: '0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1', kinds: ['stock'] },
  GOOGL: { priceId: '0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2', kinds: ['stock'] },
  AMZN:  { priceId: '0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a', kinds: ['stock'] },
  META:  { priceId: '0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe', kinds: ['stock'] },
  AMD:   { priceId: '0x4a5d3aa1aabf6dc5be99deeebd4830d04b3962d28e09f7165a1b827df0fa6a89', kinds: ['stock'] },
  NFLX:  { priceId: '0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2', kinds: ['stock'] },
};

/* ── upstream wire shapes + adapter-local types ───────────────────────────── */

interface PythPrice { readonly price: string; readonly conf: string; readonly expo: number; readonly publish_time: number }
interface PythParsedEntry { readonly id: string; readonly price: PythPrice; readonly ema_price?: PythPrice; readonly metadata?: unknown }
interface PythEnvelope { readonly binary?: unknown; readonly parsed?: readonly PythParsedEntry[] }

type WsState = 'open' | 'connecting' | 'reconnecting' | 'closed' | 'open-degraded';

interface ParsedPythTopic {
  readonly topic: Topic;
  readonly kind: PythTopicKind;
  readonly symbol: string;
  readonly priceId: string;
}

/**
 * One instance per process — registered with the hub before `hub.start()`.
 * Holds the ONLY upstream Hermes SSE connection.
 */
export class PythHermesRealtimeAdapter implements RealtimeAdapter {
  readonly venue = VENUE;

  private hub: Hub | null = null;
  private wsState: WsState = 'closed';
  private upstream: 'primary' | 'rest' = 'primary';

  /** topic -> ref count. Sole source of truth for upstream presence. */
  private readonly refs = new Map<Topic, number>();
  /** topic -> parsed form, cached so we don't re-parse on every event. */
  private readonly parsedByTopic = new Map<Topic, ParsedPythTopic>();
  /**
   * price_id (lower-case, no `0x`) -> Topics that should receive its updates.
   * One Pyth feed can fan to ticker + meme simultaneously.
   */
  private readonly topicsByPriceId = new Map<string, Set<Topic>>();

  /** Last event timestamp on any topic, epoch ms. -1 until first event. */
  private lastEventAt = -1;

  /**
   * Epoch ms of the last successful stream open; -1 before the first open.
   * Folded into the watchdog clock: `StallWatchdog.tick()` skips while its
   * clock is negative, so a stream that connects but never delivers a single
   * event would otherwise NEVER arm the watchdog (r8 sweep, defect-3 class —
   * the same blind spot the HL adapter closed with `lastOpenAt`). Seeding on
   * open also grants every fresh stream one full stall budget.
   */
  private lastOpenAt = -1;

  /** Stream lifecycle handles. Generation counter lets stale callbacks exit. */
  private streamAbort: AbortController | null = null;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private streamGen = 0;
  private readonly decoder = new TextDecoder('utf-8');

  /** Reconnect + reopen bookkeeping (reopen debounce coalesces sub bursts). */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly breaker = new CircuitBreaker({
    failureThreshold: BREAKER_OPTS.failureThreshold,
    windowMs: BREAKER_OPTS.windowMs,
    baseCooldownMs: BREAKER_OPTS.baseCooldownMs,
    maxCooldownMs: BREAKER_OPTS.maxCooldownMs,
    onOpen: () => this.onBreakerOpen(),
    onHalfOpen: () => this.onBreakerHalfOpen(),
    onClose: () => this.onBreakerClose(),
  });

  /**
   * Pyth Hermes streams price updates several times per second during US
   * market hours. 30s of silence = stall. Note: Pyth equities may legit
   * have lower cadence during half-day closes; the breaker's half-open
   * probe handles re-open once Hermes resumes.
   */
  private readonly stallWatchdog = new StallWatchdog({
    stallMs: 30_000,
    checkMs: 10_000,
    hasActiveSubs: () => this.topicsByPriceId.size > 0,
    // Only an OPEN stream can stall; closed/connecting states belong to the
    // reconnect ladder. Prevents post-close re-fires and half-open probe
    // assassination on the shared venue breaker (r8 review).
    isStreamOpen: () => this.wsState === 'open',
    // Clock = real parsed price events + open-time seed ONLY. Deliberately
    // NOT raw bytes: Hermes keepalive comments must never suppress the
    // stall→breaker→REST-fallback recovery ladder (r8 review #2) — a pipe
    // that keepalives while dropping every price event is EXACTLY the
    // "TCP-alive-but-no-events" failure this watchdog exists to catch.
    // Pyth feeds are catalog-fixed and tick continuously; legitimate quiet
    // (equity half-day closes) is handled by the designed flap: REST
    // fallback serves data, the half-open probe re-opens when events
    // resume. Contrast PM, where PONG liveness DOES count: thin markets are
    // legitimately silent, token ids are client-supplied (DoS surface), and
    // PONG is an app-level request/response rather than raw bytes.
    getLastEventAt: () => Math.max(this.lastEventAt, this.lastOpenAt),
    onStall: () => {
      log.warn({ ageMs: Date.now() - this.lastEventAt }, 'pyth-rt: stall detected');
      for (let i = 0; i < 5; i++) this.breaker.noteFailure();
      this.closeStream('stall');
    },
  });

  /* ── lifecycle ──────────────────────────────────────────────────────────── */

  async start(hub: Hub): Promise<void> {
    this.hub = hub;
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.closed);
    this.stallWatchdog.start();
    // Lazy stream open — first subscribe() schedules the first GET.
  }

  async stop(): Promise<void> {
    this.stallWatchdog.stop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    this.breaker.dispose();
    this.closeStream('shutdown');
    this.refs.clear();
    this.parsedByTopic.clear();
    this.topicsByPriceId.clear();
    this.hub = null;
  }

  /* ── subscribe / unsubscribe (hub-facing) ───────────────────────────────── */

  subscribe(topic: Topic): void {
    const parsed = this.parseOrNull(topic);
    if (!parsed) {
      // Hub keeps its own ref-count; we just skip the upstream for unknown ids.
      log.warn({ topic, venue: VENUE }, 'pyth-rt: unknown symbol — no upstream sub');
      return;
    }
    const prev = this.refs.get(topic) ?? 0;
    this.refs.set(topic, prev + 1);
    if (prev > 0) return;

    this.parsedByTopic.set(topic, parsed);
    let topics = this.topicsByPriceId.get(parsed.priceId);
    if (!topics) {
      topics = new Set();
      this.topicsByPriceId.set(parsed.priceId, topics);
    }
    const idIsNew = topics.size === 0;
    topics.add(topic);
    // Reopen only on 0->1 id transitions; same id under a second topic kind
    // doesn't change the upstream URL.
    if (idIsNew) this.scheduleReopen();
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
    const topics = this.topicsByPriceId.get(parsed.priceId);
    if (!topics) return;
    topics.delete(topic);
    if (topics.size === 0) {
      this.topicsByPriceId.delete(parsed.priceId);
      this.scheduleReopen();
    }
  }

  /* ── snapshot (REST cold-start fill) ────────────────────────────────────── */

  async snapshot(topic: Topic): Promise<FeedEvent[]> {
    const parsed = this.parseOrNull(topic);
    if (!parsed) return [];
    const endTimer = snapshotFillDurationMs.startTimer({ venue: VENUE });
    try {
      const url = new URL('/v2/updates/price/latest', env.PYTH_HERMES_URL);
      url.searchParams.append('ids[]', parsed.priceId);
      // 5s hard timeout — without this a hung Pyth endpoint pins the
      // snapshot-fill duration histogram open + holds an open fetch socket
      // forever. AbortSignal.timeout is built-in to Node 22+ and tossed
      // automatically once the request settles.
      const res = await fetch(url.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        log.warn(
          { topic, status: res.status },
          'pyth-rt: snapshot non-2xx',
        );
        return [];
      }
      const env_: unknown = await res.json();
      const events: FeedEvent[] = [];
      const parsedEntries = readParsedEntries(env_);
      for (const entry of parsedEntries) {
        const idNorm = normalizeId(entry.id);
        if (idNorm !== parsed.priceId) continue;
        const ev = this.toTickEvent(entry, parsed.topic, 'rest');
        if (ev) events.push(ev);
      }
      return events;
    } catch (err) {
      log.warn({ err: errMsg(err), topic }, 'pyth-rt: snapshot failed');
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

  /* ── SSE plumbing ───────────────────────────────────────────────────────── */

  private scheduleReopen(): void {
    if (this.reopenTimer) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      this.reopenStream();
    }, REOPEN_DEBOUNCE_MS);
    (this.reopenTimer as { unref?: () => void }).unref?.();
  }

  private reopenStream(): void {
    this.closeStream('reopen');
    if (this.topicsByPriceId.size === 0) {
      this.wsState = 'closed';
      return;
    }
    this.openStream();
  }

  private openStream(): void {
    // Breaker open -> half-open transition will retry.
    if (this.breaker.isOpen()) return;
    if (this.topicsByPriceId.size === 0) return;

    const url = this.buildStreamUrl();
    const abort = new AbortController();
    const gen = ++this.streamGen;
    this.streamAbort = abort;
    this.wsState = this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
    void this.runStream(url, abort, gen);
  }

  private async runStream(url: string, abort: AbortController, gen: number): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', signal: abort.signal, headers: { accept: 'text/event-stream' } });
    } catch (err) {
      if (gen !== this.streamGen) return;
      if (!isAbortError(err)) {
        log.warn({ err: errMsg(err) }, 'pyth-rt: SSE fetch threw');
        feedDisconnectTotal.inc({ venue: VENUE, reason: 'fetch-error' });
        this.breaker.noteFailure();
      }
      this.afterStreamClosed(gen);
      return;
    }
    if (!res.ok || !res.body) {
      if (gen !== this.streamGen) return;
      log.warn({ status: res.status }, 'pyth-rt: SSE non-2xx');
      feedDisconnectTotal.inc({ venue: VENUE, reason: `status-${res.status}` });
      this.breaker.noteFailure();
      this.afterStreamClosed(gen);
      return;
    }
    this.wsState = 'open';
    this.lastOpenAt = Date.now();
    this.reconnectAttempt = 0;
    this.breaker.noteSuccess();
    const reader = res.body.getReader();
    this.streamReader = reader;
    try {
      await this.consumeStream(reader, gen);
    } catch (err) {
      if (gen !== this.streamGen) return;
      if (!isAbortError(err)) {
        log.warn({ err: errMsg(err) }, 'pyth-rt: SSE read threw');
        feedDisconnectTotal.inc({ venue: VENUE, reason: 'read-error' });
        this.breaker.noteFailure();
      }
    } finally {
      if (gen === this.streamGen) this.afterStreamClosed(gen);
    }
  }

  private async consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    gen: number,
  ): Promise<void> {
    let buf = '';
    while (true) {
      if (gen !== this.streamGen) return;
      const { value, done } = await reader.read();
      if (done) {
        feedDisconnectTotal.inc({ venue: VENUE, reason: 'eof' });
        return;
      }
      buf += this.decoder.decode(value, { stream: true });
      // Split on SSE record terminator (\n\n or \r\n\r\n tolerated).
      let idx: number;
      while ((idx = indexOfDoubleNewline(buf)) >= 0) {
        const record = buf.slice(0, idx);
        const nextStart = buf.charAt(idx) === '\r' ? idx + 4 : idx + 2;
        buf = buf.slice(nextStart);
        this.handleSseRecord(record);
      }
    }
  }

  private handleSseRecord(record: string): void {
    // SSE: lines beginning with `data:` are concatenated (\n-joined) per spec.
    const lines = record.split('\n');
    let data = '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const piece = line.slice(5).replace(/^ /, '');
      data = data.length === 0 ? piece : `${data}\n${piece}`;
    }
    if (!data) return;
    let env_: unknown;
    try {
      env_ = JSON.parse(data);
    } catch {
      // One bad frame counts as a soft failure but doesn't tear down the stream.
      this.breaker.noteFailure();
      return;
    }
    const entries = readParsedEntries(env_);
    if (entries.length === 0) return;
    this.lastEventAt = Date.now();
    for (const entry of entries) {
      const idNorm = normalizeId(entry.id);
      const topics = this.topicsByPriceId.get(idNorm);
      if (!topics || topics.size === 0) continue;
      for (const topic of topics) {
        const ev = this.toTickEvent(entry, topic, VENUE);
        if (ev) this.publish(ev, topicKindOf(topic));
      }
    }
  }

  private afterStreamClosed(gen: number): void {
    if (gen !== this.streamGen) return;
    this.streamAbort = null;
    this.streamReader = null;
    if (this.topicsByPriceId.size === 0 || this.breaker.isOpen()) {
      this.wsState = this.breaker.isOpen() ? 'open-degraded' : 'closed';
      return;
    }
    this.scheduleReconnect();
  }

  private closeStream(_reason: string): void {
    // Bump generation first so in-flight handlers see the change and exit.
    this.streamGen++;
    const abort = this.streamAbort;
    const reader = this.streamReader;
    this.streamAbort = null;
    this.streamReader = null;
    if (reader) { try { void reader.cancel(); } catch { /* best-effort */ } }
    if (abort) { try { abort.abort(); } catch { /* best-effort */ } }
    this.wsState = 'closed';
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx];
    this.reconnectAttempt++;
    this.wsState = 'reconnecting';
    feedReconnectAttemptsTotal.inc({ venue: VENUE });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private buildStreamUrl(): string {
    const url = new URL('/v2/updates/price/stream', env.PYTH_HERMES_URL);
    // Sorted id order keeps cache keys deterministic.
    const ids = [...this.topicsByPriceId.keys()].sort();
    for (const id of ids) url.searchParams.append('ids[]', id);
    return url.toString();
  }

  /* ── breaker transitions ────────────────────────────────────────────────── */

  private onBreakerOpen(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.open);
    this.upstream = 'rest';
    this.wsState = 'open-degraded';
    this.closeStream('breaker-open');
    if (!this.hub) return;
    const now = Date.now();
    for (const [topic] of this.parsedByTopic) {
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
      try {
        this.hub.publish(ev);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'pyth-rt: breaker-open stale emit failed');
      }
    }
  }

  private onBreakerHalfOpen(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE['half-open']);
    if (this.topicsByPriceId.size > 0) this.openStream();
  }

  private onBreakerClose(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.closed);
    this.upstream = 'primary';
    if (this.wsState === 'open-degraded') this.wsState = 'open';
  }

  /* ── publish helper ─────────────────────────────────────────────────────── */

  private publish(event: FeedEvent, kind: TopicKind): void {
    hubMessagesInTotal.inc({ venue: VENUE, topic_kind: kind });
    feedTickLagMs.observe({ venue: VENUE, topic_kind: kind }, event.lastTickAgeMs);
    if (!this.hub) return;
    try {
      this.hub.publish(event);
    } catch (err) {
      log.warn({ err: errMsg(err), topic: event.topic }, 'pyth-rt: hub.publish threw');
    }
  }

  /* ── conversion + parse cache ───────────────────────────────────────────── */

  /** Build a `TickEvent` from a parsed envelope entry, or null on bad data. */
  private toTickEvent(
    entry: PythParsedEntry,
    topic: Topic,
    src: 'pyth' | 'rest',
  ): TickEvent | null {
    const priceInt = Number(entry.price?.price);
    const expo = Number(entry.price?.expo);
    const pubSec = Number(entry.price?.publish_time);
    if (!Number.isFinite(priceInt) || !Number.isInteger(expo)) return null;
    if (!Number.isFinite(pubSec)) return null;
    // Pyth prices are integer * 10^expo with expo typically negative.
    const px = priceInt * Math.pow(10, expo);
    if (!Number.isFinite(px) || px <= 0) return null;
    const ts = pubSec * 1000;
    return { t: 'tick', topic, ts, lastTickAgeMs: Math.max(0, Date.now() - ts), src, px };
  }

  private parseOrNull(topic: Topic): ParsedPythTopic | null {
    const cached = this.parsedByTopic.get(topic);
    if (cached) return cached;
    const p = parse(topic);
    if (!p || p.venue !== VENUE) return null;
    if (p.kind !== 'ticker' && p.kind !== 'stock' && p.kind !== 'meme') return null;
    const symbol = p.symbol.toUpperCase();
    const entry = SYMBOL_CATALOG[symbol];
    if (!entry) return null;
    // Refuse mis-typed topics: e.g. AAPL under ticker:, or SOL under stock:.
    if (!entry.kinds.includes(p.kind as PythTopicKind)) return null;
    return { topic, kind: p.kind as PythTopicKind, symbol, priceId: normalizeId(entry.priceId) };
  }
}

/* ── pure helpers ─────────────────────────────────────────────────────────── */

/** Lower-case hex with no `0x` prefix — matches how SSE echoes `entry.id`. */
function normalizeId(raw: string): string {
  const lower = raw.toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

function readParsedEntries(env_: unknown): readonly PythParsedEntry[] {
  if (!env_ || typeof env_ !== 'object') return [];
  const arr = (env_ as PythEnvelope).parsed;
  if (!Array.isArray(arr)) return [];
  const out: PythParsedEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<PythParsedEntry>;
    if (typeof e.id !== 'string' || !e.price || typeof e.price !== 'object') continue;
    out.push(e as PythParsedEntry);
  }
  return out;
}

/** Cheap prefix split — `topic.parse` was already enforced upstream. */
function topicKindOf(topic: Topic): TopicKind {
  const i = topic.indexOf(':');
  return (i > 0 ? topic.slice(0, i) : 'ticker') as TopicKind;
}

/** Index of SSE record terminator (`\n\n` or `\r\n\r\n`); -1 if not yet. */
function indexOfDoubleNewline(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let singleton: PythHermesRealtimeAdapter | null = null;
export function getPythHermesRealtimeAdapter(): PythHermesRealtimeAdapter {
  if (!singleton) singleton = new PythHermesRealtimeAdapter();
  return singleton;
}

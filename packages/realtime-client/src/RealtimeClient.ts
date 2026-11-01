import type { FeedEvent, Topic } from './types.js';
import { RefCountSet } from './refcount.js';
import { RealtimeStore } from './store.js';
import { SseTransport, type SseTransportOptions } from './transport/sse.js';
import { WsTransport, type WsTransportOptions } from './transport/ws.js';

type Transport = SseTransport | WsTransport;

export interface RealtimeClientOptions {
  baseUrl: string;
  token?: string;
  mintTicket?: () => Promise<string>;
  debounceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** WS is the production path; SSE is kept as an explicit fallback. */
  transport?: 'ws' | 'sse';
  /** WS path. Defaults to the public `/ws/markets` alias. */
  path?: WsTransportOptions['path'];
  onTransportError?: (err: unknown) => void;
  onProtocolError?: SseTransportOptions['onError'];
  onReady?: SseTransportOptions['onReady'];
  /**
   * Hardening 2026-07-03 — runaway-reconnect guard passthrough. After this
   * many attempts without a `ready` frame the transport drops to cold-retry
   * (`coldRetryMs`, default 5 min) and fires `onPermanentFailure` once so the
   * app can show a "reconnecting…" affordance. Self-recovers on ready.
   */
  maxAttemptsWithoutReady?: number;
  coldRetryMs?: number;
  onPermanentFailure?: (reason: string) => void;
}

interface ResolvedOptions {
  readonly baseUrl: string;
  readonly debounceMs: number;
  readonly minBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly transport: 'ws' | 'sse';
  readonly path: string;
  readonly onTransportError?: (err: unknown) => void;
  readonly onProtocolError?: SseTransportOptions['onError'];
  readonly onReady?: SseTransportOptions['onReady'];
  readonly maxAttemptsWithoutReady?: number;
  readonly coldRetryMs?: number;
  readonly onPermanentFailure?: (reason: string) => void;
}

export class RealtimeClient {
  private readonly store = new RealtimeStore();
  private readonly refs = new RefCountSet();
  private readonly opts: ResolvedOptions;
  private token: string | undefined;
  private mintTicket: (() => Promise<string>) | undefined;
  private transport: Transport | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** S3 WS5 — app-background quiesce. See `suspend()`. */
  private suspended = false;
  private readonly frameListeners = new Set<(event: FeedEvent) => void>();

  constructor(options: RealtimeClientOptions) {
    if (!options.token && !options.mintTicket) {
      throw new Error('RealtimeClient: either `token` or `mintTicket` is required');
    }
    this.opts = {
      baseUrl: options.baseUrl,
      debounceMs: options.debounceMs ?? 200,
      minBackoffMs: options.minBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      transport: options.transport ?? 'ws',
      path: options.path ?? '/ws/markets',
      ...(options.onTransportError ? { onTransportError: options.onTransportError } : {}),
      ...(options.onProtocolError ? { onProtocolError: options.onProtocolError } : {}),
      ...(options.onReady ? { onReady: options.onReady } : {}),
      ...(options.maxAttemptsWithoutReady !== undefined
        ? { maxAttemptsWithoutReady: options.maxAttemptsWithoutReady }
        : {}),
      ...(options.coldRetryMs !== undefined ? { coldRetryMs: options.coldRetryMs } : {}),
      ...(options.onPermanentFailure ? { onPermanentFailure: options.onPermanentFailure } : {}),
    };
    this.token = options.token;
    this.mintTicket = options.mintTicket;
  }

  static defaultMintTicket(baseUrl: string, sessionToken?: string): () => Promise<string> {
    const url = `${baseUrl.replace(/\/$/, '')}/v1/stream/ticket`;
    return async () => {
      const headers: Record<string, string> = {};
      if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers });
      if (!res.ok) throw new Error(`mintTicket failed: ${res.status}`);
      const body = (await res.json()) as { token?: string };
      if (!body.token) throw new Error('mintTicket: missing token in response');
      return body.token;
    };
  }

  acquire(topic: Topic): () => void {
    let released = false;
    const opened = this.refs.acquire(topic);
    if (opened) {
      if (this.transport instanceof WsTransport) this.transport.addTopics([topic]);
      else this.scheduleRebuild();
    }
    return () => {
      if (released) return;
      released = true;
      const closed = this.refs.release(topic);
      if (!closed) return;
      if (this.transport instanceof WsTransport) {
        if (this.refs.total() === 0) {
          this.transport.close();
          this.transport = null;
        } else {
          this.transport.removeTopics([topic]);
        }
      } else {
        this.scheduleRebuild();
      }
    };
  }

  onTopic(topic: Topic, listener: (event: FeedEvent) => void): () => void {
    return this.store.subscribe(topic, listener);
  }

  get(topic: Topic): FeedEvent | undefined { return this.store.get(topic); }
  getTick(topic: Topic) { return this.store.getTick(topic); }
  getCandle(topic: Topic) { return this.store.getCandle(topic); }
  getBook(topic: Topic) { return this.store.getBook(topic); }
  getTrade(topic: Topic) { return this.store.getTrade(topic); }
  getOrder(topic: Topic) { return this.store.getOrder(topic); }
  getAccount(topic: Topic) { return this.store.getAccount(topic); }
  getFill(topic: Topic) { return this.store.getFill(topic); }

  setToken(token: string, opts: { reconnectNow?: boolean } = {}): void {
    this.token = token;
    if (opts.reconnectNow) this.rebuildNow();
    else this.scheduleRebuild();
  }

  setMintTicket(mintTicket: (() => Promise<string>) | undefined, opts: { reconnectNow?: boolean } = {}): void {
    this.mintTicket = mintTicket;
    if (opts.reconnectNow) this.rebuildNow();
    else this.scheduleRebuild();
  }

  close(): void {
    this.closed = true;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.transport?.close();
    this.transport = null;
    this.refs.clear();
    this.store.clear();
    this.frameListeners.clear();
  }

  totalSubscriptions(): number { return this.refs.total(); }
  activeTopics(): readonly Topic[] { return this.refs.activeTopics(); }

  /**
   * Tap EVERY inbound feed event, across all topics, after the store has
   * absorbed it. This is the seam feed-health machinery hangs off (NEO S3
   * WS5): one listener observes hub liveness per venue without wrapping each
   * topic hook. Listeners must be cheap; a throwing listener is isolated so
   * it can never break store dispatch or its sibling taps.
   */
  onFrame(listener: (event: FeedEvent) => void): () => void {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  }

  /**
   * S3 WS5 — whole-socket quiesce for app-background. Parks the transport in
   * ONE move while keeping every subscription intent (refcounts) and the
   * store's last-event cache. Contrast with per-topic release churn: N unsub
   * frames + rebuild debounce + a resubscribe storm on return. While
   * suspended, topic churn and token rotation mutate local state only; no
   * transport is (re)built until `resume()`, which reopens with the full
   * retained topic set and freshly applied credentials. Idempotent; `close()`
   * still wins (terminal).
   */
  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.transport?.close();
    this.transport = null;
  }

  /** Undo `suspend()`: rebuild the transport from retained refcounts. */
  resume(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.rebuildNow();
  }

  isSuspended(): boolean { return this.suspended; }

  private scheduleRebuild(): void {
    if (this.closed || this.suspended) return;
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildNow();
    }, this.opts.debounceMs);
    (this.rebuildTimer as { unref?: () => void }).unref?.();
  }

  private rebuildNow(): void {
    if (this.closed || this.suspended) return;
    this.transport?.close();
    this.transport = null;
    const topics = this.refs.activeTopics();
    if (topics.length === 0) return;
    const common = {
      baseUrl: this.opts.baseUrl,
      ...(this.token ? { token: this.token } : {}),
      ...(this.mintTicket ? { mintTicket: this.mintTicket } : {}),
      topics,
      minBackoffMs: this.opts.minBackoffMs,
      maxBackoffMs: this.opts.maxBackoffMs,
      onEvent: (event: FeedEvent) => {
        if (!this.store.dispatch(event)) return;
        for (const listener of this.frameListeners) {
          try { listener(event); } catch { /* taps never break dispatch */ }
        }
      },
      ...(this.opts.onReady ? { onReady: this.opts.onReady } : {}),
      ...(this.opts.onProtocolError ? { onError: this.opts.onProtocolError } : {}),
      ...(this.opts.onTransportError ? { onTransportError: this.opts.onTransportError } : {}),
      ...(this.opts.maxAttemptsWithoutReady !== undefined
        ? { maxAttemptsWithoutReady: this.opts.maxAttemptsWithoutReady }
        : {}),
      ...(this.opts.coldRetryMs !== undefined ? { coldRetryMs: this.opts.coldRetryMs } : {}),
      ...(this.opts.onPermanentFailure ? { onPermanentFailure: this.opts.onPermanentFailure } : {}),
    };
    this.transport = this.opts.transport === 'sse'
      ? new SseTransport(common)
      : new WsTransport({ ...common, path: this.opts.path });
  }
}

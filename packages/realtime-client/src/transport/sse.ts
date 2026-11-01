/**
 * SSE transport for the realtime hub.
 *
 * Wraps the platform `EventSource` (browser native; React Native via
 * `react-native-sse` polyfill or `fetch` streaming on Hermes). The wrapper
 * normalizes the URL build (topics + auth), reconnect with exponential
 * backoff, and exposes a single `onEvent` callback consumers attach.
 *
 * Server emits each `FeedEvent` as an SSE message with `event: <kind>`
 * (`tick` / `candle` / `book` / `trade`) plus a `data:` JSON line. The hub
 * also emits `event: ready`, `event: ping`, and `event: err`. This module
 * routes the first set to `onEvent` and the others to dedicated callbacks.
 *
 * EventSource is one-way: the server pushes; the client cannot send `sub`
 * or `unsub` mid-stream. To change topics, the orchestrator tears down
 * this transport and opens a new one with the updated `topics=`. The WS
 * transport (next module) supports in-stream sub/unsub for the cases where
 * EventSource's connection-per-set granularity is too coarse.
 */

import type { FeedEvent, ServerErrCode, Topic } from '../types.js';

/* ── platform `EventSource` ducktype (avoids hard DOM lib dep here) ───────── */

interface EventSourceLike {
  readonly readyState: number;
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null;
  addEventListener(
    type: string,
    listener: (ev: { data: string }) => void,
  ): void;
  close(): void;
}

interface EventSourceCtor {
  new (
    url: string,
    init?: { withCredentials?: boolean },
  ): EventSourceLike;
}

/** Resolved at runtime so Hermes / Node test envs can polyfill before construct. */
function pickEventSource(): EventSourceCtor {
  const ctor = (globalThis as { EventSource?: EventSourceCtor }).EventSource;
  if (!ctor) {
    throw new Error(
      'SseTransport: global EventSource not found. ' +
      'On React Native install `react-native-sse` and polyfill `globalThis.EventSource`.',
    );
  }
  return ctor;
}

/* ── public types ─────────────────────────────────────────────────────────── */

export interface SseTransportOptions {
  /**
   * Base origin or full URL pointing at the API, e.g. `https://nexa.aiso.tools`.
   * Trailing slash is tolerated.
   */
  baseUrl: string;
  /**
   * Static fallback token sent as `?token=` when `mintTicket` is not provided.
   * The server only accepts SHORT-LIVED STREAM TICKETS in URLs (long-lived
   * session JWTs are rejected from `?token=` to close the URL-leakage surface).
   * Prefer `mintTicket` for production callers; keep this for tests + back-compat.
   */
  token?: string;
  /**
   * Async ticket minter — invoked before each connect attempt. The returned
   * string is used as the `?token=` query param. Pair with the server's
   * `POST /v1/stream/ticket` endpoint, which mints a 60s single-use JWT
   * bound to the cookie/session of the caller. Re-minted on every reconnect.
   */
  mintTicket?: () => Promise<string>;
  /** Topics to subscribe at connect. Changing the set requires reconnecting. */
  topics: readonly Topic[];
  /** Min reconnect delay. Default 1s. */
  minBackoffMs?: number;
  /** Max reconnect delay (cap). Default 30s. */
  maxBackoffMs?: number;
  /** Called for every typed FeedEvent (`tick` / `candle` / `book` / `trade`). */
  onEvent: (event: FeedEvent) => void;
  /** Called once per successful open after the server emits its `ready` frame. */
  onReady?: (accepted: readonly Topic[], serverVersion: string) => void;
  /** Called for server-emitted `err` frames (e.g. topic_invalid). */
  onError?: (code: ServerErrCode, topic?: Topic) => void;
  /** Called on each transport-level error. */
  onTransportError?: (err: unknown) => void;
  /**
   * Parity with WsTransport (hardening 2026-07-03): after this many
   * consecutive attempts without a `ready` frame, drop to cold-retry
   * cadence instead of hammering + re-minting a ticket per attempt.
   */
  maxAttemptsWithoutReady?: number;
  /** Cold-mode retry interval once the fast budget is spent. Default 5 min. */
  coldRetryMs?: number;
  /** Fired once on entering cold mode; self-recovers on the next ready. */
  onPermanentFailure?: (reason: string) => void;
  /**
   * Time source override for tests. Defaults to `Date.now`. Currently used
   * only for jitter on the reconnect delay.
   */
  now?: () => number;
}

/* ── implementation ───────────────────────────────────────────────────────── */

export class SseTransport {
  private readonly opts: {
    baseUrl: string;
    token?: string;
    mintTicket?: () => Promise<string>;
    topics: readonly Topic[];
    minBackoffMs: number;
    maxBackoffMs: number;
    onEvent: SseTransportOptions['onEvent'];
    onReady?: SseTransportOptions['onReady'];
    onError?: SseTransportOptions['onError'];
    onTransportError?: SseTransportOptions['onTransportError'];
    maxAttemptsWithoutReady: number;
    coldRetryMs: number;
    onPermanentFailure?: (reason: string) => void;
    now: () => number;
  };
  private source: EventSourceLike | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** True once the fast-backoff budget is spent; cleared by a ready frame. */
  private coldMode = false;

  constructor(options: SseTransportOptions) {
    if (!options.token && !options.mintTicket) {
      throw new Error('SseTransport: either `token` or `mintTicket` is required');
    }
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/$/, ''),
      ...(options.token != null ? { token: options.token } : {}),
      ...(options.mintTicket != null ? { mintTicket: options.mintTicket } : {}),
      topics: options.topics,
      minBackoffMs: options.minBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      onEvent: options.onEvent,
      ...(options.onReady ? { onReady: options.onReady } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.onTransportError ? { onTransportError: options.onTransportError } : {}),
      maxAttemptsWithoutReady: options.maxAttemptsWithoutReady ?? 12,
      coldRetryMs: options.coldRetryMs ?? 300_000,
      ...(options.onPermanentFailure ? { onPermanentFailure: options.onPermanentFailure } : {}),
      now: options.now ?? (() => Date.now()),
    };
    void this.connect();
  }

  /** True while the transport is open and ready to receive events. */
  isOpen(): boolean {
    return this.source?.readyState === 1;
  }

  /** Tear down the connection and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private async connect(): Promise<void> {
    if (this.closed) return;
    let url: string;
    try {
      url = await this.buildUrl();
    } catch (err) {
      this.opts.onTransportError?.(err);
      this.scheduleReconnect();
      return;
    }
    if (this.closed) return; // a close() can land while mintTicket awaits
    let src: EventSourceLike;
    try {
      const Ctor = pickEventSource();
      src = new Ctor(url, { withCredentials: false });
    } catch (err) {
      this.opts.onTransportError?.(err);
      this.scheduleReconnect();
      return;
    }
    this.source = src;

    src.onopen = () => {
      // Parity with WsTransport (hardening 2026-07-03): the reconnect budget
      // refills on the READY frame, not on open — EventSource fires onopen
      // on headers alone, so an endpoint that accepts then rejects (auth
      // loop, dead mount) previously reset here and re-minted a single-use
      // ticket per attempt, forever.
    };

    src.onerror = (ev) => {
      this.opts.onTransportError?.(ev);
      // Browsers auto-reconnect EventSource but lose `?token=` resolution
      // semantics across origins. We close + reschedule with our own backoff
      // so reconnects stay deterministic.
      src.close();
      this.source = null;
      this.scheduleReconnect();
    };

    src.addEventListener('tick', (ev) => this.handleEvent(ev.data));
    src.addEventListener('candle', (ev) => this.handleEvent(ev.data));
    src.addEventListener('book', (ev) => this.handleEvent(ev.data));
    src.addEventListener('trade', (ev) => this.handleEvent(ev.data));
    src.addEventListener('order', (ev) => this.handleEvent(ev.data));
    src.addEventListener('account', (ev) => this.handleEvent(ev.data));
    src.addEventListener('fill', (ev) => this.handleEvent(ev.data));

    src.addEventListener('ready', (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as {
          accepted?: readonly Topic[];
          serverVersion?: string;
        };
        // Ready proves mount + auth + capacity: refill the reconnect budget
        // and leave cold mode (parity with WsTransport).
        this.reconnectAttempts = 0;
        this.coldMode = false;
        this.opts.onReady?.(parsed.accepted ?? [], parsed.serverVersion ?? '');
      } catch (err) {
        this.opts.onTransportError?.(err);
      }
    });

    src.addEventListener('err', (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as { code?: ServerErrCode; topic?: Topic };
        if (parsed.code) this.opts.onError?.(parsed.code, parsed.topic);
      } catch {
        // Malformed err frame — ignore.
      }
    });

    // `ping` keepalive: no payload-level reaction needed; EventSource read of
    // the frame is enough to keep proxies + browsers from reaping the socket.
    src.addEventListener('ping', () => {});
  }

  private handleEvent(raw: string): void {
    try {
      const event = JSON.parse(raw) as FeedEvent;
      this.opts.onEvent(event);
    } catch (err) {
      this.opts.onTransportError?.(err);
    }
  }

  private async buildUrl(): Promise<string> {
    const params = new URLSearchParams();
    if (this.opts.topics.length) {
      params.set('topics', this.opts.topics.join(','));
    }
    // Prefer mintTicket (production path); fall back to static token (tests).
    const token = this.opts.mintTicket
      ? await this.opts.mintTicket()
      : this.opts.token!;
    params.set('token', token);
    return `${this.opts.baseUrl}/v1/stream/sse?${params.toString()}`;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.opts.maxAttemptsWithoutReady) {
      // Cold mode (parity with WsTransport, hardening 2026-07-03): stop
      // hammering + ticket-minting against an endpoint that never reaches
      // ready; one attempt per coldRetryMs keeps recovery automatic.
      if (!this.coldMode) {
        this.coldMode = true;
        const reason = `no ready frame after ${this.reconnectAttempts} attempts — cold retry every ${Math.round(this.opts.coldRetryMs / 1000)}s`;
        this.opts.onTransportError?.(new Error(`SseTransport: ${reason}`));
        this.opts.onPermanentFailure?.(reason);
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, this.opts.coldRetryMs);
      (this.reconnectTimer as { unref?: () => void }).unref?.();
      return;
    }
    const attempt = this.reconnectAttempts++;
    const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** attempt);
    // Light jitter (0-25%) so a thundering herd doesn't reconnect in lockstep
    // after a hub restart. Deterministic enough for tests via `now` override
    // — uses Math.random() in prod which is fine for distributing reconnects.
    const jitter = Math.floor(Math.random() * (base * 0.25));
    const delay = base + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }
}

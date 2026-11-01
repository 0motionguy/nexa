/**
 * WebSocket transport — sibling to `SseTransport`. Same on-the-wire envelope
 * (the server emits `FeedEvent` JSON either way), but WS lets the client
 * change its topic set mid-stream via `{op:'sub'|'unsub', topics:[...]}` and
 * round-trip a typed `pong` for liveness probes.
 *
 * Picks the platform `WebSocket` constructor at runtime. The browser ships
 * one; Node 22+ exposes `globalThis.WebSocket`; React Native (Hermes) has
 * had it since RN 0.74. If none is found this throws clearly so the calling
 * code can fall back to the SSE transport rather than failing silently.
 *
 * The transport itself is stateless about topic membership — the caller
 * (`RealtimeClient`) owns the ref-counted topic set and `send`s `sub`/`unsub`
 * frames as that set changes. That separation lets a single open WS handle
 * any number of subscribe-set churn without reconnecting.
 */

import type { ClientOp, FeedEvent, ServerErrCode, Topic } from '../types.js';

/* ── platform shim ────────────────────────────────────────────────────────── */

interface WebSocketCtor {
  new (url: string, protocols?: string | string[]): WebSocketLike;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

interface WebSocketLike {
  readonly readyState: number;
  onopen: ((this: WebSocketLike, ev: Event) => unknown) | null;
  onmessage: ((this: WebSocketLike, ev: { data: string | ArrayBuffer | Blob | Uint8Array }) => unknown) | null;
  onerror: ((this: WebSocketLike, ev: Event) => unknown) | null;
  onclose: ((this: WebSocketLike, ev: { code?: number; reason?: string }) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function pickWebSocket(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error(
      'WsTransport: global WebSocket not found. ' +
      'On older React Native install `react-native-websocket` or polyfill `globalThis.WebSocket`.',
    );
  }
  return ctor;
}

/* ── public types ─────────────────────────────────────────────────────────── */

export interface WsTransportOptions {
  /** Base origin or full URL. Trailing slash tolerated. */
  baseUrl: string;
  /**
   * WS route on the server. Defaults to `/v1/stream/ws` (legacy/stable path
   * the existing 171 tests target). NEO + MAZE use `/ws/markets` — the clean
   * public alias mounted on the same handler. Any path starting with `/` is
   * fine; trailing query string is not allowed (the transport adds `?token=`).
   */
  path?: string;
  /**
   * Static fallback token sent as `?token=` when `mintTicket` is not provided.
   * Server accepts only short-lived stream tickets in URLs; long-lived session
   * JWTs are rejected. Prefer `mintTicket` in production; keep this for tests.
   */
  token?: string;
  /**
   * Async ticket minter, invoked before each connect attempt. Pair with the
   * server's POST /v1/stream/ticket endpoint. Re-minted on every reconnect.
   */
  mintTicket?: () => Promise<string>;
  /** Topics to subscribe immediately after the `ready` frame. */
  topics: readonly Topic[];
  /** Min reconnect delay. Default 1s. */
  minBackoffMs?: number;
  /** Max reconnect delay (cap). Default 30s. */
  maxBackoffMs?: number;
  /** Pong-required ping cadence. Default 25s; server kicks at 30s of silence. */
  pingIntervalMs?: number;
  /** Called for every typed FeedEvent. */
  onEvent: (event: FeedEvent) => void;
  /** Called when the server emits its initial `ready` frame. */
  onReady?: (accepted: readonly Topic[], serverVersion: string) => void;
  /** Called for server-emitted `err` frames. */
  onError?: (code: ServerErrCode, topic?: Topic) => void;
  /** Called on transport-level errors (close codes, parse failures). */
  onTransportError?: (err: unknown) => void;
  /**
   * Scale plan 0.5 (2026-07-02, hardened 2026-07-03) — runaway-reconnect
   * guard. Reconnect attempts only reset once a `ready` frame arrives; after
   * this many consecutive attempts WITHOUT one (dead mount, auth rejection
   * loop, capacity shed, long offline gap) the transport drops from fast
   * backoff to a COLD retry cadence (`coldRetryMs`) instead of hammering and
   * re-minting a ticket every 30s. It is NOT a tombstone: a subway-length
   * outage self-recovers on the next cold attempt. Default 12.
   */
  maxAttemptsWithoutReady?: number;
  /** Cold-mode retry interval once the fast budget is spent. Default 5 min. */
  coldRetryMs?: number;
  /**
   * Fired once when the transport enters cold mode — the app can surface a
   * "reconnecting…" affordance. Recovery is automatic; a later `ready` frame
   * restores fast behavior and re-arms this callback.
   */
  onPermanentFailure?: (reason: string) => void;
}

/* ── implementation ───────────────────────────────────────────────────────── */

interface ResolvedOpts {
  readonly baseUrl: string;
  readonly path: string;
  readonly token?: string;
  readonly mintTicket?: () => Promise<string>;
  readonly topics: readonly Topic[];
  readonly minBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly pingIntervalMs: number;
  readonly onEvent: (event: FeedEvent) => void;
  readonly onReady?: (accepted: readonly Topic[], serverVersion: string) => void;
  readonly onError?: (code: ServerErrCode, topic?: Topic) => void;
  readonly onTransportError?: (err: unknown) => void;
  readonly maxAttemptsWithoutReady: number;
  readonly coldRetryMs: number;
  readonly onPermanentFailure?: (reason: string) => void;
}

export class WsTransport {
  private readonly opts: ResolvedOpts;
  private ws: WebSocketLike | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** True once the fast-backoff budget is spent; cleared by a ready frame. */
  private coldMode = false;
  private heldTopics: ReadonlySet<Topic>;

  constructor(options: WsTransportOptions) {
    if (!options.token && !options.mintTicket) {
      throw new Error('WsTransport: either `token` or `mintTicket` is required');
    }
    const resolved: ResolvedOpts = {
      baseUrl: options.baseUrl.replace(/\/$/, ''),
      path: normalizePath(options.path),
      ...(options.token ? { token: options.token } : {}),
      ...(options.mintTicket ? { mintTicket: options.mintTicket } : {}),
      topics: options.topics,
      minBackoffMs: options.minBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      pingIntervalMs: options.pingIntervalMs ?? 25_000,
      onEvent: options.onEvent,
      ...(options.onReady ? { onReady: options.onReady } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.onTransportError ? { onTransportError: options.onTransportError } : {}),
      maxAttemptsWithoutReady: options.maxAttemptsWithoutReady ?? 12,
      coldRetryMs: options.coldRetryMs ?? 300_000,
      ...(options.onPermanentFailure ? { onPermanentFailure: options.onPermanentFailure } : {}),
    };
    this.opts = resolved;
    this.heldTopics = new Set(options.topics);
    void this.connect();
  }

  isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  /**
   * Subscribe to additional topics on the live connection. The caller's
   * ref-counter has already decided this is needed; the transport just
   * forwards the op. If the socket is mid-reconnect the topic still ends
   * up in `heldTopics` and gets re-subscribed on the next open.
   */
  addTopics(topics: readonly Topic[]): void {
    if (topics.length === 0) return;
    const next = new Set(this.heldTopics);
    for (const t of topics) next.add(t);
    this.heldTopics = next;
    this.sendOp({ op: 'sub', topics });
  }

  /** Drop topics. Same caveat as `addTopics` for the mid-reconnect case. */
  removeTopics(topics: readonly Topic[]): void {
    if (topics.length === 0) return;
    const next = new Set(this.heldTopics);
    for (const t of topics) next.delete(t);
    this.heldTopics = next;
    this.sendOp({ op: 'unsub', topics });
  }

  /** Tear down. Stops reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    try { this.ws?.close(1000, 'client-close'); } catch { /* socket already gone */ }
    this.ws = null;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private async connect(): Promise<void> {
    if (this.closed) return;
    const Ctor = pickWebSocket();
    let url: string;
    try {
      url = await this.buildUrl();
    } catch (err) {
      this.opts.onTransportError?.(err);
      this.scheduleReconnect();
      return;
    }
    if (this.closed) return; // close() may have landed mid-mint
    let ws: WebSocketLike;
    try {
      ws = new Ctor(url);
    } catch (err) {
      this.opts.onTransportError?.(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // Scale 0.5 — attempts reset on READY (see handleMessage), not on open:
      // an endpoint that accepts the upgrade then fatally closes (auth loop,
      // capacity shed) previously reset here and hammered at min backoff
      // forever, re-minting a ticket per attempt.
      // Re-establish the full subscribe set on (re)open — the server forgets
      // who we are after a disconnect.
      const initial = [...this.heldTopics];
      if (initial.length > 0) this.sendOp({ op: 'sub', topics: initial });
      // Start a sender-side ping to keep proxies + idle-timeouts at bay.
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.sendOp({ op: 'ping' }), this.opts.pingIntervalMs);
      (this.pingTimer as { unref?: () => void }).unref?.();
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);

    ws.onerror = (ev) => {
      this.opts.onTransportError?.(ev);
    };

    ws.onclose = () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: string | ArrayBuffer | Blob | Uint8Array): void {
    let text: string;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else if (typeof Uint8Array !== 'undefined' && raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
    else {
      this.opts.onTransportError?.(new Error('WsTransport: unsupported message frame'));
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (err) { this.opts.onTransportError?.(err); return; }

    if (!parsed || typeof parsed !== 'object') return;
    const msg = parsed as { t?: string; op?: string };

    if (
      msg.t === 'tick' ||
      msg.t === 'candle' ||
      msg.t === 'book' ||
      msg.t === 'trade' ||
      msg.t === 'order' ||
      msg.t === 'account' ||
      msg.t === 'fill'
    ) {
      this.opts.onEvent(parsed as FeedEvent);
      return;
    }
    if (msg.op === 'ready') {
      // A ready frame proves the mount + auth + capacity are all good —
      // THIS is where the reconnect budget refills (scale 0.5) and cold
      // mode ends.
      this.reconnectAttempts = 0;
      this.coldMode = false;
      const m = parsed as { accepted?: readonly Topic[]; serverVersion?: string };
      this.opts.onReady?.(m.accepted ?? [], m.serverVersion ?? '');
      return;
    }
    if (msg.op === 'err') {
      const m = parsed as { code?: ServerErrCode; topic?: Topic };
      if (m.code) this.opts.onError?.(m.code, m.topic);
      return;
    }
    // `pong` is currently a silent ack; the keepalive timer doesn't track
    // outstanding pings (yet). The next iteration adds a deadline check.
  }

  private sendOp(op: ClientOp): void {
    if (this.ws?.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(op));
    } catch (err) {
      this.opts.onTransportError?.(err);
    }
  }

  private async buildUrl(): Promise<string> {
    const origin = resolveWsBase(this.opts.baseUrl);
    const params = new URLSearchParams();
    // Prefer mintTicket (production); fall back to static token (tests).
    const token = this.opts.mintTicket ? await this.opts.mintTicket() : this.opts.token!;
    params.set('token', token);
    return `${origin}${this.opts.path}?${params.toString()}`;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.opts.maxAttemptsWithoutReady) {
      // Hardened 2026-07-03 — cold mode, NOT a tombstone: a multi-minute
      // offline gap (subway/flight) must not kill realtime until app
      // restart. One attempt per coldRetryMs keeps the anti-hammer and
      // anti-ticket-mint win while guaranteeing self-recovery the moment
      // the network/server comes back.
      if (!this.coldMode) {
        this.coldMode = true;
        const reason = `no ready frame after ${this.reconnectAttempts} attempts — cold retry every ${Math.round(this.opts.coldRetryMs / 1000)}s`;
        this.opts.onTransportError?.(new Error(`WsTransport: ${reason}`));
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
    const jitter = Math.floor(Math.random() * (base * 0.25));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, base + jitter);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }
}

/**
 * Default WS path is the legacy `/v1/stream/ws`. NEO + MAZE pass
 * `/ws/markets` (the public alias). Any other absolute path is accepted as-is
 * so internal smoke + bench scripts can hit alternate mount points. A query
 * string in the override is rejected — the transport always appends its own
 * `?token=` and a second `?` segment would break URL parsing on every proxy.
 */
function normalizePath(raw: string | undefined): string {
  if (!raw) return '/v1/stream/ws';
  if (raw.includes('?')) {
    throw new Error(`WsTransport: path must not contain a query string (got "${raw}")`);
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function resolveWsBase(rawBaseUrl: string): string {
  const raw = rawBaseUrl.replace(/\/$/, '');
  let url: URL;
  if (/^wss?:\/\//i.test(raw)) {
    url = new URL(raw);
  } else if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  } else {
    const loc = (globalThis as { location?: { protocol?: string; host?: string } }).location;
    if (!loc?.protocol || !loc.host) {
      throw new Error('WsTransport: relative baseUrl requires browser location');
    }
    url = new URL(raw || '/', `${loc.protocol}//${loc.host}`);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  }
  return url.toString().replace(/\/$/, '');
}

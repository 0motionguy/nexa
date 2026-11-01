/**
 * Hyperliquid USER-data streaming — ADR-0004 part 2, behind `HL_USER_STREAMS`.
 *
 * Sibling to the public-market adapter in `./hyperliquid.ts` (which owns the
 * allMids/candle/l2Book/trades socket). This manager owns the per-user
 * upstream subscriptions:
 *
 *   clearinghouseState { type:'clearinghouseState', user }
 *              → AccountEvent on `priv:<uid>:account`
 *   userFills { type:'userFills', user } → FillEvent(s)  on `priv:<uid>:fills`
 *
 * It is NOT a `RealtimeAdapter` — priv topics never route through the venue
 * adapter path (`hub.subscribe` skips adapters for them). Demand arrives via
 * the hub's `PrivSubscriptionHook`s: the first client subscribing a user's
 * account/fills topic attaches that user upstream; the last unsubscribe
 * detaches them.
 *
 * Upstream caps (official WS limits): ≤10 unique users per connection across
 * user-specific subscriptions, ≤10 connections, ≤1000 subs per connection.
 * We shard: each shard socket carries up to `maxUsersPerShard` (10) users,
 * up to `maxShards` (10) shards → hard cap 100 concurrently streamed users
 * per pod. Past the cap a user is declined (one warn log) and their UI keeps
 * today's REST polling — the client feature-detects by event arrival.
 *
 * Address resolution: info-style user streams key on the MASTER wallet
 * address (`nb_users.privy_wallet_address`), never an agent address —
 * agent-keyed queries return empty data (ADR-0004 footgun #1).
 *
 * Reconnect: per-shard exponential backoff 1s → 30s cap; every user's active
 * kinds are re-subscribed on reopen. A 30s client→server ping keeps idle
 * shards inside Hyperliquid's 60s inbound-activity window.
 */

import { feedDisconnectTotal, feedReconnectAttemptsTotal, hubMessagesInTotal } from '../metrics.js';
import { describeCloseReason } from './hyperliquid.js';
import { mapClearinghousePositions } from '../../lib/markets/hyperliquid.js';
import { privAccountTopic, privFillsTopic } from '../topic.js';
import type { AccountEvent, AccountPosition, FillEvent, Topic } from '../types.js';
import type { Hub, PrivSubscriptionHook } from '../hub.js';
import { HL_WS_URL } from '../../lib/markets/hl-config.js';
import { log } from '../../lib/log.js';

/* ── upstream wire shapes (narrow `unknown` against these) ────────────────── */

interface UpstreamFrame {
  channel?: string;
  data?: unknown;
}

interface ClearinghouseStateData {
  user?: string;
  clearinghouseState?: {
    marginSummary?: { accountValue?: string; totalMarginUsed?: string };
    withdrawable?: string;
    assetPositions?: Array<{
      position?: {
        coin?: string;
        szi?: string;
        entryPx?: string;
        positionValue?: string;
        unrealizedPnl?: string;
        liquidationPx?: string | null;
        leverage?: { value?: number } | number;
      };
    }>;
  };
}

interface UserFillsData {
  user?: string;
  isSnapshot?: boolean;
  fills?: Array<{
    coin?: string;
    px?: string;
    sz?: string;
    side?: 'A' | 'B';
    time?: number;
    dir?: string;
    closedPnl?: string;
    hash?: string;
    oid?: number;
    fee?: string;
    liquidation?: unknown;
  }>;
}

/* ── minimal socket contract so specs can inject a fake ───────────────────── */

export interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev?: { code?: number }) => void) | null;
  readonly readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string) => WsLike;

/** readyState value for OPEN per the WebSocket spec — avoids needing the ctor. */
const WS_OPEN = 1;

const defaultWsFactory: WsFactory = (url) =>
  new WebSocket(url) as unknown as WsLike;

export type UserAddressResolver = (userId: string) => Promise<string | null>;

/** Default resolver — master wallet address off the user row. Lazy store
 * import so unit tests (which always inject) never touch the store boot. */
const defaultResolveAddress: UserAddressResolver = async (userId) => {
  const { store } = await import('../../store/index.js');
  try {
    const u = await store.user(userId);
    return u.privyWalletAddress ?? null;
  } catch {
    return null;
  }
};

/* ── constants ────────────────────────────────────────────────────────────── */

const VENUE_METRIC = 'hl-user';
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const PING_INTERVAL_MS = 30_000;
/** Cadence of the second-chance sweep for unresolved/declined users. */
const RETRY_SWEEP_MS = 5 * 60_000;
/** Hyperliquid cap: ≤10 unique users per connection for user-specific subs. */
const DEFAULT_MAX_USERS_PER_SHARD = 10;
/** Hyperliquid cap: ≤10 connections per IP. Leave headroom for the market adapter. */
const DEFAULT_MAX_SHARDS = 9;

export type UserStreamKind = 'account' | 'fills';

interface UserEntry {
  /** null while address resolution is in flight; '' if resolution failed. */
  address: string | null;
  readonly kinds: Set<UserStreamKind>;
  shardIndex: number | null;
}

interface Shard {
  ws: WsLike | null;
  state: 'closed' | 'connecting' | 'open';
  readonly users: Set<string>;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
}

export interface HlUserStreamOptions {
  wsFactory?: WsFactory;
  resolveAddress?: UserAddressResolver;
  wsUrl?: string;
  maxUsersPerShard?: number;
  maxShards?: number;
}

/* ── manager ──────────────────────────────────────────────────────────────── */

export class HlUserStreamManager {
  private hub: Hub | null = null;
  private stopped = false;

  private readonly wsFactory: WsFactory;
  private readonly resolveAddress: UserAddressResolver;
  private readonly wsUrl: string;
  private readonly maxUsersPerShard: number;
  private readonly maxShards: number;

  /** userId → entry. Sole source of truth for demand. */
  private readonly users = new Map<string, UserEntry>();
  /** lowercased master address → userId, for frame demux. */
  private readonly userByAddress = new Map<string, string>();
  /** userId → fingerprint of the last published account snapshot. The venue
   *  re-sends full state on a timer even when nothing changed; identical
   *  frames are dropped here so the hub/WS/client only see real deltas. */
  private readonly lastAccountFp = new Map<string, string>();
  private readonly shards: Shard[] = [];
  /** Users declined at the cap — tracked so the warn logs once per user. */
  private readonly declined = new Set<string>();

  constructor(opts: HlUserStreamOptions = {}) {
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.resolveAddress = opts.resolveAddress ?? defaultResolveAddress;
    this.wsUrl = opts.wsUrl ?? HL_WS_URL;
    this.maxUsersPerShard = opts.maxUsersPerShard ?? DEFAULT_MAX_USERS_PER_SHARD;
    this.maxShards = opts.maxShards ?? DEFAULT_MAX_SHARDS;
  }

  private retryTimer: ReturnType<typeof setInterval> | null = null;

  start(hub: Hub): void {
    this.hub = hub;
    this.stopped = false;
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => void this.retryUnresolved(), RETRY_SWEEP_MS);
      (this.retryTimer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    for (const shard of this.shards) this.teardownShard(shard, 'shutdown');
    this.shards.length = 0;
    this.users.clear();
    this.userByAddress.clear();
    this.declined.clear();
    this.lastAccountFp.clear();
    this.hub = null;
  }

  /** Hook adapter — hand the returned object to `hub.registerPrivHook(kind, …)`. */
  hookFor(kind: UserStreamKind): PrivSubscriptionHook {
    return {
      onFirstSubscriber: (userId) => void this.attach(userId, kind),
      onLastUnsubscribe: (userId) => this.detach(userId, kind),
    };
  }

  /* ── attach / detach (demand side) ──────────────────────────────────────── */

  private async attach(userId: string, kind: UserStreamKind): Promise<void> {
    if (this.stopped) return;
    let entry = this.users.get(userId);
    if (entry) {
      if (entry.kinds.has(kind)) return;
      entry.kinds.add(kind);
      // Address already resolved + shard assigned → just add the new sub.
      if (entry.address && entry.shardIndex != null) {
        this.sendSub(this.shards[entry.shardIndex], entry.address, kind, 'subscribe');
      }
      return;
    }

    entry = { address: null, kinds: new Set([kind]), shardIndex: null };
    this.users.set(userId, entry);

    let address: string | null;
    try {
      address = await this.resolveAddress(userId);
    } catch {
      address = null;
    }
    // Identity check, not presence: a rapid unsubscribe→resubscribe during
    // the await replaces the entry — deleting by userId here would tear down
    // the NEWER attach's bookkeeping and orphan (or kill) its upstream subs.
    if (this.stopped || this.users.get(userId) !== entry) return;
    if (!address) {
      // No master wallet yet — the user keeps REST polling. Keep the entry
      // ('' = unresolved) so the retry sweep can pick them up if a wallet is
      // linked mid-session; it clears on last unsubscribe.
      entry.address = '';
      return;
    }
    this.assignShard(userId, entry, address);
  }

  /** Place a resolved user on a shard and open their upstream subs. */
  private assignShard(userId: string, entry: UserEntry, address: string): void {
    const picked = this.pickShard();
    if (picked == null) {
      entry.address = '';
      if (!this.declined.has(userId)) {
        this.declined.add(userId);
        log.warn(
          { userId, cap: this.maxUsersPerShard * this.maxShards },
          'hl-user: streamed-user cap reached — user stays on REST polling',
        );
      }
      return;
    }
    entry.address = address;
    const { index, shard } = picked;
    entry.shardIndex = index;
    shard.users.add(userId);
    this.userByAddress.set(address.toLowerCase(), userId);
    this.ensureShardOpen(shard);
    for (const k of entry.kinds) this.sendSub(shard, address, k, 'subscribe');
  }

  /**
   * Second-chance sweep for still-subscribed users without a live stream:
   * wallet linked mid-session (address resolved null at attach time) or
   * declined at the shard cap (capacity may have freed). Runs every
   * RETRY_SWEEP_MS; each pass re-resolves and re-attempts placement.
   */
  private async retryUnresolved(): Promise<void> {
    if (this.stopped) return;
    for (const [userId, entry] of this.users) {
      if (entry.address !== '' || entry.kinds.size === 0) continue;
      let address: string | null;
      try {
        address = await this.resolveAddress(userId);
      } catch {
        address = null;
      }
      if (this.stopped) return;
      if (this.users.get(userId) !== entry || entry.address !== '') continue;
      if (!address) continue;
      this.declined.delete(userId);
      this.assignShard(userId, entry, address);
    }
  }

  private detach(userId: string, kind: UserStreamKind): void {
    const entry = this.users.get(userId);
    if (!entry) return;
    entry.kinds.delete(kind);
    if (entry.address && entry.shardIndex != null) {
      this.sendSub(this.shards[entry.shardIndex], entry.address, kind, 'unsubscribe');
    }
    if (entry.kinds.size > 0) return;

    this.users.delete(userId);
    this.declined.delete(userId);
    this.lastAccountFp.delete(userId);
    if (entry.address) this.userByAddress.delete(entry.address.toLowerCase());
    if (entry.shardIndex != null) {
      const shard = this.shards[entry.shardIndex];
      if (shard) {
        shard.users.delete(userId);
        if (shard.users.size === 0) this.teardownShard(shard, 'idle');
      }
    }
  }

  /* ── shard management ───────────────────────────────────────────────────── */

  /** First shard with room; create a new one while under the cap. */
  private pickShard(): { index: number; shard: Shard } | null {
    for (let i = 0; i < this.shards.length; i++) {
      const shard = this.shards[i];
      if (shard && shard.users.size < this.maxUsersPerShard) return { index: i, shard };
    }
    if (this.shards.length < this.maxShards) {
      const shard: Shard = {
        ws: null,
        state: 'closed',
        users: new Set(),
        reconnectAttempt: 0,
        reconnectTimer: null,
        pingTimer: null,
      };
      this.shards.push(shard);
      return { index: this.shards.length - 1, shard };
    }
    return null;
  }

  private ensureShardOpen(shard: Shard): void {
    if (shard.ws || shard.state === 'connecting') return;
    this.openShard(shard);
  }

  private openShard(shard: Shard): void {
    shard.state = 'connecting';
    let socket: WsLike;
    try {
      socket = this.wsFactory(this.wsUrl);
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'hl-user: WebSocket constructor threw');
      shard.state = 'closed';
      this.scheduleReconnect(shard);
      return;
    }
    shard.ws = socket;

    socket.onopen = () => {
      shard.state = 'open';
      shard.reconnectAttempt = 0;
      // Re-arm every active subscription this shard carries.
      for (const userId of shard.users) {
        const entry = this.users.get(userId);
        if (!entry?.address) continue;
        for (const k of entry.kinds) this.sendSub(shard, entry.address, k, 'subscribe');
      }
      if (!shard.pingTimer) {
        shard.pingTimer = setInterval(() => {
          this.sendJson(shard, { method: 'ping' });
        }, PING_INTERVAL_MS);
        (shard.pingTimer as { unref?: () => void }).unref?.();
      }
    };

    socket.onmessage = (ev) => this.handleFrame(ev.data);

    socket.onerror = () => {
      // close fires right after — reconnect is handled there.
    };

    socket.onclose = (ev) => {
      feedDisconnectTotal.inc({ venue: VENUE_METRIC, reason: describeCloseReason(ev) });
      shard.ws = null;
      if (shard.pingTimer) {
        clearInterval(shard.pingTimer);
        shard.pingTimer = null;
      }
      if (this.stopped || shard.users.size === 0) {
        shard.state = 'closed';
        return;
      }
      this.scheduleReconnect(shard);
    };
  }

  private scheduleReconnect(shard: Shard): void {
    if (shard.reconnectTimer) return;
    const idx = Math.min(shard.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    shard.reconnectAttempt++;
    shard.state = 'connecting';
    feedReconnectAttemptsTotal.inc({ venue: VENUE_METRIC });
    shard.reconnectTimer = setTimeout(() => {
      shard.reconnectTimer = null;
      if (this.stopped || shard.users.size === 0) {
        shard.state = 'closed';
        return;
      }
      this.openShard(shard);
    }, RECONNECT_BACKOFF_MS[idx]);
    (shard.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private teardownShard(shard: Shard, reason: string): void {
    if (shard.reconnectTimer) {
      clearTimeout(shard.reconnectTimer);
      shard.reconnectTimer = null;
    }
    if (shard.pingTimer) {
      clearInterval(shard.pingTimer);
      shard.pingTimer = null;
    }
    const ws = shard.ws;
    shard.ws = null;
    shard.state = 'closed';
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close(1000, reason);
      } catch {
        // Best-effort close.
      }
    }
  }

  private sendSub(
    shard: Shard | undefined,
    address: string,
    kind: UserStreamKind,
    method: 'subscribe' | 'unsubscribe',
  ): void {
    if (!shard) return;
    const type = kind === 'account' ? 'clearinghouseState' : 'userFills';
    this.sendJson(shard, { method, subscription: { type, user: address } });
  }

  private sendJson(shard: Shard, payload: unknown): void {
    const ws = shard.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'hl-user: WS send failed');
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
    if (parsed?.data == null) return;
    switch (parsed.channel) {
      case 'clearinghouseState': this.onClearinghouseState(parsed.data); break;
      case 'userFills': this.onUserFills(parsed.data); break;
      default:
        // subscriptionResponse / pong / unknown — ignore.
        break;
    }
  }

  private onClearinghouseState(data: unknown): void {
    const d = data as ClearinghouseStateData;
    const userId = this.userIdFor(d?.user);
    if (!userId) return;
    const ch = d.clearinghouseState;
    if (!ch || typeof ch !== 'object') return;

    // Single shared mapper with the REST path — keeps the polling and
    // streaming position shapes (incl. entry-guard + liquidationPx) identical.
    const accountValueUsd = Number(ch.marginSummary?.accountValue ?? '0') || 0;
    const marginUsedUsd = Number(ch.marginSummary?.totalMarginUsed ?? '0') || 0;
    const withdrawableUsd = Number(ch.withdrawable ?? '0') || 0;
    const positions: readonly AccountPosition[] = mapClearinghousePositions(ch.assetPositions);

    // Drop byte-identical snapshots (flat/idle accounts): the venue re-sends
    // on a timer regardless of change, and every publish costs hub fan-out,
    // WS frames, and a client-side render.
    const fp = `${accountValueUsd}|${marginUsedUsd}|${withdrawableUsd}|${positions
      .map((p) => `${p.coin}:${p.sideLong ? 'L' : 'S'}:${p.qty}:${p.unrealizedPnlUsd}:${p.liquidationPriceUsd ?? ''}`)
      .join(',')}`;
    if (this.lastAccountFp.get(userId) === fp) return;
    this.lastAccountFp.set(userId, fp);

    const now = Date.now();
    const event: AccountEvent = {
      t: 'account',
      topic: privAccountTopic(userId),
      ts: now,
      lastTickAgeMs: 0,
      src: 'hl',
      equityUsd: accountValueUsd,
      marginUsedUsd,
      withdrawableUsd,
      accountValueUsd,
      positions,
    };
    this.publish(event, 'account');
  }

  private onUserFills(data: unknown): void {
    const d = data as UserFillsData;
    const userId = this.userIdFor(d?.user);
    if (!userId) return;
    // The first frame after subscribing replays fill HISTORY — that's REST's
    // job (`/hyperliquid/user-fills`); replaying it as live events would
    // toast every historical fill on page load.
    if (d.isSnapshot) return;
    if (!Array.isArray(d.fills)) return;

    const topic: Topic = privFillsTopic(userId);
    const now = Date.now();
    for (const f of d.fills) {
      if (!f?.coin || f.oid == null) continue;
      const px = Number(f.px);
      const sz = Number(f.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      const ts = Number(f.time) || now;
      // Same clock-skew guards as the market adapter's candle path.
      if (ts > now + 60_000) continue;
      const event: FillEvent = {
        t: 'fill',
        topic,
        ts,
        lastTickAgeMs: Math.max(0, now - ts),
        src: 'hl',
        orderId: 'hl_' + String(f.oid),
        coin: String(f.coin).toUpperCase(),
        sideLong: f.side === 'B',
        px,
        sz,
        feeUsd: Number(f.fee ?? '0') || 0,
        closedPnlUsd: f.closedPnl != null ? Number(f.closedPnl) : null,
        dir: String(f.dir ?? ''),
        hash: String(f.hash ?? ''),
        liquidation: f.liquidation != null,
      };
      this.publish(event, 'fill');
    }
  }

  private userIdFor(address: unknown): string | null {
    if (typeof address !== 'string' || !address) return null;
    return this.userByAddress.get(address.toLowerCase()) ?? null;
  }

  private publish(event: AccountEvent | FillEvent, kind: 'account' | 'fill'): void {
    hubMessagesInTotal.inc({ venue: VENUE_METRIC, topic_kind: kind });
    if (!this.hub) return;
    try {
      this.hub.publish(event);
    } catch (err) {
      log.warn({ err: errMsg(err), topic: event.topic }, 'hl-user: hub.publish threw');
    }
  }

  /* ── introspection (tests + health) ─────────────────────────────────────── */

  streamedUserCount(): number {
    let n = 0;
    for (const entry of this.users.values()) {
      if (entry.shardIndex != null) n++;
    }
    return n;
  }

  shardCount(): number {
    return this.shards.length;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

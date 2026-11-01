/**
 * Helius Solana realtime adapter — owns the SOLE upstream Solana RPC
 * WebSocket per pod, subscribes to AMM pool state accounts (Raydium AMM v4,
 * Orca Whirlpool, Meteora DLMM), and derives long-tail meme token mid prices
 * from on-chain pool reserves on every swap. Sibling to `pyth-hermes.ts`:
 * Pyth Hermes covers off-chain blue-chip + equity feeds; this adapter covers
 * the long tail Pyth does NOT index by reading pool state directly.
 *
 * Topics handled (grammar in `topic.ts`):
 *   meme:helius:<mint>      → long-tail meme price tick from pool state
 *   ticker:helius:<mint>    → same data, ticker kind (some screens default to it)
 *
 * Wire protocol — Solana JSON-RPC over WS, accepted verbatim by Helius:
 *   subscribe   → { jsonrpc:"2.0", id, method:"accountSubscribe",
 *                   params:[<poolPubkey>, { encoding:"base64+zstd",
 *                                            commitment:"confirmed" }] }
 *   response    → { jsonrpc:"2.0", result:<subId>, id }
 *   notify      → { jsonrpc:"2.0", method:"accountNotification",
 *                   params:{ result:{ context:{slot}, value:{ data,owner,...}},
 *                            subscription:<subId> } }
 *   unsubscribe → { jsonrpc:"2.0", id, method:"accountUnsubscribe",
 *                   params:[<subId>] }
 *
 * SCAFFOLD-COMPLETE (wired end-to-end, compiles, registers, observable):
 *   - RealtimeAdapter contract surface (venue, start, stop, subscribe,
 *     unsubscribe, snapshot, healthSnapshot).
 *   - One WS per process to HELIUS_RPC_URL, lazy-open on first subscribe.
 *   - JSON-RPC request-id tracking, accountSubscribe / accountUnsubscribe
 *     dispatch, accountNotification → TickEvent decoding loop, sub-id ↔ mint
 *     correlation, fan-out to BOTH `meme:` and `ticker:` topics for one mint.
 *   - Exponential backoff reconnect (1s → 30s cap), re-arms every active sub
 *     on reopen.
 *   - CircuitBreaker wired (5 errs / 30s, 30s base, 5min cap) with stale-tick
 *     emission from `hub.lastFor(topic)` on open.
 *   - Prometheus: feedTickLagMs, feedDisconnectTotal, feedReconnectAttemptsTotal,
 *     feedBreakerState, hubMessagesInTotal, snapshotFillDurationMs — all
 *     labelled `venue:'helius'`.
 *
 * SCAFFOLD-STUB (explicit TODOs — follow-up commits, not this file):
 *   1. `resolvePool(mint)` returns null. Real impl: DexScreener / Jupiter
 *      lookup → cache (poolPubkey, program) tuple. Until then a sub for an
 *      unknown mint registers ref-count but emits no upstream subscribe.
 *   2. Raydium AMM v4 decoder is ARMED (see `decodeRaydiumV4PoolMeta` +
 *      `decodeSplTokenAmount` + `deriveRaydiumMid` in helius-decoders.ts).
 *      Orca Whirlpool and Meteora DLMM decoders are still pending — the
 *      adapter routes only `program === 'raydium'` through the decode path
 *      and returns null for the others (they register subs but never emit).
 *   3. `snapshot(topic)` returns []. Real impl: Jupiter Price API v3 one-shot.
 *   4. HELIUS_RPC_URL env wiring lands when the user provides a real key;
 *      until then the default `wss://mainnet.helius-rpc.com/?api-key=
 *      PUBLIC_DEMO` returns 401 — WS fails to open, breaker trips, which is
 *      the correct degraded shape for "no key yet".
 */

import { CircuitBreaker } from '../breaker.js';
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
  FeedEvent,
  RealtimeAdapter,
  TickEvent,
  Topic,
  VenueHealth,
} from '../types.js';
import type { Hub } from '../hub.js';
import { log } from '../../lib/log.js';
import {
  decodeRaydiumV4PoolMeta,
  decodeSplTokenAmount,
  deriveRaydiumMid,
} from './helius-decoders.js';

// upstream wire shapes — narrow `unknown` against these. Combined into
// `UpstreamFrame` so `handleFrame` discriminates by `method` / `id`.
interface JsonRpcResponseFrame {
  id?: number;
  result?: number | unknown;
  error?: { code?: number; message?: string };
}
interface AccountValue { data?: [string, string] | string }
interface AccountNotificationFrame {
  method?: string;
  params?: { result?: { value?: AccountValue }; subscription?: number };
}
type UpstreamFrame = JsonRpcResponseFrame & AccountNotificationFrame;

const VENUE = 'helius' as const;

// TODO(env): wire HELIUS_RPC_URL through `lib/env.ts` once a real api-key is
// available. The env schema already declares the var (Marinade RPC fallback);
// reading it directly here keeps this adapter from growing a hard dep on a
// configured key. PUBLIC_DEMO returns 401 — WS fails to open, breaker trips,
// which is the correct degraded shape for "no key yet".
const WS_URL =
  process.env.HELIUS_RPC_URL?.replace(/^http/, 'ws') ??
  'wss://mainnet.helius-rpc.com/?api-key=PUBLIC_DEMO';

/** Exponential backoff in ms, capped at 30s. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** prom-client gauge mapping for the breaker state. */
const BREAKER_STATE_GAUGE: Record<'closed' | 'half-open' | 'open', number> = {
  closed: 0, 'half-open': 1, open: 2,
};

// Solana program ids — `resolvePool()` returns one of these to pick a decoder.
const PROGRAM_RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' as const;
const PROGRAM_ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' as const;
const PROGRAM_METEORA_DLMM   = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' as const;

type PoolProgram = 'raydium' | 'orca' | 'meteora';
interface ResolvedPool { poolPubkey: string; program: PoolProgram }

type WsState = 'open' | 'connecting' | 'reconnecting' | 'closed' | 'open-degraded';

/** Cached per-topic parse so accountNotification can fan out per mint. */
interface ParsedHeliusTopic {
  topic: Topic;
  kind: 'meme' | 'ticker';
  mint: string;
}

/**
 * Which account a sub-id / reqId refers to within a mint's state machine.
 *
 * Raydium AMM v4 requires three subscriptions per mint:
 *   - `pool`     : the pool state account. First frame decodes meta
 *                  (`baseVault`/`quoteVault`/`decimals`); subsequent frames
 *                  re-decode meta in case the pool migrates (very rare).
 *                  Does NOT emit price ticks on its own.
 *   - `base`     : the base SPL token vault. Balance updates on every swap.
 *   - `quote`    : the quote SPL token vault. Balance updates on every swap.
 *
 * Mid is recomputed and emitted whenever either vault notifies AND we have
 * both balances populated AND we have decoded pool meta.
 */
type SubKind = 'pool' | 'base' | 'quote';

interface SubRef { mint: string; kind: SubKind }

/** Per-mint upstream state. One pool + two vault subs feed both meme: + ticker: topics. */
interface MintState {
  pool: ResolvedPool | null;
  /** Pool state account subscription. */
  poolSubId: number | null;
  poolPendingReqId: number | null;
  /** Pool meta — populated on first pool frame decode. */
  meta: import('./helius-decoders.js').RaydiumV4PoolMeta | null;
  /** Base SPL token vault subscription (armed AFTER meta is decoded). */
  baseSubId: number | null;
  basePendingReqId: number | null;
  /** Quote SPL token vault subscription (armed AFTER meta is decoded). */
  quoteSubId: number | null;
  quotePendingReqId: number | null;
  /** Latest decoded balances (bigint to preserve precision past 2^53). */
  lastBaseAmt: bigint | null;
  lastQuoteAmt: bigint | null;
  /** meme: + ticker: refs for this mint. */
  refCount: number;
}

/** One instance per process; holds the ONLY upstream WS to Helius. */
export class HeliusSolRealtimeAdapter implements RealtimeAdapter {
  readonly venue = VENUE;

  private hub: Hub | null = null;
  private ws: WebSocket | null = null;
  private wsState: WsState = 'closed';

  // topic → parsed form
  private readonly parsedByTopic = new Map<Topic, ParsedHeliusTopic>();
  // mint → upstream sub state (refcounted across meme: + ticker:)
  private readonly byMint = new Map<string, MintState>();
  // Helius subId → (mint, sub kind) — accountNotification routing
  private readonly refBySubId = new Map<number, SubRef>();
  // outgoing reqId → (mint, sub kind) — accountSubscribe ack routing
  private readonly refByPendingReqId = new Map<number, SubRef>();

  private lastEventAt = -1;
  private nextReqId = 1;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // 5 errs / 30s → open; 30s base cooldown, 5min cap.
  private readonly breaker = new CircuitBreaker({
    failureThreshold: 5,
    windowMs: 30_000,
    baseCooldownMs: 30_000,
    maxCooldownMs: 5 * 60_000,
    onOpen: () => this.onBreakerOpen(),
    onHalfOpen: () => this.onBreakerHalfOpen(),
    onClose: () => this.onBreakerClose(),
  });

  private upstream: 'primary' | 'rest' = 'primary';

  async start(hub: Hub): Promise<void> {
    this.hub = hub;
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.closed);
    // Lazy WS open — first subscribe() opens the socket.
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Best-effort accountUnsubscribe before the close — frees per-account
    // fanout slots if close races a notify. One per active sub kind.
    for (const state of this.byMint.values()) {
      for (const subId of [state.poolSubId, state.baseSubId, state.quoteSubId]) {
        if (subId != null) {
          this.sendJson({
            jsonrpc: '2.0',
            id: this.nextReqId++,
            method: 'accountUnsubscribe',
            params: [subId],
          });
        }
      }
    }
    this.breaker.dispose();
    this.closeSocket('shutdown');
    this.parsedByTopic.clear();
    this.byMint.clear();
    this.refBySubId.clear();
    this.refByPendingReqId.clear();
    this.hub = null;
  }

  subscribe(topic: Topic): void {
    const parsed = this.parseOrNull(topic);
    if (!parsed) return;
    if (this.parsedByTopic.has(topic)) return; // defensive idempotency
    this.parsedByTopic.set(topic, parsed);
    let state = this.byMint.get(parsed.mint);
    if (!state) {
      state = {
        pool: null,
        poolSubId: null, poolPendingReqId: null,
        meta: null,
        baseSubId: null, basePendingReqId: null,
        quoteSubId: null, quotePendingReqId: null,
        lastBaseAmt: null, lastQuoteAmt: null,
        refCount: 0,
      };
      this.byMint.set(parsed.mint, state);
    }
    state.refCount += 1;
    if (state.refCount === 1) {
      this.ensureOpen();
      void this.armUpstreamSub(parsed.mint, state);
    }
  }

  unsubscribe(topic: Topic): void {
    const parsed = this.parsedByTopic.get(topic);
    if (!parsed) return;
    this.parsedByTopic.delete(topic);
    const state = this.byMint.get(parsed.mint);
    if (!state) return;
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount > 0) return;
    // Tear down all three subs for this mint.
    for (const subId of [state.poolSubId, state.baseSubId, state.quoteSubId]) {
      if (subId != null) {
        this.refBySubId.delete(subId);
        this.sendJson({ jsonrpc: '2.0', id: this.nextReqId++, method: 'accountUnsubscribe', params: [subId] });
      }
    }
    for (const reqId of [state.poolPendingReqId, state.basePendingReqId, state.quotePendingReqId]) {
      if (reqId != null) this.refByPendingReqId.delete(reqId);
    }
    this.byMint.delete(parsed.mint);
  }

  async snapshot(topic: Topic): Promise<FeedEvent[]> {
    // TODO(snapshot): wire Jupiter Price API v3 (GET https://lite-api.jup.ag
    // /price/v3?ids=<mint> → { [mint]: { usdPrice } }); emit one synthetic
    // TickEvent with src:'rest'. Until then return [] so the hub falls back
    // to "wait for first WS tick".
    if (!this.parseOrNull(topic)) return [];
    const endTimer = snapshotFillDurationMs.startTimer({ venue: VENUE });
    try { return []; }
    catch (err) { log.warn({ err: errMsg(err), topic }, 'helius-rt: snapshot failed'); return []; }
    finally { endTimer(); }
  }

  healthSnapshot(): VenueHealth {
    let total = 0;
    for (const state of this.byMint.values()) total += state.refCount;
    return {
      ws: this.wsState,
      breakerState: this.breaker.getState(),
      lastEventAgeMs: this.lastEventAt < 0 ? -1 : Math.max(0, Date.now() - this.lastEventAt),
      subscriberCount: total,
      upstream: this.upstream,
    };
  }

  private ensureOpen(): void {
    if (this.ws || this.wsState === 'connecting' || this.wsState === 'reconnecting') return;
    this.openSocket();
  }

  private openSocket(): void {
    this.wsState = this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
    let socket: WebSocket;
    try { socket = new WebSocket(WS_URL); }
    catch (err) {
      log.warn({ err: errMsg(err) }, 'helius-rt: WebSocket constructor threw');
      this.handleSocketFailure('ctor');
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.wsState = 'open';
      this.reconnectAttempt = 0;
      // Re-arm every active mint. Helius assigns fresh sub-ids on reopen — drop
      // every stale ref, re-emit accountSubscribe for the pool (and vaults if
      // we already had decoded meta from a prior connection).
      for (const [mint, state] of this.byMint) {
        for (const subId of [state.poolSubId, state.baseSubId, state.quoteSubId]) {
          if (subId != null) this.refBySubId.delete(subId);
        }
        for (const reqId of [state.poolPendingReqId, state.basePendingReqId, state.quotePendingReqId]) {
          if (reqId != null) this.refByPendingReqId.delete(reqId);
        }
        state.poolSubId = null; state.poolPendingReqId = null;
        state.baseSubId = null; state.basePendingReqId = null;
        state.quoteSubId = null; state.quotePendingReqId = null;
        if (state.pool) this.dispatchPoolSubscribe(mint, state);
        // Vault subs re-arm from onRpcResponse when the pool meta re-decodes.
      }
      this.breaker.noteSuccess();
    };
    socket.onmessage = (ev: MessageEvent) => this.handleFrame(ev.data);
    // close runs immediately after onerror — let it handle reconnect.
    socket.onerror = () => this.breaker.noteFailure();
    socket.onclose = (ev) => {
      feedDisconnectTotal.inc({ venue: VENUE, reason: describeCloseReason(ev as WsCloseLike) });
      this.ws = null;
      // Helius assigns fresh sub-ids on reopen — wipe the maps.
      this.refBySubId.clear();
      this.refByPendingReqId.clear();
      for (const state of this.byMint.values()) {
        state.poolSubId = null; state.poolPendingReqId = null;
        state.baseSubId = null; state.basePendingReqId = null;
        state.quoteSubId = null; state.quotePendingReqId = null;
      }
      if (this.byMint.size === 0) { this.wsState = 'closed'; return; }
      this.scheduleReconnect();
    };
  }

  private closeSocket(reason: string): void {
    if (!this.ws) { this.wsState = 'closed'; return; }
    try {
      // Detach handlers first so close doesn't trigger reconnect.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close(1000, reason);
    } catch { /* best-effort close */ }
    this.ws = null;
    this.wsState = 'closed';
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx];
    this.reconnectAttempt++;
    this.wsState = 'reconnecting';
    feedReconnectAttemptsTotal.inc({ venue: VENUE });
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.openSocket(); }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private handleSocketFailure(_kind: string): void {
    this.breaker.noteFailure();
    if (this.byMint.size > 0) this.scheduleReconnect();
  }

  private sendJson(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(payload)); }
    catch (err) {
      log.warn({ err: errMsg(err) }, 'helius-rt: WS send failed');
      this.breaker.noteFailure();
    }
  }

  /**
   * Resolve `mint` → pool pubkey + program. TODO(pool-discovery): hit
   * DexScreener `/latest/dex/tokens/<mint>` or Jupiter `/tokens/v2/search`,
   * pick the highest-liquidity pool, cache in a per-process LRU. Program
   * ids to match against are exported at the top of the file. Scaffold
   * returns null: topic registers + ref-counts, no upstream sub fires.
   */
  private async resolvePool(mint: string): Promise<ResolvedPool | null> {
    log.debug({ mint }, 'helius-rt: pool discovery stubbed; mint registered without upstream sub');
    void PROGRAM_RAYDIUM_AMM_V4; void PROGRAM_ORCA_WHIRLPOOL; void PROGRAM_METEORA_DLMM;
    return null;
  }

  private async armUpstreamSub(mint: string, state: MintState): Promise<void> {
    if (state.pool) { this.dispatchPoolSubscribe(mint, state); return; }
    let pool: ResolvedPool | null;
    try { pool = await this.resolvePool(mint); }
    catch (err) { log.warn({ err: errMsg(err), mint }, 'helius-rt: resolvePool threw'); return; }
    // Mint may have been unsubscribed mid-await — guard.
    const current = this.byMint.get(mint);
    if (!current || current.refCount === 0 || !pool) return;
    current.pool = pool;
    this.dispatchPoolSubscribe(mint, current);
  }

  private dispatchPoolSubscribe(mint: string, state: MintState): void {
    if (!state.pool || state.poolPendingReqId != null || state.poolSubId != null) return;
    const reqId = this.nextReqId++;
    state.poolPendingReqId = reqId;
    this.refByPendingReqId.set(reqId, { mint, kind: 'pool' });
    this.sendJson({
      jsonrpc: '2.0', id: reqId, method: 'accountSubscribe',
      params: [state.pool.poolPubkey, { encoding: 'base64+zstd', commitment: 'confirmed' }],
    });
  }

  /** Subscribe to one of the SPL token vaults. Called after pool meta decodes. */
  private dispatchVaultSubscribe(mint: string, state: MintState, kind: 'base' | 'quote'): void {
    if (!state.meta) return;
    const pubkey = kind === 'base' ? state.meta.coinVault : state.meta.pcVault;
    const subIdKey = kind === 'base' ? 'baseSubId' : 'quoteSubId';
    const pendingKey = kind === 'base' ? 'basePendingReqId' : 'quotePendingReqId';
    if (state[subIdKey] != null || state[pendingKey] != null) return;
    const reqId = this.nextReqId++;
    state[pendingKey] = reqId;
    this.refByPendingReqId.set(reqId, { mint, kind });
    this.sendJson({
      jsonrpc: '2.0', id: reqId, method: 'accountSubscribe',
      params: [pubkey, { encoding: 'base64+zstd', commitment: 'confirmed' }],
    });
  }

  private handleFrame(raw: unknown): void {
    let frame: UpstreamFrame;
    try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as UpstreamFrame; }
    catch { return; }
    if (!frame || typeof frame !== 'object') return;
    this.lastEventAt = Date.now();
    if (frame.method === 'accountNotification') { this.onAccountNotification(frame); return; }
    if (typeof frame.id === 'number') this.onRpcResponse(frame);
  }

  private onRpcResponse(frame: JsonRpcResponseFrame): void {
    if (frame.error) {
      log.warn({ id: frame.id, code: frame.error.code, msg: frame.error.message }, 'helius-rt: upstream rpc error');
      this.breaker.noteFailure();
      return;
    }
    const reqId = frame.id;
    if (typeof reqId !== 'number') return;
    const ref = this.refByPendingReqId.get(reqId);
    if (!ref) return; // probably an unsubscribe ack
    this.refByPendingReqId.delete(reqId);
    const state = this.byMint.get(ref.mint);
    if (!state) return;
    const subId = typeof frame.result === 'number' ? frame.result : null;
    // Clear the pending slot for this kind.
    if (ref.kind === 'pool')  state.poolPendingReqId = null;
    if (ref.kind === 'base')  state.basePendingReqId = null;
    if (ref.kind === 'quote') state.quotePendingReqId = null;
    if (subId == null) {
      log.warn({ mint: ref.mint, kind: ref.kind }, 'helius-rt: accountSubscribe returned non-numeric result');
      return;
    }
    if (ref.kind === 'pool')  state.poolSubId = subId;
    if (ref.kind === 'base')  state.baseSubId = subId;
    if (ref.kind === 'quote') state.quoteSubId = subId;
    this.refBySubId.set(subId, { mint: ref.mint, kind: ref.kind });
    this.breaker.noteSuccess();
  }

  private onAccountNotification(frame: AccountNotificationFrame): void {
    const subId = frame.params?.subscription;
    if (typeof subId !== 'number') return;
    const ref = this.refBySubId.get(subId);
    if (!ref) return;
    const state = this.byMint.get(ref.mint);
    if (!state || !state.pool) return;
    const bytes = decodeAccountData(frame.params?.result?.value?.data);
    if (!bytes) return;

    if (ref.kind === 'pool') {
      // Decode meta. First successful decode arms the vault subs; subsequent
      // decodes only update meta in case the pool ever migrates.
      const meta = state.pool.program === 'raydium' ? decodeRaydiumV4PoolMeta(bytes) : null;
      if (!meta) return;
      const isFirstMeta = state.meta === null;
      state.meta = meta;
      if (isFirstMeta) {
        // Arm vault subs now that we know the pubkeys + decimals.
        this.dispatchVaultSubscribe(ref.mint, state, 'base');
        this.dispatchVaultSubscribe(ref.mint, state, 'quote');
      }
      // Pool frames don't emit ticks directly — vault frames do.
      return;
    }

    // Base or quote vault frame: decode SPL token amount + recompute mid.
    const amount = decodeSplTokenAmount(bytes);
    if (amount == null) return;
    if (ref.kind === 'base')  state.lastBaseAmt = amount;
    if (ref.kind === 'quote') state.lastQuoteAmt = amount;
    if (state.lastBaseAmt == null || state.lastQuoteAmt == null || !state.meta) return;
    const mid = deriveRaydiumMid({
      coinAmount: state.lastBaseAmt,
      pcAmount: state.lastQuoteAmt,
      coinDecimals: state.meta.coinDecimals,
      pcDecimals: state.meta.pcDecimals,
    });
    if (!Number.isFinite(mid)) return;

    // Fan out to meme: + ticker: variants; skip un-subscribed kinds so metric
    // counts stay honest. Solana exposes only `slot` (no wall time) in
    // accountNotification — lastTickAgeMs=0 = "we just received this".
    const now = Date.now();
    for (const kind of ['meme', 'ticker'] as const) {
      const topic = `${kind}:helius:${ref.mint}` as Topic;
      if (!this.parsedByTopic.has(topic)) continue;
      const ev: TickEvent = { t: 'tick', topic, ts: now, lastTickAgeMs: 0, src: VENUE, px: mid };
      this.publish(ev, kind);
    }
  }

  private onBreakerOpen(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.open);
    this.upstream = 'rest';
    this.wsState = 'open-degraded';
    if (!this.hub) return;
    const now = Date.now();
    for (const [topic, parsed] of this.parsedByTopic) {
      if (parsed.kind !== 'ticker' && parsed.kind !== 'meme') continue;
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
        log.warn({ err: errMsg(err) }, 'helius-rt: breaker-open stale emit failed');
      }
    }
  }

  private onBreakerHalfOpen(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE['half-open']);
    if (this.byMint.size > 0) this.ensureOpen();
  }

  private onBreakerClose(): void {
    feedBreakerState.set({ venue: VENUE }, BREAKER_STATE_GAUGE.closed);
    this.upstream = 'primary';
    if (this.ws && this.wsState === 'open-degraded') this.wsState = 'open';
  }

  private publish(event: FeedEvent, kind: 'ticker' | 'meme'): void {
    hubMessagesInTotal.inc({ venue: VENUE, topic_kind: kind });
    feedTickLagMs.observe({ venue: VENUE, topic_kind: kind }, event.lastTickAgeMs);
    if (!this.hub) return;
    try { this.hub.publish(event); }
    catch (err) { log.warn({ err: errMsg(err), topic: event.topic }, 'helius-rt: hub.publish threw'); }
  }

  private parseOrNull(topic: Topic): ParsedHeliusTopic | null {
    const cached = this.parsedByTopic.get(topic);
    if (cached) return cached;
    const p = parse(topic);
    if (!p || p.venue !== VENUE) return null;
    if (p.kind !== 'meme' && p.kind !== 'ticker') return null;
    return { topic, kind: p.kind, mint: p.symbol };
  }
}

/**
 * Pull raw bytes out of `accountNotification.value.data`. Helius returns
 * `[blob, encoding]` with encoding `base64` or `base64+zstd`.
 * TODO(zstd): wire `@mongodb-js/zstd` / `fzstd` for the zstd path; the
 * decoder stub doesn't read bytes yet, so decompression isn't load-bearing.
 */
function decodeAccountData(data: AccountValue['data']): Uint8Array | null {
  if (!data) return null;
  if (typeof data === 'string') {
    try { return Uint8Array.from(Buffer.from(data, 'base64')); } catch { return null; }
  }
  if (!Array.isArray(data) || data.length < 2) return null;
  const [payload, encoding] = data;
  if (typeof payload !== 'string') return null;
  if (encoding !== 'base64' && encoding !== 'base64+zstd') return null;
  try { return Uint8Array.from(Buffer.from(payload, 'base64')); } catch { return null; }
}

/** Node 22's global WS close event isn't lib.dom `CloseEvent`; we only read `code`. */
interface WsCloseLike { readonly code?: number }

function describeCloseReason(ev: WsCloseLike | null | undefined): string {
  if (!ev) return 'unknown';
  const code = typeof ev.code === 'number' ? ev.code : 0;
  switch (code) {
    case 1000: return 'normal';
    case 1001: return 'going-away';
    case 1006: return 'abnormal';
    case 1011: return 'server-error';
  }
  return code >= 4000 ? `app-${code}` : `code-${code}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Singleton accessor — one upstream WS per process. */
let singleton: HeliusSolRealtimeAdapter | null = null;
export function getHeliusSolRealtimeAdapter(): HeliusSolRealtimeAdapter {
  if (!singleton) singleton = new HeliusSolRealtimeAdapter();
  return singleton;
}

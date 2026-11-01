/**
 * WebSocket transport for the realtime hub.
 *
 * Companion to the SSE transport in `router.ts`. SSE is one-way (the topic
 * set is pinned to the URL at upgrade time); WS lets clients sub/unsub
 * mid-stream, send `ping`, and receive typed `pong` / `err` envelopes
 * without reconnecting. Same auth, same hub, same backpressure caps.
 *
 * Created at module load via `createNodeWebSocket({app})` so the route
 * mount can use the returned `upgradeWebSocket` middleware. The companion
 * `injectWebSocket(server)` MUST be called once after `serve(...)` returns
 * the node http.Server — that hook patches the upgrade event on the same
 * port the REST app listens on.
 *
 * Auth happens at upgrade: the WS lives on a path that requires a session
 * cookie OR `?token=`. We reuse `requireEventStreamSession` semantics by
 * eagerly resolving the token before returning the handler factory, so
 * any rejection turns into a 401 on the upgrade response.
 */

import { createNodeWebSocket } from '@hono/node-ws';
import type { Hono } from 'hono';
import type { WSContext, WSMessageReceive } from 'hono/ws';

/* The main app declares `Bindings` for the Node HTTP request/response.
 * We accept any Hono shape so this module stays decoupled from the app's
 * binding + schema generics. The runtime route registration is fully
 * type-safe through Hono's own middleware composition. */
type AnyHono = Hono<any, any, any>;

import { env } from '../lib/env.js';
import { clientIp as resolveClientIp } from '../lib/rate-limit.js';
import {
  activeRealtimeClients,
  releaseIpSlot,
  releaseRealtimeSlot,
  releaseUserSlot,
  tryAcquireIpSlot,
  tryAcquireRealtimeSlot,
  tryAcquireUserSlot,
} from './capacity.js';
import { log } from '../lib/log.js';
import { setSessionFromTicket, setSessionFromToken } from '../lib/auth.js';
import { ClientLimiter } from './backpressure.js';
import { ensureStarted, getHub } from './registry.js';
import { parse as parseTopic, parsePrivKindTopic, parsePrivTopic } from './topic.js';
import {
  feedSubscribersGauge,
  hubClientsGauge,
  hubMessagesOutTotal,
  realtimeCapacityShedsTotal,
  realtimeEvictionsTotal,
  streamAuthFailuresTotal,
} from './metrics.js';
import type { ClientOp, FeedEvent, ServerOp, Topic } from './types.js';
import type { SubscriberSink } from './hub.js';

/** Live WS client count for `/v1/feeds/health` + metrics. */
let activeWsClients = 0;

/**
 * Structural view of the node `ws` socket behind Hono's WSContext `.raw`
 * (@hono/node-ws). Typed loosely so test doubles / other adapters without a
 * raw socket degrade to the legacy JSON-beat keepalive instead of crashing.
 */
type RawPeerSocket = {
  ping?: (data?: Buffer | string) => void;
  terminate?: () => void;
  on?: (event: 'pong', listener: () => void) => void;
};

/** Hard caps to neutralize protocol-fuzzing attacks. */
const MAX_WS_FRAME_BYTES = 64 * 1024;
const MAX_TOPICS_PER_OP = 256;
const MAX_WS_SEND_QUEUE = 1024;

export function getActiveWsClientCount(): number {
  return activeWsClients;
}

/* ── newest-wins per-user connection registry ────────────────────────────── */

/**
 * Load-harness parity run (HANDOVER-2026-07-19-RPC-PARITY): under flaky-
 * reconnect churn — abrupt drop with no FIN, reconnect 10-60s later with a
 * fresh ticket — the per-user budget stayed pinned by half-open
 * predecessors until the keepalive reaper settled a full ping round
 * (≤ 2 × REALTIME_KEEPALIVE_MS ≈ 60s). The LIVE reconnect was shed
 * `1013 user_capacity` while dead sockets kept the slots; staging ws-ready
 * collapsed to 75.6%. Newest wins instead: at cap, reap the user's OLDEST
 * connection (in practice the zombie) and admit the fresh one. A genuinely
 * live oldest connection losing its slot is the documented budget
 * semantic — the newest device session takes precedence over the cap.
 */
type UserConnEntry = {
  openedAt: number;
  /** Synchronous full teardown + best-effort close(4000, 'superseded'). */
  evict: () => void;
};
const userConns = new Map<string, Set<UserConnEntry>>();

function registerUserConn(userId: string, entry: UserConnEntry): void {
  let set = userConns.get(userId);
  if (!set) {
    set = new Set();
    userConns.set(userId, set);
  }
  set.add(entry);
}

function unregisterUserConn(userId: string, entry: UserConnEntry): void {
  const set = userConns.get(userId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) userConns.delete(userId);
}

/** Reap the user's oldest live connection. True if one was evicted. */
function evictOldestUserConn(userId: string): boolean {
  const set = userConns.get(userId);
  if (!set || set.size === 0) return false;
  let oldest: UserConnEntry | undefined;
  for (const entry of set) {
    if (!oldest || entry.openedAt < oldest.openedAt) oldest = entry;
  }
  if (!oldest) return false;
  oldest.evict();
  return true;
}

/**
 * Scale plan 1.5 (2026-07-02) — one stringify per EVENT, not per
 * client×event. The hub hands the same FeedEvent object to every subscribed
 * sink, so a WeakMap memo turns fan-out serialization from O(clients) CPU
 * per event into O(1); at 1k clients on shared ticker topics this was the
 * projected single-loop saturation point. WeakMap keeps GC semantics —
 * once the hub drops the event, the cached string goes with it.
 */
const eventJsonMemo = new WeakMap<FeedEvent, string>();
export function serializeEvent(event: FeedEvent): string {
  let s = eventJsonMemo.get(event);
  if (s === undefined) {
    s = JSON.stringify(event);
    eventJsonMemo.set(event, s);
  }
  return s;
}

/* ── factory ─────────────────────────────────────────────────────────────── */

export interface WsServerHandles {
  /**
   * Bind to `app.get('/v1/stream/ws', upgradeWebSocket(...))`. Returns the
   * raw middleware from `@hono/node-ws`.
   */
  registerRoute(app: AnyHono): void;
  /**
   * Attach the WS upgrade handler to the node http.Server that `serve()`
   * returns. Idempotent — calling twice is a no-op.
   */
  inject(server: Parameters<ReturnType<typeof createNodeWebSocket>['injectWebSocket']>[0]): void;
}

/**
 * Build the WS server bound to a specific Hono app. The route is NOT mounted
 * here — call `registerRoute(app)` so this module owns the path string in
 * one place. Returns a handle the index.ts wiring calls once after `serve()`.
 */
export function createRealtimeWsServer(app: AnyHono): WsServerHandles {
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  let injected = false;

  const routeHandler = upgradeWebSocket(async (c) => {
    // ── auth gate ────────────────────────────────────────────────────────
    // Same contract as requireEventStreamSession (lib/auth.ts):
    //   - cookie or Bearer header → full session JWT
    //   - ?token= query param → short-lived single-use stream ticket only
    // Full session JWTs are rejected from `?token=` to close the URL-leakage
    // surface (referrer headers, server logs, browser history).
    const header = c.req.header('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const cookieHeader = c.req.header('cookie') ?? '';
    const cookieToken = readCookie(cookieHeader, 'nexa_session');
    const queryToken = c.req.query('token') ?? null;
    // Per-IP budget key — canonical trust-gated resolver (lib/rate-limit.ts
    // clientIp): TRUSTED_PROXY_HOPS picks the x-forwarded-for entry from the
    // RIGHT (Caddy=1 in prod; 0 = forwarded headers ignored, socket peer
    // only). The leftmost hop is client-appendable, so keying on it would let
    // a direct client rotate forged IPs past the per-IP cap — or burn a
    // victim's budget with their address. Codex stop-review fix, 2026-07-16.
    const clientIp = resolveClientIp(c);
    let userId: string | null = null;

    const sessionToken = bearer ?? cookieToken;
    if (sessionToken) {
      const ok = await setSessionFromToken(c, sessionToken).catch(() => false);
      if (ok) {
        const user = c.get('user') as { id?: string } | undefined;
        userId = user?.id ?? null;
      }
    }
    if (!userId && queryToken) {
      const ok = await setSessionFromTicket(c, queryToken).catch(() => false);
      if (ok) {
        const user = c.get('user') as { id?: string } | undefined;
        userId = user?.id ?? null;
      }
    }
    // Credential expiry — setSessionFromToken/setSessionFromTicket already
    // verified the token and stored the relevant session lifetime on context.
    let kickTimer: ReturnType<typeof setTimeout> | null = null;
    if (userId) {
      const expiresAt = c.get('sessionExpiresAt');
      if (typeof expiresAt === 'number') {
        const msUntilExp = (expiresAt * 1000) - Date.now();
        if (msUntilExp > 0 && msUntilExp < 2_147_483_647) {
          kickTimer = setTimeout(() => {
            try { activeWs?.close(1008, 'token_expired'); } catch { /* socket already gone */ }
          }, msUntilExp);
          (kickTimer as { unref?: () => void }).unref?.();
        }
      }
    }
    if (!userId) {
      streamAuthFailuresTotal.inc({ reason: 'unauthorized' });
      // Returning empty handlers + immediate close is the cleanest way to
      // reject from within upgradeWebSocket — the helper closes the socket
      // on the next tick if onOpen close()s.
      return {
        onOpen(_evt, ws) { ws.close(1008, 'unauthorized'); },
        onMessage() {},
        onClose() {},
        onError() {},
      };
    }

    /* ── per-connection state ───────────────────────────────────────────── */
    const sinkId = `ws:${userId}:${Math.random().toString(36).slice(2, 10)}`;
    const limiter = new ClientLimiter({
      maxTopics: env.REALTIME_MAX_TOPICS_PER_CLIENT,
      maxMsgsPerSec: env.REALTIME_MAX_MSGS_PER_SEC,
    });
    await ensureStarted();
    const hub = getHub();

    /**
     * Sink the hub calls. We funnel into a per-connection async queue so a
     * slow client doesn't block the event loop on a synchronous send().
     */
    let aborted = false;
    let finished = false;
    let connEntry: UserConnEntry | null = null;
    let slotHeld = false;
    let userSlotHeld = false;
    let ipSlotHeld = false;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    /** RFC 6455 pong (or any inbound frame) seen since the last ping tick. */
    let peerAlive = true;
    let activeWs: WSContext | null = null;
    let flushing = false;
    const sendQueue: FeedEvent[] = [];

    function flushSendQueue(): void {
      if (flushing) return;
      flushing = true;
      queueMicrotask(() => {
        flushing = false;
        if (aborted || !activeWs) { sendQueue.length = 0; return; }
        while (sendQueue.length > 0) {
          const event = sendQueue.shift()!;
          try {
            activeWs.send(serializeEvent(event));
            const parsed = parseTopic(event.topic);
            if (parsed) hubMessagesOutTotal.inc({ venue: parsed.venue, topic_kind: parsed.kind });
          } catch (err) {
            log.debug({ sinkId, err }, 'ws:send-failed');
            try { activeWs.close(1011, 'send_failed'); } catch { /* socket already gone */ }
            return;
          }
        }
      });
    }

    const sink: SubscriberSink = {
      id: sinkId,
      send(event) {
        if (aborted || !activeWs) return;
        if (sendQueue.length >= MAX_WS_SEND_QUEUE) {
          log.warn({ sinkId, queued: sendQueue.length }, 'ws:send-queue-overflow');
          realtimeCapacityShedsTotal.inc({ reason: 'backpressure' });
          try { activeWs.close(1013, 'backpressure'); } catch { /* socket already gone */ }
          return;
        }
        sendQueue.push(event);
        flushSendQueue();
      },
    };

    /**
     * Full connection teardown — idempotent. Shared by the natural onClose
     * path and by newest-wins eviction (evictOldestUserConn), which must
     * reconcile the slot ledger SYNCHRONOUSLY: the superseding upgrade
     * retries its user-slot acquire on the very next statement, while the
     * victim's own onClose only fires after the close frame settles. The
     * `finished` guard makes that late onClose (and any double-evict race)
     * a no-op; `aborted` stops the hub sink from queueing into a corpse.
     */
    function teardown(): void {
      if (finished) return;
      finished = true;
      aborted = true;
      if (connEntry) { unregisterUserConn(userId!, connEntry); connEntry = null; }
      activeWs = null;
      sendQueue.length = 0;
      if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
      // P3.10 — audit a per-topic unsubscribe BEFORE the hub releases the
      // refcount, mirroring the SSE handler.
      for (const t of limiter.heldTopics()) {
        const parsed = parseTopic(t);
        if (parsed) {
          log.info({
            evt: 'realtime.unsubscribe',
            transport: 'ws',
            userId,
            sinkId,
            topic: t,
            venue: parsed.venue,
            topicKind: parsed.kind,
            reason: 'disconnect',
          }, 'realtime.unsubscribe');
        }
      }
      hub.unsubscribeAll(sink);
      for (const t of limiter.heldTopics()) {
        const parsed = parseTopic(t);
        if (parsed) feedSubscribersGauge.dec({ venue: parsed.venue, topic_kind: parsed.kind });
      }
      activeWsClients = Math.max(0, activeWsClients - 1);
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
      if (ipSlotHeld) { releaseIpSlot(clientIp); ipSlotHeld = false; }
      if (userSlotHeld) { releaseUserSlot(userId!); userSlotHeld = false; }
      if (slotHeld) { releaseRealtimeSlot(); slotHeld = false; }
      hubClientsGauge.set(activeRealtimeClients());
      log.debug({ sinkId }, 'ws:closed');
    }

    return {
      onOpen(_evt, ws) {
        // Scale plan 1.5 — bounded blast radius: past the cap we shed load
        // with 1013 (Try Again Later) instead of degrading every connected
        // client. Cap is env-tunable; raise alongside replicas.
        // Shared WS+SSE budget (capacity.ts): a slot the SSE path also draws
        // from, so shed WS clients can't pivot to SSE to bypass the cap.
        if (!tryAcquireRealtimeSlot()) {
          log.warn({ active: activeRealtimeClients() }, 'ws:capacity-shed');
          realtimeCapacityShedsTotal.inc({ reason: 'capacity' });
          // Mark aborted BEFORE closing: this connection never took a slot or
          // incremented the counter, so its onClose must not release/decrement
          // (an undercount would silently raise the effective cap). And clear
          // the token-expiry kick timer here — onClose early-returns on
          // `aborted`, so a shed connection would otherwise leak one pending
          // timer (+ its closure) per rejected upgrade, exactly during the
          // overload the shed exists to relieve.
          aborted = true;
          if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
          try { (ws as unknown as WSContext).close(1013, 'capacity'); } catch { /* already gone */ }
          return;
        }
        slotHeld = true;
        // Readiness audit 2026-07-16 — sub-budgets inside the global cap so
        // one credential (or one NAT egress) can't drain the whole pool.
        // Release in reverse acquisition order on failure; aborted-before-
        // close mirrors the global-shed path above.
        if (!tryAcquireUserSlot(userId)) {
          // Reconnect-churn hardening (2026-07-19): the budget here is
          // overwhelmingly pinned by half-open predecessors of THIS user —
          // abrupt mobile drops ship no FIN, and the keepalive reaper needs
          // a full ping round to notice. Newest wins: synchronously reap the
          // user's oldest connection and retry the acquire ONCE. The slot
          // ledger reconciles inside evict() → teardown(), so the retry sees
          // the freed slot; the victim's own late onClose is a no-op.
          const evicted = evictOldestUserConn(userId);
          if (!evicted || !tryAcquireUserSlot(userId)) {
            log.warn({ userId }, 'ws:user-capacity-shed');
            realtimeCapacityShedsTotal.inc({ reason: 'user_capacity' });
            aborted = true;
            releaseRealtimeSlot();
            slotHeld = false;
            if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
            try { (ws as unknown as WSContext).close(1013, 'user_capacity'); } catch { /* already gone */ }
            return;
          }
          realtimeEvictionsTotal.inc({ reason: 'user_superseded' });
          log.info({ userId }, 'ws:user-conn-superseded');
        }
        userSlotHeld = true;
        if (!tryAcquireIpSlot(clientIp)) {
          log.warn({ clientIp }, 'ws:ip-capacity-shed');
          realtimeCapacityShedsTotal.inc({ reason: 'ip_capacity' });
          aborted = true;
          releaseUserSlot(userId);
          userSlotHeld = false;
          releaseRealtimeSlot();
          slotHeld = false;
          if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
          try { (ws as unknown as WSContext).close(1013, 'ip_capacity'); } catch { /* already gone */ }
          return;
        }
        ipSlotHeld = true;
        activeWs = ws as unknown as WSContext;
        activeWsClients++;
        hubClientsGauge.set(activeRealtimeClients());
        // Fully counted — expose this connection to newest-wins eviction.
        connEntry = {
          openedAt: Date.now(),
          evict: () => {
            const sock = activeWs;
            teardown();
            try { sock?.close(4000, 'superseded'); } catch { /* already gone */ }
          },
        };
        registerUserConn(userId, connEntry);
        const ready: ServerOp = {
          op: 'ready',
          accepted: [],
          serverVersion: '1',
        };
        try {
          (ws as unknown as WSContext).send(JSON.stringify(ready));
        } catch {
          // Socket closed before we could emit ready — onClose will tidy up.
        }
        // Server keepalive (REALTIME_KEEPALIVE_MS, default 30s): defeats
        // proxy idle-reaping on quiet subscriptions AND reaps half-open
        // peers. Codex review 2026-07-16 [P2]: the old JSON-only beat used
        // ws.send(), which merely QUEUES on a half-open socket (mobile
        // network loss ships no FIN/RST) — nothing threw, so a dead peer
        // held its global/user/IP slots until the OS gave up and could
        // wedge the 8-socket user cap against reconnects. Liveness now
        // rides RFC 6455 ping/pong on the raw node socket (browsers auto-
        // pong in the protocol layer, no client JS involved): each tick
        // first settles the previous round trip; a miss = terminate(), not
        // close() — no close handshake with a dead peer, and the local
        // 'close' event still fires so onClose releases every slot.
        // Inbound frames also mark the peer alive (onMessage), so a client
        // mid-burst can't be reaped over a coalesced pong. The JSON beat
        // stays for L7 proxies whose idle accounting ignores control
        // frames; raw-less adapters (test doubles) keep the legacy
        // send-failure teardown rather than silently losing keepalive.
        if (env.REALTIME_KEEPALIVE_MS > 0) {
          const raw = (ws as unknown as { raw?: RawPeerSocket }).raw;
          const canPing =
            typeof raw?.ping === 'function' && typeof raw?.on === 'function';
          if (canPing) {
            peerAlive = true;
            raw!.on!('pong', () => { peerAlive = true; });
          }
          keepalive = setInterval(() => {
            if (aborted || !activeWs) return;
            if (canPing) {
              if (!peerAlive) {
                log.warn({ sinkId, userId }, 'ws:keepalive-timeout');
                try { raw!.terminate?.(); } catch { /* already gone */ }
                return;
              }
              peerAlive = false;
              try { raw!.ping!(); } catch { /* closed — JSON beat below tears down */ }
            }
            try {
              const beat: ServerOp = { op: 'pong', ts: Date.now() };
              activeWs.send(JSON.stringify(beat));
            } catch {
              try { activeWs.close(1011, 'keepalive_failed'); } catch { /* gone */ }
            }
          }, env.REALTIME_KEEPALIVE_MS);
          (keepalive as { unref?: () => void }).unref?.();
        }
      },

      onMessage(evt, ws) {
        if (aborted) return;
        // Any inbound frame proves the peer's TCP path — never reap a client
        // mid-burst just because its pong coalesced behind data frames.
        peerAlive = true;
        if (!limiter.tryMsg()) {
          emit(ws as unknown as WSContext, { op: 'err', code: 'rate_limited' });
          return;
        }
        const op = parseClientOp(evt.data);
        if (!op) {
          emit(ws as unknown as WSContext, { op: 'err', code: 'internal' });
          return;
        }
        handleOp(op, sink, limiter, hub, ws as unknown as WSContext, userId);
      },

      onClose(_evt, _ws) {
        if (aborted) return;
        teardown();
      },

      onError(_evt, _ws) {
        log.warn({ sinkId }, 'ws:transport-error');
      },
    };
  });

  return {
    registerRoute(target: AnyHono) {
      // Mounted at the absolute `/v1/stream/ws` path so the WS surface
      // mirrors `/v1/stream/sse` regardless of how the SSE sub-router is
      // composed elsewhere. createNodeWebSocket is bound to this same `app`
      // instance, so the upgrade routing line up.
      target.get('/v1/stream/ws', routeHandler);
      // Clean public alias. NEO + MAZE connect here going forward; the
      // legacy /v1/stream/ws path stays alive so the existing tests
      // and any in-flight clients keep working. Same handler, same auth.
      target.get('/ws/markets', routeHandler);
    },
    inject(server) {
      if (injected) return;
      injected = true;
      injectWebSocket(server);
    },
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Cheap cookie-header reader. We only need one value; no need for hono/cookie. */
function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function parseClientOp(raw: WSMessageReceive): ClientOp | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else return null;

  // Reject oversized frames before the JSON parser runs — a 10MB deeply-
  // nested array would block the event loop for ~hundreds of ms in
  // JSON.parse alone. The hub never needs a frame larger than ~64KB
  // (≈ MAX_TOPICS_PER_OP × ~96 char symbols + envelope).
  if (text.length > MAX_WS_FRAME_BYTES) return null;

  try {
    const obj = JSON.parse(text) as { op?: string; topics?: unknown };
    if (obj?.op === 'sub' || obj?.op === 'unsub') {
      if (!Array.isArray(obj.topics)) return null;
      // Truncate before any per-topic work — a single op carrying 100k
      // topic strings would still pass the per-client topic cap CHECK but
      // pay 100k parseTopic + emit-err iterations inline.
      const topics = (obj.topics as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .slice(0, MAX_TOPICS_PER_OP) as Topic[];
      return { op: obj.op, topics };
    }
    if (obj?.op === 'ping') return { op: 'ping' };
    return null;
  } catch {
    return null;
  }
}

function emit(ws: WSContext, op: ServerOp | FeedEvent): void {
  try {
    ws.send(JSON.stringify(op));
  } catch {
    // Socket dead — close handler will clean up.
  }
}

function handleOp(
  op: ClientOp,
  sink: SubscriberSink,
  limiter: ClientLimiter,
  hub: ReturnType<typeof getHub>,
  ws: WSContext,
  userId: string,
): void {
  if (op.op === 'ping') {
    emit(ws, { op: 'pong', ts: Date.now() });
    return;
  }

  if (op.op === 'sub') {
    for (const raw of op.topics) {
      // Per-user ACL — see router.ts for the rationale. WS clients use the
      // same `priv:<userId>:...` reservation; non-matching userId → denied_acl.
      const priv = parsePrivTopic(raw);
      if (priv && priv.userId !== userId) {
        // Hardening: audit log denied_acl. Cross-user probing surface.
        log.warn({
          evt: 'realtime.denied_acl',
          transport: 'ws',
          userId,
          sinkId: sink.id,
          topic: raw,
          claimedUserId: priv.userId,
        }, 'realtime.denied_acl');
        emit(ws, { op: 'err', code: 'denied_acl', topic: raw });
        continue;
      }
      // Recognized priv-namespaced topic (e.g. `priv:<userId>:orders` for
      // the Sprint 1 lifecycle bridge). Bypass the public grammar parser —
      // priv topics are fed by in-process publishers, not venue adapters,
      // so they don't have a kind:venue:symbol shape.
      const privKind = priv ? parsePrivKindTopic(raw) : null;
      if (priv && !privKind) {
        emit(ws, { op: 'err', code: 'topic_invalid', topic: raw });
        continue;
      }
      const parsed = privKind ? null : parseTopic(raw);
      if (!privKind && !parsed) { emit(ws, { op: 'err', code: 'topic_invalid', topic: raw }); continue; }
      if (!limiter.trySub(raw)) { emit(ws, { op: 'err', code: 'topic_cap_exceeded', topic: raw }); continue; }
      try {
        const seed = hub.subscribe(sink, raw);
        if (parsed) feedSubscribersGauge.inc({ venue: parsed.venue, topic_kind: parsed.kind });
        // P3.10 — subscription audit log.
        log.info({
          evt: 'realtime.subscribe',
          transport: 'ws',
          userId,
          sinkId: sink.id,
          topic: raw,
          venue: parsed?.venue ?? (privKind ? 'nexa' : 'unknown'),
          topicKind: parsed?.kind ?? (privKind?.kind ?? 'unknown'),
        }, 'realtime.subscribe');
        if (seed) emit(ws, seed);
      } catch (err) {
        limiter.unsub(raw);
        emit(ws, { op: 'err', code: 'internal', topic: raw });
        log.warn({ topic: raw, err }, 'ws:subscribe-failed');
      }
    }
    return;
  }

  if (op.op === 'unsub') {
    for (const raw of op.topics) {
      hub.unsubscribe(sink, raw);
      limiter.unsub(raw);
      const parsed = parseTopic(raw);
      if (parsed) {
        feedSubscribersGauge.dec({ venue: parsed.venue, topic_kind: parsed.kind });
        log.info({
          evt: 'realtime.unsubscribe',
          transport: 'ws',
          userId,
          sinkId: sink.id,
          topic: raw,
          venue: parsed.venue,
          topicKind: parsed.kind,
          reason: 'client',
        }, 'realtime.unsubscribe');
      }
    }
    return;
  }
}

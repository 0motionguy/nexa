/**
 * Realtime hub HTTP surface.
 *
 *   GET /v1/feeds/health           — public; per-venue health summary
 *   GET /v1/stream/sse?topics=...  — auth'd; server-sent events for FeedEvent
 *
 * Phase A ships SSE only. WebSocket upgrade adds `ws` (or `@hono/node-ws`)
 * and lands as a follow-up under the same `REALTIME_HUB_V1` flag — the
 * router exports `getActiveClientCount()` so the health endpoint and metrics
 * have a single counter regardless of transport.
 *
 * Auth: reuses `requireEventStreamSession` (Bearer / cookie / ?token=) so
 * mobile (Expo) and browser (MAZE) both connect the same way.
 *
 * Topic intake: `?topics=a,b,c` at connect. Each gets passed through
 * `topic.parse()`; invalid entries are skipped with one `err` SSE event so
 * a single typo doesn't drop the whole connection. Client may force-renew
 * by closing + reconnecting with a different list — SSE is one-way by
 * design, no in-stream sub/unsub op.
 *
 * Backpressure: per-connection `ClientLimiter` caps total topics (200 by
 * default). Anything over the cap is rejected with `topic_cap_exceeded`.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { issueTicket, requireRealtimeAuth, requireSession } from '../lib/auth.js';
import { log } from '../lib/log.js';
import { env } from '../lib/env.js';
import { ClientLimiter } from './backpressure.js';
import { summarizeHealth } from './health.js';
import { ensureStarted, getHub } from './registry.js';
import { serializeEvent } from './ws-server.js';
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
import { parse as parseTopic, parsePrivKindTopic, parsePrivTopic } from './topic.js';
import {
  feedSubscribersGauge,
  hubClientTopicsGauge,
  hubClientsGauge,
  hubDroppedTotal,
  hubMessagesOutTotal,
  streamAuthFailuresTotal,
} from './metrics.js';
import type { FeedEvent, Topic } from './types.js';
import type { SubscriberSink } from './hub.js';

const KEEPALIVE_INTERVAL_MS = 15_000;
/**
 * Hard cap on the `?topics=` list size before any parsing happens. Without
 * this, an authenticated client sending 50k entries would force the route
 * to run 50k regex parses + 49.8k error frames inline, blocking the event
 * loop for hundreds of ms. The per-client topic cap (`REALTIME_MAX_TOPICS_PER_CLIENT`)
 * still bounds what actually reaches the hub.
 */
const MAX_TOPICS_PER_REQUEST = 256;
/**
 * Per-connection write queue cap. A slow client (mobile, throttled network)
 * can't drain SSE writes fast enough — without a cap, the queue grows by
 * upstream tick rate × seconds-of-backpressure, pinning RSS in MB-per-client.
 * On overflow we drop ticker updates (latest wins via coalesce — the next
 * one supersedes) and increment `hub_dropped_total` so dashboards see it.
 */
const MAX_QUEUED_EVENTS_PER_CLIENT = 1_000;

/** Tracks live SSE clients for /v1/feeds/health + metrics. */
let activeClients = 0;

export function getActiveClientCount(): number {
  return activeClients;
}

export const realtimeRoutes = new Hono();

/* ── public health endpoint ───────────────────────────────────────────────── */

realtimeRoutes.get('/feeds/health', (c) => {
  const hub = getHub();
  return c.json(summarizeHealth(hub, activeClients));
});

/* ── stream-ticket mint ────────────────────────────────────────────────────
 *
 * Browser SSE clients can't set custom headers and don't always have a
 * same-site cookie (cross-origin deployments, native webviews). They call
 * POST /v1/stream/ticket from a session-authed context (cookie OR Bearer),
 * receive a short-lived single-use JWT, and pass it as ?token= on the
 * subsequent /v1/stream/sse or /v1/stream/ws connect.
 *
 * Full session JWTs are NOT accepted in the URL — tickets close the
 * URL-leakage surface (referrer headers, server logs, browser history) for
 * long-lived credentials without breaking SSE's no-custom-header constraint.
 */
realtimeRoutes.post('/stream/ticket', requireSession, async (c) => {
  const user = c.get('user');
  const { token, expiresAt } = await issueTicket(user, c.get('sessionExpiresAt'));
  return c.json({ ok: true, token, expiresAt });
});

/* ── SSE stream ───────────────────────────────────────────────────────────── */

realtimeRoutes.get('/stream/sse', requireRealtimeAuth, async (c) => {
  await ensureStarted();
  // Hardening 2026-07-03 — draw from the SAME budget as the WS path
  // (capacity.ts). Without this, a shed WS client could pivot to SSE and
  // reopen unlimited streams, bypassing REALTIME_MAX_CLIENTS. Reserve the
  // slot BEFORE any per-connection state so a rejected connect is cheap.
  if (!tryAcquireRealtimeSlot()) {
    return c.json({ ok: false, error: 'realtime_at_capacity' }, 503);
  }
  const hub = getHub();
  const user = c.get('user');
  // Codex review 2026-07-16 — SSE draws from the SAME per-user/per-IP
  // sub-budgets as the WS onOpen path (ws-server.ts). Without this, one
  // credential shed at REALTIME_MAX_CONNS_PER_USER sockets could pivot here
  // and reopen up to REALTIME_MAX_CLIENTS streams, hollowing out the
  // sub-budget hardening. Same acquisition order (global → user → IP),
  // reverse-order release on failure, and the same trust-gated IP resolver
  // (lib/rate-limit clientIp) so forged x-forwarded-for can't dodge the cap
  // on this transport either. Error codes mirror the WS 1013 close reasons.
  if (!tryAcquireUserSlot(user.id)) {
    log.warn({ userId: user.id }, 'sse:user-capacity-shed');
    releaseRealtimeSlot();
    return c.json({ ok: false, error: 'user_capacity' }, 503);
  }
  const ip = resolveClientIp(c);
  if (!tryAcquireIpSlot(ip)) {
    log.warn({ clientIp: ip }, 'sse:ip-capacity-shed');
    releaseUserSlot(user.id);
    releaseRealtimeSlot();
    return c.json({ ok: false, error: 'ip_capacity' }, 503);
  }
  const sinkId = `sse:${user.id}:${Math.random().toString(36).slice(2, 10)}`;

  const limiter = new ClientLimiter({
    maxTopics: env.REALTIME_MAX_TOPICS_PER_CLIENT,
    maxMsgsPerSec: env.REALTIME_MAX_MSGS_PER_SEC,
  });

  const requested = (c.req.query('topics') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_TOPICS_PER_REQUEST);

  // The shared budget slot is held from here (acquired above) until the
  // stream callback's guarded cleanup releases it.
  return streamSSE(c, async (stream) => {
    activeClients++;
    hubClientsGauge.set(activeRealtimeClients());

    let aborted = false;
    let released = false;
    let sink: SubscriberSink | null = null;
    let requestAbortListener: (() => void) | null = null;

    // One connection-scoped lease owns every teardown side effect. Hono can
    // report one disconnect through response cancellation, the request
    // signal, and a failed writer, so this guard is ownership-idempotent.
    const cleanup = (): void => {
      if (released) return;
      released = true;
      aborted = true;

      if (requestAbortListener) {
        c.req.raw.signal.removeEventListener('abort', requestAbortListener);
        requestAbortListener = null;
      }

      const heldTopics = [...limiter.heldTopics()];
      for (const t of heldTopics) {
        const parsed = parseTopic(t);
        if (parsed) {
          log.info({
            evt: 'realtime.unsubscribe',
            transport: 'sse',
            userId: user.id,
            sinkId,
            topic: t,
            venue: parsed.venue,
            topicKind: parsed.kind,
            reason: 'disconnect',
          }, 'realtime.unsubscribe');
        }
      }
      if (sink) hub.unsubscribeAll(sink);
      for (const t of heldTopics) {
        const parsed = parseTopic(t);
        if (parsed) feedSubscribersGauge.dec({ venue: parsed.venue, topic_kind: parsed.kind });
      }

      activeClients = Math.max(0, activeClients - 1);
      // Reverse acquisition order: IP, user, then the shared global slot.
      releaseIpSlot(ip);
      releaseUserSlot(user.id);
      releaseRealtimeSlot();
      hubClientsGauge.set(activeRealtimeClients());
      log.debug({ sinkId }, 'sse:closed');
    };

    // Register both lifecycle signals before the first subscription or write.
    stream.onAbort(cleanup);
    requestAbortListener = () => {
      cleanup();
      stream.abort();
    };
    c.req.raw.signal.addEventListener('abort', requestAbortListener, { once: true });
    if (c.req.raw.signal.aborted) {
      requestAbortListener();
      return;
    }

    try {

    // Buffer events that arrive between when the hub fires `send()` and when
    // the SSE writer flushes — Hono's writeSSE is async so we queue.
    const queue: FeedEvent[] = [];
    let pumping = false;

    const writeSse = async (message: Parameters<typeof stream.writeSSE>[0]): Promise<void> => {
      try {
        await stream.writeSSE(message);
      } catch (err) {
        log.debug({ sinkId, err }, 'sse:write-failed');
        cleanup();
        stream.abort();
        throw err;
      }
      if (stream.aborted) {
        cleanup();
        throw new Error('SSE stream aborted during write');
      }
    };

    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length && !aborted) {
          const event = queue.shift()!;
          await writeSse({
            event: event.t,
            // Hardening 2026-07-03 — share the per-event serialization memo
            // with the WS path: same hub, same event objects, one stringify.
            data: serializeEvent(event),
          });
          const parsed = parseTopic(event.topic);
          if (parsed) {
            hubMessagesOutTotal.inc({ venue: parsed.venue, topic_kind: parsed.kind });
          }
        }
      } catch (err) {
        log.debug({ sinkId, err }, 'sse:write-failed');
        cleanup();
        stream.abort();
      } finally {
        pumping = false;
      }
    };

    sink = {
      id: sinkId,
      send: (event) => {
        if (aborted) return;
        // Slow-client guard: cap the per-connection queue. When over, drop
        // the OLDEST event so the new tick still lands — last-write-wins is
        // safer than dropping the freshest for the chart use case.
        if (queue.length >= MAX_QUEUED_EVENTS_PER_CLIENT) {
          queue.shift();
          const parsed = parseTopic(event.topic);
          hubDroppedTotal.inc({
            venue: parsed?.venue ?? 'rest',
            reason: 'slow_client',
          });
        }
        queue.push(event);
        void pump();
      },
    };

    /* ── subscribe to requested topics ─────────────────────────────────── */
    const accepted: Topic[] = [];
    for (const raw of requested) {
      // Per-user ACL gate (P3.8). Reserved `priv:<userId>:...` prefix — only
      // the matching authenticated user can subscribe. Today no `priv:` topics
      // ship; this is forward-compatible coverage so the first private feed
      // (positions, fills, alerts) can't accidentally leak to other authed users.
      const priv = parsePrivTopic(raw);
      if (priv && priv.userId !== user.id) {
        // Hardening: audit log denied_acl. This is the security signal — a
        // ratelimit-level spike here means cross-user probing.
        log.warn({
          evt: 'realtime.denied_acl',
          transport: 'sse',
          userId: user.id,
          sinkId,
          topic: raw,
          claimedUserId: priv.userId,
        }, 'realtime.denied_acl');
        await writeSse({
          event: 'err',
          data: JSON.stringify({ code: 'denied_acl', topic: raw }),
        });
        continue;
      }
      // Sprint 1 lifecycle bridge — recognized priv-namespaced topic (e.g.
      // `priv:<userId>:orders`) bypasses the public grammar parser.
      const privKind = priv ? parsePrivKindTopic(raw) : null;
      if (priv && !privKind) {
        await writeSse({
          event: 'err',
          data: JSON.stringify({ code: 'topic_invalid', topic: raw }),
        });
        continue;
      }
      const parsed = privKind ? null : parseTopic(raw);
      if (!privKind && !parsed) {
        await writeSse({
          event: 'err',
          data: JSON.stringify({ code: 'topic_invalid', topic: raw }),
        });
        continue;
      }
      if (!limiter.trySub(raw as Topic)) {
        await writeSse({
          event: 'err',
          data: JSON.stringify({ code: 'topic_cap_exceeded', topic: raw }),
        });
        continue;
      }
      try {
        const snapshot = hub.subscribe(sink, raw as Topic);
        accepted.push(raw as Topic);
        if (parsed) feedSubscribersGauge.inc({ venue: parsed.venue, topic_kind: parsed.kind });
        // P3.10 — subscription audit log. Sample 1:1; topic_kind cardinality
        // is bounded so the volume tracks active SSE clients × their topic
        // set, which Grafana can group by user / venue / topic_kind.
        log.info({
          evt: 'realtime.subscribe',
          transport: 'sse',
          userId: user.id,
          sinkId,
          topic: raw,
          venue: parsed?.venue ?? (privKind ? 'nexa' : 'unknown'),
          topicKind: parsed?.kind ?? (privKind?.kind ?? 'unknown'),
        }, 'realtime.subscribe');
        if (snapshot) {
          // Seed the client with the last-known event so the first paint is
          // immediate instead of waiting for the next upstream tick.
          await writeSse({
            event: snapshot.t,
            data: JSON.stringify(snapshot),
          });
        }
      } catch (err) {
        if (aborted) throw err;
        limiter.unsub(raw as Topic);
        await writeSse({
          event: 'err',
          data: JSON.stringify({ code: 'internal', topic: raw }),
        });
        log.warn({ sinkId, topic: raw, err }, 'sse:subscribe-failed');
      }
    }

    hubClientTopicsGauge.set(
      [...hub.activeTopics()].reduce((n, t) => n + hub.refCountFor(t), 0),
    );

    await writeSse({
      event: 'ready',
      data: JSON.stringify({ accepted, serverVersion: '1' }),
    });

    /* ── keepalive ping loop ───────────────────────────────────────────── */
    while (!aborted) {
      await stream.sleep(KEEPALIVE_INTERVAL_MS);
      if (aborted) break;
      try {
        await writeSse({ event: 'ping', data: String(Date.now()) });
      } catch {
        cleanup();
        stream.abort();
        break;
      }
    }
    } catch (err) {
      if (!aborted) throw err;
    } finally {
      cleanup();
    }
  });
});

/**
 * Called by `index.ts` on graceful shutdown so in-flight SSE streams release
 * their hub subscriptions promptly. SSE connections close themselves when
 * the server stops; this is belt-and-braces.
 */
export function dropAllStreamingClients(reason: string): void {
  // Currently a no-op: each client's guarded cleanup is wired to response
  // cancellation, request abort, writer failure, and callback finalization.
  // Kept as a hook for forced server-side disconnect support.
  log.info({ reason, activeClients }, 'realtime:drop-all-streaming-clients');
}

// On unauth attempts, the auth middleware itself returns 401 — record the
// failure here for the metric so dashboards can show denial rate without
// scraping per-route status codes.
realtimeRoutes.use('/stream/sse', async (c, next) => {
  await next();
  if (c.res.status === 401) {
    streamAuthFailuresTotal.inc({ reason: 'unauthorized' });
  }
});

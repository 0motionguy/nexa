/**
 * NEXA API — Hono on Node. One process serves:
 *   REST (session-auth app surface + agent-key x402 client)
 *   MCP  (Streamable HTTP at /mcp, agent-key auth)
 *   SSE  (/activity/stream)
 *
 * Caddy health contract: GET /healthz → {"ok":true} (2xx). /metrics is
 * blocked at the edge; the in-process route here is gated on
 * features.metrics + a Bearer METRICS_TOKEN as belt-and-braces.
 *
 * Boot order: env validated -> store factory resolved (top-level await in
 * store/index.ts) -> routes mounted -> approval worker started (if Redis
 * present) -> HTTP server bound. Scheduled sweeps run in workers/scheduler.ts.
 */

// First line: side-effect import that initialises Sentry before any other
// module (Hono, @hono/node-server) patches node:http. Sentry's
// httpIntegration auto-instruments the global http module on init; if Hono's
// server binds first, those handlers aren't wrapped.
import './lib/sentry-bootstrap.js';

import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { env, features } from './lib/env.js';
import { log } from './lib/log.js';
import { errorHandler } from './lib/errors.js';
import { getRegistry, recordHttpDuration } from './lib/metrics.js';
import { createActivityPushNotifier, createWebPushSender } from './lib/push-notifications.js';
import { clientIp, pingRedis, rateLimit } from './lib/rate-limit.js';
import {
  combineWorkerHeartbeats,
  evaluateMoneyHealth,
  evaluateReadiness,
  readWorkerHeartbeatMs,
} from './lib/health.js';
import { requireSession } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { ledgerRoutes } from './routes/ledger.js';
import { paymentRoutes } from './routes/payments.js';
import { offerRoutes, checkoutRoutes } from './routes/offers.js';
import { v1Routes } from './routes/v1.js';
import { keyRoutes } from './routes/keys.js';
import { earnRoutes, swapRoutes } from './routes/earn.js';
import { cardRoutes, getCardState } from './routes/card.js';
import { agentRoutes } from './routes/agent.js';
import { x402Routes } from './routes/x402.js';
import { bridgeRoutes } from './routes/bridge.js';
import { kycRoutes } from './routes/kyc.js';
import { claimRoutes } from './routes/claim.js';
import { isPublicMarketReadPath, marketRoutes } from './routes/markets.js';
import { realtimeRoutes } from './realtime/router.js';
import { createRealtimeWsServer, getActiveWsClientCount } from './realtime/ws-server.js';
import { getHub } from './realtime/registry.js';
import type { HealthzRealtime } from '@nexa/shared-zod';
import { marketsCardsRoutes } from './routes/markets-cards.js';
import { tvRoutes } from './routes/tv.js';
import { campaignsRoutes } from './routes/campaigns.js';
import { perksRoutes } from './routes/perks.js';
import { adminRoutes } from './routes/admin.js';
import { moneriumRoutes } from './routes/monerium.js';
import { onrampRoutes } from './routes/onramp.js';
import { transfersRoutes, balancesRoutes } from './routes/transfers.js';
import { spendRoutes } from './routes/spend.js';
import { pushRoutes } from './routes/push.js';
import { systemRoutes } from './routes/system.js';
import { configRoutes } from './routes/config.js';
import { wellknownRoutes } from './routes/wellknown.js';
import { handleMcpRequest } from './mcp/server.js';
import { store, storeBoot } from './store/index.js';
import { getChainStack } from './lib/chain/index.js';
import { buildChainMirror } from './lib/chain/chain-mirror.js';
import { startApprovalWorker, stopApprovalWorker } from './workers/approvals.js';

// Sprint 12 Phase 0 — wire the chain mirror at module load so that the first
// earnDeposit / earnWithdraw call (auto-divest, topUp tail, or explicit route)
// routes through EarnRouter under the user's preferredVaultTier preference.
// Best-effort: failures inside the mirror are swallowed; the ledger move stays.
store.attachChainMirror(buildChainMirror(getChainStack(), store));
const activityPushNotifier = createActivityPushNotifier({
  store,
  sender: createWebPushSender(),
  enabled: features.push,
});
store.bus.on('activity', (userId: string, activity) => {
  void activityPushNotifier.notifyActivity(userId, activity);
});

type Bindings = HttpBindings;

export const app = new Hono<{ Bindings: Bindings }>();

/* request id + access log */
app.use('*', async (c, next) => {
  const id = c.req.header('x-request-id') ?? randomUUID().slice(0, 8);
  c.header('x-request-id', id);
  c.set('requestId', id);
  const t0 = performance.now();
  await next();
  const elapsedMs = performance.now() - t0;
  const logFn = elapsedMs > 1000 ? log.warn.bind(log) : log.info.bind(log);
  logFn(
    {
      id,
      m: c.req.method,
      p: c.req.path,
      s: c.res.status,
      ms: Math.round(elapsedMs),
    },
    elapsedMs > 1000 ? 'slow' : 'req',
  );
  // Record the Prometheus histogram only on routed requests — routePath is
  // the templated pattern (e.g. /offers/:id) so cardinality stays bounded.
  // /metrics is skipped inside recordHttpDuration.
  const route = c.req.routePath ?? c.req.path;
  recordHttpDuration(c.req.method, route, c.res.status, elapsedMs);
});

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      const allowed = [
        env.WEB_ORIGIN,
        env.PORTAL_ORIGIN,
        'https://maze.bank',
        'https://app.maze.bank',
        'https://checkout.maze.bank',
        'https://dev.maze.bank',
        'https://maze.aiso.tools',
        'https://nexa.aiso.tools',
        'https://portal.nexa.aiso.tools',
        'https://maze.to',
        'https://neo.aiso.tools',
        'http://localhost:5173',
        'http://localhost:4173',
        'http://localhost:8081',
      ];
      return allowed.includes(origin) ? origin : undefined;
    },
    allowHeaders: [
      'Authorization',
      'Content-Type',
      'X-Nexa-Key',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      'X-Region',
      'Idempotency-Key',
      'X-Idempotency-Key',
    ],
    exposeHeaders: ['X-PAYMENT', 'X-Request-Id', 'Mcp-Session-Id', 'Retry-After'],
    credentials: true,
  }),
);

/**
 * Prometheus scrape endpoint. Mounted BEFORE auth — gated by feature flag +
 * Bearer METRICS_TOKEN so even when enabled, scrapes need the token. Caddy
 * also blocks /metrics at the edge so production scraping only works from
 * inside the data network.
 *
 * Returns 404 when the feature is off so the surface looks identical to a
 * non-observability build. Content-Type matches the prom-client default
 * (`text/plain; version=0.0.4`).
 */
app.get('/metrics', async (c) => {
  if (!features.metrics) return c.json({ ok: false, error: 'not_found' }, 404);
  const auth = c.req.header('authorization') ?? '';
  const expected = env.METRICS_TOKEN ? `Bearer ${env.METRICS_TOKEN}` : null;
  if (!expected) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  const reg = getRegistry();
  const body = await reg.metrics();
  return c.text(body, 200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  });
});

app.get('/healthz', async (c) => {
  // F094 Sprint 18 — Caddy + Cloudflare uplinks consume /healthz to mark a pod
  // healthy. Probe BOTH backends — Postgres via store.ping() (when storeBoot
  // is postgres-backed), Redis via the rate-limit module's existing client.
  // Either failing flips ok:false and returns 503 so the load balancer drains
  // the pod instead of routing money flows to a half-broken instance.
  const dbOk = store.ping ? await store.ping() : true;
  const redisState = await pingRedis();
  const dbState =
    storeBoot.backend === 'postgres' ? (dbOk ? 'connected' : 'down') : 'in-memory';
  const healthy = dbOk && redisState !== 'down';
  // Non-fatal realtime section. A provider reconnect / breaker-open is normal
  // and MUST NOT factor into the pod-level `healthy` flag — otherwise a flaky
  // upstream like Hyperliquid would drain the entire money API. Surface the
  // status so operators can see it from the same endpoint Caddy probes.
  let realtime: HealthzRealtime = { disabled: true };
  if (env.REALTIME_HUB_V1) {
    try {
      const hub = getHub();
      const hl = hub.getAdapter('hl')?.healthSnapshot();
      const pm = hub.getAdapter('pm')?.healthSnapshot();
      realtime = {
        ...(hl ? { hyperliquid: hl } : {}),
        ...(pm ? { polymarket: pm } : {}),
        clients: getActiveWsClientCount(),
      };
    } catch {
      // Hub introspection should never throw, but if a venue's
      // healthSnapshot() does, fall back to disabled so /healthz still
      // returns 200. Realtime is non-fatal by design.
      realtime = { disabled: true };
    }
  }
  const payload = {
    ok: healthy,
    demo: env.DEMO_MODE,
    name: 'nexa-api',
    version: '1.1.0',
    backend: storeBoot.backend,
    db: dbState,
    redis: redisState === 'ok' ? 'connected' : redisState,
    features: {
      privy: features.privy,
      resend: features.resend,
      chain: features.chain,
      lifi: features.lifi,
      push: features.push,
    },
    realtime,
  };
  return c.json(payload, healthy ? 200 : 503);
});

/**
 * W2-A honest readiness — the compose healthcheck consumes this instead of
 * /healthz (which is kept byte-compatible above for legacy uplinks).
 * Fail-closed: production non-demo on the in-memory backend, a failing
 * Postgres ping, or dead/unconfigured Redis → 503 so the LB drains the pod.
 * Demo stays ready and reports its in-memory backend honestly.
 */
app.get('/health/ready', async (c) => {
  const dbOk = store.ping ? await store.ping() : true;
  const redisState = await pingRedis();
  const report = evaluateReadiness({
    nodeEnv: env.NODE_ENV,
    demoMode: env.DEMO_MODE,
    backend: storeBoot.backend,
    dbOk,
    redisState,
  });
  return c.json(report.body, report.status);
});

/**
 * W2-A/W2-B money-path liveness — heartbeat freshness for EVERY money-path
 * worker: the in-process approvals worker (workers/approvals.ts) AND the
 * standalone scheduler owning the bridge/fills queues (workers/scheduler.ts).
 * combineWorkerHeartbeats() fails closed — either beat missing/stale → 503 —
 * so a dead scheduler can no longer stall transfers while money-health stays
 * green. Body carries per-worker beats for on-call triage. Demo: honest skip.
 */
app.get('/health/money', async (c) => {
  const approvalsMs = await readWorkerHeartbeatMs(storeBoot.redis, 'approvals');
  const schedulerMs = await readWorkerHeartbeatMs(storeBoot.redis, 'scheduler');
  const report = evaluateMoneyHealth({
    demoMode: env.DEMO_MODE,
    redisConfigured: features.redis,
    heartbeatMs: combineWorkerHeartbeats(approvalsMs, schedulerMs),
  });
  return c.json(
    { ...report.body, heartbeats: { approvals: approvalsMs, scheduler: schedulerMs } },
    report.status,
  );
});

/* ── Rate limiting (Sprint 11 Phase 0) ─────────────────────────────────────
 * Mounted BEFORE route handlers so 429s flow through ε's errorHandler. Key
 * shapes are scoped to the abuse vector each path actually has:
 *   /auth/start + /verify + /privy-verify — IP + email-or-challengeId so
 *     a brute-forcer can't spread over emails; auth.spec scenarios use
 *     RATE_LIMIT_ENABLED=false via per-test env override (see test setup).
 *   /mcp - agent key, hashed by the limiter so a stolen key has a
 *     bounded blast radius without coupling rate to source IP.
 *   inbound webhooks — IP only; we trust signature verification to gate
 *     the body, the rate limit is just a flood guard.
 *   /tv/* - IP only; public TradingView reads open upstream socket work.
 *   /markets/* - trading + transfer POSTs keyed by bearer/API key (IP for
 *     anonymous). Public market-data GETs are NOT rate limited: every one of
 *     them is served through the in-process response cache (request-coalesced,
 *     stale-serving), so a read burst costs cache hits, never upstream calls —
 *     and the app's own screens can never 429 themselves into "provider
 *     unavailable". Authed position reads keep their own dedicated bucket.
 *   /earn/ethena - IP only; public reads can fan out upstream.
 *   /v1/* - api key, hashed by the limiter so cross-tenant fairness holds.
 * In-memory backend is the default; Redis takes over when REDIS_URL is set.
 */
const authKeyFn = async (c: import('hono').Context): Promise<string | null> => {
  const ip = clientIp(c);
  // Best-effort: read the email/challengeId from the parsed body. We can't
  // await the json() twice (Hono consumes it once), so we use the raw text
  // and parse defensively. Failures fall back to ip-only so the limit is
  // still applied.
  try {
    const raw = await c.req.raw.clone().text();
    if (raw) {
      const body = JSON.parse(raw) as { email?: unknown; challengeId?: unknown };
      const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
      const cid = typeof body.challengeId === 'string' ? body.challengeId : '';
      const tail = email || cid;
      if (tail) return `${ip}|${tail}`;
    }
  } catch {
    // fall through to ip-only
  }
  return ip;
};

const mcpKeyFn = (c: import('hono').Context): string | null => {
  const raw = c.req.header('x-nexa-key') ?? '';
  const bearer = c.req.header('authorization') ?? '';
  const tok = raw || (bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
  if (!tok) return clientIp(c); // anonymous MCP probes get IP-bucketed
  return tok;
};

const webhookKeyFn = (c: import('hono').Context): string => clientIp(c);

const authOrIpKeyFn = (c: import('hono').Context): string => {
  const raw = c.req.header('x-nexa-key') ?? '';
  const bearer = c.req.header('authorization') ?? '';
  const tok = raw || (bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
  return tok || clientIp(c);
};
const v1KeyFn = (c: import('hono').Context): string | null => {
  const raw = c.req.header('x-nexa-key') ?? '';
  const bearer = c.req.header('authorization') ?? '';
  const tok = raw || (bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
  if (!tok) return clientIp(c);
  return tok;
};

const marketPositionReadPaths = new Set([
  '/markets/positions',
  '/markets/hyperliquid/positions',
  '/markets/hyperliquid-spot/user-state',
  '/markets/hyperliquid-spot/positions',
  '/markets/jupiter/positions',
  '/markets/polymarket/positions',
  '/markets/stocks/positions',
  '/markets/cards/positions',
]);

// Public market GETs skip the limiter entirely — the route-level response
// cache is the abuse shield (hammering yields cache hits; upstream sees at
// most one call per TTL per key). Only mutations consume the markets bucket;
// position GETs are covered by their own dedicated bucket below.
const marketsKeyFn = (c: import('hono').Context): string | null =>
  c.req.method === 'GET' ? null : authOrIpKeyFn(c);

// Scale plan 1.1 (2026-07-02) — shared, non-personalized market JSON is
// byte-identical for every caller (same predicate as the public session
// gate, exported from routes/markets.ts so the two can't drift). Let the
// edge absorb the fleet: `s-maxage` serves the swarm from Cloudflare while
// an EXPLICIT `max-age=0` forces every BROWSER to revalidate — critical for
// a money app, and it makes the origin's intent unambiguous regardless of
// Cloudflare's zone Browser-Cache-TTL (measured 2026-07-03: CF was
// injecting max-age=14400 = 4h onto these price responses; a live mids feed
// cached 4h in-browser freezes entry/liq math).
// OPS (both required before the edge behaves): the /api/markets/* + /api/earn
// Cache Rule must be "Eligible for cache" AND "Browser Cache TTL: Respect
// Existing Headers" so CF stops overriding our max-age. Until then
// Cf-Cache-Status stays DYNAMIC (header is already correct). See
// docs/SCALE-PLAN-10K.md §6.
const EDGE_CACHEABLE_EARN_TILES = /^\/earn\/(landing|ethena|jupiter-lend)\/?$/;
// Hardening 2026-07-03: sub-second price surfaces (mids feeding entry/liq
// math, the live orderbook) must not inherit the blanket 3s — their route
// TTLs are 1s/500ms by deliberate choice. They still get s-maxage=1 so the
// edge absorbs a stampede without adding meaningful staleness. Covers ALL
// three all-mids feeds (perps, spot, stocks/HIP-3) — each backs an order
// sheet's notional/entry math — plus the HL orderbook.
const EDGE_PRICE_CRITICAL =
  /\/markets\/((hyperliquid|hyperliquid-spot|stocks)\/all-mids|hyperliquid\/orderbook)\/?$/;
const edgeCacheShared = async (c: import('hono').Context, next: () => Promise<void>): Promise<void> => {
  await next();
  if (c.req.method !== 'GET') return;
  if (c.res.headers.has('cache-control')) return;
  const path = c.req.path;
  const cacheable =
    c.res.status === 200 && (isPublicMarketReadPath(path) || EDGE_CACHEABLE_EARN_TILES.test(path));
  if (cacheable) {
    c.res.headers.set(
      'Cache-Control',
      EDGE_PRICE_CRITICAL.test(path)
        ? 'public, max-age=0, s-maxage=1, stale-while-revalidate=2'
        : 'public, max-age=0, s-maxage=3, stale-while-revalidate=30',
    );
  } else {
    // Hardening 2026-07-03: cacheability is DECLARED for every GET under
    // these mounts, never left implicit. Personalized reads (fills,
    // positions, portfolio, user-state) and error responses get an explicit
    // `private, no-store`, so no cache layer — Cloudflare rule drift, a
    // corporate proxy, a browser heuristic — can ever store one user's
    // money data and serve it to another. The Cache Rule at the edge is an
    // optimization; this header is the contract.
    c.res.headers.set('Cache-Control', 'private, no-store');
  }
};
app.use('/markets/*', edgeCacheShared);
app.use('/earn/*', edgeCacheShared);
app.use(
  '/auth/start',
  rateLimit({ windowSeconds: 600, limit: 5, keyFn: authKeyFn, namespace: 'auth-start' }),
);
app.use(
  '/auth/verify',
  rateLimit({ windowSeconds: 600, limit: 5, keyFn: authKeyFn, namespace: 'auth-verify' }),
);
app.use(
  '/auth/privy-verify',
  rateLimit({ windowSeconds: 600, limit: 5, keyFn: authKeyFn, namespace: 'auth-privy' }),
);
app.use(
  '/bridge/webhook',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: webhookKeyFn, namespace: 'wh-bridge' }),
);
app.use(
  '/bridge/transfer-webhook',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: webhookKeyFn, namespace: 'wh-bridge-xfer' }),
);
app.use(
  '/kyc/webhook',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: webhookKeyFn, namespace: 'wh-kyc' }),
);
app.use(
  '/checkout/stripe-webhook',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: webhookKeyFn, namespace: 'wh-stripe' }),
);
app.use(
  '/onramp/stripe/webhook',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: webhookKeyFn, namespace: 'wh-onramp-stripe' }),
);
// Sprint 13 COMMIT 5 (SR1) — /checkout/session-status is a public poll that
// reveals buyer+amount metadata; IP-bucket it so an attacker can't brute-
// force sessionIds at line rate. 10/min is well above the legitimate poll
// cadence (the post-Stripe-redirect SPA polls a handful of times before
// settling).
app.use(
  '/checkout/session-status',
  rateLimit({ windowSeconds: 60, limit: 10, keyFn: webhookKeyFn, namespace: 'checkout-status' }),
);
app.use(
  '/tv/*',
  rateLimit({ windowSeconds: 60, limit: 30, keyFn: webhookKeyFn, namespace: 'tv' }),
);
const marketPositionsRateLimit = rateLimit({
  windowSeconds: 60,
  limit: 600,
  keyFn: authOrIpKeyFn,
  namespace: 'market-positions',
});
for (const path of marketPositionReadPaths) {
  app.use(path, marketPositionsRateLimit);
}
app.use(
  '/markets/*',
  rateLimit({ windowSeconds: 60, limit: 120, keyFn: marketsKeyFn, namespace: 'markets' }),
);
app.use(
  '/earn/ethena',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: webhookKeyFn, namespace: 'earn-ethena' }),
);
app.use(
  '/v1/*',
  rateLimit({ windowSeconds: 60, limit: 120, keyFn: v1KeyFn, namespace: 'v1' }),
);
app.use(
  '/mcp',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: mcpKeyFn, namespace: 'mcp' }),
);
// /x402 shares the agent-key population with /mcp; same bucket strategy,
// own namespace so a saturated mcp loop doesn't 429 the x402 settlement
// path or vice versa.
app.use(
  '/x402/pay',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: mcpKeyFn, namespace: 'x402-pay' }),
);
app.use(
  '/x402/settle',
  rateLimit({ windowSeconds: 60, limit: 60, keyFn: mcpKeyFn, namespace: 'x402-settle' }),
);

app.route('/auth', authRoutes);
// L1 — unified per-user profile aggregator. Accepts both session JWT and
// API key, so third-party clients can read on behalf of users via sk_*.
const { meRoutes } = await import('./routes/me.js');
app.route('/me', meRoutes);
app.route('/ledger', ledgerRoutes);
app.route('/payments', paymentRoutes);
app.route('/offers', offerRoutes);
app.route('/checkout', checkoutRoutes);
// F021 — serve the OpenAPI doc unauthenticated; it's a static description
// of the public API and downstream tools (Swagger UI, Postman) won't have
// an api key. Cached after first generation; no perf concern.
app.get('/v1/openapi.json', async (c) => {
  const { getOpenApiDocument } = await import('./lib/openapi.js');
  return c.json(getOpenApiDocument());
});
// F021 — interactive Swagger UI for the public /v1 surface.
// Sprint 13 COMMIT 7 (SR3) — the prior unauth posture loaded swagger-ui-dist
// from a CDN with no SRI hash, an XSS supply-chain risk for anyone visiting
// /v1/docs in a browser logged into the API host. Gate behind requireSession
// so only signed-in operators see the UI; the underlying spec at
// /v1/openapi.json stays public for downstream tools (Postman, codegen).
app.get('/v1/docs', requireSession, swaggerUI({ url: '/v1/openapi.json' }));
app.route('/v1', v1Routes);
app.route('/keys', keyRoutes);
app.route('/earn', earnRoutes);
app.route('/swap', swapRoutes);
app.get('/card/', requireSession, getCardState);
app.route('/card', cardRoutes);
app.route('/agent', agentRoutes);
app.route('/x402', x402Routes);
app.route('/bridge', bridgeRoutes);
app.route('/kyc', kycRoutes);
app.route('/claim', claimRoutes);
app.route('/markets', marketRoutes);
// Phase A — realtime fan-out hub. Gated by REALTIME_HUB_V1 so the routes
// stay 404 in production until the flag flips on. Idle pods don't open
// any upstream WS even when the flag is on — the first SSE client subscribe
// triggers `adapter.subscribe(topic)` which lazy-opens the venue WS.
//
// The realtime ws-server uses `Hono<any, any, any>` (AnyHono) so it stays
// decoupled from the main app's `Bindings: HttpBindings` generic. TS still
// flags the variance mismatch — cast through `unknown` rather than disable
// the check, so future env-shape changes still surface as errors elsewhere.
type AnyHonoApp = Parameters<typeof createRealtimeWsServer>[0];
const realtimeWs = env.REALTIME_HUB_V1 ? createRealtimeWsServer(app as unknown as AnyHonoApp) : null;
if (env.REALTIME_HUB_V1) {
  app.route('/v1', realtimeRoutes);
  realtimeWs?.registerRoute(app as unknown as AnyHonoApp);
}
// Sprint 20 — Collector Crypt cards. Separate route file (its own table +
// adapter); mounted at /markets/cards under the same /markets prefix so the
// NEO client's `api.cards.*` calls share the markets namespace conventions.
app.route('/markets/cards', marketsCardsRoutes);
app.route('/tv', tvRoutes);
app.route('/campaigns', campaignsRoutes);
app.route('/perks', perksRoutes);
app.route('/admin', adminRoutes);
app.route('/monerium', moneriumRoutes);
app.route('/onramp', onrampRoutes);
// Sprint 19 — Portfolio settlement: /balances aggregate + /transfers/* CCTP
// state-machine driven cross-chain bucket transfers.
app.route('/balances', balancesRoutes);
app.route('/transfers', transfersRoutes);
app.route('/spend', spendRoutes);
app.route('/push', pushRoutes);
app.route('/system', systemRoutes);
app.route('/config', configRoutes);
app.route('/.well-known', wellknownRoutes);

/* MCP — Streamable HTTP on the raw node req/res. */
app.all('/mcp', async (c) => {
  const { incoming, outgoing } = c.env;
  let body: unknown;
  if (c.req.method === 'POST') {
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
  }
  await handleMcpRequest(incoming, outgoing, body);
  return RESPONSE_ALREADY_SENT;
});

app.notFound((c) => c.json({ ok: false, error: 'not_found', path: c.req.path }, 404));

// Structured error normalizer — ApiError → carried status + code; ZodError →
// 422 with field-level details; everything else → 500 + Sentry capture
// (δ's captureException pattern retained inside errorHandler). The pino-
// sentry transport stays at warn-only so explicit 500 captures don't double
// up with the transport.
app.onError(errorHandler);

/* boot (skipped under vitest) */
if (process.env['VITEST'] === undefined) {
  const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: '0.0.0.0' }, (info) => {
    log.info(
      {
        port: info.port,
        demo: env.DEMO_MODE,
        backend: storeBoot.backend,
        features,
      },
      `NEXA API listening on :${info.port} (demo=${env.DEMO_MODE}, backend=${storeBoot.backend})`,
    );
  });

  // Phase A.3 — attach the realtime WS upgrade hook on the same port the
  // REST app listens on. The route is registered on the Hono app above; this
  // call patches `server.on('upgrade', ...)` so the WS handshake flows
  // through `@hono/node-ws`. No-op when the hub flag is off.
  realtimeWs?.inject(server);

  const startWorker = (name: string, start: () => Promise<void>): void => {
    void start().catch((e) => {
      log.error({ worker: name, err: e instanceof Error ? e.message : String(e) }, 'worker start failed');
    });
  };

  // Request-time approval jobs stay in the API process. Recurring money sweeps
  // are owned by the standalone scheduler container to avoid duplicate workers.
  if (features.redis) {
    startWorker('approvals', startApprovalWorker);
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutdown: draining');
    server.close();
    try {
      await stopApprovalWorker();
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'shutdown: worker close failed');
    }
    try {
      await store.dispose();
      await storeBoot.sqlClose();
      await storeBoot.redisClose();
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'shutdown: store close failed');
    }
    log.info('shutdown: complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Sliding-window rate limit middleware (Sprint 11 Phase 0).
 *
 * Two backends, picked at runtime:
 *   - Redis-backed when `features.redis && REDIS_URL` — `INCR rl:<key>` with
 *     `EXPIRE` on the first hit so a single round-trip per check serves both
 *     the counter and the TTL. `TTL rl:<key>` runs only when we've exceeded
 *     the budget (to compute Retry-After).
 *   - In-memory `Map<key, { count, resetAt }>` otherwise — fine for dev/demo,
 *     and intentionally clear-on-restart so a soft bounce wipes the table.
 *     Capped at 10k keys with a lazy O(n) FIFO drop of the 1000 oldest by
 *     `resetAt` so a busy demo never grows the heap unbounded. We also
 *     lazy-GC entries whose `resetAt` is in the past on every access — the
 *     map will tend to stay small in normal traffic.
 *
 * Mounted via `app.use(path, rateLimit({...}))` in `apps/api/src/index.ts`
 * with per-route keyFn / window / limit (see the plan table — auth/start +
 * verify use email-or-challenge id, /mcp uses the agent-key sha, webhook
 * receivers + /v1/* use IP).
 *
 * `env.RATE_LIMIT_ENABLED=false` short-circuits the middleware — used in
 * the existing test suite (set via per-test env stub) so vitests don't get
 * 429'd by the sliding-window counter.
 *
 * 429 responses flow through ε's `ApiError.tooManyRequests`, which the
 * onError normalizer renders as `{ ok: false, error: { code, message, ... } }`.
 * We set `Retry-After` on the context BEFORE throwing so the header is on
 * the response even though `throw` unwinds.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { env, features, runtimeFailClosed } from './env.js';
import { parseRedisUrl } from './redis-url.js';
import { log } from './log.js';
import { ApiError } from './errors.js';

export interface RateLimitConfig {
  /** Window length in seconds (e.g. 60 for "per minute", 600 for "per 10 min"). */
  windowSeconds: number;
  /** Maximum requests allowed in the window before the next one 429s. */
  limit: number;
  /**
   * Per-request key. Strings are hashed by the backend — collisions are fine
   * because each rate-limit instance shares its own key namespace. Returns
   * `null` to skip the check (e.g. when the request hasn't bound the key
   * the limiter expects — anonymous /v1/* without an api key, etc.).
   */
  keyFn: (c: Context) => string | null | Promise<string | null>;
  /**
   * Optional namespace for the Redis key (`rl:<namespace>:<key>`). Without
   * it counts under different limits collide in Redis even though the
   * middleware instances are distinct. In-memory backend uses the same
   * namespace inline.
   */
  namespace?: string;
}

interface ConsumeResult {
  ok: boolean;
  /** Seconds until the window resets when ok=false; 0 when ok=true. */
  retryAfter: number;
}

/* ── in-memory backend ─────────────────────────────────────────────────── */

interface MemEntry {
  count: number;
  /** Wall-clock ms at which the window resets and the counter zeros. */
  resetAt: number;
}

const memMap = new Map<string, MemEntry>();
const MEM_CAP = 10_000;
const MEM_EVICT_BATCH = 1_000;

function hashRateLimitKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function consumeInMemory(key: string, windowSeconds: number, limit: number): ConsumeResult {
  const now = Date.now();

  // Lazy GC the current key and (cheaply) any expired entries we touch. The
  // map gets a full sweep only when the cap is breached.
  const existing = memMap.get(key);
  if (!existing || existing.resetAt < now) {
    memMap.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    if (memMap.size > MEM_CAP) evictOldest();
    return { ok: true, retryAfter: 0 };
  }

  existing.count += 1;
  if (existing.count <= limit) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
}

function evictOldest(): void {
  // One pass to find the 1000 oldest `resetAt`s. We don't bother with a
  // heap — n=10k is tiny and this only fires when the cap is breached.
  const entries: Array<[string, number]> = [];
  for (const [k, v] of memMap) entries.push([k, v.resetAt]);
  entries.sort((a, b) => a[1] - b[1]);
  const drop = Math.min(MEM_EVICT_BATCH, entries.length);
  for (let i = 0; i < drop; i++) memMap.delete(entries[i]![0]);
}

/* ── redis backend ─────────────────────────────────────────────────────── */

let redisClient: Redis | null = null;
let redisInitTried = false;

/**
 * Lazy-init a single ioredis connection shared across all rate-limit
 * checks. Parsing goes through `lib/redis-url.ts` — the same helper
 * `workers/connection.ts` uses — so the limiter and BullMQ can never
 * disagree about which host/db a REDIS_URL points at.
 *
 * Returns null when Redis is unconfigured or the URL is unparseable; what
 * that null MEANS is the caller's decision (in-memory fallback in open
 * mode, 503 in closed mode — see `rateLimit()`).
 */
function getRedis(): Redis | null {
  if (redisInitTried) return redisClient;
  redisInitTried = true;
  if (!features.redis || !env.REDIS_URL) return null;
  const parsed = parseRedisUrl(env.REDIS_URL);
  if (!parsed) {
    log.warn('rate-limit: REDIS_URL is set but unparseable');
    return null;
  }
  try {
    redisClient = new Redis({
      ...parsed,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    redisClient.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'rate-limit redis error');
    });
    return redisClient;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'rate-limit redis init failed',
    );
    return null;
  }
}

/**
 * Effective fail mode for a degraded/missing Redis backend. Explicit
 * RATE_LIMIT_FAIL_MODE wins; unset derives from the runtime: closed in real
 * production (NODE_ENV=production && !DEMO_MODE), open in dev/demo/test.
 * Evaluated per request so tests can stub env fields.
 */
function failClosed(): boolean {
  if (env.RATE_LIMIT_FAIL_MODE) return env.RATE_LIMIT_FAIL_MODE === 'closed';
  return runtimeFailClosed();
}

async function consumeRedis(
  client: Redis,
  key: string,
  windowSeconds: number,
  limit: number,
): Promise<ConsumeResult> {
  const rkey = `rl:${key}`;
  const count = await client.incr(rkey);
  if (count === 1) await client.expire(rkey, windowSeconds);
  if (count <= limit) return { ok: true, retryAfter: 0 };
  const ttl = await client.ttl(rkey);
  return { ok: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
}

/* ── public API ────────────────────────────────────────────────────────── */

/**
 * Build a Hono middleware that enforces `limit` requests per `windowSeconds`
 * per the key returned by `keyFn`. Per-request:
 *   1. If RATE_LIMIT_ENABLED=false, fall through.
 *   2. Compute the key; null → skip (anonymous bypass).
 *   3. Pick Redis or in-memory backend; INCR/check.
 *   4. On allow, fall through.
 *   5. On reject, set `Retry-After` and throw `ApiError.tooManyRequests`.
 *
 * Backend failure behavior depends on the fail mode (`RATE_LIMIT_FAIL_MODE`,
 * defaulting to closed only in real production): open mode falls back to the
 * in-memory counter so a Redis outage doesn't 500 a dev/demo API; closed
 * mode rejects with 503 service_unavailable instead of silently degrading to
 * a per-process counter (multi-pod would multiply every budget by the pod
 * count and lose state on restart).
 */
export function rateLimit(config: RateLimitConfig): MiddlewareHandler {
  const namespace = config.namespace ?? 'def';
  return async (c, next) => {
    if (!env.RATE_LIMIT_ENABLED) return next();
    const rawKey = await config.keyFn(c);
    if (!rawKey) return next();
    const fullKey = `${namespace}:${hashRateLimitKey(rawKey)}`;

    let result: ConsumeResult;
    const client = getRedis();
    if (client) {
      try {
        result = await consumeRedis(client, fullKey, config.windowSeconds, config.limit);
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), namespace },
          failClosed()
            ? 'rate-limit redis check failed; failing closed (503)'
            : 'rate-limit redis check failed; falling back to in-memory',
        );
        if (failClosed()) throw ApiError.serviceUnavailable('rate_limiter_unavailable');
        result = consumeInMemory(fullKey, config.windowSeconds, config.limit);
      }
    } else if (failClosed()) {
      // Closed mode: an expected-but-unusable Redis (unparseable URL, init
      // failure, or none configured at all in real production) must not
      // silently degrade to a per-process counter.
      throw ApiError.serviceUnavailable('rate_limiter_unavailable');
    } else {
      result = consumeInMemory(fullKey, config.windowSeconds, config.limit);
    }

    if (!result.ok) {
      c.header('Retry-After', String(result.retryAfter));
      throw ApiError.tooManyRequests('rate_limited');
    }
    await next();
  };
}

/**
 * F089 Sprint 18 — non-middleware consume.
 *
 * Use this from inside a handler when the rate-limit decision depends on data
 * that's only available after the body is parsed (e.g. the MCP server needs
 * the JSON-RPC `params.name` to split read-tool vs write-tool buckets).
 *
 * Same backend selection and fail mode as the middleware: open mode falls
 * back to in-memory on Redis failure; closed mode (real production or
 * RATE_LIMIT_FAIL_MODE=closed) throws ApiError.serviceUnavailable instead.
 * Returns the raw ConsumeResult; the caller is responsible for surfacing 429
 * and setting Retry-After.
 *
 * NOTE: bypasses the `RATE_LIMIT_ENABLED` flag check the middleware honors —
 * pass the flag through if needed. We deliberately do not skip in tests by
 * default so per-tool tests can exercise the bucket.
 */
export async function enforceRateLimit(opts: {
  rawKey: string;
  namespace: string;
  windowSeconds: number;
  limit: number;
}): Promise<ConsumeResult> {
  if (!env.RATE_LIMIT_ENABLED) return { ok: true, retryAfter: 0 };
  const fullKey = `${opts.namespace}:${hashRateLimitKey(opts.rawKey)}`;
  const client = getRedis();
  if (client) {
    try {
      return await consumeRedis(client, fullKey, opts.windowSeconds, opts.limit);
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), namespace: opts.namespace },
        failClosed()
          ? 'enforceRateLimit redis check failed; failing closed (503)'
          : 'enforceRateLimit redis check failed; falling back to in-memory',
      );
      if (failClosed()) throw ApiError.serviceUnavailable('rate_limiter_unavailable');
    }
  } else if (failClosed()) {
    throw ApiError.serviceUnavailable('rate_limiter_unavailable');
  }
  return consumeInMemory(fullKey, opts.windowSeconds, opts.limit);
}

/**
 * F094 Sprint 18 — best-effort PING against the Redis connection the rate
 * limiter is already holding open. Used by `/healthz` so Caddy stops marking
 * a pod healthy when Redis is unreachable (BullMQ would silently fail to
 * enqueue transfers in that state).
 *
 * Returns:
 *   - 'ok'       — PING returned PONG within 2s
 *   - 'down'     — features.redis is on but the PING failed/timed out
 *   - 'absent'   — features.redis is off (Redis is intentionally unconfigured)
 *
 * Connect is lazy (lazyConnect:true in getRedis()); the first call here
 * triggers the connect handshake. Subsequent calls reuse the cached client.
 */
export async function pingRedis(): Promise<'ok' | 'down' | 'absent'> {
  if (!features.redis) return 'absent';
  const client = getRedis();
  if (!client) return 'down';
  try {
    const result = await Promise.race([
      client.ping(),
      new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 2000)),
    ]);
    return result === 'PONG' ? 'ok' : 'down';
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'rate-limit: redis ping failed',
    );
    return 'down';
  }
}

/* ── key helpers ───────────────────────────────────────────────────────── */

/**
 * Best-effort client IP, trusting only the proxies we run.
 *
 * `x-forwarded-for` is client-appendable — every hop adds the peer it saw —
 * so the only entries we can trust are the last `TRUSTED_PROXY_HOPS` ones
 * (Caddy = 1 in prod). We take the entry `hops` from the right: the address
 * our outermost trusted proxy actually observed, never the spoofable
 * leftmost. With fewer entries than `hops`, the leftmost available wins.
 * TRUSTED_PROXY_HOPS=0 means no proxy is trusted: x-forwarded-for/x-real-ip
 * are ignored outright. Falls back to `x-real-ip` (proxy-set), then the
 * socket peer, then 'unknown' so the rate-limit instance still has *some*
 * bucket rather than skipping the check.
 *
 * Codex review 2026-07-16 [P1]: behind a CDN/tunnel front (Cloudflare →
 * cloudflared → Caddy) even the trusted XFF hop is the tunnel-side peer,
 * not the browser — every user would share one bucket. When the operator
 * names TRUSTED_CLIENT_IP_HEADER (prod: `cf-connecting-ip`), that proxy-set
 * end-client header wins. Same trust gate as XFF: ignored when
 * TRUSTED_PROXY_HOPS=0, since a direct client can forge any header.
 */
export function clientIp(c: Context): string {
  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops > 0) {
    const trusted = env.TRUSTED_CLIENT_IP_HEADER;
    if (trusted) {
      const val = c.req.header(trusted);
      if (val) {
        // Single value expected (edge-set); split defensively anyway so a
        // misconfigured multi-value header can't mint unbounded buckets.
        const first = val.split(',')[0]?.trim();
        if (first) return first;
      }
    }
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) {
      const parts = fwd
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        const picked = parts[Math.max(0, parts.length - hops)];
        if (picked) return picked;
      }
    }
    const real = c.req.header('x-real-ip');
    if (real) return real.trim();
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Test-only: drop the in-memory state so individual tests start clean. */
export function _resetForTests(): void {
  memMap.clear();
}

/** Test-only: surface map size for assertions. */
export function _memSizeForTests(): number {
  return memMap.size;
}

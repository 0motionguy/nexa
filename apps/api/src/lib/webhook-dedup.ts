/**
 * Webhook event deduplication — replay protection for inbound webhooks.
 *
 * Why this exists, even though signatures + freshness windows already exist:
 * a captured webhook within the 5-minute freshness window can be POSTed
 * multiple times. The signature stays valid. The Stripe SDK accepts it.
 * Without explicit ID dedup, the credit-side-effect (topUp, payOffer, etc.)
 * fires N times.
 *
 * Existing protections:
 *   - lib/webhooks.ts:signWebhook (outbound, ours)
 *   - lib/psp/stripe.ts:verifyAndParseWebhook (Stripe SDK constructEvent —
 *     does signature + 5min freshness)
 *   - lib/chain/bridge.ts:verifyWebhook (HMAC + 300s freshness)
 *   - lib/kyc.ts:verifyWebhook (HMAC + 300s freshness)
 *   - DB-level: nb_bridge_webhook_events.ref PK, nb_stripe_sessions.session_id
 *     unique, payOffer's idempotencyKey
 *
 * What this adds: an in-memory LRU keyed on `source:event_id`, TTL slightly
 * longer than the freshness window. Cheap (<1µs lookup), zero infra deps.
 * Redis-backed dedup is opt-in for multi-instance deployments — when
 * REDIS_URL is set, we also persist a `wdedup:<source>:<id>` key with the
 * same TTL so two API replicas don't both credit the same replay.
 *
 * Call shape:
 *   const seen = await markWebhookSeen('stripe', event.id)
 *   if (seen) return c.json({ ok: true, ignored: 'replay' })
 *   // … your credit side-effect …
 *
 * Returns true ON DUPLICATE (caller skips). False on first sighting.
 */

import { Redis } from 'ioredis';
import { env, features } from './env.js';
import { log } from './log.js';

/** TTL must outlive the longest freshness window (currently 300s); pad to 600s. */
const DEDUP_TTL_SECONDS = 600;
const MEM_CAP = 10_000;
const MEM_EVICT_BATCH = 1_000;

interface MemEntry {
  /** Wall-clock ms at which this entry expires. */
  expiresAt: number;
}

const memCache = new Map<string, MemEntry>();

function buildKey(source: string, id: string): string {
  return `wdedup:${source}:${id}`;
}

function pruneInMemory(key: string, nowMs: number): void {
  const existing = memCache.get(key);
  if (existing && existing.expiresAt < nowMs) {
    memCache.delete(key);
  }
}

function evictOldestInMemory(): void {
  const entries: Array<[string, number]> = [];
  for (const [k, v] of memCache) entries.push([k, v.expiresAt]);
  entries.sort((a, b) => a[1] - b[1]);
  const drop = Math.min(MEM_EVICT_BATCH, entries.length);
  for (let i = 0; i < drop; i++) memCache.delete(entries[i]![0]);
}

/* ── redis backend (lazy-init) ─────────────────────────────────────────── */

let redisClient: Redis | null = null;
let redisInitTried = false;

function getRedis(): Redis | null {
  if (redisInitTried) return redisClient;
  redisInitTried = true;
  if (!features.redis || !env.REDIS_URL) return null;
  try {
    const u = new URL(env.REDIS_URL);
    redisClient = new Redis({
      host: u.hostname,
      port: u.port ? Number(u.port) : 6379,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      db: u.pathname && u.pathname !== '/' ? Number(u.pathname.replace('/', '')) || 0 : 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    redisClient.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'webhook-dedup redis error');
    });
    return redisClient;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'webhook-dedup redis init failed; falling back to in-memory',
    );
    return null;
  }
}

/**
 * Atomically mark `(source, id)` as seen. Returns true when this id has
 * already been seen within the dedup window (caller should skip side
 * effects). Returns false on the first sighting.
 *
 * On Redis failure: degrades to in-memory only. The in-memory cache is
 * always written so single-instance deployments stay protected even if
 * Redis is unreachable.
 */
export async function markWebhookSeen(source: string, eventId: string): Promise<boolean> {
  if (!source || !eventId) return false; // missing id: cannot dedupe, let through
  const key = buildKey(source, eventId);
  const now = Date.now();
  pruneInMemory(key, now);

  // Redis SETNX with EX — atomic check-and-set with TTL. Returns 'OK' if the
  // key was set (first sighting), null if it already existed (replay).
  const client = getRedis();
  if (client) {
    try {
      const r = await client.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      const seen = r === null; // null = already existed
      // Mirror the result in-memory to keep both backends in sync. On replay
      // we set with the same TTL; on first-sighting we record locally too so
      // subsequent same-process replays don't even round-trip Redis.
      memCache.set(key, { expiresAt: now + DEDUP_TTL_SECONDS * 1000 });
      if (memCache.size > MEM_CAP) evictOldestInMemory();
      return seen;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), source, eventId },
        'webhook-dedup: redis check failed; in-memory only',
      );
      // fall through to in-memory
    }
  }

  // In-memory backend
  const existing = memCache.get(key);
  if (existing) return true; // replay
  memCache.set(key, { expiresAt: now + DEDUP_TTL_SECONDS * 1000 });
  if (memCache.size > MEM_CAP) evictOldestInMemory();
  return false;
}

/** Test-only: clear the in-memory cache. */
export function _resetWebhookDedupForTests(): void {
  memCache.clear();
}

/** Test-only: report the in-memory cache size. */
export function _webhookDedupSizeForTests(): number {
  return memCache.size;
}

/**
 * Redis client factory.
 *
 * Used for:
 *   - agent-key → userId cache (1h TTL)
 *   - OTP challenge store (10min TTL)
 *   - User snapshot cache (30s TTL, invalidated on mutation)
 *   - BullMQ queue connection (workers/approvals.ts)
 *
 * Returns null when REDIS_URL is unset → callers fall back to in-process Maps.
 */

import { Redis } from 'ioredis';

export type RedisClient = Redis;

export function makeRedis(url: string | undefined): RedisClient | null {
  if (!url) return null;
  const r = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    enableReadyCheck: true,
  });
  r.on('error', (e: Error) => {
    // Don't crash the process — let calling code decide whether to degrade.
    process.stderr.write(`[redis] ${e.message}\n`);
  });
  return r;
}

export const RedisKeys = {
  agentKey: (key: string) => `nb:agent_key:${key}`,
  otp: (id: string) => `nb:otp:${id}`,
  userCache: (id: string) => `nb:user:${id}`,
  /** Scale wave 3 — session-auth projection cache (SessionUser, no aggregates). */
  userCoreCache: (id: string) => `nb:user_core:${id}`,
  approvalLock: (id: string) => `nb:approval_lock:${id}`,
  /** W2-A worker liveness heartbeat (epoch-ms string, EX TTL) — read by /health/money. */
  workerHeartbeat: (name: string) => `nb:worker_heartbeat:${name}`,
  /** W2-B — stream-ticket jti one-shot marker (`SET … PX <ttl> NX`). */
  ticketJti: (jti: string) => `nb:ticket_jti:${jti}`,
  /** WORKER-P1-1 — durable per-user fill cursor (epoch-ms string), no TTL. */
  fillsCursor: (userId: string) => `nb:fills_cursor:${userId}`,
  /** WORKER-P1-1 — sweep-wide keyset scan cursor (last userId visited), no TTL. */
  fillsScanCursor: () => `nb:fills_scan_cursor`,
  /** WORKER-P1-1 — at-most-once push-notified marker per (user, fill hash), 7d TTL. */
  fillNotified: (userId: string, fillId: string) => `nb:fill_notified:${userId}:${fillId}`,
} as const;

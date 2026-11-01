/**
 * Shared BullMQ connection options builder.
 *
 * Originally lived inline in workers/approvals.ts; extracted in Sprint 10
 * Phase 2 ε so the new standalone scheduler entrypoint and every worker
 * module return identical options. Keeping the parse + flag-gate in one
 * place avoids drift when a new worker is added.
 *
 * Returns null (rather than throwing) when Redis is unconfigured so callers
 * can degrade to inline/admin-route mode cleanly.
 */

import type { ConnectionOptions } from 'bullmq';
import { env, features } from '../lib/env.js';
import { parseRedisUrl } from '../lib/redis-url.js';

export function makeConnectionOpts(): ConnectionOptions | null {
  if (!features.redis || !env.REDIS_URL) return null;
  // W2-B — parse through the shared helper (rediss/ACL-username/db handling,
  // null on malformed instead of coercing to db 0). The scheduler entrypoint
  // treats a set-but-unparseable REDIS_URL as a boot failure.
  const parsed = parseRedisUrl(env.REDIS_URL);
  if (!parsed) return null;
  // Pass connection options (not an ioredis instance) so BullMQ owns the
  // socket. This sidesteps the dual-ioredis-version mismatch that bullmq's
  // pinned dependency causes.
  return {
    ...parsed,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

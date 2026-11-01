/**
 * W2-B — single source of truth for parsing REDIS_URL into ioredis-shaped
 * connection options.
 *
 * Before this module, `lib/rate-limit.ts` and `workers/connection.ts` each
 * hand-parsed the URL with `new URL()` and silently diverged from ioredis'
 * own URL handling in three ways that all fail OPEN into a misconfigured
 * runtime:
 *   - `rediss://` lost its TLS flag → plaintext AUTH bytes to a TLS
 *     listener (hangs or leaks the password, depending on the endpoint);
 *   - ACL usernames (`redis://user:pass@host`) were dropped → AUTH as
 *     `default` with the wrong ACL;
 *   - a malformed db path (`redis://host/2x`) coerced to db 0 via `|| 0`,
 *     so rate-limit counters and BullMQ queues silently landed in a
 *     different keyspace than the operator configured.
 *
 * `parseRedisUrl` returns null for anything it cannot parse EXACTLY so each
 * caller makes an explicit fail-open (dev/demo) or fail-closed (production)
 * decision instead of limping on with defaults. It never throws.
 *
 * `lib/redis.ts` (makeRedis) is intentionally NOT routed through here — it
 * hands the raw URL to ioredis, whose native URL handling already covers
 * rediss/username/db.
 */

export interface RedisUrlOptions {
  host: string;
  port: number;
  /** ACL username — only set when the URL carries a non-empty user part. */
  username?: string;
  password?: string;
  db: number;
  /** Present (empty options object) for rediss:// so ioredis enables TLS. */
  tls?: Record<string, never>;
}

export function parseRedisUrl(raw: string | undefined): RedisUrlOptions | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') return null;
  if (!u.hostname) return null;

  const port = u.port ? Number(u.port) : 6379;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  // Logical-db path: `/2` → db 2. Empty or `/` → db 0. Anything that is not
  // a bare non-negative integer is a misconfiguration — refuse rather than
  // coerce to 0 (the pre-W2-B `|| 0` behavior this module exists to kill).
  let db = 0;
  if (u.pathname && u.pathname !== '/') {
    const dbRaw = u.pathname.slice(1);
    if (!/^\d+$/.test(dbRaw)) return null;
    db = Number(dbRaw);
  }

  const opts: RedisUrlOptions = { host: u.hostname, port, db };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.protocol === 'rediss:') opts.tls = {};
  return opts;
}

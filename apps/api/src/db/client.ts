/**
 * Drizzle Postgres client factory.
 *
 * Used by:
 *   - store/postgres.ts (Store impl)
 *   - migrate.ts (boot-time migration runner)
 *   - drizzle.config.ts (kit-time generate/migrate)
 *
 * Pool config: max 25 conns (see scale-plan note below; opts.max overrides —
 * the migration runner passes max:1), prepare:false (pg-bouncer compatibility).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function makeDb(
  url: string,
  opts?: { max?: number },
): { db: Db; sql: ReturnType<typeof postgres> } {
  const sql = postgres(url, {
    // Scale plan 1.4 (2026-07-02) — 10 was zero-headroom at ~1k concurrent:
    // auth hydrates alone project ~270 queries/s, and one slow FOR UPDATE
    // money transaction stalled the whole API. 25 keeps well under the
    // shared toolbox-postgres max_connections while tripling burst room.
    // W2-A: opts.max override — migrate.ts uses max:1 so its advisory lock
    // and the migration statements share a single session.
    max: opts?.max ?? 25,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

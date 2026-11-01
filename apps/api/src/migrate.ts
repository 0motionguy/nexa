/**
 * Migration runner — invoked by the Docker entrypoint (and the standalone
 * `neobank-migrate` one-shot) before the API server starts. Idempotent:
 * re-running is a no-op when migrations are up-to-date.
 *
 * Usage:
 *   node dist/migrate.js   → exits 0 on success or demo skip, 1 on failure
 *
 * W2-A hardening (harden/wave2-failclosed-core):
 *   - Main logic is `runMigrate()`, an exported function returning the exit
 *     code so the spec suite can exercise every branch; the thin CLI wrapper
 *     at the bottom is the only place that calls process.exit.
 *   - NODE_ENV=production + DEMO_MODE=0 without DATABASE_URL exits 1
 *     (fail-closed) — previously that combination "skipped" the migrate and
 *     let a mis-wired production pod boot schema-less.
 *   - The run holds `pg_advisory_lock(MIGRATE_LOCK_ID)` on a max:1
 *     connection (lock + migration statements share the single session, so
 *     pool idle-reaping can never drop the lock mid-run). Concurrent booters
 *     — the api entrypoint and the one-shot migrate container — serialize
 *     instead of racing drizzle's journal.
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { makeDb } from './db/client.js';
import { log } from './lib/log.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** App-unique advisory lock id — arbitrary but stable; never reuse elsewhere. */
export const MIGRATE_LOCK_ID = 7_802_616_042;

export interface RunMigrateDeps {
  /** Environment source; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injection seams for the spec suite. */
  makeDbFn?: typeof makeDb;
  migrateFn?: typeof migrate;
}

/**
 * Run pending migrations; returns the process exit code instead of exiting.
 *
 * NOTE: reads the raw env instead of importing lib/env.js on purpose — the
 * full env module throws at import time on fail-closed misconfiguration,
 * which would stop this runner from reporting its own exit code.
 */
export async function runMigrate(deps: RunMigrateDeps = {}): Promise<0 | 1> {
  const e = deps.env ?? process.env;
  const makeDbFn = deps.makeDbFn ?? makeDb;
  const migrateFn = deps.migrateFn ?? migrate;

  const url = e['DATABASE_URL'];
  if (!url) {
    // Mirror lib/env.ts defaults: DEMO_MODE unset → '1' (demo).
    const demoRaw = e['DEMO_MODE'] ?? '1';
    const demo = demoRaw === '1' || demoRaw === 'true';
    if ((e['NODE_ENV'] ?? 'development') === 'production' && !demo) {
      log.error(
        'migrate: DATABASE_URL missing under NODE_ENV=production DEMO_MODE=0 — refusing to skip (fail-closed)',
      );
      return 1;
    }
    log.info('migrate: DATABASE_URL not set, skipping (demo mode)');
    return 0;
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(__dirname, 'db/migrations');
  const { db, sql } = makeDbFn(url, { max: 1 });
  log.info({ migrationsFolder }, 'migrate: starting');
  try {
    await sql`select pg_advisory_lock(${MIGRATE_LOCK_ID})`;
    try {
      await migrateFn(db, { migrationsFolder });
      log.info('migrate: applied');
      return 0;
    } finally {
      // Session close releases it anyway; explicit unlock keeps the lock
      // window as tight as the migration itself.
      await sql`select pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => undefined);
    }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'migrate: failed');
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/* Thin CLI wrapper — runs only when this file is the process entrypoint
 * (`node dist/migrate.js`), never on spec import (vitest is argv[1] there). */
const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
const selfPath = fileURLToPath(import.meta.url);
const isDirectInvocation =
  entryPath !== null &&
  (process.platform === 'win32'
    ? entryPath.toLowerCase() === selfPath.toLowerCase()
    : entryPath === selfPath);
if (isDirectInvocation) {
  void runMigrate().then((code) => process.exit(code));
}

/**
 * Store factory + module-level singleton.
 *
 * createStore() resolves at boot via top-level await. Routes import `store`
 * directly — they don't care whether it's backed by Postgres or in-memory.
 *
 * Selection:
 *   - DATABASE_URL set → PostgresStore + Redis cache (if REDIS_URL set)
 *   - DATABASE_URL unset → InMemoryStore (DEMO_MODE default)
 *
 * Seeds:
 *   - mirko@studio.co user (matches the canonical Mirko demo fixtures)
 *   - nx_live_7f3k_demo agent key bound to that user
 */

import { env } from '../lib/env.js';
import { log } from '../lib/log.js';
import { makeDb, type Db } from '../db/client.js';
import { makeRedis, type RedisClient } from '../lib/redis.js';
import { InMemoryStore } from './in-memory.js';
import { PostgresStore } from './postgres.js';
import type { Store } from './types.js';

export interface StoreConfig {
  databaseUrl?: string | undefined;
  redisUrl?: string | undefined;
}

export type StoreBackend = 'in-memory' | 'postgres';

export interface StoreBoot {
  store: Store;
  backend: StoreBackend;
  /**
   * Drizzle handle when PostgresStore is active; null in DEMO_MODE. Exposed
   * for adjunct stores (e.g. `transferStore`) that haven't been lifted into
   * the Store interface yet but need to share the same connection pool.
   */
  db: Db | null;
  /**
   * W2-A — Redis client shared with PostgresStore's cache; null on the
   * in-memory/demo boot. Exposed so /health/money reads the worker heartbeat
   * over the existing connection instead of opening another.
   */
  redis: RedisClient | null;
  /** Set when PostgresStore — used by graceful shutdown to close the pool. */
  sqlClose: () => Promise<void>;
  /** Set when Redis present — used by graceful shutdown to quit the client. */
  redisClose: () => Promise<void>;
}

async function bootStore(cfg: StoreConfig): Promise<StoreBoot> {
  // W2-A fail-closed: production non-demo must never serve the in-memory
  // ledger. lib/env.ts already refuses to parse that configuration; this
  // guard is belt-and-braces against future env regressions and direct
  // bootStore misuse.
  if (!cfg.databaseUrl && env.NODE_ENV === 'production' && !env.DEMO_MODE) {
    throw new Error(
      'store: DATABASE_URL missing under NODE_ENV=production DEMO_MODE=0 — in-memory fallback is demo-only (fail-closed).',
    );
  }
  if (cfg.databaseUrl) {
    const { db, sql } = makeDb(cfg.databaseUrl);
    const redis = makeRedis(cfg.redisUrl);
    const store = new PostgresStore({ db, redis });
    log.info({ backend: 'postgres', redis: !!redis }, 'store: postgres backend ready');
    return {
      store,
      backend: 'postgres',
      db,
      redis,
      sqlClose: () => sql.end({ timeout: 5 }),
      redisClose: async () => {
        if (redis) await redis.quit();
      },
    };
  }
  const store = new InMemoryStore();
  log.info({ backend: 'in-memory' }, 'store: in-memory backend ready');
  return {
    store,
    backend: 'in-memory',
    db: null,
    redis: null,
    sqlClose: async () => {},
    redisClose: async () => {},
  };
}

async function seedDemoUser(store: Store): Promise<void> {
  try {
    const user = await store.upsertUserByEmail('mirko@studio.co', 'Mirko');
    // Bind the demo agent key — also parse NEXA_AGENT_KEYS for additional entries
    // (format: "key=email" or bare "key" → uses the first-seeded user).
    const entries = env.NEXA_AGENT_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
    for (const raw of entries) {
      const [key, email] = raw.split('=', 2).map((s) => s.trim());
      if (!key) continue;
      if (email && email !== user.email) {
        const other = await store.upsertUserByEmail(email);
        await store.bindAgentKeyToUser(key, other.id);
      } else {
        await store.bindAgentKeyToUser(key, user.id);
      }
    }
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'store: demo seed failed');
  }
}

const boot = await bootStore({
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
});

await seedDemoUser(boot.store);

export const store: Store = boot.store;
export const storeBoot: StoreBoot = boot;

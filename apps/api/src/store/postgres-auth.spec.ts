/**
 * W2-C — PgAuth identity + agent-key durability against pg-mem.
 *
 * Runs the real PgAuth query paths (drizzle-orm/postgres-js — the production
 * driver flavor — over a minimal postgres.js client fake backed by pg-mem)
 * so the ON CONFLICT upsert, the guarded DID
 * adoption and the nb_agent_keys fallback execute as actual SQL. The
 * LedgerStateManager is stubbed to an identity echo — hydration/seeding is
 * ledger-state territory, not what these tests protect.
 */

import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DataType, newDb, replaceQueryArgs$ } from 'pg-mem';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { nbAgentKeys, nbUsers } from '../db/schema/index.js';
import * as schema from '../db/schema/index.js';
import type { RedisClient } from '../lib/redis.js';
import type { LedgerStateManager } from './core/ledger-state.js';
import { PgAuth } from './postgres/auth.js';
import type { User } from './types.js';

/**
 * DDL mirror of the tables PgAuth touches, matching db/schema/index.ts
 * (nbUsers, nbCardState, nbAgentKeys) column for column — drizzle INSERTs
 * emit the full column list with DEFAULT placeholders, so every mapped
 * column must exist. Mirroring beats replaying the 37-migration chain,
 * which pg-mem only supports best-effort.
 */
const DDL = `
  create table nb_users (
    id uuid primary key default gen_random_uuid(),
    email varchar(320) not null unique,
    name varchar(120),
    privy_did varchar(120) unique,
    privy_wallet_id varchar(80),
    privy_wallet_address varchar(42),
    hl_builder_approved_at timestamptz,
    hl_builder_max_fee_tenths_bp integer,
    pm_clob_key varchar(400),
    pm_clob_secret varchar(400),
    pm_clob_passphrase varchar(400),
    privy_sol_wallet_id varchar(80),
    privy_sol_wallet_address varchar(64),
    cohort varchar(40),
    kyc_status varchar(20) not null default 'none',
    bridge_customer_id varchar(80) unique,
    created_at timestamptz not null default now()
  );
  create table nb_card_state (
    user_id uuid primary key references nb_users(id),
    frozen boolean not null default false,
    day_limit_usd integer not null default 500,
    gnosis_pay_token text,
    updated_at timestamptz not null default now()
  );
  create table nb_agent_keys (
    key varchar(80) primary key,
    user_id uuid not null references nb_users(id),
    label varchar(120),
    created_at timestamptz not null default now(),
    last_used_at timestamptz
  );
`;

const coreStub = {
  hydrateUser: async (id: string) => ({ id }) as unknown as User,
  setUserState: async () => {},
  seedDemoData: async () => {},
  invalidateUser: async () => {},
} as unknown as LedgerStateManager;

/**
 * drizzle's postgres-js session touches exactly two client surfaces:
 * `client.unsafe(sql, params)` awaited directly (execute → row objects) or
 * via `.values()` (all → positional rows), plus `client.options.parsers/
 * serializers` patched at construction. Backing those with pg-mem runs the
 * production driver flavor without pg-mem's own postgres.js adapter, which
 * needs the optional `pg-server` package we don't ship.
 */
function makeDb(): Db {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });
  mem.public.none(DDL);

  const exec = (query: string, params: unknown[]) =>
    mem.public.query(params.length ? replaceQueryArgs$(query, params) : query);
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[] = []) {
      // Lazy on purpose: drizzle either awaits the thenable OR calls
      // .values() — an eager promise would run every statement twice.
      return {
        then<T>(onOk: (rows: unknown[]) => T, onErr: (e: unknown) => T) {
          return Promise.resolve()
            .then(() => exec(query, params).rows as unknown[])
            .then(onOk, onErr);
        },
        values: async () => {
          const res = exec(query, params);
          return res.rows.map((row: Record<string, unknown>) =>
            res.fields.map((f) => row[f.name]),
          );
        },
      };
    },
  };
  return drizzle(client as unknown as Sql, { schema });
}

function fakeRedis(): { store: Map<string, string>; client: RedisClient } {
  const store = new Map<string, string>();
  const client = {
    setex: async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
      return 'OK';
    },
    get: async (k: string) => store.get(k) ?? null,
  } as unknown as RedisClient;
  return { store, client };
}

let db: Db;
let auth: PgAuth;

beforeEach(() => {
  db = makeDb();
  auth = new PgAuth(db, null, coreStub);
});

describe('PgAuth.upsertUserByEmail', () => {
  it('collapses two racing first logins onto a single row without error', async () => {
    const [a, b] = await Promise.all([
      auth.upsertUserByEmail('race@test.co', 'First'),
      auth.upsertUserByEmail('race@test.co', 'Second'),
    ]);

    expect(a.id).toBe(b.id);
    const rows = await db.select({ id: nbUsers.id }).from(nbUsers);
    expect(rows.length).toBe(1);
  });

  it('resolves by DID first, even when the presented email has drifted', async () => {
    const first = await auth.upsertUserByEmail('stable@test.co', 'Stable', {
      privyDid: 'did:privy:alpha',
    });
    const drifted = await auth.upsertUserByEmail('renamed@test.co', 'Renamed', {
      privyDid: 'did:privy:alpha',
    });

    expect(drifted.id).toBe(first.id);
    // The DID hit wins outright — no email rebind, no second row.
    const rows = await db.select({ email: nbUsers.email }).from(nbUsers);
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe('stable@test.co');
  });

  it('adopts a DID onto an email-resolved row exactly once', async () => {
    const bare = await auth.upsertUserByEmail('adopt@test.co', 'Adopter');

    const adopted = await auth.upsertUserByEmail('adopt@test.co', 'Adopter', {
      privyDid: 'did:privy:one',
    });
    expect(adopted.id).toBe(bare.id);
    const [row] = await db
      .select({ privyDid: nbUsers.privyDid })
      .from(nbUsers);
    expect(row!.privyDid).toBe('did:privy:one');

    // Same DID again is a no-op…
    const again = await auth.upsertUserByEmail('adopt@test.co', 'Adopter', {
      privyDid: 'did:privy:one',
    });
    expect(again.id).toBe(bare.id);

    // …but a bound identity is never silently rebound.
    await expect(
      auth.upsertUserByEmail('adopt@test.co', 'Adopter', { privyDid: 'did:privy:two' }),
    ).rejects.toMatchObject({ status: 409, message: 'identity_did_conflict' });
  });
});

describe('PgAuth agent keys', () => {
  const RAW = 'nexa-agent-key-raw-secret';

  it('bindings survive a restart: fresh caches resolve from the Postgres row', async () => {
    const u = await auth.upsertUserByEmail('owner@test.co', 'Owner');
    await auth.bindAgentKeyToUser(RAW, u.id);

    // "Restart" — new instance over the same db: empty map, no Redis.
    const reborn = new PgAuth(db, null, coreStub);
    const resolved = await reborn.userForAgentKey(RAW);

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(u.id);
    const [row] = await db
      .select({ lastUsedAt: nbAgentKeys.lastUsedAt })
      .from(nbAgentKeys);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('stores only the SHA-256 hash — the raw key is never at rest', async () => {
    const u = await auth.upsertUserByEmail('owner@test.co', 'Owner');
    await auth.bindAgentKeyToUser(RAW, u.id);

    const rows = await db.select({ key: nbAgentKeys.key }).from(nbAgentKeys);
    expect(rows.length).toBe(1);
    const stored = rows[0]!.key;
    expect(stored).toBe(createHash('sha256').update(RAW).digest('hex'));
    expect(stored).not.toBe(RAW);
    expect(stored).toHaveLength(64);
  });

  it('rebinding a key to a new user keeps last-write-wins semantics', async () => {
    const u1 = await auth.upsertUserByEmail('one@test.co', 'One');
    const u2 = await auth.upsertUserByEmail('two@test.co', 'Two');
    await auth.bindAgentKeyToUser(RAW, u1.id);
    await auth.bindAgentKeyToUser(RAW, u2.id);

    const reborn = new PgAuth(db, null, coreStub);
    const resolved = await reborn.userForAgentKey(RAW);
    expect(resolved!.id).toBe(u2.id);
  });

  it('reads through Redis when the caches are cold and Postgres has no row', async () => {
    const { client } = fakeRedis();
    const withRedis = new PgAuth(db, client, coreStub);
    const u = await withRedis.upsertUserByEmail('cached@test.co', 'Cached');
    await withRedis.bindAgentKeyToUser(RAW, u.id);

    // Remove the durable row; a fresh instance sharing the Redis still resolves.
    await db.delete(nbAgentKeys);
    const reborn = new PgAuth(db, client, coreStub);
    const resolved = await reborn.userForAgentKey(RAW);
    expect(resolved!.id).toBe(u.id);
  });

  it('resolves unknown keys to null', async () => {
    const r = await auth.userForAgentKey('never-bound');
    expect(r).toBeNull();
  });
});

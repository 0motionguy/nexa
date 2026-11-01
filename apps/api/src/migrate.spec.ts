/**
 * W2-A — migrate runner exit-code behavior (migrate.ts runMigrate).
 *
 * The runner is exercised through its dependency seams: a fake makeDb whose
 * `sql` records every tagged-template query (making the pg_advisory_lock /
 * unlock calls visible, per the wave plan) and a stubbed drizzle migrateFn.
 * No real Postgres — pg-mem can't service postgres.js tagged templates
 * through drizzle's migrator, so the seam mock is the feasible route.
 */

import { describe, expect, it, vi } from 'vitest';
import { MIGRATE_LOCK_ID, runMigrate, type RunMigrateDeps } from './migrate.js';
import type { makeDb } from './db/client.js';

interface SqlCall {
  text: string;
  params: unknown[];
}

function makeFakeDb(seq: string[] = []) {
  const calls: SqlCall[] = [];
  const sql = (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?').trim();
    calls.push({ text, params });
    seq.push(`sql:${text}`);
    return Promise.resolve([]);
  };
  const end = vi.fn(async (_opts?: { timeout?: number }): Promise<void> => {});
  const makeDbFn = vi.fn((_url: string, _opts?: { max?: number }) => ({
    db: {} as never,
    sql: Object.assign(sql, { end }) as never,
  })) as unknown as typeof makeDb;
  return { calls, end, makeDbFn };
}

function asMigrateFn(fn: (...args: unknown[]) => Promise<void>): NonNullable<RunMigrateDeps['migrateFn']> {
  return fn as unknown as NonNullable<RunMigrateDeps['migrateFn']>;
}

describe('runMigrate — exit codes', () => {
  it('returns 0 and skips the DB entirely when DATABASE_URL is unset outside prod non-demo', async () => {
    const { makeDbFn } = makeFakeDb();
    await expect(runMigrate({ env: {}, makeDbFn })).resolves.toBe(0);
    await expect(
      runMigrate({ env: { NODE_ENV: 'production', DEMO_MODE: '1' }, makeDbFn }),
    ).resolves.toBe(0);
    await expect(runMigrate({ env: { NODE_ENV: 'test' }, makeDbFn })).resolves.toBe(0);
    expect(makeDbFn).not.toHaveBeenCalled();
  });

  it('returns 1 (fail-closed) when production non-demo lacks DATABASE_URL', async () => {
    const { makeDbFn } = makeFakeDb();
    await expect(
      runMigrate({ env: { NODE_ENV: 'production', DEMO_MODE: '0' }, makeDbFn }),
    ).resolves.toBe(1);
    await expect(
      runMigrate({ env: { NODE_ENV: 'production', DEMO_MODE: 'false' }, makeDbFn }),
    ).resolves.toBe(1);
    expect(makeDbFn).not.toHaveBeenCalled();
  });

  it('applies migrations under pg_advisory_lock on a max:1 connection → exit 0', async () => {
    const seq: string[] = [];
    const fake = makeFakeDb(seq);
    const migrateFn = vi.fn(async (): Promise<void> => {
      seq.push('migrate');
    });

    const code = await runMigrate({
      env: { DATABASE_URL: 'postgresql://maze:pw@localhost:5432/maze' },
      makeDbFn: fake.makeDbFn,
      migrateFn: asMigrateFn(migrateFn),
    });

    expect(code).toBe(0);
    // Lock is taken BEFORE the migration runs and released after it.
    expect(seq).toEqual([
      'sql:select pg_advisory_lock(?)',
      'migrate',
      'sql:select pg_advisory_unlock(?)',
    ]);
    expect(fake.calls[0]!.params).toEqual([MIGRATE_LOCK_ID]);
    expect(fake.calls[1]!.params).toEqual([MIGRATE_LOCK_ID]);
    expect(fake.makeDbFn).toHaveBeenCalledWith('postgresql://maze:pw@localhost:5432/maze', {
      max: 1,
    });
    expect(migrateFn).toHaveBeenCalledTimes(1);
    const migrateArgs = migrateFn.mock.calls[0] as unknown[];
    expect(migrateArgs[1]).toMatchObject({ migrationsFolder: expect.stringContaining('migrations') });
    expect(fake.end).toHaveBeenCalledTimes(1);
  });

  it('returns 1 when the migration fails, still unlocking and closing the pool', async () => {
    const seq: string[] = [];
    const fake = makeFakeDb(seq);
    const migrateFn = vi.fn(async (): Promise<void> => {
      seq.push('migrate');
      throw new Error('boom: relation already exists');
    });

    const code = await runMigrate({
      env: { DATABASE_URL: 'postgresql://maze:pw@localhost:5432/maze' },
      makeDbFn: fake.makeDbFn,
      migrateFn: asMigrateFn(migrateFn),
    });

    expect(code).toBe(1);
    expect(seq).toEqual([
      'sql:select pg_advisory_lock(?)',
      'migrate',
      'sql:select pg_advisory_unlock(?)',
    ]);
    expect(fake.end).toHaveBeenCalledTimes(1);
  });
});

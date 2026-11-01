import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('database migration metadata', () => {
  function readJournal(): { entries: Array<{ idx: number; tag: string }> } {
    return JSON.parse(readFileSync(new URL('./meta/_journal.json', import.meta.url), 'utf8'));
  }

  it('lists every SQL migration in the Drizzle journal', () => {
    const migrationsDir = new URL('.', import.meta.url);

    const sqlTags = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => basename(name, '.sql'))
      .sort();

    const journal = readJournal();
    const journalTags = journal.entries.map((entry) => entry.tag).sort();

    expect(journalTags).toEqual(sqlTags);
  });

  it('has a Drizzle snapshot for every journal entry', () => {
    const metaDir = new URL('./meta/', import.meta.url);
    const snapshotNames = readdirSync(metaDir)
      .filter((name) => /^\d{4}_snapshot\.json$/.test(name))
      .sort();
    const expectedSnapshotNames = readJournal().entries.map((entry) =>
      `${String(entry.idx).padStart(4, '0')}_snapshot.json`,
    );

    expect(snapshotNames).toEqual(expectedSnapshotNames);
  });

  it('includes the persistent Polymarket leaderboard snapshot table', () => {
    const migrationsDir = new URL('.', import.meta.url);
    const combinedSql = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(new URL(name, migrationsDir), 'utf8'))
      .join('\n');

    expect(combinedSql).toContain('CREATE TABLE "nb_pm_leaderboard_snapshots"');
    expect(combinedSql).toContain('"payload" jsonb');
    expect(combinedSql).toContain('"expires_at" timestamp with time zone NOT NULL');
  });

  it('pins the positions-history hot-path index (0037, readiness audit 2026-07-16)', () => {
    const migrationsDir = new URL('.', import.meta.url);
    const combinedSql = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(new URL(name, migrationsDir), 'utf8'))
      .join('\n');

    expect(combinedSql).toContain(
      'CREATE INDEX "nb_market_positions_user_created_idx" ON "nb_market_positions" USING btree ("user_id","created_at" DESC NULLS FIRST)',
    );
  });

  it('bounds 0037 lock/build time and restores defaults for later migrations', () => {
    const sql = readFileSync(
      new URL('./0037_positions_user_created_idx.sql', import.meta.url),
      'utf8',
    );
    const lock = sql.indexOf("SET LOCAL lock_timeout = '5s'");
    const statement = sql.indexOf("SET LOCAL statement_timeout = '30s'");
    const create = sql.indexOf('CREATE INDEX "nb_market_positions_user_created_idx"');
    const resetStatement = sql.indexOf('SET LOCAL statement_timeout = DEFAULT');
    const resetLock = sql.indexOf('SET LOCAL lock_timeout = DEFAULT');

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(statement).toBeGreaterThan(lock);
    expect(create).toBeGreaterThan(statement);
    expect(resetStatement).toBeGreaterThan(create);
    expect(resetLock).toBeGreaterThan(resetStatement);
  });
});

/**
 * Deposit reconciliation sweep (ADR-0006 Phase 2).
 *
 * The store here is in-memory (no DATABASE_URL under vitest), so the sweep's
 * db-gate path is what most tests exercise via the flag; the log-source
 * classification logic (exclusions, aggregation) is tested through the
 * exported seam by stubbing storeBoot.db with a minimal drizzle-shaped fake
 * where needed. To keep this suite honest without a Postgres instance, we
 * test three layers:
 *   1. gates (flag off / no db) — sweep must no-op, not throw
 *   2. classification helpers via a full fake db + fake log source
 *   3. cursor semantics (first run initializes, never backfills)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import { storeBoot, store } from '../../store/index.js';
import { nbChainCursors, nbTransfers, nbUsers } from '../../db/schema/index.js';
import { sweepBaseDeposits, type DepositLogSource } from './deposits.js';

const mutableEnv = env as unknown as { DEPOSIT_RECONCILER: boolean };
const originalFlag = mutableEnv.DEPOSIT_RECONCILER;

const USER_WALLET = '0x00000000000000000000000000000000000000a1';
const OTHER_TRACKED_WALLET = '0x00000000000000000000000000000000000000a2';
const EXTERNAL_WALLET = '0x00000000000000000000000000000000000000e1';
const ZERO = '0x0000000000000000000000000000000000000000';

type FakeLog = { txHash: `0x${string}`; from: `0x${string}`; to: `0x${string}`; valueAtoms: bigint };

function fakeSource(latest: number, logs: FakeLog[]): DepositLogSource & { calls: number } {
  const src = {
    calls: 0,
    async getBlockNumber() {
      return BigInt(latest);
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint; toAddresses: `0x${string}`[] }) {
      src.calls += 1;
      // The fake ignores block filtering granularity — the sweep already
      // bounds the range; tests assert the range via the result fields.
      void fromBlock;
      void toBlock;
      return logs;
    },
  };
  return src;
}

/**
 * Minimal drizzle-shaped fake covering exactly the query shapes the sweep
 * issues: cursor select/upsert, users select, transfers dst-hash select.
 */
function fakeDb(opts: {
  userIdsByWallet: Record<string, string>;
  bridgeDstHashes?: string[];
  initialCursor?: number | null;
}): { db: unknown; cursor: () => number | null } {
  let cursorRow: { key: string; lastBlock: number } | null =
    opts.initialCursor != null ? { key: 'base:usdc-deposits', lastBlock: opts.initialCursor } : null;
  const db = {
    select(_shape?: unknown) {
      return {
        from(table: unknown) {
          const rowsFor = (): unknown[] => {
            if (table === nbChainCursors) return cursorRow ? [cursorRow] : [];
            if (table === nbUsers) {
              return Object.entries(opts.userIdsByWallet).map(([address, id]) => ({ id, address }));
            }
            if (table === nbTransfers) {
              return (opts.bridgeDstHashes ?? []).map((h) => ({ dstTxHash: h }));
            }
            return [];
          };
          const chain = {
            where: () => chain,
            limit: async () => rowsFor(),
            then: (resolve: (rows: unknown[]) => void, reject: (e: unknown) => void) =>
              Promise.resolve(rowsFor()).then(resolve, reject),
          };
          return chain;
        },
      };
    },
    insert() {
      return {
        values(v: { key: string; lastBlock: number }) {
          return {
            async onConflictDoUpdate() {
              cursorRow = { key: v.key, lastBlock: v.lastBlock };
            },
          };
        },
      };
    },
  };
  return { db, cursor: () => (cursorRow ? cursorRow.lastBlock : null) };
}

// storeBoot.db is a plain property (null under vitest's in-memory store) —
// swap it directly and restore after each test.
const mutableBoot = storeBoot as unknown as { db: unknown };
const originalDb = mutableBoot.db;

function useFakeDb(f: { db: unknown }): void {
  mutableBoot.db = f.db;
}

beforeEach(() => {
  mutableEnv.DEPOSIT_RECONCILER = true;
});

afterEach(() => {
  mutableEnv.DEPOSIT_RECONCILER = originalFlag;
  mutableBoot.db = originalDb;
  vi.restoreAllMocks();
});

describe('sweepBaseDeposits', () => {
  it('no-ops when the flag is off', async () => {
    mutableEnv.DEPOSIT_RECONCILER = false;
    const r = await sweepBaseDeposits(fakeSource(1000, []));
    expect(r.ran).toBe(false);
    expect(r.credited).toBe(0);
  });

  it('no-ops without a Postgres store (in-memory/demo)', async () => {
    const r = await sweepBaseDeposits(fakeSource(1000, []));
    expect(r.ran).toBe(false);
  });

  it('first run initializes the cursor at latest−confirmations and credits nothing (no backfill)', async () => {
    const u = await store.upsertUserByEmail('deposit-sweep-init@example.com');
    const fake = fakeDb({ userIdsByWallet: { [USER_WALLET]: u.id }, initialCursor: null });
    useFakeDb(fake);
    const src = fakeSource(1000, [
      { txHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`, from: EXTERNAL_WALLET, to: USER_WALLET, valueAtoms: 5_000_000n },
    ]);
    const r = await sweepBaseDeposits(src);
    expect(r.ran).toBe(true);
    expect(r.initializedCursor).toBe(true);
    expect(r.credited).toBe(0);
    expect(fake.cursor()).toBe(1000 - 300);
    expect(src.calls).toBe(0); // never even asked for logs
  });

  it('credits an external deposit once, advances the cursor, and skips exclusions', async () => {
    const u = await store.upsertUserByEmail('deposit-sweep-credit@example.com');
    const before = u.balUsd;
    const fake = fakeDb({
      userIdsByWallet: { [USER_WALLET]: u.id, [OTHER_TRACKED_WALLET]: 'other-user-id' },
      bridgeDstHashes: ['0x' + 'bb'.repeat(32)],
      initialCursor: 500,
    });
    useFakeDb(fake);
    const src = fakeSource(1000, [
      // 1. Genuine external deposit — credited.
      { txHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`, from: EXTERNAL_WALLET, to: USER_WALLET, valueAtoms: 12_500_000n },
      // 2. CCTP mint (from 0x0) — skipped.
      { txHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`, from: ZERO, to: USER_WALLET, valueAtoms: 9_000_000n },
      // 3. Internal move from another tracked wallet — skipped.
      { txHash: ('0x' + 'dd'.repeat(32)) as `0x${string}`, from: OTHER_TRACKED_WALLET, to: USER_WALLET, valueAtoms: 8_000_000n },
      // 4. Bridge delivery recorded in nb_transfers — skipped.
      { txHash: ('0x' + 'bb'.repeat(32)) as `0x${string}`, from: EXTERNAL_WALLET, to: USER_WALLET, valueAtoms: 7_000_000n },
      // 5. Dust — skipped.
      { txHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`, from: EXTERNAL_WALLET, to: USER_WALLET, valueAtoms: 100_000n },
    ]);
    const r = await sweepBaseDeposits(src);
    expect(r.ran).toBe(true);
    expect(r.credited).toBe(1);
    expect(r.creditedUsd).toBeCloseTo(12.5, 6);
    expect(r.skipped).toBe(4);
    expect(u.balUsd).toBeCloseTo(before + 12.5, 6);
    expect(fake.cursor()).toBe(1000 - 300);

    // Re-scan of the same window (crash recovery) must not double-credit —
    // reset the cursor and run again.
    const fake2 = fakeDb({
      userIdsByWallet: { [USER_WALLET]: u.id, [OTHER_TRACKED_WALLET]: 'other-user-id' },
      bridgeDstHashes: ['0x' + 'bb'.repeat(32)],
      initialCursor: 500,
    });
    useFakeDb(fake2);
    const r2 = await sweepBaseDeposits(src);
    expect(r2.credited).toBe(0); // creditDeposit replay: fresh=false
    expect(u.balUsd).toBeCloseTo(before + 12.5, 6);
  });

  it('aggregates multiple logs of one tx to the same wallet into a single credit', async () => {
    const u = await store.upsertUserByEmail('deposit-sweep-agg@example.com');
    const before = u.balUsd;
    const fake = fakeDb({ userIdsByWallet: { [USER_WALLET]: u.id }, initialCursor: 500 });
    useFakeDb(fake);
    const tx = ('0x' + 'a1'.repeat(32)) as `0x${string}`;
    const src = fakeSource(1000, [
      { txHash: tx, from: EXTERNAL_WALLET, to: USER_WALLET, valueAtoms: 1_000_000n },
      { txHash: tx, from: EXTERNAL_WALLET, to: USER_WALLET, valueAtoms: 2_000_000n },
    ]);
    const r = await sweepBaseDeposits(src);
    expect(r.credited).toBe(1);
    expect(r.creditedUsd).toBeCloseTo(3, 6);
    expect(u.balUsd).toBeCloseTo(before + 3, 6);
  });

  it('bounds the scan window and leaves the cursor at the bounded block', async () => {
    const u = await store.upsertUserByEmail('deposit-sweep-bound@example.com');
    const fake = fakeDb({ userIdsByWallet: { [USER_WALLET]: u.id }, initialCursor: 0 });
    useFakeDb(fake);
    const r = await sweepBaseDeposits(fakeSource(50_000, []));
    expect(r.ran).toBe(true);
    // cursor 0 + MAX_BLOCKS_PER_SWEEP(10_000) < 50_000−12 → bounded.
    expect(r.scannedToBlock).toBe(10_000);
    expect(fake.cursor()).toBe(10_000);
  });
});

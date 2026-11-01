/**
 * ADR-0006 Phase 2 — Base USDC deposit reconciliation sweep.
 *
 * Scans USDC `Transfer` logs on Base for arrivals at users' Privy wallet
 * addresses and credits the app ledger via `store.creditDeposit` (idempotent
 * on tx hash). From this sweep onward the spendable ledger can only contain
 * money that verifiably arrived on-chain.
 *
 * Called by the BullMQ worker (workers/deposit-reconciler.ts, every 2 min)
 * and the admin fallback route (POST /admin/sweep-deposits) — same single
 * source of truth pattern as sweeps/claims.ts.
 *
 * EXCLUSIONS — arrivals that are our own money movements, not deposits:
 *   1. `from == 0x0`            → CCTP V1/V2 mints (perps→cash etc.)
 *   2. `from` is a tracked user wallet → internal user↔user / self moves
 *   3. tx hash recorded as a bridge delivery (`nb_transfers.dst_tx_hash`)
 *   4. dust below MIN_DEPOSIT_CREDIT_USD
 *
 * Cursor: `nb_chain_cursors['base:usdc-deposits']`. First run initializes to
 * (latest − confirmations) and credits NOTHING — historical backfill is a
 * deliberate manual operation, not an automatic one. Crash recovery re-scans
 * the window; creditDeposit's tx-hash idempotency absorbs the re-offer.
 */

import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';
import { base } from 'viem/chains';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { env } from '../env.js';
import { log } from '../log.js';
import { store, storeBoot } from '../../store/index.js';
import { nbChainCursors, nbTransfers, nbUsers } from '../../db/schema/index.js';
import { USDC_BY_CHAIN } from '../chain/cctp.js';

const CURSOR_KEY = 'base:usdc-deposits';
/**
 * ~10 minutes of Base blocks (2s cadence) before a block becomes creditable.
 * Serves two purposes: reorg safety, and — the load-bearing one — closing
 * the race with the bridge worker (audit 2026-07-08): exclusion filter 3
 * reads `nb_transfers.dst_tx_hash`, which the bridge worker writes on its
 * own polling cadence AFTER the delivery lands on-chain. Crediting only
 * blocks older than ~10 min guarantees the delivery record exists before
 * the sweep can misread a bucket→cash bridge arrival as an external
 * deposit. Deposit credit latency is therefore ~10-12 min by design.
 */
const CONFIRMATIONS = 300;
/** Bound the per-tick scan window so a long outage can't demand one giant getLogs. */
const MAX_BLOCKS_PER_SWEEP = 10_000;
/** Addresses per getLogs topic filter — RPC providers cap topic array sizes. */
const ADDRESS_CHUNK = 200;
/** Ignore dust — sub-$0.50 arrivals aren't worth a ledger row. */
const MIN_DEPOSIT_CREDIT_USD = 0.5;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface DepositSweepResult {
  /** false when a gate (flag / db / rpc) skipped the sweep entirely. */
  ran: boolean;
  initializedCursor?: boolean;
  fromBlock?: number;
  scannedToBlock?: number;
  credited: number;
  creditedUsd: number;
  skipped: number;
}

const SKIPPED_RESULT: DepositSweepResult = { ran: false, credited: 0, creditedUsd: 0, skipped: 0 };

/** Test seam — everything the sweep reads from the chain. */
export interface DepositLogSource {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    fromBlock: bigint;
    toBlock: bigint;
    toAddresses: Hex[];
  }): Promise<Array<{ txHash: Hex; from: Hex; to: Hex; valueAtoms: bigint }>>;
}

function viemLogSource(): DepositLogSource | null {
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';
  const usdc = USDC_BY_CHAIN.base;
  if (!usdc) return null;
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 15_000 }) });
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getLogs({ fromBlock, toBlock, toAddresses }) {
      const logs = await client.getLogs({
        address: usdc,
        event: TRANSFER_EVENT,
        args: { to: toAddresses },
        fromBlock,
        toBlock,
      });
      return logs
        .filter((l) => l.args.from && l.args.to && l.args.value !== undefined && l.transactionHash)
        .map((l) => ({
          txHash: l.transactionHash as Hex,
          from: l.args.from as Hex,
          to: l.args.to as Hex,
          valueAtoms: l.args.value as bigint,
        }));
    },
  };
}

async function readCursor(db: NonNullable<typeof storeBoot.db>): Promise<number | null> {
  const [row] = await db
    .select()
    .from(nbChainCursors)
    .where(eq(nbChainCursors.key, CURSOR_KEY))
    .limit(1);
  return row ? Number(row.lastBlock) : null;
}

async function writeCursor(db: NonNullable<typeof storeBoot.db>, block: number): Promise<void> {
  await db
    .insert(nbChainCursors)
    .values({ key: CURSOR_KEY, lastBlock: block, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: nbChainCursors.key,
      set: { lastBlock: block, updatedAt: new Date() },
    });
}

export async function sweepBaseDeposits(
  source: DepositLogSource | null = viemLogSource(),
): Promise<DepositSweepResult> {
  if (!env.DEPOSIT_RECONCILER) return SKIPPED_RESULT;
  const db = storeBoot.db;
  if (!db) return SKIPPED_RESULT; // in-memory/demo store — nothing durable to reconcile
  if (!source) return SKIPPED_RESULT;

  const latest = Number(await source.getBlockNumber());
  const safeHead = latest - CONFIRMATIONS;
  if (safeHead <= 0) return SKIPPED_RESULT;

  const cursor = await readCursor(db);
  if (cursor === null) {
    // First run — start from NOW. Backfilling history would credit deposits
    // that predate the reconciliation regime; that is a manual decision.
    await writeCursor(db, safeHead);
    log.info({ cursor: safeHead }, 'deposit-sweep: cursor initialized (no backfill)');
    return { ran: true, initializedCursor: true, scannedToBlock: safeHead, credited: 0, creditedUsd: 0, skipped: 0 };
  }
  if (cursor >= safeHead) {
    return { ran: true, fromBlock: cursor, scannedToBlock: cursor, credited: 0, creditedUsd: 0, skipped: 0 };
  }
  const fromBlock = cursor + 1;
  const toBlock = Math.min(safeHead, cursor + MAX_BLOCKS_PER_SWEEP);

  // Tracked wallets: userId by lowercase address, for credit routing AND the
  // internal-move exclusion.
  const rows = await db
    .select({ id: nbUsers.id, address: nbUsers.privyWalletAddress })
    .from(nbUsers)
    .where(isNotNull(nbUsers.privyWalletAddress));
  const userByAddress = new Map<string, string>();
  for (const r of rows) {
    if (r.address) userByAddress.set(r.address.toLowerCase(), r.id);
  }
  if (userByAddress.size === 0) {
    await writeCursor(db, toBlock);
    return { ran: true, fromBlock, scannedToBlock: toBlock, credited: 0, creditedUsd: 0, skipped: 0 };
  }

  const addresses = [...userByAddress.keys()] as Hex[];
  const allLogs: Array<{ txHash: Hex; from: Hex; to: Hex; valueAtoms: bigint }> = [];
  for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
    const chunk = addresses.slice(i, i + ADDRESS_CHUNK);
    allLogs.push(
      ...(await source.getLogs({ fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock), toAddresses: chunk })),
    );
  }

  const ZERO = '0x0000000000000000000000000000000000000000';
  let skipped = 0;
  // Aggregate per (txHash, recipient) — several Transfer logs in one tx to
  // the same wallet credit once with the summed amount (the tx hash is the
  // idempotency key, so they could never credit separately anyway).
  const candidates = new Map<string, { txHash: Hex; userId: string; atoms: bigint }>();
  const candidateTxHashes = new Set<string>();
  for (const l of allLogs) {
    const from = l.from.toLowerCase();
    const to = l.to.toLowerCase();
    const userId = userByAddress.get(to);
    if (!userId) continue;
    if (from === ZERO || userByAddress.has(from)) {
      skipped++;
      continue;
    }
    const key = `${l.txHash.toLowerCase()}:${to}`;
    const existing = candidates.get(key);
    if (existing) existing.atoms += l.valueAtoms;
    else candidates.set(key, { txHash: l.txHash, userId, atoms: l.valueAtoms });
    candidateTxHashes.add(l.txHash);
  }

  // Exclusion 3 — bridge deliveries our own worker recorded (Mayan → base
  // etc. arrive from bridge contracts, not 0x0).
  let bridgeDeliveries = new Set<string>();
  if (candidateTxHashes.size > 0) {
    const deliveredRows = await db
      .select({ dstTxHash: nbTransfers.dstTxHash })
      .from(nbTransfers)
      .where(and(isNotNull(nbTransfers.dstTxHash), inArray(nbTransfers.dstTxHash, [...candidateTxHashes])));
    bridgeDeliveries = new Set(deliveredRows.map((r) => (r.dstTxHash ?? '').toLowerCase()));
  }

  let credited = 0;
  let creditedUsd = 0;
  for (const c of candidates.values()) {
    if (bridgeDeliveries.has(c.txHash.toLowerCase())) {
      skipped++;
      continue;
    }
    const amountUsd = Number(c.atoms) / 1_000_000;
    if (amountUsd < MIN_DEPOSIT_CREDIT_USD) {
      skipped++;
      continue;
    }
    try {
      const u = await store.user(c.userId);
      const { fresh } = await store.creditDeposit(u, amountUsd, { txHash: c.txHash, chain: 'base' });
      if (fresh) {
        credited++;
        creditedUsd += amountUsd;
        log.info(
          { userId: c.userId, amountUsd, txHash: c.txHash },
          'deposit-sweep: credited on-chain deposit',
        );
      }
    } catch (e) {
      // One bad credit must not stall the cursor for everyone else; the tx
      // hash idempotency lets the next sweep retry this window safely — but
      // only if we DON'T advance past it. Conservative: stop here, keep the
      // cursor at the last fully-processed point (previous block of this tx
      // is unknowable cheaply, so re-scan the whole window next tick).
      log.error(
        { err: e instanceof Error ? e.message : String(e), userId: c.userId, txHash: c.txHash },
        'deposit-sweep: credit failed — window will re-scan next tick',
      );
      return { ran: true, fromBlock, scannedToBlock: cursor, credited, creditedUsd, skipped };
    }
  }

  await writeCursor(db, toBlock);
  return { ran: true, fromBlock, scannedToBlock: toBlock, credited, creditedUsd, skipped };
}

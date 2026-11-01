/**
 * Cross-chain transfer store (Sprint 19).
 *
 * Adjunct store for `nb_transfers` + `nb_transfer_events`. Self-contained
 * rather than wired into the main Store interface so the new bridging
 * surface can land without touching twelve domain modules. Postgres-backed
 * when `storeBoot.db` is available; in-memory Map fallback for DEMO_MODE +
 * tests.
 *
 * Both code paths share the same `Transfer` / `TransferEvent` shapes so the
 * /transfers/internal route, the bridge worker, and the eventual lift into
 * the Store interface can all share types.
 *
 * Idempotency contract: `create()` re-issues the existing row when the
 * (userId, idempotencyKey) pair has been seen before — never throws on
 * replay. Same shape as `nb_bridge_transfers`.
 */

import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, notInArray, sql } from 'drizzle-orm';
import { nbTransfers, nbTransferEvents } from '../db/schema/index.js';
import { storeBoot } from './index.js';

export type TransferBucket = 'perps' | 'predictions' | 'memes' | 'stocks-spot' | 'cash' | 'external';
export type TransferChain = 'arbitrum' | 'polygon' | 'solana' | 'base' | 'optimism' | 'gnosis';
export type TransferRail = 'cctp' | 'mayan' | 'socket' | 'lifi' | 'hl_bridge' | 'hl_withdraw' | 'internal';
export type TransferStatus =
  | 'created'
  | 'burning'
  | 'attesting'
  | 'minting'
  | 'depositing'
  /** Bucket-final hop for Perps: USDC.transfer → HL Bridge2 → HL L1 credit. */
  | 'hl_depositing'
  /** Outbound first hop for Perps-SOURCE legs: withdraw3 → Arbitrum EOA arrival. */
  | 'hl_withdrawing'
  | 'complete'
  | 'failed';

/**
 * F092 Sprint 18 — terminal statuses are the single source of truth for
 * "the worker is done with this row". `listMidFlight` filters by exclusion
 * of this set rather than enumerating non-terminal states, so adding a new
 * state to `TransferStatus` (e.g. a future `verifying`, `bridging`) does not
 * silently orphan that state on worker restart — anything not in this set is
 * mid-flight by default.
 */
export const TERMINAL_TRANSFER_STATUSES: readonly TransferStatus[] = ['complete', 'failed'] as const;

export interface Transfer {
  id: string;
  userId: string;
  fromBucket: TransferBucket;
  toBucket: TransferBucket;
  fromChain: TransferChain;
  toChain: TransferChain;
  amountUsd: number;
  amountTokenAtoms: string;
  token: string;
  rail: TransferRail;
  status: TransferStatus;
  srcTxHash: string | null;
  dstTxHash: string | null;
  srcCallId: string | null;
  dstCallId: string | null;
  cctpMessageHash: string | null;
  cctpMessageBody: string | null;
  cctpAttestation: string | null;
  /** CCTP protocol version the burn used (1 | 2); null pre-V2 or non-CCTP. */
  cctpVersion: number | null;
  feesUsd: number;
  error: unknown;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransferEvent {
  id: string;
  transferId: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface NewTransfer {
  userId: string;
  fromBucket: TransferBucket;
  toBucket: TransferBucket;
  fromChain: TransferChain;
  toChain: TransferChain;
  amountUsd: number;
  amountTokenAtoms: string;
  token?: string;
  rail: TransferRail;
  /**
   * Perps-source legs start at the HL-withdrawal hop instead of `created` —
   * funds sit on HL L1, so nothing on the EOA is spendable until withdraw3
   * pays out. Defaults to `created`.
   */
  initialStatus?: Extract<TransferStatus, 'created' | 'hl_withdrawing'>;
  idempotencyKey: string;
}

export interface CreateTransferResult {
  transfer: Transfer;
  fresh: boolean;
}

export interface TransferPatch {
  rail?: TransferRail;
  status?: TransferStatus;
  srcTxHash?: string | null;
  dstTxHash?: string | null;
  srcCallId?: string | null;
  dstCallId?: string | null;
  cctpMessageHash?: string | null;
  cctpMessageBody?: string | null;
  cctpAttestation?: string | null;
  cctpVersion?: number | null;
  feesUsd?: number;
  error?: unknown;
}

function nanoid32(): string {
  // 32 char URL-safe base64 (≈192 bits of entropy). No node:crypto.randomUUID
  // because we want url-safe, single-segment, fixed-length 36 incl prefix.
  return randomBytes(24).toString('base64url').slice(0, 32);
}

function generateTransferId(): string {
  return `tr_${nanoid32()}`;
}

function n(v: string | number): number {
  return typeof v === 'number' ? v : Number(v);
}

/* ── In-memory fallback (DEMO_MODE / tests) ──────────────────────────────── */

const memTransfers = new Map<string, Transfer>();
const memEvents = new Map<string, TransferEvent[]>(); // transferId → events
let memEventCounter = 0;

function memCreate(input: NewTransfer): CreateTransferResult {
  // Idempotency replay — return the existing row when the pair is reused.
  for (const t of memTransfers.values()) {
    if (t.userId === input.userId && t.idempotencyKey === input.idempotencyKey) {
      return { transfer: t, fresh: false };
    }
  }
  const now = new Date().toISOString();
  const t: Transfer = {
    id: generateTransferId(),
    userId: input.userId,
    fromBucket: input.fromBucket,
    toBucket: input.toBucket,
    fromChain: input.fromChain,
    toChain: input.toChain,
    amountUsd: input.amountUsd,
    amountTokenAtoms: input.amountTokenAtoms,
    token: input.token ?? 'USDC',
    rail: input.rail,
    status: input.initialStatus ?? 'created',
    srcTxHash: null,
    dstTxHash: null,
    srcCallId: null,
    dstCallId: null,
    cctpMessageHash: null,
    cctpMessageBody: null,
    cctpAttestation: null,
    cctpVersion: null,
    feesUsd: 0,
    error: null,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  memTransfers.set(t.id, t);
  return { transfer: t, fresh: true };
}

function memFindByUserIdempotencyKey(userId: string, idempotencyKey: string): Transfer | null {
  for (const t of memTransfers.values()) {
    if (t.userId === userId && t.idempotencyKey === idempotencyKey) return t;
  }
  return null;
}

function memUpdate(id: string, patch: TransferPatch): Transfer | null {
  const t = memTransfers.get(id);
  if (!t) return null;
  const updated: Transfer = {
    ...t,
    ...(patch.rail !== undefined ? { rail: patch.rail } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.srcTxHash !== undefined ? { srcTxHash: patch.srcTxHash } : {}),
    ...(patch.dstTxHash !== undefined ? { dstTxHash: patch.dstTxHash } : {}),
    ...(patch.srcCallId !== undefined ? { srcCallId: patch.srcCallId } : {}),
    ...(patch.dstCallId !== undefined ? { dstCallId: patch.dstCallId } : {}),
    ...(patch.cctpMessageHash !== undefined ? { cctpMessageHash: patch.cctpMessageHash } : {}),
    ...(patch.cctpMessageBody !== undefined ? { cctpMessageBody: patch.cctpMessageBody } : {}),
    ...(patch.cctpAttestation !== undefined ? { cctpAttestation: patch.cctpAttestation } : {}),
    ...(patch.cctpVersion !== undefined ? { cctpVersion: patch.cctpVersion } : {}),
    ...(patch.feesUsd !== undefined ? { feesUsd: patch.feesUsd } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    updatedAt: new Date().toISOString(),
  };
  memTransfers.set(id, updated);
  return updated;
}

function memClaimCreated(id: string): Transfer | null {
  const t = memTransfers.get(id);
  if (!t || t.status !== 'created') return null;
  return memUpdate(id, { status: 'burning' });
}

function memAppendEvent(transferId: string, eventType: string, payload: unknown): TransferEvent {
  memEventCounter += 1;
  const evt: TransferEvent = {
    id: String(memEventCounter),
    transferId,
    eventType,
    payload,
    createdAt: new Date().toISOString(),
  };
  const list = memEvents.get(transferId) ?? [];
  list.push(evt);
  memEvents.set(transferId, list);
  return evt;
}

/* ── Postgres path ───────────────────────────────────────────────────────── */

type TransferRow = typeof nbTransfers.$inferSelect;
type EventRow = typeof nbTransferEvents.$inferSelect;

function transferFromRow(row: TransferRow): Transfer {
  return {
    id: row.id,
    userId: row.userId,
    fromBucket: row.fromBucket as TransferBucket,
    toBucket: row.toBucket as TransferBucket,
    fromChain: row.fromChain as TransferChain,
    toChain: row.toChain as TransferChain,
    amountUsd: n(row.amountUsd),
    amountTokenAtoms: row.amountTokenAtoms,
    token: row.token,
    rail: row.rail as TransferRail,
    status: row.status as TransferStatus,
    srcTxHash: row.srcTxHash ?? null,
    dstTxHash: row.dstTxHash ?? null,
    srcCallId: row.srcCallId ?? null,
    dstCallId: row.dstCallId ?? null,
    cctpMessageHash: row.cctpMessageHash ?? null,
    cctpMessageBody: row.cctpMessageBody ?? null,
    cctpAttestation: row.cctpAttestation ?? null,
    cctpVersion: row.cctpVersion ?? null,
    feesUsd: n(row.feesUsd),
    error: row.error ?? null,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function eventFromRow(row: EventRow): TransferEvent {
  return {
    id: String(row.id),
    transferId: row.transferId,
    eventType: row.eventType,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── Public surface — branches on whether storeBoot.db is set ────────────── */

export const transferStore = {
  async findByUserIdempotencyKey(userId: string, idempotencyKey: string): Promise<Transfer | null> {
    const db = storeBoot.db;
    if (!db) return memFindByUserIdempotencyKey(userId, idempotencyKey);
    const [existing] = await db
      .select()
      .from(nbTransfers)
      .where(and(eq(nbTransfers.userId, userId), eq(nbTransfers.idempotencyKey, idempotencyKey)))
      .limit(1);
    return existing ? transferFromRow(existing) : null;
  },

  async create(input: NewTransfer): Promise<CreateTransferResult> {
    const db = storeBoot.db;
    if (!db) return memCreate(input);
    const id = generateTransferId();
    const [inserted] = await db
      .insert(nbTransfers)
      .values({
        id,
        userId: input.userId,
        fromBucket: input.fromBucket,
        toBucket: input.toBucket,
        fromChain: input.fromChain,
        toChain: input.toChain,
        amountUsd: String(input.amountUsd),
        amountTokenAtoms: input.amountTokenAtoms,
        token: input.token ?? 'USDC',
        rail: input.rail,
        status: input.initialStatus ?? 'created',
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({
        target: [nbTransfers.userId, nbTransfers.idempotencyKey],
      })
      .returning();
    if (inserted) return { transfer: transferFromRow(inserted), fresh: true };
    const [existing] = await db
      .select()
      .from(nbTransfers)
      .where(
        and(eq(nbTransfers.userId, input.userId), eq(nbTransfers.idempotencyKey, input.idempotencyKey)),
      )
      .limit(1);
    if (!existing) throw new Error('transfer_idempotency_conflict');
    return { transfer: transferFromRow(existing), fresh: false };
  },

  async claimCreated(id: string): Promise<Transfer | null> {
    const db = storeBoot.db;
    if (!db) return memClaimCreated(id);
    const [row] = await db
      .update(nbTransfers)
      .set({ status: 'burning', updatedAt: new Date() })
      .where(and(eq(nbTransfers.id, id), eq(nbTransfers.status, 'created')))
      .returning();
    return row ? transferFromRow(row) : null;
  },

  async get(id: string): Promise<Transfer | null> {
    const db = storeBoot.db;
    if (!db) return memTransfers.get(id) ?? null;
    const [row] = await db.select().from(nbTransfers).where(eq(nbTransfers.id, id)).limit(1);
    return row ? transferFromRow(row) : null;
  },

  async listByUser(userId: string, limit = 50): Promise<Transfer[]> {
    const db = storeBoot.db;
    if (!db) {
      return Array.from(memTransfers.values())
        .filter((t) => t.userId === userId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    }
    const rows = await db
      .select()
      .from(nbTransfers)
      .where(eq(nbTransfers.userId, userId))
      .orderBy(desc(nbTransfers.createdAt))
      .limit(limit);
    return rows.map(transferFromRow);
  },

  /**
   * Find transfers in a non-terminal status. Used by the bridge worker on
   * boot to re-enqueue rows that were mid-flight when the worker restarted.
   *
   * F092 — filter-by-exclusion of `TERMINAL_TRANSFER_STATUSES`. Adding a new
   * status to `TransferStatus` automatically inherits the mid-flight default;
   * a future state addition cannot silently orphan rows on worker boot.
   */
  /**
   * F095 — group-by-(status, rail, toBucket) count of all transfers. Powers
   * the `bridge_transfers_by_status` Prometheus gauge so operators can see
   * stuck-row pile-ups in Grafana without ad-hoc SQL.
   */
  async countByStatus(): Promise<Array<{ status: string; rail: string; bucket: string; count: number }>> {
    const db = storeBoot.db;
    if (!db) {
      const buckets = new Map<string, number>();
      for (const t of memTransfers.values()) {
        const key = `${t.status}|${t.rail}|${t.toBucket}`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      return Array.from(buckets.entries()).map(([key, count]) => {
        const [status, rail, bucket] = key.split('|') as [string, string, string];
        return { status, rail, bucket, count };
      });
    }
    const rows = await db
      .select({
        status: nbTransfers.status,
        rail: nbTransfers.rail,
        bucket: nbTransfers.toBucket,
        count: sql<number>`COUNT(*)::int`.as('count'),
      })
      .from(nbTransfers)
      .groupBy(nbTransfers.status, nbTransfers.rail, nbTransfers.toBucket);
    return rows.map((r) => ({
      status: r.status,
      rail: r.rail,
      bucket: r.bucket,
      count: Number(r.count),
    }));
  },

  async listMidFlight(): Promise<Transfer[]> {
    const db = storeBoot.db;
    if (!db) {
      return Array.from(memTransfers.values()).filter(
        (t) => !TERMINAL_TRANSFER_STATUSES.includes(t.status),
      );
    }
    const rows = await db
      .select()
      .from(nbTransfers)
      .where(notInArray(nbTransfers.status, TERMINAL_TRANSFER_STATUSES as unknown as string[]));
    return rows.map(transferFromRow);
  },

  async update(id: string, patch: TransferPatch): Promise<Transfer | null> {
    const db = storeBoot.db;
    if (!db) return memUpdate(id, patch);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.rail !== undefined) updates['rail'] = patch.rail;
    if (patch.status !== undefined) updates['status'] = patch.status;
    if (patch.srcTxHash !== undefined) updates['srcTxHash'] = patch.srcTxHash;
    if (patch.dstTxHash !== undefined) updates['dstTxHash'] = patch.dstTxHash;
    if (patch.srcCallId !== undefined) updates['srcCallId'] = patch.srcCallId;
    if (patch.dstCallId !== undefined) updates['dstCallId'] = patch.dstCallId;
    if (patch.cctpMessageHash !== undefined) updates['cctpMessageHash'] = patch.cctpMessageHash;
    if (patch.cctpMessageBody !== undefined) updates['cctpMessageBody'] = patch.cctpMessageBody;
    if (patch.cctpAttestation !== undefined) updates['cctpAttestation'] = patch.cctpAttestation;
    if (patch.cctpVersion !== undefined) updates['cctpVersion'] = patch.cctpVersion;
    if (patch.feesUsd !== undefined) updates['feesUsd'] = String(patch.feesUsd);
    if (patch.error !== undefined) updates['error'] = patch.error;
    const [row] = await db.update(nbTransfers).set(updates).where(eq(nbTransfers.id, id)).returning();
    return row ? transferFromRow(row) : null;
  },

  async appendEvent(
    transferId: string,
    eventType: string,
    payload: unknown,
  ): Promise<TransferEvent> {
    const db = storeBoot.db;
    if (!db) return memAppendEvent(transferId, eventType, payload);
    const [row] = await db
      .insert(nbTransferEvents)
      .values({
        transferId,
        eventType,
        payload: payload as Record<string, unknown>,
      })
      .returning();
    return eventFromRow(row!);
  },

  async listEvents(transferId: string, limit = 100): Promise<TransferEvent[]> {
    const db = storeBoot.db;
    if (!db) return (memEvents.get(transferId) ?? []).slice(0, limit);
    const rows = await db
      .select()
      .from(nbTransferEvents)
      .where(eq(nbTransferEvents.transferId, transferId))
      .orderBy(asc(nbTransferEvents.createdAt))
      .limit(limit);
    return rows.map(eventFromRow);
  },

  /** Test-only: drop in-memory state between test cases. */
  _resetForTests(): void {
    memTransfers.clear();
    memEvents.clear();
    memEventCounter = 0;
  },
};

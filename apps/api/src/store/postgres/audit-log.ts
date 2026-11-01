/**
 * PgAuditLog — append-only forensic trail (Tier 3 #14).
 *
 * Single-purpose module: one insert path (recordAuditEntry) and one read path
 * (listAuditEntries). No UPDATE / DELETE methods on purpose — the table is the
 * legal source of truth for compliance reviews. Trim by created_at if retention
 * policy ever needs it; that lives outside this module.
 *
 * The id column is bigserial; we surface it as a string everywhere to dodge
 * JS bigint contagion at the route + JSON serialization boundary.
 */

import { and, desc, eq, gte, like, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nbAuditLog } from '../../db/schema/index.js';
import {
  type AuditLogEntry,
  type AuditLogFilter,
  type AuditLogRecord,
  type AuditActorType,
} from '../types.js';

/** Inline-mirror of the route-level clamps so the store stays the safety net. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type AuditRow = typeof nbAuditLog.$inferSelect;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit as number) <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(limit as number));
}

function rowToRecord(row: AuditRow): AuditLogRecord {
  return {
    id: String(row.id),
    actorType: row.actorType as AuditActorType,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgAuditLog {
  constructor(private db: Db) {}

  async recordAuditEntry(entry: AuditLogEntry): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(nbAuditLog)
      .values({
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        // jsonb column — pass the object directly, drizzle stringifies it.
        metadata: (entry.metadata ?? {}) as Record<string, unknown>,
        requestId: entry.requestId ?? null,
      })
      .returning({ id: nbAuditLog.id });
    if (!row) throw new Error('audit_log_insert_failed');
    return { id: String(row.id) };
  }

  async listAuditEntries(filter: AuditLogFilter): Promise<AuditLogRecord[]> {
    const conditions = [] as ReturnType<typeof eq>[];
    if (filter.actorType) conditions.push(eq(nbAuditLog.actorType, filter.actorType));
    if (filter.actionPrefix) {
      // Escape `%` and `_` so a wildcard in user-supplied input can't widen
      // the match. The admin route also validates the input is a sensible
      // dotted action token; this is defense-in-depth.
      const escaped = filter.actionPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      conditions.push(like(nbAuditLog.action, `${escaped}%`) as unknown as ReturnType<typeof eq>);
    }
    if (filter.since instanceof Date) {
      conditions.push(gte(nbAuditLog.createdAt, filter.since) as unknown as ReturnType<typeof eq>);
    }
    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0]! : and(...conditions)!;

    const rows = await this.db
      .select()
      .from(nbAuditLog)
      .where(where ?? sql`true`)
      .orderBy(desc(nbAuditLog.createdAt), desc(nbAuditLog.id))
      .limit(clampLimit(filter.limit));
    return rows.map(rowToRecord);
  }
}

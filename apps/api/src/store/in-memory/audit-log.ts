/**
 * InMemoryAuditLog — append-only forensic trail (Tier 3 #14).
 *
 * Demo-mode mirror of PgAuditLog. Same insert + filtered-list surface; rows
 * live in a single sorted array indexed by an in-process counter. Lost on
 * restart (matches the rest of in-memory.ts). Behavior parity with Postgres:
 *   - newest-first ordering on read
 *   - limit defaults to 100, clamps at 1000
 *   - actionPrefix is case-sensitive prefix matching on the action key
 *   - since is inclusive (createdAt >= since)
 */

import {
  type AuditLogEntry,
  type AuditLogFilter,
  type AuditLogRecord,
} from '../types.js';
import { nowIso } from './_shared.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit as number) <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(limit as number));
}

export class InMemoryAuditLog {
  private rows: AuditLogRecord[] = [];
  private nextId = 1n;

  async recordAuditEntry(entry: AuditLogEntry): Promise<{ id: string }> {
    const id = String(this.nextId);
    this.nextId += 1n;
    const row: AuditLogRecord = {
      id,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: { ...(entry.metadata ?? {}) },
      requestId: entry.requestId ?? null,
      createdAt: nowIso(),
    };
    this.rows.push(row);
    return { id };
  }

  async listAuditEntries(filter: AuditLogFilter): Promise<AuditLogRecord[]> {
    const sinceMs = filter.since instanceof Date ? filter.since.getTime() : null;
    const filtered = this.rows.filter((r) => {
      if (filter.actorType && r.actorType !== filter.actorType) return false;
      if (filter.actionPrefix && !r.action.startsWith(filter.actionPrefix)) return false;
      if (sinceMs !== null && new Date(r.createdAt).getTime() < sinceMs) return false;
      return true;
    });
    // Newest first; ties broken by id desc to match the Postgres order-by.
    filtered.sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      // Both ids are decimal strings of incrementing bigints — length-first
      // compare avoids JS Number precision loss for long-lived processes.
      if (a.id.length !== b.id.length) return b.id.length - a.id.length;
      return b.id.localeCompare(a.id);
    });
    return filtered.slice(0, clampLimit(filter.limit));
  }

  clearAll(): void {
    this.rows = [];
    this.nextId = 1n;
  }
}

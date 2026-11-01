/**
 * Sprint 17 F066 — audit-log emitters.
 *
 * The `nb_audit_log` table + store impl shipped in Sprint 12 (migration 0014)
 * but no production mutation called `recordAuditEntry()`. This helper closes
 * that gap from the route layer. Security/compliance-critical routes should
 * await `recordAudit()` before returning success; `emitAudit()` remains for
 * non-critical best-effort telemetry.
 *
 * Callers pass:
 *   - `action` (dotted lowercase token, e.g. 'payment.paid')
 *   - actor/target metadata derived from the request context
 *   - free-form `metadata` object (already-redacted, no raw PII)
 *
 * The request id is read from the Hono context when available so SIEM exports
 * can correlate audit rows back to HTTP logs.
 */

import type { Context } from 'hono';
import { log } from './log.js';
import { store } from '../store/index.js';
import type { AuditActorType } from '../store/types.js';

export interface AuditEmit {
  action: string;
  actorType: AuditActorType;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

function auditPayload(c: Context, entry: AuditEmit): Parameters<typeof store.recordAuditEntry>[0] {
  // `requestId` is always populated by the request-id middleware at
  // apps/api/src/index.ts:73-75 with either the validated client header or
  // a server-generated UUID. Reading the header directly here would let a
  // malicious client spoof correlation ids if any future code path bypassed
  // the middleware — trust only the context value.
  const requestId = c.get('requestId') ?? null;
  return {
    action: entry.action,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    requestId,
  };
}

/** Emit an audit row and surface failures to the caller. */
export async function recordAudit(c: Context, entry: AuditEmit): Promise<void> {
  await store.recordAuditEntry(auditPayload(c, entry));
}

/**
 * Emit an audit row WITHOUT awaiting it. The route handler returns immediately;
 * insert failures are logged at warn and intentionally do not page.
 */
export function emitAudit(c: Context, entry: AuditEmit): void {
  void recordAudit(c, entry)
    .catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), action: entry.action },
        'audit_emit_failed',
      );
    });
}

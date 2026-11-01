/**
 * Shared realtime connection budget (scale plan 1.5, hardening 2026-07-03).
 *
 * WS and SSE serve the SAME hub on the SAME process, so the capacity ceiling
 * must be shared: gating only the WS upgrade path let a shed client (or an
 * attacker with valid tickets) pivot to /v1/stream/sse and reopen unlimited
 * streams, defeating the bounded blast radius. Both transports acquire a slot
 * here before accepting a connection and release it on close.
 *
 * Leaf module — imports only env, so neither transport creates an import
 * cycle by using it.
 */

import { env } from '../lib/env.js';

let active = 0;

/** Reserve one slot. Returns false (caller must reject) when at capacity. */
export function tryAcquireRealtimeSlot(): boolean {
  if (active >= env.REALTIME_MAX_CLIENTS) return false;
  active += 1;
  return true;
}

/** Release a slot previously acquired. Idempotent-safe (floors at 0). */
export function releaseRealtimeSlot(): void {
  active = Math.max(0, active - 1);
}

/** Combined WS + SSE live connection count, for metrics/health. */
export function activeRealtimeClients(): number {
  return active;
}

/* ── per-user / per-IP sub-budgets (readiness audit 2026-07-16) ──────────── */

const perUser = new Map<string, number>();
const perIp = new Map<string, number>();

/** Reserve a per-user slot. False at REALTIME_MAX_CONNS_PER_USER. */
export function tryAcquireUserSlot(userId: string): boolean {
  const n = perUser.get(userId) ?? 0;
  if (n >= env.REALTIME_MAX_CONNS_PER_USER) return false;
  perUser.set(userId, n + 1);
  return true;
}

/** Release a per-user slot. Idempotent-safe; evicts the entry at zero. */
export function releaseUserSlot(userId: string): void {
  const n = perUser.get(userId) ?? 0;
  if (n <= 1) perUser.delete(userId);
  else perUser.set(userId, n - 1);
}

/** Reserve a per-source-IP slot. False at REALTIME_MAX_CONNS_PER_IP. */
export function tryAcquireIpSlot(ip: string): boolean {
  const n = perIp.get(ip) ?? 0;
  if (n >= env.REALTIME_MAX_CONNS_PER_IP) return false;
  perIp.set(ip, n + 1);
  return true;
}

/** Release a per-IP slot. Idempotent-safe; evicts the entry at zero. */
export function releaseIpSlot(ip: string): void {
  const n = perIp.get(ip) ?? 0;
  if (n <= 1) perIp.delete(ip);
  else perIp.set(ip, n - 1);
}

/** Introspection for specs + health surfaces. */
export function activeUserSlots(userId: string): number {
  return perUser.get(userId) ?? 0;
}
export function activeIpSlots(ip: string): number {
  return perIp.get(ip) ?? 0;
}

/** Test hook — reset the budget between suites. */
export function resetRealtimeBudget(): void {
  active = 0;
  perUser.clear();
  perIp.clear();
}

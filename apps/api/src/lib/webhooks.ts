/**
 * Signed webhook dispatch for the MAZE facilitator.
 *
 * Events (payment.paid, …) are POSTed to seller-registered endpoints with an
 * HMAC-SHA256 signature over `${timestamp}.${payload}` so receivers can verify
 * authenticity + freshness. Stripe-style header: `MAZE-Signature: t=…,v1=…`.
 *
 * No new deps — node:crypto for signing, global fetch for delivery. Delivery is
 * best-effort: up to 3 attempts with backoff, all errors swallowed (a dead
 * webhook must never break the payment path).
 */

import { createHmac } from 'node:crypto';
import type { WebhookEndpoint } from '../store/types.js';
import { log } from './log.js';
import { safeFetch } from './safe-fetch.js';

export interface WebhookEvent {
  id: string;
  type: string;
  created: string;
  data: unknown;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Typed event catalogue. Existing callers still pass plain { type: 'payment.paid' }
 * objects (WebhookEvent.type is just `string`); these aliases let new callers
 * use the discriminated union when they want stricter checking, and document
 * the full set of events the facilitator fires.
 *
 * Stack upgrades Phase 0 — adds 'agent.blocked' (Upgrade 3). Phase 3 wires
 * the actual fire from routes/x402.ts after every PolicyError from x402Pay.
 * ────────────────────────────────────────────────────────────────────────── */

export type MazeWebhookPayload =
  | { type: 'payment.paid'; data: unknown }
  | { type: 'payout.completed'; data: unknown }
  | { type: 'subscription.canceled'; data: unknown }
  | { type: 'subscription.renewed'; data: unknown }
  | { type: 'transfer.completed'; data: unknown }
  | { type: 'transfer.failed'; data: unknown }
  | {
      type: 'agent.blocked';
      data: {
        agentId: string;
        agentName: string;
        endpoint: string;
        amountUsd: number;
        /** PolicyError.code — e.g. 'endpoint_not_allowed', 'per_day_cap'. */
        policyCode: string;
        /** Human-friendly explanation surfaced from PolicyError.message. */
        reason: string;
        /** ISO timestamp of the blocked attempt. */
        attemptedAt: string;
      };
    };

export type AgentBlockedWebhookPayload = Extract<MazeWebhookPayload, { type: 'agent.blocked' }>;

/** HMAC-SHA256 over `${timestamp}.${payload}`, hex-encoded. */
export function signWebhook(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

/** `t=<timestamp>,v1=<signature>` — the value of the MAZE-Signature header. */
export function signatureHeader(secret: string, timestamp: number, payload: string): string {
  return `t=${timestamp},v1=${signWebhook(secret, timestamp, payload)}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WEBHOOK_CONCURRENCY = 5;

/**
 * Deliver one event to one endpoint. Up to 3 attempts (backoff 200ms, 800ms)
 * on network error or non-2xx; each attempt has a ~4s timeout. Never throws —
 * returns {ok:false} on final failure.
 */
// F029 — module-private; fireWebhooks is the public surface that callers should use.
async function dispatchWebhook(
  endpoint: WebhookEndpoint,
  event: WebhookEvent,
): Promise<{ ok: boolean; status?: number }> {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signatureHeader(endpoint.secret, timestamp, payload);
  const backoff = [200, 800];

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await safeFetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MAZE-Signature': signature,
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        log.info({ endpoint: endpoint.id, type: event.type, status: res.status }, 'webhook: delivered');
        return { ok: true, status: res.status };
      }
      log.warn(
        { endpoint: endpoint.id, type: event.type, status: res.status, attempt: attempt + 1 },
        'webhook: non-2xx',
      );
      if (attempt < 2) await sleep(backoff[attempt]!);
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      // Sprint 11 Phase 0 — safeFetch refuses to dial internal addresses. The
      // error message carries the reason; surface it explicitly and stop
      // retrying since the URL itself is the problem.
      if (msg.startsWith('ssrf_blocked:')) {
        log.warn(
          { endpoint: endpoint.id, type: event.type, reason: msg.slice('ssrf_blocked:'.length) },
          'webhook: blocked by SSRF guard',
        );
        return { ok: false };
      }
      log.warn(
        { endpoint: endpoint.id, type: event.type, err: msg, attempt: attempt + 1 },
        'webhook: delivery error',
      );
      if (attempt < 2) await sleep(backoff[attempt]!);
    }
  }
  log.warn({ endpoint: endpoint.id, type: event.type }, 'webhook: gave up after 3 attempts');
  return { ok: false };
}

/** Fan out one event to all endpoints concurrently. Never throws. */
export async function fireWebhooks(endpoints: WebhookEndpoint[], event: WebhookEvent): Promise<void> {
  if (endpoints.length === 0) return;
  for (let i = 0; i < endpoints.length; i += WEBHOOK_CONCURRENCY) {
    const batch = endpoints.slice(i, i + WEBHOOK_CONCURRENCY);
    await Promise.allSettled(batch.map((ep) => dispatchWebhook(ep, event)));
  }
}

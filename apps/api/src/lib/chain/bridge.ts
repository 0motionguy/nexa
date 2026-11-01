/**
 * Bridge.xyz adapter — the compliance perimeter for real money in/out.
 *
 * Bridge issues a KYC'd customer record, then fiat virtual accounts (USD = ACH,
 * EUR = SEPA) that fund the user's balance on deposit via webhook. Everything is
 * env-gated behind BRIDGE_API_KEY (same pattern as the Aave/LIFI/x402 adapters):
 * unset → plausible demo numbers + a webhook that accepts without a signature.
 *
 * Every network call is wrapped so a Bridge outage degrades to demo behaviour
 * rather than throwing to the route — the demo flow must never 500.
 *
 * Auth: Bridge accepts the API key in both `Authorization: Bearer` and `Api-Key`;
 * we send both. Webhooks are HMAC-SHA256 over the raw body, compared timing-safe.
 *
 * Docs: https://apidocs.bridge.xyz
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { HttpError, httpRequest } from '../http.js';
import type { VirtualAccount } from '../../store/types.js';

/** A new virtual account minus the fields the store assigns (id, createdAt). */
type NewVirtualAccount = Omit<VirtualAccount, 'id' | 'createdAt'>;

export function isBridgeEnabled(): boolean {
  return features.bridge;
}

export class BridgeProvisioningError extends Error {
  constructor(
    public code:
      | 'bridge_customer_failed'
      | 'bridge_virtual_account_failed'
      | 'bridge_external_account_failed'
      | 'bridge_transfer_failed',
    message: string,
    public ambiguous = false,
  ) {
    super(message);
  }
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function digits(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10).toString();
  return out;
}

function bridgeHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${env.BRIDGE_API_KEY ?? ''}`,
    'Api-Key': env.BRIDGE_API_KEY ?? '',
  };
}

function apiBase(): string {
  return env.BRIDGE_API_BASE.replace(/\/+$/, '');
}

/* ── customers ──────────────────────────────────────────────────────────── */

function demoCustomer(): { customerId: string; kycUrl: string | null } {
  return { customerId: 'bridge_demo_' + hex(4), kycUrl: null };
}

/**
 * Create (or fetch) a Bridge customer. Live: POST /v0/customers and return the
 * customer id only; hosted KYC links are intentionally not surfaced by NEXA.
 * Disabled or on any error: a synthetic
 * `bridge_demo_<8 hex>` id so onboarding still completes in demo.
 */
export async function createCustomer(input: {
  email: string;
  name: string;
}): Promise<{ customerId: string; kycUrl: string | null }> {
  if (!isBridgeEnabled()) return demoCustomer();
  try {
    // Sprint 17 F072 — httpRequest wraps timeout + retry + structured error.
    // POST is not retried (idempotency on Bridge requires Idempotency-Key).
    const res = await httpRequest(`${apiBase()}/v0/customers`, {
      vendor: 'bridge',
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify({ email: input.email, full_name: input.name, type: 'individual' }),
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'bridge: createCustomer rejected');
      throw new BridgeProvisioningError('bridge_customer_failed', 'Bridge customer provisioning failed.');
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string; kyc_link?: string | null };
    if (!data.id) {
      throw new BridgeProvisioningError('bridge_customer_failed', 'Bridge customer response was missing an id.');
    }
    return { customerId: data.id, kycUrl: null };
  } catch (e) {
    if (e instanceof BridgeProvisioningError) throw e;
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'bridge: createCustomer unreachable');
    throw new BridgeProvisioningError('bridge_customer_failed', 'Bridge customer provisioning failed.');
  }
}

/* ── virtual accounts ───────────────────────────────────────────────────── */

function demoVirtualAccount(currency: 'USD' | 'EUR'): NewVirtualAccount {
  if (currency === 'USD') {
    return {
      currency: 'USD',
      routingNumber: '101019644',
      accountNumber: '8' + digits(9),
      iban: null,
      bic: null,
      bankName: 'Lead Bank',
      livemode: isBridgeEnabled(),
    };
  }
  return {
    currency: 'EUR',
    routingNumber: null,
    accountNumber: null,
    iban: 'GB29NWBK' + digits(14),
    bic: 'MONZGB2L',
    bankName: 'Monerium EMI',
    livemode: isBridgeEnabled(),
  };
}

/**
 * Provision a fiat virtual account for a customer. Live: call Bridge's
 * virtual-account endpoint and map the source-deposit-instructions block. Disabled
 * or on any error: plausible mock numbers (livemode reflects whether Bridge is on).
 */
export async function createVirtualAccount(
  customerId: string,
  currency: 'USD' | 'EUR',
): Promise<NewVirtualAccount> {
  if (!isBridgeEnabled()) return demoVirtualAccount(currency);
  try {
    const res = await httpRequest(`${apiBase()}/v0/customers/${customerId}/virtual_accounts`, {
      vendor: 'bridge',
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify({
        source: { currency: currency.toLowerCase() },
        destination: { currency: 'usdc', payment_rail: 'base' },
      }),
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'bridge: createVirtualAccount rejected');
      throw new BridgeProvisioningError(
        'bridge_virtual_account_failed',
        'Bridge virtual-account provisioning failed.',
      );
    }
    const data = (await res.json().catch(() => ({}))) as {
      source_deposit_instructions?: {
        bank_routing_number?: string | null;
        routing_number?: string | null;
        bank_account_number?: string | null;
        account_number?: string | null;
        iban?: string | null;
        bic?: string | null;
        bank_name?: string | null;
      };
    };
    const di = data.source_deposit_instructions;
    if (!di) {
      throw new BridgeProvisioningError(
        'bridge_virtual_account_failed',
        'Bridge virtual-account response was missing deposit instructions.',
      );
    }
    if (currency === 'USD') {
      return {
        currency: 'USD',
        routingNumber: di.bank_routing_number ?? di.routing_number ?? null,
        accountNumber: di.bank_account_number ?? di.account_number ?? null,
        iban: null,
        bic: null,
        bankName: di.bank_name ?? 'Lead Bank',
        livemode: true,
      };
    }
    return {
      currency: 'EUR',
      routingNumber: null,
      accountNumber: null,
      iban: di.iban ?? null,
      bic: di.bic ?? null,
      bankName: di.bank_name ?? 'Monerium EMI',
      livemode: true,
    };
  } catch (e) {
    if (e instanceof BridgeProvisioningError) throw e;
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'bridge: createVirtualAccount unreachable');
    throw new BridgeProvisioningError(
      'bridge_virtual_account_failed',
      'Bridge virtual-account provisioning failed.',
    );
  }
}

/* ── webhooks ────────────────────────────────────────────────────────────── */

/**
 * Verify a Bridge webhook signature. When BRIDGE_WEBHOOK_SECRET is set, compute
 * HMAC-SHA256 over the raw body and timing-safe compare to the header value
 * (tolerating a `sha256=` / `t=…,v1=…` style prefix). When no secret is set,
 * only dev/test demo mode accepts unsigned payloads so production public URLs
 * fail closed even when Bridge is disabled.
 *
 * Sprint 11 Phase 0 — freshness gate. When the header carries a `t=<unix>`
 * timestamp (Stripe-style), reject when the skew exceeds
 * `WEBHOOK_FRESHNESS_WINDOW_SECONDS` (default 300s) so a captured webhook
 * cannot be replayed days later. Headers without a `t=` field (some Bridge
 * variants ship just the hex digest) bypass the freshness check — the HMAC
 * itself is still required.
 */
export function verifyWebhook(signatureHeader: string | null, rawBody: string): boolean {
  const secret = env.BRIDGE_WEBHOOK_SECRET;
  if (!secret) return env.DEMO_MODE && env.NODE_ENV !== 'production' && !isBridgeEnabled();
  if (!signatureHeader) return false;
  try {
    // Freshness: parse optional `t=<unix>` and compare to wall clock. Reject
    // when skew exceeds the configured window; log a clock_skew warn at the
    // 60s threshold so ops sees mild drift before it turns into rejects.
    const tMatch = signatureHeader.match(/(?:^|[,;\s])t=(\d{1,11})\b/);
    if (tMatch) {
      const t = Number.parseInt(tMatch[1]!, 10);
      const nowSec = Math.floor(Date.now() / 1000);
      const skew = Math.abs(nowSec - t);
      const windowSec = env.WEBHOOK_FRESHNESS_WINDOW_SECONDS;
      if (skew > windowSec) {
        log.warn({ skewSec: skew, source: 'bridge', windowSec }, 'webhook freshness check failed');
        return false;
      }
      if (skew > 60) {
        log.warn({ skewSec: skew, source: 'bridge' }, 'webhook clock skew detected');
      }
    }

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    // Pull the last hex run out of the header (handles `sha256=…` and `t=…,v1=…`).
    const m = signatureHeader.match(/[a-f0-9]{64}/i);
    const provided = (m ? m[0] : signatureHeader).toLowerCase();
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'bridge: verifyWebhook error');
    return false;
  }
}

/**
 * Recognise a deposit / funds-received event and pull out the customer id, USD
 * amount, and a stable reference (for idempotency). Defensive about Bridge's
 * event shape — returns null for anything that isn't a credit we can apply.
 */
export function parseDepositEvent(
  body: unknown,
): { customerId: string; amountUsd: number; ref: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;

  const type = String(b.type ?? b.event_type ?? b.event ?? '').toLowerCase();
  const looksLikeDeposit =
    type.includes('funds') ||
    type.includes('deposit') ||
    type.includes('payment.received') ||
    type.includes('virtual_account.received');
  if (!looksLikeDeposit) return null;

  // Bridge nests the payload under `data` (sometimes `data.object`).
  const data = (b.data?.object ?? b.data ?? b) as Record<string, any>;

  const customerId =
    data.customer_id ?? data.customerId ?? data.customer ?? b.customer_id ?? b.customerId ?? null;
  if (!customerId || typeof customerId !== 'string') return null;

  const rawAmount = data.amount ?? data.amount_usd ?? data.value ?? data.subtotal_amount ?? null;
  const amountUsd = typeof rawAmount === 'string' ? Number(rawAmount) : Number(rawAmount);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;

  const ref = String(
    b.id ?? data.id ?? data.payment_id ?? data.transaction_id ?? `${customerId}:${amountUsd}`,
  );

  return { customerId, amountUsd, ref };
}

/* ── offramp: external accounts + transfers ─────────────────────────────── */

export type ExternalAccountType = 'ach' | 'sepa' | 'wire' | 'crypto';

function transferPaymentRail(type: ExternalAccountType): 'ach' | 'sepa' | 'wire' | 'base' {
  return type === 'crypto' ? 'base' : type;
}

function isAmbiguousTransferStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

/**
 * Register a payout destination (bank account / crypto address) on the user's
 * Bridge customer. Live: POST /v0/customers/{id}/external_accounts and return
 * the external_account_id. Demo: synthetic `external_demo_<8 hex>` so the
 * offramp UI works without a Bridge contract.
 */
export async function createExternalAccount(
  customerId: string,
  payload: { type: ExternalAccountType; label: string; details: Record<string, unknown> },
): Promise<{ externalAccountId: string; livemode: boolean }> {
  if (!isBridgeEnabled()) {
    return { externalAccountId: 'external_demo_' + hex(8), livemode: false };
  }
  try {
    const res = await httpRequest(`${apiBase()}/v0/customers/${customerId}/external_accounts`, {
      vendor: 'bridge',
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify({
        type: payload.type,
        label: payload.label,
        ...payload.details,
      }),
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'bridge: createExternalAccount rejected');
      throw new BridgeProvisioningError(
        'bridge_external_account_failed',
        'Bridge external-account provisioning failed.',
      );
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    if (!data.id) {
      throw new BridgeProvisioningError(
        'bridge_external_account_failed',
        'Bridge external-account response was missing an id.',
      );
    }
    return { externalAccountId: data.id, livemode: true };
  } catch (e) {
    if (e instanceof BridgeProvisioningError) throw e;
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'bridge: createExternalAccount unreachable',
    );
    throw new BridgeProvisioningError(
      'bridge_external_account_failed',
      'Bridge external-account provisioning failed.',
    );
  }
}

/**
 * Create an offramp transfer (USDC on Base → fiat on the registered external
 * account). Live: POST /v0/transfers with the source/destination rails Bridge
 * expects. Demo: synthetic `transfer_demo_<8 hex>`; the route schedules a
 * webhook-shaped completion so the round-trip closes for the UI.
 */
export async function createTransfer(input: {
  source: { customerId: string };
  destination: { externalAccountId: string; type: ExternalAccountType };
  amountUsd: number;
  idempotencyKey: string;
}): Promise<{ externalRef: string; livemode: boolean }> {
  if (!isBridgeEnabled()) {
    return { externalRef: 'transfer_demo_' + hex(8), livemode: false };
  }
  try {
    // Sprint 17 F072 — transfers carry an Idempotency-Key so retries are
    // safe; we still keep maxAttempts at the wrapper default of 1 for POST
    // and rely on Bridge to dedupe if a retry races a delivery.
    const res = await httpRequest(`${apiBase()}/v0/transfers`, {
      vendor: 'bridge',
      method: 'POST',
      headers: {
        ...bridgeHeaders(),
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        amount: input.amountUsd.toFixed(2),
        currency: 'usd',
        source: {
          payment_rail: 'usdc',
          customer_id: input.source.customerId,
        },
        destination: {
          payment_rail: transferPaymentRail(input.destination.type),
          external_account_id: input.destination.externalAccountId,
        },
      }),
      timeoutMs: 15_000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'bridge: createTransfer rejected');
      throw new BridgeProvisioningError(
        'bridge_transfer_failed',
        'Bridge transfer creation failed.',
        isAmbiguousTransferStatus(res.status),
      );
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    if (!data.id) {
      throw new BridgeProvisioningError(
        'bridge_transfer_failed',
        'Bridge transfer response was missing an id.',
        true,
      );
    }
    return { externalRef: data.id, livemode: true };
  } catch (e) {
    if (e instanceof BridgeProvisioningError) throw e;
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'bridge: createTransfer unreachable',
    );
    throw new BridgeProvisioningError(
      'bridge_transfer_failed',
      'Bridge transfer creation failed.',
      e instanceof HttpError,
    );
  }
}

/**
 * Recognise a transfer completion / failure event and extract the transfer ref,
 * the new status, the USD amount, and the destination external account id.
 * Mirrors parseDepositEvent's defensiveness — returns null for anything we can't
 * map onto our transfer state machine.
 */
export function parseTransferEvent(
  body: unknown,
):
  | {
      ref: string;
      status: 'completed' | 'failed';
      amountUsd: number;
      externalAccountId: string | null;
    }
  | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;

  const type = String(b.type ?? b.event_type ?? b.event ?? '').toLowerCase();
  let status: 'completed' | 'failed' | null = null;
  if (type.includes('transfer.completed') || type.includes('transfer.payment_processed')) {
    status = 'completed';
  } else if (type.includes('transfer.failed') || type.includes('transfer.returned')) {
    status = 'failed';
  }
  if (!status) return null;

  const data = (b.data?.object ?? b.data ?? b) as Record<string, any>;

  const rawAmount = data.amount_usd ?? data.amount ?? data.value ?? null;
  const amountUsd = typeof rawAmount === 'string' ? Number(rawAmount) : Number(rawAmount);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;

  const ref = String(data.id ?? data.transfer_id ?? data.transferId ?? b.transfer_id ?? b.transferId ?? b.id ?? '');
  if (!ref) return null;

  const dest = data.destination ?? null;
  const externalAccountId =
    (typeof dest === 'object' && dest !== null
      ? (dest.external_account_id ?? dest.externalAccountId)
      : null) ?? null;

  return { ref, status, amountUsd, externalAccountId };
}

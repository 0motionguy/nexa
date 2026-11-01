/**
 * Bridge.xyz routes + adapter — demo-mode coverage.
 *
 * BRIDGE_API_KEY is unset under vitest, so the adapter returns mock customer ids
 * + virtual accounts and the webhook accepts without a signature. Boots the real
 * Hono app on an ephemeral port (same harness as api.spec.ts) because the public
 * webhook reads the raw request body.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { parseDepositEvent } from '../lib/chain/bridge.js';
import * as bridgeAdapter from '../lib/chain/bridge.js';
import { env } from '../lib/env.js';
import { store } from '../store/index.js';
import type { PayoutMethod } from '../store/types.js';

let server: ServerType;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

let token = '';
const EMAIL = 'bridge-tester@example.com';

async function login(): Promise<void> {
  const start = await json('/auth/start', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  token = verify.body.token;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(login);

describe('bridge routes (demo mode)', () => {
  let customerId = '';

  it('POST /bridge/customer returns a demo customer id', async () => {
    const { status, body } = await json('/bridge/customer', { method: 'POST', headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.customerId).toMatch(/^bridge_demo_[0-9a-f]{8}$/);
    expect(body.kycUrl).toBeNull();
    customerId = body.customerId;
  });

  it('POST /bridge/customer reuses the existing Bridge customer id', async () => {
    const { status, body } = await json('/bridge/customer', { method: 'POST', headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.customerId).toBe(customerId);
  });

  it('POST /bridge/virtual-account {USD} returns an ACH account with a routing number', async () => {
    const { status, body } = await json('/bridge/virtual-account', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ currency: 'USD' }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.account.currency).toBe('USD');
    expect(body.account.routingNumber).toBeTruthy();
    expect(body.account.accountNumber).toMatch(/^8\d{9}$/);
    expect(body.account.livemode).toBe(false); // BRIDGE_API_KEY unset in tests
    expect(body.account.id).toBeTruthy();
  });

  it('POST /bridge/virtual-account {EUR} returns a SEPA account with an IBAN', async () => {
    const { body } = await json('/bridge/virtual-account', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ currency: 'EUR' }),
    });
    expect(body.account.currency).toBe('EUR');
    expect(body.account.iban).toMatch(/^GB29NWBK\d{14}$/);
    expect(body.account.bic).toBe('MONZGB2L');
  });

  it('rejects an unknown currency', async () => {
    const { status } = await json('/bridge/virtual-account', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ currency: 'GBP' }),
    });
    expect(status).toBe(400);
  });

  it('GET /bridge/accounts lists the provisioned accounts', async () => {
    const { status, body } = await json('/bridge/accounts', { headers: authed() });
    expect(status).toBe(200);
    expect(Array.isArray(body.accounts)).toBe(true);
    const currencies = body.accounts.map((a: { currency: string }) => a.currency);
    expect(currencies).toContain('USD');
    expect(currencies).toContain('EUR');
  });

  it('requires a session for the authed routes', async () => {
    const { status } = await json('/bridge/accounts');
    expect(status).toBe(401);
  });

  it('webhook deposit credits the matching user balance', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const startBal = before.body.balance.balUsd as number;

    const hook = await json('/bridge/webhook', {
      method: 'POST',
      body: JSON.stringify({
        type: 'funds.received',
        id: 'evt_test_deposit_1',
        data: { customer_id: customerId, amount: 250 },
      }),
    });
    expect(hook.status).toBe(200);
    expect(hook.body.ok).toBe(true);

    const after = await json('/auth/me', { headers: authed() });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal + 250);
  });

  it('webhook is idempotent on the event ref (no double credit)', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const startBal = before.body.balance.balUsd as number;

    // Replay the exact same event id — must not credit again.
    await json('/bridge/webhook', {
      method: 'POST',
      body: JSON.stringify({
        type: 'funds.received',
        id: 'evt_test_deposit_1',
        data: { customer_id: customerId, amount: 250 },
      }),
    });

    const after = await json('/auth/me', { headers: authed() });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal);
  });

  it('webhook acks unrelated events without crediting', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const startBal = before.body.balance.balUsd as number;

    const hook = await json('/bridge/webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'customer.updated', data: { customer_id: customerId } }),
    });
    expect(hook.status).toBe(200);
    expect(hook.body.ok).toBe(true);

    const after = await json('/auth/me', { headers: authed() });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal);
  });

  it('/ledger/me exposes kycStatus and the real virtual-account list', async () => {
    const { body } = await json('/ledger/me', { headers: authed() });
    expect(body.kycStatus).toBe('verified');
    expect(Array.isArray(body.virtualAccountsList)).toBe(true);
    expect(body.virtualAccountsList.length).toBeGreaterThanOrEqual(2);
    const usd = body.virtualAccountsList.find((a: { currency: string }) => a.currency === 'USD');
    const eur = body.virtualAccountsList.find((a: { currency: string }) => a.currency === 'EUR');
    expect(usd.accountNumber).toMatch(/^\*\*\*\*\d{4}$/);
    expect(usd.routingNumber).toMatch(/^\*\*\*\*\d{4}$/);
    expect(eur.iban).toMatch(/^\*\*\*\*\w{4}$/);
  });
});

describe('parseDepositEvent', () => {
  it('returns the credit for a funds-received event', () => {
    const ev = parseDepositEvent({
      type: 'funds.received',
      id: 'evt_1',
      data: { customer_id: 'cus_123', amount: 100 },
    });
    expect(ev).toEqual({ customerId: 'cus_123', amountUsd: 100, ref: 'evt_1' });
  });

  it('returns null on an unrelated event', () => {
    expect(
      parseDepositEvent({ type: 'customer.updated', data: { customer_id: 'cus_123' } }),
    ).toBeNull();
  });

  it('returns null on a malformed body', () => {
    expect(parseDepositEvent(null)).toBeNull();
    expect(parseDepositEvent({ type: 'funds.received', data: {} })).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Sprint 10 Item B — Bridge offramp coverage. Same demo-mode harness; each
 * test uses a fresh login + isolated email so the in-memory store state
 * doesn't leak between cases.
 * ────────────────────────────────────────────────────────────────────────── */

import { parseTransferEvent } from '../lib/chain/bridge.js';

async function freshSession(email: string): Promise<string> {
  const start = await json('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  return verify.body.token;
}

function authedFor(tok: string): Record<string, string> {
  return { authorization: `Bearer ${tok}` };
}

const ACH_ACCOUNT_DETAILS = { routing: '101019644', account: '8841294078' };

describe('bridge offramp routes (demo mode)', () => {
  it('POST /bridge/payout-method returns a demo external_account id', async () => {
    const tok = await freshSession('offramp-create@example.com');
    const r = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({
        type: 'ach',
        label: 'Lead Bank · checking',
        accountDetails: ACH_ACCOUNT_DETAILS,
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.method.externalAccountId).toMatch(/^external_demo_[0-9a-f]{16}$/);
    expect(r.body.method.type).toBe('ach');
    expect(r.body.method.livemode).toBe(false);
  });

  it('POST /bridge/payout-method requires bank account details for bank rails', async () => {
    const tok = await freshSession('offramp-create-missing-bank-details@example.com');
    const r = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary' }),
    });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe('bad_request');
    expect(r.body.error.message).toBe('bank_account_details_required');
    expect(r.body.error.details.missing).toEqual(['account', 'routing']);
  });

  it('GET /bridge/payout-methods returns the registered method', async () => {
    const tok = await freshSession('offramp-list@example.com');
    await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const r = await json('/bridge/payout-methods', { headers: authedFor(tok) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.methods).toHaveLength(1);
    expect(r.body.methods[0].label).toBe('Primary');
  });

  it('POST /bridge/withdraw with insufficient funds returns 400', async () => {
    const tok = await freshSession('offramp-broke@example.com');
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const r = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-insufficient-funds-2' },
      // Seeded balance is $4,820.40; this overshoots while staying under the
      // schema's max (99999).
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 50000 }),
    });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe('bad_request');
    expect(r.body.error.message).toBe('Not enough balance.');
    expect(r.body.error.details.policyCode).toBe('insufficient_funds');
  });

  it('POST /bridge/withdraw with a missing payout method returns not_found ApiError shape', async () => {
    const tok = await freshSession('offramp-missing-method@example.com');
    const missingPayoutMethodId = '00000000-0000-4000-8000-000000000404';
    const r = await json('/bridge/withdraw', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ payoutMethodId: missingPayoutMethodId, amountUsd: 10 }),
    });

    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe('not_found');
    expect(r.body.error.message).toBe('payout_method_not_found');
  });

  it('POST /bridge/withdraw without a Bridge customer returns bad_request ApiError shape', async () => {
    const tok = await freshSession('offramp-customer-missing@example.com');
    const payoutMethodId = '00000000-0000-4000-8000-000000000400';
    const originalListPayoutMethods = store.listPayoutMethods;
    store.listPayoutMethods = async (u) => [
      {
        id: payoutMethodId,
        userId: u.id,
        type: 'ach',
        externalAccountId: 'external_demo_without_customer',
        label: 'Primary',
        status: 'active',
        livemode: false,
        createdAt: new Date().toISOString(),
      } satisfies PayoutMethod,
    ];

    try {
      const r = await json('/bridge/withdraw', {
        method: 'POST',
        headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-customer-missing-1' },
        body: JSON.stringify({ payoutMethodId, amountUsd: 10 }),
      });

      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
      expect(r.body.error.code).toBe('bad_request');
      expect(r.body.error.message).toBe('bridge_customer_missing');
    } finally {
      store.listPayoutMethods = originalListPayoutMethods;
    }
  });

  it('POST /bridge/withdraw rejects fractional-cent amounts before debiting', async () => {
    const tok = await freshSession('offramp-fractional-cent@example.com');
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const r = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-roundtrip-1' },
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 10.999 }),
    });

    expect(r.status).toBe(400);
    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal);
  });

  it('POST /bridge/withdraw requires an explicit idempotency key before debiting', async () => {
    const tok = await freshSession('offramp-missing-idempotency@example.com');
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });

    const r = await json('/bridge/withdraw', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 50 }),
    });

    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('idempotency_key_required');
    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal);
  });

  it('POST /bridge/withdraw rejects disabled payout methods before debiting', async () => {
    const tok = await freshSession('offramp-disabled-method@example.com');
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const originalListPayoutMethods = store.listPayoutMethods;
    store.listPayoutMethods = async (u) => {
      const methods = await originalListPayoutMethods.call(store, u);
      return methods.map((method) =>
        method.id === m.body.method.id ? { ...method, status: 'disabled' as const } : method,
      );
    };

    try {
      const r = await json('/bridge/withdraw', {
        method: 'POST',
        headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-disabled-method-1' },
        body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 50 }),
      });

      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe('payout_method_disabled');
      const after = await json('/auth/me', { headers: authedFor(tok) });
      expect(after.body.balance.balUsd).toBeCloseTo(startBal);
    } finally {
      store.listPayoutMethods = originalListPayoutMethods;
    }
  });

  it('POST /bridge/withdraw with kill-switch returns 423', async () => {
    const tok = await freshSession('offramp-frozen@example.com');
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    await json('/agent/kill-switch', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ on: true }),
    });
    const r = await json('/bridge/withdraw', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 50 }),
    });
    expect(r.status).toBe(423);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toEqual({
      code: 'account_frozen',
      message: 'account_frozen',
    });
    // Undo so other tests don't blow up if state shares.
    await json('/agent/kill-switch', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ on: false }),
    });
  });

  it('POST /bridge/withdraw debits the balance and completes the demo round-trip', async () => {
    const tok = await freshSession('offramp-roundtrip@example.com');
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;

    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const w = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-roundtrip-2' },
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 50 }),
    });
    expect(w.status).toBe(200);
    expect(w.body.transfer.status).toBe('pending');
    expect(w.body.transfer.externalRef).toMatch(/^transfer_demo_[0-9a-f]{16}$/);

    // Demo round-trip is scheduled via setImmediate — flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal - 50);
  });

  it('POST /bridge/withdraw replays an Idempotency-Key without a second debit', async () => {
    const tok = await freshSession('offramp-withdraw-idem@example.com');
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const headers = { ...authedFor(tok), 'Idempotency-Key': 'withdraw-idem-route-1' };
    const body = {
      payoutMethodId: m.body.method.id,
      amountUsd: 40,
      idempotencyKey: 'withdraw-idem-route-1',
    };

    const first = await json('/bridge/withdraw', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const second = await json('/bridge/withdraw', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transfer.id).toBe(first.body.transfer.id);
    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal - 40);
  });

  it('POST /bridge/withdraw rejects Idempotency-Key replay with different payload', async () => {
    const tok = await freshSession('offramp-withdraw-idem-conflict@example.com');
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const first = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-idem-conflict-1' },
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 40 }),
    });
    expect(first.status).toBe(200);

    const replay = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-idem-conflict-1' },
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 41 }),
    });
    expect(replay.status).toBe(409);
    expect(replay.body.ok).toBe(false);
    expect(replay.body.error.message).toBe('idempotency_key_reused');
  });

  it('does not refund the local debit after Bridge creates a transfer but ref persistence fails', async () => {
    const tok = await freshSession('offramp-persist-fails@example.com');
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const originalSetRef = store.setBridgeTransferExternalRef;
    store.setBridgeTransferExternalRef = async () => {
      throw new Error('db_down_after_bridge');
    };

    try {
      const w = await json('/bridge/withdraw', {
        method: 'POST',
        headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-persist-fails-1' },
        body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 35 }),
      });
      expect(w.status).toBe(502);
      expect(w.body.ok).toBe(false);
      expect(w.body.error).toEqual({
        code: 'bridge_transfer_persist_failed',
        message: 'bridge_transfer_persist_failed',
      });
    } finally {
      store.setBridgeTransferExternalRef = originalSetRef;
    }

    const replay = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-persist-fails-1' },
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 35 }),
    });
    expect(replay.status).toBe(503);
    expect(replay.body.ok).toBe(false);
    expect(replay.body.error).toEqual({
      code: 'bridge_transfer_reconciliation_required',
      message: 'bridge_transfer_reconciliation_required',
    });
    expect(replay.body.transfer.status).toBe('pending');
    expect(replay.body.transfer.externalRef).toBeNull();

    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal - 35);
  });

  it('keeps ambiguous Bridge transfer submissions pending instead of refunding', async () => {
    const tok = await freshSession('offramp-ambiguous-submit@example.com');
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const createTransfer = vi
      .spyOn(bridgeAdapter, 'createTransfer')
      .mockRejectedValueOnce(
        new bridgeAdapter.BridgeProvisioningError('bridge_transfer_failed', 'Bridge timed out', true),
      );

    try {
      const first = await json('/bridge/withdraw', {
        method: 'POST',
        headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-ambiguous-submit-1' },
        body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 35 }),
      });
      expect(first.status).toBe(503);
      expect(first.body.error).toEqual({
        code: 'bridge_transfer_reconciliation_required',
        message: 'bridge_transfer_reconciliation_required',
      });
      expect(first.body.transfer.status).toBe('pending');
      expect(first.body.transfer.externalRef).toBeNull();

      const replay = await json('/bridge/withdraw', {
        method: 'POST',
        headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-ambiguous-submit-1' },
        body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 35 }),
      });
      expect(replay.status).toBe(503);
      expect(replay.body.transfer.id).toBe(first.body.transfer.id);
      expect(createTransfer).toHaveBeenCalledTimes(1);
    } finally {
      createTransfer.mockRestore();
    }

    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal - 35);
  });

  it('POST /bridge/transfer-webhook is idempotent on the transfer ref', async () => {
    const tok = await freshSession('offramp-idempotent@example.com');
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const w = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': 'withdraw-failed-first-1' },
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 25 }),
    });
    const ref = w.body.transfer.externalRef as string;
    // Demo round-trip should have flipped it to completed already.
    await new Promise((r) => setImmediate(r));

    const before = await json('/auth/me', { headers: authedFor(tok) });
    const bal = before.body.balance.balUsd as number;

    // Replay the same transfer.completed event — must not credit/debit anything.
    const reply = await json('/bridge/transfer-webhook', {
      method: 'POST',
      body: JSON.stringify({
        type: 'transfer.completed',
        data: { id: ref, amount_usd: 25 },
      }),
    });
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(true);

    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(bal);
  });

  it('POST /bridge/transfer-webhook ignores amount or destination mismatches', async () => {
    const email = 'offramp-webhook-mismatch@example.com';
    const tok = await freshSession(email);
    const u = await store.upsertUserByEmail(email);
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const ref = 'transfer_mismatch_guard';
    await store.createBridgeTransfer(u, {
      payoutMethodId: m.body.method.id,
      amountUsd: 25,
      externalRef: ref,
    });

    const reply = await json('/bridge/transfer-webhook', {
      method: 'POST',
      body: JSON.stringify({
        type: 'transfer.completed',
        data: {
          id: ref,
          amount_usd: 250,
          destination: { external_account_id: 'external_wrong_destination' },
        },
      }),
    });
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(true);

    const freshTransition = await store.markTransferStatus(ref, 'completed');
    expect(freshTransition?.status).toBe('completed');
  });

  it('POST /bridge/webhook with an invalid signature returns bad_request ApiError shape', async () => {
    const originalSecret = env.BRIDGE_WEBHOOK_SECRET;
    env.BRIDGE_WEBHOOK_SECRET = 'bridge_webhook_test_secret';

    try {
      const r = await json('/bridge/webhook', {
        method: 'POST',
        headers: { 'X-Bridge-Signature': 'not-a-valid-signature' },
        body: JSON.stringify({ type: 'funds.received' }),
      });

      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
      expect(r.body.error.code).toBe('bad_request');
      expect(r.body.error.message).toBe('invalid_signature');
    } finally {
      env.BRIDGE_WEBHOOK_SECRET = originalSecret;
    }
  });

  it('POST /bridge/transfer-webhook with an invalid signature returns bad_request ApiError shape', async () => {
    const originalSecret = env.BRIDGE_WEBHOOK_SECRET;
    env.BRIDGE_WEBHOOK_SECRET = 'bridge_transfer_webhook_test_secret';

    try {
      const r = await json('/bridge/transfer-webhook', {
        method: 'POST',
        headers: { 'X-Bridge-Signature': 'not-a-valid-signature' },
        body: JSON.stringify({ type: 'transfer.completed' }),
      });

      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
      expect(r.body.error.code).toBe('bad_request');
      expect(r.body.error.message).toBe('invalid_signature');
    } finally {
      env.BRIDGE_WEBHOOK_SECRET = originalSecret;
    }
  });

  it('a failed transfer credits the balance back', async () => {
    const email = 'offramp-failed@example.com';
    const tok = await freshSession(email);
    const before = await json('/auth/me', { headers: authedFor(tok) });
    const startBal = before.body.balance.balUsd as number;

    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const u = await store.upsertUserByEmail(email);
    const reserved = await store.createBridgeTransferDebit(u, {
      payoutMethodId: m.body.method.id,
      amountUsd: 25,
      idempotencyKey: 'withdraw-failed-store-reserved-1',
      label: 'Primary',
    });
    const ref = 'transfer_failed_route_guard';
    await store.setBridgeTransferExternalRef(reserved.transfer.id, ref);

    const reply = await json('/bridge/transfer-webhook', {
      method: 'POST',
      body: JSON.stringify({
        type: 'transfer.failed',
        data: { id: ref, amount_usd: 25 },
      }),
    });
    expect(reply.status).toBe(200);

    const after = await json('/auth/me', { headers: authedFor(tok) });
    expect(after.body.balance.balUsd).toBeCloseTo(startBal);
  });

  it('POST /bridge/withdraw rejects idempotency replay of a failed transfer', async () => {
    const email = 'offramp-failed-replay@example.com';
    const tok = await freshSession(email);
    const m = await json('/bridge/payout-method', {
      method: 'POST',
      headers: authedFor(tok),
      body: JSON.stringify({ type: 'ach', label: 'Primary', accountDetails: ACH_ACCOUNT_DETAILS }),
    });
    const u = await store.upsertUserByEmail(email);
    const key = 'withdraw-failed-replay-1';
    const reserved = await store.createBridgeTransferDebit(u, {
      payoutMethodId: m.body.method.id,
      amountUsd: 25,
      idempotencyKey: key,
      label: 'Primary',
    });
    await store.failBridgeTransferById(reserved.transfer.id);

    const replay = await json('/bridge/withdraw', {
      method: 'POST',
      headers: { ...authedFor(tok), 'Idempotency-Key': key },
      body: JSON.stringify({ payoutMethodId: m.body.method.id, amountUsd: 25 }),
    });

    expect(replay.status).toBe(409);
    expect(replay.body.error.message).toBe('idempotency_key_used');
  });
});

describe('parseTransferEvent', () => {
  it('returns completed/failed/null for the expected event shapes', () => {
    expect(
      parseTransferEvent({
        type: 'transfer.completed',
        data: { id: 'transfer_abc', amount_usd: 50 },
      }),
    ).toEqual({
      ref: 'transfer_abc',
      status: 'completed',
      amountUsd: 50,
      externalAccountId: null,
    });
    expect(
      parseTransferEvent({
        type: 'transfer.failed',
        data: { id: 'transfer_xyz', amount_usd: '12.5', destination: { external_account_id: 'ea_1' } },
      }),
    ).toEqual({
      ref: 'transfer_xyz',
      status: 'failed',
      amountUsd: 12.5,
      externalAccountId: 'ea_1',
    });
    expect(parseTransferEvent({ type: 'customer.updated', data: {} })).toBeNull();
    expect(parseTransferEvent(null)).toBeNull();
  });

  it('prefers the nested transfer id over the envelope event id', () => {
    expect(
      parseTransferEvent({
        id: 'evt_123',
        type: 'transfer.failed',
        data: { transfer_id: 'transfer_real_123', amount_usd: 50 },
      }),
    ).toMatchObject({ ref: 'transfer_real_123', status: 'failed' });
  });
});

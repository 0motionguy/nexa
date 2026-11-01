/**
 * Money-path wire-contract lockstep tests (2026-07-02).
 *
 * Root cause being prevented: NEO shipped cancels with `{ orderId }` while the
 * route read `externalRef` — a silent production failure. These tests pin the
 * markets money routes to the shared request schemas in `@nexa/shared-zod`, so
 * any field rename on either side fails HERE, not in a user's hands.
 *
 * `routes/transfers.ts` needs no equivalent pinning: since this pass it
 * validates with the shared schemas directly at runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import {
  HyperliquidCancelInput,
  InternalTransferInput,
  UsdClassTransferInput,
} from '@nexa/shared-zod';
import { app } from '../index.js';

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

async function authHeaders(email: string): Promise<Record<string, string>> {
  const start = await fetch(base + '/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const { challengeId } = (await start.json()) as { challengeId: string };
  const verify = await fetch(base + '/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: '482019' }),
  });
  const { token } = (await verify.json()) as { token: string };
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'CF-IPCountry': 'NL',
  };
}

async function post(
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('money-path wire contracts (shared-zod lockstep)', () => {
  it('cancel routes reject the legacy { orderId } drift payload with invalid_ref', async () => {
    const headers = await authHeaders('contract-cancel-drift@example.com');
    for (const path of [
      '/markets/hyperliquid/cancel',
      '/markets/hyperliquid-spot/cancel',
      '/markets/stocks/cancel',
    ]) {
      const { status, body } = await post(path, headers, { orderId: 'oid_123', coin: 'BTC' });
      expect(status, path).toBe(400);
      expect(body.error?.message ?? body.error, path).toBe('invalid_ref');
    }
  });

  it('cancel routes accept a HyperliquidCancelInput-shaped body (field-name contract)', async () => {
    const headers = await authHeaders('contract-cancel-shape@example.com');
    const payload = HyperliquidCancelInput.parse({ externalRef: 'hl_demo_missing', coin: 'BTC' });
    const { status, body } = await post('/markets/hyperliquid/cancel', headers, payload);
    // No such position for a fresh user — but the body must get PAST field
    // validation: not_found proves `externalRef` was read, invalid_ref would
    // mean the contract broke.
    expect(status).toBe(404);
    expect(body.error?.message ?? body.error).toBe('not_found');
  });

  it('usd-class-transfer accepts a UsdClassTransferInput-shaped body in demo mode', async () => {
    const headers = await authHeaders('contract-class-transfer@example.com');
    const payload = UsdClassTransferInput.parse({ amountUsd: 25, toPerp: true });
    const { status, body } = await post('/markets/hyperliquid/usd-class-transfer', headers, payload);
    expect(status).toBe(200);
    expect(body.ok ?? Boolean(body.callId)).toBeTruthy();
  });

  it('usd-class-transfer rejects a drifted amount field with invalid_amount', async () => {
    const headers = await authHeaders('contract-class-drift@example.com');
    const { status, body } = await post('/markets/hyperliquid/usd-class-transfer', headers, {
      amount: 25, // drifted field name — must not be silently accepted as 0
      toPerp: true,
    });
    expect(status).toBe(400);
    expect(body.error?.message ?? body.error).toBe('invalid_amount');
  });

  it('swap conserves money across the EUR ledger (usd→eur credits, eur→usd debits, no minting)', async () => {
    const headers = await authHeaders('contract-eur-ledger@example.com');
    const me = async () =>
      (await fetch(base + '/auth/me', { headers }).then((r) => r.json())) as {
        balance: { balUsd: number; eurUsd: number };
      };
    const me0 = await me();
    expect(me0.balance.eurUsd).toBe(0);

    // usd→eur: USD debited, EUR credited at the mid rate — visible money.
    const s1 = await post('/swap/execute', headers, { amount: 100, direction: 'usd-eur' });
    expect(s1.status).toBe(200);
    const me1 = await me();
    expect(me1.balance.eurUsd).toBeCloseTo(92, 5);
    expect(me1.balance.balUsd).toBeCloseTo(me0.balance.balUsd - 100, 5);

    // eur→usd round-trip: EUR debited back to zero, USD restored — conservation.
    const s2 = await post('/swap/execute', headers, { amount: 92, direction: 'eur-usd' });
    expect(s2.status).toBe(200);
    const me2 = await me();
    expect(me2.balance.eurUsd).toBeCloseTo(0, 5);
    expect(me2.balance.balUsd).toBeCloseTo(me0.balance.balUsd, 5);

    // …and never minting: swapping EUR you don't hold is rejected (this was
    // an unbacked USD credit before 2026-07-02).
    const s3 = await post('/swap/execute', headers, { amount: 50, direction: 'eur-usd' });
    expect(s3.status).toBe(400);
  });

  it('POST /transfers/internal validates with the shared InternalTransferInput schema', async () => {
    const headers = await authHeaders('contract-internal-transfer@example.com');
    // Shared schema builds the payload; the route zValidates with the SAME
    // schema object, so acceptance here is lockstep by construction.
    const payload = InternalTransferInput.parse({
      fromBucket: 'cash',
      toBucket: 'perps',
      amountUsd: 10,
      idempotencyKey: 'contract-internal-0001',
    });
    const accepted = await post('/transfers/internal', headers, payload);
    // Flagless test env: the cash→perps CCTP rail fails closed with 503
    // (no executor). The contract under test is that the schema-built body
    // passes VALIDATION — any status but 400 proves that.
    expect(accepted.status).not.toBe(400);

    // And a payload the shared schema rejects must be rejected by the route.
    const bad = await post('/transfers/internal', headers, {
      fromBucket: 'cash',
      toBucket: 'external', // not a client-transferable bucket
      amountUsd: 10,
    });
    expect(bad.status).toBe(400);
    expect(InternalTransferInput.safeParse({ fromBucket: 'cash', toBucket: 'external', amountUsd: 10 }).success).toBe(false);
  });
});

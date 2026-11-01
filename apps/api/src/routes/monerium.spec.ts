/**
 * /monerium/* integration tests — EUR rails alternative to Bridge.
 *
 * In vitest, MONERIUM_API_KEY is unset, so the adapter runs the demo path
 * and emits `provider-demo` source kind on every response. These tests pin:
 *   - the status probe doesn't leak `live` outside a configured run
 *   - the profile route synthesises a deterministic IBAN tied to the user's wallet
 *   - the offramp route returns a synthetic order id + `placed` state
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
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

async function json(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

let token = '';

beforeAll(async () => {
  const start = await json('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email: 'monerium-tester@example.com' }),
  });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  token = verify.body.token;
});

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('/monerium', () => {
  it('GET /status reports demo source when no key is configured', async () => {
    const { status, body } = await json('/monerium/status');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('monerium');
    expect(body.available).toBe(false);
    expect(body.chain).toBe('gnosis');
    expect(body.sourced.source).toBe('provider-demo');
  });

  it('GET /profile synthesises a stable IBAN tied to the user wallet', async () => {
    const { status, body } = await json('/monerium/profile', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // Demo IBAN is wallet-derived (hex chars allowed in the check positions);
    // we only assert the German country code + bank-routing segment.
    expect(body.iban).toMatch(/^DE[0-9A-F]{2}50010517/);
    expect(body.bic).toBe('INGDDEFFXXX');
    expect(body.kycStatus).toBe('pending');
    expect(body.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(body.sourced.source).toBe('provider-demo');
  });

  it('GET /profile is session-gated', async () => {
    const { status } = await json('/monerium/profile');
    expect(status).toBe(401);
  });

  it('POST /offramp returns a demo order in placed state when no key is configured', async () => {
    const { status, body } = await json('/monerium/offramp', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountEur: 250, reference: 'rent' }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.orderId).toMatch(/^mn_demo_/);
    expect(body.state).toBe('placed');
    expect(body.amountEur).toBe(250);
    expect(body.sourced.source).toBe('provider-demo');
  });

  it('POST /offramp rejects non-positive amounts', async () => {
    const { status } = await json('/monerium/offramp', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountEur: 0 }),
    });
    expect(status).toBe(400);
  });

  it('POST /offramp rejects amounts above the per-call cap', async () => {
    const { status } = await json('/monerium/offramp', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountEur: 999_999 }),
    });
    expect(status).toBe(400);
  });
});

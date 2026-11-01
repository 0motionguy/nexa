/**
 * Card-layer route suite (Sprint 8) — virtual card details, order, cross-chain
 * top-up, and per-agent card. Boots the real Hono app on an ephemeral port and
 * authenticates a fresh session (unique email) so state stays isolated from
 * api.spec.ts.
 *
 * The on-chain side (Gnosis card / LIFI cross-chain top-up / Sponge agent card)
 * is supplied by adapters built in parallel against a fixed interface. If those
 * methods are not yet present at run time the route handlers will 500 and these
 * assertions will flag exactly which surface is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from './../index.js';

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
const EMAIL = `card-tester-${Date.now()}@example.com`;

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const start = await json('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL }),
  });
  expect(start.status).toBe(200);
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  expect(verify.status).toBe(200);
  token = verify.body.token;
  expect(token).toBeTruthy();
});

describe('card layer', () => {
  it('GET /card returns card details', async () => {
    const { status, body } = await json('/card', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.last4).toBe('string');
    expect(body.last4).toHaveLength(4);
    expect(typeof body.network).toBe('string');
    expect(typeof body.frozen).toBe('boolean');
  });

  it('POST /card/order returns a freshly ordered card', async () => {
    const { status, body } = await json('/card/order', {
      method: 'POST',
      headers: authed(),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.last4).toBe('string');
    expect(body.last4).toHaveLength(4);
    expect(typeof body.network).toBe('string');
  });

  it('POST /card/topup logs a cross-chain top-up WITHOUT crediting the balance', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const balBefore = before.body.balance.balUsd as number;

    const { status, body } = await json('/card/topup', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 50 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.txHash).toBeTruthy();

    const after = await json('/auth/me', { headers: authed() });
    expect(after.body.balance.balUsd).toBe(balBefore);
  });

  it('POST /agent/:id/card issues a card for an owned agent', async () => {
    const created = await json('/agent/create', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ name: `CardAgent-${Date.now()}`, perDayCapUsd: 5, perTxCapUsd: 0.5 }),
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;
    expect(agentId).toBeTruthy();

    const { status, body } = await json(`/agent/${agentId}/card`, {
      method: 'POST',
      headers: authed(),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe(agentId);
    expect(typeof body.last4).toBe('string');
    expect(body.last4).toHaveLength(4);
    expect(typeof body.network).toBe('string');
  });

  it('POST /agent/:id/card 404s for an unknown agent', async () => {
    const { status, body } = await json('/agent/does-not-exist/card', {
      method: 'POST',
      headers: authed(),
    });
    expect(status).toBe(404);
    // Sprint 17 F062 — ApiError envelope wraps the code in error.message.
    expect(body.error.message).toBe('agent_not_found');
  });
});

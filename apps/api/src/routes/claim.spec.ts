/**
 * Sprint 6 — claim escrow + KYC smoke.
 *
 * Boots the real Hono app on an ephemeral port (same harness as api.spec.ts) and
 * mints its OWN fresh OTP session under a UNIQUE sender email so the send debit
 * here can't collide with api.spec.ts's shared-session balance assertions.
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

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

let token = '';
const SENDER = 'claimer@s6.test';

async function mintSession(email: string): Promise<string> {
  const start = await json('/auth/start', { method: 'POST', body: JSON.stringify({ email }) });
  expect(start.status).toBe(200);
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  expect(verify.status).toBe(200);
  expect(verify.body.token).toBeTruthy();
  return verify.body.token as string;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  token = await mintSession(SENDER);
});

describe('email-claim escrow', () => {
  let slug = '';

  it('send to an email flags claim and returns a claimSlug', async () => {
    const { status, body } = await json('/payments/send', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 20, to: 'bob6@x.com' }),
    });
    expect(status).toBe(200);
    expect(body.claim).toBe(true);
    expect(body.claimSlug).toBeTruthy();
    slug = body.claimSlug;
  });

  it('GET /claim/:slug returns the parked escrow', async () => {
    const { status, body } = await json(`/claim/${slug}`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.claim.senderName).toBeTruthy();
    expect(body.claim.amountUsd).toBe(20);
    expect(body.claim.status).toBe('pending');
  });

  it('POST /claim/:slug credits the recipient once', async () => {
    const { status, body } = await json(`/claim/${slug}`, {
      method: 'POST',
      body: JSON.stringify({ email: 'bob6@x.com' }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.amountUsd).toBe(20);
  });

  it('a second claim on the same slug is gone (409)', async () => {
    // F062 — claim.ts migrated to ApiError; 410 was not in the ApiError status
    // union so the closest semantic match (conflict, 409) is used. The error
    // code lives in error.message now.
    const { status, body } = await json(`/claim/${slug}`, {
      method: 'POST',
      body: JSON.stringify({ email: 'bob6@x.com' }),
    });
    expect(status).toBe(409);
    expect(body.error.message).toBe('unavailable');
  });

  it('unknown slug is 404', async () => {
    const { status, body } = await json('/claim/bogus');
    expect(status).toBe(404);
    expect(body.error.message).toBe('not_found');
  });
});

describe('kyc smoke (demo)', () => {
  it('POST /kyc/start mints a demo token', async () => {
    const { status, body } = await json('/kyc/start', { method: 'POST', headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.demo).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it('GET /kyc/status reports a kycStatus', async () => {
    const { status, body } = await json('/kyc/status', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.kycStatus).toBeTruthy();
  });
});

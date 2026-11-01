/**
 * No-demo-data leakage tests — Sprint 15.
 *
 * The live-wiring rollout's core promise is: a production caller never receives
 * a synthesized financial value. This file asserts the shape of the `sourced`
 * envelope on every route that emits financial data.
 *
 * Under vitest, `process.env.VITEST` is set, so the chain adapters report
 * `apyUnavailable` instead of contacting real RPCs — the perfect stand-in for
 * "production minus provider keys". DEMO_MODE controls the swap-quote demo
 * fallback; we toggle it where needed.
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
    body: JSON.stringify({ email: 'no-leak-tester@example.com' }),
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

const ALLOWED_KINDS = [
  'live',
  'sandbox',
  'cached-live',
  'provider-demo',
  'unavailable',
  'error',
];

describe('no-leak: /earn/apy', () => {
  it('503 response carries sourced metadata, never a fake APY', async () => {
    const { status, body } = await json('/earn/apy', { headers: authed() });
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    // sourced envelope must be present and identify a known provider + reason
    expect(body.sourced).toBeDefined();
    expect(ALLOWED_KINDS).toContain(body.sourced.source);
    expect(body.sourced.source).not.toBe('live'); // we never had a live read
    expect(typeof body.sourced.provider).toBe('string');
    // every adapter row also carries sourced metadata
    expect(Array.isArray(body.adapters)).toBe(true);
    for (const row of body.adapters) {
      expect(row.sourced).toBeDefined();
      expect(ALLOWED_KINDS).toContain(row.sourced.source);
    }
  });
});

describe('no-leak: /earn/protocols', () => {
  it('every adapter row reports sourced metadata aligned with availability', async () => {
    const { status, body } = await json('/earn/protocols', { headers: authed() });
    expect(status).toBe(200);
    for (const adapter of body.adapters as Array<{
      name: string;
      apyBps: number;
      available: boolean;
      sourced: { source: string; provider: string };
    }>) {
      expect(adapter.sourced).toBeDefined();
      expect(ALLOWED_KINDS).toContain(adapter.sourced.source);
      // When available is false the source MUST be a failure kind; we will
      // never serve a live number on top of an `available: false` row.
      if (!adapter.available) {
        expect(['unavailable', 'error']).toContain(adapter.sourced.source);
      }
    }
  });
});

describe('no-leak: /swap/quote', () => {
  it('DEMO_MODE quote response declares source=provider-demo (never silently live)', async () => {
    const { status, body } = await json('/swap/quote?amount=100&direction=usd-eur', {
      headers: authed(),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sourced).toBeDefined();
    // In DEMO_MODE the response either reports `provider-demo` (the explicit
    // demo path) or `live` if a real provider answered. It must NEVER come
    // through as `live` with the 0.92 demo rate stamped on top.
    expect(ALLOWED_KINDS).toContain(body.sourced.source);
    if (body.source === 'demo') {
      expect(body.sourced.source).toBe('provider-demo');
    }
  });
});

describe('no-leak: /markets/hyperliquid', () => {
  it('market list response carries a sourced envelope per call', async () => {
    const { status, body } = await json('/markets/hyperliquid', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sourced).toBeDefined();
    expect(ALLOWED_KINDS).toContain(body.sourced.source);
    expect(['hyperliquid', 'polymarket']).toContain(body.sourced.provider);
  });
});

describe('no-leak: /card', () => {
  it('card state response carries sourced metadata', async () => {
    const { status, body } = await json('/card', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sourced).toBeDefined();
    expect(ALLOWED_KINDS).toContain(body.sourced.source);
    expect(['gnosis-pay', 'sponge']).toContain(body.sourced.provider);
  });
});

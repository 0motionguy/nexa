/**
 * Sprint 10 Item F — perks read surface + awardPoints lifecycle.
 *
 * The store is in-memory under vitest so we exercise the store contract via
 * the route: GET /perks defaults to starter/0; we can't write points directly,
 * but the store-level awardPoints is exposed via the campaign release-bonus
 * path in campaigns.spec.ts. Here we focus on the route shape + tier ramp via
 * a direct store import.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { store } from '../store/index.js';

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

async function login(email: string): Promise<string> {
  const start = await json('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  return verify.body.token as string;
}

describe('GET /perks — read surface', () => {
  it('new user → starter tier 0 points', async () => {
    const token = await login('perks-new@example.com');
    const { status, body } = await json('/perks', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(body.tier).toBe('starter');
    expect(body.points).toBe(0);
    expect(body.multiplier).toBe(1);
    expect(body.nextTierAt).toBe(100);
    expect(body.lifetimeEarnedUsd).toBe(0);
  });

  it('awardPoints earn 50 USD → 50 pts, still starter', async () => {
    const token = await login('perks-50@example.com');
    const u = await store.upsertUserByEmail('perks-50@example.com');
    await store.awardPoints(u, 'earn', 50);
    const { body } = await json('/perks', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(body.points).toBe(50);
    expect(body.tier).toBe('starter');
    expect(body.lifetimeEarnedUsd).toBeCloseTo(50, 2);
  });

  it('awardPoints earn 100 USD → rising tier with 1.05x multiplier', async () => {
    const token = await login('perks-100@example.com');
    const u = await store.upsertUserByEmail('perks-100@example.com');
    await store.awardPoints(u, 'earn', 100);
    const { body } = await json('/perks', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(body.points).toBe(100);
    expect(body.tier).toBe('rising');
    expect(body.multiplier).toBe(1.05);
    expect(body.nextTierAt).toBe(500);
  });

  it('awardPoints cardSpend 1000 USD → 500 pts, top tier with 1.10x multiplier', async () => {
    const token = await login('perks-top@example.com');
    const u = await store.upsertUserByEmail('perks-top@example.com');
    await store.awardPoints(u, 'cardSpend', 1000);
    const { body } = await json('/perks', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(body.points).toBe(500);
    expect(body.tier).toBe('top');
    expect(body.multiplier).toBe(1.1);
    expect(body.nextTierAt).toBeNull();
    // cardSpend does not bump lifetimeEarnedUsd — that's earn-only.
    expect(body.lifetimeEarnedUsd).toBe(0);
  });

  it('requires a session', async () => {
    const { status } = await json('/perks');
    expect(status).toBe(401);
  });
});

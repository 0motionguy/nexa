/**
 * Stack upgrades Phase 3 — agent route extensions + store invariants.
 *
 * Exercises:
 *   - InMemoryStore `getAgentWallet`/`setAgentWallet` round-trips
 *   - Per-agent wallet isolation via the singleton walletService
 *   - humanApprovalThresholdUsd enforcement in x402Pay
 *   - Allowlist still throws on miss (regression coverage for the threshold check)
 *
 * Each `it` block creates fresh users (unique emails) on the same singleton
 * store so wallet bindings + digest rows don't leak across tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory.js';
import { PolicyError } from '../store/types.js';

describe('InMemoryStore — agent wallet bindings', () => {
  it('round-trips setAgentWallet → getAgentWallet', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('aa@test.co', 'A');
    const a = await store.createAgent(u, 'A1', 5, 0.5, []);

    expect(await store.getAgentWallet(a.id)).toBeNull();

    await store.setAgentWallet(a.id, {
      walletId: 'wallet_demo_xyz',
      address: '0xabc0000000000000000000000000000000000abc',
      chain: 'base',
    });
    const r = await store.getAgentWallet(a.id);
    expect(r?.walletId).toBe('wallet_demo_xyz');
    expect(r?.chain).toBe('base');
  });

  it('setAgentWallet is idempotent — second set overwrites the first', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('bb@test.co', 'B');
    const a = await store.createAgent(u, 'B1', 5, 0.5, []);
    await store.setAgentWallet(a.id, {
      walletId: 'old',
      address: '0xold0000000000000000000000000000000000old',
      chain: 'base',
    });
    await store.setAgentWallet(a.id, {
      walletId: 'new',
      address: '0xnew0000000000000000000000000000000000new',
      chain: 'base',
    });
    const r = await store.getAgentWallet(a.id);
    expect(r?.walletId).toBe('new');
  });
});

describe('walletService.getOrCreateAgentWallet — per-agent isolation', () => {
  it('synthesizes a deterministic demo address per agent.id', async () => {
    // Use the singleton store + walletService — walletService reads/writes
    // through the same singleton so persistence round-trips through it.
    const { store } = await import('../store/index.js');
    const { walletService } = await import('../lib/chain/wallet.js');
    const u = await store.upsertUserByEmail('alice@phase3.co', 'Alice');
    const a1 = await store.createAgent(u, 'P3Alice1', 5, 0.5, []);
    const a2 = await store.createAgent(u, 'P3Alice2', 5, 0.5, []);

    const w1 = await walletService.getOrCreateAgentWallet(u.id, null, a1.id, a1.name);
    const w2 = await walletService.getOrCreateAgentWallet(u.id, null, a2.id, a2.name);
    expect(w1.address).not.toEqual(w2.address);
    expect(w1.address).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(w2.address).toMatch(/^0x[0-9a-f]{40}$/i);

    // The (agent, chain) record must persist after the live call.
    const p1 = await store.getAgentWallet(a1.id);
    const p2 = await store.getAgentWallet(a2.id);
    expect(p1?.address).toBe(w1.address);
    expect(p2?.address).toBe(w2.address);
  });

  it('idempotent — second call returns the same address', async () => {
    const { store } = await import('../store/index.js');
    const { walletService } = await import('../lib/chain/wallet.js');
    const u = await store.upsertUserByEmail('bob@phase3.co', 'Bob');
    const a = await store.createAgent(u, 'P3Bob1', 5, 0.5, []);
    const w1 = await walletService.getOrCreateAgentWallet(u.id, null, a.id, a.name);
    const w2 = await walletService.getOrCreateAgentWallet(u.id, null, a.id, a.name);
    expect(w2.address).toBe(w1.address);
    expect(w2.walletId).toBe(w1.walletId);
  });
});

describe('store.x402Pay — humanApprovalThresholdUsd enforcement', () => {
  it('throws needs_human_approval when amount > threshold (distinct from per-tx-cap)', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('dave@test.co', 'Dave');
    const a = await store.createAgent(u, 'Spender', 100, 50, ['api.x.com']);
    a.balanceUsd = 200;
    // Lower the threshold below the cap so threshold check fires before cap check.
    await store.updateAgentPolicy(u, a.id, { humanApprovalThresholdUsd: 5 });
    a.state = 'live';

    await expect(
      store.x402Pay(u, a.id, 'api.x.com/v1/q', 10, 'big spend'),
    ).rejects.toMatchObject({ code: 'needs_human_approval' });
  });

  it('threshold fires before per-tx-cap when both would trip', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('eve@test.co', 'Eve');
    // Default `humanApprovalThresholdUsd = perTxCapUsd`. Both = 5 → threshold fires.
    const a = await store.createAgent(u, 'Spender', 100, 5, ['api.x.com']);
    a.balanceUsd = 200;
    a.state = 'live';
    await expect(
      store.x402Pay(u, a.id, 'api.x.com/v1/q', 10, 'big'),
    ).rejects.toMatchObject({ code: 'needs_human_approval' });
  });

  it('within threshold + within cap + allowlisted → settles', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('frank@test.co', 'Frank');
    const a = await store.createAgent(u, 'Saver', 50, 5, ['api.x.com']);
    a.balanceUsd = 100;
    a.state = 'live';
    await store.updateAgentPolicy(u, a.id, { humanApprovalThresholdUsd: 5 });
    const { receipt } = await store.x402Pay(u, a.id, 'api.x.com/v1/q', 3, 'small');
    expect(receipt.amountUsd).toBe(3);
    expect(receipt.httpStatus).toBe(200);
  });

  it('replays an idempotent x402Pay without a second agent debit', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('x402-idem@test.co', 'Idem');
    const a = await store.createAgent(u, 'ReplayBot', 50, 5, ['api.x.com']);
    a.balanceUsd = 100;
    a.state = 'live';
    await store.updateAgentPolicy(u, a.id, { humanApprovalThresholdUsd: 5 });

    const first = await store.x402Pay(
      u,
      a.id,
      'api.x.com/v1/q',
      3,
      'small',
      'chain-ref-1',
      { idempotencyKey: 'x402-pay-store-1' },
    );
    const replay = await store.x402Pay(
      u,
      a.id,
      'api.x.com/v1/q',
      3,
      'small',
      'chain-ref-2',
      { idempotencyKey: 'x402-pay-store-1' },
    );

    expect(a.balanceUsd).toBe(97);
    expect(u.x402Events).toHaveLength(1);
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(replay.activity.id).toBe(first.activity.id);
  });
});

describe('store.x402Pay — allowlist regression', () => {
  it('endpoint_not_allowed throws PolicyError when host is off the allowlist', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('gina@test.co', 'Gina');
    const a = await store.createAgent(u, 'AllowOnly', 50, 5, ['api.x.com']);
    a.balanceUsd = 100;
    a.state = 'live';
    await expect(
      store.x402Pay(u, a.id, 'evil.io/v1/q', 1, 'naughty'),
    ).rejects.toBeInstanceOf(PolicyError);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Sprint 11 Phase 3 — HTTP route coverage. Boots the real Hono `app` so the
 * full middleware chain (session, validators, error normalizer) runs. Each
 * test creates a fresh user via /auth so the policy gates are exercised
 * against an isolated state slice.
 * ────────────────────────────────────────────────────────────────────────── */

describe('routes/agent HTTP', () => {
  let randomBytes: typeof import('node:crypto').randomBytes;
  let app: typeof import('../index.js').app;

  beforeAll(async () => {
    randomBytes = (await import('node:crypto')).randomBytes;
    app = (await import('../index.js')).app;
  });

  async function postJson(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, any> }> {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async function freshToken(): Promise<string> {
    const email = `agent-route-${randomBytes(4).toString('hex')}@example.com`;
    const start = await postJson('/auth/start', { email });
    const verify = await postJson('/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    return verify.body['token'] as string;
  }

  it('GET /agent without a session returns 401', async () => {
    const res = await app.request('/agent');
    expect(res.status).toBe(401);
  });

  it('GET /agent lists the user agents + killSwitch flag', async () => {
    const token = await freshToken();
    const res = await app.request('/agent', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(Array.isArray(body['agents'])).toBe(true);
    expect(typeof body['killSwitch']).toBe('boolean');
  });

  it('POST /agent/create creates a new agent (default-deny allowlist)', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const { status, body } = await postJson(
      '/agent/create',
      { name: `HTTPCreate-${randomBytes(2).toString('hex')}`, perDayCapUsd: 10, perTxCapUsd: 1 },
      auth,
    );
    expect(status).toBe(201);
    expect(body['ok']).toBe(true);
    expect(body['agent']?.policy?.endpointAllowlist).toEqual([]);
    expect(body['agent']?.state).toBe('ready');
  });

  it('POST /agent/kill-switch toggles the user-level kill flag', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const on = await postJson('/agent/kill-switch', { on: true }, auth);
    expect(on.status).toBe(200);
    expect(on.body['killSwitch']).toBe(true);
    const off = await postJson('/agent/kill-switch', { on: false }, auth);
    expect(off.body['killSwitch']).toBe(false);
  });

  it('POST /agent/:id/policy updates allowlist + caps on an owned agent', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(
      '/agent/create',
      { name: `PolicyAgent-${randomBytes(2).toString('hex')}`, perDayCapUsd: 5, perTxCapUsd: 0.5 },
      auth,
    );
    const id = created.body['agent']?.id as string;
    expect(id).toBeTruthy();

    const patched = await postJson(
      `/agent/${id}/policy`,
      { perDayCapUsd: 25, endpointAllowlist: ['api.exa.ai'] },
      auth,
    );
    expect(patched.status).toBe(200);
    expect(patched.body['agent']?.policy?.perDayCapUsd).toBe(25);
    expect(patched.body['agent']?.policy?.endpointAllowlist).toEqual(['api.exa.ai']);
  });

  it('POST /agent/:id/fund replays Idempotency-Key without a second budget move', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(
      '/agent/create',
      { name: `FundAgent-${randomBytes(2).toString('hex')}`, perDayCapUsd: 20, perTxCapUsd: 2 },
      auth,
    );
    const id = created.body['agent']?.id as string;
    const headers = { ...auth, 'Idempotency-Key': 'agent-fund-route-1' };

    const first = await postJson(`/agent/${id}/fund`, { amountUsd: 10 }, headers);
    const replay = await postJson(`/agent/${id}/fund`, { amountUsd: 10 }, headers);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(first.body['agent']?.balanceUsd).toBe(10);
    expect(replay.body['agent']?.balanceUsd).toBe(10);
    expect(replay.body['balUsd']).toBe(first.body['balUsd']);
  });

  it('POST /agent/:id/fund requires an Idempotency-Key', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(
      '/agent/create',
      { name: `FundKeyAgent-${randomBytes(2).toString('hex')}`, perDayCapUsd: 20, perTxCapUsd: 2 },
      auth,
    );
    const id = created.body['agent']?.id as string;

    const res = await postJson(`/agent/${id}/fund`, { amountUsd: 10 }, auth);

    expect(res.status).toBe(400);
    expect(res.body['error']?.message).toBe('idempotency_key_required');
  });

  it('POST /agent/:id/approve-once replays Idempotency-Key without a second spend', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(
      '/agent/create',
      { name: `ApproveAgent-${randomBytes(2).toString('hex')}`, perDayCapUsd: 20, perTxCapUsd: 1 },
      auth,
    );
    const id = created.body['agent']?.id as string;
    await postJson(
      `/agent/${id}/fund`,
      { amountUsd: 10 },
      { ...auth, 'Idempotency-Key': 'agent-approve-setup-fund-1' },
    );
    const headers = { ...auth, 'Idempotency-Key': 'agent-approve-route-1' };
    const body = { endpoint: 'dataset.vendor.io/v1/access', amountUsd: 2.4, reason: 'dataset access' };

    const first = await postJson(`/agent/${id}/approve-once`, body, headers);
    const replay = await postJson(`/agent/${id}/approve-once`, body, headers);
    const agents = await app.request('/agent', { headers: auth });
    const agentsBody = (await agents.json()) as Record<string, any>;
    const agent = (agentsBody['agents'] as Array<Record<string, any>>).find((row) => row['id'] === id);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body['receipt']?.ref).toBe(first.body['receipt']?.ref);
    expect(agent?.['balanceUsd']).toBe(7.6);
    expect(agent?.['spentTodayUsd']).toBe(2.4);
  });

  it('POST /agent/:id/approve-once requires an Idempotency-Key', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(
      '/agent/create',
      { name: `ApproveKeyAgent-${randomBytes(2).toString('hex')}`, perDayCapUsd: 20, perTxCapUsd: 1 },
      auth,
    );
    const id = created.body['agent']?.id as string;
    await postJson(
      `/agent/${id}/fund`,
      { amountUsd: 10 },
      { ...auth, 'Idempotency-Key': 'agent-approve-key-setup-fund-1' },
    );

    const res = await postJson(
      `/agent/${id}/approve-once`,
      { endpoint: 'dataset.vendor.io/v1/access', amountUsd: 2.4, reason: 'dataset access' },
      auth,
    );

    expect(res.status).toBe(400);
    expect(res.body['error']?.message).toBe('idempotency_key_required');
  });

  it('POST /agent/:id/policy 404s for an unknown agent', async () => {
    const token = await freshToken();
    const { status, body } = await postJson(
      '/agent/agent_does_not_exist/policy',
      { perDayCapUsd: 10 },
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(404);
    // Sprint 17 F062 — ApiError envelope wraps the code in error.message.
    expect((body['error'] as { message: string }).message).toBe('agent_not_found');
  });

  it('GET /agent/:id/activity returns events scoped to the agent', async () => {
    const token = await freshToken();
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(
      '/agent/create',
      { name: `ActivityAgent-${randomBytes(2).toString('hex')}`, perDayCapUsd: 5, perTxCapUsd: 0.5 },
      auth,
    );
    const id = created.body['agent']?.id as string;
    const res = await app.request(`/agent/${id}/activity`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(Array.isArray(body['events'])).toBe(true);
  });

  it('GET /agent/:id/activity 404s for an unknown agent', async () => {
    const token = await freshToken();
    const res = await app.request('/agent/agent_does_not_exist/activity', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('POST /agent/:id/bank 404s for an unknown agent', async () => {
    const token = await freshToken();
    const { status, body } = await postJson(
      '/agent/agent_does_not_exist/bank',
      {},
      { authorization: `Bearer ${token}` },
    );
    expect(status).toBe(404);
    // Sprint 17 F062 — ApiError envelope wraps the code in error.message.
    expect((body['error'] as { message: string }).message).toBe('agent_not_found');
  });

  it('POST /agent/:id/fund 404s for an unknown agent (after Zod passes)', async () => {
    const token = await freshToken();
    const { status, body } = await postJson(
      '/agent/agent_does_not_exist/fund',
      { amountUsd: 1 },
      { authorization: `Bearer ${token}`, 'Idempotency-Key': 'agent-fund-missing-agent-1' },
    );
    expect(status).toBe(404);
    // Sprint 17 F062 — ApiError envelope wraps the code in error.message.
    expect((body['error'] as { message: string }).message).toBe('agent_not_found');
  });
});

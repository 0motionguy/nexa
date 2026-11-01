/**
 * Sprint 11 Phase 3 — route-level coverage for /card surface. Pairs with
 * routes/cards.spec.ts (sprint 8) which exercises the on-chain adapter happy
 * paths via the live Hono server; this file focuses on the auth gates,
 * /freeze + /limit (which cards.spec doesn't touch), and Zod boundaries.
 *
 *   GET  /card        — current state (frozen, dayLimit, last4)
 *   POST /card/order  — provision a virtual card (covered by cards.spec)
 *   POST /card/topup  — bridge-routed top-up, logged as activity
 *   POST /card/freeze — flip frozen flag
 *   POST /card/limit  — set the per-day cap
 *
 * Each test seeds a fresh session via a unique email so state stays scoped
 * to the test (the underlying singleton store survives across the file).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const ORIGINAL_ENV = process.env;

async function loadApp(): Promise<typeof import('../index.js').app> {
  const mod = await import('../index.js');
  return mod.app;
}

async function postJson(
  app: Awaited<ReturnType<typeof loadApp>>,
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

async function authedToken(app: Awaited<ReturnType<typeof loadApp>>): Promise<string> {
  const email = `card-test-${randomBytes(4).toString('hex')}@example.com`;
  const start = await postJson(app, '/auth/start', { email });
  const verify = await postJson(app, '/auth/verify', {
    challengeId: start.body['challengeId'] as string,
    code: '482019',
  });
  return verify.body['token'] as string;
}

describe('routes/card', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '1' };
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../lib/chain/index.js');
    process.env = ORIGINAL_ENV;
  });

  it('GET /card rejects requests without a session (401)', async () => {
    const app = await loadApp();
    const res = await app.request('/card');
    expect(res.status).toBe(401);
  });

  it('GET /card returns the current card state for a session', async () => {
    const app = await loadApp();
    const token = await authedToken(app);
    const res = await app.request('/card', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(typeof body['frozen']).toBe('boolean');
    expect(typeof body['dayLimitUsd']).toBe('number');
    // Back-compat nested projection — exists for the legacy front-end.
    expect(body['card']?.kind).toBe('DEBIT');
    expect(typeof body['card']?.last4).toBe('string');
  });

  it('GET /card/ mirrors /card for browser callers', async () => {
    const app = await loadApp();
    const token = await authedToken(app);
    const res = await app.request('/card/', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(typeof body['dayLimitUsd']).toBe('number');
  });

  it('GET /card does not fabricate card identity outside DEMO_MODE without Gnosis Pay', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    delete process.env['GNOSIS_PAY_API_KEY'];
    vi.resetModules();
    const app = await loadApp();
    const token = await authedToken(app);
    const res = await app.request('/card', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(body['last4']).toBeNull();
    expect(body['network']).toBeNull();
    expect(body['safeAddress']).toBeNull();
    expect(body['demo']).toBe(false);
    expect(body['card']).toBeNull();
  });

  it('POST /card/freeze flips the frozen flag and GET /card reflects it', async () => {
    const app = await loadApp();
    const token = await authedToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const frozen = await postJson(app, '/card/freeze', { frozen: true }, auth);
    expect(frozen.status).toBe(200);
    expect(frozen.body['ok']).toBe(true);
    expect(frozen.body['frozen']).toBe(true);

    const view = await app.request('/card', { headers: auth });
    const body = (await view.json()) as Record<string, any>;
    expect(body['frozen']).toBe(true);
    expect(body['card']?.frozen).toBe(true);

    const unfrozen = await postJson(app, '/card/freeze', { frozen: false }, auth);
    expect(unfrozen.body['frozen']).toBe(false);
  });

  it('POST /card/limit persists the new dayLimitUsd', async () => {
    const app = await loadApp();
    const token = await authedToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const { status, body } = await postJson(app, '/card/limit', { dayLimitUsd: 750 }, auth);
    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(body['dayLimitUsd']).toBe(750);

    const view = await app.request('/card', { headers: auth });
    const viewBody = (await view.json()) as Record<string, any>;
    expect(viewBody['dayLimitUsd']).toBe(750);
  });

  it('POST /card/limit rejects values outside [100, 2000] at Zod boundary', async () => {
    const app = await loadApp();
    const token = await authedToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const tooLow = await postJson(app, '/card/limit', { dayLimitUsd: 50 }, auth);
    expect(tooLow.status).toBe(400);

    const tooHigh = await postJson(app, '/card/limit', { dayLimitUsd: 5000 }, auth);
    expect(tooHigh.status).toBe(400);
  });

  it('POST /card/topup rejects non-positive amounts at Zod boundary', async () => {
    const app = await loadApp();
    const token = await authedToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const { status } = await postJson(app, '/card/topup', { amountUsd: 0 }, auth);
    expect(status).toBe(400);
  });

  it('POST /card/order requires an idempotency key before live provider calls', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const deploySafe = vi.fn(async () => ({ safeAddress: '0x000000000000000000000000000000000000cafe', demo: false }));
    const orderVirtualCard = vi.fn(async () => ({ last4: '1234', network: 'Visa', pan: '4111', demo: false }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        gnosis: { deploySafe, orderVirtualCard },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);

    const { status, body } = await postJson(
      app,
      '/card/order',
      {},
      { authorization: `Bearer ${token}` },
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe('idempotency_key_required');
    expect(deploySafe).not.toHaveBeenCalled();
    expect(orderVirtualCard).not.toHaveBeenCalled();
  });

  it('POST /card/order forwards step-specific idempotency keys to live providers', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const deploySafe = vi.fn(async () => ({ safeAddress: '0x000000000000000000000000000000000000cafe', demo: false }));
    const orderVirtualCard = vi.fn(async () => ({ last4: '1234', network: 'Visa', pan: '4111', demo: false }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        gnosis: { deploySafe, orderVirtualCard },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);

    const { status, body } = await postJson(
      app,
      '/card/order',
      {},
      {
        authorization: `Bearer ${token}`,
        'Idempotency-Key': 'card-order-route-1',
      },
    );

    expect(status).toBe(200);
    expect(body['ok']).toBe(true);
    expect(deploySafe).toHaveBeenCalledWith(expect.any(String), {
      idempotencyKey: expect.stringMatching(/^card-order:safe:/),
    });
    expect(orderVirtualCard).toHaveBeenCalledWith(expect.any(String), {
      idempotencyKey: expect.stringMatching(/^card-order:card:/),
    });
  });

  it('POST /agent/:id/card requires idempotency when Sponge is live', async () => {
    const createAgentCard = vi.fn(async () => ({ last4: '1234', network: 'Mastercard', demo: false }));
    const createAgentBankAccount = vi.fn(async () => ({
      accountNumber: '1234567890',
      routingNumber: '021000021',
      demo: false,
    }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        wallets: { getOrCreateAgentWallet: vi.fn(async () => ({ address: '0xabc' })) },
        sponge: {
          isSpongeEnabled: () => true,
          createAgentCard,
          createAgentBankAccount,
        },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(app, '/agent/create', {
      name: `SpongeCard-${randomBytes(2).toString('hex')}`,
      perDayCapUsd: 5,
      perTxCapUsd: 1,
    }, auth);
    const agentId = created.body['agent']?.id as string;

    const { status, body } = await postJson(app, `/agent/${agentId}/card`, {}, auth);

    expect(status).toBe(400);
    expect(body.error.message).toBe('idempotency_key_required');
    expect(createAgentCard).not.toHaveBeenCalled();
  });

  it('POST /agent/:id/card and /bank forward Sponge idempotency keys', async () => {
    const createAgentCard = vi.fn(async () => ({ last4: '1234', network: 'Mastercard', demo: false }));
    const createAgentBankAccount = vi.fn(async () => ({
      accountNumber: '1234567890',
      routingNumber: '021000021',
      demo: false,
    }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        wallets: { getOrCreateAgentWallet: vi.fn(async () => ({ address: '0xabc' })) },
        sponge: {
          isSpongeEnabled: () => true,
          createAgentCard,
          createAgentBankAccount,
        },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(app, '/agent/create', {
      name: `SpongeBank-${randomBytes(2).toString('hex')}`,
      perDayCapUsd: 5,
      perTxCapUsd: 1,
    }, auth);
    const agentId = created.body['agent']?.id as string;

    const card = await postJson(app, `/agent/${agentId}/card`, {}, {
      ...auth,
      'Idempotency-Key': 'agent-card-route-1',
    });
    const bank = await postJson(app, `/agent/${agentId}/bank`, {}, {
      ...auth,
      'Idempotency-Key': 'agent-bank-route-1',
    });

    expect(card.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(createAgentCard).toHaveBeenCalledWith(expect.any(String), agentId, {
      idempotencyKey: expect.stringMatching(/^agent-card:/),
    });
    expect(createAgentBankAccount).toHaveBeenCalledWith(expect.any(String), agentId, {
      idempotencyKey: expect.stringMatching(/^agent-bank:/),
    });
  });

  it('POST /card/topup requires an idempotency key before live bridge execution', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const execute = vi.fn(async () => ({ txHash: '0xtopup', demo: false, provider: 'socket' as const }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        wallets: {
          getOrCreateUserWallet: vi.fn(async () => ({
            address: '0x000000000000000000000000000000000000cafe',
          })),
        },
        bridgeRouter: { execute },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);

    const { status, body } = await postJson(
      app,
      '/card/topup',
      { amountUsd: 25 },
      { authorization: `Bearer ${token}` },
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe('idempotency_key_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('POST /card/topup forwards Idempotency-Key into bridge execution', async () => {
    const execute = vi.fn(async () => ({ txHash: '0xtopup', demo: false, provider: 'socket' as const }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        wallets: {
          getOrCreateUserWallet: vi.fn(async () => ({
            address: '0x000000000000000000000000000000000000cafe',
          })),
        },
        bridgeRouter: { execute },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);

    const { status } = await postJson(
      app,
      '/card/topup',
      { amountUsd: 25 },
      {
        authorization: `Bearer ${token}`,
        'Idempotency-Key': 'card-topup-idem-1',
      },
    );

    expect(status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ amountUsd: 25, fromChain: 'base', toChain: 'gnosis' }),
      expect.any(String),
      { idempotencyKey: 'card-topup-idem-1' },
    );
  });

  it('POST /card/topup replays Idempotency-Key without a second bridge execution', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const execute = vi.fn(async () => ({ txHash: '0xtopup-replay', demo: false, provider: 'socket' as const }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        wallets: {
          getOrCreateUserWallet: vi.fn(async () => ({
            address: '0x000000000000000000000000000000000000cafe',
          })),
        },
        bridgeRouter: { execute },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);
    const headers = {
      authorization: `Bearer ${token}`,
      'Idempotency-Key': 'card-topup-replay-1',
    };

    const first = await postJson(app, '/card/topup', { amountUsd: 25 }, headers);
    const replay = await postJson(app, '/card/topup', { amountUsd: 25 }, headers);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body['txHash']).toBe('0xtopup-replay');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('POST /card/topup rejects Idempotency-Key replay with a different amount', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const execute = vi.fn(async () => ({ txHash: '0xtopup-conflict', demo: false, provider: 'socket' as const }));
    vi.doMock('../lib/chain/index.js', () => ({
      getChainStack: () => ({
        wallets: {
          getOrCreateUserWallet: vi.fn(async () => ({
            address: '0x000000000000000000000000000000000000cafe',
          })),
        },
        bridgeRouter: { execute },
      }),
    }));
    const app = await loadApp();
    const token = await authedToken(app);
    const headers = {
      authorization: `Bearer ${token}`,
      'Idempotency-Key': 'card-topup-conflict-1',
    };

    await postJson(app, '/card/topup', { amountUsd: 25 }, headers);
    const replay = await postJson(app, '/card/topup', { amountUsd: 30 }, headers);

    expect(replay.status).toBe(409);
    expect(replay.body.error.message).toBe('idempotency_key_reused');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('POST /card/freeze without a session returns 401', async () => {
    const app = await loadApp();
    const { status } = await postJson(app, '/card/freeze', { frozen: true });
    expect(status).toBe(401);
  });
});

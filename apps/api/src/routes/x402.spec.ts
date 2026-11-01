/**
 * Sprint 11 Phase 3 — coverage for the x402 surface. The api.spec.ts suite
 * already exercises:
 *
 *   POST /x402/pay     — allowlist block (403), needs_human_approval (402),
 *                         allowed within caps (200), bad agent key (401)
 *   POST /x402/settle  — same shape as /pay
 *   GET  /x402/quote   — happy path on a seeded contract
 *
 * This file adds:
 *
 *   GET  /x402/quote          — missing_resource (400) + contract_not_found (404)
 *   GET  /x402/contracts      — session-only list
 *   POST /x402/contracts      — create (201)
 *   GET  /x402/contracts/:id  — owned + 404
 *   POST /x402/contracts/:id/status — flip status; 404 path
 *   GET  /x402/events         — recent events list
 *   POST /x402/pay            — agent_not_found 404 surfacing
 *
 * The async `agent.blocked` webhook fan-out fires from a void-promise inside
 * the 403 branch; the route returns synchronously with the policy code, so
 * the assertion is on the response. Lifecycle / delivery of the dispatched
 * webhook itself is covered by webhooks.spec.ts.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const ORIGINAL_ENV = process.env;
const AGENT_KEY = 'nx_live_7f3k_demo'; // seeded against mirko@studio.co
const LIVE_TX_HASH = `0x${'ab'.repeat(32)}`;

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

async function freshSessionToken(
  app: Awaited<ReturnType<typeof loadApp>>,
): Promise<string> {
  const email = `x402-test-${randomBytes(4).toString('hex')}@example.com`;
  const start = await postJson(app, '/auth/start', { email });
  const verify = await postJson(app, '/auth/verify', {
    challengeId: start.body['challengeId'] as string,
    code: '482019',
  });
  return verify.body['token'] as string;
}

describe('routes/x402 — /pay edge cases (agent key)', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../lib/chain/index.js');
    vi.doUnmock('../lib/x402-payee.js');
    vi.restoreAllMocks();
    process.env = ORIGINAL_ENV;
  });

  it('returns 404 agent_not_found when the named agent is unknown', async () => {
    const app = await loadApp();
    const { status, body } = await postJson(
      app,
      '/x402/pay',
      {
        agent: 'NoSuchAgent-xyz-9999',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.1,
        reason: 'sanity',
      },
      { 'x-nexa-key': AGENT_KEY },
    );
    expect(status).toBe(404);
    expect(body['error']?.message).toBe('agent_not_found');
  });

  it('rejects malformed bodies at the Zod boundary (400)', async () => {
    const app = await loadApp();
    const { status } = await postJson(
      app,
      '/x402/pay',
      { agent: '', endpoint: 'x', amountUsd: -1, reason: '' },
      { 'x-nexa-key': AGENT_KEY },
    );
    expect(status).toBe(400);
  });

  it('requires an Idempotency-Key for ledger settles outside demo mode', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const app = await loadApp();

    const { status, body } = await postJson(
      app,
      '/x402/pay',
      {
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.1,
        reason: 'ledger settle',
      },
      { 'x-nexa-key': AGENT_KEY },
    );

    expect(status).toBe(400);
    expect(body['error']?.message).toBe('idempotency_key_required');
  });

  it('replays a ledger-settle Idempotency-Key without a second agent debit', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const app = await loadApp();
    const headers = { 'x-nexa-key': AGENT_KEY, 'Idempotency-Key': 'x402-ledger-replay-1' };
    const request = {
      agent: 'ResearchBot-01',
      endpoint: 'api.exa.ai/v1/search',
      amountUsd: 0.1,
      reason: 'ledger settle',
    };

    const first = await postJson(app, '/x402/pay', request, headers);
    const replay = await postJson(app, '/x402/pay', request, headers);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body['receipt']?.ref).toBe(first.body['receipt']?.ref);
    expect(replay.body['receipt']?.id).toBe(first.body['receipt']?.id);
  });

  it('requires an Idempotency-Key on /settle outside demo mode', async () => {
    process.env = { ...ORIGINAL_ENV, DEMO_MODE: '0' };
    const app = await loadApp();

    const { status, body } = await postJson(
      app,
      '/x402/settle',
      {
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.1,
        reason: 'ledger settle',
      },
      { 'x-nexa-key': AGENT_KEY },
    );

    expect(status).toBe(400);
    expect(body['error']?.message).toBe('idempotency_key_required');
  });

  it('returns 403 endpoint_not_allowed for the agent.blocked dispatch path', async () => {
    // The route fires `agent.blocked` async on this branch (void-promise) and
    // returns 403 synchronously. We assert the synchronous shape — webhook
    // delivery itself is covered in webhooks.spec.ts.
    const app = await loadApp();
    const { status, body } = await postJson(
      app,
      '/x402/pay',
      {
        agent: 'ResearchBot-01',
        endpoint: 'evil.io/v1/anything',
        amountUsd: 0.1,
        reason: 'unallowed',
      },
      { 'x-nexa-key': AGENT_KEY },
    );
    expect(status).toBe(403);
    expect(body['error']?.code).toBe('endpoint_not_allowed');
    expect(body['error']?.message).toBeTruthy();
  });

  it('fails closed when live x402 settlement fails', async () => {
    vi.doMock('../lib/x402-payee.js', () => ({
      resolvePayeeAddress: vi.fn(async () => ({
        address: '0x00000000000000000000000000000000000000bb',
        source: 'contract',
        contractId: 'contract_live_test',
      })),
    }));
    vi.doMock('../lib/chain/index.js', async () => {
      const actual = await vi.importActual<typeof import('../lib/chain/index.js')>(
        '../lib/chain/index.js',
      );
      const stack = actual.getChainStack();
      return {
        ...actual,
        getChainStack: () => ({
          ...stack,
          x402: {
            get isLive() {
              return true;
            },
            signTransferAuth: vi.fn(async () => ({
              from: '0x00000000000000000000000000000000000000aa',
              to: '0x00000000000000000000000000000000000000bb',
              value: 100000n,
              validAfter: 0n,
              validBefore: 1n,
              nonce: '0x1111111111111111111111111111111111111111111111111111111111111111',
              signature:
                '0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
              asset: 'USDC',
            })),
            settleViaCoinbase: vi.fn(async () => {
              throw new actual.ChainError('facilitator_rejected', 'facilitator down');
            }),
            buildXPaymentHeader: vi.fn(() => 'live-payment-header'),
          },
          wallets: {
            isLive: vi.fn(() => true),
            getOrCreateAgentWallet: vi.fn(async () => ({
              address: '0x00000000000000000000000000000000000000aa',
              walletId: 'wallet_live_x402_test',
              live: true,
              signTypedData: vi.fn(async () => null),
            })),
          },
        }),
      };
    });

    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const user = await store.userForAgentKey(AGENT_KEY);
    expect(user).toBeTruthy();
    const beforeAgent = await store.agent(user!, 'ResearchBot-01');
    const beforeBalance = beforeAgent.balanceUsd;
    const beforeSpent = beforeAgent.spentTodayUsd;
    const beforeEvents = user!.x402Events.length;
    const res = await app.request('/x402/pay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nexa-key': AGENT_KEY,
        'Idempotency-Key': 'x402-live-settle-fails-1',
      },
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.1,
        reason: 'live settle',
      }),
    });
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(503);
    expect(res.headers.get('x-payment')).toBeNull();
    expect(body['error']?.message).toBe('x402_settlement_failed');
    const afterUser = await store.user(user!.id);
    const afterAgent = await store.agent(afterUser, 'ResearchBot-01');
    expect(afterAgent.balanceUsd).toBe(beforeBalance);
    expect(afterAgent.spentTodayUsd).toBe(beforeSpent);
    expect(afterUser.x402Events).toHaveLength(beforeEvents);
  });

  it('fails closed when live x402 payee resolution would self-pay', async () => {
    const signTransferAuth = vi.fn(async () => ({
      from: '0x00000000000000000000000000000000000000aa',
      to: '0x00000000000000000000000000000000000000aa',
      value: 100000n,
      validAfter: 0n,
      validBefore: 1n,
      nonce: '0x1111111111111111111111111111111111111111111111111111111111111111',
      signature:
        '0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      asset: 'USDC',
    }));
    vi.doMock('../lib/chain/index.js', async () => {
      const actual = await vi.importActual<typeof import('../lib/chain/index.js')>(
        '../lib/chain/index.js',
      );
      const stack = actual.getChainStack();
      return {
        ...actual,
        getChainStack: () => ({
          ...stack,
          x402: {
            get isLive() {
              return true;
            },
            signTransferAuth,
            settleViaCoinbase: vi.fn(async () => ({
              txHash: LIVE_TX_HASH,
              blockNumber: 123n,
              facilitator: 'coinbase',
            })),
            buildXPaymentHeader: vi.fn(() => 'live-payment-header'),
          },
          wallets: {
            isLive: vi.fn(() => true),
            getOrCreateAgentWallet: vi.fn(async () => ({
              address: '0x00000000000000000000000000000000000000aa',
              walletId: 'wallet_live_x402_self_pay',
              live: true,
              signTypedData: vi.fn(async () => null),
            })),
          },
        }),
      };
    });

    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const user = await store.userForAgentKey(AGENT_KEY);
    expect(user).toBeTruthy();
    const beforeAgent = await store.agent(user!, 'ResearchBot-01');
    const beforeEvents = user!.x402Events.length;
    const res = await app.request('/x402/pay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nexa-key': AGENT_KEY,
        'Idempotency-Key': 'x402-live-self-pay-1',
      },
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.1,
        reason: 'live settle',
      }),
    });
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(503);
    expect(res.headers.get('x-payment')).toBeNull();
    expect(body['error']?.message).toBe('x402_payee_unavailable');
    expect(signTransferAuth).not.toHaveBeenCalled();
    const afterUser = await store.user(user!.id);
    const afterAgent = await store.agent(afterUser, 'ResearchBot-01');
    expect(afterAgent.balanceUsd).toBe(beforeAgent.balanceUsd);
    expect(afterAgent.spentTodayUsd).toBe(beforeAgent.spentTodayUsd);
    expect(afterUser.x402Events).toHaveLength(beforeEvents);
  });

  it('requires an Idempotency-Key before live x402 settlement', async () => {
    const signTransferAuth = vi.fn(async () => signedAuthForTest());
    const settleViaCoinbase = vi.fn(async () => ({
      txHash: LIVE_TX_HASH,
      blockNumber: 123n,
      facilitator: 'coinbase',
    }));
    vi.doMock('../lib/x402-payee.js', () => ({
      resolvePayeeAddress: vi.fn(async () => ({
        address: '0x00000000000000000000000000000000000000bb',
        source: 'contract',
        contractId: 'contract_live_test',
      })),
    }));
    vi.doMock('../lib/chain/index.js', async () => {
      const actual = await vi.importActual<typeof import('../lib/chain/index.js')>(
        '../lib/chain/index.js',
      );
      const stack = actual.getChainStack();
      return {
        ...actual,
        getChainStack: () => ({
          ...stack,
          x402: {
            get isLive() {
              return true;
            },
            signTransferAuth,
            settleViaCoinbase,
            buildXPaymentHeader: vi.fn(() => 'live-payment-header'),
          },
          wallets: {
            isLive: vi.fn(() => true),
            getOrCreateAgentWallet: vi.fn(async () => ({
              address: '0x00000000000000000000000000000000000000aa',
              walletId: 'wallet_live_x402_missing_idem',
              live: true,
              signTypedData: vi.fn(async () => null),
            })),
          },
        }),
      };
    });

    const app = await loadApp();
    const res = await app.request('/x402/pay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nexa-key': AGENT_KEY },
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.1,
        reason: 'live settle',
      }),
    });
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(400);
    expect(body['error']?.message).toBe('idempotency_key_required');
    expect(signTransferAuth).not.toHaveBeenCalled();
    expect(settleViaCoinbase).not.toHaveBeenCalled();
  });

  it('replays a live x402 Idempotency-Key without a second facilitator settlement', async () => {
    const settleViaCoinbase = vi.fn(async () => ({
      txHash: LIVE_TX_HASH,
      blockNumber: 123n,
      facilitator: 'coinbase',
    }));
    vi.doMock('../lib/x402-payee.js', () => ({
      resolvePayeeAddress: vi.fn(async () => ({
        address: '0x00000000000000000000000000000000000000bb',
        source: 'contract',
        contractId: 'contract_live_test',
      })),
    }));
    vi.doMock('../lib/chain/index.js', async () => {
      const actual = await vi.importActual<typeof import('../lib/chain/index.js')>(
        '../lib/chain/index.js',
      );
      const stack = actual.getChainStack();
      return {
        ...actual,
        getChainStack: () => ({
          ...stack,
          x402: {
            get isLive() {
              return true;
            },
            signTransferAuth: vi.fn(async () => signedAuthForTest()),
            settleViaCoinbase,
            buildXPaymentHeader: vi.fn(() => 'live-payment-header'),
          },
          wallets: {
            isLive: vi.fn(() => true),
            getOrCreateAgentWallet: vi.fn(async () => ({
              address: '0x00000000000000000000000000000000000000aa',
              walletId: 'wallet_live_x402_replay',
              live: true,
              signTypedData: vi.fn(async () => null),
            })),
          },
        }),
      };
    });

    const app = await loadApp();
    const request = {
      agent: 'ResearchBot-01',
      endpoint: 'api.exa.ai/v1/search',
      amountUsd: 0.1,
      reason: 'live settle',
    };
    const headers = {
      'content-type': 'application/json',
      'x-nexa-key': AGENT_KEY,
      'Idempotency-Key': 'x402-route-replay-1',
    };
    const first = await app.request('/x402/settle', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    const replay = await app.request('/x402/settle', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(settleViaCoinbase).toHaveBeenCalledTimes(1);
  });

  it('routes /x402/settle through the live settlement path', async () => {
    const settleViaCoinbase = vi.fn(async () => ({
      txHash: LIVE_TX_HASH,
      blockNumber: 123n,
      facilitator: 'coinbase',
    }));
    vi.doMock('../lib/x402-payee.js', () => ({
      resolvePayeeAddress: vi.fn(async () => ({
        address: '0x00000000000000000000000000000000000000bb',
        source: 'contract',
        contractId: 'contract_live_test',
      })),
    }));
    vi.doMock('../lib/chain/index.js', async () => {
      const actual = await vi.importActual<typeof import('../lib/chain/index.js')>(
        '../lib/chain/index.js',
      );
      const stack = actual.getChainStack();
      return {
        ...actual,
        getChainStack: () => ({
          ...stack,
          x402: {
            get isLive() {
              return true;
            },
            signTransferAuth: vi.fn(async () => ({
              from: '0x00000000000000000000000000000000000000aa',
              to: '0x00000000000000000000000000000000000000bb',
              value: 100000n,
              validAfter: 0n,
              validBefore: 1n,
              nonce: '0x1111111111111111111111111111111111111111111111111111111111111111',
              signature:
                '0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
              asset: 'USDC',
            })),
            settleViaCoinbase,
            buildXPaymentHeader: vi.fn(() => 'live-payment-header'),
          },
          wallets: {
            isLive: vi.fn(() => true),
            getOrCreateAgentWallet: vi.fn(async () => ({
              address: '0x00000000000000000000000000000000000000aa',
              walletId: 'wallet_live_x402_settle',
              live: true,
              signTypedData: vi.fn(async () => null),
            })),
          },
        }),
      };
    });

    const app = await loadApp();
    const res = await app.request('/x402/settle', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nexa-key': AGENT_KEY,
        'Idempotency-Key': 'x402-settle-route-1',
      },
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.1,
        reason: 'live settle',
      }),
    });
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-payment')).toBe('live-payment-header');
    expect(settleViaCoinbase).toHaveBeenCalledTimes(1);
    expect(body['receipt']?.ref).toBe(LIVE_TX_HASH);
  });
});

function signedAuthForTest() {
  return {
    from: '0x00000000000000000000000000000000000000aa',
    to: '0x00000000000000000000000000000000000000bb',
    value: 100000n,
    validAfter: 0n,
    validBefore: 1n,
    nonce: '0x1111111111111111111111111111111111111111111111111111111111111111',
    signature:
      '0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
    asset: 'USDC',
  };
}

describe('routes/x402 — /quote', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns 400 missing_resource when ?resource is not supplied', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/x402/quote', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body['error']?.message).toBe('missing_resource');
  });

  it('returns 404 contract_not_found when the resource is unknown to this user', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/x402/quote?resource=/v1/missing', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body['error']?.message).toBe('contract_not_found');
  });
});

describe('routes/x402 — contracts CRUD', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('GET /x402/contracts requires a session (401)', async () => {
    const app = await loadApp();
    const res = await app.request('/x402/contracts');
    expect(res.status).toBe(401);
  });

  it('POST /x402/contracts creates a contract and GET lists it back', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const created = await postJson(
      app,
      '/x402/contracts',
      {
        name: 'Sentiment scoring',
        endpointPath: '/v1/sentiment',
        method: 'POST',
        priceUsd: 0.05,
        currency: 'USDC',
      },
      auth,
    );
    expect(created.status).toBe(201);
    expect(created.body['ok']).toBe(true);
    const contract = created.body['contract'] as Record<string, any>;
    expect(contract.name).toBe('Sentiment scoring');
    expect(contract.endpointPath).toBe('/v1/sentiment');
    expect(contract.status).toBe('live');

    const list = await app.request('/x402/contracts', { headers: auth });
    const listBody = (await list.json()) as Record<string, any>;
    const ids = (listBody['contracts'] as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(contract.id);
  });

  it('POST /x402/contracts/:id/status flips status; 404 for unknown id', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };
    const created = await postJson(
      app,
      '/x402/contracts',
      { name: 'Toggle test', endpointPath: '/v1/toggle', priceUsd: 0.01 },
      auth,
    );
    const id = created.body['contract']?.id as string;

    const paused = await postJson(app, `/x402/contracts/${id}/status`, { status: 'paused' }, auth);
    expect(paused.status).toBe(200);
    expect(paused.body['contract']?.status).toBe('paused');

    const missing = await postJson(
      app,
      '/x402/contracts/contract_does_not_exist/status',
      { status: 'paused' },
      auth,
    );
    expect(missing.status).toBe(404);
  });

  it('GET /x402/contracts/:id 404s for unknown id', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/x402/contracts/contract_does_not_exist', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('routes/x402 — /events', () => {
  beforeAll(async () => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('GET /x402/events without a session returns 401', async () => {
    vi.resetModules();
    const app = await loadApp();
    const res = await app.request('/x402/events');
    expect(res.status).toBe(401);
  });

  it('GET /x402/events returns the recent events list (cap 50)', async () => {
    vi.resetModules();
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/x402/events', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(Array.isArray(body['events'])).toBe(true);
    expect((body['events'] as unknown[]).length).toBeLessThanOrEqual(50);
  });
});

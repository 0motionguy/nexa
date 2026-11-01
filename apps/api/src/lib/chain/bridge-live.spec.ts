import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

describe('Bridge adapter live-mode guardrails', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      BRIDGE_API_KEY: 'bridge_test_key',
      BRIDGE_API_BASE: 'https://bridge.test',
    };
    delete process.env.BRIDGE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects unsigned webhooks when Bridge is enabled without a webhook secret', async () => {
    const bridge = await import('./bridge.js');
    expect(bridge.verifyWebhook(null, '{"type":"funds.received"}')).toBe(false);
  });

  it('fails closed instead of returning fake live virtual accounts on Bridge rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream rejected', { status: 502 })),
    );

    const bridge = await import('./bridge.js');

    await expect(bridge.createVirtualAccount('cus_live', 'USD')).rejects.toMatchObject({
      code: 'bridge_virtual_account_failed',
    });
  });

  it('does not surface hosted KYC links from live customer creation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'cus_live_no_kyc_prompt', kyc_link: 'https://bridge.test/kyc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );

    const bridge = await import('./bridge.js');
    await expect(bridge.createCustomer({ email: 'no-kyc@example.com', name: 'No KYC' })).resolves.toEqual({
      customerId: 'cus_live_no_kyc_prompt',
      kycUrl: null,
    });
  });
});

describe('Bridge adapter demo-mode guardrails', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
    };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('still accepts unsigned webhooks in pure demo mode', async () => {
    const bridge = await import('./bridge.js');
    expect(bridge.verifyWebhook(null, '{"type":"funds.received"}')).toBe(true);
  });
});

describe('Bridge adapter production-disabled guardrails', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      DEMO_MODE: '0',
      ALLOW_DEMO_IN_PRODUCTION: '0',
      JWT_SECRET: 'production-test-secret-with-enough-length',
      NEXA_AGENT_KEYS: 'nx_live_production_test_key',
      PRIVY_APP_ID: 'privy-app-test',
      PRIVY_APP_SECRET: 'privy-secret-test',
      // Wave2 fail-closed core: production non-demo requires persistence URLs
      // at env parse time. Inert strings — nothing connects during import.
      DATABASE_URL: 'postgresql://maze:pw@localhost:5432/maze',
      REDIS_URL: 'redis://localhost:6379/9',
    };
    delete process.env.BRIDGE_API_KEY;
    delete process.env.BRIDGE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('rejects unsigned webhooks outside demo mode even when Bridge is disabled', async () => {
    const bridge = await import('./bridge.js');
    expect(bridge.verifyWebhook(null, '{"type":"funds.received"}')).toBe(false);
  });
});

describe('Bridge live-mode routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream rejected', { status: 502 })),
    );
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      BRIDGE_API_KEY: 'bridge_test_key',
      BRIDGE_API_BASE: 'https://bridge.test',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function postJson(
    app: { request: (path: string, init?: RequestInit) => Promise<Response> },
    path: string,
    body: unknown,
    token?: string,
    extraHeaders?: Record<string, string>,
  ) {
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('returns structured 502 when virtual-account customer provisioning fails', { timeout: 30_000 }, async () => {
    const { app } = await import('../../index.js');

    const start = await postJson(app, '/auth/start', { email: 'bridge-live-route@example.com' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body.challengeId,
      code: '482019',
    });

    const res = await postJson(
      app,
      '/bridge/virtual-account',
      { currency: 'USD' },
      verify.body.token,
    );

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'bridge_customer_failed', message: 'bridge_customer_failed' },
    });
  });

  it('allows live bank payout rails before KYC approval', { timeout: 30_000 }, async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/v0/customers')) {
        return new Response(JSON.stringify({ id: 'cus_live_kyc_gate', kyc_link: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.endsWith('/external_accounts')) {
        return new Response(JSON.stringify({ id: 'ea_live_kyc_gate' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.endsWith('/v0/transfers')) {
        return new Response(JSON.stringify({ id: 'transfer_live_kyc_gate' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const { app } = await import('../../index.js');

    const start = await postJson(app, '/auth/start', { email: 'bridge-kyc-gate@example.com' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body.challengeId,
      code: '482019',
    });
    const token = verify.body.token as string;

    const method = await postJson(
      app,
      '/bridge/payout-method',
      { type: 'ach', label: 'Primary', accountDetails: { routing: '101019644', account: '8841294078' } },
      token,
    );
    expect(method.status).toBe(200);

    await postJson(app, '/kyc/start', {}, token);

    const createWhilePending = await postJson(
      app,
      '/bridge/payout-method',
      { type: 'ach', label: 'Secondary', accountDetails: { routing: '101019644', account: '8841294078' } },
      token,
    );
    expect(createWhilePending.status).toBe(200);
    expect(createWhilePending.body.method.externalAccountId).toBe('ea_live_kyc_gate');

    const withdrawWhilePending = await postJson(
      app,
      '/bridge/withdraw',
      { payoutMethodId: method.body.method.id, amountUsd: 25 },
      token,
      { 'Idempotency-Key': 'withdraw-live-kyc-gate-1' },
    );
    expect(withdrawWhilePending.status).toBe(200);
    expect(withdrawWhilePending.body.transfer.externalRef).toBe('transfer_live_kyc_gate');
  });
});

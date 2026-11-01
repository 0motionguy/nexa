/**
 * NEXA API integration suite — boots the real Hono app on an ephemeral Node
 * port (the MCP transport needs raw req/res, so app.request() isn't enough)
 * and exercises REST + policy engine + MCP over Streamable HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from './index.js';
import { store } from './store/index.js';

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
const EMAIL = 'tester@example.com';

describe('health + auth', () => {
  it('healthz returns ok:true (Caddy contract)', async () => {
    const { status, body } = await json('/healthz');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // Realtime section is non-fatal — when REALTIME_HUB_V1 is off (the test
    // default) it must surface `disabled: true` rather than crash or omit.
    expect(body.realtime).toBeDefined();
    expect(body.realtime.disabled).toBe(true);
  });

  it('allows the live preview host through CORS', async () => {
    const res = await fetch(base + '/healthz', {
      headers: { Origin: 'https://maze.aiso.tools' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://maze.aiso.tools');
  });

  it('otp flow: start → bad code rejected → good code issues token', async () => {
    const start = await json('/auth/start', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(start.status).toBe(200);
    const challengeId = start.body.challengeId as string;

    const bad = await json('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, code: '000000' }),
    });
    expect(bad.status).toBe(400);

    const start2 = await json('/auth/start', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL }),
    });
    const good = await json('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: start2.body.challengeId, code: '482019' }),
    });
    expect(good.status).toBe(200);
    expect(good.body.token).toBeTruthy();
    token = good.body.token;
  });

  it('me returns seeded balance', async () => {
    const { status, body } = await json('/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(body.balance.balUsd).toBe(4820.4);
    expect(body.balance.earnUsd).toBe(3200);
  });

  it('ledger me exposes the cached Base receive wallet', async () => {
    const me = await json('/auth/me', { headers: authed() });
    await store.setPrivyWallet(me.body.user.id, 'wallet_receive_test', '0x1111111111111111111111111111111111111111');
    const { status, body } = await json('/ledger/me', { headers: authed() });
    expect(status).toBe(200);
    expect(body.wallet.baseAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('rejects missing token', async () => {
    const { status } = await json('/ledger/balance');
    expect(status).toBe(401);
  });
});

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('money movement', () => {
  it('send to email flags claim + decrements balance', async () => {
    const { status, body } = await json('/payments/send', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 20, to: 'bob@x.com' }),
    });
    expect(status).toBe(200);
    expect(body.claim).toBe(true);
    expect(body.balUsd).toBe(4800.4);
  });

  it('send above balance is rejected', async () => {
    const { status, body } = await json('/payments/send', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 99999, to: 'bob@x.com' }),
    });
    expect(status).toBe(400);
    // Sprint 10 Phase 2 ε — structured error shape via the global normalizer.
    // PolicyError('insufficient_funds') is surfaced as a `bad_request` ApiError
    // with the policy code carried in `details.policyCode`.
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.details.policyCode).toBe('insufficient_funds');
  });

  it('rejects bearer tokens in query strings on mutating routes', async () => {
    const { status, body } = await json(`/payments/topup?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({ amountUsd: 10 }),
    });
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('request-link emits one-time url', async () => {
    const { body } = await json('/payments/request-link', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 75, note: 'Edit for launch video' }),
    });
    expect(body.url).toMatch(/^https:\/\/maze\.to\/pay\//);
    expect(body.oneTime).toBe(true);
  });

  it('earn deposit + withdraw round-trips', async () => {
    const dep = await json('/earn/deposit', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 500 }),
    });
    expect(dep.body.earnUsd).toBe(3700);

    const wd = await json('/earn/withdraw', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 500 }),
    });
    expect(wd.body.earnUsd).toBe(3200);
  });

  it('swap quotes at mid-market', async () => {
    const q = await json('/swap/quote?amount=500&direction=usd-eur', { headers: authed() });
    expect(q.body.out).toBeCloseTo(460);
    const ex = await json('/swap/execute', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amount: 500, direction: 'usd-eur' }),
    });
    expect(ex.body.out).toBeCloseTo(460);
    expect(ex.body.balUsd).toBeCloseTo(4300.4);
  });

  it('rejects invalid query parameters', async () => {
    const activity = await json('/ledger/activity?limit=-1', { headers: authed() });
    expect(activity.status).toBe(400);
    // F062 — ledger.ts migrated to ApiError; code is in error.message.
    expect(activity.body.error.message).toBe('invalid_limit');

    const quote = await json('/swap/quote?amount=-500&direction=usd-eur', { headers: authed() });
    expect(quote.status).toBe(400);
    // Sprint 17 F062 — earn.ts migrated to ApiError; code is in error.message.
    expect(quote.body.error.message).toBe('invalid_amount');

    const invalidSolana = await json('/swap/quote?amount=10&fromChain=solana&toChain=base&fromToken=EURe&toToken=USDC', { headers: authed() });
    expect(invalidSolana.status).toBe(400);
    expect(invalidSolana.body.error.message).toBe('invalid_swap_route');
  });

  it('activity feed records the moves', async () => {
    const { body } = await json('/ledger/activity', { headers: authed() });
    const titles = body.activity.map((a: { n: string }) => a.n);
    expect(titles).toContain('Sent · bob@x.com');
    expect(titles).toContain('Moved to Earn');
  });

  it('monthly spend is derived from real spending activity', async () => {
    const user = await store.upsertUserByEmail(`spend-${Date.now()}@example.com`, 'Spender');
    await store.pushActivity(user, { n: 'Card coffee', s: 'CARD · JUST NOW', a: '−$12.34', k: 'card' });
    await store.pushActivity(user, { n: 'Agent call', s: 'AGENT · JUST NOW', a: '-$0.66', k: 'x402' });
    await store.pushActivity(user, { n: 'Incoming', s: 'ACH · JUST NOW', a: '+$100.00', k: 'in', pos: true });
    const start = await json('/auth/start', {
      method: 'POST',
      body: JSON.stringify({ email: user.email }),
    });
    const auth = await json('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
    });

    const { status, body } = await json('/spend/monthly', {
      headers: { authorization: `Bearer ${auth.body.token}` },
    });
    expect(status).toBe(200);
    expect(body.totalUsd).toBeCloseTo(13);
    expect(body.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'card', totalUsd: 12.34 }),
        expect.objectContaining({ key: 'agent', totalUsd: 0.66 }),
      ]),
    );
  });
});

describe('card', () => {
  it('freeze + limit persist', async () => {
    await json('/card/freeze', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ frozen: true }),
    });
    const { body } = await json('/card', { headers: authed() });
    expect(body.card.frozen).toBe(true);

    const lim = await json('/card/limit', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ dayLimitUsd: 750 }),
    });
    expect(lim.body.dayLimitUsd).toBe(750);
  });
});

describe('agents + policy engine', () => {
  let agentId = '';

  it('lists seeded agents', async () => {
    const { body } = await json('/agent', { headers: authed() });
    expect(body.agents.length).toBeGreaterThanOrEqual(2);
    const research = body.agents.find((a: { name: string }) => a.name === 'ResearchBot-01');
    expect(research.policy.endpointAllowlist).toContain('api.exa.ai');
    agentId = research.id;
  });

  it('funds an agent from the main balance', async () => {
    const { body } = await json(`/agent/${agentId}/fund`, {
      method: 'POST',
      headers: { ...authed(), 'Idempotency-Key': 'api-spec-agent-fund-1' },
      body: JSON.stringify({ amountUsd: 50 }),
    });
    expect(body.ok).toBe(true);
    expect(body.agent.balanceUsd).toBeGreaterThanOrEqual(50);
    expect(body.agent.spentTodayUsd).toBe(13.2);
    expect(body.agent.policy.perDayCapUsd).toBe(50);
  });

  it('does not approve one-off payments while the agent is paused', async () => {
    await json(`/agent/${agentId}/pause`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ paused: true }),
    });
    const { status, body } = await json(`/agent/${agentId}/approve-once`, {
      method: 'POST',
      headers: { ...authed(), 'Idempotency-Key': 'api-spec-agent-approve-paused-1' },
      body: JSON.stringify({
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.2,
        reason: 'manual approval test',
      }),
    });
    expect(status).toBe(400);
    // F062 — agent.ts migrated PolicyError to ApiError; the policy code now
    // surfaces inside error.details rather than as the raw error string.
    expect(body.error.details.policyCode).toBe('agent_paused');
  });

  it('creates an agent with default-deny allowlist', async () => {
    const { status, body } = await json('/agent/create', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ name: 'TestAgent-99', perDayCapUsd: 5, perTxCapUsd: 0.5 }),
    });
    expect(status).toBe(201);
    expect(body.agent.state).toBe('ready');
    expect(body.agent.policy.endpointAllowlist).toEqual([]);
  });
});

describe('x402 client (agent key) — the policy gate', () => {
  const key = { 'x-nexa-key': 'nx_live_7f3k_demo' };

  it('rejects bad key', async () => {
    const { status } = await json('/x402/pay', {
      method: 'POST',
      headers: { 'x-nexa-key': 'nx_live_wrong' },
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.12,
        reason: 'market data',
      }),
    });
    expect(status).toBe(401);
  });

  it('pays an allowlisted endpoint within caps', async () => {
    const { status, body } = await json('/x402/pay', {
      method: 'POST',
      headers: key,
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.12,
        reason: 'market data',
      }),
    });
    expect(status).toBe(200);
    expect(body.receipt.httpStatus).toBe(200);
    expect(body.receipt.buyerType).toBe('agent');
  });

  it('settle is the documented alias for agent-key payment', async () => {
    const { status, body } = await json('/x402/settle', {
      method: 'POST',
      headers: key,
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.12,
        reason: 'market data',
      }),
    });
    expect(status).toBe(200);
    expect(body.receipt.httpStatus).toBe(200);
  });

  it('quotes a merchant contract by resource path', async () => {
    const { status, body } = await json('/x402/quote?resource=/v1/clip-analytics', {
      headers: authed(),
    });
    expect(status).toBe(200);
    expect(body.quote.resource).toBe('/v1/clip-analytics');
    expect(body.quote.amountUsd).toBe(0.003);
    expect(body.quote.currency).toBe('USDC');
  });

  it('blocks endpoints not on the allowlist', async () => {
    const { status, body } = await json('/x402/pay', {
      method: 'POST',
      headers: key,
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'dataset.vendor.io/v1/dump',
        amountUsd: 0.5,
        reason: 'dataset',
      }),
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe('endpoint_not_allowed');
  });

  it('402s payments above the per-tx cap (needs approval)', async () => {
    // ResearchBot-01 seed: perTxCap=1, humanApprovalThreshold=1. The Phase 3
    // threshold check fires first when amount > threshold, so this 402 maps to
    // `needs_human_approval` (a distinct UI signal from per-tx-cap overflow).
    const { status, body } = await json('/x402/pay', {
      method: 'POST',
      headers: key,
      body: JSON.stringify({
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 2.4,
        reason: 'dataset access',
      }),
    });
    expect(status).toBe(402);
    expect(body.error.code).toBe('needs_human_approval');
  });
});

describe('MCP over Streamable HTTP', () => {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-nexa-key': 'nx_live_7f3k_demo',
  };

  async function rpc(method: string, params: unknown, id = 1): Promise<any> {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  it('rejects missing key', async () => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('initializes and lists the agent + facilitator tools', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    });
    expect(init.result.serverInfo.name).toBe('nexa');

    const tools = await rpc('tools/list', {}, 2);
    const names = tools.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      'create_offer',
      'create_payout',
      'get_balance',
      'get_payments',
      'get_policy',
      'list_agents',
      'pay_endpoint',
      'request_funds',
      'split_revenue',
      'transfer',
    ]);
  });

  it('get_balance returns human + agent budgets', async () => {
    const out = await rpc(
      'tools/call',
      { name: 'get_balance', arguments: {} },
      3,
    );
    expect(out.result.content[0].text).toContain('Human balance');
    expect(out.result.content[0].text).toContain('ResearchBot-01');
  });

  it('pay_endpoint enforces policy through MCP too', async () => {
    const blocked = await rpc(
      'tools/call',
      {
        name: 'pay_endpoint',
        arguments: {
          agent: 'ResearchBot-01',
          endpoint: 'evil.example.com/dump',
          amountUsd: 0.1,
          reason: 'test',
        },
      },
      4,
    );
    expect(blocked.result.isError).toBe(true);
    expect(blocked.result.content[0].text).toContain('endpoint_not_allowed');

    const ok = await rpc(
      'tools/call',
      {
        name: 'pay_endpoint',
        arguments: {
          agent: 'ResearchBot-01',
          endpoint: 'weather.api/v1/daily',
          amountUsd: 0.002,
          reason: 'forecast pull',
        },
      },
      5,
    );
    expect(ok.result.isError).toBeUndefined();
    expect(ok.result.content[0].text).toContain('200 OK');
  });

  it('transfer to-agent is default-deny; to-human executes', async () => {
    const deny = await rpc(
      'tools/call',
      {
        name: 'transfer',
        arguments: { agent: 'ResearchBot-01', amountUsd: 10, direction: 'to-agent' },
      },
      6,
    );
    expect(deny.result.isError).toBe(true);

    const give = await rpc(
      'tools/call',
      {
        name: 'transfer',
        arguments: { agent: 'ResearchBot-01', amountUsd: 1, direction: 'to-human' },
      },
      7,
    );
    expect(give.result.content[0].text).toContain('Returned $1.00');
  });
});

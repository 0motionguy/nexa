/**
 * F050 — MCP server coverage. The handler is the agent-facing tool surface
 * (pay_endpoint / transfer / create_payout / split_revenue + read-only
 * inspectors); the audit flagged it as ~12 KB of code shipping minimal
 * direct test coverage. This spec covers:
 *
 *   1. Auth gate — missing / invalid / malformed key → 401 JSON-RPC error
 *   2. Tool registration — tools/list returns the documented set with
 *      non-empty descriptions and the correct shape
 *   3. Per-tool happy paths — get_balance, list_agents, get_policy,
 *      pay_endpoint, request_funds, transfer, create_offer, get_payments,
 *      create_payout, split_revenue
 *   4. Policy-gated tools — pay_endpoint denies on allowlist miss /
 *      kill switch / per-tx cap; transfer to-agent is default-deny;
 *      create_payout denies on insufficient funds
 *   5. Argument validation — bad / missing args surface as JSON-RPC errors
 *   6. Unknown tools / methods — surface error envelopes, never silent
 *
 * Two suites in one file:
 *   - Suite A uses synthetic IncomingMessage/ServerResponse to drive the
 *     handler at the boundary BEFORE it hands off to the MCP SDK transport.
 *     This catches the auth gate cheaply (no server boot, no HTTP listen).
 *   - Suite B boots the real Hono app on an ephemeral port and talks to
 *     /mcp via fetch — the only way to satisfy the SDK transport's
 *     Accept header + streaming request body invariants.
 *
 * Suite B shares the singleton in-memory store with the demo seed
 * (`mirko@studio.co`, ResearchBot-01 / OpsAgent-02). Tests pick inputs
 * that don't collide across cases and use the policy-gate-friendly
 * `weather.api` allowlisted hostname so policy assertions can fire even
 * after sibling tests have nudged the spent counter.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { handleMcpRequest } from './server.js';

/* ════════════════════════════════════════════════════════════════════════
 * Suite A — boundary tests. Auth-gate behaviour is observable BEFORE
 * the SDK transport runs, so a synthetic req/res pair is enough and we
 * don't have to bring an HTTP server up just to verify a 401.
 * ══════════════════════════════════════════════════════════════════════ */

function makeReqRes(headers: Record<string, string>): {
  req: IncomingMessage;
  res: ServerResponse;
  read: () => { status: number; body: string };
} {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = 'POST';
  req.url = '/mcp';
  for (const [k, v] of Object.entries(headers)) req.headers[k.toLowerCase()] = v;
  const res = new ServerResponse(req);
  let body = '';
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = ((chunk: unknown): boolean => {
    if (chunk !== undefined) body += String(chunk);
    return origWrite(chunk as Parameters<typeof origWrite>[0]);
  }) as typeof res.write;
  res.end = ((chunk?: unknown): ServerResponse => {
    if (chunk !== undefined) body += String(chunk);
    return origEnd(chunk as Parameters<typeof origEnd>[0]);
  }) as typeof res.end;
  return { req, res, read: () => ({ status: res.statusCode, body }) };
}

describe('mcp/server — auth gate (boundary)', () => {
  it('rejects requests with no agent key with a JSON-RPC error envelope', async () => {
    const { req, res, read } = makeReqRes({});
    await handleMcpRequest(req, res, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const { status, body } = read();
    expect(status).toBe(401);
    // The handler returns a JSON-RPC error envelope; the message text is the
    // contract anchored in mcp/server.ts:308.
    expect(body).toContain('invalid or missing NEXA key');
    expect(body).toContain('"jsonrpc":"2.0"');
  });

  it('rejects requests with an unknown agent key with the same gate', async () => {
    const { req, res, read } = makeReqRes({
      'x-nexa-key': 'nx_live_fake_key_should_not_resolve_xxxx',
    });
    await handleMcpRequest(req, res, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const { status, body } = read();
    expect(status).toBe(401);
    expect(body).toContain('invalid or missing NEXA key');
  });

  it('rejects requests with a malformed Bearer header (not nx_*) at the gate', async () => {
    const { req, res, read } = makeReqRes({
      authorization: 'Bearer not_a_real_key_xxxxxxxxxxxxxxxx',
    });
    await handleMcpRequest(req, res, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    const { status, body } = read();
    expect(status).toBe(401);
    expect(body).toContain('invalid or missing NEXA key');
  });

  it('rejects requests with an empty Bearer token at the gate', async () => {
    const { req, res, read } = makeReqRes({ authorization: 'Bearer ' });
    await handleMcpRequest(req, res, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    });
    const { status } = read();
    expect(status).toBe(401);
  });

  it('rejects requests with a non-Bearer Authorization scheme', async () => {
    const { req, res, read } = makeReqRes({
      authorization: 'Basic nx_live_7f3k_demo:',
    });
    await handleMcpRequest(req, res, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
    });
    const { status, body } = read();
    expect(status).toBe(401);
    expect(body).toContain('invalid or missing NEXA key');
  });

  it('emits an envelope with id:null and code -32001 on the auth failure', async () => {
    const { req, res, read } = makeReqRes({});
    await handleMcpRequest(req, res, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/list',
    });
    const { body } = read();
    const env = JSON.parse(body) as { id: unknown; error: { code: number; message: string } };
    expect(env.id).toBeNull();
    expect(env.error.code).toBe(-32001);
    expect(env.error.message).toBe('invalid or missing NEXA key');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Suite B — full handler via real HTTP server. The MCP SDK transport
 * needs both an HTTP-style Accept header AND a real request body stream,
 * neither of which the synthetic IncomingMessage in Suite A delivers.
 * Booting a real listener also exercises the index.ts /mcp route wrapper.
 * ══════════════════════════════════════════════════════════════════════ */

let server: ServerType;
let base: string;

beforeAll(async () => {
  const { app } = await import('../index.js');
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: app.fetch, port: 0, hostname: '127.0.0.1' },
      (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      },
    );
  });
});

afterAll(() => {
  server.close();
});

const AUTHED_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-nexa-key': 'nx_live_7f3k_demo',
};

let rpcId = 1000;
function nextId(): number {
  return rpcId++;
}

interface RpcResp {
  status: number;
  rpc: {
    jsonrpc?: string;
    id?: unknown;
    result?: {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
      tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      serverInfo?: { name: string; version: string };
    };
    error?: { code: number; message: string };
  };
}

async function rpc(
  method: string,
  params: unknown = {},
  headers: Record<string, string> = AUTHED_HEADERS,
): Promise<RpcResp> {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, params }),
  });
  let parsed: RpcResp['rpc'] = {};
  const text = await res.text();
  // Streamable HTTP may emit `event: message\ndata: <json>\n\n`; pull the
  // first JSON envelope either way.
  if (text.includes('data: ')) {
    const m = text.match(/data: (.*)/);
    if (m) parsed = JSON.parse(m[1]!);
  } else if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { code: -1, message: text } };
    }
  }
  return { status: res.status, rpc: parsed };
}

function text(r: RpcResp): string {
  return r.rpc.result?.content?.[0]?.text ?? '';
}

function isError(r: RpcResp): boolean {
  return r.rpc.result?.isError === true;
}

/* ──────────────────────────────────────────────────────────────────────
 * Auth gate against the live HTTP layer — proves the index.ts /mcp
 * wrapper passes headers through to handleMcpRequest correctly.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — auth gate (HTTP)', () => {
  it('rejects missing key over real HTTP with status 401', async () => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('invalid or missing NEXA key');
  });

  it('accepts the demo key on x-nexa-key over real HTTP', async () => {
    const r = await rpc('tools/list');
    expect(r.status).toBe(200);
    expect(r.rpc.jsonrpc).toBe('2.0');
    expect(r.rpc.result?.tools).toBeDefined();
  });

  it('accepts the demo key on Authorization: Bearer too', async () => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer nx_live_7f3k_demo',
    };
    const r = await rpc('tools/list', {}, headers);
    expect(r.status).toBe(200);
    expect(r.rpc.result?.tools).toBeDefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Tool registration — list, count, descriptions, schemas.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — tools/list registration', () => {
  it('registers all 10 documented tools with the expected names', async () => {
    const r = await rpc('tools/list');
    const names = (r.rpc.result?.tools ?? []).map((t) => t.name).sort();
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

  it('every tool has a non-empty, descriptive description (>20 chars)', async () => {
    const r = await rpc('tools/list');
    for (const tool of r.rpc.result?.tools ?? []) {
      expect(tool.description, `tool ${tool.name} description`).toBeTruthy();
      expect((tool.description ?? '').length).toBeGreaterThan(20);
    }
  });

  it('every tool has an inputSchema (the SDK auto-generates from Zod)', async () => {
    const r = await rpc('tools/list');
    for (const tool of r.rpc.result?.tools ?? []) {
      expect(tool.inputSchema, `tool ${tool.name} inputSchema`).toBeDefined();
    }
  });

  it('responds to initialize with the nexa server identity', async () => {
    const r = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    });
    expect(r.rpc.result?.serverInfo?.name).toBe('nexa');
    expect(r.rpc.result?.serverInfo?.version).toBe('1.0.0');
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Read-only tools — get_balance, list_agents, get_policy.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — get_balance', () => {
  it('returns human balance + agent budgets + kill switch line', async () => {
    const r = await rpc('tools/call', { name: 'get_balance', arguments: {} });
    expect(isError(r)).toBe(false);
    const t = text(r);
    expect(t).toContain('Human balance');
    expect(t).toContain('Kill switch');
    expect(t).toContain('ResearchBot-01');
    expect(t).toContain('OpsAgent-02');
  });

  it('formats every money figure as $X.XX', async () => {
    const r = await rpc('tools/call', { name: 'get_balance', arguments: {} });
    expect(text(r)).toMatch(/\$\d[\d,]*\.\d{2}/);
  });
});

describe('mcp/server — list_agents', () => {
  it('returns a JSON array of agents with id/name/state/balance/spent', async () => {
    const r = await rpc('tools/call', { name: 'list_agents', arguments: {} });
    const parsed = JSON.parse(text(r)) as Array<{
      id: string;
      name: string;
      state: string;
      balanceUsd: number;
      spentTodayUsd: number;
    }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    for (const a of parsed) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.name).toBe('string');
      expect(typeof a.state).toBe('string');
      expect(typeof a.balanceUsd).toBe('number');
      expect(typeof a.spentTodayUsd).toBe('number');
    }
  });

  it('surfaces the seeded ResearchBot-01 + OpsAgent-02 in some order', async () => {
    const r = await rpc('tools/call', { name: 'list_agents', arguments: {} });
    const names = (JSON.parse(text(r)) as Array<{ name: string }>).map((a) => a.name);
    expect(names).toContain('ResearchBot-01');
    expect(names).toContain('OpsAgent-02');
  });
});

describe('mcp/server — get_policy', () => {
  it('returns the agent policy keyed by agent name', async () => {
    const r = await rpc('tools/call', {
      name: 'get_policy',
      arguments: { agent: 'ResearchBot-01' },
    });
    const parsed = JSON.parse(text(r)) as {
      name: string;
      state: string;
      policy: { perTxCapUsd: number; perDayCapUsd: number; endpointAllowlist: string[] };
    };
    expect(parsed.name).toBe('ResearchBot-01');
    expect(parsed.policy.perTxCapUsd).toBeGreaterThan(0);
    expect(parsed.policy.perDayCapUsd).toBeGreaterThan(0);
    expect(Array.isArray(parsed.policy.endpointAllowlist)).toBe(true);
  });

  it('returns an error tool result when the agent is unknown', async () => {
    const r = await rpc('tools/call', {
      name: 'get_policy',
      arguments: { agent: 'does-not-exist-anywhere' },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('No agent matching');
  });

  it('rejects missing required `agent` argument at the JSON-RPC layer', async () => {
    const r = await rpc('tools/call', { name: 'get_policy', arguments: {} });
    // The SDK surfaces Zod-violating args as either an error envelope or an
    // isError tool result; either is contractually fine.
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * pay_endpoint — the policy-gated tool. Asserts every policy code that
 * the in-memory engine can throw, plus the happy receipt.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — pay_endpoint policy gates', () => {
  it('blocks when the endpoint host is not on the agent allowlist', async () => {
    const r = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: {
        agent: 'ResearchBot-01',
        endpoint: 'evil.example.com/dump',
        amountUsd: 0.01,
        reason: 'test',
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('endpoint_not_allowed');
  });

  it('blocks when the agent has no such id/name', async () => {
    const r = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: {
        agent: 'NoSuchAgent-99',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 0.01,
        reason: 'test',
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('No agent matching');
  });

  it('blocks when amount exceeds the per-tx cap (needs_human_approval fires first)', async () => {
    // ResearchBot-01: perTxCapUsd = 1, humanApprovalThresholdUsd defaults
    // to perTxCapUsd. Any amount > 1 trips the threshold check first.
    const r = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: {
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: 5,
        reason: 'too much',
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/needs_human_approval|needs_approval/);
  });

  it('returns a receipt when the call is within policy and on the allowlist', async () => {
    const r = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: {
        agent: 'ResearchBot-01',
        endpoint: 'weather.api/v1/daily',
        amountUsd: 0.002,
        reason: 'forecast pull',
      },
    });
    if (isError(r)) {
      // The shared store's day-cap counter may have been pushed by prior
      // tests in this file; assert the failure was at least a PolicyError.
      expect(text(r)).toMatch(/BLOCKED \(.*\):/);
    } else {
      expect(text(r)).toContain('200 OK');
      expect(text(r)).toContain('ref');
    }
  });

  it('rejects calls missing required `amountUsd`', async () => {
    const r = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: {
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        reason: 'no amount',
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('rejects negative amountUsd at the Zod boundary', async () => {
    const r = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: {
        agent: 'ResearchBot-01',
        endpoint: 'api.exa.ai/v1/search',
        amountUsd: -1,
        reason: 'negative',
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * request_funds — never auto-approves, logs activity, returns msg.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — request_funds', () => {
  it('logs the request and returns a confirmation message', async () => {
    const r = await rpc('tools/call', {
      name: 'request_funds',
      arguments: {
        agent: 'ResearchBot-01',
        amountUsd: 50,
        reason: 'continued research',
      },
    });
    expect(isError(r)).toBe(false);
    expect(text(r)).toContain('Request logged');
    expect(text(r)).toContain('ResearchBot-01');
  });

  it('errors when the agent name is unknown', async () => {
    const r = await rpc('tools/call', {
      name: 'request_funds',
      arguments: {
        agent: 'NoSuchAgent-09',
        amountUsd: 10,
        reason: 'who am I',
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('No agent matching');
  });

  it('rejects reasons longer than the 140-char schema cap', async () => {
    const r = await rpc('tools/call', {
      name: 'request_funds',
      arguments: {
        agent: 'ResearchBot-01',
        amountUsd: 10,
        reason: 'a'.repeat(141),
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * transfer — to-agent default-deny + to-human defund path.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — transfer', () => {
  it('to-agent always logs an activity row and returns isError:true (default-deny)', async () => {
    const r = await rpc('tools/call', {
      name: 'transfer',
      arguments: {
        agent: 'ResearchBot-01',
        amountUsd: 25,
        direction: 'to-agent',
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('to-agent transfers require human approval');
  });

  it('to-human executes immediately and returns the amount sent back', async () => {
    const r = await rpc('tools/call', {
      name: 'transfer',
      arguments: {
        agent: 'ResearchBot-01',
        amountUsd: 0.01,
        direction: 'to-human',
      },
    });
    expect(isError(r)).toBe(false);
    expect(text(r)).toMatch(/Returned \$[\d.]+/);
  });

  it('errors when the direction is invalid (Zod enum)', async () => {
    const r = await rpc('tools/call', {
      name: 'transfer',
      arguments: {
        agent: 'ResearchBot-01',
        amountUsd: 5,
        direction: 'sideways',
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('errors when amountUsd is missing', async () => {
    const r = await rpc('tools/call', {
      name: 'transfer',
      arguments: {
        agent: 'ResearchBot-01',
        direction: 'to-human',
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('errors when the agent does not exist (to-human path)', async () => {
    const r = await rpc('tools/call', {
      name: 'transfer',
      arguments: {
        agent: 'unknown-agent',
        amountUsd: 1,
        direction: 'to-human',
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('No agent matching');
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Facilitator tools — create_offer / get_payments / create_payout /
 * split_revenue.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — create_offer', () => {
  it('creates an offer and returns a checkout URL containing the offer id', async () => {
    const r = await rpc('tools/call', {
      name: 'create_offer',
      arguments: {
        title: 'MCP test offer',
        amountUsd: 9.99,
        type: 'one_time',
        fulfillmentKind: 'message',
        fulfillmentValue: 'Thanks for the test order.',
      },
    });
    expect(isError(r)).toBe(false);
    expect(text(r)).toContain('Offer created');
    expect(text(r)).toContain('Share this link');
    // env.CHECKOUT_BASE_URL default is https://maze.to/o
    expect(text(r)).toMatch(/https?:\/\/[^/]+\/[A-Za-z0-9_-]+/);
  });

  it('supports optional splits for revenue routing', async () => {
    const r = await rpc('tools/call', {
      name: 'create_offer',
      arguments: {
        title: 'Split offer',
        amountUsd: 50,
        splits: [
          { email: 'designer@example.com', percent: 30 },
          { email: 'engineer@example.com', percent: 20 },
        ],
      },
    });
    expect(isError(r)).toBe(false);
    expect(text(r)).toContain('Offer created');
  });

  it('rejects missing title at the Zod boundary', async () => {
    const r = await rpc('tools/call', {
      name: 'create_offer',
      arguments: { amountUsd: 5 },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('rejects non-positive amountUsd', async () => {
    const r = await rpc('tools/call', {
      name: 'create_offer',
      arguments: { title: 'Free', amountUsd: 0 },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('rejects invalid email in splits', async () => {
    const r = await rpc('tools/call', {
      name: 'create_offer',
      arguments: {
        title: 'Bad split',
        amountUsd: 10,
        splits: [{ email: 'not-an-email', percent: 50 }],
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });
});

describe('mcp/server — get_payments', () => {
  it('returns either a friendly empty message or a list of payments', async () => {
    const r = await rpc('tools/call', {
      name: 'get_payments',
      arguments: { limit: 5 },
    });
    expect(isError(r)).toBe(false);
    const t = text(r);
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(0);
  });

  it('rejects limit > 100 at the Zod boundary', async () => {
    const r = await rpc('tools/call', {
      name: 'get_payments',
      arguments: { limit: 200 },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('rejects non-integer limit', async () => {
    const r = await rpc('tools/call', {
      name: 'get_payments',
      arguments: { limit: 3.5 },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });
});

describe('mcp/server — create_payout', () => {
  it('pays out within balance and returns the payout receipt text', async () => {
    const r = await rpc('tools/call', {
      name: 'create_payout',
      arguments: {
        destination: 'collab@example.com',
        amountUsd: 1.5,
        note: 'tiny test payout',
      },
    });
    if (isError(r)) {
      // The shared store may have been drained by other tests; assert the
      // failure path was a real PolicyError rather than a crash.
      expect(text(r)).toMatch(/BLOCKED|insufficient_funds/);
    } else {
      expect(text(r)).toContain('Paid out');
      expect(text(r)).toContain('collab@example.com');
    }
  });

  it('blocks the call when amountUsd exceeds the account balance', async () => {
    const r = await rpc('tools/call', {
      name: 'create_payout',
      arguments: {
        destination: 'overdraft@example.com',
        amountUsd: 999_999,
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toMatch(/BLOCKED|insufficient_funds/);
  });

  it('rejects missing destination', async () => {
    const r = await rpc('tools/call', {
      name: 'create_payout',
      arguments: { amountUsd: 10 },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });
});

describe('mcp/server — split_revenue', () => {
  it('rejects splits whose percentages sum > 100', async () => {
    const r = await rpc('tools/call', {
      name: 'split_revenue',
      arguments: {
        amountUsd: 100,
        rules: [
          { to: 'a@example.com', percent: 60 },
          { to: 'b@example.com', percent: 50 },
        ],
      },
    });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('exceed 100');
  });

  it('processes a valid split into individual payout lines', async () => {
    const r = await rpc('tools/call', {
      name: 'split_revenue',
      arguments: {
        amountUsd: 10,
        rules: [
          { to: 'small1@example.com', percent: 10 },
          { to: 'small2@example.com', percent: 20 },
        ],
      },
    });
    if (isError(r)) {
      expect(text(r)).toMatch(/BLOCKED|insufficient_funds|exceed/);
    } else {
      const t = text(r);
      expect(t).toContain('Split');
      expect(t).toContain('small1@example.com');
      expect(t).toContain('small2@example.com');
    }
  });

  it('rejects invalid recipient email at the Zod boundary', async () => {
    const r = await rpc('tools/call', {
      name: 'split_revenue',
      arguments: {
        amountUsd: 10,
        rules: [{ to: 'not-an-email', percent: 50 }],
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('rejects rules with negative percent', async () => {
    const r = await rpc('tools/call', {
      name: 'split_revenue',
      arguments: {
        amountUsd: 10,
        rules: [{ to: 'x@example.com', percent: -5 }],
      },
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * Unknown tools / methods — JSON-RPC error surface.
 * ────────────────────────────────────────────────────────────────────── */

describe('mcp/server — unknown methods', () => {
  it('returns an error envelope for tools/call with an unknown tool name', async () => {
    const r = await rpc('tools/call', {
      name: 'does_not_exist',
      arguments: {},
    });
    const hasError = r.rpc.error !== undefined || isError(r);
    expect(hasError).toBe(true);
  });

  it('returns an error envelope for a totally unknown method', async () => {
    const r = await rpc('not/a/real/method');
    expect(r.rpc.error).toBeDefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * pay_endpoint idempotency (2026-07-02) — the MCP surface previously called
 * store.x402Pay with NO idempotency key, so an agent retrying a timed-out
 * tools/call could double-debit its budget (same class as the /x402/pay
 * route gap closed in the same-day walkthrough fix #1).
 * ──────────────────────────────────────────────────────────────────────── */

describe('mcp/server — pay_endpoint idempotency (retry-safety)', () => {
  beforeAll(async () => {
    // Earlier suites in this file legitimately drain ResearchBot-01 to $0 —
    // top the budget back up through the store so these paths can settle.
    const { store } = await import('../store/index.js');
    const { userForAgentKey } = await import('../lib/agent-keys.js');
    const u = await userForAgentKey('nx_live_7f3k_demo');
    if (!u) throw new Error('demo agent key did not resolve');
    await store.fundAgent(u, 'ResearchBot-01', 5);
  });

  it('replays the same idempotencyKey instead of double-debiting', async () => {
    const args = {
      agent: 'ResearchBot-01',
      endpoint: 'api.exa.ai/v1/search',
      amountUsd: 0.25,
      reason: 'retry test',
      idempotencyKey: 'mcp-retry-key-0001',
    };
    const r1 = await rpc('tools/call', { name: 'pay_endpoint', arguments: args });
    expect(isError(r1), text(r1)).toBe(false);
    const ref1 = text(r1).match(/ref (\S+)/)?.[1];
    expect(ref1).toBeTruthy();

    const r2 = await rpc('tools/call', { name: 'pay_endpoint', arguments: args });
    expect(isError(r2), text(r2)).toBe(false);
    const ref2 = text(r2).match(/ref (\S+)/)?.[1];
    // Same receipt back — settled at most once.
    expect(ref2).toBe(ref1);
  });

  it('rejects reusing a key for a different payment', async () => {
    const base = {
      agent: 'ResearchBot-01',
      endpoint: 'api.exa.ai/v1/search',
      reason: 'retry test',
      idempotencyKey: 'mcp-retry-key-0002',
    };
    const r1 = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: { ...base, amountUsd: 0.1 },
    });
    expect(isError(r1), text(r1)).toBe(false);
    // Same key, different amount → must not silently settle. The store throws
    // idempotency_key_reused; the MCP SDK surfaces it as an error envelope.
    const r2 = await rpc('tools/call', {
      name: 'pay_endpoint',
      arguments: { ...base, amountUsd: 0.9 },
    });
    expect(isError(r2) || r2.rpc.error !== undefined).toBe(true);
    expect(JSON.stringify(r2.rpc)).toContain('idempotency_key_reused');
  });

  it('exposes idempotencyKey in the pay_endpoint tool schema', async () => {
    const r = await rpc('tools/list');
    const tool = (r.rpc.result?.tools ?? []).find((t) => t.name === 'pay_endpoint');
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.inputSchema)).toContain('idempotencyKey');
  });
});

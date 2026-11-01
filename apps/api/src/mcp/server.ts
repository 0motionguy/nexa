/**
 * NEXA MCP server — exposes the agent-wallet tools over Streamable HTTP at
 * POST /mcp (stateless mode: fresh server+transport per request, no session
 * pinning — curl-able, horizontally scalable).
 *
 * Tools (PLAN-ADDENDUM §MCP SERVER): get_balance, list_agents, get_policy,
 * pay_endpoint, request_funds, transfer.
 *
 * Facilitator tools (the get-paid layer, so an agent can run a whole micro-
 * business as the seller): create_offer, get_payments, create_payout,
 * split_revenue. These operate on the resolved `user` as the seller and wrap
 * the already-tested store facilitator methods.
 *
 * Safety model: the key (nx_live_*) scopes to ONE user's agent surface.
 * pay_endpoint runs the same server-side policy gate as the REST route.
 * transfer to-agent is default-deny (needs the human in the app);
 * to-human (give back) is always allowed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store } from '../store/index.js';
import { PolicyError, type User } from '../store/types.js';
import { userForAgentKey } from '../lib/agent-keys.js';
import { env } from '../lib/env.js';
import { mcpRequests } from '../lib/metrics.js';
import { setSentryUser } from '../lib/sentry.js';
import { enforceRateLimit } from '../lib/rate-limit.js';

function text(s: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: s }] };
}

function err(s: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: s }], isError: true };
}

function money(v: number): string {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildServer(user: User): McpServer {
  const server = new McpServer({ name: 'nexa', version: '1.0.0' });

  server.tool(
    'get_balance',
    'Get the human balance plus every agent budget (available, spent today, caps).',
    {},
    () => {
      const lines = [
        `Human balance: ${money(user.balUsd)} (earning ${money(user.earnUsd)} at ${(user.earnApy * 100).toFixed(1)}% est.)`,
        `Kill switch: ${user.killSwitch ? 'ON — all agents paused' : 'off'}`,
        ...user.agents.map(
          (a) =>
            `Agent ${a.name} [${a.state}]: ${money(a.balanceUsd)} available · spent today ${money(a.spentTodayUsd)} of ${money(a.policy.perDayCapUsd)}/day · ${money(a.policy.perTxCapUsd)}/tx cap`,
        ),
      ];
      return text(lines.join('\n'));
    },
  );

  server.tool('list_agents', 'List the agents on this account with state and budget.', {}, () => {
    return text(
      JSON.stringify(
        user.agents.map((a) => ({
          id: a.id,
          name: a.name,
          state: a.state,
          balanceUsd: a.balanceUsd,
          spentTodayUsd: a.spentTodayUsd,
        })),
        null,
        2,
      ),
    );
  });

  server.tool(
    'get_policy',
    'Get the active policy for an agent (caps, allowlist, approval threshold).',
    { agent: z.string().describe('Agent id or name') },
    async ({ agent }) => {
      try {
        const a = await store.agent(user, agent);
        return text(JSON.stringify({ name: a.name, state: a.state, policy: a.policy }, null, 2));
      } catch {
        return err(`No agent matching "${agent}".`);
      }
    },
  );

  server.tool(
    'pay_endpoint',
    'Pay an x402 endpoint from an agent budget. Validated server-side against the agent policy (per-tx cap, daily cap, endpoint allowlist, kill switch). Returns the receipt.',
    {
      agent: z.string().describe('Agent id or name'),
      endpoint: z.string().describe('Endpoint URL or hostname+path, e.g. api.exa.ai/v1/search'),
      amountUsd: z.number().positive().describe('Payment amount in USD'),
      reason: z.string().describe('Short human-readable purpose, e.g. "market data"'),
      idempotencyKey: z
        .string()
        .min(8)
        .max(120)
        .optional()
        .describe(
          'Retry-safety key (8-120 chars): reuse the same key when retrying so the payment settles at most once. Required outside demo mode.',
        ),
    },
    async ({ agent, endpoint, amountUsd, reason, idempotencyKey }) => {
      try {
        // Same fail-closed posture as POST /x402/pay: an unkeyed retry outside
        // demo mode must never be able to double-debit the agent budget.
        if (!env.DEMO_MODE && !idempotencyKey) {
          return err(
            'BLOCKED (idempotency_key_required): pass idempotencyKey so retries settle at most once.',
          );
        }
        const { receipt } = await store.x402Pay(user, agent, endpoint, amountUsd, reason, undefined, {
          idempotencyKey: idempotencyKey ?? null,
        });
        return text(
          `Paid ${money(amountUsd)} to ${endpoint} · 402 → paid → 200 OK · ref ${receipt.ref} · policy ✓`,
        );
      } catch (e) {
        if (e instanceof PolicyError) return err(`BLOCKED (${e.code}): ${e.message}`);
        if (e instanceof Error && e.message === 'agent_not_found')
          return err(`No agent matching "${agent}".`);
        throw e;
      }
    },
  );

  server.tool(
    'request_funds',
    'Ask the human to top up an agent budget. Never auto-approves — the human approves in the NEXA app.',
    {
      agent: z.string().describe('Agent id or name'),
      amountUsd: z.number().positive(),
      reason: z.string().max(140),
    },
    async ({ agent, amountUsd, reason }) => {
      try {
        const a = await store.agent(user, agent);
        await store.pushActivity(user, {
          n: `Wants ${money(amountUsd)} · ${a.name}`,
          s: `${reason.toUpperCase()} · NEEDS YOUR OK`,
          k: 'agent',
          a: money(amountUsd),
        });
        return text(
          `Request logged. ${user.name} will see "${a.name} wants ${money(amountUsd)} — ${reason}" in the app and can approve with one tap.`,
        );
      } catch {
        return err(`No agent matching "${agent}".`);
      }
    },
  );

  server.tool(
    'transfer',
    'Move budget between an agent and the human balance. Direction "to-human" (give back) executes instantly; "to-agent" always requires human approval in the app — this tool cannot pull money from the human.',
    {
      agent: z.string().describe('Agent id or name'),
      amountUsd: z.number().positive(),
      direction: z.enum(['to-human', 'to-agent']),
    },
    async ({ agent, amountUsd, direction }) => {
      try {
        const a = await store.agent(user, agent);
        if (direction === 'to-agent') {
          await store.pushActivity(user, {
            n: `Wants ${money(amountUsd)} · ${a.name}`,
            s: 'FUNDING REQUEST · NEEDS YOUR OK',
            k: 'agent',
            a: money(amountUsd),
          });
          return err(
            'to-agent transfers require human approval — request logged in the app instead.',
          );
        }
        // to-human is a defund (return all up-to amountUsd to the human).
        const back = Math.min(amountUsd, a.balanceUsd);
        if (back > 0) {
          await store.defundAgent(user, a.id);
        }
        return text(`Returned ${money(back)} from ${a.name} to the main balance.`);
      } catch {
        return err(`No agent matching "${agent}".`);
      }
    },
  );

  /* ── facilitator (the get-paid layer) ── */

  server.tool(
    'create_offer',
    'Create a sellable offer (one-time or subscription) and get a shareable checkout link. Optional splits route slices of each sale to sub-accounts or emails.',
    {
      title: z.string(),
      amountUsd: z.number().positive(),
      type: z.enum(['one_time', 'subscription']).optional(),
      fulfillmentKind: z.enum(['url', 'message', 'none']).optional(),
      fulfillmentValue: z.string().optional(),
      splits: z
        .array(
          z.object({
            email: z.string().email().optional(),
            subAccountId: z.string().optional(),
            percent: z.number(),
          }),
        )
        .optional(),
    },
    async ({ title, amountUsd, type, fulfillmentKind, fulfillmentValue, splits }) => {
      const offer = await store.createOffer(
        user,
        { title, amountUsd, type, fulfillmentKind, fulfillmentValue, splits },
        { livemode: true },
      );
      return text(
        'Offer created. Share this link: ' +
          env.CHECKOUT_BASE_URL.replace(/\/+$/, '') +
          '/' +
          offer.id,
      );
    },
  );

  server.tool(
    'get_payments',
    'List recent payments received on this account (title, amount, buyer, status).',
    { limit: z.number().int().positive().max(100).optional() },
    async ({ limit }) => {
      const payments = await store.listPayments(user, { livemode: true });
      const rows = payments.slice(0, limit ?? 20);
      if (rows.length === 0) return text('No payments yet.');
      const lines = rows.map(
        (p) =>
          `${p.offerTitle} · ${money(p.amountUsd)} · ${p.buyerEmail ?? 'anonymous'} · ${p.status}`,
      );
      return text(lines.join('\n'));
    },
  );

  server.tool(
    'create_payout',
    'Pay money out to a developer or collaborator. Debits the account balance. Returns the receipt; blocked when funds are insufficient.',
    {
      destination: z.string().describe('Email or account ref'),
      amountUsd: z.number().positive(),
      note: z.string().optional(),
    },
    async ({ destination, amountUsd, note }) => {
      try {
        const payout = await store.createPayout(
          user,
          { destination, amountUsd, note },
          { livemode: true },
        );
        return text(`Paid out ${money(payout.amountUsd)} to ${payout.destination} · ${payout.status}.`);
      } catch (e) {
        if (e instanceof PolicyError) return err(`BLOCKED (${e.code}): ${e.message}`);
        throw e;
      }
    },
  );

  server.tool(
    'split_revenue',
    'Distribute an amount across collaborators by percentage (each a payout). Percentages must sum to ≤ 100.',
    {
      amountUsd: z.number().positive(),
      rules: z.array(z.object({ to: z.string().email(), percent: z.number().positive() })),
    },
    async ({ amountUsd, rules }) => {
      const sum = rules.reduce((acc, r) => acc + r.percent, 0);
      if (sum > 100) return err(`Split percentages exceed 100 (got ${sum}).`);
      const done: string[] = [];
      try {
        for (const rule of rules) {
          const share = Math.round((amountUsd * rule.percent) / 100 * 100) / 100;
          await store.createPayout(
            user,
            { destination: rule.to, amountUsd: share, note: 'revenue split' },
            { livemode: true },
          );
          done.push(`${rule.to}: ${money(share)} (${rule.percent}%)`);
        }
      } catch (e) {
        if (e instanceof PolicyError) return err(`BLOCKED (${e.code}): ${e.message}`);
        throw e;
      }
      return text(`Split ${money(amountUsd)}:\n` + done.join('\n'));
    },
  );

  return server;
}

/**
 * F089 — Tool-name prefixes that classify a tools/call as a WRITE (tighter
 * rate-limit bucket). Anything not matching is treated as READ. Kept as a
 * prefix allowlist rather than an enumerated tool list so new write tools
 * (e.g. `withdraw_*`, `mint_*`) automatically inherit the tighter bucket
 * provided they follow the verb convention.
 */
const MCP_WRITE_TOOL_PREFIXES = [
  'place_',
  'pay_',
  'transfer',
  'swap',
  'approve_',
  'revoke_',
  'create_',
  'mint_',
  'withdraw_',
  'cancel_',
] as const;

function extractKey(req: IncomingMessage): string | null {
  const h = req.headers;
  const direct = h['x-nexa-key'];
  if (typeof direct === 'string' && direct) return direct;
  const auth = h['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * Stateless Streamable-HTTP handler for POST/GET/DELETE /mcp.
 * Fresh transport per request; closes with the response.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
): Promise<void> {
  const provided = extractKey(req);
  const user = provided ? await userForAgentKey(provided) : null;
  if (!provided || !user) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'invalid or missing NEXA key' },
        id: null,
      }),
    );
    return;
  }

  // Tag the Sentry scope for this MCP request — agent-key auth doesn't go
  // through the Hono session middleware, so withSentryUser doesn't fire.
  setSentryUser({ id: user.id, email: user.email });

  // Surface mcp_requests_total{method=...}. parsedBody is the JSON-RPC
  // envelope from index.ts; we pull `method` if present so dashboards can
  // distinguish tools/call from initialize / notifications.
  const method =
    parsedBody && typeof parsedBody === 'object' && 'method' in parsedBody
      ? String((parsedBody as { method?: unknown }).method ?? 'unknown')
      : 'unknown';
  mcpRequests.inc({ method });

  // F089 Sprint 18 — per-tool rate-limit split. The outer `mcp` bucket (60/min,
  // applied in index.ts) covers initialize + tools/list noise. tools/call goes
  // through a finer split here so a runaway agent looping a read tool can't
  // starve write tools (and vice versa).
  //
  //   - Read tools  (list_*, get_*, no on-chain mutation):  120 / min
  //   - Write tools (pay_*, transfer*, approve_*, swap_*):   30 / min
  //
  // When tools/call carries a recognised tool name, we enforce the matching
  // bucket. Any other JSON-RPC method falls through (the outer `mcp` bucket
  // already counted this request).
  if (method === 'tools/call') {
    const toolName =
      parsedBody && typeof parsedBody === 'object' && 'params' in parsedBody
        ? (() => {
            const p = (parsedBody as { params?: { name?: unknown } }).params;
            return p && typeof p.name === 'string' ? p.name : null;
          })()
        : null;
    if (toolName) {
      const isWrite = MCP_WRITE_TOOL_PREFIXES.some((pref) => toolName.startsWith(pref));
      const bucket = isWrite
        ? { namespace: 'mcp-write', windowSeconds: 60, limit: 30 }
        : { namespace: 'mcp-read', windowSeconds: 60, limit: 120 };
      const result = await enforceRateLimit({ ...bucket, rawKey: `${user.id}:${toolName}` });
      if (!result.ok) {
        res
          .writeHead(429, {
            'content-type': 'application/json',
            'Retry-After': String(result.retryAfter),
          })
          .end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32002,
                message: `rate_limited: ${bucket.namespace} (${bucket.limit}/${bucket.windowSeconds}s)`,
                data: { retryAfter: result.retryAfter, tool: toolName },
              },
              id:
                parsedBody && typeof parsedBody === 'object' && 'id' in parsedBody
                  ? (parsedBody as { id?: unknown }).id ?? null
                  : null,
            }),
          );
        return;
      }
    }
  }

  const server = buildServer(user);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // plain JSON (no SSE wrapper) — curl/test friendly
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

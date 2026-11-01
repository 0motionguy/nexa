/**
 * x402 — both sides of the protocol surface:
 *
 *   CLIENT (agent pays): POST /pay — validates against the agent's policy
 *   server-side, settles from the agent budget, returns the receipt. This is
 *   the route the MCP `pay_endpoint` tool calls. Auth: agent key.
 *
 *   MERCHANT (vendor sells): /contracts CRUD + per-contract events. Auth:
 *   session (the human vendor manages their endpoints from the portal).
 *
 * DEMO_MODE settles on the ledger. Production signs EIP-3009
 * transferWithAuthorization and returns an X-PAYMENT header per the
 * x402 spec (PLAN-ADDENDUM §x402 CLIENT).
 */

import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAgentKey, requireSession } from '../lib/auth.js';
import { store } from '../store/index.js';
import { PolicyError, type Agent, type SessionUser } from '../store/types.js';
import { ChainError, getChainStack } from '../lib/chain/index.js';
import { env } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { x402Settlements } from '../lib/metrics.js';
import { fireWebhooks } from '../lib/webhooks.js';
import { resolvePayeeAddress } from '../lib/x402-payee.js';

export const x402Routes = new Hono();

interface AgentPaymentInput {
  agent: string;
  endpoint: string;
  amountUsd: number;
  reason: string;
}

function policyMoney(v: number): string {
  return '$' + v.toFixed(2);
}

function idempotencyKeyOf(c: Context): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? '').trim();
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key || null;
}

function x402IdempotencyTag(key: string): string {
  return `x402:${createHash('sha256').update(key).digest('hex')}`;
}

function activityAmountUsd(row: { a: string }): number {
  const raw = row.a.replace(/[^0-9.-]/g, '');
  const value = Number(raw);
  return Number.isFinite(value) ? Math.abs(value) : NaN;
}

function assertSameReplayIntent(
  row: { signer?: string; a: string },
  endpoint: string,
  amountUsd: number,
): void {
  if (row.signer !== endpoint || Math.abs(activityAmountUsd(row) - amountUsd) > 0.005) {
    throw ApiError.conflict('idempotency_key_reused');
  }
}

function policyHost(endpoint: string): string {
  try {
    return new URL(endpoint.startsWith('http') ? endpoint : 'https://' + endpoint).hostname;
  } catch {
    throw new PolicyError('endpoint_not_allowed', 'Endpoint is not a valid URL.');
  }
}

function assertX402PolicyAllowed(u: SessionUser, a: Agent, input: AgentPaymentInput): void {
  if (u.killSwitch) throw new PolicyError('kill_switch', 'Kill switch is on - every agent is paused.');
  if (a.state === 'paused' || a.state === 'blocked') {
    throw new PolicyError('agent_paused', `${a.name} is ${a.state}.`);
  }
  if (a.policy.expiresAt && new Date(a.policy.expiresAt) < new Date()) {
    throw new PolicyError('expired', 'Agent policy expired.');
  }
  const host = policyHost(input.endpoint);
  const allowed = a.policy.endpointAllowlist.some((h) => host === h || host.endsWith('.' + h));
  if (!allowed) {
    throw new PolicyError('endpoint_not_allowed', `${host} is not on ${a.name}'s allowlist.`);
  }
  if (input.amountUsd > a.policy.humanApprovalThresholdUsd) {
    throw new PolicyError(
      'needs_human_approval',
      `${policyMoney(input.amountUsd)} is above ${policyMoney(a.policy.humanApprovalThresholdUsd)} - needs your OK.`,
    );
  }
  if (input.amountUsd > a.policy.perTxCapUsd) {
    throw new PolicyError(
      'needs_approval',
      `${policyMoney(input.amountUsd)} is above the ${policyMoney(a.policy.perTxCapUsd)}/tx cap - needs your OK.`,
    );
  }
  if (a.spentTodayUsd + input.amountUsd > a.policy.perDayCapUsd) {
    throw new PolicyError('per_day_cap', `Would exceed the ${policyMoney(a.policy.perDayCapUsd)}/day cap.`);
  }
  if (input.amountUsd > a.balanceUsd) {
    throw new PolicyError('insufficient_funds', `${a.name} only holds ${policyMoney(a.balanceUsd)}.`);
  }
}

async function maybeSettleLiveX402(
  c: Context,
  u: SessionUser,
  input: AgentPaymentInput,
  idempotencyKey: string | null,
): Promise<Response | null> {
  const stack = getChainStack();
  if (!stack.x402.isLive || !stack.wallets.isLive()) return null;
  if (!idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const idem = x402IdempotencyTag(idempotencyKey);

  try {
    const agentObj = await store.agent(u, input.agent);
    assertX402PolicyAllowed(u, agentObj, input);
    // Scale wave 3 — idempotent-replay lookup needs the full aggregate record.
    const full = await store.user(u.id);
    const replayActivity = full.activity.find((row) => row.txHash === idem);
    if (replayActivity) {
      assertSameReplayIntent(replayActivity, input.endpoint, input.amountUsd);
      const receipt = full.x402Events.find((event) => event.ref === idem) ?? {
        id: replayActivity.id,
        contractId: null,
        buyer: agentObj.name,
        buyerType: 'agent' as const,
        resource: input.endpoint,
        amountUsd: input.amountUsd,
        httpStatus: 200,
        ref: idem,
        at: replayActivity.at,
      };
      c.header('X-PAYMENT', `replay ${idem}`);
      return c.json({ ok: true, receipt: { ...receipt, idempotent: true, replay: true } });
    }
    const wallet = await stack.wallets.getOrCreateAgentWallet(u.id, null, agentObj.id, agentObj.name);
    const payee = await resolvePayeeAddress({
      endpoint: input.endpoint,
      fallbackAddress: wallet.address,
    });
    if (payee.source === 'fallback') {
      x402Settlements.inc({ result: 'failure' });
      throw ApiError.serviceUnavailable('x402_payee_unavailable');
    }
    const signed = await stack.x402.signTransferAuth(
      wallet.address,
      payee.address as `0x${string}`,
      input.amountUsd,
      'USDC',
      wallet,
      { nonceSeed: idem },
    );
    if (!signed) {
      throw new ChainError('sig_unavailable', 'x402 signature unavailable');
    }
    const result = await stack.x402.settleViaCoinbase(signed);
    const { receipt } = await store.x402Pay(
      u,
      input.agent,
      input.endpoint,
      input.amountUsd,
      input.reason,
      idem,
      { idempotencyKey },
    );
    c.header('X-PAYMENT', stack.x402.buildXPaymentHeader(signed));
    x402Settlements.inc({ result: 'success' });
    return c.json({
      ok: true,
      receipt: {
        ...receipt,
        ref: result.txHash,
        settlement: {
          ...result,
          blockNumber: result.blockNumber.toString(),
        },
      },
    });
  } catch (e) {
    if (e instanceof ApiError || e instanceof PolicyError) throw e;
    if (e instanceof ChainError) {
      log.warn({ code: e.code, msg: e.message }, 'x402: chain settle failed');
    } else {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'x402: chain unexpected');
    }
    x402Settlements.inc({ result: 'failure' });
    throw ApiError.serviceUnavailable('x402_settlement_failed');
  }
}

/* ── client side (agent key) ── */

x402Routes.post(
  '/pay',
  requireAgentKey,
  zValidator(
    'json',
    z.object({
      agent: z.string().min(1).describe('agent id or name'),
      endpoint: z.string().min(3),
      amountUsd: z.number().positive().max(1000),
      reason: z.string().min(1).max(140),
    }),
  ),
  async (c) => {
    const u = c.get('user');
    const { agent, endpoint, amountUsd, reason } = c.req.valid('json');
    const idempotencyKey = idempotencyKeyOf(c);
    if (!env.DEMO_MODE && !idempotencyKey) {
      throw ApiError.badRequest('idempotency_key_required');
    }
    try {
      const live = await maybeSettleLiveX402(c, u, { agent, endpoint, amountUsd, reason }, idempotencyKey);
      if (live) return live;
      const stack = getChainStack();
      if (stack.x402.isLive && stack.wallets.isLive()) {
        throw ApiError.serviceUnavailable('x402_settlement_failed');
      }
      const { receipt } = await store.x402Pay(u, agent, endpoint, amountUsd, reason, undefined, {
        idempotencyKey,
      });

      // Demo / ledger settlement is still a successful settle from the
      // counter's perspective — payOffer succeeded server-side.
      c.header('X-PAYMENT', `demo ${receipt.ref}`);
      x402Settlements.inc({ result: 'success' });
      return c.json({ ok: true, receipt });
    } catch (e) {
      if (e instanceof PolicyError) {
        x402Settlements.inc({ result: 'failure' });
        // Stack upgrades Phase 3 — fire `agent.blocked` webhook before
        // responding. Best-effort: dead webhooks must never break the agent
        // request path. The route still returns the policy code synchronously.
        void (async () => {
          try {
            const agentObj = await store.agent(u, agent).catch(() => null);
            await fireWebhooks(await store.webhooksForSeller(u.id), {
              id: receipt404Id(),
              type: 'agent.blocked',
              created: new Date().toISOString(),
              data: {
                agentId: agentObj?.id ?? agent,
                agentName: agentObj?.name ?? agent,
                endpoint,
                amountUsd,
                policyCode: e.code,
                reason: e.message,
                attemptedAt: new Date().toISOString(),
              },
            });
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'x402: agent.blocked webhook dispatch failed',
            );
          }
        })();
        // `needs_approval` and `needs_human_approval` both signal "402 — needs
        // human OK"; per-day cap / kill switch / agent paused etc. are 403.
        // 402 is not in the ApiError union (x402-only), so we render the
        // shared `{ ok: false, error: { code, message } }` envelope inline
        // to keep the wire shape stable across all error branches.
        const status =
          e.code === 'needs_approval' || e.code === 'needs_human_approval' ? 402 : 403;
        return c.json(
          { ok: false, error: { code: e.code, message: e.message } },
          status,
        );
      }
      if (e instanceof Error && e.message === 'agent_not_found') {
        x402Settlements.inc({ result: 'failure' });
        throw ApiError.notFound('agent_not_found');
      }
      if (e instanceof Error && e.message === 'idempotency_key_reused') {
        x402Settlements.inc({ result: 'failure' });
        throw ApiError.conflict('idempotency_key_reused');
      }
      throw e;
    }
  },
);

/** Short event-id helper so the dispatched webhook has a unique reference. */
function receipt404Id(): string {
  return 'blocked_' + Math.random().toString(36).slice(2, 14);
}

/* ── merchant side (session) ── */

x402Routes.post(
  '/settle',
  requireAgentKey,
  zValidator(
    'json',
    z.object({
      agent: z.string().min(1).describe('agent id or name'),
      endpoint: z.string().min(3),
      amountUsd: z.number().positive().max(1000),
      reason: z.string().min(1).max(140),
    }),
  ),
  async (c) => {
    const u = c.get('user');
    const { agent, endpoint, amountUsd, reason } = c.req.valid('json');
    const idempotencyKey = idempotencyKeyOf(c);
    if (!env.DEMO_MODE && !idempotencyKey) {
      throw ApiError.badRequest('idempotency_key_required');
    }
    try {
      const live = await maybeSettleLiveX402(c, u, { agent, endpoint, amountUsd, reason }, idempotencyKey);
      if (live) return live;
      const stack = getChainStack();
      if (stack.x402.isLive && stack.wallets.isLive()) {
        throw ApiError.serviceUnavailable('x402_settlement_failed');
      }
      const { receipt } = await store.x402Pay(u, agent, endpoint, amountUsd, reason, undefined, {
        idempotencyKey,
      });
      c.header('X-PAYMENT', `demo ${receipt.ref}`);
      x402Settlements.inc({ result: 'success' });
      return c.json({ ok: true, receipt });
    } catch (e) {
      if (e instanceof PolicyError) {
        x402Settlements.inc({ result: 'failure' });
        // See /pay handler note — 402 lives outside the ApiError union, so
        // we render the shared envelope inline here too.
        const status =
          e.code === 'needs_approval' || e.code === 'needs_human_approval' ? 402 : 403;
        return c.json(
          { ok: false, error: { code: e.code, message: e.message } },
          status,
        );
      }
      if (e instanceof Error && e.message === 'agent_not_found') {
        x402Settlements.inc({ result: 'failure' });
        throw ApiError.notFound('agent_not_found');
      }
      if (e instanceof Error && e.message === 'idempotency_key_reused') {
        x402Settlements.inc({ result: 'failure' });
        throw ApiError.conflict('idempotency_key_reused');
      }
      throw e;
    }
  },
);

x402Routes.get('/quote', requireSession, async (c) => {
  const u = c.get('user');
  const resource = c.req.query('resource');
  if (!resource) throw ApiError.badRequest('missing_resource');
  const contract = (await store.user(u.id)).contracts.find((item) => item.endpointPath === resource);
  if (!contract || contract.status !== 'live') {
    throw ApiError.notFound('contract_not_found');
  }
  return c.json({
    ok: true,
    quote: {
      resource: contract.endpointPath,
      method: contract.method,
      amountUsd: contract.priceUsd,
      currency: contract.currency,
      expiresInSeconds: 60,
      paymentHeader: 'X-PAYMENT',
    },
  });
});

x402Routes.get('/contracts', requireSession, async (c) => {
  const u = c.get('user');
  return c.json({ ok: true, contracts: (await store.user(u.id)).contracts });
});

x402Routes.post(
  '/contracts',
  requireSession,
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      endpointPath: z.string().startsWith('/').max(120),
      method: z.enum(['GET', 'POST']).default('GET'),
      priceUsd: z.number().positive().max(100),
      currency: z.enum(['USDC', 'EURC']).default('USDC'),
    }),
  ),
  async (c) => {
    const u = c.get('user');
    const b = c.req.valid('json');
    const contract = await store.createContract(u, b.name, b.endpointPath, b.method, b.priceUsd, b.currency);
    return c.json({ ok: true, contract }, 201);
  },
);

x402Routes.get('/contracts/:id', requireSession, async (c) => {
  const u = c.get('user');
  try {
    return c.json({ ok: true, contract: await store.contract(u, c.req.param('id') ?? '') });
  } catch {
    throw ApiError.notFound('contract_not_found');
  }
});

x402Routes.post(
  '/contracts/:id/status',
  requireSession,
  zValidator('json', z.object({ status: z.enum(['live', 'paused']) })),
  async (c) => {
    const u = c.get('user');
    try {
      const contract = await store.setContractStatus(u, c.req.param('id'), c.req.valid('json').status);
      return c.json({ ok: true, contract });
    } catch {
      throw ApiError.notFound('contract_not_found');
    }
  },
);

x402Routes.get('/events', requireSession, async (c) => {
  const u = c.get('user');
  return c.json({ ok: true, events: (await store.user(u.id)).x402Events.slice(0, 50) });
});

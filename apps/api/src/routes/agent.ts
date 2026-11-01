/**
 * Agent wallet surface — CRUD, fund/defund, pause, kill switch, activity.
 * Per PLAN-ADDENDUM-V2-AGENT-X402 §New backend surface. Policy enforcement
 * lives in the store (server-side only).
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireSession } from '../lib/auth.js';
import { store } from '../store/index.js';
import { PolicyError } from '../store/types.js';
import { ApiError } from '../lib/errors.js';
import { emitAudit } from '../lib/audit.js';
import { getChainStack } from '../lib/chain/index.js';

export const agentRoutes = new Hono();

agentRoutes.use('*', requireSession);

function idempotencyKeyOf(c: { req: { header(name: string): string | undefined } }): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? '').trim();
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key || null;
}

function agentProvisioningKey(key: string, step: 'card' | 'bank'): string {
  return `agent-${step}:${createHash('sha256').update(key).digest('hex')}`;
}

agentRoutes.get('/', async (c) => {
  const u = c.get('user');
  // Scale wave 3 — agent list lives on the full aggregate record.
  const full = await store.user(u.id);
  return c.json({ ok: true, killSwitch: u.killSwitch, agents: full.agents });
});

agentRoutes.post(
  '/create',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(60),
      perDayCapUsd: z.number().positive().max(10000).default(10),
      perTxCapUsd: z.number().positive().max(1000).default(1),
      endpointAllowlist: z.array(z.string().min(1)).max(50).default([]),
    }),
  ),
  async (c) => {
    const u = c.get('user');
    const body = c.req.valid('json');
    const agent = await store.createAgent(u, body.name, body.perDayCapUsd, body.perTxCapUsd, body.endpointAllowlist);
    // Stack upgrades Phase 3 — provision the per-agent Privy server wallet
    // eagerly so the dashboard can show the agent's address immediately.
    // Demo mode (no Privy env) synthesizes a deterministic address from
    // agent.id so two siblings always get distinct, stable addresses.
    let walletAddress: string | null = null;
    try {
      const wallet = await getChainStack().wallets.getOrCreateAgentWallet(u.id, null, agent.id, agent.name);
      walletAddress = wallet.address;
    } catch {
      // Swallow — wallet provisioning is best-effort at create time; the next
      // x402 attempt will retry through the same code path.
    }
    return c.json({ ok: true, agent, walletAddress }, 201);
  },
);

agentRoutes.post(
  '/kill-switch',
  zValidator('json', z.object({ on: z.boolean() })),
  async (c) => {
    const u = c.get('user');
    const { on } = c.req.valid('json');
    await store.setKillSwitch(u, on);
    // F066 — compliance trail for every flip of the session kill switch.
    emitAudit(c, {
      action: 'agent.kill_switch',
      actorType: 'user',
      actorId: u.id,
      targetType: 'user',
      targetId: u.id,
      metadata: { value: on },
    });
    return c.json({ ok: true, killSwitch: u.killSwitch });
  },
);

agentRoutes.post(
  '/:id/fund',
  zValidator('json', z.object({ amountUsd: z.number().positive().max(99999) })),
  async (c) => {
    const u = c.get('user');
    const agentId = c.req.param('id');
    const { amountUsd } = c.req.valid('json');
    const idempotencyKey = idempotencyKeyOf(c);
    if (!idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
    try {
      const agent = await store.fundAgent(u, agentId, amountUsd, { idempotencyKey });
      // F066 — record successful fund-from-user into agent budget.
      emitAudit(c, {
        action: 'agent.funded',
        actorType: 'user',
        actorId: u.id,
        targetType: 'agent',
        targetId: agentId,
        metadata: { amountUsd, newBalance: agent.balanceUsd },
      });
      return c.json({ ok: true, agent, balUsd: u.balUsd });
    } catch (e) {
      if (e instanceof PolicyError) throw ApiError.badRequest(e.message, { policyCode: e.code });
      if (e instanceof Error && e.message === 'agent_not_found')
        throw ApiError.notFound('agent_not_found');
      if (e instanceof Error && e.message === 'idempotency_key_reused')
        throw ApiError.conflict('idempotency_key_reused');
      throw e;
    }
  },
);

agentRoutes.post('/:id/defund', async (c) => {
  const u = c.get('user');
  const agentId = c.req.param('id');
  try {
    const agent = await store.defundAgent(u, agentId);
    // F066 — record withdrawal of agent budget back to user.
    emitAudit(c, {
      action: 'agent.defunded',
      actorType: 'user',
      actorId: u.id,
      targetType: 'agent',
      targetId: agentId,
      metadata: { newBalance: agent.balanceUsd },
    });
    return c.json({ ok: true, agent, balUsd: u.balUsd });
  } catch (e) {
    if (e instanceof Error && e.message === 'agent_not_found')
      throw ApiError.notFound('agent_not_found');
    throw e;
  }
});

agentRoutes.post(
  '/:id/pause',
  zValidator('json', z.object({ paused: z.boolean() })),
  async (c) => {
    const u = c.get('user');
    try {
      const agent = await store.setAgentPaused(u, c.req.param('id'), c.req.valid('json').paused);
      return c.json({ ok: true, agent });
    } catch (e) {
      if (e instanceof Error && e.message === 'agent_not_found')
        throw ApiError.notFound('agent_not_found');
      throw e;
    }
  },
);

agentRoutes.post(
  '/:id/policy',
  zValidator(
    'json',
    z.object({
      perDayCapUsd: z.number().positive().max(10000).optional(),
      perTxCapUsd: z.number().positive().max(1000).optional(),
      endpointAllowlist: z.array(z.string().min(1)).max(50).optional(),
      humanApprovalThresholdUsd: z.number().nonnegative().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
    }),
  ),
  async (c) => {
    const u = c.get('user');
    try {
      const agent = await store.updateAgentPolicy(u, c.req.param('id'), c.req.valid('json'));
      return c.json({ ok: true, agent });
    } catch {
      throw ApiError.notFound('agent_not_found');
    }
  },
);

agentRoutes.post(
  '/:id/approve-once',
  zValidator(
    'json',
    z.object({
      endpoint: z.string().min(1),
      amountUsd: z.number().positive().max(1000),
      reason: z.string().min(1).max(140),
    }),
  ),
  async (c) => {
    const u = c.get('user');
    const { endpoint, amountUsd, reason } = c.req.valid('json');
    const idempotencyKey = idempotencyKeyOf(c);
    if (!idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
    try {
      const { receipt } = await store.x402ApproveOnce(u, c.req.param('id'), endpoint, amountUsd, reason, {
        idempotencyKey,
      });
      return c.json({ ok: true, receipt });
    } catch (e) {
      if (e instanceof PolicyError) throw ApiError.badRequest(e.message, { policyCode: e.code });
      if (e instanceof Error && e.message === 'agent_not_found')
        throw ApiError.notFound('agent_not_found');
      if (e instanceof Error && e.message === 'idempotency_key_reused')
        throw ApiError.conflict('idempotency_key_reused');
      throw e;
    }
  },
);

agentRoutes.get('/:id/activity', async (c) => {
  const u = c.get('user');
  try {
    const agent = await store.agent(u, c.req.param('id'));
    const full = await store.user(u.id);
    const events = full.x402Events.filter((e) => e.buyer === agent.name).slice(0, 50);
    return c.json({ ok: true, agent: agent.name, events });
  } catch {
    throw ApiError.notFound('agent_not_found');
  }
});

/* ── card layer: per-agent virtual card + bank account (Sponge) ──────────── */

agentRoutes.post('/:id/card', async (c) => {
  const u = c.get('user');
  const idempotencyKey = idempotencyKeyOf(c);
  let agent;
  try {
    agent = await store.agent(u, c.req.param('id'));
  } catch {
    throw ApiError.notFound('agent_not_found');
  }
  const stack = getChainStack();
  if (stack.sponge.isSpongeEnabled() && !idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const card = await stack.sponge.createAgentCard(u.id, agent.id, {
    idempotencyKey: idempotencyKey ? agentProvisioningKey(idempotencyKey, 'card') : null,
  });
  return c.json({ ok: true, agentId: agent.id, last4: card.last4, network: card.network, demo: card.demo });
});

agentRoutes.post('/:id/bank', async (c) => {
  const u = c.get('user');
  const idempotencyKey = idempotencyKeyOf(c);
  let agent;
  try {
    agent = await store.agent(u, c.req.param('id'));
  } catch {
    throw ApiError.notFound('agent_not_found');
  }
  const stack = getChainStack();
  if (stack.sponge.isSpongeEnabled() && !idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
  const acct = await stack.sponge.createAgentBankAccount(u.id, agent.id, {
    idempotencyKey: idempotencyKey ? agentProvisioningKey(idempotencyKey, 'bank') : null,
  });
  return c.json({ ok: true, accountNumber: acct.accountNumber, routingNumber: acct.routingNumber });
});

/**
 * InMemoryAgents — agents, contracts, Privy wallets, x402 events, digests.
 *
 * Mirrors PgAgents but mutates User.agents / User.contracts arrays in place
 * (single-threaded JS makes that safe). The policy engine validation lives
 * in the x402Pay path here so it's testable without a DB.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type Agent,
  type AgentDigestDue,
  type AgentPolicy,
  type AgentWalletRecord,
  PolicyError,
  type SessionUser,
  type User,
  type X402Contract,
  type X402Event,
  type X402PayResult,
} from '../types.js';
import type { InMemoryState } from '../core/in-memory-state.js';
import { money, nowIso, ref, round2 } from './_shared.js';

function idempotencyTag(scope: 'x402' | 'agent-fund' | 'agent-approve', key?: string | null): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return `${scope}:${createHash('sha256').update(trimmed).digest('hex')}`;
}

function activityAmountUsd(a: { a: string }): number {
  const raw = a.a.replace(/[^0-9.-]/g, '');
  const value = Number(raw);
  return Number.isFinite(value) ? Math.abs(value) : NaN;
}

function assertSameAmount(actual: number, expected: number): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.005) {
    throw new Error('idempotency_key_reused');
  }
}

export class InMemoryAgents {
  private agentWallets = new Map<string, AgentWalletRecord>();
  private agentDigests = new Map<
    string,
    { lastSentAt: Date; lastWindowSpentUsd: number }
  >();

  constructor(private state: InMemoryState) {}

  /**
   * Scale wave 3 — SessionUser params are detached projections; in-memory
   * persistence lives on the canonical `usersById` map object. Aggregate
   * reads AND balance mutations must target that object, or writes are lost.
   */
  private full(u: SessionUser): User {
    const row = this.state.usersById.get(u.id);
    if (!row) throw new Error('user_not_found');
    return row;
  }

  async createAgent(
    u: SessionUser,
    name: string,
    perDayCapUsd: number,
    perTxCapUsd: number,
    allowlist: string[],
  ): Promise<Agent> {
    const agent: Agent = {
      id: randomUUID(),
      name,
      role: 'Custom agent',
      balanceUsd: 0,
      spentTodayUsd: 0,
      policy: {
        perTxCapUsd,
        perDayCapUsd,
        endpointAllowlist: allowlist,
        humanApprovalThresholdUsd: perTxCapUsd,
        expiresAt: null,
      },
      state: 'ready',
      createdAt: nowIso(),
    };
    this.full(u).agents.push(agent);
    return agent;
  }

  async agent(u: SessionUser, id: string): Promise<Agent> {
    const a = this.full(u).agents.find((x) => x.id === id || x.name === id);
    if (!a) throw new Error('agent_not_found');
    return a;
  }

  async fundAgent(
    u: SessionUser,
    agentId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<Agent> {
    const a = await this.agent(u, agentId);
    const idem = idempotencyTag('agent-fund', opts?.idempotencyKey);
    const fu = this.full(u);
    if (idem) {
      const existing = fu.activity.find((row) => row.txHash === idem);
      if (existing) {
        if (existing.signer !== a.id) throw new Error('idempotency_key_reused');
        assertSameAmount(activityAmountUsd(existing), amountUsd);
        return a;
      }
    }
    if (amountUsd > fu.balUsd) throw new PolicyError('insufficient_funds', 'Not enough in your main balance.');
    fu.balUsd -= amountUsd;
    a.balanceUsd += amountUsd;
    if (a.state === 'ready') a.state = 'live';
    await this.state.pushActivity(fu, {
      n: 'Funded ' + a.name,
      s: 'AGENT BUDGET · JUST NOW',
      a: '−' + money(amountUsd),
      k: 'agent',
      signer: a.id,
      ...(idem ? { txHash: idem } : {}),
    });
    return a;
  }

  async defundAgent(u: SessionUser, agentId: string): Promise<Agent> {
    const a = await this.agent(u, agentId);
    const fu = this.full(u);
    const back = a.balanceUsd;
    a.balanceUsd = 0;
    fu.balUsd += back;
    await this.state.pushActivity(fu, {
      n: 'Pulled back · ' + a.name,
      s: 'AGENT BUDGET · JUST NOW',
      a: '+' + money(back),
      pos: true,
      k: 'agent',
    });
    return a;
  }

  async setAgentPaused(u: SessionUser, agentId: string, paused: boolean): Promise<Agent> {
    const a = await this.agent(u, agentId);
    a.state = paused ? 'paused' : a.balanceUsd > 0 ? 'live' : 'ready';
    return a;
  }

  async updateAgentPolicy(u: SessionUser, agentId: string, patch: Partial<AgentPolicy>): Promise<Agent> {
    const a = await this.agent(u, agentId);
    Object.assign(a.policy, patch);
    return a;
  }

  async x402Pay(
    u: SessionUser,
    agentId: string,
    endpoint: string,
    amountUsd: number,
    reason: string,
    settlementRef?: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<X402PayResult> {
    const a = await this.agent(u, agentId);
    const idem = idempotencyTag('x402', opts?.idempotencyKey);
    const fu = this.full(u);

    if (idem) {
      const existing = fu.activity.find((row) => row.txHash === idem);
      if (existing) {
        if (existing.signer !== endpoint) throw new Error('idempotency_key_reused');
        assertSameAmount(activityAmountUsd(existing), amountUsd);
        const receipt = fu.x402Events.find((event) => event.ref === idem) ?? {
          id: existing.id,
          contractId: null,
          buyer: a.name,
          buyerType: 'agent' as const,
          resource: endpoint,
          amountUsd,
          httpStatus: 200,
          ref: idem,
          at: existing.at,
        };
        return { receipt, activity: existing };
      }
    }

    if (fu.killSwitch) throw new PolicyError('kill_switch', 'Kill switch is on — every agent is paused.');
    if (a.state === 'paused' || a.state === 'blocked')
      throw new PolicyError('agent_paused', `${a.name} is ${a.state}.`);
    if (a.policy.expiresAt && new Date(a.policy.expiresAt) < new Date())
      throw new PolicyError('expired', 'Agent policy expired.');

    let host: string;
    try {
      host = new URL(endpoint.startsWith('http') ? endpoint : 'https://' + endpoint).hostname;
    } catch {
      throw new PolicyError('endpoint_not_allowed', 'Endpoint is not a valid URL.');
    }
    const allowed = a.policy.endpointAllowlist.some((h) => host === h || host.endsWith('.' + h));
    if (!allowed)
      throw new PolicyError('endpoint_not_allowed', `${host} is not on ${a.name}'s allowlist.`);

    if (amountUsd > a.policy.humanApprovalThresholdUsd)
      throw new PolicyError(
        'needs_human_approval',
        `${money(amountUsd)} is above ${money(a.policy.humanApprovalThresholdUsd)} — needs your OK.`,
      );
    if (amountUsd > a.policy.perTxCapUsd)
      throw new PolicyError(
        'needs_approval',
        `${money(amountUsd)} is above the ${money(a.policy.perTxCapUsd)}/tx cap — needs your OK.`,
      );
    if (a.spentTodayUsd + amountUsd > a.policy.perDayCapUsd)
      throw new PolicyError('per_day_cap', `Would exceed the ${money(a.policy.perDayCapUsd)}/day cap.`);
    if (amountUsd > a.balanceUsd)
      throw new PolicyError('insufficient_funds', `${a.name} only holds ${money(a.balanceUsd)}.`);

    a.balanceUsd -= amountUsd;
    a.spentTodayUsd += amountUsd;

    const receipt: X402Event = {
      id: randomUUID(),
      contractId: null,
      buyer: a.name,
      buyerType: 'agent',
      resource: endpoint,
      amountUsd,
      httpStatus: 200,
      ref: idem ?? settlementRef ?? ref(),
      at: nowIso(),
    };
    fu.x402Events.unshift(receipt);

    const activity = await this.state.pushActivity(fu, {
      n: 'Paid ' + host,
      s: `${reason.toUpperCase()} · ✓ POLICY`,
      a: '−' + money(amountUsd),
      k: 'x402',
      signer: endpoint,
      ...(idem ? { txHash: idem } : {}),
    });
    return { receipt, activity };
  }

  async x402ApproveOnce(
    u: SessionUser,
    agentId: string,
    endpoint: string,
    amountUsd: number,
    reason: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<X402PayResult> {
    const a = await this.agent(u, agentId);
    const idem = idempotencyTag('agent-approve', opts?.idempotencyKey);
    const fu = this.full(u);

    if (idem) {
      const existing = fu.activity.find((row) => row.txHash === idem);
      if (existing) {
        if (existing.signer !== endpoint || existing.chain !== a.id) throw new Error('idempotency_key_reused');
        assertSameAmount(activityAmountUsd(existing), amountUsd);
        const receipt = fu.x402Events.find((event) => event.ref === idem) ?? {
          id: existing.id,
          contractId: null,
          buyer: a.name,
          buyerType: 'agent' as const,
          resource: endpoint,
          amountUsd,
          httpStatus: 200,
          ref: idem,
          at: existing.at,
        };
        return { receipt, activity: existing };
      }
    }
    if (fu.killSwitch) throw new PolicyError('kill_switch', 'Kill switch is on.');
    if (a.state === 'paused' || a.state === 'blocked')
      throw new PolicyError('agent_paused', `${a.name} is ${a.state}.`);
    if (a.policy.expiresAt && new Date(a.policy.expiresAt) < new Date())
      throw new PolicyError('expired', 'Agent policy expired.');
    if (a.spentTodayUsd + amountUsd > a.policy.perDayCapUsd)
      throw new PolicyError('per_day_cap', `Would exceed the daily cap even with approval.`);
    if (amountUsd > a.balanceUsd)
      throw new PolicyError('insufficient_funds', `${a.name} only holds ${money(a.balanceUsd)}.`);

    a.balanceUsd -= amountUsd;
    a.spentTodayUsd += amountUsd;
    const receipt: X402Event = {
      id: randomUUID(),
      contractId: null,
      buyer: a.name,
      buyerType: 'agent',
      resource: endpoint,
      amountUsd,
      httpStatus: 200,
      ref: idem ?? ref(),
      at: nowIso(),
    };
    fu.x402Events.unshift(receipt);
    const activity = await this.state.pushActivity(fu, {
      n: `Released ${money(amountUsd)} · ${reason}`,
      s: 'APPROVED BY YOU · JUST NOW',
      a: '−' + money(amountUsd),
      k: 'agent',
      signer: endpoint,
      chain: a.id,
      ...(idem ? { txHash: idem } : {}),
    });
    return { receipt, activity };
  }

  /* ── contracts ── */

  async createContract(
    u: SessionUser,
    name: string,
    endpointPath: string,
    method: 'GET' | 'POST',
    priceUsd: number,
    currency: 'USDC' | 'EURC',
  ): Promise<X402Contract> {
    const c: X402Contract = {
      id: randomUUID(),
      name,
      endpointPath,
      method,
      priceUsd,
      currency,
      status: 'live',
      requestsToday: 0,
      revenueTodayUsd: 0,
      paidSuccessRate: 1,
    };
    this.full(u).contracts.push(c);
    return c;
  }

  async contract(u: SessionUser, id: string): Promise<X402Contract> {
    const c = this.full(u).contracts.find((x) => x.id === id);
    if (!c) throw new Error('contract_not_found');
    return c;
  }

  async setContractStatus(u: SessionUser, id: string, status: 'live' | 'paused'): Promise<X402Contract> {
    const c = await this.contract(u, id);
    c.status = status;
    return c;
  }

  async findContractByEndpoint(
    endpointPath: string,
  ): Promise<{ id: string; payeeAddress: string | null } | null> {
    for (const u of this.state.usersById.values()) {
      for (const c of u.contracts) {
        if (c.endpointPath === endpointPath) {
          return { id: c.id, payeeAddress: c.payeeAddress ?? null };
        }
      }
    }
    return null;
  }

  async findContractById(
    contractId: string,
  ): Promise<{ id: string; payeeAddress: string | null } | null> {
    for (const u of this.state.usersById.values()) {
      const c = u.contracts.find((x) => x.id === contractId);
      if (c) return { id: c.id, payeeAddress: c.payeeAddress ?? null };
    }
    return null;
  }

  /* ── Privy wallets ── */

  async getAgentWallet(agentId: string): Promise<AgentWalletRecord | null> {
    return this.agentWallets.get(agentId) ?? null;
  }

  async setAgentWallet(agentId: string, input: AgentWalletRecord): Promise<AgentWalletRecord> {
    this.agentWallets.set(agentId, { ...input });
    return this.agentWallets.get(agentId)!;
  }

  /* ── digests ── */

  async recordAgentDigestSent(agentId: string, windowSpentUsd: number): Promise<void> {
    this.agentDigests.set(agentId, {
      lastSentAt: new Date(),
      lastWindowSpentUsd: windowSpentUsd,
    });
  }

  async findAgentsDueForDigest(cutoff: Date): Promise<AgentDigestDue[]> {
    const due: AgentDigestDue[] = [];
    for (const u of this.state.usersById.values()) {
      for (const a of u.agents) {
        if (a.spentTodayUsd <= 0) continue;
        const last = this.agentDigests.get(a.id);
        if (last && last.lastSentAt >= cutoff) continue;
        // Top endpoint over the same window — compute from x402Events authored
        // by this agent. Fallback to '—' when no events exist.
        let topEndpoint = '—';
        const tally = new Map<string, number>();
        for (const e of u.x402Events) {
          if (e.buyer !== a.name) continue;
          tally.set(e.resource, (tally.get(e.resource) ?? 0) + e.amountUsd);
        }
        let topUsd = 0;
        for (const [ep, usd] of tally.entries()) {
          if (usd > topUsd) {
            topUsd = usd;
            topEndpoint = ep;
          }
        }
        due.push({
          agentId: a.id,
          userId: u.id,
          spentUsd: round2(a.spentTodayUsd),
          topEndpoint,
        });
      }
    }
    return due;
  }

  /* ── dispose helper for the facade ──
   * Sprint 17 (Sweep #6) — InMemoryStore.dispose() now resets the agents
   * domain alongside the other modules so vitest's module-cache resets don't
   * leak agent-wallet or digest state across spec files. Agent rows
   * themselves live on `User.agents`, so the user map clear in dispose()
   * handles them; this drops the two side-Maps the agents domain owns.
   */
  clearAll(): void {
    this.agentWallets.clear();
    this.agentDigests.clear();
  }
}

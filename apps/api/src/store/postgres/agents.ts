/**
 * PgAgents — agents, policies, x402 events, contracts, Privy wallets, digests.
 *
 * Depends on LedgerStateManager for nb_user_state locking + activity emission
 * and on PgLedger for activity row writes ... only for funding/defunding.
 * x402Pay / x402ApproveOnce mutate the agent row directly inside their own
 * transactions and don't need to call PgLedger.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  nbAgentPolicies,
  nbAgentSpendDigests,
  nbAgents,
  nbPrivyWallets,
  nbTransactions,
  nbX402Contracts,
  nbX402Events,
} from '../../db/schema/index.js';
import {
  type Activity,
  type Agent,
  type AgentDigestDue,
  type AgentPolicy,
  type AgentWalletRecord,
  PolicyError,
  type SessionUser,
  type X402Contract,
  type X402Event,
  type X402PayResult,
} from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';
import { money, n, ref, round2 } from './_shared.js';

type TransactionRow = typeof nbTransactions.$inferSelect;
type X402EventRow = typeof nbX402Events.$inferSelect;

function idempotencyTag(scope: 'x402' | 'agent-fund' | 'agent-approve', key?: string | null): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return `${scope}:${createHash('sha256').update(trimmed).digest('hex')}`;
}

function activityFromTx(row: TransactionRow): Activity {
  const debit =
    row.kind === 'out' ||
    row.kind === 'x402' ||
    (row.kind === 'agent' && !row.title.startsWith('Pulled back'));
  const sign = debit ? '-' : '+';
  return {
    id: row.id,
    n: row.title,
    s: row.subtitle ?? '',
    a: sign + money(Math.abs(Number(row.amountUsd))),
    ...(debit ? {} : { pos: true }),
    k: row.kind as Activity['k'],
    at: row.createdAt.toISOString(),
    status: row.status,
    signer: row.counterparty ?? undefined,
    txHash: row.txHash ?? undefined,
    chain: row.chain ?? undefined,
  };
}

export function _activityFromTxForTests(row: TransactionRow): Activity {
  return activityFromTx(row);
}

function eventFromRow(row: X402EventRow): X402Event {
  return {
    id: row.id,
    contractId: row.contractId,
    buyer: row.buyer,
    buyerType: row.buyerType as 'agent' | 'human',
    resource: row.resource,
    amountUsd: n(row.amountUsd),
    httpStatus: row.httpStatus,
    ref: row.settlementRef ?? '',
    at: row.createdAt.toISOString(),
  };
}

function assertSameAmount(row: TransactionRow, expected: number): void {
  if (Math.abs(Number(row.amountUsd) - expected) > 0.005) {
    throw new Error('idempotency_key_reused');
  }
}

export class PgAgents {
  constructor(
    private db: Db,
    private core: LedgerStateManager,
  ) {}

  /* ── agents ── */

  async createAgent(
    u: SessionUser,
    name: string,
    perDayCapUsd: number,
    perTxCapUsd: number,
    allowlist: string[],
  ): Promise<Agent> {
    const id = randomUUID();
    const at = new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(nbAgents).values({
        id,
        userId: u.id,
        name,
        role: 'Custom agent',
        state: 'ready',
        balanceUsd: '0',
        spentTodayUsd: '0',
        createdAt: at,
      });
      await tx.insert(nbAgentPolicies).values({
        agentId: id,
        perTxCapUsd: perTxCapUsd.toFixed(6),
        perDayCapUsd: perDayCapUsd.toFixed(6),
        endpointAllowlist: allowlist,
        humanApprovalThresholdUsd: perTxCapUsd.toFixed(6),
        expiresAt: null,
      });
    });
    await this.core.invalidateUser(u.id);
    return {
      id,
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
      createdAt: at.toISOString(),
    };
  }

  async agent(u: SessionUser, id: string): Promise<Agent> {
    // Scale wave 3 — session projections no longer carry agents[]. Keep the
    // snapshot fast-path for callers that still pass a full User (worker
    // paths), and widen the DB fallback to match by name as well as UUID so
    // name lookups keep working for session-authenticated requests.
    const snapshotAgents = (u as { agents?: Agent[] }).agents;
    const fromSnapshot = snapshotAgents?.find((x) => x.id === id || x.name === id);
    if (fromSnapshot) return fromSnapshot;
    const rows = await this.db
      .select()
      .from(nbAgents)
      .where(
        and(
          eq(nbAgents.userId, u.id),
          /^[0-9a-f-]{36}$/i.test(id) ? eq(nbAgents.id, id) : eq(nbAgents.name, id),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new Error('agent_not_found');
    const fresh = await this.core.hydrateUser(u.id);
    const found = fresh.agents.find((a) => a.id === rows[0]!.id);
    if (!found) throw new Error('agent_not_found');
    return found;
  }

  async fundAgent(
    u: SessionUser,
    agentId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<Agent> {
    const a = await this.agent(u, agentId);
    const idem = idempotencyTag('agent-fund', opts?.idempotencyKey);
    if (idem) {
      const [existing] = await this.db
        .select()
        .from(nbTransactions)
        .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
        .limit(1);
      if (existing) {
        if ((existing.counterparty ?? '') !== a.id) throw new Error('idempotency_key_reused');
        assertSameAmount(existing, amountUsd);
        const freshUser = await this.core.hydrateUser(u.id);
        return freshUser.agents.find((agent) => agent.id === a.id) ?? a;
      }
    }
    let resultAgent: Agent = a;
    let activity!: Activity;
    let fresh = true;
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      if (idem) {
        const [existing] = await tx
          .select()
          .from(nbTransactions)
          .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
          .limit(1);
        if (existing) {
          if ((existing.counterparty ?? '') !== a.id) throw new Error('idempotency_key_reused');
          assertSameAmount(existing, amountUsd);
          const [agentAfter] = await tx.select().from(nbAgents).where(eq(nbAgents.id, a.id)).limit(1);
          resultAgent = agentAfter
            ? { ...a, balanceUsd: n(agentAfter.balanceUsd), state: agentAfter.state as Agent['state'] }
            : a;
          activity = activityFromTx(existing);
          fresh = false;
          u.balUsd = state.balUsd;
          return;
        }
      }
      if (amountUsd > state.balUsd)
        throw new PolicyError('insufficient_funds', 'Not enough in your main balance.');
      state.balUsd -= amountUsd;
      await this.core.writeUserState(tx, u.id, state);

      const [updated] = await tx
        .update(nbAgents)
        .set({
          balanceUsd: sql`${nbAgents.balanceUsd} + ${amountUsd.toFixed(6)}`,
          state: a.state === 'ready' ? 'live' : a.state,
        })
        .where(eq(nbAgents.id, a.id))
        .returning();
      const newBal = n(updated!.balanceUsd);

      const id = randomUUID();
      const at = new Date();
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        agentId: a.id,
        kind: 'agent',
        status: 'confirmed',
        title: 'Funded ' + a.name,
        subtitle: 'AGENT BUDGET · JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        counterparty: a.id,
        txHash: idem ?? undefined,
        createdAt: at,
      });
      activity = {
        id,
        n: 'Funded ' + a.name,
        s: 'AGENT BUDGET · JUST NOW',
        a: '−' + money(amountUsd),
        k: 'agent',
        signer: a.id,
        ...(idem ? { txHash: idem } : {}),
        at: at.toISOString(),
      };
      resultAgent = { ...a, balanceUsd: newBal, state: updated!.state as Agent['state'] };
      u.balUsd = state.balUsd;
    });
    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    return resultAgent;
  }

  async defundAgent(u: SessionUser, agentId: string): Promise<Agent> {
    const a = await this.agent(u, agentId);
    let activity!: Activity;
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      const back = a.balanceUsd;
      state.balUsd += back;
      await this.core.writeUserState(tx, u.id, state);
      await tx
        .update(nbAgents)
        .set({ balanceUsd: '0' })
        .where(eq(nbAgents.id, a.id));
      const id = randomUUID();
      const at = new Date();
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        agentId: a.id,
        kind: 'agent',
        status: 'confirmed',
        title: 'Pulled back · ' + a.name,
        subtitle: 'AGENT BUDGET · JUST NOW',
        amountUsd: back.toFixed(6),
        createdAt: at,
      });
      activity = {
        id,
        n: 'Pulled back · ' + a.name,
        s: 'AGENT BUDGET · JUST NOW',
        a: '+' + money(back),
        pos: true,
        k: 'agent',
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
    });
    await this.core.invalidateUser(u.id);
    this.core.emitActivity(u.id, activity);
    return { ...a, balanceUsd: 0 };
  }

  async setAgentPaused(u: SessionUser, agentId: string, paused: boolean): Promise<Agent> {
    const a = await this.agent(u, agentId);
    const newState: Agent['state'] = paused ? 'paused' : a.balanceUsd > 0 ? 'live' : 'ready';
    await this.db.update(nbAgents).set({ state: newState }).where(eq(nbAgents.id, a.id));
    await this.core.invalidateUser(u.id);
    return { ...a, state: newState };
  }

  async updateAgentPolicy(u: SessionUser, agentId: string, patch: Partial<AgentPolicy>): Promise<Agent> {
    const a = await this.agent(u, agentId);
    const merged: AgentPolicy = { ...a.policy, ...patch };
    await this.db
      .update(nbAgentPolicies)
      .set({
        perTxCapUsd: merged.perTxCapUsd.toFixed(6),
        perDayCapUsd: merged.perDayCapUsd.toFixed(6),
        endpointAllowlist: merged.endpointAllowlist,
        humanApprovalThresholdUsd: merged.humanApprovalThresholdUsd.toFixed(6),
        expiresAt: merged.expiresAt ? new Date(merged.expiresAt) : null,
        updatedAt: new Date(),
      })
      .where(eq(nbAgentPolicies.agentId, a.id));
    await this.core.invalidateUser(u.id);
    return { ...a, policy: merged };
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

    if (idem) {
      const [existing] = await this.db
        .select()
        .from(nbTransactions)
        .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
        .limit(1);
      if (existing) {
        if ((existing.counterparty ?? '') !== endpoint) throw new Error('idempotency_key_reused');
        assertSameAmount(existing, amountUsd);
        const [event] = await this.db
          .select()
          .from(nbX402Events)
          .where(and(eq(nbX402Events.userId, u.id), eq(nbX402Events.settlementRef, idem)))
          .limit(1);
        const receipt = event
          ? eventFromRow(event)
          : {
              id: existing.id,
              contractId: null,
              buyer: a.name,
              buyerType: 'agent' as const,
              resource: endpoint,
              amountUsd,
              httpStatus: 200,
              ref: idem,
              at: existing.createdAt.toISOString(),
            };
        return { receipt, activity: activityFromTx(existing) };
      }
    }

    // Validate first (no DB writes on a fail).
    const state = await this.core.readUserState(u.id);
    if (state.killSwitch) throw new PolicyError('kill_switch', 'Kill switch is on — every agent is paused.');
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

    // Stack upgrades Phase 3 — human-approval threshold is the "ask first" line.
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

    let receipt!: X402Event;
    let activity!: Activity;
    let fresh = true;

    await this.db.transaction(async (tx) => {
      // Re-validate inside tx with row lock to prevent double-spend.
      // Sprint 13 COMMIT 4 (SR2) — also re-read user state under lock and
      // re-check killSwitch. The pre-fix path read killSwitch outside the tx
      // and only locked the agent row, so a kill-switch flip racing with an
      // in-flight payment could be silently bypassed.
      const userState = await this.core.lockUserState(tx, u.id);
      if (userState.killSwitch)
        throw new PolicyError('kill_switch', 'Kill switch is on — every agent is paused.');

      if (idem) {
        const [existing] = await tx
          .select()
          .from(nbTransactions)
          .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
          .limit(1);
        if (existing) {
          if ((existing.counterparty ?? '') !== endpoint) throw new Error('idempotency_key_reused');
          assertSameAmount(existing, amountUsd);
          const [event] = await tx
            .select()
            .from(nbX402Events)
            .where(and(eq(nbX402Events.userId, u.id), eq(nbX402Events.settlementRef, idem)))
            .limit(1);
          receipt = event
            ? eventFromRow(event)
            : {
                id: existing.id,
                contractId: null,
                buyer: a.name,
                buyerType: 'agent' as const,
                resource: endpoint,
                amountUsd,
                httpStatus: 200,
                ref: idem,
                at: existing.createdAt.toISOString(),
              };
          activity = activityFromTx(existing);
          fresh = false;
          u.balUsd = userState.balUsd;
          u.earnUsd = userState.earnUsd;
          return;
        }
      }

      const [agentLocked] = await tx
        .select()
        .from(nbAgents)
        .where(eq(nbAgents.id, a.id))
        .for('update');
      if (!agentLocked) throw new Error('agent_not_found');
      const balanceUsd = n(agentLocked.balanceUsd);
      const spentTodayUsd = n(agentLocked.spentTodayUsd);
      if (amountUsd > balanceUsd)
        throw new PolicyError('insufficient_funds', `${a.name} only holds ${money(balanceUsd)}.`);
      if (spentTodayUsd + amountUsd > a.policy.perDayCapUsd)
        throw new PolicyError('per_day_cap', `Would exceed the ${money(a.policy.perDayCapUsd)}/day cap.`);

      await tx
        .update(nbAgents)
        .set({
          balanceUsd: (balanceUsd - amountUsd).toFixed(6),
          spentTodayUsd: (spentTodayUsd + amountUsd).toFixed(6),
        })
        .where(eq(nbAgents.id, a.id));

      const eventId = randomUUID();
      const refStr = idem ?? settlementRef ?? ref();
      const at = new Date();
      await tx.insert(nbX402Events).values({
        id: eventId,
        userId: u.id,
        agentId: a.id,
        buyer: a.name,
        buyerType: 'agent',
        resource: endpoint,
        amountUsd: amountUsd.toFixed(6),
        httpStatus: 200,
        settlementRef: refStr,
        createdAt: at,
      });
      receipt = {
        id: eventId,
        contractId: null,
        buyer: a.name,
        buyerType: 'agent',
        resource: endpoint,
        amountUsd,
        httpStatus: 200,
        ref: refStr,
        at: at.toISOString(),
      };

      const txId = randomUUID();
      await tx.insert(nbTransactions).values({
        id: txId,
        userId: u.id,
        agentId: a.id,
        kind: 'x402',
        status: 'confirmed',
        title: 'Paid ' + host,
        subtitle: `${reason.toUpperCase()} · ✓ POLICY`,
        amountUsd: amountUsd.toFixed(6),
        counterparty: endpoint,
        txHash: idem ?? undefined,
        createdAt: at,
      });
      activity = {
        id: txId,
        n: 'Paid ' + host,
        s: `${reason.toUpperCase()} · ✓ POLICY`,
        a: '−' + money(amountUsd),
        k: 'x402',
        signer: endpoint,
        ...(idem ? { txHash: idem } : {}),
        at: at.toISOString(),
      };
    });

    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
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
    if (idem) {
      const [existing] = await this.db
        .select()
        .from(nbTransactions)
        .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
        .limit(1);
      if (existing) {
        if (existing.agentId !== a.id || (existing.counterparty ?? '') !== endpoint)
          throw new Error('idempotency_key_reused');
        assertSameAmount(existing, amountUsd);
        const [event] = await this.db
          .select()
          .from(nbX402Events)
          .where(and(eq(nbX402Events.userId, u.id), eq(nbX402Events.settlementRef, idem)))
          .limit(1);
        const receipt = event
          ? eventFromRow(event)
          : {
              id: existing.id,
              contractId: null,
              buyer: a.name,
              buyerType: 'agent' as const,
              resource: endpoint,
              amountUsd,
              httpStatus: 200,
              ref: idem,
              at: existing.createdAt.toISOString(),
            };
        return { receipt, activity: activityFromTx(existing) };
      }
    }
    const state = await this.core.readUserState(u.id);
    if (state.killSwitch) throw new PolicyError('kill_switch', 'Kill switch is on.');
    if (a.state === 'paused' || a.state === 'blocked')
      throw new PolicyError('agent_paused', `${a.name} is ${a.state}.`);
    if (a.policy.expiresAt && new Date(a.policy.expiresAt) < new Date())
      throw new PolicyError('expired', 'Agent policy expired.');

    let receipt!: X402Event;
    let activity!: Activity;
    let fresh = true;
    await this.db.transaction(async (tx) => {
      // Sprint 13 COMMIT 4 (SR2) — re-read killSwitch under lock so the flip
      // can't race with the in-flight one-off approval.
      const userState = await this.core.lockUserState(tx, u.id);
      if (userState.killSwitch) throw new PolicyError('kill_switch', 'Kill switch is on.');

      if (idem) {
        const [existing] = await tx
          .select()
          .from(nbTransactions)
          .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
          .limit(1);
        if (existing) {
          if (existing.agentId !== a.id || (existing.counterparty ?? '') !== endpoint)
            throw new Error('idempotency_key_reused');
          assertSameAmount(existing, amountUsd);
          const [event] = await tx
            .select()
            .from(nbX402Events)
            .where(and(eq(nbX402Events.userId, u.id), eq(nbX402Events.settlementRef, idem)))
            .limit(1);
          receipt = event
            ? eventFromRow(event)
            : {
                id: existing.id,
                contractId: null,
                buyer: a.name,
                buyerType: 'agent' as const,
                resource: endpoint,
                amountUsd,
                httpStatus: 200,
                ref: idem,
                at: existing.createdAt.toISOString(),
              };
          activity = activityFromTx(existing);
          fresh = false;
          return;
        }
      }

      const [agentLocked] = await tx
        .select()
        .from(nbAgents)
        .where(eq(nbAgents.id, a.id))
        .for('update');
      if (!agentLocked) throw new Error('agent_not_found');
      const balanceUsd = n(agentLocked.balanceUsd);
      const spentTodayUsd = n(agentLocked.spentTodayUsd);
      if (spentTodayUsd + amountUsd > a.policy.perDayCapUsd)
        throw new PolicyError('per_day_cap', `Would exceed the daily cap even with approval.`);
      if (amountUsd > balanceUsd)
        throw new PolicyError('insufficient_funds', `${a.name} only holds ${money(balanceUsd)}.`);

      await tx
        .update(nbAgents)
        .set({
          balanceUsd: (balanceUsd - amountUsd).toFixed(6),
          spentTodayUsd: (spentTodayUsd + amountUsd).toFixed(6),
        })
        .where(eq(nbAgents.id, a.id));

      const eventId = randomUUID();
      const refStr = idem ?? ref();
      const at = new Date();
      await tx.insert(nbX402Events).values({
        id: eventId,
        userId: u.id,
        agentId: a.id,
        buyer: a.name,
        buyerType: 'agent',
        resource: endpoint,
        amountUsd: amountUsd.toFixed(6),
        httpStatus: 200,
        settlementRef: refStr,
        createdAt: at,
      });
      receipt = {
        id: eventId,
        contractId: null,
        buyer: a.name,
        buyerType: 'agent',
        resource: endpoint,
        amountUsd,
        httpStatus: 200,
        ref: refStr,
        at: at.toISOString(),
      };

      const txId = randomUUID();
      await tx.insert(nbTransactions).values({
        id: txId,
        userId: u.id,
        agentId: a.id,
        kind: 'agent',
        status: 'confirmed',
        title: `Released ${money(amountUsd)} · ${reason}`,
        subtitle: 'APPROVED BY YOU · JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        counterparty: endpoint,
        txHash: idem ?? undefined,
        createdAt: at,
      });
      activity = {
        id: txId,
        n: `Released ${money(amountUsd)} · ${reason}`,
        s: 'APPROVED BY YOU · JUST NOW',
        a: '−' + money(amountUsd),
        k: 'agent',
        signer: endpoint,
        chain: a.id,
        ...(idem ? { txHash: idem } : {}),
        at: at.toISOString(),
      };
    });
    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    return { receipt, activity };
  }

  /* ── x402 vendor (contracts) ── */

  async createContract(
    u: SessionUser,
    name: string,
    endpointPath: string,
    method: 'GET' | 'POST',
    priceUsd: number,
    currency: 'USDC' | 'EURC',
  ): Promise<X402Contract> {
    const id = randomUUID();
    await this.db.insert(nbX402Contracts).values({
      id,
      userId: u.id,
      name,
      endpointPath,
      method,
      priceUsd: priceUsd.toFixed(6),
      currency,
      status: 'live',
      requestsToday: 0,
      revenueTodayUsd: '0',
    });
    await this.core.invalidateUser(u.id);
    return {
      id,
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
  }

  async contract(u: SessionUser, id: string): Promise<X402Contract> {
    const [row] = await this.db
      .select()
      .from(nbX402Contracts)
      .where(and(eq(nbX402Contracts.userId, u.id), eq(nbX402Contracts.id, id)))
      .limit(1);
    if (!row) throw new Error('contract_not_found');
    return {
      id: row.id,
      name: row.name,
      endpointPath: row.endpointPath,
      method: row.method as 'GET' | 'POST',
      priceUsd: n(row.priceUsd),
      currency: row.currency as 'USDC' | 'EURC',
      status: row.status as 'live' | 'paused',
      requestsToday: row.requestsToday,
      revenueTodayUsd: n(row.revenueTodayUsd),
      paidSuccessRate: 1,
      payeeAddress: row.payeeAddress,
    };
  }

  async findContractByEndpoint(
    endpointPath: string,
  ): Promise<{ id: string; payeeAddress: string | null } | null> {
    const [row] = await this.db
      .select({ id: nbX402Contracts.id, payeeAddress: nbX402Contracts.payeeAddress })
      .from(nbX402Contracts)
      .where(eq(nbX402Contracts.endpointPath, endpointPath))
      .limit(1);
    return row ?? null;
  }

  async findContractById(
    contractId: string,
  ): Promise<{ id: string; payeeAddress: string | null } | null> {
    const [row] = await this.db
      .select({ id: nbX402Contracts.id, payeeAddress: nbX402Contracts.payeeAddress })
      .from(nbX402Contracts)
      .where(eq(nbX402Contracts.id, contractId))
      .limit(1);
    return row ?? null;
  }

  async setContractStatus(u: SessionUser, id: string, status: 'live' | 'paused'): Promise<X402Contract> {
    const c = await this.contract(u, id);
    await this.db.update(nbX402Contracts).set({ status }).where(eq(nbX402Contracts.id, id));
    await this.core.invalidateUser(u.id);
    return { ...c, status };
  }

  /* ── per-agent Privy wallets ── */

  async getAgentWallet(agentId: string): Promise<AgentWalletRecord | null> {
    const [row] = await this.db
      .select()
      .from(nbPrivyWallets)
      .where(eq(nbPrivyWallets.agentId, agentId))
      .limit(1);
    if (!row) return null;
    return { walletId: row.walletId, address: row.address, chain: row.chain };
  }

  async setAgentWallet(agentId: string, input: AgentWalletRecord): Promise<AgentWalletRecord> {
    await this.db
      .insert(nbPrivyWallets)
      .values({
        agentId,
        walletId: input.walletId,
        address: input.address,
        chain: input.chain,
      })
      .onConflictDoUpdate({
        target: [nbPrivyWallets.agentId, nbPrivyWallets.chain],
        set: { walletId: input.walletId, address: input.address },
      });
    return input;
  }

  /* ── digests ── */

  async recordAgentDigestSent(agentId: string, windowSpentUsd: number): Promise<void> {
    await this.db
      .insert(nbAgentSpendDigests)
      .values({
        agentId,
        lastSentAt: new Date(),
        lastWindowSpentUsd: windowSpentUsd.toFixed(6),
      })
      .onConflictDoUpdate({
        target: nbAgentSpendDigests.agentId,
        set: {
          lastSentAt: new Date(),
          lastWindowSpentUsd: windowSpentUsd.toFixed(6),
        },
      });
  }

  async findAgentsDueForDigest(cutoff: Date): Promise<AgentDigestDue[]> {
    // LEFT JOIN nb_agent_spend_digests so we include agents that have NEVER
    // been digested yet (lastSentAt IS NULL).
    const rows = await this.db
      .select({
        agentId: nbAgents.id,
        userId: nbAgents.userId,
        spentTodayUsd: nbAgents.spentTodayUsd,
        lastSentAt: nbAgentSpendDigests.lastSentAt,
      })
      .from(nbAgents)
      .leftJoin(nbAgentSpendDigests, eq(nbAgentSpendDigests.agentId, nbAgents.id))
      .where(
        and(
          // spend > 0 today; numeric column compared as text would order weird,
          // but `> '0'` works for non-negative magnitudes we always emit.
          sql`${nbAgents.spentTodayUsd}::numeric > 0`,
          or(isNull(nbAgentSpendDigests.lastSentAt), lt(nbAgentSpendDigests.lastSentAt, cutoff)),
        ),
      );
    if (rows.length === 0) return [];
    // F051 — single GROUP BY across all due agents, top endpoint picked in JS.
    const agentIds = rows.map((r) => r.agentId);
    const totals = await this.db
      .select({
        agentId: nbX402Events.agentId,
        resource: nbX402Events.resource,
        totalUsd: sql<string>`sum(${nbX402Events.amountUsd})`,
      })
      .from(nbX402Events)
      .where(inArray(nbX402Events.agentId, agentIds))
      .groupBy(nbX402Events.agentId, nbX402Events.resource);
    const topByAgent = new Map<string, { resource: string; total: number }>();
    for (const row of totals) {
      if (row.agentId === null) continue;
      const total = n(row.totalUsd);
      const prior = topByAgent.get(row.agentId);
      if (!prior || total > prior.total) {
        topByAgent.set(row.agentId, { resource: row.resource, total });
      }
    }
    return rows.map((r) => ({
      agentId: r.agentId,
      userId: r.userId,
      spentUsd: round2(n(r.spentTodayUsd)),
      topEndpoint: topByAgent.get(r.agentId)?.resource ?? '—',
    }));
  }
}

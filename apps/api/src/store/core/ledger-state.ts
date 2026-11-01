/**
 * LedgerStateManager — the user-state kernel shared across every postgres
 * domain module.
 *
 * Owns:
 *  - nb_user_state rows (lock/read/write/set)
 *  - Redis user cache (invalidate + hydrate-on-read)
 *  - Activity bus emission
 *  - hydrateUser — the User aggregate (5 parallel reads)
 *  - seedDemoData — demo bootstrap on first sign-up
 *  - sub-account row locking (used by payments splits)
 *
 * Every domain module receives this via constructor injection so the
 * money-mutating helpers (lockUserState / writeUserState) are reusable
 * without re-deriving the contract.
 */

import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { env } from '../../lib/env.js';
import {
  nbAgentPolicies,
  nbAgents,
  nbCardState,
  nbSubAccounts,
  nbTransactions,
  nbUserState,
  nbUsers,
  nbVirtualAccounts,
  nbX402Contracts,
  nbX402Events,
} from '../../db/schema/index.js';
import type { RedisClient } from '../../lib/redis.js';
import { RedisKeys } from '../../lib/redis.js';
import {
  type Activity,
  type Agent,
  type AgentPolicy,
  type KycStatus,
  type SessionUser,
  type User,
  type VaultTier,
  type VirtualAccount,
  type X402Contract,
  type X402Event,
} from '../types.js';
import { type DbExecutor, formatAmount, n, virtualAccountFromRow } from '../postgres/_shared.js';
import { decryptIfWrapped } from '../../lib/crypto.js';
import { log } from '../../lib/log.js';

/** Mutable per-user ledger snapshot threaded through the user-state helpers. */
export interface UserState {
  balUsd: number;
  /** EUR cash balance (EURC) — the other side of /swap. */
  eurUsd: number;
  sandboxBalUsd: number;
  earnUsd: number;
  killSwitch: boolean;
  /** Sprint 10 Item A — opt-in auto-deposit of topUp tail into earn. */
  earnByDefault: boolean;
  /** Sprint 10 Item A — opt-in auto-withdraw from earn when balUsd is short. */
  autoDivestOnSpend: boolean;
  /** Sprint 10 Item A — floor maintained in balUsd before auto-deposits hit earn. */
  divestThresholdUsd: number;
  /** Stack upgrades Phase 1 — earn router tier preference. */
  preferredVaultTier: VaultTier;
}

const USER_CACHE_TTL_S = 30;

function defaultUserState(): UserState {
  return {
    balUsd: env.DEMO_MODE ? 4820.4 : 0,
    eurUsd: 0,
    sandboxBalUsd: 0,
    earnUsd: env.DEMO_MODE ? 3200 : 0,
    killSwitch: false,
    earnByDefault: false,
    autoDivestOnSpend: false,
    divestThresholdUsd: 50,
    preferredVaultTier: 'standard',
  };
}

/**
 * SEC-01 helper: decrypt a stored secret, falling back to null on any error
 * so a corrupted/tampered envelope never silently flows into upstream HMAC
 * headers. The userId + field name are emitted to the warn log without the
 * value itself.
 */
function safeDecrypt(value: string | null | undefined, field: string, userId: string): string | null {
  if (value == null) return null;
  try {
    return decryptIfWrapped(value);
  } catch (e) {
    log.warn(
      { userId, field, err: e instanceof Error ? e.message : String(e) },
      'ledger-state: decryptIfWrapped failed; nulling field',
    );
    return null;
  }
}

export class LedgerStateManager {
  constructor(
    private db: Db,
    private redis: RedisClient | null,
    public readonly bus: EventEmitter,
  ) {}

  /* ── user hydration ── */

  /**
   * Scale plan 1.4 (2026-07-02) — single-flight per userId. requireSession
   * hydrates on EVERY authed request; on a Redis blip or 30s-TTL expiry a
   * burst of concurrent requests from the same user previously fanned out N
   * parallel ~8-query storms into a pool of 10 connections. Coalescing makes
   * that exactly one storm. Callers share the resolved User reference — the
   * same semantics the in-memory store has always had.
   */
  private readonly inflightHydrates = new Map<string, Promise<User>>();

  async hydrateUser(userId: string): Promise<User> {
    // Hardening 2026-07-03: request isolation without a per-call clone tax.
    // ~20 store sites mutate the request's User in place, and pre-coalescing
    // every request got its own object, so concurrent callers must NOT share
    // one reference. The CREATOR of the in-flight promise uniquely owns the
    // resolved object; every JOINER gets a structuredClone. Result: N callers
    // → N isolated objects, but the clone cost lands only on the (rarer)
    // coalesced joiners, leaving the hot sole-caller / Redis-hit path at one
    // JSON.parse exactly as before.
    const inflight = this.inflightHydrates.get(userId);
    if (inflight) return structuredClone(await inflight);
    const p = this.hydrateUserUncoalesced(userId).finally(() => {
      if (this.inflightHydrates.get(userId) === p) this.inflightHydrates.delete(userId);
    });
    this.inflightHydrates.set(userId, p);
    return p;
  }

  /* ── session-auth projection (scale wave 3) ──
   * requireSession runs on EVERY authed request; the full aggregate below is
   * ~9 queries. The projection is 3 primary-key reads and its own Redis key,
   * so the per-request auth cost no longer scales with activity history.
   * Same coalescing + joiner-clone semantics as hydrateUser. */
  private readonly inflightCoreHydrates = new Map<string, Promise<SessionUser>>();

  async hydrateUserCore(userId: string): Promise<SessionUser> {
    const inflight = this.inflightCoreHydrates.get(userId);
    if (inflight) return structuredClone(await inflight);
    const p = this.hydrateUserCoreUncoalesced(userId).finally(() => {
      if (this.inflightCoreHydrates.get(userId) === p) this.inflightCoreHydrates.delete(userId);
    });
    this.inflightCoreHydrates.set(userId, p);
    return p;
  }

  private async hydrateUserCoreUncoalesced(userId: string): Promise<SessionUser> {
    if (this.redis) {
      const cached = await this.redis.get(RedisKeys.userCoreCache(userId)).catch(() => null);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as SessionUser;
          return { ...parsed, privyDid: parsed.privyDid ?? null };
        } catch {
          /* fallthrough */
        }
      }
    }

    const [userRows, cardRows, balance] = await Promise.all([
      this.db.select().from(nbUsers).where(eq(nbUsers.id, userId)).limit(1),
      this.db.select().from(nbCardState).where(eq(nbCardState.userId, userId)).limit(1),
      this.readUserState(userId),
    ]);
    const userRow = userRows[0];
    if (!userRow) throw new Error('user_not_found');
    const card = cardRows[0];

    const user: SessionUser = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name ?? 'Member',
      privyDid: userRow.privyDid ?? null,
      privyWalletId: userRow.privyWalletId ?? null,
      privyWalletAddress: userRow.privyWalletAddress ?? null,
      hlBuilderApprovedAt: userRow.hlBuilderApprovedAt ? userRow.hlBuilderApprovedAt.toISOString() : null,
      hlBuilderMaxFeeTenthsBp: userRow.hlBuilderMaxFeeTenthsBp ?? null,
      pmClobKey: safeDecrypt(userRow.pmClobKey, 'pmClobKey', userRow.id),
      pmClobSecret: safeDecrypt(userRow.pmClobSecret, 'pmClobSecret', userRow.id),
      pmClobPassphrase: safeDecrypt(userRow.pmClobPassphrase, 'pmClobPassphrase', userRow.id),
      privySolWalletId: userRow.privySolWalletId ?? null,
      privySolWalletAddress: userRow.privySolWalletAddress ?? null,
      cohort: userRow.cohort ?? null,
      balUsd: balance.balUsd,
      eurUsd: balance.eurUsd,
      sandboxBalUsd: balance.sandboxBalUsd,
      earnUsd: balance.earnUsd,
      earnApy: 0.084,
      cardFrozen: card?.frozen ?? false,
      cardDayLimitUsd: card?.dayLimitUsd ?? 500,
      killSwitch: balance.killSwitch,
      kycStatus: (userRow.kycStatus as KycStatus) ?? 'none',
      bridgeCustomerId: userRow.bridgeCustomerId ?? null,
      earnByDefault: balance.earnByDefault,
      autoDivestOnSpend: balance.autoDivestOnSpend,
      divestThresholdUsd: balance.divestThresholdUsd,
      preferredVaultTier: balance.preferredVaultTier,
    };

    if (this.redis) {
      void this.redis.setex(RedisKeys.userCoreCache(userId), USER_CACHE_TTL_S, JSON.stringify(user));
    }
    return user;
  }

  private async hydrateUserUncoalesced(userId: string): Promise<User> {
    // Try cache first
    if (this.redis) {
      const cached = await this.redis.get(RedisKeys.userCache(userId)).catch(() => null);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as User;
          return { ...parsed, privyDid: parsed.privyDid ?? null };
        } catch {
          /* fallthrough */
        }
      }
    }

    const [userRow] = await this.db.select().from(nbUsers).where(eq(nbUsers.id, userId)).limit(1);
    if (!userRow) throw new Error('user_not_found');

    // Parallel queries for the rest of the snapshot (scale 1.4: the user-state
    // balance read rides the same batch instead of a sequential 8th query).
    const [cardRows, agentsRaw, contractsRaw, txRaw, x402EventsRaw, virtualAccountsRaw, balance] =
      await Promise.all([
        this.db.select().from(nbCardState).where(eq(nbCardState.userId, userId)).limit(1),
        this.db.select().from(nbAgents).where(eq(nbAgents.userId, userId)),
        this.db.select().from(nbX402Contracts).where(eq(nbX402Contracts.userId, userId)),
        this.db
          .select()
          .from(nbTransactions)
          .where(eq(nbTransactions.userId, userId))
          .orderBy(desc(nbTransactions.createdAt))
          .limit(50),
        this.db
          .select()
          .from(nbX402Events)
          .where(eq(nbX402Events.userId, userId))
          .orderBy(desc(nbX402Events.createdAt))
          .limit(50),
        this.db
          .select()
          .from(nbVirtualAccounts)
          .where(eq(nbVirtualAccounts.userId, userId))
          .orderBy(desc(nbVirtualAccounts.createdAt)),
        this.readUserState(userId),
      ]);

    // Hydrate agents with their policies.
    const agentIds = agentsRaw.map((a) => a.id);
    const policies = agentIds.length
      ? await this.db.select().from(nbAgentPolicies).where(inArray(nbAgentPolicies.agentId, agentIds))
      : [];
    const policyByAgent = new Map<string, (typeof policies)[number]>();
    for (const p of policies) policyByAgent.set(p.agentId, p);

    const agents: Agent[] = agentsRaw.map((row) => {
      const p = policyByAgent.get(row.id);
      const policy: AgentPolicy = p
        ? {
            perTxCapUsd: n(p.perTxCapUsd),
            perDayCapUsd: n(p.perDayCapUsd),
            endpointAllowlist: (p.endpointAllowlist as string[] | null) ?? [],
            humanApprovalThresholdUsd: n(p.humanApprovalThresholdUsd),
            expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
          }
        : {
            perTxCapUsd: 0,
            perDayCapUsd: 0,
            endpointAllowlist: [],
            humanApprovalThresholdUsd: 0,
            expiresAt: null,
          };
      return {
        id: row.id,
        name: row.name,
        role: row.role ?? 'Custom agent',
        balanceUsd: n(row.balanceUsd),
        spentTodayUsd: n(row.spentTodayUsd),
        policy,
        state: row.state as Agent['state'],
        createdAt: row.createdAt.toISOString(),
      };
    });

    const contracts: X402Contract[] = contractsRaw.map((c) => ({
      id: c.id,
      name: c.name,
      endpointPath: c.endpointPath,
      method: c.method as 'GET' | 'POST',
      priceUsd: n(c.priceUsd),
      currency: c.currency as 'USDC' | 'EURC',
      status: c.status as 'live' | 'paused',
      requestsToday: c.requestsToday,
      revenueTodayUsd: n(c.revenueTodayUsd),
      paidSuccessRate: 1,
      payeeAddress: c.payeeAddress,
    }));

    const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
    const activity: Activity[] = txRaw.map((t) => ({
      id: t.id,
      n: t.title,
      s: t.subtitle ?? '',
      a: formatAmount(n(t.amountUsd), t.kind),
      k: (t.kind as Activity['k']) ?? 'in',
      at: t.createdAt.toISOString(),
      status: t.status,
      txHash: t.txHash ?? undefined,
      chain: t.chain ?? undefined,
      signer: t.txHash && t.counterparty ? t.counterparty : undefined,
    }));

    const x402Events: X402Event[] = x402EventsRaw.map((e) => ({
      id: e.id,
      contractId: e.contractId,
      buyer: e.buyer,
      buyerType: e.buyerType as 'agent' | 'human',
      resource: e.resource,
      amountUsd: n(e.amountUsd),
      httpStatus: e.httpStatus,
      ref: e.settlementRef ?? '',
      at: e.createdAt.toISOString(),
    }));

    const virtualAccounts: VirtualAccount[] = virtualAccountsRaw.map(virtualAccountFromRow);

    const card = cardRows[0];

    const user: User = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name ?? 'Member',
      privyDid: userRow.privyDid ?? null,
      // Sprint 16.4 — Hyperliquid live trading prerequisites.
      privyWalletId: userRow.privyWalletId ?? null,
      privyWalletAddress: userRow.privyWalletAddress ?? null,
      hlBuilderApprovedAt: userRow.hlBuilderApprovedAt ? userRow.hlBuilderApprovedAt.toISOString() : null,
      hlBuilderMaxFeeTenthsBp: userRow.hlBuilderMaxFeeTenthsBp ?? null,
      // Audit 2026-06-19 — Polymarket CLOB L2 creds + Solana wallet pairing.
      // SEC-01 — values at rest are AES-256-GCM wrapped under PM_CLOB_ENC_KEY
      // when set. `decryptIfWrapped` is rolling-migration safe: it passes
      // legacy plaintext rows through unchanged. A decrypt FAILURE (tampered
      // ciphertext / wrong key) is logged and the field nulled so a corrupted
      // value can never silently flow into HMAC headers.
      pmClobKey: safeDecrypt(userRow.pmClobKey, 'pmClobKey', userRow.id),
      pmClobSecret: safeDecrypt(userRow.pmClobSecret, 'pmClobSecret', userRow.id),
      pmClobPassphrase: safeDecrypt(userRow.pmClobPassphrase, 'pmClobPassphrase', userRow.id),
      privySolWalletId: userRow.privySolWalletId ?? null,
      privySolWalletAddress: userRow.privySolWalletAddress ?? null,
      cohort: userRow.cohort ?? null,
      balUsd: 0,
      eurUsd: 0,
      sandboxBalUsd: 0,
      earnUsd: 0,
      earnApy: 0.084,
      cardFrozen: card?.frozen ?? false,
      cardDayLimitUsd: card?.dayLimitUsd ?? 500,
      killSwitch: false,
      kycStatus: (userRow.kycStatus as KycStatus) ?? 'none',
      bridgeCustomerId: userRow.bridgeCustomerId ?? null,
      earnByDefault: false,
      autoDivestOnSpend: false,
      divestThresholdUsd: 50,
      preferredVaultTier: 'standard',
      virtualAccounts,
      activity,
      agents,
      contracts,
      x402Events,
    };

    // Balance + earn live on the user row's virtual ledger via nb_transactions sums,
    // but for simplicity we keep them as derived fields on a synthetic "wallet" row
    // (read in the parallel batch above).
    user.balUsd = balance.balUsd;
    user.eurUsd = balance.eurUsd;
    user.sandboxBalUsd = balance.sandboxBalUsd;
    user.earnUsd = balance.earnUsd;
    user.killSwitch = balance.killSwitch;
    user.earnByDefault = balance.earnByDefault;
    user.autoDivestOnSpend = balance.autoDivestOnSpend;
    user.divestThresholdUsd = balance.divestThresholdUsd;
    user.preferredVaultTier = balance.preferredVaultTier;

    // Repopulate agent names on x402 events buyer string (already done via buyer field).
    void agentNameById;

    // Cache and return.
    if (this.redis) {
      void this.redis.setex(RedisKeys.userCache(userId), USER_CACHE_TTL_S, JSON.stringify(user));
    }
    return user;
  }

  async invalidateUser(userId: string): Promise<void> {
    // Hardening 2026-07-03: drop any in-flight coalesced hydrate so a caller
    // arriving after a money mutation can't join a read that STARTED before
    // the commit. Delete on BOTH sides of the Redis del: the pre-delete stops
    // current joiners; the post-delete evicts any hydrate that raced in during
    // the `await` window and re-seeded the map from the not-yet-deleted (thus
    // stale) Redis snapshot — closing the read-your-writes gap the single
    // delete left open.
    this.inflightHydrates.delete(userId);
    this.inflightCoreHydrates.delete(userId);
    if (this.redis) {
      await this.redis
        .del(RedisKeys.userCache(userId), RedisKeys.userCoreCache(userId))
        .catch(() => 0);
    }
    this.inflightHydrates.delete(userId);
    this.inflightCoreHydrates.delete(userId);
  }

  emitActivity(userId: string, row: Activity): void {
    this.bus.emit('activity', userId, row);
  }

  /* ── helpers: nb_user_state side table ── */

  /** Read user state with FOR UPDATE — call inside a transaction. */
  async lockUserState(tx: DbExecutor, userId: string): Promise<UserState> {
    const rows = await tx
      .select()
      .from(nbUserState)
      .where(eq(nbUserState.userId, userId))
      .for('update');
    const row = rows[0];
    if (!row) {
      const defaults = defaultUserState();
      await tx
        .insert(nbUserState)
        .values({
          userId,
          balUsd: defaults.balUsd.toFixed(6),
          eurUsd: defaults.eurUsd.toFixed(6),
          sandboxBalUsd: defaults.sandboxBalUsd.toFixed(6),
          earnUsd: defaults.earnUsd.toFixed(6),
          killSwitch: defaults.killSwitch,
          earnByDefault: defaults.earnByDefault,
          autoDivestOnSpend: defaults.autoDivestOnSpend,
          divestThresholdUsd: defaults.divestThresholdUsd.toFixed(6),
          preferredVaultTier: defaults.preferredVaultTier,
        })
        .onConflictDoNothing();
      return defaults;
    }
    return {
      balUsd: Number(row.balUsd),
      eurUsd: Number(row.eurUsd),
      sandboxBalUsd: Number(row.sandboxBalUsd),
      earnUsd: Number(row.earnUsd),
      killSwitch: row.killSwitch,
      earnByDefault: row.earnByDefault,
      autoDivestOnSpend: row.autoDivestOnSpend,
      divestThresholdUsd: Number(row.divestThresholdUsd),
      preferredVaultTier: (row.preferredVaultTier as VaultTier) ?? 'standard',
    };
  }

  async readUserState(userId: string): Promise<UserState> {
    const rows = await this.db
      .select()
      .from(nbUserState)
      .where(eq(nbUserState.userId, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return defaultUserState();
    return {
      balUsd: Number(row.balUsd),
      eurUsd: Number(row.eurUsd),
      sandboxBalUsd: Number(row.sandboxBalUsd),
      earnUsd: Number(row.earnUsd),
      killSwitch: row.killSwitch,
      earnByDefault: row.earnByDefault,
      autoDivestOnSpend: row.autoDivestOnSpend,
      divestThresholdUsd: Number(row.divestThresholdUsd),
      preferredVaultTier: (row.preferredVaultTier as VaultTier) ?? 'standard',
    };
  }

  async writeUserState(db: DbExecutor, userId: string, state: UserState): Promise<void> {
    await db
      .insert(nbUserState)
      .values({
        userId,
        balUsd: state.balUsd.toFixed(6),
        eurUsd: state.eurUsd.toFixed(6),
        sandboxBalUsd: state.sandboxBalUsd.toFixed(6),
        earnUsd: state.earnUsd.toFixed(6),
        killSwitch: state.killSwitch,
        earnByDefault: state.earnByDefault,
        autoDivestOnSpend: state.autoDivestOnSpend,
        divestThresholdUsd: state.divestThresholdUsd.toFixed(6),
        preferredVaultTier: state.preferredVaultTier,
      })
      .onConflictDoUpdate({
        target: nbUserState.userId,
        set: {
          balUsd: state.balUsd.toFixed(6),
          eurUsd: state.eurUsd.toFixed(6),
          sandboxBalUsd: state.sandboxBalUsd.toFixed(6),
          earnUsd: state.earnUsd.toFixed(6),
          killSwitch: state.killSwitch,
          earnByDefault: state.earnByDefault,
          autoDivestOnSpend: state.autoDivestOnSpend,
          divestThresholdUsd: state.divestThresholdUsd.toFixed(6),
          preferredVaultTier: state.preferredVaultTier,
          updatedAt: new Date(),
        },
      });
  }

  async setUserState(userId: string, state: UserState): Promise<void> {
    await this.writeUserState(this.db, userId, state);
  }

  /* ── helpers: nb_sub_accounts balances (live + sandbox) ── */

  /** Lock a sub-account row FOR UPDATE — call inside a transaction. Null if gone. */
  async lockSubAccount(
    tx: DbExecutor,
    id: string,
  ): Promise<{ balUsd: number; sandboxBalUsd: number } | null> {
    const rows = await tx.select().from(nbSubAccounts).where(eq(nbSubAccounts.id, id)).for('update');
    const row = rows[0];
    if (!row) return null;
    return { balUsd: Number(row.balUsd), sandboxBalUsd: Number(row.sandboxBalUsd) };
  }

  async writeSubAccount(
    tx: DbExecutor,
    id: string,
    state: { balUsd: number; sandboxBalUsd: number },
  ): Promise<void> {
    await tx
      .update(nbSubAccounts)
      .set({ balUsd: state.balUsd.toFixed(6), sandboxBalUsd: state.sandboxBalUsd.toFixed(6) })
      .where(eq(nbSubAccounts.id, id));
  }

  /* ── demo bootstrap ── */

  async seedDemoData(userId: string): Promise<void> {
    // Seed sample agents
    const a1Id = randomUUID();
    const a2Id = randomUUID();
    const at = new Date();
    await this.db.insert(nbAgents).values([
      {
        id: a1Id,
        userId,
        name: 'ResearchBot-01',
        role: 'Data procurement',
        balanceUsd: '36.8',
        spentTodayUsd: '13.2',
        state: 'live',
        createdAt: at,
      },
      {
        id: a2Id,
        userId,
        name: 'OpsAgent-02',
        role: 'Operations',
        balanceUsd: '25',
        spentTodayUsd: '0',
        state: 'review',
        createdAt: at,
      },
    ]);
    await this.db.insert(nbAgentPolicies).values([
      {
        agentId: a1Id,
        perTxCapUsd: '1',
        perDayCapUsd: '50',
        endpointAllowlist: ['api.exa.ai', 'weather.api'],
        humanApprovalThresholdUsd: '1',
      },
      {
        agentId: a2Id,
        perTxCapUsd: '25',
        perDayCapUsd: '25',
        endpointAllowlist: [],
        humanApprovalThresholdUsd: '25',
      },
    ]);
    // Seed sample contract
    await this.db.insert(nbX402Contracts).values({
      userId,
      name: 'Clip analytics',
      endpointPath: '/v1/clip-analytics',
      method: 'GET',
      priceUsd: '0.003',
      currency: 'USDC',
      status: 'live',
      requestsToday: 18402,
      revenueTodayUsd: '55.2',
    });
    // Seed sample activity
    await this.db.insert(nbTransactions).values([
      {
        userId,
        kind: 'in',
        status: 'confirmed',
        title: 'Salary · Acme Studio',
        subtitle: 'ACH · TODAY',
        amountUsd: '2400',
        createdAt: at,
      },
      {
        userId,
        agentId: a1Id,
        kind: 'x402',
        status: 'confirmed',
        title: 'api.exa.ai',
        subtitle: 'AGENT · POLICY OK',
        amountUsd: '0.12',
        createdAt: at,
      },
    ]);
  }
}

/**
 * PgLedger — money mutators that touch nb_user_state.
 *
 * pushActivity (raw row insert), send, topUp, earnDeposit, earnWithdraw, swap,
 * setEarnConfig, autoDivestIfNeeded, setPreferredVaultTier.
 *
 * Cross-domain: earnDeposit / earnWithdraw fire the optional ChainMirror tail
 * call. topUp's auto-deposit tail relies on its own earnDeposit method (no
 * cross-module hop). setEarnConfig + setPreferredVaultTier return a freshly
 * hydrated User via the core kernel.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nbTransactions } from '../../db/schema/index.js';
import { log } from '../../lib/log.js';
import {
  type Activity,
  type ChainMirror,
  type EarnMoveResult,
  PolicyError,
  type SendResult,
  type SwapResult,
  type SessionUser,
  type User,
  type VaultTier,
} from '../types.js';
import type { LedgerStateManager, UserState } from '../core/ledger-state.js';
import { type DbExecutor, money, parseAmount } from './_shared.js';

type TransactionRow = typeof nbTransactions.$inferSelect;

function idempotencyTag(scope: 'send' | 'swap' | 'earn-deposit' | 'earn-withdraw', key?: string | null): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return `${scope}:${createHash('sha256').update(trimmed).digest('hex')}`;
}

function activityFromTx(row: TransactionRow): Activity {
  // Sign comes from `kind`; the title match is a legacy fallback for
  // pre-2026-07 'Moved to Earn' rows written as kind:'in' (append-only data
  // can't be rewritten). New writers set kind:'out' explicitly.
  const debit = row.kind === 'out' || row.title === 'Moved to Earn';
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

function assertSameAmount(row: TransactionRow, expected: number): void {
  if (Math.abs(Number(row.amountUsd) - expected) > 0.005) {
    throw new Error('idempotency_key_reused');
  }
}

export type LockedAutoDivestResult = {
  amountUsd: number;
  activity: Activity;
} | null;

export class PgLedger {
  private chainMirror?: ChainMirror;

  constructor(
    private db: Db,
    private core: LedgerStateManager,
  ) {}

  setChainMirror(m: ChainMirror | undefined): void {
    this.chainMirror = m;
  }

  async pushActivity(u: SessionUser, row: Omit<Activity, 'id' | 'at'>): Promise<Activity> {
    const id = randomUUID();
    const at = new Date();
    const amountUsd = parseAmount(row.a);
    await this.db.insert(nbTransactions).values({
      id,
      userId: u.id,
      kind: row.k,
      status: row.status ?? 'confirmed',
      title: row.n,
      subtitle: row.s,
      amountUsd: amountUsd.toFixed(6),
      txHash: row.txHash,
      chain: row.chain,
      counterparty: row.signer,
      createdAt: at,
    });
    const full: Activity = { ...row, id, at: at.toISOString() };
    await this.core.invalidateUser(u.id);
    this.core.emitActivity(u.id, full);
    return full;
  }

  async send(
    u: SessionUser,
    amountUsd: number,
    to: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<SendResult> {
    if (!(amountUsd >= 1)) throw new PolicyError('insufficient_funds', 'Minimum send is $1.');
    const claim = to.includes('@');
    const idem = idempotencyTag('send', opts?.idempotencyKey);
    if (idem) {
      const [existing] = await this.db
        .select()
        .from(nbTransactions)
        .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
        .limit(1);
      if (existing) {
        if ((existing.counterparty ?? '') !== to) throw new Error('idempotency_key_reused');
        assertSameAmount(existing, amountUsd);
        return { claim, activity: activityFromTx(existing), fresh: false };
      }
    }
    // Sprint 10 Item A — top up balUsd from earnUsd before the lock so the
    // balance check inside the transaction has the divested funds available.
    await this.autoDivestIfNeeded(u, amountUsd);
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
          if ((existing.counterparty ?? '') !== to) throw new Error('idempotency_key_reused');
          assertSameAmount(existing, amountUsd);
          activity = activityFromTx(existing);
          fresh = false;
          u.balUsd = state.balUsd;
          return;
        }
      }
      if (amountUsd > state.balUsd)
        throw new PolicyError('insufficient_funds', 'Not enough balance.');
      state.balUsd -= amountUsd;
      await this.core.writeUserState(tx, u.id, state);

      const id = randomUUID();
      const at = new Date();
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        kind: 'out',
        status: 'confirmed',
        title: 'Sent · ' + to,
        subtitle: (claim ? 'CLAIM PENDING' : 'DELIVERED') + ' · JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        counterparty: to,
        txHash: idem ?? undefined,
        createdAt: at,
      });
      activity = {
        id,
        n: 'Sent · ' + to,
        s: (claim ? 'CLAIM PENDING' : 'DELIVERED') + ' · JUST NOW',
        a: '−' + money(amountUsd),
        k: 'out',
        signer: to,
        ...(idem ? { txHash: idem } : {}),
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
    });

    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    return { claim, activity, fresh };
  }

  async topUp(u: SessionUser, amountUsd: number, label = 'Balance top-up'): Promise<Activity> {
    let activity!: Activity;
    let earnByDefault = false;
    let postBal = 0;
    let threshold = 0;
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      state.balUsd += amountUsd;
      await this.core.writeUserState(tx, u.id, state);
      const id = randomUUID();
      const at = new Date();
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        kind: 'in',
        status: 'confirmed',
        title: label,
        subtitle: 'INSTANT · JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        createdAt: at,
      });
      activity = {
        id,
        n: label,
        s: 'INSTANT · JUST NOW',
        a: '+' + money(amountUsd),
        pos: true,
        k: 'in',
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
      earnByDefault = state.earnByDefault;
      postBal = state.balUsd;
      threshold = state.divestThresholdUsd;
    });
    await this.core.invalidateUser(u.id);
    this.core.emitActivity(u.id, activity);
    // Sprint 10 Item A — auto-deposit the tail above divestThresholdUsd into earn
    // when the user opted in. Best-effort: failures log and continue.
    if (earnByDefault && postBal > threshold) {
      try {
        await this.earnDeposit(u, postBal - threshold);
      } catch (e) {
        log.warn(
          { userId: u.id, err: e instanceof Error ? e.message : String(e) },
          'topUp: earn-by-default auto-deposit failed',
        );
      }
    }
    return activity;
  }

  /**
   * ADR-0006 Phase 2 — credit the app ledger for a VERIFIED on-chain USDC
   * deposit. Unlike `topUp` this is idempotent on the real deposit tx hash:
   * the reconciliation worker re-scans block windows after crashes, so the
   * same deposit will be offered more than once and must credit exactly once.
   * Pre-check inside the lock (same pattern as `send`) + the DB's unique
   * (user_id, tx_hash) index as the second line of defense.
   */
  async creditDeposit(
    u: SessionUser,
    amountUsd: number,
    opts: { txHash: string; chain: string },
  ): Promise<{ activity: Activity; fresh: boolean }> {
    if (!(amountUsd > 0)) throw new Error('invalid_deposit_amount');
    const txHash = opts.txHash.trim();
    if (!txHash) throw new Error('invalid_deposit_tx_hash');
    let activity!: Activity;
    let fresh = true;
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      const [existing] = await tx
        .select()
        .from(nbTransactions)
        .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, txHash)))
        .limit(1);
      if (existing) {
        activity = activityFromTx(existing);
        fresh = false;
        u.balUsd = state.balUsd;
        return;
      }
      state.balUsd += amountUsd;
      await this.core.writeUserState(tx, u.id, state);
      const id = randomUUID();
      const at = new Date();
      const subtitle = `USDC · ${opts.chain.toUpperCase()}`;
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        kind: 'in',
        status: 'confirmed',
        title: 'Deposit received',
        subtitle,
        amountUsd: amountUsd.toFixed(6),
        txHash,
        chain: opts.chain,
        createdAt: at,
      });
      activity = {
        id,
        n: 'Deposit received',
        s: subtitle,
        a: '+' + money(amountUsd),
        pos: true,
        k: 'in',
        txHash,
        chain: opts.chain,
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
    });
    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    return { activity, fresh };
  }

  async earnDeposit(
    u: SessionUser,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult> {
    let activity!: Activity;
    let fresh = true;
    const idem = idempotencyTag('earn-deposit', opts?.idempotencyKey);
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      if (idem) {
        const [existing] = await tx
          .select()
          .from(nbTransactions)
          .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
          .limit(1);
        if (existing) {
          assertSameAmount(existing, amountUsd);
          activity = activityFromTx(existing);
          fresh = false;
          u.balUsd = state.balUsd;
          u.earnUsd = state.earnUsd;
          return;
        }
      }
      if (amountUsd > state.balUsd)
        throw new PolicyError('insufficient_funds', 'More than your spending balance.');
      state.balUsd -= amountUsd;
      state.earnUsd += amountUsd;
      await this.core.writeUserState(tx, u.id, state);
      const id = randomUUID();
      const at = new Date();
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        // 'out' — the move debits the SPENDING balance. Replay sign logic
        // reads kind, so it must not rely on the title-match fallback.
        kind: 'out',
        status: 'confirmed',
        title: 'Moved to Earn',
        txHash: idem ?? undefined,
        subtitle: 'AUTO · 8.4% EST · JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        createdAt: at,
      });
      activity = {
        id,
        n: 'Moved to Earn',
        ...(idem ? { txHash: idem } : {}),
        s: 'AUTO · 8.4% EST · JUST NOW',
        a: '−' + money(amountUsd),
        k: 'out',
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
      u.earnUsd = state.earnUsd;
    });
    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    // Sprint 12 Phase 0 — fire-and-forget chain mirror AFTER commit. The mirror
    // swallows errors so a chain failure can't unwind the ledger move.
    if (fresh && opts?.mirror !== false) void this.chainMirror?.depositEarn(u, amountUsd, u.preferredVaultTier);
    return { fresh };
  }

  async earnWithdraw(
    u: SessionUser,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult> {
    let activity!: Activity;
    let fresh = true;
    const idem = idempotencyTag('earn-withdraw', opts?.idempotencyKey);
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      if (idem) {
        const [existing] = await tx
          .select()
          .from(nbTransactions)
          .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
          .limit(1);
        if (existing) {
          assertSameAmount(existing, amountUsd);
          activity = activityFromTx(existing);
          fresh = false;
          u.balUsd = state.balUsd;
          u.earnUsd = state.earnUsd;
          return;
        }
      }
      if (amountUsd > state.earnUsd)
        throw new PolicyError('insufficient_funds', 'More than your earning balance.');
      state.earnUsd -= amountUsd;
      state.balUsd += amountUsd;
      await this.core.writeUserState(tx, u.id, state);
      const id = randomUUID();
      const at = new Date();
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        kind: 'in',
        status: 'confirmed',
        title: 'From Earn',
        txHash: idem ?? undefined,
        subtitle: 'WITHDRAWAL · INSTANT · JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        createdAt: at,
      });
      activity = {
        id,
        n: 'From Earn',
        ...(idem ? { txHash: idem } : {}),
        s: 'WITHDRAWAL · INSTANT · JUST NOW',
        a: '+' + money(amountUsd),
        pos: true,
        k: 'in',
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
      u.earnUsd = state.earnUsd;
    });
    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    // Sprint 12 Phase 0 — autoDivestIfNeeded calls earnWithdraw, so the mirror
    // is wired implicitly for the auto-divest path. topUp's auto-deposit tail
    // calls earnDeposit, same story — no extra mirror wiring needed there.
    if (fresh && opts?.mirror !== false) void this.chainMirror?.withdrawEarn(u, amountUsd, u.preferredVaultTier);
    return { fresh };
  }

  async autoDivestLocked(
    tx: DbExecutor,
    u: SessionUser,
    state: UserState,
    spendUsd: number,
  ): Promise<LockedAutoDivestResult> {
    if (state.balUsd >= spendUsd) return null;
    if (!state.autoDivestOnSpend) return null;
    const shortfall = spendUsd - state.balUsd;
    if (state.earnUsd < shortfall) return null;

    state.earnUsd -= shortfall;
    state.balUsd += shortfall;

    const id = randomUUID();
    const at = new Date();
    await tx.insert(nbTransactions).values({
      id,
      userId: u.id,
      kind: 'in',
      status: 'confirmed',
      title: 'From Earn',
      subtitle: 'WITHDRAWAL · INSTANT · JUST NOW',
      amountUsd: shortfall.toFixed(6),
      createdAt: at,
    });

    u.balUsd = state.balUsd;
    u.earnUsd = state.earnUsd;

    return {
      amountUsd: shortfall,
      activity: {
        id,
        n: 'From Earn',
        s: 'WITHDRAWAL · INSTANT · JUST NOW',
        a: '+' + money(shortfall),
        pos: true,
        k: 'in',
        at: at.toISOString(),
      },
    };
  }

  emitLockedAutoDivest(u: SessionUser, result: LockedAutoDivestResult): void {
    if (!result) return;
    this.core.emitActivity(u.id, result.activity);
    void this.chainMirror?.withdrawEarn(u, result.amountUsd, u.preferredVaultTier);
  }

  async swap(
    u: SessionUser,
    amountUsd: number,
    direction: 'usd-eur' | 'eur-usd',
    opts?: { idempotencyKey?: string | null },
  ): Promise<SwapResult> {
    const RATE = 0.92;
    const rate = direction === 'usd-eur' ? RATE : 1 / RATE;
    const out = amountUsd * rate;
    let activity!: Activity;
    let fresh = true;
    const idem = idempotencyTag('swap', opts?.idempotencyKey);
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      if (idem) {
        const [existing] = await tx
          .select()
          .from(nbTransactions)
          .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
          .limit(1);
        if (existing) {
          if ((existing.counterparty ?? '') !== direction) throw new Error('idempotency_key_reused');
          assertSameAmount(existing, out);
          activity = activityFromTx(existing);
          fresh = false;
          u.balUsd = state.balUsd;
          u.eurUsd = state.eurUsd;
          return;
        }
      }
      if (direction === 'usd-eur') {
        if (amountUsd > state.balUsd)
          throw new PolicyError('insufficient_funds', 'More than your spending balance.');
        state.balUsd -= amountUsd;
        state.eurUsd += out;
      } else {
        // 2026-07-02 — eur→usd previously credited USD without debiting
        // anything (an unbacked mint). The EUR side now debits the tracked
        // EUR balance. In-memory parity: store/in-memory/ledger.ts swap().
        if (amountUsd > state.eurUsd)
          throw new PolicyError('insufficient_funds', 'More than your EUR balance.');
        state.eurUsd -= amountUsd;
        state.balUsd += out;
      }
      await this.core.writeUserState(tx, u.id, state);
      const id = randomUUID();
      const at = new Date();
      const title = 'Swap · ' + (direction === 'usd-eur' ? 'USD → EUR' : 'EUR → USD');
      await tx.insert(nbTransactions).values({
        id,
        userId: u.id,
        kind: 'swap',
        status: 'confirmed',
        title,
        subtitle: 'MID-MARKET · JUST NOW',
        amountUsd: out.toFixed(6),
        counterparty: direction,
        txHash: idem ?? undefined,
        createdAt: at,
      });
      activity = {
        id,
        n: title,
        s: 'MID-MARKET · JUST NOW',
        a: (direction === 'usd-eur' ? '€' : '$') + out.toFixed(2),
        pos: true,
        k: 'swap',
        signer: direction,
        ...(idem ? { txHash: idem } : {}),
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
      u.eurUsd = state.eurUsd;
    });
    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    return { out, rate, fresh };
  }

  // Item A — earn-by-default + auto-divest-on-spend
  async setEarnConfig(
    u: SessionUser,
    patch: Partial<{
      earnByDefault: boolean;
      autoDivestOnSpend: boolean;
      divestThresholdUsd: number;
    }>,
  ): Promise<User> {
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      if (patch.earnByDefault !== undefined) state.earnByDefault = patch.earnByDefault;
      if (patch.autoDivestOnSpend !== undefined) state.autoDivestOnSpend = patch.autoDivestOnSpend;
      if (patch.divestThresholdUsd !== undefined) state.divestThresholdUsd = patch.divestThresholdUsd;
      await this.core.writeUserState(tx, u.id, state);
    });
    await this.core.invalidateUser(u.id);
    return this.core.hydrateUser(u.id);
  }

  /**
   * Top up `u.balUsd` from `u.earnUsd` if the next spend would exceed it.
   * Sprint 10 Item A opt-in: only fires when `state.autoDivestOnSpend` is on.
   */
  async autoDivestIfNeeded(u: SessionUser, amountUsd: number): Promise<void> {
    const state = await this.core.readUserState(u.id);
    if (state.balUsd >= amountUsd) return;
    if (!state.autoDivestOnSpend) return;
    const shortfall = amountUsd - state.balUsd;
    if (state.earnUsd < shortfall) return;
    await this.earnWithdraw(u, shortfall);
  }

  async setPreferredVaultTier(u: SessionUser, tier: VaultTier): Promise<User> {
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      state.preferredVaultTier = tier;
      await this.core.writeUserState(tx, u.id, state);
    });
    await this.core.invalidateUser(u.id);
    return this.core.hydrateUser(u.id);
  }

  // Used by the Bridge deposit webhook and claim sweeper - they need the helper
  // primitive (lock + state + write) but the actual transaction is owned by
  // the caller. We don't expose these as Store methods; they remain on this
  // module so PgBridge / PgClaims can grab them via this.ledger.<method>.
  /** Read user state without locking — used by bridge webhook + claim caller paths. */
  async readUserState(userId: string) {
    return this.core.readUserState(userId);
  }

  // setKillSwitch belongs to agents in the public interface but lives close to
  // ledger state because it's just a `state.killSwitch` flip. Expose via the
  // facade so PgAgents can delegate without dragging the user-state plumbing
  // into agents.ts.
  /**
   * Sprint 13 COMMIT 4 (C4) — wrap in db.transaction + lockUserState so the
   * non-locking read+write doesn't lose-update against a concurrent earn
   * deposit. The pre-fix path read state (no lock), set killSwitch, then
   * wrote the WHOLE row back — wiping any balUsd/earnUsd delta written
   * between the read and the write.
   */
  async setKillSwitch(u: SessionUser, on: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      state.killSwitch = on;
      await this.core.writeUserState(tx, u.id, state);
    });
    u.killSwitch = on;
    await this.core.invalidateUser(u.id);
  }
}

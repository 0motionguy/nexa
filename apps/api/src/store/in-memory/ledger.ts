/**
 * InMemoryLedger — send, topUp, earnDeposit, earnWithdraw, swap.
 * Plus earn config toggles + autoDivestIfNeeded + setPreferredVaultTier +
 * setKillSwitch. Mirrors the postgres ledger module shape; differs only in
 * that there are no transactions / row locks — single-threaded JS makes
 * mutation atomic by construction.
 */

import { createHash } from 'node:crypto';
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
import type { InMemoryState } from '../core/in-memory-state.js';
import { money } from './_shared.js';

function idempotencyTag(scope: 'send' | 'swap' | 'earn-deposit' | 'earn-withdraw', key?: string | null): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return `${scope}:${createHash('sha256').update(trimmed).digest('hex')}`;
}

function activityAmountUsd(a: Activity): number {
  const raw = a.a.replace(/[^0-9.-]/g, '');
  const value = Number(raw);
  return Number.isFinite(value) ? Math.abs(value) : NaN;
}

function assertSameAmount(actual: number, expected: number): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.005) {
    throw new Error('idempotency_key_reused');
  }
}

export class InMemoryLedger {
  private chainMirror?: ChainMirror;

  constructor(private state: InMemoryState) {}

  /**
   * Scale wave 3 — SessionUser params are detached projections; in-memory
   * persistence lives on the canonical `usersById` map object. Balance
   * mutations and activity reads must target that object, or writes are lost.
   */
  private full(u: SessionUser): User {
    const row = this.state.usersById.get(u.id);
    if (!row) throw new Error('user_not_found');
    return row;
  }

  setChainMirror(m: ChainMirror | undefined): void {
    this.chainMirror = m;
  }

  async send(
    u: SessionUser,
    amountUsd: number,
    to: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<SendResult> {
    if (!(amountUsd >= 1)) throw new PolicyError('insufficient_funds', 'Minimum send is $1.');
    const idem = idempotencyTag('send', opts?.idempotencyKey);
    const fu = this.full(u);
    if (idem) {
      const existing = fu.activity.find((a) => a.txHash === idem);
      if (existing) {
        if (existing.signer !== to) throw new Error('idempotency_key_reused');
        assertSameAmount(activityAmountUsd(existing), amountUsd);
        return { claim: existing.s.startsWith('CLAIM'), activity: existing, fresh: false };
      }
    }
    // Sprint 10 Item A — if the user opted into auto-divest, top up balUsd from
    // earnUsd before the balance check so this send can clear when there's
    // enough total liquidity.
    await this.autoDivestIfNeeded(u, amountUsd);
    if (amountUsd > fu.balUsd) throw new PolicyError('insufficient_funds', 'Not enough balance.');
    fu.balUsd -= amountUsd;
    const claim = to.includes('@');
    const activity = await this.state.pushActivity(fu, {
      n: 'Sent · ' + to,
      s: (claim ? 'CLAIM PENDING' : 'DELIVERED') + ' · JUST NOW',
      a: '−' + money(amountUsd),
      k: 'out',
      signer: to,
      ...(idem ? { txHash: idem } : {}),
    });
    return { claim, activity, fresh: true };
  }

  async topUp(u: SessionUser, amountUsd: number, label = 'Balance top-up'): Promise<Activity> {
    const fu = this.full(u);
    fu.balUsd += amountUsd;
    const activity = await this.state.pushActivity(fu, {
      n: label,
      s: 'INSTANT · JUST NOW',
      a: '+' + money(amountUsd),
      pos: true,
      k: 'in',
    });
    // Sprint 10 Item A — auto-deposit the tail above divestThresholdUsd into earn
    // when the user opted in. The earnDeposit is best-effort: failures log and
    // continue so the top-up never fails because of the auto-stash.
    if (fu.earnByDefault && fu.balUsd > fu.divestThresholdUsd) {
      const excess = fu.balUsd - fu.divestThresholdUsd;
      try {
        await this.earnDeposit(u, excess);
      } catch {
        // swallow — the top-up itself already succeeded.
      }
    }
    return activity;
  }

  /** ADR-0006 Phase 2 — idempotent on-chain deposit credit (parity with PgLedger). */
  async creditDeposit(
    u: SessionUser,
    amountUsd: number,
    opts: { txHash: string; chain: string },
  ): Promise<{ activity: Activity; fresh: boolean }> {
    if (!(amountUsd > 0)) throw new Error('invalid_deposit_amount');
    const txHash = opts.txHash.trim();
    if (!txHash) throw new Error('invalid_deposit_tx_hash');
    const fu = this.full(u);
    const existing = fu.activity.find((a) => a.txHash === txHash);
    if (existing) return { activity: existing, fresh: false };
    fu.balUsd += amountUsd;
    const activity = await this.state.pushActivity(fu, {
      n: 'Deposit received',
      s: `USDC · ${opts.chain.toUpperCase()}`,
      a: '+' + money(amountUsd),
      pos: true,
      k: 'in',
      txHash,
      chain: opts.chain,
    });
    return { activity, fresh: true };
  }

  async earnDeposit(
    u: SessionUser,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult> {
    const idem = idempotencyTag('earn-deposit', opts?.idempotencyKey);
    const fu = this.full(u);
    if (idem) {
      const existing = fu.activity.find((a) => a.txHash === idem);
      if (existing) {
        assertSameAmount(activityAmountUsd(existing), amountUsd);
        return { fresh: false };
      }
    }
    if (amountUsd > fu.balUsd) throw new PolicyError('insufficient_funds', 'More than your spending balance.');
    fu.balUsd -= amountUsd;
    fu.earnUsd += amountUsd;
    await this.state.pushActivity(fu, {
      n: 'Moved to Earn',
      s: 'AUTO · 8.4% EST · JUST NOW',
      a: '−' + money(amountUsd),
      // 'out' — debits the spending balance (parity with the Postgres store).
      k: 'out',
      ...(idem ? { txHash: idem } : {}),
    });
    // Sprint 12 Phase 0 — fire-and-forget chain mirror AFTER ledger success.
    // The mirror swallows errors so a chain failure can't unwind the move.
    if (opts?.mirror !== false) void this.chainMirror?.depositEarn(u, amountUsd, u.preferredVaultTier);
    return { fresh: true };
  }

  async earnWithdraw(
    u: SessionUser,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null; mirror?: boolean },
  ): Promise<EarnMoveResult> {
    const idem = idempotencyTag('earn-withdraw', opts?.idempotencyKey);
    const fu = this.full(u);
    if (idem) {
      const existing = fu.activity.find((a) => a.txHash === idem);
      if (existing) {
        assertSameAmount(activityAmountUsd(existing), amountUsd);
        return { fresh: false };
      }
    }
    if (amountUsd > fu.earnUsd) throw new PolicyError('insufficient_funds', 'More than your earning balance.');
    fu.earnUsd -= amountUsd;
    fu.balUsd += amountUsd;
    await this.state.pushActivity(fu, {
      n: 'From Earn',
      s: 'WITHDRAWAL · INSTANT · JUST NOW',
      a: '+' + money(amountUsd),
      pos: true,
      k: 'in',
      ...(idem ? { txHash: idem } : {}),
    });
    // Sprint 12 Phase 0 — autoDivestIfNeeded calls earnWithdraw, so the mirror
    // is wired implicitly for the auto-divest path. topUp's auto-deposit tail
    // calls earnDeposit, same story — no extra mirror wiring needed there.
    if (opts?.mirror !== false) void this.chainMirror?.withdrawEarn(u, amountUsd, u.preferredVaultTier);
    return { fresh: true };
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
    const idem = idempotencyTag('swap', opts?.idempotencyKey);
    const fu = this.full(u);
    if (idem) {
      const existing = fu.activity.find((a) => a.txHash === idem);
      if (existing) {
        if (existing.signer !== direction) throw new Error('idempotency_key_reused');
        assertSameAmount(activityAmountUsd(existing), out);
        return { out, rate, fresh: false };
      }
    }
    if (direction === 'usd-eur') {
      if (amountUsd > fu.balUsd) throw new PolicyError('insufficient_funds', 'More than your spending balance.');
      fu.balUsd -= amountUsd;
      fu.eurUsd += out;
    } else {
      // 2026-07-02 — eur→usd previously credited USD without debiting anything
      // (an unbacked mint). The EUR side now debits the tracked EUR balance.
      if (amountUsd > fu.eurUsd) throw new PolicyError('insufficient_funds', 'More than your EUR balance.');
      fu.eurUsd -= amountUsd;
      fu.balUsd += out;
    }
    await this.state.pushActivity(fu, {
      n: 'Swap · ' + (direction === 'usd-eur' ? 'USD → EUR' : 'EUR → USD'),
      s: 'MID-MARKET · JUST NOW',
      a: (direction === 'usd-eur' ? '€' : '$') + out.toFixed(2),
      pos: true,
      k: 'swap',
      signer: direction,
      ...(idem ? { txHash: idem } : {}),
    });
    return { out, rate, fresh: true };
  }

  async setEarnConfig(
    u: SessionUser,
    patch: Partial<{
      earnByDefault: boolean;
      autoDivestOnSpend: boolean;
      divestThresholdUsd: number;
    }>,
  ): Promise<User> {
    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    if (patch.earnByDefault !== undefined) live.earnByDefault = patch.earnByDefault;
    if (patch.autoDivestOnSpend !== undefined) live.autoDivestOnSpend = patch.autoDivestOnSpend;
    if (patch.divestThresholdUsd !== undefined) live.divestThresholdUsd = patch.divestThresholdUsd;
    // Mirror onto the passed-in snapshot so callers see fresh values without re-fetch.
    if (patch.earnByDefault !== undefined) u.earnByDefault = patch.earnByDefault;
    if (patch.autoDivestOnSpend !== undefined) u.autoDivestOnSpend = patch.autoDivestOnSpend;
    if (patch.divestThresholdUsd !== undefined) u.divestThresholdUsd = patch.divestThresholdUsd;
    return live;
  }

  /**
   * Top up `u.balUsd` from `u.earnUsd` if the next spend would exceed it.
   * Mirrors the postgres contract; call BEFORE any insufficient_funds check;
   * mutates the caller's `u`.
   */
  async autoDivestIfNeeded(u: SessionUser, amountUsd: number): Promise<void> {
    // Refresh from the live record — callers may have stale snapshots.
    const live = this.state.usersById.get(u.id);
    if (!live) return;
    if (live.balUsd >= amountUsd) return;
    if (!live.autoDivestOnSpend) return;
    const shortfall = amountUsd - live.balUsd;
    if (live.earnUsd < shortfall) return;
    await this.earnWithdraw(live, shortfall);
    // Mirror the post-withdraw balance back onto the caller's snapshot.
    u.balUsd = live.balUsd;
    u.earnUsd = live.earnUsd;
  }

  async setPreferredVaultTier(u: SessionUser, tier: VaultTier): Promise<User> {
    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    live.preferredVaultTier = tier;
    u.preferredVaultTier = tier;
    return live;
  }

  async setKillSwitch(u: SessionUser, on: boolean): Promise<void> {
    // Scale wave 3 — must write the canonical record; the snapshot alone
    // would drop the flag on the floor for every later session hydrate.
    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    live.killSwitch = on;
    u.killSwitch = on;
  }
}

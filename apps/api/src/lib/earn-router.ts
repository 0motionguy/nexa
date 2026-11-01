/**
 * EarnRouter — single point of yield-adapter selection.
 *
 * Wraps yoUSD / Aave / Compound / Morpho behind one `getProtocols`/`deposit`/
 * `withdraw` surface, ranked by the user's tier preference:
 *
 *   - 'standard'     → Morpho (Steakhouse-curated USDC vault on Base, the same
 *                      vault that backs Coinbase's USDC lending product).
 *   - 'higher_yield' → highest risk-weighted APY across the four adapters
 *                      (weights live in RISK_WEIGHTS below — one-line redirect).
 *
 * Why a router (vs each route picking an adapter):
 *   - Sprint 10 hardcoded yoUSD as primary; this is the seam to swap it.
 *   - `/earn/protocols`, `/earn/deposit`, and `/earn/withdraw` all need the
 *     same selection logic — keeping it in one class means one source of truth.
 *   - Phase 3 (agent moat) can call `router.deposit` to honor the same tier
 *     pref as the human; the router is the integration boundary.
 *
 * Adapter surface (internal normalization):
 *   yoUSD exposes deposit / withdraw; Aave / Compound / Morpho expose
 *   depositUsd / withdrawUsd. The router normalizes via small facades so
 *   callers see one shape: `adapter.deposit(userId, amountUsd)`.
 *
 * Demo mode:
 *   Adapters return demo ExecResult when their `isLive` is false (no chain
 *   keys). APY reads still have to come from real providers; unavailable reads
 *   are marked explicitly so routes and clients do not present seeded rates as
 *   yield.
 */

import type { SourcedValueMeta } from '@nexa/shared-zod';
import type { SessionUser, User, VaultTier } from '../store/types.js';
import { log } from './log.js';
import { liveMeta, unavailableMeta } from './sourced.js';

export type AdapterName = 'morpho' | 'morpho-high-yield' | 'yousd' | 'aave' | 'compound';

export interface AdapterSummary {
  name: AdapterName;
  apyBps: number;
  isLive: boolean;
  available: boolean;
  /** Sprint 15 — source envelope so callers can render `Live · Morpho · Xs ago`. */
  sourced: SourcedValueMeta;
}

/**
 * Risk weights for the Higher Yield tier — multiplied against raw APY before
 * ranking. Morpho is 1.0 (the curator-vetted baseline); yoUSD and Aave sit a
 * notch below for protocol risk; Compound rounds out the bottom. Tweak in one
 * place to retune. v1 keeps Morpho strictly above tied APYs so Standard and
 * Higher-Yield can co-resolve to Morpho when its APY is highest.
 */
export const RISK_WEIGHTS: Record<AdapterName, number> = {
  morpho: 1.0,
  'morpho-high-yield': 0.92, // Ethena USDe exposure — higher risk than the curator-vetted baseline
  yousd: 0.95,
  aave: 0.95,
  compound: 0.93,
};

/**
 * Per-adapter APY read budget. Home boot and `ledger/me` embed these
 * summaries, so a hung provider RPC must degrade to `unavailable` (the
 * existing catch path) instead of serializing first paint behind a raw
 * transport timeout — CI traced a 5,015ms `/ledger/me` straight into a blank
 * home. Tune here; tests inject a smaller budget via `summaries(budgetMs)`.
 */
export const APY_READ_BUDGET_MS = 1_500;

/** Reject `p` after `ms`; the losing promise is muted so a late settle never
 *  surfaces as an unhandled rejection. Timer is unref'd — no process pinning. */
function withBudget<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      p.catch(() => undefined);
      reject(new Error(`${label}: APY read exceeded ${ms}ms budget`));
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Stable adapter facade so router callers don't need to know each adapter's quirks. */
interface EarnExecResult {
  txHash: string;
  demo: boolean;
  sponsored: boolean;
}

interface EarnExecOptions {
  idempotencyKey?: string | null;
}

interface YieldAdapter {
  readonly name: AdapterName;
  getApyBps(): Promise<number>;
  deposit(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
  withdraw(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
  readonly isLive: boolean;
}

interface EarnRouterStack {
  yousd: {
    getApyBps(): Promise<number>;
    deposit(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    withdraw(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    readonly isLive: boolean;
  };
  aave: {
    getApy(asset: 'USDC'): Promise<number>;
    depositUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    withdrawUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    readonly isLive: boolean;
  };
  compound: {
    getApyBps(): Promise<number>;
    depositUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    withdrawUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    readonly isLive: boolean;
  };
  morpho: {
    getApyBps(): Promise<number>;
    depositUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    withdrawUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    readonly isLive: boolean;
  };
  morphoHighYield: {
    getApyBps(): Promise<number>;
    depositUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    withdrawUsd(userId: string, amountUsd: number, opts?: EarnExecOptions): Promise<EarnExecResult>;
    readonly isLive: boolean;
  };
}

export interface ProtocolsResponse {
  standard: AdapterSummary;
  higherYield: AdapterSummary;
  blendedApy: number;
  adapters: AdapterSummary[];
}

export interface RouterExecResult extends EarnExecResult {
  adapter: AdapterName;
  tier: VaultTier;
}

export class EarnRouter {
  /** Eager-bind the four adapter facades so the array order is stable. */
  private readonly adapters: YieldAdapter[];

  constructor(
    private stack: EarnRouterStack,
  ) {
    this.adapters = [
      {
        name: 'morpho',
        getApyBps: () => stack.morpho.getApyBps(),
        deposit: (uid, amt, opts) => stack.morpho.depositUsd(uid, amt, opts),
        withdraw: (uid, amt, opts) => stack.morpho.withdrawUsd(uid, amt, opts),
        get isLive() {
          return stack.morpho.isLive;
        },
      },
      {
        // Coinbase USDC High Yield — Steakhouse-curated, Ethena-powered
        // (matches Coinbase's "USDC High Yield" lending product announced
        // 2026-06-12). Higher APY than the Standard tier, higher risk.
        name: 'morpho-high-yield',
        getApyBps: () => stack.morphoHighYield.getApyBps(),
        deposit: (uid, amt, opts) => stack.morphoHighYield.depositUsd(uid, amt, opts),
        withdraw: (uid, amt, opts) => stack.morphoHighYield.withdrawUsd(uid, amt, opts),
        get isLive() {
          return stack.morphoHighYield.isLive;
        },
      },
      {
        name: 'yousd',
        getApyBps: () => stack.yousd.getApyBps(),
        deposit: (uid, amt, opts) => stack.yousd.deposit(uid, amt, opts),
        withdraw: (uid, amt, opts) => stack.yousd.withdraw(uid, amt, opts),
        get isLive() {
          return stack.yousd.isLive;
        },
      },
      {
        name: 'aave',
        getApyBps: () => stack.aave.getApy('USDC'),
        deposit: (uid, amt, opts) => stack.aave.depositUsd(uid, amt, opts),
        withdraw: (uid, amt, opts) => stack.aave.withdrawUsd(uid, amt, opts),
        get isLive() {
          return stack.aave.isLive;
        },
      },
      {
        name: 'compound',
        getApyBps: () => stack.compound.getApyBps(),
        deposit: (uid, amt, opts) => stack.compound.depositUsd(uid, amt, opts),
        withdraw: (uid, amt, opts) => stack.compound.withdrawUsd(uid, amt, opts),
        get isLive() {
          return stack.compound.isLive;
        },
      },
    ];
  }

  /**
   * APY + liveness snapshot for every adapter. Errors are absorbed per adapter
   * (apy 0, isLive preserved) so one slow/failing RPC can't 500 the whole list.
   */
  async summaries(budgetMs: number = APY_READ_BUDGET_MS): Promise<AdapterSummary[]> {
    return Promise.all(
      this.adapters.map(async (a) => {
        let apyBps = 0;
        let available = true;
        let sourced: SourcedValueMeta;
        try {
          apyBps = await withBudget(a.getApyBps(), budgetMs, a.name);
          sourced = liveMeta(a.name, 'apy');
        } catch (e) {
          available = false;
          sourced = unavailableMeta(a.name, 'apy', e);
          log.warn(
            { err: e instanceof Error ? e.message : String(e), adapter: a.name },
            'earn-router: getApyBps failed - marking unavailable',
          );
        }
        return { name: a.name, apyBps, isLive: a.isLive, available, sourced };
      }),
    );
  }

  /**
   * Pick the adapter that matches `tier`:
   *   - 'standard'     → Morpho (curated; deterministic regardless of APY)
   *   - 'higher_yield' → highest risk-weighted APY across the four
   *
   * Falls back to the first summary when the preferred adapter isn't in the
   * input list (defensive — shouldn't happen in production).
   */
  pick(tier: VaultTier, summaries: AdapterSummary[]): AdapterSummary {
    if (summaries.length === 0) {
      // Synthesize a zero-APY Morpho stub so callers always get something to
      // attempt; the deposit/withdraw paths will degrade to demo if needed.
      return {
        name: 'morpho',
        apyBps: 0,
        isLive: false,
        available: false,
        sourced: unavailableMeta('morpho', 'apy', new Error('no adapter summaries available')),
      };
    }
    if (tier === 'standard') {
      return summaries.find((s) => s.name === 'morpho') ?? summaries[0]!;
    }
    const candidates = summaries.filter((s) => s.available);
    if (candidates.length === 0) return summaries[0]!;
    let best: AdapterSummary = candidates[0]!;
    let bestWeighted = best.apyBps * RISK_WEIGHTS[best.name];
    for (const s of candidates.slice(1)) {
      const weighted = s.apyBps * RISK_WEIGHTS[s.name];
      if (weighted > bestWeighted) {
        best = s;
        bestWeighted = weighted;
      }
    }
    return best;
  }

  /**
   * Bundle `summaries` + the user's standard/higher-yield picks + the blended
   * APY (current tier's APY for v1; per-position weighting is a follow-up
   * when balances track per-adapter) into the route response shape.
   */
  async getProtocols(u: SessionUser): Promise<ProtocolsResponse> {
    const all = await this.summaries();
    const standard = this.pick('standard', all);
    const higherYield = this.pick('higher_yield', all);
    const blendedApy = this.pick(u.preferredVaultTier ?? 'standard', all).apyBps;
    return { standard, higherYield, blendedApy, adapters: all };
  }

  /**
   * Deposit `amountUsd` via the adapter selected for `tier` (defaults to the
   * user's stored preference; falls back to 'standard'). When `tier` is given
   * AND differs from the user's stored pref, persist the new pref FIRST so
   * subsequent reads see the choice. Returns the adapter's ExecResult enriched
   * with the picked adapter name + effective tier.
   *
   * Adapter selection is pure data — `setPreferredVaultTier` is the only
   * store side effect.
   */
  async deposit(
    u: SessionUser,
    amountUsd: number,
    tier: VaultTier | undefined,
    setPreferredVaultTier: (u: SessionUser, tier: VaultTier) => Promise<User>,
    opts?: EarnExecOptions,
  ): Promise<RouterExecResult> {
    const effective: VaultTier = tier ?? u.preferredVaultTier ?? 'standard';
    if (tier && tier !== u.preferredVaultTier) {
      await setPreferredVaultTier(u, tier);
    }
    const summaries = await this.summaries();
    const picked = this.pick(effective, summaries);
    const adapter = this.adapterFor(picked.name);
    log.info(
      { userId: u.id, tier: effective, adapter: picked.name, amountUsd, apyBps: picked.apyBps },
      'earn-router: deposit',
    );
    const result = await adapter.deposit(u.id, amountUsd, opts);
    return { ...result, adapter: picked.name, tier: effective };
  }

  /**
   * Withdraw `amountUsd` via the adapter selected for `tier`. Unlike deposit,
   * withdraw doesn't persist a new preference — the user may divest from one
   * tier while keeping the other as their go-forward default.
   */
  async withdraw(
    u: SessionUser,
    amountUsd: number,
    tier: VaultTier | undefined,
    opts?: EarnExecOptions,
  ): Promise<RouterExecResult> {
    const effective: VaultTier = tier ?? u.preferredVaultTier ?? 'standard';
    const summaries = await this.summaries();
    const picked = this.pick(effective, summaries);
    const adapter = this.adapterFor(picked.name);
    log.info(
      { userId: u.id, tier: effective, adapter: picked.name, amountUsd },
      'earn-router: withdraw',
    );
    const result = await adapter.withdraw(u.id, amountUsd, opts);
    return { ...result, adapter: picked.name, tier: effective };
  }

  /**
   * Blended APY — v1: returns the picked tier's APY (positions don't yet
   * track per-adapter balance, so weighted-by-USD math has nothing to weight).
   * Follow-up when per-adapter positions land: weight by USD across positions.
   */
  async getBlendedApy(u: SessionUser): Promise<number> {
    const all = await this.summaries();
    return this.pick(u.preferredVaultTier ?? 'standard', all).apyBps;
  }

  private adapterFor(name: AdapterName): YieldAdapter {
    const a = this.adapters.find((x) => x.name === name);
    if (!a) throw new Error(`earn-router: unknown adapter ${name}`);
    return a;
  }
}

/**
 * EarnRouter — unit tests for tier-based adapter selection.
 *
 * The router is constructed against a tiny mock stack so the tests assert pure
 * selection logic + the deposit/withdraw plumbing without spinning up adapter
 * RPC mocks. The real adapters' demo paths are already covered in
 * chain/earn.spec.ts; here we focus on the router itself.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EarnRouter,
  RISK_WEIGHTS,
  type AdapterName,
  type AdapterSummary,
} from './earn-router.js';
import type { User, VaultTier } from '../store/types.js';

interface StubAdapter {
  isLive: boolean;
  apyBps: number;
  failApy?: boolean;
  /** Simulate a provider RPC that never answers (vs failApy's instant throw). */
  hangApy?: boolean;
  deposit: ReturnType<typeof vi.fn>;
  withdraw: ReturnType<typeof vi.fn>;
}

function makeStub(opts: Partial<StubAdapter> = {}): StubAdapter {
  return {
    isLive: opts.isLive ?? false,
    apyBps: opts.apyBps ?? 0,
    failApy: opts.failApy ?? false,
    hangApy: opts.hangApy ?? false,
    deposit: vi.fn(async () => ({ txHash: '0xdemoabc', demo: true, sponsored: false })),
    withdraw: vi.fn(async () => ({ txHash: '0xdemodef', demo: true, sponsored: false })),
  };
}

function buildRouter(opts: {
  yousd?: Partial<StubAdapter>;
  aave?: Partial<StubAdapter>;
  compound?: Partial<StubAdapter>;
  morpho?: Partial<StubAdapter>;
  morphoHighYield?: Partial<StubAdapter>;
} = {}): { router: EarnRouter; stubs: Record<AdapterName, StubAdapter> } {
  const stubs: Record<AdapterName, StubAdapter> = {
    morpho: makeStub(opts.morpho),
    'morpho-high-yield': makeStub(opts.morphoHighYield),
    yousd: makeStub(opts.yousd),
    aave: makeStub(opts.aave),
    compound: makeStub(opts.compound),
  };
  const apy = (s: StubAdapter): Promise<number> => {
    if (s.hangApy) return new Promise<number>(() => undefined); // never settles
    if (s.failApy) throw new Error('rpc_down');
    return Promise.resolve(s.apyBps);
  };
  const router = new EarnRouter({
    yousd: {
      getApyBps: () => apy(stubs.yousd),
      deposit: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.yousd.deposit(uid, amt, opts),
      withdraw: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.yousd.withdraw(uid, amt, opts),
      get isLive() {
        return stubs.yousd.isLive;
      },
    } as never,
    aave: {
      getApy: () => apy(stubs.aave),
      depositUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.aave.deposit(uid, amt, opts),
      withdrawUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.aave.withdraw(uid, amt, opts),
      get isLive() {
        return stubs.aave.isLive;
      },
    } as never,
    compound: {
      getApyBps: () => apy(stubs.compound),
      depositUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.compound.deposit(uid, amt, opts),
      withdrawUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.compound.withdraw(uid, amt, opts),
      get isLive() {
        return stubs.compound.isLive;
      },
    } as never,
    morpho: {
      getApyBps: () => apy(stubs.morpho),
      depositUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.morpho.deposit(uid, amt, opts),
      withdrawUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs.morpho.withdraw(uid, amt, opts),
      get isLive() {
        return stubs.morpho.isLive;
      },
    } as never,
    morphoHighYield: {
      getApyBps: () => apy(stubs['morpho-high-yield']),
      depositUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs['morpho-high-yield'].deposit(uid, amt, opts),
      withdrawUsd: (uid: string, amt: number, opts?: { idempotencyKey?: string | null }) =>
        stubs['morpho-high-yield'].withdraw(uid, amt, opts),
      get isLive() {
        return stubs['morpho-high-yield'].isLive;
      },
    } as never,
  });
  return { router, stubs };
}

function makeUser(tier: VaultTier | undefined = 'standard'): User {
  return {
    id: 'u1',
    email: 'u1@example.com',
    name: 'Tester',
    balUsd: 1000,
    sandboxBalUsd: 0,
    earnUsd: 0,
    earnApy: 0.084,
    cardFrozen: false,
    cardDayLimitUsd: 500,
    killSwitch: false,
    kycStatus: 'verified',
    bridgeCustomerId: null,
    earnByDefault: false,
    autoDivestOnSpend: false,
    divestThresholdUsd: 50,
    preferredVaultTier: tier,
    virtualAccounts: [],
    activity: [],
    agents: [],
    contracts: [],
    x402Events: [],
  };
}

describe('EarnRouter — tier selection', () => {
  it("pick('standard', …) always returns Morpho regardless of APY", () => {
    const { router } = buildRouter();
    const summaries: AdapterSummary[] = [
      { name: 'yousd', apyBps: 5000, isLive: true, available: true }, // wildly higher APY
      { name: 'morpho', apyBps: 100, isLive: true, available: true },
      { name: 'aave', apyBps: 200, isLive: true, available: true },
      { name: 'compound', apyBps: 50, isLive: true, available: true },
    ];
    expect(router.pick('standard', summaries).name).toBe('morpho');
  });

  it("pick('higher_yield', …) returns the top risk-weighted APY", () => {
    const { router } = buildRouter();
    // yousd 900 * 0.95 = 855; aave 850 * 0.95 = 807.5; morpho 800 * 1 = 800; compound 700 * 0.93 = 651
    const summaries: AdapterSummary[] = [
      { name: 'yousd', apyBps: 900, isLive: true, available: true },
      { name: 'aave', apyBps: 850, isLive: true, available: true },
      { name: 'morpho', apyBps: 800, isLive: true, available: true },
      { name: 'compound', apyBps: 700, isLive: true, available: true },
    ];
    expect(router.pick('higher_yield', summaries).name).toBe('yousd');
  });

  it("pick('higher_yield', …) prefers Morpho when its weighted APY ties or wins", () => {
    const { router } = buildRouter();
    // All same raw bps; Morpho's 1.0 weight beats the rest.
    const summaries: AdapterSummary[] = [
      { name: 'morpho', apyBps: 1000, isLive: true, available: true },
      { name: 'yousd', apyBps: 1000, isLive: true, available: true },
      { name: 'aave', apyBps: 1000, isLive: true, available: true },
      { name: 'compound', apyBps: 1000, isLive: true, available: true },
    ];
    expect(router.pick('higher_yield', summaries).name).toBe('morpho');
  });

  it('summaries() returns one row per adapter with apyBps + isLive', async () => {
    const { router } = buildRouter({
      yousd: { isLive: true, apyBps: 880 },
      aave: { isLive: true, apyBps: 840 },
      compound: { isLive: false, apyBps: 750 },
      morpho: { isLive: true, apyBps: 820 },
    });
    const all = await router.summaries();
    expect(all).toHaveLength(5);
    expect(new Set(all.map((s) => s.name))).toEqual(
      new Set(['morpho', 'morpho-high-yield', 'yousd', 'aave', 'compound']),
    );
    const compound = all.find((s) => s.name === 'compound');
    expect(compound?.isLive).toBe(false);
    expect(compound?.apyBps).toBe(750);
    expect(compound?.available).toBe(true);
  });

  it('summaries() marks per-adapter APY failures unavailable (one bad RPC does not 500 the list)', async () => {
    const { router } = buildRouter({
      morpho: { isLive: true, apyBps: 820 },
      yousd: { isLive: true, failApy: true },
      aave: { isLive: true, apyBps: 840 },
      compound: { isLive: true, apyBps: 750 },
    });
    const all = await router.summaries();
    expect(all.find((s) => s.name === 'yousd')?.apyBps).toBe(0);
    expect(all.find((s) => s.name === 'yousd')?.available).toBe(false);
    // Pick must still resolve sensibly even though yoUSD is dead.
    // morpho 820 * 1.0 = 820 vs aave 840 * 0.95 = 798 vs compound 750 * 0.93 ≈ 697.5 → morpho wins.
    expect(router.pick('higher_yield', all).name).toBe('morpho');
  });

  it('summaries(budgetMs) bounds a hung APY read and marks it unavailable', async () => {
    const { router } = buildRouter({
      morpho: { isLive: true, hangApy: true },
      yousd: { isLive: true, apyBps: 880 },
      aave: { isLive: true, apyBps: 840 },
      compound: { isLive: true, apyBps: 750 },
    });
    const started = Date.now();
    const all = await router.summaries(120);
    // A provider RPC that never answers must not serialize the whole list —
    // CI traced an unbounded read into a 5,015ms /ledger/me and a blank home.
    expect(Date.now() - started).toBeLessThan(2_000);
    const morpho = all.find((s) => s.name === 'morpho');
    expect(morpho?.available).toBe(false);
    expect(morpho?.apyBps).toBe(0);
    // Higher-yield pick degrades to the best *available* adapter:
    // yousd 880 * 0.95 = 836 beats aave 798 and compound ≈ 697.5.
    expect(router.pick('higher_yield', all).name).toBe('yousd');
  });
});

describe('EarnRouter — getProtocols', () => {
  it('returns { standard, higherYield, blendedApy } in the expected shape', async () => {
    const { router } = buildRouter({
      yousd: { isLive: true, apyBps: 880 },
      aave: { isLive: true, apyBps: 840 },
      compound: { isLive: true, apyBps: 750 },
      morpho: { isLive: true, apyBps: 820 },
    });
    const u = makeUser('standard');
    const out = await router.getProtocols(u);
    expect(out.standard.name).toBe('morpho');
    expect(out.standard.apyBps).toBe(820);
    expect(out.higherYield.name).toBe('yousd'); // 880 * 0.95 = 836 beats 820 * 1.0 = 820
    expect(out.blendedApy).toBe(820); // user's standard tier picks Morpho → 820 bps
    expect(out.adapters).toHaveLength(5);
  });

  it("getBlendedApy returns the Higher-Yield tier's APY when that's the user's pref", async () => {
    const { router } = buildRouter({
      yousd: { isLive: true, apyBps: 880 },
      aave: { isLive: true, apyBps: 840 },
      compound: { isLive: true, apyBps: 750 },
      morpho: { isLive: true, apyBps: 820 },
    });
    const u = makeUser('higher_yield');
    expect(await router.getBlendedApy(u)).toBe(880);
  });
});

describe('EarnRouter — deposit / withdraw', () => {
  it('deposit with explicit tier updates preferredVaultTier via the setter', async () => {
    const { router, stubs } = buildRouter({
      morpho: { apyBps: 820 },
      yousd: { apyBps: 880 },
    });
    const u = makeUser('standard');
    const setter = vi.fn(async (user: User, t: VaultTier) => {
      user.preferredVaultTier = t;
      return user;
    });
    const r = await router.deposit(u, 100, 'higher_yield', setter);
    expect(setter).toHaveBeenCalledOnce();
    expect(setter).toHaveBeenCalledWith(u, 'higher_yield');
    expect(r.adapter).toBe('yousd'); // 880 * 0.95 beats 820 * 1.0
    expect(r.tier).toBe('higher_yield');
    expect(stubs.yousd.deposit).toHaveBeenCalledWith('u1', 100, undefined);
    expect(stubs.morpho.deposit).not.toHaveBeenCalled();
  });

  it('deposit without an explicit tier uses the user.preferredVaultTier (no setter call)', async () => {
    const { router, stubs } = buildRouter({ morpho: { apyBps: 820 }, yousd: { apyBps: 880 } });
    const u = makeUser('standard');
    const setter = vi.fn(async (user: User, t: VaultTier) => {
      user.preferredVaultTier = t;
      return user;
    });
    const r = await router.deposit(u, 50, undefined, setter);
    expect(setter).not.toHaveBeenCalled();
    expect(r.adapter).toBe('morpho');
    expect(r.tier).toBe('standard');
    expect(stubs.morpho.deposit).toHaveBeenCalledWith('u1', 50, undefined);
  });

  it('threads idempotency options into the selected adapter', async () => {
    const { router, stubs } = buildRouter({ morpho: { apyBps: 820 } });
    const u = makeUser('standard');

    await router.deposit(u, 75, undefined, async (uu) => uu, { idempotencyKey: 'earn-idem-1' });
    await router.withdraw(u, 25, undefined, { idempotencyKey: 'earn-idem-2' });

    expect(stubs.morpho.deposit).toHaveBeenCalledWith('u1', 75, { idempotencyKey: 'earn-idem-1' });
    expect(stubs.morpho.withdraw).toHaveBeenCalledWith('u1', 25, { idempotencyKey: 'earn-idem-2' });
  });

  it('deposit defaults to standard when the user has no stored preference', async () => {
    const { router, stubs } = buildRouter({ morpho: { apyBps: 100 }, yousd: { apyBps: 9999 } });
    const u = makeUser(undefined);
    const setter = vi.fn(async (user: User, _t: VaultTier) => user);
    const r = await router.deposit(u, 25, undefined, setter);
    expect(r.tier).toBe('standard');
    expect(r.adapter).toBe('morpho');
    expect(stubs.morpho.deposit).toHaveBeenCalledOnce();
  });

  it('withdraw routes to the picked adapter and does NOT persist the tier', async () => {
    const { router, stubs } = buildRouter({ morpho: { apyBps: 820 }, yousd: { apyBps: 880 } });
    const u = makeUser('standard');
    const r = await router.withdraw(u, 10, 'higher_yield');
    expect(r.adapter).toBe('yousd');
    expect(r.tier).toBe('higher_yield');
    expect(stubs.yousd.withdraw).toHaveBeenCalledWith('u1', 10, undefined);
    // The user's stored pref is unchanged — withdraw is read-only on tier.
    expect(u.preferredVaultTier).toBe('standard');
  });

  it('deposit returns a demo ExecResult shape from the underlying adapter', async () => {
    const { router } = buildRouter({ morpho: { apyBps: 820 } });
    const u = makeUser('standard');
    const r = await router.deposit(u, 100, undefined, async (uu) => uu);
    expect(r.demo).toBe(true);
    expect(r.txHash).toMatch(/^0xdemo/);
    expect(r.adapter).toBe('morpho');
  });

  it('pick returns a safe synthetic when no summaries are provided', () => {
    const { router } = buildRouter();
    const out = router.pick('standard', []);
    expect(out.name).toBe('morpho');
    expect(out.apyBps).toBe(0);
    expect(out.isLive).toBe(false);
    expect(out.available).toBe(false);
  });

  it('RISK_WEIGHTS gives Morpho the highest weight (one-line redirect for retuning)', () => {
    expect(RISK_WEIGHTS.morpho).toBeGreaterThanOrEqual(RISK_WEIGHTS.yousd);
    expect(RISK_WEIGHTS.morpho).toBeGreaterThanOrEqual(RISK_WEIGHTS.aave);
    expect(RISK_WEIGHTS.morpho).toBeGreaterThanOrEqual(RISK_WEIGHTS.compound);
  });
});

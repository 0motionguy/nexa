import { describe, expect, it } from 'vitest';
import { planWrapStep } from './pm-approvals.js';

/**
 * Deposit-lane wrap branching (2026-07-05) — money truth for the funnel
 * native USDC (CCTP) → USDC.e (Uniswap V3 swap step) → pUSD (onramp step).
 * Pure planner: no RPC, no executor.
 */
describe('planWrapStep', () => {
  it('native-only balance routes to the swap step and sweeps it all', () => {
    expect(planWrapStep({ usdceUsd: 0, nativeUsd: 2.4 })).toEqual({
      step: 'swap',
      swapAtoms: 2_400_000n,
      minOutAtoms: 2_392_800n,
    });
  });

  it('applies the 30 bps minimum-out guard on the swap leg', () => {
    const plan = planWrapStep({ usdceUsd: 0, nativeUsd: 1 });
    expect(plan.step).toBe('swap');
    if (plan.step === 'swap') expect(plan.minOutAtoms).toBe(997_000n);
  });

  it('USDC.e-only balance goes straight to the ramp', () => {
    expect(planWrapStep({ usdceUsd: 5, nativeUsd: 0 })).toEqual({
      step: 'ramp',
      rampAtoms: 5_000_000n,
    });
  });

  it('a request covered by USDC.e never swaps needlessly', () => {
    expect(planWrapStep({ usdceUsd: 5, nativeUsd: 2 }, 3)).toEqual({
      step: 'ramp',
      rampAtoms: 3_000_000n,
    });
  });

  it('a request beyond USDC.e converts the native balance first', () => {
    const plan = planWrapStep({ usdceUsd: 5, nativeUsd: 2 }, 6);
    expect(plan.step).toBe('swap');
    if (plan.step === 'swap') expect(plan.swapAtoms).toBe(2_000_000n);
  });

  it('requests clamp to the held total (never over-draw)', () => {
    expect(planWrapStep({ usdceUsd: 1, nativeUsd: 0 }, 50)).toEqual({
      step: 'ramp',
      rampAtoms: 1_000_000n,
    });
  });

  it('default (no amount) on a mixed balance sweeps native first, ramp after', () => {
    const first = planWrapStep({ usdceUsd: 1, nativeUsd: 2 });
    expect(first.step).toBe('swap');
    // After the swap settles the balance is all-USDC.e — second call ramps.
    const second = planWrapStep({ usdceUsd: 2.997, nativeUsd: 0 });
    expect(second).toEqual({ step: 'ramp', rampAtoms: 2_997_000n });
  });

  it('zero balances no-op via ramp with zero atoms', () => {
    expect(planWrapStep({ usdceUsd: 0, nativeUsd: 0 })).toEqual({
      step: 'ramp',
      rampAtoms: 0n,
    });
  });
});

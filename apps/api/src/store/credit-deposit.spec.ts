/**
 * creditDeposit (ADR-0006 Phase 2) — the deposit-reconciliation worker
 * re-offers the same on-chain deposit after crashes/re-scans, so the credit
 * MUST be idempotent on the real tx hash: exactly one balance mutation and
 * one activity row per deposit, ever.
 */

import { describe, expect, it } from 'vitest';
import { store } from './index.js';

describe('store.creditDeposit', () => {
  it('credits once; replays with the same tx hash are no-ops', async () => {
    const u = await store.upsertUserByEmail('deposit-credit@example.com');
    const before = u.balUsd;
    const txHash = '0x' + 'ab'.repeat(32);

    const first = await store.creditDeposit(u, 12.5, { txHash, chain: 'base' });
    expect(first.fresh).toBe(true);
    expect(first.activity.n).toBe('Deposit received');
    expect(first.activity.k).toBe('in');
    expect(first.activity.txHash).toBe(txHash);
    expect(first.activity.s).toBe('USDC · BASE');
    expect(u.balUsd).toBeCloseTo(before + 12.5, 6);

    const replay = await store.creditDeposit(u, 12.5, { txHash, chain: 'base' });
    expect(replay.fresh).toBe(false);
    expect(u.balUsd).toBeCloseTo(before + 12.5, 6);
  });

  it('distinct tx hashes credit independently', async () => {
    const u = await store.upsertUserByEmail('deposit-credit-multi@example.com');
    const before = u.balUsd;
    await store.creditDeposit(u, 1, { txHash: '0x' + '01'.repeat(32), chain: 'base' });
    await store.creditDeposit(u, 2, { txHash: '0x' + '02'.repeat(32), chain: 'base' });
    expect(u.balUsd).toBeCloseTo(before + 3, 6);
  });

  it('rejects non-positive amounts and empty tx hashes before mutating', async () => {
    const u = await store.upsertUserByEmail('deposit-credit-bad@example.com');
    const before = u.balUsd;
    await expect(
      store.creditDeposit(u, 0, { txHash: '0x' + '0a'.repeat(32), chain: 'base' }),
    ).rejects.toThrow('invalid_deposit_amount');
    await expect(store.creditDeposit(u, 1, { txHash: '   ', chain: 'base' })).rejects.toThrow(
      'invalid_deposit_tx_hash',
    );
    expect(u.balUsd).toBe(before);
  });
});

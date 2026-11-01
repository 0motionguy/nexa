/**
 * Bridge.xyz compliance perimeter — store-layer unit tests against InMemoryStore.
 * Covers seeded virtual accounts + KYC status on a fresh user, the Bridge
 * customer mapping, and virtual-account persistence. No server boots (VITEST
 * is set), so these exercise the Store impl directly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('Bridge compliance perimeter', () => {
  it('a fresh user has two seeded virtual accounts (USD ACH + EUR IBAN) and kycStatus verified', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');

    expect(u.kycStatus).toBe('verified');
    expect(u.bridgeCustomerId).toBeNull();
    expect(u.virtualAccounts).toHaveLength(2);

    const usd = u.virtualAccounts.find((v) => v.currency === 'USD');
    const eur = u.virtualAccounts.find((v) => v.currency === 'EUR');

    expect(usd).toBeDefined();
    expect(usd!.routingNumber).toBeTruthy();
    expect(usd!.accountNumber).toBeTruthy();
    expect(usd!.iban).toBeNull();
    expect(usd!.livemode).toBe(true);

    expect(eur).toBeDefined();
    expect(eur!.iban).toBeTruthy();
    expect(eur!.routingNumber).toBeNull();
    expect(eur!.accountNumber).toBeNull();

    // listVirtualAccounts reflects the same seeded set.
    const listed = await store.listVirtualAccounts(u);
    expect(listed).toHaveLength(2);
    expect(listed.map((v) => v.currency).sort()).toEqual(['EUR', 'USD']);
  });

  it('setBridgeCustomer then userForBridgeCustomer resolves the owner (bogus id → null)', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');

    await store.setBridgeCustomer(u, 'cus_bridge_123');
    expect(u.bridgeCustomerId).toBe('cus_bridge_123');

    const found = await store.userForBridgeCustomer('cus_bridge_123');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(u.id);

    const missing = await store.userForBridgeCustomer('cus_does_not_exist');
    expect(missing).toBeNull();
  });

  it('applyBridgeDeposit credits a Bridge webhook ref once, durably at the store boundary', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    await store.setBridgeCustomer(u, 'cus_bridge_123');
    const startBal = u.balUsd;

    await expect(store.applyBridgeDeposit('cus_bridge_123', 75, 'evt_bridge_1')).resolves.toBe(true);
    expect(u.balUsd).toBeCloseTo(startBal + 75);

    await expect(store.applyBridgeDeposit('cus_bridge_123', 75, 'evt_bridge_1')).resolves.toBe(false);
    expect(u.balUsd).toBeCloseTo(startBal + 75);

    await expect(store.applyBridgeDeposit('cus_missing', 75, 'evt_bridge_2')).resolves.toBe(false);
  });

  it('saveVirtualAccount appends and listVirtualAccounts reflects it', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const before = (await store.listVirtualAccounts(u)).length;

    const saved = await store.saveVirtualAccount(u, {
      currency: 'USD',
      routingNumber: '021000021',
      accountNumber: '1234567890',
      iban: null,
      bic: null,
      bankName: 'JPMorgan Chase',
      livemode: true,
    });
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBeTruthy();
    expect(saved.bankName).toBe('JPMorgan Chase');

    const after = await store.listVirtualAccounts(u);
    expect(after).toHaveLength(before + 1);
    expect(after.map((v) => v.id)).toContain(saved.id);
  });

  it('setKyc updates the status', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    expect(u.kycStatus).toBe('verified');

    await store.setKyc(u, 'pending');
    expect(u.kycStatus).toBe('pending');

    const refreshed = await store.user(u.id);
    expect(refreshed.kycStatus).toBe('pending');
  });

  it('markTransferStatus returns a transfer only for a fresh transition', async () => {
    const u = await store.upsertUserByEmail('offramp@test.co', 'Offramp');
    const method = await store.savePayoutMethod(u, {
      type: 'ach',
      externalAccountId: 'external_replay_guard',
      label: 'Primary',
      livemode: false,
    });
    await store.createBridgeTransfer(u, {
      payoutMethodId: method.id,
      amountUsd: 25,
      externalRef: 'transfer_replay_guard',
    });

    const first = await store.markTransferStatus('transfer_replay_guard', 'completed');
    const replay = await store.markTransferStatus('transfer_replay_guard', 'completed');

    expect(first?.status).toBe('completed');
    expect(replay).toBeNull();
  });

  it('markTransferStatus treats failed as terminal for later completions', async () => {
    const u = await store.upsertUserByEmail('offramp-terminal@test.co', 'Offramp');
    const method = await store.savePayoutMethod(u, {
      type: 'ach',
      externalAccountId: 'external_terminal_guard',
      label: 'Primary',
      livemode: false,
    });
    await store.createBridgeTransfer(u, {
      payoutMethodId: method.id,
      amountUsd: 25,
      externalRef: 'transfer_terminal_guard',
    });

    const failed = await store.markTransferStatus('transfer_terminal_guard', 'failed');
    const completed = await store.markTransferStatus('transfer_terminal_guard', 'completed');

    expect(failed?.status).toBe('failed');
    expect(completed).toBeNull();
  });

  it('markTransferStatus treats completed as terminal for later failures', async () => {
    const u = await store.upsertUserByEmail('offramp-completed-terminal@test.co', 'Offramp');
    const method = await store.savePayoutMethod(u, {
      type: 'ach',
      externalAccountId: 'external_completed_terminal_guard',
      label: 'Primary',
      livemode: false,
    });
    await store.createBridgeTransfer(u, {
      payoutMethodId: method.id,
      amountUsd: 25,
      externalRef: 'transfer_completed_terminal_guard',
    });
    const before = u.balUsd;

    const completed = await store.markTransferStatus('transfer_completed_terminal_guard', 'completed');
    const failed = await store.markTransferStatus('transfer_completed_terminal_guard', 'failed');

    expect(completed?.status).toBe('completed');
    expect(failed).toBeNull();
    expect(u.balUsd).toBeCloseTo(before);
  });
});

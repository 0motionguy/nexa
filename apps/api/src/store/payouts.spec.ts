/**
 * MAZE facilitator — payouts + sub-accounts + split distribution, store-layer
 * unit tests against InMemoryStore. Covers money-out, one-KYC-many-businesses
 * sub-accounts, and auto-split of a sale across sub-accounts + email payouts.
 * No server boots (VITEST set), so these exercise the Store impl directly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';
import { PolicyError } from './types.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('sub-accounts', () => {
  it('createSubAccount then listSubAccounts returns it', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const sub = await store.createSubAccount(u, 'Side hustle');
    expect(sub.id).toBeTruthy();
    expect(sub.sellerId).toBe(u.id);
    expect(sub.name).toBe('Side hustle');
    expect(sub.balUsd).toBe(0);
    expect(sub.sandboxBalUsd).toBe(0);

    const subs = await store.listSubAccounts(u);
    expect(subs.map((s) => s.id)).toContain(sub.id);
  });

  it('subAccount throws sub_account_not_found for an unowned id', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    await expect(store.subAccount(u, 'does-not-exist')).rejects.toThrow('sub_account_not_found');
  });
});

describe('payouts', () => {
  it('createPayout debits balUsd and records status paid', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const startBal = u.balUsd;

    const payout = await store.createPayout(u, { amountUsd: 100, destination: 'dev@crew.io' });
    expect(payout.status).toBe('paid');
    expect(payout.amountUsd).toBe(100);
    expect(payout.destination).toBe('dev@crew.io');
    expect(payout.method).toBe('email');
    expect(payout.livemode).toBe(true);

    const after = await store.user(u.id);
    expect(after.balUsd).toBeCloseTo(startBal - 100);

    const payouts = await store.listPayouts(u);
    expect(payouts.map((p) => p.id)).toContain(payout.id);
  });

  it('payout over balance throws PolicyError(insufficient_funds)', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const err = await store
      .createPayout(u, { amountUsd: u.balUsd + 1, destination: 'dev@crew.io' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).code).toBe('insufficient_funds');
  });

  it('same idempotencyKey debits only once and returns the prior payout', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const startBal = u.balUsd;

    const first = await store.createPayout(
      u,
      { amountUsd: 40, destination: 'dev@crew.io' },
      { idempotencyKey: 'po-123' },
    );
    const second = await store.createPayout(
      u,
      { amountUsd: 40, destination: 'dev@crew.io' },
      { idempotencyKey: 'po-123' },
    );
    expect(second.id).toBe(first.id);

    const after = await store.user(u.id);
    expect(after.balUsd).toBeCloseTo(startBal - 40);

    const payouts = await store.listPayouts(u);
    expect(payouts.filter((p) => p.id === first.id)).toHaveLength(1);
  });

  /* Sprint 11 Phase 2 (F009) — payouts mirror payments: the unique on
   * idempotency_key was global, replaced with (seller_id, idempotency_key)
   * in migration 0012. Two distinct sellers can pick the same key value. */
  it('seller A and seller B can use the same payout Idempotency-Key without collision', async () => {
    const sellerA = await store.upsertUserByEmail('payout-a@test.co', 'A');
    const sellerB = await store.upsertUserByEmail('payout-b@test.co', 'B');
    const sharedKey = 'po-shared-key';

    const payoutA = await store.createPayout(
      sellerA,
      { amountUsd: 12, destination: 'devA@crew.io' },
      { idempotencyKey: sharedKey },
    );
    const payoutB = await store.createPayout(
      sellerB,
      { amountUsd: 34, destination: 'devB@crew.io' },
      { idempotencyKey: sharedKey },
    );
    expect(payoutA.id).not.toBe(payoutB.id);
    expect(payoutA.sellerId).toBe(sellerA.id);
    expect(payoutB.sellerId).toBe(sellerB.id);
    expect(payoutA.amountUsd).toBe(12);
    expect(payoutB.amountUsd).toBe(34);

    // Each seller sees only their own payout.
    const aPayouts = await store.listPayouts(sellerA);
    const bPayouts = await store.listPayouts(sellerB);
    expect(aPayouts.map((p) => p.id)).toContain(payoutA.id);
    expect(aPayouts.map((p) => p.id)).not.toContain(payoutB.id);
    expect(bPayouts.map((p) => p.id)).toContain(payoutB.id);
    expect(bPayouts.map((p) => p.id)).not.toContain(payoutA.id);
  });
});

describe('offer split distribution', () => {
  it('splits[{subAccountId, percent:50}] credits the sub-account 50% and the seller the remainder', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const startBal = u.balUsd;
    const sub = await store.createSubAccount(u, 'Crew member');

    const offer = await store.createOffer(u, {
      title: 'Split sale',
      amountUsd: 100,
      splits: [{ subAccountId: sub.id, percent: 50 }],
    });

    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    expect(res.fresh).toBe(true);
    expect(res.payouts).toEqual([]);

    const after = await store.user(u.id);
    const subAfter = await store.subAccount(u, sub.id);
    // Sub-account gets 50% (50), seller gets the remainder (50).
    expect(subAfter.balUsd).toBeCloseTo(50);
    expect(after.balUsd).toBeCloseTo(startBal + 50);
  });

  it('splits[{email, percent:25}] produces a Payout in payouts for 25% and leaves the seller the rest', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const startBal = u.balUsd;

    const offer = await store.createOffer(u, {
      title: 'Affiliate sale',
      amountUsd: 100,
      splits: [{ email: 'affiliate@crew.io', percent: 25 }],
    });

    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    expect(res.fresh).toBe(true);
    expect(res.payouts).toHaveLength(1);
    expect(res.payouts[0]!.amountUsd).toBeCloseTo(25);
    expect(res.payouts[0]!.destination).toBe('affiliate@crew.io');
    expect(res.payouts[0]!.status).toBe('paid');

    const after = await store.user(u.id);
    // Seller is credited the remainder (75), then the email payout debits 25 → net +50.
    expect(after.balUsd).toBeCloseTo(startBal + 50);
  });
});

describe('simple offer (no splits / sub-account) is unchanged', () => {
  it('credits the seller exactly as before and returns payouts:[]', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const startBal = u.balUsd;
    const offer = await store.createOffer(u, { title: 'Plain', amountUsd: 25 });

    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    expect(res.fresh).toBe(true);
    expect(res.payouts).toEqual([]);

    const after = await store.user(u.id);
    expect(after.balUsd).toBeCloseTo(startBal + 25);
  });
});

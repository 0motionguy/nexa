/**
 * MAZE facilitator — subscriptions (recurring offers), store-layer unit tests
 * against InMemoryStore. Covers create-on-pay, list, renew (re-credit + period
 * advance), and cancel (blocks renewal). No server boots (VITEST set), so these
 * exercise the Store impl directly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

function expireSub(store: InMemoryStore, id: string, daysAgo = 2): void {
  const subs = (store as unknown as {
    subscriptions: { subscriptions: Map<string, { currentPeriodEnd: string }> };
  }).subscriptions.subscriptions;
  const sub = subs.get(id);
  if (!sub) throw new Error('missing subscription');
  sub.currentPeriodEnd = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe('subscriptions', () => {
  it('paying a subscription-type offer returns an active Subscription and lists it', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, {
      title: 'Priority queue · monthly',
      amountUsd: 9.99,
      type: 'subscription',
    });

    const before = Date.now();
    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });

    expect(res.subscription).not.toBeNull();
    const sub = res.subscription!;
    expect(sub.status).toBe('active');
    expect(sub.offerId).toBe(offer.id);
    expect(sub.offerTitle).toBe('Priority queue · monthly');
    expect(sub.amountUsd).toBe(9.99);
    expect(sub.buyerEmail).toBe('buyer@x.com');
    expect(sub.sellerId).toBe(u.id);
    // currentPeriodEnd is ~30 days in the future.
    expect(new Date(sub.currentPeriodEnd).getTime()).toBeGreaterThan(before);

    const subs = await store.listSubscriptions(u);
    expect(subs.map((s) => s.id)).toContain(sub.id);
  });

  it('paying a one_time offer returns subscription:null', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, { title: 'Template', amountUsd: 25 });

    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    expect(res.subscription).toBeNull();

    const subs = await store.listSubscriptions(u);
    expect(subs).toHaveLength(0);
  });

  it('renewSubscription credits the seller again and pushes the period end forward', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, {
      title: 'Pro plan',
      amountUsd: 20,
      type: 'subscription',
    });
    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    const sub = res.subscription!;

    // Balance after the initial sale credit.
    const seller = await store.user(u.id);
    const balBeforeRenew = seller.balUsd;
    const periodBeforeRenew = new Date(sub.currentPeriodEnd).getTime();

    const renewed = await store.renewSubscription(u, sub.id);
    expect(renewed.id).toBe(sub.id);
    expect(renewed.status).toBe('active');
    // Re-credited by the subscription amount.
    expect(seller.balUsd).toBeCloseTo(balBeforeRenew + 20);
    // Period advanced.
    expect(new Date(renewed.currentPeriodEnd).getTime()).toBeGreaterThanOrEqual(periodBeforeRenew);

    // A 'Renewal ·' activity row was pushed for the live subscription.
    expect(seller.activity[0]!.n).toBe('Renewal · Pro plan');
    expect(seller.activity[0]!.k).toBe('in');
  });

  it('cancelSubscription sets status canceled and a subsequent renew throws', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, {
      title: 'Cancelable',
      amountUsd: 5,
      type: 'subscription',
    });
    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    const sub = res.subscription!;

    const canceled = await store.cancelSubscription(u, sub.id);
    expect(canceled.status).toBe('canceled');

    await expect(store.renewSubscription(u, sub.id)).rejects.toThrow('subscription_canceled');
  });

  it('renewSubscription with dueBefore rejects a stale second renewal attempt', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, {
      title: 'Race guarded',
      amountUsd: 12,
      type: 'subscription',
    });
    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    const sub = res.subscription!;
    expireSub(store, sub.id);
    const cutoff = new Date();
    const seller = await store.user(u.id);
    const balBefore = seller.balUsd;

    await store.renewSubscription(u, sub.id, { dueBefore: cutoff });
    await expect(store.renewSubscription(u, sub.id, { dueBefore: cutoff })).rejects.toThrow('subscription_not_due');

    expect(seller.balUsd).toBeCloseTo(balBefore + 12);
  });

  it('subscription throws subscription_not_found for an unowned id', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    await expect(store.subscription(u, 'does-not-exist')).rejects.toThrow('subscription_not_found');
  });
});

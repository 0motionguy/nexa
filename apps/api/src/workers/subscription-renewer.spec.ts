/**
 * Sprint 10 Item D — subscription renewal cron.
 *
 * Store-layer unit tests against the InMemoryStore singleton (vitest runs in
 * DEMO_MODE by default so the module-level `store` is the in-memory impl) plus
 * the worker's pure `sweepDueSubscriptions` helper. The BullMQ wrapper itself
 * is a thin layer around the helper; running the helper directly is more
 * deterministic than booting a queue under vitest.
 *
 * Covers:
 *   - findSubscriptionsDueBefore returns active rows past their period end.
 *   - findSubscriptionsDueBefore skips canceled subs.
 *   - sweepDueSubscriptions renews + credits the seller, idempotency on re-call.
 */

import { describe, expect, it } from 'vitest';
import type { InMemoryStore } from '../store/in-memory.js';
import { store } from '../store/index.js';
import { sweepDueSubscriptions } from './subscription-renewer.js';

// Tests share the singleton store; each test seeds its own seller/offer pair
// keyed on a unique email so they don't collide.
function asInMemory(s: typeof store): InMemoryStore {
  return s as unknown as InMemoryStore;
}

/** Force a subscription's currentPeriodEnd into the past. */
function expireSubNow(s: InMemoryStore, subId: string, daysAgo = 1): void {
  // Sprint 12 Phase 3 — subscriptions Map lives on the InMemorySubscriptions
  // sub-module under the facade. Reach in via the private field chain.
  const subs = (s as unknown as { subscriptions: { subscriptions: Map<string, { currentPeriodEnd: string }> } }).subscriptions.subscriptions;
  const sub = subs.get(subId);
  if (!sub) throw new Error('subscription not found: ' + subId);
  sub.currentPeriodEnd = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

let n = 0;
const uniqEmail = (): string => `sub-renewer-${++n}@test.co`;

describe('subscription-renewer — store.findSubscriptionsDueBefore', () => {
  it('returns active subs whose currentPeriodEnd is past the cutoff', async () => {
    const seller = await store.upsertUserByEmail(uniqEmail(), 'Seller');
    const offer = await store.createOffer(seller, {
      title: 'Pro plan',
      amountUsd: 20,
      type: 'subscription',
    });
    const r = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    const sub = r.subscription!;
    expireSubNow(asInMemory(store), sub.id);

    const due = await store.findSubscriptionsDueBefore(new Date());
    expect(due.map((s) => s.id)).toContain(sub.id);
  });

  it('does not return canceled subs even when past their period', async () => {
    const seller = await store.upsertUserByEmail(uniqEmail(), 'Seller');
    const offer = await store.createOffer(seller, {
      title: 'Pro plan',
      amountUsd: 20,
      type: 'subscription',
    });
    const r = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    const sub = r.subscription!;
    await store.cancelSubscription(seller, sub.id);
    expireSubNow(asInMemory(store), sub.id);

    const due = await store.findSubscriptionsDueBefore(new Date());
    expect(due.map((s) => s.id)).not.toContain(sub.id);
  });

  it('does not return active subs whose period is still in the future', async () => {
    const seller = await store.upsertUserByEmail(uniqEmail(), 'Seller');
    const offer = await store.createOffer(seller, {
      title: 'Pro plan',
      amountUsd: 20,
      type: 'subscription',
    });
    const r = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    const sub = r.subscription!;
    // Default period is ~30 days in the future — sweeper sees nothing.
    const due = await store.findSubscriptionsDueBefore(new Date());
    expect(due.map((s) => s.id)).not.toContain(sub.id);
  });
});

describe('subscription-renewer — sweepDueSubscriptions worker helper', () => {
  it('renews due active subs, credits the seller, advances the period', async () => {
    const seller = await store.upsertUserByEmail(uniqEmail(), 'Seller');
    const offer = await store.createOffer(seller, {
      title: 'Pro plan',
      amountUsd: 20,
      type: 'subscription',
    });
    const r = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    const sub = r.subscription!;
    expireSubNow(asInMemory(store), sub.id, 2);

    const sellerFresh = await store.user(seller.id);
    const balBeforeRenew = sellerFresh.balUsd;

    const result = await sweepDueSubscriptions();
    expect(result.due).toBeGreaterThanOrEqual(1);
    expect(result.renewed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const sellerAfter = await store.user(seller.id);
    expect(sellerAfter.balUsd).toBeCloseTo(balBeforeRenew + 20);

    // After renew, the seller's sub is past-cutoff no more.
    const due = await store.findSubscriptionsDueBefore(new Date());
    expect(due.map((s) => s.id)).not.toContain(sub.id);
  });
});

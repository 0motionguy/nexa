/**
 * MAZE facilitator — store-layer unit tests against InMemoryStore.
 * Covers the offers → checkout → payment flow + idempotency. No server boots
 * (VITEST is set), so these exercise the Store impl directly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('offers + checkout + payments', () => {
  it('createOffer then listOffers returns it', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, {
      title: 'Beat pack · vol 1',
      amountUsd: 12.5,
    });
    expect(offer.id).toBeTruthy();
    expect(offer.sellerId).toBe(u.id);
    expect(offer.amountUsd).toBe(12.5);
    expect(offer.active).toBe(true);
    expect(offer.currency).toBe('USD');
    expect(offer.type).toBe('one_time');
    expect(offer.fulfillmentKind).toBe('none');

    const offers = await store.listOffers(u);
    const ids = offers.map((o) => o.id);
    expect(ids).toContain(offer.id);
  });

  it('checkoutView returns the offer for an active offer', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, { title: 'Coaching call', amountUsd: 80 });

    const view = await store.checkoutView(offer.id);
    expect(view).not.toBeNull();
    expect(view!.offerId).toBe(offer.id);
    expect(view!.title).toBe('Coaching call');
    expect(view!.amountUsd).toBe(80);
    expect(view!.sellerName).toBe('Seller');
    // Public projection must NOT leak the sellerId.
    expect((view as Record<string, unknown>).sellerId).toBeUndefined();
  });

  it('checkoutView returns null for a non-existent offer', async () => {
    const view = await store.checkoutView('does-not-exist');
    expect(view).toBeNull();
  });

  it('checkoutView returns null for an inactive offer', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const offer = await store.createOffer(u, { title: 'Old listing', amountUsd: 5 });
    await store.updateOffer(u, offer.id, { active: false });

    const view = await store.checkoutView(offer.id);
    expect(view).toBeNull();
  });

  it('payOffer credits the seller balance and returns a paid payment (fresh:true)', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const startBal = u.balUsd;
    const offer = await store.createOffer(u, { title: 'Template', amountUsd: 25 });

    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    expect(res.fresh).toBe(true);
    expect(res.payment.status).toBe('paid');
    expect(res.payment.amountUsd).toBe(25);
    expect(res.payment.offerTitle).toBe('Template');
    expect(res.sellerId).toBe(u.id);

    const after = await store.user(u.id);
    expect(after.balUsd).toBeCloseTo(startBal + 25);

    const payments = await store.listPayments(u);
    expect(payments.map((p) => p.id)).toContain(res.payment.id);
  });

  it('same idempotencyKey credits the balance only once and the repeat returns fresh:false', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const startBal = u.balUsd;
    const offer = await store.createOffer(u, { title: 'Subscription', amountUsd: 9.99 });

    const first = await store.payOffer(offer.id, {
      buyerEmail: 'buyer@x.com',
      method: 'demo',
      idempotencyKey: 'idem-123',
    });
    expect(first.fresh).toBe(true);

    const second = await store.payOffer(offer.id, {
      buyerEmail: 'buyer@x.com',
      method: 'demo',
      idempotencyKey: 'idem-123',
    });
    expect(second.fresh).toBe(false);
    expect(second.payment.id).toBe(first.payment.id);

    const after = await store.user(u.id);
    // Credited exactly once.
    expect(after.balUsd).toBeCloseTo(startBal + 9.99);

    const payments = await store.listPayments(u);
    const matching = payments.filter((p) => p.id === first.payment.id);
    expect(matching).toHaveLength(1);
  });

  it('payOffer on a missing offer throws', async () => {
    await expect(
      store.payOffer('nope', { buyerEmail: null, method: 'demo' }),
    ).rejects.toThrow('offer_not_found');
  });

  /* ──────────────────────────────────────────────────────────────────────
   * Sprint 11 Phase 2 (F009) — idempotency key was global-unique before
   * migration 0012. After: the unique is compound on (seller_id,
   * idempotency_key) so two distinct sellers can freely pick the same key
   * without colliding. Replays from the SAME seller still dedupe.
   * ────────────────────────────────────────────────────────────────────── */

  it('seller A and seller B can use the same Idempotency-Key without collision', async () => {
    const sellerA = await store.upsertUserByEmail('seller-a-collide@test.co', 'Seller A');
    const sellerB = await store.upsertUserByEmail('seller-b-collide@test.co', 'Seller B');
    const offerA = await store.createOffer(sellerA, { title: 'A item', amountUsd: 10 });
    const offerB = await store.createOffer(sellerB, { title: 'B item', amountUsd: 20 });

    const sharedKey = 'shared-idem-key-xyz';
    const payA = await store.payOffer(offerA.id, {
      buyerEmail: 'buyer-a@x.com',
      method: 'demo',
      idempotencyKey: sharedKey,
    });
    const payB = await store.payOffer(offerB.id, {
      buyerEmail: 'buyer-b@x.com',
      method: 'demo',
      idempotencyKey: sharedKey,
    });

    expect(payA.fresh).toBe(true);
    expect(payB.fresh).toBe(true);
    // Distinct payment IDs — no cross-seller collision.
    expect(payA.payment.id).not.toBe(payB.payment.id);
    expect(payA.sellerId).toBe(sellerA.id);
    expect(payB.sellerId).toBe(sellerB.id);
    expect(payA.payment.amountUsd).toBe(10);
    expect(payB.payment.amountUsd).toBe(20);
  });

  it('same seller posting same Idempotency-Key returns the original payment (idempotent replay)', async () => {
    const u = await store.upsertUserByEmail('seller-replay@test.co', 'Seller');
    const offer = await store.createOffer(u, { title: 'Replay item', amountUsd: 7 });

    const first = await store.payOffer(offer.id, {
      buyerEmail: 'buyer@x.com',
      method: 'demo',
      idempotencyKey: 'replay-key-1',
    });
    const second = await store.payOffer(offer.id, {
      buyerEmail: 'buyer@x.com',
      method: 'demo',
      idempotencyKey: 'replay-key-1',
    });
    expect(first.fresh).toBe(true);
    expect(second.fresh).toBe(false);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.amountUsd).toBe(first.payment.amountUsd);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * Sprint 10 Item G — humans check out via balance. payOffer accepts a
   * buyerUser; method='balance' debits the buyer + credits the seller
   * atomically. Insufficient → PolicyError. autoDivest honored.
   * ────────────────────────────────────────────────────────────────────── */

  it("payOffer with method='balance' debits the buyer and credits the seller", async () => {
    const seller = await store.upsertUserByEmail('seller-balance@test.co', 'Seller');
    const buyer = await store.upsertUserByEmail('buyer-balance@test.co', 'Buyer');
    const sellerStart = seller.balUsd;
    const buyerStart = buyer.balUsd;
    const offer = await store.createOffer(seller, { title: 'Course', amountUsd: 19.99 });

    const res = await store.payOffer(offer.id, {
      buyerEmail: buyer.email,
      method: 'balance',
      buyerUser: buyer,
    });
    expect(res.fresh).toBe(true);
    expect(res.payment.method).toBe('balance');

    const sellerAfter = await store.user(seller.id);
    const buyerAfter = await store.user(buyer.id);
    expect(sellerAfter.balUsd).toBeCloseTo(sellerStart + 19.99);
    expect(buyerAfter.balUsd).toBeCloseTo(buyerStart - 19.99);
  });

  it("payOffer with method='balance' throws PolicyError on insufficient balance", async () => {
    const seller = await store.upsertUserByEmail('seller-broke@test.co', 'Seller');
    const buyer = await store.upsertUserByEmail('buyer-broke@test.co', 'Buyer');
    // Zero the buyer's balance the same way send() would.
    await store.send(buyer, buyer.balUsd, 'sink@example.com');
    const offer = await store.createOffer(seller, { title: 'Pricey', amountUsd: 100 });

    await expect(
      store.payOffer(offer.id, {
        buyerEmail: buyer.email,
        method: 'balance',
        buyerUser: buyer,
      }),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
  });

  it("payOffer with method='balance' + autoDivestOnSpend pulls from earn to cover the shortfall", async () => {
    const seller = await store.upsertUserByEmail('seller-divest@test.co', 'Seller');
    const buyer = await store.upsertUserByEmail('buyer-divest@test.co', 'Buyer');
    // Move all but $10 into earn, then turn on autoDivestOnSpend.
    await store.earnDeposit(buyer, buyer.balUsd - 10);
    await store.setEarnConfig(buyer, { autoDivestOnSpend: true });
    const fresh = await store.user(buyer.id);
    expect(fresh.balUsd).toBeCloseTo(10);
    expect(fresh.earnUsd).toBeGreaterThan(50);

    const offer = await store.createOffer(seller, { title: 'Premium', amountUsd: 50 });
    const res = await store.payOffer(offer.id, {
      buyerEmail: fresh.email,
      method: 'balance',
      buyerUser: fresh,
    });
    expect(res.fresh).toBe(true);
    const after = await store.user(buyer.id);
    // Net: 10 (start) - 50 (paid) + 40 (auto-divested from earn) = 0
    expect(after.balUsd).toBeCloseTo(0);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * Sprint 13 COMMIT 2 (Sweep #1) — when offer.subAccountId points at a
   * deleted sub, the remainder must NOT be dropped on the floor. Mirrors
   * the postgres + in-memory behavior: credit the seller's main balance
   * + log warn (in-memory has no logger so we just assert the math).
   * ────────────────────────────────────────────────────────────────────── */
  it('payOffer credits the seller when offer.subAccountId points at a non-existent sub', async () => {
    const seller = await store.upsertUserByEmail('seller-stale-sub@test.co', 'Seller');
    const startBal = seller.balUsd;
    const offer = await store.createOffer(seller, {
      title: 'Stale-sub offer',
      amountUsd: 42,
      subAccountId: '00000000-0000-0000-0000-000000000000',
    });

    const res = await store.payOffer(offer.id, {
      buyerEmail: 'buyer@x.com',
      method: 'demo',
    });
    expect(res.fresh).toBe(true);
    expect(res.payment.amountUsd).toBe(42);

    // Money landed on the seller's main balance — none dropped.
    const after = await store.user(seller.id);
    expect(after.balUsd).toBeCloseTo(startBal + 42);
  });

  it('Postgres payOffer credits seller when offer.subAccountId points at a deleted sub (structural)', () => {
    // Sprint 13 COMMIT 2 — the inline if(sub) branch used to skip the
    // remainder credit entirely. Now both branches end with a balance
    // mutation so no money is dropped.
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/payments.ts'), 'utf8');
    const start = source.indexOf('  async payOffer(');
    const end = source.indexOf('  async listPayments(', start);
    const payOffer = source.slice(start, end);
    expect(payOffer).toContain('subAccount missing; remainder credited to seller');
    // The fallback else branch credits sellerState (main balance).
    expect(payOffer).toContain('sellerState.balUsd += remainder');
  });
});

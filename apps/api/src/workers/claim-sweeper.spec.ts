/**
 * Sprint 10 Item C — 30-day claim reclaim sweep.
 *
 * Store-layer unit tests against InMemoryStore. The worker function itself
 * (claim-sweeper.ts) is a thin BullMQ wrapper around `store.expireClaimsBefore`;
 * driving the store directly is more deterministic than booting a queue under
 * vitest. Covers the per-record state machine + idempotency + refund mechanics.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/in-memory.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

/**
 * Force a claim's expiresAt into the past — the in-memory store keeps the
 * 30-day default at record time; sweep tests need expired rows on demand.
 */
function expireClaimNow(s: InMemoryStore, slug: string, daysAgo = 1): void {
  // Sprint 12 Phase 3 — claims now live in the InMemoryClaims sub-module
  // under the facade. Reach in via the private field chain.
  const claims = (s as unknown as { claims: { claimsBySlug: Map<string, { expiresAt: string }> } }).claims;
  const rec = claims.claimsBySlug.get(slug);
  if (!rec) throw new Error('claim not found: ' + slug);
  rec.expiresAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

describe('claim-sweeper — store.expireClaimsBefore', () => {
  it('flips 3 expired pending claims to expired, refunds 3 senders, leaves the fresh one alone', async () => {
    const alice = await store.upsertUserByEmail('alice@test.co', 'Alice');
    // Three claims past their expiry (each debits alice $1 via send).
    const stale: string[] = [];
    for (let i = 0; i < 3; i++) {
      const send = await store.send(alice, 1, `late${i}@x.com`);
      // send() also pushes activity; capture the slug via recordClaim now.
      const rec = await store.recordClaim(alice, `late${i}@x.com`, 1);
      expireClaimNow(store, rec.slug);
      stale.push(rec.slug);
      void send;
    }
    // One claim that's still within the 30-day window.
    const fresh = await store.recordClaim(alice, 'soon@x.com', 5);
    expect(new Date(fresh.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const balBeforeSweep = alice.balUsd;
    const result = await store.expireClaimsBefore(new Date());
    expect(result.expired).toHaveLength(3);
    expect(result.refundsApplied).toBe(3);

    // Three refunds of $1 each landed on alice's balance.
    expect(alice.balUsd).toBeCloseTo(balBeforeSweep + 3);

    // Stale slugs now show 'expired'.
    for (const slug of stale) {
      const rec = await store.getClaim(slug);
      expect(rec!.status).toBe('expired');
    }
    // The fresh claim is still pending.
    const stillFresh = await store.getClaim(fresh.slug);
    expect(stillFresh!.status).toBe('pending');
  });

  it('is idempotent — a second sweep produces zero additional refunds', async () => {
    const alice = await store.upsertUserByEmail('alice@test.co', 'Alice');
    for (let i = 0; i < 2; i++) {
      const rec = await store.recordClaim(alice, `late${i}@x.com`, 2);
      expireClaimNow(store, rec.slug);
    }
    const first = await store.expireClaimsBefore(new Date());
    expect(first.refundsApplied).toBe(2);
    const balAfterFirst = alice.balUsd;

    const second = await store.expireClaimsBefore(new Date());
    expect(second.refundsApplied).toBe(0);
    expect(second.expired).toHaveLength(0);
    expect(alice.balUsd).toBeCloseTo(balAfterFirst);
  });

  it('does not touch claims whose expiresAt is exactly at the cutoff (strict <)', async () => {
    const alice = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const rec = await store.recordClaim(alice, 'edge@x.com', 1);
    // Mutate to exactly cutoff time below.
    const cutoff = new Date();
    (store as unknown as { claims: { claimsBySlug: Map<string, { expiresAt: string }> } }).claims.claimsBySlug.get(rec.slug)!.expiresAt =
      cutoff.toISOString();

    const result = await store.expireClaimsBefore(cutoff);
    expect(result.expired).toHaveLength(0);
    expect(result.refundsApplied).toBe(0);

    const stillPending = await store.getClaim(rec.slug);
    expect(stillPending!.status).toBe('pending');
  });
});

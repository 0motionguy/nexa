/**
 * MAZE developer surface — store-layer unit tests against InMemoryStore.
 * Covers API-key issuance/resolution/revocation and test/live sandbox
 * isolation on the offer → payment credit path. No server boots (VITEST set).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('api keys', () => {
  it('createApiKey returns a secret with the right prefix and matching last4', async () => {
    const u = await store.upsertUserByEmail('dev@test.co', 'Dev');

    const live = await store.createApiKey(u, 'prod key', true);
    expect(live.prefix).toBe('sk_live');
    expect(live.secret.startsWith('sk_live_')).toBe(true);
    expect(live.last4).toBe(live.secret.slice(-4));
    expect(live.livemode).toBe(true);
    expect(live.label).toBe('prod key');

    const test = await store.createApiKey(u, null, false);
    expect(test.prefix).toBe('sk_test');
    expect(test.secret.startsWith('sk_test_')).toBe(true);
    expect(test.last4).toBe(test.secret.slice(-4));
    expect(test.livemode).toBe(false);
    expect(test.label).toBeNull();
  });

  it('userForApiKey resolves the owner and the key mode', async () => {
    const u = await store.upsertUserByEmail('owner@test.co', 'Owner');
    const live = await store.createApiKey(u, null, true);
    const test = await store.createApiKey(u, null, false);

    const rLive = await store.userForApiKey(live.secret);
    expect(rLive).not.toBeNull();
    expect(rLive!.user.id).toBe(u.id);
    expect(rLive!.livemode).toBe(true);

    const rTest = await store.userForApiKey(test.secret);
    expect(rTest).not.toBeNull();
    expect(rTest!.user.id).toBe(u.id);
    expect(rTest!.livemode).toBe(false);
  });

  it('userForApiKey returns null for an unknown secret', async () => {
    await store.upsertUserByEmail('owner@test.co', 'Owner');
    const r = await store.userForApiKey('sk_test_not_a_real_key');
    expect(r).toBeNull();
  });

  it('userForApiKey returns null for a revoked key', async () => {
    const u = await store.upsertUserByEmail('owner@test.co', 'Owner');
    const key = await store.createApiKey(u, null, false);
    await store.revokeApiKey(u, key.id);

    const r = await store.userForApiKey(key.secret);
    expect(r).toBeNull();
  });

  it('listApiKeys items never expose the secret or hash', async () => {
    const u = await store.upsertUserByEmail('owner@test.co', 'Owner');
    await store.createApiKey(u, 'a', true);
    await store.createApiKey(u, 'b', false);

    const keys = await store.listApiKeys(u);
    expect(keys.length).toBe(2);
    for (const k of keys) {
      expect((k as Record<string, unknown>).secret).toBeUndefined();
      expect((k as Record<string, unknown>).keyHash).toBeUndefined();
      expect((k as Record<string, unknown>).hash).toBeUndefined();
      expect(k.last4).toHaveLength(4);
    }
  });

  it('listApiKeys includes revoked keys with revokedAt set', async () => {
    const u = await store.upsertUserByEmail('owner@test.co', 'Owner');
    const key = await store.createApiKey(u, null, true);
    await store.revokeApiKey(u, key.id);

    const keys = await store.listApiKeys(u);
    const found = keys.find((k) => k.id === key.id);
    expect(found).toBeDefined();
    expect(found!.revokedAt).not.toBeNull();
  });
});

describe('sandbox isolation', () => {
  it('paying a sandbox offer credits sandboxBalUsd and leaves balUsd untouched', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const liveBefore = u.balUsd;
    const sandboxBefore = u.sandboxBalUsd;

    const offer = await store.createOffer(u, { title: 'Sandbox item', amountUsd: 25 }, { livemode: false });
    expect(offer.livemode).toBe(false);

    const res = await store.payOffer(offer.id, { buyerEmail: 'buyer@x.com', method: 'demo' });
    expect(res.fresh).toBe(true);
    expect(res.payment.livemode).toBe(false);

    const after = await store.user(u.id);
    expect(after.sandboxBalUsd).toBeCloseTo(sandboxBefore + 25);
    expect(after.balUsd).toBeCloseTo(liveBefore);
  });

  it('listOffers({livemode:false}) returns only sandbox offers', async () => {
    const u = await store.upsertUserByEmail('seller@test.co', 'Seller');
    const liveOffer = await store.createOffer(u, { title: 'Live', amountUsd: 10 }, { livemode: true });
    const sandboxOffer = await store.createOffer(u, { title: 'Sandbox', amountUsd: 5 }, { livemode: false });

    const sandboxOnly = await store.listOffers(u, { livemode: false });
    const ids = sandboxOnly.map((o) => o.id);
    expect(ids).toContain(sandboxOffer.id);
    expect(ids).not.toContain(liveOffer.id);
    expect(sandboxOnly.every((o) => o.livemode === false)).toBe(true);
  });
});

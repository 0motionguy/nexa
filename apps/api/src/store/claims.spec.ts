/**
 * Email-claim escrow — store-layer unit tests against InMemoryStore.
 * Covers recordClaim → getClaim → claimFunds (credit recipient, flip status),
 * double-claim guard, and the existing setKyc surface. No server boots (VITEST
 * is set), so these exercise the Store impl directly. createPregeneratedWallet
 * degrades to a deterministic mock address (Privy unwired in tests).
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';
import { PolicyError } from './types.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('email-claim escrow', () => {
  it('sendClaim debits the sender and creates a pending claim together', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const startBal = u.balUsd;

    const res = await store.sendClaim(u, 20, ' Bob@X.com ');

    expect(res.claim).toBe(true);
    expect(res.activity.id).toBeTruthy();
    expect(res.claimRecord.email).toBe('bob@x.com');
    expect(res.claimRecord.status).toBe('pending');
    expect(u.balUsd).toBeCloseTo(startBal - 20);
    expect(await store.getClaim(res.claimRecord.slug)).not.toBeNull();
  });

  it('sendClaim does not create an unfunded claim when the sender is short', async () => {
    const u = await store.upsertUserByEmail('short@test.co', 'Short');

    await expect(() => store.sendClaim(u, 50_000, 'bob@x.com')).rejects.toBeInstanceOf(PolicyError);
    expect(await store.listClaims(u)).toEqual([]);
  });

  it('recordClaim parks a pending record with a slug, wallet, and ~30-day expiry', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const rec = await store.recordClaim(u, 'bob@x.com', 20);

    expect(rec.id).toBeTruthy();
    expect(rec.slug).toBeTruthy();
    expect(rec.status).toBe('pending');
    expect(rec.amountUsd).toBe(20);
    expect(rec.email).toBe('bob@x.com');
    expect(rec.senderUserId).toBe(u.id);
    expect(rec.senderName).toBe('Alice');
    expect(rec.claimedAt).toBeNull();
    // Mock pregenerated wallet (Privy unwired) — a stable 0x address.
    expect(rec.walletAddress).toMatch(/^0x[0-9a-f]{40}$/);

    // Expiry is ~30 days out.
    const days = (new Date(rec.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('getClaim returns the record by slug, null for an unknown slug', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const rec = await store.recordClaim(u, 'bob@x.com', 20);

    const found = await store.getClaim(rec.slug);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(rec.id);

    expect(await store.getClaim('nope')).toBeNull();
  });

  it('claimFunds credits the recipient, returns them, and flips status to claimed', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const rec = await store.recordClaim(u, 'bob@x.com', 20);

    const before = await store.upsertUserByEmail('bob@x.com');
    const startBal = before.balUsd;

    const res = await store.claimFunds(rec.slug, 'bob@x.com');
    expect(res).not.toBeNull();
    expect(res!.amountUsd).toBe(20);
    expect(res!.recipient.balUsd).toBeCloseTo(startBal + 20);
    expect(res!.recipient.email).toBe('bob@x.com');

    const after = await store.user(res!.recipient.id);
    expect(after.balUsd).toBeCloseTo(startBal + 20);

    const claim = await store.getClaim(rec.slug);
    expect(claim!.status).toBe('claimed');
    expect(claim!.claimedAt).not.toBeNull();

    // The sender can see the claim in their list.
    const list = await store.listClaims(u);
    expect(list.map((c) => c.id)).toContain(rec.id);
  });

  it('a second claimFunds on the same slug returns null (already claimed)', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const rec = await store.recordClaim(u, 'bob@x.com', 20);

    const first = await store.claimFunds(rec.slug, 'bob@x.com');
    expect(first).not.toBeNull();

    const recipient = await store.upsertUserByEmail('bob@x.com');
    const balAfterFirst = recipient.balUsd;

    const second = await store.claimFunds(rec.slug, 'bob@x.com');
    expect(second).toBeNull();

    // No double-credit.
    const stillSame = await store.upsertUserByEmail('bob@x.com');
    expect(stillSame.balUsd).toBeCloseTo(balAfterFirst);
  });

  it('claimFunds on an unknown slug returns null', async () => {
    expect(await store.claimFunds('nope', 'bob@x.com')).toBeNull();
  });

  it('claimFunds only credits the email the escrow was addressed to', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const rec = await store.recordClaim(u, 'bob@x.com', 20);

    expect(await store.claimFunds(rec.slug, 'mallory@x.com')).toBeNull();
    expect((await store.getClaim(rec.slug))!.status).toBe('pending');
  });

  it('normalizes claim emails before matching recipients', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const rec = await store.recordClaim(u, ' Bob@X.com ', 20);

    expect(rec.email).toBe('bob@x.com');
    expect(await store.claimFunds(rec.slug, 'bob@x.com')).not.toBeNull();
  });

  it('Postgres claimFunds validates the claim before creating a recipient account', () => {
    // Sprint 12 Phase 3 — claim methods live in store/postgres/claims.ts now.
    // claimFunds calls into PgAuth (via this.auth) for the recipient upsert.
    const source = readFileSync(new URL('./postgres/claims.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async claimFunds');
    const end = source.indexOf('async listClaims');
    const method = source.slice(start, end);

    const validation = method.indexOf('const [claimPreview]');
    const recipientUpsert = method.indexOf('this.auth.upsertUserByEmail(norm)');

    expect(validation).toBeGreaterThanOrEqual(0);
    expect(recipientUpsert).toBeGreaterThan(validation);
  });

  it('Postgres sendClaim debits and inserts the claim in one transaction', () => {
    const source = readFileSync(new URL('./postgres/claims.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async sendClaim');
    const end = source.indexOf('async getClaim');
    const method = source.slice(start, end);

    expect(method).toContain('await this.db.transaction');
    expect(method).toContain('this.core.lockUserState(tx, u.id)');
    expect(method).toContain('tx.insert(nbTransactions)');
    expect(method).toContain('tx');
    expect(method).toContain('.insert(nbClaimWallets)');
    expect(method.indexOf('if (amountUsd > state.balUsd)')).toBeLessThan(
      method.indexOf('createPregeneratedWallet(norm)'),
    );
  });

  it('Postgres expireClaimsBefore flips status in tx and refunds via the ledger facade', () => {
    // Sprint 13 COMMIT 1 — the in-tx inline state mutation skipped the chain
    // mirror. expireClaimsBefore now writes only the claim status flip inside
    // the tx; the sender refund routes through PgLedger.topUp after commit
    // so earnByDefault auto-tail + chain mirror fire.
    const source = readFileSync(new URL('./postgres/claims.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async expireClaimsBefore');
    const method = source.slice(start);

    // In-tx state mutation is gone.
    expect(method).not.toContain('this.core.lockUserState(tx, row.senderUserId)');
    // Refund snapshot is collected in-tx, then ledger.topUp runs after commit.
    expect(method).toContain('refunds.push');
    expect(method).toContain('await this.ledger.topUp(sender');
  });

  it('setKyc still updates the user kyc status', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    await store.setKyc(u, 'pending');
    const pending = await store.user(u.id);
    expect(pending.kycStatus).toBe('pending');

    await store.setKyc(u, 'verified');
    const verified = await store.user(u.id);
    expect(verified.kycStatus).toBe('verified');
  });
});

/**
 * Sprint 10 Item A — earn-by-default + auto-divest-on-spend.
 *
 * Store-layer unit tests against InMemoryStore. Covers:
 *   - setEarnConfig persists the patch.
 *   - send() with autoDivestOnSpend uses earnUsd to cover the shortfall.
 *   - send() refuses without autoDivestOnSpend (the original behavior).
 *   - topUp() with earnByDefault auto-deposits the tail above divestThresholdUsd.
 *   - topUp() with earnByDefault=false leaves the balance alone.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';
import { PolicyError } from './types.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('earn config + auto-divest-on-spend', () => {
  it('setEarnConfig persists the three toggles and returns the fresh user', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    expect(u.earnByDefault).toBe(false);
    expect(u.autoDivestOnSpend).toBe(false);
    expect(u.divestThresholdUsd).toBe(50);

    const updated = await store.setEarnConfig(u, {
      earnByDefault: true,
      autoDivestOnSpend: true,
      divestThresholdUsd: 100,
    });
    expect(updated.earnByDefault).toBe(true);
    expect(updated.autoDivestOnSpend).toBe(true);
    expect(updated.divestThresholdUsd).toBe(100);

    const fresh = await store.user(u.id);
    expect(fresh.earnByDefault).toBe(true);
    expect(fresh.autoDivestOnSpend).toBe(true);
    expect(fresh.divestThresholdUsd).toBe(100);
  });

  it('setEarnConfig accepts a partial patch (single field flip)', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    await store.setEarnConfig(u, { autoDivestOnSpend: true });
    const fresh = await store.user(u.id);
    expect(fresh.autoDivestOnSpend).toBe(true);
    // unchanged
    expect(fresh.earnByDefault).toBe(false);
    expect(fresh.divestThresholdUsd).toBe(50);
  });

  it('send() pulls earnUsd into balUsd when autoDivestOnSpend covers the gap', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    // Drain balUsd close to zero so we know the divest fired.
    await store.earnDeposit(u, u.balUsd - 10); // balUsd → 10, earnUsd → 3200 + (4820.4-10)
    expect(u.balUsd).toBeCloseTo(10);
    const earnBeforeSend = u.earnUsd;

    await store.setEarnConfig(u, { autoDivestOnSpend: true });

    // Try to send $30 — short by $20. Divest 20 from earn.
    const r = await store.send(u, 30, 'bob@x.com');
    expect(r.activity.n).toBe('Sent · bob@x.com');
    // Bal was 10 + 20 divested = 30, minus 30 sent = 0.
    expect(u.balUsd).toBeCloseTo(0);
    // Earn lost 20.
    expect(u.earnUsd).toBeCloseTo(earnBeforeSend - 20);
  });

  it('send() throws insufficient_funds when autoDivestOnSpend is off (default)', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    await store.earnDeposit(u, u.balUsd - 10); // balUsd → 10
    expect(u.balUsd).toBeCloseTo(10);

    await expect(() => store.send(u, 30, 'bob@x.com')).rejects.toBeInstanceOf(PolicyError);
    // Earn untouched.
    expect(u.balUsd).toBeCloseTo(10);
  });

  it('send() still throws when autoDivestOnSpend is on but earnUsd cannot cover the shortfall', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    // Drain earnUsd → 5 first (earnWithdraw flows earn→bal).
    await store.earnWithdraw(u, u.earnUsd - 5);
    expect(u.earnUsd).toBeCloseTo(5);
    // Now spend balUsd down to 10 via a non-claim send (debits balUsd, no escrow).
    await store.send(u, u.balUsd - 10, 'recipient-no-email');
    expect(u.balUsd).toBeCloseTo(10);
    expect(u.earnUsd).toBeCloseTo(5);
    await store.setEarnConfig(u, { autoDivestOnSpend: true });

    await expect(() => store.send(u, 30, 'bob@x.com')).rejects.toBeInstanceOf(PolicyError);
    // No partial divest fired.
    expect(u.balUsd).toBeCloseTo(10);
    expect(u.earnUsd).toBeCloseTo(5);
  });

  it('topUp() auto-deposits the excess above divestThresholdUsd when earnByDefault is on', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    await store.setEarnConfig(u, { earnByDefault: true, divestThresholdUsd: 50 });
    // Trim balUsd to 30 so the topUp tail is predictable.
    await store.earnDeposit(u, u.balUsd - 30);
    expect(u.balUsd).toBeCloseTo(30);
    const earnBeforeTopUp = u.earnUsd;

    // Top up $100 → bal becomes 130, threshold is 50, excess 80 → moves to earn.
    await store.topUp(u, 100);
    expect(u.balUsd).toBeCloseTo(50);
    expect(u.earnUsd).toBeCloseTo(earnBeforeTopUp + 80);
  });

  it('topUp() leaves the balance alone when earnByDefault is off (default)', async () => {
    const u = await store.upsertUserByEmail('alice@test.co', 'Alice');
    const startBal = u.balUsd;
    const startEarn = u.earnUsd;
    await store.topUp(u, 100);
    expect(u.balUsd).toBeCloseTo(startBal + 100);
    expect(u.earnUsd).toBeCloseTo(startEarn);
  });

  it('Postgres payOffer routes auto-divest through the ledger facade (chain mirror coverage)', () => {
    // Sprint 13 COMMIT 1 — the previous Sprint 12 invariant ("keep auto-divest
    // inline so it stays in the tx") shipped a quiet regression: the inline
    // earnUsd debit never fired the chain mirror. Now payOffer asks PgLedger
    // to autoDivestIfNeeded BEFORE locking the buyer's row, so the mirror tail
    // attached to earnWithdraw lands. The buyer is still locked + the balUsd
    // check still runs inside the same db.transaction.
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/payments.ts'), 'utf8');
    const start = source.indexOf('  async payOffer(');
    const end = source.indexOf('  async listPayments(', start);
    const payOffer = source.slice(start, end);

    expect(payOffer).toContain('await this.ledger.autoDivestIfNeeded(buyerUser');
    expect(payOffer).not.toContain('buyerState.earnUsd -= shortfall');
  });

  it('Postgres Bridge claims idempotency before locked auto-divest', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/bridge.ts'), 'utf8');
    const start = source.indexOf('  async createBridgeTransferDebit(');
    const end = source.indexOf('  async setBridgeTransferExternalRef(', start);
    const createDebit = source.slice(start, end);

    const insertIdx = createDebit.indexOf('.insert(nbBridgeTransfers)');
    const lockedDivestIdx = createDebit.indexOf('await this.ledger.autoDivestLocked(');

    expect(insertIdx).toBeGreaterThan(-1);
    expect(lockedDivestIdx).toBeGreaterThan(insertIdx);
    expect(createDebit).not.toContain('await this.ledger.autoDivestIfNeeded(u, input.amountUsd);');
  });
});

/**
 * Sprint 12 Phase 0 — chain-mirror invocation. The Store fires the mirror
 * after each successful ledger move so the user's preferredVaultTier choice
 * routes through EarnRouter. We never assert mirror SUCCESS — only that it
 * was CALLED with the right shape. The mirror itself is best-effort.
 */
describe('chain mirror — auto-divest + earn-by-default fire the mirror', () => {
  type MirrorCall = {
    op: 'deposit' | 'withdraw';
    userId: string;
    amountUsd: number;
    tier: 'standard' | 'higher_yield' | undefined;
  };

  function recordingMirror(calls: MirrorCall[]) {
    return {
      depositEarn: async (
        u: { id: string },
        amountUsd: number,
        tier?: 'standard' | 'higher_yield',
      ) => {
        calls.push({ op: 'deposit', userId: u.id, amountUsd, tier });
      },
      withdrawEarn: async (
        u: { id: string },
        amountUsd: number,
        tier?: 'standard' | 'higher_yield',
      ) => {
        calls.push({ op: 'withdraw', userId: u.id, amountUsd, tier });
      },
    };
  }

  // Await all pending microtasks (Node also flushes anything `void`-ed off the
  // main path). The mirror is fire-and-forget, so we yield once to let any
  // queued promise settle before asserting.
  async function flushMicrotasks(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
  }

  it('earnDeposit fires depositEarn on the attached mirror with the user preferredVaultTier', async () => {
    const store = new InMemoryStore();
    const calls: MirrorCall[] = [];
    store.attachChainMirror(recordingMirror(calls));

    const u = await store.upsertUserByEmail('mirror-dep@test.co', 'Mirror');
    await store.setPreferredVaultTier(u, 'higher_yield');

    await store.earnDeposit(u, 25);
    await flushMicrotasks();

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      op: 'deposit',
      userId: u.id,
      amountUsd: 25,
      tier: 'higher_yield',
    });
  });

  it('autoDivestIfNeeded (via send) fires withdrawEarn on the mirror with the user preferredVaultTier', async () => {
    const store = new InMemoryStore();
    const calls: MirrorCall[] = [];
    store.attachChainMirror(recordingMirror(calls));

    const u = await store.upsertUserByEmail('mirror-wd@test.co', 'Mirror');
    // Start by stashing the balance into earn so send() must auto-divest.
    await store.earnDeposit(u, u.balUsd - 10);
    expect(u.balUsd).toBeCloseTo(10);

    // Reset the recorded mirror calls so we only assert on the auto-divest hop.
    calls.length = 0;

    await store.setEarnConfig(u, { autoDivestOnSpend: true });
    // Standard tier explicit so the assertion is precise.
    await store.setPreferredVaultTier(u, 'standard');

    // Send $30 — short by $20. autoDivestIfNeeded withdraws 20 from earn.
    await store.send(u, 30, 'bob@x.com');
    await flushMicrotasks();

    // Exactly one withdraw mirror call. setPreferredVaultTier doesn't touch
    // the mirror (it's pure store state), and send() doesn't move earn — only
    // the autoDivestIfNeeded → earnWithdraw path does.
    const withdraws = calls.filter((c) => c.op === 'withdraw');
    expect(withdraws.length).toBe(1);
    expect(withdraws[0]).toEqual({
      op: 'withdraw',
      userId: u.id,
      amountUsd: 20,
      tier: 'standard',
    });
  });

  /**
   * Sprint 13 COMMIT 1 — cross-domain modules now route through PgLedger
   * sibling facade so chain mirror fires for inline credits + debits the
   * pre-fix code mutated user state for. We can only run the runtime
   * mirror probe against InMemoryStore — Postgres is covered by structural
   * assertions on the source below.
   */
  it('applyBridgeDeposit fires depositEarn when the recipient has earnByDefault on (InMemory)', async () => {
    const store = new InMemoryStore();
    const calls: MirrorCall[] = [];
    store.attachChainMirror(recordingMirror(calls));

    const u = await store.upsertUserByEmail('bridge-dep@test.co', 'Bridge');
    await store.setBridgeCustomer(u, 'cust_abc');
    await store.setEarnConfig(u, { earnByDefault: true, divestThresholdUsd: 50 });
    // Trim balUsd to 30 so the topUp tail above threshold is predictable.
    await store.earnDeposit(u, u.balUsd - 30);
    calls.length = 0;

    // Deposit $100 → bal becomes 130, excess of 80 above threshold goes to earn,
    // and earnDeposit fires the mirror.
    const ok = await store.applyBridgeDeposit('cust_abc', 100, 'evt_1');
    await flushMicrotasks();
    expect(ok).toBe(true);

    const deposits = calls.filter((c) => c.op === 'deposit');
    expect(deposits.length).toBe(1);
    expect(deposits[0]).toMatchObject({ op: 'deposit', userId: u.id, amountUsd: 80 });
  });

  it('releaseBonus fires depositEarn when the submitter has earnByDefault on (InMemory)', async () => {
    const store = new InMemoryStore();
    const calls: MirrorCall[] = [];
    store.attachChainMirror(recordingMirror(calls));

    const creator = await store.upsertUserByEmail('creator@test.co', 'Creator');
    const submitter = await store.upsertUserByEmail('submitter@test.co', 'Sub');
    await store.setEarnConfig(submitter, { earnByDefault: true, divestThresholdUsd: 50 });
    // Trim submitter's balUsd to 30 so the auto-tail is predictable.
    await store.earnDeposit(submitter, submitter.balUsd - 30);

    const campaign = await store.createCampaign(creator, {
      title: 'Test campaign',
      brand: 'TestBrand',
      baseUsd: 100,
      bonusTiers: [],
      topPrizeUsd: 0,
    });
    const sub = await store.submitToCampaign(submitter, campaign.id, {
      clipUrl: 'https://x.com/c/1',
      platform: 'x',
      viewsAttested: 1_000_000,
    });
    await store.approveSubmission(sub.id, 1_000_000);
    calls.length = 0;

    // Payout: base $100 * starter mult 1.0 = $100 → bal 130 → 80 excess to earn.
    await store.releaseBonus(campaign.id, sub.id);
    await flushMicrotasks();

    const deposits = calls.filter((c) => c.op === 'deposit');
    expect(deposits.length).toBe(1);
    expect(deposits[0]).toMatchObject({ op: 'deposit', userId: submitter.id, amountUsd: 80 });
  });

  it('Postgres facade wires ledger into PgPayments / PgBridge / PgCampaigns / PgClaims', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres.ts'), 'utf8');
    expect(source).toContain('new PgPayments(opts.db, this.core, this.ledger)');
    expect(source).toContain('new PgBridge(opts.db, this.core, this.auth, this.ledger)');
    expect(source).toContain('new PgClaims(opts.db, this.core, this.auth, this.ledger)');
    expect(source).toContain('new PgCampaigns(opts.db, this.core, this.ledger)');
  });

  it('Postgres applyBridgeDeposit routes the credit through PgLedger.topUp', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/bridge.ts'), 'utf8');
    const start = source.indexOf('async applyBridgeDeposit');
    const end = source.indexOf('async savePayoutMethod', start);
    const method = source.slice(start, end);
    expect(method).toContain("await this.ledger.topUp(user, amountUsd, 'Deposit · Bank transfer')");
    expect(method).not.toContain('await this.core.lockUserState(tx, userId)');
  });
});

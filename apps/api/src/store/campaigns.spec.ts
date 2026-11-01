import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('campaign store invariants', () => {
  // Sprint 12 Phase 3 — campaign methods moved to store/postgres/campaigns.ts
  // and the user-state primitives moved to store/core/ledger-state.ts. The
  // body-level invariants this spec guards still live in the same methods.
  it('Postgres releaseBonus state-machine flip stays in tx, credit routes through ledger', () => {
    // Sprint 13 COMMIT 1 — releaseBonus locks subRow + perks + flips submission
    // 'paid' atomically inside the tx; the actual balance credit is routed
    // through PgLedger.topUp AFTER commit so earnByDefault auto-tail + chain
    // mirror fire. The pre-fix inline 'state.earnUsd += autoEarnUsd' shipped a
    // quiet regression that skipped the chain mirror entirely.
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/campaigns.ts'), 'utf8');
    const start = source.indexOf('  async releaseBonus(');
    const end = source.indexOf('  async getPerks(', start);
    const releaseBonus = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(releaseBonus).toContain('await this.db.transaction(async (tx) =>');
    expect(releaseBonus).toContain(".for('update')");
    expect(releaseBonus).toContain('.insert(nbUserPerks)');
    // SR4 — campaignId/submissionId binding asserted in-tx.
    expect(releaseBonus).toContain("subRow.campaignId !== campaignId");
    // Credit path goes through the ledger after commit so the chain mirror fires.
    expect(releaseBonus).toContain('await this.ledger.topUp(user, creditUsd');
    // Inline credit + earn split are gone.
    expect(releaseBonus).not.toContain('state.earnUsd += autoEarnUsd');
    expect(releaseBonus).not.toContain('state.balUsd += paidUsd');
  });

  it('Postgres approveSubmission refuses paid submissions under row lock', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/campaigns.ts'), 'utf8');
    const start = source.indexOf('  async approveSubmission(');
    const end = source.indexOf('  async releaseBonus(', start);
    const approveSubmission = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(approveSubmission).toContain('await this.db.transaction(async (tx) =>');
    expect(approveSubmission).toContain(".for('update')");
    expect(approveSubmission).toContain("existing.status === 'paid'");
    expect(approveSubmission).toContain("throw new Error('submission_already_paid')");
  });
});

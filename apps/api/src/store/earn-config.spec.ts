/**
 * Sprint 10 earn config invariants at the store boundary.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from './in-memory.js';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('earn-by-default and auto-divest', () => {
  it('does not auto-divest owner Earn funds for agent-funded x402 payments', async () => {
    const u = await store.upsertUserByEmail('agent-owner@test.co', 'Agent Owner');
    u.balUsd = 0;
    u.earnUsd = 100;
    await store.setEarnConfig(u, { autoDivestOnSpend: true });

    const agent = await store.createAgent(u, 'SpendBot', 50, 50, ['api.exa.ai']);
    agent.balanceUsd = 25;
    agent.state = 'live';

    await store.x402Pay(u, agent.id, 'api.exa.ai/v1/search', 10, 'search');

    expect(agent.balanceUsd).toBeCloseTo(15);
    expect(u.balUsd).toBeCloseTo(0);
    expect(u.earnUsd).toBeCloseTo(100);
  });
});

/**
 * Sprint 13 COMMIT 4 (C4 + SR2) — setKillSwitch was a non-locking read+write
 * that could lose-update against a concurrent earnDeposit. x402Pay /
 * x402ApproveOnce read killSwitch outside the tx and only locked the agent
 * row, so a kill-switch flip racing with an in-flight payment was silently
 * bypassed. The Postgres impl now wraps both under db.transaction with
 * lockUserState. Asserting structurally on the source for the postgres path,
 * and functionally on the in-memory path for the kill-switch refusal.
 */
describe('kill switch race close', () => {
  it('Postgres setKillSwitch runs under db.transaction + lockUserState', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/ledger.ts'), 'utf8');
    const start = source.indexOf('  async setKillSwitch(');
    const end = source.length;
    const setKillSwitch = source.slice(start, end);

    expect(setKillSwitch).toContain('await this.db.transaction(async (tx) =>');
    expect(setKillSwitch).toContain('await this.core.lockUserState(tx, u.id)');
    // Pre-fix path passed `this.db` to writeUserState; the lock now writes
    // through the tx handle so the non-locking read+write is gone.
    expect(setKillSwitch).not.toContain('writeUserState(this.db');
    expect(setKillSwitch).not.toContain('readUserState(u.id)');
  });

  it('Postgres x402Pay re-reads killSwitch under lockUserState inside the tx', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/agents.ts'), 'utf8');
    const start = source.indexOf('  async x402Pay(');
    const end = source.indexOf('  async x402ApproveOnce(', start);
    const x402Pay = source.slice(start, end);

    // The pre-fix path called readUserState outside the tx for killSwitch.
    // The re-check inside the tx now uses lockUserState before agent-row lock.
    expect(x402Pay).toContain('await this.core.lockUserState(tx, u.id)');
    expect(x402Pay).toContain('userState.killSwitch');
    // Order matters — user-state lock fires before the agent-row lock.
    const userLockIdx = x402Pay.indexOf('lockUserState(tx, u.id)');
    const agentLockIdx = x402Pay.indexOf('.for(\'update\')');
    expect(userLockIdx).toBeGreaterThan(-1);
    expect(agentLockIdx).toBeGreaterThan(userLockIdx);
  });

  it('Postgres x402ApproveOnce re-reads killSwitch under lockUserState inside the tx', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/store/postgres/agents.ts'), 'utf8');
    const start = source.indexOf('  async x402ApproveOnce(');
    const end = source.indexOf('  /* ── x402 vendor', start);
    const method = source.slice(start, end);

    expect(method).toContain('await this.core.lockUserState(tx, u.id)');
    expect(method).toContain('userState.killSwitch');
  });

  it('InMemory x402Pay still refuses when the kill switch is on', async () => {
    const store = new InMemoryStore();
    const u = await store.upsertUserByEmail('killswitch@test.co', 'KS');
    const agent = await store.createAgent(u, 'KSBot', 100, 100, ['api.exa.ai']);
    agent.balanceUsd = 50;
    agent.state = 'live';

    await store.setKillSwitch(u, true);
    await expect(
      store.x402Pay(u, agent.id, 'api.exa.ai/v1/search', 10, 'search'),
    ).rejects.toMatchObject({ code: 'kill_switch' });
  });
});

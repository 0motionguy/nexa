/**
 * Sprint 10 Phase 2 ε — admin sweep routes.
 *
 * The gate reads `env.ADMIN_TOKEN` per-request, so each test mutates the
 * shared env before calling and restores it afterwards. We use the in-
 * process `app.request()` harness (not an ephemeral server) because the
 * admin routes don't need MCP/raw req/res.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { app } from '../index.js';
import { env } from '../lib/env.js';
import { store } from '../store/index.js';

const originalAdminToken = env.ADMIN_TOKEN;

afterEach(() => {
  env.ADMIN_TOKEN = originalAdminToken;
});

async function post(path: string, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method: 'POST', headers });
  return { status: res.status, body: await res.json() };
}

async function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method: 'GET', headers });
  return { status: res.status, body: await res.json() };
}

describe('admin auth gate', () => {
  it('rejects when ADMIN_TOKEN is unset', async () => {
    env.ADMIN_TOKEN = undefined;

    const { status, body } = await post('/admin/sweep-subscriptions', 'admin-test');

    expect(status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBe('admin token required');
  });

  it('rejects invalid admin bearer tokens', async () => {
    env.ADMIN_TOKEN = 'admin-test';

    const { status, body } = await post('/admin/sweep-subscriptions', 'wrong');

    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('also rejects /sweep-claims when no Authorization is sent', async () => {
    env.ADMIN_TOKEN = 'admin-test';

    const { status, body } = await post('/admin/sweep-claims');

    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });
});

describe('POST /admin/sweep-claims', () => {
  it('returns { ok, swept, refundsApplied, durationMs } with the right token', async () => {
    env.ADMIN_TOKEN = 'admin-test';

    const { status, body } = await post('/admin/sweep-claims', 'admin-test');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.swept).toBe('number');
    expect(typeof body.refundsApplied).toBe('number');
    expect(typeof body.durationMs).toBe('number');
    // Fresh in-memory store under test has no expired claims; swept = 0.
    expect(body.swept).toBe(0);
    expect(body.refundsApplied).toBe(0);
  });
});

describe('POST /admin/sweep-subscriptions', () => {
  it('runs the manual subscription sweep with the admin token', async () => {
    env.ADMIN_TOKEN = 'admin-test';

    const { status, body } = await post('/admin/sweep-subscriptions', 'admin-test');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.swept).toBeGreaterThanOrEqual(0);
    expect(body.succeeded).toBeGreaterThanOrEqual(0);
    expect(body.failed).toBeGreaterThanOrEqual(0);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('POST /admin/sentry-test', () => {
  it('returns 200 + captured boolean behind the same admin token', async () => {
    env.ADMIN_TOKEN = 'admin-test';

    const { status, body } = await post('/admin/sentry-test', 'admin-test');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.captured).toBe('boolean');
  });
});

/**
 * Tier 3 #14 — append-only audit log.
 *
 * The store is shared across tests so we seed via store.recordAuditEntry
 * directly and then read via the admin route. Each test seeds an isolated
 * `actor_type` or `action` prefix and asserts only on rows it owns, which
 * keeps the suite robust to whatever else other test files may have written.
 */
describe('GET /admin/audit-log', () => {
  beforeEach(() => {
    env.ADMIN_TOKEN = 'admin-test';
  });

  it('rejects without the admin bearer', async () => {
    const { status, body } = await get('/admin/audit-log');
    expect(status).toBe(401);
    expect(body.error?.code).toBe('unauthorized');
  });

  it('returns a row recorded directly on the store', async () => {
    await store.recordAuditEntry({
      actorType: 'admin',
      actorId: 'admin-happy-1',
      action: 'admin.audit.happy',
      targetType: 'user',
      targetId: 'u_42',
      metadata: { note: 'fresh from store' },
      requestId: 'req_happy_1',
    });

    const { status, body } = await get(
      '/admin/audit-log?action=admin.audit.happy',
      'admin-test',
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.next).toBeNull();
    const found = body.entries.find((e: any) => e.actorId === 'admin-happy-1');
    expect(found).toBeTruthy();
    expect(found.action).toBe('admin.audit.happy');
    expect(found.actorType).toBe('admin');
    expect(found.targetId).toBe('u_42');
    expect(found.metadata).toEqual({ note: 'fresh from store' });
    expect(found.requestId).toBe('req_happy_1');
    expect(typeof found.id).toBe('string');
    expect(typeof found.createdAt).toBe('string');
  });

  it('filters by actor_type', async () => {
    await store.recordAuditEntry({
      actorType: 'system',
      action: 'system.filter.case',
      actorId: 'sys-filter-1',
    });
    await store.recordAuditEntry({
      actorType: 'agent',
      action: 'agent.filter.case',
      actorId: 'agent-filter-1',
    });

    const { status, body } = await get(
      '/admin/audit-log?actor_type=system&action=system.filter',
      'admin-test',
    );

    expect(status).toBe(200);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of body.entries) {
      expect(entry.actorType).toBe('system');
      expect(entry.action.startsWith('system.filter')).toBe(true);
    }
  });

  it('filters by action prefix', async () => {
    await store.recordAuditEntry({
      actorType: 'admin',
      action: 'card.frozen',
      actorId: 'admin-prefix-1',
    });
    await store.recordAuditEntry({
      actorType: 'admin',
      action: 'card.unfrozen',
      actorId: 'admin-prefix-2',
    });
    await store.recordAuditEntry({
      actorType: 'admin',
      action: 'user.kyc.approved',
      actorId: 'admin-prefix-3',
    });

    const { status, body } = await get(
      '/admin/audit-log?action=card.',
      'admin-test',
    );

    expect(status).toBe(200);
    const prefixed = body.entries.filter((e: any) =>
      ['admin-prefix-1', 'admin-prefix-2'].includes(e.actorId),
    );
    expect(prefixed.length).toBe(2);
    expect(prefixed.every((e: any) => e.action.startsWith('card.'))).toBe(true);
    // 'user.kyc.approved' must NOT be in this filtered slice.
    expect(body.entries.find((e: any) => e.actorId === 'admin-prefix-3')).toBeUndefined();
  });

  it('clamps limit at 1000 (request 5000)', async () => {
    // Don't seed 1001 rows — assert on the wire that the store applied the
    // clamp. The route validates `limit` as positive int; the store ceils it.
    const { status, body } = await get(
      '/admin/audit-log?limit=5000',
      'admin-test',
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The page can hold at most 1000 entries; with the current test data it
    // is well under, but the upper bound must hold regardless.
    expect(body.entries.length).toBeLessThanOrEqual(1000);
  });

  it('rejects malformed action filter at the Zod boundary', async () => {
    const { status, body } = await get(
      '/admin/audit-log?action=has spaces and! bangs',
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Audit 2026-06-19 — test cohort routes (Sprint 17).
 *
 * Tags users, surfaces them via the dashboard view, runs a forced recovery.
 * The withdraw-all path under demo mode reads the demo `0xdemo…` hash from
 * the executor and records `admin.withdraw-all.demo` — that's how we know
 * the route fully exercised every check (validation, balance read, audit
 * entry, demo executor fall-through).
 * ────────────────────────────────────────────────────────────────────────── */

async function postJson(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe('POST /admin/cohort', () => {
  beforeEach(() => {
    env.ADMIN_TOKEN = 'admin-test';
  });

  it('rejects without the admin bearer', async () => {
    const seeded = await store.upsertUserByEmail('cohort-noauth@example.com', 'No Auth');
    const { status, body } = await postJson(
      '/admin/cohort',
      { userId: seeded.id, cohort: 'tester-2026Q3' },
      undefined,
    );
    expect(status).toBe(401);
    expect(body.error?.code).toBe('unauthorized');
  });

  it('sets a cohort tag and reflects it back', async () => {
    const seeded = await store.upsertUserByEmail('cohort-set@example.com', 'Cohort Set');
    const { status, body } = await postJson(
      '/admin/cohort',
      { userId: seeded.id, cohort: 'tester-2026Q3' },
      'admin-test',
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.cohort).toBe('tester-2026Q3');
    const refreshed = await store.user(seeded.id);
    expect(refreshed.cohort).toBe('tester-2026Q3');
  });

  it('returns 404 when tagging a missing user', async () => {
    const { status, body } = await postJson(
      '/admin/cohort',
      { userId: '00000000-0000-0000-0000-00000000cafe', cohort: 'tester-2026Q3' },
      'admin-test',
    );
    expect(status).toBe(404);
    expect(body.error?.code).toBe('not_found');
  });

  it('clears a cohort tag when null is passed', async () => {
    const seeded = await store.upsertUserByEmail('cohort-clear@example.com', 'Cohort Clear');
    await store.setUserCohort(seeded.id, 'old-tag');
    const { status, body } = await postJson(
      '/admin/cohort',
      { userId: seeded.id, cohort: null },
      'admin-test',
    );
    expect(status).toBe(200);
    expect(body.cohort).toBeNull();
    const refreshed = await store.user(seeded.id);
    expect(refreshed.cohort).toBeNull();
  });

  it('rejects payloads with spaces in cohort', async () => {
    const seeded = await store.upsertUserByEmail('cohort-bad@example.com', 'Cohort Bad');
    const { status, body } = await postJson(
      '/admin/cohort',
      { userId: seeded.id, cohort: 'has spaces' },
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
  });
});

describe('GET /admin/test-users', () => {
  beforeEach(() => {
    env.ADMIN_TOKEN = 'admin-test';
  });

  it('returns an empty list when no users carry the cohort', async () => {
    const { status, body } = await get(
      '/admin/test-users?cohort=cohort-empty-zzz&onchain=false',
      'admin-test',
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.cohort).toBe('cohort-empty-zzz');
    expect(body.count).toBe(0);
    expect(body.users).toEqual([]);
  });

  it('returns the enriched view for a tagged user (onchain off)', async () => {
    const seeded = await store.upsertUserByEmail('cohort-view@example.com', 'Cohort View');
    await store.setUserCohort(seeded.id, 'cohort-view-test');
    const { status, body } = await get(
      '/admin/test-users?cohort=cohort-view-test&onchain=false',
      'admin-test',
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    const row = body.users[0];
    expect(row.id).toBe(seeded.id);
    expect(row.email).toBe('cohort-view@example.com');
    expect(row.cohort).toBe('cohort-view-test');
    expect(row.wallets).toEqual({ evm: null, solana: null });
    expect(row.balances.onchainUsdcBase).toBeNull();
    expect(row.flags.pmClobDerived).toBe(false);
    expect(row.flags.hlBuilderApproved).toBe(false);
    expect(row.positions).toEqual({ hyperliquid: 0, polymarket: 0 });
  });
});

describe('POST /admin/withdraw-all', () => {
  beforeEach(() => {
    env.ADMIN_TOKEN = 'admin-test';
  });

  it('rejects without the admin bearer', async () => {
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      { userId: '00000000-0000-0000-0000-000000000001', destinationAddress: '0x' + '1'.repeat(40) },
      undefined,
    );
    expect(status).toBe(401);
    expect(body.error?.code).toBe('unauthorized');
  });

  it('rejects a malformed destinationAddress', async () => {
    const seeded = await store.upsertUserByEmail('wd-bad-dest@example.com', 'WD Bad');
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      { userId: seeded.id, destinationAddress: 'not-an-address' },
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
  });

  it('returns 404 for a user that does not exist', async () => {
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      {
        userId: '00000000-0000-0000-0000-00000000feed',
        destinationAddress: '0x' + '1'.repeat(40),
      },
      'admin-test',
    );
    expect(status).toBe(404);
    expect(body.error?.code).toBe('not_found');
  });

  it('rejects users that are not tagged into a recovery cohort', async () => {
    const seeded = await store.upsertUserByEmail('wd-no-cohort@example.com', 'WD No Cohort');
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      { userId: seeded.id, destinationAddress: '0x' + '1'.repeat(40) },
      'admin-test',
    );
    expect(status).toBe(403);
    expect(body.error?.code).toBe('forbidden');
    expect(body.error?.message).toBe('cohort_required');
  });

  it('rejects when the user has no EVM wallet on file', async () => {
    const seeded = await store.upsertUserByEmail('wd-no-wallet@example.com', 'WD No Wallet');
    await store.setUserCohort(seeded.id, 'tester-2026Q3');
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      { userId: seeded.id, destinationAddress: '0x' + '1'.repeat(40) },
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
    expect(body.error?.message).toBe('user_has_no_evm_wallet');
  });

  it('rejects EVM-shaped destinationAddress when chain=solana', async () => {
    const seeded = await store.upsertUserByEmail('wd-sol-mix@example.com', 'WD Sol Mix');
    await store.setUserCohort(seeded.id, 'tester-2026Q3');
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      {
        userId: seeded.id,
        chain: 'solana',
        destinationAddress: '0x' + '1'.repeat(40),
      },
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
  });

  it('records an .attempted audit row even when the payload is malformed (F5)', async () => {
    const before = await store.listAuditEntries({
      actionPrefix: 'admin.withdraw-all.attempted',
      limit: 100,
    });
    const beforeCount = before.length;
    const { status } = await postJson(
      '/admin/withdraw-all',
      { userId: 'not-a-uuid', destinationAddress: 'not-an-address' },
      'admin-test',
    );
    expect(status).toBe(400);
    const after = await store.listAuditEntries({
      actionPrefix: 'admin.withdraw-all.attempted',
      limit: 100,
    });
    expect(after.length).toBeGreaterThan(beforeCount);
    // Most recent row first; metadata.payload should include the bad userId so
    // a probe is forensically traceable.
    const newest = after[0];
    expect(newest.action).toBe('admin.withdraw-all.attempted');
    const meta = newest.metadata as { payload?: { userId?: unknown } } | undefined;
    expect(meta?.payload?.userId).toBe('not-a-uuid');
  });

  it('blocks EVM self-drain when dest equals source (F3)', async () => {
    const seeded = await store.upsertUserByEmail('wd-self-evm@example.com', 'WD Self EVM');
    const selfWallet = '0x' + 'ab'.repeat(20);
    await store.setUserCohort(seeded.id, 'tester-2026Q3');
    await store.setPrivyWallet(seeded.id, 'priv-self-evm', selfWallet);
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      { userId: seeded.id, destinationAddress: selfWallet },
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
    expect(body.error?.message).toBe('destination_equals_source');
  });

  it('blocks Solana self-drain when dest equals source (F3)', async () => {
    const seeded = await store.upsertUserByEmail('wd-self-sol@example.com', 'WD Self Sol');
    const selfSol = 'So11111111111111111111111111111111111111112';
    await store.setUserCohort(seeded.id, 'tester-2026Q3');
    await store.setPrivySolWallet(seeded.id, 'priv-self-sol', selfSol);
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      { userId: seeded.id, chain: 'solana', destinationAddress: selfSol },
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
    expect(body.error?.message).toBe('destination_equals_source');
  });

  it('rejects when chain=solana but user has no Solana wallet on file', async () => {
    const seeded = await store.upsertUserByEmail('wd-no-sol@example.com', 'WD No Sol');
    await store.setUserCohort(seeded.id, 'tester-2026Q3');
    const { status, body } = await postJson(
      '/admin/withdraw-all',
      {
        userId: seeded.id,
        chain: 'solana',
        // 32-44 char base58 — Solana pubkey shape, validates at the Zod
        // boundary so we hit the wallet-missing check beyond.
        destinationAddress: '11111111111111111111111111111111',
      },
      'admin-test',
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
    expect(body.error?.message).toBe('user_has_no_solana_wallet');
  });

  it('threads an admin retry key into EVM executor submissions', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/routes/admin.ts'), 'utf8');

    expect(source).toContain("c.req.header('Idempotency-Key')");
    expect(source).toContain('admin-withdraw-all:');
    expect(source).toContain('executor.sendCalls(userId, calls, idempotencyKey ? { idempotencyKey } : undefined)');
  });
});

/**
 * Passive HL-fill push notifier (competitor sprint push channel).
 * Pins the anti-storm cursor model + the delta-only notification contract.
 *
 * WORKER-P1-1 — the second describe block below pins the scale-out rewrite:
 * durable (Redis-backed) cursors surviving a simulated restart, full-
 * population keyset pagination + wraparound, time-budget cutoff + resume,
 * notification dedupe as defense-in-depth against a cursor regression, and
 * the bounded-concurrency worker pool. The Redis-backed tests inject a small
 * Map-backed fake via `_setFillsRedisForTests` (same technique as
 * lib/auth-ticket.spec.ts's `_setTicketRedisForTests`) rather than mocking
 * ioredis — fills-notifier builds its client lazily through lib/redis.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { store } from '../store/index.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import * as expoPush from '../lib/expo-push.js';
import { env } from '../lib/env.js';
import { RedisKeys, type RedisClient } from '../lib/redis.js';
import { sweepFills, _resetFillsCursors, _setFillsRedisForTests } from './fills-notifier.js';

const WALLET = '0x00000000000000000000000000000000000000ff';

async function authedUser(email: string): Promise<{ id: string; token: string }> {
  const start = await app.request('/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const { challengeId } = (await start.json()) as { challengeId: string };
  const verify = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: '482019' }),
  });
  const { token } = (await verify.json()) as { token: string };
  const me = (await app
    .request('/auth/me', { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json())) as { user: { id: string } };
  return { id: me.user.id, token };
}

async function seedPushUser(email: string, wallet = true): Promise<string> {
  const { id } = await authedUser(email);
  const user = await store.user(id);
  if (wallet) await store.setPrivyWallet(id, 'wallet_fills_notify', WALLET, { force: true });
  await store.saveExpoPushSubscription(user!, { token: `ExponentPushToken[${email}]`, platform: 'ios' });
  return id;
}

function fill(timeMs: number, over: Partial<{ coin: string; qty: number; priceUsd: number }> = {}) {
  return {
    orderId: `oid_${timeMs}`,
    coin: over.coin ?? 'BTC',
    sideLong: true,
    qty: over.qty ?? 0.01,
    priceUsd: over.priceUsd ?? 50_000,
    feeUsd: 0.02,
    timeMs,
    hash: `0x${timeMs}`,
  };
}

/* ── WORKER-P1-1 test helpers ── */

const envMut = env as unknown as {
  MAX_USERS_PER_SWEEP: number;
  FILLS_NOTIFIER_CONCURRENCY: number;
  FILLS_SWEEP_BUDGET_MS: number;
  FILLS_NOTIFIER_MIN_DELAY_MS: number;
};
const ORIGINAL_ENV = { ...envMut };

/** Builds a store.listPushEnabledUserIdsPage-compatible paginator over a
 *  fixed, pre-sorted synthetic id list — mirrors the real keyset semantics
 *  (strictly-greater-than cursor, stable ascending order). */
function pagedUserIds(ids: string[]) {
  return async ({ after, limit }: { after: string | null; limit: number }): Promise<string[]> => {
    const start = after == null ? 0 : ids.findIndex((id) => id > after);
    if (start === -1) return [];
    return ids.slice(start, start + limit);
  };
}

/** Minimal Map-backed fake Redis — only the get/set/del subset fills-notifier
 *  calls. `set` honors the 'NX' arg (SET NX semantics) since dedupe relies
 *  on it; TTL args are accepted but not simulated (no test needs expiry). */
function makeMemRedis(): { client: RedisClient; data: Map<string, string> } {
  const data = new Map<string, string>();
  const set = vi.fn(async (key: string, val: string, ...args: unknown[]) => {
    if (args.includes('NX') && data.has(key)) return null;
    data.set(key, val);
    return 'OK';
  });
  const get = vi.fn(async (key: string) => (data.has(key) ? (data.get(key) as string) : null));
  const del = vi.fn(async (key: string) => {
    const had = data.has(key);
    data.delete(key);
    return had ? 1 : 0;
  });
  return { client: { get, set, del } as unknown as RedisClient, data };
}

describe('sweepFills — passive HL fill notifications', () => {
  beforeEach(() => {
    _resetFillsCursors();
    _setFillsRedisForTests(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _setFillsRedisForTests(null);
  });

  it('first sight seeds the cursor and notifies NOTHING (no restart storm)', async () => {
    const id = await seedPushUser('fills-seed@example.com');
    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockResolvedValue([id]);
    const send = vi.spyOn(expoPush, 'sendExpoPushToUser').mockResolvedValue(1);
    // Even if the venue returns old fills, the first sweep must stay silent.
    vi.spyOn(hyperliquid, 'getUserFills').mockResolvedValue([fill(1_000)]);

    const r = await sweepFills(10_000);
    expect(r.notified).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('notifies only fills newer than the cursor on the next sweep', async () => {
    const id = await seedPushUser('fills-delta@example.com');
    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockResolvedValue([id]);
    const send = vi.spyOn(expoPush, 'sendExpoPushToUser').mockResolvedValue(1);
    const getFills = vi.spyOn(hyperliquid, 'getUserFills');

    // Sweep 1 at t=10_000 seeds cursor=10_000 (first-sight → no venue call).
    await sweepFills(10_000);

    // Sweep 2: one fill before the cursor (ignored) + one after (notified).
    getFills.mockResolvedValueOnce([fill(9_500), fill(11_000, { coin: 'ETH' })]);
    const r = await sweepFills(12_000);
    expect(r.notified).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1].title).toContain('ETH');
  });

  it('advances the cursor so the same fill never re-notifies', async () => {
    const id = await seedPushUser('fills-once@example.com');
    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockResolvedValue([id]);
    vi.spyOn(expoPush, 'sendExpoPushToUser').mockResolvedValue(1);
    const getFills = vi.spyOn(hyperliquid, 'getUserFills');

    await sweepFills(10_000); // first-sight seed
    getFills.mockResolvedValueOnce([fill(11_000)]);
    const first = await sweepFills(12_000);
    // Same fill returned again next sweep — must be below the advanced cursor.
    getFills.mockResolvedValueOnce([fill(11_000)]);
    const second = await sweepFills(13_000);

    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
  });

  it('skips users without a wallet', async () => {
    const id = await seedPushUser('fills-nowallet@example.com', /* wallet */ false);
    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockResolvedValue([id]);
    const getFills = vi.spyOn(hyperliquid, 'getUserFills');

    const r = await sweepFills(10_000);
    // User in the poll set but no wallet → getUserFills never called.
    expect(r.users).toBe(1);
    expect(getFills).not.toHaveBeenCalled();
  });
});

describe('WORKER-P1-1 — fills-notifier scale-out', () => {
  beforeEach(() => {
    _resetFillsCursors();
    _setFillsRedisForTests(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _setFillsRedisForTests(null);
    Object.assign(envMut, ORIGINAL_ENV);
  });

  it('keyset-pages the FULL population across successive sweeps and wraps around (>500 users, no hard cap)', async () => {
    const POP = 510;
    const ids = Array.from({ length: POP }, (_, i) => `scale_${String(i).padStart(4, '0')}`);
    const visited = new Set<string>();

    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockImplementation(pagedUserIds(ids));
    vi.spyOn(store, 'user').mockImplementation(async (id: string) => {
      visited.add(id);
      return { privyWalletAddress: WALLET } as unknown as Awaited<ReturnType<typeof store.user>>;
    });
    vi.spyOn(hyperliquid, 'getUserFills').mockResolvedValue([]);

    envMut.MAX_USERS_PER_SWEEP = 80;
    envMut.FILLS_NOTIFIER_CONCURRENCY = 4;

    // Phase 1 — seed every cursor. First-sight is instant (no HL call, no
    // rate-floor sleep), so a single generously-budgeted sweep already
    // proves pagination alone reaches the FULL population — the pre-fix
    // code hard-capped this at 500 and never saw the tail.
    envMut.FILLS_SWEEP_BUDGET_MS = 60_000;
    const seed = await sweepFills(1_000);
    expect(seed.users).toBe(POP);
    expect(visited.size).toBe(POP);

    // Phase 2 — steady state: every user now has a stored cursor, so each
    // visit pays the per-lane rate floor. A tight budget forces each sweep
    // to stop mid-population, proving the worker needs MULTIPLE successive
    // sweeps (not one) to cover >500 users under a realistic time budget.
    visited.clear();
    envMut.FILLS_SWEEP_BUDGET_MS = 50;
    envMut.FILLS_NOTIFIER_MIN_DELAY_MS = 2;

    let sweeps = 0;
    while (visited.size < POP && sweeps < 500) {
      await sweepFills(2_000);
      sweeps += 1;
    }
    expect(sweeps).toBeGreaterThan(1);
    expect(visited.size).toBe(POP);

    // Wraparound — the keyset is now fully consumed; the NEXT sweep must
    // start back at the front instead of returning nothing forever.
    // Keep this assertion independent of host scheduling load; the exact
    // budget/final-item collision is pinned deterministically below.
    envMut.FILLS_SWEEP_BUDGET_MS = 60_000;
    const wrapped = await sweepFills(3_000);
    expect(wrapped.users).toBeGreaterThan(0);
  });

  it('wraps immediately when the budget expires only after the final user is complete', async () => {
    const ids = ['tail_00', 'tail_01'];
    const { client } = makeMemRedis();
    _setFillsRedisForTests(client);
    for (const id of ids) await client.set(RedisKeys.fillsCursor(id), '1');

    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockImplementation(pagedUserIds(ids));
    let completed = 0;
    let wallMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => wallMs);
    vi.spyOn(store, 'user').mockImplementation(async () => {
      completed += 1;
      if (completed === ids.length) wallMs = 100;
      return { privyWalletAddress: WALLET } as unknown as Awaited<ReturnType<typeof store.user>>;
    });
    vi.spyOn(hyperliquid, 'getUserFills').mockResolvedValue([]);

    envMut.MAX_USERS_PER_SWEEP = 10; // the two-user tail is a short final page
    envMut.FILLS_NOTIFIER_CONCURRENCY = 1;
    envMut.FILLS_NOTIFIER_MIN_DELAY_MS = 0;
    envMut.FILLS_SWEEP_BUDGET_MS = 50;

    const tail = await sweepFills(1_000);
    expect(tail.users).toBe(ids.length);
    expect(await client.get(RedisKeys.fillsScanCursor())).toBeNull();

    const wrapped = await sweepFills(2_000);
    expect(wrapped.users).toBe(ids.length);
  });

  it('cursor survives a simulated process restart (durable Redis, not process memory)', async () => {
    const { client } = makeMemRedis();
    _setFillsRedisForTests(client);

    const id = await seedPushUser('fills-restart@example.com');
    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockResolvedValue([id]);
    const send = vi.spyOn(expoPush, 'sendExpoPushToUser').mockResolvedValue(1);
    const getFills = vi.spyOn(hyperliquid, 'getUserFills');

    // Sweep 1 — first sight, seeds the cursor into the (fake, durable) Redis.
    await sweepFills(10_000);
    expect(await client.get(RedisKeys.fillsCursor(id))).toBe('10000');

    // Simulate a process restart: wipe ONLY the in-process fallback state.
    // The fake Redis instance (standing in for the real, durable store) is
    // deliberately left untouched — a real restart loses process memory but
    // not the external Redis keyspace.
    _resetFillsCursors();

    // Sweep 2, long after the "restart" — a fill just after the seeded
    // cursor. Under the OLD (process-memory-only) model this would look
    // like first-sight again and notify nothing; the durable cursor must
    // still be there and catch it.
    getFills.mockResolvedValueOnce([fill(11_000, { coin: 'ETH' })]);
    const r2 = await sweepFills(999_999);

    expect(r2.notified).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1].title).toContain('ETH');
  });

  it('budget cutoff persists the scan cursor and the next sweep resumes exactly where it stopped', async () => {
    const POP = 12;
    const ids = Array.from({ length: POP }, (_, i) => `budget_${String(i).padStart(2, '0')}`);
    const { client } = makeMemRedis();
    _setFillsRedisForTests(client);
    // Pre-seed every cursor as already-established (not first-sight) so each
    // visit pays the rate-floor delay — first-sight users return instantly
    // and the budget would never have anything real to bind against.
    for (const id of ids) {
      await client.set(RedisKeys.fillsCursor(id), '1');
    }

    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockImplementation(pagedUserIds(ids));
    vi.spyOn(store, 'user').mockImplementation(
      async () => ({ privyWalletAddress: WALLET }) as unknown as Awaited<ReturnType<typeof store.user>>,
    );
    vi.spyOn(hyperliquid, 'getUserFills').mockResolvedValue([]);

    envMut.MAX_USERS_PER_SWEEP = 12; // one page covers the whole population —
    // isolates the budget cutoff from pagination page-boundary effects.
    envMut.FILLS_NOTIFIER_CONCURRENCY = 1; // serial — makes the cutoff point exact.
    envMut.FILLS_NOTIFIER_MIN_DELAY_MS = 40;
    envMut.FILLS_SWEEP_BUDGET_MS = 115; // 2×40=80 comfortably under, 3×40=120 comfortably over.

    const r1 = await sweepFills(5_000);
    expect(r1.users).toBe(3); // users 0,1,2 complete (checks at ~0/40/80ms, all <115; next at ~120ms >115)
    expect(await client.get(RedisKeys.fillsScanCursor())).toBe(ids[2]);

    const r2 = await sweepFills(6_000);
    expect(r2.users).toBe(3); // resumes at ids[3..5], cut off again by the same budget
    expect(await client.get(RedisKeys.fillsScanCursor())).toBe(ids[5]);
  });

  it('notification dedupe suppresses a duplicate send even if the cursor regresses (defense in depth)', async () => {
    const { client } = makeMemRedis();
    _setFillsRedisForTests(client);

    const id = await seedPushUser('fills-dedupe@example.com');
    await client.set(RedisKeys.fillsCursor(id), '5000'); // already-seeded, not first-sight
    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockResolvedValue([id]);
    const send = vi.spyOn(expoPush, 'sendExpoPushToUser').mockResolvedValue(1);
    vi.spyOn(hyperliquid, 'getUserFills').mockResolvedValue([fill(11_000)]);

    const r1 = await sweepFills(20_000);
    expect(r1.notified).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);

    // Simulate a cursor-durability regression — roll it back behind the fill
    // that was ALREADY notified. Without a separate dedupe ledger this would
    // re-send; the cursor-advance mechanism alone can no longer catch it,
    // because as far as the cursor is concerned this fill is "fresh" again.
    await client.set(RedisKeys.fillsCursor(id), '5000');

    const r2 = await sweepFills(21_000);
    expect(r2.notified).toBe(0);
    expect(send).toHaveBeenCalledTimes(1); // still just the one send from r1
  });

  it('never exceeds FILLS_NOTIFIER_CONCURRENCY in-flight Hyperliquid fetches', async () => {
    const POP = 9;
    const ids = Array.from({ length: POP }, (_, i) => `conc_${String(i).padStart(2, '0')}`);
    const { client } = makeMemRedis();
    _setFillsRedisForTests(client);
    for (const id of ids) await client.set(RedisKeys.fillsCursor(id), '1');

    vi.spyOn(store, 'listPushEnabledUserIdsPage').mockResolvedValue(ids);
    vi.spyOn(store, 'user').mockImplementation(
      async () => ({ privyWalletAddress: WALLET }) as unknown as Awaited<ReturnType<typeof store.user>>,
    );

    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(hyperliquid, 'getUserFills').mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return [];
    });

    envMut.FILLS_NOTIFIER_CONCURRENCY = 3;
    envMut.MAX_USERS_PER_SWEEP = 200;
    envMut.FILLS_SWEEP_BUDGET_MS = 5_000;
    envMut.FILLS_NOTIFIER_MIN_DELAY_MS = 5;

    const r = await sweepFills(1_000);

    expect(r.users).toBe(POP);
    expect(maxInFlight).toBe(3);
  });
});

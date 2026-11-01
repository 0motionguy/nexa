/**
 * Passive HL-fill push notifier (competitor sprint push channel, 2026-07-03).
 *
 * Order-placement pushes already fire synchronously in the markets route, but
 * a RESTING limit / TP-SL / externally-placed order fills server-side with no
 * request to hang a push on. This worker polls Hyperliquid fills for every
 * push-enabled user and notifies the deltas — the "your BTC limit filled"
 * class every competitor has.
 *
 * WORKER-P1-1 (2026-07-15) — scale-out rewrite. The original cursor model was
 * process-memory-only (a restart replayed or silently dropped ~1min of fills)
 * and capped the poll at a single 500-user page (the tail of a >500-user
 * population was NEVER swept, forever). This version:
 *
 *   - Durable per-user cursors in Redis (`RedisKeys.fillsCursor`), no TTL —
 *     survive restarts. Bootstrap for a user with no stored cursor is `now`
 *     (still no backfill storm on first sight).
 *   - Full-population keyset pagination (`store.listPushEnabledUserIdsPage`)
 *     replacing the single-page cap. A sweep-wide scan cursor
 *     (`RedisKeys.fillsScanCursor`) persists after every completed page, so a
 *     time-budget-truncated sweep resumes where it left off next sweep
 *     instead of restarting at the front of the keyspace every minute — and
 *     wraps to the start once the keyset is exhausted.
 *   - Bounded concurrency (`FILLS_NOTIFIER_CONCURRENCY`, default 4) via a
 *     small in-process worker pool — no queue library.
 *   - A wall-clock time budget (`FILLS_SWEEP_BUDGET_MS`, default 45s): once
 *     exceeded, no new users are started, the scan cursor is persisted, and
 *     the sweep returns early.
 *   - Notification dedupe (`RedisKeys.fillNotified`, 7-day TTL, SET NX) so a
 *     cursor-durability regression can't double-push a fill already delivered.
 *   - A per-lane rate floor (`FILLS_NOTIFIER_MIN_DELAY_MS`, default 100ms)
 *     bounding this process's worst-case request rate to Hyperliquid. See the
 *     SCALE MATH note on `sweepFills` below.
 *
 * Redis is required for the durable cursor/dedupe path — with REDIS_URL
 * unset the worker still runs (in-memory Map fallback for cursors/dedupe) so
 * local/demo mode keeps working, but restart-durability and cross-replica
 * dedupe are lost. Matches the REDIS_URL-optional pattern of lib/auth.ts's
 * ticket store.
 *
 * Queue: fills-notifier · scheduler: fills-notifier-poll · cron every minute
 * (off-second not applicable to * * * * *). BullMQ connection unavailable →
 * worker not started; `POST /admin/sweep-fills` is the fallback trigger (same
 * pattern as the claim-sweeper / digest-sender).
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from '../lib/log.js';
import { store } from '../store/index.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import { sendExpoPushToUser } from '../lib/expo-push.js';
import { workerHeartbeat } from '../lib/metrics.js';
import { env } from '../lib/env.js';
import { makeRedis, RedisKeys, type RedisClient } from '../lib/redis.js';
import { makeConnectionOpts } from './connection.js';

const QUEUE_NAME = 'fills-notifier';
const JOB_NAME = 'sweep';
const SCHEDULER_ID = 'fills-notifier-poll';
const CRON_PATTERN = '* * * * *';
/** Cap fills pushed per user per sweep so a backfill can't spam a device. */
const MAX_FILLS_PER_USER = 5;
/** Dedupe ledger TTL — long enough that a re-delivered/backfilled fill can never outlive it. */
const FILL_NOTIFIED_TTL_SECONDS = 7 * 24 * 60 * 60;

export let fillsNotifierQueue: Queue | null = null;
let worker: Worker | null = null;

/** userId → last fill timeMs we've already notified (or seeded). In-memory
 *  fallback used only when Redis is unavailable — see getFillsRedis(). */
const memCursors = new Map<string, number>();
/** In-memory fallback for the sweep-wide keyset scan cursor. */
let memScanCursor: string | null = null;
/** In-memory fallback dedupe set. Unbounded is fine — only touched when Redis
 *  (the durable path) is unavailable, i.e. local/demo/test only. */
const memNotified = new Set<string>();

/* ── redis (lazy singleton, test-injectable — mirrors lib/auth.ts's ticket store) ── */

let fillsRedis: RedisClient | null = null;
let fillsRedisInitTried = false;

function getFillsRedis(): RedisClient | null {
  if (!fillsRedisInitTried) {
    fillsRedisInitTried = true;
    fillsRedis = makeRedis(env.REDIS_URL);
  }
  return fillsRedis;
}

/** Test-only — inject a fake Redis client, or null to force the in-memory
 *  fallback deterministically (mirrors lib/auth.ts's _setTicketRedisForTests). */
export function _setFillsRedisForTests(client: RedisClient | null): void {
  fillsRedis = client;
  fillsRedisInitTried = true;
}

/* ── durable per-user fill cursor ── */

async function getCursor(userId: string): Promise<number | undefined> {
  const redis = getFillsRedis();
  if (redis) {
    try {
      const v = await redis.get(RedisKeys.fillsCursor(userId));
      return v == null ? undefined : Number(v);
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'fills-notifier: cursor read failed; treating as unseeded',
      );
      return undefined;
    }
  }
  return memCursors.get(userId);
}

async function setCursor(userId: string, valueMs: number): Promise<void> {
  const redis = getFillsRedis();
  if (redis) {
    try {
      await redis.set(RedisKeys.fillsCursor(userId), String(valueMs));
      return;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'fills-notifier: cursor write failed',
      );
      // fall through to the in-memory mirror so at least this process stays consistent
    }
  }
  memCursors.set(userId, valueMs);
}

/* ── sweep-wide keyset scan cursor ── */

async function getScanCursor(): Promise<string | null> {
  const redis = getFillsRedis();
  if (redis) {
    try {
      return await redis.get(RedisKeys.fillsScanCursor());
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'fills-notifier: scan cursor read failed');
      return null;
    }
  }
  return memScanCursor;
}

async function setScanCursor(after: string | null): Promise<void> {
  const redis = getFillsRedis();
  if (redis) {
    try {
      if (after === null) await redis.del(RedisKeys.fillsScanCursor());
      else await redis.set(RedisKeys.fillsScanCursor(), after);
      return;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'fills-notifier: scan cursor write failed');
    }
  }
  memScanCursor = after;
}

/* ── notification dedupe ── */

/** True when this (userId, fillId) was already notified — caller should skip
 *  the push. False on first claim (this call is now the record of record). */
async function claimFillNotification(userId: string, fillId: string): Promise<boolean> {
  const key = RedisKeys.fillNotified(userId, fillId);
  const redis = getFillsRedis();
  if (redis) {
    try {
      const res = await redis.set(key, '1', 'EX', FILL_NOTIFIED_TTL_SECONDS, 'NX');
      return res !== 'OK'; // null = already existed = duplicate
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId, fillId },
        'fills-notifier: dedupe check failed; notifying (fail-open)',
      );
      return false;
    }
  }
  if (memNotified.has(key)) return true;
  memNotified.add(key);
  return false;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded-concurrency worker pool — no external deps. `concurrency` lanes
 * each claim the next unclaimed index synchronously (JS run-to-completion
 * guarantees no two lanes claim the same index) and await `handler` to
 * completion before claiming again, so at the point this resolves the
 * claimed indices form a contiguous prefix `[0, visited)` of `items` that
 * have ALL been fully processed — callers rely on that to know exactly how
 * far into `items` progress reached when `stopped` is true.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  handler: (item: T) => Promise<void>,
): Promise<{ visited: number; stopped: boolean }> {
  let next = 0;
  let visited = 0;
  let stopped = false;

  async function lane(): Promise<void> {
    for (;;) {
      const i = next;
      if (i >= items.length) return;
      if (shouldStop()) {
        stopped = true;
        return;
      }
      next += 1; // synchronous claim — no two lanes ever share an index
      visited += 1;
      await handler(items[i] as T);
    }
  }

  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => lane());
  await Promise.all(lanes);
  return { visited, stopped };
}

/* ── per-user sweep body ── */

async function processUser(userId: string, now: number): Promise<number> {
  const user = await store.user(userId);
  const addr = user?.privyWalletAddress ?? null;
  if (!addr) return 0;

  const seededCursor = await getCursor(userId);
  if (seededCursor === undefined) {
    // First sight — establish the baseline, notify nothing (no restart storm).
    await setCursor(userId, now);
    return 0;
  }

  // Per-lane rate floor — bounds this process's worst-case request rate to
  // Hyperliquid regardless of page size or how fast the venue responds.
  await sleep(env.FILLS_NOTIFIER_MIN_DELAY_MS);
  const fills = await hyperliquid.getUserFills(addr, { limit: 50, sinceMs: seededCursor });
  const fresh = fills.filter((f) => f.timeMs > seededCursor).sort((a, b) => a.timeMs - b.timeMs);
  if (fresh.length === 0) return 0;

  // Advance the cursor to the newest fill BEFORE pushing, so a push failure
  // (or a crash mid-loop) can't cause the same fill to re-notify next sweep
  // from the CURSOR side — claimFillNotification below is the second,
  // independent line of defense against a duplicate send (e.g. if the
  // cursor write itself is ever lost/regressed).
  await setCursor(userId, Math.max(seededCursor, ...fresh.map((f) => f.timeMs)));

  let notified = 0;
  for (const f of fresh.slice(-MAX_FILLS_PER_USER)) {
    const alreadyNotified = await claimFillNotification(userId, f.hash);
    if (alreadyNotified) continue;
    const side = f.sideLong ? 'Long' : 'Short';
    await sendExpoPushToUser(
      userId,
      {
        title: `${f.coin} ${side.toLowerCase()} filled`,
        body: `${f.qty} ${f.coin} @ $${f.priceUsd.toLocaleString()}`,
        link: '/portfolio',
        data: { venue: 'hyperliquid', coin: f.coin, orderId: f.orderId, hash: f.hash },
      },
      { category: 'fills' },
    );
    notified += 1;
  }
  return notified;
}

/**
 * One sweep: keyset-paginates the FULL push-enabled population (not a single
 * capped page), processing pages with bounded concurrency until either the
 * keyset is exhausted (wraps to the start for next time) or the wall-clock
 * time budget is spent (persists the scan cursor so the next sweep resumes
 * there instead of restarting at the front). Per-user errors log and
 * continue — one bad user can't stall the sweep.
 *
 * SCALE MATH (defaults: page 200, concurrency 4, budget 45_000ms, per-lane
 * floor 100ms; assumes Hyperliquid responds fast relative to the 100ms floor
 * — real venue latency adds on top of this floor-bound estimate): one page
 * of 200 users across 4 lanes is 200/4 = 50 users/lane × 100ms ≈ 5s.
 * 1,000 users = 5 pages ≈ 25s — one sweep, comfortably inside the 45s budget,
 * so every user is checked every ~1min (the cron interval). 10,000 users =
 * 50 pages ≈ 250s; the 45s budget is spent partway through page ~9 (~1,800
 * users), the scan cursor persists there, and the NEXT sweep (1min later)
 * continues from that userId — full coverage across ⌈250s / 45s⌉ ≈ 6 sweeps
 * (~6min), vs. the pre-fix behavior where everything past user #500 was
 * silently skipped forever.
 *
 * Exported for the admin fallback route + tests.
 */
export async function sweepFills(now = Date.now()): Promise<{
  users: number;
  notified: number;
}> {
  const sweepStartWallMs = Date.now();
  const budgetMs = env.FILLS_SWEEP_BUDGET_MS;
  const pageSize = env.MAX_USERS_PER_SWEEP;
  const concurrency = env.FILLS_NOTIFIER_CONCURRENCY;
  const shouldStop = () => Date.now() - sweepStartWallMs > budgetMs;

  let after = await getScanCursor();
  let totalUsers = 0;
  let totalNotified = 0;
  let pagesVisited = 0;
  let budgetExceeded = false;

  for (;;) {
    const page = await store.listPushEnabledUserIdsPage({ after, limit: pageSize });
    if (page.length === 0) {
      // End of keyset (or nothing to do at all) — wrap so the next sweep
      // starts from the front rather than getting stuck past the tail.
      after = null;
      break;
    }
    pagesVisited += 1;

    const result = await runPool(page, concurrency, shouldStop, async (userId) => {
      try {
        totalNotified += await processUser(userId, now);
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), userId },
          'fills-notifier: per-user sweep failed',
        );
      }
    });
    totalUsers += result.visited;

    if (result.stopped) {
      // Budget spent partway through this page — persist the LAST user we
      // fully finished (a contiguous prefix, see runPool's doc comment), not
      // the page start, so the next sweep resumes mid-page instead of
      // re-visiting already-swept users. visited===0 means we made no
      // progress at all on this page — leave `after` exactly as it was.
      after = result.visited > 0 ? (page[result.visited - 1] ?? after) : after;
      budgetExceeded = true;
      break;
    }

    // Page fully processed — advance past its last id.
    after = page[page.length - 1] ?? after;

    if (page.length < pageSize) {
      // Short page = end of keyset. Wrap for next sweep.
      after = null;
      break;
    }
    if (shouldStop()) {
      budgetExceeded = true;
      break;
    }
  }

  await setScanCursor(after);
  if (budgetExceeded) {
    log.info(
      { usersVisited: totalUsers, pagesVisited, budgetMs },
      'fills-notifier: sweep budget exceeded; scan cursor persisted for next sweep',
    );
  }

  return { users: totalUsers, notified: totalNotified };
}

export async function startFillsNotifier(): Promise<void> {
  const connection = makeConnectionOpts();
  if (!connection) {
    log.info('fills-notifier: redis unavailable, use POST /admin/sweep-fills');
    return;
  }
  fillsNotifierQueue = new Queue(QUEUE_NAME, { connection });
  await fillsNotifierQueue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: { age: 60 * 60 * 24 }, removeOnFail: { age: 60 * 60 * 24 } } },
  );
  worker = new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      const result = await sweepFills();
      workerHeartbeat.set({ worker: 'fills-notifier' }, Date.now() / 1000);
      if (result.notified > 0) log.info(result, 'fills-notifier: sweep complete');
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'fills-notifier: job failed'),
  );
  log.info('fills-notifier: worker started');
}

export async function stopFillsNotifier(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (fillsNotifierQueue) {
    await fillsNotifierQueue.close();
    fillsNotifierQueue = null;
  }
}

/** Test-only — reset in-process cursor/scan-cursor/dedupe fallback state
 *  (the state used when no Redis is injected). Does not touch an injected
 *  fake Redis's own storage — callers that inject one own its lifecycle. */
export function _resetFillsCursors(): void {
  memCursors.clear();
  memScanCursor = null;
  memNotified.clear();
}

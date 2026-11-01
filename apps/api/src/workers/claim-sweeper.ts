/**
 * 30-day claim reclaim sweeper.
 *
 * Email-claim escrow records expire 30 days after creation. This worker
 * scans for `pending` claims past their `expiresAt`, flips them to `expired`,
 * and refunds each sender via `topUp`. Refunds are idempotent because
 * `expireClaimsBefore` only touches `status='pending'` rows — a second pass
 * sees nothing left to do.
 *
 * Queue: claim-sweep
 * Job scheduler: claim-sweep-daily — cron `0 3 * * *` UTC (daily 03:00).
 *
 * When `REDIS_URL` is unset the queue is not started; the admin sweep route
 * (Phase 2 ε's `POST /admin/sweep-claims`) is the fallback trigger.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from '../lib/log.js';
import { workerHeartbeat } from '../lib/metrics.js';
import { sweepExpiredClaims } from '../lib/sweeps/claims.js';
import { makeConnectionOpts } from './connection.js';

const QUEUE_NAME = 'claim-sweep';
const JOB_NAME = 'sweep';
const SCHEDULER_ID = 'claim-sweep-daily';
/** Daily at 03:00 UTC. Off-peak — claims don't expire under load. */
const CRON_PATTERN = '0 3 * * *';

// Exported so the standalone scheduler can read job counts for the
// bullmq_queue_depth gauge without owning a second queue handle.
export let claimSweepQueue: Queue | null = null;
let worker: Worker | null = null;

export async function startClaimSweeper(): Promise<void> {
  const connection = makeConnectionOpts();
  if (!connection) {
    log.info('claim-sweeper: redis unavailable, use POST /admin/sweep-claims');
    return;
  }
  claimSweepQueue = new Queue(QUEUE_NAME, { connection });
  // Daily 03:00 UTC via BullMQ job scheduler. Repeated calls upsert the same
  // scheduler id, so this is safe to invoke on every boot.
  await claimSweepQueue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: { age: 60 * 60 * 24 * 7 } } },
  );
  worker = new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      const result = await sweepExpiredClaims();
      workerHeartbeat.set({ worker: 'claim-sweep' }, Date.now() / 1000);
      log.info(result, 'claim-sweeper: sweep complete');
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'claim-sweeper: job failed'),
  );
  log.info('claim-sweeper: worker started');
}

export async function stopClaimSweeper(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (claimSweepQueue) {
    await claimSweepQueue.close();
    claimSweepQueue = null;
  }
}

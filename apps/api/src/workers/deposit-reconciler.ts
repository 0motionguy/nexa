/**
 * On-chain deposit reconciliation worker (ADR-0006 Phase 2).
 *
 * Every 2 minutes: scan Base USDC Transfer logs to user wallets since the
 * last cursor and credit the app ledger (idempotent on tx hash). All logic
 * lives in lib/sweeps/deposits.ts — shared with the admin fallback route
 * (POST /admin/sweep-deposits), same pattern as claim-sweeper.
 *
 * Queue: deposit-reconcile
 * Job scheduler: deposit-reconcile-2m — every 2 minutes (see CRON_PATTERN).
 *
 * Gated twice: REDIS_URL must be set for the queue to start at all, and
 * sweepBaseDeposits itself no-ops unless DEPOSIT_RECONCILER=1 + Postgres —
 * so the worker can run everywhere while the money behavior stays opt-in.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from '../lib/log.js';
import { workerHeartbeat } from '../lib/metrics.js';
import { sweepBaseDeposits } from '../lib/sweeps/deposits.js';
import { makeConnectionOpts } from './connection.js';

const QUEUE_NAME = 'deposit-reconcile';
const JOB_NAME = 'sweep';
const SCHEDULER_ID = 'deposit-reconcile-2m';
const CRON_PATTERN = '*/2 * * * *';

// Exported so the standalone scheduler can read job counts for the
// bullmq_queue_depth gauge without owning a second queue handle.
export let depositReconcileQueue: Queue | null = null;
let worker: Worker | null = null;

export async function startDepositReconciler(): Promise<void> {
  const connection = makeConnectionOpts();
  if (!connection) {
    log.info('deposit-reconciler: redis unavailable, use POST /admin/sweep-deposits');
    return;
  }
  depositReconcileQueue = new Queue(QUEUE_NAME, { connection });
  await depositReconcileQueue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: { age: 60 * 60 * 24 } } },
  );
  worker = new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      const result = await sweepBaseDeposits();
      workerHeartbeat.set({ worker: 'deposit-reconcile' }, Date.now() / 1000);
      if (result.ran && (result.credited > 0 || result.initializedCursor)) {
        log.info(result, 'deposit-reconciler: sweep complete');
      }
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'deposit-reconciler: job failed'),
  );
  log.info('deposit-reconciler: worker started');
}

export async function stopDepositReconciler(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (depositReconcileQueue) {
    await depositReconcileQueue.close();
    depositReconcileQueue = null;
  }
}

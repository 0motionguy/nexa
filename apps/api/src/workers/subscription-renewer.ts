/**
 * Subscription renewal cron worker.
 *
 * Subscriptions advance their `currentPeriodEnd` once per pay-period. This
 * worker scans for `active` subscriptions whose `current_period_end < now`,
 * calls the existing `renewSubscription` (which credits the seller + advances
 * the period inside a row lock), and fires `subscription.renewed` to the
 * seller's webhook endpoints.
 *
 * Queue: subscription-renewer
 * Job scheduler: subscription-renewer-hourly — cron `7 * * * *` (offset off
 * the :00 minute mark per the avoid-:00 preference).
 *
 * When `REDIS_URL` is unset the queue is not started; the admin sweep route
 * (Phase 2 ε's `POST /admin/sweep-subscriptions`) is the fallback trigger.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from '../lib/log.js';
import { store } from '../store/index.js';
import { fireWebhooks } from '../lib/webhooks.js';
import { workerHeartbeat } from '../lib/metrics.js';
import { makeConnectionOpts } from './connection.js';

const QUEUE_NAME = 'subscription-renewer';
const JOB_NAME = 'renew';
const SCHEDULER_ID = 'subscription-renewer-hourly';
/** Hourly at minute :07 — off-peak per Mirko's avoid-:00 preference. */
const CRON_PATTERN = '7 * * * *';

// Exported so the standalone scheduler can read job counts for the
// bullmq_queue_depth gauge without owning a second queue handle.
export let subscriptionRenewerQueue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Iterate over every due subscription, renew + fire webhook. Per-row errors
 * log and continue so one stuck seller can't stall the whole batch.
 */
export async function sweepDueSubscriptions(): Promise<{
  due: number;
  renewed: number;
  failed: number;
}> {
  const cutoff = new Date();
  const due = await store.findSubscriptionsDueBefore(cutoff);
  let renewed = 0;
  let failed = 0;
  for (const sub of due) {
    try {
      const seller = await store.user(sub.sellerId);
      const renewedSub = await store.renewSubscription(seller, sub.id, { dueBefore: cutoff });
      renewed += 1;
      void fireWebhooks(await store.webhooksForSeller(seller.id), {
        id: renewedSub.id,
        type: 'subscription.renewed',
        created: new Date().toISOString(),
        data: { subscription: renewedSub },
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'subscription_not_due') continue;
      failed += 1;
      log.error(
        { subId: sub.id, err: e instanceof Error ? e.message : String(e) },
        'subscription-renewer: renew failed',
      );
    }
  }
  return { due: due.length, renewed, failed };
}

export async function startSubscriptionRenewer(): Promise<void> {
  const connection = makeConnectionOpts();
  if (!connection) {
    log.info('subscription-renewer: redis unavailable, use POST /admin/sweep-subscriptions');
    return;
  }
  subscriptionRenewerQueue = new Queue(QUEUE_NAME, { connection });
  await subscriptionRenewerQueue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: { age: 60 * 60 * 24 * 7 } } },
  );
  worker = new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      const result = await sweepDueSubscriptions();
      workerHeartbeat.set({ worker: 'subscription-renewer' }, Date.now() / 1000);
      log.info(result, 'subscription-renewer: sweep complete');
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'subscription-renewer: job failed'),
  );
  log.info('subscription-renewer: worker started');
}

export async function stopSubscriptionRenewer(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (subscriptionRenewerQueue) {
    await subscriptionRenewerQueue.close();
    subscriptionRenewerQueue = null;
  }
}

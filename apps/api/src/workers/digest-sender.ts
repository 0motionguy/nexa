/**
 * Daily agent-spend digest worker.
 *
 * Stack upgrades Phase 3 — every active agent with `spentTodayUsd > 0` and a
 * digest cycle older than 24 h gets one summary email per day: today's spend
 * total + the top endpoint by USD. Idempotency via `nb_agent_spend_digests`
 * (`recordAgentDigestSent` upserts on agent_id).
 *
 * Queue: digest-sender
 * Job scheduler: digest-sender-daily — cron `19 14 * * *` UTC (daily 14:19 UTC,
 * mid-afternoon European time / morning Pacific). Off-minute per Mirko's
 * avoid-:00 preference.
 *
 * When `REDIS_URL` is unset the queue is not started; the admin sweep route
 * `POST /admin/dispatch-digests` is the fallback trigger (same pattern as
 * Sprint 10 ε's claim-sweeper).
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from '../lib/log.js';
import { store } from '../store/index.js';
import { sendEmail } from '../lib/email.js';
import { workerHeartbeat } from '../lib/metrics.js';
import { makeConnectionOpts } from './connection.js';

const QUEUE_NAME = 'digest-sender';
const JOB_NAME = 'send';
const SCHEDULER_ID = 'digest-sender-daily';
/** Daily at 14:19 UTC — off-minute, off-the-hour mark. */
const CRON_PATTERN = '19 14 * * *';

// Exported so the standalone scheduler can read job counts for the
// bullmq_queue_depth gauge without owning a second queue handle.
export let digestSenderQueue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Iterate over every agent due for a digest, send the email + mark sent.
 * Per-row errors log and continue so one bad email can't stall the batch.
 *
 * Cutoff = 24 h before "now". `findAgentsDueForDigest(cutoff)` returns agents
 * whose last_sent_at < cutoff OR whose row doesn't exist yet, AND spent > 0.
 */
export async function sweepDigests(): Promise<{
  due: number;
  sent: number;
  failed: number;
}> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const due = await store.findAgentsDueForDigest(cutoff);
  let sent = 0;
  let failed = 0;
  for (const d of due) {
    try {
      const user = await store.user(d.userId);
      // Resolve agentId → agent.name from the user snapshot. Falls back to
      // the id itself when the agent has been deleted between the SELECT and
      // here (race window is small).
      const agentName = user.agents.find((a) => a.id === d.agentId)?.name ?? d.agentId;
      const result = await sendEmail(user.email, 'digest', {
        agentName,
        spentUsd: d.spentUsd,
        topEndpoint: d.topEndpoint,
      });
      if (!result.ok) {
        failed += 1;
        log.warn(
          { agentId: d.agentId, userId: d.userId, reason: result.reason },
          'digest-sender: send failed',
        );
        continue;
      }
      await store.recordAgentDigestSent(d.agentId, d.spentUsd);
      sent += 1;
    } catch (e) {
      failed += 1;
      log.error(
        { agentId: d.agentId, userId: d.userId, err: e instanceof Error ? e.message : String(e) },
        'digest-sender: dispatch failed',
      );
    }
  }
  return { due: due.length, sent, failed };
}

export async function startDigestSender(): Promise<void> {
  const connection = makeConnectionOpts();
  if (!connection) {
    log.info('digest-sender: redis unavailable, use POST /admin/dispatch-digests');
    return;
  }
  digestSenderQueue = new Queue(QUEUE_NAME, { connection });
  await digestSenderQueue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: { age: 60 * 60 * 24 * 7 } } },
  );
  worker = new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      const result = await sweepDigests();
      workerHeartbeat.set({ worker: 'digest-sender' }, Date.now() / 1000);
      log.info(result, 'digest-sender: sweep complete');
      return result;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'digest-sender: job failed'),
  );
  log.info('digest-sender: worker started');
}

export async function stopDigestSender(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (digestSenderQueue) {
    await digestSenderQueue.close();
    digestSenderQueue = null;
  }
}

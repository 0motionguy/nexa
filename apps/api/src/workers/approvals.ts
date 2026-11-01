/**
 * Agent-approval queue worker.
 *
 * Persists "agent wants to spend X" requests so the human can approve/decline
 * in the app. When REDIS_URL is unset, the queue degrades to inline execution
 * (the request is logged directly as activity, no separate worker process).
 *
 * Queue: agent-approvals
 * Job types:
 *   - agent-transfer-request: {userId, agentId, amountUsd, reason}
 */

import { Queue, Worker, type Job } from 'bullmq';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';
import { store } from '../store/index.js';
import { workerHeartbeat } from '../lib/metrics.js';
import { makeRedis, RedisKeys, type RedisClient } from '../lib/redis.js';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '../lib/health.js';
import { makeConnectionOpts } from './connection.js';

export interface AgentTransferRequest {
  userId: string;
  agentId: string;
  amountUsd: number;
  reason: string;
}

const QUEUE_NAME = 'agent-approvals';

// Avoid pinning the Queue/Worker generics — bullmq's heavy generic surface is
// painful to spell out at TypeScript level. We type just our handler payload.
// Exported so the standalone scheduler can read job counts for the
// bullmq_queue_depth gauge without duplicating the queue reference.
export let approvalsQueue: Queue | null = null;
let worker: Worker | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatRedis: RedisClient | null = null;

/**
 * W2-A — cross-process liveness beacon. /health/money (api process) reads
 * `nb:worker_heartbeat:approvals`; a wedged worker loop or a dead Redis
 * write path surfaces as a missing/stale heartbeat within
 * WORKER_HEARTBEAT_MAX_AGE_SECONDS. Best-effort: a beat failure logs at
 * warn and never crashes the worker.
 */
function startWorkerHeartbeat(): void {
  heartbeatRedis = makeRedis(env.REDIS_URL);
  if (!heartbeatRedis) return;
  const key = RedisKeys.workerHeartbeat('approvals');
  const beat = (): void => {
    void heartbeatRedis
      ?.set(key, String(Date.now()), 'EX', WORKER_HEARTBEAT_TTL_SECONDS)
      .catch((e: Error) => log.warn({ err: e.message }, 'approvals: heartbeat write failed'));
  };
  beat();
  const timer = setInterval(beat, WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  heartbeatTimer = timer;
}

export async function enqueueApproval(req: AgentTransferRequest): Promise<{ id: string }> {
  if (!approvalsQueue) {
    // Inline degradation: log as activity directly so the human still sees it.
    const user = await store.user(req.userId);
    const agent = await store.agent(user, req.agentId);
    const activity = await store.pushActivity(user, {
      n: `Wants $${req.amountUsd.toFixed(2)} · ${agent.name}`,
      s: `${req.reason.toUpperCase()} · NEEDS YOUR OK`,
      k: 'agent',
      a: '$' + req.amountUsd.toFixed(2),
    });
    return { id: activity.id };
  }
  const job = await approvalsQueue.add('agent-transfer-request', req, {
    removeOnComplete: { age: 60 * 60 * 24 * 7 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  });
  return { id: job.id ?? 'unknown' };
}

export async function startApprovalWorker(): Promise<void> {
  const connection = makeConnectionOpts();
  if (!connection) {
    log.info('approvals: redis unavailable, worker disabled');
    return;
  }
  approvalsQueue = new Queue(QUEUE_NAME, { connection });
  worker = new Worker(
    QUEUE_NAME,
    async (job: Job<AgentTransferRequest>) => {
      const { userId, agentId, amountUsd, reason } = job.data;
      const user = await store.user(userId);
      const agent = await store.agent(user, agentId);
      // Log the request as pending activity (the human acts via /agent/approvals/:id/decide).
      await store.pushActivity(user, {
        n: `Wants $${amountUsd.toFixed(2)} · ${agent.name}`,
        s: `${reason.toUpperCase()} · NEEDS YOUR OK`,
        k: 'agent',
        a: '$' + amountUsd.toFixed(2),
      });
      return { agentId, amountUsd };
    },
    { connection, concurrency: 4 },
  );
  worker.on('completed', (job) => {
    workerHeartbeat.set({ worker: 'approvals' }, Date.now() / 1000);
    log.info({ jobId: job.id }, 'approvals: processed');
  });
  worker.on('failed', (job, err) => log.error({ jobId: job?.id, err: err.message }, 'approvals: failed'));
  startWorkerHeartbeat();
  log.info('approvals: worker started');
}

export async function stopApprovalWorker(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (heartbeatRedis) {
    try {
      await heartbeatRedis.quit();
    } catch {
      // quit() rejects when the connection never established; disposal only.
    }
    heartbeatRedis = null;
  }
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (approvalsQueue) {
    await approvalsQueue.close();
    approvalsQueue = null;
  }
}

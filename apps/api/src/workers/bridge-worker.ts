/**
 * Bridge worker — CCTP transfer state machine (Sprint 19).
 *
 * Each `nb_transfers` row advances through:
 *   created → burning → attesting → minting → depositing → complete | failed
 *
 * One BullMQ job per state transition; the worker re-enqueues itself with a
 * status-appropriate delay so the queue never blocks on Circle Iris polling.
 *
 * Job: `bridge-transfer.progress { transferId }`
 *
 * Why a worker instead of inline in the route:
 *   1. Circle's attestation takes 60-120s on Arbitrum → Polygon. Holding an
 *      HTTP connection for that long would burn route capacity.
 *   2. The mint leg is a SECOND on-chain tx that must wait for the attestation.
 *      A single-shot route can't pause mid-execution.
 *   3. If the API process restarts mid-flight, listMidFlight() on boot
 *      re-enqueues every in-progress transfer so nothing strands.
 *
 * Mayan / Socket / LI.FI single-shot bridges DO NOT run through this worker —
 * those return a tx hash immediately from their respective routes. CCTP is the
 * only rail that needs the multi-step state machine today.
 *
 * Queue: bridge-transfer
 * Concurrency: 4 (one transfer per worker slot; each is mostly I/O-bound).
 * On Redis-less environments, the queue is not started; /transfers/internal
 * still creates the row but transfers stay in `created` until Redis comes back.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { log } from '../lib/log.js';
import { captureMessage } from '../lib/sentry.js';
import { bridgeTransfersByStatus, workerHeartbeat } from '../lib/metrics.js';
import { makeConnectionOpts } from './connection.js';
import { transferStore, type Transfer, type TransferPatch } from '../store/transfers.js';
import {
  executeCctpBurn,
  executeCctpMint,
  executeCctpV2Burn,
  extractMessageFromBurnReceipt,
  fetchCctpAttestation,
  fetchCctpV2Message,
  CCTP_DOMAIN,
} from '../lib/chain/cctp.js';
import { executor } from '../lib/chain/alchemy.js';
import {
  executeHlBridge2Deposit,
  getHlBridgeDepositStatus,
  HL_MIN_DEPOSIT_USDC_ATOMS,
  HL_WITHDRAW_FEE_USD,
} from '../lib/chain/hl-bridge.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import { getUsdcEvmBalance } from '../lib/chain/balances.js';
import { fetchMayanQuote, executeMayanSwap, type MayanChain } from '../lib/chain/mayan.js';
import { walletService } from '../lib/chain/wallet.js';
import { CHAIN_IDS, type Chain } from '../lib/bridge-router.js';
import { env } from '../lib/env.js';
import type { Hex } from 'viem';

/**
 * NEO bridge skim — resolve treasury address for a source chain. Returns null
 * when no treasury is configured for that chain (skim is then skipped cleanly).
 * Keyed on the source chain since the fee is taken from the user's USDC on the
 * SOURCE side, before the bridge burn.
 */
function resolveBridgeTreasury(srcChain: string): Hex | null {
  const map: Record<string, string | undefined> = {
    arbitrum: env.NEO_BRIDGE_TREASURY_ARB,
    polygon: env.NEO_BRIDGE_TREASURY_POL,
    base: env.NEO_BRIDGE_TREASURY_BASE,
    solana: env.NEO_BRIDGE_TREASURY_SOL,
  };
  const raw = map[srcChain]?.trim();
  if (!raw) return null;
  // EVM source chains require a 0x-prefixed 20-byte address. Solana source
  // doesn't run through this CCTP path (uses Mayan), but we still skip
  // gracefully if the value isn't EVM-shaped.
  if (!raw.startsWith('0x') || raw.length !== 42) return null;
  return raw as Hex;
}

const QUEUE_NAME = 'bridge-transfer';
const JOB_NAME = 'progress';

/** Delays between status polls. Tuned for CCTP V1 typical finality. */
const DELAY = {
  burnConfirm: 10_000, // 10s — Arbitrum/Polygon block times are sub-second; conf takes ~5-15s
  attestationPoll: 30_000, // 30s — Iris typically signs in 60-120s
  mintImmediate: 0, // Mint as soon as the attestation lands
  mintConfirm: 10_000,
} as const;

/** Soft cap on attestation polls per job-re-enqueue chain — ~25 min. */
const MAX_ATTESTATION_ATTEMPTS = 50;

/**
 * Deterministic jitter so 10 simultaneous transfers don't all hit Iris on the
 * same second. No Math.random (the harness blocks it). Module-level counter
 * cycles through 0-9; multiply by 200ms = 0-1.8s spread on top of the base.
 */
let jitterCounter = 0;
function jitter(): number {
  return (jitterCounter++ % 10) * 200;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errorObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function markReconciliationRequired(
  transfer: Pick<Transfer, 'id' | 'rail' | 'status'>,
  error: Record<string, unknown>,
  patch: Omit<TransferPatch, 'error'> = {},
): Promise<void> {
  const payload: Record<string, unknown> = { ...error, reconciliationRequired: true };
  try {
    await transferStore.update(transfer.id, { ...patch, error: payload });
    try {
      await transferStore.appendEvent(transfer.id, 'reconciliation_required', payload);
    } catch (e) {
      log.warn(
        { transferId: transfer.id, err: messageOf(e) },
        'bridge-worker: failed to append reconciliation_required event',
      );
    }
  } catch (e) {
    log.error(
      { transferId: transfer.id, err: messageOf(e), error: payload },
      'bridge-worker: failed to persist reconciliation requirement',
    );
  }
  captureMessage('bridge_transfer_reconciliation_required', {
    level: 'fatal',
    tags: {
      transferId: transfer.id,
      code: String(payload['code'] ?? 'unknown'),
      rail: transfer.rail,
      status: transfer.status,
    },
    extra: payload,
  });
}

export let bridgeTransferQueue: Queue | null = null;
let worker: Worker | null = null;

interface JobData {
  transferId: string;
  /** Counter for attestation polls; ignored for other states. */
  attestationAttempts?: number;
}

/**
 * Lazy-init a Queue handle. The API process needs it to enqueue without
 * starting a Worker; the scheduler process needs it AND the Worker. Both call
 * sites use this; idempotent.
 */
function ensureQueue(): Queue | null {
  if (bridgeTransferQueue) return bridgeTransferQueue;
  const connection = makeConnectionOpts();
  if (!connection) return null;
  bridgeTransferQueue = new Queue(QUEUE_NAME, { connection });
  return bridgeTransferQueue;
}

/**
 * F095 Sprint 18 — Refresh the `bridge_transfers_by_status` Prometheus gauge
 * by grouping the nb_transfers table by (status, rail, bucket). Called on
 * worker boot and via the 30-second interval below so operators see
 * stuck-row pile-ups in Grafana without hitting the DB by hand.
 *
 * Best-effort: a failed refresh logs warn but does not block the worker. The
 * gauge stays at its last sampled value until the next tick.
 */
async function refreshBridgeTransferGauge(): Promise<void> {
  try {
    const rows = await transferStore.countByStatus();
    // Reset before applying so labels that dropped to zero (e.g. all `created`
    // transfers progressed) actually disappear from the surface.
    bridgeTransfersByStatus.reset();
    for (const row of rows) {
      bridgeTransfersByStatus.set(
        { status: row.status, rail: row.rail, bucket: row.bucket },
        row.count,
      );
    }
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'bridge-worker: bridge_transfers_by_status refresh failed',
    );
  }
}

let gaugeRefreshTimer: NodeJS.Timeout | null = null;

export async function startBridgeWorker(): Promise<void> {
  const q = ensureQueue();
  if (!q) {
    log.info('bridge-worker: redis unavailable, transfers will stay in created until Redis comes back');
    return;
  }
  const connection = makeConnectionOpts();
  if (!connection) return;
  worker = new Worker<JobData>(
    QUEUE_NAME,
    async (job: Job<JobData>) => {
      await advanceTransfer(job.data.transferId, job.data.attestationAttempts ?? 0);
      workerHeartbeat.set({ worker: 'bridge-transfer' }, Date.now() / 1000);
    },
    { connection, concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    log.error(
      { jobId: job?.id, transferId: job?.data?.transferId, err: err.message },
      'bridge-worker: job failed',
    ),
  );
  log.info('bridge-worker: started');

  // On boot, re-enqueue any transfer that was mid-flight when the worker died.
  // Parallel — a fleet of 1000 orphans shouldn't take 1000 serial round-trips.
  // BullMQ's jobId dedup (see enqueueTransferProgress) makes this idempotent.
  try {
    const orphans = await transferStore.listMidFlight();
    if (orphans.length > 0) {
      await Promise.all(orphans.map((t) => enqueueTransferProgress(t.id, 0, 0, true)));
      log.info({ count: orphans.length }, 'bridge-worker: re-enqueued mid-flight transfers');
    }
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'bridge-worker: orphan scan failed',
    );
  }

  // F095 — initial gauge refresh + 30s interval. Single timer per process; the
  // shutdown path (stopBridgeWorker) clears it.
  await refreshBridgeTransferGauge();
  if (!gaugeRefreshTimer) {
    gaugeRefreshTimer = setInterval(() => {
      void refreshBridgeTransferGauge();
    }, 30_000);
    // Don't keep the process alive just for the gauge refresh.
    gaugeRefreshTimer.unref?.();
  }
}

export async function stopBridgeWorker(): Promise<void> {
  if (gaugeRefreshTimer) {
    clearInterval(gaugeRefreshTimer);
    gaugeRefreshTimer = null;
  }
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (bridgeTransferQueue) {
    await bridgeTransferQueue.close();
    bridgeTransferQueue = null;
  }
}

/**
 * Enqueue a transfer for the next state-machine tick. Called by the
 * /transfers/internal route after creating the row, and by the worker itself
 * to advance between states.
 *
 * Lazy-creates the queue handle if it doesn't exist yet, so the API process
 * (which doesn't run a Worker) can still produce jobs. Both processes share
 * the same Redis-backed queue.
 *
 * `jobId` is derived from (transferId, attestationAttempts) so duplicate
 * enqueues for the same state are no-ops at the BullMQ layer — protects
 * against the orphan-scan-on-boot + worker-self-re-enqueue race.
 */
export async function enqueueTransferProgress(
  transferId: string,
  delayMs = 0,
  attestationAttempts = 0,
  dedupe = false,
): Promise<void> {
  const q = ensureQueue();
  if (!q) {
    log.warn({ transferId }, 'bridge-worker: redis unavailable — transfer will not progress');
    return;
  }
  // Stable jobId per (transfer, attestation-attempt-counter). BullMQ ignores
  // an add() whose jobId already exists in the queue's active/wait/delayed
  // set — gives us free idempotency without a separate dedup table.
  const jobId = dedupe ? `tr:${transferId}:kick` : undefined;
  await q.add(
    JOB_NAME,
    { transferId, attestationAttempts },
    {
      ...(jobId ? { jobId } : {}),
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  );
}

/* ── State machine ───────────────────────────────────────────────────────── */

async function advanceTransfer(transferId: string, attestationAttempts: number): Promise<void> {
  const t = await transferStore.get(transferId);
  if (!t) {
    log.warn({ transferId }, 'bridge-worker: transfer not found');
    return;
  }
  try {
    // F101 — perps-source outbound hop is rail-agnostic: funds sit on HL L1
    // and must reach the Arbitrum EOA (withdraw3) before ANY burn/swap can
    // spend them. Runs ahead of the per-rail branches (cctp AND mayan legs).
    if (t.status === 'hl_withdrawing') {
      await advanceHlWithdrawing(t);
      return;
    }
    if (t.rail === 'mayan') {
      // Mayan completes in one shot — quote + execute + mark done (source-tx
      // broadcast is treated as success; destination relay is Mayan's job).
      if (t.status === 'created') await advanceMayanCreated(t);
      if (t.status === 'burning') await advanceMayanBurning(t);
      return;
    }
    if (t.rail === 'internal') {
      // P1: external sends share the 'internal' rail (same-chain base→base
      // ERC20, no bridge hop) but are route-owned provider dispatches — a row
      // still 'created' here means the submit outcome is UNKNOWN (write-ahead
      // src_call_id persisted, then crash/timeout/submittedUnknown, then the
      // boot orphan scan re-enqueued it after a worker restart). Blind-
      // completing would assert money moved with zero on-chain evidence; it
      // may equally never have left the wallet — that's the point: unknown.
      // Same refusal for ANY row carrying a dispatch handle: a genuine bucket
      // relabel never has one. Leave the row pending under its reconciliation
      // handle — the route/ops own resolution via the write-ahead key.
      if (t.toBucket === 'external' || t.srcCallId != null) {
        log.warn(
          { transferId: t.id, toBucket: t.toBucket, srcCallId: t.srcCallId ?? null },
          'bridge-worker: refusing auto-complete of dispatched internal-rail row (unknown outcome, needs reconciliation)',
        );
        return;
      }
      // Same-chain bucket move — no on-chain hop. Mark complete immediately.
      if (t.status === 'created') {
        await transferStore.update(t.id, { status: 'complete' });
        await transferStore.appendEvent(t.id, 'state_change', {
          from: 'created',
          to: 'complete',
          rail: 'internal',
        });
      }
      return;
    }
    if (t.rail !== 'cctp') {
      log.debug({ transferId, rail: t.rail }, 'bridge-worker: unsupported rail, ignoring');
      return;
    }
    switch (t.status) {
      case 'created':
        await advanceCreated(t);
        return;
      case 'burning':
        await advanceBurning(t);
        return;
      case 'attesting':
        await advanceAttesting(t, attestationAttempts);
        return;
      case 'minting':
        await advanceMinting(t);
        return;
      case 'depositing':
        await advanceDepositing(t);
        return;
      case 'hl_depositing':
        await advanceHlDepositing(t);
        return;
      case 'complete':
      case 'failed':
        return; // terminal; nothing to do
    }
  } catch (e) {
    const err = e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) };
    log.error({ transferId, status: t.status, err: err.message }, 'bridge-worker: state advance threw');
    await failTransfer(t.id, { code: 'worker_exception', message: err.message });
  }
}

async function advanceCreated(t: Transfer): Promise<void> {
  const claimed = await transferStore.claimCreated(t.id);
  if (!claimed) return;

  // Resolve the destination mint recipient — for EVM destinations this is the
  // user's Privy EVM wallet address (same across all EVM chains).
  const wallet = await walletService.getOrCreateUserWallet(claimed.userId, null);

  // NEO bridge skim — when feesUsd was set at /transfers/internal time AND the
  // source-chain treasury is configured, atomically prepend a USDC.transfer to
  // the treasury into the same EIP-7702 batch as the CCTP approve+burn. One
  // signature, one tx, atomic (transfer + burn succeed together or fail
  // together). Falls back to a fee-free burn when either signal is missing.
  let feeSkim: { treasury: Hex; feeAtoms: bigint } | undefined;
  if (claimed.feesUsd > 0) {
    const treasury = resolveBridgeTreasury(claimed.fromChain);
    if (treasury) {
      const feeAtoms = BigInt(Math.round(claimed.feesUsd * 1_000_000));
      if (feeAtoms > 0n) {
        feeSkim = { treasury, feeAtoms };
        log.info(
          { transferId: claimed.id, treasury, feeAtoms: feeAtoms.toString(), srcChain: claimed.fromChain },
          'bridge-worker: cctp skim batched',
        );
      }
    } else {
      log.warn(
        { transferId: claimed.id, srcChain: claimed.fromChain, feesUsd: claimed.feesUsd },
        'bridge-worker: feesUsd set but treasury unconfigured — skim SKIPPED',
      );
    }
  }

  // F085 — deterministic idempotency key per (transfer, FSM-stage). Retried
  // worker ticks pass the same key, so Alchemy edge dedup (Idempotency-Key
  // header + JSON-RPC id) protects against double-submission of the prepared
  // userop in addition to the worker-level state-guard.
  // ADR-0005 — CCTP_V2 routes NEW burns through TokenMessengerV2 (Fast
  // Transfer when a fee quote succeeds, Standard otherwise). The version is
  // persisted on the row below so attest/mint follow the burn's protocol
  // even if the flag flips mid-flight.
  const cctpVersion = env.CCTP_V2 ? 2 : 1;
  const burnInput = {
    userId: claimed.userId,
    srcChain: claimed.fromChain as Chain,
    dstChain: claimed.toChain as Chain,
    amountAtoms: BigInt(claimed.amountTokenAtoms),
    mintRecipientAddress: wallet.address,
    idempotencyKey: `${claimed.id}:burn`,
    ...(feeSkim ? { feeSkim } : {}),
  };
  const result = cctpVersion === 2 ? await executeCctpV2Burn(burnInput) : await executeCctpBurn(burnInput);
  if (!result) {
    await failTransfer(claimed.id, { code: 'burn_not_executable', message: 'CCTP route unsupported' });
    return;
  }
  if (result.failed) {
    // Live signing was configured but failed — a real error (e.g. the wallet
    // has no authorized server signer), NOT a demo. Surface it actionably.
    await failTransfer(claimed.id, {
      code: result.failureCode ?? 'server_signing_unavailable',
      message: 'Signing is unavailable for this wallet — server signer not authorized.',
    });
    return;
  }
  if (result.demo) {
    if (result.submittedUnknown) {
      await markReconciliationRequired(claimed, {
        code: 'burn_submit_unknown',
        message: 'CCTP burn submission reached an unknown provider state.',
      });
      return;
    }
    await failTransfer(claimed.id, { code: 'burn_not_live', message: 'CCTP burn did not submit live' });
    return;
  }
  try {
    await transferStore.update(claimed.id, { srcCallId: result.callId, cctpVersion });
    await transferStore.appendEvent(claimed.id, 'state_change', {
      from: 'created',
      to: 'burning',
      callId: result.callId,
      demo: result.demo,
      cctpVersion,
      ...(cctpVersion === 2 && 'mode' in result ? { cctpV2Mode: result.mode } : {}),
    });
    await enqueueTransferProgress(claimed.id, DELAY.burnConfirm);
  } catch (e) {
    await markReconciliationRequired(
      claimed,
      {
        code: 'burn_submit_persistence_failed',
        message: messageOf(e),
        callId: result.callId,
      },
      { srcCallId: result.callId, cctpVersion },
    );
  }
}

async function advanceBurning(t: Transfer): Promise<void> {
  if (!t.srcCallId) {
    await markReconciliationRequired(t, {
      code: 'missing_src_call_id',
      message: 'Transfer reached burning without a persisted source call id; manual reconciliation required.',
    });
    return;
  }
  const snap = await executor.getCallStatus(t.srcCallId, CHAIN_IDS[t.fromChain as Chain]);
  if (snap.status === 'PENDING') {
    await enqueueTransferProgress(t.id, DELAY.burnConfirm + jitter());
    return;
  }
  if (snap.status === 'FAILED') {
    await failTransfer(t.id, { code: 'burn_failed', message: snap.error });
    return;
  }
  // ADR-0005 — V2 attestation is keyed by the burn TX HASH via the iris /v2
  // endpoint; no MessageSent log extraction needed (message bytes arrive with
  // the attestation). Advance straight to attesting with the tx hash.
  if (t.cctpVersion === 2) {
    if (!snap.txHash) {
      await markReconciliationRequired(t, {
        code: 'burn_confirmed_without_txhash',
        message: 'CCTP V2 burn confirmed but no tx hash surfaced; attestation cannot be keyed.',
      });
      return;
    }
    await transferStore.update(t.id, { status: 'attesting', srcTxHash: snap.txHash });
    await transferStore.appendEvent(t.id, 'state_change', {
      from: 'burning',
      to: 'attesting',
      txHash: snap.txHash,
      cctpVersion: 2,
    });
    await enqueueTransferProgress(t.id, DELAY.attestationPoll + jitter());
    return;
  }
  // CONFIRMED — extract the MessageSent log from the receipt.
  const extraction = extractMessageFromBurnReceipt(t.fromChain as Chain, snap.receipt);
  if (!extraction) {
    // No MessageSent log → either the depositForBurn reverted silently, or
    // we're in demo mode (receipt has no logs). For demo mode, synthesize a
    // throw-away message + hash so the rest of the machine can advance.
    if (snap.demo) {
      const demoMessage = ('0x' + '00'.repeat(32)) as `0x${string}`;
      const demoHash = ('0x' + '00'.repeat(32)) as `0x${string}`;
      await transferStore.update(t.id, {
        status: 'attesting',
        srcTxHash: snap.txHash,
        cctpMessageBody: demoMessage,
        cctpMessageHash: demoHash,
      });
      await transferStore.appendEvent(t.id, 'state_change', {
        from: 'burning',
        to: 'attesting',
        demo: true,
      });
      await enqueueTransferProgress(t.id, DELAY.attestationPoll + jitter());
      return;
    }
    await failTransfer(t.id, { code: 'message_not_found', txHash: snap.txHash });
    return;
  }
  await transferStore.update(t.id, {
    status: 'attesting',
    srcTxHash: snap.txHash,
    cctpMessageBody: extraction.messageBody,
    cctpMessageHash: extraction.messageHash,
  });
  await transferStore.appendEvent(t.id, 'state_change', {
    from: 'burning',
    to: 'attesting',
    txHash: snap.txHash,
    messageHash: extraction.messageHash,
  });
  await enqueueTransferProgress(t.id, DELAY.attestationPoll + jitter());
}

async function advanceAttesting(t: Transfer, attempts: number): Promise<void> {
  const isV2 = t.cctpVersion === 2;
  // V1 keys the attestation by message hash (receipt log); V2 by burn tx
  // hash. Each version fails actionably on its own missing key.
  if (!isV2 && !t.cctpMessageHash) {
    await failTransfer(t.id, { code: 'missing_message_hash' });
    return;
  }
  if (isV2 && !t.srcTxHash) {
    await failTransfer(t.id, { code: 'missing_src_tx_hash' });
    return;
  }
  if (attempts >= MAX_ATTESTATION_ATTEMPTS) {
    await failTransfer(t.id, {
      code: 'attestation_timeout',
      attempts,
      maxAttempts: MAX_ATTESTATION_ATTEMPTS,
    });
    return;
  }
  // Demo path — synthesize the attestation so the machine advances.
  if (t.srcTxHash?.startsWith('0xdemo')) {
    await transferStore.update(t.id, {
      status: 'minting',
      cctpAttestation: ('0x' + '00'.repeat(65)) as string,
    });
    await transferStore.appendEvent(t.id, 'state_change', {
      from: 'attesting',
      to: 'minting',
      demo: true,
    });
    await enqueueTransferProgress(t.id, DELAY.mintImmediate);
    return;
  }
  const srcDomain = CCTP_DOMAIN[t.fromChain as Chain];
  if (isV2 && srcDomain === undefined) {
    await failTransfer(t.id, { code: 'missing_source_domain' });
    return;
  }
  const att = isV2
    ? await fetchCctpV2Message(srcDomain as number, t.srcTxHash as string)
    : await fetchCctpAttestation(t.cctpMessageHash as `0x${string}`);
  await transferStore.appendEvent(t.id, 'attestation_poll', {
    attempt: attempts + 1,
    status: att.status,
  });
  if (att.status === 'pending') {
    await enqueueTransferProgress(t.id, DELAY.attestationPoll + jitter(), attempts + 1);
    return;
  }
  if (att.status === 'failed') {
    await failTransfer(t.id, { code: 'attestation_failed' });
    return;
  }
  // complete
  await transferStore.update(t.id, {
    status: 'minting',
    cctpAttestation: att.attestation ?? null,
    // The message bytes are echoed back by Iris — if we missed them from the
    // receipt parse for some reason, this is the second chance.
    ...(att.message && !t.cctpMessageBody ? { cctpMessageBody: att.message } : {}),
  });
  await transferStore.appendEvent(t.id, 'state_change', {
    from: 'attesting',
    to: 'minting',
  });
  await enqueueTransferProgress(t.id, DELAY.mintImmediate);
}

async function advanceMinting(t: Transfer): Promise<void> {
  if (!t.cctpMessageBody || !t.cctpAttestation) {
    await failTransfer(t.id, { code: 'missing_mint_inputs' });
    return;
  }
  const result = await executeCctpMint({
    userId: t.userId,
    dstChain: t.toChain as Chain,
    message: t.cctpMessageBody as `0x${string}`,
    attestation: t.cctpAttestation as `0x${string}`,
    idempotencyKey: `${t.id}:mint`,
    // ADR-0005 — mint on the transmitter matching the burn's protocol version.
    version: t.cctpVersion === 2 ? 2 : 1,
  });
  if (!result) {
    await failTransfer(t.id, { code: 'mint_not_executable' });
    return;
  }
  if (result.demo) {
    if (result.submittedUnknown) {
      await markReconciliationRequired(t, {
        code: 'mint_submit_unknown',
        message: 'CCTP mint submission reached an unknown provider state.',
      });
      return;
    }
    await failTransfer(t.id, { code: 'mint_not_live', message: 'CCTP mint did not submit live' });
    return;
  }
  try {
    await transferStore.update(t.id, { status: 'depositing', dstCallId: result.callId });
    await transferStore.appendEvent(t.id, 'state_change', {
      from: 'minting',
      to: 'depositing',
      callId: result.callId,
      demo: result.demo,
    });
    await enqueueTransferProgress(t.id, DELAY.mintConfirm + jitter());
  } catch (e) {
    await markReconciliationRequired(
      t,
      {
        code: 'mint_submit_persistence_failed',
        message: messageOf(e),
        callId: result.callId,
      },
      { status: 'depositing', dstCallId: result.callId },
    );
  }
}

async function advanceDepositing(t: Transfer): Promise<void> {
  if (!t.dstCallId) {
    await markReconciliationRequired(t, { code: 'missing_dst_call_id' });
    return;
  }
  const snap = await executor.getCallStatus(t.dstCallId, CHAIN_IDS[t.toChain as Chain]);
  if (snap.status === 'PENDING') {
    await enqueueTransferProgress(t.id, DELAY.mintConfirm + jitter());
    return;
  }
  if (snap.status === 'FAILED') {
    await failTransfer(t.id, { code: 'mint_failed', message: snap.error });
    return;
  }
  // CONFIRMED — bucket-specific deposit hop.
  //   perps       → USDC now sits on Arbitrum; advance to hl_depositing for
  //                 the HL Bridge2 hop that pushes it into HL L1 balance.
  //   predictions → Polymarket reads USDC from the wallet directly; complete.
  //   memes       → SPL USDC landed via the (mint already done); complete.
  //   cash        → USDC on Base; complete.
  if (t.toBucket === 'perps') {
    await transferStore.update(t.id, { status: 'hl_depositing', dstTxHash: snap.txHash, dstCallId: null });
    await transferStore.appendEvent(t.id, 'state_change', {
      from: 'depositing',
      to: 'hl_depositing',
      cctpMintTxHash: snap.txHash,
    });
    await enqueueTransferProgress(t.id, DELAY.mintImmediate);
    return;
  }
  await transferStore.update(t.id, { status: 'complete', dstTxHash: snap.txHash });
  await transferStore.appendEvent(t.id, 'state_change', {
    from: 'depositing',
    to: 'complete',
    txHash: snap.txHash,
  });
}

/**
 * HL Bridge2 final-hop: USDC.transfer(BRIDGE2, amt) on Arbitrum → HL L1 credit.
 *
 * No new schema column — the deposit's callId is stored in the event log under
 * `hl_deposit_submitted.callId` and read back on each tick. First entry into
 * this state submits; subsequent ticks poll the submitted call.
 * The current implementation also persists the HL provider call id on
 * `dstCallId` after the CCTP mint call id has been confirmed and cleared.
 */
async function advanceHlDepositing(t: Transfer): Promise<void> {
  // Below HL's $5 floor → can't deposit; mark complete with a warn. Funds
  // are stranded on the user's Arbitrum wallet (still spendable, just not on HL).
  if (BigInt(t.amountTokenAtoms) < HL_MIN_DEPOSIT_USDC_ATOMS) {
    await transferStore.update(t.id, { status: 'complete' });
    await transferStore.appendEvent(t.id, 'state_change', {
      from: 'hl_depositing',
      to: 'complete',
      note: 'below_hl_minimum_skipped',
      amountAtoms: t.amountTokenAtoms,
    });
    return;
  }
  // Find any prior submission in the event log. If audit persistence failed
  // after submit, fall back to the row-level marker written with dstCallId.
  const events = await transferStore.listEvents(t.id);
  const submitted = events.find((e) => e.eventType === 'hl_deposit_submitted');
  const submittedPayload = submitted?.payload as { callId?: string } | null | undefined;
  const err = errorObject(t.error);
  const callId = submittedPayload?.callId
    ?? t.dstCallId
    ?? (err?.['code'] === 'hl_deposit_submit_persistence_failed' && typeof err['callId'] === 'string'
      ? err['callId']
      : null);
  if (!callId) {
    const result = await executeHlBridge2Deposit({
      userId: t.userId,
      amountAtoms: BigInt(t.amountTokenAtoms),
      idempotencyKey: `${t.id}:hl-deposit`,
    });
    if (!result) {
      await failTransfer(t.id, { code: 'hl_deposit_below_minimum' });
      return;
    }
    if (result.failed) {
      await failTransfer(t.id, {
        code: result.failureCode ?? 'server_signing_unavailable',
        message: 'Signing is unavailable for this wallet — server signer not authorized.',
      });
      return;
    }
    if (result.demo) {
      if (result.submittedUnknown) {
        await markReconciliationRequired(t, {
          code: 'hl_deposit_submit_unknown',
          message: 'HL Bridge2 submission reached an unknown provider state.',
        });
        return;
      }
      await failTransfer(t.id, { code: 'hl_deposit_not_live', message: 'HL Bridge2 deposit did not submit live' });
      return;
    }
    try {
      await transferStore.update(t.id, { dstCallId: result.callId });
      await transferStore.appendEvent(t.id, 'hl_deposit_submitted', {
        callId: result.callId,
        demo: result.demo,
      });
      await enqueueTransferProgress(t.id, DELAY.mintConfirm + jitter());
    } catch (e) {
      await markReconciliationRequired(
        t,
        {
          code: 'hl_deposit_submit_persistence_failed',
          message: messageOf(e),
          callId: result.callId,
        },
        { dstCallId: result.callId },
      );
    }
    return;
  }
  const snap = await getHlBridgeDepositStatus(callId);
  if (snap.status === 'PENDING') {
    await enqueueTransferProgress(t.id, DELAY.mintConfirm + jitter());
    return;
  }
  if (snap.status === 'FAILED') {
    await failTransfer(t.id, { code: 'hl_deposit_failed', message: snap.error });
    return;
  }
  // CONFIRMED — HL indexer credits L1 balance within ~1 block of this tx.
  await transferStore.update(t.id, { status: 'complete', error: null });
  await transferStore.appendEvent(t.id, 'state_change', {
    from: 'hl_depositing',
    to: 'complete',
    hlBridgeTxHash: snap.txHash,
  });
}

/** withdraw3 → EOA arrival typically lands in ~5 min; park after 45. */
const HL_WITHDRAW_TIMEOUT_MS = 45 * 60_000;

/**
 * F101 — HL outbound hop for perps-SOURCE transfers: withdraw3 moves USDC
 * from HL L1 to the user's own Arbitrum EOA (HL deducts a flat $1 fee,
 * Bridge2 pays out after ~5 min), after which the row advances to `created`
 * and the normal burn/swap path spends the arrived funds.
 *
 * withdraw3 is an off-chain HL exchange action (no tx hash / callId we can
 * poll on-chain), so arrival detection is a balance delta on the EOA: first
 * entry records `baselineUsd` + submits; subsequent ticks poll until
 * baseline + (amount - fee) shows up, then hand off to `created`.
 */
async function advanceHlWithdrawing(t: Transfer): Promise<void> {
  const events = await transferStore.listEvents(t.id);
  const submitted = events.find((e) => e.eventType === 'hl_withdraw_submitted');
  const wallet = await walletService.getOrCreateUserWallet(t.userId, null);
  if (!submitted) {
    // Baseline BEFORE submit — an RPC blip here just retries the whole entry
    // (nothing has been sent yet, so re-entry is safe).
    const baselineUsd = await getUsdcEvmBalance('arbitrum', wallet.address);
    if (baselineUsd == null) {
      await enqueueTransferProgress(t.id, DELAY.mintConfirm + jitter());
      return;
    }
    let result: Awaited<ReturnType<typeof hyperliquid.withdraw3>>;
    try {
      result = await hyperliquid.withdraw3({
        privyWalletId: wallet.live ? wallet.walletId : null,
        privyWalletAddress: wallet.live ? wallet.address : null,
        destination: wallet.address,
        amountUsd: t.amountUsd,
      });
    } catch (e) {
      // Hard reject (e.g. insufficient withdrawable) — funds untouched on HL;
      // fail actionably rather than retry-looping against the exchange.
      await failTransfer(t.id, { code: 'hl_withdraw_failed', message: messageOf(e) });
      return;
    }
    if (result.demo) {
      // Mirror of the burn stage's `burn_not_live` — never fake progress on a
      // money path. Funds remain on HL L1, fully tradable.
      await failTransfer(t.id, {
        code: 'hl_withdraw_not_live',
        message: 'HL withdraw3 did not submit live — funds remain on HL L1.',
      });
      return;
    }
    try {
      await transferStore.appendEvent(t.id, 'hl_withdraw_submitted', {
        callId: result.callId,
        baselineUsd,
        submittedAtMs: Date.now(),
      });
      await enqueueTransferProgress(t.id, DELAY.mintConfirm + jitter());
    } catch (e) {
      // Submission went out but the marker didn't persist — re-entry would
      // double-withdraw, so park for manual reconciliation (funds safe).
      await markReconciliationRequired(t, {
        code: 'hl_withdraw_submit_persistence_failed',
        message: messageOf(e),
        callId: result.callId,
      });
    }
    return;
  }
  const payload = submitted.payload as { baselineUsd?: number; submittedAtMs?: number } | null;
  const expectedUsd = t.amountUsd - HL_WITHDRAW_FEE_USD;
  const balanceUsd = await getUsdcEvmBalance('arbitrum', wallet.address);
  // 2¢ dust tolerance on the delta — covers float rounding, NOT the $1 fee.
  if (
    balanceUsd != null &&
    typeof payload?.baselineUsd === 'number' &&
    balanceUsd >= payload.baselineUsd + expectedUsd - 0.02
  ) {
    await transferStore.update(t.id, { status: 'created' });
    await transferStore.appendEvent(t.id, 'state_change', {
      from: 'hl_withdrawing',
      to: 'created',
      arrivedUsd: balanceUsd,
      hlWithdrawFeeUsd: HL_WITHDRAW_FEE_USD,
    });
    await enqueueTransferProgress(t.id, DELAY.mintImmediate);
    return;
  }
  const submittedAtMs = typeof payload?.submittedAtMs === 'number' ? payload.submittedAtMs : 0;
  if (Date.now() - submittedAtMs > HL_WITHDRAW_TIMEOUT_MS) {
    await markReconciliationRequired(t, {
      code: 'hl_withdraw_arrival_timeout',
      message: 'HL withdrawal not observed on the Arbitrum EOA within 45 min.',
    });
    return;
  }
  await enqueueTransferProgress(t.id, DELAY.mintConfirm + jitter());
}

/**
 * Mayan rail — single-shot Solana ↔ EVM USDC via Mayan Swift.
 *
 * One pass: build quote, execute (Privy sign + broadcast), mark complete on
 * source-tx-submitted. Mayan's relayers handle destination delivery in 3-5s;
 * client can poll the tracking URL for final state.
 *
 * Slippage cap 50 bps (0.5%). Mayan typically lands USDC↔USDC at <0.05%.
 */
async function advanceMayanCreated(t: Transfer): Promise<void> {
  const claimed = await transferStore.claimCreated(t.id);
  if (!claimed) return;
  const [evmWallet, solWallet] = await Promise.all([
    walletService.getOrCreateUserWallet(claimed.userId, null),
    walletService.getOrCreateUserSolanaWallet(claimed.userId, null),
  ]);
  const fromAddress = claimed.fromChain === 'solana' ? solWallet.address : evmWallet.address;
  const toAddress = claimed.toChain === 'solana' ? solWallet.address : evmWallet.address;
  const fromToken = usdcAddressFor(claimed.fromChain);
  const toToken = usdcAddressFor(claimed.toChain);
  if (!fromToken || !toToken) {
    await failTransfer(claimed.id, { code: 'mayan_token_address_missing' });
    return;
  }
  try {
    const quotes = await fetchMayanQuote({
      amountIn: claimed.amountUsd,
      fromToken,
      fromChain: claimed.fromChain as MayanChain,
      toToken,
      toChain: claimed.toChain as MayanChain,
      slippageBps: 50,
    });
    const quote = quotes[0];
    if (!quote) {
      await failTransfer(claimed.id, { code: 'mayan_no_route' });
      return;
    }
    // NEO bridge skim — Mayan's native referrer fee. Mayan picks the right
    // address based on swap direction; pass both EVM + Solana so a one-time
    // Mayan dashboard config covers every direction. Falls back cleanly
    // when neither is configured.
    const referrer = (() => {
      const sol = env.NEO_BRIDGE_TREASURY_SOL?.trim();
      const evm = (env.NEO_BRIDGE_TREASURY_BASE
        ?? env.NEO_BRIDGE_TREASURY_ARB
        ?? env.NEO_BRIDGE_TREASURY_POL)?.trim();
      if (!sol && !evm) return undefined;
      return {
        ...(sol ? { solana: sol } : {}),
        ...(evm ? { evm } : {}),
      };
    })();
    let result: Awaited<ReturnType<typeof executeMayanSwap>>;
    try {
      result = await executeMayanSwap({
        quote,
        fromAddress,
        toAddress,
        userId: claimed.userId,
        idempotencyKey: `${claimed.id}:mayan`,
        signSolanaTx: claimed.fromChain === 'solana'
          ? (msg: string) => solWallet.signTx(msg)
          : undefined,
        ...(referrer ? { referrer } : {}),
      });
    } catch (e) {
      await markReconciliationRequired(claimed, {
        code: 'mayan_submit_unknown',
        message: messageOf(e),
      });
      return;
    }
    if (result.status === 'unavailable') {
      await failTransfer(claimed.id, { code: 'mayan_unavailable', reason: result.reason });
      return;
    }
    // Source tx submitted; relayer delivers destination in ~3-5s. Mark
    // complete here — caller can show the trackingUrl for definitive state.
    try {
      await transferStore.update(claimed.id, {
        status: 'complete',
        srcTxHash: result.sourceTxId,
      });
      await transferStore.appendEvent(claimed.id, 'state_change', {
        from: 'burning',
        to: 'complete',
        rail: 'mayan',
        sourceTxId: result.sourceTxId,
        trackingUrl: result.trackingUrl,
        quoteType: quote.type,
        expectedOut: quote.expectedAmountOut,
      });
    } catch (e) {
      await markReconciliationRequired(
        claimed,
        {
          code: 'mayan_submit_persistence_failed',
          message: messageOf(e),
          sourceTxId: result.sourceTxId,
        },
        { status: 'complete', srcTxHash: result.sourceTxId },
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failTransfer(claimed.id, { code: 'mayan_exception', message: msg });
  }
}

async function advanceMayanBurning(t: Transfer): Promise<void> {
  if (t.srcTxHash) {
    await transferStore.update(t.id, { status: 'complete' });
    await transferStore.appendEvent(t.id, 'state_change', {
      from: 'burning',
      to: 'complete',
      rail: 'mayan',
      sourceTxId: t.srcTxHash,
      recovered: true,
    });
    return;
  }
  await markReconciliationRequired(t, {
    code: 'missing_mayan_source_tx',
    message: 'Mayan transfer reached submitting state without a persisted source tx; manual reconciliation required.',
  });
}

/** Resolve the USDC token address for a chain in Mayan-API shape. */
function usdcAddressFor(chain: string): string | null {
  switch (chain) {
    case 'arbitrum': return '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    case 'polygon': return '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
    case 'base': return '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    case 'optimism': return '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
    case 'solana': return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    default: return null;
  }
}

async function failTransfer(transferId: string, error: Record<string, unknown>): Promise<void> {
  await transferStore.update(transferId, { status: 'failed', error });
  await transferStore.appendEvent(transferId, 'error', error);
  log.warn({ transferId, error }, 'bridge-worker: transfer failed');

  // F086 Sprint 18 — operator-facing Sentry alert. Tags are sliceable in the
  // Sentry dashboard and routable by alert rules (Slack / PagerDuty). The
  // transfer fields (rail / bucket / amount) are loaded fresh — failTransfer
  // is called from several call sites, not all of which pass the full row.
  try {
    const t = await transferStore.get(transferId);
    const code = String(error['code'] ?? 'unknown');
    // Critical conditions deserve fatal-level so paging rules fire even when
    // Sentry has a default error-level mute on the project.
    const critical =
      code === 'attestation_timeout' ||
      code === 'burn_failed' ||
      code === 'mint_failed' ||
      (t ? Number(t.amountUsd) >= 1000 : false);
    captureMessage('bridge_transfer_failed', {
      level: critical ? 'fatal' : 'error',
      tags: {
        transferId,
        code,
        rail: t?.rail,
        fromBucket: t?.fromBucket,
        toBucket: t?.toBucket,
        fromChain: t?.fromChain,
        toChain: t?.toChain,
        highValue: t ? Number(t.amountUsd) >= 1000 : false,
      },
      extra: {
        amountUsd: t?.amountUsd,
        amountTokenAtoms: t?.amountTokenAtoms,
        srcCallId: t?.srcCallId,
        dstCallId: t?.dstCallId,
        userId: t?.userId,
        error,
      },
    });
  } catch (e) {
    // The alert path must never reduce the reliability of the fail path.
    log.warn(
      { err: e instanceof Error ? e.message : String(e), transferId },
      'bridge-worker: ops-alert capture failed',
    );
  }
}

/**
 * F090 — test-only surface for `failTransfer`. The function stays module-
 * private; this aliased export lets bridge-worker.spec.ts assert the F086
 * Sentry-capture wiring without exporting `failTransfer` to the production
 * import graph.
 */
export const __testFailTransfer = failTransfer;
export const __testAdvanceTransfer = (transferId: string, attestationAttempts = 0): Promise<void> =>
  advanceTransfer(transferId, attestationAttempts);

/**
 * /transfers/* + /balances — Portfolio settlement surface (Sprint 19).
 *
 *   GET  /balances                       — per-chain USDC balances aggregated by bucket
 *   POST /transfers/internal             — bucket → bucket cross-chain transfer
 *   GET  /transfers                      — list user's recent transfers
 *   GET  /transfers/:id                  — single transfer with state-machine events
 *   GET  /transfers/onramp/deposit-address?bucket=…  — Privy address by bucket
 *
 * Internal transfers create an `nb_transfers` row and immediately enqueue a
 * `bridge-transfer.progress` BullMQ job that drives the CCTP state machine
 * (see workers/bridge-worker.ts). The POST returns the transferId in <500ms;
 * the actual on-chain hops run async over ~90s for an Arbitrum↔Polygon hop.
 *
 * Round 1 rails:
 *   - cctp     → Arbitrum ↔ Polygon / Base / Optimism USDC (worker-driven)
 *   - mayan    → anything ↔ Solana USDC (route-driven, returns tx hash immediately)
 *   - internal → same-chain bucket move (no on-chain hop)
 *
 * Future rails (not in this round):
 *   - socket / lifi non-USDC fallback
 *   - hl_bridge for explicit HL Bridge2 deposit
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { base } from 'viem/chains';
import { requireSession } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { rateLimit } from '../lib/rate-limit.js';
import { liveMeta, providerDemoMeta } from '../lib/sourced.js';
import { env, features } from '../lib/env.js';
import { recordFee } from '../lib/fees.js';
import { walletService } from '../lib/chain/wallet.js';
import { readPortfolioBalances } from '../lib/chain/balances.js';
import { isCctpExecutable } from '../lib/chain/cctp.js';
import { executor } from '../lib/chain/alchemy.js';
import { ASSETS, usdToUsdcWei } from '../lib/chain/units.js';
import {
  HL_MIN_DEPOSIT_USDC_ATOMS,
  HL_MIN_WITHDRAW_USD,
  HL_WITHDRAW_FEE_USD,
  executeHlBridge2Deposit,
} from '../lib/chain/hl-bridge.js';
import { getUsdcEvmBalance, getUsdcSolanaBalance } from '../lib/chain/balances.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import {
  transferStore,
  type Transfer,
  type TransferBucket,
  type TransferChain,
  type TransferRail,
} from '../store/transfers.js';
import { enqueueTransferProgress } from '../workers/bridge-worker.js';
// Money-path wire contracts live in shared-zod so NEO/web build their
// payloads from the SAME schemas this route validates with (lockstep pass
// 2026-07-02 — no more silent field drift on money routes).
import {
  DepositAddressQuery,
  ExternalTransferInput,
  HlDepositInput,
  InternalTransferInput,
} from '@nexa/shared-zod';

/**
 * Two routers exported from this file:
 *   - balancesRoutes  → mount at /balances        (single GET /)
 *   - transfersRoutes → mount at /transfers       (POST /internal, GET /, GET /:id, GET /onramp/deposit-address)
 */
export const transfersRoutes = new Hono();
export const balancesRoutes = new Hono();

/**
 * P1 money-path (wave4): one per-user budget across ALL transfer POSTs
 * (internal + external + hl-deposit share it, so abuse can't fan out across
 * routes). 20/min is generous for legit bursts (auto-sweep + user actions)
 * while killing runaway client loops. Redis-backed cross-replica when
 * available; `RATE_LIMIT_ENABLED=false` short-circuits in the test suite.
 */
const transfersMoneyLimit = rateLimit({
  windowSeconds: 60,
  limit: 20,
  keyFn: (c) => (c.get('user') as { id?: string } | undefined)?.id ?? null,
  namespace: 'transfers-money',
});

/** Bucket → physical chain. `external` bucket means user-specified destination. */
const BUCKET_TO_CHAIN: Record<TransferBucket, TransferChain> = {
  perps: 'arbitrum',
  predictions: 'polygon',
  memes: 'solana',
  'stocks-spot': 'solana',
  cash: 'base',
  external: 'base',
};

/** Bucket → human-readable label for UI. */
const BUCKET_LABEL: Record<TransferBucket, string> = {
  perps: 'Perps · Arbitrum',
  predictions: 'Predictions · Polygon',
  memes: 'Memes · Solana',
  'stocks-spot': 'xStocks · Solana',
  cash: 'Cash · Base',
  external: 'External',
};

function pickRail(from: TransferChain, to: TransferChain): TransferRail {
  if (from === to) return 'internal';
  if (from === 'solana' || to === 'solana') return 'mayan';
  if (
    isCctpExecutable(from as Parameters<typeof isCctpExecutable>[0], to as Parameters<typeof isCctpExecutable>[1], 'USDC')
  ) {
    return 'cctp';
  }
  return 'socket';
}

function scopedTransferIdempotencyKey(scope: string, key: string): string {
  return `${scope}:${createHash('sha256').update(key).digest('hex')}`;
}

const ERC20_TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

function externalReplayDestination(events: Awaited<ReturnType<typeof transferStore.listEvents>>): string | null {
  const created = events.find((event) => event.eventType === 'created');
  const payload = created?.payload;
  return payload && typeof payload === 'object' && 'destinationAddress' in payload
    ? String((payload as { destinationAddress?: unknown }).destinationAddress)
    : null;
}

/* ── GET /balances ──────────────────────────────────────────────────────── */

balancesRoutes.get('/', requireSession, async (c) => {
  const u = c.get('user');
  // Resolve both wallets in parallel. In demo mode these return synthetic
  // base58/0x addresses; the balance reads will harmlessly return 0.
  const [evm, sol] = await Promise.all([
    walletService.getOrCreateUserWallet(u.id, null),
    walletService.getOrCreateUserSolanaWallet(u.id, null),
  ]);
  const balances = await readPortfolioBalances({
    evmAddress: evm.address,
    solanaAddress: sol.address,
  });
  return c.json({
    ok: true,
    ...balances,
    sourced: balances.live
      ? liveMeta('cctp', 'balances')
      : providerDemoMeta('cctp', 'balances'),
  });
});

/* ── GET /transfers/onramp/deposit-address ──────────────────────────────── */

transfersRoutes.get(
  '/onramp/deposit-address',
  requireSession,
  zValidator('query', DepositAddressQuery),
  async (c) => {
    const u = c.get('user');
    const { bucket } = c.req.valid('query');
    const chain = BUCKET_TO_CHAIN[bucket];
    const isSolana = chain === 'solana';
    const wallet = isSolana
      ? await walletService.getOrCreateUserSolanaWallet(u.id, null)
      : await walletService.getOrCreateUserWallet(u.id, null);
    return c.json({
      ok: true,
      bucket,
      bucketLabel: BUCKET_LABEL[bucket],
      chain,
      address: wallet.address,
      token: 'USDC',
      live: wallet.live,
      memo: null,
    });
  },
);

/* ── POST /transfers/internal ───────────────────────────────────────────── */

transfersRoutes.post(
  '/internal',
  requireSession,
  transfersMoneyLimit,
  zValidator('json', InternalTransferInput),
  async (c) => {
    const u = c.get('user');
    if (u.killSwitch) {
      throw ApiError.forbidden('account_frozen');
    }
    const body = c.req.valid('json');
    if (body.fromBucket === body.toBucket) {
      throw ApiError.badRequest('same_bucket');
    }
    const suppliedIdempotencyKey =
      c.req.header('Idempotency-Key') ??
      c.req.header('X-Idempotency-Key') ??
      body.idempotencyKey ??
      '';
    const idempotencyKey = suppliedIdempotencyKey.trim();
    if (!idempotencyKey) {
      throw ApiError.badRequest('idempotency_key_required');
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
      throw ApiError.badRequest('invalid_idempotency_key');
    }
    const fromChain = BUCKET_TO_CHAIN[body.fromBucket];
    const toChain = BUCKET_TO_CHAIN[body.toBucket];
    const rail = pickRail(fromChain, toChain);
    if (rail !== 'cctp' && rail !== 'mayan' && rail !== 'internal') {
      throw ApiError.serviceUnavailable('transfer_rail_unsupported', { rail });
    }
    // NEO platform skim on cross-chain bridge hops (CCTP + Mayan). Same-chain
    // `internal` rail is a pure bucket move with no bridge spread, so no skim.
    // The treasury address on the SOURCE chain receives the fee; if the chain
    // has no treasury configured we skip the skim cleanly so a partial config
    // can't accidentally take fee + lose the destination. Actual on-chain
    // collection happens in the bridge worker (CCTP: batched USDC.transfer
    // before depositForBurn; Mayan: native referrer fee param).
    const feeBps = rail === 'internal' ? 0 : env.NEO_BRIDGE_FEE_BPS;
    const treasuryByChain: Record<string, string | undefined> = {
      arbitrum: env.NEO_BRIDGE_TREASURY_ARB,
      polygon: env.NEO_BRIDGE_TREASURY_POL,
      base: env.NEO_BRIDGE_TREASURY_BASE,
      solana: env.NEO_BRIDGE_TREASURY_SOL,
    };
    const treasuryAddress = treasuryByChain[fromChain] ?? null;
    const skimEligible = feeBps > 0 && Boolean(treasuryAddress);
    const feeUsd = skimEligible
      ? Math.round(((body.amountUsd * feeBps) / 10_000) * 1_000_000) / 1_000_000
      : 0;
    // F101 — perps-SOURCE legs hold funds on HL L1, not the EOA. The worker
    // runs an hl_withdrawing hop first (withdraw3 → EOA arrival, ~5 min) and
    // HL deducts a flat $1 fee, so net it out of the burn: EOA arrival
    // (gross - $1) must always cover burn (net) + treasury skim (feeUsd).
    const hlWithdrawFeeUsd =
      body.fromBucket === 'perps' && (rail === 'cctp' || rail === 'mayan') ? HL_WITHDRAW_FEE_USD : 0;
    // Store gross USD for audit, but net atoms for the bridge burn.
    const netBurnAtoms = BigInt(Math.round((body.amountUsd - feeUsd - hlWithdrawFeeUsd) * 1_000_000));
    const amountTokenAtoms = netBurnAtoms.toString();
    if (netBurnAtoms <= 0n) {
      throw ApiError.badRequest('amount_below_atom');
    }
    if (hlWithdrawFeeUsd > 0 && body.amountUsd < HL_MIN_WITHDRAW_USD) {
      throw ApiError.badRequest('transfer_amount_below_hl_withdraw_min', {
        minimumUsd: HL_MIN_WITHDRAW_USD,
        hlWithdrawFeeUsd,
      });
    }
    if (body.toBucket === 'perps' && netBurnAtoms < HL_MIN_DEPOSIT_USDC_ATOMS) {
      throw ApiError.badRequest('transfer_amount_below_perps_min', {
        minimumUsd: Number(HL_MIN_DEPOSIT_USDC_ATOMS) / 1_000_000,
      });
    }
    const demoExecution = env.DEMO_MODE && (!executor.isLive || !u.privyDid);
    if (!executor.isLive || !u.privyDid) {
      if (demoExecution) {
        log.info({ userId: u.id, rail }, 'transfers.demo: completing transfer without live executor');
      } else {
        throw ApiError.serviceUnavailable('transfer_execution_unavailable', {
          alchemy: features.alchemy,
          chain: features.chain,
          privy: features.privy,
          userWalletReady: Boolean(u.privyDid),
        });
      }
    }
    if (!demoExecution && !features.redis) {
      throw ApiError.serviceUnavailable('transfer_queue_unavailable', { rail });
    }
    // Source-balance pre-check: reject an underfunded transfer at POST time
    // instead of accepting the row and letting it fail mid-flight in the
    // worker (`burning`/`hl_withdrawing` with no user-visible cause). Sibling
    // routes /external and /hl-deposit already pre-check; this closes the gap
    // for /internal. Replays skip the check — the original funds may already
    // be in motion, so re-checking would 400 a legitimately in-flight row.
    if (!demoExecution) {
      const replayRow = await transferStore.findByUserIdempotencyKey(u.id, idempotencyKey);
      if (!replayRow) {
        let availableUsd: number | null;
        if (body.fromBucket === 'perps') {
          // F101 — perps-source funds sit on HL L1; the worker's withdraw3
          // hop pulls the GROSS amountUsd from perp withdrawable.
          const evm = await walletService.getOrCreateUserWallet(u.id, null);
          const hlState = await hyperliquid.getUserState(evm.address);
          availableUsd = hlState.withdrawableUsd;
        } else if (fromChain === 'solana') {
          const sol = await walletService.getOrCreateUserSolanaWallet(u.id, null);
          availableUsd = await getUsdcSolanaBalance(sol.address);
        } else {
          const evm = await walletService.getOrCreateUserWallet(u.id, null);
          availableUsd = await getUsdcEvmBalance(
            fromChain as 'arbitrum' | 'polygon' | 'base' | 'optimism',
            evm.address,
          );
        }
        // Scale plan 1.3 — a failed read returns null; a money move must fail
        // CLOSED on an unknown balance, never proceed against an invented 0.
        if (availableUsd === null) {
          throw ApiError.serviceUnavailable('balance_read_unavailable', { chain: fromChain });
        }
        if (availableUsd + 0.000001 < body.amountUsd) {
          throw ApiError.badRequest('insufficient_source_balance', {
            bucket: body.fromBucket,
            availableUsd,
            requestedUsd: body.amountUsd,
          });
        }
      }
    }
    // CCTP_DOMAIN is keyed on EVM chains only; pickRail won't pick CCTP for
    // Solana legs, so a double-check via isCctpExecutable is enough.
    if (rail === 'cctp' && !isCctpExecutable(fromChain as 'arbitrum' | 'polygon' | 'base' | 'optimism', toChain as 'arbitrum' | 'polygon' | 'base' | 'optimism', 'USDC')) {
      throw ApiError.badRequest('cctp_route_unsupported');
    }
    const { transfer, fresh } = await transferStore.create({
      userId: u.id,
      fromBucket: body.fromBucket as TransferBucket,
      toBucket: body.toBucket as TransferBucket,
      fromChain,
      toChain,
      amountUsd: body.amountUsd,
      amountTokenAtoms,
      rail,
      initialStatus: hlWithdrawFeeUsd > 0 ? 'hl_withdrawing' : 'created',
      idempotencyKey,
    });

    if (!fresh) {
      const replayMatches =
        transfer.fromBucket === body.fromBucket &&
        transfer.toBucket === body.toBucket &&
        transfer.fromChain === fromChain &&
        transfer.toChain === toChain &&
        transfer.rail === rail &&
        transfer.amountUsd === body.amountUsd &&
        transfer.amountTokenAtoms === amountTokenAtoms;
      if (!replayMatches) {
        throw ApiError.conflict('idempotency_key_reused', {
          transferId: transfer.id,
          originalAmountUsd: transfer.amountUsd,
          originalFromBucket: transfer.fromBucket,
          originalToBucket: transfer.toBucket,
        });
      }
      if (transfer.status === 'failed') {
        throw ApiError.conflict('idempotency_key_used', { transferId: transfer.id, status: transfer.status });
      }
      if (
        !demoExecution &&
        (transfer.status === 'created' || transfer.status === 'hl_withdrawing') &&
        (transfer.rail === 'cctp' || transfer.rail === 'mayan' || transfer.rail === 'internal')
      ) {
        try {
          await enqueueTransferProgress(transfer.id, 0, 0, true);
        } catch (e) {
          log.error(
            {
              err: e instanceof Error ? e.message : String(e),
              transferId: transfer.id,
              rail: transfer.rail,
            },
            'transfers: failed to re-enqueue created transfer on idempotent replay',
          );
          throw ApiError.serviceUnavailable('transfer_queue_unavailable', { rail: transfer.rail });
        }
      }
    }

    if (fresh) {
      // Persist feesUsd on the row so the bridge worker can compute the skim
      // atoms when it batches the USDC.transfer + depositForBurn together.
      if (feeUsd > 0) {
        await transferStore.update(transfer.id, { feesUsd: feeUsd });
        transfer.feesUsd = feeUsd;
      }
      await transferStore.appendEvent(transfer.id, 'created', {
        rail,
        fromBucket: body.fromBucket,
        toBucket: body.toBucket,
        amountUsd: body.amountUsd,
        feeUsd,
      });
      if (feeUsd > 0) {
        recordFee({
          userId: u.id,
          venue: 'cctp-bridge',
          kind: 'spread',
          notionalUsd: body.amountUsd,
          rateBps: feeBps,
          symbol: `${fromChain}->${toChain}`,
        });
        await transferStore.appendEvent(transfer.id, 'fee_skimmed', {
          feeUsd,
          rateBps: feeBps,
          treasuryChain: fromChain,
          treasuryAddress,
        });
      }
      // All three live rails advance through the bridge worker; dedupe=true
      // so a double-click POST doesn't enqueue twice for the same fresh row.
      // Socket / LIFI fallback for non-USDC EVM legs would land here later.
      if (demoExecution) {
        await transferStore.update(transfer.id, { status: 'complete' });
        transfer.status = 'complete';
        await transferStore.appendEvent(transfer.id, 'demo_completed', { rail });
      } else if (rail === 'cctp' || rail === 'mayan' || rail === 'internal') {
        try {
          await enqueueTransferProgress(transfer.id, 0, 0, true);
        } catch (e) {
          const error = {
            code: 'transfer_queue_unavailable',
            message: e instanceof Error ? e.message : String(e),
          };
          await transferStore.update(transfer.id, { status: 'failed', error });
          await transferStore.appendEvent(transfer.id, 'error', error);
          log.error(
            { err: error.message, transferId: transfer.id, rail },
            'transfers: failed to enqueue transfer worker job',
          );
          throw ApiError.serviceUnavailable('transfer_queue_unavailable', { rail });
        }
      } else {
        log.info(
          { transferId: transfer.id, rail },
          'transfers: rail not yet wired through worker — transfer stays in created',
        );
      }
    }

    const responseFeeUsd = transfer.feesUsd;
    const responseFeeBps =
      transfer.amountUsd > 0
        ? Math.round((responseFeeUsd / transfer.amountUsd) * 10_000 * 1_000_000) / 1_000_000
        : 0;

    return c.json({
      ok: true,
      transferId: transfer.id,
      status: transfer.status,
      rail: transfer.rail,
      fromBucket: transfer.fromBucket,
      toBucket: transfer.toBucket,
      // `amountUsd` is the NET amount the destination chain will receive
      // (gross minus skim). Kept as the headline number so the existing UI
      // doesn't change shape. `requestedUsd` exposes the gross for explicit
      // surfacing of "Fee: $0.10 · You receive: $99.90".
      amountUsd: transfer.amountUsd - responseFeeUsd,
      requestedUsd: transfer.amountUsd,
      feeUsd: responseFeeUsd,
      feeBps: responseFeeBps,
      etaSec:
        transfer.rail === 'cctp'
          ? (transfer.toBucket === 'perps' ? 110 : 90) // +HL Bridge2 hop
          : transfer.rail === 'mayan'
            ? 8
            : transfer.rail === 'internal'
              ? 2
              : 60,
      idempotent: !fresh,
      demo: demoExecution,
      sourced: demoExecution
        ? providerDemoMeta(transfer.rail === 'mayan' ? 'mayan' : 'cctp', 'transfers-internal')
        : features.alchemy
          ? liveMeta(transfer.rail === 'mayan' ? 'mayan' : 'cctp', 'transfers-internal')
          : providerDemoMeta(transfer.rail === 'mayan' ? 'mayan' : 'cctp', 'transfers-internal'),
    });
  },
);

/* ── POST /transfers/hl-deposit ─────────────────────────────────────────────
 *
 * Push Arbitrum USDC sitting on the user's Privy server-wallet directly to
 * Hyperliquid Bridge2. Used by the client auto-sweep so users only need to
 * "send USDC to my Arbitrum address" — the rest is automatic.
 *
 * Differs from /transfers/internal: no CCTP hop. The funds must already live
 * on Arbitrum (otherwise this route 400s with `insufficient_arb_balance`).
 *
 *   POST /transfers/hl-deposit  { amountUsd?: number }
 *
 * `amountUsd` is optional — when omitted, sweeps the full Arbitrum USDC
 * balance to HL. Caller may pass an explicit amount to leave dust behind.
 */

/**
 * P1 (wave4): shared replay/dedupe response for /transfers/external — used by
 * BOTH the pre-create lookup and the create() `!fresh` race loser. In-flight
 * and settled rows replay as 200 (idempotent:true, live status) so a client
 * retry or racing double-click never burns its intent key; only a true body
 * mismatch or a definitively-failed original 409s (NEO rotates keys on
 * those). The destination check tolerates a missing 'created' event — the
 * race loser can observe the row before the winner's event lands; amount +
 * chain, which live on the row itself, still gate.
 */
async function externalReplayBody(
  replay: Transfer,
  body: { amountUsd: number; chain: string },
  destinationAddress: Hex,
): Promise<Record<string, unknown>> {
  const originalDestination = externalReplayDestination(await transferStore.listEvents(replay.id));
  if (
    replay.amountUsd !== body.amountUsd ||
    replay.toChain !== body.chain ||
    (originalDestination != null && originalDestination !== destinationAddress)
  ) {
    throw ApiError.conflict('idempotency_key_reused', {
      transferId: replay.id,
      originalAmountUsd: replay.amountUsd,
      originalDestinationAddress: originalDestination,
    });
  }
  if (replay.status === 'failed') {
    throw ApiError.conflict('idempotency_key_used', { transferId: replay.id, status: replay.status });
  }
  const txHash = replay.srcTxHash ?? replay.srcCallId;
  const demo = Boolean(txHash?.startsWith('0xdemo'));
  return {
    ok: true,
    transferId: replay.id,
    status: replay.status,
    chain: 'base',
    destinationAddress,
    amountUsd: replay.amountUsd,
    txHash,
    demo,
    idempotent: true,
    sourced: demo
      ? providerDemoMeta('alchemy', 'transfers-external')
      : liveMeta('alchemy', 'transfers-external'),
  };
}

/* Base USDC external wallet send. */
transfersRoutes.post(
  '/external',
  requireSession,
  transfersMoneyLimit,
  zValidator('json', ExternalTransferInput),
  async (c) => {
    const u = c.get('user');
    if (u.killSwitch) {
      throw ApiError.forbidden('account_frozen');
    }
    const body = c.req.valid('json');
    const idempotencyKey = (
      c.req.header('Idempotency-Key') ??
      c.req.header('X-Idempotency-Key') ??
      body.idempotencyKey ??
      ''
    ).trim();
    if (!idempotencyKey) throw ApiError.badRequest('idempotency_key_required');
    if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
      throw ApiError.badRequest('invalid_idempotency_key');
    }

    const destinationAddress = getAddress(body.destinationAddress) as Hex;
    const transferIdempotencyKey = scopedTransferIdempotencyKey('external-transfer', idempotencyKey);
    const replay = await transferStore.findByUserIdempotencyKey(u.id, transferIdempotencyKey);
    if (replay) {
      return c.json(await externalReplayBody(replay, body, destinationAddress));
    }

    const sourceWallet = await walletService.getOrCreateUserWallet(u.id, null);
    const sourceAddress = getAddress(sourceWallet.address) as Hex;
    if (sourceAddress === destinationAddress) {
      throw ApiError.badRequest('destination_equals_source');
    }
    const demoExecution = env.DEMO_MODE && (!executor.isLive || !u.privyDid || !sourceWallet.live);
    if (!executor.isLive || !u.privyDid || !sourceWallet.live) {
      if (!demoExecution) {
        throw ApiError.serviceUnavailable('external_transfer_unavailable', {
          alchemy: features.alchemy,
          chain: features.chain,
          privy: features.privy,
          userWalletReady: Boolean(u.privyDid),
        });
      }
    }

    const amountAtoms = usdToUsdcWei(body.amountUsd);
    if (amountAtoms <= 0n) throw ApiError.badRequest('amount_below_atom');
    if (!demoExecution) {
      const balanceUsd = await getUsdcEvmBalance('base', sourceAddress);
      if (balanceUsd === null) throw ApiError.serviceUnavailable('balance_read_unavailable', { chain: 'base' });
      if (balanceUsd + 0.000001 < body.amountUsd) {
        throw ApiError.badRequest('insufficient_base_usdc', { balanceUsd });
      }
    }

    const { transfer, fresh } = await transferStore.create({
      userId: u.id,
      fromBucket: 'cash',
      toBucket: 'external',
      fromChain: 'base',
      toChain: 'base',
      amountUsd: body.amountUsd,
      amountTokenAtoms: amountAtoms.toString(),
      token: 'USDC',
      rail: 'internal',
      idempotencyKey: transferIdempotencyKey,
    });
    if (!fresh) {
      // Race loser (double-click / same-key concurrent retry): replay the
      // winner's row instead of 409ing — a 409 burns the client intent key,
      // and the rotated key would re-execute the same money move.
      return c.json(await externalReplayBody(transfer, body, destinationAddress));
    }
    await transferStore.appendEvent(transfer.id, 'created', {
      rail: 'external',
      chain: 'base',
      destinationAddress,
      amountUsd: body.amountUsd,
      amountTokenAtoms: amountAtoms.toString(),
    });

    // ── P1 (wave4): WRITE-AHEAD call id. The deterministic executor key is
    // persisted on the row BEFORE dispatch — from here on, a crash, timeout,
    // or unknown-outcome submit leaves a row that says "dispatch may have
    // happened; reconcile via this key", never a bare 'created' row a retry
    // could blindly re-execute. Overwritten by the real callId on a definite
    // submit; kept as the only reconciliation handle on unknown outcomes.
    const executorCallKey = `${transfer.id}:external`;
    await transferStore.update(transfer.id, { srcCallId: executorCallKey });
    await transferStore.appendEvent(transfer.id, 'dispatching', {
      executorCallKey,
      chainId: base.id,
    });

    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [destinationAddress, amountAtoms],
    });

    const acceptedPending = async (event: string, detail: Record<string, unknown>) => {
      // Maybe-dispatched. NEVER mark failed and NEVER 409/503 here — NEO
      // burns its intent key on any error that isn't *_in_progress, and a
      // rotated key re-executes the same money move. 200 accepted-pending
      // parks the key on this row; GET /transfers/:id is the truth surface.
      await transferStore.appendEvent(transfer.id, event, detail);
      return c.json({
        ok: true,
        transferId: transfer.id,
        status: 'created',
        chain: 'base',
        destinationAddress,
        amountUsd: transfer.amountUsd,
        txHash: null,
        demo: false,
        idempotent: false,
        submittedUnknown: true,
        sourced: liveMeta('alchemy', 'transfers-external'),
      });
    };

    let result: Awaited<ReturnType<typeof executor.sendCalls>>;
    try {
      result = await executor.sendCalls(
        u.id,
        [{ to: ASSETS.USDC.address, data }],
        { chainId: base.id, idempotencyKey: executorCallKey },
      );
    } catch (e) {
      // sendCalls' contract is "never throws"; if it ever does we cannot
      // prove the userop was NOT submitted — fail-after-dispatch rule applies.
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ err: msg, transferId: transfer.id }, 'transfers: external dispatch outcome unknown (throw)');
      return acceptedPending('dispatch_unknown', { executorCallKey, error: msg, thrown: true });
    }

    if (result.submittedUnknown) {
      // The submit RPC timed out / returned no callId — the userop may have
      // landed. MUST be handled BEFORE the demo-in-prod guard below: the
      // executor tags unknown outcomes with a demo-shaped fallback, and
      // marking them failed burns the client key → rotate → double send.
      return acceptedPending('dispatch_unknown', { executorCallKey });
    }

    if (result.failed) {
      // Definite pre-submit failure (live signing configured but the sign
      // step failed) — nothing was dispatched, so failing the row (and
      // burning the key via the 409 replay path) is safe AND required.
      // Pre-fix this fell through and recorded a COMPLETE transfer with an
      // empty call id for money that never moved.
      const error = {
        code: result.failureCode ?? 'external_transfer_sign_failed',
        message: 'Live signing failed before dispatch.',
      };
      await transferStore.update(transfer.id, { status: 'failed', srcCallId: null, error });
      await transferStore.appendEvent(transfer.id, 'error', error);
      throw ApiError.serviceUnavailable('external_transfer_unavailable', { reason: error.code });
    }

    if (!env.DEMO_MODE && result.demo) {
      // Executor degraded to demo outside DEMO_MODE (keys missing / prepare
      // failed) — definite non-dispatch, safe to fail closed.
      const error = { code: 'external_transfer_unavailable', message: 'Wallet executor returned demo outside DEMO_MODE.' };
      await transferStore.update(transfer.id, { status: 'failed', srcCallId: null, error });
      await transferStore.appendEvent(transfer.id, 'error', error);
      throw ApiError.serviceUnavailable('external_transfer_unavailable');
    }

    const updated = await transferStore.update(transfer.id, {
      status: 'complete',
      ...(result.demo ? { srcTxHash: result.txHash, srcCallId: null } : { srcCallId: result.txHash }),
    }) ?? transfer;
    await transferStore.appendEvent(
      transfer.id,
      result.demo ? 'demo_completed' : 'external_submitted',
      { txHash: result.txHash, demo: result.demo, submittedUnknown: false },
    );

    return c.json({
      ok: true,
      transferId: transfer.id,
      status: updated.status,
      chain: 'base',
      destinationAddress,
      amountUsd: transfer.amountUsd,
      txHash: result.txHash,
      demo: result.demo,
      idempotent: false,
      submittedUnknown: false,
      sourced: result.demo
        ? providerDemoMeta('alchemy', 'transfers-external')
        : liveMeta('alchemy', 'transfers-external'),
    });
  },
);

function hlDepositReplayPayload(t: Awaited<ReturnType<typeof transferStore.findByUserIdempotencyKey>>) {
  if (!t) throw new Error('missing_transfer_replay');
  const demo = Boolean(t.dstCallId?.startsWith('hl_demo_deposit_'));
  return {
    ok: true,
    callId: t.dstCallId ?? t.srcCallId,
    amountUsd: t.amountUsd,
    demo,
    transferId: t.id,
    status: t.status,
    idempotent: true,
    sourced: demo
      ? providerDemoMeta('cctp', 'transfers-internal')
      : features.alchemy
        ? liveMeta('cctp', 'transfers-internal')
        : providerDemoMeta('cctp', 'transfers-internal'),
  };
}

transfersRoutes.post(
  '/hl-deposit',
  requireSession,
  transfersMoneyLimit,
  zValidator('json', HlDepositInput),
  async (c) => {
    const u = c.get('user');
    if (u.killSwitch) {
      throw ApiError.forbidden('account_frozen');
    }
    const body = c.req.valid('json');
    const suppliedIdempotencyKey =
      c.req.header('Idempotency-Key') ??
      c.req.header('X-Idempotency-Key') ??
      body.idempotencyKey ??
      '';
    const idempotencyKey = suppliedIdempotencyKey.trim();
    if (!idempotencyKey) {
      throw ApiError.badRequest('idempotency_key_required');
    }
    if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
      throw ApiError.badRequest('invalid_idempotency_key');
    }
    const transferIdempotencyKey = scopedTransferIdempotencyKey('hl-deposit', idempotencyKey);
    const replay = await transferStore.findByUserIdempotencyKey(u.id, transferIdempotencyKey);
    if (replay) {
      if (body.amountUsd !== undefined && Math.abs(replay.amountUsd - body.amountUsd) > 0.005) {
        throw ApiError.conflict('idempotency_key_reused', {
          transferId: replay.id,
          originalAmountUsd: replay.amountUsd,
        });
      }
      if (replay.status === 'failed') {
        throw ApiError.conflict('idempotency_key_used', { transferId: replay.id, status: replay.status });
      }
      return c.json(hlDepositReplayPayload(replay));
    }
    const demoExecution = env.DEMO_MODE && (!executor.isLive || !u.privyDid);
    if (!executor.isLive || !u.privyDid) {
      if (demoExecution) {
        const sweepUsd = body.amountUsd ?? 5;
        const amountAtoms = BigInt(Math.round(sweepUsd * 1_000_000));
        if (amountAtoms <= 0n) {
          throw ApiError.badRequest('amount_below_atom');
        }
        if (amountAtoms < HL_MIN_DEPOSIT_USDC_ATOMS) {
          throw ApiError.badRequest('hl_deposit_below_min', {
            minimumUsd: Number(HL_MIN_DEPOSIT_USDC_ATOMS) / 1_000_000,
            currentUsd: sweepUsd,
          });
        }
        const { transfer } = await transferStore.create({
          userId: u.id,
          fromBucket: 'perps',
          toBucket: 'perps',
          fromChain: 'arbitrum',
          toChain: 'arbitrum',
          amountUsd: sweepUsd,
          amountTokenAtoms: amountAtoms.toString(),
          token: 'USDC',
          rail: 'hl_bridge',
          idempotencyKey: transferIdempotencyKey,
        });
        const callId = `hl_demo_deposit_${createHash('sha256').update(transfer.id).digest('hex').slice(0, 16)}`;
        await transferStore.update(transfer.id, { status: 'complete', dstCallId: callId });
        await transferStore.appendEvent(transfer.id, 'created', {
          rail: 'hl_bridge',
          fromChain: 'arbitrum',
          toChain: 'arbitrum',
          amountUsd: sweepUsd,
          amountTokenAtoms: amountAtoms.toString(),
        });
        await transferStore.appendEvent(transfer.id, 'hl_deposit_submitted', { callId, demo: true });
        return c.json({
          ok: true,
          callId,
          amountUsd: sweepUsd,
          demo: true,
          transferId: transfer.id,
          status: 'complete',
          idempotent: false,
          sourced: providerDemoMeta('cctp', 'transfers-internal'),
        });
      }
      throw ApiError.serviceUnavailable('hl_deposit_unavailable', {
        alchemy: features.alchemy,
        privy: features.privy,
      });
    }
    const evm = await walletService.getOrCreateUserWallet(u.id, null);
    const arbBalanceUsd = await getUsdcEvmBalance('arbitrum', evm.address);
    // Scale plan 1.3 — a failed RPC read now returns null instead of a fake 0.
    // A money move must fail CLOSED on an unknown balance, never proceed (or
    // reject) against a number we invented.
    if (arbBalanceUsd === null) {
      throw ApiError.serviceUnavailable('balance_read_unavailable', { chain: 'arbitrum' });
    }
    const sweepUsd = body.amountUsd ?? arbBalanceUsd;
    const amountAtoms = BigInt(Math.round(sweepUsd * 1_000_000));
    if (amountAtoms <= 0n) {
      throw ApiError.badRequest('amount_below_atom');
    }
    if (amountAtoms < HL_MIN_DEPOSIT_USDC_ATOMS) {
      throw ApiError.badRequest('hl_deposit_below_min', {
        minimumUsd: Number(HL_MIN_DEPOSIT_USDC_ATOMS) / 1_000_000,
        currentUsd: arbBalanceUsd,
      });
    }
    const haveAtoms = BigInt(Math.round(arbBalanceUsd * 1_000_000));
    if (haveAtoms < amountAtoms) {
      throw ApiError.badRequest('insufficient_arb_balance', {
        requestedUsd: sweepUsd,
        availableUsd: arbBalanceUsd,
      });
    }
    const { transfer, fresh } = await transferStore.create({
      userId: u.id,
      fromBucket: 'perps',
      toBucket: 'perps',
      fromChain: 'arbitrum',
      toChain: 'arbitrum',
      amountUsd: sweepUsd,
      amountTokenAtoms: amountAtoms.toString(),
      token: 'USDC',
      rail: 'hl_bridge',
      idempotencyKey: transferIdempotencyKey,
    });
    if (!fresh) {
      if (Math.abs(transfer.amountUsd - sweepUsd) > 0.005 || transfer.amountTokenAtoms !== amountAtoms.toString()) {
        throw ApiError.conflict('idempotency_key_reused', {
          transferId: transfer.id,
          originalAmountUsd: transfer.amountUsd,
        });
      }
      if (transfer.status === 'failed') {
        throw ApiError.conflict('idempotency_key_used', { transferId: transfer.id, status: transfer.status });
      }
      return c.json(hlDepositReplayPayload(transfer));
    }
    await transferStore.appendEvent(transfer.id, 'created', {
      rail: 'hl_bridge',
      fromChain: 'arbitrum',
      toChain: 'arbitrum',
      amountUsd: sweepUsd,
      amountTokenAtoms: amountAtoms.toString(),
    });
    // ── P1 (wave4): WRITE-AHEAD call id (see /external). The deterministic
    // executor key is persisted on the row BEFORE dispatch; F085 threads it
    // to the Alchemy edge as the Idempotency-Key header on the submit RPC,
    // so it is the reconciliation handle for unknown outcomes.
    const executorCallKey = `${transfer.id}:hl-deposit`;
    await transferStore.update(transfer.id, { dstCallId: executorCallKey });
    await transferStore.appendEvent(transfer.id, 'dispatching', { executorCallKey });

    const hlAcceptedPending = async (detail: Record<string, unknown>) => {
      // Maybe-dispatched: keep status 'created' — there is no pollable
      // callId, so 'hl_depositing' would wedge the worker poller on an empty
      // id. dstCallId keeps the write-ahead key; same-key replays land on
      // this row instead of re-executing (never mark failed → never burn the
      // client intent key → no rotate-and-double-send).
      await transferStore.appendEvent(transfer.id, 'dispatch_unknown', { executorCallKey, ...detail });
      return c.json({
        ok: true,
        callId: null,
        amountUsd: sweepUsd,
        demo: false,
        transferId: transfer.id,
        status: 'created',
        idempotent: false,
        submittedUnknown: true,
        sourced: features.alchemy
          ? liveMeta('cctp', 'transfers-internal')
          : providerDemoMeta('cctp', 'transfers-internal'),
      });
    };

    let result: Awaited<ReturnType<typeof executeHlBridge2Deposit>>;
    try {
      result = await executeHlBridge2Deposit({
        userId: u.id,
        amountAtoms,
        idempotencyKey: executorCallKey,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ err: msg, transferId: transfer.id }, 'transfers: hl-deposit dispatch outcome unknown (throw)');
      return hlAcceptedPending({ error: msg, thrown: true });
    }
    if (!result) {
      // executeHlBridge2Deposit returns null only on below-min — already
      // guarded above, and null means nothing was dispatched: safe to fail.
      await transferStore.update(transfer.id, { status: 'failed', dstCallId: null, error: { code: 'hl_deposit_below_min' } });
      throw ApiError.badRequest('hl_deposit_below_min');
    }
    if (result.submittedUnknown) {
      // Submit RPC timeout / no callId — the deposit may have landed. MUST
      // precede the demo branch below: unknown outcomes carry a demo-shaped
      // fallback, and marking them failed would 409 the replay → key rotate
      // → double deposit.
      return hlAcceptedPending({});
    }
    if (result.failed) {
      // Definite pre-submit sign failure — nothing dispatched. Pre-fix this
      // fell through as demo:false and was recorded as 'hl_depositing' with
      // an EMPTY call id, wedging the poller forever.
      const error = { code: result.failureCode ?? 'hl_deposit_sign_failed' };
      await transferStore.update(transfer.id, { status: 'failed', dstCallId: null, error });
      await transferStore.appendEvent(transfer.id, 'error', error);
      throw ApiError.serviceUnavailable('hl_deposit_unavailable', { reason: error.code });
    }
    await transferStore.update(transfer.id, {
      status: result.demo ? 'failed' : 'hl_depositing',
      dstCallId: result.callId,
      error: result.demo ? { code: 'hl_deposit_not_live' } : null,
    });
    await transferStore.appendEvent(transfer.id, 'hl_deposit_submitted', {
      callId: result.callId,
      demo: result.demo,
    });
    log.info(
      { userId: u.id, transferId: transfer.id, amountUsd: sweepUsd, callId: result.callId, demo: result.demo },
      'transfers: hl-deposit submitted',
    );
    return c.json({
      ok: true,
      callId: result.callId,
      amountUsd: sweepUsd,
      demo: result.demo,
      transferId: transfer.id,
      status: result.demo ? 'failed' : 'hl_depositing',
      idempotent: false,
      sourced: features.alchemy
        ? liveMeta('cctp', 'transfers-internal')
        : providerDemoMeta('cctp', 'transfers-internal'),
    });
  },
);

/* ── GET /transfers ─────────────────────────────────────────────────────── */

transfersRoutes.get('/', requireSession, async (c) => {
  const u = c.get('user');
  const raw = c.req.query('limit') ?? '20';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw ApiError.badRequest('invalid_limit');
  }
  const transfers = await transferStore.listByUser(u.id, parsed);
  return c.json({ ok: true, transfers });
});

/* ── GET /transfers/:id ─────────────────────────────────────────────────── */

transfersRoutes.get('/:id', requireSession, async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  if (!id?.startsWith('tr_')) {
    throw ApiError.badRequest('invalid_transfer_id');
  }
  const transfer = await transferStore.get(id);
  if (!transfer || transfer.userId !== u.id) {
    throw ApiError.notFound('transfer_not_found');
  }
  const events = await transferStore.listEvents(id);
  return c.json({ ok: true, transfer, events });
});

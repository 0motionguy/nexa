/**
 * Sprint 10 Phase 2 ε — admin sweep routes.
 *
 * Manual triggers for the same store methods the BullMQ repeat workers call
 * (claim-sweeper, subscription-renewer). They are the always-available
 * fallback when REDIS_URL is unset (compose's `neobank-scheduler` exits 0
 * and the workers don't auto-fire), and the on-call lever when a sweep
 * needs to run on demand.
 *
 * Gating: Bearer ${ADMIN_TOKEN}. When the token is unset, EVERY request is
 * rejected with 401 — the routes are inert by default so a forgotten env
 * variable can't leak the admin surface.
 *
 * Wire shape: `{ ok: true, swept, durationMs, … }` on success; structured
 * `{ ok: false, error: { code, message, requestId } }` on auth failure via
 * the global errorHandler.
 */

import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, type Hex } from 'viem';
import { base } from 'viem/chains';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';
import { ApiError } from '../lib/errors.js';
import { captureException } from '../lib/sentry.js';
import { sweepExpiredClaims } from '../lib/sweeps/claims.js';
import { sweepBaseDeposits } from '../lib/sweeps/deposits.js';
import { sweepDueSubscriptions } from '../workers/subscription-renewer.js';
import { sweepDigests } from '../workers/digest-sender.js';
import { sweepFills } from '../workers/fills-notifier.js';
import { store } from '../store/index.js';
import { executor } from '../lib/chain/alchemy.js';
import { signAndSendSolanaTx, resolveSolanaRpcUrl } from '../lib/chain/solana-tx.js';
import { ASSETS } from '../lib/chain/units.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import type { AuditActorType, AuditLogFilter } from '../store/types.js';

export const adminRoutes = new Hono();

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Bearer auth gate. ADMIN_TOKEN being unset implicitly disables the surface —
 * any incoming Authorization header is rejected.
 */
adminRoutes.use('*', async (c, next) => {
  const provided = c.req.header('authorization') ?? '';
  const expected = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : null;
  if (!expected || !tokenMatches(provided, expected)) {
    throw ApiError.unauthorized('admin token required');
  }
  await next();
});

/**
 * Trigger the 30-day claim reclaim sweep. Idempotent — only `pending` rows
 * past `expiresAt` are touched; a second call inside the same minute returns
 * `swept: 0`.
 */
adminRoutes.post('/sweep-claims', async (c) => {
  const start = Date.now();
  const { expiredCount, refundsApplied } = await sweepExpiredClaims();
  const durationMs = Date.now() - start;
  log.info(
    { expiredCount, refundsApplied, durationMs },
    'admin: claim sweep complete',
  );
  return c.json({
    ok: true,
    swept: expiredCount,
    refundsApplied,
    durationMs,
  });
});

/**
 * Trigger the on-chain deposit reconciliation sweep (ADR-0006 Phase 2).
 * Delegates to the same `sweepBaseDeposits` the 2-minute BullMQ job runs.
 * No-ops (`ran: false`) unless DEPOSIT_RECONCILER=1 + Postgres + Base RPC.
 */
adminRoutes.post('/sweep-deposits', async (c) => {
  const start = Date.now();
  const result = await sweepBaseDeposits();
  const durationMs = Date.now() - start;
  log.info({ ...result, durationMs }, 'admin: deposit sweep complete');
  return c.json({ ok: true, ...result, durationMs });
});

/**
 * Trigger the hourly subscription renewer. Delegates to the same
 * `sweepDueSubscriptions` helper the BullMQ job runs so behavior is
 * identical between the cron and the admin path (renew + seller credit +
 * webhook fire).
 */
adminRoutes.post('/sweep-subscriptions', async (c) => {
  const start = Date.now();
  const { due, renewed, failed } = await sweepDueSubscriptions();
  const durationMs = Date.now() - start;
  log.info(
    { due, renewed, failed, durationMs },
    'admin: subscription sweep complete',
  );
  return c.json({
    ok: true,
    swept: due,
    succeeded: renewed,
    failed,
    durationMs,
  });
});

/**
 * Stack upgrades Phase 3 — trigger the daily agent-spend digest sweep
 * inline. Same dispatch shape as the BullMQ Repeat worker; this is the
 * always-available trigger when REDIS_URL is unset. Idempotent: each
 * agent's `nb_agent_spend_digests.last_sent_at` advances on send so a
 * repeat call inside the same 24 h window returns `sent: 0`.
 */
adminRoutes.post('/dispatch-digests', async (c) => {
  const start = Date.now();
  const { due, sent, failed } = await sweepDigests();
  const durationMs = Date.now() - start;
  log.info(
    { due, sent, failed, durationMs },
    'admin: digest dispatch complete',
  );
  return c.json({
    ok: true,
    swept: due,
    sent,
    failed,
    durationMs,
  });
});

/**
 * Manual passive-fill push sweep — fallback trigger when REDIS_URL is unset
 * (no scheduler process). Same pattern as /dispatch-digests. Note the
 * in-process cursor lives in the API process here, not the scheduler.
 */
adminRoutes.post('/sweep-fills', async (c) => {
  const start = Date.now();
  const { users, notified } = await sweepFills();
  const durationMs = Date.now() - start;
  log.info({ users, notified, durationMs }, 'admin: fills sweep complete');
  return c.json({ ok: true, users, notified, durationMs });
});

adminRoutes.post('/sentry-test', async (c) => {
  captureException(new Error('admin_sentry_test'), {
    route: '/admin/sentry-test',
    requestId: c.get('requestId'),
  });
  return c.json({ ok: true, captured: Boolean(env.SENTRY_DSN) });
});

/**
 * Tier 3 #14 — read the forensic audit log behind the same admin gate.
 *
 * Query params (all optional):
 *   - actor_type   — exact match: 'user' | 'admin' | 'system' | 'agent'
 *   - action       — case-sensitive prefix on the dotted action key
 *                    (e.g. ?action=user.kyc matches 'user.kyc.approved')
 *   - since        — ISO timestamp; rows with createdAt >= since
 *   - limit        — 1..1000, clamps out-of-range to 1000, default 100
 *
 * Returns `{ ok: true, entries, next }`. `next` is currently null — pagination
 * lands when SOC-2 reviewers want stable cursors. The store clamps at 1000
 * defensively even if the route accepts a higher number.
 */
const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = ['user', 'admin', 'system', 'agent'] as const;

const auditQuerySchema = z.object({
  actor_type: z.enum(['user', 'admin', 'system', 'agent']).optional(),
  // Dotted action token, alphanumeric + dots + dashes + underscores. The store
  // also escapes wildcards as defense-in-depth.
  action: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/).optional(),
  since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().datetime().optional()),
  limit: z.coerce.number().int().positive().optional(),
});

adminRoutes.get('/audit-log', async (c) => {
  const parsed = auditQuerySchema.safeParse({
    actor_type: c.req.query('actor_type') ?? undefined,
    action: c.req.query('action') ?? undefined,
    since: c.req.query('since') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
  });
  if (!parsed.success) {
    throw ApiError.badRequest('invalid audit-log filter', parsed.error.flatten());
  }
  const q = parsed.data;
  const filter: AuditLogFilter = {};
  if (q.actor_type && AUDIT_ACTOR_TYPES.includes(q.actor_type)) {
    filter.actorType = q.actor_type;
  }
  if (q.action) filter.actionPrefix = q.action;
  if (q.since) filter.since = new Date(q.since);
  if (q.limit !== undefined) filter.limit = q.limit;

  const entries = await store.listAuditEntries(filter);
  return c.json({ ok: true, entries, next: null });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Audit 2026-06-19 — test-cohort management. Lets Mirko tag friendly testers
 * with a `cohort` string and see a rich per-user dashboard (wallets, balances,
 * KYC, recent positions) without tailing logs.
 *
 * Routes:
 *   - POST /cohort         { userId, cohort: string | null }   set/clear tag
 *   - GET  /test-users     ?cohort=tester-2026Q3               enriched view
 *
 * Cohort is free-form text (max 40 chars). Sentry tagging keys off the same
 * value via `setSentryUser` at the auth boundary (next-session task).
 * ────────────────────────────────────────────────────────────────────────── */

const CohortPayload = z.object({
  userId: z.string().uuid(),
  cohort: z
    .string()
    .max(40)
    .regex(/^[a-zA-Z0-9_-]+$/, 'cohort must be alphanumeric + `-`/`_` only')
    .nullable(),
});

adminRoutes.post('/cohort', async (c) => {
  const parsed = CohortPayload.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw ApiError.badRequest('invalid cohort payload', parsed.error.flatten());
  }
  const { userId, cohort } = parsed.data;
  const u = await store.user(userId).catch(() => null);
  if (!u) throw ApiError.notFound('user_not_found');
  await store.setUserCohort(userId, cohort);
  log.info({ userId, cohort }, 'admin: cohort updated');
  return c.json({ ok: true, userId, cohort });
});

/* Audit 2026-06-19 — force-recovery: drain a cohort user's crypto to a
 * supplied external address. Used when a tester wants their funds back.
 *
 * Two chains supported:
 *   - `chain: 'base'` (default): drains USDC on Base via the EIP-7702
 *     sponsored executor. Reads `USDC.balanceOf(wallet)`, builds a single
 *     `transfer(dest, balance)` call, submits gas-free.
 *   - `chain: 'solana'`: drains native SOL on Solana via the Privy server
 *     wallet's `signSolanaTxWithPrivy`. Reads `connection.getBalance` and
 *     leaves a 5_000-lamport floor for rent.
 *
 * Both paths record `admin.withdraw-all.{submitted,demo,skipped}` to the
 * audit log with the dest address + amount.
 */
const WithdrawAllPayload = z
  .object({
    userId: z.string().uuid(),
    destinationAddress: z.string().min(32),
    chain: z.enum(['base', 'solana']).default('base'),
  })
  .superRefine((val, ctx) => {
    if (val.chain === 'base' && !/^0x[a-fA-F0-9]{40}$/.test(val.destinationAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinationAddress'],
        message: 'destinationAddress must be a 0x-prefixed EVM address when chain=base',
      });
    }
    if (val.chain === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(val.destinationAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destinationAddress'],
        message: 'destinationAddress must be a base58 Solana address when chain=solana',
      });
    }
  });

const USDC_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address, uint256) returns (bool)']);
/**
 * Solana rent-exempt floor on a system account (SOL drain leaves this much
 * behind to keep the wallet account alive — drainable on the next attempt
 * once we wire account-close, but right now we just leave it).
 */
const SOL_RENT_LAMPORTS = 5_000n;

/* Audit 2026-06-19 — record an `admin.withdraw-all.attempted` row at the very
 * top of the handler so we have a forensic trail of every probe, even ones
 * that throw before reaching the chain. Best-effort: a failed audit write
 * shouldn't suppress the original error. Mitigates F5. */
async function recordWithdrawAllAttempted(
  c: Context,
  payload: unknown,
): Promise<void> {
  await store
    .recordAuditEntry({
      actorType: 'admin',
      actorId: 'admin-token',
      action: 'admin.withdraw-all.attempted',
      targetType: 'user',
      targetId:
        typeof payload === 'object' && payload && 'userId' in payload && typeof (payload as { userId?: unknown }).userId === 'string'
          ? ((payload as { userId: string }).userId)
          : null,
      metadata: { payload },
      requestId: c.req.header('x-request-id') ?? null,
    })
    .catch((err) => captureException(err instanceof Error ? err : new Error(String(err))));
}

/* Audit 2026-06-19 — rate-limit the destructive admin endpoint per-IP. A
 * compromised ADMIN_TOKEN still can't run a loop against this route faster
 * than 10/min — gives Mirko a tripwire (`Retry-After` 429 spam) before any
 * meaningful drain campaign completes. Mitigates F4. */
const withdrawAllRateLimit = rateLimit({
  namespace: 'admin-withdraw-all',
  windowSeconds: 60,
  limit: 10,
  keyFn: (c) => clientIp(c),
});

adminRoutes.post('/withdraw-all', withdrawAllRateLimit, async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  // Forensic trail BEFORE validation throws — F5 mitigation.
  await recordWithdrawAllAttempted(c, rawBody);
  const parsed = WithdrawAllPayload.safeParse(rawBody);
  if (!parsed.success) {
    throw ApiError.badRequest('invalid withdraw-all payload', parsed.error.flatten());
  }
  const { userId, destinationAddress, chain } = parsed.data;
  const u = await store.user(userId).catch(() => null);
  if (!u) throw ApiError.notFound('user_not_found');
  if (!u.cohort) {
    throw ApiError.forbidden('cohort_required');
  }

  // ── Solana SOL drain ──
  if (chain === 'solana') {
    if (!u.privySolWalletId || !u.privySolWalletAddress) {
      throw ApiError.badRequest('user_has_no_solana_wallet');
    }
    // F3 mitigation — block draining a wallet to itself. Base58 case-sensitive
    // compare is correct for Solana pubkeys.
    if (destinationAddress === u.privySolWalletAddress) {
      throw ApiError.badRequest('destination_equals_source');
    }
    return solanaDrain(c, userId, u.privySolWalletId, u.privySolWalletAddress, destinationAddress);
  }

  // ── Base USDC drain ──
  if (!u.privyWalletAddress) {
    throw ApiError.badRequest('user_has_no_evm_wallet');
  }
  const dest = getAddress(destinationAddress) as Hex;
  const wallet = getAddress(u.privyWalletAddress) as Hex;
  // F3 mitigation — block self-drain. `getAddress` normalises checksums so the
  // string compare is reliable across mixed-case inputs.
  if (dest === wallet) {
    throw ApiError.badRequest('destination_equals_source');
  }

  // 1. Read on-chain USDC balance.
  let balance: bigint;
  try {
    const client = createPublicClient({
      chain: base,
      transport: http(env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
    });
    balance = (await client.readContract({
      address: ASSETS.USDC.address,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [wallet],
    })) as bigint;
  } catch (e) {
    captureException(e instanceof Error ? e : new Error(String(e)), { userId, op: 'withdraw-all balanceOf' });
    throw ApiError.internal('balance_read_failed');
  }
  if (balance === 0n) {
    log.info({ userId, dest, wallet }, 'admin: withdraw-all skipped — zero balance');
    await store
      .recordAuditEntry({
        actorType: 'admin',
        actorId: 'admin-token',
        action: 'admin.withdraw-all.skipped',
        targetType: 'user',
        targetId: userId,
        metadata: { destinationAddress: dest, walletAddress: wallet, balance: '0' },
        requestId: c.req.header('x-request-id') ?? null,
      })
      .catch((err) => captureException(err instanceof Error ? err : new Error(String(err))));
    return c.json({ ok: true, skipped: true, balance: '0' });
  }

  // 2. Build USDC.transfer call.
  const data = encodeFunctionData({
    abi: USDC_ABI,
    functionName: 'transfer',
    args: [dest, balance],
  });
  const calls = [{ to: ASSETS.USDC.address, data }];

  // 3. Submit via sponsored executor. demo mode returns `0xdemo…` — surface
  // `result.demo` so the caller knows nothing hit chain.
  const rawIdempotencyKey = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? '').trim();
  if (rawIdempotencyKey.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  const idempotencyKey = rawIdempotencyKey
    ? `admin-withdraw-all:${createHash('sha256').update(`${userId}:${rawIdempotencyKey}`).digest('hex')}`
    : undefined;
  const result = await executor.sendCalls(userId, calls, idempotencyKey ? { idempotencyKey } : undefined);
  const isDemo = result.demo;

  // 4. Audit log (best-effort — even a demo run is worth recording).
  const auditId = await store
    .recordAuditEntry({
      actorType: 'admin',
      actorId: 'admin-token',
      action: isDemo ? 'admin.withdraw-all.demo' : 'admin.withdraw-all.submitted',
      targetType: 'user',
      targetId: userId,
      metadata: {
        destinationAddress: dest,
        walletAddress: wallet,
        amountWei: balance.toString(),
        amountUsdc: (Number(balance) / 1e6).toFixed(6),
        txHash: result.txHash,
        demo: isDemo,
      },
      requestId: c.req.header('x-request-id') ?? null,
    })
    .then((r) => r.id)
    .catch((err) => {
      captureException(err instanceof Error ? err : new Error(String(err)));
      return null;
    });

  log.info(
    { userId, dest, wallet, amountWei: balance.toString(), txHash: result.txHash, demo: isDemo, auditId },
    'admin: withdraw-all submitted',
  );
  return c.json({
    ok: true,
    userId,
    destinationAddress: dest,
    amountWei: balance.toString(),
    amountUsdc: Number(balance) / 1e6,
    txHash: result.txHash,
    demo: isDemo,
    auditId,
  });
});

/* Solana SOL drain. Reads balance, leaves rent floor, signs via the shared
 * `signAndSendSolanaTx` helper which handles broadcast + confirmation. The
 * `confirmed` flag in the response tells the caller whether validators have
 * accepted the tx — `confirmed: false` means the sig is still in flight. */
async function solanaDrain(
  c: Context,
  userId: string,
  walletId: string,
  walletAddress: string,
  destinationAddress: string,
): Promise<Response> {
  const rpcUrl = resolveSolanaRpcUrl();
  if (!rpcUrl) {
    throw ApiError.internal('solana_rpc_url_missing');
  }
  try {
    const web3 = await import('@solana/web3.js');
    const { signSolanaTxWithPrivy } = await import('../lib/privy.js');
    const probeConnection = new web3.Connection(rpcUrl, 'confirmed');
    const fromPubkey = new web3.PublicKey(walletAddress);
    const toPubkey = new web3.PublicKey(destinationAddress);

    // Read balance first so we can short-circuit the at-or-below-rent case
    // before invoking the helper (which would spend a Privy quota on a nop).
    const balanceLamports = BigInt(await probeConnection.getBalance(fromPubkey, 'confirmed'));
    const drainable = balanceLamports > SOL_RENT_LAMPORTS ? balanceLamports - SOL_RENT_LAMPORTS : 0n;
    if (drainable === 0n) {
      log.info({ userId, walletAddress, destinationAddress, balanceLamports: balanceLamports.toString() }, 'admin: withdraw-all solana skipped — at-or-below rent');
      await store
        .recordAuditEntry({
          actorType: 'admin',
          actorId: 'admin-token',
          action: 'admin.withdraw-all.skipped',
          targetType: 'user',
          targetId: userId,
          metadata: {
            chain: 'solana',
            destinationAddress,
            walletAddress,
            balanceLamports: balanceLamports.toString(),
            reason: 'at_or_below_rent',
          },
          requestId: c.req.header('x-request-id') ?? null,
        })
        .catch((err) => captureException(err instanceof Error ? err : new Error(String(err))));
      return c.json({ ok: true, skipped: true, chain: 'solana', balanceLamports: balanceLamports.toString() });
    }

    const submission = await signAndSendSolanaTx({
      rpcUrl,
      walletAddress,
      signTx: (messageBase64) => signSolanaTxWithPrivy(walletId, messageBase64),
      label: 'admin.withdraw-all.solana',
      buildTx: async (web3Inner) =>
        new web3Inner.Transaction().add(
          web3Inner.SystemProgram.transfer({ fromPubkey, toPubkey, lamports: drainable }),
        ),
    });

    if (submission.status === 'unavailable') {
      throw ApiError.internal(submission.reason);
    }

    const auditId = await store
      .recordAuditEntry({
        actorType: 'admin',
        actorId: 'admin-token',
        action: 'admin.withdraw-all.submitted',
        targetType: 'user',
        targetId: userId,
        metadata: {
          chain: 'solana',
          destinationAddress,
          walletAddress,
          amountLamports: drainable.toString(),
          amountSol: (Number(drainable) / 1e9).toFixed(9),
          signature: submission.signature,
          confirmed: submission.confirmed,
        },
        requestId: c.req.header('x-request-id') ?? null,
      })
      .then((r) => r.id)
      .catch((err) => {
        captureException(err instanceof Error ? err : new Error(String(err)));
        return null;
      });

    log.info(
      { userId, walletAddress, destinationAddress, amountLamports: drainable.toString(), signature: submission.signature, confirmed: submission.confirmed, auditId },
      'admin: withdraw-all solana submitted',
    );
    return c.json({
      ok: true,
      userId,
      chain: 'solana',
      destinationAddress,
      amountLamports: drainable.toString(),
      amountSol: Number(drainable) / 1e9,
      signature: submission.signature,
      confirmed: submission.confirmed,
      auditId,
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    captureException(e instanceof Error ? e : new Error(String(e)), { userId, op: 'withdraw-all solana' });
    throw ApiError.internal('solana_drain_failed');
  }
}

adminRoutes.get('/test-users', async (c) => {
  const cohort = (c.req.query('cohort') ?? 'tester-2026Q3').trim();
  if (!cohort) throw ApiError.badRequest('cohort query param required');
  const includeOnchain = c.req.query('onchain') !== 'false'; // default on
  const users = await store.listUsersByCohort(cohort);

  // Audit 2026-06-19 — share one publicClient across the dashboard so the
  // RPC connection is reused across all balance reads (one Base RPC call per
  // user with an EVM wallet). Quiet on RPC failure — the dashboard should
  // still render even if Base is down.
  const baseClient = includeOnchain
    ? createPublicClient({
        chain: base,
        transport: http(env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
      })
    : null;

  const rows = await Promise.all(
    users.map(async (u) => {
      // listMarketPositions can fail per-user (e.g. demo path with no rows);
      // wrap so one bad user doesn't break the whole dashboard.
      const [hlPositions, pmPositions] = await Promise.all([
        store.listMarketPositions(u, 'hyperliquid').catch(() => []),
        store.listMarketPositions(u, 'polymarket').catch(() => []),
      ]);

      // On-chain USDC balance on Base — the airdrop reconciliation view.
      // Lets Mirko see "tester X received 20 USDC on-chain" without needing
      // a Basescan lookup.
      let onchainUsdc: string | null = null;
      if (baseClient && u.privyWalletAddress) {
        try {
          const bal = (await baseClient.readContract({
            address: ASSETS.USDC.address,
            abi: USDC_ABI,
            functionName: 'balanceOf',
            args: [getAddress(u.privyWalletAddress) as Hex],
          })) as bigint;
          onchainUsdc = (Number(bal) / 1e6).toFixed(6);
        } catch {
          onchainUsdc = null; // RPC failure — leave null, no crash
        }
      }

      return {
        id: u.id,
        email: u.email,
        name: u.name,
        cohort: u.cohort,
        kycStatus: u.kycStatus,
        killSwitch: u.killSwitch,
        wallets: {
          evm: u.privyWalletAddress ?? null,
          solana: u.privySolWalletAddress ?? null,
        },
        balances: {
          ledgerUsd: u.balUsd,
          ledgerEarnUsd: u.earnUsd,
          earnApy: u.earnApy,
          onchainUsdcBase: onchainUsdc,
        },
        flags: {
          hlBuilderApproved: Boolean(u.hlBuilderApprovedAt),
          hlBuilderMaxFeeTenthsBp: u.hlBuilderMaxFeeTenthsBp ?? null,
          pmClobDerived: Boolean(u.pmClobKey && u.pmClobSecret),
        },
        positions: {
          hyperliquid: hlPositions.length,
          polymarket: pmPositions.length,
        },
      };
    }),
  );
  return c.json({ ok: true, cohort, count: rows.length, users: rows });
});

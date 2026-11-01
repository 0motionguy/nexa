/**
 * Bridge worker tests — Sprint 18 F090.
 *
 * The bridge worker (CCTP / Mayan / HL Bridge2 state machine) is the hottest
 * money-touching path in the codebase. The prior audit (Sprint 16.2 / 17)
 * shipped without direct worker-level coverage; this spec locks the Sprint 18
 * fixes against regression:
 *
 *   F086 — `failTransfer` calls `Sentry.captureMessage` with rich tags so
 *          operator alert rules can fire on `tag:transfer_failed=true`.
 *
 *   F092 — `transferStore.listMidFlight()` filters by exclusion of
 *          TERMINAL_TRANSFER_STATUSES, so any future non-terminal state is
 *          mid-flight by default and gets re-enqueued on worker boot.
 *
 * Full FSM transition coverage (advanceCreated → … → complete) requires
 * mocking the executor + Iris + Mayan SDK and is filed as a follow-up. This
 * file's mandate is the audit-stamped surface only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// captureMessage is the side effect we assert; mock the module before the
// worker imports it.
vi.mock('../lib/sentry.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/sentry.js')>('../lib/sentry.js');
  return {
    ...actual,
    captureMessage: vi.fn(),
  };
});

vi.mock('../lib/chain/wallet.js', () => ({
  walletService: {
    getOrCreateUserWallet: vi.fn(async () => ({
      address: '0x00000000000000000000000000000000000000a1',
    })),
    getOrCreateUserSolanaWallet: vi.fn(async () => ({
      address: 'So11111111111111111111111111111111111111112',
      signTx: vi.fn(async () => Buffer.from('signed-solana-message').toString('base64')),
    })),
  },
}));

vi.mock('../lib/chain/mayan.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/chain/mayan.js')>('../lib/chain/mayan.js');
  return {
    ...actual,
    fetchMayanQuote: vi.fn(),
    executeMayanSwap: vi.fn(),
  };
});

vi.mock('../lib/chain/cctp.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/chain/cctp.js')>('../lib/chain/cctp.js');
  return {
    ...actual,
    executeCctpBurn: vi.fn(),
    executeCctpMint: vi.fn(),
  };
});

vi.mock('../lib/chain/hl-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/chain/hl-bridge.js')>('../lib/chain/hl-bridge.js');
  return {
    ...actual,
    executeHlBridge2Deposit: vi.fn(),
    getHlBridgeDepositStatus: vi.fn(),
  };
});

// F101 — the worker only touches `hyperliquid.withdraw3`; a plain factory
// avoids loading the full venue adapter in the worker spec.
vi.mock('../lib/markets/hyperliquid.js', () => ({
  hyperliquid: { withdraw3: vi.fn() },
}));

vi.mock('../lib/chain/balances.js', () => ({
  getUsdcEvmBalance: vi.fn(),
}));

import { captureMessage } from '../lib/sentry.js';
import { executeCctpMint } from '../lib/chain/cctp.js';
import { executeHlBridge2Deposit, getHlBridgeDepositStatus } from '../lib/chain/hl-bridge.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import { getUsdcEvmBalance } from '../lib/chain/balances.js';
import { fetchMayanQuote, executeMayanSwap } from '../lib/chain/mayan.js';
import { transferStore, TERMINAL_TRANSFER_STATUSES, type TransferStatus } from '../store/transfers.js';
import { __testAdvanceTransfer, __testFailTransfer } from './bridge-worker.js';

const captureMessageMock = vi.mocked(captureMessage);
const executeCctpMintMock = vi.mocked(executeCctpMint);
const withdraw3Mock = vi.mocked(hyperliquid.withdraw3);
const getUsdcEvmBalanceMock = vi.mocked(getUsdcEvmBalance);
const executeHlBridge2DepositMock = vi.mocked(executeHlBridge2Deposit);
const getHlBridgeDepositStatusMock = vi.mocked(getHlBridgeDepositStatus);
const fetchMayanQuoteMock = vi.mocked(fetchMayanQuote);
const executeMayanSwapMock = vi.mocked(executeMayanSwap);

const baseTransfer = {
  userId: 'user_bridge_worker_spec',
  fromBucket: 'cash' as const,
  toBucket: 'perps' as const,
  fromChain: 'base' as const,
  toChain: 'arbitrum' as const,
  amountUsd: 50,
  amountTokenAtoms: '50000000',
  rail: 'cctp' as const,
};

const baseMayanTransfer = {
  ...baseTransfer,
  toBucket: 'memes' as const,
  fromChain: 'base' as const,
  toChain: 'solana' as const,
  rail: 'mayan' as const,
};

beforeEach(() => {
  transferStore._resetForTests();
  captureMessageMock.mockClear();
  executeCctpMintMock.mockReset();
  executeHlBridge2DepositMock.mockReset();
  getHlBridgeDepositStatusMock.mockReset();
  fetchMayanQuoteMock.mockReset();
  executeMayanSwapMock.mockReset();
  withdraw3Mock.mockReset();
  getUsdcEvmBalanceMock.mockReset();
  withdraw3Mock.mockResolvedValue({
    ok: true,
    callId: 'hl_wdr_1',
    destination: '0x00000000000000000000000000000000000000a1',
    amountUsd: 50,
    demo: false,
  });
  getUsdcEvmBalanceMock.mockResolvedValue(10);
  executeCctpMintMock.mockResolvedValue({
    callId: 'cctp_mint_call_1',
    demo: false,
  });
  executeHlBridge2DepositMock.mockResolvedValue({
    callId: 'hl_deposit_call_1',
    demo: false,
  });
  getHlBridgeDepositStatusMock.mockResolvedValue({
    status: 'CONFIRMED',
    txHash: '0xhlbridge',
    receipt: { logs: [] },
  });
  fetchMayanQuoteMock.mockResolvedValue([
    {
      type: 'SWIFT',
      amountIn: 50,
      expectedAmountOut: 49.95,
      minAmountOut: 49.5,
      price: 0.999,
      etaSeconds: 5,
      redeemRelayerFee: 0,
      fromSymbol: 'USDC',
      toSymbol: 'USDC',
      fromChain: 'base',
      toChain: 'solana',
    },
  ]);
  executeMayanSwapMock.mockResolvedValue({
    status: 'submitted',
    sourceTxId: 'mayan_src_tx_1',
    trackingUrl: 'https://explorer.mayan.finance/swap/mayan_src_tx_1',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('F086 failTransfer ops-alert capture', () => {
  it('emits a Sentry message with rich tags on transfer failure', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'bridge-worker-f086-baseline',
    });

    await __testFailTransfer(transfer.id, { code: 'burn_failed', message: 'rpc_down' });

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, opts] = captureMessageMock.mock.calls[0]!;
    expect(message).toBe('bridge_transfer_failed');
    expect(opts?.tags).toMatchObject({
      transferId: transfer.id,
      code: 'burn_failed',
      rail: 'cctp',
      fromBucket: 'cash',
      toBucket: 'perps',
    });
    // burn_failed is a critical condition — level should escalate to fatal so
    // alert rules with a default error-level mute still page.
    expect(opts?.level).toBe('fatal');
  });

  it('marks high-value transfers ($1k+) as fatal-level for ops paging', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      amountUsd: 5000,
      amountTokenAtoms: '5000000000',
      idempotencyKey: 'bridge-worker-f086-highvalue',
    });

    await __testFailTransfer(transfer.id, { code: 'mayan_exception', message: 'quote_failed' });

    const [, opts] = captureMessageMock.mock.calls[0]!;
    expect(opts?.level).toBe('fatal');
    // Note: the real captureMessage helper stringifies tag values; the mock
    // here observes the pre-coercion shape, so we assert against the boolean.
    expect(opts?.tags).toMatchObject({ highValue: true });
  });

  it('downgrades low-value non-critical failures to error level', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      amountUsd: 10,
      amountTokenAtoms: '10000000',
      idempotencyKey: 'bridge-worker-f086-lowvalue',
    });

    await __testFailTransfer(transfer.id, { code: 'hl_deposit_below_minimum' });

    const [, opts] = captureMessageMock.mock.calls[0]!;
    expect(opts?.level).toBe('error');
    expect(opts?.tags).toMatchObject({ highValue: false });
  });

  it('does not throw if the transfer row vanishes between fail and capture', async () => {
    // Worker should not double-fail when failTransfer is called against a
    // bogus id (e.g. parallel cleanup). captureMessage is still attempted.
    await expect(__testFailTransfer('tr_nonexistent', { code: 'race' })).resolves.not.toThrow();
  });
});

describe('F092 listMidFlight exclusion filter', () => {
  it('includes every non-terminal state including hl_depositing', async () => {
    const nonTerminal: TransferStatus[] = [
      'created',
      'burning',
      'attesting',
      'minting',
      'depositing',
      'hl_depositing',
      'hl_withdrawing',
    ];

    for (const status of nonTerminal) {
      const { transfer } = await transferStore.create({
        ...baseTransfer,
        idempotencyKey: `bridge-worker-f092-${status}`,
      });
      if (status !== 'created') {
        await transferStore.update(transfer.id, { status });
      }
    }

    const midFlight = await transferStore.listMidFlight();
    expect(midFlight.length).toBe(nonTerminal.length);
    const statuses = new Set(midFlight.map((t) => t.status));
    for (const status of nonTerminal) expect(statuses.has(status)).toBe(true);
  });

  it('excludes complete + failed transfers from boot recovery', async () => {
    for (const status of TERMINAL_TRANSFER_STATUSES) {
      const { transfer } = await transferStore.create({
        ...baseTransfer,
        idempotencyKey: `bridge-worker-f092-terminal-${status}`,
      });
      await transferStore.update(transfer.id, { status });
    }
    const midFlight = await transferStore.listMidFlight();
    expect(midFlight.length).toBe(0);
  });
});

describe('F101 perps-source HL withdrawal hop', () => {
  const perpsSourceTransfer = {
    ...baseTransfer,
    fromBucket: 'perps' as const,
    toBucket: 'cash' as const,
    fromChain: 'arbitrum' as const,
    toChain: 'base' as const,
    amountUsd: 50,
    amountTokenAtoms: '49000000', // gross $50 - $1 HL withdraw fee
    initialStatus: 'hl_withdrawing' as const,
  };

  it('first tick records a balance baseline and submits withdraw3 to the user EOA', async () => {
    const { transfer } = await transferStore.create({
      ...perpsSourceTransfer,
      idempotencyKey: 'bridge-worker-f094-submit',
    });
    expect(transfer.status).toBe('hl_withdrawing');

    await __testAdvanceTransfer(transfer.id);

    expect(withdraw3Mock).toHaveBeenCalledTimes(1);
    expect(withdraw3Mock).toHaveBeenCalledWith({
      // Spec wallet mock is not live → ids demo-gate to null; the real
      // adapter then refuses to fake a live withdrawal.
      privyWalletId: null,
      privyWalletAddress: null,
      destination: '0x00000000000000000000000000000000000000a1',
      amountUsd: 50,
    });
    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('hl_withdrawing');
    const events = await transferStore.listEvents(transfer.id);
    const submitted = events.find((e) => e.eventType === 'hl_withdraw_submitted');
    expect(submitted?.payload).toMatchObject({ callId: 'hl_wdr_1', baselineUsd: 10 });
  });

  it('advances to created once the EOA balance shows the net arrival', async () => {
    const { transfer } = await transferStore.create({
      ...perpsSourceTransfer,
      idempotencyKey: 'bridge-worker-f094-arrival',
    });
    await transferStore.appendEvent(transfer.id, 'hl_withdraw_submitted', {
      callId: 'hl_wdr_1',
      baselineUsd: 10,
      submittedAtMs: Date.now(),
    });
    getUsdcEvmBalanceMock.mockResolvedValueOnce(59); // 10 + (50 - $1 fee)

    await __testAdvanceTransfer(transfer.id);

    expect(withdraw3Mock).not.toHaveBeenCalled();
    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('created');
    const events = await transferStore.listEvents(transfer.id);
    expect(events.some(
      (e) => e.eventType === 'state_change'
        && (e.payload as { from?: string; to?: string }).from === 'hl_withdrawing'
        && (e.payload as { from?: string; to?: string }).to === 'created',
    )).toBe(true);
  });

  it('keeps waiting while the withdrawal is still in flight', async () => {
    const { transfer } = await transferStore.create({
      ...perpsSourceTransfer,
      idempotencyKey: 'bridge-worker-f094-pending',
    });
    await transferStore.appendEvent(transfer.id, 'hl_withdraw_submitted', {
      callId: 'hl_wdr_1',
      baselineUsd: 10,
      submittedAtMs: Date.now(),
    });
    getUsdcEvmBalanceMock.mockResolvedValueOnce(10.5); // dust ≠ the $49 arrival

    await __testAdvanceTransfer(transfer.id);

    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('hl_withdrawing');
    expect(after?.error).toBeNull();
  });

  it('fails closed when withdraw3 cannot submit live', async () => {
    withdraw3Mock.mockResolvedValueOnce({
      ok: true,
      callId: 'hl_demo_wdr_x',
      destination: '0x00000000000000000000000000000000000000a1',
      amountUsd: 50,
      demo: true,
    });
    const { transfer } = await transferStore.create({
      ...perpsSourceTransfer,
      idempotencyKey: 'bridge-worker-f094-not-live',
    });

    await __testAdvanceTransfer(transfer.id);

    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toMatchObject({ code: 'hl_withdraw_not_live' });
  });

  it('parks for reconciliation when the arrival never lands within the window', async () => {
    const { transfer } = await transferStore.create({
      ...perpsSourceTransfer,
      idempotencyKey: 'bridge-worker-f094-timeout',
    });
    await transferStore.appendEvent(transfer.id, 'hl_withdraw_submitted', {
      callId: 'hl_wdr_1',
      baselineUsd: 10,
      submittedAtMs: Date.now() - 46 * 60_000,
    });
    getUsdcEvmBalanceMock.mockResolvedValueOnce(10);

    await __testAdvanceTransfer(transfer.id);

    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('hl_withdrawing');
    expect(after?.error).toMatchObject({
      code: 'hl_withdraw_arrival_timeout',
      reconciliationRequired: true,
    });
    const events = await transferStore.listEvents(transfer.id);
    expect(events.some((e) => e.eventType === 'reconciliation_required')).toBe(true);
  });
});

describe('CCTP state-machine crash recovery', () => {
  it('marks a burning transfer without a persisted source call id for reconciliation', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'bridge-worker-burning-missing-call-id',
    });
    await transferStore.update(transfer.id, { status: 'burning' });

    await __testAdvanceTransfer(transfer.id);

    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('burning');
    expect(after?.error).toMatchObject({
      code: 'missing_src_call_id',
      reconciliationRequired: true,
    });
    const events = await transferStore.listEvents(transfer.id);
    expect(events.some((event) => event.eventType === 'reconciliation_required')).toBe(true);
  });

  it('keeps a submitted CCTP mint non-terminal when local audit persistence fails', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'bridge-worker-cctp-mint-audit-failure',
    });
    await transferStore.update(transfer.id, {
      status: 'minting',
      cctpMessageBody: '0x1234',
      cctpAttestation: '0xabcd',
    });
    vi.spyOn(transferStore, 'appendEvent').mockRejectedValueOnce(new Error('audit db down'));

    await __testAdvanceTransfer(transfer.id);

    expect(executeCctpMintMock).toHaveBeenCalledTimes(1);
    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('depositing');
    expect(after?.dstCallId).toBe('cctp_mint_call_1');
    expect(after?.error).toMatchObject({
      code: 'mint_submit_persistence_failed',
      callId: 'cctp_mint_call_1',
      reconciliationRequired: true,
    });
    expect(captureMessageMock).toHaveBeenCalledWith(
      'bridge_transfer_reconciliation_required',
      expect.objectContaining({ level: 'fatal' }),
    );
  });

  it('keeps an unknown CCTP mint submit non-terminal for reconciliation', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'bridge-worker-cctp-mint-submit-unknown',
    });
    await transferStore.update(transfer.id, {
      status: 'minting',
      cctpMessageBody: '0x1234',
      cctpAttestation: '0xabcd',
    });
    executeCctpMintMock.mockResolvedValueOnce({
      callId: '0xdemo_unknown_mint',
      demo: true,
      submittedUnknown: true,
    });

    await __testAdvanceTransfer(transfer.id);

    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('minting');
    expect(after?.error).toMatchObject({
      code: 'mint_submit_unknown',
      reconciliationRequired: true,
    });
    expect(captureMessageMock).toHaveBeenCalledWith(
      'bridge_transfer_reconciliation_required',
      expect.objectContaining({ level: 'fatal' }),
    );
  });

  it('persists the HL final-hop call id before audit events so retry does not resubmit', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'bridge-worker-hl-audit-failure',
    });
    await transferStore.update(transfer.id, {
      status: 'hl_depositing',
      dstCallId: null,
      dstTxHash: '0xcctpmint',
    });
    vi.spyOn(transferStore, 'appendEvent').mockRejectedValueOnce(new Error('audit db down'));

    await __testAdvanceTransfer(transfer.id);

    expect(executeHlBridge2DepositMock).toHaveBeenCalledTimes(1);
    const submitted = await transferStore.get(transfer.id);
    expect(submitted?.status).toBe('hl_depositing');
    expect(submitted?.dstCallId).toBe('hl_deposit_call_1');
    expect(submitted?.error).toMatchObject({
      code: 'hl_deposit_submit_persistence_failed',
      callId: 'hl_deposit_call_1',
      reconciliationRequired: true,
    });

    await __testAdvanceTransfer(transfer.id);

    expect(executeHlBridge2DepositMock).toHaveBeenCalledTimes(1);
    expect(getHlBridgeDepositStatusMock).toHaveBeenCalledWith('hl_deposit_call_1');
    const complete = await transferStore.get(transfer.id);
    expect(complete?.status).toBe('complete');
    expect(complete?.error).toBeNull();
  });

  it('polls a persisted HL final-hop call id even when the audit event is missing', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'bridge-worker-hl-row-call-id-recovery',
    });
    await transferStore.update(transfer.id, {
      status: 'hl_depositing',
      dstCallId: 'hl_row_call_id',
      dstTxHash: '0xcctpmint',
    });

    await __testAdvanceTransfer(transfer.id);

    expect(executeHlBridge2DepositMock).not.toHaveBeenCalled();
    expect(getHlBridgeDepositStatusMock).toHaveBeenCalledWith('hl_row_call_id');
    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('complete');
  });

  it('surfaces a live signing failure as an actionable error, not a fake demo success', async () => {
    // Server signing configured but the wallet has no authorized signer: the
    // executor returns { failed:true } instead of a 0xdemo hash. The worker
    // must fail the transfer with the real code, never mask it as "not live".
    executeHlBridge2DepositMock.mockResolvedValueOnce({
      callId: '',
      demo: false,
      failed: true,
      failureCode: 'server_signing_unavailable',
    });
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'bridge-worker-hl-sign-failure',
    });
    await transferStore.update(transfer.id, {
      status: 'hl_depositing',
      dstCallId: null,
      dstTxHash: '0xcctpmint',
    });

    await __testAdvanceTransfer(transfer.id);

    const failed = await transferStore.get(transfer.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatchObject({ code: 'server_signing_unavailable' });
    expect(getHlBridgeDepositStatusMock).not.toHaveBeenCalled();
  });
});

describe('Mayan state-machine idempotency', () => {
  it('claims a created Mayan transfer before external submit so parallel ticks submit once', async () => {
    const { transfer } = await transferStore.create({
      ...baseMayanTransfer,
      idempotencyKey: 'bridge-worker-mayan-parallel-submit',
    });

    await Promise.all([
      __testAdvanceTransfer(transfer.id),
      __testAdvanceTransfer(transfer.id),
    ]);

    expect(executeMayanSwapMock).toHaveBeenCalledTimes(1);
    expect(executeMayanSwapMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `${transfer.id}:mayan`,
    }));
    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('complete');
    expect(after?.srcTxHash).toBe('mayan_src_tx_1');
  });

  it('fails a claimed Mayan transfer without a persisted source tx instead of resubmitting', async () => {
    const { transfer } = await transferStore.create({
      ...baseMayanTransfer,
      idempotencyKey: 'bridge-worker-mayan-missing-source-tx',
    });
    await transferStore.update(transfer.id, { status: 'burning' });

    await __testAdvanceTransfer(transfer.id);

    expect(executeMayanSwapMock).not.toHaveBeenCalled();
    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('burning');
    expect(after?.error).toMatchObject({
      code: 'missing_mayan_source_tx',
      reconciliationRequired: true,
    });
  });
});

describe('external-send guard (stop-hook P1) — unknown submits never blind-complete', () => {
  it('worker restart re-enqueue leaves an unknown-outcome external send in created', async () => {
    // Row shape stamped by POST /transfers/external: same-chain base→base,
    // rail 'internal', toBucket 'external', write-ahead executor key on the
    // row, dispatch outcome unknown (submittedUnknown / crash / timeout).
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      toBucket: 'external' as const,
      toChain: 'base' as const,
      rail: 'internal' as const,
      idempotencyKey: 'bridge-worker-external-unknown',
    });
    await transferStore.update(transfer.id, { srcCallId: `${transfer.id}:external` });

    // Boot orphan scan path after a worker restart: listMidFlight → enqueue
    // → advance.
    await __testAdvanceTransfer(transfer.id);

    const after = await transferStore.get(transfer.id);
    // Pre-fix: the internal-rail branch marked this 'complete' with zero
    // on-chain evidence. It must stay pending under its reconciliation
    // handle instead.
    expect(after?.status).toBe('created');
    expect(after?.srcCallId).toBe(`${transfer.id}:external`);
    const events = await transferStore.listEvents(transfer.id);
    expect(events.some((e) => e.eventType === 'state_change')).toBe(false);
  });

  it('any internal-rail row carrying a dispatch handle is refused (defense in depth)', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      toBucket: 'cash' as const,
      toChain: 'base' as const,
      rail: 'internal' as const,
      idempotencyKey: 'bridge-worker-internal-dispatched',
    });
    await transferStore.update(transfer.id, { srcCallId: 'maybe_dispatched_handle' });

    await __testAdvanceTransfer(transfer.id);

    expect((await transferStore.get(transfer.id))?.status).toBe('created');
  });

  it('control: a genuine same-chain bucket relabel still auto-completes', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      fromBucket: 'memes' as const,
      toBucket: 'stocks-spot' as const,
      fromChain: 'solana' as const,
      toChain: 'solana' as const,
      rail: 'internal' as const,
      idempotencyKey: 'bridge-worker-internal-genuine',
    });

    await __testAdvanceTransfer(transfer.id);

    const after = await transferStore.get(transfer.id);
    expect(after?.status).toBe('complete');
    const events = await transferStore.listEvents(transfer.id);
    expect(events.some((e) => e.eventType === 'state_change')).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { transferStore } from './transfers.js';

const baseTransfer = {
  userId: 'user_transfer_idem',
  fromBucket: 'perps' as const,
  toBucket: 'predictions' as const,
  fromChain: 'arbitrum' as const,
  toChain: 'polygon' as const,
  amountUsd: 12.34,
  amountTokenAtoms: '12340000',
  rail: 'cctp' as const,
  idempotencyKey: 'transfer-idem-1',
};

beforeEach(() => {
  transferStore._resetForTests();
});

describe('transferStore idempotency', () => {
  it('marks only the first create as fresh for a user idempotency key', async () => {
    const first = await transferStore.create(baseTransfer);
    const replay = await transferStore.create(baseTransfer);

    expect(first.fresh).toBe(true);
    expect(replay.fresh).toBe(false);
    expect(replay.transfer.id).toBe(first.transfer.id);
  });

  it('claims a created transfer only once before external burn execution', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'transfer-claim-1',
    });

    const firstClaim = await transferStore.claimCreated(transfer.id);
    const secondClaim = await transferStore.claimCreated(transfer.id);

    expect(firstClaim?.status).toBe('burning');
    expect(secondClaim).toBeNull();
  });

  it('includes hl_depositing transfers in boot recovery', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'transfer-hl-recovery-1',
      toBucket: 'perps',
    });
    await transferStore.update(transfer.id, { status: 'hl_depositing' });

    const midFlight = await transferStore.listMidFlight();

    expect(midFlight.map((t) => t.id)).toContain(transfer.id);
  });

  /**
   * F091 Sprint 18 — Mid-flight replay safety. A client retry of POST
   * /transfers/internal with the same Idempotency-Key while the original
   * transfer is in `attesting` (or any other non-terminal state) must get
   * the existing row back unchanged, NOT trigger a second burn / mint /
   * deposit. The route layer uses `fresh: false` from `create()` to skip
   * the worker re-enqueue; this spec is the row-level guarantee.
   */
  it('replay mid-flight (status=attesting) returns the same row with no status regression', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'transfer-midflight-replay-1',
    });
    await transferStore.update(transfer.id, { status: 'attesting' });

    const replay = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'transfer-midflight-replay-1',
    });

    expect(replay.fresh).toBe(false);
    expect(replay.transfer.id).toBe(transfer.id);
    expect(replay.transfer.status).toBe('attesting');
  });

  it('replay mid-flight (status=hl_depositing) returns the same row', async () => {
    const { transfer } = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'transfer-midflight-replay-2',
      toBucket: 'perps',
    });
    await transferStore.update(transfer.id, { status: 'hl_depositing' });

    const replay = await transferStore.create({
      ...baseTransfer,
      idempotencyKey: 'transfer-midflight-replay-2',
      toBucket: 'perps',
    });

    expect(replay.fresh).toBe(false);
    expect(replay.transfer.id).toBe(transfer.id);
    expect(replay.transfer.status).toBe('hl_depositing');
  });
});

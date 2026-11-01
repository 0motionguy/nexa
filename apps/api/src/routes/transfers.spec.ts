import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { issueToken } from '../lib/auth.js';
import * as balances from '../lib/chain/balances.js';
import { executor } from '../lib/chain/alchemy.js';
import * as hlBridge from '../lib/chain/hl-bridge.js';
import { walletService } from '../lib/chain/wallet.js';
import { env, features } from '../lib/env.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import { hyperliquidSpot } from '../lib/markets/hyperliquid-spot.js';
import { store } from '../store/index.js';
import { transferStore } from '../store/transfers.js';
import * as bridgeWorker from '../workers/bridge-worker.js';

const mutableFeatures = features as unknown as { alchemy: boolean; chain: boolean; privy: boolean; redis: boolean };
const originalFeatures = {
  alchemy: mutableFeatures.alchemy,
  chain: mutableFeatures.chain,
  privy: mutableFeatures.privy,
  redis: mutableFeatures.redis,
};

// env is a Zod-parsed const at runtime; tests mutate it via a typed cast so the
// route handler reads the test value through the same env import path.
const mutableEnv = env as unknown as {
  DEMO_MODE: boolean;
  NEO_BRIDGE_FEE_BPS: number;
  NEO_BRIDGE_TREASURY_ARB?: string;
  NEO_BRIDGE_TREASURY_POL?: string;
  NEO_BRIDGE_TREASURY_BASE?: string;
  NEO_BRIDGE_TREASURY_SOL?: string;
};
const originalBridgeFee = {
  demoMode: mutableEnv.DEMO_MODE,
  bps: mutableEnv.NEO_BRIDGE_FEE_BPS,
  arb: mutableEnv.NEO_BRIDGE_TREASURY_ARB,
  pol: mutableEnv.NEO_BRIDGE_TREASURY_POL,
  base: mutableEnv.NEO_BRIDGE_TREASURY_BASE,
  sol: mutableEnv.NEO_BRIDGE_TREASURY_SOL,
};

const buckets = ['cash', 'perps', 'predictions', 'memes'] as const;

const expectedRails: Record<string, 'cctp' | 'mayan'> = {
  'cash->perps': 'cctp',
  'cash->predictions': 'cctp',
  'cash->memes': 'mayan',
  'perps->cash': 'cctp',
  'perps->predictions': 'cctp',
  'perps->memes': 'mayan',
  'predictions->cash': 'cctp',
  'predictions->perps': 'cctp',
  'predictions->memes': 'mayan',
  'memes->cash': 'mayan',
  'memes->perps': 'mayan',
  'memes->predictions': 'mayan',
};

function setLiveTransferFeatures(): void {
  mutableFeatures.alchemy = true;
  mutableFeatures.chain = true;
  mutableFeatures.privy = true;
  mutableFeatures.redis = true;
}

async function authHeaders(email: string, opts: { privyDid?: string | null } = {}): Promise<Record<string, string>> {
  const user = await store.upsertUserByEmail(email, undefined, opts);
  const { token } = await issueToken(user);
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

beforeEach(() => {
  transferStore._resetForTests();
  mutableFeatures.redis = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  mutableFeatures.alchemy = originalFeatures.alchemy;
  mutableFeatures.chain = originalFeatures.chain;
  mutableFeatures.privy = originalFeatures.privy;
  mutableFeatures.redis = originalFeatures.redis;
  mutableEnv.DEMO_MODE = originalBridgeFee.demoMode;
  mutableEnv.NEO_BRIDGE_FEE_BPS = originalBridgeFee.bps;
  mutableEnv.NEO_BRIDGE_TREASURY_ARB = originalBridgeFee.arb;
  mutableEnv.NEO_BRIDGE_TREASURY_POL = originalBridgeFee.pol;
  mutableEnv.NEO_BRIDGE_TREASURY_BASE = originalBridgeFee.base;
  mutableEnv.NEO_BRIDGE_TREASURY_SOL = originalBridgeFee.sol;
});

describe('/transfers/internal', () => {
  beforeEach(() => {
    // The source-balance pre-check reads live wallets + balances; default every
    // source to well-funded so rail/idempotency tests exercise their own
    // concern. Tests for the pre-check itself override these per-case.
    vi.spyOn(walletService, 'getOrCreateUserWallet').mockResolvedValue({
      address: '0x00000000000000000000000000000000000000a1',
      walletId: 'w_test',
      live: true,
    } as any);
    vi.spyOn(walletService, 'getOrCreateUserSolanaWallet').mockResolvedValue({
      address: 'So11111111111111111111111111111111111111112',
      walletId: 'w_test_sol',
      live: true,
    } as any);
    vi.spyOn(balances, 'getUsdcEvmBalance').mockResolvedValue(1_000_000);
    vi.spyOn(balances, 'getUsdcSolanaBalance').mockResolvedValue(1_000_000);
    vi.spyOn(hyperliquid, 'getUserState').mockResolvedValue({
      equityUsd: 1_000_000,
      marginUsedUsd: 0,
      withdrawableUsd: 1_000_000,
      accountValueUsd: 1_000_000,
      positions: [],
    });
  });

  it('routes every supported bucket pair to CCTP or Mayan', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-matrix@example.com', { privyDid: 'did:privy:transfer-matrix' });

    for (const fromBucket of buckets) {
      for (const toBucket of buckets) {
        if (fromBucket === toBucket) continue;
        const key = `${fromBucket}->${toBucket}`;
        const res = await app.request('/transfers/internal', {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': `matrix-${key}` },
          body: JSON.stringify({ fromBucket, toBucket, amountUsd: 25 }),
        });
        expect(res.status, key).toBe(200);
        const body = await res.json();
        expect(body.rail, key).toBe(expectedRails[key]);
        // F101 — perps-source legs start at the HL-withdrawal hop (funds sit
        // on HL L1 and must reach the EOA before any burn/swap can spend them).
        expect(body.status, key).toBe(fromBucket === 'perps' ? 'hl_withdrawing' : 'created');
      }
    }
  });

  it('rejects same-bucket transfers before creating state', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-same-bucket@example.com', { privyDid: 'did:privy:transfer-same-bucket' });

    for (const bucket of buckets) {
      const res = await app.request('/transfers/internal', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': `same-${bucket}` },
        body: JSON.stringify({ fromBucket: bucket, toBucket: bucket, amountUsd: 25 }),
      });
      expect(res.status, bucket).toBe(400);
      expect((await res.json()).error.message, bucket).toBe('same_bucket');
    }
    const user = await store.upsertUserByEmail('transfer-same-bucket@example.com');
    expect(await transferStore.listByUser(user.id)).toEqual([]);
  });

  it('requires an idempotency key before creating live transfer state', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-missing-idem@example.com', { privyDid: 'did:privy:transfer-missing-idem' });
    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('idempotency_key_required');
    const user = await store.upsertUserByEmail('transfer-missing-idem@example.com');
    expect(await transferStore.listByUser(user.id)).toEqual([]);
  });

  it('fails closed when live CCTP execution prerequisites are unavailable', async () => {
    mutableEnv.DEMO_MODE = false;
    mutableFeatures.redis = true;
    const headers = await authHeaders('transfer-exec-unavailable@example.com');
    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-exec-unavailable-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('transfer_execution_unavailable');
    const user = await store.upsertUserByEmail('transfer-exec-unavailable@example.com');
    expect(await transferStore.listByUser(user.id)).toEqual([]);
  });

  it('returns a demo transfer receipt when execution prerequisites are unavailable in demo mode', async () => {
    mutableEnv.DEMO_MODE = true;
    mutableFeatures.alchemy = false;
    mutableFeatures.chain = false;
    mutableFeatures.privy = false;
    mutableFeatures.redis = false;
    const headers = await authHeaders('transfer-demo@example.com');

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-demo-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('complete');
    expect(body.rail).toBe('cctp');
    expect(body.sourced.source).toBe('provider-demo');
    const user = await store.upsertUserByEmail('transfer-demo@example.com');
    const transfers = await transferStore.listByUser(user.id);
    expect(transfers[0]?.status).toBe('complete');
  });

  it('rejects perps deposits below the Hyperliquid Bridge2 minimum from every source bucket', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-perps-min@example.com', { privyDid: 'did:privy:transfer-perps-min' });

    for (const fromBucket of buckets.filter((bucket) => bucket !== 'perps')) {
      const res = await app.request('/transfers/internal', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': `transfer-perps-min-${fromBucket}` },
        body: JSON.stringify({ fromBucket, toBucket: 'perps', amountUsd: 4.99 }),
      });

      expect(res.status, fromBucket).toBe(400);
      expect((await res.json()).error.message, fromBucket).toBe('transfer_amount_below_perps_min');
    }
    const user = await store.upsertUserByEmail('transfer-perps-min@example.com');
    expect(await transferStore.listByUser(user.id)).toEqual([]);
  });

  it('nets the HL withdraw fee and starts perps-source transfers at hl_withdrawing', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-perps-src@example.com', { privyDid: 'did:privy:transfer-perps-src' });

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-perps-src-1' },
      body: JSON.stringify({ fromBucket: 'perps', toBucket: 'cash', amountUsd: 25 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('hl_withdrawing');
    const user = await store.upsertUserByEmail('transfer-perps-src@example.com');
    const [row] = await transferStore.listByUser(user.id);
    expect(row?.status).toBe('hl_withdrawing');
    expect(row?.amountUsd).toBe(25);
    // $25 gross - $1 HL withdraw fee (NEO fee 0 bps by default) = $24 burn:
    // the EOA arrival ($24) always covers the burn exactly.
    expect(row?.amountTokenAtoms).toBe('24000000');
  });

  it('rejects perps-source transfers below the HL withdrawal minimum', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-perps-src-min@example.com', { privyDid: 'did:privy:transfer-perps-src-min' });

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-perps-src-min-1' },
      body: JSON.stringify({ fromBucket: 'perps', toBucket: 'cash', amountUsd: 1.5 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('transfer_amount_below_hl_withdraw_min');
    const user = await store.upsertUserByEmail('transfer-perps-src-min@example.com');
    expect(await transferStore.listByUser(user.id)).toEqual([]);
  });

  it('rejects an underfunded EVM-source transfer before creating state', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-underfunded@example.com', { privyDid: 'did:privy:transfer-underfunded' });
    vi.spyOn(balances, 'getUsdcEvmBalance').mockResolvedValue(10);

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-underfunded-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('insufficient_source_balance');
    expect(body.error.details.availableUsd).toBe(10);
    expect(body.error.details.requestedUsd).toBe(25);
    expect(body.error.details.bucket).toBe('cash');
    const user = await store.upsertUserByEmail('transfer-underfunded@example.com');
    expect(await transferStore.listByUser(user.id)).toEqual([]);
  });

  it('rejects a perps-source transfer exceeding HL withdrawable', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-hl-underfunded@example.com', { privyDid: 'did:privy:transfer-hl-underfunded' });
    vi.spyOn(hyperliquid, 'getUserState').mockResolvedValue({
      equityUsd: 40,
      marginUsedUsd: 35,
      withdrawableUsd: 5,
      accountValueUsd: 40,
      positions: [],
    });

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-hl-underfunded-1' },
      body: JSON.stringify({ fromBucket: 'perps', toBucket: 'cash', amountUsd: 25 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('insufficient_source_balance');
    expect(body.error.details.availableUsd).toBe(5);
    expect(body.error.details.bucket).toBe('perps');
  });

  it('rejects an underfunded Solana-source transfer before creating state', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-sol-underfunded@example.com', { privyDid: 'did:privy:transfer-sol-underfunded' });
    vi.spyOn(balances, 'getUsdcSolanaBalance').mockResolvedValue(1);

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-sol-underfunded-1' },
      body: JSON.stringify({ fromBucket: 'memes', toBucket: 'cash', amountUsd: 25 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('insufficient_source_balance');
  });

  it('fails closed when the source balance read is unavailable', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-balread-down@example.com', { privyDid: 'did:privy:transfer-balread-down' });
    vi.spyOn(balances, 'getUsdcEvmBalance').mockResolvedValue(null);

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-balread-down-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('balance_read_unavailable');
  });

  it('skips the source-balance pre-check on idempotent replay of an in-flight transfer', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-replay-drained@example.com', { privyDid: 'did:privy:transfer-replay-drained' });
    const replayHeaders = { ...headers, 'Idempotency-Key': 'transfer-replay-drained-1' };
    const body = JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 });

    const first = await app.request('/transfers/internal', { method: 'POST', headers: replayHeaders, body });
    expect(first.status).toBe(200);

    // Funds have since left the source wallet (mid-flight burn). The replay
    // must still return the original transfer, not a 400.
    vi.spyOn(balances, 'getUsdcEvmBalance').mockResolvedValue(0);
    const replay = await app.request('/transfers/internal', { method: 'POST', headers: replayHeaders, body });
    expect(replay.status).toBe(200);
    expect((await replay.json()).idempotent).toBe(true);
  });

  it('creates a CCTP transfer, preserves idempotency, and exposes only owner-readable state', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-success@example.com', { privyDid: 'did:privy:transfer-success' });
    const replayHeaders = { ...headers, 'Idempotency-Key': 'transfer-success-1' };
    const body = JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 });

    const first = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);
    expect(firstBody.status).toBe('created');
    expect(firstBody.rail).toBe('cctp');
    expect(firstBody.idempotent).toBe(false);
    expect(firstBody.transferId).toMatch(/^tr_/);

    const replay = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body,
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.transferId).toBe(firstBody.transferId);
    expect(replayBody.idempotent).toBe(true);

    const ownerRead = await app.request(`/transfers/${firstBody.transferId}`, { headers });
    expect(ownerRead.status).toBe(200);
    const ownerBody = await ownerRead.json();
    expect(ownerBody.transfer.amountUsd).toBe(25);
    expect(ownerBody.transfer.fromBucket).toBe('cash');
    expect(ownerBody.transfer.toBucket).toBe('predictions');
    expect(ownerBody.events.map((event: { eventType: string }) => event.eventType)).toContain('created');

    const otherHeaders = await authHeaders('transfer-other@example.com');
    const otherRead = await app.request(`/transfers/${firstBody.transferId}`, { headers: otherHeaders });
    expect(otherRead.status).toBe(404);
    expect((await otherRead.json()).error.message).toBe('transfer_not_found');
  });

  it('rejects idempotency replay with different transfer payload', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-idem-conflict@example.com', { privyDid: 'did:privy:transfer-idem-conflict' });
    const replayHeaders = { ...headers, 'Idempotency-Key': 'transfer-conflict-1' };

    const first = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }),
    });
    expect(first.status).toBe(200);

    const replay = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 26 }),
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error.message).toBe('idempotency_key_reused');
  });

  it('rejects idempotency replay of a failed transfer row', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-idem-failed@example.com', { privyDid: 'did:privy:transfer-idem-failed' });
    const replayHeaders = { ...headers, 'Idempotency-Key': 'transfer-failed-replay-1' };
    const payload = JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 });

    const first = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body: payload,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    await transferStore.update(firstBody.transferId, { status: 'failed', error: { code: 'test_failed' } });

    const replay = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body: payload,
    });

    expect(replay.status).toBe(409);
    expect((await replay.json()).error.message).toBe('idempotency_key_used');
  });

  it('re-enqueues a still-created transfer on idempotent replay', async () => {
    setLiveTransferFeatures();
    const enqueueSpy = vi.spyOn(bridgeWorker, 'enqueueTransferProgress').mockResolvedValue(undefined);
    const headers = await authHeaders('transfer-replay-reenqueue@example.com', { privyDid: 'did:privy:transfer-replay-reenqueue' });
    const replayHeaders = { ...headers, 'Idempotency-Key': 'transfer-replay-reenqueue-1' };
    const payload = JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 });

    const first = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body: payload,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.idempotent).toBe(false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    const replay = await app.request('/transfers/internal', {
      method: 'POST',
      headers: replayHeaders,
      body: payload,
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.idempotent).toBe(true);
    expect(replayBody.transferId).toBe(firstBody.transferId);
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy).toHaveBeenLastCalledWith(firstBody.transferId, 0, 0, true);
  });

  it('creates a Mayan transfer for Solana bucket moves when live prerequisites are available', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-mayan@example.com', { privyDid: 'did:privy:transfer-mayan' });
    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-mayan-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'memes', amountUsd: 25 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.rail).toBe('mayan');
    expect(body.status).toBe('created');
    const user = await store.upsertUserByEmail('transfer-mayan@example.com');
    const transfers = await transferStore.listByUser(user.id);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.rail).toBe('mayan');
  });

  it('accepts stocks-spot as a Solana spot transfer bucket', async () => {
    setLiveTransferFeatures();
    const headers = await authHeaders('transfer-xstocks-spot@example.com', { privyDid: 'did:privy:transfer-xstocks-spot' });

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-xstocks-spot-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'stocks-spot', amountUsd: 25 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rail).toBe('mayan');
    expect(body.toBucket).toBe('stocks-spot');
    const user = await store.upsertUserByEmail('transfer-xstocks-spot@example.com');
    const transfers = await transferStore.listByUser(user.id);
    expect(transfers[0]?.toBucket).toBe('stocks-spot');
    expect(transfers[0]?.toChain).toBe('solana');
  });

  it('skims NEO_BRIDGE_FEE_BPS on CCTP burns when treasury is configured', async () => {
    setLiveTransferFeatures();
    mutableEnv.NEO_BRIDGE_FEE_BPS = 10; // 0.10%
    mutableEnv.NEO_BRIDGE_TREASURY_BASE = '0xfeeFEEfee0000000000000000000000000000000';
    const headers = await authHeaders('transfer-fee@example.com', { privyDid: 'did:privy:transfer-fee' });
    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-fee-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 100 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeBps).toBe(10);
    expect(body.feeUsd).toBe(0.1);
    expect(body.requestedUsd).toBe(100);
    // amountUsd in the response = net the user receives (gross - skim).
    expect(body.amountUsd).toBe(99.9);

    const user = await store.upsertUserByEmail('transfer-fee@example.com');
    const transfers = await transferStore.listByUser(user.id);
    expect(transfers).toHaveLength(1);
    // Row stores GROSS amountUsd; bridge worker reads feesUsd to compute the
    // skim atoms and batches USDC.transfer(treasury, fee) + CCTP burn(net).
    expect(transfers[0]?.amountUsd).toBe(100);
    expect(transfers[0]?.feesUsd).toBe(0.1);
    expect(transfers[0]?.amountTokenAtoms).toBe('99900000');
  });

  it('passes through full amount when NEO_BRIDGE_FEE_BPS=0 (default)', async () => {
    setLiveTransferFeatures();
    mutableEnv.NEO_BRIDGE_FEE_BPS = 0;
    mutableEnv.NEO_BRIDGE_TREASURY_BASE = '0xfeeFEEfee0000000000000000000000000000000';
    const headers = await authHeaders('transfer-nofee@example.com', { privyDid: 'did:privy:transfer-nofee' });
    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-nofee-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 100 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeUsd).toBe(0);
    expect(body.amountUsd).toBe(100);
  });

  it('skips the skim when NEO_BRIDGE_FEE_BPS>0 but the source-chain treasury is unset', async () => {
    setLiveTransferFeatures();
    mutableEnv.NEO_BRIDGE_FEE_BPS = 10;
    mutableEnv.NEO_BRIDGE_TREASURY_BASE = undefined; // cash bucket lives on base
    const headers = await authHeaders('transfer-partial@example.com', { privyDid: 'did:privy:transfer-partial' });
    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-partial-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 100 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeUsd).toBe(0);
    expect(body.amountUsd).toBe(100);
  });

  it('rejects CCTP transfers when Redis cannot run the worker', async () => {
    mutableFeatures.alchemy = true;
    mutableFeatures.chain = true;
    mutableFeatures.privy = true;
    mutableFeatures.redis = false;
    const headers = await authHeaders('transfer-redis@example.com', { privyDid: 'did:privy:transfer-redis' });
    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-redis-1' },
      body: JSON.stringify({ fromBucket: 'perps', toBucket: 'predictions', amountUsd: 25 }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('transfer_queue_unavailable');
  });

  it('marks a fresh transfer failed when queue enqueue fails after row creation', async () => {
    setLiveTransferFeatures();
    vi.spyOn(bridgeWorker, 'enqueueTransferProgress').mockRejectedValueOnce(new Error('redis write failed'));
    const headers = await authHeaders('transfer-enqueue-throws@example.com', { privyDid: 'did:privy:transfer-enqueue-throws' });

    const res = await app.request('/transfers/internal', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'transfer-enqueue-throws-1' },
      body: JSON.stringify({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('transfer_queue_unavailable');
    const user = await store.upsertUserByEmail('transfer-enqueue-throws@example.com');
    const transfers = await transferStore.listByUser(user.id);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.status).toBe('failed');
    expect(transfers[0]?.error).toMatchObject({ code: 'transfer_queue_unavailable' });
  });
});

describe('/transfers/hl-deposit', () => {
  it('requires an explicit idempotency key before live execution checks', async () => {
    const headers = await authHeaders('hl-deposit-missing-idem@example.com');
    const res = await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 10 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('idempotency_key_required');
  });

  it('replays Idempotency-Key without a second HL Bridge2 submit', async () => {
    setLiveTransferFeatures();
    vi.spyOn(walletService, 'getOrCreateUserWallet').mockResolvedValue({
      address: '0x00000000000000000000000000000000000000a1',
    } as any);
    vi.spyOn(balances, 'getUsdcEvmBalance').mockResolvedValue(50);
    const submit = vi.spyOn(hlBridge, 'executeHlBridge2Deposit').mockResolvedValue({
      callId: 'hl_direct_call_1',
      demo: false,
    });
    const headers = await authHeaders('hl-deposit-replay@example.com', { privyDid: 'did:privy:hl-deposit-replay' });
    const replayHeaders = { ...headers, 'Idempotency-Key': 'hl-deposit-replay-1' };
    const payload = JSON.stringify({ amountUsd: 10 });

    const first = await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers: replayHeaders,
      body: payload,
    });
    const replay = await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers: replayHeaders,
      body: payload,
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = await first.json();
    const replayBody = await replay.json();
    expect(firstBody.callId).toBe('hl_direct_call_1');
    expect(firstBody.idempotent).toBe(false);
    expect(replayBody.callId).toBe('hl_direct_call_1');
    expect(replayBody.transferId).toBe(firstBody.transferId);
    expect(replayBody.idempotent).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('returns a demo HL deposit receipt when execution prerequisites are unavailable in demo mode', async () => {
    mutableEnv.DEMO_MODE = true;
    mutableFeatures.alchemy = false;
    mutableFeatures.chain = false;
    mutableFeatures.privy = false;
    const headers = await authHeaders('hl-deposit-demo@example.com');

    const res = await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'hl-deposit-demo-1' },
      body: JSON.stringify({ amountUsd: 5 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.demo).toBe(true);
    expect(body.status).toBe('complete');
    expect(body.callId).toMatch(/^hl_demo_deposit_/);
    expect(body.sourced.source).toBe('provider-demo');
  });

  it('fails closed when HL deposit execution prerequisites are unavailable outside demo mode', async () => {
    mutableEnv.DEMO_MODE = false;
    mutableFeatures.alchemy = false;
    mutableFeatures.chain = false;
    mutableFeatures.privy = false;
    const headers = await authHeaders('hl-deposit-unavailable@example.com');

    const res = await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'hl-deposit-unavailable-1' },
      body: JSON.stringify({ amountUsd: 5 }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('hl_deposit_unavailable');
  });

  it('rejects HL deposit Idempotency-Key replay with a different amount', async () => {
    setLiveTransferFeatures();
    vi.spyOn(walletService, 'getOrCreateUserWallet').mockResolvedValue({
      address: '0x00000000000000000000000000000000000000a1',
    } as any);
    vi.spyOn(balances, 'getUsdcEvmBalance').mockResolvedValue(50);
    const submit = vi.spyOn(hlBridge, 'executeHlBridge2Deposit').mockResolvedValue({
      callId: 'hl_direct_call_conflict',
      demo: false,
    });
    const headers = await authHeaders('hl-deposit-conflict@example.com', { privyDid: 'did:privy:hl-deposit-conflict' });
    const replayHeaders = { ...headers, 'Idempotency-Key': 'hl-deposit-conflict-1' };

    await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers: replayHeaders,
      body: JSON.stringify({ amountUsd: 10 }),
    });
    const replay = await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers: replayHeaders,
      body: JSON.stringify({ amountUsd: 11 }),
    });

    expect(replay.status).toBe(409);
    expect((await replay.json()).error.message).toBe('idempotency_key_reused');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('/transfers/external', () => {
  it('returns a demo Base USDC wallet-send receipt when live execution is unavailable in demo mode', async () => {
    mutableEnv.DEMO_MODE = true;
    mutableFeatures.alchemy = false;
    mutableFeatures.chain = false;
    mutableFeatures.privy = false;
    const sendCalls = vi.spyOn(executor, 'sendCalls');
    const headers = await authHeaders('external-transfer-demo@example.com');

    const res = await app.request('/transfers/external', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'external-demo-1' },
      body: JSON.stringify({
        chain: 'base',
        destinationAddress: '0x1111111111111111111111111111111111111111',
        amountUsd: 12.5,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      chain: 'base',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      amountUsd: 12.5,
      demo: true,
      status: 'complete',
      idempotent: false,
    });
    expect(body.transferId).toMatch(/^tr_/);
    expect(body.txHash).toMatch(/^0xdemo/);
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it('fails closed outside demo when wallet execution is unavailable', async () => {
    mutableEnv.DEMO_MODE = false;
    mutableFeatures.alchemy = false;
    mutableFeatures.chain = false;
    mutableFeatures.privy = false;
    const headers = await authHeaders('external-transfer-unavailable@example.com');

    const res = await app.request('/transfers/external', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'external-unavailable-1' },
      body: JSON.stringify({
        chain: 'base',
        destinationAddress: '0x1111111111111111111111111111111111111111',
        amountUsd: 12.5,
      }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('external_transfer_unavailable');
    const user = await store.upsertUserByEmail('external-transfer-unavailable@example.com');
    expect(await transferStore.listByUser(user.id)).toEqual([]);
  });

  it('rejects idempotency replay with a different destination address', async () => {
    mutableEnv.DEMO_MODE = true;
    mutableFeatures.alchemy = false;
    mutableFeatures.chain = false;
    mutableFeatures.privy = false;
    const headers = await authHeaders('external-transfer-replay@example.com');
    const replayHeaders = { ...headers, 'Idempotency-Key': 'external-replay-1' };

    await app.request('/transfers/external', {
      method: 'POST',
      headers: replayHeaders,
      body: JSON.stringify({
        chain: 'base',
        destinationAddress: '0x1111111111111111111111111111111111111111',
        amountUsd: 12.5,
      }),
    });
    const replay = await app.request('/transfers/external', {
      method: 'POST',
      headers: replayHeaders,
      body: JSON.stringify({
        chain: 'base',
        destinationAddress: '0x2222222222222222222222222222222222222222',
        amountUsd: 12.5,
      }),
    });

    expect(replay.status).toBe(409);
    expect((await replay.json()).error.message).toBe('idempotency_key_reused');
  });
});

describe('/balances and deposit addresses', () => {
  it('returns user wallet-backed balance buckets', async () => {
    const headers = await authHeaders('balances@example.com');
    const res = await app.request('/balances', { headers });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.buckets.cash.chain).toBe('base');
    expect(body.buckets.perps.chain).toBe('arbitrum');
    expect(body.buckets.predictions.chain).toBe('polygon');
    expect(body.buckets.memes.chain).toBe('solana');
    expect(body.wallets.evm).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(typeof body.wallets.solana).toBe('string');
  });

  it('includes Hyperliquid Spot USDC in the perps bucket and total', async () => {
    const headers = await authHeaders('balances-hl-spot@example.com');
    const getUserState = vi.spyOn(hyperliquidSpot, 'getUserState').mockResolvedValueOnce({
      usdcUsd: 15.118582,
      balances: [{ coin: 'USDC', total: 15.118582, hold: 0, entryNtl: null }],
      live: true,
    });

    const res = await app.request('/balances', { headers });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(getUserState).toHaveBeenCalledWith(expect.stringMatching(/^0x[a-fA-F0-9]{40}$/));
    expect(body.buckets.perps.usd).toBe(15.118582);
    expect(body.buckets.perps.sources).toEqual({ arbitrum: 0, hyperliquidSpot: 15.118582 });
    expect(body.byChain.hyperliquidSpot).toBe(15.118582);
    expect(body.totalUsd).toBe(15.118582);
  });

  it('returns a bucket-specific onramp deposit address', async () => {
    const headers = await authHeaders('deposit-address@example.com');
    const res = await app.request('/transfers/onramp/deposit-address?bucket=memes', { headers });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.bucket).toBe('memes');
    expect(body.bucketLabel).toBe('Memes · Solana');
    expect(body.chain).toBe('solana');
    expect(body.token).toBe('USDC');
    expect(typeof body.address).toBe('string');
  });

  it('returns a Solana onramp deposit address for xStocks spot', async () => {
    const headers = await authHeaders('deposit-address-xstocks@example.com');
    const res = await app.request('/transfers/onramp/deposit-address?bucket=stocks-spot', { headers });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.bucket).toBe('stocks-spot');
    expect(body.bucketLabel).toBe('xStocks · Solana');
    expect(body.chain).toBe('solana');
    expect(body.token).toBe('USDC');
    expect(typeof body.address).toBe('string');
  });
});

/* ── P1 money-path hardening (wave4) ────────────────────────────────────────
 *
 * Write-ahead call ids, fail-after-dispatch discipline, in-flight dedupe and
 * the per-user transfer rate budget. Each test pins a pre-fix failure mode:
 * unknown-outcome submits were marked failed (burning the client intent key
 * → rotate → double send), definite sign failures fell through as COMPLETE
 * (external) / wedged hl_depositing-with-empty-callid (hl-deposit), and the
 * create() race loser 409'd instead of replaying.
 */
describe('P1 money-path hardening (wave4)', () => {
  const DEST = '0x1111111111111111111111111111111111111111';

  function mockLiveMoneyPath(): void {
    setLiveTransferFeatures();
    mutableEnv.DEMO_MODE = false;
    vi.spyOn(walletService, 'getOrCreateUserWallet').mockResolvedValue({
      address: '0x00000000000000000000000000000000000000a1',
      live: true,
    } as any);
    vi.spyOn(balances, 'getUsdcEvmBalance').mockResolvedValue(1_000);
  }

  it('external: unknown-outcome submit stays created with the write-ahead call id and replays without a second dispatch', async () => {
    mockLiveMoneyPath();
    const sendCalls = vi.spyOn(executor, 'sendCalls').mockResolvedValue({
      txHash: '0xdemo00000000000000000000000000000000feed',
      demo: true,
      submittedUnknown: true,
      sponsored: false,
    });
    const headers = await authHeaders('external-unknown@example.com', { privyDid: 'did:privy:external-unknown' });
    const reqInit = {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'external-unknown-1' },
      body: JSON.stringify({ chain: 'base', destinationAddress: DEST, amountUsd: 12.5 }),
    };

    const res = await app.request('/transfers/external', reqInit);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Accepted-pending, NOT failed: marking maybe-sent rows failed burns the
    // client intent key → rotate → double send (the pre-fix bug).
    expect(body).toMatchObject({ ok: true, status: 'created', submittedUnknown: true, txHash: null, demo: false });

    const user = await store.upsertUserByEmail('external-unknown@example.com');
    const [row] = await transferStore.listByUser(user.id);
    expect(row?.status).toBe('created');
    // Write-ahead executor key survives as the reconciliation handle.
    expect(row?.srcCallId).toBe(`${body.transferId}:external`);

    // Same-key replay lands on the pending row — no second dispatch, no 409.
    const replay = await app.request('/transfers/external', reqInit);
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.idempotent).toBe(true);
    expect(replayBody.transferId).toBe(body.transferId);
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it('external: definite sign failure marks the row failed — never complete-with-empty-callid', async () => {
    mockLiveMoneyPath();
    vi.spyOn(executor, 'sendCalls').mockResolvedValue({
      txHash: '',
      demo: false,
      sponsored: false,
      failed: true,
      failureCode: 'server_signing_unavailable',
    });
    const headers = await authHeaders('external-signfail@example.com', { privyDid: 'did:privy:external-signfail' });

    const res = await app.request('/transfers/external', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'external-signfail-1' },
      body: JSON.stringify({ chain: 'base', destinationAddress: DEST, amountUsd: 12.5 }),
    });

    // Pre-fix: signFailure (demo:false, failed:true) fell through to the
    // completion path and recorded status 'complete' with an empty call id
    // for money that never moved.
    expect(res.status).toBe(503);
    const user = await store.upsertUserByEmail('external-signfail@example.com');
    const [row] = await transferStore.listByUser(user.id);
    expect(row?.status).toBe('failed');
    expect(row?.srcCallId).toBeNull();
  });

  it('external: create() race loser replays the winner row instead of 409-burning the key', async () => {
    mockLiveMoneyPath();
    const sendCalls = vi.spyOn(executor, 'sendCalls').mockResolvedValue({
      txHash: '0xabc0000000000000000000000000000000000001',
      demo: false,
      sponsored: false,
    });
    const headers = await authHeaders('external-race@example.com', { privyDid: 'did:privy:external-race' });
    const reqInit = {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'external-race-1' },
      body: JSON.stringify({ chain: 'base', destinationAddress: DEST, amountUsd: 12.5 }),
    };

    const first = await app.request('/transfers/external', reqInit);
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // Simulate the loser's interleaving: its pre-create lookup misses (the
    // winner hasn't committed yet from its perspective), so it falls through
    // to create() and loses the (userId, idempotencyKey) insert race.
    vi.spyOn(transferStore, 'findByUserIdempotencyKey').mockResolvedValueOnce(null);
    const race = await app.request('/transfers/external', reqInit);
    expect(race.status).toBe(200);
    const raceBody = await race.json();
    expect(raceBody.idempotent).toBe(true);
    expect(raceBody.transferId).toBe(firstBody.transferId);
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it('hl-deposit: unknown-outcome submit stays created (not hl_depositing/failed) and replays without a second submit', async () => {
    mockLiveMoneyPath();
    const submit = vi.spyOn(hlBridge, 'executeHlBridge2Deposit').mockResolvedValue({
      callId: '0xdemo00000000000000000000000000000000feed',
      demo: true,
      submittedUnknown: true,
    });
    const headers = await authHeaders('hl-unknown@example.com', { privyDid: 'did:privy:hl-unknown' });
    const reqInit = {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'hl-unknown-1' },
      body: JSON.stringify({ amountUsd: 10 }),
    };

    const res = await app.request('/transfers/hl-deposit', reqInit);
    expect(res.status).toBe(200);
    const body = await res.json();
    // 'created', not 'hl_depositing': there is no pollable callId, so the
    // poller state would wedge on an empty id; and not 'failed', which would
    // burn the client key.
    expect(body).toMatchObject({ ok: true, status: 'created', submittedUnknown: true, callId: null });

    const user = await store.upsertUserByEmail('hl-unknown@example.com');
    const [row] = await transferStore.listByUser(user.id);
    expect(row?.status).toBe('created');
    expect(row?.dstCallId).toBe(`${body.transferId}:hl-deposit`);

    const replay = await app.request('/transfers/hl-deposit', reqInit);
    expect(replay.status).toBe(200);
    expect((await replay.json()).idempotent).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('hl-deposit: definite sign failure fails the row — never hl_depositing with an empty call id', async () => {
    mockLiveMoneyPath();
    vi.spyOn(hlBridge, 'executeHlBridge2Deposit').mockResolvedValue({
      callId: '',
      demo: false,
      failed: true,
      failureCode: 'server_signing_unavailable',
    });
    const headers = await authHeaders('hl-signfail@example.com', { privyDid: 'did:privy:hl-signfail' });

    const res = await app.request('/transfers/hl-deposit', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'hl-signfail-1' },
      body: JSON.stringify({ amountUsd: 10 }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('hl_deposit_unavailable');
    const user = await store.upsertUserByEmail('hl-signfail@example.com');
    const [row] = await transferStore.listByUser(user.id);
    expect(row?.status).toBe('failed');
    expect(row?.dstCallId).toBeNull();
  });

  it('rate-limits transfer POSTs per user across the money routes', async () => {
    const limiterEnv = env as unknown as { RATE_LIMIT_ENABLED: boolean };
    const original = limiterEnv.RATE_LIMIT_ENABLED;
    limiterEnv.RATE_LIMIT_ENABLED = true;
    try {
      const headers = await authHeaders('transfer-ratelimit@example.com');
      // Budget is 20/min shared across the transfer POSTs; missing-key 400s
      // still consume it (limiter mounts before validation).
      let last = 0;
      for (let i = 0; i < 21; i++) {
        const res = await app.request('/transfers/hl-deposit', {
          method: 'POST',
          headers,
          body: JSON.stringify({ amountUsd: 10 }),
        });
        last = res.status;
      }
      expect(last).toBe(429);
      // Per-user keying: another user's budget is untouched.
      const other = await authHeaders('transfer-ratelimit-other@example.com');
      const otherRes = await app.request('/transfers/hl-deposit', {
        method: 'POST',
        headers: other,
        body: JSON.stringify({ amountUsd: 10 }),
      });
      expect(otherRes.status).toBe(400);
    } finally {
      limiterEnv.RATE_LIMIT_ENABLED = original;
    }
  });
});

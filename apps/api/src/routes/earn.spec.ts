/**
 * Earn route — yoUSD-primary, demo-mode coverage.
 *
 * No chain keys or live APY providers under vitest, so /apy must not present a
 * demo percentage as real yield. Deposit/withdraw still settle against the
 * ledger only (source 'ledger', txHash null). Boots the real Hono app on an
 * ephemeral port, same harness as api.spec.ts / bridge.spec.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { mayanAdapter } from '../lib/chain/mayan.js';
import { getChainStack } from '../lib/chain/index.js';
import * as marinade from '../lib/chain/marinade.js';
import { env } from '../lib/env.js';

let server: ServerType;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

let token = '';
const EMAIL = 'earn-tester@example.com';

async function login(): Promise<void> {
  const start = await json('/auth/start', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  token = verify.body.token;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeAll(login);

describe('earn routes (no live APY provider — ledger settlement)', () => {
  it('GET /earn/apy reports unavailable instead of serving a demo APY', async () => {
    const { status, body } = await json('/earn/apy', { headers: authed() });
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('apy_unavailable');
  });

  it('GET /earn/protocols marks adapters unavailable when live rates cannot be read', async () => {
    const { status, body } = await json('/earn/protocols', { headers: authed() });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.standard.name).toBe('morpho');
    expect(body.standard.available).toBe(false);
    expect(body.higherYield.available).toBe(false);
    expect(body.blendedApy).toBe(0);
    expect(body.adapters).toHaveLength(5);
    expect(body.adapters.every((a: { available: boolean }) => a.available === false)).toBe(true);
  });

  it('POST /earn/deposit moves balUsd→earnUsd and settles on the ledger', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const startBal = before.body.balance.balUsd as number;
    const startEarn = before.body.balance.earnUsd as number;

    const { status, body } = await json('/earn/deposit', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 100 }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.balUsd).toBeCloseTo(startBal - 100);
    expect(body.earnUsd).toBeCloseTo(startEarn + 100);
    expect(body.source).toBe('ledger'); // no chain in demo
    expect(body.txHash).toBeNull();
  });

  it('POST /earn/deposit replays an Idempotency-Key without a second ledger move', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const startBal = before.body.balance.balUsd as number;
    const startEarn = before.body.balance.earnUsd as number;
    const headers = { ...authed(), 'Idempotency-Key': 'earn-deposit-idem-1' };

    const first = await json('/earn/deposit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 35 }),
    });
    const replay = await json('/earn/deposit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 35 }),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(first.body.balUsd).toBeCloseTo(startBal - 35);
    expect(first.body.earnUsd).toBeCloseTo(startEarn + 35);
    expect(replay.body.balUsd).toBeCloseTo(first.body.balUsd);
    expect(replay.body.earnUsd).toBeCloseTo(first.body.earnUsd);
  });

  it('POST /earn/deposit rejects Idempotency-Key replay with a different payload', async () => {
    const headers = { ...authed(), 'Idempotency-Key': 'earn-deposit-idem-conflict-1' };
    await json('/earn/deposit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 20 }),
    });

    const replay = await json('/earn/deposit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 25 }),
    });

    expect(replay.status).toBe(409);
    expect(replay.body.error.message).toBe('idempotency_key_reused');
  });

  it('POST /earn/withdraw reverses the move and stays ledger-only', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const startBal = before.body.balance.balUsd as number;
    const startEarn = before.body.balance.earnUsd as number;

    const { status, body } = await json('/earn/withdraw', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 50 }),
    });
    expect(status).toBe(200);
    expect(body.balUsd).toBeCloseTo(startBal + 50);
    expect(body.earnUsd).toBeCloseTo(startEarn - 50);
    expect(body.source).toBe('ledger');
    expect(body.txHash).toBeNull();
  });

  it('POST /earn/withdraw replays an Idempotency-Key without a second ledger move', async () => {
    const before = await json('/auth/me', { headers: authed() });
    const startBal = before.body.balance.balUsd as number;
    const startEarn = before.body.balance.earnUsd as number;
    const headers = { ...authed(), 'Idempotency-Key': 'earn-withdraw-idem-1' };

    const first = await json('/earn/withdraw', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 25 }),
    });
    const replay = await json('/earn/withdraw', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 25 }),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(first.body.balUsd).toBeCloseTo(startBal + 25);
    expect(first.body.earnUsd).toBeCloseTo(startEarn - 25);
    expect(replay.body.balUsd).toBeCloseTo(first.body.balUsd);
    expect(replay.body.earnUsd).toBeCloseTo(first.body.earnUsd);
  });

  it('rejects an over-balance deposit with 400 insufficient_funds', async () => {
    const { status, body } = await json('/earn/deposit', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountUsd: 999999 }),
    });
    expect(status).toBe(400);
    // F062 — earn.ts migrated PolicyError to ApiError; the policy code now
    // surfaces inside error.details rather than as the raw error string.
    expect(body.error.details.policyCode).toBe('insufficient_funds');
  });

  it('GET /earn/ethena is public so signed-out Earn does not trigger auth redirect', async () => {
    const { status, body } = await json('/earn/ethena');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.depositUrl).toMatch(/ethena\.fi/);
    expect(body.riskCopy).toContain('NEXA never holds');
  });

  it('requires a session', async () => {
    const { status } = await json('/earn/apy');
    expect(status).toBe(401);
  });
});

describe('swap routes (Mayan Solana path)', () => {
  it('POST /swap/execute requires an Idempotency-Key outside demo mode', async () => {
    const originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = false;
    try {
      const res = await json('/swap/execute', {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ amount: 25, direction: 'usd-eur' }),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('idempotency_key_required');
    } finally {
      env.DEMO_MODE = originalDemoMode;
    }
  });

  it('POST /swap/execute replays an Idempotency-Key without a second ledger debit', async () => {
    const headers = { ...authed(), 'Idempotency-Key': 'swap-idem-1' };
    const first = await json('/swap/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amount: 25, direction: 'usd-eur' }),
    });
    const replay = await json('/swap/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amount: 25, direction: 'usd-eur' }),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.balUsd).toBeCloseTo(first.body.balUsd);
  });

  it('POST /swap/execute replays a live bridge Idempotency-Key without a second provider submit', async () => {
    const originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = false;
    const stack = getChainStack();
    const execute = vi.spyOn(stack.bridgeRouter, 'execute').mockResolvedValue({
      txHash: '0xlivebridgeidem',
      demo: false,
      provider: 'lifi',
    });
    const headers = { ...authed(), 'Idempotency-Key': 'swap-bridge-provider-idem-1' };
    try {
      const first = await json('/swap/execute', {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: 25, direction: 'usd-eur' }),
      });
      const replay = await json('/swap/execute', {
        method: 'POST',
        headers,
        body: JSON.stringify({ amount: 25, direction: 'usd-eur' }),
      });

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(first.body.txHash).toBe('0xlivebridgeidem');
      expect(replay.body.txHash).toBe('0xlivebridgeidem');
      expect(replay.body.idempotent).toBe(true);
      expect(replay.body.balUsd).toBeCloseTo(first.body.balUsd);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      env.DEMO_MODE = originalDemoMode;
      execute.mockRestore();
    }
  });

  it('POST /swap/execute rejects Idempotency-Key replay with a different payload', async () => {
    const headers = { ...authed(), 'Idempotency-Key': 'swap-idem-conflict-1' };
    await json('/swap/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amount: 25, direction: 'usd-eur' }),
    });
    const replay = await json('/swap/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amount: 30, direction: 'usd-eur' }),
    });

    expect(replay.status).toBe(409);
    expect(replay.body.error.message).toBe('idempotency_key_reused');
  });

  it('GET /swap/quote routes Solana USDC through Mayan', async () => {
    const quote = vi.spyOn(mayanAdapter, 'quote').mockResolvedValueOnce([
      {
        type: 'SWIFT',
        expectedAmountOut: 24.91,
        minAmountOut: 24.5,
        price: 0.9964,
        etaSeconds: 4,
        redeemRelayerFee: 0.05,
        fromSymbol: 'USDC',
        toSymbol: 'USDC',
        fromChain: 'solana',
        toChain: 'base',
      },
    ]);

    const { status, body } = await json(
      '/swap/quote?amount=25&fromChain=solana&toChain=base&fromToken=USDC&toToken=USDC',
      { headers: authed() },
    );

    expect(status).toBe(200);
    expect(body.source).toBe('mayan');
    expect(body.out).toBeCloseTo(24.91);
    expect(body.rate).toBeCloseTo(0.9964);
    expect(body.fees).toBeCloseTo(0.05);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({
      amountIn: 25,
      fromChain: 'solana',
      toChain: 'base',
    }));
  });

  it('POST /swap/execute submits Solana USDC through Mayan', async () => {
    vi.spyOn(mayanAdapter, 'quote').mockResolvedValueOnce([
      {
        type: 'SWIFT',
        expectedAmountOut: 24.91,
        minAmountOut: 24.5,
        price: 0.9964,
        etaSeconds: 4,
        redeemRelayerFee: 0.05,
        fromSymbol: 'USDC',
        toSymbol: 'USDC',
        fromChain: 'solana',
        toChain: 'base',
      },
    ]);
    const execute = vi.spyOn(mayanAdapter, 'execute').mockResolvedValueOnce({
      status: 'submitted',
      sourceTxId: 'mayan_sig_123',
      trackingUrl: 'https://explorer.mayan.finance/swap/mayan_sig_123',
    });

    const { status, body } = await json('/swap/execute', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({
        amount: 25,
        fromChain: 'solana',
        toChain: 'base',
        fromToken: 'USDC',
        toToken: 'USDC',
      }),
    });

    expect(status).toBe(200);
    expect(body.source).toBe('mayan');
    expect(body.txHash).toBe('mayan_sig_123');
    expect(body.out).toBeCloseTo(24.91);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      quote: expect.objectContaining({ fromChain: 'solana', toChain: 'base' }),
      userId: expect.any(String),
    }));
  });

  it('POST /swap/execute replays a Mayan Idempotency-Key without a second provider submit', async () => {
    const quote = vi.spyOn(mayanAdapter, 'quote').mockResolvedValue([
      {
        type: 'SWIFT',
        expectedAmountOut: 24.91,
        minAmountOut: 24.5,
        price: 0.9964,
        etaSeconds: 4,
        redeemRelayerFee: 0.05,
        fromSymbol: 'USDC',
        toSymbol: 'USDC',
        fromChain: 'solana',
        toChain: 'base',
      },
    ]);
    const execute = vi.spyOn(mayanAdapter, 'execute').mockResolvedValue({
      status: 'submitted',
      sourceTxId: 'mayan_sig_idem_123',
      trackingUrl: 'https://explorer.mayan.finance/swap/mayan_sig_idem_123',
    });
    const headers = { ...authed(), 'Idempotency-Key': 'swap-mayan-provider-idem-1' };

    const first = await json('/swap/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: 25,
        fromChain: 'solana',
        toChain: 'base',
        fromToken: 'USDC',
        toToken: 'USDC',
      }),
    });
    const replay = await json('/swap/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: 25,
        fromChain: 'solana',
        toChain: 'base',
        fromToken: 'USDC',
        toToken: 'USDC',
      }),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(first.body.txHash).toBe('mayan_sig_idem_123');
    expect(replay.body.txHash).toBe('mayan_sig_idem_123');
    expect(replay.body.idempotent).toBe(true);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects token pairs Mayan cannot route', async () => {
    const { status, body } = await json(
      '/swap/quote?amount=10&fromChain=solana&toChain=base&fromToken=EURe&toToken=USDC',
      { headers: authed() },
    );
    expect(status).toBe(400);
    expect(body.error.message).toBe('invalid_swap_route');
  });
});

describe('Marinade write routes', () => {
  it('POST /earn/marinade/stake submits SOL through Marinade', async () => {
    const stake = vi.spyOn(marinade, 'marinadeStake').mockResolvedValueOnce({
      status: 'submitted',
      signature: 'stake_sig_route',
      confirmed: true,
      mSolMint: marinade.MSOL_MINT,
    });

    const { status, body } = await json('/earn/marinade/stake', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountSol: 0.05 }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, signature: 'stake_sig_route', confirmed: true });
    expect(stake).toHaveBeenCalledWith(expect.objectContaining({
      solLamports: 50_000_000n,
      walletAddress: expect.any(String),
      signTx: expect.any(Function),
    }));
  });

  it('POST /earn/marinade/unstake submits instant mSOL unstake', async () => {
    const unstake = vi.spyOn(marinade, 'marinadeUnstake').mockResolvedValueOnce({
      status: 'submitted',
      signature: 'unstake_sig_route',
      confirmed: false,
      via: 'liquid-pool',
    });

    const { status, body } = await json('/earn/marinade/unstake', {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ amountMSol: 0.05 }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, signature: 'unstake_sig_route', confirmed: false, via: 'liquid-pool' });
    expect(unstake).toHaveBeenCalledWith(expect.objectContaining({
      mSolAmount: 50_000_000n,
      walletAddress: expect.any(String),
      signTx: expect.any(Function),
    }));
  });
});

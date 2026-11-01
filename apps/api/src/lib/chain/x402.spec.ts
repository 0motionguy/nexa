import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedAuth } from './x402.js';

const ORIGINAL_ENV = process.env;
const LIVE_TX = `0x${'ab'.repeat(32)}`;

function signedAuth(): SignedAuth {
  return {
    from: '0x00000000000000000000000000000000000000aa',
    to: '0x00000000000000000000000000000000000000bb',
    value: 100000n,
    validAfter: 0n,
    validBefore: 1n,
    nonce: '0x1111111111111111111111111111111111111111111111111111111111111111',
    signature:
      '0x2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
    asset: 'USDC',
  };
}

describe('X402Settler', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      BASE_RPC_URL: 'https://base.example',
      X402_FACILITATOR_URL: 'https://facilitator.example',
    };
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('viem');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = ORIGINAL_ENV;
  });

  it('throws when a live facilitator request is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { X402Settler } = await import('./x402.js');
    const settler = new X402Settler();

    await expect(settler.settleViaCoinbase(signedAuth())).rejects.toMatchObject({
      code: 'facilitator_unreachable',
    });
  });

  it('throws when the live facilitator omits a transaction hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );
    const { X402Settler } = await import('./x402.js');
    const settler = new X402Settler();

    await expect(settler.settleViaCoinbase(signedAuth())).rejects.toMatchObject({
      code: 'facilitator_rejected',
    });
  });

  it('throws when the live facilitator returns an invalid transaction hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ transaction: 'not-a-hash' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );
    const { X402Settler } = await import('./x402.js');
    const settler = new X402Settler();

    await expect(settler.settleViaCoinbase(signedAuth())).rejects.toMatchObject({
      code: 'facilitator_rejected',
    });
  });

  it('throws when the live settlement receipt is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ transaction: LIVE_TX }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );
    const { X402Settler } = await import('./x402.js');
    const settler = new X402Settler();
    (settler as unknown as {
      publicClient: { waitForTransactionReceipt: () => Promise<never> };
    }).publicClient = {
      waitForTransactionReceipt: vi.fn(async () => {
        throw new Error('timeout');
      }),
    };

    await expect(settler.settleViaCoinbase(signedAuth())).rejects.toMatchObject({
      code: 'facilitator_rejected',
    });
  });

  it('throws when the live settlement receipt is reverted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ transaction: LIVE_TX }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    );
    const { X402Settler } = await import('./x402.js');
    const settler = new X402Settler();
    (settler as unknown as {
      publicClient: { waitForTransactionReceipt: () => Promise<{ blockNumber: bigint; status: string }> };
    }).publicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 123n, status: 'reverted' })),
    };

    await expect(settler.settleViaCoinbase(signedAuth())).rejects.toMatchObject({
      code: 'facilitator_rejected',
    });
  });

  it('derives a stable bytes32 nonce from an idempotency seed', async () => {
    const { X402Settler } = await import('./x402.js');
    const settler = new X402Settler();
    const signer = {
      live: true,
      signTypedData: vi.fn(async () => signedAuth().signature),
    };

    const first = await settler.signTransferAuth(
      signedAuth().from,
      signedAuth().to,
      0.1,
      'USDC',
      signer,
      { nonceSeed: 'x402:user-1:idem-1' },
    );
    const replay = await settler.signTransferAuth(
      signedAuth().from,
      signedAuth().to,
      0.1,
      'USDC',
      signer,
      { nonceSeed: 'x402:user-1:idem-1' },
    );
    const other = await settler.signTransferAuth(
      signedAuth().from,
      signedAuth().to,
      0.1,
      'USDC',
      signer,
      { nonceSeed: 'x402:user-1:idem-2' },
    );

    expect(first?.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(replay?.nonce).toBe(first?.nonce);
    expect(other?.nonce).not.toBe(first?.nonce);
  });
});

/**
 * BridgeRouter — adapter selection + fallback unit tests.
 *
 * The router is constructed against tiny stub adapters so the tests assert the
 * Socket-first / LIFI-fallback / synthetic-demo flow without touching real
 * fetches. The Socket adapter's own /v3/swap/quote parsing is exercised
 * separately in chain/socket.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BridgeRouter,
  CHAIN_IDS,
  type BridgeAdapter,
  type BridgeQuote,
  type BridgeQuoteInput,
} from './bridge-router.js';

function makeStub(opts: {
  name: 'socket' | 'lifi';
  isLive: boolean;
  quote?: BridgeQuote | null;
  throws?: boolean;
}): BridgeAdapter & { quote: ReturnType<typeof vi.fn> } {
  const quoteFn = vi.fn(async (_input: BridgeQuoteInput): Promise<BridgeQuote | null> => {
    if (opts.throws) throw new Error('upstream blew up');
    return opts.quote ?? null;
  });
  return {
    name: opts.name,
    get isLive(): boolean {
      return opts.isLive;
    },
    quote: quoteFn,
  };
}

function makeQuote(provider: 'socket' | 'lifi', overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  return {
    provider,
    calls: [
      {
        to: '0x0000000000000000000000000000000000001234',
        data: '0xabcdef',
        value: '0',
      },
    ],
    estimate: {
      fromAmount: '50000000',
      toAmount: '46000000',
      toAmountMin: '45540000',
      rate: 0.92,
      estimatedGasUsd: 0.42,
    },
    ...overrides,
  };
}

const sampleInput: BridgeQuoteInput = {
  fromChain: 'base',
  toChain: 'gnosis',
  fromToken: 'USDC',
  toToken: 'EURe',
  amountUsd: 50,
  userAddress: '0x000000000000000000000000000000000000dEaD',
  enableRefuel: true,
};

function makeExecutor(opts: { demo?: boolean } = {}): {
  sendCalls: ReturnType<typeof vi.fn>;
} {
  return {
    sendCalls: vi.fn(async (_userId, _calls, _opts) => ({
      txHash: opts.demo ? '0xdemo' + '1'.repeat(28) : '0xdeadbeef',
      demo: opts.demo ?? false,
      sponsored: !opts.demo,
    })),
  };
}

describe('BridgeRouter — quote selection', () => {
  it('prefers Socket when live and a route is returned', async () => {
    const socket = makeStub({ name: 'socket', isLive: true, quote: makeQuote('socket') });
    const lifi = makeStub({ name: 'lifi', isLive: true, quote: makeQuote('lifi') });
    const router = new BridgeRouter(socket, lifi, makeExecutor() as never);
    const q = await router.quote(sampleInput);
    expect(q.provider).toBe('socket');
    expect(socket.quote).toHaveBeenCalledOnce();
    expect(lifi.quote).not.toHaveBeenCalled();
  });

  it('falls back to LIFI when Socket returns null (no route)', async () => {
    const socket = makeStub({ name: 'socket', isLive: true, quote: null });
    const lifi = makeStub({ name: 'lifi', isLive: true, quote: makeQuote('lifi') });
    const router = new BridgeRouter(socket, lifi, makeExecutor() as never);
    const q = await router.quote(sampleInput);
    expect(q.provider).toBe('lifi');
    expect(socket.quote).toHaveBeenCalledOnce();
    expect(lifi.quote).toHaveBeenCalledOnce();
  });

  it('falls back to LIFI when Socket throws', async () => {
    const socket = makeStub({ name: 'socket', isLive: true, throws: true });
    const lifi = makeStub({ name: 'lifi', isLive: true, quote: makeQuote('lifi') });
    const router = new BridgeRouter(socket, lifi, makeExecutor() as never);
    const q = await router.quote(sampleInput);
    expect(q.provider).toBe('lifi');
    expect(socket.quote).toHaveBeenCalledOnce();
    expect(lifi.quote).toHaveBeenCalledOnce();
  });

  it('skips Socket entirely when not live and goes straight to LIFI', async () => {
    const socket = makeStub({ name: 'socket', isLive: false, quote: makeQuote('socket') });
    const lifi = makeStub({ name: 'lifi', isLive: true, quote: makeQuote('lifi') });
    const router = new BridgeRouter(socket, lifi, makeExecutor() as never);
    const q = await router.quote(sampleInput);
    expect(q.provider).toBe('lifi');
    expect(socket.quote).not.toHaveBeenCalled();
    expect(lifi.quote).toHaveBeenCalledOnce();
  });

  it('returns a synthetic demo quote when both providers fail', async () => {
    const socket = makeStub({ name: 'socket', isLive: true, quote: null });
    const lifi = makeStub({ name: 'lifi', isLive: true, quote: null });
    const router = new BridgeRouter(socket, lifi, makeExecutor() as never);
    const q = await router.quote(sampleInput);
    // Synthetic demo: provider 'lifi', no calls, 0.92 fallback rate.
    expect(q.provider).toBe('lifi');
    expect(q.calls).toHaveLength(0);
    expect(q.estimate.rate).toBe(0.92);
    expect(Number(q.estimate.toAmount)).toBeCloseTo(46);
  });

  it('threads refuelGasUsd through when Socket includes it', async () => {
    const socket = makeStub({
      name: 'socket',
      isLive: true,
      quote: makeQuote('socket', {
        estimate: {
          fromAmount: '50000000',
          toAmount: '46000000',
          toAmountMin: '45540000',
          rate: 0.92,
          estimatedGasUsd: 0.42,
          refuelGasUsd: 0.05,
        },
      }),
    });
    const lifi = makeStub({ name: 'lifi', isLive: true });
    const router = new BridgeRouter(socket, lifi, makeExecutor() as never);
    const q = await router.quote({ ...sampleInput, enableRefuel: true });
    expect(q.estimate.refuelGasUsd).toBe(0.05);
  });
});

describe('BridgeRouter — execute', () => {
  it('passes the source chainId to executor.sendCalls', async () => {
    const socket = makeStub({ name: 'socket', isLive: true, quote: makeQuote('socket') });
    const lifi = makeStub({ name: 'lifi', isLive: false });
    const executor = makeExecutor();
    const router = new BridgeRouter(socket, lifi, executor as never);
    const r = await router.execute(sampleInput, 'u-1');
    expect(r.provider).toBe('socket');
    expect(r.demo).toBe(false);
    expect(executor.sendCalls).toHaveBeenCalledTimes(1);
    const [userId, calls, opts] = executor.sendCalls.mock.calls[0];
    expect(userId).toBe('u-1');
    expect(Array.isArray(calls)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(opts).toEqual({ chainId: CHAIN_IDS.base });
  });

  it('passes Gnosis chainId for Gnosis-origin executes', async () => {
    const socket = makeStub({
      name: 'socket',
      isLive: true,
      quote: makeQuote('socket'),
    });
    const lifi = makeStub({ name: 'lifi', isLive: false });
    const executor = makeExecutor();
    const router = new BridgeRouter(socket, lifi, executor as never);
    await router.execute({ ...sampleInput, fromChain: 'gnosis', toChain: 'base' }, 'u-2');
    const [, , opts] = executor.sendCalls.mock.calls[0];
    expect(opts).toEqual({ chainId: CHAIN_IDS.gnosis });
  });

  it('returns a demo tx hash without invoking the executor when both providers fail', async () => {
    const socket = makeStub({ name: 'socket', isLive: false });
    const lifi = makeStub({ name: 'lifi', isLive: false, quote: null });
    const executor = makeExecutor();
    const router = new BridgeRouter(socket, lifi, executor as never);
    const r = await router.execute(sampleInput, 'u-3');
    expect(r.demo).toBe(true);
    expect(r.txHash).toMatch(/^0xdemo/);
    expect(executor.sendCalls).not.toHaveBeenCalled();
  });

  it('decodes call.value into BigInt when non-zero', async () => {
    const socket = makeStub({
      name: 'socket',
      isLive: true,
      quote: makeQuote('socket', {
        calls: [{ to: '0xabc', data: '0xdef', value: '1000000000000000' }],
      }),
    });
    const lifi = makeStub({ name: 'lifi', isLive: false });
    const executor = makeExecutor();
    const router = new BridgeRouter(socket, lifi, executor as never);
    await router.execute(sampleInput, 'u-4');
    const [, calls] = executor.sendCalls.mock.calls[0];
    expect(calls[0].value).toBe(BigInt('1000000000000000'));
  });
});

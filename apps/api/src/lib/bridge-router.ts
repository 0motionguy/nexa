/**
 * Bridge router — Socket primary, LIFI fallback (Stack upgrades Phase 2).
 *
 * Cross-chain swaps and the Gnosis Pay card top-up route through one common
 * interface so a quote or execution can transparently failover from Socket to
 * LIFI without the caller knowing. Same-chain swap (e.g. USDC ⇄ EURC on Base)
 * uses the same router with `fromChain === toChain`.
 *
 *   bridgeRouter.quote(input)   → BridgeQuote     (calls + estimate)
 *   bridgeRouter.execute(input) → tx hash via 7702 executor
 *
 * Provider preference: Socket when its API key is set AND it returns a quote;
 * LIFI otherwise. Synthetic quotes are allowed only in DEMO_MODE.
 *
 * Source for Socket schema:
 *   https://docs.socket.tech/integrate/integration-guides/socket-api.md
 *   GET /v3/swap/quote — `result.routes[0].txData.object` carries the EVM tx,
 *   `output.amount/minAmountOut/valueInUsd`, `gasFee.feeInUsd`, optional
 *   `approval`. Retrieved 2026-06-14.
 */

import { ChainError } from './chain/units.js';
import { env } from './env.js';
import { log } from './log.js';

/** Chains the router can target — bridge legs ride on the on-chain executor. */
export type Chain = 'base' | 'gnosis' | 'polygon' | 'optimism' | 'arbitrum';
/** Asset tickers the router recognises. */
export type Token = 'USDC' | 'EURC' | 'EURe' | 'USDT';

export const CHAIN_IDS: Record<Chain, number> = {
  base: 8453,
  gnosis: 100,
  polygon: 137,
  optimism: 10,
  arbitrum: 42161,
};

export interface BridgeQuoteInput {
  fromChain: Chain;
  toChain: Chain;
  fromToken: Token;
  toToken: Token;
  amountUsd: number;
  userAddress: string;
  enableRefuel?: boolean;
}

export interface Call {
  to: string;
  data: string;
  value?: string;
}

export interface BridgeEstimate {
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  rate: number;
  estimatedGasUsd: number;
  refuelGasUsd?: number;
}

export interface BridgeQuote {
  provider: 'socket' | 'lifi';
  calls: Call[];
  estimate: BridgeEstimate;
  /** Provider-specific payload retained for debugging — never serialized to clients. */
  raw?: unknown;
}

export interface BridgeAdapter {
  readonly name: 'socket' | 'lifi';
  readonly isLive: boolean;
  quote(input: BridgeQuoteInput): Promise<BridgeQuote | null>;
}

interface BridgeExecutor {
  sendCalls(
    userId: string,
    calls: Array<{ to: `0x${string}`; data: `0x${string}`; value?: bigint }>,
    opts: { chainId?: number; idempotencyKey?: string },
  ): Promise<{ txHash: string; demo: boolean }>;
}

/**
 * Tries Socket first when it's live; falls back to LIFI. DEMO_MODE can return
 * a synthetic quote; non-demo environments fail closed when no live provider
 * returns executable calls.
 */
export class BridgeRouter {
  constructor(
    private socket: BridgeAdapter,
    private lifi: BridgeAdapter,
    private executor: BridgeExecutor,
  ) {}

  async quote(input: BridgeQuoteInput): Promise<BridgeQuote> {
    if (this.socket.isLive) {
      const q = await this.socket.quote(input).catch((e) => {
        log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'bridge-router: socket quote failed',
        );
        return null;
      });
      if (q) return q;
    }
    const q = await this.lifi.quote(input).catch((e) => {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'bridge-router: lifi quote failed',
      );
      return null;
    });
    if (q && (env.DEMO_MODE || q.calls.length > 0)) return q;
    if (q && !env.DEMO_MODE) {
      log.warn('bridge-router: refusing synthetic quote outside demo mode');
    }
    if (!env.DEMO_MODE) {
      throw new ChainError('rpc_failed', 'No live bridge quote available');
    }
    // Both failed in demo mode — return a synthetic quote so local/offline
    // prototype flows can still complete without provider keys.
    return {
      provider: 'lifi',
      calls: [],
      estimate: {
        fromAmount: String(input.amountUsd),
        toAmount: String(input.amountUsd * 0.92),
        toAmountMin: String(input.amountUsd * 0.91),
        rate: 0.92,
        estimatedGasUsd: 0,
      },
    };
  }

  async execute(
    input: BridgeQuoteInput,
    userId: string,
    opts: { idempotencyKey?: string | null } = {},
  ): Promise<{ txHash: string; demo: boolean; provider: 'socket' | 'lifi' }> {
    const q = await this.quote(input);
    // No calls = synthetic demo path. This should only be reachable while
    // DEMO_MODE is enabled because quote() fails closed otherwise.
    if (q.calls.length === 0) {
      if (!env.DEMO_MODE) throw new ChainError('rpc_failed', 'No executable bridge calls available');
      return { txHash: '0xdemo' + '0'.repeat(28), demo: true, provider: q.provider };
    }
    const result = await this.executor.sendCalls(userId, q.calls.map((c) => ({
      to: c.to as `0x${string}`,
      data: c.data as `0x${string}`,
      ...(c.value && c.value !== '0' && c.value !== '0x0' ? { value: BigInt(c.value) } : {}),
    })), {
      chainId: CHAIN_IDS[input.fromChain],
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    return { txHash: result.txHash, demo: result.demo, provider: q.provider };
  }
}

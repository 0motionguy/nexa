/**
 * yoUSD — the PRIMARY earn adapter.
 *
 * yoUSD is a yield-bearing USD vault on Base implementing the ERC-4626
 * tokenized-vault standard. Deposits convert USDC → yoUSD shares; withdrawals
 * redeem shares back to USDC.
 *
 * Vault address: env.YOUSD_ADDRESS (Base mainnet).
 * ERC-4626: https://eips.ethereum.org/EIPS/eip-4626
 *
 * Writes funnel through the EIP-7702 batch executor:
 *   deposit  → [ USDC.approve(vault, amt), vault.deposit(amt, receiver) ]
 *   withdraw → [ vault.withdraw(amt, receiver, owner) ]
 * In demo mode the executor returns a `0xdemo…` hash and the route layer
 * mirrors the move into the ledger, so deposit/withdraw "work" with no keys.
 *
 * APY: yoUSD's live rate must come from a configured off-chain provider. When
 * that provider is absent, the adapter reports APY unavailable.
 */

import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { env } from '../env.js';
import { ASSETS, ChainError, usdToUsdcWei } from './units.js';
import { walletService } from './wallet.js';
import { executor, type ExecResult, type SponsoredCall } from './alchemy.js';
import { apyToBps, apyUnavailable } from './apy.js';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const VAULT_ABI = parseAbi([
  // ERC-4626 tokenized vault.
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
]);

// F029 — class is module-private; the singleton `yoUsdAdapter` is the public surface.
class YoUsdAdapter {
  private readonly vault = getAddress(env.YOUSD_ADDRESS) as Hex;

  /** Live writes require the same stack as the batch executor (Alchemy+chain+Privy). */
  get isLive(): boolean {
    return executor.isLive;
  }

  /**
   * Blended APY in basis points. Two response shapes are supported:
   *
   *   1) YO Protocol public API (default):
   *      GET https://api.yo.xyz/api/v1/vault/yield/timeseries/base/{vault}
   *      → [{ timestamp, yield: "4.03760915..." }, ...]  ← yield is APR as %
   *      The last entry is the most recent realised yield.
   *
   *   2) Generic { apyBps | netApy | apy | apr } object shape — used by any
   *      operator-provided alternative endpoint that returns a single value.
   *
   * If no YOUSD_APY_URL is configured we default to YO's public API for the
   * pinned vault. Setting an explicit URL overrides this.
   */
  async getApyBps(): Promise<number> {
    if (process.env['VITEST']) throw apyUnavailable('yoUSD');
    const url =
      env.YOUSD_APY_URL ??
      `https://api.yo.xyz/api/v1/vault/yield/timeseries/base/${env.YOUSD_ADDRESS}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new ChainError('rpc_failed', `yoUSD APY ${res.status}`);
      const body = (await res.json()) as
        | Array<{ timestamp?: number; yield?: string | number }>
        | { data?: Array<{ yield?: string | number }> }
        | {
            apyBps?: unknown;
            apy?: unknown;
            apr?: unknown;
            netApy?: unknown;
          };
      // Shape 1: timeseries array — last entry has the most recent yield (%).
      const series = Array.isArray(body) ? body : (body as { data?: Array<unknown> }).data;
      if (Array.isArray(series) && series.length > 0) {
        const last = series[series.length - 1] as { yield?: string | number };
        const y = Number(last?.yield);
        if (Number.isFinite(y) && y >= 0) return Math.round(y * 100); // % → bps
      }
      // Shape 2: object with apyBps / netApy / apy / apr.
      const obj = body as { apyBps?: unknown; apy?: unknown; apr?: unknown; netApy?: unknown };
      const direct =
        typeof obj.apyBps === 'string' || typeof obj.apyBps === 'number'
          ? Number(obj.apyBps)
          : Number.NaN;
      if (Number.isFinite(direct) && direct >= 0) return Math.round(direct);
      const bps = apyToBps(obj.netApy ?? obj.apy ?? obj.apr);
      if (bps != null) return bps;
      throw apyUnavailable('yoUSD');
    } catch (e) {
      if (e instanceof ChainError) throw e;
      throw apyUnavailable('yoUSD', e);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Deposit `amountUsd` USDC into the yoUSD vault. Encodes approve + ERC-4626
   * deposit as one sponsored batch and routes through the executor. Demo mode
   * returns a `0xdemo…` ExecResult.
   */
  async deposit(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    const receiver = await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: ASSETS.USDC.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [this.vault, amt],
        }),
      },
      {
        to: this.vault,
        data: encodeFunctionData({
          abi: VAULT_ABI,
          functionName: 'deposit',
          args: [amt, receiver],
        }),
      },
    ];
    return executor.sendCalls(userId, calls, opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {});
  }

  /**
   * Withdraw `amountUsd` of underlying USDC from the vault (ERC-4626 withdraw,
   * receiver == owner == the user's wallet). Routes through the executor.
   */
  async withdraw(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    const wallet = await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: this.vault,
        data: encodeFunctionData({
          abi: VAULT_ABI,
          functionName: 'withdraw',
          args: [amt, wallet, wallet],
        }),
      },
    ];
    return executor.sendCalls(userId, calls, opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {});
  }

  /**
   * Resolve the user's wallet address for calldata encoding. In demo mode this
   * is the deterministic mock address; live it's the Privy wallet. (privyDid
   * threading from the session is a follow-up, shared with the executor.)
   */
  private async walletAddress(userId: string): Promise<Hex> {
    const wallet = await walletService.getOrCreateUserWallet(userId, null);
    return wallet.address;
  }
}

export const yoUsdAdapter = new YoUsdAdapter();

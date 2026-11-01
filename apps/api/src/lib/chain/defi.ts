/**
 * Aave v3 adapter — Base mainnet Pool.
 *
 * Provides:
 *   - getApy('USDC')        → current supply APY in bps
 *   - depositUsd(userId, $) → USDC.approve + Pool.supply via the 7702 executor
 *   - withdrawUsd(userId, $)→ Pool.withdraw via the 7702 executor
 *   - balance(wallet)       → aUSDC token balance (the receipt token)
 *
 * Aave is the SECONDARY earn venue (yoUSD is primary). Writes batch through the
 * EIP-7702 executor so the user pays no gas and signs once.
 *
 * Demo fallback when BASE_RPC_URL is unset: getApy reports unavailable;
 * deposit/withdraw return a `0xdemo` tx hash (via the executor) and rely on
 * the route layer to mirror the move into the in-memory ledger.
 *
 * Aave Pool docs: https://docs.aave.com/developers/core-contracts/pool
 */

import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { base } from 'viem/chains';
import { env, features } from '../env.js';
import { ASSETS, type AssetKey, ChainError, rayToBps, usdToUsdcWei } from './units.js';
import { walletService } from './wallet.js';
import { executor, type ExecResult, type SponsoredCall } from './alchemy.js';
import { apyUnavailable } from './apy.js';

const POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export class AaveAdapter {
  private readonly publicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
  });

  private readonly poolAddress = env.AAVE_POOL_ADDRESS as Hex;

  get isLive(): boolean {
    return features.chain && Boolean(env.BASE_RPC_URL);
  }

  /**
   * APY in basis points from on-chain Aave Pool.getReserveData. Public read —
   * no key required. Gated only by VITEST (tests stay deterministic) and the
   * absence of BASE_RPC_URL (the publicClient would throw anyway). DEMO_MODE
   * is intentionally NOT a blocker — reading public chain data is safe.
   * Writes (depositUsd / withdrawUsd) remain gated by executor.isLive.
   */
  async getApy(asset: AssetKey = 'USDC'): Promise<number> {
    if (process.env['VITEST']) throw apyUnavailable('Aave');
    if (!env.BASE_RPC_URL) throw apyUnavailable('Aave', new Error('BASE_RPC_URL not configured'));
    try {
      const data = (await this.publicClient.readContract({
        address: this.poolAddress,
        abi: POOL_ABI,
        functionName: 'getReserveData',
        args: [ASSETS[asset].address],
      })) as readonly [
        bigint, bigint, bigint, bigint, bigint, bigint, number, number,
        Hex, Hex, Hex, Hex, bigint, bigint, bigint,
      ];
      const liquidityRate = data[2];
      return rayToBps(liquidityRate);
    } catch (e) {
      throw new ChainError('apy_unavailable', 'Aave APY unavailable', e);
    }
  }

  /**
   * Supply `amountUsd` USDC into the Aave Pool. Encodes USDC.approve +
   * Pool.supply as one sponsored batch and routes through the 7702 executor.
   * Demo mode (or any live failure) returns a `0xdemo…` ExecResult.
   */
  async depositUsd(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    const onBehalfOf = await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: ASSETS.USDC.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [this.poolAddress, amt],
        }),
      },
      {
        to: this.poolAddress,
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: 'supply',
          args: [ASSETS.USDC.address, amt, onBehalfOf, 0],
        }),
      },
    ];
    return executor.sendCalls(userId, calls, opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {});
  }

  /**
   * Withdraw `amountUsd` of USDC from the Aave Pool back to the user's wallet.
   * Encodes Pool.withdraw and routes through the 7702 executor.
   */
  async withdrawUsd(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    const to = await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: this.poolAddress,
        data: encodeFunctionData({
          abi: POOL_ABI,
          functionName: 'withdraw',
          args: [ASSETS.USDC.address, amt, to],
        }),
      },
    ];
    return executor.sendCalls(userId, calls, opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {});
  }

  /** Resolve the user's wallet address for calldata encoding (demo → mock). */
  private async walletAddress(userId: string): Promise<Hex> {
    const wallet = await walletService.getOrCreateUserWallet(userId, null);
    return wallet.address;
  }

  /** aUSDC balance for the wallet (receipt token from the supply call). */
  async balance(wallet: Hex): Promise<bigint> {
    if (!this.isLive) return 0n;
    try {
      const v = (await this.publicClient.readContract({
        address: ASSETS.aUSDC.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [wallet],
      })) as bigint;
      return v;
    } catch (e) {
      throw new ChainError('rpc_failed', 'aUSDC balanceOf failed', e);
    }
  }
}

export const aaveAdapter = new AaveAdapter();

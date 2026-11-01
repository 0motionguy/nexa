/**
 * Compound v3 (Comet) adapter — Base mainnet USDC market (cUSDCv3).
 *
 * A DeFi diversification venue alongside yoUSD (primary), Aave, and Morpho.
 * Comet is a single-asset-base lending market: supplying USDC mints an internal
 * balance that accrues the supply rate; there is no separate receipt token to
 * approve against and supply/withdraw act on msg.sender (no onBehalfOf/to args),
 * which is the key shape difference from Aave's Pool.
 *
 * Provides the standard EarnAdapter surface:
 *   - getApyBps()           → live supply APY in bps, or APY unavailable
 *   - depositUsd(userId, $) → [ USDC.approve(comet, amt), Comet.supply(USDC, amt) ]
 *   - withdrawUsd(userId, $)→ [ Comet.withdraw(USDC, amt) ]
 *   - get isLive
 *
 * Writes batch through the EIP-7702 executor so the user pays no gas and signs
 * once. Demo fallback (BASE_RPC_URL unset) → getApyBps reports unavailable and
 * deposit/withdraw return a `0xdemo…` ExecResult via the executor; the route
 * layer mirrors the move into the in-memory ledger.
 *
 * Comet APY math (docs): supply rate is per-second, scaled by 1e18. Annualize
 * with SECONDS_PER_YEAR then convert to bps. Read getUtilization() then
 * getSupplyRate(utilization).
 * Comet docs: https://docs.compound.finance/interest-rates/
 */

import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { base } from 'viem/chains';
import { env, features } from '../env.js';
import { ASSETS, ChainError, usdToUsdcWei } from './units.js';
import { walletService } from './wallet.js';
import { executor, type ExecResult, type SponsoredCall } from './alchemy.js';
import { apyUnavailable } from './apy.js';

/** Comet's per-second supply rate is scaled by 1e18. */
const RATE_SCALE = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n; // 365 * 24 * 60 * 60

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const COMET_ABI = parseAbi([
  // Single-asset-base market: supply/withdraw operate on msg.sender.
  'function supply(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
  // Per-second supply rate (1e18-scaled) for a given utilization (1e18-scaled).
  'function getSupplyRate(uint256 utilization) view returns (uint64)',
  'function getUtilization() view returns (uint256)',
]);

export class CompoundAdapter {
  private readonly publicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
  });

  private readonly comet = env.COMPOUND_COMET_ADDRESS as Hex;

  /** Live reads/writes need the chain RPC (same gate as Aave). */
  get isLive(): boolean {
    return features.chain && Boolean(env.BASE_RPC_URL);
  }

  /**
   * Supply APY in basis points. Public read against Comet.getSupplyRate —
   * no key required. Gated only by VITEST (test determinism) and the
   * absence of BASE_RPC_URL. DEMO_MODE is intentionally NOT a blocker:
   * reading public chain rates is safe; writes stay gated by executor.isLive.
   */
  async getApyBps(): Promise<number> {
    if (process.env['VITEST']) throw apyUnavailable('Compound');
    if (!env.BASE_RPC_URL) throw apyUnavailable('Compound', new Error('BASE_RPC_URL not configured'));
    try {
      const utilization = (await this.publicClient.readContract({
        address: this.comet,
        abi: COMET_ABI,
        functionName: 'getUtilization',
      })) as bigint;
      const ratePerSecond = (await this.publicClient.readContract({
        address: this.comet,
        abi: COMET_ABI,
        functionName: 'getSupplyRate',
        args: [utilization],
      })) as bigint;
      // APY ≈ ratePerSecond/1e18 * secondsPerYear, expressed in bps (×10000).
      return Number((ratePerSecond * SECONDS_PER_YEAR * 10000n) / RATE_SCALE);
    } catch (e) {
      throw new ChainError('apy_unavailable', 'Compound APY unavailable', e);
    }
  }

  /**
   * Supply `amountUsd` USDC into the Comet market. Encodes USDC.approve +
   * Comet.supply as one sponsored batch and routes through the 7702 executor.
   * Demo mode (or any live failure) returns a `0xdemo…` ExecResult.
   */
  async depositUsd(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    // Comet supplies for msg.sender — no onBehalfOf — but we still resolve the
    // wallet to keep the demo path identical to the other adapters.
    await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: ASSETS.USDC.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [this.comet, amt],
        }),
      },
      {
        to: this.comet,
        data: encodeFunctionData({
          abi: COMET_ABI,
          functionName: 'supply',
          args: [ASSETS.USDC.address, amt],
        }),
      },
    ];
    return executor.sendCalls(userId, calls, opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {});
  }

  /**
   * Withdraw `amountUsd` of USDC from the Comet market back to the user's wallet
   * (Comet withdraws to msg.sender). Encodes Comet.withdraw and routes through
   * the 7702 executor.
   */
  async withdrawUsd(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: this.comet,
        data: encodeFunctionData({
          abi: COMET_ABI,
          functionName: 'withdraw',
          args: [ASSETS.USDC.address, amt],
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
}

export const compoundAdapter = new CompoundAdapter();

/**
 * Money / unit conversion + asset registry.
 *
 * USDC and EURC on Base both use 6 decimals. aUSDC (Aave receipt token) same.
 * Everything passes through getAddress() to enforce checksum form so case
 * mismatches don't slip through to RPC calls.
 */

import { getAddress, type Hex } from 'viem';
import { env } from '../env.js';

export const ASSETS = {
  USDC: { address: getAddress(env.USDC_ADDRESS) as Hex, decimals: 6 },
  EURC: { address: getAddress(env.EURC_ADDRESS) as Hex, decimals: 6 },
  aUSDC: { address: getAddress(env.AUSDC_ADDRESS) as Hex, decimals: 6 },
} as const;

export type AssetKey = keyof typeof ASSETS;

export function usdToUsdcWei(usd: number): bigint {
  return BigInt(Math.round(usd * 1e6));
}

/** Ray (1e27) → bps. Aave's liquidityRate is ray-scaled APR. */
export function rayToBps(ray: bigint): number {
  return Number((ray * 10000n) / 10n ** 27n);
}

export type ChainErrorCode =
  | 'rpc_failed'
  | 'apy_unavailable'
  | 'facilitator_rejected'
  | 'facilitator_unreachable'
  | 'insufficient_balance'
  | 'sig_failed'
  | 'sig_unavailable'
  | 'wallet_missing'
  | 'wallet_unavailable'
  | 'not_implemented'
  | 'bad_address'
  | 'unsupported_asset';

export class ChainError extends Error {
  constructor(
    public code: ChainErrorCode,
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

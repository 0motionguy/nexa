/**
 * Hyperliquid Bridge2 — Arbitrum USDC → HL L1 deposit (Sprint 19).
 *
 * Bridge2 is HL's canonical Arbitrum-side deposit contract. Users deposit by
 * sending USDC via the standard ERC-20 transfer; Bridge2 watches for incoming
 * USDC Transfer events and credits the sender's HL L1 balance.
 *
 *   contract:  0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7   (Arbitrum mainnet)
 *   token:     0xaf88d065e77c8cC2239327C5EDb3A432268e5831   (native USDC)
 *   min:       $5 (HL enforces, below this is silently lost to the bridge)
 *   credit:    near-instant; HL indexer typically reflects within 1 block
 *
 * Used by the bridge-worker as the FINAL hop when a CCTP transfer's
 * destination bucket is `perps`. The CCTP mint leaves USDC on the user's
 * Arbitrum wallet; this hop pushes it into HL L1 so the Trade tab actually
 * shows the funds as tradable Perps margin.
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-start-trading
 */

import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { executor, type CallStatusSnapshot } from './alchemy.js';
import { log } from '../log.js';

/** HL Bridge2 contract address on Arbitrum mainnet. */
export const HL_BRIDGE2_ADDRESS: Hex = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';

/** Arbitrum chain id — Bridge2 only exists on Arbitrum. */
const ARBITRUM_CHAIN_ID = 42161;

/** Arbitrum native USDC. */
const ARBITRUM_USDC: Hex = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

/** HL Bridge2 enforces a $5 minimum deposit; below this the funds are lost. */
export const HL_MIN_DEPOSIT_USDC_ATOMS = 5_000_000n; // 5.00 USDC (6 decimals)

/**
 * HL withdraw3 (L1 → Arbitrum) — flat fee HL deducts from the withdrawal.
 * Bridge2 pays out `amount - $1` to the destination after HL's finalization
 * window (typically ~5 min). Perps-source transfers must net this out of the
 * burn amount so the EOA arrival always covers burn + treasury skim.
 */
export const HL_WITHDRAW_FEE_USD = 1;

/** HL rejects withdrawal requests below $2. */
export const HL_MIN_WITHDRAW_USD = 2;

const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Encode `USDC.transfer(BRIDGE2, amount)` calldata.
 *
 * Bridge2 has no dedicated deposit function — it watches for incoming USDC
 * transfers to its address. This is the only on-chain call needed.
 */
export function buildHlBridge2DepositCalldata(amountAtoms: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [HL_BRIDGE2_ADDRESS, amountAtoms],
  });
}

export interface HlBridgeDepositResult {
  /** Alchemy preparedCallId — track via executor.getCallStatus. */
  callId: string;
  demo: boolean;
  submittedUnknown?: boolean;
  /** Live signing configured but failed — surface, don't fake demo success. */
  failed?: boolean;
  failureCode?: string;
}

/**
 * Submit the HL Bridge2 deposit via the Alchemy 7702 executor on Arbitrum.
 * Returns null when the amount is below HL's $5 minimum (deposit would burn
 * the funds at Bridge2 with no L1 credit).
 *
 * Caller should pre-check `amountAtoms >= HL_MIN_DEPOSIT_USDC_ATOMS` to
 * avoid this case and surface a meaningful error to the user.
 */
export async function executeHlBridge2Deposit(input: {
  userId: string;
  amountAtoms: bigint;
  /** F085 — deterministic idempotency key (e.g. `${transfer.id}:hl-deposit`). */
  idempotencyKey?: string;
}): Promise<HlBridgeDepositResult | null> {
  if (input.amountAtoms < HL_MIN_DEPOSIT_USDC_ATOMS) {
    log.warn(
      {
        userId: input.userId,
        amountAtoms: input.amountAtoms.toString(),
        minimum: HL_MIN_DEPOSIT_USDC_ATOMS.toString(),
      },
      'hl-bridge: deposit below $5 minimum — rejecting',
    );
    return null;
  }
  const calldata = buildHlBridge2DepositCalldata(input.amountAtoms);
  const result = await executor.sendCalls(
    input.userId,
    [{ to: ARBITRUM_USDC, data: calldata }],
    {
      chainId: ARBITRUM_CHAIN_ID,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  );
  return {
    callId: result.txHash,
    demo: result.demo,
    submittedUnknown: result.submittedUnknown,
    ...(result.failed ? { failed: true, failureCode: result.failureCode } : {}),
  };
}

/** Re-export getCallStatus for the worker (single import surface). */
export async function getHlBridgeDepositStatus(callId: string): Promise<CallStatusSnapshot> {
  return executor.getCallStatus(callId, ARBITRUM_CHAIN_ID);
}

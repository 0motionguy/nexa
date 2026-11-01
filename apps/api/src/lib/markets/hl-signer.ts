/**
 * Hyperliquid signing adapter — wraps Privy server-wallet signatures in the
 * `AbstractViemLocalAccount` shape `@nktkas/hyperliquid/signing` expects.
 *
 * The SDK computes the L1 action hash + connectionId for us, builds the typed
 * data, calls `wallet.signTypedData`, and returns `{r, s, v}`. Without this
 * adapter the pre-Sprint-16 hyperliquid.ts hand-rolled the EIP-712 with a
 * random `connectionId` (instead of the deterministic hash of the action) —
 * any order signed that way was rejected by Hyperliquid because the recovered
 * signer didn't match the user's wallet at the expected action hash.
 *
 * Provenance: @nktkas/hyperliquid 0.33.1 `esm/signing/mod.d.ts` and
 * `esm/signing/_abstractWallet.d.ts` — re-verified 2026-07-02 (0.33.0's
 * breaking changes touch only noop/createVault/multi-sig, none used here).
 */

import {
  signL1Action as sdkSignL1Action,
  signUserSignedAction as sdkSignUserSignedAction,
  type AbstractViemLocalAccount,
  type Signature,
} from '@nktkas/hyperliquid/signing';

import { signTypedDataWithPrivy } from '../privy.js';
import { log } from '../log.js';
import { ensureAgentApproved, getProcessAgent, hlAgentWalletsEnabled } from './hl-agent.js';

let lastHlNonce = 0;

export function nextHlNonce(now = Date.now()): number {
  // ponytail: process-local monotonic nonce; use Redis/DB only if multi-process collisions show up.
  lastHlNonce = Math.max(now, lastHlNonce + 1);
  return lastHlNonce;
}

export function _resetHlNonceForTests(): void {
  lastHlNonce = 0;
}

/**
 * Shape of the params the SDK passes to `wallet.signTypedData`. Mirrors the
 * `ViemTypedDataParams` interface in `_abstractWallet.d.ts` so we don't have
 * to import a non-exported internal type.
 */
interface ViemTypedDataParams {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: { [key: string]: { name: string; type: string }[] };
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Build an `AbstractViemLocalAccount` whose `signTypedData` delegates to
 * Privy's server-wallet signing for the given walletId. `walletAddress` is
 * the EVM address Privy provisioned for that walletId — we accept it from
 * the caller because the SDK reads `wallet.address` on the shape; a wrong
 * value here means the SDK builds a request the venue would reject (the
 * recovered signer wouldn't match this address).
 */
function privyWallet(walletId: string, walletAddress: `0x${string}`): AbstractViemLocalAccount {
  return {
    address: walletAddress,
    async signTypedData(params: ViemTypedDataParams): Promise<`0x${string}`> {
      const sig = await signTypedDataWithPrivy(walletId, params as never);
      if (!sig) throw new Error('privy_sign_failed');
      return sig as `0x${string}`;
    },
  };
}

/**
 * Sign an L1 action (place order, cancel, modify, etc.) with a Privy server
 * wallet. The SDK computes the action hash + connectionId + typed data,
 * calls our wallet.signTypedData, and returns `{r, s, v}`.
 */
export async function hlSignL1Action(args: {
  walletId: string;
  walletAddress: `0x${string}`;
  action: Record<string, unknown> | unknown[];
  nonce: number;
  isMainnet?: boolean;
  vaultAddress?: `0x${string}` | null;
  expiresAfter?: number | null;
}): Promise<Signature> {
  // ADR-0004 — when agent wallets are on, L1 actions sign with the ephemeral
  // process agent (its own 100-nonce window at the venue) after a one-time
  // master-signed approveAgent. Approval failure FAILS OPEN to the master
  // path below. User-signed fund moves never route here — they always keep
  // the master wallet (hlSignUserSignedAction).
  if (hlAgentWalletsEnabled()) {
    const approved = await ensureAgentApproved({
      privyWalletId: args.walletId,
      privyWalletAddress: args.walletAddress,
    });
    if (approved) {
      try {
        return await sdkSignL1Action({
          wallet: getProcessAgent(),
          action: args.action,
          nonce: args.nonce,
          isTestnet: args.isMainnet === false,
          ...(args.vaultAddress ? { vaultAddress: args.vaultAddress } : {}),
          ...(args.expiresAfter ? { expiresAfter: args.expiresAfter } : {}),
        });
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'hl-signer: agent L1 signing failed — falling back to master',
        );
      }
    }
  }
  const wallet = privyWallet(args.walletId, args.walletAddress);
  try {
    return await sdkSignL1Action({
      wallet,
      action: args.action,
      nonce: args.nonce,
      isTestnet: args.isMainnet === false,
      ...(args.vaultAddress ? { vaultAddress: args.vaultAddress } : {}),
      ...(args.expiresAfter ? { expiresAfter: args.expiresAfter } : {}),
    });
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e), walletId: args.walletId.slice(0, 8) + '…' },
      'hl-signer: L1 action signing failed',
    );
    throw e;
  }
}

/**
 * Sign a user-signed action (approveBuilderFee, approveAgent, usdSend, etc.)
 * with a Privy server wallet. Returns `{r, s, v}` to slot into the
 * Hyperliquid `/exchange` request.
 */
export async function hlSignUserSignedAction(args: {
  walletId: string;
  walletAddress: `0x${string}`;
  action: { signatureChainId: `0x${string}`; [k: string]: unknown };
  types: { [key: string]: { name: string; type: string }[] };
}): Promise<Signature> {
  const wallet = privyWallet(args.walletId, args.walletAddress);
  try {
    return await sdkSignUserSignedAction({
      wallet,
      action: args.action,
      types: args.types,
    });
  } catch (e) {
    log.error(
      {
        err: e instanceof Error ? e.message : String(e),
        actionType: String(args.action['type'] ?? 'unknown'),
        walletId: args.walletId.slice(0, 8) + '…',
      },
      'hl-signer: user action signing failed',
    );
    throw e;
  }
}

// Moved to hl-config.ts (shared with the agent module); re-exported here so
// the existing adapter imports keep working unchanged.
export { HL_USER_SIGN_CHAIN_ID, HL_HYPERLIQUID_CHAIN } from './hl-config.js';

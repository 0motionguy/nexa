/**
 * x402 client settler.
 *
 * Builds EIP-712 typed-data for USDC/EURC `transferWithAuthorization` (EIP-3009),
 * has the user's Privy server wallet sign it, then POSTs the signed payload to
 * the Coinbase x402 facilitator (free for v1) for on-chain settlement on Base.
 *
 * Demo fallback: when chain features are off, returns a synthetic
 * `0xdemo<hex>` reference so local previews keep flowing. Live signing or
 * facilitator failures throw ChainError and must fail closed at the route.
 *
 * Spec: https://x402.org/spec/v1, https://eips.ethereum.org/EIPS/eip-3009
 */

import { createHash, randomBytes } from 'node:crypto';
import { createPublicClient, http, type Hex } from 'viem';
import { base } from 'viem/chains';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { ASSETS, ChainError, type AssetKey, usdToUsdcWei } from './units.js';
import type { WalletHandle } from './wallet.js';

export interface SignedAuth {
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
  asset: AssetKey;
}

export interface SettleResult {
  txHash: string;
  blockNumber: bigint;
  facilitator: 'coinbase' | 'demo';
}

export interface SignTransferAuthOptions {
  nonceSeed?: string | null;
}

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

function nonce32(seed?: string | null): Hex {
  const trimmed = seed?.trim();
  if (trimmed) {
    return `0x${createHash('sha256').update(trimmed).digest('hex')}` as Hex;
  }
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}

function domain(asset: AssetKey): { name: string; version: string; chainId: number; verifyingContract: Hex } {
  const name = asset === 'EURC' ? 'EURC' : 'USD Coin';
  return {
    name,
    version: '2',
    chainId: base.id, // 8453
    verifyingContract: ASSETS[asset].address,
  };
}

function isTxHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export class X402Settler {
  private readonly publicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
  });

  get isLive(): boolean {
    return features.chain && Boolean(env.BASE_RPC_URL);
  }

  /**
   * Build + sign an EIP-3009 transferWithAuthorization payload.
   *
   * Phase 3 — `signer` is the AGENT's WalletHandle (returned by
   * `walletService.getOrCreateAgentWallet`). The `from` field is the agent's
   * own address and `to` is the contract's `payee_address` (resolved by the
   * caller via `resolvePayeeAddress`). The signer's internal walletId is what
   * Privy uses to sign — no walletId param needed here because the handle
   * already binds to a specific walletId.
   *
   * Returns null in demo mode (no real signature available).
   */
  async signTransferAuth(
    from: Hex,
    to: Hex,
    valueUsd: number,
    asset: AssetKey,
    signer: WalletHandle,
    opts?: SignTransferAuthOptions,
  ): Promise<SignedAuth | null> {
    if (!signer.live) return null;

    const value = asset === 'USDC' || asset === 'EURC' ? usdToUsdcWei(valueUsd) : usdToUsdcWei(valueUsd);
    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
    const nonce = nonce32(opts?.nonceSeed);

    const typedData = {
      domain: domain(asset),
      types: TYPES,
      primaryType: 'TransferWithAuthorization' as const,
      message: { from, to, value, validAfter, validBefore, nonce },
    };

    try {
      const signature = await signer.signTypedData(typedData);
      if (!signature) return null;
      return { from, to, value, validAfter, validBefore, nonce, signature, asset };
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, 'x402: sign failed');
      throw new ChainError('sig_failed', 'EIP-3009 sign failed', e);
    }
  }

  /**
   * POST signed payload to the Coinbase facilitator. On success, returns the
   * settlement transaction hash + block number. On non-2xx response or chain
   * features disabled, throws `ChainError('facilitator_rejected')`.
   */
  async settleViaCoinbase(signed: SignedAuth): Promise<SettleResult> {
    if (!this.isLive) {
      return { txHash: this.demoRef(), blockNumber: 0n, facilitator: 'demo' };
    }
    const body = {
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      paymentPayload: {
        signature: signed.signature,
        authorization: {
          from: signed.from,
          to: signed.to,
          value: signed.value.toString(),
          validAfter: signed.validAfter.toString(),
          validBefore: signed.validBefore.toString(),
          nonce: signed.nonce,
        },
        asset: ASSETS[signed.asset].address,
      },
    };
    let res: Response;
    try {
      res = await fetch(`${env.X402_FACILITATOR_URL.replace(/\/+$/, '')}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'x402: facilitator unreachable');
      throw new ChainError('facilitator_unreachable', 'x402 facilitator unreachable', e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'x402: facilitator rejected');
      throw new ChainError('facilitator_rejected', `facilitator returned ${res.status}: ${text}`);
    }
    const data = (await res.json().catch(() => ({}))) as { transaction?: string };
    if (!isTxHash(data.transaction)) {
      // Log a narrow projection, not the raw body — the facilitator response
      // is unvalidated external input and future fields must not spill here.
      log.warn(
        { hasTransaction: typeof data.transaction === 'string' },
        'x402: facilitator response missing transaction',
      );
      throw new ChainError('facilitator_rejected', 'facilitator missing transaction hash');
    }
    const txHash = data.transaction;
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 60_000 });
      if ('status' in receipt && receipt.status !== 'success') {
        throw new ChainError('facilitator_rejected', 'x402 settlement reverted');
      }
      return { txHash, blockNumber: receipt.blockNumber, facilitator: 'coinbase' };
    } catch (e) {
      if (e instanceof ChainError) throw e;
      throw new ChainError('facilitator_rejected', 'x402 settlement receipt unavailable', e);
    }
  }

  /**
   * Build the X-PAYMENT header value per x402 spec (base64 JSON of the
   * payment payload).
   */
  buildXPaymentHeader(signed: SignedAuth): string {
    const payload = {
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      authorization: {
        from: signed.from,
        to: signed.to,
        value: signed.value.toString(),
        validAfter: signed.validAfter.toString(),
        validBefore: signed.validBefore.toString(),
        nonce: signed.nonce,
      },
      signature: signed.signature,
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  private demoRef(): string {
    return '0xdemo' + randomBytes(28).toString('hex');
  }
}

export const x402Settler = new X402Settler();

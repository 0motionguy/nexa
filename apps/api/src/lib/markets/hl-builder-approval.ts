import { ApproveBuilderFeeTypes } from '@nktkas/hyperliquid/api/exchange';
import { HL_EXCHANGE_URL } from './hl-config.js';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { store } from '../../store/index.js';
import {
  HL_HYPERLIQUID_CHAIN,
  HL_USER_SIGN_CHAIN_ID,
  hlSignUserSignedAction,
  nextHlNonce,
} from './hl-signer.js';

export const HL_BUILDER_FEE_CAP_TENTHS_BP = 100; // Hyperliquid perps max: 10 bps.

export function formatHlBuilderBpsAsPercent(bps: number): `${string}%` {
  const pct = bps / 100;
  return `${pct.toFixed(5).replace(/\.?0+$/, '')}%` as `${string}%`;
}

export function currentHlBuilderFeeTenths(): number {
  const raw = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0;
  return Math.max(0, Math.min(HL_BUILDER_FEE_CAP_TENTHS_BP, raw));
}

export function hlBuilderFeeEnabled(): boolean {
  return Boolean(env.HL_BUILDER_ADDRESS && currentHlBuilderFeeTenths() > 0);
}

export interface EnsureHlBuilderApprovalInput {
  userId: string;
  walletId: string | null;
  walletAddress: `0x${string}` | null;
  approvedAt?: string | null;
  approvedMaxFeeTenthsBp?: number | null;
  maxFeeBps?: number;
}

export type EnsureHlBuilderApprovalResult =
  | { ok: true; approved: boolean; requiredTenthsBp: number; maxFeeRate: `${string}%` | null }
  | { ok: false; status: 422 | 503; code: string; details?: unknown };

export async function ensureHlBuilderApproval(
  input: EnsureHlBuilderApprovalInput,
): Promise<EnsureHlBuilderApprovalResult> {
  if (!hlBuilderFeeEnabled()) {
    return { ok: true, approved: false, requiredTenthsBp: 0, maxFeeRate: null };
  }

  const requiredTenths = currentHlBuilderFeeTenths();
  const approvedTenths = input.approvedMaxFeeTenthsBp ?? 0;
  if (input.approvedAt && approvedTenths >= requiredTenths) {
    return {
      ok: true,
      approved: false,
      requiredTenthsBp: requiredTenths,
      maxFeeRate: formatHlBuilderBpsAsPercent(approvedTenths / 10),
    };
  }

  if (!features.privy) {
    return { ok: false, status: 503, code: 'privy_disabled' };
  }
  if (!env.HL_BUILDER_ADDRESS) {
    return { ok: false, status: 503, code: 'builder_address_unset' };
  }
  if (!input.walletId || !input.walletAddress) {
    return { ok: false, status: 503, code: 'trading_wallet_unavailable' };
  }

  const requestedMaxBps = Number(input.maxFeeBps ?? 0);
  const envBps = requiredTenths / 10;
  const safeMaxBps = Math.max(
    envBps,
    Math.min(10, Number.isFinite(requestedMaxBps) ? requestedMaxBps : envBps),
  );
  const maxFeeRate = formatHlBuilderBpsAsPercent(safeMaxBps);
  const builderLower = env.HL_BUILDER_ADDRESS.toLowerCase() as `0x${string}`;
  const nonce = nextHlNonce();
  const action = {
    type: 'approveBuilderFee' as const,
    signatureChainId: HL_USER_SIGN_CHAIN_ID,
    hyperliquidChain: HL_HYPERLIQUID_CHAIN,
    maxFeeRate,
    builder: builderLower,
    nonce,
  };

  try {
    const signature = await hlSignUserSignedAction({
      walletId: input.walletId,
      walletAddress: input.walletAddress,
      action,
      types: ApproveBuilderFeeTypes,
    });

    const res = await fetch(HL_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, signature, nonce }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      response?: string | { type?: string };
    };

    if (!res.ok || data.status !== 'ok') {
      const reason = typeof data.response === 'string' ? data.response : 'rejected';
      log.warn(
        { status: res.status, reason, userId: input.userId },
        'hyperliquid: builder agreement rejected',
      );
      return { ok: false, status: 422, code: 'builder_approval_rejected', details: { reason } };
    }

    const persistedTenths = Math.round(safeMaxBps * 10);
    await store.setHlBuilderApproval(input.userId, persistedTenths);
    return {
      ok: true,
      approved: true,
      requiredTenthsBp: persistedTenths,
      maxFeeRate,
    };
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e), userId: input.userId },
      'hyperliquid: builder agreement failed',
    );
    return { ok: false, status: 422, code: 'builder_approval_failed' };
  }
}

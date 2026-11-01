/**
 * Socket Swap V3 API bridge adapter — primary path in the BridgeRouter.
 *
 * Gated on `features.socket` (SOCKET_API_KEY set). Live: one GET to
 * `${SOCKET_API_BASE}/v3/swap/quote?userOps=tx&...&refuel=true|false` returns
 * `result.routes[0]` which includes `txData.object` (kind=`evm_tx`) — that
 * payload is the EVM transaction to submit (already encoded; approvals folded
 * in via the `approval` object if needed but Socket exposes both as separate
 * `txData` blocks in `approval.txData` when an explicit approval call is
 * required; for the v1 of this adapter we forward only the swap tx and rely on
 * upstream USDC approval — most v3 routes use Permit2 or the user has prior
 * allowance on the canonical socket gateway).
 *
 * Refuel: pass `refuel=true` to bundle a destination-gas drop. The card
 * top-up flow turns this on for Base → Gnosis by default so the user doesn't
 * need xDAI to settle the card transaction.
 *
 * Schema source:
 *   https://docs.socket.tech/integrate/integration-guides/socket-api.md
 *   https://docs.socket.tech/openapi.json
 * Retrieved: 2026-06-14.
 */

import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { env, features } from '../env.js';
import { log } from '../log.js';
import {
  CHAIN_IDS,
  type BridgeAdapter,
  type BridgeQuote,
  type BridgeQuoteInput,
  type Call,
  type Chain,
} from '../bridge-router.js';

/** Minimal ERC-20 approve ABI — used to synthesize an approval call when
 *  Socket returns allowance metadata instead of a ready-made approval tx. */
const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount)']);
/** uint256 max — a one-time infinite approval avoids re-approving every bridge. */
const MAX_UINT256 = (2n ** 256n) - 1n;

/**
 * Token addresses per chain. USDC + EURC on Base reuse the env-pinned addresses;
 * Gnosis EURe is pinned here (Monerium's EUR e-money token, the Gnosis Pay card
 * settlement token). Polygon/Optimism/Arbitrum USDC pinned to the canonical
 * native USDC contracts (Circle), not bridged USDC.e.
 */
const TOKENS: Record<Chain, Partial<Record<string, string>>> = {
  base: {
    USDC: env.USDC_ADDRESS,
    EURC: env.EURC_ADDRESS,
  },
  gnosis: {
    /** EURe (Monerium EUR e-money) on Gnosis Chain — same constant LIFI uses. */
    EURe: '0xcB444e90D8198415266c6a2724b7900fb12FC56E',
  },
  polygon: {
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  optimism: {
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  arbitrum: {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
};

interface SocketRoute {
  quoteId?: string;
  output?: {
    amount?: string;
    minAmountOut?: string;
    valueInUsd?: number;
  };
  txData?: {
    kind?: string;
    object?: {
      chainId?: number;
      to?: string;
      data?: string;
      value?: string;
    };
  };
  gasFee?: {
    feeInUsd?: number;
    estimatedFee?: string;
  };
  refuel?: {
    /** Destination-side gas value in USD (when the refuel feature is bundled). */
    estimatedOutputUsd?: number;
    estimatedOutput?: string;
  };
  /**
   * ERC-20 approval the sender must grant before the swap tx can execute.
   * Socket returns this when the user's allowance on the gateway is short.
   * Two documented shapes are parsed defensively (see `buildApprovalCall`):
   *   - a ready-made executable tx under `txData.object`, or
   *   - allowance metadata (`allowanceTarget`/`spender` + token + min amount)
   *     from which we synthesize the `approve()` call.
   */
  approval?: {
    txData?: {
      object?: { to?: string; data?: string; value?: string };
    };
    allowanceTarget?: string;
    spender?: string;
    approvalTokenAddress?: string;
    tokenAddress?: string;
    minimumApprovalAmount?: string;
    approvalAmount?: string;
  };
}

/**
 * Turn a route's `approval` block into an executable `Call`, or null when no
 * approval is required. Prefers Socket's ready-made approval tx; otherwise
 * synthesizes an ERC-20 `approve(spender, MAX_UINT256)` against the token
 * for the allowance target. A missing spender/token means "no approval".
 */
function buildApprovalCall(approval: SocketRoute['approval']): Call | null {
  if (!approval) return null;
  const tx = approval.txData?.object;
  if (tx?.to && tx.data) {
    return { to: tx.to, data: tx.data, value: tx.value ?? '0' };
  }
  const spender = approval.allowanceTarget ?? approval.spender;
  const token = approval.approvalTokenAddress ?? approval.tokenAddress;
  if (!spender || !token) return null;
  const data = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [spender as Hex, MAX_UINT256],
  });
  return { to: token, data, value: '0' };
}

interface SocketQuoteEnvelope {
  success?: boolean;
  statusCode?: number;
  result?: {
    routes?: SocketRoute[];
  };
}

export class SocketAdapter implements BridgeAdapter {
  readonly name = 'socket' as const;

  get isLive(): boolean {
    // Sprint 17 F074 — `features.socket` is already `Boolean(env.SOCKET_API_KEY)`
    // (see lib/env.ts). The compound check was redundant.
    return features.socket;
  }

  async quote(input: BridgeQuoteInput): Promise<BridgeQuote | null> {
    if (!this.isLive) return null;
    const fromChainId = CHAIN_IDS[input.fromChain];
    const toChainId = CHAIN_IDS[input.toChain];
    if (!fromChainId || !toChainId) return null;
    const fromTokenAddr = TOKENS[input.fromChain]?.[input.fromToken];
    const toTokenAddr = TOKENS[input.toChain]?.[input.toToken];
    if (!fromTokenAddr || !toTokenAddr) return null;

    // Socket Swap V3 GET /v3/swap/quote params. `userOps=tx` selects executable
    // transaction routes (we don't want deposit-address or CEX-withdraw routes
    // since those require a separate UX). USDC/EURC/EURe/USDT all use 6 dec.
    const params = new URLSearchParams({
      userOps: 'tx',
      originChainId: String(fromChainId),
      destinationChainId: String(toChainId),
      inputToken: fromTokenAddr,
      outputToken: toTokenAddr,
      inputAmount: String(Math.floor(input.amountUsd * 1_000_000)),
      userAddress: input.userAddress,
      receiverAddress: input.userAddress,
      ...(input.enableRefuel ? { refuel: 'true' } : {}),
    });

    try {
      const url = `${env.SOCKET_API_BASE.replace(/\/+$/, '')}/v3/swap/quote?${params}`;
      // Auth header: Socket's docs are unreachable from CI (Cloudflare 403),
      // and the header name is contested across sources (`API-KEY` vs
      // `x-api-key`). Send both — the server ignores the one it doesn't use —
      // so a header-name mismatch can never 401 the live path. `AFFILIATE-ID`
      // (when set) earns integrator fees. Collapse to the confirmed header
      // after the supervised go-live test.
      const apiKey = env.SOCKET_API_KEY ?? '';
      const headers: Record<string, string> = {
        'API-KEY': apiKey,
        'x-api-key': apiKey,
        accept: 'application/json',
      };
      if (env.SOCKET_AFFILIATE_ID) headers['AFFILIATE-ID'] = env.SOCKET_AFFILIATE_ID;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn(
          { status: res.status, text },
          'socket: /v3/swap/quote rejected — bridge-router will fall back to LIFI',
        );
        return null;
      }
      const body = (await res.json().catch(() => ({}))) as SocketQuoteEnvelope;
      const route = body?.result?.routes?.[0];
      if (!route) return null;
      const tx = route.txData?.object;
      if (!tx?.to || !tx.data) {
        log.warn({ quoteId: route.quoteId }, 'socket: quote returned no txData.object');
        return null;
      }
      const fromAmount = String(Math.floor(input.amountUsd * 1_000_000));
      const toAmount = route.output?.amount ?? '0';
      const toAmountMin = route.output?.minAmountOut ?? toAmount;
      const rate =
        Number(toAmount) > 0 && Number(fromAmount) > 0
          ? Number(toAmount) / Number(fromAmount)
          : 0;
      const estimatedGasUsd = Number(route.gasFee?.feeInUsd ?? 0);
      const refuelGasUsd =
        input.enableRefuel && route.refuel
          ? Number(route.refuel.estimatedOutputUsd ?? 0)
          : undefined;
      // Prepend the ERC-20 approval when the route requires one — otherwise a
      // first-time bridger (no prior allowance on the Socket gateway) reverts.
      // The executor sends the Call[] in sequence, so [approve, swap] is safe.
      const approvalCall = buildApprovalCall(route.approval);
      const swapCall: Call = { to: tx.to, data: tx.data, value: tx.value ?? '0' };
      return {
        provider: 'socket',
        calls: approvalCall ? [approvalCall, swapCall] : [swapCall],
        estimate: {
          fromAmount,
          toAmount,
          toAmountMin,
          rate,
          estimatedGasUsd,
          ...(refuelGasUsd !== undefined ? { refuelGasUsd } : {}),
        },
        raw: route,
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'socket: /v3/swap/quote unreachable — bridge-router will fall back to LIFI',
      );
      return null;
    }
  }
}

export const socketAdapter = new SocketAdapter();

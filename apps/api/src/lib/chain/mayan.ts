/**
 * Mayan Finance adapter — intent-based cross-chain swap.
 *
 * Mayan's price-api is a public quote endpoint (no auth) covering Solana ↔ EVM
 * routes (Base, Ethereum, Arbitrum, Optimism, BNB, Sui, HyperEVM, etc.) using
 * three methods:
 *
 *   - Swift  — intent-based, fastest (~3-5 seconds)
 *   - MCTP   — stablecoin-optimised
 *   - Wormhole — high-value transfers
 *
 * The product exposes live quotes and routes Solana legs through Mayan
 * execution from `/swap/execute`.
 *
 * Docs:
 *   https://docs.mayan.finance/
 *   https://docs.mayan.finance/integration/quote-api.md
 *   https://github.com/mayan-finance/swap-sdk
 */

import { log } from '../log.js';
import { ASSETS, ChainError } from './units.js';
import { createRequire } from 'node:module';
import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';
import { env } from '../env.js';
import { venueBreadcrumb } from '../observability/venue-breadcrumb.js';

const DEFAULT_API_URL = 'https://price-api.mayan.finance/v3/quote';
const DEFAULT_SOLANA_PROGRAM = 'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf';
const DEFAULT_SDK_VERSION = '13_1_0';

export type MayanChain =
  | 'base'
  | 'ethereum'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'bsc'
  | 'avalanche'
  | 'solana'
  | 'sui'
  | 'hyperevm';

export interface MayanQuoteInput {
  /** Amount in the source token's nominal units (e.g. 100 = 100 USDC). */
  amountIn: number;
  /** Source-chain token address (hex for EVM, base58 mint for Solana, 0x000... for native). */
  fromToken: string;
  fromChain: MayanChain;
  /** Destination-chain token address. */
  toToken: string;
  toChain: MayanChain;
  /** Slippage in basis points (300 = 3%). */
  slippageBps: number;
  /** Destination-chain gas drop in source units (0 = no drop). */
  gasDrop?: number;
  /** Solana program override — defaults to Mayan's main program. */
  solanaProgram?: string;
}

export interface MayanQuote {
  type: 'SWIFT' | 'MCTP' | 'FAST_MCTP' | 'WORMHOLE';
  amountIn?: number;
  expectedAmountOut: number;
  minAmountOut: number;
  /** Quoted FX rate (toAmount / fromAmount). */
  price: number;
  etaSeconds: number;
  redeemRelayerFee: number;
  fromSymbol: string;
  toSymbol: string;
  fromChain: MayanChain;
  toChain: MayanChain;
}

interface MayanQuoteResponse {
  quotes?: Array<{
    type?: string;
    expectedAmountOut?: number;
    minAmountOut?: number;
    price?: number;
    etaSeconds?: number;
    redeemRelayerFee?: number;
    fromToken?: { symbol?: string };
    toToken?: { symbol?: string };
    fromChain?: string;
    toChain?: string;
  }>;
  code?: string;
  msg?: string;
}

/**
 * Fetch Mayan quotes. Returns an array sorted by `expectedAmountOut` desc
 * (best first). Throws ChainError when no route is available.
 *
 * No auth. Public endpoint.
 */
export async function fetchMayanQuote(
  input: MayanQuoteInput,
  opts: { fetchImpl?: typeof fetch; apiUrl?: string } = {},
): Promise<MayanQuote[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const params = new URLSearchParams({
    amountIn: String(input.amountIn),
    fromToken: input.fromToken,
    fromChain: input.fromChain,
    toToken: input.toToken,
    toChain: input.toChain,
    slippageBps: String(input.slippageBps),
    gasDrop: String(input.gasDrop ?? 0),
    swift: 'true',
    mctp: 'true',
    fastMctp: 'true',
    wormhole: 'true',
    solanaProgram: input.solanaProgram ?? DEFAULT_SOLANA_PROGRAM,
    sdkVersion: DEFAULT_SDK_VERSION,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(`${apiUrl}?${params}`, { signal: ctrl.signal });
    if (!res.ok) throw new ChainError('rpc_failed', `Mayan quote ${res.status}`);
    const body = (await res.json()) as MayanQuoteResponse;
    if (body.code === 'ROUTE_NOT_FOUND' || !body.quotes?.length) {
      throw new ChainError('rpc_failed', `Mayan: ${body.msg ?? 'no route'}`);
    }
    return body.quotes
      .filter((q) => typeof q.expectedAmountOut === 'number')
      .map((q) => ({
        type: (q.type ?? 'SWIFT') as MayanQuote['type'],
        amountIn: input.amountIn,
        expectedAmountOut: q.expectedAmountOut ?? 0,
        minAmountOut: q.minAmountOut ?? 0,
        price: q.price ?? 0,
        etaSeconds: q.etaSeconds ?? 0,
        redeemRelayerFee: q.redeemRelayerFee ?? 0,
        fromSymbol: q.fromToken?.symbol ?? '',
        toSymbol: q.toToken?.symbol ?? '',
        fromChain: (q.fromChain ?? input.fromChain) as MayanChain,
        toChain: (q.toChain ?? input.toChain) as MayanChain,
      }))
      .sort((a, b) => b.expectedAmountOut - a.expectedAmountOut);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sprint 16.3 — SDK availability is checked once at module load (`require.
 * resolve` is non-trivial; the answer only changes on process restart).
 */
const requireFromHere = createRequire(import.meta.url);
const MAYAN_HAS_SDK: boolean = (() => {
  try {
    requireFromHere.resolve('@mayanfinance/swap-sdk');
    return true;
  } catch {
    return false;
  }
})();

/**
 * Audit 2026-06-19 — Mayan execute helper, not product wiring.
 *
 * Solana-source (SOL/USDC Solana → USDC Base etc.): `swapFromSolana` callback-
 * based signing — Privy server wallet signs the serialized message, SDK
 * submits internally over the configured Solana RPC.
 *
 * EVM-source (USDC Base → SOL Solana etc.): we don't build an ethers.js
 * Signer wrapper around the Privy server wallet (that's a 2h side quest).
 * Instead we use the SDK's lower-level `getSwapFromEvmTxPayload` to get the
 * unsigned `TransactionRequest` (`{to, data, value, chainId, …}`), then
 * submit it via our existing EIP-7702 sponsored executor — same path Aave/
 * Compound/Morpho deposits use. Privy signs the prepared userop hash via
 * `signRawWithPrivy`; the user pays no gas; the SDK handles forwarder/permit
 * via its built-in `_forwarder` field.
 *
 * The quote object's `fromChain` tells us which path to take. Chain id is
 * resolved from the chain name via EVM_CHAIN_IDS below. `/swap/execute`
 * calls this helper for any route involving Solana.
 */
const EVM_CHAIN_IDS: Record<string, number> = {
  base: 8453,
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  bsc: 56,
  avalanche: 43114,
  hyperevm: 999,
};

function isEvmSourceChain(chain: string): boolean {
  return chain in EVM_CHAIN_IDS;
}

/* ── REL-03 (Sprint 17.5) — USDC allowance pre-flight for EVM source ──────
 * Mayan's swap forwarder needs ERC-20 transferFrom against the user's USDC
 * balance on the source chain. For permit-supporting tokens (Base USDC is
 * EIP-2612) the SDK includes a signed permit in calldata and no on-chain
 * approve is needed; for older variants (Ethereum legacy USDC), the user
 * must pre-approve the forwarder. We don't know which path the SDK takes
 * for a given quote without inspecting calldata, so we ALWAYS read the
 * current allowance and prepend an approve if it's below the swap amount.
 *
 * The approve is a no-op on-chain when an EIP-2612 permit is also included
 * (the forwarder just doesn't read the on-chain allowance), so the cost is
 * one extra ~46k gas line item that the sponsored executor covers. Safer
 * than the alternative (first-swap revert with no error message).
 */
const ERC20_ABI_MAYAN = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** Resolve the viem chain object for a Mayan chain name. */
function viemChainFor(chainName: string): typeof base | typeof mainnet | typeof arbitrum | typeof optimism | typeof polygon | null {
  switch (chainName) {
    case 'base':
      return base;
    case 'ethereum':
      return mainnet;
    case 'arbitrum':
      return arbitrum;
    case 'optimism':
      return optimism;
    case 'polygon':
      return polygon;
    default:
      return null;
  }
}

/** Resolve a public RPC URL for a Mayan EVM chain (Base uses BASE_RPC_URL). */
function rpcUrlFor(chainName: string): string | undefined {
  if (chainName === 'base') return env.BASE_RPC_URL ?? 'https://mainnet.base.org';
  return undefined; // viem falls back to chain.rpcUrls.default
}

/**
 * Read USDC.allowance(user, spender) and return whether an approve call
 * is required for `amount`. Returns true on read failure (fail-open: better
 * to add a redundant approve than to revert the swap).
 */
async function needsUsdcApproval(
  chainName: string,
  userAddress: string,
  spender: string,
  amount: bigint,
): Promise<boolean> {
  const chain = viemChainFor(chainName);
  if (!chain) return true; // unknown chain — let the swap attempt anyway with approve prepended
  try {
    const client = createPublicClient({ chain, transport: http(rpcUrlFor(chainName)) });
    const current = (await client.readContract({
      address: ASSETS.USDC.address,
      abi: ERC20_ABI_MAYAN,
      functionName: 'allowance',
      args: [userAddress as Hex, spender as Hex],
    })) as bigint;
    return current < amount;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), chainName, userAddress, spender },
      'mayan: allowance read failed; defaulting to approve prepend',
    );
    return true;
  }
}

/**
 * Build the USDC.approve calldata for the executor multicall. Uses the
 * MAX_UINT256 amount so the user only ever does this once per spender per
 * chain (instead of re-approving each swap). Mayan's audited contracts are
 * the spender, which limits the blast radius.
 *
 * Exported for the REL-03 unit test (TEST-03 sibling).
 */
export function buildUsdcApproveCall(spender: string): { to: Hex; data: Hex } {
  return {
    to: ASSETS.USDC.address,
    data: encodeFunctionData({
      abi: ERC20_ABI_MAYAN,
      functionName: 'approve',
      args: [spender as Hex, (2n ** 256n) - 1n],
    }) as Hex,
  };
}

export async function executeMayanSwap(args: {
  quote: MayanQuote;
  signSolanaTx?: (messageBase64: string) => Promise<string | null>;
  signTypedData?: (typedData: unknown) => Promise<string | null>;
  fromAddress: string;
  toAddress: string;
  /**
   * Audit 2026-06-19 — for EVM-source swaps, we submit the SDK-built
   * TransactionRequest through the user's sponsored executor. The caller
   * passes the userId so `executor.sendCalls(userId, …)` can resolve the
   * Privy signer for them. Solana-source swaps don't need this.
   */
  userId?: string;
  idempotencyKey?: string | null;
  /**
   * NEO bridge skim — Mayan's native referrer fee. Pass treasury addresses
   * for both Solana + EVM legs (Mayan picks the right one based on the swap
   * direction). The Mayan referrer system collects the configured bps off
   * the swap output and routes it to these addresses. No extra signature,
   * no extra tx — handled inside Mayan's SDK call. Skipped cleanly when
   * either field is unset.
   */
  referrer?: { solana?: string; evm?: string };
}): Promise<
  | { status: 'unavailable'; reason: string }
  | { status: 'submitted'; sourceTxId: string; trackingUrl: string }
> {
  if (!MAYAN_HAS_SDK) {
    return { status: 'unavailable', reason: '@mayanfinance/swap-sdk not installed' };
  }
  const fromChain = String(args.quote.fromChain ?? '');
  venueBreadcrumb('mayan', 'swap.start', {
    fromChain,
    toChain: String(args.quote.toChain ?? ''),
    type: String(args.quote.type ?? ''),
    expectedAmountOut: args.quote.expectedAmountOut,
  });

  // ── EVM source ────────────────────────────────────────────────────────
  if (isEvmSourceChain(fromChain)) {
    if (!args.userId) {
      return { status: 'unavailable', reason: 'evm_source_requires_userId' };
    }
    const chainId = EVM_CHAIN_IDS[fromChain] as number;
    try {
      const mayan = await import('@mayanfinance/swap-sdk');
      const { executor } = await import('./alchemy.js');
      // SDK exports vary by version — narrow via cast. Function shape:
      // getSwapFromEvmTxPayload(quote, swapperAddress, destAddress, referrer,
      //   signerAddress, signerChainId, payload, permit, opts?) →
      //   TransactionRequest & { _forwarder }
      const buildPayload = (mayan as unknown as {
        getSwapFromEvmTxPayload?: (
          quote: unknown,
          swapper: string,
          dest: string,
          referrer: unknown,
          signerAddr: string,
          signerChainId: number,
          payload: unknown,
          permit: unknown,
        ) => Promise<{ to: string; data: string; value?: string | bigint; chainId?: number }>;
      }).getSwapFromEvmTxPayload;
      if (!buildPayload) {
        return { status: 'unavailable', reason: 'sdk_getSwapFromEvmTxPayload_missing' };
      }
      // Mayan referrer — pass the per-network treasury addresses so Mayan
      // collects the dashboard-configured bps off the swap output. Falls back
      // to `undefined` cleanly when no referrer is configured.
      const referrerArg = args.referrer && (args.referrer.solana || args.referrer.evm)
        ? { solana: args.referrer.solana, evm: args.referrer.evm }
        : undefined;
      const payload = await buildPayload(
        args.quote,
        args.fromAddress,
        args.toAddress,
        referrerArg,
        args.fromAddress,
        chainId,
        undefined,
        undefined,
      );
      if (!payload.to || !payload.data) {
        return { status: 'unavailable', reason: 'sdk_payload_invalid' };
      }
      // REL-03 — USDC allowance pre-flight. The swap forwarder is the
      // address Mayan returns as `payload.to`. For permit-enabled USDC
      // (Base) this is redundant; for legacy USDC variants it's the
      // difference between success and a revert with no error string.
      const swapAmountUsdc = BigInt(Math.floor((args.quote.amountIn ?? args.quote.expectedAmountOut) * 1e6));
      const calls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      try {
        const needApprove = await needsUsdcApproval(
          fromChain,
          args.fromAddress,
          payload.to,
          swapAmountUsdc,
        );
        if (needApprove) {
          const approveCall = buildUsdcApproveCall(payload.to);
          calls.push({ to: approveCall.to, data: approveCall.data });
          log.info(
            { fromChain, spender: payload.to, swapAmountUsdc: swapAmountUsdc.toString() },
            'mayan: prepending USDC.approve(MAX) before swap',
          );
        }
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), fromChain },
          'mayan: allowance pre-flight failed; proceeding without approve',
        );
      }
      calls.push({ to: payload.to as `0x${string}`, data: payload.data as `0x${string}` });
      venueBreadcrumb('mayan', 'swap.evm.submit', {
        chainId,
        spender: payload.to,
        callCount: calls.length,
      });
      const result = await executor.sendCalls(args.userId, calls, {
        chainId,
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      });
      if (result.demo) {
        return { status: 'unavailable', reason: 'executor_demo_fallback' };
      }
      return {
        status: 'submitted',
        sourceTxId: result.txHash,
        trackingUrl: `https://explorer.mayan.finance/swap/${result.txHash}`,
      };
    } catch (e) {
      log.error(
        { err: e instanceof Error ? e.message : String(e) },
        'mayan: EVM-source swap execute failed',
      );
      return { status: 'unavailable', reason: 'swap_failed' };
    }
  }

  // ── Solana source ─────────────────────────────────────────────────────
  if (fromChain !== 'solana') {
    return { status: 'unavailable', reason: `unsupported_source_chain:${fromChain}` };
  }
  if (!args.signSolanaTx) {
    return { status: 'unavailable', reason: 'solana_signer_missing' };
  }
  const rpcUrl =
    process.env['HELIUS_RPC_URL'] ??
    process.env['CHAINSTACK_SOLANA_RPC_URL'] ??
    process.env['SOLANA_RPC_URL'] ??
    null;
  if (!rpcUrl) {
    return { status: 'unavailable', reason: 'solana_rpc_url_missing' };
  }
  try {
    const web3 = await import('@solana/web3.js');
    const mayan = await import('@mayanfinance/swap-sdk');
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    // The SDK's signTransaction callback receives a Transaction and must
    // return it signed. We bridge: serialize message → Privy sign → attach
    // signature. The SDK then submits internally.
    const fromPubkey = new web3.PublicKey(args.fromAddress);
    const signTransaction = async (tx: InstanceType<typeof web3.Transaction>) => {
      tx.feePayer = fromPubkey;
      if (!tx.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
      }
      const messageBase64 = Buffer.from(tx.serializeMessage()).toString('base64');
      const sig = await args.signSolanaTx!(messageBase64);
      if (!sig) throw new Error('privy_signature_unavailable');
      tx.addSignature(fromPubkey, Buffer.from(sig, 'base64'));
      return tx;
    };
    // SDK signature varies across versions; cast through. swapFromSolana
    // takes (quote, walletAddress, destAddress, referrerAddresses,
    // signTransaction, connection, extraRpcs?).
    const fn = (mayan as unknown as { swapFromSolana?: (...a: unknown[]) => Promise<unknown> }).swapFromSolana;
    if (!fn) {
      return { status: 'unavailable', reason: 'sdk_swapfromsolana_missing' };
    }
    // Mayan referrer for Solana-source swap (see EVM-source path above).
    const referrerArg = args.referrer && (args.referrer.solana || args.referrer.evm)
      ? { solana: args.referrer.solana, evm: args.referrer.evm }
      : undefined;
    const submitted = await fn(
      args.quote,
      args.fromAddress,
      args.toAddress,
      referrerArg,
      signTransaction,
      connection,
    );
    const sourceTxId = mayanSourceTxId(submitted);
    if (typeof sourceTxId !== 'string') {
      return { status: 'unavailable', reason: 'sdk_returned_non_string' };
    }
    return {
      status: 'submitted',
      sourceTxId,
      trackingUrl: `https://explorer.mayan.finance/swap/${sourceTxId}`,
    };
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'mayan: swap execute failed',
    );
    return { status: 'unavailable', reason: 'swap_failed' };
  }
}

export function mayanSourceTxId(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof (result as { signature?: unknown }).signature === 'string') {
    return (result as { signature: string }).signature;
  }
  return null;
}

/** Adapter capability snapshot for the provider registry. */
export function mayanCapability(): {
  provider: 'mayan';
  surfaces: { quoteRead: boolean; execute: boolean };
  supportedChains: MayanChain[];
  notes: string;
} {
  return {
    provider: 'mayan',
    surfaces: {
      quoteRead: true,
      execute: true,
    },
    supportedChains: [
      'base',
      'ethereum',
      'arbitrum',
      'optimism',
      'polygon',
      'bsc',
      'avalanche',
      'solana',
      'sui',
      'hyperevm',
    ],
    notes:
      'Intent-based cross-chain swap. Solana <-> EVM via Swift (~3s) / MCTP / Wormhole. Free quote API; /swap routes Solana legs through Mayan execute.',
  };
}

/**
 * Lightweight Mayan adapter exposing quotes and execute for Solana routes.
 * The adapter is always live for quotes because Mayan's API is free + public.
 */
export class MayanAdapter {
  get isLive(): boolean {
    return true; // quotes are public
  }

  async quote(input: MayanQuoteInput): Promise<MayanQuote[]> {
    if (process.env['VITEST']) {
      throw new ChainError('rpc_failed', 'Mayan quote disabled in vitest');
    }
    return fetchMayanQuote(input);
  }

  async execute(args: Parameters<typeof executeMayanSwap>[0]): ReturnType<typeof executeMayanSwap> {
    return executeMayanSwap(args);
  }
}

export const mayanAdapter = new MayanAdapter();

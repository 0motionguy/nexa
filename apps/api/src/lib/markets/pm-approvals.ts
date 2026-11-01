/**
 * Polymarket on-chain trading approvals (competitor sprint Lane A follow-up,
 * 2026-07-03) — the live-sell (and live-buy) unblock.
 *
 * CLOB trades settle on Polygon: SELLs move CTF ERC-1155 outcome tokens and
 * BUYs spend the collateral ERC-20, both via Polymarket's exchange contracts.
 * A wallet must therefore grant, once:
 *   - `setApprovalForAll(exchange, true)` on the CTF for every exchange
 *     generation our SDK can sign against, and
 *   - `approve(exchange, max)` on the collateral token.
 *
 * The operator/collateral set is read from `@polymarket/clob-client-v2`'s own
 * `getContractConfig(137)` — the EXACT config our order signing uses, so the
 * approvals can never drift from the orders (SDK 1.0.8: legacy exchange +
 * negRiskExchange + negRiskAdapter + exchangeV2 + negRiskExchangeV2 +
 * exchangeV3; collateral = pUSD proxy 0xC011…2DFB, NOT bridged USDC.e).
 *
 * Deposit-rail close-out (2026-07-05): funding arrives as NATIVE USDC (what
 * CCTP mints) or USDC.e, while the CLOB settles pUSD. `convertPmCollateral`
 * ('wrap') now covers the full funnel: native → USDC.e (Uniswap V3 0.01%
 * pool, sponsored, step 'swap') → pUSD (CollateralOnramp, step 'ramp'). Each
 * call executes exactly ONE batch; call wrap until step 'ramp' lands.
 *
 * Writes ride `executor.sendCalls` (EIP-7702, Alchemy Gas Manager) so the
 * user's wallet needs ZERO POL — all missing approvals batch into ONE
 * sponsored user operation. Reads use a plain viem public client on
 * POLYGON_RPC_URL. Everything degrades to an explicit non-live result rather
 * than guessing — money paths never fail open.
 */

import { createPublicClient, encodeFunctionData, erc20Abi, http, maxUint256, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { env } from '../env.js';
import { log } from '../log.js';
import { executor, type SponsoredCall } from '../chain/alchemy.js';

const POLY_CHAIN_ID = 137;

const CTF_ABI = parseAbi([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]);

/**
 * pUSD rails (docs.polymarket.com/concepts/pusd.md, verified 2026-07-03):
 * pUSD is a 1:1 ERC-20 wrapper over USDC.e; the CLOB settles all trading in
 * it. Wrap via CollateralOnramp.wrap(asset, to, amount) after approving the
 * onramp on USDC.e; unwrap via CollateralOfframp.unwrap(asset, to, amount)
 * after approving the offramp on pUSD. Addresses from the official contracts
 * page (docs.polymarket.com/resources/contracts.md).
 */
const USDCE_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const COLLATERAL_ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee' as `0x${string}`;
const COLLATERAL_OFFRAMP = '0x2957922Eb93258b93368531d39fAcCA3B4dC5854' as `0x${string}`;
const RAMP_ABI = parseAbi([
  'function wrap(address _asset, address _to, uint256 _amount)',
  'function unwrap(address _asset, address _to, uint256 _amount)',
]);
/** pUSD/USDC.e both use 6 decimals. */
const COLLATERAL_DECIMALS = 1_000_000;

/** ERC-20 allowances below this threshold count as "needs approval". */
const MIN_ALLOWANCE = maxUint256 / 2n;

/**
 * Native→USDC.e conversion for the wrap lane (deposit-rail close-out,
 * 2026-07-05): CCTP mints NATIVE USDC on Polygon, but the CollateralOnramp
 * wraps USDC.e ONLY. Bridge the two via the canonical Uniswap V3 0.01% pool
 * 0xd36ec33c8bed5a9f7b6630855f1533455b98a418 (probed 2026-07-05: liquidity
 * 1.44e15, spot 0.999998). Router approval is exact-amount inside each batch
 * — no standing allowance is left behind.
 */
const NATIVE_USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`;
const UNIV3_SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as `0x${string}`;
const UNIV3_USDC_FEE_TIER = 100;
/** amountOutMinimum guard: 30 bps under input on a 1:1-pegged stable pool. */
const SWAP_SLIPPAGE_BPS = 30n;
const SWAP_ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

export interface PmApprovalItem {
  /** Config key in the SDK contract map, e.g. "exchangeV3". */
  key: string;
  operator: `0x${string}`;
  /** ERC-1155 operator approval on the CTF. */
  ctfApproved: boolean;
  /** ERC-20 allowance on the collateral token. */
  collateralApproved: boolean;
}

export interface PmTradingStatus {
  /** False when no Polygon RPC is configured — approvals unknowable. */
  live: boolean;
  collateral: `0x${string}` | null;
  conditionalTokens: `0x${string}` | null;
  approvals: PmApprovalItem[];
  missingCount: number;
  /** pUSD wrap/unwrap readiness + balances (USD floats, 6-dp tokens). */
  rails?: {
    onrampApproved: boolean;
    offrampApproved: boolean;
    usdceUsd: number;
    pusdUsd: number;
    /** CCTP-delivered native USDC awaiting the `wrap` swap step. */
    nativeUsd: number;
  };
}

interface PmContractSet {
  conditionalTokens: `0x${string}`;
  collateral: `0x${string}`;
  operators: Array<{ key: string; address: `0x${string}` }>;
}

async function contracts(): Promise<PmContractSet> {
  const { getContractConfig } = await import('@polymarket/clob-client-v2');
  const cfg = getContractConfig(POLY_CHAIN_ID) as Record<string, string>;
  const operatorKeys = [
    'exchange',
    'negRiskExchange',
    'negRiskAdapter',
    'exchangeV2',
    'negRiskExchangeV2',
    'exchangeV3',
  ];
  return {
    conditionalTokens: cfg.conditionalTokens as `0x${string}`,
    collateral: cfg.collateral as `0x${string}`,
    operators: operatorKeys
      .filter((k) => typeof cfg[k] === 'string' && cfg[k]!.startsWith('0x'))
      .map((k) => ({ key: k, address: cfg[k] as `0x${string}` })),
  };
}

function polygonClient(): ReturnType<typeof createPublicClient> | null {
  if (!env.POLYGON_RPC_URL) return null;
  return createPublicClient({ chain: polygon, transport: http(env.POLYGON_RPC_URL) });
}

/** Read the wallet's current approval state. Unknown (no RPC) → live:false. */
export async function getPmTradingStatus(owner: `0x${string}`): Promise<PmTradingStatus> {
  const set = await contracts();
  const client = polygonClient();
  if (!client) {
    return {
      live: false,
      collateral: set.collateral,
      conditionalTokens: set.conditionalTokens,
      approvals: [],
      missingCount: 0,
    };
  }
  const [approvals, onrampAllowance, offrampAllowance, usdceAtoms, pusdAtoms, nativeAtoms] = await Promise.all([
    Promise.all(
      set.operators.map(async ({ key, address }) => {
        const [ctfApproved, allowance] = await Promise.all([
          client
            .readContract({
              address: set.conditionalTokens,
              abi: CTF_ABI,
              functionName: 'isApprovedForAll',
              args: [owner, address],
            })
            .catch(() => false),
          client
            .readContract({
              address: set.collateral,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [owner, address],
            })
            .catch(() => 0n),
        ]);
        return { key, operator: address, ctfApproved, collateralApproved: allowance >= MIN_ALLOWANCE };
      }),
    ),
    client
      .readContract({ address: USDCE_POLYGON, abi: erc20Abi, functionName: 'allowance', args: [owner, COLLATERAL_ONRAMP] })
      .catch(() => 0n),
    client
      .readContract({ address: set.collateral, abi: erc20Abi, functionName: 'allowance', args: [owner, COLLATERAL_OFFRAMP] })
      .catch(() => 0n),
    client
      .readContract({ address: USDCE_POLYGON, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
      .catch(() => 0n),
    client
      .readContract({ address: set.collateral, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
      .catch(() => 0n),
    client
      .readContract({ address: NATIVE_USDC_POLYGON, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
      .catch(() => 0n),
  ]);
  const rails = {
    onrampApproved: onrampAllowance >= MIN_ALLOWANCE,
    offrampApproved: offrampAllowance >= MIN_ALLOWANCE,
    usdceUsd: Number(usdceAtoms) / COLLATERAL_DECIMALS,
    pusdUsd: Number(pusdAtoms) / COLLATERAL_DECIMALS,
    nativeUsd: Number(nativeAtoms) / COLLATERAL_DECIMALS,
  };
  return {
    live: true,
    collateral: set.collateral,
    conditionalTokens: set.conditionalTokens,
    approvals,
    rails,
    missingCount:
      approvals.reduce((n, a) => n + (a.ctfApproved ? 0 : 1) + (a.collateralApproved ? 0 : 1), 0) +
      (rails.onrampApproved ? 0 : 1) +
      (rails.offrampApproved ? 0 : 1),
  };
}

export interface PmEnableResult {
  demo: boolean;
  txHash: string | null;
  /** Approval calls included in the batch (empty = nothing was missing). */
  submitted: Array<{ key: string; kind: 'ctf' | 'collateral' }>;
}

/**
 * Grant every missing approval in ONE gas-sponsored batch. Idempotent by
 * construction: already-granted approvals are skipped, and re-running after
 * success submits nothing.
 */
export async function enablePmTrading(
  userId: string,
  owner: `0x${string}`,
): Promise<PmEnableResult> {
  const status = await getPmTradingStatus(owner);
  if (!status.live) {
    // No RPC to verify state — refuse to blind-fire approvals.
    return { demo: true, txHash: null, submitted: [] };
  }
  const set = await contracts();
  const calls: SponsoredCall[] = [];
  const submitted: PmEnableResult['submitted'] = [];
  for (const a of status.approvals) {
    if (!a.ctfApproved) {
      calls.push({
        to: set.conditionalTokens,
        data: encodeFunctionData({
          abi: CTF_ABI,
          functionName: 'setApprovalForAll',
          args: [a.operator, true],
        }),
      });
      submitted.push({ key: a.key, kind: 'ctf' });
    }
    if (!a.collateralApproved) {
      calls.push({
        to: set.collateral,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [a.operator, maxUint256],
        }),
      });
      submitted.push({ key: a.key, kind: 'collateral' });
    }
  }
  // pUSD rails: pre-authorize wrap (USDC.e → onramp) and unwrap (pUSD →
  // offramp) in the same one-tap batch, so funding conversions later need
  // no further approval transactions.
  if (status.rails && !status.rails.onrampApproved) {
    calls.push({
      to: USDCE_POLYGON,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [COLLATERAL_ONRAMP, maxUint256] }),
    });
    submitted.push({ key: 'collateralOnramp', kind: 'collateral' });
  }
  if (status.rails && !status.rails.offrampApproved) {
    calls.push({
      to: set.collateral,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [COLLATERAL_OFFRAMP, maxUint256] }),
    });
    submitted.push({ key: 'collateralOfframp', kind: 'collateral' });
  }
  if (calls.length === 0) return { demo: false, txHash: null, submitted: [] };

  const res = await executor.sendCalls(userId, calls, {
    chainId: POLY_CHAIN_ID,
    idempotencyKey: `pm-approvals:${owner}`,
  });
  log.info(
    { userId, owner, count: calls.length, txHash: res.txHash, demo: res.demo, sponsored: res.sponsored },
    'polymarket: trading approvals submitted',
  );
  return { demo: res.demo, txHash: res.txHash, submitted };
}

export interface PmRampResult {
  demo: boolean;
  txHash: string | null;
  /** USD amount converted (0 when nothing to do). */
  amountUsd: number;
  direction: 'wrap' | 'unwrap';
  /**
   * Which leg this call executed. 'swap' = native USDC → USDC.e (call `wrap`
   * again to finish); 'ramp' = the CollateralOnramp/Offramp leg itself.
   */
  step: 'swap' | 'ramp';
}

/**
 * Pure wrap-step planner — the money-path branching, unit-testable without
 * RPC/executor. The ramp leg can only draw USDC.e; a request beyond held
 * USDC.e means the native (CCTP-delivered) balance must convert first. The
 * swap step sweeps ALL native — no sub-target dust is left stranded.
 */
export function planWrapStep(
  rails: { usdceUsd: number; nativeUsd: number },
  amountUsd?: number,
):
  | { step: 'swap'; swapAtoms: bigint; minOutAtoms: bigint }
  | { step: 'ramp'; rampAtoms: bigint } {
  const total = rails.usdceUsd + rails.nativeUsd;
  const targetUsd = Math.min(amountUsd ?? total, total);
  if (targetUsd > rails.usdceUsd + 1e-6 && rails.nativeUsd > 0) {
    const swapAtoms = BigInt(Math.floor(rails.nativeUsd * COLLATERAL_DECIMALS));
    return {
      step: 'swap',
      swapAtoms,
      minOutAtoms: (swapAtoms * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n,
    };
  }
  const rampUsd = Math.min(amountUsd ?? rails.usdceUsd, rails.usdceUsd);
  return { step: 'ramp', rampAtoms: BigInt(Math.floor(rampUsd * COLLATERAL_DECIMALS)) };
}

/**
 * Convert deposited funds into pUSD (and back), gas-sponsored, exactly ONE
 * batch per call — a mid-funnel crash never strands a half-signed sequence.
 * `wrap` understands BOTH deposit tokens:
 *   step 'swap': native USDC (what CCTP mints) → USDC.e via the canonical
 *                Uniswap V3 0.01% pool; exact-amount router approval; 30 bps
 *                minimum-out guard. Call `wrap` again to finish.
 *   step 'ramp': USDC.e → pUSD via the CollateralOnramp (1:1).
 * `unwrap`: pUSD → USDC.e (funds withdrawals), always step 'ramp'. Amount
 * defaults to the full source balance; requesting more than held clamps to
 * held. A missing ramp allowance rides the same batch, so a first-time wrap
 * is still one signature.
 */
export async function convertPmCollateral(
  userId: string,
  owner: `0x${string}`,
  direction: 'wrap' | 'unwrap',
  amountUsd?: number,
): Promise<PmRampResult> {
  const status = await getPmTradingStatus(owner);
  if (!status.live || !status.rails) {
    // No RPC to verify balances/allowances — refuse to blind-fire.
    return { demo: true, txHash: null, amountUsd: 0, direction, step: 'ramp' };
  }
  const set = await contracts();

  if (direction === 'wrap') {
    const plan = planWrapStep(status.rails, amountUsd);
    if (plan.step === 'swap' && plan.swapAtoms > 0n) {
      const res = await executor.sendCalls(
        userId,
        [
          {
            to: NATIVE_USDC_POLYGON,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [UNIV3_SWAP_ROUTER_02, plan.swapAtoms],
            }),
          },
          {
            to: UNIV3_SWAP_ROUTER_02,
            data: encodeFunctionData({
              abi: SWAP_ROUTER_ABI,
              functionName: 'exactInputSingle',
              args: [
                {
                  tokenIn: NATIVE_USDC_POLYGON,
                  tokenOut: USDCE_POLYGON,
                  fee: UNIV3_USDC_FEE_TIER,
                  recipient: owner,
                  amountIn: plan.swapAtoms,
                  amountOutMinimum: plan.minOutAtoms,
                  sqrtPriceLimitX96: 0n,
                },
              ],
            }),
          },
        ],
        { chainId: POLY_CHAIN_ID, idempotencyKey: `pm-swap:${owner}:${plan.swapAtoms}` },
      );
      const swappedUsd = Number(plan.swapAtoms) / COLLATERAL_DECIMALS;
      log.info(
        { userId, owner, amountUsd: swappedUsd, txHash: res.txHash, demo: res.demo },
        'polymarket: native→USDC.e swap submitted (wrap step 1 of 2)',
      );
      return { demo: res.demo, txHash: res.txHash, amountUsd: swappedUsd, direction, step: 'swap' };
    }
    const atoms = plan.step === 'ramp' ? plan.rampAtoms : 0n;
    if (atoms <= 0n) return { demo: false, txHash: null, amountUsd: 0, direction, step: 'ramp' };
    const calls: SponsoredCall[] = [];
    if (!status.rails.onrampApproved) {
      calls.push({
        to: USDCE_POLYGON,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [COLLATERAL_ONRAMP, maxUint256] }),
      });
    }
    calls.push({
      to: COLLATERAL_ONRAMP,
      data: encodeFunctionData({ abi: RAMP_ABI, functionName: 'wrap', args: [USDCE_POLYGON, owner, atoms] }),
    });
    const usd = Number(atoms) / COLLATERAL_DECIMALS;
    const res = await executor.sendCalls(userId, calls, {
      chainId: POLY_CHAIN_ID,
      idempotencyKey: `pm-${direction}:${owner}:${atoms}`,
    });
    log.info(
      { userId, owner, direction, amountUsd: usd, txHash: res.txHash, demo: res.demo },
      'polymarket: collateral conversion submitted',
    );
    return { demo: res.demo, txHash: res.txHash, amountUsd: usd, direction, step: 'ramp' };
  }

  const sourceUsd = status.rails.pusdUsd;
  const usd = Math.min(amountUsd ?? sourceUsd, sourceUsd);
  const atoms = BigInt(Math.floor(usd * COLLATERAL_DECIMALS));
  if (atoms <= 0n) return { demo: false, txHash: null, amountUsd: 0, direction, step: 'ramp' };
  const calls: SponsoredCall[] = [];
  if (!status.rails.offrampApproved) {
    calls.push({
      to: set.collateral,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [COLLATERAL_OFFRAMP, maxUint256] }),
    });
  }
  calls.push({
    to: COLLATERAL_OFFRAMP,
    data: encodeFunctionData({ abi: RAMP_ABI, functionName: 'unwrap', args: [USDCE_POLYGON, owner, atoms] }),
  });
  const res = await executor.sendCalls(userId, calls, {
    chainId: POLY_CHAIN_ID,
    idempotencyKey: `pm-${direction}:${owner}:${atoms}`,
  });
  log.info(
    { userId, owner, direction, amountUsd: usd, txHash: res.txHash, demo: res.demo },
    'polymarket: collateral conversion submitted',
  );
  return { demo: res.demo, txHash: res.txHash, amountUsd: usd, direction, step: 'ramp' };
}

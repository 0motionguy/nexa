/**
 * Morpho (MetaMorpho) adapter — Base mainnet ERC-4626 USDC vault.
 *
 * Stack-upgrades Phase 1 pins this to the Steakhouse-curated USDC vault
 * (0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183) — the same Morpho vault that
 * backs Coinbase's USDC lending product. It's the "Standard" tier in the
 * EarnRouter: a curated, conservatively-managed default. The "Higher Yield"
 * tier picks the highest risk-weighted APY across yoUSD / Aave / Compound /
 * Morpho at request time.
 *
 * MetaMorpho vaults are curated ERC-4626 vaults that allocate USDC across
 * Morpho Blue markets, so this adapter is structurally identical to yoUSD:
 * deposits convert USDC → vault shares; withdrawals redeem shares back to
 * USDC.
 *
 * Vault address: env.MORPHO_VAULT_ADDRESS (Base mainnet). Default pinned to
 * the Steakhouse vault; override with a different MetaMorpho address to
 * change curator/strategy without code changes.
 *
 * Provides the standard EarnAdapter surface:
 *   - getApyBps()           → live Morpho API rate, or APY unavailable
 *   - depositUsd(userId, $) → [ USDC.approve(vault, amt), vault.deposit(amt, wallet) ]
 *   - withdrawUsd(userId, $)→ [ vault.withdraw(amt, wallet, wallet) ]
 *   - get isLive
 *
 * Writes batch through the EIP-7702 executor so the user pays no gas and signs
 * once. Demo fallback returns a `0xdemo…` ExecResult via the executor and the
 * route layer mirrors the move into the in-memory ledger.
 *
 * Vault provenance:
 *   - https://app.merkl.xyz/opportunities/base/MORPHOVAULT/0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183
 *   - https://morpho.org/blog/morpho-is-now-powering-usdc-lending-on-coinbase/
 * ERC-4626: https://eips.ethereum.org/EIPS/eip-4626
 * MetaMorpho: https://docs.morpho.org/
 */

import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { env } from '../env.js';
import { ASSETS, ChainError, usdToUsdcWei } from './units.js';
import { walletService } from './wallet.js';
import { executor, type ExecResult, type SponsoredCall } from './alchemy.js';
import { apyToBps, apyUnavailable } from './apy.js';

const BASE_CHAIN_ID = 8453;
// Morpho V1 vault query — `vaultByAddress` is the canonical lookup for
// MetaMorpho vaults like Steakhouse USDC (our pinned address). The earlier
// `vaultV2ByAddress` shape only indexes Morpho V2 vaults which excludes the
// Steakhouse curator (verified via the `vaults` list query 2026-06-17).
const MORPHO_APY_QUERY = /* GraphQL */ `
  query MorphoVaultApy($address: String!, $chainId: Int!) {
    vaultByAddress(address: $address, chainId: $chainId) {
      state {
        netApy
        netApyWithoutRewards
        apy
      }
    }
  }
`;

// Top USDC vaults on Base, ranked by TVL. Used by /earn/morpho/vaults so the
// UI can present the full curated Morpho lineup rather than a single pinned
// address. Filter clientside for `asset.symbol === 'USDC'` since Morpho's
// VaultFilters schema doesn't expose `asset_` directly.
const MORPHO_VAULTS_QUERY = /* GraphQL */ `
  query MorphoVaults($chainId: Int!, $first: Int!) {
    vaults(first: $first, where: { chainId_in: [$chainId] }, orderBy: TotalAssetsUsd, orderDirection: Desc) {
      items {
        address
        symbol
        name
        asset { symbol address }
        state {
          netApy
          netApyWithoutRewards
          apy
          totalAssetsUsd
        }
      }
    }
  }
`;

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const VAULT_ABI = parseAbi([
  // ERC-4626 tokenized vault.
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
]);

interface MorphoVaultApyResponse {
  data?: {
    vaultByAddress?: {
      state?: {
        netApy?: number | string | null;
        netApyWithoutRewards?: number | string | null;
        apy?: number | string | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

export async function fetchMorphoVaultApyBps(opts: {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  vaultAddress?: string;
  chainId?: number;
} = {}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? env.MORPHO_API_URL;
  const vaultAddress = getAddress(opts.vaultAddress ?? env.MORPHO_VAULT_ADDRESS);
  const chainId = opts.chainId ?? BASE_CHAIN_ID;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: MORPHO_APY_QUERY,
        variables: { address: vaultAddress, chainId },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new ChainError('rpc_failed', `Morpho API ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const body = (await res.json()) as MorphoVaultApyResponse;
    if (body.errors?.length) {
      throw new ChainError('rpc_failed', body.errors.map((e) => e.message).filter(Boolean).join('; '));
    }
    const vault = body.data?.vaultByAddress;
    const state = vault?.state;
    if (!state) throw apyUnavailable('Morpho');
    // Prefer netApy (includes reward yields); fall back to netApyWithoutRewards
    // then to the gross apy. All three are decimals (e.g. 0.0327 = 3.27%).
    const net = apyToBps(state.netApy);
    if (net != null) return net;
    const noRewards = apyToBps(state.netApyWithoutRewards);
    if (noRewards != null) return noRewards;
    const gross = apyToBps(state.apy);
    if (gross != null) return gross;
    throw apyUnavailable('Morpho');
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw apyUnavailable('Morpho', e);
  } finally {
    clearTimeout(timer);
  }
}

export interface MorphoVaultSummary {
  address: string;
  symbol: string;
  name: string;
  assetSymbol: string;
  assetAddress: string;
  apyBps: number | null;
  apyNoRewardsBps: number | null;
  totalAssetsUsd: number | null;
}

/**
 * Fetch the top USDC vaults on a given chain (default Base) ordered by TVL.
 * Returns the structured summary the UI needs to render a vault picker.
 * Falls back to an empty list on transport / GraphQL errors so the route can
 * decide whether to fail or degrade.
 */
export async function fetchMorphoVaultsList(opts: {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  chainId?: number;
  first?: number;
  assetSymbol?: string;
} = {}): Promise<MorphoVaultSummary[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? env.MORPHO_API_URL;
  const chainId = opts.chainId ?? BASE_CHAIN_ID;
  const first = Math.min(opts.first ?? 25, 50);
  const assetSymbol = opts.assetSymbol ?? 'USDC';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: MORPHO_VAULTS_QUERY, variables: { chainId, first } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ChainError('rpc_failed', `Morpho vaults ${res.status}`);
    const body = (await res.json()) as {
      data?: {
        vaults?: {
          items?: Array<{
            address: string;
            symbol: string;
            name: string;
            asset?: { symbol?: string; address?: string };
            state?: {
              netApy?: number | string | null;
              netApyWithoutRewards?: number | string | null;
              apy?: number | string | null;
              totalAssetsUsd?: number | string | null;
            };
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) {
      throw new ChainError('rpc_failed', body.errors.map((e) => e.message).filter(Boolean).join('; '));
    }
    const items = body.data?.vaults?.items ?? [];
    return items
      .filter((v) => v.asset?.symbol === assetSymbol)
      .map((v) => ({
        address: v.address,
        symbol: v.symbol,
        name: v.name,
        assetSymbol: v.asset?.symbol ?? assetSymbol,
        assetAddress: v.asset?.address ?? '',
        apyBps: apyToBps(v.state?.netApy),
        apyNoRewardsBps: apyToBps(v.state?.netApyWithoutRewards),
        totalAssetsUsd:
          v.state?.totalAssetsUsd != null ? Number(v.state.totalAssetsUsd) : null,
      }));
  } finally {
    clearTimeout(timer);
  }
}

export class MorphoAdapter {
  private readonly vault: Hex;
  /** Tier of the vault this adapter wraps. Standard = Steakhouse Coinbase Prime. */
  public readonly tier: 'standard' | 'high-yield';

  constructor(vaultAddress?: string, tier: 'standard' | 'high-yield' = 'standard') {
    this.vault = getAddress(vaultAddress ?? env.MORPHO_VAULT_ADDRESS) as Hex;
    this.tier = tier;
  }

  /** Live writes require the same stack as the batch executor. */
  get isLive(): boolean {
    return executor.isLive;
  }

  /** Read-only — the vault address this adapter is targeting. */
  get vaultAddress(): Hex {
    return this.vault;
  }

  /**
   * Blended APY in basis points. MetaMorpho's net APY is exposed via Morpho's
   * public off-chain GraphQL API — no key required, no chain RPC needed for
   * READS. We gate on VITEST so tests stay deterministic, but DEMO_MODE is
   * intentionally NOT a blocker here: reading public DeFi rates cannot move
   * money, so the defense-in-depth guard was over-cautious.
   *
   * Writes (depositUsd / withdrawUsd) remain gated by executor.isLive, which
   * requires Alchemy keys, so demo mode still can't accidentally settle.
   */
  async getApyBps(): Promise<number> {
    if (process.env['VITEST']) throw apyUnavailable('Morpho');
    return fetchMorphoVaultApyBps({ vaultAddress: this.vault });
  }

  /**
   * Deposit `amountUsd` USDC into the MetaMorpho vault. Encodes approve +
   * ERC-4626 deposit as one sponsored batch and routes through the executor.
   * Demo mode returns a `0xdemo…` ExecResult.
   */
  async depositUsd(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    const receiver = await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: ASSETS.USDC.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [this.vault, amt],
        }),
      },
      {
        to: this.vault,
        data: encodeFunctionData({
          abi: VAULT_ABI,
          functionName: 'deposit',
          args: [amt, receiver],
        }),
      },
    ];
    return executor.sendCalls(userId, calls, opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {});
  }

  /**
   * Withdraw `amountUsd` of underlying USDC from the vault (ERC-4626 withdraw,
   * receiver == owner == the user's wallet). Routes through the executor.
   */
  async withdrawUsd(
    userId: string,
    amountUsd: number,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ExecResult> {
    const wallet = await this.walletAddress(userId);
    const amt = usdToUsdcWei(amountUsd);
    const calls: SponsoredCall[] = [
      {
        to: this.vault,
        data: encodeFunctionData({
          abi: VAULT_ABI,
          functionName: 'withdraw',
          args: [amt, wallet, wallet],
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

/** Standard tier — Steakhouse USDC (the Coinbase USDC Prime vault). */
export const morphoAdapter = new MorphoAdapter(env.MORPHO_VAULT_ADDRESS, 'standard');

/**
 * Higher Yield tier — Steakhouse High Yield USDC v1.1 (bbqUSDC), the same
 * Ethena-powered vault Coinbase wired as their "USDC High Yield" product
 * (Coinbase + Steakhouse + Morpho + Ethena announcement 2026-06-12). Users
 * opting up the risk curve get the same exposure Coinbase High Yield gives.
 */
export const morphoHighYieldAdapter = new MorphoAdapter(
  env.MORPHO_HIGH_YIELD_VAULT_ADDRESS,
  'high-yield',
);

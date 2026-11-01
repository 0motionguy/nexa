/**
 * Jupiter Lend (Earn) APY adapter — read-only "headline yield" tier on Solana.
 *
 * Jupiter Lend is a Solana money market built on Fluid (Instadapp's lending
 * engine). It launched Aug 2025 and by Q4 2025 was the #2 Solana lender by
 * TVL after Kamino (~$1.5B). Its USDC vault is currently the highest-yielding
 * stablecoin venue on Solana.
 *
 * Read source: `https://lend-api.jup.ag/earn/tokens` — public, no auth.
 *   Returns a list of supply tokens with `supplyRate` (APY in 1e4 bps) and
 *   `totalAssets` (TVL in atomic units). Override via env.JUPITER_LEND_API_URL
 *   for testing or vendor mirroring.
 *
 * Why phase-1 read-only:
 *   - Deposit/withdraw require a Solana tx signed via Privy server wallet,
 *     plus PriceFee accounts wired through the swap path. The on-ramp is
 *     identical to the existing Jupiter swap flow in `markets/jupiter.ts`
 *     once a USDC→shares deposit instruction is wrapped.
 *   - Today we surface the live rate + deposit URL so users can either
 *     hit jup.ag/lend directly OR (when write ships) tap "Earn here".
 *
 * Risk envelope (UI MUST mirror):
 *   - 10 months old as of 2026-06-21 — youngest large-TVL Solana lender.
 *   - Fluid engine rehypothecates collateral — Kamino blocked their refinance
 *     loop Dec 2025 citing this. Document the model before raising caps.
 *   - 90% LTV / 0.1% liquidation fee is aggressive; withdrawal caps can throttle exits.
 *
 * Reference:
 *   - https://jup.ag/lend/earn
 *   - https://dev.jup.ag/docs/lend/sdk
 *   - https://github.com/jup-ag/jupiter-lend
 *   - https://lend-api.jup.ag/
 */

import { env } from '../env.js';
import { log } from '../log.js';
import { ChainError } from './units.js';
import { apyToBps, apyUnavailable } from './apy.js';

interface JupLendToken {
  /** SPL mint address of the supply asset (USDC, USDT, etc.). */
  asset?: string;
  symbol?: string;
  /** Supply APY as a decimal (0.0469 = 4.69%) OR a bps integer — adapter accepts both. */
  supplyRate?: number | string | null;
  /** Same field under alternative names some snapshots use. */
  apy?: number | string | null;
  apyBase?: number | string | null;
  apyReward?: number | string | null;
  /** TVL in USD if exposed; else atomic units of underlying. */
  totalAssetsUsd?: number | string | null;
  tvlUsd?: number | string | null;
}

interface JupLendListResponse {
  tokens?: JupLendToken[];
  data?: JupLendToken[];
}

const DEFAULT_API_URL = 'https://lend-api.jup.ag/earn/tokens';

/** Standard Solana mint addresses for the assets we surface. */
const USDC_MINT_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT_SOL = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export type JupLendAsset = 'USDC' | 'USDT';

const ASSET_MINT: Record<JupLendAsset, string> = {
  USDC: USDC_MINT_SOL,
  USDT: USDT_MINT_SOL,
};

export interface JupLendTileSummary {
  /** Asset symbol (USDC / USDT). */
  asset: JupLendAsset;
  /** Live supply APY in basis points. */
  apyBps: number;
  /** TVL in USD (best-effort — null when the upstream doesn't expose it). */
  tvlUsd: number | null;
  /** Where the user goes to deposit. */
  depositUrl: string;
  /** Human-readable risk one-liner the UI surfaces verbatim. */
  riskCopy: string;
  /** When the read succeeded — ISO string. */
  readAt: string;
}

const RISK_COPY =
  'Solana money market launched Aug 2025 — younger than Aave/Compound. ' +
  'Built on Fluid engine; high LTV with aggressive liquidation. ' +
  'Check withdrawal caps before sizing.';

const DEFAULT_DEPOSIT_URL = 'https://jup.ag/lend/earn';

function pickTokenForAsset(list: JupLendToken[], asset: JupLendAsset): JupLendToken | null {
  const wantMint = ASSET_MINT[asset];
  // Prefer exact mint match (canonical). Fall back to symbol so the adapter
  // doesn't go blind if the upstream shape drifts.
  const byMint = list.find((t) => t.asset && t.asset.toLowerCase() === wantMint.toLowerCase());
  if (byMint) return byMint;
  const bySymbol = list.find((t) => t.symbol && t.symbol.toUpperCase() === asset);
  return bySymbol ?? null;
}

function combineBaseAndReward(base: unknown, reward: unknown): number | null {
  const b = apyToBps(base);
  const r = apyToBps(reward);
  if (b == null && r == null) return null;
  return (b ?? 0) + (r ?? 0);
}

export async function fetchJupiterLendApyBps(
  asset: JupLendAsset,
  opts: { fetchImpl?: typeof fetch; apiUrl?: string } = {},
): Promise<{ apyBps: number; tvlUsd: number | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? env.JUPITER_LEND_API_URL ?? DEFAULT_API_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new ChainError(
        'rpc_failed',
        `Jupiter Lend API ${res.status}: ${await res.text().catch(() => '')}`,
      );
    }
    const body = (await res.json().catch(() => null)) as JupLendListResponse | JupLendToken[] | null;
    if (!body) throw apyUnavailable('Jupiter Lend');
    const tokens: JupLendToken[] = Array.isArray(body)
      ? body
      : (body.tokens ?? body.data ?? []);
    const row = pickTokenForAsset(tokens, asset);
    if (!row) throw apyUnavailable(`Jupiter Lend (${asset})`);
    // Combine base + reward if both are present; otherwise fall back to the
    // single supplyRate / apy field.
    const combined = combineBaseAndReward(row.apyBase, row.apyReward);
    const single = apyToBps(row.supplyRate ?? row.apy);
    const apyBps = combined ?? single;
    if (apyBps == null) throw apyUnavailable(`Jupiter Lend (${asset})`);
    const tvlUsd =
      typeof row.totalAssetsUsd === 'number'
        ? row.totalAssetsUsd
        : typeof row.tvlUsd === 'number'
          ? row.tvlUsd
          : null;
    return { apyBps, tvlUsd };
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw apyUnavailable(`Jupiter Lend (${asset})`, e);
  } finally {
    clearTimeout(timer);
  }
}

export class JupiterLendAdapter {
  /** Read-only adapter; always "live" because the public endpoint has no auth gate. */
  get isLive(): boolean {
    return true;
  }

  async getApyBps(asset: JupLendAsset = 'USDC'): Promise<number> {
    if (process.env['VITEST']) throw apyUnavailable(`Jupiter Lend (${asset})`);
    const { apyBps } = await fetchJupiterLendApyBps(asset);
    return apyBps;
  }

  async getTileSummary(asset: JupLendAsset = 'USDC'): Promise<JupLendTileSummary> {
    let apyBps = 0;
    let tvlUsd: number | null = null;
    try {
      const r = await fetchJupiterLendApyBps(asset);
      apyBps = r.apyBps;
      tvlUsd = r.tvlUsd;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), asset },
        'jupiter-lend: APY read failed — surfacing 0',
      );
    }
    return {
      asset,
      apyBps,
      tvlUsd,
      depositUrl: env.JUPITER_LEND_DEPOSIT_URL ?? DEFAULT_DEPOSIT_URL,
      riskCopy: RISK_COPY,
      readAt: new Date().toISOString(),
    };
  }
}

export const jupiterLendAdapter = new JupiterLendAdapter();

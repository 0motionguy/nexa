/**
 * Ethena sUSDe APY adapter — read-only "headline yield" tier.
 *
 * Surfaces the live sUSDe staking APY (currently 12-25% depending on perp
 * funding rates) without taking custody. UI tile renders the live number and
 * a CTA that deep-links to https://app.ethena.fi for the user to deposit
 * directly. We never custody Ethena positions in this phase — the user's
 * sUSDe balance is on their own wallet on Ethereum mainnet / Base.
 *
 * Why phase-1 read-only:
 *   - Ethena's stake mechanic expects USDe (their synthetic dollar), not USDC
 *   - A one-click "USDC → USDe → sUSDe" flow needs the swap router wired
 *     (Mayan / Socket / LIFI route) plus an ERC-4626 deposit batch through
 *     the EIP-7702 executor. ~4-5 hours of work, deferred to the next sprint.
 *   - Most users don't want a brand new neobank holding their highest-risk
 *     synthetic-dollar position — a clear "go deposit at ethena.fi" CTA
 *     respects autonomy and matches the regulatory framing.
 *
 * Risk envelope (UI MUST mirror):
 *   - sUSDe = USDe staked. Yield comes from delta-neutral perp funding rates.
 *   - Funding can go negative → yield can go negative.
 *   - Ethena's protocol controls minting/redemption; depeg risk exists.
 *   - Battle-tested (~$5B+ TVL, audited by Spearbit, ChainSecurity, Cantina,
 *     Sherlock) but the structural risk is real.
 *
 * Reference:
 *   - https://ethena.fi
 *   - https://docs.ethena.fi/
 *   - sUSDe (Ethereum mainnet): 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497
 *   - USDe (Ethereum mainnet):  0x4c9EDD5852cd905f086C759E8383e09bff1E68B3
 */

import { env } from '../env.js';
import { log } from '../log.js';
import { ChainError } from './units.js';
import { apyToBps, apyUnavailable } from './apy.js';

interface EthenaYieldResponse {
  /** sUSDe APY as a decimal (e.g. 0.18 = 18%). */
  apy?: number | string | null;
  /** Some endpoints return APR + APY separately; we prefer APY. */
  apr?: number | string | null;
  /** Updated timestamp from the protocol. */
  updatedAt?: string | null;
  /** Optional raw — Ethena sometimes wraps under data.staking. */
  data?: { apy?: number | string | null; apr?: number | string | null };
  staking?: { apy?: number | string | null; apr?: number | string | null };
}

/**
 * Public Ethena yield endpoint. No auth required, no rate limits documented.
 * Override via env.ETHENA_API_URL for testing or vendor mirroring.
 */
const DEFAULT_API_URL = 'https://app.ethena.fi/api/yields/protocol-and-staking-yield';

export async function fetchEthenaSusdeApyBps(opts: {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
} = {}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? env.ETHENA_API_URL ?? DEFAULT_API_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new ChainError('rpc_failed', `Ethena API ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const body = (await res.json().catch(() => null)) as EthenaYieldResponse | null;
    if (!body) throw apyUnavailable('Ethena');
    // Try every shape the public endpoint has used: top-level apy, data.apy, staking.apy.
    const candidate =
      body.apy ?? body.data?.apy ?? body.staking?.apy ??
      body.apr ?? body.data?.apr ?? body.staking?.apr;
    const bps = apyToBps(candidate);
    if (bps == null) throw apyUnavailable('Ethena');
    return bps;
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw apyUnavailable('Ethena', e);
  } finally {
    clearTimeout(timer);
  }
}

export interface EthenaTileSummary {
  /** Live sUSDe APY in basis points. */
  apyBps: number;
  /** Live source URL the user opens to deposit. */
  depositUrl: string;
  /** Human-readable risk one-liner the UI surfaces verbatim. */
  riskCopy: string;
  /** When the read succeeded — ISO string. */
  readAt: string;
}

const RISK_COPY =
  'Synthetic dollar. Yield from perp funding rates. Can go negative when funding flips. ' +
  'Custody stays at ethena.fi — NEXA never holds your sUSDe.';

const DEFAULT_DEPOSIT_URL = 'https://app.ethena.fi/buy';

export class EthenaAdapter {
  /** Read-only adapter; always "live" because the public APY endpoint has no auth gate. */
  get isLive(): boolean {
    return true;
  }

  async getApyBps(): Promise<number> {
    if (process.env['VITEST']) throw apyUnavailable('Ethena');
    return fetchEthenaSusdeApyBps();
  }

  async getTileSummary(): Promise<EthenaTileSummary> {
    const apyBps = await this.getApyBps().catch((e) => {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'ethena: APY read failed — surfacing 0',
      );
      return 0;
    });
    return {
      apyBps,
      depositUrl: env.ETHENA_DEPOSIT_URL ?? DEFAULT_DEPOSIT_URL,
      riskCopy: RISK_COPY,
      readAt: new Date().toISOString(),
    };
  }
}

export const ethenaAdapter = new EthenaAdapter();

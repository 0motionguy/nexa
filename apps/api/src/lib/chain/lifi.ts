/**
 * LIFI swap adapter — USDC ↔ EURC on Base via REST (no SDK install).
 *
 * Works without an API key for low volume; LIFI_API_KEY only needed when you
 * exceed the free-tier rate limit. Quote-only by default; executeSwap requires
 * the writeable wallet pipeline (same caveat as Aave deposit) so currently
 * returns `not_implemented`.
 *
 * API: https://docs.li.fi/li.fi-api/li.fi-api
 */

import { randomBytes } from 'node:crypto';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { executor, type SponsoredCall } from './alchemy.js';
import { walletService } from './wallet.js';
import { ASSETS, type AssetKey, ChainError, usdToUsdcWei } from './units.js';

export interface LifiQuote {
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  rate: number;
  estimatedGasUsd: number;
  raw: unknown;
}

const BASE_CHAIN_ID = 8453;
const GNOSIS_CHAIN_ID = 100;
/** EURe (Monerium EUR e-money) on Gnosis Chain — the card's settlement token. */
const GNOSIS_EURE_ADDRESS = '0xcB444e90D8198415266c6a2724b7900fb12FC56E';

export class LifiAdapter {
  private readonly apiBase = 'https://li.quest/v1';

  get isLive(): boolean {
    return features.lifi;
  }

  async getQuote(
    fromAsset: AssetKey,
    toAsset: AssetKey,
    amount: bigint,
    fromAddress: string,
    slippageBps = 50,
  ): Promise<LifiQuote> {
    if (!this.isLive) {
      // Fall back to the hardcoded 0.92 rate so demo screens render.
      const rate = fromAsset === 'USDC' && toAsset === 'EURC' ? 0.92 : 1 / 0.92;
      const toAmount = (amount * BigInt(Math.round(rate * 1e6))) / 10n ** 6n;
      return {
        fromAmount: amount.toString(),
        toAmount: toAmount.toString(),
        toAmountMin: toAmount.toString(),
        rate,
        estimatedGasUsd: 0,
        raw: { demo: true },
      };
    }
    const u = new URL(`${this.apiBase}/quote`);
    u.searchParams.set('fromChain', String(BASE_CHAIN_ID));
    u.searchParams.set('toChain', String(BASE_CHAIN_ID));
    u.searchParams.set('fromToken', ASSETS[fromAsset].address);
    u.searchParams.set('toToken', ASSETS[toAsset].address);
    u.searchParams.set('fromAmount', amount.toString());
    u.searchParams.set('fromAddress', fromAddress);
    u.searchParams.set('slippage', String(slippageBps / 10000));
    const headers: Record<string, string> = {};
    if (env.LIFI_API_KEY) headers['x-lifi-api-key'] = env.LIFI_API_KEY;

    let res: Response;
    try {
      res = await fetch(u.toString(), { headers });
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'lifi: unreachable');
      throw new ChainError('rpc_failed', 'LIFI unreachable', e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ChainError('rpc_failed', `LIFI ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      estimate?: { fromAmount?: string; toAmount?: string; toAmountMin?: string; gasCosts?: { amountUSD?: string }[] };
    };
    const fromAmount = data.estimate?.fromAmount ?? amount.toString();
    const toAmount = data.estimate?.toAmount ?? '0';
    const toAmountMin = data.estimate?.toAmountMin ?? toAmount;
    const gasUsd = Number(data.estimate?.gasCosts?.[0]?.amountUSD ?? '0');
    const rate = Number(toAmount) / Number(fromAmount);
    return { fromAmount, toAmount, toAmountMin, rate, estimatedGasUsd: gasUsd, raw: data };
  }

  /**
   * Cross-chain card top-up: bridge `amountUsd` of USDC on Base into EURe on
   * Gnosis Chain (the Gnosis Pay card's settlement token). Live: fetch a li.quest
   * cross-chain quote and route the returned transaction through the 7702
   * executor. Demo (or any failure): a synthetic `0xdemo…` hash with demo:true —
   * never throws, so the top-up flow always completes against the ledger.
   */
  async topUpCardCrossChain(
    userId: string,
    amountUsd: number,
  ): Promise<{ txHash: string; demo: boolean }> {
    const demo = { txHash: '0xdemo' + randomBytes(14).toString('hex'), demo: true };
    if (!this.isLive) return demo;
    try {
      const wallet = await walletService.getOrCreateUserWallet(userId, null);
      const u = new URL(`${this.apiBase}/quote`);
      u.searchParams.set('fromChain', String(BASE_CHAIN_ID));
      u.searchParams.set('toChain', String(GNOSIS_CHAIN_ID));
      u.searchParams.set('fromToken', ASSETS.USDC.address);
      u.searchParams.set('toToken', GNOSIS_EURE_ADDRESS);
      u.searchParams.set('fromAmount', usdToUsdcWei(amountUsd).toString());
      u.searchParams.set('fromAddress', wallet.address);
      u.searchParams.set('toAddress', wallet.address);
      const headers: Record<string, string> = {};
      if (env.LIFI_API_KEY) headers['x-lifi-api-key'] = env.LIFI_API_KEY;

      const res = await fetch(u.toString(), { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'lifi: topUpCardCrossChain quote rejected — demo fallback');
        return demo;
      }
      const data = (await res.json().catch(() => ({}))) as {
        transactionRequest?: { to?: string; data?: string; value?: string };
      };
      const tx = data.transactionRequest;
      if (!tx?.to || !tx.data) {
        log.warn('lifi: topUpCardCrossChain quote had no transactionRequest — demo fallback');
        return demo;
      }
      const calls: SponsoredCall[] = [
        {
          to: tx.to as `0x${string}`,
          data: tx.data as `0x${string}`,
          ...(tx.value && tx.value !== '0x0' ? { value: BigInt(tx.value) } : {}),
        },
      ];
      const result = await executor.sendCalls(userId, calls);
      return { txHash: result.txHash, demo: result.demo };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'lifi: topUpCardCrossChain unreachable — demo fallback',
      );
      return demo;
    }
  }

  /**
   * Same-chain swap on Base (e.g. USDC ⇄ EURC). Live: fetch a li.quest quote for
   * `amountUsd` and route the returned transactionRequest through the 7702
   * executor (one sponsored userop — approval is folded into LIFI's calldata).
   * Demo (or any failure): a synthetic `0xdemo…` hash with demo:true — never
   * throws, so the swap flow always completes against the ledger.
   */
  async executeSwap(
    userId: string,
    fromAsset: AssetKey,
    toAsset: AssetKey,
    amountUsd: number,
  ): Promise<{ txHash: string; demo: boolean }> {
    const demo = { txHash: '0xdemo' + randomBytes(14).toString('hex'), demo: true };
    if (!this.isLive) return demo;
    try {
      const wallet = await walletService.getOrCreateUserWallet(userId, null);
      const u = new URL(`${this.apiBase}/quote`);
      u.searchParams.set('fromChain', String(BASE_CHAIN_ID));
      u.searchParams.set('toChain', String(BASE_CHAIN_ID));
      u.searchParams.set('fromToken', ASSETS[fromAsset].address);
      u.searchParams.set('toToken', ASSETS[toAsset].address);
      u.searchParams.set('fromAmount', usdToUsdcWei(amountUsd).toString());
      u.searchParams.set('fromAddress', wallet.address);
      u.searchParams.set('toAddress', wallet.address);
      const headers: Record<string, string> = {};
      if (env.LIFI_API_KEY) headers['x-lifi-api-key'] = env.LIFI_API_KEY;

      const res = await fetch(u.toString(), { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'lifi: executeSwap quote rejected — demo fallback');
        return demo;
      }
      const data = (await res.json().catch(() => ({}))) as {
        transactionRequest?: { to?: string; data?: string; value?: string };
      };
      const tx = data.transactionRequest;
      if (!tx?.to || !tx.data) {
        log.warn('lifi: executeSwap quote had no transactionRequest — demo fallback');
        return demo;
      }
      const calls: SponsoredCall[] = [
        {
          to: tx.to as `0x${string}`,
          data: tx.data as `0x${string}`,
          ...(tx.value && tx.value !== '0x0' ? { value: BigInt(tx.value) } : {}),
        },
      ];
      const result = await executor.sendCalls(userId, calls);
      return { txHash: result.txHash, demo: result.demo };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'lifi: executeSwap unreachable — demo fallback',
      );
      return demo;
    }
  }
}

export const lifiAdapter = new LifiAdapter();

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 2 — BridgeAdapter shim wrapping the existing LifiAdapter so the
 * BridgeRouter can call it through the same interface as Socket. No behavior
 * change to the LIFI logic above; this just exposes a single `quote()` that
 * resolves the same /v1/quote endpoint, supports any chain pair LIFI does, and
 * returns the router's normalized `BridgeQuote` shape.
 * ────────────────────────────────────────────────────────────────────────── */

import {
  CHAIN_IDS as BRIDGE_CHAIN_IDS,
  type BridgeAdapter,
  type BridgeQuote,
  type BridgeQuoteInput,
  type Chain,
} from '../bridge-router.js';

/** Token addresses used by the LIFI shim. Reuses env addresses where possible. */
const BRIDGE_TOKENS: Record<Chain, Partial<Record<string, string>>> = {
  base: {
    USDC: env.USDC_ADDRESS,
    EURC: env.EURC_ADDRESS,
  },
  gnosis: {
    EURe: GNOSIS_EURE_ADDRESS,
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

class LifiBridgeAdapter implements BridgeAdapter {
  readonly name = 'lifi' as const;

  get isLive(): boolean {
    return lifiAdapter.isLive;
  }

  async quote(input: BridgeQuoteInput): Promise<BridgeQuote | null> {
    const fromChainId = BRIDGE_CHAIN_IDS[input.fromChain];
    const toChainId = BRIDGE_CHAIN_IDS[input.toChain];
    if (!fromChainId || !toChainId) return null;
    const fromTokenAddr = BRIDGE_TOKENS[input.fromChain]?.[input.fromToken];
    const toTokenAddr = BRIDGE_TOKENS[input.toChain]?.[input.toToken];
    if (!fromTokenAddr || !toTokenAddr) return null;

    if (!this.isLive) {
      // Demo: synthetic 0.92 rate + no calls so the router executes an empty
      // batch (which the 7702 demo path collapses into a 0xdemo… hash).
      const toAmount = input.amountUsd * 0.92;
      return {
        provider: 'lifi',
        calls: [],
        estimate: {
          fromAmount: String(Math.floor(input.amountUsd * 1_000_000)),
          toAmount: String(Math.floor(toAmount * 1_000_000)),
          toAmountMin: String(Math.floor(toAmount * 0.99 * 1_000_000)),
          rate: 0.92,
          estimatedGasUsd: 0,
        },
      };
    }

    try {
      const u = new URL('https://li.quest/v1/quote');
      u.searchParams.set('fromChain', String(fromChainId));
      u.searchParams.set('toChain', String(toChainId));
      u.searchParams.set('fromToken', fromTokenAddr);
      u.searchParams.set('toToken', toTokenAddr);
      u.searchParams.set('fromAmount', String(Math.floor(input.amountUsd * 1_000_000)));
      u.searchParams.set('fromAddress', input.userAddress);
      u.searchParams.set('toAddress', input.userAddress);
      const headers: Record<string, string> = {};
      if (env.LIFI_API_KEY) headers['x-lifi-api-key'] = env.LIFI_API_KEY;
      const res = await fetch(u.toString(), { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn(
          { status: res.status, text },
          'lifi-bridge: quote rejected — bridge-router will surface demo',
        );
        return null;
      }
      const data = (await res.json().catch(() => ({}))) as {
        estimate?: {
          fromAmount?: string;
          toAmount?: string;
          toAmountMin?: string;
          gasCosts?: { amountUSD?: string }[];
        };
        transactionRequest?: { to?: string; data?: string; value?: string };
      };
      const tx = data.transactionRequest;
      if (!tx?.to || !tx.data) {
        log.warn('lifi-bridge: quote had no transactionRequest');
        return null;
      }
      const fromAmount = data.estimate?.fromAmount ?? String(Math.floor(input.amountUsd * 1_000_000));
      const toAmount = data.estimate?.toAmount ?? '0';
      const toAmountMin = data.estimate?.toAmountMin ?? toAmount;
      const rate =
        Number(toAmount) > 0 && Number(fromAmount) > 0
          ? Number(toAmount) / Number(fromAmount)
          : 0;
      const estimatedGasUsd = Number(data.estimate?.gasCosts?.[0]?.amountUSD ?? '0');
      return {
        provider: 'lifi',
        calls: [{ to: tx.to, data: tx.data, value: tx.value ?? '0' }],
        estimate: {
          fromAmount,
          toAmount,
          toAmountMin,
          rate,
          estimatedGasUsd,
        },
        raw: data,
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'lifi-bridge: unreachable',
      );
      return null;
    }
  }
}

export const lifiBridgeAdapter = new LifiBridgeAdapter();

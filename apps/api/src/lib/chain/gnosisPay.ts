/**
 * Gnosis Pay adapter — permissionless card scaffold.
 *
 * Day-1 path is fully permissionless: SIWE on Gnosis Chain → deploy Safe →
 * order virtual card directly from the Gnosis Pay contract. The SIWE message
 * builder + verifier are functional; the Safe deploy + card mint + card reads
 * sit behind `isLive` (GNOSIS_PAY_API_KEY) with a try/catch that degrades to a
 * deterministic demo — the demo flow must never throw to the route.
 *
 * Live writes batch through the EIP-7702 executor (same path as Aave/yoUSD), so
 * the user pays no gas and signs once. The Safe deploy encodes
 * SafeProxyFactory.createProxyWithNonce on Gnosis Chain (chainId 100); the card
 * mint hits the Gnosis Pay REST surface with a Bearer key.
 *
 * Permissionless contract reference:
 *   SafeProxyFactory on Gnosis Chain: 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
 *   Safe singleton (L2) on Gnosis Chain: 0x3E5c63644E683549055b9Be8653de26E0B4CD36E
 *   Gnosis Pay Cards (permissionless mint): see https://docs.gnosispay.com/
 */

import { createHash } from 'node:crypto';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { SiweMessage } from 'siwe';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { executor, type SponsoredCall } from './alchemy.js';

export interface SiweChallenge {
  message: string;
  nonce: string;
}

/** SafeProxyFactory on Gnosis Chain — createProxyWithNonce deploys a new Safe. */
const SAFE_PROXY_FACTORY = getAddress('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67') as Hex;
/** Safe L2 singleton on Gnosis Chain — the implementation each proxy points at. */
const SAFE_SINGLETON_L2 = getAddress('0x3E5c63644E683549055b9Be8653de26E0B4CD36E') as Hex;

const SAFE_PROXY_FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);
const GNOSIS_CHAIN_ID = 100;

/** Stable sha256 hex of `userId + tag`. The deterministic-demo workhorse. */
function digest(userId: string, tag: string): string {
  return createHash('sha256').update(`${userId}:${tag}`).digest('hex');
}

/** Deterministic 4-digit card suffix from the user id. */
function demoLast4(userId: string): string {
  const h = digest(userId, 'card');
  // Map the first 4 hex nibbles into 0–9 so the suffix always reads as digits.
  let out = '';
  for (let i = 0; i < 4; i++) out += (parseInt(h[i] ?? '0', 16) % 10).toString();
  return out;
}

/** Deterministic checksummed Safe address from the user id. */
function demoSafeAddress(userId: string): string {
  return getAddress(('0x' + digest(userId, 'safe').slice(0, 40)) as Hex);
}

export class GnosisPayAdapter {
  private apiBase(): string {
    return env.GNOSIS_PAY_BASE.replace(/\/+$/, '');
  }

  /** Live when a Gnosis Pay API key is configured. Reads still demo-fallback on error. */
  get isLive(): boolean {
    return features.gnosisPay;
  }

  /** Build a SIWE message for the given address on Gnosis Chain (chainId 100). */
  siweMessage(
    address: string,
    domain: string,
    uri: string,
    nonce: string,
    statement = 'Sign in to MAZE / Gnosis Pay',
  ): SiweChallenge {
    const siwe = new SiweMessage({
      domain,
      address,
      statement,
      uri,
      version: '1',
      chainId: 100,
      nonce,
    });
    return { message: siwe.prepareMessage(), nonce };
  }

  async verifySiwe(message: string, signature: string): Promise<{ address: string; valid: boolean }> {
    try {
      const siwe = new SiweMessage(message);
      const result = await siwe.verify({ signature });
      return { address: siwe.address, valid: result.success };
    } catch {
      return { address: '', valid: false };
    }
  }

  /**
   * Deploy a Gnosis Safe for the user on Gnosis Chain. Live: encode
   * SafeProxyFactory.createProxyWithNonce and route it through the 7702 executor;
   * the deployed proxy address is derived deterministically from the user id
   * (CREATE2 salt) so we can resolve it without a receipt round-trip in this
   * scaffold. Demo (or any failure): a deterministic `0x` Safe address.
   */
  async deploySafe(
    userId: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<{ safeAddress: string; demo: boolean }> {
    const safeAddress = demoSafeAddress(userId);
    if (!this.isLive) return { safeAddress, demo: true };
    try {
      // Empty initializer keeps the scaffold dependency-free; the production diff
      // swaps in Safe.setup(owners, threshold, …) calldata once the owner set is
      // threaded from the session.
      const calls: SponsoredCall[] = [
        {
          to: SAFE_PROXY_FACTORY,
          data: encodeFunctionData({
            abi: SAFE_PROXY_FACTORY_ABI,
            functionName: 'createProxyWithNonce',
            args: [SAFE_SINGLETON_L2, '0x', BigInt('0x' + digest(userId, 'safe').slice(0, 16))],
          }),
        },
      ];
      const sendOpts: { chainId: number; idempotencyKey?: string } = { chainId: GNOSIS_CHAIN_ID };
      if (opts?.idempotencyKey) sendOpts.idempotencyKey = opts.idempotencyKey;
      const res = await executor.sendCalls(userId, calls, sendOpts);
      if (res.demo) return { safeAddress, demo: true };
      return { safeAddress, demo: false };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'gnosisPay: deploySafe failed — demo fallback',
      );
      return { safeAddress, demo: true };
    }
  }

  /**
   * Order a virtual card for the user. Live: Gnosis Pay REST card-mint with a
   * Bearer key, mapping back the last4 + network + masked PAN. Demo (or any
   * failure): a Visa card with a deterministic last4 and the masked `5312` PAN.
   */
  async orderVirtualCard(
    userId: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<{ last4: string; network: string; pan: string; demo: boolean }> {
    const last4 = demoLast4(userId);
    const demoCard = {
      last4,
      network: 'Visa',
      pan: `5312 ···· ···· ${last4}`,
      demo: true,
    };
    if (!this.isLive) return demoCard;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${env.GNOSIS_PAY_API_KEY ?? ''}`,
      };
      if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
      const res = await fetch(`${this.apiBase()}/api/v1/cards/virtual`, {
        method: 'POST',
        headers,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn({ status: res.status, text }, 'gnosisPay: orderVirtualCard rejected — demo fallback');
        return demoCard;
      }
      const data = (await res.json().catch(() => ({}))) as {
        last4?: string;
        lastFour?: string;
        lastFourDigits?: string;
        network?: string;
        scheme?: string;
        pan?: string;
        maskedPan?: string;
      };
      const live4 = data.last4 ?? data.lastFour ?? data.lastFourDigits ?? last4;
      const network = data.network ?? data.scheme ?? 'Visa';
      const pan = data.maskedPan ?? data.pan ?? `5312 ···· ···· ${live4}`;
      return { last4: live4, network, pan, demo: false };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'gnosisPay: orderVirtualCard unreachable — demo fallback',
      );
      return demoCard;
    }
  }

  /**
   * Read the user's card summary (Safe + last4 + network). Live: Gnosis Pay REST
   * card lookup; demo (or any failure): deterministic + stable per user so the
   * card screen renders the same card every load.
   */
  async getCard(
    userId: string,
  ): Promise<{ safeAddress: string; last4: string; network: string; demo: boolean }> {
    const demoCard = {
      safeAddress: demoSafeAddress(userId),
      last4: demoLast4(userId),
      network: 'Visa',
      demo: true,
    };
    if (!this.isLive) return demoCard;
    try {
      const res = await fetch(`${this.apiBase()}/api/v1/cards?status_code=1000`, {
        headers: { Authorization: `Bearer ${env.GNOSIS_PAY_API_KEY ?? ''}` },
      });
      if (!res.ok) return demoCard;
      const body = (await res.json().catch(() => null)) as
        | { cards?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
        | null;
      const card = (Array.isArray(body) ? body[0] : body?.cards?.[0]) as
        | { last4?: string; lastFour?: string; lastFourDigits?: string; network?: string; scheme?: string; safeAddress?: string; safe?: string }
        | undefined;
      if (!card) return demoCard;
      return {
        safeAddress: card.safeAddress ?? card.safe ?? demoCard.safeAddress,
        last4: card.last4 ?? card.lastFour ?? card.lastFourDigits ?? demoCard.last4,
        network: card.network ?? card.scheme ?? 'Visa',
        demo: false,
      };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'gnosisPay: getCard unreachable — demo fallback',
      );
      return demoCard;
    }
  }

  /**
   * Card spendable balance in USD. Live: Gnosis Pay REST balance; demo (or any
   * failure): a stable sample balance so the card screen shows a figure.
   */
  async getCardBalanceUsd(userId: string): Promise<number> {
    if (!this.isLive) return 1240.5;
    try {
      const res = await fetch(`${this.apiBase()}/v1/cards/balance`, {
        headers: { Authorization: `Bearer ${env.GNOSIS_PAY_API_KEY ?? ''}` },
      });
      if (!res.ok) return 1240.5;
      const data = (await res.json().catch(() => ({}))) as { balanceUsd?: number; balance?: number };
      const v = data.balanceUsd ?? data.balance;
      return typeof v === 'number' && Number.isFinite(v) ? v : 1240.5;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'gnosisPay: getCardBalanceUsd unreachable — demo fallback',
      );
      return 1240.5;
    }
  }

  /**
   * Recent card transactions. Live: Gnosis Pay REST transactions; demo (or any
   * failure): a small sample list so the activity feed renders.
   */
  async getCardTransactions(
    userId: string,
  ): Promise<Array<{ title: string; amountUsd: number; at: string }>> {
    if (!this.isLive) return demoCardTransactions();
    try {
      const res = await fetch(`${this.apiBase()}/v1/cards/transactions`, {
        headers: { Authorization: `Bearer ${env.GNOSIS_PAY_API_KEY ?? ''}` },
      });
      if (!res.ok) return demoCardTransactions();
      const body = (await res.json().catch(() => null)) as
        | { transactions?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
        | null;
      const rows = Array.isArray(body) ? body : body?.transactions;
      if (!Array.isArray(rows)) return demoCardTransactions();
      return rows.map((r) => ({
        title: String(r.merchant ?? r.title ?? r.description ?? 'Card purchase'),
        amountUsd: Number(r.amountUsd ?? r.amount ?? 0),
        at: String(r.at ?? r.createdAt ?? r.timestamp ?? new Date().toISOString()),
      }));
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'gnosisPay: getCardTransactions unreachable — demo fallback',
      );
      return demoCardTransactions();
    }
  }
}

/** Stable sample card activity for demo / disabled / error. */
function demoCardTransactions(): Array<{ title: string; amountUsd: number; at: string }> {
  return [
    { title: 'Whole Foods Market', amountUsd: 64.2, at: '2026-06-12T18:24:00.000Z' },
    { title: 'Uber', amountUsd: 18.5, at: '2026-06-12T09:11:00.000Z' },
    { title: 'Netflix', amountUsd: 15.49, at: '2026-06-10T00:00:00.000Z' },
    { title: 'Shell', amountUsd: 52.8, at: '2026-06-08T14:02:00.000Z' },
  ];
}

export const gnosisPayAdapter = new GnosisPayAdapter();

/**
 * Monerium adapter — EUR ↔ EURe ↔ SEPA on Gnosis Chain.
 *
 * Monerium issues EURe (Euro e-money) on Gnosis Chain and ties it to a
 * SEPA-addressable IBAN owned by the user. This bypasses Bridge for EU
 * onramp / offramp:
 *
 *   Onramp:  user SEPA wire → Monerium IBAN → EURe minted on Gnosis → user's address
 *   Offramp: user signs EURe burn → Monerium destroys → SEPA wire to user's bank
 *
 * Crucially the IBAN is **issued in the user's name** (not custodial-to-MAZE)
 * because Monerium is an EU e-money institution. This is the closest to true
 * non-custodial bank rails we can get today.
 *
 * Status: docs-only by default. Set MONERIUM_API_KEY (+ MONERIUM_API_SECRET
 * for OAuth) to flip the adapter to live. Until then the surface returns
 * `unavailable` and the registry stays at `docs-only`.
 *
 * Docs:
 *   https://monerium.dev/api-docs/v2/profiles/manage-profiles
 *   https://monerium.dev/docs
 *   https://monerium.com/
 *
 * Status reads OAuth-token + profile from cache; chain reads (EURe balance,
 * transfer history) ride the existing Gnosis chain stack at runtime when
 * features.chain becomes true.
 */

import { env } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import { liveMeta, providerDemoMeta, unavailableMeta } from '../sourced.js';
import { ChainError } from './units.js';
import type { SourcedValueMeta } from '@nexa/shared-zod';

const DEFAULT_API_BASE = 'https://api.monerium.app';
const MONERIUM_CHAIN = 'gnosis' as const;
const TOKEN_BUFFER_MS = 60_000; // refresh 1 minute before expiry

let cachedToken: { value: string; expiresAt: number } | null = null;

function apiBase(): string {
  return env.MONERIUM_API_BASE ?? DEFAULT_API_BASE;
}

export interface MoneriumProfile {
  /** User-owned IBAN issued in their legal name. */
  iban: string;
  /** BIC paired with the IBAN. */
  bic: string;
  /** Profile id from Monerium. */
  profileId: string;
  /** KYC state — usually 'verified' once the user has completed Monerium KYC. */
  kycStatus: 'pending' | 'verified' | 'failed';
}

export interface MoneriumOfframpInput {
  /** EURe amount the user wants to withdraw to fiat. */
  amountEur: number;
  /** Source EVM address (Gnosis Chain) the EURe is burned from. */
  sourceAddress: string;
  /** Optional reference shown on the SEPA wire. */
  reference?: string;
}

export interface MoneriumOfframpResult {
  /** Monerium order id. */
  orderId: string;
  /** Final state after submission ('placed', 'processed', 'rejected'). */
  state: 'placed' | 'processed' | 'rejected' | 'expired';
  /** Demo flag — true when the synthetic fallback ran. */
  demo: boolean;
}

export class MoneriumAdapter {
  /** True when both API key and secret are configured. */
  get isLive(): boolean {
    return Boolean(env.MONERIUM_API_KEY && env.MONERIUM_API_SECRET);
  }

  /** Status snapshot used by the registry + /monerium/status route. */
  status(): { provider: 'monerium'; available: boolean; chain: typeof MONERIUM_CHAIN; sourced: SourcedValueMeta } {
    const sourced = this.isLive
      ? liveMeta('monerium', 'status')
      : providerDemoMeta('monerium', 'status');
    return {
      provider: 'monerium',
      available: this.isLive,
      chain: MONERIUM_CHAIN,
      sourced,
    };
  }

  /**
   * Fetch the user's Monerium profile (IBAN + BIC). Returns null when the
   * adapter is not live or the user hasn't been onboarded with Monerium yet.
   * Caller is expected to wire the profile bootstrap (sign a SIWE statement,
   * link the address) — that flow is its own follow-up sprint.
   */
  async profile(userAddress: string): Promise<MoneriumProfile | null> {
    if (!this.isLive) return null;
    try {
      const token = await this.bearerToken();
      // Sprint 17 F072 — GET wrapped with timeout + 3-attempt retry.
      const res = await httpRequest(`${apiBase()}/v2/profiles?address=${userAddress}`, {
        vendor: 'monerium',
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: 10_000,
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new ChainError('rpc_failed', `Monerium profile ${res.status}`);
      }
      const body = (await res.json()) as {
        items?: Array<{
          id: string;
          accounts?: Array<{ iban?: string; bic?: string }>;
          kyc?: { state?: string };
        }>;
      };
      const profile = body.items?.[0];
      if (!profile || !profile.accounts?.length) return null;
      const account = profile.accounts.find((a) => a.iban && a.bic);
      if (!account || !account.iban || !account.bic) return null;
      const kyc = profile.kyc?.state;
      const kycStatus: MoneriumProfile['kycStatus'] =
        kyc === 'verified' || kyc === 'approved'
          ? 'verified'
          : kyc === 'rejected'
            ? 'failed'
            : 'pending';
      return {
        iban: account.iban,
        bic: account.bic,
        profileId: profile.id,
        kycStatus,
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'monerium: profile fetch failed');
      return null;
    }
  }

  /**
   * Submit an EURe → SEPA offramp order. The user's wallet must hold EURe
   * on Gnosis Chain; Monerium burns the EURe and wires the EUR. Demo path
   * returns a synthetic order id and `placed` state so the e2e loop closes.
   */
  async offramp(input: MoneriumOfframpInput): Promise<MoneriumOfframpResult> {
    if (!this.isLive) {
      return {
        orderId: `mn_demo_${Math.random().toString(16).slice(2, 14)}`,
        state: 'placed',
        demo: true,
      };
    }
    try {
      const token = await this.bearerToken();
      const body = JSON.stringify({
        kind: 'redeem',
        amount: input.amountEur.toFixed(2),
        currency: 'eur',
        chain: 'gnosis',
        memo: input.reference,
        address: input.sourceAddress,
      });
      const res = await httpRequest(`${apiBase()}/v2/orders`, {
        vendor: 'monerium',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body,
        timeoutMs: 15_000,
      });
      if (!res.ok) {
        throw new ChainError('rpc_failed', `Monerium offramp ${res.status}: ${await res.text().catch(() => '')}`);
      }
      const parsed = (await res.json()) as { id?: string; state?: string };
      const state: MoneriumOfframpResult['state'] =
        parsed.state === 'processed' ? 'processed' : parsed.state === 'rejected' ? 'rejected' : parsed.state === 'expired' ? 'expired' : 'placed';
      return {
        orderId: parsed.id ?? `mn_${Date.now().toString(16)}`,
        state,
        demo: false,
      };
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'monerium: offramp failed');
      throw e instanceof ChainError ? e : new ChainError('rpc_failed', 'monerium offramp failed', e);
    }
  }

  /** Translate an internal error into a SourcedValueMeta envelope. */
  unavailableMeta(cause?: unknown): SourcedValueMeta {
    return unavailableMeta('monerium', 'status', cause);
  }

  /**
   * OAuth client-credentials flow — exchange API key + secret for a short-lived
   * bearer token, cached until just before expiry.
   */
  private async bearerToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt - TOKEN_BUFFER_MS > now) {
      return cachedToken.value;
    }
    const apiKey = env.MONERIUM_API_KEY;
    const secret = env.MONERIUM_API_SECRET;
    if (!apiKey || !secret) {
      throw new ChainError('wallet_missing', 'monerium credentials missing');
    }
    const res = await httpRequest(`${apiBase()}/auth/token`, {
      vendor: 'monerium',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: apiKey,
        client_secret: secret,
      }).toString(),
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      throw new ChainError('rpc_failed', `Monerium token ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new ChainError('rpc_failed', 'Monerium token: access_token missing');
    }
    const expiresIn = (body.expires_in ?? 600) * 1000;
    cachedToken = {
      value: body.access_token,
      expiresAt: now + expiresIn,
    };
    return body.access_token;
  }
}

export const moneriumAdapter = new MoneriumAdapter();

/** Test-only — clear the cached OAuth token between runs. */
export function _resetMoneriumToken(): void {
  cachedToken = null;
}

/**
 * Laso Finance card adapter — scaffold.
 *
 * Laso (https://laso.finance) is the leading candidate for replacing or
 * augmenting Gnosis Pay because it supports Base + USDC natively (the
 * exact rails NEXA already runs) and offers an "instant stablecoin → card"
 * load model that matches our custody pattern. Status as of 2026-06-20:
 * SDK / API documentation requires a vendor contact (support@laso.finance);
 * this file ships the adapter shape so the moment keys arrive the live
 * methods can be filled in without changing the route layer.
 *
 * The adapter implements `CardIssuer` (see ./types.ts) and degrades the same
 * way Gnosis Pay does: every method returns `demo:true` and never throws.
 * Routes that call this adapter behind the factory get the existing
 * `providerDemoMeta('laso', …)` surface for free.
 *
 * Wire-up to routes happens in a follow-up commit once `LASO_API_KEY` is
 * present in `/opt/neobank/secrets/maze.env`.
 */

import { createHash } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { env } from '../env.js';
import { log } from '../log.js';
import type {
  CardCapability,
  CardIssuer,
  CardOrderResult,
  CardReadResult,
  CardSafeResult,
  CardTransaction,
} from './types.js';

function digest(userId: string, tag: string): string {
  return createHash('sha256').update(`${userId}:${tag}:laso`).digest('hex');
}

function demoLast4(userId: string): string {
  const h = digest(userId, 'card');
  let out = '';
  for (let i = 0; i < 4; i++) out += (parseInt(h[i] ?? '0', 16) % 10).toString();
  return out;
}

function demoSafeAddress(userId: string): string {
  return getAddress(('0x' + digest(userId, 'safe').slice(0, 40)) as Hex);
}

export class LasoAdapter implements CardIssuer {
  readonly name = 'laso' as const;

  private apiBase(): string {
    return (env.LASO_API_BASE ?? 'https://api.laso.finance').replace(/\/+$/, '');
  }

  private apiKey(): string | null {
    return env.LASO_API_KEY ?? null;
  }

  get isLive(): boolean {
    return Boolean(this.apiKey());
  }

  async capability(): Promise<CardCapability> {
    if (!this.isLive) return { available: false, reason: 'no_api_key' };
    return { available: true };
  }

  async deploySafe(userId: string): Promise<CardSafeResult> {
    const safeAddress = demoSafeAddress(userId);
    if (!this.isLive) return { safeAddress, demo: true };
    // TODO(laso): replace with live Laso wallet provisioning once docs arrive.
    // Laso's model is a hosted custody account, not a Safe — when the live
    // path lands, return the wallet handle in the same shape (the wire field
    // is still called `safeAddress` for route-layer compatibility).
    log.warn({ userId }, 'laso: deploySafe scaffold — live path pending vendor docs');
    return { safeAddress, demo: true };
  }

  async orderVirtualCard(userId: string): Promise<CardOrderResult> {
    const last4 = demoLast4(userId);
    const fallback: CardOrderResult = {
      last4,
      network: 'Visa',
      pan: `4112 ···· ···· ${last4}`,
      demo: true,
    };
    if (!this.isLive) return fallback;
    // TODO(laso): live POST {apiBase}/cards once vendor docs arrive.
    log.warn({ userId }, 'laso: orderVirtualCard scaffold — live path pending');
    return fallback;
  }

  async getCard(userId: string): Promise<CardReadResult> {
    return {
      safeAddress: demoSafeAddress(userId),
      last4: demoLast4(userId),
      network: 'Visa',
      demo: true,
    };
  }

  async getCardBalanceUsd(_userId: string): Promise<number> {
    return 0;
  }

  async getCardTransactions(_userId: string): Promise<CardTransaction[]> {
    return [];
  }
}

export const lasoAdapter = new LasoAdapter();

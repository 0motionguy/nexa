/**
 * Vendor-pluggable card issuer interface.
 *
 * The route layer (apps/api/src/routes/card.ts) currently calls
 * `getChainStack().gnosis` directly. This module introduces a `CardIssuer`
 * abstraction so a future change can swap issuers (Gnosis Pay / Sponge /
 * Laso / SolCard) via env flag without touching the route handlers.
 *
 * Design:
 *  - `CardIssuer.capability()` returns whether the adapter is live + a short
 *    reason when it's not (no API key, vendor outage). Routes call this
 *    once per request and downgrade gracefully (HTTP 503 with `sourced`
 *    metadata pointing at the disabled vendor).
 *  - `CardIssuer.deploySafe()`/`.orderVirtualCard()`/etc. mirror the Gnosis
 *    Pay adapter's existing surface so the migration is a function-by-
 *    function swap rather than a contract redesign.
 *  - Each method must NEVER throw to the route. On vendor errors, return the
 *    `demo:true` shape so the route can mark `sourced: providerDemoMeta(...)`
 *    and the UI can show the existing "unavailable" surface.
 *
 * Wiring this up to routes/card.ts is a follow-up commit; this file just
 * lands the abstraction so a Laso integration can be drafted in parallel.
 */

export type CardIssuerName = 'gnosis-pay' | 'sponge' | 'laso' | 'solcard';

export interface CardCapability {
  available: boolean;
  reason?: 'no_api_key' | 'unreachable' | 'jurisdiction' | 'kyc_required' | 'demo';
}

export interface CardSafeResult {
  safeAddress: string;
  demo: boolean;
}

export interface CardOrderResult {
  last4: string;
  network: string;
  pan: string;
  demo: boolean;
}

export interface CardReadResult {
  safeAddress: string;
  last4: string;
  network: string;
  demo: boolean;
}

export interface CardTransaction {
  title: string;
  amountUsd: number;
  at: string;
}

export interface CardIssuer {
  readonly name: CardIssuerName;

  /** Cheap probe — does the adapter have keys + can it reach the vendor? */
  capability(): Promise<CardCapability>;

  /** Provision the on-chain safe / equivalent custody container. */
  deploySafe(userId: string, opts?: { idempotencyKey?: string | null }): Promise<CardSafeResult>;

  /** Mint the virtual card. */
  orderVirtualCard(userId: string, opts?: { idempotencyKey?: string | null }): Promise<CardOrderResult>;

  /** Read current card summary (idempotent). */
  getCard(userId: string): Promise<CardReadResult>;

  /** USD balance available on the card. */
  getCardBalanceUsd(userId: string): Promise<number>;

  /** Recent activity feed (already converted to USD; no FX). */
  getCardTransactions(userId: string): Promise<CardTransaction[]>;
}

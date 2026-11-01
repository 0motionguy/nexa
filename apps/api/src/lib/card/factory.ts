/**
 * Card-issuer factory.
 *
 * Dispatches to the configured vendor based on env. Default issuer is
 * `gnosis-pay` (the existing wiring) so installing this factory is
 * zero-disruption to routes/card.ts; future commits can update the route
 * to call `getCardIssuer()` instead of `getChainStack().gnosis` directly.
 *
 * Env switches:
 *   CARD_ISSUER=gnosis-pay  (default, preserves current behavior)
 *   CARD_ISSUER=laso        (live once LASO_API_KEY is provisioned)
 *   CARD_ISSUER=sponge      (reserved; Sponge adapter shape lives in
 *                           lib/chain/sponge.ts but isn't wrapped yet)
 *
 * Adapters that don't yet implement `CardIssuer` directly are wrapped
 * inline; this keeps the migration incremental.
 */

import { gnosisPayAdapter } from '../chain/gnosisPay.js';
import { env } from '../env.js';
import { log } from '../log.js';
import { lasoAdapter } from './laso.js';
import type {
  CardCapability,
  CardIssuer,
  CardIssuerName,
  CardOrderResult,
  CardReadResult,
  CardSafeResult,
  CardTransaction,
} from './types.js';

/**
 * Inline adapter that adds `capability()` + `name` to the existing
 * GnosisPayAdapter without changing its file. Drop this once
 * lib/chain/gnosisPay.ts is migrated to implement `CardIssuer` directly.
 */
const gnosisPayWrapper: CardIssuer = {
  name: 'gnosis-pay',
  async capability(): Promise<CardCapability> {
    return gnosisPayAdapter.isLive
      ? { available: true }
      : { available: false, reason: 'no_api_key' };
  },
  deploySafe(userId: string, opts?: { idempotencyKey?: string | null }): Promise<CardSafeResult> {
    return gnosisPayAdapter.deploySafe(userId, opts);
  },
  async orderVirtualCard(userId: string, opts?: { idempotencyKey?: string | null }): Promise<CardOrderResult> {
    return gnosisPayAdapter.orderVirtualCard(userId, opts);
  },
  async getCard(userId: string): Promise<CardReadResult> {
    return gnosisPayAdapter.getCard(userId);
  },
  getCardBalanceUsd(userId: string): Promise<number> {
    return gnosisPayAdapter.getCardBalanceUsd(userId);
  },
  getCardTransactions(userId: string): Promise<CardTransaction[]> {
    return gnosisPayAdapter.getCardTransactions(userId);
  },
};

const ISSUERS: Record<CardIssuerName, CardIssuer | null> = {
  'gnosis-pay': gnosisPayWrapper,
  laso: lasoAdapter,
  sponge: null,
  solcard: null,
};

export function getCardIssuer(): CardIssuer {
  const requested = (env.CARD_ISSUER ?? 'gnosis-pay') as CardIssuerName;
  const issuer = ISSUERS[requested];
  if (!issuer) {
    log.warn(
      { requested },
      'card-factory: requested issuer not implemented — falling back to gnosis-pay',
    );
    return gnosisPayWrapper;
  }
  return issuer;
}

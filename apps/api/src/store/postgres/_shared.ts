/**
 * Shared helpers + row → domain mappers used across every Postgres domain module.
 *
 * Sprint 12 Phase 3 — extracted from the monolithic store/postgres.ts so each
 * module file can be small and focused. The mappers stay row-shape ↔ domain-shape
 * and never call back into a domain class.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../../db/client.js';
import {
  nbApiKeys,
  nbBridgeTransfers,
  nbCampaignSubmissions,
  nbCampaigns,
  nbClaimWallets,
  nbMarketPositions,
  nbOffers,
  nbPayments,
  nbPayoutMethods,
  nbPayouts,
  nbSubAccounts,
  nbSubscriptions,
  nbVirtualAccounts,
  nbWebhookEndpoints,
} from '../../db/schema/index.js';
import {
  type ApiKey,
  type BridgeTransfer,
  type Campaign,
  type CampaignSubmission,
  type ClaimRecord,
  type MarketPosition,
  type Offer,
  type Payment,
  type Payout,
  type PayoutMethod,
  type SplitRule,
  type SubAccount,
  type Subscription,
  type VirtualAccount,
  type WebhookEndpoint,
} from '../types.js';
import { n, round2 } from '../../lib/money.js';

export { n, round2 };

/**
 * The Drizzle transaction callback receives an executor that lacks `$client`.
 * This alias accepts both the top-level Db and a transaction-scoped executor
 * for the few methods we actually call (select/insert/update/execute).
 */
export type DbExecutor = Pick<Db, 'select' | 'insert' | 'update' | 'execute'>;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function money(v: number): string {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ref(): string {
  return '0x' + randomUUID().replace(/-/g, '').slice(0, 8) + '..' + randomUUID().slice(0, 4);
}

export function parseAmount(s: string): number {
  const sign = s.startsWith('−') || s.startsWith('-') ? -1 : 1;
  const m = s.replace(/[^0-9.]/g, '');
  const v = Number(m);
  return Number.isFinite(v) ? sign * v : 0;
}

export function formatAmount(amount: number, kind: string): string {
  const abs = Math.abs(amount);
  const fmt = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (kind === 'in' || kind === 'swap') return '+' + fmt;
  return '−' + fmt;
}

/* ── row → domain mappers ── */

type OfferRow = typeof nbOffers.$inferSelect;
type PaymentRow = typeof nbPayments.$inferSelect;
type WebhookRow = typeof nbWebhookEndpoints.$inferSelect;
type ApiKeyRow = typeof nbApiKeys.$inferSelect;
type SubAccountRow = typeof nbSubAccounts.$inferSelect;
type PayoutRow = typeof nbPayouts.$inferSelect;
type SubscriptionRow = typeof nbSubscriptions.$inferSelect;
type VirtualAccountRow = typeof nbVirtualAccounts.$inferSelect;
type ClaimRow = typeof nbClaimWallets.$inferSelect;
type PayoutMethodRow = typeof nbPayoutMethods.$inferSelect;
type BridgeTransferRow = typeof nbBridgeTransfers.$inferSelect;
type MarketPositionRow = typeof nbMarketPositions.$inferSelect;
type CampaignRow = typeof nbCampaigns.$inferSelect;
type CampaignSubmissionRow = typeof nbCampaignSubmissions.$inferSelect;

export function payoutMethodFromRow(row: PayoutMethodRow): PayoutMethod {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as PayoutMethod['type'],
    externalAccountId: row.externalAccountId,
    label: row.label,
    status: row.status as PayoutMethod['status'],
    livemode: row.livemode,
    createdAt: row.createdAt.toISOString(),
  };
}

export function bridgeTransferFromRow(row: BridgeTransferRow): BridgeTransfer {
  return {
    id: row.id,
    userId: row.userId,
    payoutMethodId: row.payoutMethodId,
    amountUsd: n(row.amountUsd),
    status: row.status as BridgeTransfer['status'],
    externalRef: row.externalRef,
    createdAt: row.createdAt.toISOString(),
  };
}

export function offerFromRow(row: OfferRow): Offer {
  return {
    id: row.id,
    sellerId: row.sellerId,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl,
    amountUsd: n(row.amountUsd),
    currency: row.currency as Offer['currency'],
    type: row.type as Offer['type'],
    fulfillmentKind: row.fulfillmentKind as Offer['fulfillmentKind'],
    fulfillmentValue: row.fulfillmentValue,
    active: row.active,
    livemode: row.livemode,
    subAccountId: row.subAccountId,
    splits: (row.splits as SplitRule[] | null) ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

export function subAccountFromRow(row: SubAccountRow): SubAccount {
  return {
    id: row.id,
    sellerId: row.sellerId,
    name: row.name,
    balUsd: n(row.balUsd),
    sandboxBalUsd: n(row.sandboxBalUsd),
    createdAt: row.createdAt.toISOString(),
  };
}

export function virtualAccountFromRow(row: VirtualAccountRow): VirtualAccount {
  return {
    id: row.id,
    currency: row.currency as VirtualAccount['currency'],
    routingNumber: row.routingNumber,
    accountNumber: row.accountNumber,
    iban: row.iban,
    bic: row.bic,
    bankName: row.bankName,
    livemode: row.livemode,
    createdAt: row.createdAt.toISOString(),
  };
}

export function payoutFromRow(row: PayoutRow): Payout {
  return {
    id: row.id,
    sellerId: row.sellerId,
    amountUsd: n(row.amountUsd),
    currency: row.currency as Payout['currency'],
    destination: row.destination,
    method: row.method,
    note: row.note,
    status: row.status as Payout['status'],
    livemode: row.livemode,
    createdAt: row.createdAt.toISOString(),
  };
}

export function subscriptionFromRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    sellerId: row.sellerId,
    offerId: row.offerId,
    offerTitle: row.offerTitle,
    buyerEmail: row.buyerEmail,
    amountUsd: n(row.amountUsd),
    currency: row.currency as Subscription['currency'],
    status: row.status as Subscription['status'],
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    livemode: row.livemode,
    createdAt: row.createdAt.toISOString(),
  };
}

export function claimFromRow(row: ClaimRow): ClaimRecord {
  return {
    id: row.id,
    slug: row.slug ?? '',
    senderUserId: row.senderUserId,
    senderName: row.senderName ?? '',
    email: row.email,
    amountUsd: n(row.amountUsd),
    walletAddress: row.walletAddress || null,
    status: row.status as ClaimRecord['status'],
    expiresAt: row.expiresAt.toISOString(),
    claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function paymentFromRow(row: PaymentRow): Payment {
  return {
    id: row.id,
    offerId: row.offerId,
    sellerId: row.sellerId,
    offerTitle: row.offerTitle,
    amountUsd: n(row.amountUsd),
    currency: row.currency as Payment['currency'],
    buyerEmail: row.buyerEmail,
    method: row.method,
    status: row.status as Payment['status'],
    fulfillmentSent: row.fulfillmentSent,
    livemode: row.livemode,
    createdAt: row.createdAt.toISOString(),
  };
}

export function apiKeyFromRow(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    sellerId: row.sellerId,
    prefix: row.prefix as ApiKey['prefix'],
    last4: row.last4,
    label: row.label,
    livemode: row.livemode,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

export function webhookFromRow(row: WebhookRow): WebhookEndpoint {
  return {
    id: row.id,
    sellerId: row.sellerId,
    url: row.url,
    secret: row.secret,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export function marketPositionFromRow(row: MarketPositionRow): MarketPosition {
  return {
    id: row.id,
    userId: row.userId,
    venue: row.venue as MarketPosition['venue'],
    symbol: row.symbol,
    sideLong: row.sideLong,
    qtyUsd: n(row.qtyUsd),
    entryPriceUsd: n(row.entryPriceUsd),
    status: row.status as MarketPosition['status'],
    externalRef: row.externalRef ?? null,
    createdAt: row.createdAt.toISOString(),
    copiedFrom: row.copiedFrom ?? null,
    lifecycleEvents: Array.isArray(row.lifecycleEvents)
      ? (row.lifecycleEvents as MarketPosition['lifecycleEvents'])
      : [],
    avgFillPriceUsd: row.avgFillPriceUsd != null ? n(row.avgFillPriceUsd) : null,
    filledQtyUsd: row.filledQtyUsd != null ? n(row.filledQtyUsd) : null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    filledAt: row.filledAt ? row.filledAt.toISOString() : null,
    canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
    failedAt: row.failedAt ? row.failedAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : undefined,
  };
}

export function campaignFromRow(row: CampaignRow): Campaign {
  return {
    id: row.id,
    creatorId: row.creatorId,
    title: row.title,
    brand: row.brand,
    baseUsd: n(row.baseUsd),
    bonusTiers: (row.bonusTiers as Array<{ viewsThreshold: number; bonusUsd: number }>) ?? [],
    topPrizeUsd: n(row.topPrizeUsd),
    status: row.status as Campaign['status'],
    endAt: row.endAt ? row.endAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function submissionFromRow(row: CampaignSubmissionRow): CampaignSubmission {
  return {
    id: row.id,
    campaignId: row.campaignId,
    userId: row.userId,
    clipUrl: row.clipUrl,
    platform: row.platform as CampaignSubmission['platform'],
    viewsAttested: row.viewsAttested,
    viewsVerified: row.viewsVerified,
    status: row.status as CampaignSubmission['status'],
    paidUsd: n(row.paidUsd),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

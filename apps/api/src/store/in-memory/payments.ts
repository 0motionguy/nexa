/**
 * InMemoryPayments — offers, payments, payOffer, Stripe sessions.
 *
 * Mirrors PgPayments in shape; talks directly to the InMemoryState Maps and
 * to the InMemorySubscriptions module for sub-accounts + subscriptions maps
 * (payOffer mutates both on split/sub-account credits).
 */

import { randomUUID } from 'node:crypto';
import { computeSplitDistribution } from '../../lib/offers/splits.js';
import {
  type CheckoutView,
  type CreateStripeSessionInput,
  type Offer,
  type OfferInput,
  type PayResult,
  type Payment,
  type Payout,
  PolicyError,
  type StripeSessionRecord,
  type Subscription,
  type SessionUser,
  type User,
} from '../types.js';
import type { InMemoryState } from '../core/in-memory-state.js';
import type { InMemoryLedger } from './ledger.js';
import type { InMemorySubscriptions } from './subscriptions.js';
import { money, nowIso } from './_shared.js';

export class InMemoryPayments {
  private offersById = new Map<string, Offer>();
  private offerIdemKeys = new Map<string, string>();
  private paymentsById = new Map<string, Payment>();
  private idemKeys = new Map<string, string>(); // `${sellerId}:${idempotencyKey}` → paymentId
  private stripeSessions = new Map<string, StripeSessionRecord>();
  // subscriptions module injected lazily by the facade to break the cycle:
  // payOffer creates Subscription rows on the subscriptions Map.
  private subs!: InMemorySubscriptions;
  // ledger injected lazily so we can call ledger.autoDivestIfNeeded inside payOffer.
  private ledger!: InMemoryLedger;

  constructor(private state: InMemoryState) {}

  bindSiblings(subs: InMemorySubscriptions, ledger: InMemoryLedger): void {
    this.subs = subs;
    this.ledger = ledger;
  }

  /* ── offers ── */

  async createOffer(
    u: SessionUser,
    input: OfferInput,
    opts?: { livemode?: boolean; idempotencyKey?: string | null },
  ): Promise<Offer> {
    if (opts?.idempotencyKey) {
      const priorId = this.offerIdemKeys.get(`${u.id}:${opts.idempotencyKey}`);
      if (priorId) {
        const prior = this.offersById.get(priorId);
        if (prior) return prior;
      }
    }
    const offer: Offer = {
      id: randomUUID(),
      sellerId: u.id,
      title: input.title,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      amountUsd: input.amountUsd,
      currency: input.currency ?? 'USD',
      type: input.type ?? 'one_time',
      fulfillmentKind: input.fulfillmentKind ?? 'none',
      fulfillmentValue: input.fulfillmentValue ?? null,
      active: true,
      livemode: opts?.livemode ?? true,
      subAccountId: input.subAccountId ?? null,
      splits: input.splits ?? [],
      createdAt: nowIso(),
    };
    this.offersById.set(offer.id, offer);
    if (opts?.idempotencyKey) this.offerIdemKeys.set(`${u.id}:${opts.idempotencyKey}`, offer.id);
    return offer;
  }

  async listOffers(u: SessionUser, opts?: { livemode?: boolean }): Promise<Offer[]> {
    return [...this.offersById.values()]
      .filter((o) => o.sellerId === u.id && (opts?.livemode === undefined || o.livemode === opts.livemode))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async sellerOffer(u: SessionUser, id: string): Promise<Offer> {
    const o = this.offersById.get(id);
    if (!o || o.sellerId !== u.id) throw new Error('offer_not_found');
    return o;
  }

  async updateOffer(
    u: SessionUser,
    id: string,
    patch: Partial<OfferInput> & { active?: boolean },
  ): Promise<Offer> {
    const o = await this.sellerOffer(u, id);
    Object.assign(o, patch);
    return o;
  }

  async checkoutView(offerId: string): Promise<CheckoutView | null> {
    const o = this.offersById.get(offerId);
    if (!o || !o.active) return null;
    const sellerName = this.state.usersById.get(o.sellerId)?.name ?? 'A MAZE seller';
    return {
      offerId: o.id,
      title: o.title,
      description: o.description,
      imageUrl: o.imageUrl,
      amountUsd: o.amountUsd,
      currency: o.currency,
      type: o.type,
      sellerName,
      active: o.active,
    };
  }

  async payOffer(
    offerId: string,
    opts: {
      buyerEmail: string | null;
      method: string;
      idempotencyKey?: string | null;
      buyerUser?: User | null;
    },
  ): Promise<PayResult> {
    const { buyerEmail, method, idempotencyKey, buyerUser } = opts;

    // F033 — load + validate the offer FIRST, then check idempotency.
    const offer = this.offersById.get(offerId);
    if (!offer) throw new Error('offer_not_found');
    if (!offer.active) throw new Error('offer_inactive');

    const seller = this.state.usersById.get(offer.sellerId);
    if (!seller) throw new Error('offer_not_found');

    if (idempotencyKey) {
      const priorId = this.idemKeys.get(`${seller.id}:${idempotencyKey}`);
      if (priorId) {
        const prior = this.paymentsById.get(priorId)!;
        const priorOffer = this.offersById.get(prior.offerId);
        return {
          payment: prior,
          sellerId: prior.sellerId,
          fulfillment: {
            kind: priorOffer?.fulfillmentKind ?? 'none',
            value: priorOffer?.fulfillmentValue ?? null,
          },
          fresh: false,
          payouts: [],
          subscription: null,
        };
      }
    }

    // Sprint 10 Item G — when a buyerUser is threaded in for the 'balance' flow,
    // debit their balUsd here so humans check out via the same x402 path as
    // agents. autoDivestIfNeeded honors the Item A opt-in before the balance
    // check throws. Live-mode only — sandbox/test offers don't move balUsd.
    if (buyerUser && method === 'balance' && offer.livemode) {
      const buyer = this.state.usersById.get(buyerUser.id);
      if (!buyer) throw new Error('buyer_not_found');
      await this.ledger.autoDivestIfNeeded(buyer, offer.amountUsd);
      if (offer.amountUsd > buyer.balUsd) {
        throw new PolicyError('insufficient_funds', 'Not enough balance.');
      }
      buyer.balUsd -= offer.amountUsd;
      await this.state.pushActivity(buyer, {
        n: 'Paid · ' + offer.title,
        s: 'CHECKOUT · JUST NOW',
        a: '−' + money(offer.amountUsd),
        k: 'x402',
      });
      buyerUser.balUsd = buyer.balUsd;
    }

    const payment: Payment = {
      id: randomUUID(),
      offerId: offer.id,
      sellerId: seller.id,
      offerTitle: offer.title,
      amountUsd: offer.amountUsd,
      currency: offer.currency,
      buyerEmail: buyerEmail ?? null,
      method,
      status: 'paid',
      fulfillmentSent: false,
      livemode: offer.livemode,
      createdAt: nowIso(),
    };
    this.paymentsById.set(payment.id, payment);
    if (idempotencyKey) this.idemKeys.set(`${seller.id}:${idempotencyKey}`, payment.id);

    // A `subscription`-type offer creates a recurring agreement on first pay.
    let subscription: Subscription | null = null;
    if (offer.type === 'subscription') {
      subscription = {
        id: randomUUID(),
        sellerId: offer.sellerId,
        offerId: offer.id,
        offerTitle: offer.title,
        buyerEmail: buyerEmail ?? null,
        amountUsd: offer.amountUsd,
        currency: offer.currency,
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        livemode: offer.livemode,
        createdAt: nowIso(),
      };
      this.subs.subscriptions.set(subscription.id, subscription);
    }

    const simple = offer.splits.length === 0 && offer.subAccountId == null;

    if (simple) {
      // Sprint 1/2 behavior, unchanged: credit the seller main/sandbox balance
      // and (for live) push the single 'Sale ·' activity into the human feed.
      if (offer.livemode) seller.balUsd += offer.amountUsd;
      else seller.sandboxBalUsd += offer.amountUsd;

      if (offer.livemode) {
        await this.state.pushActivity(seller, {
          n: 'Sale · ' + offer.title,
          s: (method === 'demo' ? 'SANDBOX' : method === 'balance' ? 'BALANCE' : 'CARD') + ' · JUST NOW',
          a: '+' + money(offer.amountUsd),
          pos: true,
          k: 'in',
        });
      }

      return {
        payment,
        sellerId: seller.id,
        fulfillment: { kind: offer.fulfillmentKind, value: offer.fulfillmentValue },
        fresh: true,
        payouts: [],
        subscription,
      };
    }

    // Split / sub-account distribution. F008 + F019 — math via lib/offers/splits.ts.
    const distribution = computeSplitDistribution(offer.amountUsd, offer.splits);
    const portions = distribution.portions.map((p) => ({ s: p.rule, amt: p.amt }));
    const remainder = distribution.remainder;

    // Sprint 13 COMMIT 2 (Sweep #1) — in-memory has always credited the
    // seller's main balance when the named sub-account was missing; postgres
    // used to silently drop the remainder. We preserve in-memory parity here
    // so the two backends are observationally identical for the same edge.
    const baseSub = offer.subAccountId ? this.subs.subAccounts.get(offer.subAccountId) : undefined;
    if (offer.livemode) {
      if (baseSub) baseSub.balUsd += remainder;
      else seller.balUsd += remainder;
    } else {
      if (baseSub) baseSub.sandboxBalUsd += remainder;
      else seller.sandboxBalUsd += remainder;
    }

    const collectedPayouts: Payout[] = [];
    for (const { s, amt } of portions) {
      if (s.subAccountId) {
        const sub = this.subs.subAccounts.get(s.subAccountId);
        if (sub) {
          if (offer.livemode) sub.balUsd += amt;
          else sub.sandboxBalUsd += amt;
        } else {
          // Same fallback as postgres: credit seller's main balance.
          if (offer.livemode) seller.balUsd += amt;
          else seller.sandboxBalUsd += amt;
        }
      } else if (s.email) {
        const p = await this.subs.createPayout(
          seller,
          { amountUsd: amt, destination: s.email, method: 'email' },
          { livemode: offer.livemode },
        );
        collectedPayouts.push(p);
      }
    }

    // For live sales, still surface ONE 'Sale ·' activity for the GROSS amount.
    if (offer.livemode) {
      await this.state.pushActivity(seller, {
        n: 'Sale · ' + offer.title,
        s: (method === 'demo' ? 'SANDBOX' : 'CARD') + ' · JUST NOW',
        a: '+' + money(offer.amountUsd),
        pos: true,
        k: 'in',
      });
    }

    return {
      payment,
      sellerId: seller.id,
      fulfillment: { kind: offer.fulfillmentKind, value: offer.fulfillmentValue },
      fresh: true,
      payouts: collectedPayouts,
      subscription,
    };
  }

  async listPayments(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payment[]> {
    return [...this.paymentsById.values()]
      .filter((p) => p.sellerId === u.id && (opts?.livemode === undefined || p.livemode === opts.livemode))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async payment(u: SessionUser, id: string): Promise<Payment> {
    const p = this.paymentsById.get(id);
    if (!p || p.sellerId !== u.id) throw new Error('payment_not_found');
    return p;
  }

  /* ── Stripe Checkout sessions ── */

  async createStripeSession(input: CreateStripeSessionInput): Promise<StripeSessionRecord> {
    // Idempotent on sessionId.
    const prior = this.stripeSessions.get(input.sessionId);
    if (prior) return prior;
    const record: StripeSessionRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      offerId: input.offerId,
      buyerEmail: input.buyerEmail,
      amountUsd: input.amountUsd,
      status: 'pending',
      createdAt: nowIso(),
      completedAt: null,
    };
    this.stripeSessions.set(input.sessionId, record);
    return record;
  }

  async findStripeSession(sessionId: string): Promise<StripeSessionRecord | null> {
    return this.stripeSessions.get(sessionId) ?? null;
  }

  async markStripeSessionCompleted(sessionId: string): Promise<StripeSessionRecord | null> {
    const row = this.stripeSessions.get(sessionId);
    if (!row) return null;
    if (row.status === 'completed') return row;
    row.status = 'completed';
    row.completedAt = nowIso();
    return row;
  }

  async markStripeSessionStatus(
    sessionId: string,
    status: 'expired' | 'failed',
  ): Promise<StripeSessionRecord | null> {
    const row = this.stripeSessions.get(sessionId);
    if (!row) return null;
    row.status = status;
    return row;
  }

  /* ── dispose helper for the facade ── */
  clearAll(): void {
    this.offersById.clear();
    this.offerIdemKeys.clear();
    this.paymentsById.clear();
    this.idemKeys.clear();
    this.stripeSessions.clear();
  }
}

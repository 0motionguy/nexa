/**
 * PgPayments — offers, payments, payOffer, Stripe sessions.
 *
 * Cross-domain: payOffer mutates the buyer's user-state (debit), the seller's
 * user-state (credit), sub-account balances on split payouts, and may create
 * a subscription row. All inside a single transaction. The module receives
 * LedgerStateManager for state locking + activity emission; it owns its own
 * Stripe session table writes.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { log } from '../../lib/log.js';
import { computeSplitDistribution } from '../../lib/offers/splits.js';
import {
  nbOffers,
  nbPayments,
  nbPayouts,
  nbStripeSessions,
  nbSubscriptions,
  nbTransactions,
  nbUsers,
} from '../../db/schema/index.js';
import {
  type Activity,
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
import type { LedgerStateManager } from '../core/ledger-state.js';
import type { PgLedger } from './ledger.js';
import {
  money,
  n,
  offerFromRow,
  paymentFromRow,
  payoutFromRow,
  subscriptionFromRow,
} from './_shared.js';

export class PgPayments {
  /** in-process create-offer idempotency: `${userId}:${key}` → offerId */
  private offerIdemKeys = new Map<string, string>();

  constructor(
    private db: Db,
    private core: LedgerStateManager,
    /**
     * Sprint 13 COMMIT 1 — payOffer's auto-divest path goes through ledger so
     * the chain-mirror tail fires when earn is decremented. Without this, a
     * buyer-balance debit could decrement earnUsd inline and skip the mirror.
     */
    private ledger: PgLedger,
  ) {}

  /* ── offers ── */

  async createOffer(
    u: SessionUser,
    input: OfferInput,
    opts?: { livemode?: boolean; idempotencyKey?: string | null },
  ): Promise<Offer> {
    const idemMapKey = opts?.idempotencyKey ? `${u.id}:${opts.idempotencyKey}` : null;
    if (idemMapKey) {
      const priorId = this.offerIdemKeys.get(idemMapKey);
      if (priorId) {
        const [prior] = await this.db.select().from(nbOffers).where(eq(nbOffers.id, priorId)).limit(1);
        if (prior) return offerFromRow(prior);
      }
    }
    const id = randomUUID();
    const at = new Date();
    const [row] = await this.db
      .insert(nbOffers)
      .values({
        id,
        sellerId: u.id,
        title: input.title,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
        amountUsd: input.amountUsd.toFixed(6),
        currency: input.currency ?? 'USD',
        type: input.type ?? 'one_time',
        fulfillmentKind: input.fulfillmentKind ?? 'none',
        fulfillmentValue: input.fulfillmentValue ?? null,
        active: true,
        livemode: opts?.livemode ?? true,
        subAccountId: input.subAccountId ?? null,
        splits: input.splits ?? [],
        createdAt: at,
      })
      .returning();
    if (idemMapKey) this.offerIdemKeys.set(idemMapKey, id);
    return offerFromRow(row!);
  }

  async listOffers(u: SessionUser, opts?: { livemode?: boolean }): Promise<Offer[]> {
    const where =
      opts?.livemode === undefined
        ? eq(nbOffers.sellerId, u.id)
        : and(eq(nbOffers.sellerId, u.id), eq(nbOffers.livemode, opts.livemode));
    const rows = await this.db.select().from(nbOffers).where(where).orderBy(desc(nbOffers.createdAt));
    return rows.map(offerFromRow);
  }

  async sellerOffer(u: SessionUser, id: string): Promise<Offer> {
    const [row] = await this.db
      .select()
      .from(nbOffers)
      .where(and(eq(nbOffers.id, id), eq(nbOffers.sellerId, u.id)))
      .limit(1);
    if (!row) throw new Error('offer_not_found');
    return offerFromRow(row);
  }

  async updateOffer(
    u: SessionUser,
    id: string,
    patch: Partial<OfferInput> & { active?: boolean },
  ): Promise<Offer> {
    // Ownership check (throws offer_not_found if not owned).
    await this.sellerOffer(u, id);
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.imageUrl !== undefined) set.imageUrl = patch.imageUrl;
    if (patch.amountUsd !== undefined) set.amountUsd = patch.amountUsd.toFixed(6);
    if (patch.currency !== undefined) set.currency = patch.currency;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.fulfillmentKind !== undefined) set.fulfillmentKind = patch.fulfillmentKind;
    if (patch.fulfillmentValue !== undefined) set.fulfillmentValue = patch.fulfillmentValue;
    if (patch.subAccountId !== undefined) set.subAccountId = patch.subAccountId;
    if (patch.splits !== undefined) set.splits = patch.splits ?? [];
    if (patch.active !== undefined) set.active = patch.active;
    const [row] =
      Object.keys(set).length > 0
        ? await this.db.update(nbOffers).set(set).where(eq(nbOffers.id, id)).returning()
        : await this.db.select().from(nbOffers).where(eq(nbOffers.id, id)).limit(1);
    return offerFromRow(row!);
  }

  async checkoutView(offerId: string): Promise<CheckoutView | null> {
    // Sprint 11 Phase 2 — single LEFT JOIN (offer + seller name) saves a round-trip
    // on the hot checkout path.
    const rows = await this.db
      .select({
        offer: nbOffers,
        sellerName: nbUsers.name,
      })
      .from(nbOffers)
      .leftJoin(nbUsers, eq(nbUsers.id, nbOffers.sellerId))
      .where(eq(nbOffers.id, offerId))
      .limit(1);
    const row = rows[0];
    if (!row || !row.offer.active) return null;
    const offer = offerFromRow(row.offer);
    return {
      offerId: offer.id,
      title: offer.title,
      description: offer.description,
      imageUrl: offer.imageUrl,
      amountUsd: offer.amountUsd,
      currency: offer.currency,
      type: offer.type,
      sellerName: row.sellerName ?? 'A MAZE seller',
      active: offer.active,
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
    let result!: PayResult;
    let activity: Activity | null = null;
    let sellerId = '';
    let subscription: Subscription | null = null;
    let buyerActivity: Activity | null = null;
    let buyerUserId = '';

    await this.db.transaction(async (tx) => {
      // F009 — load + validate the offer FIRST so we know the seller, then
      // scope the idempotency lookup to (seller_id, idempotency_key).
      const [offerRow] = await tx
        .select()
        .from(nbOffers)
        .where(eq(nbOffers.id, offerId))
        .limit(1);
      if (!offerRow) throw new Error('offer_not_found');
      if (!offerRow.active) throw new Error('offer_inactive');
      const offer = offerFromRow(offerRow);
      sellerId = offer.sellerId;

      // Idempotency: a repeat key returns the prior payment, no re-credit.
      if (idempotencyKey) {
        const [prior] = await tx
          .select()
          .from(nbPayments)
          .where(and(
            eq(nbPayments.sellerId, sellerId),
            eq(nbPayments.idempotencyKey, idempotencyKey),
          ))
          .limit(1);
        if (prior) {
          result = {
            payment: paymentFromRow(prior),
            sellerId: prior.sellerId,
            fulfillment: {
              kind: (offerRow.fulfillmentKind as Offer['fulfillmentKind']) ?? 'none',
              value: offerRow.fulfillmentValue ?? null,
            },
            fresh: false,
            payouts: [],
            subscription: null,
          };
          return;
        }
      }

      const at = new Date();
      const simple = offer.splits.length === 0 && offer.subAccountId == null;
      const collectedPayouts: Payout[] = [];

      // Sprint 10 Item G: debit the buyer's balUsd before the seller credit.
      if (buyerUser && method === 'balance' && offer.livemode) {
        // Sprint 13 COMMIT 1 — route auto-divest through PgLedger BEFORE the
        // transaction's lock-and-read so the chain mirror fires for the earn
        // withdraw. Inline `earnUsd -= shortfall` (the pre-fix path) skipped
        // the mirror entirely; now we lean on PgLedger.autoDivestIfNeeded which
        // runs its own short tx + emits the mirror call after commit.
        await this.ledger.autoDivestIfNeeded(buyerUser, offer.amountUsd);
        const buyerState = await this.core.lockUserState(tx, buyerUser.id);
        if (offer.amountUsd > buyerState.balUsd) {
          throw new PolicyError('insufficient_funds', 'Not enough balance.');
        }
        buyerState.balUsd -= offer.amountUsd;
        await this.core.writeUserState(tx, buyerUser.id, buyerState);
        const buyerTxId = randomUUID();
        const title = 'Paid · ' + offer.title;
        const subtitle = 'CHECKOUT · JUST NOW';
        await tx.insert(nbTransactions).values({
          id: buyerTxId,
          userId: buyerUser.id,
          kind: 'x402',
          status: 'confirmed',
          title,
          subtitle,
          amountUsd: offer.amountUsd.toFixed(6),
          createdAt: at,
        });
        buyerActivity = {
          id: buyerTxId,
          n: title,
          s: subtitle,
          a: '−' + money(offer.amountUsd),
          k: 'x402',
          at: at.toISOString(),
        };
        buyerUserId = buyerUser.id;
        buyerUser.balUsd = buyerState.balUsd;
        buyerUser.earnUsd = buyerState.earnUsd;
      }

      if (simple) {
        // Lock the seller's ledger row and credit the matching balance.
        const state = await this.core.lockUserState(tx, offer.sellerId);
        if (offer.livemode) state.balUsd += offer.amountUsd;
        else state.sandboxBalUsd += offer.amountUsd;
        await this.core.writeUserState(tx, offer.sellerId, state);
      } else {
        // Split / sub-account distribution.
        const distribution = computeSplitDistribution(offer.amountUsd, offer.splits);
        const portions = distribution.portions.map((p) => ({ s: p.rule, amt: p.amt }));
        const remainder = distribution.remainder;

        const sellerState = await this.core.lockUserState(tx, offer.sellerId);

        if (offer.subAccountId) {
          const sub = await this.core.lockSubAccount(tx, offer.subAccountId);
          if (sub) {
            if (offer.livemode) sub.balUsd += remainder;
            else sub.sandboxBalUsd += remainder;
            await this.core.writeSubAccount(tx, offer.subAccountId, sub);
          } else {
            // Sprint 13 COMMIT 2 (Sweep #1) — the named subAccount was deleted
            // between offer creation and payment. Mirror the in-memory fallback
            // and credit the seller's main balance so the remainder is never
            // silently dropped on the floor. Logged at warn so an operator
            // can reconcile if this fires in prod.
            log.warn(
              { offerId: offer.id, subAccountId: offer.subAccountId, remainder },
              'payOffer: subAccount missing; remainder credited to seller main balance',
            );
            if (offer.livemode) sellerState.balUsd += remainder;
            else sellerState.sandboxBalUsd += remainder;
          }
        } else if (offer.livemode) {
          sellerState.balUsd += remainder;
        } else {
          sellerState.sandboxBalUsd += remainder;
        }

        for (const { s, amt } of portions) {
          if (s.subAccountId) {
            const sub = await this.core.lockSubAccount(tx, s.subAccountId);
            if (sub) {
              if (offer.livemode) sub.balUsd += amt;
              else sub.sandboxBalUsd += amt;
              await this.core.writeSubAccount(tx, s.subAccountId, sub);
            } else {
              // Sprint 13 COMMIT 2 (Sweep #1) — same fallback for split rules
              // that named a deleted sub-account. Credit the seller's main
              // balance + log so the operator can reconcile.
              log.warn(
                { offerId: offer.id, subAccountId: s.subAccountId, amount: amt },
                'payOffer: split-rule subAccount missing; portion credited to seller main balance',
              );
              if (offer.livemode) sellerState.balUsd += amt;
              else sellerState.sandboxBalUsd += amt;
            }
          } else if (s.email) {
            // Debit the seller's already-locked state and insert the payout row.
            const live = offer.livemode;
            if (live) sellerState.balUsd -= amt;
            else sellerState.sandboxBalUsd -= amt;
            const payoutId = randomUUID();
            const [payoutRow] = await tx
              .insert(nbPayouts)
              .values({
                id: payoutId,
                sellerId: offer.sellerId,
                amountUsd: amt.toFixed(6),
                currency: 'USD',
                destination: s.email,
                method: 'email',
                note: null,
                status: 'paid',
                livemode: live,
                idempotencyKey: null,
                createdAt: at,
              })
              .returning();
            collectedPayouts.push(payoutFromRow(payoutRow!));
            // Live payouts mirror an 'out' activity row (matches createPayout).
            if (live) {
              await tx.insert(nbTransactions).values({
                userId: offer.sellerId,
                kind: 'out',
                status: 'confirmed',
                title: 'Payout · ' + s.email,
                subtitle: 'SENT · JUST NOW',
                amountUsd: amt.toFixed(6),
                counterparty: s.email,
                createdAt: at,
              });
            }
          }
        }

        await this.core.writeUserState(tx, offer.sellerId, sellerState);
      }

      const paymentId = randomUUID();
      const [paymentRow] = await tx
        .insert(nbPayments)
        .values({
          id: paymentId,
          offerId: offer.id,
          sellerId: offer.sellerId,
          offerTitle: offer.title,
          amountUsd: offer.amountUsd.toFixed(6),
          currency: offer.currency,
          buyerEmail: buyerEmail ?? null,
          method,
          status: 'paid',
          fulfillmentSent: false,
          livemode: offer.livemode,
          idempotencyKey: idempotencyKey ?? null,
          createdAt: at,
        })
        .returning();

      // A `subscription`-type offer creates a recurring agreement on first pay.
      if (offer.type === 'subscription') {
        const subId = randomUUID();
        const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const [subRow] = await tx
          .insert(nbSubscriptions)
          .values({
            id: subId,
            sellerId: offer.sellerId,
            offerId: offer.id,
            offerTitle: offer.title,
            buyerEmail: buyerEmail ?? null,
            amountUsd: offer.amountUsd.toFixed(6),
            currency: offer.currency,
            status: 'active',
            currentPeriodEnd: periodEnd,
            livemode: offer.livemode,
            createdAt: at,
          })
          .returning();
        subscription = subscriptionFromRow(subRow!);
      }

      // Live sales mirror ONE 'Sale ·' row for the GROSS into the activity ledger.
      if (offer.livemode) {
        const txId = randomUUID();
        const title = 'Sale · ' + offer.title;
        const subtitle =
          (method === 'demo' ? 'SANDBOX' : method === 'balance' ? 'BALANCE' : 'CARD') +
          ' · JUST NOW';
        await tx.insert(nbTransactions).values({
          id: txId,
          userId: offer.sellerId,
          kind: 'in',
          status: 'confirmed',
          title,
          subtitle,
          amountUsd: offer.amountUsd.toFixed(6),
          createdAt: at,
        });
        activity = {
          id: txId,
          n: title,
          s: subtitle,
          a: '+' + money(offer.amountUsd),
          pos: true,
          k: 'in',
          at: at.toISOString(),
        };
      }

      result = {
        payment: paymentFromRow(paymentRow!),
        sellerId: offer.sellerId,
        fulfillment: { kind: offer.fulfillmentKind, value: offer.fulfillmentValue },
        fresh: true,
        payouts: collectedPayouts,
        subscription,
      };
    });

    // After commit: invalidate cache + emit to SSE (only on a fresh live credit).
    if (result.fresh && sellerId) {
      await this.core.invalidateUser(sellerId);
      if (activity) this.core.emitActivity(sellerId, activity);
    }
    // Sprint 10 Item G — same cache/SSE flush for the buyer when their balUsd moved.
    if (result.fresh && buyerUserId) {
      await this.core.invalidateUser(buyerUserId);
      if (buyerActivity) this.core.emitActivity(buyerUserId, buyerActivity);
    }
    return result;
  }

  async listPayments(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payment[]> {
    const where =
      opts?.livemode === undefined
        ? eq(nbPayments.sellerId, u.id)
        : and(eq(nbPayments.sellerId, u.id), eq(nbPayments.livemode, opts.livemode));
    const rows = await this.db
      .select()
      .from(nbPayments)
      .where(where)
      .orderBy(desc(nbPayments.createdAt));
    return rows.map(paymentFromRow);
  }

  async payment(u: SessionUser, id: string): Promise<Payment> {
    const [row] = await this.db
      .select()
      .from(nbPayments)
      .where(and(eq(nbPayments.id, id), eq(nbPayments.sellerId, u.id)))
      .limit(1);
    if (!row) throw new Error('payment_not_found');
    return paymentFromRow(row);
  }

  /* ── Stripe Checkout sessions ── */

  async createStripeSession(input: CreateStripeSessionInput): Promise<StripeSessionRecord> {
    // Idempotent on session_id (UNIQUE) — onConflictDoNothing then re-select.
    await this.db
      .insert(nbStripeSessions)
      .values({
        sessionId: input.sessionId,
        offerId: input.offerId,
        buyerEmail: input.buyerEmail,
        amountUsd: input.amountUsd.toFixed(6),
        status: 'pending',
      })
      .onConflictDoNothing({ target: nbStripeSessions.sessionId });
    const fresh = await this.findStripeSession(input.sessionId);
    if (!fresh) throw new Error('stripe_session_persist_failed');
    return fresh;
  }

  async findStripeSession(sessionId: string): Promise<StripeSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(nbStripeSessions)
      .where(eq(nbStripeSessions.sessionId, sessionId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      offerId: row.offerId,
      buyerEmail: row.buyerEmail,
      amountUsd: n(row.amountUsd),
      status: row.status as StripeSessionRecord['status'],
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }

  async markStripeSessionCompleted(sessionId: string): Promise<StripeSessionRecord | null> {
    const prior = await this.findStripeSession(sessionId);
    if (!prior) return null;
    if (prior.status === 'completed') return prior;
    await this.db
      .update(nbStripeSessions)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(nbStripeSessions.sessionId, sessionId));
    return this.findStripeSession(sessionId);
  }

  async markStripeSessionStatus(
    sessionId: string,
    status: 'expired' | 'failed',
  ): Promise<StripeSessionRecord | null> {
    const prior = await this.findStripeSession(sessionId);
    if (!prior) return null;
    await this.db
      .update(nbStripeSessions)
      .set({ status })
      .where(eq(nbStripeSessions.sessionId, sessionId));
    return this.findStripeSession(sessionId);
  }
}

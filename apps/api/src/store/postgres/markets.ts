/**
 * PgMarkets — venue-agnostic market position storage.
 *
 * The venue adapter (lib/markets/*) places the actual order; this layer
 * just records and supports cancel/close so /positions can answer without
 * re-hitting the venue.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nbMarketPositions } from '../../db/schema/index.js';
import {
  type LifecycleEvent,
  type LifecycleTransitionInput,
  type MarketOrderCompletionInput,
  type MarketOrderInput,
  type MarketOrderReservationInput,
  type MarketOrderReservationResult,
  type MarketPosition,
  type MarketVenue,
  type SessionUser,
} from '../types.js';
import { marketPositionFromRow } from './_shared.js';
import { envelopeFromPosition } from '../../lib/lifecycle/publisher.js';
import { publishLifecycleEvent } from '../../realtime/lifecycle-bus.js';

function sameReservationIntent(position: MarketPosition, input: MarketOrderReservationInput): boolean {
  const priceStillRepresentsReservation = new Set(['pending', 'created', 'reserved', 'submitted']).has(position.status);
  const priceMatches = !priceStillRepresentsReservation
    || Math.abs(position.entryPriceUsd - input.entryPriceUsd) < 0.000001;
  return position.venue === input.venue
    && position.symbol === input.symbol
    && position.sideLong === input.sideLong
    && Math.abs(position.qtyUsd - input.qtyUsd) < 0.000001
    && priceMatches;
}

export class PgMarkets {
  constructor(private db: Db) {}

  async placeMarketOrder(u: SessionUser, input: MarketOrderInput): Promise<MarketPosition> {
    const [row] = await this.db
      .insert(nbMarketPositions)
      .values({
        userId: u.id,
        venue: input.venue,
        symbol: input.symbol,
        sideLong: input.sideLong,
        qtyUsd: input.qtyUsd.toFixed(6),
        entryPriceUsd: input.entryPriceUsd.toFixed(6),
        status: 'open',
        externalRef: input.externalRef ?? null,
        copiedFrom: input.copiedFrom ?? null,
      })
      .returning();
    return marketPositionFromRow(row!);
  }

  async reserveMarketOrder(
    u: SessionUser,
    input: MarketOrderReservationInput,
  ): Promise<MarketOrderReservationResult> {
    const [inserted] = await this.db
      .insert(nbMarketPositions)
      .values({
        userId: u.id,
        venue: input.venue,
        symbol: input.symbol,
        sideLong: input.sideLong,
        qtyUsd: input.qtyUsd.toFixed(6),
        entryPriceUsd: input.entryPriceUsd.toFixed(6),
        status: 'pending',
        externalRef: null,
        idempotencyKey: input.idempotencyKey,
        copiedFrom: input.copiedFrom ?? null,
      })
      .onConflictDoNothing({
        target: [nbMarketPositions.userId, nbMarketPositions.idempotencyKey],
      })
      .returning();

    if (inserted) return { position: marketPositionFromRow(inserted), fresh: true };

    const [prior] = await this.db
      .select()
      .from(nbMarketPositions)
      .where(and(eq(nbMarketPositions.userId, u.id), eq(nbMarketPositions.idempotencyKey, input.idempotencyKey)));
    if (!prior) throw new Error('market_order_idempotency_conflict');
    const position = marketPositionFromRow(prior);
    return {
      position,
      fresh: false,
      intentMismatch: !sameReservationIntent(position, input),
    };
  }

  async completeMarketOrder(
    positionId: string,
    input: MarketOrderCompletionInput,
  ): Promise<MarketPosition> {
    const updates: Partial<typeof nbMarketPositions.$inferInsert> = {
      qtyUsd: input.qtyUsd.toFixed(6),
      entryPriceUsd: input.entryPriceUsd.toFixed(6),
      externalRef: input.externalRef,
      status: 'open',
    };
    if (input.symbol !== undefined) updates.symbol = input.symbol;
    if (input.sideLong !== undefined) updates.sideLong = input.sideLong;

    const [row] = await this.db
      .update(nbMarketPositions)
      .set(updates)
      .where(eq(nbMarketPositions.id, positionId))
      .returning();
    if (!row) throw new Error('market_position_not_found');
    return marketPositionFromRow(row);
  }

  async failMarketOrder(positionId: string): Promise<MarketPosition | null> {
    const [row] = await this.db
      .update(nbMarketPositions)
      .set({ status: 'failed' })
      .where(eq(nbMarketPositions.id, positionId))
      .returning();
    return row ? marketPositionFromRow(row) : null;
  }

  async reduceMarketPosition(
    u: SessionUser,
    positionId: string,
    reduceQtyUsd: number,
  ): Promise<MarketPosition | null> {
    if (!(reduceQtyUsd > 0)) return null;
    // Single atomic UPDATE: ownership + reducible-status + sufficient-qty are
    // all in the WHERE, and the arithmetic runs in SQL — two concurrent sells
    // can't both pass a read-then-write check and oversell the row.
    const reduce = reduceQtyUsd.toFixed(6);
    const [row] = await this.db
      .update(nbMarketPositions)
      .set({
        qtyUsd: sql`${nbMarketPositions.qtyUsd} - ${reduce}`,
        status: sql`CASE WHEN ${nbMarketPositions.qtyUsd} - ${reduce} <= 0.000001 THEN 'closed' ELSE ${nbMarketPositions.status} END`,
      })
      .where(
        and(
          eq(nbMarketPositions.id, positionId),
          eq(nbMarketPositions.userId, u.id),
          inArray(nbMarketPositions.status, ['open', 'filled', 'partially_filled', 'resting']),
          sql`${nbMarketPositions.qtyUsd} >= ${reduce} - 0.000001`,
        ),
      )
      .returning();
    return row ? marketPositionFromRow(row) : null;
  }

  async cancelMarketOrder(u: SessionUser, externalRef: string): Promise<MarketPosition | null> {
    // Sprint 1 lifecycle: filled is terminal. `cancel_requested` is included so
    // routes that emit it before the venue call can still resolve to `closed`.
    const [row] = await this.db
      .update(nbMarketPositions)
      .set({ status: 'closed' })
      .where(
        and(
          eq(nbMarketPositions.userId, u.id),
          eq(nbMarketPositions.externalRef, externalRef),
          inArray(nbMarketPositions.status, [
            'open',
            'resting',
            'partially_filled',
            'accepted',
            'cancel_requested',
          ]),
        ),
      )
      .returning();
    return row ? marketPositionFromRow(row) : null;
  }

  async listMarketPositions(u: SessionUser, venue?: MarketVenue): Promise<MarketPosition[]> {
    const whereClause = venue
      ? and(eq(nbMarketPositions.userId, u.id), eq(nbMarketPositions.venue, venue))
      : eq(nbMarketPositions.userId, u.id);
    const rows = await this.db
      .select()
      .from(nbMarketPositions)
      .where(whereClause)
      .orderBy(desc(nbMarketPositions.createdAt));
    return rows
      .map(marketPositionFromRow)
      // Legacy 'open'/'closed' rows + lifecycle live/terminal/in-flight-cancel
      // statuses are all "real" positions to display. Drop only failed/rejected/
      // expired/pre-reservation transient states.
      .filter((p) =>
        p.status === 'open' ||
        p.status === 'closed' ||
        p.status === 'resting' ||
        p.status === 'filled' ||
        p.status === 'partially_filled' ||
        p.status === 'accepted' ||
        p.status === 'canceled' ||
        p.status === 'cancel_requested',
      );
  }

  async getMarketPositionById(positionId: string): Promise<MarketPosition | null> {
    const [row] = await this.db
      .select()
      .from(nbMarketPositions)
      .where(eq(nbMarketPositions.id, positionId));
    return row ? marketPositionFromRow(row) : null;
  }

  /**
   * Sprint 2 — order-history read. Returns EVERY row for this user (including
   * failed / rejected / transient), filtered JS-side. SQL push-down can come
   * later once we add indexes on (user_id, venue, symbol, created_at).
   */
  async listMarketOrders(
    u: SessionUser,
    filter?: {
      venue?: MarketVenue;
      symbol?: string;
      statuses?: string[];
      fromMs?: number;
      toMs?: number;
      limit?: number;
    },
  ): Promise<MarketPosition[]> {
    const whereClause = filter?.venue
      ? and(eq(nbMarketPositions.userId, u.id), eq(nbMarketPositions.venue, filter.venue))
      : eq(nbMarketPositions.userId, u.id);
    const rows = await this.db
      .select()
      .from(nbMarketPositions)
      .where(whereClause)
      .orderBy(desc(nbMarketPositions.createdAt));
    let out = rows.map(marketPositionFromRow);
    if (filter?.symbol) {
      const sym = filter.symbol.toUpperCase();
      out = out.filter((p) => p.symbol.toUpperCase() === sym);
    }
    if (filter?.statuses?.length) {
      const set = new Set<string>(filter.statuses);
      out = out.filter((p) => set.has(p.status));
    }
    if (filter?.fromMs) out = out.filter((p) => Date.parse(p.createdAt) >= filter.fromMs!);
    if (filter?.toMs) out = out.filter((p) => Date.parse(p.createdAt) <= filter.toMs!);
    if (filter?.limit && filter.limit > 0) out = out.slice(0, filter.limit);
    return out;
  }

  /**
   * Sprint 1 — append-only lifecycle transition. Updates status, sets the matching
   * timestamp, appends an audit entry to lifecycle_events, and fires the
   * in-process publisher so the realtime hub / activity ledger can fan out.
   *
   * Performed in a single UPDATE statement using PG's jsonb concat operator so
   * concurrent transitions on the same row don't lose events.
   */
  async recordLifecycleTransition(
    positionId: string,
    input: LifecycleTransitionInput,
  ): Promise<MarketPosition | null> {
    const ts = new Date();
    const event: LifecycleEvent = {
      status: input.status,
      ts: ts.toISOString(),
      externalOrderId: input.externalOrderId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      providerPayload: input.providerPayload,
    };

    // Append the new event via PG's jsonb concat operator (||). Drizzle binds the
    // JSON string as a parameter so the providerPayload payload cannot inject SQL.
    const patch: Record<string, unknown> = {
      status: input.status,
      lifecycleEvents: sql`coalesce(${nbMarketPositions.lifecycleEvents}, '[]'::jsonb) || ${JSON.stringify([event])}::jsonb`,
      updatedAt: ts,
    };
    if (input.externalOrderId !== undefined) patch.externalRef = input.externalOrderId;
    if (input.avgFillPriceUsd != null) patch.avgFillPriceUsd = input.avgFillPriceUsd.toFixed(6);
    if (input.filledQtyUsd != null) patch.filledQtyUsd = input.filledQtyUsd.toFixed(6);
    if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
    if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage;

    // Per-status timestamp shortcuts so consumers don't have to scan the audit array.
    if (input.status === 'submitted') patch.submittedAt = ts;
    if (input.status === 'accepted') patch.acceptedAt = ts;
    if (input.status === 'filled' || input.status === 'partially_filled') patch.filledAt = ts;
    if (input.status === 'canceled') patch.canceledAt = ts;
    if (input.status === 'failed' || input.status === 'rejected' || input.status === 'expired') patch.failedAt = ts;

    const [row] = await this.db
      .update(nbMarketPositions)
      .set(patch)
      .where(eq(nbMarketPositions.id, positionId))
      .returning();
    if (!row) return null;

    const position = marketPositionFromRow(row);
    publishLifecycleEvent(envelopeFromPosition(position, event, input.demo ?? false));
    return position;
  }
}

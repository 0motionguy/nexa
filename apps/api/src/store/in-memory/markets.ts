/**
 * InMemoryMarkets — Hyperliquid + Polymarket position storage.
 */

import { randomUUID } from 'node:crypto';
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
import type { InMemoryState } from '../core/in-memory-state.js';
import { nowIso } from './_shared.js';
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

export class InMemoryMarkets {
  private marketPositionsById = new Map<string, MarketPosition>();
  private marketPositionIdByIdempotencyKey = new Map<string, string>();

  constructor(private state: InMemoryState) {}

  async placeMarketOrder(u: SessionUser, input: MarketOrderInput): Promise<MarketPosition> {
    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    const pos: MarketPosition = {
      id: randomUUID(),
      userId: live.id,
      venue: input.venue,
      symbol: input.symbol,
      sideLong: input.sideLong,
      qtyUsd: input.qtyUsd,
      entryPriceUsd: input.entryPriceUsd,
      status: 'open',
      externalRef: input.externalRef ?? null,
      copiedFrom: input.copiedFrom ?? null,
      createdAt: nowIso(),
    };
    this.marketPositionsById.set(pos.id, pos);
    return pos;
  }

  async reserveMarketOrder(
    u: SessionUser,
    input: MarketOrderReservationInput,
  ): Promise<MarketOrderReservationResult> {
    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    const idemKey = `${live.id}:${input.idempotencyKey}`;
    const priorId = this.marketPositionIdByIdempotencyKey.get(idemKey);
    if (priorId) {
      const prior = this.marketPositionsById.get(priorId);
      if (!prior) throw new Error('market_order_idempotency_conflict');
      return {
        position: prior,
        fresh: false,
        intentMismatch: !sameReservationIntent(prior, input),
      };
    }
    const pos: MarketPosition = {
      id: randomUUID(),
      userId: live.id,
      venue: input.venue,
      symbol: input.symbol,
      sideLong: input.sideLong,
      qtyUsd: input.qtyUsd,
      entryPriceUsd: input.entryPriceUsd,
      status: 'pending',
      externalRef: null,
      copiedFrom: input.copiedFrom ?? null,
      createdAt: nowIso(),
    };
    this.marketPositionsById.set(pos.id, pos);
    this.marketPositionIdByIdempotencyKey.set(idemKey, pos.id);
    return { position: pos, fresh: true };
  }

  async completeMarketOrder(
    positionId: string,
    input: MarketOrderCompletionInput,
  ): Promise<MarketPosition> {
    const pos = this.marketPositionsById.get(positionId);
    if (!pos) throw new Error('market_position_not_found');
    if (input.symbol !== undefined) pos.symbol = input.symbol;
    if (input.sideLong !== undefined) pos.sideLong = input.sideLong;
    pos.qtyUsd = input.qtyUsd;
    pos.entryPriceUsd = input.entryPriceUsd;
    pos.externalRef = input.externalRef;
    pos.status = 'open';
    return pos;
  }

  async failMarketOrder(positionId: string): Promise<MarketPosition | null> {
    const pos = this.marketPositionsById.get(positionId);
    if (!pos) return null;
    pos.status = 'failed';
    return pos;
  }

  async cancelMarketOrder(u: SessionUser, externalRef: string): Promise<MarketPosition | null> {
    // Sprint 1 lifecycle: filled is terminal; only open/resting live states are cancellable.
    const liveSet = new Set(['open', 'resting', 'partially_filled', 'accepted', 'cancel_requested']);
    for (const pos of this.marketPositionsById.values()) {
      if (pos.userId !== u.id) continue;
      if (pos.externalRef !== externalRef) continue;
      if (!liveSet.has(pos.status)) return null;
      pos.status = 'closed';
      return pos;
    }
    return null;
  }

  async reduceMarketPosition(
    u: SessionUser,
    positionId: string,
    reduceQtyUsd: number,
  ): Promise<MarketPosition | null> {
    if (!(reduceQtyUsd > 0)) return null;
    const pos = this.marketPositionsById.get(positionId);
    if (!pos || pos.userId !== u.id) return null;
    // Mirror the postgres guard: only live displayable holdings are reducible.
    if (!['open', 'filled', 'partially_filled', 'resting'].includes(pos.status)) return null;
    if (pos.qtyUsd < reduceQtyUsd - 0.000001) return null;
    pos.qtyUsd = Math.max(0, pos.qtyUsd - reduceQtyUsd);
    if (pos.qtyUsd <= 0.000001) {
      pos.qtyUsd = 0;
      pos.status = 'closed';
    }
    return pos;
  }

  async listMarketPositions(u: SessionUser, venue?: MarketVenue): Promise<MarketPosition[]> {
    const liveSet = new Set([
      'open', 'closed', 'resting', 'filled', 'partially_filled', 'accepted', 'canceled', 'cancel_requested',
    ]);
    return [...this.marketPositionsById.values()]
      .filter((p) => p.userId === u.id && (venue === undefined || p.venue === venue))
      .filter((p) => liveSet.has(p.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getMarketPositionById(positionId: string): Promise<MarketPosition | null> {
    return this.marketPositionsById.get(positionId) ?? null;
  }

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
    const symUpper = filter?.symbol?.toUpperCase();
    const statusSet = filter?.statuses?.length ? new Set(filter.statuses) : null;
    let out = [...this.marketPositionsById.values()]
      .filter((p) => p.userId === u.id)
      .filter((p) => filter?.venue === undefined || p.venue === filter.venue)
      .filter((p) => symUpper === undefined || p.symbol.toUpperCase() === symUpper)
      .filter((p) => !statusSet || statusSet.has(p.status))
      .filter((p) => filter?.fromMs == null || Date.parse(p.createdAt) >= filter.fromMs)
      .filter((p) => filter?.toMs == null || Date.parse(p.createdAt) <= filter.toMs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.limit && filter.limit > 0) out = out.slice(0, filter.limit);
    return out;
  }

  async recordLifecycleTransition(
    positionId: string,
    input: LifecycleTransitionInput,
  ): Promise<MarketPosition | null> {
    const pos = this.marketPositionsById.get(positionId);
    if (!pos) return null;
    const ts = nowIso();
    const event: LifecycleEvent = {
      status: input.status,
      ts,
      externalOrderId: input.externalOrderId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      providerPayload: input.providerPayload,
    };
    pos.status = input.status;
    pos.lifecycleEvents = [...(pos.lifecycleEvents ?? []), event];
    if (input.externalOrderId !== undefined) pos.externalRef = input.externalOrderId;
    if (input.avgFillPriceUsd != null) pos.avgFillPriceUsd = input.avgFillPriceUsd;
    if (input.filledQtyUsd != null) pos.filledQtyUsd = input.filledQtyUsd;
    if (input.errorCode !== undefined) pos.errorCode = input.errorCode;
    if (input.errorMessage !== undefined) pos.errorMessage = input.errorMessage;
    if (input.status === 'submitted') pos.submittedAt = ts;
    if (input.status === 'accepted') pos.acceptedAt = ts;
    if (input.status === 'filled' || input.status === 'partially_filled') pos.filledAt = ts;
    if (input.status === 'canceled') pos.canceledAt = ts;
    if (input.status === 'failed' || input.status === 'rejected' || input.status === 'expired') {
      pos.failedAt = ts;
    }
    pos.updatedAt = ts;
    publishLifecycleEvent(envelopeFromPosition(pos, event, input.demo ?? false));
    return pos;
  }

  clearAll(): void {
    this.marketPositionsById.clear();
    this.marketPositionIdByIdempotencyKey.clear();
  }
}

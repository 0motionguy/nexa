/**
 * Platform fee tracker — records every fee NEXA attempts to collect across
 * the venues we route through. Wires the order-success paths in
 * markets.ts → metrics + structured log + an in-memory ring buffer that
 * `GET /admin/fees/summary` reads from.
 *
 * Source of truth for actual money received is the on-chain wallet balance
 * (Jupiter fee account ATA + HL builder address). This module tracks INTENT
 * — "we charged X bps on Y orders" — so the operator can spot mis-configured
 * fee accounts before settlement reveals the gap.
 *
 * Fee venues and mechanisms:
 *
 *   hyperliquid       — HL_BUILDER_ADDRESS + HYPERLIQUID_BUILDER_FEE_TENTHS_BP
 *   hyperliquid-hip3  — same builder model, trades against trade.xyz universe
 *   jupiter           — JUPITER_PLATFORM_FEE_BPS + JUPITER_PLATFORM_FEE_ACCOUNT
 *   xstocks           — settles through jupiter, same fee account
 *   polymarket        — POLYMARKET_BUILDER_FEE_BPS + POLYMARKET_BUILDER_ADDRESS
 *   hyperliquid-spot  — no native fee channel (HL spot has no builder rebate)
 *   cctp-bridge       — NEO_BRIDGE_FEE_BPS + NEO_BRIDGE_TREASURY_{ARB,POL,BASE,SOL}
 *
 * Fee values are best-effort USD; the underlying venue settles in its native
 * units and conversion is sampled at order-time.
 */

import { env } from './env.js';
import { log } from './log.js';
import { feesAttempted, feesEarnedUsd } from './metrics.js';

export type FeeVenue =
  | 'hyperliquid'
  | 'hyperliquid-spot'
  | 'hyperliquid-hip3'
  | 'jupiter'
  | 'xstocks'
  | 'polymarket'
  | 'cctp-bridge';

export type FeeKind = 'builder' | 'platform' | 'spread';

export interface FeeEvent {
  at: string;
  userId: string | null;
  venue: FeeVenue;
  kind: FeeKind;
  /** Notional USD of the order — the base we charged a rate against. */
  notionalUsd: number;
  /** Rate we attempted to charge, in basis points (50 = 0.50%). */
  rateBps: number;
  /** Computed fee USD = notionalUsd * rateBps / 10_000. */
  feeUsd: number;
  /** Optional symbol/coin/mint for tracing. */
  symbol?: string;
  /** Did the venue accept the fee instruction (best-effort). */
  attempted: boolean;
}

/**
 * Bounded in-memory ring buffer of the most recent N fee events. Read by
 * `GET /admin/fees/summary`. Persists across requests but resets on
 * process restart — Prometheus is the durable counter.
 */
const RING_CAP = 1000;
const ring: FeeEvent[] = [];

function push(ev: FeeEvent): void {
  ring.push(ev);
  if (ring.length > RING_CAP) ring.shift();
}

/**
 * Record an attempted/collected fee from an order. Idempotent in counters
 * (Prometheus is monotonic). Safe to call from any order success path —
 * never throws.
 */
export function recordFee(input: {
  userId: string | null;
  venue: FeeVenue;
  kind: FeeKind;
  notionalUsd: number;
  rateBps: number;
  symbol?: string;
  attempted?: boolean;
}): FeeEvent {
  const rawRate = Number(input.rateBps);
  const rateBps = Number.isFinite(rawRate) ? Math.max(0, rawRate) : 0;
  const notionalUsd = Math.max(0, Number(input.notionalUsd) || 0);
  const feeUsd = Math.round((notionalUsd * rateBps) / 10_000 * 1_000_000) / 1_000_000;
  const ev: FeeEvent = {
    at: new Date().toISOString(),
    userId: input.userId,
    venue: input.venue,
    kind: input.kind,
    notionalUsd,
    rateBps,
    feeUsd,
    symbol: input.symbol,
    attempted: input.attempted !== false,
  };
  push(ev);
  try {
    if (ev.attempted) {
      feesAttempted.inc({ venue: ev.venue, kind: ev.kind });
      if (ev.feeUsd > 0) feesEarnedUsd.inc({ venue: ev.venue, kind: ev.kind }, ev.feeUsd);
    }
    log.info(
      {
        userId: ev.userId,
        venue: ev.venue,
        kind: ev.kind,
        notionalUsd: ev.notionalUsd,
        rateBps: ev.rateBps,
        feeUsd: ev.feeUsd,
        symbol: ev.symbol,
      },
      'fee.recorded',
    );
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'fee.record failed');
  }
  return ev;
}

/** Aggregate snapshot for `/admin/fees/summary`. */
export interface FeeSummary {
  windowFrom: string | null;
  windowTo: string;
  byVenue: Record<string, { feeUsd: number; orderCount: number; notionalUsd: number }>;
  totalFeeUsd: number;
  totalNotionalUsd: number;
  recent: FeeEvent[];
  config: {
    hyperliquidBuilderBps: number;
    polymarketBuilderBps: number;
    jupiterPlatformBps: number;
    jupiterFeeAccountConfigured: boolean;
  };
}

/**
 * Aggregate the in-memory ring into a venue-keyed snapshot. Bounded by
 * `limit` for the recent slice. Window is bounded by the buffer; for
 * historical analysis query Prometheus directly.
 */
export function summarizeFees(limit = 50): FeeSummary {
  const byVenue: Record<string, { feeUsd: number; orderCount: number; notionalUsd: number }> = {};
  let totalFeeUsd = 0;
  let totalNotionalUsd = 0;
  const collected = ring.filter((ev) => ev.attempted);
  for (const ev of collected) {
    const slot = (byVenue[ev.venue] ??= { feeUsd: 0, orderCount: 0, notionalUsd: 0 });
    slot.feeUsd += ev.feeUsd;
    slot.orderCount += 1;
    slot.notionalUsd += ev.notionalUsd;
    totalFeeUsd += ev.feeUsd;
    totalNotionalUsd += ev.notionalUsd;
  }
  const tenths = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0;
  return {
    windowFrom: collected[0]?.at ?? null,
    windowTo: new Date().toISOString(),
    byVenue,
    totalFeeUsd: Math.round(totalFeeUsd * 1_000_000) / 1_000_000,
    totalNotionalUsd: Math.round(totalNotionalUsd * 100) / 100,
    recent: collected.slice(-limit).reverse(),
    config: {
      hyperliquidBuilderBps: tenths / 10,
      polymarketBuilderBps: env.POLYMARKET_BUILDER_FEE_BPS ?? 0,
      jupiterPlatformBps: env.JUPITER_PLATFORM_FEE_BPS ?? 0,
      jupiterFeeAccountConfigured: Boolean(env.JUPITER_PLATFORM_FEE_ACCOUNT),
    },
  };
}

/**
 * Configured fee rate for a given venue, in basis points. Used by the
 * order-success paths to know what rate to record.
 */
export function configuredRateBps(venue: FeeVenue): { kind: FeeKind; bps: number } {
  switch (venue) {
    case 'hyperliquid':
    case 'hyperliquid-hip3': {
      const tenths = env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? 0;
      return { kind: 'builder', bps: tenths / 10 };
    }
    case 'jupiter':
    case 'xstocks':
      return { kind: 'platform', bps: env.JUPITER_PLATFORM_FEE_BPS ?? 0 };
    case 'polymarket':
      return { kind: 'builder', bps: env.POLYMARKET_BUILDER_FEE_BPS ?? 0 };
    case 'hyperliquid-spot':
      return { kind: 'spread', bps: 0 };
    case 'cctp-bridge':
      return { kind: 'spread', bps: env.NEO_BRIDGE_FEE_BPS ?? 0 };
  }
}

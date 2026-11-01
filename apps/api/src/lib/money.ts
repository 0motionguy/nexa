/**
 * Money math helpers — extracted from store/postgres.ts so the pure helpers
 * in lib/offers, lib/campaigns, and downstream callers don't need to import
 * from the store layer (which would create a dependency cycle).
 *
 * Convention: dollars as `number`, NOT cents. The 2-decimal rounding via
 * `round2` is the canonical cent-rounding step; storage to `numeric(18,6)`
 * happens via `.toFixed(6)` at the store boundary.
 */

/** Coerce a possibly-null/possibly-string column value to a finite number, or 0. */
export function n(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(x) ? x : 0;
}

/** Round to 2 decimals (cents). */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

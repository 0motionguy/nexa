/**
 * Region gating for live money writes — ONE source of truth shared by the
 * route-level tradeGate (routes/markets.ts) and the /me/profile per-venue
 * eligibility surface (routes/me.ts) so the gate and the UI state can never
 * drift apart.
 *
 * Policy: the block list is compliance-owned. Changing which countries are
 * blocked is a deliberate product/legal decision — never edit casually.
 * LIVE_WRITE_REGION_EXEMPT_EMAILS exists ONLY for named internal test
 * accounts; exempted trades still increment a 'region_exempt' metric at the
 * gate so every bypass stays auditable.
 */
import { env } from '../env.js';
import { polymarket } from './polymarket.js';

/** ISO-3166 alpha-2 codes where live money writes are blocked (non-Polymarket venues). */
export const LIVE_WRITE_BLOCKED_COUNTRIES: ReadonlySet<string> = new Set([
  'US', 'GB', 'DE', 'FR', 'IT', 'JP', 'SG', 'AU', 'BE', 'PL', 'RU', 'IR', 'KP',
]);

export function isLiveWriteCountryAllowed(venue: string, country: string): boolean {
  if (venue === 'polymarket') return polymarket.isRegionAllowed(country);
  return !LIVE_WRITE_BLOCKED_COUNTRIES.has(country.trim().toUpperCase());
}

/**
 * Whether this account may bypass the country block. Reads the env var
 * lazily (per call) so tests and ops can toggle it without a process
 * restart ordering problem; unset/empty → nobody is exempt.
 */
export function isRegionExemptUser(u: { email?: string | null }): boolean {
  const raw = env.LIVE_WRITE_REGION_EXEMPT_EMAILS;
  const email = u.email?.trim().toLowerCase();
  if (!raw || !email) return false;
  return raw.split(',').some((entry) => entry.trim().toLowerCase() === email);
}

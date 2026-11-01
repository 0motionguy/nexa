/**
 * OBS-01 (Sprint 17.5) — structured breadcrumbs for every external venue
 * call so the pilot has a forensic trail when a Polymarket / Marinade /
 * Mayan / Privy / Stripe round-trip fails.
 *
 * Why a wrapper instead of inline `Sentry.addBreadcrumb` calls:
 *   - One `category` convention (`venue.<provider>`) means breadcrumbs
 *     filter cleanly in Sentry's UI without per-call drift.
 *   - PII scrubbing already runs in `scrubSentryEvent`, but we also strip
 *     anything that smells like a key here as a belt-and-suspenders. A
 *     leaked secret in a breadcrumb is just as bad as one in an exception.
 *   - No-op when Sentry isn't initialized (DSN unset) so the test suite
 *     and demo deployments stay quiet.
 *
 * Call pattern:
 *   venueBreadcrumb('polymarket', 'order.submit', { tokenId, side, qty })
 *   try { … } catch (e) {
 *     venueBreadcrumb('polymarket', 'order.failed', { code: e.code })
 *     throw e
 *   }
 */

import * as Sentry from '@sentry/node';
import { isSentryInitialized } from '../sentry.js';

const SECRET_KEY_PATTERN =
  /\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]+|\bnx_(live|test)_[A-Za-z0-9_]+|[A-Za-z0-9+/]{40,}={0,2}/;

function scrubData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && SECRET_KEY_PATTERN.test(v)) {
      out[k] = '[redacted-secret]';
      continue;
    }
    // Lowercase key name guard — explicit `secret`/`password`/`token`/`key`
    // names get redacted regardless of value shape.
    const kLower = k.toLowerCase();
    if (
      kLower.includes('secret') ||
      kLower.includes('password') ||
      kLower === 'token' ||
      kLower.endsWith('apikey') ||
      kLower.endsWith('passphrase') ||
      kLower.endsWith('privatekey')
    ) {
      out[k] = '[redacted-secret]';
      continue;
    }
    out[k] = v;
  }
  return out;
}

export type VenueProvider =
  | 'hyperliquid'
  | 'polymarket'
  | 'polymarket-clob'
  | 'polymarket-relayer'
  | 'marinade'
  | 'mayan'
  | 'aave'
  | 'compound'
  | 'morpho'
  | 'yousd'
  | 'cctp'
  | 'stripe'
  | 'privy'
  | 'bridge'
  | 'sumsub';

/**
 * Append a breadcrumb under `venue.<provider>`. Safe to call even when
 * Sentry isn't initialized (no-op).
 */
export function venueBreadcrumb(
  provider: VenueProvider,
  op: string,
  data: Record<string, unknown> = {},
  level: Sentry.SeverityLevel = 'info',
): void {
  if (!isSentryInitialized()) return;
  Sentry.addBreadcrumb({
    category: `venue.${provider}`,
    message: op,
    data: scrubData(data),
    level,
    type: 'http',
  });
}

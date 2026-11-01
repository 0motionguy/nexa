/**
 * Sourced-value envelope helpers.
 *
 * Financial values carry source metadata so the frontend can render whether a
 * number is live, cached, demo-only, unavailable, or errored.
 */

import type { DataSourceKind, SourcedValueMeta } from '@nexa/shared-zod';
import { env } from './env.js';
import { ChainError } from './chain/units.js';

interface FreshnessEntry {
  fetchedAt: string;
  source: DataSourceKind;
}

const freshness = new Map<string, FreshnessEntry>();

function key(provider: string, metric: string): string {
  return `${provider.toLowerCase()}::${metric.toLowerCase()}`;
}

/** Record a successful fetch so subsequent failures can render cached state. */
export function recordFetch(
  provider: string,
  metric: string,
  source: DataSourceKind = 'live',
): string {
  const fetchedAt = new Date().toISOString();
  freshness.set(key(provider, metric), { fetchedAt, source });
  return fetchedAt;
}

export function lastFetch(provider: string, metric: string): FreshnessEntry | null {
  return freshness.get(key(provider, metric)) ?? null;
}

export function clearFreshness(): void {
  freshness.clear();
}

const DOCS_URL: Record<string, string> = {
  privy: 'https://docs.privy.io/wallets/wallets/create/create-a-wallet',
  bridge: 'https://apidocs.bridge.xyz/platform/orchestration/overview',
  sumsub: 'https://docs.sumsub.com/reference/get-started-with-api',
  stripe: 'https://docs.stripe.com/crypto/onramp',
  resend: 'https://resend.com/docs/api-reference/emails/send-email',
  circle: 'https://developers.circle.com/cctp',
  coinbase: 'https://docs.cdp.coinbase.com/x402/welcome',
  x402: 'https://docs.x402.org/introduction',
  lifi: 'https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer',
  socket: 'https://docs.socket.tech/integrate/get-api-access',
  mayan: 'https://docs.mayan.finance/',
  aave: 'https://aave.com/docs/aave-v3/overview',
  morpho: 'https://docs.morpho.org/build/earn/resources/all',
  compound: 'https://docs.compound.finance/interest-rates/',
  yousd: '',
  marinade: 'https://docs.marinade.finance/',
  hyperliquid: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes',
  polymarket: 'https://docs.polymarket.com/market-data/overview',
  'gnosis-pay': 'https://docs.gnosispay.com/',
  sponge: '',
  alchemy: 'https://www.alchemy.com/docs/wallets',
  xstocks: 'https://docs.xstocks.fi/docs',
  dinari: 'https://dinari.com/defi',
  cctp: 'https://developers.circle.com/cctp',
  onramper: 'https://docs.onramper.com/docs/widget',
  'collector-crypt': 'https://docs.collectorcrypt.com/marketplace/api',
};

function docsUrlFor(provider: string): string | undefined {
  const url = DOCS_URL[provider.toLowerCase()];
  return url || undefined;
}

/** Build metadata for a positive live result and record its fetch timestamp. */
export function liveMeta(provider: string, metric: string): SourcedValueMeta {
  const fetchedAt = recordFetch(provider, metric);
  return {
    source: 'live',
    provider,
    fetchedAt,
    docsUrl: docsUrlFor(provider),
  };
}

/** Demo-mode fallback. Never returns provider-demo outside DEMO_MODE. */
export function providerDemoMeta(provider: string, metric: string): SourcedValueMeta {
  if (!env.DEMO_MODE) {
    return unavailableMeta(provider, metric, new Error('demo path blocked outside DEMO_MODE'));
  }
  return {
    source: 'provider-demo',
    provider,
    fetchedAt: new Date().toISOString(),
    docsUrl: docsUrlFor(provider),
  };
}

/**
 * Map an adapter failure to cached-live when a recent live fetch exists,
 * otherwise unavailable.
 */
export function unavailableMeta(
  provider: string,
  metric: string,
  cause?: unknown,
  ttlSeconds = 60,
): SourcedValueMeta {
  const prior = lastFetch(provider, metric);
  const code = cause instanceof ChainError ? cause.code : undefined;
  const message =
    cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined;

  if (prior && prior.source === 'live') {
    const ageMs = Date.now() - new Date(prior.fetchedAt).getTime();
    if (ageMs < ttlSeconds * 1000) {
      return {
        source: 'cached-live',
        provider,
        fetchedAt: prior.fetchedAt,
        ttlSeconds,
        docsUrl: docsUrlFor(provider),
        errorCode: code,
        errorMessage: message,
      };
    }
  }

  return {
    source: 'unavailable',
    provider,
    fetchedAt: prior?.fetchedAt ?? null,
    docsUrl: docsUrlFor(provider),
    errorCode: code,
    errorMessage: message,
  };
}

/** Internal unexpected failure metadata. */
export function errorMeta(
  provider: string,
  metric: string,
  cause: unknown,
): SourcedValueMeta {
  const prior = lastFetch(provider, metric);
  return {
    source: 'error',
    provider,
    fetchedAt: prior?.fetchedAt ?? null,
    docsUrl: docsUrlFor(provider),
    errorCode: cause instanceof ChainError ? cause.code : 'internal_error',
    errorMessage: cause instanceof Error ? cause.message : String(cause),
  };
}

export function sourced<T>(
  value: T | null,
  meta: SourcedValueMeta,
): { value: T | null } & SourcedValueMeta {
  return { value, ...meta };
}

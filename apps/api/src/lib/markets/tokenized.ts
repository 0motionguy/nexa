/**
 * Tokenized-stocks capability detection — Sprint 15.
 *
 * The rollout prompt's hard rule: tokenized-stock support shows up in the UI
 * **only** when a provider actually returns a route. Until partner access from
 * xStocks or Dinari lands, we keep the asset class hidden and the registry
 * status pinned to `docs-only`.
 *
 * This module exposes the capability layer so future code paths can ask "can
 * we buy AAPLx today?" without scattering vendor checks. The detector caches
 * the result for `CAPABILITY_TTL_MS` to avoid pinging every render.
 *
 * When partner access lands:
 *   1. Set `XSTOCKS_API_KEY` (and/or `DINARI_API_KEY`) in `/opt/neobank/secrets/maze.env`.
 *   2. The detector switches from `unsupported` to a real capability check
 *      against the provider's quote endpoint.
 *   3. The provider registry status auto-flips from `docs-only` to `live`.
 *
 * Allowed labels per the rollout: AAPLx, TSLAx, SPYx, NVDAx (etc.). The UI
 * must NEVER say "buy Apple stock" — only "AAPLx · Tokenized exposure".
 */

import { log } from '../log.js';

export type TokenizedProvider = 'xstocks' | 'dinari' | 'none';

export interface TokenizedCapability {
  /** Which provider can currently quote the asset, or 'none' when nothing can. */
  provider: TokenizedProvider;
  /** True when the asset has been verified routable end-to-end. */
  routable: boolean;
  /** Last successful capability probe — ISO timestamp or null. */
  checkedAt: string | null;
  /** When the response was cached, regardless of result. */
  cachedAt: string | null;
  /** Reason for the most recent failure (env name, vendor error, etc.). */
  reason?: string;
}

/** Five-minute cache so the capability flag doesn't ping vendors on every UI mount. */
const CAPABILITY_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { value: TokenizedCapability; expiresAt: number }>();

function key(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Drop the cache — handy for tests + cron-driven capability invalidation. */
export function clearTokenizedCache(): void {
  cache.clear();
}

/** Read whichever capability is currently cached without firing a fresh probe. */
export function peekTokenizedCapability(symbol: string): TokenizedCapability | null {
  const hit = cache.get(key(symbol));
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) return null;
  return hit.value;
}

/**
 * Capability probe. Today, returns `unsupported` for every symbol because no
 * tokenized-stocks provider is wired. When `XSTOCKS_API_KEY` or
 * `DINARI_API_KEY` is set, swap the implementation here to call the provider's
 * quote endpoint and assert it returns a route for the asked symbol.
 *
 * The contract: return a TokenizedCapability. Callers (routes / UI) decide
 * how to react — typically the route returns 503 unsupported and the UI hides
 * the asset class.
 */
export async function detectTokenizedCapability(
  symbol: string,
): Promise<TokenizedCapability> {
  const k = key(symbol);
  const cached = cache.get(k);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const xstocksKey = process.env['XSTOCKS_API_KEY'];
  const dinariKey = process.env['DINARI_API_KEY'];

  let value: TokenizedCapability;
  if (xstocksKey) {
    value = await probeXstocks(symbol, xstocksKey).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), symbol: k },
        'tokenized: xstocks probe failed',
      );
      return {
        provider: 'xstocks' as const,
        routable: false,
        checkedAt: null,
        cachedAt: new Date(now).toISOString(),
        reason: 'xstocks_probe_failed',
      };
    });
  } else if (dinariKey) {
    value = await probeDinari(symbol, dinariKey).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), symbol: k },
        'tokenized: dinari probe failed',
      );
      return {
        provider: 'dinari' as const,
        routable: false,
        checkedAt: null,
        cachedAt: new Date(now).toISOString(),
        reason: 'dinari_probe_failed',
      };
    });
  } else {
    value = {
      provider: 'none',
      routable: false,
      checkedAt: null,
      cachedAt: new Date(now).toISOString(),
      reason: 'no_provider_keys_configured',
    };
  }

  cache.set(k, { value, expiresAt: now + CAPABILITY_TTL_MS });
  return value;
}

/**
 * Shape-only xStocks probe — wired to throw `not_implemented` until partner
 * access lands. When the access form is approved:
 *   1. Replace with `fetch(${baseUrl}/quote?symbol=...)`
 *   2. Parse the response and return `{ provider: 'xstocks', routable: <bool>, ... }`
 *   3. Add a unit test under `tokenized.spec.ts` that mocks fetch
 */
async function probeXstocks(_symbol: string, _apiKey: string): Promise<TokenizedCapability> {
  // Intentional placeholder — never reached today because XSTOCKS_API_KEY is
  // expected to remain unset. This keeps the code path live-ready without
  // claiming live support.
  throw new Error('xstocks probe not implemented — awaiting partner access');
}

/**
 * Shape-only Dinari probe — same shape as xStocks. Replace with a real fetch
 * call once Dinari API keys are issued.
 */
async function probeDinari(_symbol: string, _apiKey: string): Promise<TokenizedCapability> {
  throw new Error('dinari probe not implemented — awaiting partner access');
}

/**
 * Bulk capability check — handy when the UI wants to know which of a list of
 * symbols are routable so it can render only the supported ones.
 */
export async function detectTokenizedCapabilities(
  symbols: string[],
): Promise<Record<string, TokenizedCapability>> {
  const entries = await Promise.all(
    symbols.map(async (s) => [s, await detectTokenizedCapability(s)] as const),
  );
  return Object.fromEntries(entries);
}

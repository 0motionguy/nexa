/**
 * Hyperliquid shared config — single source of truth for the API endpoints
 * and the geo blocklist.
 *
 * Before 2026-07-08 the blocklist literal was duplicated in three adapters
 * (perps / spot / HIP-3) and every URL was a per-file hardcode, which made a
 * testnet run impossible and let the three lists drift silently. Adapters now
 * import from here; the exported per-venue predicate names are preserved at
 * their original call sites.
 *
 * URLs honor env overrides so a testnet deploy is a config change, not a
 * code change:
 *   HL_API_BASE_URL  (default https://api.hyperliquid.xyz)
 *   HL_WS_URL        (default wss://api.hyperliquid.xyz/ws)
 * NOTE: pointing these at testnet also requires the signing constants
 * (hyperliquidChain 'Testnet') — see hl-signer.ts before flipping.
 */

function baseUrl(): string {
  const raw = process.env['HL_API_BASE_URL']?.trim();
  return raw ? raw.replace(/\/$/, '') : 'https://api.hyperliquid.xyz';
}

export const HL_INFO_URL = `${baseUrl()}/info`;
export const HL_EXCHANGE_URL = `${baseUrl()}/exchange`;
export const HL_WS_URL = process.env['HL_WS_URL']?.trim() || 'wss://api.hyperliquid.xyz/ws';

/**
 * Geo blocklist for every Hyperliquid venue (perps, spot, HIP-3 — same ToS).
 * US is the canonical blocker; we mirror the broader Polymarket list so the
 * markets surface gates from one source of truth.
 */
export const HL_BLOCKED: ReadonlySet<string> = new Set([
  'US', 'GB', 'DE', 'FR', 'IT', 'JP', 'SG', 'AU', 'BE', 'PL', 'RU', 'IR', 'KP',
]);

export function isHlRegionAllowed(country: string | null): boolean {
  if (!country) return true;
  return !HL_BLOCKED.has(country.trim().toUpperCase());
}

/**
 * The Hyperliquid EIP-712 signatureChainId for user-signed actions. The SDK
 * standardised on `0x66eee` (421614, Arbitrum Sepolia) for both mainnet and
 * testnet — the actual L1 chain is separate. Lives here (config) so signing
 * and agent modules can share it without an import cycle; hl-signer
 * re-exports for existing call sites.
 */
export const HL_USER_SIGN_CHAIN_ID: `0x${string}` = '0x66eee';

/** Hyperliquid chain label used in user-signed actions. */
export const HL_HYPERLIQUID_CHAIN = 'Mainnet' as const;

/**
 * Polymarket CLOB L2 authentication — L1 EIP-712 derive flow + L2 HMAC headers.
 *
 * The Polymarket CLOB requires *per-user* L2 credentials (apiKey/secret/passphrase)
 * derived from an L1 EIP-712 signature on the user's wallet. Once derived, the
 * triple is persisted on `nb_users` and used to HMAC every order/cancel request.
 *
 * Spec sources (verified 2026-06-19):
 *   - docs.polymarket.com/developers/CLOB/authentication
 *   - github.com/Polymarket/clob-client (signing/eip712, signing/constants,
 *     signing/hmac, endpoints)
 *
 * Why we don't just import `@polymarket/clob-client` directly:
 *   - The SDK ships an ethers.js Signer adapter; Privy server-wallet signing is
 *     async over an HTTP API and doesn't fit the synchronous-ish Signer shape.
 *     Reimplementing the L1 derive + L2 HMAC by hand (both are ~30 lines each)
 *     is cleaner than building a Signer shim, and gives us full control of the
 *     auth surface for Sentry breadcrumbs + replay-safety.
 *   - The SDK depends on viem^2.46.3; our root pin is 2.21.55. Bundling two
 *     viem majors complicates tree-shaking.
 *
 * Identity (2026-07-06, live-proven): every order authenticates + signs with
 * the EOA. The CLOB binds creds to POLY_ADDRESS = the SIGNER's address, and it
 * REFUSES to issue creds for a contract wallet (`/auth/api-key` with
 * POLY_ADDRESS=deposit-wallet → 401 "Invalid L1 Request headers"). So there is
 * no such thing as wallet-bound creds. For the Builder Program deposit-wallet
 * lane the order rides signatureType=3 (POLY_1271) + funderAddress=wallet:
 * clob-client-v2 stamps the order's `signer` field with the wallet (maker) and
 * the exchange validates the EOA's signature via the wallet's EIP-1271 owner
 * check. Live probe: a France GTC posted `status:"live" success:true` with
 * exactly EOA-signer + EOA-creds + sigType 3 + wallet funder, then cancelled
 * clean (docs/probes). sigType 2 with the same wallet is rejected "maker
 * address not allowed" — 3 is the only accepted type.
 */

import { createHmac } from 'node:crypto';
import { log } from '../log.js';
import { signTypedDataWithPrivy } from '../privy.js';
import { venueBreadcrumb } from '../observability/venue-breadcrumb.js';
import { ProviderRateLimitError, throwIfProviderRateLimited } from './provider-errors.js';
import type { SignatureTypeV2 } from '@polymarket/clob-client-v2';

const CLOB_HOST = 'https://clob.polymarket.com';
/** Polygon mainnet. The CLOB exchange contract lives here. */
const POLY_CHAIN_ID = 137;
/** Canonical L1 derive message — Polymarket constant `MSG_TO_SIGN`. */
const MSG_TO_SIGN = 'This message attests that I control the given wallet';

export interface PmClobCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface PmClobSubmitResult {
  orderId: string;
  status: string | null;
}

type TypedDataTypes = Record<string, Array<{ name: string; type: string }>>;

interface EthersTypedDataSigner {
  _signTypedData(
    domain: Record<string, unknown>,
    types: TypedDataTypes,
    value: Record<string, unknown>,
  ): Promise<string>;
  getAddress(): Promise<string>;
}

interface L1AuthHeaders {
  POLY_ADDRESS: string;
  POLY_SIGNATURE: string;
  POLY_TIMESTAMP: string;
  POLY_NONCE: string;
}

/**
 * Build the L1 EIP-712 signature + headers required by `/auth/api-key` and
 * `/auth/derive-api-key`. Returns null if Privy signing fails (e.g. demo mode
 * or wallet not yet provisioned).
 */
async function buildL1Headers(
  privyWalletId: string,
  address: string,
): Promise<L1AuthHeaders | null> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = '0';
  const typedData = {
    domain: { name: 'ClobAuthDomain', version: '1', chainId: POLY_CHAIN_ID },
    types: {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    },
    primaryType: 'ClobAuth',
    message: { address, timestamp, nonce, message: MSG_TO_SIGN },
  } as const;
  const signature = await signTypedDataWithPrivy(privyWalletId, typedData);
  if (!signature) return null;
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce,
  };
}

/**
 * Per-identity in-process mutex for the derive flow. Two parallel order POSTs
 * from the same user would each call `deriveL2Credentials` → two Privy
 * signing round-trips + a race on `setPmClobCredentials`. We coalesce both
 * into a single inflight promise. Cleared on settlement so a later request
 * can re-derive after rotation.
 *
 * Keyed by walletId AND address (2026-07-06): one Privy wallet now derives
 * creds for TWO identities — the EOA (legacy lanes) and the deposit wallet
 * (builder lane). Keying by walletId alone would hand the second caller the
 * FIRST identity's creds mid-flight.
 *
 * Audit 2026-06-19 — fix for code-review #3.
 */
const inflightDerives = new Map<string, Promise<PmClobCreds | null>>();

/**
 * Derive a user's CLOB L2 credentials. Tries `create-api-key` (POST) first;
 * falls back to `derive-api-key` (GET) when the key already exists for this
 * wallet. Either path returns `{ apiKey, secret, passphrase }`.
 *
 * The caller is responsible for persisting the result (we don't reach into
 * the store from here to keep this adapter pure).
 */
export async function deriveL2Credentials(
  privyWalletId: string,
  address: string,
): Promise<PmClobCreds | null> {
  const inflightKey = `${privyWalletId}:${address.toLowerCase()}`;
  const existing = inflightDerives.get(inflightKey);
  if (existing) return existing;
  const promise = (async (): Promise<PmClobCreds | null> => {
    const headers = await buildL1Headers(privyWalletId, address);
    if (!headers) {
      log.warn({ address }, 'polymarket: L1 sig unavailable (Privy demo or wallet missing)');
      return null;
    }
    const httpHeaders = { 'content-type': 'application/json', ...headers };
    // Try create first — succeeds on first run, 4xx if key exists.
    let creds = await fetchCreds(`${CLOB_HOST}/auth/api-key`, 'POST', httpHeaders);
    if (creds) return creds;
    // Existing key: derive returns it.
    creds = await fetchCreds(`${CLOB_HOST}/auth/derive-api-key`, 'GET', httpHeaders);
    return creds;
  })();
  inflightDerives.set(inflightKey, promise);
  // Clear inflight entry regardless of outcome so a later request can
  // re-derive (e.g. after rotation).
  promise.finally(() => {
    if (inflightDerives.get(inflightKey) === promise) {
      inflightDerives.delete(inflightKey);
    }
  });
  return promise;
}

async function fetchCreds(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
): Promise<PmClobCreds | null> {
  const endpoint = url.replace(CLOB_HOST, '');
  venueBreadcrumb('polymarket-clob', 'derive.request', { method, endpoint });
  try {
    const res = await fetch(url, { method, headers });
    venueBreadcrumb('polymarket-clob', 'derive.response', {
      method,
      endpoint,
      status: res.status,
    });
    if (!res.ok) {
      throwIfProviderRateLimited(res, 'polymarket-clob');
      return null;
    }
    const body = (await res.json().catch(() => null)) as
      | { apiKey?: string; secret?: string; passphrase?: string }
      | null;
    if (!body || !body.apiKey || !body.secret || !body.passphrase) return null;
    return { key: body.apiKey, secret: body.secret, passphrase: body.passphrase };
  } catch (e) {
    if (e instanceof ProviderRateLimitError) throw e;
    venueBreadcrumb(
      'polymarket-clob',
      'derive.error',
      { method, endpoint, err: e instanceof Error ? e.message : String(e) },
      'warning',
    );
    log.warn(
      { err: e instanceof Error ? e.message : String(e), url },
      'polymarket: derive fetch failed',
    );
    return null;
  }
}

/**
 * Build the five L2 auth headers (POLY_ADDRESS / POLY_SIGNATURE /
 * POLY_TIMESTAMP / POLY_API_KEY / POLY_PASSPHRASE) for an authenticated CLOB
 * request. The signature is HMAC-SHA256 over `timestamp + method + path + body`
 * keyed by the base64-decoded secret, output as base64url.
 */
export function buildL2Headers(
  creds: PmClobCreds,
  address: string,
  method: string,
  requestPath: string,
  body?: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + requestPath + (body ?? '');
  const keyData = Buffer.from(creds.secret, 'base64');
  const sigB64 = createHmac('sha256', keyData).update(message).digest('base64');
  // base64url: + → -, / → _, keep `=` padding (Polymarket spec).
  const signature = sigB64.replace(/\+/g, '-').replace(/\//g, '_');
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

/**
 * Optional helper for routes: GET /fee-rate?market=<conditionId> returns the
 * relayer's required feeRateBps for the market. Default fallback is 10 (0.1%),
 * Polymarket's standard for binary markets — set this on the Order struct's
 * `feeRateBps` field. Returns null on any failure; callers should use 10.
 */
export async function fetchMarketFeeRateBps(conditionId: string): Promise<number | null> {
  try {
    const url = `${CLOB_HOST}/fee-rate?market=${encodeURIComponent(conditionId)}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { feeRateBps?: number } | null;
    if (!body || typeof body.feeRateBps !== 'number') return null;
    return Math.round(body.feeRateBps);
  } catch {
    return null;
  }
}

function primaryTypeOf(types: TypedDataTypes): string {
  if (types['TypedDataSign']) return 'TypedDataSign';
  if (types['Order']) return 'Order';
  return Object.keys(types).find((k) => k !== 'EIP712Domain') ?? 'Order';
}

function privyClobSigner(walletId: string, address: `0x${string}`): EthersTypedDataSigner {
  return {
    async getAddress(): Promise<string> {
      return address;
    },
    async _signTypedData(domain, types, value): Promise<string> {
      const sig = await signTypedDataWithPrivy(walletId, {
        domain,
        types,
        primaryType: primaryTypeOf(types),
        message: value,
      } as never);
      if (!sig) throw new Error('polymarket_order_signature_unavailable');
      return sig;
    },
  };
}

function rejectReason(res: unknown): string {
  const body = res as { errorMsg?: unknown; error?: unknown; status?: unknown };
  const reason = body.errorMsg ?? body.error ?? body.status ?? 'unknown';
  return String(reason).slice(0, 120);
}

function statusFromUnknown(value: unknown): number | null {
  const body = value as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  const raw = body?.statusCode ?? body?.status ?? body?.response?.status;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function retryAfterFromUnknown(value: unknown): string | null {
  const body = value as {
    headers?: { get?: (name: string) => string | null } | Record<string, unknown>;
    response?: { headers?: { get?: (name: string) => string | null } | Record<string, unknown> };
  } | null;
  const headers = body?.response?.headers ?? body?.headers;
  if (!headers) return null;
  const getter = (headers as { get?: (name: string) => string | null }).get;
  if (typeof getter === 'function') {
    return getter.call(headers, 'Retry-After') ?? getter.call(headers, 'retry-after');
  }
  const record = headers as Record<string, unknown>;
  const raw = record['retry-after'] ?? record['Retry-After'];
  return typeof raw === 'string' ? raw : null;
}

function normalizeClobRateLimit(value: unknown): ProviderRateLimitError | null {
  if (value instanceof ProviderRateLimitError) return value;
  if (statusFromUnknown(value) === 429) {
    return new ProviderRateLimitError('polymarket-clob', retryAfterFromUnknown(value));
  }
  return null;
}

/**
 * Deposit-wallet funder override — OFF unless both envs are set.
 *
 * 2026-07-05: the CLOB rejects bare-EOA makers ("maker address not allowed,
 * please use the deposit wallet flow" — captured live in
 * docs/probes/auth-market-actions-2026-07-04.authenticated.json).
 *
 * 2026-07-06: the deposit-wallet lane is now FIRST-CLASS — pm-relayer's
 * getBuilderLaneFunder resolves signatureType=3 (POLY_1271) + the
 * relayer-deployed deposit wallet; the order keeps EOA signer + EOA creds and
 * clob-client-v2 handles maker=wallet via funderAddress (see the identity
 * block at the top of this file). This env override remains an operator
 * escape hatch for pinning a specific funder. Half-configured or malformed
 * env throws rather than silently ordering under the wrong identity.
 */
export function clobFunderOverride(): { signatureType: SignatureTypeV2; funderAddress: `0x${string}` } | null {
  const address = process.env.PM_CLOB_FUNDER_ADDRESS ?? '';
  const rawType = process.env.PM_CLOB_SIGNATURE_TYPE ?? '';
  if (!address && !rawType) return null;
  const signatureType = Number(rawType);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !Number.isInteger(signatureType) || signatureType < 1 || signatureType > 3) {
    throw new Error('polymarket_funder_misconfigured');
  }
  return { signatureType: signatureType as SignatureTypeV2, funderAddress: address as `0x${string}` };
}

/** POLY_GNOSIS_SAFE — the EOA signs for a Gnosis Safe funder (retained for rollback/recovery). */
export const SIGNATURE_TYPE_POLY_GNOSIS_SAFE = 2 as SignatureTypeV2;

/**
 * POLY_1271 — the deposit wallet IS the maker AND the order signer; the EOA
 * produces the actual EIP-712 signature and the wallet validates it via
 * EIP-1271 (owner check). This is the Builder Program deposit-wallet lane.
 */
export const SIGNATURE_TYPE_POLY_1271 = 3 as SignatureTypeV2;

/**
 * Order identity — EOA for ALL lanes (2026-07-06, live-proven).
 *
 * The deposit-wallet lane runs signatureType=3 (POLY_1271) with
 * funderAddress = the relayer-deployed deposit wallet, but the order stays
 * SIGNED BY THE EOA and authenticated with the EOA's L2 creds. Live probe on
 * prod (docs/probes): a France GTC posted `status:"live" success:true` with
 * exactly this config (EOA signer + EOA creds + sigType 3 + wallet funder),
 * then cancelled clean. clob-client-v2 sets the order's `signer` field to the
 * wallet (maker) for POLY_1271 and the CLOB validates it via the wallet's
 * EIP-1271 owner check against the EOA signature — no wallet-bound creds
 * needed (the CLOB refuses to issue them: `/auth/api-key` with
 * POLY_ADDRESS=wallet returns 401 "Invalid L1 Request headers"). sigType 2
 * with the same wallet is rejected "maker address not allowed" — 3 is the
 * only accepted type. So: never swap identity; the lane options
 * (buildClobLaneOptions) carry sigType + funder + builderCode.
 */

export function _resetPmClobCachesForTests(): void {
  inflightDerives.clear();
}

/**
 * Per-order lane override (Builder Program): when the caller has resolved a
 * trade-ready per-user deposit wallet (pm-relayer.getBuilderLaneFunder), the
 * order rides signatureType=3 (POLY_1271) with funderAddress = the deposit
 * wallet. The order stays SIGNED by the EOA with EOA-bound creds; the wallet
 * is only the maker/funder and validates the EOA signature via EIP-1271 (see
 * the identity block at the top of this file — live-proven). Orders carry our
 * builderCode — clob-client-v2 merges it into the signed order for attribution
 * + builder fees. Precedence: explicit lane > env clobFunderOverride() > none,
 * so existing lanes keep byte-identical client options until a lane engages.
 */
export interface ClobLane {
  signatureType: SignatureTypeV2;
  funderAddress: `0x${string}`;
  /** bytes32 builder code (POLYMARKET_BUILDER_CODE) — omitted → no attribution. */
  builderCode?: string | null;
}

export function buildClobLaneOptions(lane?: ClobLane | null): {
  signatureType?: SignatureTypeV2;
  funderAddress?: `0x${string}`;
  builderConfig?: { builderCode: string };
} {
  if (lane) {
    return {
      signatureType: lane.signatureType,
      funderAddress: lane.funderAddress,
      ...(lane.builderCode ? { builderConfig: { builderCode: lane.builderCode } } : {}),
    };
  }
  const envFunder = clobFunderOverride();
  return envFunder
    ? { signatureType: envFunder.signatureType, funderAddress: envFunder.funderAddress }
    : {};
}

export async function submitClobLimitBuyOrder(args: {
  privyWalletId: string;
  privyWalletAddress: `0x${string}`;
  creds: PmClobCreds;
  tokenId: string;
  priceCents: number;
  qtyUsd: number;
  /** Builder-lane override — see buildClobLaneOptions precedence. */
  lane?: ClobLane | null;
}): Promise<PmClobSubmitResult> {
  const price = args.priceCents / 100;
  if (!(price > 0 && args.qtyUsd > 0)) throw new Error('polymarket_invalid_order_amount');

  const { Chain, ClobClient, OrderType, Side } = await import('@polymarket/clob-client-v2');
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: privyClobSigner(args.privyWalletId, args.privyWalletAddress),
    creds: args.creds,
    throwOnError: false,
    ...buildClobLaneOptions(args.lane),
  });
  let res: { success?: boolean; orderID?: string; status?: string };
  try {
    res = await client.createAndPostOrder(
      {
        tokenID: args.tokenId,
        price,
        size: args.qtyUsd / price,
        side: Side.BUY,
      },
      { tickSize: '0.01' },
      OrderType.GTC,
    ) as { success?: boolean; orderID?: string; status?: string };
  } catch (e) {
    const rateLimit = normalizeClobRateLimit(e);
    if (rateLimit) throw rateLimit;
    throw e;
  }
  const rateLimit = normalizeClobRateLimit(res);
  if (rateLimit) throw rateLimit;

  if (res.success !== true || !res.orderID) {
    throw new Error(`polymarket_order_rejected:${rejectReason(res)}`);
  }
  return { orderId: res.orderID, status: res.status ?? null };
}

/**
 * Sell-side twin of `submitClobLimitBuyOrder` (competitor sprint Lane A).
 * Size is SHARE-denominated: sells dispose of outcome tokens the wallet
 * already holds, so the caller passes the share count (position qtyUsd /
 * entryPriceUsd), never a USD notional — the CLOB would misinterpret it.
 */
export async function submitClobLimitSellOrder(args: {
  privyWalletId: string;
  privyWalletAddress: `0x${string}`;
  creds: PmClobCreds;
  tokenId: string;
  priceCents: number;
  sizeShares: number;
  /** Builder-lane override — see buildClobLaneOptions precedence. */
  lane?: ClobLane | null;
}): Promise<PmClobSubmitResult> {
  const price = args.priceCents / 100;
  if (!(price > 0 && args.sizeShares > 0)) throw new Error('polymarket_invalid_order_amount');

  const { Chain, ClobClient, OrderType, Side } = await import('@polymarket/clob-client-v2');
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: privyClobSigner(args.privyWalletId, args.privyWalletAddress),
    creds: args.creds,
    throwOnError: false,
    ...buildClobLaneOptions(args.lane),
  });
  let res: { success?: boolean; orderID?: string; status?: string };
  try {
    // FOK (all-or-nothing) via the market-order path, deliberately NOT a GTC
    // limit: there is no fill-detection worker yet, so a resting sell would
    // fill venue-side without the local holding ever being reduced — silent
    // portfolio drift on a money path. FOK's binary outcome matches the
    // route's reduce-on-fill logic exactly; partial/resting sells arrive
    // together with the fills worker. Per the SDK contract, `amount` on SELL
    // market orders is SHARES to sell, and a present `price` makes the FOK
    // limit-protected (never fills below it).
    res = await client.createAndPostMarketOrder(
      {
        tokenID: args.tokenId,
        price,
        amount: args.sizeShares,
        side: Side.SELL,
      },
      { tickSize: '0.01' },
      OrderType.FOK,
    ) as { success?: boolean; orderID?: string; status?: string };
  } catch (e) {
    const rateLimit = normalizeClobRateLimit(e);
    if (rateLimit) throw rateLimit;
    throw e;
  }
  const rateLimit = normalizeClobRateLimit(res);
  if (rateLimit) throw rateLimit;

  if (res.success !== true || !res.orderID) {
    throw new Error(`polymarket_order_rejected:${rejectReason(res)}`);
  }
  return { orderId: res.orderID, status: res.status ?? null };
}

export async function cancelClobOrder(args: {
  privyWalletId: string;
  privyWalletAddress: `0x${string}`;
  creds: PmClobCreds;
  orderId: string;
  /** Builder-lane override — cancel under the same identity the order used. */
  lane?: ClobLane | null;
}): Promise<void> {
  if (!args.orderId) throw new Error('polymarket_missing_order_id');
  const { Chain, ClobClient } = await import('@polymarket/clob-client-v2');
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: privyClobSigner(args.privyWalletId, args.privyWalletAddress),
    creds: args.creds,
    throwOnError: false,
    ...buildClobLaneOptions(args.lane),
  });
  let res: { success?: boolean; errorMsg?: string; error?: string };
  try {
    res = await client.cancelOrder({ orderID: args.orderId }) as { success?: boolean; errorMsg?: string; error?: string };
  } catch (e) {
    const rateLimit = normalizeClobRateLimit(e);
    if (rateLimit) throw rateLimit;
    throw e;
  }
  const rateLimit = normalizeClobRateLimit(res);
  if (rateLimit) throw rateLimit;
  if (res && (res.success === false || res.errorMsg || res.error)) {
    throw new Error(`polymarket_cancel_rejected:${rejectReason(res)}`);
  }
}

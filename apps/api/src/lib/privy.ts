/**
 * Privy server-side integration.
 *
 * When PRIVY_APP_ID + PRIVY_APP_SECRET are set, the auth flow switches to:
 *   1. Frontend calls Privy directly to start passwordless login
 *   2. Frontend receives Privy access token after user verifies code
 *   3. Frontend POSTs that token to /auth/privy-verify
 *   4. This module verifies the token and returns {did, email}
 *   5. Route exchanges that for our MAZE session JWT
 *
 * When env is empty, this module exports stubs and routes/auth.ts falls back
 * to the hardcoded 482019 demo OTP path.
 *
 * Also exposes server-wallet creation/signing for the chain layer.
 */

import { PrivyClient, type User, type WalletWithMetadata } from '@privy-io/server-auth';
import { env, features } from './env.js';
import { log } from './log.js';
import { venueBreadcrumb } from './observability/venue-breadcrumb.js';

/* ── REL-05 (Sprint 17.5) — bounded retry helper for Privy SDK calls ──────
 * Privy enforces a per-app server-wallet signing quota. The SDK rejects
 * with a generic Error wrapping the upstream HTTP status; the message
 * usually contains 'rate' / '429' / 'too many requests'. Detect those, plus
 * common transient signals (ECONNRESET, ETIMEDOUT, fetch failed), and
 * retry with capped exponential backoff plus deterministic jitter (no
 * Math.random — the harness blocks it, and a deterministic offset is fine
 * for spreading two-replica bursts).
 */
let retryJitterCounter = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryableError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message.toLowerCase();
  return (
    m.includes('rate') ||
    m.includes('429') ||
    m.includes('too many') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('fetch failed') ||
    m.includes('network')
  );
}

async function withPrivyRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fn();
      if (attempt > 0) {
        venueBreadcrumb('privy', `${label}.retry.success`, { attempt: attempt + 1 });
      }
      return r;
    } catch (e) {
      lastError = e;
      if (!isRetryableError(e)) throw e;
      if (attempt === 3) break;
      // Cap backoff at 2s base; add 0–495 ms deterministic jitter.
      const baseDelay = Math.min(2 ** attempt * 250, 2000);
      const jitter = (retryJitterCounter++ % 100) * 5;
      venueBreadcrumb(
        'privy',
        `${label}.retry.backoff`,
        { attempt: attempt + 1, baseDelay, jitter },
        'warning',
      );
      log.warn(
        { label, attempt: attempt + 1, baseDelay, jitter, err: e instanceof Error ? e.message : String(e) },
        'privy: retryable error, backing off',
      );
      await sleep(baseDelay + jitter);
    }
  }
  throw lastError;
}

/** Test-only: reset the deterministic jitter counter. */
export function _resetPrivyRetryForTests(): void {
  retryJitterCounter = 0;
}

let client: PrivyClient | null = null;
if (features.privy && env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
  // Configure the authorization key so walletApi RPC can SIGN user-owned
  // wallets. Without it, every signing call 401s ("no valid authorization
  // keys") and swap/order/deposit/transfer all fail. Absent → unchanged.
  client = new PrivyClient(
    env.PRIVY_APP_ID,
    env.PRIVY_APP_SECRET,
    env.PRIVY_AUTHORIZATION_PRIVATE_KEY
      ? { walletApi: { authorizationPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY } }
      : undefined,
  );
  log.info(
    { appId: env.PRIVY_APP_ID, serverSigning: features.privyServerSigning },
    'privy: client ready',
  );
}

/** True when the server holds the Privy authorization key and can sign
    user-owned wallets. Surfaced in /system/health so trade sheets show the
    true readiness instead of failing at submit. */
export function privyServerSigningReady(): boolean {
  return client !== null && features.privyServerSigning;
}

/** Extra wallet-create options: when an authorization key id is registered,
    add it as an additionalSigner so the server can sign the new wallet while
    the user keeps ownership (session-signer model). No-op otherwise, so
    wallet creation is byte-identical when signing isn't configured. */
function serverSignerCreateOpts(): { additionalSigners: Array<{ signerId: string }> } | Record<string, never> {
  return env.PRIVY_AUTHORIZATION_KEY_ID
    ? { additionalSigners: [{ signerId: env.PRIVY_AUTHORIZATION_KEY_ID }] }
    : {};
}

export function isPrivyEnabled(): boolean {
  return client !== null;
}

export interface PrivyVerifiedUser {
  did: string;
  email: string | null;
}

type PrivyEmailSource = Pick<User, 'email'> & Partial<Pick<User, 'linkedAccounts'>>;

function extractPrivyEmail(user: PrivyEmailSource): string | null {
  const directEmail = user.email?.address;
  if (typeof directEmail === 'string' && directEmail.length > 0) return directEmail;

  const linkedAccounts = Array.isArray(user.linkedAccounts) ? user.linkedAccounts : [];
  const emailAccount = linkedAccounts.find((a) => a.type === 'email');
  const linkedEmail =
    emailAccount && 'address' in emailAccount && typeof emailAccount.address === 'string'
      ? emailAccount.address
      : null;
  return linkedEmail && linkedEmail.length > 0 ? linkedEmail : null;
}

function normalizePrivyVerificationKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PUBLIC KEY-----\s*/, '-----BEGIN PUBLIC KEY-----\n')
    .replace(/\s*-----END PUBLIC KEY-----/, '\n-----END PUBLIC KEY-----');
}

/**
 * Verify a Privy access token. Returns the user DID + linked email, or null
 * on any failure (treat as bad token — never trust caller-supplied claims).
 */
export async function verifyPrivyToken(token: string): Promise<PrivyVerifiedUser | null> {
  if (!client) return null;
  try {
    const claims = await client.verifyAuthToken(token, normalizePrivyVerificationKey(env.PRIVY_VERIFICATION_KEY));
    const did = typeof claims.userId === 'string' && claims.userId.length > 0 ? claims.userId : null;
    if (!did) {
      log.warn('privy: token verify returned no user id');
      return null;
    }

    // Fetch the user to extract the linked email.
    const user = await client.getUserById(did);
    const email = extractPrivyEmail(user);
    return { did, email };
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'privy: token verify failed');
    return null;
  }
}

/**
 * Get or create a Privy server EVM wallet for a user. Used by the chain
 * layer to sign EIP-3009 payments, EIP-712 typed data, etc.
 *
 * Sprint 16.4 — bug fix: the previous version `find(a => type==='wallet')`
 * matched the FIRST linked wallet of any chain. If the user already had a
 * Solana wallet (because Marinade/Mayan provisioned it first), this
 * function would return the Solana base58 address as `existing.address` —
 * which is NOT a valid EVM hex address and would later fail every EIP-712
 * call. Now we filter explicitly for 0x-prefixed addresses (and prefer the
 * `chainType === 'ethereum'` marker when Privy sends it). Mirrors the
 * Solana variant below.
 */
export async function getOrCreatePrivyWallet(
  privyUserId: string,
  _chain: 'base' | 'gnosis' = 'base',
): Promise<{ walletId: string; address: string } | null> {
  if (!client) return null;
  try {
    const user = await client.getUserById(privyUserId);
    const existing = user.linkedAccounts.find((a): a is WalletWithMetadata => {
      if (a.type !== 'wallet' || !('address' in a)) return false;
      const addr = (a as WalletWithMetadata).address;
      const chainType = (a as { chainType?: string }).chainType;
      // Prefer explicit `chainType === 'ethereum'`; fall back to 0x address
      // shape when older Privy responses omit the chainType marker.
      if (chainType !== undefined) return chainType === 'ethereum';
      return typeof addr === 'string' && addr.startsWith('0x') && addr.length === 42;
    });
    if (existing && 'address' in existing) {
      return { walletId: (existing as { id?: string }).id ?? 'unknown', address: existing.address };
    }
    // Create a new embedded wallet for this user. The user owns it; the server
    // authorization key is added as an additionalSigner so the backend can
    // sign on their behalf (swap/order/deposit) without holding custody.
    const created = await client.walletApi.create({
      chainType: 'ethereum',
      owner: { userId: privyUserId },
      ...serverSignerCreateOpts(),
    });
    return { walletId: created.id, address: created.address };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'privy: wallet provision failed');
    return null;
  }
}

/**
 * Get or create a Privy SOLANA server wallet for a user. Solana wallets are
 * separate accounts on the same Privy `did`. Returns null in demo mode or on
 * any failure so the caller can fall back gracefully (Marinade stake / Mayan
 * execute degrade to `wallet_unavailable` until live).
 *
 * Provenance: Privy server-wallet REST spec — `walletApi.create` accepts
 * `chainType: 'solana'` and returns `{ id, address }` for an SPL-compatible
 * address (32-byte base58). Multiple wallets per user are supported, so
 * provisioning the Solana sibling does NOT replace the existing EVM wallet.
 */
export async function getOrCreatePrivySolanaWallet(
  privyUserId: string,
): Promise<{ walletId: string; address: string } | null> {
  if (!client) return null;
  try {
    const user = await client.getUserById(privyUserId);
    // Solana addresses are base58 (no 0x prefix); ETH wallets are hex. Filter
    // existing wallets by chain type if Privy returns it; else by address shape.
    const existing = user.linkedAccounts.find((a): a is WalletWithMetadata => {
      if (a.type !== 'wallet' || !('address' in a)) return false;
      const addr = (a as WalletWithMetadata).address;
      const chainType = (a as { chainType?: string }).chainType;
      if (chainType !== undefined) return chainType === 'solana';
      return typeof addr === 'string' && !addr.startsWith('0x');
    });
    if (existing && 'address' in existing) {
      return { walletId: (existing as { id?: string }).id ?? 'unknown', address: existing.address };
    }
    const created = await client.walletApi.create({
      chainType: 'solana',
      owner: { userId: privyUserId },
      ...serverSignerCreateOpts(),
    });
    return { walletId: created.id, address: created.address };
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'privy: solana wallet provision failed');
    return null;
  }
}

/**
 * Sign a Solana transaction with a Privy server wallet. Used by Marinade
 * stake/unstake + Mayan execute. The `messageBase64` is the serialized
 * transaction message (the `message.serialize()` output, base64-encoded).
 * Returns the signature (base64) or null on failure.
 *
 * ⚠️ This uses `walletApi.solana.signMessage`, which signs `messageBase64` as
 * an ARBITRARY message — the resulting ed25519 signature does NOT verify
 * against the transaction (proven live 2026-07-04: `tx.verifySignatures()`
 * === false). Prefer `signSolanaTransactionWithPrivy` (below), which uses the
 * purpose-built `signTransaction` and produces a valid signature. Remaining
 * callers (Marinade, Mayan, admin drain, Collector-Crypt) should migrate.
 */
export async function signSolanaTxWithPrivy(
  walletId: string,
  messageBase64: string,
): Promise<string | null> {
  if (!client) return null;
  try {
    return await withPrivyRetry('signSolanaTx', async () => {
      // Privy's Solana signing surface is per-SDK-version; cast through unknown
      // since the type definitions still mark `walletApi.solana` as preview.
      const sol = (client!.walletApi as unknown as {
        solana?: { signMessage: (input: { walletId: string; message: string }) => Promise<{ signature: string }> };
      }).solana;
      if (!sol?.signMessage) {
        log.warn({ walletId }, 'privy: solana signMessage surface not available in this SDK');
        return null;
      }
      const r = await sol.signMessage({ walletId, message: messageBase64 });
      return r.signature ?? null;
    });
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'privy: signSolanaTx failed');
    return null;
  }
}

/**
 * Sign a full Solana transaction with a Privy server wallet via the
 * purpose-built `walletApi.solana.signTransaction`. Accepts a web3.js
 * `Transaction` or `VersionedTransaction`; returns the SIGNED transaction
 * (same shape, or a base64 string per SDK version) or null on failure.
 *
 * This is the CORRECT primitive: it signs the transaction itself, so the
 * signature verifies (proven live 2026-07-04 — `tx.verifySignatures()` === true,
 * vs false for the signMessage path). Callers broadcast the returned tx.
 */
export async function signSolanaTransactionWithPrivy<T>(
  walletId: string,
  transaction: T,
): Promise<T | string | null> {
  if (!client) return null;
  try {
    return await withPrivyRetry('signSolanaTransaction', async () => {
      const sol = (client!.walletApi as unknown as {
        solana?: {
          signTransaction: (input: {
            walletId: string;
            transaction: unknown;
          }) => Promise<{ signedTransaction: T | string }>;
        };
      }).solana;
      if (!sol?.signTransaction) {
        log.warn({ walletId }, 'privy: solana signTransaction surface not available in this SDK');
        return null;
      }
      const r = await sol.signTransaction({ walletId, transaction });
      return r.signedTransaction ?? null;
    });
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'privy: signSolanaTransaction failed',
    );
    return null;
  }
}

/**
 * Deep-convert BigInt leaves to decimal strings so the payload survives the
 * Privy SDK's internal JSON.stringify. EIP-712 hashing parses decimal
 * strings and bigints identically for uint/int fields, so the resulting
 * signature is unchanged. viem-driven callers (Polymarket relayer Safe
 * deploy/exec) produce bigint chainId/value/nonce fields — without this the
 * SDK throws "Do not know how to serialize a BigInt" before any request is
 * sent. Exported for tests.
 */
export function jsonSafeTypedData<T>(value: T): T {
  if (typeof value === 'bigint') return (value as bigint).toString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => jsonSafeTypedData(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafeTypedData(v);
    return out as unknown as T;
  }
  return value;
}

/** Sign EIP-712 typed data with a Privy server wallet. Used by x402 settler. */
export async function signTypedDataWithPrivy(
  walletId: string,
  typedData: Parameters<NonNullable<typeof client>['walletApi']['ethereum']['signTypedData']>[0]['typedData'],
): Promise<string | null> {
  if (!client) return null;
  try {
    return await withPrivyRetry('signTypedData', async () => {
      const result = await client!.walletApi.ethereum.signTypedData({
        walletId,
        typedData: jsonSafeTypedData(typedData),
      });
      return result.signature;
    });
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'privy: signTypedData failed');
    return null;
  }
}

/**
 * Sign a raw hash (personal_sign / secp256k1) with a Privy server wallet.
 * Used by the EIP-7702 batch executor to sign Alchemy's `wallet_prepareCalls`
 * signatureRequest (`signatureRequest.data.raw`). Returns null on any failure
 * so the executor degrades to its demo result rather than throwing.
 */
export async function signRawWithPrivy(
  walletId: string,
  hash: string,
): Promise<string | null> {
  if (!client) return null;
  try {
    return await withPrivyRetry('signRaw', async () => {
      const result = await client!.walletApi.ethereum.signMessage({
        walletId,
        message: hash,
      });
      return result.signature;
    });
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'privy: signRaw failed');
    return null;
  }
}

/**
 * Sign a 32-byte digest with a RAW secp256k1 signature (no EIP-191 prefix, no
 * re-hashing) via Privy's `walletApi.ethereum.secp256k1Sign`.
 *
 * This is the correct primitive for Alchemy's `wallet_prepareCalls`
 * signatureRequest `rawPayload` — for both the `eip7702Auth` authorization
 * (delegating the EOA to Modular Account v2) and the `personal_sign` userop
 * item, `rawPayload` is the FINAL digest to sign. Using `signMessage` here
 * fails two ways: (1) it adds the EIP-191 prefix, breaking the 7702
 * authorization (recovered authority ≠ sender), and (2) Privy interprets the
 * 0x-prefixed hash as a UTF-8 string rather than 32 bytes, so even the userop
 * signature is rejected ("Invalid account signature"). Signing `rawPayload`
 * raw sidesteps both. Verified live 2026-07-04 (Base tx 0x1fc74d74…).
 */
export async function signHashWithPrivy(
  walletId: string,
  hash: string,
): Promise<string | null> {
  if (!client) return null;
  try {
    return await withPrivyRetry('secp256k1Sign', async () => {
      const result = await client!.walletApi.ethereum.secp256k1Sign({
        walletId,
        hash: hash as `0x${string}`,
      });
      return result.signature;
    });
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e) },
      'privy: secp256k1Sign failed',
    );
    return null;
  }
}

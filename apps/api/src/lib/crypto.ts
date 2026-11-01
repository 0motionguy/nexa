/**
 * AES-256-GCM authenticated encryption for at-rest secrets.
 *
 * Use to wrap *small* sensitive values that need to land in the DB without
 * existing as plaintext on disk (Polymarket CLOB triple today; KYC artifact
 * keys, Bridge transfer credentials, future per-user signing material).
 *
 * Format: `nx1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`
 *   - `nx1` prefix lets us version the scheme without re-keying — a future
 *     `nx2` for, say, AES-256-SIV would coexist during rotation.
 *   - All three parts are unpadded base64url-safe (Buffer's default base64
 *     keeps `+` / `/` which the spec accepts; we keep them as-is for
 *     compactness — no URL passthrough).
 *
 * Key material:
 *   - `PM_CLOB_ENC_KEY` env var, base64-encoded 32 bytes.
 *   - In dev/test (NODE_ENV !== 'production'), an unset key is tolerated and
 *     encrypt/decrypt are *no-ops* (values pass through plain). This keeps
 *     the existing test suite green without forcing every CI lane to plumb
 *     a key.
 *   - In production with NODE_ENV=production, unset key throws at FIRST
 *     encrypt/decrypt call — failing closed rather than silently storing
 *     plaintext after a deploy where the env var was forgotten.
 *
 * Detection:
 *   - `decryptIfWrapped(value)` returns plaintext as-is when the prefix
 *     doesn't match — supports rolling upgrade where some rows are still
 *     plaintext (pre-migration) and some are encrypted. After the backfill
 *     completes, callers can switch to `decrypt(value)` which throws on
 *     malformed input.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const SCHEME_PREFIX = 'nx1';
const IV_LENGTH = 12; // GCM canonical IV length
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;
let cachedKeySource: 'env' | 'none' = 'none';

function loadKey(): Buffer | null {
  // Re-resolve on every call when the cache is empty — env mutations (test
  // setup) need to be picked up. Once we've successfully loaded a key, we
  // keep it for the process lifetime (rotation = process restart).
  if (cachedKey) return cachedKey;
  const raw = process.env['PM_CLOB_ENC_KEY'];
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `PM_CLOB_ENC_KEY must decode to exactly 32 bytes; got ${buf.length}. Generate via: openssl rand -base64 32`,
    );
  }
  cachedKey = buf;
  cachedKeySource = 'env';
  return cachedKey;
}

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/** Reset cached key — test-only. */
export function _resetCryptoForTests(): void {
  cachedKey = null;
  cachedKeySource = 'none';
}

/** Reports whether at-rest encryption is currently active. */
export function cryptoStatus(): { active: boolean; source: 'env' | 'none' } {
  // Touch loadKey() to populate the cache without throwing.
  try {
    loadKey();
  } catch {
    /* fall through with active=false */
  }
  return { active: cachedKey !== null, source: cachedKeySource };
}

/**
 * Encrypt a plaintext string. Returns the wrapped `nx1:…` envelope.
 *
 * In dev/test with no key configured: returns plaintext unchanged. Tests
 * that exercise the encrypted path should set PM_CLOB_ENC_KEY explicitly.
 *
 * In production with no key configured: throws — silent plaintext storage
 * is the bug this module exists to prevent.
 */
export function encrypt(plaintext: string): string {
  if (plaintext === '') return plaintext;
  const key = loadKey();
  if (!key) {
    if (isProduction()) {
      throw new Error('encrypt() called with no PM_CLOB_ENC_KEY in production');
    }
    return plaintext;
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${SCHEME_PREFIX}:${iv.toString('base64')}:${authTag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a wrapped envelope. Throws on any malformed/tampered input
 * (auth-tag mismatch). Use `decryptIfWrapped` when the row may still hold
 * legacy plaintext.
 */
export function decrypt(envelope: string): string {
  if (envelope === '') return envelope;
  if (!envelope.startsWith(`${SCHEME_PREFIX}:`)) {
    throw new Error('decrypt: envelope missing nx1 prefix');
  }
  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new Error(`decrypt: malformed envelope (expected 4 segments, got ${parts.length})`);
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = loadKey();
  if (!key) {
    throw new Error('decrypt: no PM_CLOB_ENC_KEY configured but envelope is encrypted');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LENGTH) throw new Error('decrypt: bad iv length');
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error('decrypt: bad authTag length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Best-effort decrypt: returns plaintext unchanged when the value is not
 * wrapped (legacy row); decrypts when it is. Use during the rolling
 * migration window where some rows are still plaintext from before the
 * encryption layer landed.
 *
 * Throws only when a wrapped envelope is present but the key is missing
 * (which would mean storing-encrypted-but-can't-read — operator error).
 */
export function decryptIfWrapped(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value === '') return '';
  if (!value.startsWith(`${SCHEME_PREFIX}:`)) return value;
  return decrypt(value);
}

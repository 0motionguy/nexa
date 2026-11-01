/**
 * Unit tests for crypto.ts — AES-256-GCM at-rest encryption.
 *
 * Covers:
 *  - Roundtrip in dev (no key) → no-op passthrough
 *  - Roundtrip with key → opaque envelope, decrypts back
 *  - Tamper detection (auth tag mismatch throws)
 *  - Wrong key throws on decrypt
 *  - decryptIfWrapped tolerates legacy plaintext
 *  - Production + missing key fails closed on encrypt
 *  - Envelope format guard (prefix, segment count)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  _resetCryptoForTests,
  cryptoStatus,
  decrypt,
  decryptIfWrapped,
  encrypt,
} from './crypto.js';

function setKey(): string {
  const key = randomBytes(32).toString('base64');
  process.env['PM_CLOB_ENC_KEY'] = key;
  _resetCryptoForTests();
  return key;
}

function clearKey(): void {
  delete process.env['PM_CLOB_ENC_KEY'];
  _resetCryptoForTests();
}

describe('crypto', () => {
  afterEach(() => {
    clearKey();
    delete process.env['NODE_ENV'];
  });

  describe('without key (dev/test mode)', () => {
    beforeEach(() => clearKey());

    it('encrypt is a no-op passthrough', () => {
      expect(encrypt('hello')).toBe('hello');
      expect(encrypt('')).toBe('');
    });

    it('cryptoStatus reports inactive', () => {
      expect(cryptoStatus()).toEqual({ active: false, source: 'none' });
    });

    it('decryptIfWrapped passes legacy plaintext through', () => {
      expect(decryptIfWrapped('legacy-plain-secret')).toBe('legacy-plain-secret');
      expect(decryptIfWrapped(null)).toBeNull();
      expect(decryptIfWrapped(undefined)).toBeNull();
    });

    it('decrypt throws on wrapped envelope when key is missing', () => {
      // Build an envelope while a key IS set, then drop the key.
      setKey();
      const env = encrypt('payload');
      clearKey();
      expect(() => decrypt(env)).toThrow(/no PM_CLOB_ENC_KEY/);
    });
  });

  describe('with key', () => {
    beforeEach(() => setKey());

    it('roundtrips short and long strings', () => {
      for (const plain of ['a', 'hello', 'x'.repeat(2048)]) {
        const env = encrypt(plain);
        expect(env).toMatch(/^nx1:[^:]+:[^:]+:[^:]+$/);
        // Single chars like 'a' happen to appear in random base64 output;
        // only assert non-containment for distinctive longer plaintexts.
        if (plain.length >= 5 && /[^a-zA-Z0-9+/=:]/.test(plain) === false ? plain === 'hello' : true) {
          // skip — base64 alphabet overlaps too much
        }
        expect(decrypt(env)).toBe(plain);
      }
    });

    it('ciphertext does not contain a distinctive long plaintext', () => {
      const plain = 'unique-marker-payload-XYZ@%-' + 'PAYLOAD_'.repeat(20);
      const env = encrypt(plain);
      expect(env).not.toContain(plain);
      expect(env).not.toContain('PAYLOAD_PAYLOAD_PAYLOAD_PAYLOAD_');
      expect(decrypt(env)).toBe(plain);
    });

    it('passes empty string through unchanged (no envelope)', () => {
      expect(encrypt('')).toBe('');
    });

    it('produces distinct envelopes for the same plaintext (random IV)', () => {
      const a = encrypt('repeat-me');
      const b = encrypt('repeat-me');
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe('repeat-me');
      expect(decrypt(b)).toBe('repeat-me');
    });

    it('cryptoStatus reports active + env source', () => {
      // touch a roundtrip to populate cache
      encrypt('warm');
      expect(cryptoStatus()).toEqual({ active: true, source: 'env' });
    });

    it('decryptIfWrapped decrypts wrapped values and passes plaintext through', () => {
      const env = encrypt('confidential');
      expect(decryptIfWrapped(env)).toBe('confidential');
      expect(decryptIfWrapped('legacy-plain')).toBe('legacy-plain');
    });

    it('throws on authTag tamper', () => {
      const env = encrypt('secret');
      const parts = env.split(':');
      // Flip a bit in the ciphertext segment.
      const ct = Buffer.from(parts[3]!, 'base64');
      ct[0] = ct[0]! ^ 0xff;
      const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':');
      expect(() => decrypt(tampered)).toThrow();
    });

    it('throws on wrong key', () => {
      const env = encrypt('confidential');
      setKey(); // new random key
      expect(() => decrypt(env)).toThrow();
    });

    it('throws on malformed envelope', () => {
      expect(() => decrypt('not-an-envelope')).toThrow(/nx1 prefix/);
      expect(() => decrypt('nx1:onlyonepart')).toThrow(/malformed/);
      expect(() => decrypt('nx1:bad:iv:bad-tag:bad-ct')).toThrow(/4 segments/);
    });
  });

  describe('production', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production';
    });

    it('encrypt throws when key is missing in production', () => {
      clearKey();
      expect(() => encrypt('this-cant-be-plain')).toThrow(/PM_CLOB_ENC_KEY/);
    });

    it('encrypt + decrypt work normally with key in production', () => {
      setKey();
      const env = encrypt('prod-secret');
      expect(env).toMatch(/^nx1:/);
      expect(decrypt(env)).toBe('prod-secret');
    });
  });

  it('rejects PM_CLOB_ENC_KEY that does not decode to 32 bytes', () => {
    process.env['PM_CLOB_ENC_KEY'] = Buffer.alloc(16).toString('base64');
    _resetCryptoForTests();
    expect(() => encrypt('x')).toThrow(/32 bytes/);
  });
});

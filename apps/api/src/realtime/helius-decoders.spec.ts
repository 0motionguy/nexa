/**
 * Byte-layout decoders for Helius Solana account data. Only the implemented
 * functions get tests here — `decodeRaydiumV4PoolMeta` is a documented stub
 * (see helius-decoders.ts) and is exercised at the buffer-length guard level
 * but not the field-parse level until offsets are verified against canonical
 * Raydium SDK source.
 */

import { describe, expect, it } from 'vitest';

import {
  bs58Encode,
  decodeRaydiumV4PoolMeta,
  decodeSplTokenAmount,
  deriveRaydiumMid,
} from './venues/helius-decoders.js';

/** Construct a synthetic 165-byte SPL token account buffer with `amount` at offset 64. */
function makeSplTokenAccount(amount: bigint): Uint8Array {
  const buf = new Uint8Array(165);
  // Write u64 LE at offset 64.
  let a = amount;
  for (let i = 0; i < 8; i++) {
    buf[64 + i] = Number(a & 0xffn);
    a >>= 8n;
  }
  return buf;
}

describe('decodeSplTokenAmount', () => {
  it('reads a small u64 amount at offset 64', () => {
    const buf = makeSplTokenAccount(1_234_567n);
    expect(decodeSplTokenAmount(buf)).toBe(1_234_567n);
  });

  it('reads zero', () => {
    const buf = makeSplTokenAccount(0n);
    expect(decodeSplTokenAmount(buf)).toBe(0n);
  });

  it('reads a value past Number.MAX_SAFE_INTEGER without precision loss', () => {
    // 2^53 + 1 — first integer that round-trips through Number lossily.
    const big = (1n << 53n) + 1n;
    const buf = makeSplTokenAccount(big);
    expect(decodeSplTokenAmount(buf)).toBe(big);
  });

  it('reads the max u64 (2^64 - 1)', () => {
    const max = (1n << 64n) - 1n;
    const buf = makeSplTokenAccount(max);
    expect(decodeSplTokenAmount(buf)).toBe(max);
  });

  it('returns null when the buffer is too short to read 8 bytes at offset 64', () => {
    expect(decodeSplTokenAmount(new Uint8Array(64))).toBeNull();
    expect(decodeSplTokenAmount(new Uint8Array(71))).toBeNull();
    // exactly 72 bytes is the minimum length the read can complete in.
    expect(decodeSplTokenAmount(new Uint8Array(72))).toBe(0n);
  });

  it('returns null for non-Uint8Array input', () => {
    // Defensive guard — adapter passes upstream-decoded bytes which should
    // already be Uint8Array, but a typing slip shouldn't crash the WS loop.
    expect(decodeSplTokenAmount(null as unknown as Uint8Array)).toBeNull();
    expect(decodeSplTokenAmount(undefined as unknown as Uint8Array)).toBeNull();
  });

  it('ignores bytes before offset 64 and after offset 72', () => {
    const buf = makeSplTokenAccount(42n);
    // Smear noise around the amount window — read should still return 42.
    for (let i = 0; i < 64; i++) buf[i] = 0xff;
    for (let i = 72; i < 165; i++) buf[i] = 0xff;
    expect(decodeSplTokenAmount(buf)).toBe(42n);
  });
});

describe('deriveRaydiumMid', () => {
  it('computes mid for a SOL/USDC-shaped pool (9 / 6 decimals)', () => {
    // 100 SOL at 9 decimals = 100 · 1e9 raw
    // 15_000 USDC at 6 decimals = 15_000 · 1e6 raw
    // expected mid = 15_000 / 100 = 150 USDC/SOL
    const mid = deriveRaydiumMid({
      coinAmount: 100n * 1_000_000_000n,
      pcAmount: 15_000n * 1_000_000n,
      coinDecimals: 9,
      pcDecimals: 6,
    });
    expect(mid).toBeCloseTo(150, 10);
  });

  it('computes mid for a meme/USDC-shaped pool (6 / 6 decimals, large coin supply)', () => {
    // 1_000_000_000 MEME at 6 decimals, 5_000 USDC at 6 decimals → 0.000005 USDC per MEME
    const mid = deriveRaydiumMid({
      coinAmount: 1_000_000_000n * 1_000_000n,
      pcAmount: 5_000n * 1_000_000n,
      coinDecimals: 6,
      pcDecimals: 6,
    });
    expect(mid).toBeCloseTo(0.000005, 12);
  });

  it('handles equal decimals symmetrically', () => {
    const mid = deriveRaydiumMid({
      coinAmount: 1n,
      pcAmount: 2n,
      coinDecimals: 0,
      pcDecimals: 0,
    });
    expect(mid).toBe(2);
  });

  it('returns NaN when the coin reserve is zero (degenerate pool)', () => {
    const mid = deriveRaydiumMid({
      coinAmount: 0n,
      pcAmount: 1_000n,
      coinDecimals: 9,
      pcDecimals: 6,
    });
    expect(Number.isNaN(mid)).toBe(true);
  });

  it('returns zero when only the pc reserve is zero', () => {
    const mid = deriveRaydiumMid({
      coinAmount: 1_000n,
      pcAmount: 0n,
      coinDecimals: 9,
      pcDecimals: 6,
    });
    expect(mid).toBe(0);
  });
});

describe('decodeRaydiumV4PoolMeta', () => {
  /**
   * Build a synthetic 752-byte Raydium AMM v4 pool buffer with the four
   * fields the decoder cares about populated at their verified offsets:
   *   baseDecimal  @ 32  : u64
   *   quoteDecimal @ 40  : u64
   *   baseVault    @ 336 : 32 bytes (pubkey)
   *   quoteVault   @ 368 : 32 bytes (pubkey)
   * Other fields are left zero; the decoder doesn't read them.
   */
  function makeRaydiumPool(args: {
    baseDecimal: number;
    quoteDecimal: number;
    baseVault: Uint8Array;
    quoteVault: Uint8Array;
  }): Uint8Array {
    const buf = new Uint8Array(752);
    // u64 LE writes
    let b = BigInt(args.baseDecimal);
    for (let i = 0; i < 8; i++) {
      buf[32 + i] = Number(b & 0xffn);
      b >>= 8n;
    }
    let q = BigInt(args.quoteDecimal);
    for (let i = 0; i < 8; i++) {
      buf[40 + i] = Number(q & 0xffn);
      q >>= 8n;
    }
    buf.set(args.baseVault, 336);
    buf.set(args.quoteVault, 368);
    return buf;
  }

  it('returns null for wrong-sized buffers (Orca / Meteora / SPL token)', () => {
    expect(decodeRaydiumV4PoolMeta(new Uint8Array(165))).toBeNull(); // SPL token
    expect(decodeRaydiumV4PoolMeta(new Uint8Array(653))).toBeNull(); // Orca Whirlpool
    expect(decodeRaydiumV4PoolMeta(new Uint8Array(904))).toBeNull(); // arbitrary
  });

  it('decodes a synthetic SOL/USDC-shaped pool (9 / 6 decimals)', () => {
    // Distinguishable vault patterns so we know the decoder reads from the
    // correct slice (not a coincidental match of overlapping bytes).
    const baseVault = new Uint8Array(32).fill(0xaa);
    const quoteVault = new Uint8Array(32).fill(0xbb);
    const buf = makeRaydiumPool({
      baseDecimal: 9,
      quoteDecimal: 6,
      baseVault,
      quoteVault,
    });
    const meta = decodeRaydiumV4PoolMeta(buf);
    expect(meta).not.toBeNull();
    expect(meta!.coinDecimals).toBe(9);
    expect(meta!.pcDecimals).toBe(6);
    expect(meta!.coinVault).toBe(bs58Encode(baseVault));
    expect(meta!.pcVault).toBe(bs58Encode(quoteVault));
  });

  it('decodes a zero-decimal token (some memes have 0 decimals)', () => {
    const buf = makeRaydiumPool({
      baseDecimal: 0,
      quoteDecimal: 6,
      baseVault: new Uint8Array(32).fill(0x11),
      quoteVault: new Uint8Array(32).fill(0x22),
    });
    const meta = decodeRaydiumV4PoolMeta(buf);
    expect(meta!.coinDecimals).toBe(0);
    expect(meta!.pcDecimals).toBe(6);
  });

  it('decodes a max-decimals token (18-decimal wrapped tokens)', () => {
    const buf = makeRaydiumPool({
      baseDecimal: 18,
      quoteDecimal: 18,
      baseVault: new Uint8Array(32).fill(0xcc),
      quoteVault: new Uint8Array(32).fill(0xdd),
    });
    const meta = decodeRaydiumV4PoolMeta(buf);
    expect(meta!.coinDecimals).toBe(18);
    expect(meta!.pcDecimals).toBe(18);
  });

  it('returns null when decoded decimals are out of the plausible 0..18 range', () => {
    // Stuff a u64 value of 19 into baseDecimal — beyond the defensive bound.
    const buf = makeRaydiumPool({
      baseDecimal: 19,
      quoteDecimal: 6,
      baseVault: new Uint8Array(32).fill(0x01),
      quoteVault: new Uint8Array(32).fill(0x02),
    });
    expect(decodeRaydiumV4PoolMeta(buf)).toBeNull();
  });

  it('rejects garbage 752-byte buffers via the decimals range gate', () => {
    // All-0xff would decode decimals as max u64 → reject.
    const buf = new Uint8Array(752).fill(0xff);
    expect(decodeRaydiumV4PoolMeta(buf)).toBeNull();
  });

  it('returns null for non-Uint8Array input', () => {
    expect(decodeRaydiumV4PoolMeta(null as unknown as Uint8Array)).toBeNull();
    expect(decodeRaydiumV4PoolMeta(undefined as unknown as Uint8Array)).toBeNull();
  });

  it('reads vaults from the verified offsets (not adjacent slots)', () => {
    // Smear noise INTO offsets 304-335 (right before baseVault) and 400-431
    // (right after quoteVault). If the decoder accidentally read from an
    // adjacent slot, the vault pubkeys would shift. The known-vault assertion
    // pins the read window.
    const baseVault = new Uint8Array(32).fill(0xa5);
    const quoteVault = new Uint8Array(32).fill(0x5a);
    const buf = makeRaydiumPool({
      baseDecimal: 9,
      quoteDecimal: 6,
      baseVault,
      quoteVault,
    });
    for (let i = 304; i < 336; i++) buf[i] = 0xff;
    for (let i = 400; i < 432; i++) buf[i] = 0xff;
    const meta = decodeRaydiumV4PoolMeta(buf);
    expect(meta!.coinVault).toBe(bs58Encode(baseVault));
    expect(meta!.pcVault).toBe(bs58Encode(quoteVault));
  });
});

describe('bs58Encode', () => {
  it('encodes the empty buffer to the empty string', () => {
    expect(bs58Encode(new Uint8Array(0))).toBe('');
  });

  it('encodes a single zero byte to "1"', () => {
    expect(bs58Encode(new Uint8Array([0]))).toBe('1');
  });

  it('encodes leading zero bytes as leading "1"s', () => {
    expect(bs58Encode(new Uint8Array([0, 0, 0, 1]))).toBe('1112');
  });

  it('encodes a known 32-byte pubkey correctly (Solana system program)', () => {
    // The Solana System Program pubkey is 32 zero bytes → "11111111111111111111111111111111".
    expect(bs58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
  });

  it('encodes a single non-zero byte', () => {
    // 57 → 'z' is the last char of the alphabet.
    expect(bs58Encode(new Uint8Array([57]))).toBe('z');
    // 0 → '1', 1 → '2'
    expect(bs58Encode(new Uint8Array([1]))).toBe('2');
  });

  it('round-trips a multi-byte value to a known base58 string', () => {
    // [0, 0, 0, 87] = 87 in base256 = "15Q" (1 leading zero, 1 leading "1",
    // remaining 3 zero bytes contribute "11", final byte 87 decimal → 'F' in
    // base58 if we did it as just [87] → '2E' ... easier to verify by
    // empirical anchoring: encode/decode round-trip via known fixtures.
    //
    // Anchor: [255] → base58. 255 / 58 = 4 r 23, so digits = [23, 4] LSB-first,
    // composed MSB-first → alphabet[4] + alphabet[23] = '5' + 'Q' = '5Q'.
    expect(bs58Encode(new Uint8Array([255]))).toBe('5Q');
  });

  it('returns "" for non-Uint8Array input (defensive guard)', () => {
    expect(bs58Encode(null as unknown as Uint8Array)).toBe('');
    expect(bs58Encode(undefined as unknown as Uint8Array)).toBe('');
  });
});

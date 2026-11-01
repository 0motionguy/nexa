import { describe, expect, it } from 'vitest';

import { jsonSafeTypedData } from './privy.js';

/**
 * REGRESSION — pm builder lane Safe deploy (2026-07-06). The Polymarket
 * relayer client signs EIP-712 payloads through viem, which emits bigint
 * chainId/value/nonce leaves. Privy's SDK JSON.stringifies the typed data
 * and threw "Do not know how to serialize a BigInt", so builder-setup
 * 500'd before any relayer request. jsonSafeTypedData must convert every
 * bigint leaf to its decimal string (hash-equivalent for uint/int fields)
 * while leaving all other values untouched.
 */
describe('jsonSafeTypedData', () => {
  it('converts nested bigint leaves to decimal strings (Safe-create shape)', () => {
    const typedData = {
      domain: { chainId: 137n, verifyingContract: '0xaB45c5A4B0c941F2d6215BF346B0928c0Ca9Ac70' },
      types: {
        SafeCreate: [
          { name: 'singleton', type: 'address' },
          { name: 'initializer', type: 'bytes' },
          { name: 'saltNonce', type: 'uint256' },
        ],
      },
      primaryType: 'SafeCreate',
      message: {
        singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
        initializer: '0xb63e800d',
        saltNonce: 9007199254740993n, // > Number.MAX_SAFE_INTEGER on purpose
        payment: 0n,
        nested: { values: [1n, 2n, '0xdead', 3] },
      },
    };

    const safe = jsonSafeTypedData(typedData);

    expect(safe.domain.chainId).toBe('137');
    expect(safe.message.saltNonce).toBe('9007199254740993');
    expect(safe.message.payment).toBe('0');
    expect(safe.message.nested.values).toEqual(['1', '2', '0xdead', 3]);
    // JSON round-trip must no longer throw.
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it('preserves non-bigint leaves and structure exactly', () => {
    const input = {
      a: 'text',
      b: 42,
      c: true,
      d: null,
      e: ['0xbeef', { f: 'inner' }],
    };
    expect(jsonSafeTypedData(input)).toEqual(input);
  });

  it('is a no-op pass-through for primitives', () => {
    expect(jsonSafeTypedData('0x01')).toBe('0x01');
    expect(jsonSafeTypedData(7)).toBe(7);
    expect(jsonSafeTypedData(null)).toBe(null);
    expect(jsonSafeTypedData(9n)).toBe('9');
  });
});

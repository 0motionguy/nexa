/**
 * Sprint 16.4 — tests for the Hyperliquid signing adapter.
 *
 * The adapter wraps the @nktkas/hyperliquid SDK so the broken Sprint-15
 * hand-rolled signing path is replaced with a verified one. Tests pin:
 *   - signL1Action ferries the action through to the SDK with the
 *     correct mainnet flag (isTestnet=false by default)
 *   - signUserSignedAction passes the user-signed action + types through
 *   - When Privy returns null (sign failure), the adapter throws cleanly
 *     so the route logs a meaningful reason instead of swallowing
 *
 * Mocks: stubs `signTypedDataWithPrivy` in privy.js so no real HTTP fires.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Privy module is dynamically loaded via the chain. Mock before importing
// hl-signer so the latter picks up our stub.
const fakeSignature =
  '0x' + 'aa'.repeat(64) + '1b';

vi.mock('../privy.js', () => ({
  signTypedDataWithPrivy: vi.fn(async () => fakeSignature),
}));

import {
  _resetHlNonceForTests,
  hlSignL1Action,
  hlSignUserSignedAction,
  HL_USER_SIGN_CHAIN_ID,
  nextHlNonce,
} from './hl-signer.js';
import { signTypedDataWithPrivy } from '../privy.js';

const WALLET_ID = 'wallet_abc123';
const WALLET_ADDRESS = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  vi.clearAllMocks();
  _resetHlNonceForTests();
});

describe('nextHlNonce', () => {
  it('stays monotonic when the wall clock repeats or moves backward', () => {
    expect(nextHlNonce(1000)).toBe(1000);
    expect(nextHlNonce(1000)).toBe(1001);
    expect(nextHlNonce(999)).toBe(1002);
    expect(nextHlNonce(1005)).toBe(1005);
  });
});

describe('hlSignL1Action', () => {
  it('routes through Privy and returns an {r, s, v} signature', async () => {
    const sig = await hlSignL1Action({
      walletId: WALLET_ID,
      walletAddress: WALLET_ADDRESS,
      action: { type: 'cancel', cancels: [{ a: 0, o: 12345 }] },
      nonce: 1781700000000,
    });
    expect(sig).toHaveProperty('r');
    expect(sig).toHaveProperty('s');
    expect(sig).toHaveProperty('v');
    expect([27, 28]).toContain(sig.v);
    expect(signTypedDataWithPrivy).toHaveBeenCalledTimes(1);
  });

  it('defaults to mainnet (isTestnet=false) — verified by the typed-data domain', async () => {
    await hlSignL1Action({
      walletId: WALLET_ID,
      walletAddress: WALLET_ADDRESS,
      action: { type: 'cancel', cancels: [{ a: 0, o: 1 }] },
      nonce: Date.now(),
    });
    // The SDK builds typed data with `source: 'a'` on mainnet, `source: 'b'`
    // on testnet (per @nktkas/hyperliquid/signing internals). We assert the
    // mainnet source went through.
    const [[, params]] = (signTypedDataWithPrivy as ReturnType<typeof vi.fn>).mock.calls;
    expect(params.message.source).toBe('a');
  });

  it('throws on Privy sign failure (null return)', async () => {
    (signTypedDataWithPrivy as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(
      hlSignL1Action({
        walletId: WALLET_ID,
        walletAddress: WALLET_ADDRESS,
        action: { type: 'cancel', cancels: [{ a: 0, o: 1 }] },
        nonce: Date.now(),
      }),
    ).rejects.toThrow();
  });
});

describe('hlSignUserSignedAction', () => {
  it('passes the action + types through to the SDK', async () => {
    const sig = await hlSignUserSignedAction({
      walletId: WALLET_ID,
      walletAddress: WALLET_ADDRESS,
      action: {
        type: 'approveBuilderFee',
        signatureChainId: HL_USER_SIGN_CHAIN_ID,
        hyperliquidChain: 'Mainnet',
        maxFeeRate: '0.1%',
        builder: '0x2222222222222222222222222222222222222222',
        nonce: Date.now(),
      },
      types: {
        'HyperliquidTransaction:ApproveBuilderFee': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'maxFeeRate', type: 'string' },
          { name: 'builder', type: 'address' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
    });
    expect(sig).toHaveProperty('r');
    expect(sig).toHaveProperty('v');
    expect(signTypedDataWithPrivy).toHaveBeenCalledTimes(1);
    // The SDK should hand a domain with chainId=421614 (0x66eee) per HL
    // user-signed spec; verify the chainId reached signTypedDataWithPrivy.
    const [[, params]] = (signTypedDataWithPrivy as ReturnType<typeof vi.fn>).mock.calls;
    expect(params.domain.chainId).toBe(421614);
  });

  it('throws on Privy sign failure', async () => {
    (signTypedDataWithPrivy as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(
      hlSignUserSignedAction({
        walletId: WALLET_ID,
        walletAddress: WALLET_ADDRESS,
        action: {
          type: 'approveBuilderFee',
          signatureChainId: HL_USER_SIGN_CHAIN_ID,
          hyperliquidChain: 'Mainnet',
          maxFeeRate: '0.1%',
          builder: '0x2222222222222222222222222222222222222222',
          nonce: Date.now(),
        },
        types: {
          'HyperliquidTransaction:ApproveBuilderFee': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'maxFeeRate', type: 'string' },
            { name: 'builder', type: 'address' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
      }),
    ).rejects.toThrow();
  });
});

/**
 * CCTP scaffold tests — Sprint 15.
 *
 * The adapter is a scaffold: it must report `isLive: false` and return null
 * from `quote()`. These tests pin that behavior so the bridge router never
 * accidentally prefers CCTP before the implementation lands.
 */

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import {
  cctpAdapter,
  CCTP_DOMAIN,
  CCTP_V2_FINALITY_FAST,
  CCTP_V2_FINALITY_STANDARD,
  CCTP_V2_TOKEN_MESSENGER,
  CCTP_V2_MESSAGE_TRANSMITTER,
  isCctpRoute,
  fetchCctpAttestation,
  fetchCctpV2FastFeeBpsHundredths,
  fetchCctpV2Message,
  cctpV2MaxFeeAtoms,
  buildDepositForBurnV2Calldata,
  pollCctpAttestation,
  buildReceiveMessageCalldata,
  addressToBytes32,
} from './cctp.js';

describe('lib/chain/cctp', () => {
  it('isLive is false by default (no provider keys configured)', () => {
    expect(cctpAdapter.isLive).toBe(false);
  });

  it('quote returns null today so the router falls back to Socket / LI.FI', async () => {
    const result = await cctpAdapter.quote({
      fromChain: 'base',
      toChain: 'arbitrum',
      fromToken: 'USDC',
      toToken: 'USDC',
      amountUsd: 100,
      userAddress: '0x' + '0'.repeat(40),
    });
    expect(result).toBeNull();
  });

  it('isCctpRoute detects supported USDC pairs', () => {
    expect(isCctpRoute({ fromChain: 'base', toChain: 'arbitrum', fromToken: 'USDC', toToken: 'USDC' })).toBe(true);
    expect(isCctpRoute({ fromChain: 'base', toChain: 'optimism', fromToken: 'USDC', toToken: 'USDC' })).toBe(true);
    expect(isCctpRoute({ fromChain: 'base', toChain: 'polygon', fromToken: 'USDC', toToken: 'USDC' })).toBe(true);
  });

  it('rejects non-USDC pairs', () => {
    expect(isCctpRoute({ fromChain: 'base', toChain: 'arbitrum', fromToken: 'USDC', toToken: 'EURC' })).toBe(false);
    expect(isCctpRoute({ fromChain: 'base', toChain: 'arbitrum', fromToken: 'EURC', toToken: 'USDC' })).toBe(false);
  });

  it('rejects same-chain "transfers"', () => {
    expect(isCctpRoute({ fromChain: 'base', toChain: 'base', fromToken: 'USDC', toToken: 'USDC' })).toBe(false);
  });

  it('rejects unsupported chains (Gnosis is not in CCTP)', () => {
    expect(isCctpRoute({ fromChain: 'base', toChain: 'gnosis', fromToken: 'USDC', toToken: 'USDC' })).toBe(false);
  });

  it('CCTP_DOMAIN exposes the canonical Circle domain IDs', () => {
    expect(CCTP_DOMAIN['base']).toBe(6);
    expect(CCTP_DOMAIN['optimism']).toBe(2);
    expect(CCTP_DOMAIN['arbitrum']).toBe(3);
    expect(CCTP_DOMAIN['polygon']).toBe(7);
  });
});

describe('lib/chain/cctp — Sprint 16.2 live wiring', () => {
  const fakeHash = ('0x' + '11'.repeat(32)) as `0x${string}`;

  it('fetchCctpAttestation returns pending on 404 (Circle still signing)', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const r = await fetchCctpAttestation(fakeHash, { fetchImpl });
    expect(r.status).toBe('pending');
    expect(r.attestation).toBeNull();
  });

  it('fetchCctpAttestation parses a complete response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 'complete', attestation: '0xabcd', message: '0x1234' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const r = await fetchCctpAttestation(fakeHash, { fetchImpl });
    expect(r.status).toBe('complete');
    expect(r.attestation).toBe('0xabcd');
    expect(r.message).toBe('0x1234');
  });

  it('fetchCctpAttestation treats Circle "pending_confirmations" as pending, not failed', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 'pending_confirmations', attestation: 'PENDING' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const r = await fetchCctpAttestation(fakeHash, { fetchImpl });
    expect(r.status).toBe('pending');
  });

  it('fetchCctpAttestation treats an explicit error status as failed', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 'error' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const r = await fetchCctpAttestation(fakeHash, { fetchImpl });
    expect(r.status).toBe('failed');
  });

  it('pollCctpAttestation returns the first complete snapshot it sees', async () => {
    let count = 0;
    const fetchImpl = (async () => {
      count += 1;
      if (count < 3) return new Response(null, { status: 404 });
      return new Response(
        JSON.stringify({ status: 'complete', attestation: '0xdead', message: '0xbeef' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const sleep = async (): Promise<void> => undefined;
    const r = await pollCctpAttestation(fakeHash, { fetchImpl, sleep, maxAttempts: 10, intervalMs: 0 });
    expect(r.status).toBe('complete');
    expect(r.polls).toBe(3);
    expect(r.attestation).toBe('0xdead');
  });

  it('pollCctpAttestation caps polling at maxAttempts', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const sleep = async (): Promise<void> => undefined;
    const r = await pollCctpAttestation(fakeHash, { fetchImpl, sleep, maxAttempts: 3, intervalMs: 0 });
    expect(r.status).toBe('pending');
    expect(r.polls).toBe(3);
  });

  it('buildReceiveMessageCalldata starts with the receiveMessage selector', () => {
    const calldata = buildReceiveMessageCalldata({
      message: ('0x' + 'ab'.repeat(64)) as `0x${string}`,
      attestation: ('0x' + 'cd'.repeat(65)) as `0x${string}`,
    });
    expect(calldata.startsWith('0x57ecfd28')).toBe(true);
    // selector(4) + head(64) + tail = 132 hex + tails; just ensure non-trivial length
    expect(calldata.length).toBeGreaterThan(200);
  });

  it('buildReceiveMessageCalldata pads dynamic bytes to 32-byte boundaries', () => {
    const calldata = buildReceiveMessageCalldata({
      message: '0xab' as `0x${string}`,
      attestation: '0xcd' as `0x${string}`,
    });
    // selector(10 chars incl 0x) + head(2*64) + msg tail(len 64 + data 64) + att tail(64+64) = 394
    expect(calldata.length).toBe(394);
    // Both dynamic bytes are stored 32-byte aligned — the first byte of each
    // tail (after the length word) is the actual byte, then zero-padding.
    expect(calldata.endsWith('cd' + '0'.repeat(62))).toBe(true);
  });
});

describe('lib/chain/cctp — V2 (ADR-0005)', () => {
  it('pins the CREATE2 same-address-everywhere V2 contracts', () => {
    // Verified against circlefin/evm-cctp-contracts + explorer labels on
    // arbitrum/base/optimism/polygon. If these change, Circle redeployed —
    // re-verify before trusting a green build.
    expect(CCTP_V2_TOKEN_MESSENGER).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(CCTP_V2_MESSAGE_TRANSMITTER).toBe('0x81D40F21F12A8F0E3252Bccb954D722d4c464B64');
    expect(CCTP_V2_FINALITY_STANDARD).toBe(2000);
    expect(CCTP_V2_FINALITY_FAST).toBe(1000);
  });

  it('buildDepositForBurnV2Calldata encodes the 7-arg V2 signature', () => {
    const mintRecipient = addressToBytes32('0x00000000000000000000000000000000000000a1');
    const calldata = buildDepositForBurnV2Calldata({
      amount: 25_000_000n,
      destDomain: 6,
      mintRecipient,
      burnToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      maxFee: 3_000n,
      minFinalityThreshold: 1000,
    });
    const decoded = decodeFunctionData({
      abi: parseAbi([
        'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
      ]),
      data: calldata,
    });
    expect(decoded.args[0]).toBe(25_000_000n);
    expect(decoded.args[1]).toBe(6);
    expect(decoded.args[2]).toBe(mintRecipient);
    // destinationCaller defaults to bytes32(0) — anyone may broadcast the mint.
    expect(decoded.args[4]).toBe('0x' + '00'.repeat(32));
    expect(decoded.args[5]).toBe(3_000n);
    expect(decoded.args[6]).toBe(1000);
  });

  it('cctpV2MaxFeeAtoms applies the rate with a 20% buffer, floor 1 atom', () => {
    // 1 bp (100 hundredths) on $100 (100_000_000 atoms) = 10_000 atoms → 12_000 buffered.
    expect(cctpV2MaxFeeAtoms(100_000_000n, 100)).toBe(12_000n);
    // Tiny amounts never round to a 0 maxFee (contract needs fee ≥ on-chain min).
    expect(cctpV2MaxFeeAtoms(1n, 1)).toBe(1n);
  });

  it('fetchCctpV2FastFeeBpsHundredths picks the fast (1000) tier and converts to hundredths', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { finalityThreshold: 2000, minimumFee: 0 },
          { finalityThreshold: 1000, minimumFee: 1.5 },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    expect(await fetchCctpV2FastFeeBpsHundredths(3, 6, { fetchImpl })).toBe(150);
  });

  it('fetchCctpV2FastFeeBpsHundredths returns null on error — caller falls back to Standard', async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as typeof fetch;
    expect(await fetchCctpV2FastFeeBpsHundredths(3, 6, { fetchImpl })).toBeNull();
  });

  it('fetchCctpV2Message treats 404 as pending (tx not yet indexed)', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const r = await fetchCctpV2Message(3, '0x' + 'aa'.repeat(32), { fetchImpl });
    expect(r.status).toBe('pending');
  });

  it('fetchCctpV2Message parses a complete message with attestation', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          messages: [{ status: 'complete', message: '0x1234', attestation: '0xabcd' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const r = await fetchCctpV2Message(3, '0x' + 'aa'.repeat(32), { fetchImpl });
    expect(r.status).toBe('complete');
    expect(r.message).toBe('0x1234');
    expect(r.attestation).toBe('0xabcd');
  });

  it('fetchCctpV2Message keeps polling on pending_confirmations and empty message lists', async () => {
    const pendingImpl = (async () =>
      new Response(JSON.stringify({ messages: [{ status: 'pending_confirmations' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    expect((await fetchCctpV2Message(3, '0xaa', { fetchImpl: pendingImpl })).status).toBe('pending');
    const emptyImpl = (async () =>
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    expect((await fetchCctpV2Message(3, '0xaa', { fetchImpl: emptyImpl })).status).toBe('pending');
  });
});

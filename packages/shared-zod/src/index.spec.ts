import { describe, expect, it } from 'vitest';
import {
  Agent,
  AgentPolicy,
  BridgeWithdrawInput,
  EarnTierInput,
  ExternalTransferResponse,
  HlDepositResponse,
  HyperliquidOrderInput,
  InternalTransferResponse,
  MarketPosition,
  TransferDepositAddressResponse,
  X402Contract,
  X402Event,
} from './index.js';

describe('shared API contracts', () => {
  it('accepts the hostname-based agent policy used by the API store', () => {
    expect(() =>
      AgentPolicy.parse({
        perTxCapUsd: 1,
        perDayCapUsd: 50,
        endpointAllowlist: ['api.exa.ai', 'weather.api'],
        expiresAt: null,
        humanApprovalThresholdUsd: 1,
        killSwitch: false,
      }),
    ).not.toThrow();
  });

  it('accepts API agent lifecycle states', () => {
    expect(() =>
      Agent.parse({
        id: 'b48ef452-ea9a-4d66-980a-33e8d20af3a7',
        name: 'ResearchBot-01',
        role: 'Data procurement',
        balanceUsd: 36.8,
        spentTodayUsd: 13.2,
        policy: {
          perTxCapUsd: 1,
          perDayCapUsd: 50,
          endpointAllowlist: ['api.exa.ai'],
          expiresAt: null,
          humanApprovalThresholdUsd: 1,
          killSwitch: false,
        },
        state: 'live',
        createdAt: '2026-06-13T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('accepts the demo x402 merchant contract shape', () => {
    expect(() =>
      X402Contract.parse({
        id: 'a8e1c3af-6a9b-4a11-8731-6a09d4d11a72',
        name: 'Clip analytics',
        endpointPath: '/v1/clip-analytics',
        method: 'GET',
        priceUsd: 0.003,
        currency: 'USDC',
        status: 'live',
        requestsToday: 18402,
        revenueTodayUsd: 55.2,
        paidSuccessRate: 0.987,
      }),
    ).not.toThrow();
  });

  it('accepts agent-side x402 receipts with no merchant contract id', () => {
    expect(() =>
      X402Event.parse({
        id: '0f68a340-e578-47ef-8e5e-9ce2df9804e1',
        contractId: null,
        buyer: 'ResearchBot-01',
        buyerType: 'agent',
        resource: 'api.exa.ai/v1/search',
        amountUsd: 0.12,
        httpStatus: 200,
        ref: '0x8c1f2d3a..e2d4',
        at: '2026-06-13T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('requires Bridge withdrawals to use cent precision', () => {
    const payoutMethodId = 'b48ef452-ea9b-4d66-980a-33e8d20af3a7';

    expect(() => BridgeWithdrawInput.parse({ payoutMethodId, amountUsd: 10.99 })).not.toThrow();
    expect(() => BridgeWithdrawInput.parse({ payoutMethodId, amountUsd: 10.999 })).toThrow();
  });

  it('accepts lifecycle market positions returned by the API', () => {
    expect(() =>
      MarketPosition.parse({
        id: 'b48ef452-ea9a-4d66-980a-33e8d20af3a7',
        userId: 'b48ef452-ea9b-4d66-980a-33e8d20af3a7',
        venue: 'hyperliquid-spot',
        symbol: 'PURR/USDC',
        sideLong: true,
        qtyUsd: 25,
        entryPriceUsd: 1.23,
        status: 'cancel_requested',
        externalRef: '12345',
        externalOrderId: '12345',
        createdAt: '2026-06-25T00:00:00.000Z',
        lifecycleEvents: [
          { status: 'filled', ts: '2026-06-25T00:00:01.000Z', externalOrderId: '12345' },
          { status: 'cancel_requested', ts: '2026-06-25T00:00:02.000Z' },
        ],
        filledQtyUsd: 25,
        avgFillPriceUsd: 1.23,
        updatedAt: '2026-06-25T00:00:02.000Z',
      }),
    ).not.toThrow();
  });

  it('accepts both earn router tier values and rejects anything else', () => {
    expect(EarnTierInput.parse({ tier: 'standard' }).tier).toBe('standard');
    expect(EarnTierInput.parse({ tier: 'higher_yield' }).tier).toBe('higher_yield');
    expect(() => EarnTierInput.parse({ tier: 'aggressive' })).toThrow();
    expect(() => EarnTierInput.parse({})).toThrow();
  });

  it('does not expose legacy builder approval refs on Hyperliquid orders', () => {
    const parsed = HyperliquidOrderInput.parse({
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 100,
      leverage: 2,
      builderApprovalRef: 'legacy-client-ref',
    });

    expect(parsed).toEqual({ coin: 'BTC', sideLong: true, qtyUsd: 100, leverage: 2 });
  });

  it('keeps live Hyperliquid order controls in the shared wire schema', () => {
    const parsed = HyperliquidOrderInput.parse({
      coin: 'ETH',
      sideLong: false,
      qtyUsd: 250,
      leverage: 3,
      kind: 'limit',
      orderType: 'limit',
      limitPriceUsd: 4200,
      tif: 'Gtc',
      reduceOnly: true,
      takeProfit: { triggerPriceUsd: 3900, limitPriceUsd: 3890 },
      stopLoss: { triggerPriceUsd: 4300 },
    });

    expect(parsed).toEqual({
      coin: 'ETH',
      sideLong: false,
      qtyUsd: 250,
      leverage: 3,
      kind: 'limit',
      orderType: 'limit',
      limitPriceUsd: 4200,
      tif: 'Gtc',
      reduceOnly: true,
      takeProfit: { triggerPriceUsd: 3900, limitPriceUsd: 3890 },
      stopLoss: { triggerPriceUsd: 4300 },
    });
  });

  it('pins transfer responses to the route payloads consumed by NEO and the SDK', () => {
    expect(() =>
      TransferDepositAddressResponse.parse({
        ok: true,
        bucket: 'stocks-spot',
        bucketLabel: 'Stocks (spot)',
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        token: 'USDC',
        live: true,
        memo: null,
      }),
    ).not.toThrow();

    expect(() =>
      InternalTransferResponse.parse({
        ok: true,
        transferId: 'tr_internal_1',
        status: 'hl_withdrawing',
        rail: 'cctp',
        fromBucket: 'perps',
        toBucket: 'cash',
        amountUsd: 98.9,
        requestedUsd: 100,
        feeUsd: 0.1,
        feeBps: 10,
        etaSec: 90,
        idempotent: false,
        demo: false,
      }),
    ).not.toThrow();

    expect(() =>
      ExternalTransferResponse.parse({
        ok: true,
        transferId: 'tr_external_1',
        status: 'created',
        chain: 'base',
        destinationAddress: '0x1111111111111111111111111111111111111111',
        amountUsd: 5,
        txHash: null,
        demo: false,
        idempotent: false,
        submittedUnknown: true,
      }),
    ).not.toThrow();

    expect(() =>
      HlDepositResponse.parse({
        ok: true,
        callId: null,
        amountUsd: 5,
        demo: false,
        transferId: 'tr_hl_1',
        status: 'created',
        idempotent: false,
        submittedUnknown: true,
      }),
    ).not.toThrow();

    expect(
      InternalTransferResponse.safeParse({
        ok: true,
        transferId: 'tr_drift',
        status: 'created',
        rail: 'cctp',
        fromBucket: 'cash',
        toBucket: 'perps',
        amountUsd: 5,
        requestedUsd: 5,
        feeUsd: 0,
        feeBps: 0,
        etaSeconds: 90,
        idempotent: false,
        demo: true,
      }).success,
    ).toBe(false);
  });
});

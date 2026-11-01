import { describe, expect, expectTypeOf, it } from 'vitest';
import { NexaClient, NexaError } from '../../../../packages/nexa-sdk/src/index.ts';

describe('NexaClient errors', () => {
  it('preserves Retry-After on rate-limit responses', async () => {
    const fetchMock = async (): Promise<Response> =>
      new Response(JSON.stringify({
        ok: false,
        error: { code: 'too_many_requests', message: 'rate_limited' },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '60' },
      });
    const client = new NexaClient({
      baseUrl: 'https://nexa.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.markets.positions()).rejects.toMatchObject({
      status: 429,
      code: 'too_many_requests',
      retryAfterMs: 60_000,
    });
    await expect(client.markets.positions()).rejects.toBeInstanceOf(NexaError);
  });

  it('uses the canonical transfers deposit-address route including stocks-spot', async () => {
    let seenUrl = '';
    const fetchMock = async (url: string | URL | Request): Promise<Response> => {
      seenUrl = String(url);
      return new Response(JSON.stringify({
        ok: true,
        bucket: 'stocks-spot',
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new NexaClient({
      baseUrl: 'https://nexa.test',
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.transfers.depositAddress('stocks-spot')).resolves.toMatchObject({
      ok: true,
      bucket: 'stocks-spot',
    });
    expect(seenUrl).toBe('https://nexa.test/transfers/onramp/deposit-address?bucket=stocks-spot');
  });

  it('exposes the exact transfer response fields returned by the routes', () => {
    type Internal = Awaited<ReturnType<NexaClient['transfers']['internal']>>;
    type External = Awaited<ReturnType<NexaClient['transfers']['external']>>;
    type HlDeposit = Awaited<ReturnType<NexaClient['transfers']['hlDeposit']>>;

    expectTypeOf<Internal>().toMatchTypeOf<{
      etaSec: number;
      demo: boolean;
      status: string;
    }>();
    expectTypeOf<'hl_withdrawing'>().toMatchTypeOf<Internal['status']>();
    expectTypeOf<External>().toMatchTypeOf<{
      chain: 'base';
      submittedUnknown?: boolean;
    }>();
    expectTypeOf<HlDeposit>().toMatchTypeOf<{
      callId: string | null;
      transferId: string;
      status: string;
      idempotent: boolean;
      submittedUnknown?: boolean;
    }>();

    const internalContract: { etaSec: number; demo: boolean } = null as unknown as Internal;
    const externalContract: { chain: 'base' } = null as unknown as External;
    const hlDepositContract: {
      callId: string | null;
      transferId: string;
      status: string;
      idempotent: boolean;
    } = null as unknown as HlDeposit;
    const withdrawingStatus: Internal['status'] = 'hl_withdrawing';
    void [internalContract, externalContract, hlDepositContract, withdrawingStatus];
  });
});

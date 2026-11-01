/**
 * pm-clob.spec.ts — L2 HMAC math + cred shape regression tests.
 *
 * We don't (and can't) hit Polymarket from the test suite, so this file
 * stays scoped to pure-function verification: the HMAC payload is built in
 * the exact byte-order Polymarket's CLOB expects (so a wrong order won't
 * cause silent 401s only Mirko catches in the pilot).
 *
 * TEST-01 / TEST-02 (Sprint 17.5) — deriveL2Credentials mutex + fallback
 * tests added at the bottom. We mock the Privy sign call (via vi.mock of
 * '../privy.js') and globalThis.fetch so no real network fires.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeSignature = '0xdeadbeef' + 'a'.repeat(120);
vi.mock('../privy.js', () => ({
  signTypedDataWithPrivy: vi.fn(async () => fakeSignature),
}));

// Constructor-capture mock for the CLOB SDK: the deposit-wallet funder tests
// assert exactly what identity we hand the venue, without any network.
const clobMock = vi.hoisted(() => ({
  ctorCalls: [] as Array<Record<string, unknown>>,
}));
vi.mock('@polymarket/clob-client-v2', () => ({
  Chain: { POLYGON: 137 },
  OrderType: { GTC: 'GTC', FOK: 'FOK' },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  ClobClient: class {
    constructor(opts: Record<string, unknown>) {
      clobMock.ctorCalls.push(opts);
    }
    async createAndPostOrder() {
      return { success: true, orderID: 'ord-live-1', status: 'live' };
    }
  },
}));

import {
  buildClobLaneOptions,
  buildL2Headers,
  deriveL2Credentials,
  submitClobLimitBuyOrder,
  type ClobLane,
  type PmClobCreds,
} from './pm-clob.js';
import { signTypedDataWithPrivy } from '../privy.js';

const FIXED_TS_RE = /^\d{10}$/;

const CREDS: PmClobCreds = {
  key: 'test-api-key-uuid',
  // 32-byte base64-encoded secret (mimics Polymarket's HMAC key shape).
  secret: Buffer.from('a'.repeat(32)).toString('base64'),
  passphrase: 'test-passphrase',
};

describe('pm-clob.buildL2Headers', () => {
  it('sets the five canonical POLY_* headers', () => {
    const headers = buildL2Headers(
      CREDS,
      '0x000000000000000000000000000000000000dEaD',
      'POST',
      '/order',
      '{"foo":"bar"}',
    );
    expect(Object.keys(headers).sort()).toEqual([
      'POLY_ADDRESS',
      'POLY_API_KEY',
      'POLY_PASSPHRASE',
      'POLY_SIGNATURE',
      'POLY_TIMESTAMP',
    ]);
    expect(headers.POLY_ADDRESS).toBe('0x000000000000000000000000000000000000dEaD');
    expect(headers.POLY_API_KEY).toBe('test-api-key-uuid');
    expect(headers.POLY_PASSPHRASE).toBe('test-passphrase');
    expect(headers.POLY_TIMESTAMP).toMatch(FIXED_TS_RE);
  });

  it('signature matches HMAC-SHA256 over (timestamp + method + path + body), base64url', () => {
    const address = '0xabc0000000000000000000000000000000000123';
    const method = 'POST';
    const path = '/order';
    const body = '{"side":"BUY"}';
    const headers = buildL2Headers(CREDS, address, method, path, body);
    const ts = headers.POLY_TIMESTAMP as string;
    const message = ts + 'POST' + path + body;
    const keyData = Buffer.from(CREDS.secret, 'base64');
    const expectedB64 = createHmac('sha256', keyData).update(message).digest('base64');
    const expectedB64Url = expectedB64.replace(/\+/g, '-').replace(/\//g, '_');
    expect(headers.POLY_SIGNATURE).toBe(expectedB64Url);
  });

  it('uppercases the method on the signed payload', () => {
    const address = '0xabc0000000000000000000000000000000000123';
    const headers = buildL2Headers(CREDS, address, 'post', '/order', '{}');
    const ts = headers.POLY_TIMESTAMP as string;
    const message = ts + 'POST' + '/order' + '{}';
    const keyData = Buffer.from(CREDS.secret, 'base64');
    const expected = createHmac('sha256', keyData)
      .update(message)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(headers.POLY_SIGNATURE).toBe(expected);
  });

  it('treats missing body as empty string in the signed payload', () => {
    const address = '0xabc0000000000000000000000000000000000123';
    const headers = buildL2Headers(CREDS, address, 'GET', '/orders');
    const ts = headers.POLY_TIMESTAMP as string;
    const message = ts + 'GET' + '/orders' + '';
    const keyData = Buffer.from(CREDS.secret, 'base64');
    const expected = createHmac('sha256', keyData)
      .update(message)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(headers.POLY_SIGNATURE).toBe(expected);
  });

  it('produces base64url not standard base64 (no + or /, keeps = padding)', () => {
    // Hand-pick a (key, message) combo that yields + and / in standard base64,
    // then assert they get translated. Iterate until we find one — keeps the
    // test deterministic without knowing the secret in advance.
    let foundSpecial = false;
    for (let i = 0; i < 20 && !foundSpecial; i++) {
      const headers = buildL2Headers(
        CREDS,
        '0x1111111111111111111111111111111111111111',
        'POST',
        '/order',
        `body-${i}`,
      );
      const sig = headers.POLY_SIGNATURE as string;
      expect(sig).not.toContain('+');
      expect(sig).not.toContain('/');
      // base64url with `=` padding preserved (Polymarket spec).
      if (sig.includes('-') || sig.includes('_')) foundSpecial = true;
    }
    // At least one iteration should have produced a `-` or `_`, proving the
    // translation actually fires. (Probabilistically near-certain inside 20.)
    expect(foundSpecial).toBe(true);
  });
});

/* ── TEST-01 / TEST-02 — deriveL2Credentials behavior ─────────────────────
 *
 * deriveL2Credentials performs:
 *   1. signTypedDataWithPrivy(walletId, ClobAuth typed data) → POLY_* L1 headers
 *   2. POST /auth/api-key (create)        → 200 returns creds, 4xx falls through
 *   3. GET  /auth/derive-api-key (fallback) → 200 returns existing creds
 *
 * Mutex: a second concurrent call while the first is inflight must
 * coalesce into the same promise (so two parallel orders don't double-
 * sign with Privy and don't race on the derived creds).
 */

const VALID_CREDS_RESPONSE = {
  apiKey: 'derived-key-001',
  secret: Buffer.from('s'.repeat(32)).toString('base64'),
  passphrase: 'derived-pp-001',
};

describe('pm-clob.deriveL2Credentials', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    (signTypedDataWithPrivy as ReturnType<typeof vi.fn>).mockClear();
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    fetchSpy.mockReset();
  });

  function okJson(body: object) {
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }
  function notOk(status: number) {
    return {
      ok: false,
      status,
      json: async () => ({}),
    } as unknown as Response;
  }

  it('TEST-01: coalesces concurrent derives via inflight mutex (1 Privy sign for N callers)', async () => {
    // Resolve fetch immediately — the assertion is that only ONE fetch +
    // ONE Privy sign happen even with 5 concurrent callers (mutex behavior).
    fetchSpy.mockResolvedValue(okJson(VALID_CREDS_RESPONSE));

    // Use a unique wallet id per test so prior runs' inflight maps don't
    // collide.
    const walletId = `wallet-mutex-${Date.now()}-${Math.floor(performance.now())}`;
    const callers = [
      deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000001'),
      deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000001'),
      deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000001'),
      deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000001'),
      deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000001'),
    ];
    const results = await Promise.all(callers);

    // All five callers got the same creds; only ONE Privy sign + ONE fetch
    // happened (the mutex coalesced 5 → 1).
    for (const r of results) {
      expect(r).toEqual({
        key: VALID_CREDS_RESPONSE.apiKey,
        secret: VALID_CREDS_RESPONSE.secret,
        passphrase: VALID_CREDS_RESPONSE.passphrase,
      });
    }
    expect(signTypedDataWithPrivy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('TEST-02: falls back to GET /auth/derive-api-key when POST /auth/api-key returns 4xx', async () => {
    // POST fails (e.g. 400/409 because creds already exist) → GET succeeds.
    fetchSpy
      .mockResolvedValueOnce(notOk(409))
      .mockResolvedValueOnce(okJson(VALID_CREDS_RESPONSE));

    const walletId = `wallet-fallback-${Date.now()}`;
    const r = await deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000002');

    expect(r).toEqual({
      key: VALID_CREDS_RESPONSE.apiKey,
      secret: VALID_CREDS_RESPONSE.secret,
      passphrase: VALID_CREDS_RESPONSE.passphrase,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstCall = fetchSpy.mock.calls[0];
    const secondCall = fetchSpy.mock.calls[1];
    expect(String(firstCall![0])).toContain('/auth/api-key');
    expect((firstCall![1] as RequestInit).method).toBe('POST');
    expect(String(secondCall![0])).toContain('/auth/derive-api-key');
    expect((secondCall![1] as RequestInit).method).toBe('GET');
  });

  it('returns null when both endpoints reject', async () => {
    fetchSpy.mockResolvedValueOnce(notOk(403)).mockResolvedValueOnce(notOk(403));
    const walletId = `wallet-both-fail-${Date.now()}`;
    const r = await deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000003');
    expect(r).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null when Privy L1 sign fails (no upstream fetch)', async () => {
    (signTypedDataWithPrivy as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const walletId = `wallet-sig-fail-${Date.now()}`;
    const r = await deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000004');
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears inflight on settlement so the next call re-derives', async () => {
    fetchSpy.mockResolvedValue(okJson(VALID_CREDS_RESPONSE));
    const walletId = `wallet-clear-${Date.now()}`;
    await deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000005');
    await deriveL2Credentials(walletId, '0xabc0000000000000000000000000000000000005');
    // Two sequential calls — each fires its own sign + fetch round.
    expect(signTypedDataWithPrivy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('pm-clob deposit-wallet funder override (Phase 5 plumbing)', () => {
  const submitArgs = {
    privyWalletId: 'wallet-funder-1',
    privyWalletAddress: '0xabc0000000000000000000000000000000000123' as `0x${string}`,
    creds: CREDS,
    tokenId: '123456',
    priceCents: 50,
    qtyUsd: 1,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    clobMock.ctorCalls.length = 0;
  });

  it('defaults to bare-EOA construction — no signatureType/funderAddress keys', async () => {
    const res = await submitClobLimitBuyOrder(submitArgs);
    expect(res.orderId).toBe('ord-live-1');
    expect(clobMock.ctorCalls).toHaveLength(1);
    expect('signatureType' in clobMock.ctorCalls[0]!).toBe(false);
    expect('funderAddress' in clobMock.ctorCalls[0]!).toBe(false);
  });

  it('threads PM_CLOB_SIGNATURE_TYPE + PM_CLOB_FUNDER_ADDRESS into the ClobClient with EOA creds', async () => {
    vi.stubEnv('PM_CLOB_SIGNATURE_TYPE', '3');
    vi.stubEnv('PM_CLOB_FUNDER_ADDRESS', '0x00000000000000000000000000000000000f11de');
    await submitClobLimitBuyOrder(submitArgs);
    // sigType 3 + funder go through; the order still SIGNS + AUTHENTICATES as
    // the EOA (caller creds), never wallet-bound — the CLOB validates the
    // deposit wallet via EIP-1271 on the signed order (live-proven 2026-07-06).
    expect(clobMock.ctorCalls[0]).toMatchObject({
      signatureType: 3,
      funderAddress: '0x00000000000000000000000000000000000f11de',
      creds: CREDS,
    });
  });

  it('rejects half-configured funder env instead of ordering under the wrong identity', async () => {
    vi.stubEnv('PM_CLOB_FUNDER_ADDRESS', '0x00000000000000000000000000000000000f11de');
    await expect(submitClobLimitBuyOrder(submitArgs)).rejects.toThrow('polymarket_funder_misconfigured');
  });
});

/* ── Lane plumbing via buildClobLaneOptions — Sprint 18 Safe values kept as
 * rollback fixtures; the LIVE builder lane is sigType 3 (POLY_1271) + deposit
 * wallet, see pm-relayer.getBuilderLaneFunder ─────────────────────────────── */

describe('pm-clob.buildClobLaneOptions', () => {
  const SAFE = '0x00000000000000000000000000000000005AFE01' as `0x${string}`;
  const LANE: ClobLane = {
    signatureType: 2 as ClobLane['signatureType'],
    funderAddress: SAFE,
    builderCode: 'NEXA-01',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    clobMock.ctorCalls.length = 0;
  });

  it('returns {} when there is no lane and no env override', () => {
    expect(buildClobLaneOptions(null)).toEqual({});
    expect(buildClobLaneOptions(undefined)).toEqual({});
  });

  it('falls back to the PM_CLOB_* env pair when no explicit lane is given', () => {
    vi.stubEnv('PM_CLOB_SIGNATURE_TYPE', '3');
    vi.stubEnv('PM_CLOB_FUNDER_ADDRESS', '0x00000000000000000000000000000000000f11de');
    expect(buildClobLaneOptions(null)).toEqual({
      signatureType: 3,
      funderAddress: '0x00000000000000000000000000000000000f11de',
    });
  });

  it('explicit lane beats env and carries builderConfig', () => {
    vi.stubEnv('PM_CLOB_SIGNATURE_TYPE', '3');
    vi.stubEnv('PM_CLOB_FUNDER_ADDRESS', '0x00000000000000000000000000000000000f11de');
    expect(buildClobLaneOptions(LANE)).toEqual({
      signatureType: 2,
      funderAddress: SAFE,
      builderConfig: { builderCode: 'NEXA-01' },
    });
  });

  it('omits builderConfig entirely when the lane has no builderCode', () => {
    const opts = buildClobLaneOptions({ ...LANE, builderCode: null });
    expect(opts).toEqual({ signatureType: 2, funderAddress: SAFE });
    expect('builderConfig' in opts).toBe(false);
  });

  it('threads the lane into the ClobClient constructor on submit', async () => {
    await submitClobLimitBuyOrder({
      privyWalletId: 'wallet-lane-1',
      privyWalletAddress: '0xabc0000000000000000000000000000000000123' as `0x${string}`,
      creds: CREDS,
      tokenId: '123456',
      priceCents: 50,
      qtyUsd: 1,
      lane: LANE,
    });
    expect(clobMock.ctorCalls).toHaveLength(1);
    expect(clobMock.ctorCalls[0]).toMatchObject({
      signatureType: 2,
      funderAddress: SAFE,
      builderConfig: { builderCode: 'NEXA-01' },
    });
  });
});

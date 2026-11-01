/**
 * pm-relayer unit surface (Builder Program Safe lane, 2026-07-05).
 *
 * Offline-only: operator-set derivation, approval planning, chunking, relayer
 * API-key header injection, deterministic Safe derivation, lane gating, and
 * fail-closed funding. Live relayer behavior (deploy/approve/order) is proven
 * by the authenticated $1 probe recorded under docs/probes — never by units.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  hashMessage,
  maxUint256,
  parseAbi,
  serializeSignature,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

vi.mock('../chain/alchemy.js', () => ({
  executor: { sendCalls: vi.fn() },
}));
vi.mock('../privy.js', () => ({
  signHashWithPrivy: vi.fn(),
  signTypedDataWithPrivy: vi.fn(),
}));

import { executor } from '../chain/alchemy.js';
import { signHashWithPrivy } from '../privy.js';
import { env } from '../env.js';
import {
  _resetPmRelayerCachesForTests,
  attachRelayerKeyHeaders,
  buildApprovalTxs,
  chunkTxns,
  depositCallsFromTxs,
  deriveUserSafe,
  fundSafeFromEoa,
  getBuilderLaneFunder,
  operatorSetsFromConfig,
  privySafeWalletClient,
  resolveFundAtoms,
  type RelayerHttpish,
} from './pm-relayer.js';

const CTF_ABI = parseAbi([
  'function setApprovalForAll(address operator, bool approved)',
]);

/** clob-client-v2 getContractConfig(137) snapshot (dist/config.js, 1.0.8). */
const CFG = {
  exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  collateral: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  exchangeV2: '0xE111180000d2663C0091e4f400237545B87B996B',
  negRiskExchangeV2: '0xe2222d279d744050d28e00520010520000310F59',
  exchangeV3: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',
} as Record<string, string>;

const EOA = '0x91b8af6e23a7b27ecb7d0f2c8171bd9b2e1b6e0d' as `0x${string}`;
const USDCE = getAddress('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['PM_BUILDER_LANE', 'POLYMARKET_BUILDER_CODE'] as const;

beforeEach(() => {
  _resetPmRelayerCachesForTests();
  for (const k of ENV_KEYS) savedEnv[k] = (env as Record<string, string | undefined>)[k];
  vi.mocked(executor.sendCalls).mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) (env as Record<string, string | undefined>)[k] = savedEnv[k];
  _resetPmRelayerCachesForTests();
});

describe('operatorSetsFromConfig', () => {
  it('derives the relayer-allowed version-2 operator set (exchangeV2 + negRiskExchangeV2 + negRiskAdapter) with CTF as an extra ERC-20 spender', () => {
    const sets = operatorSetsFromConfig(CFG);
    expect(sets.ctfOperators).toHaveLength(3);
    expect(sets.erc20Spenders).toHaveLength(4); // 3 operators + CTF itself
    // Live-probed allow-list: modern operators in, legacy V1 exchanges out.
    const lc = (a: string) => a.toLowerCase();
    expect(sets.ctfOperators.map(lc)).toEqual(
      [CFG.exchangeV2, CFG.negRiskExchangeV2, CFG.negRiskAdapter].map(lc),
    );
    expect(sets.ctfOperators.map(lc)).not.toContain(lc(CFG.exchange));
    expect(sets.ctfOperators.map(lc)).not.toContain(lc(CFG.negRiskExchange));
    expect(sets.erc20Tokens).toEqual([getAddress(CFG.collateral), USDCE]);
    expect(sets.ctf).toBe(getAddress(CFG.conditionalTokens));
    // Everything checksummed.
    for (const a of [...sets.ctfOperators, ...sets.erc20Spenders]) {
      expect(a).toBe(getAddress(a));
    }
    // CTF is a spender but never an ERC-1155 operator.
    expect(sets.erc20Spenders).toContain(sets.ctf);
    expect(sets.ctfOperators).not.toContain(sets.ctf);
  });

  it('dedupes repeated addresses across config keys', () => {
    const sets = operatorSetsFromConfig({ ...CFG, negRiskExchangeV2: CFG.exchangeV2 });
    expect(sets.ctfOperators).toHaveLength(2);
    expect(sets.erc20Spenders).toHaveLength(3);
  });
});

describe('buildApprovalTxs', () => {
  it('encodes approve(max) + setApprovalForAll(true) with operation=Call and value 0', () => {
    const sets = operatorSetsFromConfig(CFG);
    const missingErc20 = [
      { token: sets.erc20Tokens[0], spender: sets.erc20Spenders[0] },
      { token: sets.erc20Tokens[1], spender: sets.erc20Spenders[1] },
    ];
    const missingCtf = [sets.ctfOperators[2]];
    const txns = buildApprovalTxs(missingErc20, missingCtf, sets.ctf);
    expect(txns).toHaveLength(3);

    const approve = decodeFunctionData({ abi: erc20Abi, data: txns[0].data as `0x${string}` });
    expect(approve.functionName).toBe('approve');
    expect(approve.args?.[0]).toBe(sets.erc20Spenders[0]);
    expect(approve.args?.[1]).toBe(maxUint256);
    expect(txns[0].to).toBe(sets.erc20Tokens[0]);
    expect(txns[0].operation).toBe(0);
    expect(txns[0].value).toBe('0');

    const sfa = decodeFunctionData({ abi: CTF_ABI, data: txns[2].data as `0x${string}` });
    expect(sfa.functionName).toBe('setApprovalForAll');
    expect(sfa.args?.[0]).toBe(sets.ctfOperators[2]);
    expect(sfa.args?.[1]).toBe(true);
    expect(txns[2].to).toBe(sets.ctf);
  });

  it('is empty when nothing is missing', () => {
    expect(buildApprovalTxs([], [], USDCE)).toEqual([]);
  });
});

describe('chunkTxns', () => {
  it('splits into fixed-size batches with a tail remainder', () => {
    expect(chunkTxns([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkTxns([], 12)).toEqual([]);
  });
  it('rejects non-positive sizes', () => {
    expect(() => chunkTxns([1], 0)).toThrow('pm_relayer_invalid_chunk_size');
  });
});

describe('attachRelayerKeyHeaders', () => {
  function fakeClient(): { client: RelayerHttpish; calls: Array<{ endpoint: string; method: string; options?: Record<string, unknown> }> } {
    const calls: Array<{ endpoint: string; method: string; options?: Record<string, unknown> }> = [];
    const client: RelayerHttpish = {
      httpClient: {
        send: async (endpoint, method, options) => {
          calls.push({ endpoint, method, options: options as Record<string, unknown> | undefined });
          return { data: null };
        },
      },
    };
    return { client, calls };
  }

  it('injects RELAYER_API_KEY headers on every request and keeps per-call headers dominant', async () => {
    const { client, calls } = fakeClient();
    attachRelayerKeyHeaders(client, { RELAYER_API_KEY: 'k', RELAYER_API_KEY_ADDRESS: '0xabc' });
    await client.httpClient.send('/submit', 'POST', { data: 'x', headers: { POLY_BUILDER_API_KEY: 'hmac', RELAYER_API_KEY: 'per-call-wins' } });
    await client.httpClient.send('/deployed', 'GET');
    expect(calls[0].options?.headers).toEqual({
      RELAYER_API_KEY: 'per-call-wins',
      RELAYER_API_KEY_ADDRESS: '0xabc',
      POLY_BUILDER_API_KEY: 'hmac',
    });
    expect(calls[0].options?.data).toBe('x');
    expect(calls[1].options?.headers).toEqual({ RELAYER_API_KEY: 'k', RELAYER_API_KEY_ADDRESS: '0xabc' });
  });

  it('is a no-op when the header pair is absent', async () => {
    const { client, calls } = fakeClient();
    const before = client.httpClient.send;
    attachRelayerKeyHeaders(client, null);
    expect(client.httpClient.send).toBe(before);
    await client.httpClient.send('/nonce', 'GET');
    expect(calls[0].options).toBeUndefined();
  });
});

describe('deriveUserSafe', () => {
  it('is deterministic, checksummed and distinct from the EOA', async () => {
    const a = await deriveUserSafe(EOA);
    const b = await deriveUserSafe(EOA.toLowerCase() as `0x${string}`);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a).toBe(getAddress(a));
    expect(a.toLowerCase()).not.toBe(EOA.toLowerCase());
  });
});

describe('getBuilderLaneFunder', () => {
  it('returns null without touching the chain when PM_BUILDER_LANE is off', async () => {
    (env as Record<string, string | undefined>).PM_BUILDER_LANE = undefined;
    await expect(getBuilderLaneFunder('wallet-1', EOA)).resolves.toBeNull();
  });

  it('returns null when the lane is on but the Privy walletId is missing', async () => {
    (env as Record<string, string | undefined>).PM_BUILDER_LANE = '1';
    try {
      await expect(getBuilderLaneFunder('', EOA)).resolves.toBeNull();
    } finally {
      (env as Record<string, string | undefined>).PM_BUILDER_LANE = undefined;
    }
  });
});

describe('depositCallsFromTxs', () => {
  it('maps Safe txns to deposit-wallet calls field-for-field', () => {
    const txns = buildApprovalTxs(
      [{ token: USDCE, spender: EOA }],
      [EOA],
      '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    );
    const calls = depositCallsFromTxs(txns);
    expect(calls).toHaveLength(txns.length);
    calls.forEach((call, i) => {
      expect(call.target).toBe(txns[i].to);
      expect(call.data).toBe(txns[i].data);
      expect(call.value).toBe('0');
    });
  });
});

describe('fundSafeFromEoa', () => {
  it('rejects non-positive amounts before any I/O', async () => {
    await expect(fundSafeFromEoa('u1', EOA, USDCE, 0n)).rejects.toThrow('pm_safe_fund_invalid_amount');
    expect(executor.sendCalls).not.toHaveBeenCalled();
  });

  it('fails CLOSED on demo executor results', async () => {
    vi.mocked(executor.sendCalls).mockResolvedValue({
      txHash: '0xdemo' + '0'.repeat(28),
      demo: true,
      sponsored: false,
    });
    await expect(fundSafeFromEoa('u1', EOA, USDCE, 1_000_000n)).rejects.toThrow(
      'pm_safe_fund_not_live:demo',
    );
  });

  it('fails CLOSED on failed executor results with the failure code', async () => {
    vi.mocked(executor.sendCalls).mockResolvedValue({
      txHash: '',
      demo: false,
      sponsored: false,
      failed: true,
      failureCode: 'server_signing_unavailable',
    });
    await expect(fundSafeFromEoa('u1', EOA, USDCE, 1_000_000n)).rejects.toThrow(
      'pm_safe_fund_not_live:server_signing_unavailable',
    );
  });

  it('transfers to the derived Safe on Polygon with a deterministic idempotency key', async () => {
    vi.mocked(executor.sendCalls).mockResolvedValue({
      txHash: '0x' + 'ab'.repeat(32),
      demo: false,
      sponsored: true,
    });
    const res = await fundSafeFromEoa('u1', EOA, USDCE, 1_200_000n);
    const safe = await deriveUserSafe(EOA);
    expect(res.safe).toBe(safe);
    expect(res.sponsored).toBe(true);

    const [userId, calls, opts] = vi.mocked(executor.sendCalls).mock.calls[0];
    expect(userId).toBe('u1');
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(USDCE);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args?.[0]).toBe(safe);
    expect(decoded.args?.[1]).toBe(1_200_000n);
    expect(opts?.chainId).toBe(137);
    expect(opts?.idempotencyKey).toBe(
      `pm-safe-fund:${EOA.toLowerCase()}:${USDCE.toLowerCase()}:1200000`,
    );
  });
});

describe('resolveFundAtoms', () => {
  it('sweeps the full balance when no amount is requested', () => {
    expect(resolveFundAtoms(2_400_000n)).toBe(2_400_000n);
  });

  it('converts an explicit USD amount at 6 decimals', () => {
    expect(resolveFundAtoms(5_000_000n, 2.5)).toBe(2_500_000n);
  });

  it('rounds sub-atom USD fractions to the nearest atom', () => {
    expect(resolveFundAtoms(5_000_000n, 1.2345678)).toBe(1_234_568n);
  });

  it('fails closed on an empty-balance sweep', () => {
    expect(() => resolveFundAtoms(0n)).toThrow('pm_safe_fund_invalid_amount');
  });

  it('fails closed on a non-positive requested amount', () => {
    expect(() => resolveFundAtoms(5_000_000n, 0)).toThrow('pm_safe_fund_invalid_amount');
  });

  it('fails closed when the request exceeds the live balance', () => {
    expect(() => resolveFundAtoms(1_000_000n, 1.01)).toThrow(
      'pm_safe_fund_insufficient_balance',
    );
  });
});

describe('privySafeWalletClient signMessage', () => {
  // Well-known throwaway key (hardhat #0) — unit-only, never funded.
  const TEST_PK =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
  const local = privateKeyToAccount(TEST_PK);
  // SafeTx-hash shape the relayer SDK personal_signs before splitAndPackSig.
  const RAW_HASH =
    '0x2a01e70a10c07a9a5a5c48e96e48f755ca1e0f66f9bcd1b6f6f9c2f27c1e5a3b' as `0x${string}`;

  beforeEach(() => {
    // Privy raw-signs the exact digest it is handed — emulate with the same
    // local key so byte-identity against viem's own account is provable.
    vi.mocked(signHashWithPrivy).mockImplementation(async (_walletId, hash) =>
      serializeSignature(await sign({ hash: hash as `0x${string}`, privateKey: TEST_PK })),
    );
  });

  it('is byte-identical to a local private-key account for { raw } hashes', async () => {
    const wc = privySafeWalletClient('wallet-1', local.address);
    const ours = await wc.signMessage({
      account: wc.account!,
      message: { raw: RAW_HASH },
    });
    expect(ours).toBe(await local.signMessage({ message: { raw: RAW_HASH } }));
    expect(vi.mocked(signHashWithPrivy)).toHaveBeenCalledWith(
      'wallet-1',
      hashMessage({ raw: RAW_HASH }),
    );
  });

  it('is byte-identical for plain string messages', async () => {
    const wc = privySafeWalletClient('wallet-1', local.address);
    const ours = await wc.signMessage({ account: wc.account!, message: 'clob-l1-auth' });
    expect(ours).toBe(await local.signMessage({ message: 'clob-l1-auth' }));
  });

  it('fails loud when Privy returns no signature', async () => {
    vi.mocked(signHashWithPrivy).mockResolvedValue(null);
    const wc = privySafeWalletClient('wallet-1', local.address);
    await expect(
      wc.signMessage({ account: wc.account!, message: { raw: RAW_HASH } }),
    ).rejects.toThrow('pm_relayer_signature_unavailable');
  });
});

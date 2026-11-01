/**
 * hl-agent — per-process Hyperliquid agent wallet (ADR-0004).
 *
 * Pins: approveAgent action shape (user-signed, unnamed agent), one approval
 * per (process, master) with concurrent dedupe, fail-open on rejection, and
 * the ephemeral key lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import { _resetHlAgentForTests, ensureAgentApproved, getProcessAgent } from './hl-agent.js';

vi.mock('../privy.js', () => ({
  // 65-byte signature with a VALID recovery byte (v=27) — the SDK splits and
  // validates r/s/v before building the request.
  signTypedDataWithPrivy: vi.fn(async () => ('0x' + 'ab'.repeat(64) + '1b') as `0x${string}`),
}));

const mutableEnv = env as unknown as { HL_AGENT_WALLETS: boolean };
const originalFlag = mutableEnv.HL_AGENT_WALLETS;

const MASTER = '0x00000000000000000000000000000000000000A1' as `0x${string}`;

function okFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  _resetHlAgentForTests();
  mutableEnv.HL_AGENT_WALLETS = true;
});

afterEach(() => {
  mutableEnv.HL_AGENT_WALLETS = originalFlag;
  vi.restoreAllMocks();
});

describe('hl-agent', () => {
  it('mints one ephemeral agent key per process and reuses it', () => {
    const a = getProcessAgent();
    const b = getProcessAgent();
    expect(a.address).toBe(b.address);
    expect(a.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    _resetHlAgentForTests();
    // New "process" (post-restart semantics) mints a NEW key.
    expect(getProcessAgent().address).not.toBe(a.address);
  });

  it('submits a master-signed unnamed approveAgent with the canonical shape', async () => {
    const fetchImpl = okFetch();
    const ok = await ensureAgentApproved({
      privyWalletId: 'w_test',
      privyWalletAddress: MASTER,
      fetchImpl,
    });
    expect(ok).toBe(true);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse((call[1] as { body: string }).body) as {
      action: Record<string, unknown>;
      nonce: number;
      signature: unknown;
    };
    expect(body.action['type']).toBe('approveAgent');
    expect(body.action['hyperliquidChain']).toBe('Mainnet');
    expect(body.action['signatureChainId']).toBe('0x66eee');
    expect(body.action['agentAddress']).toBe(getProcessAgent().address);
    // Unnamed agent — one replaceable slot per account.
    expect(body.action['agentName']).toBe('');
    // Inner nonce must equal the outer request nonce (HL replay rule).
    expect(body.action['nonce']).toBe(body.nonce);
    expect(body.signature).toBeTruthy();
  });

  it('approves once per master — second call is a cache hit, no second POST', async () => {
    const fetchImpl = okFetch();
    await ensureAgentApproved({ privyWalletId: 'w_test', privyWalletAddress: MASTER, fetchImpl });
    await ensureAgentApproved({ privyWalletId: 'w_test', privyWalletAddress: MASTER, fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('dedupes concurrent first-order approvals into one POST', async () => {
    let resolveFetch: (r: Response) => void = () => undefined;
    const gate = new Promise<Response>((r) => (resolveFetch = r));
    const fetchImpl = vi.fn(async () => gate) as unknown as typeof fetch;
    const p1 = ensureAgentApproved({ privyWalletId: 'w_test', privyWalletAddress: MASTER, fetchImpl });
    const p2 = ensureAgentApproved({ privyWalletId: 'w_test', privyWalletAddress: MASTER, fetchImpl });
    resolveFetch(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await Promise.all([p1, p2])).toEqual([true, true]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('fails OPEN (returns false, no throw) when the venue rejects the approval', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'err', response: 'nope' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const ok = await ensureAgentApproved({
      privyWalletId: 'w_test',
      privyWalletAddress: MASTER,
      fetchImpl,
    });
    expect(ok).toBe(false);
    // A rejected approval is NOT cached as approved — the next action retries.
    const fetchOk = okFetch();
    expect(
      await ensureAgentApproved({ privyWalletId: 'w_test', privyWalletAddress: MASTER, fetchImpl: fetchOk }),
    ).toBe(true);
  });
});

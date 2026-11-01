/**
 * Card-layer chain adapters — demo-mode unit tests.
 *
 * No card keys in CI (GNOSIS_PAY_API_KEY / SPONGE_API_KEY / BASE_RPC_URL all
 * unset), so the whole stack runs its demo fallback. We assert the demo contract
 * holds:
 *   - gnosisPay.orderVirtualCard → Visa, 4-char last4, demo:true, masked 5312 PAN
 *   - gnosisPay.getCard is deterministic + stable across calls
 *   - lifi.topUpCardCrossChain → demo:true with a 0xdemo… hash
 *   - sponge.createAgentCard → 4-char last4, demo:true
 *   - sponge.createAgentBankAccount → account + routing numbers, demo:true
 *
 * The live REST / 7702 paths are untestable without keys and are covered
 * structurally in each adapter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { gnosisPayAdapter } from './gnosisPay.js';
import { lifiAdapter } from './lifi.js';
import { spongeAdapter } from './sponge.js';

const DEMO_HASH = /^0xdemo[0-9a-f]{28}$/;

describe('GnosisPayAdapter — card layer, demo mode', () => {
  it('is not live without a Gnosis Pay key', () => {
    expect(gnosisPayAdapter.isLive).toBe(false);
  });

  it('orderVirtualCard returns a Visa card with a 4-digit last4, masked 5312 PAN, demo:true', async () => {
    const card = await gnosisPayAdapter.orderVirtualCard('u');
    expect(card.network).toBe('Visa');
    expect(card.last4).toHaveLength(4);
    expect(card.last4).toMatch(/^\d{4}$/);
    expect(card.demo).toBe(true);
    expect(card.pan.startsWith('5312')).toBe(true);
    expect(card.pan.endsWith(card.last4)).toBe(true);
  });

  it('getCard is deterministic and stable across two calls', async () => {
    const a = await gnosisPayAdapter.getCard('u');
    const b = await gnosisPayAdapter.getCard('u');
    expect(a).toEqual(b);
    expect(a.demo).toBe(true);
    expect(a.last4).toHaveLength(4);
    expect(a.safeAddress.startsWith('0x')).toBe(true);
    expect(a.safeAddress).toHaveLength(42);
    // Different users resolve to different cards.
    const other = await gnosisPayAdapter.getCard('v');
    expect(other.last4 === a.last4 && other.safeAddress === a.safeAddress).toBe(false);
  });

  it('deploySafe returns a stable 0x Safe address with demo:true', async () => {
    const a = await gnosisPayAdapter.deploySafe('u');
    const b = await gnosisPayAdapter.deploySafe('u');
    expect(a.demo).toBe(true);
    expect(a.safeAddress).toHaveLength(42);
    expect(a.safeAddress).toBe(b.safeAddress);
  });

  it('deploySafe sends the Safe deployment through the Gnosis chain executor path when live', async () => {
    const originalEnv = process.env;
    const sendCalls = vi.fn(async () => ({ txHash: '0xabc', demo: false, sponsored: true }));

    vi.resetModules();
    vi.doMock('./alchemy.js', () => ({ executor: { sendCalls } }));
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      GNOSIS_PAY_API_KEY: 'gp_test_key',
    };

    try {
      const { GnosisPayAdapter } = await import('./gnosisPay.js');
      const adapter = new GnosisPayAdapter();

      const res = await adapter.deploySafe('u');

      expect(res.demo).toBe(false);
      expect(sendCalls).toHaveBeenCalledWith('u', expect.any(Array), { chainId: 100 });
    } finally {
      process.env = originalEnv;
      vi.doUnmock('./alchemy.js');
      vi.resetModules();
    }
  });

  it('orderVirtualCard uses the current Gnosis Pay virtual-card endpoint', async () => {
    const originalEnv = process.env;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'card_1', lastFourDigits: '1234', virtual: true, statusCode: 1000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    vi.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      GNOSIS_PAY_API_KEY: 'gp_test_key',
    };

    try {
      const { GnosisPayAdapter } = await import('./gnosisPay.js');
      const adapter = new GnosisPayAdapter();

      const card = await adapter.orderVirtualCard('u');

      expect(card.demo).toBe(false);
      expect(card.last4).toBe('1234');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.gnosispay.com/api/v1/cards/virtual',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      process.env = originalEnv;
      vi.resetModules();
    }
  });

  it('orderVirtualCard forwards a caller-provided idempotency key', async () => {
    const originalEnv = process.env;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'card_1', lastFourDigits: '1234', virtual: true, statusCode: 1000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    vi.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      GNOSIS_PAY_API_KEY: 'gp_test_key',
    };

    try {
      const { GnosisPayAdapter } = await import('./gnosisPay.js');
      const adapter = new GnosisPayAdapter();

      await adapter.orderVirtualCard('u', { idempotencyKey: 'card-order:card:abc' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.gnosispay.com/api/v1/cards/virtual',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Idempotency-Key': 'card-order:card:abc' }),
        }),
      );
    } finally {
      process.env = originalEnv;
      vi.resetModules();
    }
  });

  it('getCardBalanceUsd and getCardTransactions return demo sample data', async () => {
    expect(await gnosisPayAdapter.getCardBalanceUsd('u')).toBeGreaterThan(0);
    const txns = await gnosisPayAdapter.getCardTransactions('u');
    expect(txns.length).toBeGreaterThan(0);
    expect(typeof txns[0].title).toBe('string');
    expect(typeof txns[0].amountUsd).toBe('number');
    expect(typeof txns[0].at).toBe('string');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LifiAdapter — cross-chain card top-up, demo mode', () => {
  it('topUpCardCrossChain returns a demo 0xdemo… hash', async () => {
    const r = await lifiAdapter.topUpCardCrossChain('u', 50);
    expect(r.demo).toBe(true);
    expect(r.txHash).toMatch(DEMO_HASH);
  });
});

describe('Sponge adapter — agent cards + accounts, demo mode', () => {
  it('is not enabled without a Sponge key', () => {
    expect(spongeAdapter.isSpongeEnabled()).toBe(false);
  });

  it('createAgentCard returns a 4-digit last4 with demo:true', async () => {
    const card = await spongeAdapter.createAgentCard('u', 'a');
    expect(card.last4).toHaveLength(4);
    expect(card.last4).toMatch(/^\d{4}$/);
    expect(card.demo).toBe(true);
    expect(typeof card.network).toBe('string');
  });

  it('createAgentCard is deterministic per (user, agent)', async () => {
    const a = await spongeAdapter.createAgentCard('u', 'a');
    const b = await spongeAdapter.createAgentCard('u', 'a');
    expect(a.last4).toBe(b.last4);
    const other = await spongeAdapter.createAgentCard('u', 'b');
    expect(other.last4 === a.last4).toBe(false);
  });

  it('createAgentBankAccount returns account + routing numbers with demo:true', async () => {
    const acct = await spongeAdapter.createAgentBankAccount('u', 'a');
    expect(acct.accountNumber).toMatch(/^\d{10}$/);
    expect(acct.routingNumber).toMatch(/^\d{9}$/);
    expect(acct.demo).toBe(true);
  });

  it('forwards idempotency keys on live card and bank-account creates', async () => {
    const originalEnv = process.env;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ last4: '1234', accountNumber: '1234567890', routingNumber: '021000021' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    vi.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      SPONGE_API_KEY: 'sp_test_key',
    };

    try {
      const { spongeAdapter: liveSponge } = await import('./sponge.js');
      await liveSponge.createAgentCard('u', 'a', { idempotencyKey: 'agent-card:abc' });
      await liveSponge.createAgentBankAccount('u', 'a', { idempotencyKey: 'agent-bank:abc' });

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://api.paysponge.com/v1/cards',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Idempotency-Key': 'agent-card:abc' }),
        }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'https://api.paysponge.com/v1/accounts',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Idempotency-Key': 'agent-bank:abc' }),
        }),
      );
    } finally {
      process.env = originalEnv;
      vi.resetModules();
    }
  });
});

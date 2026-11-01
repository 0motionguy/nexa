/**
 * Stack upgrades Phase 3 — x402 payee resolver.
 *
 * Verifies:
 *   - contract.payeeAddress wins when set (resolved by endpoint match)
 *   - fallback to the supplied selfAddress when no contract has a payee
 *   - URL-style endpoint vs path-style endpoint both normalize to the same
 *     contract row lookup
 *
 * Tests run against the singleton store (the resolver reads `store` at module
 * load and we don't want to fight the import graph). Each test uses unique
 * vendor emails + endpoint paths so contracts don't collide across tests.
 */

import { describe, expect, it } from 'vitest';
import { store } from '../store/index.js';
import { resolvePayeeAddress } from './x402-payee.js';

const FAKE_FALLBACK = '0xfb00000000000000000000000000000000000000';

let n = 0;
const uniqEmail = (): string => `payee-${++n}@test.co`;
const uniqPath = (): string => `/v1/payee-${++n}`;

describe('resolvePayeeAddress', () => {
  it('returns the contract payee_address when an endpoint path matches', async () => {
    const u = await store.upsertUserByEmail(uniqEmail(), 'Vendor');
    const path = uniqPath();
    const contract = await store.createContract(u, 'Premium feed', path, 'GET', 0.01, 'USDC');
    // Stamp the payee on the freshly-created row (the in-memory store hands
    // back a live reference, so this mutates the underlying contract).
    contract.payeeAddress = '0xC0FFEE000000000000000000000000000000C0FF';

    const result = await resolvePayeeAddress({
      endpoint: path,
      fallbackAddress: FAKE_FALLBACK,
    });
    expect(result.address).toBe('0xC0FFEE000000000000000000000000000000C0FF');
    expect(result.source).toBe('contract');
    expect(result.contractId).toBe(contract.id);
  });

  it('falls back to selfAddress when no contract has a payee_address', async () => {
    await store.upsertUserByEmail(uniqEmail(), 'NoPayee');
    const result = await resolvePayeeAddress({
      endpoint: uniqPath(),
      fallbackAddress: FAKE_FALLBACK,
    });
    expect(result.address).toBe(FAKE_FALLBACK);
    expect(result.source).toBe('fallback');
    expect(result.contractId).toBeNull();
  });

  it('normalizes a full URL endpoint to its pathname for contract lookup', async () => {
    const u = await store.upsertUserByEmail(uniqEmail(), 'FullUrlVendor');
    const path = uniqPath();
    const c = await store.createContract(u, 'Path-equal', path, 'GET', 0.01, 'USDC');
    c.payeeAddress = '0xDADA000000000000000000000000000000000DAD';
    const result = await resolvePayeeAddress({
      endpoint: `https://vendor.io${path}`,
      fallbackAddress: FAKE_FALLBACK,
    });
    expect(result.address).toBe('0xDADA000000000000000000000000000000000DAD');
    expect(result.source).toBe('contract');
  });

  it('returns fallback when the contract row exists but has no payee_address', async () => {
    const u = await store.upsertUserByEmail(uniqEmail(), 'BlankVendor');
    const path = uniqPath();
    await store.createContract(u, 'No-payee', path, 'GET', 0.01, 'USDC');
    const result = await resolvePayeeAddress({
      endpoint: path,
      fallbackAddress: FAKE_FALLBACK,
    });
    expect(result.address).toBe(FAKE_FALLBACK);
    expect(result.source).toBe('fallback');
  });
});

/**
 * Budget unit specs. The global slot behaviour is pinned by realtime.spec.ts;
 * these cover the per-user / per-IP sub-budgets added by the 2026-07-16
 * readiness audit: acquire→cap→release symmetry, cross-key isolation, and
 * reset hygiene between suites.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../lib/env.js';
import {
  activeIpSlots,
  activeUserSlots,
  releaseIpSlot,
  releaseUserSlot,
  resetRealtimeBudget,
  tryAcquireIpSlot,
  tryAcquireUserSlot,
} from './capacity.js';

afterEach(() => resetRealtimeBudget());

describe('capacity — per-user budget', () => {
  it('caps one user at REALTIME_MAX_CONNS_PER_USER and frees on release', () => {
    const cap = env.REALTIME_MAX_CONNS_PER_USER;
    for (let i = 0; i < cap; i++) expect(tryAcquireUserSlot('u1')).toBe(true);
    expect(tryAcquireUserSlot('u1')).toBe(false);
    // Other users are unaffected by u1 being at cap.
    expect(tryAcquireUserSlot('u2')).toBe(true);
    releaseUserSlot('u1');
    expect(tryAcquireUserSlot('u1')).toBe(true);
    expect(activeUserSlots('u1')).toBe(cap);
  });

  it('release floors at zero and evicts the map entry (no unbounded growth)', () => {
    releaseUserSlot('ghost'); // release-without-acquire must not go negative
    expect(activeUserSlots('ghost')).toBe(0);
    expect(tryAcquireUserSlot('ghost')).toBe(true);
    releaseUserSlot('ghost');
    expect(activeUserSlots('ghost')).toBe(0);
  });
});

describe('capacity — per-IP budget', () => {
  it('caps one source IP at REALTIME_MAX_CONNS_PER_IP independently of users', () => {
    const cap = env.REALTIME_MAX_CONNS_PER_IP;
    for (let i = 0; i < cap; i++) expect(tryAcquireIpSlot('10.0.0.1')).toBe(true);
    expect(tryAcquireIpSlot('10.0.0.1')).toBe(false);
    expect(tryAcquireIpSlot('10.0.0.2')).toBe(true);
    releaseIpSlot('10.0.0.1');
    expect(tryAcquireIpSlot('10.0.0.1')).toBe(true);
    expect(activeIpSlots('10.0.0.1')).toBe(cap);
  });

  it('resetRealtimeBudget clears the sub-budgets (suite isolation)', () => {
    tryAcquireUserSlot('u1');
    tryAcquireIpSlot('10.0.0.1');
    resetRealtimeBudget();
    expect(activeUserSlots('u1')).toBe(0);
    expect(activeIpSlots('10.0.0.1')).toBe(0);
  });
});

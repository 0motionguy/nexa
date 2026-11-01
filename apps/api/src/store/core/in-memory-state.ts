/**
 * InMemoryState — the user-store kernel for the in-memory implementation.
 *
 * The in-memory store keeps every user as a live mutable object inside a Map
 * keyed by id (and a second Map indexed by email). Every domain module reads
 * those Maps via this shared kernel so they all see the same live state.
 *
 * Mirrors LedgerStateManager (postgres/core/ledger-state.ts) in role but
 * not in shape — the postgres kernel speaks Drizzle, this one speaks Maps.
 */

import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { type Activity, type User } from '../types.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function seedUser(email: string, name: string, opts: { privyDid?: string | null } = {}): User {
  return {
    id: randomUUID(),
    email,
    name,
    privyDid: opts.privyDid ?? null,
    privyWalletId: null,
    privyWalletAddress: null,
    hlBuilderApprovedAt: null,
    hlBuilderMaxFeeTenthsBp: null,
    pmClobKey: null,
    pmClobSecret: null,
    pmClobPassphrase: null,
    privySolWalletId: null,
    privySolWalletAddress: null,
    cohort: null,
    balUsd: 4820.4,
    eurUsd: 0,
    sandboxBalUsd: 0,
    earnUsd: 3200,
    earnApy: 0.084,
    cardFrozen: false,
    cardDayLimitUsd: 500,
    killSwitch: false,
    kycStatus: 'verified',
    bridgeCustomerId: null,
    earnByDefault: false,
    autoDivestOnSpend: false,
    divestThresholdUsd: 50,
    virtualAccounts: [
      {
        id: randomUUID(),
        currency: 'USD',
        routingNumber: '101019644',
        accountNumber: '8841 2940 7841',
        iban: null,
        bic: null,
        bankName: 'Lead Bank',
        livemode: true,
        createdAt: nowIso(),
      },
      {
        id: randomUUID(),
        currency: 'EUR',
        routingNumber: null,
        accountNumber: null,
        iban: 'GB29 NWBK 6016 1331 9268 19',
        bic: 'MONZGB2L',
        bankName: 'Monerium EMI',
        livemode: true,
        createdAt: nowIso(),
      },
    ],
    activity: [
      {
        id: randomUUID(),
        n: 'Salary · Acme Studio',
        s: 'ACH · TODAY',
        a: '+$2,400.00',
        k: 'in',
        pos: true,
        logo: 'S',
        at: nowIso(),
      },
      { id: randomUUID(), n: 'api.exa.ai', s: 'AGENT · POLICY OK', a: '-$0.12', k: 'x402', logo: 'AI', at: nowIso() },
    ],
    agents: [
      {
        id: randomUUID(),
        name: 'ResearchBot-01',
        role: 'Data procurement',
        balanceUsd: 36.8,
        spentTodayUsd: 13.2,
        policy: {
          perTxCapUsd: 1,
          perDayCapUsd: 50,
          endpointAllowlist: ['api.exa.ai', 'weather.api'],
          humanApprovalThresholdUsd: 1,
          expiresAt: null,
        },
        state: 'live',
        createdAt: nowIso(),
      },
      {
        id: randomUUID(),
        name: 'OpsAgent-02',
        role: 'Operations',
        balanceUsd: 25,
        spentTodayUsd: 0,
        policy: {
          perTxCapUsd: 25,
          perDayCapUsd: 25,
          endpointAllowlist: [],
          humanApprovalThresholdUsd: 25,
          expiresAt: null,
        },
        state: 'review',
        createdAt: nowIso(),
      },
    ],
    contracts: [
      {
        id: randomUUID(),
        name: 'Clip analytics',
        endpointPath: '/v1/clip-analytics',
        method: 'GET',
        priceUsd: 0.003,
        currency: 'USDC',
        status: 'live',
        requestsToday: 18402,
        revenueTodayUsd: 55.2,
        paidSuccessRate: 0.987,
      },
    ],
    x402Events: [],
  };
}

/**
 * Shared kernel — every domain module receives this via constructor.
 * Owns the Maps; modules read/write through them.
 */
export class InMemoryState {
  readonly usersById = new Map<string, User>();
  readonly usersByEmail = new Map<string, string>();

  constructor(public readonly bus: EventEmitter) {}

  async pushActivity(u: User, row: Omit<Activity, 'id' | 'at'>): Promise<Activity> {
    const full: Activity = { ...row, id: randomUUID(), at: nowIso() };
    u.activity.unshift(full);
    this.bus.emit('activity', u.id, full);
    return full;
  }
}

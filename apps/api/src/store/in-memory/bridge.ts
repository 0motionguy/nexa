/**
 * InMemoryBridge — Bridge.xyz state mirror.
 *
 * Virtual accounts live on User.virtualAccounts; bridge customer ids are
 * resolved via a side Map. Transfers + payout methods live in side Maps.
 * Cross-domain: applyBridgeDeposit + the refund paths call ledger.topUp.
 */

import { randomUUID } from 'node:crypto';
import {
  type BridgeTransfer,
  type PayoutMethod,
  type PayoutMethodType,
  PolicyError,
  type SessionUser,
  type User,
  type VirtualAccount,
} from '../types.js';
import type { InMemoryState } from '../core/in-memory-state.js';
import type { InMemoryLedger } from './ledger.js';
import { money, nowIso } from './_shared.js';

export class InMemoryBridge {
  private bridgeCustomerToUserId = new Map<string, string>();
  private bridgeWebhookRefs = new Set<string>();
  private payoutMethodsById = new Map<string, PayoutMethod>();
  private bridgeTransfersById = new Map<string, BridgeTransfer>();
  private bridgeTransferByExternalRef = new Map<string, string>();
  private bridgeTransferByIdempotencyKey = new Map<string, string>();

  constructor(
    private state: InMemoryState,
    private ledger: InMemoryLedger,
  ) {}

  /** Scale wave 3 — resolve the canonical map object; snapshot writes are lost. */
  private full(u: SessionUser) {
    const row = this.state.usersById.get(u.id);
    if (!row) throw new Error('user_not_found');
    return row;
  }

  async setBridgeCustomer(u: SessionUser, customerId: string): Promise<void> {
    this.full(u).bridgeCustomerId = customerId;
    u.bridgeCustomerId = customerId;
    this.bridgeCustomerToUserId.set(customerId, u.id);
  }

  async saveVirtualAccount(
    u: SessionUser,
    va: Omit<VirtualAccount, 'id' | 'createdAt'>,
  ): Promise<VirtualAccount> {
    const full: VirtualAccount = { ...va, id: randomUUID(), createdAt: nowIso() };
    this.full(u).virtualAccounts.push(full);
    return full;
  }

  async listVirtualAccounts(u: SessionUser): Promise<VirtualAccount[]> {
    return this.full(u).virtualAccounts;
  }

  async userForBridgeCustomer(customerId: string): Promise<User | null> {
    const id = this.bridgeCustomerToUserId.get(customerId);
    return id ? (this.state.usersById.get(id) ?? null) : null;
  }

  async applyBridgeDeposit(customerId: string, amountUsd: number, eventRef: string): Promise<boolean> {
    // Sprint 13 COMMIT 3 — postgres-parity amount guard. Negative or zero
    // amounts are silently dropped instead of double-debiting via topUp.
    if (!(amountUsd > 0)) return false;
    // Sprint 13 COMMIT 3 — close the idempotency race. The previous
    // `has(eventRef)` → `await topUp` → `add(eventRef)` opened a window where
    // two concurrent webhooks both pass `.has()` and double-credit. Claim
    // the ref SYNCHRONOUSLY before any await; release it only if topUp throws
    // or the customer lookup fails.
    if (this.bridgeWebhookRefs.has(eventRef)) return false;
    this.bridgeWebhookRefs.add(eventRef);
    try {
      const user = await this.userForBridgeCustomer(customerId);
      if (!user) {
        this.bridgeWebhookRefs.delete(eventRef);
        return false;
      }
      await this.ledger.topUp(user, amountUsd, 'Deposit · Bank transfer');
      return true;
    } catch (e) {
      this.bridgeWebhookRefs.delete(eventRef);
      throw e;
    }
  }

  /* ── Bridge offramp ── */

  async savePayoutMethod(
    u: SessionUser,
    input: {
      type: PayoutMethodType;
      externalAccountId: string;
      label: string;
      livemode: boolean;
    },
  ): Promise<PayoutMethod> {
    const method: PayoutMethod = {
      id: randomUUID(),
      userId: u.id,
      type: input.type,
      externalAccountId: input.externalAccountId,
      label: input.label,
      status: 'active',
      livemode: input.livemode,
      createdAt: nowIso(),
    };
    this.payoutMethodsById.set(method.id, method);
    return method;
  }

  async listPayoutMethods(u: SessionUser): Promise<PayoutMethod[]> {
    return [...this.payoutMethodsById.values()]
      .filter((m) => m.userId === u.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async createBridgeTransfer(
    u: SessionUser,
    input: { payoutMethodId: string; amountUsd: number; externalRef: string | null },
  ): Promise<BridgeTransfer> {
    const transfer: BridgeTransfer = {
      id: randomUUID(),
      userId: u.id,
      payoutMethodId: input.payoutMethodId,
      amountUsd: input.amountUsd,
      status: 'pending',
      externalRef: input.externalRef,
      createdAt: nowIso(),
    };
    this.bridgeTransfersById.set(transfer.id, transfer);
    if (input.externalRef) {
      this.bridgeTransferByExternalRef.set(input.externalRef, transfer.id);
    }
    return transfer;
  }

  async createBridgeTransferDebit(
    u: SessionUser,
    input: { payoutMethodId: string; amountUsd: number; idempotencyKey: string; label: string },
  ): Promise<{ transfer: BridgeTransfer; fresh: boolean }> {
    const idemKey = `${u.id}:${input.idempotencyKey}`;
    const priorId = this.bridgeTransferByIdempotencyKey.get(idemKey);
    if (priorId) {
      const prior = this.bridgeTransfersById.get(priorId);
      if (prior) return { transfer: prior, fresh: false };
    }

    const live = this.state.usersById.get(u.id);
    if (!live) throw new Error('user_not_found');
    await this.ledger.autoDivestIfNeeded(live, input.amountUsd);
    if (input.amountUsd > live.balUsd) {
      throw new PolicyError('insufficient_funds', 'Not enough balance.');
    }
    live.balUsd -= input.amountUsd;
    u.balUsd = live.balUsd;
    u.earnUsd = live.earnUsd;
    await this.state.pushActivity(live, {
      n: 'Sent · ' + input.label,
      s: 'BANK TRANSFER · JUST NOW',
      a: '−' + money(input.amountUsd),
      k: 'out',
    });

    const transfer: BridgeTransfer = {
      id: randomUUID(),
      userId: u.id,
      payoutMethodId: input.payoutMethodId,
      amountUsd: input.amountUsd,
      status: 'pending',
      externalRef: null,
      createdAt: nowIso(),
    };
    this.bridgeTransfersById.set(transfer.id, transfer);
    this.bridgeTransferByIdempotencyKey.set(idemKey, transfer.id);
    return { transfer, fresh: true };
  }

  async setBridgeTransferExternalRef(id: string, externalRef: string): Promise<BridgeTransfer> {
    const transfer = this.bridgeTransfersById.get(id);
    if (!transfer) throw new Error('bridge_transfer_not_found');
    transfer.externalRef = externalRef;
    this.bridgeTransferByExternalRef.set(externalRef, transfer.id);
    return transfer;
  }

  async failBridgeTransferById(id: string): Promise<BridgeTransfer | null> {
    const transfer = this.bridgeTransfersById.get(id);
    if (!transfer) return null;
    if (transfer.status === 'failed' || transfer.status === 'completed') return null;
    const user = this.state.usersById.get(transfer.userId);
    if (user) {
      await this.ledger.topUp(user, transfer.amountUsd, 'Refund · Bridge unavailable');
    }
    transfer.status = 'failed';
    return transfer;
  }

  async markTransferStatus(
    externalRef: string,
    status: 'completed' | 'failed',
    expected?: { amountUsd?: number; externalAccountId?: string | null },
  ): Promise<BridgeTransfer | null> {
    const id = this.bridgeTransferByExternalRef.get(externalRef);
    if (!id) return null;
    const transfer = this.bridgeTransfersById.get(id);
    if (!transfer) return null;
    if (expected?.amountUsd !== undefined && Math.abs(transfer.amountUsd - expected.amountUsd) > 0.005) {
      return null;
    }
    if (expected?.externalAccountId) {
      const method = this.payoutMethodsById.get(transfer.payoutMethodId);
      if (!method || method.externalAccountId !== expected.externalAccountId) return null;
    }
    if (transfer.status !== 'pending') return null;
    if (status === 'failed') {
      const user = this.state.usersById.get(transfer.userId);
      if (user) {
        await this.ledger.topUp(user, transfer.amountUsd, 'Refund · Transfer failed');
      }
    }
    transfer.status = status;
    return transfer;
  }

  async userForBridgeTransfer(externalRef: string): Promise<User | null> {
    const id = this.bridgeTransferByExternalRef.get(externalRef);
    if (!id) return null;
    const transfer = this.bridgeTransfersById.get(id);
    if (!transfer) return null;
    return this.state.usersById.get(transfer.userId) ?? null;
  }

  /* ── dispose helper for the facade ── */
  clearAll(): void {
    this.bridgeCustomerToUserId.clear();
    this.bridgeWebhookRefs.clear();
    this.payoutMethodsById.clear();
    this.bridgeTransfersById.clear();
    this.bridgeTransferByExternalRef.clear();
    this.bridgeTransferByIdempotencyKey.clear();
  }
}

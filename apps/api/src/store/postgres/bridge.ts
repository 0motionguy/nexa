/**
 * PgBridge — Bridge.xyz compliance perimeter (real money in/out).
 *
 * Virtual accounts, payout methods, transfers (deposit/withdraw), and the
 * webhook side of the integration.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  nbBridgeTransfers,
  nbBridgeWebhookEvents,
  nbPayoutMethods,
  nbTransactions,
  nbUsers,
  nbVirtualAccounts,
} from '../../db/schema/index.js';
import {
  type Activity,
  type BridgeTransfer,
  type PayoutMethod,
  type PayoutMethodType,
  PolicyError,
  type SessionUser,
  type User,
  type VirtualAccount,
} from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';
import type { PgAuth } from './auth.js';
import type { LockedAutoDivestResult, PgLedger } from './ledger.js';
import { log } from '../../lib/log.js';
import {
  bridgeTransferFromRow,
  money,
  n,
  payoutMethodFromRow,
  virtualAccountFromRow,
} from './_shared.js';

export class PgBridge {
  constructor(
    private db: Db,
    private core: LedgerStateManager,
    private auth: PgAuth,
    /**
     * Sprint 13 COMMIT 1 — route the deposit credit + spend auto-divest
     * through PgLedger so earnByDefault auto-tail and the chain mirror fire.
     * Without this, applyBridgeDeposit + createBridgeTransferDebit mutated
     * state inline and skipped the mirror entirely.
     */
    private ledger: PgLedger,
  ) {}

  async setBridgeCustomer(u: SessionUser, customerId: string): Promise<void> {
    await this.db
      .update(nbUsers)
      .set({ bridgeCustomerId: customerId })
      .where(eq(nbUsers.id, u.id));
    u.bridgeCustomerId = customerId;
    await this.core.invalidateUser(u.id);
  }

  async saveVirtualAccount(
    u: SessionUser,
    va: Omit<VirtualAccount, 'id' | 'createdAt'>,
  ): Promise<VirtualAccount> {
    const id = randomUUID();
    const at = new Date();
    const [row] = await this.db
      .insert(nbVirtualAccounts)
      .values({
        id,
        userId: u.id,
        currency: va.currency,
        routingNumber: va.routingNumber,
        accountNumber: va.accountNumber,
        iban: va.iban,
        bic: va.bic,
        bankName: va.bankName,
        livemode: va.livemode,
        createdAt: at,
      })
      .returning();
    await this.core.invalidateUser(u.id);
    return virtualAccountFromRow(row!);
  }

  async listVirtualAccounts(u: SessionUser): Promise<VirtualAccount[]> {
    const rows = await this.db
      .select()
      .from(nbVirtualAccounts)
      .where(eq(nbVirtualAccounts.userId, u.id))
      .orderBy(desc(nbVirtualAccounts.createdAt));
    return rows.map(virtualAccountFromRow);
  }

  async userForBridgeCustomer(customerId: string): Promise<User | null> {
    const [row] = await this.db
      .select({ id: nbUsers.id })
      .from(nbUsers)
      .where(eq(nbUsers.bridgeCustomerId, customerId))
      .limit(1);
    if (!row) return null;
    try {
      return await this.auth.user(row.id);
    } catch {
      return null;
    }
  }

  async applyBridgeDeposit(customerId: string, amountUsd: number, eventRef: string): Promise<boolean> {
    if (!(amountUsd > 0)) return false;

    // Sprint 13 COMMIT 1 — claim the eventRef row idempotently first (its own
    // short tx), then route the credit through PgLedger.topUp so earnByDefault
    // auto-tail + chain mirror fire. The Bridge webhook row itself is the
    // idempotency lock — if topUp throws we keep the row so a retry doesn't
    // double-credit, but log it loud.
    let userId = '';
    await this.db.transaction(async (tx) => {
      const [userRow] = await tx
        .select({ id: nbUsers.id })
        .from(nbUsers)
        .where(eq(nbUsers.bridgeCustomerId, customerId))
        .for('update');
      if (!userRow) return;
      userId = userRow.id;

      const [inserted] = await tx
        .insert(nbBridgeWebhookEvents)
        .values({
          ref: eventRef,
          userId,
          customerId,
          amountUsd: amountUsd.toFixed(6),
        })
        .onConflictDoNothing()
        .returning({ ref: nbBridgeWebhookEvents.ref });
      if (!inserted) {
        // Replay of an already-consumed eventRef: signal nothing happened.
        userId = '';
      }
    });

    if (!userId) return false;

    const user = await this.auth.user(userId);
    try {
      await this.ledger.topUp(user, amountUsd, 'Deposit · Bank transfer');
    } catch (e) {
      await this.db
        .delete(nbBridgeWebhookEvents)
        .where(eq(nbBridgeWebhookEvents.ref, eventRef))
        .catch((err) => {
          log.error(
            {
              eventRef,
              err: err instanceof Error ? err.message : String(err),
            },
            'bridge: failed to release deposit replay marker after credit failure',
          );
        });
      throw e;
    }
    return true;
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
    const [row] = await this.db
      .insert(nbPayoutMethods)
      .values({
        userId: u.id,
        type: input.type,
        externalAccountId: input.externalAccountId,
        label: input.label,
        status: 'active',
        livemode: input.livemode,
      })
      .returning();
    return payoutMethodFromRow(row!);
  }

  async listPayoutMethods(u: SessionUser): Promise<PayoutMethod[]> {
    const rows = await this.db
      .select()
      .from(nbPayoutMethods)
      .where(eq(nbPayoutMethods.userId, u.id))
      .orderBy(desc(nbPayoutMethods.createdAt));
    return rows.map(payoutMethodFromRow);
  }

  async createBridgeTransfer(
    u: SessionUser,
    input: { payoutMethodId: string; amountUsd: number; externalRef: string | null },
  ): Promise<BridgeTransfer> {
    const [row] = await this.db
      .insert(nbBridgeTransfers)
      .values({
        userId: u.id,
        payoutMethodId: input.payoutMethodId,
        amountUsd: input.amountUsd.toFixed(6),
        status: 'pending',
        externalRef: input.externalRef,
      })
      .returning();
    return bridgeTransferFromRow(row!);
  }

  async createBridgeTransferDebit(
    u: SessionUser,
    input: { payoutMethodId: string; amountUsd: number; idempotencyKey: string; label: string },
  ): Promise<{ transfer: BridgeTransfer; fresh: boolean }> {
    let activity: Activity | null = null;
    let autoDivest: LockedAutoDivestResult = null;
    let result!: { transfer: BridgeTransfer; fresh: boolean };

    const [existingBeforeDivest] = await this.db
      .select()
      .from(nbBridgeTransfers)
      .where(
        and(
          eq(nbBridgeTransfers.userId, u.id),
          eq(nbBridgeTransfers.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existingBeforeDivest) {
      return { transfer: bridgeTransferFromRow(existingBeforeDivest), fresh: false };
    }

    // Claim the idempotency row before auto-divest so same-key races cannot
    // withdraw from Earn twice while only one transfer is recorded.
    await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(nbBridgeTransfers)
        .values({
          userId: u.id,
          payoutMethodId: input.payoutMethodId,
          amountUsd: input.amountUsd.toFixed(6),
          status: 'pending',
          externalRef: null,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({
          target: [nbBridgeTransfers.userId, nbBridgeTransfers.idempotencyKey],
        })
        .returning();

      if (!inserted) {
        const [prior] = await tx
          .select()
          .from(nbBridgeTransfers)
          .where(
            and(
              eq(nbBridgeTransfers.userId, u.id),
              eq(nbBridgeTransfers.idempotencyKey, input.idempotencyKey),
            ),
          )
          .for('update');
        if (!prior) throw new Error('bridge_transfer_idempotency_conflict');
        result = { transfer: bridgeTransferFromRow(prior), fresh: false };
        return;
      }

      const state = await this.core.lockUserState(tx, u.id);
      autoDivest = await this.ledger.autoDivestLocked(tx, u, state, input.amountUsd);
      if (input.amountUsd > state.balUsd) {
        throw new PolicyError('insufficient_funds', 'Not enough balance.');
      }
      state.balUsd -= input.amountUsd;
      await this.core.writeUserState(tx, u.id, state);

      const txId = randomUUID();
      const at = new Date();
      const title = 'Sent - ' + input.label;
      await tx.insert(nbTransactions).values({
        id: txId,
        userId: u.id,
        kind: 'out',
        status: 'confirmed',
        title,
        subtitle: 'BANK TRANSFER - JUST NOW',
        amountUsd: input.amountUsd.toFixed(6),
        counterparty: input.label,
        createdAt: at,
      });
      activity = {
        id: txId,
        n: title,
        s: 'BANK TRANSFER - JUST NOW',
        a: '-' + money(input.amountUsd),
        k: 'out',
        at: at.toISOString(),
      };
      u.balUsd = state.balUsd;
      u.earnUsd = state.earnUsd;
      result = { transfer: bridgeTransferFromRow(inserted), fresh: true };
    });

    if (result.fresh && activity) {
      await this.core.invalidateUser(u.id);
      this.ledger.emitLockedAutoDivest(u, autoDivest);
      this.core.emitActivity(u.id, activity);
    }
    return result;
  }

  async setBridgeTransferExternalRef(id: string, externalRef: string): Promise<BridgeTransfer> {
    const [row] = await this.db
      .update(nbBridgeTransfers)
      .set({ externalRef })
      .where(eq(nbBridgeTransfers.id, id))
      .returning();
    if (!row) throw new Error('bridge_transfer_not_found');
    return bridgeTransferFromRow(row);
  }

  async failBridgeTransferById(id: string): Promise<BridgeTransfer | null> {
    let refundActivity: Activity | null = null;
    let refundUserId = '';
    let result: BridgeTransfer | null = null;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(nbBridgeTransfers)
        .where(eq(nbBridgeTransfers.id, id))
        .for('update');
      if (!row) return;
      if (row.status === 'failed' || row.status === 'completed') return;

      await tx.update(nbBridgeTransfers).set({ status: 'failed' }).where(eq(nbBridgeTransfers.id, id));

      const amountUsd = n(row.amountUsd);
      const state = await this.core.lockUserState(tx, row.userId);
      state.balUsd += amountUsd;
      await this.core.writeUserState(tx, row.userId, state);

      const txId = randomUUID();
      const at = new Date();
      const title = 'Refund - Bridge unavailable';
      await tx.insert(nbTransactions).values({
        id: txId,
        userId: row.userId,
        kind: 'in',
        status: 'confirmed',
        title,
        subtitle: 'BANK TRANSFER - JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        createdAt: at,
      });
      refundActivity = {
        id: txId,
        n: title,
        s: 'BANK TRANSFER - JUST NOW',
        a: '+' + money(amountUsd),
        pos: true,
        k: 'in',
        at: at.toISOString(),
      };
      refundUserId = row.userId;
      result = bridgeTransferFromRow({ ...row, status: 'failed' });
    });

    if (refundUserId && refundActivity) {
      await this.core.invalidateUser(refundUserId);
      this.core.emitActivity(refundUserId, refundActivity);
    }
    return result;
  }

  async markTransferStatus(
    externalRef: string,
    status: 'completed' | 'failed',
    expected?: { amountUsd?: number; externalAccountId?: string | null },
  ): Promise<BridgeTransfer | null> {
    let refundActivity: Activity | null = null;
    let refundUserId = '';
    let result: BridgeTransfer | null = null;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(nbBridgeTransfers)
        .where(eq(nbBridgeTransfers.externalRef, externalRef))
        .for('update');
      if (!row) return;
      if (expected?.amountUsd !== undefined && Math.abs(n(row.amountUsd) - expected.amountUsd) > 0.005) {
        return;
      }
      if (expected?.externalAccountId) {
        const [method] = await tx
          .select({ externalAccountId: nbPayoutMethods.externalAccountId })
          .from(nbPayoutMethods)
          .where(eq(nbPayoutMethods.id, row.payoutMethodId))
          .limit(1);
        if (!method || method.externalAccountId !== expected.externalAccountId) {
          return;
        }
      }
      // Idempotent replay or late contradictory provider events: terminal rows
      // never transition again, so callers skip side effects.
      if (row.status !== 'pending') {
        return;
      }
      await tx
        .update(nbBridgeTransfers)
        .set({ status })
        .where(eq(nbBridgeTransfers.id, row.id));

      // Fresh 'failed' → credit the user's balance back.
      if (status === 'failed') {
        const amountUsd = n(row.amountUsd);
        const state = await this.core.lockUserState(tx, row.userId);
        state.balUsd += amountUsd;
        await this.core.writeUserState(tx, row.userId, state);

        const txId = randomUUID();
        const at = new Date();
        const title = 'Refund · Transfer failed';
        await tx.insert(nbTransactions).values({
          id: txId,
          userId: row.userId,
          kind: 'in',
          status: 'confirmed',
          title,
          subtitle: 'BANK TRANSFER · JUST NOW',
          amountUsd: amountUsd.toFixed(6),
          createdAt: at,
        });
        refundActivity = {
          id: txId,
          n: title,
          s: 'BANK TRANSFER · JUST NOW',
          a: '+' + money(amountUsd),
          pos: true,
          k: 'in',
          at: at.toISOString(),
        };
        refundUserId = row.userId;
      }

      result = bridgeTransferFromRow({ ...row, status });
    });

    if (refundUserId && refundActivity) {
      await this.core.invalidateUser(refundUserId);
      this.core.emitActivity(refundUserId, refundActivity);
    }
    return result;
  }

  async userForBridgeTransfer(externalRef: string): Promise<User | null> {
    const [row] = await this.db
      .select({ userId: nbBridgeTransfers.userId })
      .from(nbBridgeTransfers)
      .where(eq(nbBridgeTransfers.externalRef, externalRef))
      .limit(1);
    if (!row) return null;
    try {
      return await this.auth.user(row.userId);
    } catch {
      return null;
    }
  }
}

/**
 * PgClaims — email-claim escrow (pregenerated wallets + 30-day expiry).
 *
 * recordClaim + getClaim + claimFunds + listClaims + expireClaimsBefore.
 * Cross-domain: needs PgAuth's upsert-by-email for the recipient lookup in
 * claimFunds, and LedgerStateManager for credit + activity emission.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nbClaimWallets, nbTransactions } from '../../db/schema/index.js';
import { createPregeneratedWallet } from '../../lib/chain/privy-claim.js';
import { type Activity, type ClaimRecord, type ClaimSendResult, PolicyError, type SessionUser, type User } from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';
import type { PgAuth } from './auth.js';
import type { PgLedger } from './ledger.js';
import { claimFromRow, money, n } from './_shared.js';

type TransactionRow = typeof nbTransactions.$inferSelect;

function idempotencyTag(key?: string | null): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return `send:${createHash('sha256').update(trimmed).digest('hex')}`;
}

function activityFromTx(row: TransactionRow): Activity {
  return {
    id: row.id,
    n: row.title,
    s: row.subtitle ?? '',
    a: '-' + money(Math.abs(Number(row.amountUsd))),
    k: 'out',
    at: row.createdAt.toISOString(),
    status: row.status,
    signer: row.counterparty ?? undefined,
    txHash: row.txHash ?? undefined,
    chain: row.chain ?? undefined,
  };
}

export class PgClaims {
  constructor(
    private db: Db,
    private core: LedgerStateManager,
    private auth: PgAuth,
    /**
     * Sprint 13 COMMIT 1 — claimFunds + expireClaimsBefore credit recipients
     * via PgLedger.topUp so earnByDefault auto-tail + chain mirror fire. The
     * prior inline state mutations skipped the mirror.
     */
    private ledger: PgLedger,
  ) {}

  async recordClaim(u: SessionUser, email: string, amountUsd: number): Promise<ClaimRecord> {
    // send() already debited the sender — we only park the escrow row here.
    const norm = email.trim().toLowerCase();
    const walletAddress = await createPregeneratedWallet(norm);
    const id = randomUUID();
    const slug = randomBytes(4).toString('hex');
    const at = new Date();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const [row] = await this.db
      .insert(nbClaimWallets)
      .values({
        id,
        slug,
        email: norm,
        // The column is NOT NULL; the mock adapter always returns an address, but
        // guard with empty string in the impossible null case.
        walletAddress: walletAddress ?? '',
        amountUsd: amountUsd.toFixed(6),
        status: 'pending',
        senderUserId: u.id,
        senderName: u.name,
        claimedAt: null,
        expiresAt,
        createdAt: at,
      })
      .returning();
    return claimFromRow(row!);
  }

  async sendClaim(
    u: SessionUser,
    amountUsd: number,
    email: string,
    opts?: { idempotencyKey?: string | null },
  ): Promise<ClaimSendResult> {
    if (!(amountUsd >= 1)) throw new PolicyError('insufficient_funds', 'Minimum send is $1.');
    const norm = email.trim().toLowerCase();
    const idem = idempotencyTag(opts?.idempotencyKey);
    if (idem) {
      const [existing] = await this.db
        .select()
        .from(nbTransactions)
        .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
        .limit(1);
      if (existing) {
        const slug = existing.chain?.startsWith('claim:') ? existing.chain.slice('claim:'.length) : null;
        const [claimRow] = slug
          ? await this.db.select().from(nbClaimWallets).where(eq(nbClaimWallets.slug, slug)).limit(1)
          : [];
        if (
          (existing.counterparty ?? '').trim().toLowerCase() !== norm ||
          Math.abs(Number(existing.amountUsd) - amountUsd) > 0.005 ||
          !claimRow
        ) {
          throw new Error('idempotency_key_reused');
        }
        return { claim: true, activity: activityFromTx(existing), claimRecord: claimFromRow(claimRow), fresh: false };
      }
    }

    await this.ledger.autoDivestIfNeeded(u, amountUsd);

    let activity!: Activity;
    let claimRecord!: ClaimRecord;
    let fresh = true;
    await this.db.transaction(async (tx) => {
      const state = await this.core.lockUserState(tx, u.id);
      if (idem) {
        const [existing] = await tx
          .select()
          .from(nbTransactions)
          .where(and(eq(nbTransactions.userId, u.id), eq(nbTransactions.txHash, idem)))
          .limit(1);
        if (existing) {
          const slug = existing.chain?.startsWith('claim:') ? existing.chain.slice('claim:'.length) : null;
          const [claimRow] = slug
            ? await tx.select().from(nbClaimWallets).where(eq(nbClaimWallets.slug, slug)).limit(1)
            : [];
          if (
            (existing.counterparty ?? '').trim().toLowerCase() !== norm ||
            Math.abs(Number(existing.amountUsd) - amountUsd) > 0.005 ||
            !claimRow
          ) {
            throw new Error('idempotency_key_reused');
          }
          activity = activityFromTx(existing);
          claimRecord = claimFromRow(claimRow);
          fresh = false;
          u.balUsd = state.balUsd;
          return;
        }
      }
      if (amountUsd > state.balUsd)
        throw new PolicyError('insufficient_funds', 'Not enough balance.');
      const walletAddress = await createPregeneratedWallet(norm);
      state.balUsd -= amountUsd;
      await this.core.writeUserState(tx, u.id, state);

      const txId = randomUUID();
      const claimId = randomUUID();
      const slug = randomBytes(4).toString('hex');
      const at = new Date();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await tx.insert(nbTransactions).values({
        id: txId,
        userId: u.id,
        kind: 'out',
        status: 'confirmed',
        title: 'Sent · ' + email,
        subtitle: 'CLAIM PENDING · JUST NOW',
        amountUsd: amountUsd.toFixed(6),
        counterparty: email,
        txHash: idem ?? undefined,
        chain: `claim:${slug}`,
        createdAt: at,
      });
      const [row] = await tx
        .insert(nbClaimWallets)
        .values({
          id: claimId,
          slug,
          email: norm,
          walletAddress: walletAddress ?? '',
          amountUsd: amountUsd.toFixed(6),
          status: 'pending',
          senderUserId: u.id,
          senderName: u.name,
          claimedAt: null,
          expiresAt,
          createdAt: at,
        })
        .returning();

      activity = {
        id: txId,
        n: 'Sent · ' + email,
        s: 'CLAIM PENDING · JUST NOW',
        a: '−' + money(amountUsd),
        k: 'out',
        signer: norm,
        chain: `claim:${slug}`,
        ...(idem ? { txHash: idem } : {}),
        at: at.toISOString(),
      };
      claimRecord = claimFromRow(row!);
      u.balUsd = state.balUsd;
    });

    await this.core.invalidateUser(u.id);
    if (fresh) this.core.emitActivity(u.id, activity);
    return { claim: true, activity, claimRecord, fresh };
  }

  async getClaim(slug: string): Promise<ClaimRecord | null> {
    const [row] = await this.db
      .select()
      .from(nbClaimWallets)
      .where(eq(nbClaimWallets.slug, slug))
      .limit(1);
    return row ? claimFromRow(row) : null;
  }

  async claimFunds(
    slug: string,
    recipientEmail: string,
  ): Promise<{ amountUsd: number; recipient: User } | null> {
    const norm = recipientEmail.trim().toLowerCase();
    const [claimPreview] = await this.db
      .select({
        id: nbClaimWallets.id,
        email: nbClaimWallets.email,
        status: nbClaimWallets.status,
        expiresAt: nbClaimWallets.expiresAt,
      })
      .from(nbClaimWallets)
      .where(eq(nbClaimWallets.slug, slug))
      .limit(1);
    if (!claimPreview) return null;
    if (claimPreview.email !== norm) return null;
    if (claimPreview.status !== 'pending') return null;
    if (claimPreview.expiresAt.getTime() < Date.now()) return null;

    const recipient = await this.auth.upsertUserByEmail(norm);

    let amountUsd = 0;
    let claimed = false;
    let senderName = '';

    await this.db.transaction(async (tx) => {
      // Row-lock the claim and re-check it's still pending + unexpired.
      const [locked] = await tx
        .select()
        .from(nbClaimWallets)
        .where(eq(nbClaimWallets.slug, slug))
        .for('update');
      if (!locked) return;
      if (locked.status !== 'pending') return;
      if (locked.expiresAt.getTime() < Date.now()) return;

      amountUsd = n(locked.amountUsd);
      senderName = locked.senderName ?? 'a MAZE member';
      const at = new Date();

      // Sprint 13 COMMIT 1 — write only the claim status flip inside the tx;
      // route the credit through PgLedger.topUp after commit so earnByDefault
      // auto-tail + chain mirror fire. If topUp throws post-commit we have a
      // 'claimed' row with no credit; operator reconciliation is the safety
      // net (best-effort contract, matches chain-mirror).
      await tx
        .update(nbClaimWallets)
        .set({ status: 'claimed', claimedAt: at })
        .where(eq(nbClaimWallets.id, locked.id));
      claimed = true;
    });

    if (!claimed) return null;

    await this.ledger.topUp(recipient, amountUsd, 'Claimed · from ' + senderName);
    const refreshed = await this.auth.user(recipient.id);
    return { amountUsd, recipient: refreshed };
  }

  async claimPendingFundsForEmail(email: string): Promise<{ claimed: number; amountUsd: number }> {
    const norm = email.trim().toLowerCase();
    const rows = await this.db
      .select({ slug: nbClaimWallets.slug })
      .from(nbClaimWallets)
      .where(
        and(
          eq(nbClaimWallets.email, norm),
          eq(nbClaimWallets.status, 'pending'),
          sql`${nbClaimWallets.expiresAt} >= NOW()`,
        ),
      );
    let claimed = 0;
    let amountUsd = 0;
    for (const row of rows) {
      if (!row.slug) continue;
      const res = await this.claimFunds(row.slug, norm);
      if (!res) continue;
      claimed += 1;
      amountUsd += res.amountUsd;
    }
    return { claimed, amountUsd };
  }

  async listClaims(u: SessionUser): Promise<ClaimRecord[]> {
    const rows = await this.db
      .select()
      .from(nbClaimWallets)
      .where(eq(nbClaimWallets.senderUserId, u.id))
      .orderBy(desc(nbClaimWallets.createdAt));
    return rows.map(claimFromRow);
  }

  async expireClaimsBefore(
    cutoff: Date,
  ): Promise<{ expired: ClaimRecord[]; refundsApplied: number }> {
    const expired: ClaimRecord[] = [];
    // Snapshot the (senderUserId, amountUsd) tuples to refund AFTER the tx
    // commits so the ledger.topUp tail can fire mirror + earnByDefault.
    const refunds: Array<{ senderUserId: string; amountUsd: number }> = [];
    let refundsApplied = 0;

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(nbClaimWallets)
        .where(
          // lt() (not a raw sql`` fragment): raw fragments hand postgres-js a
          // naked Date, which crashes client-side before reaching Postgres —
          // killed every daily claim-sweep run in prod (2026-07-15 incident).
          and(eq(nbClaimWallets.status, 'pending'), lt(nbClaimWallets.expiresAt, cutoff)),
        )
        .for('update', { skipLocked: true });
      if (rows.length === 0) return;

      for (const row of rows) {
        await tx
          .update(nbClaimWallets)
          .set({ status: 'expired' })
          .where(eq(nbClaimWallets.id, row.id));

        expired.push(claimFromRow({ ...row, status: 'expired' }));
        refunds.push({ senderUserId: row.senderUserId, amountUsd: n(row.amountUsd) });
        refundsApplied += 1;
      }
    });

    // Sprint 13 COMMIT 1 — route refunds through PgLedger.topUp so the chain
    // mirror + earnByDefault fire. If a single refund throws we surface the
    // error after; partial refunds are caught by the daily sweeper retry.
    for (const refund of refunds) {
      const sender = await this.auth.user(refund.senderUserId);
      await this.ledger.topUp(sender, refund.amountUsd, 'Refund · Claim expired');
    }

    return { expired, refundsApplied };
  }
}

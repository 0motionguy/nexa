/**
 * InMemoryClaims — email-claim escrow.
 *
 * Cross-domain: claimFunds + expireClaimsBefore call ledger.topUp on the
 * recipient/sender. claimFunds also calls auth.upsertUserByEmail.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPregeneratedWallet } from '../../lib/chain/privy-claim.js';
import { type ClaimRecord, type ClaimSendResult, PolicyError, type SessionUser, type User } from '../types.js';
import type { InMemoryState } from '../core/in-memory-state.js';
import type { InMemoryAuth } from './auth.js';
import type { InMemoryLedger } from './ledger.js';
import { money, nowIso } from './_shared.js';

function idempotencyTag(key?: string | null): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return `send:${createHash('sha256').update(trimmed).digest('hex')}`;
}

function activityAmountUsd(a: { a: string }): number {
  const value = Number(a.a.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(value) ? Math.abs(value) : NaN;
}

export class InMemoryClaims {
  private claimsBySlug = new Map<string, ClaimRecord>();

  constructor(
    private state: InMemoryState,
    private auth: InMemoryAuth,
    private ledger: InMemoryLedger,
  ) {}

  /** Scale wave 3 — resolve the canonical map object for balance mutations. */
  private full(u: SessionUser): User {
    const row = this.state.usersById.get(u.id);
    if (!row) throw new Error('user_not_found');
    return row;
  }

  async recordClaim(u: SessionUser, email: string, amountUsd: number): Promise<ClaimRecord> {
    // send() already debited the sender — we only park the escrow here.
    const norm = email.trim().toLowerCase();
    const walletAddress = await createPregeneratedWallet(norm);
    const rec: ClaimRecord = {
      id: randomUUID(),
      slug: randomBytes(4).toString('hex'),
      senderUserId: u.id,
      senderName: u.name,
      email: norm,
      amountUsd,
      walletAddress,
      status: 'pending',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      claimedAt: null,
      createdAt: nowIso(),
    };
    this.claimsBySlug.set(rec.slug, rec);
    return rec;
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
    const fu = this.full(u);
    if (idem) {
      const existing = fu.activity.find((a) => a.txHash === idem);
      if (existing) {
        const slug = existing.chain?.startsWith('claim:') ? existing.chain.slice('claim:'.length) : null;
        const claimRecord = slug ? this.claimsBySlug.get(slug) : null;
        if (
          existing.signer?.trim().toLowerCase() !== norm ||
          Math.abs(activityAmountUsd(existing) - amountUsd) > 0.005 ||
          !claimRecord
        ) {
          throw new Error('idempotency_key_reused');
        }
        return { claim: true, activity: existing, claimRecord, fresh: false };
      }
    }
    await this.ledger.autoDivestIfNeeded(u, amountUsd);
    if (amountUsd > fu.balUsd) throw new PolicyError('insufficient_funds', 'Not enough balance.');
    const walletAddress = await createPregeneratedWallet(norm);

    const rec: ClaimRecord = {
      id: randomUUID(),
      slug: randomBytes(4).toString('hex'),
      senderUserId: u.id,
      senderName: u.name,
      email: norm,
      amountUsd,
      walletAddress,
      status: 'pending',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      claimedAt: null,
      createdAt: nowIso(),
    };

    fu.balUsd -= amountUsd;
    const activity = await this.state.pushActivity(fu, {
      n: 'Sent · ' + email,
      s: 'CLAIM PENDING · JUST NOW',
      a: '−' + money(amountUsd),
      k: 'out',
      signer: norm,
      chain: `claim:${rec.slug}`,
      ...(idem ? { txHash: idem } : {}),
    });
    this.claimsBySlug.set(rec.slug, rec);
    return { claim: true, activity, claimRecord: rec, fresh: true };
  }

  async getClaim(slug: string): Promise<ClaimRecord | null> {
    return this.claimsBySlug.get(slug) ?? null;
  }

  async claimFunds(
    slug: string,
    recipientEmail: string,
  ): Promise<{ amountUsd: number; recipient: User } | null> {
    const rec = this.claimsBySlug.get(slug);
    if (!rec) return null;
    const norm = recipientEmail.trim().toLowerCase();
    if (rec.email !== norm) return null;
    if (rec.status !== 'pending') return null;
    if (new Date(rec.expiresAt) < new Date()) return null;
    const recipient = await this.auth.upsertUserByEmail(norm);
    await this.ledger.topUp(recipient, rec.amountUsd, 'Claimed · from ' + rec.senderName);
    rec.status = 'claimed';
    rec.claimedAt = nowIso();
    return { amountUsd: rec.amountUsd, recipient };
  }

  async claimPendingFundsForEmail(email: string): Promise<{ claimed: number; amountUsd: number }> {
    const norm = email.trim().toLowerCase();
    let claimed = 0;
    let amountUsd = 0;
    for (const rec of [...this.claimsBySlug.values()]) {
      if (rec.email !== norm) continue;
      const res = await this.claimFunds(rec.slug, norm);
      if (!res) continue;
      claimed += 1;
      amountUsd += res.amountUsd;
    }
    return { claimed, amountUsd };
  }

  async listClaims(u: SessionUser): Promise<ClaimRecord[]> {
    return [...this.claimsBySlug.values()]
      .filter((c) => c.senderUserId === u.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async expireClaimsBefore(
    cutoff: Date,
  ): Promise<{ expired: ClaimRecord[]; refundsApplied: number }> {
    const expired: ClaimRecord[] = [];
    let refundsApplied = 0;
    for (const rec of this.claimsBySlug.values()) {
      if (rec.status !== 'pending') continue;
      if (new Date(rec.expiresAt) >= cutoff) continue;
      rec.status = 'expired';
      expired.push(rec);
      const sender = this.state.usersById.get(rec.senderUserId);
      if (sender) {
        await this.ledger.topUp(sender, rec.amountUsd, 'Refund · Claim expired');
        refundsApplied += 1;
      }
    }
    return { expired, refundsApplied };
  }

  /* ── dispose helper for the facade ── */
  clearAll(): void {
    this.claimsBySlug.clear();
  }
}

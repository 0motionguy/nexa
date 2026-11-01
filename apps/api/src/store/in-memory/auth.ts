/**
 * InMemoryAuth — user upsert + agent-key bindings + identity lookups.
 *
 * upsertUserByEmail seeds a sample offer at creation time so first sign-up
 * lands on a dashboard with familiar demo data.
 */

import type { SessionUser, User } from '../types.js';
import type { InMemoryState } from '../core/in-memory-state.js';
import { seedUser } from '../core/in-memory-state.js';
import type { InMemoryPayments } from './payments.js';

export class InMemoryAuth {
  private agentKeyUsers = new Map<string, string>();

  constructor(
    private state: InMemoryState,
    private payments: InMemoryPayments,
  ) {}

  async upsertUserByEmail(
    email: string,
    name?: string,
    opts: { privyDid?: string | null } = {},
  ): Promise<User> {
    const norm = email.trim().toLowerCase();
    const existingId = this.state.usersByEmail.get(norm);
    if (existingId) {
      const existing = this.state.usersById.get(existingId)!;
      if (opts.privyDid) existing.privyDid = opts.privyDid;
      return existing;
    }
    const fallback = norm.split('@')[0] ?? 'Member';
    const display = name ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
    const u = seedUser(norm, display, opts);
    this.state.usersById.set(u.id, u);
    this.state.usersByEmail.set(norm, u.id);
    // Demo seed: give every new user one example offer (live mode).
    await this.payments.createOffer(
      u,
      {
        title: 'Priority queue · 7 days',
        description: 'Skip the line on the server for a week.',
        amountUsd: 9.99,
        currency: 'USD',
        type: 'subscription',
        fulfillmentKind: 'message',
        fulfillmentValue: 'You are in — rejoin the server to see priority queue active.',
      },
      { livemode: true },
    );
    return u;
  }

  async user(id: string): Promise<User> {
    const u = this.state.usersById.get(id);
    if (!u) throw new Error('user_not_found');
    return u;
  }

  /** Scale wave 3 — in-memory has no per-request query cost; the full user
   *  IS the projection (User is structurally assignable to SessionUser). */
  async userSession(id: string): Promise<SessionUser> {
    return this.user(id);
  }

  async setPrivyWallet(
    userId: string,
    walletId: string,
    walletAddress: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const u = this.state.usersById.get(userId);
    if (!u) return;
    if (!opts.force && u.privyWalletId && u.privyWalletAddress) return;
    u.privyWalletId = walletId;
    u.privyWalletAddress = walletAddress;
  }

  async setHlBuilderApproval(userId: string, maxFeeTenthsBp: number): Promise<void> {
    const u = this.state.usersById.get(userId);
    if (!u) return;
    u.hlBuilderApprovedAt = new Date().toISOString();
    u.hlBuilderMaxFeeTenthsBp = maxFeeTenthsBp;
  }

  async setPmClobCredentials(
    userId: string,
    creds: { key: string; secret: string; passphrase: string },
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const u = this.state.usersById.get(userId);
    if (!u) return;
    if (!opts.force && u.pmClobKey && u.pmClobSecret && u.pmClobPassphrase) return;
    u.pmClobKey = creds.key;
    u.pmClobSecret = creds.secret;
    u.pmClobPassphrase = creds.passphrase;
  }

  async setPrivySolWallet(
    userId: string,
    walletId: string,
    walletAddress: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const u = this.state.usersById.get(userId);
    if (!u) return;
    if (!opts.force && u.privySolWalletId && u.privySolWalletAddress) return;
    u.privySolWalletId = walletId;
    u.privySolWalletAddress = walletAddress;
  }

  async setUserCohort(userId: string, cohort: string | null): Promise<void> {
    const u = this.state.usersById.get(userId);
    if (!u) return;
    u.cohort = cohort;
  }

  async listUsersByCohort(cohort: string): Promise<User[]> {
    const wanted = cohort.trim();
    if (!wanted) return [];
    return Array.from(this.state.usersById.values()).filter((u) => u.cohort === wanted);
  }

  async bindAgentKeyToUser(key: string, userId: string): Promise<void> {
    this.agentKeyUsers.set(key, userId);
  }

  async userForAgentKey(key: string): Promise<User | null> {
    const id = this.agentKeyUsers.get(key);
    return id ? (this.state.usersById.get(id) ?? null) : null;
  }

  clearAgentKeys(): void {
    this.agentKeyUsers.clear();
  }
}

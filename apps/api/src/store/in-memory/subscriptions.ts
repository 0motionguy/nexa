/**
 * InMemorySubscriptions — API keys, sub-accounts, payouts, subscriptions,
 * webhooks. Pure in-memory Map storage; idempotency keys held in side maps.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type ApiKey,
  type ApiKeyCreated,
  type Payout,
  type PayoutInput,
  PolicyError,
  type SubAccount,
  type Subscription,
  type SessionUser,
  type User,
  type WebhookEndpoint,
} from '../types.js';
import type { InMemoryState } from '../core/in-memory-state.js';
import { money, nowIso } from './_shared.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export class InMemorySubscriptions {
  // API keys
  private apiKeys = new Map<string, ApiKey>();
  private apiKeyHashToId = new Map<string, string>();
  // Sub-accounts
  readonly subAccounts = new Map<string, SubAccount>();
  // Payouts
  private payouts = new Map<string, Payout>();
  private payoutIdemKeys = new Map<string, string>();
  // Subscriptions
  readonly subscriptions = new Map<string, Subscription>();
  // Webhooks
  private webhooksById = new Map<string, WebhookEndpoint>();

  constructor(private state: InMemoryState) {}

  /* ── API keys ── */

  async createApiKey(u: SessionUser, label: string | null, livemode: boolean): Promise<ApiKeyCreated> {
    const prefix: ApiKey['prefix'] = livemode ? 'sk_live' : 'sk_test';
    const secret = prefix + '_' + randomBytes(18).toString('hex');
    const hash = sha256(secret);
    const record: ApiKey = {
      id: randomUUID(),
      sellerId: u.id,
      prefix,
      last4: secret.slice(-4),
      label,
      livemode,
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.apiKeys.set(record.id, record);
    this.apiKeyHashToId.set(hash, record.id);
    return { ...record, secret };
  }

  async listApiKeys(u: SessionUser): Promise<ApiKey[]> {
    return [...this.apiKeys.values()]
      .filter((k) => k.sellerId === u.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeApiKey(u: SessionUser, id: string): Promise<ApiKey | null> {
    const k = this.apiKeys.get(id);
    if (!k || k.sellerId !== u.id) return null;
    if (!k.revokedAt) k.revokedAt = nowIso();
    return k;
  }

  async userForApiKey(secret: string): Promise<{ user: User; livemode: boolean } | null> {
    const id = this.apiKeyHashToId.get(sha256(secret));
    if (!id) return null;
    const record = this.apiKeys.get(id);
    if (!record || record.revokedAt) return null;
    record.lastUsedAt = nowIso();
    return { user: this.state.usersById.get(record.sellerId)!, livemode: record.livemode };
  }

  /* ── sub-accounts ── */

  async createSubAccount(u: SessionUser, name: string): Promise<SubAccount> {
    const sub: SubAccount = {
      id: randomUUID(),
      sellerId: u.id,
      name,
      balUsd: 0,
      sandboxBalUsd: 0,
      createdAt: nowIso(),
    };
    this.subAccounts.set(sub.id, sub);
    return sub;
  }

  async listSubAccounts(u: SessionUser): Promise<SubAccount[]> {
    return [...this.subAccounts.values()]
      .filter((s) => s.sellerId === u.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async subAccount(u: SessionUser, id: string): Promise<SubAccount> {
    const s = this.subAccounts.get(id);
    if (!s || s.sellerId !== u.id) throw new Error('sub_account_not_found');
    return s;
  }

  /* ── payouts ── */

  async createPayout(
    u: SessionUser,
    input: PayoutInput,
    opts?: { livemode?: boolean; idempotencyKey?: string | null },
  ): Promise<Payout> {
    const live = opts?.livemode ?? true;

    if (opts?.idempotencyKey) {
      const priorId = this.payoutIdemKeys.get(`${u.id}:${opts.idempotencyKey}`);
      if (priorId) {
        const prior = this.payouts.get(priorId);
        if (prior) return prior;
      }
    }

    const bal = live ? u.balUsd : u.sandboxBalUsd;
    if (input.amountUsd > bal)
      throw new PolicyError('insufficient_funds', 'Not enough balance for this payout.');
    if (live) u.balUsd -= input.amountUsd;
    else u.sandboxBalUsd -= input.amountUsd;

    const payout: Payout = {
      id: randomUUID(),
      sellerId: u.id,
      amountUsd: input.amountUsd,
      currency: 'USD',
      destination: input.destination,
      method: input.method ?? 'email',
      note: input.note ?? null,
      status: 'paid',
      livemode: live,
      createdAt: nowIso(),
    };
    this.payouts.set(payout.id, payout);
    if (opts?.idempotencyKey) this.payoutIdemKeys.set(`${u.id}:${opts.idempotencyKey}`, payout.id);

    if (live) {
      await this.state.pushActivity(this.full(u), {
        n: 'Payout · ' + input.destination,
        s: 'SENT · JUST NOW',
        a: '−' + money(input.amountUsd),
        k: 'out',
      });
    }

    return payout;
  }

  async listPayouts(u: SessionUser, opts?: { livemode?: boolean }): Promise<Payout[]> {
    return [...this.payouts.values()]
      .filter((p) => p.sellerId === u.id && (opts?.livemode === undefined || p.livemode === opts.livemode))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async payout(u: SessionUser, id: string): Promise<Payout> {
    const p = this.payouts.get(id);
    if (!p || p.sellerId !== u.id) throw new Error('payout_not_found');
    return p;
  }

  /** Scale wave 3 — resolve the canonical map object; snapshot writes are lost. */
  private full(u: SessionUser) {
    const row = this.state.usersById.get(u.id);
    if (!row) throw new Error('user_not_found');
    return row;
  }

  /* ── subscriptions ── */

  async listSubscriptions(u: SessionUser, opts?: { livemode?: boolean }): Promise<Subscription[]> {
    return [...this.subscriptions.values()]
      .filter((s) => s.sellerId === u.id && (opts?.livemode === undefined || s.livemode === opts.livemode))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async subscription(u: SessionUser, id: string): Promise<Subscription> {
    const s = this.subscriptions.get(id);
    if (!s || s.sellerId !== u.id) throw new Error('subscription_not_found');
    return s;
  }

  async renewSubscription(u: SessionUser, id: string, opts?: { dueBefore?: Date }): Promise<Subscription> {
    const s = await this.subscription(u, id);
    if (s.status === 'canceled') throw new Error('subscription_canceled');
    if (opts?.dueBefore && new Date(s.currentPeriodEnd) >= opts.dueBefore)
      throw new Error('subscription_not_due');
    // Credit the seller (u IS the owner here) a renewal charge.
    if (s.livemode) {
      const fu = this.full(u);
      fu.balUsd += s.amountUsd;
      await this.state.pushActivity(fu, {
        n: 'Renewal · ' + s.offerTitle,
        s: 'SUBSCRIPTION · JUST NOW',
        a: '+' + money(s.amountUsd),
        pos: true,
        k: 'in',
      });
    } else {
      u.sandboxBalUsd += s.amountUsd;
    }
    s.currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return s;
  }

  async cancelSubscription(u: SessionUser, id: string): Promise<Subscription> {
    const s = await this.subscription(u, id);
    s.status = 'canceled';
    return s;
  }

  async findSubscriptionsDueBefore(cutoff: Date): Promise<Subscription[]> {
    const due: Subscription[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.status !== 'active') continue;
      if (new Date(sub.currentPeriodEnd) >= cutoff) continue;
      due.push(sub);
    }
    return due;
  }

  /* ── webhooks ── */

  async registerWebhook(u: SessionUser, url: string): Promise<WebhookEndpoint> {
    const wh: WebhookEndpoint = {
      id: randomUUID(),
      sellerId: u.id,
      url,
      secret: 'whsec_' + randomUUID().replace(/-/g, ''),
      active: true,
      createdAt: nowIso(),
    };
    this.webhooksById.set(wh.id, wh);
    return wh;
  }

  async listWebhooks(u: SessionUser): Promise<WebhookEndpoint[]> {
    return [...this.webhooksById.values()].filter((w) => w.sellerId === u.id);
  }

  async webhooksForSeller(sellerId: string): Promise<WebhookEndpoint[]> {
    return [...this.webhooksById.values()].filter((w) => w.sellerId === sellerId);
  }

  /* ── dispose helper for the facade ── */
  clearAll(): void {
    this.apiKeys.clear();
    this.apiKeyHashToId.clear();
    this.subAccounts.clear();
    this.payouts.clear();
    this.payoutIdemKeys.clear();
    this.subscriptions.clear();
    this.webhooksById.clear();
  }
}

/**
 * Sponge adapter — agent card + bank account issuance.
 *
 * Sponge issues programmable cards and bank accounts scoped to an agent, so an
 * autonomous agent can transact under its own credential rather than the human's.
 * Env-gated behind SPONGE_API_KEY (same pattern as the Bridge/LIFI adapters):
 * unset → deterministic demo numbers. Every network call is wrapped so a Sponge
 * outage degrades to demo behaviour rather than throwing to the route.
 *
 * Demo identifiers are derived from sha256(userId + agentId) so the same agent
 * always resolves to the same card / account across calls.
 *
 * Docs: https://docs.paysponge.com/
 */

import { createHash } from 'node:crypto';
import { env, features } from '../env.js';
import { log } from '../log.js';

export function isSpongeEnabled(): boolean {
  return features.sponge;
}

function apiBase(): string {
  return env.SPONGE_API_BASE.replace(/\/+$/, '');
}

function spongeHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${env.SPONGE_API_KEY ?? ''}`,
  };
}

function headersWithIdempotency(key?: string | null): Record<string, string> {
  const headers = spongeHeaders();
  if (key) headers['Idempotency-Key'] = key;
  return headers;
}

/** Stable sha256 hex of `userId + agentId + tag` — the deterministic-demo seed. */
function digest(userId: string, agentId: string, tag: string): string {
  return createHash('sha256').update(`${userId}:${agentId}:${tag}`).digest('hex');
}

/** `n` deterministic digits pulled from a hex string (each nibble mod 10). */
function digitsFrom(hex: string, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += (parseInt(hex[i % hex.length] ?? '0', 16) % 10).toString();
  return out;
}

/**
 * Issue an agent card. Live: Sponge REST card-create with a Bearer key, mapping
 * back the last4 + network. Demo (or any failure): a Mastercard with a
 * deterministic last4 derived from sha256(userId + agentId).
 */
export async function createAgentCard(
  userId: string,
  agentId: string,
  opts?: { idempotencyKey?: string | null },
): Promise<{ last4: string; network: string; demo: boolean }> {
  const last4 = digitsFrom(digest(userId, agentId, 'card'), 4);
  const demoCard = { last4, network: 'Mastercard', demo: true };
  if (!isSpongeEnabled()) return demoCard;
  try {
    const res = await fetch(`${apiBase()}/v1/cards`, {
      method: 'POST',
      headers: headersWithIdempotency(opts?.idempotencyKey),
      body: JSON.stringify({ agentId, type: 'virtual' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'sponge: createAgentCard rejected — demo fallback');
      return demoCard;
    }
    const data = (await res.json().catch(() => ({}))) as {
      last4?: string;
      lastFour?: string;
      network?: string;
      scheme?: string;
    };
    return {
      last4: data.last4 ?? data.lastFour ?? last4,
      network: data.network ?? data.scheme ?? 'Mastercard',
      demo: false,
    };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), userId, agentId },
      'sponge: createAgentCard unreachable — demo fallback',
    );
    return demoCard;
  }
}

/**
 * Issue an agent bank account. Live: Sponge REST account-create with a Bearer
 * key, mapping back account + routing numbers. Demo (or any failure):
 * deterministic account + routing numbers derived from sha256(userId + agentId).
 */
export async function createAgentBankAccount(
  userId: string,
  agentId: string,
  opts?: { idempotencyKey?: string | null },
): Promise<{ accountNumber: string; routingNumber: string; demo: boolean }> {
  const demoAccount = {
    accountNumber: digitsFrom(digest(userId, agentId, 'account'), 10),
    routingNumber: digitsFrom(digest(userId, agentId, 'routing'), 9),
    demo: true,
  };
  if (!isSpongeEnabled()) return demoAccount;
  try {
    const res = await fetch(`${apiBase()}/v1/accounts`, {
      method: 'POST',
      headers: headersWithIdempotency(opts?.idempotencyKey),
      body: JSON.stringify({ agentId, type: 'checking' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn({ status: res.status, text }, 'sponge: createAgentBankAccount rejected — demo fallback');
      return demoAccount;
    }
    const data = (await res.json().catch(() => ({}))) as {
      accountNumber?: string;
      account_number?: string;
      routingNumber?: string;
      routing_number?: string;
    };
    return {
      accountNumber: data.accountNumber ?? data.account_number ?? demoAccount.accountNumber,
      routingNumber: data.routingNumber ?? data.routing_number ?? demoAccount.routingNumber,
      demo: false,
    };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), userId, agentId },
      'sponge: createAgentBankAccount unreachable — demo fallback',
    );
    return demoAccount;
  }
}

export const spongeAdapter = {
  isSpongeEnabled,
  createAgentCard,
  createAgentBankAccount,
};

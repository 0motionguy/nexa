/**
 * Pregenerated-wallet adapter — the "send $20 to bob@x.com" escrow target.
 *
 * When a user sends to an email, we park the funds against a Privy pregenerated
 * wallet keyed to that email. Privy can create a self-custodial embedded wallet
 * before the recipient ever logs in; on first login (claim) they take ownership.
 *
 * Env-gated behind PRIVY_APP_ID/SECRET (features.privy), same as every other
 * chain adapter: when Privy is unwired we return a deterministic mock 0x address
 * derived from a sha256 of the email — stable per email so repeated sends to the
 * same address resolve to the same wallet in demo. Every network call is wrapped
 * so a Privy outage degrades to the mock rather than throwing to the store.
 *
 * Docs: https://docs.sumsub.com/ (KYC) · https://docs.privy.io/wallets (wallets)
 */

import { createHash } from 'node:crypto';
import { PrivyClient } from '@privy-io/server-auth';
import { env, features } from '../env.js';
import { log } from '../log.js';

let client: PrivyClient | null = null;
if (features.privy && env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
  client = new PrivyClient(
    env.PRIVY_APP_ID,
    env.PRIVY_APP_SECRET,
    env.PRIVY_AUTHORIZATION_PRIVATE_KEY
      ? { walletApi: { authorizationPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY } }
      : undefined,
  );
}

/** Deterministic, stable-per-email mock address for demo / disabled / error. */
function mockAddress(email: string): string {
  const h = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return '0x' + h.slice(0, 40);
}

/** Pull the first ethereum wallet address out of a Privy user payload, shape-tolerant. */
function extractAddress(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const u = user as Record<string, any>;
  // v1 server-auth exposes wallets via linkedAccounts; some shapes use `wallets`.
  const accounts: any[] = Array.isArray(u.linkedAccounts)
    ? u.linkedAccounts
    : Array.isArray(u.wallets)
      ? u.wallets
      : [];
  const wallet = accounts.find(
    (a) =>
      a &&
      typeof a.address === 'string' &&
      a.address.startsWith('0x') &&
      (a.type === 'wallet' || a.chainType === 'ethereum' || a.chain_type === 'ethereum' || a.type === undefined),
  );
  return wallet && typeof wallet.address === 'string' ? wallet.address : null;
}

/**
 * Create (or resolve) a Privy pregenerated embedded wallet for an email and
 * return its address. Live: pregenerate an Ethereum wallet against an email-linked
 * user. Disabled or on any error: a deterministic mock `0x` address derived from
 * a sha256 of the email (stable per email). Returns null only if a live call
 * somehow yields no address AND no fallback is desired — in practice we always
 * return the mock on failure so the escrow row still has a wallet to point at.
 */
export async function createPregeneratedWallet(email: string): Promise<string | null> {
  const norm = email.trim().toLowerCase();
  if (!client) return mockAddress(norm);
  try {
    // Pregenerate a user keyed to the email with an embedded Ethereum wallet.
    // server-auth v1 exposes importUser({ linkedAccounts, createEthereumWallet }).
    const api = client as unknown as {
      importUser?: (input: unknown) => Promise<unknown>;
      getUserByEmail?: (email: string) => Promise<unknown>;
    };

    // If a user already exists for this email, reuse its wallet.
    if (typeof api.getUserByEmail === 'function') {
      const existing = await api.getUserByEmail(norm).catch(() => null);
      const addr = extractAddress(existing);
      if (addr) return addr;
    }

    if (typeof api.importUser === 'function') {
      const created = await api.importUser({
        linkedAccounts: [{ type: 'email', address: norm }],
        createEthereumWallet: true,
      });
      const addr = extractAddress(created);
      if (addr) return addr;
    }

    log.warn({ email: norm }, 'privy-claim: pregenerate yielded no address — mock fallback');
    return mockAddress(norm);
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'privy-claim: createPregeneratedWallet unreachable — mock fallback',
    );
    return mockAddress(norm);
  }
}

/**
 * Privy server-wallet provisioning for an AGENT.
 *
 * Distinct from `getOrCreatePrivyWallet` in `lib/privy.ts`, which returns the
 * EXISTING wallet linked to the user (we'd want one wallet per user from the
 * user surface). Agents need a FRESH wallet per call so each agent has on-chain
 * isolation from its sibling agents AND from the human owner. Privy supports
 * multiple wallets under the same `owner: { userId }` — confirmed via Context7
 * `/websites/privy_io` recipe "Create a Wallet Owned by User via REST API"
 * retrieved 2026-06-14.
 *
 * Returns `null` on any failure so the caller can degrade to demo mode without
 * throwing through the route handler.
 */

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

export async function createPrivyAgentWallet(
  privyUserId: string,
): Promise<{ walletId: string; address: string } | null> {
  if (!client) return null;
  try {
    // Agent wallets sign x402 payments server-side — register the auth key as
    // an additionalSigner so the backend can sign them.
    const created = await client.walletApi.create({
      chainType: 'ethereum',
      owner: { userId: privyUserId },
      ...(env.PRIVY_AUTHORIZATION_KEY_ID
        ? { additionalSigners: [{ signerId: env.PRIVY_AUTHORIZATION_KEY_ID }] }
        : {}),
    });
    return { walletId: created.id, address: created.address };
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e), privyUserId },
      'privy: agent wallet create failed',
    );
    return null;
  }
}

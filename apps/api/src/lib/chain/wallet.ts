/**
 * Wallet service — fetches or creates Privy server wallets for users and
 * agents, persists the (agent, chain) → walletId mapping in nb_privy_wallets.
 *
 * Agents get their OWN wallet (a fresh `walletApi.create({ owner: { userId },
 * chainType: 'ethereum' })` call per agent) so x402 payments sign as the agent's
 * address, not the human's. Privy enforces the per-user ownership model — keys
 * never leave their TEE; the human is still the legal owner because they own
 * the Privy `did`.
 *
 * Stack upgrades Phase 3 — `getOrCreateAgentWallet` now:
 *   1. Reads `nb_privy_wallets (agent_id, chain)` first (idempotent).
 *   2. If absent, calls Privy's `walletApi.create` to provision a fresh wallet
 *      owned by the human's `privyDid`, persists, returns.
 *   3. In demo mode (Privy unwired or `privyDid === null`), synthesizes a
 *      deterministic address from agent_id so tests are stable across runs
 *      AND the same agent always resolves to the same demo address.
 *
 * Provenance: Privy server-wallet REST spec verified via Context7
 * `/websites/privy_io` on 2026-06-14: each `walletApi.create` returns a fresh
 * `id` + `address`; multiple wallets per user are supported.
 */

import { createHash } from 'node:crypto';
import { keccak256, toHex, type Hex } from 'viem';
import { features } from '../env.js';
import { log } from '../log.js';
import { store } from '../../store/index.js';
import { ChainError } from './units.js';
import {
  getOrCreatePrivyWallet,
  getOrCreatePrivySolanaWallet,
  signTypedDataWithPrivy,
  signSolanaTxWithPrivy,
} from '../privy.js';
import { createPrivyAgentWallet } from './privy-agent-wallet.js';

export interface WalletHandle {
  address: Hex;
  walletId: string;
  live: boolean;
  /** EIP-712 typed-data signer. Returns null in demo mode. */
  signTypedData(typedData: unknown): Promise<Hex | null>;
}

function mockAddress(seed: string): Hex {
  // Deterministic non-checksummed address derived from seed hash.
  const h = keccak256(toHex(seed));
  return (`0x${h.slice(2, 42)}`) as Hex;
}

function mockHandle(seed: string): WalletHandle {
  const address = mockAddress(seed);
  return {
    address,
    walletId: `mock_${seed.slice(0, 12)}`,
    live: false,
    async signTypedData(): Promise<Hex | null> {
      log.info({ address, seed }, 'wallet.demo: signTypedData no-op');
      return null;
    },
  };
}

/** Deterministic 0x40-hex demo address keyed off the agent's id. */
function demoAgentAddress(agentId: string): string {
  return '0x' + createHash('sha256').update('agent:' + agentId).digest('hex').slice(0, 40);
}

async function resolvePrivyDid(userId: string, supplied: string | null): Promise<string | null> {
  if (supplied) return supplied;
  try {
    const user = await store.user(userId);
    return user.privyDid ?? null;
  } catch {
    return null;
  }
}

/**
 * Solana wallet handle. Mirrors `WalletHandle` shape but the address is a
 * base58 string (not 0x hex), and the signer takes a serialized Solana tx
 * message (base64) instead of EIP-712 typed data.
 */
export interface SolanaWalletHandle {
  address: string;
  walletId: string;
  live: boolean;
  /** Sign a serialized Solana tx message. Returns null in demo mode. */
  signTx(messageBase64: string): Promise<string | null>;
}

/**
 * Sprint 16.3 — Solana base58 address validation. Real Solana addresses are
 * 32-byte ed25519 public keys, base58-encoded, 32-44 chars long, alphabet
 * matching base58 (no 0, O, I, l). A malformed return from Privy would
 * silently break Marinade stake/Mayan execute later; fail fast here.
 */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isValidSolanaAddress(addr: string): boolean {
  return BASE58.test(addr);
}

function mockSolanaHandle(seed: string): SolanaWalletHandle {
  // Deterministic base58-ish demo address; not a real Solana key, but stable
  // across calls so tests that snapshot the address don't flake.
  const h = createHash('sha256').update('solana:' + seed).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 44);
  return {
    address: h,
    walletId: `mock_sol_${seed.slice(0, 12)}`,
    live: false,
    async signTx(): Promise<string | null> {
      log.info({ seed }, 'wallet.demo: signSolanaTx no-op');
      return null;
    },
  };
}

export interface WalletService {
  isLive(): boolean;
  getOrCreateUserWallet(userId: string, privyDid: string | null): Promise<WalletHandle>;
  /** Sprint 16.2 — Solana sibling of getOrCreateUserWallet for Marinade + Mayan. */
  getOrCreateUserSolanaWallet(userId: string, privyDid: string | null): Promise<SolanaWalletHandle>;
  getOrCreateAgentWallet(
    userId: string,
    privyDid: string | null,
    agentId: string,
    agentName: string,
  ): Promise<WalletHandle>;
}

export const walletService: WalletService = {
  isLive(): boolean {
    return features.privy;
  },

  async getOrCreateUserWallet(userId, privyDid): Promise<WalletHandle> {
    const resolvedPrivyDid = await resolvePrivyDid(userId, privyDid);
    if (!features.privy || !resolvedPrivyDid) {
      return mockHandle('user_' + userId);
    }
    const wallet = await getOrCreatePrivyWallet(resolvedPrivyDid, 'base');
    if (!wallet) {
      throw new ChainError('wallet_missing', 'failed to provision Privy wallet for user');
    }
    return {
      address: wallet.address as Hex,
      walletId: wallet.walletId,
      live: true,
      async signTypedData(typedData: unknown): Promise<Hex | null> {
        const sig = await signTypedDataWithPrivy(wallet.walletId, typedData as never);
        return sig as Hex | null;
      },
    };
  },

  async getOrCreateUserSolanaWallet(userId, privyDid): Promise<SolanaWalletHandle> {
    const resolvedPrivyDid = await resolvePrivyDid(userId, privyDid);
    if (!features.privy || !resolvedPrivyDid) {
      return mockSolanaHandle('user_' + userId);
    }
    const wallet = await getOrCreatePrivySolanaWallet(resolvedPrivyDid);
    if (!wallet) {
      throw new ChainError('wallet_unavailable', 'failed to provision Solana wallet via Privy');
    }
    if (!isValidSolanaAddress(wallet.address)) {
      // Privy returned an address Privy itself wouldn't have signed for.
      // Bail loud rather than wire a broken handle into the chain layer.
      log.error(
        { address: wallet.address.slice(0, 8) + '…', walletId: wallet.walletId },
        'wallet: Privy returned malformed Solana address',
      );
      throw new ChainError('wallet_unavailable', 'malformed Solana address from Privy');
    }
    return {
      address: wallet.address,
      walletId: wallet.walletId,
      live: true,
      async signTx(messageBase64: string): Promise<string | null> {
        return signSolanaTxWithPrivy(wallet.walletId, messageBase64);
      },
    };
  },

  async getOrCreateAgentWallet(userId, privyDid, agentId, agentName): Promise<WalletHandle> {
    const resolvedPrivyDid = await resolvePrivyDid(userId, privyDid);
    // 1) Read the persisted (agent_id, chain) binding first. Lets a previously
    //    provisioned agent resume signing with its own walletId across restarts.
    const persisted = await store.getAgentWallet(agentId);
    if (persisted) {
      if (!features.privy || persisted.walletId.startsWith('mock_') || persisted.walletId.startsWith('demo_')) {
        // Demo binding — never produced a real signature; round-trip the mock.
        return {
          address: persisted.address as Hex,
          walletId: persisted.walletId,
          live: false,
          async signTypedData(): Promise<Hex | null> {
            log.info({ agentId, address: persisted.address }, 'wallet.demo: signTypedData no-op');
            return null;
          },
        };
      }
      // Live binding — sign with the persisted Privy walletId.
      return {
        address: persisted.address as Hex,
        walletId: persisted.walletId,
        live: true,
        async signTypedData(typedData: unknown): Promise<Hex | null> {
          const sig = await signTypedDataWithPrivy(persisted.walletId, typedData as never);
          return sig as Hex | null;
        },
      };
    }

    // 2) No row yet. Demo path: synthesize + persist a deterministic mock so
    //    repeat calls hit branch (1) and tests stay stable.
    if (!features.privy || !resolvedPrivyDid) {
      const address = demoAgentAddress(agentId);
      const walletId = `mock_agent_${agentId.slice(0, 12)}`;
      try {
        await store.setAgentWallet(agentId, { walletId, address, chain: 'base' });
      } catch (e) {
        // Tests that don't seed the agent row will fail here — log + continue
        // with an in-memory mock so the call site still gets a usable handle.
        log.warn(
          { agentId, agentName, err: e instanceof Error ? e.message : String(e) },
          'wallet.demo: setAgentWallet persist failed, returning ephemeral mock',
        );
      }
      return {
        address: address as Hex,
        walletId,
        live: false,
        async signTypedData(): Promise<Hex | null> {
          log.info({ agentId, address }, 'wallet.demo: signTypedData no-op');
          return null;
        },
      };
    }

    // 3) Live path: provision a fresh Privy server wallet owned by the human's
    //    did, persist the (agentId, chain) → walletId binding, return the
    //    signing handle. `createPrivyAgentWallet` is a thin wrapper that calls
    //    `walletApi.create` directly (the user-level helper returns the
    //    EXISTING wallet, which we don't want here).
    const created = await createPrivyAgentWallet(resolvedPrivyDid);
    if (!created) {
      throw new ChainError('wallet_missing', 'failed to provision Privy wallet for agent');
    }
    await store.setAgentWallet(agentId, {
      walletId: created.walletId,
      address: created.address,
      chain: 'base',
    });
    return {
      address: created.address as Hex,
      walletId: created.walletId,
      live: true,
      async signTypedData(typedData: unknown): Promise<Hex | null> {
        const sig = await signTypedDataWithPrivy(created.walletId, typedData as never);
        return sig as Hex | null;
      },
    };
  },
};

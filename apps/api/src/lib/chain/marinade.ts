/**
 * Marinade Finance adapter — Solana liquid staking via mSOL.
 *
 * Marinade is Solana's largest liquid-staking provider. Users deposit SOL
 * and receive mSOL (an SPL token) that auto-compounds Solana validator
 * rewards while remaining liquid for DeFi composability.
 *
 *   Stake:   SOL  → mSOL  (instant, no lockup)
 *   Unstake: mSOL → SOL   (instant via liquidity pool with fee, OR delayed
 *                          via a 2-day ticket without fee)
 *
 * Status today: APY reads are live, and stake plus instant liquid unstake
 * submit through direct Marinade program instructions when a Solana RPC URL
 * and Privy-backed Solana wallet are available. Delayed ticket unstake
 * remains unavailable.
 *
 * APY data source: Marinade's public state API endpoint at
 *   https://api.marinade.finance/msol/apy/30d
 * returns `{ value: 0.0712 }` style (no auth required). This adapter reads
 * that and exposes it through the standard EarnAdapter surface.
 *
 * Docs:
 *   https://docs.marinade.finance/
 *   https://docs.marinade.finance/marinade-protocol/system-overview
 *   https://docs.marinade.finance/developers/apy-calculation
 */

import { ChainError } from './units.js';
import { apyToBps, apyUnavailable } from './apy.js';
import { log } from '../log.js';
import { createHash } from 'node:crypto';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  findAssociatedTokenAddress,
} from './solana-ata.js';
import { resolveSolanaRpcUrl, signAndSendSolanaTx } from './solana-tx.js';

const DEFAULT_API_URL = 'https://api.marinade.finance/msol/apy/30d';
const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const MARINADE_PROGRAM_ID = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD';
const MARINADE_STATE_ADDRESS = '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC';
const MARINADE_RESERVE_PDA = 'Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN';
const MARINADE_MSOL_AUTHORITY = '3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM';
const MARINADE_LIQ_POOL_MSOL_LEG = '7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE';
const MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY = 'EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL';
const MARINADE_LIQ_POOL_SOL_LEG = 'UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q';
const MARINADE_TREASURY_MSOL_ACCOUNT = 'B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface MarinadeApySummary {
  /** Net staking APY in basis points. Includes validator rewards minus the Marinade fee. */
  apyBps: number;
  /** Source URL the data came from. */
  apiUrl: string;
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
}

/**
 * Fetch the current Marinade mSOL APY. Hits Marinade's public state API —
 * no auth required, no Solana RPC needed for this READ. Read times out at
 * 5s so the Earn route can't hang.
 */
export async function fetchMarinadeApyBps(opts: {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
} = {}): Promise<MarinadeApySummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchImpl(apiUrl, { signal: ctrl.signal });
    if (!res.ok) {
      throw new ChainError('rpc_failed', `Marinade APY ${res.status}`);
    }
    const body = (await res.json()) as { value?: number | string };
    const apyBps = apyToBps(body.value);
    if (apyBps == null) {
      throw apyUnavailable('Marinade');
    }
    return {
      apyBps,
      apiUrl,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw apyUnavailable('Marinade', e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Status of the Marinade integration capability — does NOT trigger any
 * wallet creation, only reports what the adapter would need to flip live.
 *
 * Capability snapshot is static for the current process. APY reads are live;
 * write surfaces need a Solana RPC URL and a live Solana wallet at submit time.
 */
export function marinadeCapability(): {
  provider: 'marinade';
  chain: 'solana';
  surfaces: { apyRead: true; stake: boolean; unstake: boolean };
  envHints: string[];
  notes: string;
} {
  return {
    provider: 'marinade' as const,
    chain: 'solana' as const,
    surfaces: {
      apyRead: true,
      stake: true,
      unstake: true,
    },
    envHints: [
      'PRIVY_APP_ID (Solana chainType wallet provisioning via walletService.getOrCreateUserSolanaWallet)',
      'CHAINSTACK_SOLANA_RPC_URL | SOLANA_RPC_URL | HELIUS_RPC_URL (required before tx submit)',
      'Direct Marinade liquid-staking instruction builder (no SPL Token SDK dependency)',
    ],
    notes:
      'APY works today. Stake and instant liquid unstake submit via direct Marinade program instructions when Solana RPC and Privy Solana wallet signing are configured. Delayed unstake tickets are not implemented.',
  };
}

/**
 * Stake SOL into mSOL. The route wrapper owns wallet provisioning; this helper
 * only validates the amount/RPC and builds/submits the Marinade transaction.
 */

function marinadeInstructionData(anchorMethod: 'deposit' | 'liquid_unstake', amount: bigint): Buffer {
  const data = Buffer.alloc(16);
  createHash('sha256')
    .update(`global:${anchorMethod}`)
    .digest()
    .subarray(0, 8)
    .copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return data;
}

function pubkey(web3: typeof import('@solana/web3.js'), address: string): InstanceType<typeof web3.PublicKey> {
  return new web3.PublicKey(address);
}

function buildDepositInstruction(
  web3: typeof import('@solana/web3.js'),
  owner: InstanceType<typeof import('@solana/web3.js').PublicKey>,
  msolAta: InstanceType<typeof import('@solana/web3.js').PublicKey>,
  amountLamports: bigint,
): InstanceType<typeof import('@solana/web3.js').TransactionInstruction> {
  return new web3.TransactionInstruction({
    programId: pubkey(web3, MARINADE_PROGRAM_ID),
    keys: [
      { pubkey: pubkey(web3, MARINADE_STATE_ADDRESS), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MSOL_MINT), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MARINADE_LIQ_POOL_SOL_LEG), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MARINADE_LIQ_POOL_MSOL_LEG), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY), isSigner: false, isWritable: false },
      { pubkey: pubkey(web3, MARINADE_RESERVE_PDA), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: msolAta, isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MARINADE_MSOL_AUTHORITY), isSigner: false, isWritable: false },
      { pubkey: pubkey(web3, SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: pubkey(web3, TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: marinadeInstructionData('deposit', amountLamports),
  });
}

function buildLiquidUnstakeInstruction(
  web3: typeof import('@solana/web3.js'),
  owner: InstanceType<typeof import('@solana/web3.js').PublicKey>,
  msolAta: InstanceType<typeof import('@solana/web3.js').PublicKey>,
  amountLamports: bigint,
): InstanceType<typeof import('@solana/web3.js').TransactionInstruction> {
  return new web3.TransactionInstruction({
    programId: pubkey(web3, MARINADE_PROGRAM_ID),
    keys: [
      { pubkey: pubkey(web3, MARINADE_STATE_ADDRESS), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MSOL_MINT), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MARINADE_LIQ_POOL_SOL_LEG), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MARINADE_LIQ_POOL_MSOL_LEG), isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, MARINADE_TREASURY_MSOL_ACCOUNT), isSigner: false, isWritable: true },
      { pubkey: msolAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: pubkey(web3, SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: pubkey(web3, TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: marinadeInstructionData('liquid_unstake', amountLamports),
  });
}

export async function marinadeStake(args: {
  signTx: (messageBase64: string) => Promise<string | null>;
  walletAddress: string;
  solLamports: bigint;
}): Promise<{ status: 'unavailable'; reason: string } | { status: 'submitted'; signature: string; confirmed: boolean; mSolMint: string }> {
  if (args.solLamports <= 0n) return { status: 'unavailable', reason: 'invalid_amount' };
  const rpcUrl = resolveSolanaRpcUrl();
  if (!rpcUrl) return { status: 'unavailable', reason: 'solana_rpc_url_missing' };
  const submitted = await signAndSendSolanaTx({
    rpcUrl,
    walletAddress: args.walletAddress,
    signTx: args.signTx,
    label: 'marinade.stake',
    buildTx: async (web3, _connection, fromPubkey) => {
      const transaction = new web3.Transaction();
      transaction.add(await ensureMSolAtaInstruction(web3, args.walletAddress));
      const msolAta = await findAssociatedTokenAddress(web3, args.walletAddress, MSOL_MINT);
      transaction.add(buildDepositInstruction(web3, fromPubkey, msolAta, args.solLamports));
      return transaction;
    },
  });
  return submitted.status === 'submitted' ? { ...submitted, mSolMint: MSOL_MINT } : submitted;
}

export async function marinadeUnstake(args: {
  signTx: (messageBase64: string) => Promise<string | null>;
  walletAddress: string;
  mSolAmount: bigint;
  immediate?: boolean;
}): Promise<{ status: 'unavailable'; reason: string } | { status: 'submitted'; signature: string; confirmed: boolean; via: 'liquid-pool' | 'delayed-ticket' }> {
  if (args.immediate === false) {
    return { status: 'unavailable', reason: 'marinade_delayed_unstake_unimplemented' };
  }
  if (args.mSolAmount <= 0n) return { status: 'unavailable', reason: 'invalid_amount' };
  const rpcUrl = resolveSolanaRpcUrl();
  if (!rpcUrl) return { status: 'unavailable', reason: 'solana_rpc_url_missing' };
  const submitted = await signAndSendSolanaTx({
    rpcUrl,
    walletAddress: args.walletAddress,
    signTx: args.signTx,
    label: 'marinade.unstake',
    buildTx: async (web3, _connection, fromPubkey) => {
      const transaction = new web3.Transaction();
      transaction.add(await ensureMSolAtaInstruction(web3, args.walletAddress));
      const msolAta = await findAssociatedTokenAddress(web3, args.walletAddress, MSOL_MINT);
      transaction.add(buildLiquidUnstakeInstruction(web3, fromPubkey, msolAta, args.mSolAmount));
      return transaction;
    },
  });
  return submitted.status === 'submitted' ? { ...submitted, via: 'liquid-pool' as const } : submitted;
}

export { MSOL_MINT, MARINADE_PROGRAM_ID };

/**
 * REL-02 (Sprint 17.5) — pre-flight helper: returns the
 * `CreateIdempotent` instruction for the user's mSOL ATA. Safe to prepend
 * to any stake/unstake tx unconditionally — the idempotent variant succeeds
 * whether the ATA exists or not.
 *
 * Kept exported for manual transaction builders that need to prepend an mSOL
 * ATA create before stake/unstake. The direct route prepends it
 * unconditionally because missing ATAs are a common first-stake failure mode.
 *
 * Why this matters: a Marinade stake against a wallet that has never held
 * mSOL fails the moment the deposit instruction lands without an existing
 * recipient ATA. Because this adapter avoids the vulnerable SDK dependency,
 * we build that instruction ourselves.
 */
export async function ensureMSolAtaInstruction(
  web3: typeof import('@solana/web3.js'),
  walletAddress: string,
): Promise<InstanceType<typeof import('@solana/web3.js').TransactionInstruction>> {
  return createAssociatedTokenAccountIdempotentInstruction(
    web3,
    walletAddress, // payer
    MSOL_MINT,
    walletAddress, // owner
  );
}

/**
 * REL-02 — compute the user's mSOL ATA address. Exposed for routes that want
 * to log / display the address before tx submit.
 */
export async function deriveMSolAta(
  web3: typeof import('@solana/web3.js'),
  walletAddress: string,
): Promise<string> {
  const pda = await findAssociatedTokenAddress(web3, walletAddress, MSOL_MINT);
  return pda.toBase58();
}

/**
 * Lightweight Marinade adapter exposing the APY surface used by EarnRouter.
 * Stake/unstake live as explicit route helpers above because they are SOL/mSOL
 * flows, not USD-denominated EarnRouter deposits.
 */
export class MarinadeAdapter {
  /** APY is public; write readiness is enforced by the route helpers. */
  get isLive(): boolean {
    return true;
  }

  async getApyBps(): Promise<number> {
    if (process.env['VITEST']) throw apyUnavailable('Marinade');
    try {
      const r = await fetchMarinadeApyBps();
      return r.apyBps;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'marinade: getApyBps failed',
      );
      throw e;
    }
  }
}

export const marinadeAdapter = new MarinadeAdapter();

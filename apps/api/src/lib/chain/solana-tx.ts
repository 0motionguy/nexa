/**
 * Solana transaction helpers shared by Marinade stake/unstake + the admin
 * SOL force-recovery path.
 *
 * Both call sites independently implemented the same pattern: resolve RPC,
 * build a Transaction, attach blockhash + feePayer, serialize the message,
 * sign via the Privy server wallet, re-attach the signature, broadcast.
 * Promoted here so a fix to one (e.g. `confirmTransaction` polling, retry on
 * stale blockhash) lands in both — and the dynamic-import shape stays
 * consistent across modules that don't have a hard dep on `@solana/web3.js`.
 */

import { log } from '../log.js';

/** Resolve the Solana RPC URL from the canonical env vars, in order. */
export function resolveSolanaRpcUrl(): string | null {
  return (
    process.env['HELIUS_RPC_URL'] ??
    process.env['CHAINSTACK_SOLANA_RPC_URL'] ??
    process.env['SOLANA_RPC_URL'] ??
    null
  );
}

/**
 * Build a Transaction lazily — receives the dynamically-imported web3 module +
 * a live Connection + the user's pubkey, returns a populated tx with no
 * blockhash/feePayer set (the helper attaches those). The buildTx callback
 * stays sync where possible; mark async if you need to await an SDK call
 * (Marinade's direct builders are sync today, but other protocol builders may
 * need async RPC reads).
 */
export type BuildSolanaTx<W = unknown> = (
  web3: typeof import('@solana/web3.js'),
  connection: InstanceType<typeof import('@solana/web3.js').Connection>,
  fromPubkey: InstanceType<typeof import('@solana/web3.js').PublicKey>,
) => Promise<W>;

export type SolanaSubmitResult =
  | { status: 'submitted'; signature: string; confirmed: boolean }
  | { status: 'unavailable'; reason: string };

export interface SignAndSendSolanaTxArgs {
  rpcUrl: string;
  walletAddress: string;
  signTx: (messageBase64: string) => Promise<string | null>;
  /** Returns a Transaction-shaped object (web3.Transaction or an SDK tx). */
  buildTx: BuildSolanaTx;
  /**
   * Optional: confirm the tx after broadcast. Default true — production
   * paths should wait so caller knows whether validators accepted it. Set
   * false for fire-and-forget paths.
   */
  confirm?: boolean;
  /** Timeout for `confirmTransaction`, in milliseconds. Default 30s. */
  confirmTimeoutMs?: number;
  /** Diagnostic label surfaced in logs / Sentry — e.g. 'marinade.stake'. */
  label?: string;
}

/**
 * Sign + send a Solana transaction via a Privy server wallet.
 *
 * Returns `{status: 'submitted', signature, confirmed}` on success or
 * `{status: 'unavailable', reason}` on any failure — never throws so callers
 * can map cleanly to a 200-with-flag-or-503 response shape.
 *
 * The `confirmed: false` case means the tx was broadcast but not confirmed
 * within the timeout — the signature is still valid and may land later, but
 * the caller should treat the funds as "in flight" not "received."
 */
export async function signAndSendSolanaTx(
  args: SignAndSendSolanaTxArgs,
): Promise<SolanaSubmitResult> {
  try {
    const web3 = await import('@solana/web3.js');
    const connection = new web3.Connection(args.rpcUrl, 'confirmed');
    const fromPubkey = new web3.PublicKey(args.walletAddress);

    // Caller builds — they own the instructions (transfer, deposit, etc.).
    const txAny = await args.buildTx(web3, connection, fromPubkey);
    const tx = txAny as InstanceType<typeof web3.Transaction>;
    tx.feePayer = fromPubkey;
    if (!tx.recentBlockhash) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
    }

    // Serialize, sign via Privy, re-attach signature.
    const messageBase64 = Buffer.from(tx.serializeMessage()).toString('base64');
    const sigBase64 = await args.signTx(messageBase64);
    if (!sigBase64) {
      return { status: 'unavailable', reason: 'privy_signature_unavailable' };
    }
    tx.addSignature(fromPubkey, Buffer.from(sigBase64, 'base64'));

    // Broadcast.
    const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: false });
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    // Optionally wait for confirmation. Default ON because every caller we
    // have today wants to know the tx landed before recording success.
    let confirmed = false;
    if (args.confirm !== false) {
      const timeoutMs = args.confirmTimeoutMs ?? 30_000;
      try {
        const result = await Promise.race([
          connection.confirmTransaction(signature, 'confirmed').then(() => 'confirmed' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
        ]);
        confirmed = result === 'confirmed';
        if (!confirmed) {
          log.warn(
            { signature, label: args.label, timeoutMs },
            'solana-tx: confirm timeout — tx may land later',
          );
        }
      } catch (e) {
        // confirmTransaction can throw on stale blockhash etc.; the tx is
        // still in the mempool. We log + report unconfirmed; the signature
        // is the authoritative receipt.
        log.warn(
          { err: e instanceof Error ? e.message : String(e), signature, label: args.label },
          'solana-tx: confirm threw — tx may land later',
        );
      }
    }

    return { status: 'submitted', signature, confirmed };
  } catch (e) {
    log.error(
      { err: e instanceof Error ? e.message : String(e), label: args.label },
      'solana-tx: signAndSend failed',
    );
    return { status: 'unavailable', reason: 'send_failed' };
  }
}

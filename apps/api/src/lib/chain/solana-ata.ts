/**
 * Solana Associated Token Account (ATA) helpers — without @solana/spl-token.
 *
 * Why hand-rolled: @solana/spl-token transitively depends on `bigint-buffer`,
 * which has an unpatched high-severity advisory (`pnpm audit` blocks the
 * verify gate). Until the upstream lands a fix, we build the few ATA
 * instructions we need from scratch using only `@solana/web3.js`.
 *
 * What this file covers:
 *   - `findAssociatedTokenAddress(mint, owner)` — PDA derivation
 *   - `createAssociatedTokenAccountIdempotentInstruction(payer, mint, owner)` —
 *     `Create (idempotent)` from the spl-associated-token-account program
 *
 * Why idempotent: `Create` (discriminator 0) fails if the ATA already exists.
 * `CreateIdempotent` (discriminator 1) succeeds either way, so callers can
 * prepend it unconditionally without an extra `getAccountInfo` round-trip.
 * Source: github.com/solana-labs/solana-program-library/blob/master/
 *   associated-token-account/program/src/instruction.rs
 *
 * REL-02 (Sprint 17.5) - kept for manual Marinade transaction builders.
 * mSOL ATA creation on first stake is otherwise a common failure on
 * first-time accounts.
 */

const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

type Web3 = typeof import('@solana/web3.js');
type PublicKey = InstanceType<Web3['PublicKey']>;
type TransactionInstruction = InstanceType<Web3['TransactionInstruction']>;

/**
 * Derive the associated token account address for (mint, owner). PDA over
 * seeds `[owner, TOKEN_PROGRAM_ID, mint]` under the ATA program.
 */
export async function findAssociatedTokenAddress(
  web3: Web3,
  ownerAddress: string,
  mintAddress: string,
): Promise<PublicKey> {
  const owner = new web3.PublicKey(ownerAddress);
  const mint = new web3.PublicKey(mintAddress);
  const tokenProgram = new web3.PublicKey(TOKEN_PROGRAM_ID);
  const ataProgram = new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ataProgram,
  );
  return pda;
}

/**
 * Build the `CreateIdempotent` instruction for the (mint, owner) ATA. Safe
 * to prepend to any tx that touches the ATA — succeeds when the account
 * already exists. Payer covers the rent (~0.002 SOL).
 *
 * Account order is fixed by the SPL ATA program; don't rearrange.
 */
export async function createAssociatedTokenAccountIdempotentInstruction(
  web3: Web3,
  payerAddress: string,
  mintAddress: string,
  ownerAddress: string,
): Promise<TransactionInstruction> {
  const payer = new web3.PublicKey(payerAddress);
  const mint = new web3.PublicKey(mintAddress);
  const owner = new web3.PublicKey(ownerAddress);
  const tokenProgram = new web3.PublicKey(TOKEN_PROGRAM_ID);
  const systemProgram = new web3.PublicKey(SYSTEM_PROGRAM_ID);
  const ataProgram = new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
  const ata = await findAssociatedTokenAddress(web3, ownerAddress, mintAddress);

  return new web3.TransactionInstruction({
    programId: ataProgram,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: systemProgram, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    // Discriminator 1 = CreateIdempotent.
    data: Buffer.from([1]),
  });
}

export {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
};

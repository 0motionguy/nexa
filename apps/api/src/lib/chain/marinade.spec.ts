/**
 * Marinade Finance adapter tests — Sprint 15 alternative providers.
 *
 * These tests pin the public APY read plus the Solana stake/instant-unstake
 * submit path. Route tests cover wallet provisioning; this file keeps adapter
 * pre-flight behavior deterministic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignAndSendSolanaTxArgs } from './solana-tx.js';

const solanaSubmitMock = vi.hoisted(() => ({
  signAndSendSolanaTx: vi.fn(),
}));

vi.mock('./solana-tx.js', () => ({
  resolveSolanaRpcUrl: () =>
    process.env['HELIUS_RPC_URL'] ??
    process.env['CHAINSTACK_SOLANA_RPC_URL'] ??
    process.env['SOLANA_RPC_URL'] ??
    null,
  signAndSendSolanaTx: solanaSubmitMock.signAndSendSolanaTx,
}));
import {
  deriveMSolAta,
  ensureMSolAtaInstruction,
  fetchMarinadeApyBps,
  marinadeAdapter,
  marinadeCapability,
  marinadeStake,
  marinadeUnstake,
  MSOL_MINT,
  MARINADE_PROGRAM_ID,
} from './marinade.js';

describe('lib/chain/marinade', () => {
  const originalRpcEnv = {
    helius: process.env['HELIUS_RPC_URL'],
    chainstack: process.env['CHAINSTACK_SOLANA_RPC_URL'],
    solana: process.env['SOLANA_RPC_URL'],
  };

  afterEach(() => {
    restoreRpcEnv();
    solanaSubmitMock.signAndSendSolanaTx.mockClear();
  });

  function restoreRpcEnv(): void {
    if (originalRpcEnv.helius === undefined) delete process.env['HELIUS_RPC_URL'];
    else process.env['HELIUS_RPC_URL'] = originalRpcEnv.helius;
    if (originalRpcEnv.chainstack === undefined) delete process.env['CHAINSTACK_SOLANA_RPC_URL'];
    else process.env['CHAINSTACK_SOLANA_RPC_URL'] = originalRpcEnv.chainstack;
    if (originalRpcEnv.solana === undefined) delete process.env['SOLANA_RPC_URL'];
    else process.env['SOLANA_RPC_URL'] = originalRpcEnv.solana;
  }

  function clearRpcEnv(): void {
    delete process.env['HELIUS_RPC_URL'];
    delete process.env['CHAINSTACK_SOLANA_RPC_URL'];
    delete process.env['SOLANA_RPC_URL'];
  }

  it('parses Marinade APY payload (decimal -> bps)', async () => {
    const fetchImpl = async (): Promise<Response> => Response.json({ value: 0.0712 });
    const r = await fetchMarinadeApyBps({ fetchImpl });
    expect(r.apyBps).toBe(712);
    expect(r.apiUrl).toContain('marinade.finance');
    expect(typeof r.fetchedAt).toBe('string');
  });

  it('rejects payloads missing the value field', async () => {
    const fetchImpl = async (): Promise<Response> => Response.json({ ok: 1 });
    await expect(fetchMarinadeApyBps({ fetchImpl })).rejects.toThrow(/Marinade/);
  });

  it('throws when the upstream HTTP call fails', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('boom', { status: 502 });
    await expect(fetchMarinadeApyBps({ fetchImpl })).rejects.toThrow(/Marinade APY 502/);
  });

  it('capability snapshot pins surfaces and env hints', () => {
    const cap = marinadeCapability();
    expect(cap.provider).toBe('marinade');
    expect(cap.chain).toBe('solana');
    expect(cap.surfaces.apyRead).toBe(true);
    expect(cap.surfaces.stake).toBe(true);
    expect(cap.surfaces.unstake).toBe(true);
    expect(cap.envHints.length).toBeGreaterThan(0);
  });

  it('exports canonical Solana addresses', () => {
    expect(MSOL_MINT).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58
    expect(MARINADE_PROGRAM_ID).toBe('MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD');
  });

  it('adapter is always considered live for the read-only surface', () => {
    expect(marinadeAdapter.isLive).toBe(true);
  });

  it('adapter getApyBps refuses to run in vitest (deterministic test guard)', async () => {
    await expect(marinadeAdapter.getApyBps()).rejects.toThrow(/Marinade/);
  });

  describe('marinadeStake/marinadeUnstake pre-flight', () => {
    const noopSignTx = async (): Promise<string | null> => null;

    it('stake returns `unavailable` when Solana RPC is missing', async () => {
      clearRpcEnv();
      const r = await marinadeStake({
        signTx: noopSignTx,
        walletAddress: 'So11111111111111111111111111111111111111112',
        solLamports: 50_000_000n, // 0.05 SOL
      });
      expect(r).toMatchObject({ status: 'unavailable', reason: 'solana_rpc_url_missing' });
    });

    it('stake builds and submits when Solana RPC exists', async () => {
      process.env['HELIUS_RPC_URL'] = 'https://solana.example.invalid';
      solanaSubmitMock.signAndSendSolanaTx.mockImplementationOnce(async (args: SignAndSendSolanaTxArgs) => {
        const web3 = await import('@solana/web3.js');
        const owner = new web3.PublicKey('So11111111111111111111111111111111111111112');
        const tx = await args.buildTx(
          web3,
          {} as Parameters<SignAndSendSolanaTxArgs['buildTx']>[1],
          owner,
        ) as InstanceType<typeof web3.Transaction>;
        expect(tx.instructions).toHaveLength(2);
        const depositIx = tx.instructions[1]!;
        expect(depositIx.programId.toBase58()).toBe(MARINADE_PROGRAM_ID);
        expect(depositIx.keys).toHaveLength(11);
        expect(depositIx.keys[6]!.pubkey.toBase58()).toBe(owner.toBase58());
        expect(depositIx.keys[6]!.isSigner).toBe(true);
        expect(depositIx.data).toHaveLength(16);
        return {
          status: 'submitted',
          signature: 'stake_sig_123',
          confirmed: true,
        };
      });

      const r = await marinadeStake({
        signTx: noopSignTx,
        walletAddress: 'So11111111111111111111111111111111111111112',
        solLamports: 50_000_000n,
      });

      expect(r).toMatchObject({ status: 'submitted', signature: 'stake_sig_123', confirmed: true });
      expect(solanaSubmitMock.signAndSendSolanaTx).toHaveBeenCalledWith(expect.objectContaining({
        rpcUrl: 'https://solana.example.invalid',
        walletAddress: 'So11111111111111111111111111111111111111112',
        label: 'marinade.stake',
      }));
    });

    it('delayed unstake returns `unavailable` without pretending to submit', async () => {
      clearRpcEnv();
      const r = await marinadeUnstake({
        signTx: noopSignTx,
        walletAddress: 'So11111111111111111111111111111111111111112',
        mSolAmount: 50_000_000n,
        immediate: false,
      });
      expect(r).toMatchObject({ status: 'unavailable', reason: 'marinade_delayed_unstake_unimplemented' });
    });

    it('immediate unstake builds and submits when Solana RPC exists', async () => {
      process.env['HELIUS_RPC_URL'] = 'https://solana.example.invalid';
      solanaSubmitMock.signAndSendSolanaTx.mockImplementationOnce(async (args: SignAndSendSolanaTxArgs) => {
        const web3 = await import('@solana/web3.js');
        const owner = new web3.PublicKey('So11111111111111111111111111111111111111112');
        const tx = await args.buildTx(
          web3,
          {} as Parameters<SignAndSendSolanaTxArgs['buildTx']>[1],
          owner,
        ) as InstanceType<typeof web3.Transaction>;
        expect(tx.instructions).toHaveLength(2);
        const unstakeIx = tx.instructions[1]!;
        expect(unstakeIx.programId.toBase58()).toBe(MARINADE_PROGRAM_ID);
        expect(unstakeIx.keys).toHaveLength(10);
        expect(unstakeIx.keys[6]!.pubkey.toBase58()).toBe(owner.toBase58());
        expect(unstakeIx.keys[6]!.isSigner).toBe(true);
        expect(unstakeIx.keys[7]!.pubkey.toBase58()).toBe(owner.toBase58());
        expect(unstakeIx.keys[7]!.isWritable).toBe(true);
        expect(unstakeIx.data).toHaveLength(16);
        return {
          status: 'submitted',
          signature: 'unstake_sig_123',
          confirmed: false,
        };
      });

      const r = await marinadeUnstake({
        signTx: noopSignTx,
        walletAddress: 'So11111111111111111111111111111111111111112',
        mSolAmount: 50_000_000n,
      });

      expect(r).toMatchObject({ status: 'submitted', signature: 'unstake_sig_123', confirmed: false });
      expect(solanaSubmitMock.signAndSendSolanaTx).toHaveBeenCalledWith(expect.objectContaining({
        rpcUrl: 'https://solana.example.invalid',
        walletAddress: 'So11111111111111111111111111111111111111112',
        label: 'marinade.unstake',
      }));
    });
  });

  /* ── TEST-04 / REL-02 (Sprint 17.5) — mSOL ATA pre-flight helper ────────
   * The direct route prepends this helper, so first-stake accounts do not
   * fail because the mSOL ATA is missing. */
  describe('mSOL ATA pre-flight (REL-02)', () => {
    it('derives a deterministic ATA for a given wallet (no SDK required)', async () => {
      const web3 = await import('@solana/web3.js');
      const owner = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'; // demo pubkey
      const ata1 = await deriveMSolAta(web3, owner);
      const ata2 = await deriveMSolAta(web3, owner);
      // ATA is a PDA, derivation is deterministic.
      expect(ata1).toBe(ata2);
      // Base58 shape (32–44 chars).
      expect(ata1).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      // ATA address is NOT the owner address (PDA != EOA).
      expect(ata1).not.toBe(owner);
    });

    it('builds a CreateIdempotent instruction with the correct program + accounts', async () => {
      const web3 = await import('@solana/web3.js');
      const owner = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
      const ix = await ensureMSolAtaInstruction(web3, owner);

      // ATA program id.
      expect(ix.programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      // Data must encode discriminator 1 (CreateIdempotent).
      expect(Array.from(ix.data)).toEqual([1]);
      // Account order: [payer (signer, mut), ata (mut), owner, mint, system, token]
      expect(ix.keys.length).toBe(6);
      expect(ix.keys[0]!.isSigner).toBe(true);
      expect(ix.keys[0]!.isWritable).toBe(true);
      expect(ix.keys[1]!.isWritable).toBe(true);
      // Mint must be MSOL.
      expect(ix.keys[3]!.pubkey.toBase58()).toBe(MSOL_MINT);
      // System + token program well-known ids.
      expect(ix.keys[4]!.pubkey.toBase58()).toBe('11111111111111111111111111111111');
      expect(ix.keys[5]!.pubkey.toBase58()).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    });
  });
});

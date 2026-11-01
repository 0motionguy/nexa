/**
 * Hyperliquid per-process agent wallet (ADR-0004).
 *
 * Why: every /exchange write used to sign with the user's master Privy
 * wallet, and HL tracks nonces PER SIGNER (100-nonce sliding window). Two
 * API processes signing for the same user race that window and produce
 * intermittent "nonce already used" rejections. HL's sanctioned fix is an
 * agent (API) wallet per process: the master signs one `approveAgent`, the
 * agent then signs L1 actions with its OWN nonce window.
 *
 * Key custody: the agent private key is EPHEMERAL — generated at first use,
 * held only in this process's memory, never persisted anywhere. A restart
 * mints a new key and re-approves lazily on each user's next live action.
 * Blast radius of a leaked agent key is trade-only: Hyperliquid rejects
 * fund-moving user-signed actions (usdSend / withdraw3 / usdClassTransfer)
 * from agents, and our fund moves keep the master signing path regardless.
 *
 * Approval bookkeeping: in-memory per process (matches the key lifetime),
 * plus an append-only `nb_hl_agents` audit row per approval so incident
 * response can answer "which agent keys could trade for which wallet, when".
 *
 * Failure policy: FAIL OPEN to master signing. An approval hiccup must
 * degrade to the pre-agent behavior (slower under multi-process, but
 * correct), never block an order.
 */

import { hostname } from 'node:os';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { signUserSignedAction as sdkSignUserSignedAction } from '@nktkas/hyperliquid/signing';
import { ApproveAgentTypes } from '@nktkas/hyperliquid/api/exchange';
import { env } from '../env.js';
import { log } from '../log.js';
import { signTypedDataWithPrivy } from '../privy.js';
import { HL_EXCHANGE_URL, HL_USER_SIGN_CHAIN_ID, HL_HYPERLIQUID_CHAIN } from './hl-config.js';

let processAgent: PrivateKeyAccount | null = null;

/** Master wallet addresses (lowercase) that approved this process's agent. */
const approvedMasters = new Set<string>();

/** Masters whose approval is in flight — dedupes concurrent first orders. */
const approvalInFlight = new Map<string, Promise<boolean>>();

export function hlAgentWalletsEnabled(): boolean {
  return env.HL_AGENT_WALLETS;
}

/** The process agent account, minted lazily. Exposed for the signer. */
export function getProcessAgent(): PrivateKeyAccount {
  if (!processAgent) {
    processAgent = privateKeyToAccount(generatePrivateKey());
    log.info(
      { agentAddress: processAgent.address, process: `${hostname()}:${process.pid}` },
      'hl-agent: minted ephemeral process agent key',
    );
  }
  return processAgent;
}

export function _resetHlAgentForTests(): void {
  processAgent = null;
  approvedMasters.clear();
  approvalInFlight.clear();
}

/** Append the audit row. Best-effort: audit must never block trading. */
async function recordApprovalAudit(masterAddress: string, agentAddress: string): Promise<void> {
  try {
    const { storeBoot } = await import('../../store/index.js');
    const db = storeBoot.db;
    if (!db) return; // in-memory/demo store — no durable audit surface
    const { nbHlAgents } = await import('../../db/schema/index.js');
    await db.insert(nbHlAgents).values({
      userWalletAddress: masterAddress,
      agentAddress,
      agentName: null,
      processId: `${hostname()}:${process.pid}`,
    });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), masterAddress },
      'hl-agent: approval audit insert failed (non-blocking)',
    );
  }
}

/**
 * Ensure this process's agent is approved to trade for the given master
 * wallet. Returns true when the agent may sign L1 actions for that master.
 * Master-signed `approveAgent` is submitted at most once per (process,
 * master); concurrent callers share the in-flight promise.
 */
export async function ensureAgentApproved(input: {
  privyWalletId: string;
  privyWalletAddress: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const master = input.privyWalletAddress.toLowerCase();
  if (approvedMasters.has(master)) return true;
  const inFlight = approvalInFlight.get(master);
  if (inFlight) return inFlight;
  const attempt = (async (): Promise<boolean> => {
    const agent = getProcessAgent();
    const fetchImpl = input.fetchImpl ?? fetch;
    try {
      const nonce = Date.now();
      // Unnamed agent (agentName '') — one slot per account, replaced on
      // re-approval, which is exactly the per-process-restart semantics we
      // want. Named agents (max 3) stay free for other tooling.
      const action = {
        type: 'approveAgent' as const,
        signatureChainId: HL_USER_SIGN_CHAIN_ID,
        hyperliquidChain: HL_HYPERLIQUID_CHAIN,
        agentAddress: agent.address,
        agentName: '',
        nonce,
      };
      const signature = await sdkSignUserSignedAction({
        wallet: {
          address: input.privyWalletAddress,
          async signTypedData(params: unknown): Promise<`0x${string}`> {
            const sig = await signTypedDataWithPrivy(input.privyWalletId, params as never);
            if (!sig) throw new Error('privy_sign_failed');
            return sig as `0x${string}`;
          },
        },
        action,
        types: ApproveAgentTypes,
      });
      const res = await fetchImpl(HL_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, signature, nonce }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (!res.ok || data.status !== 'ok') {
        log.warn(
          { status: res.status, data, master },
          'hl-agent: approveAgent rejected — falling back to master signing',
        );
        return false;
      }
      approvedMasters.add(master);
      void recordApprovalAudit(master, agent.address.toLowerCase());
      log.info({ master, agentAddress: agent.address }, 'hl-agent: agent approved for master');
      return true;
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), master },
        'hl-agent: approveAgent failed — falling back to master signing',
      );
      return false;
    } finally {
      approvalInFlight.delete(master);
    }
  })();
  approvalInFlight.set(master, attempt);
  return attempt;
}

/**
 * Circle CCTP (Cross-Chain Transfer Protocol) adapter — Sprint 15 scaffold.
 *
 * Native USDC cross-chain transfer via Circle's burn-on-source / mint-on-dest
 * primitive. Preferred over swap aggregators when both legs are USDC because
 * it preserves Circle's 1:1 redemption and avoids slippage entirely.
 *
 * Status today: **scaffold only.** Real wiring requires:
 *   1. Domain IDs from https://developers.circle.com/cctp/cctp-protocol-contract
 *      (Base = 6, Polygon = 7, Arbitrum = 3, Optimism = 2, etc.)
 *   2. TokenMessenger contract addresses per chain
 *   3. Attestation polling against `https://iris-api.circle.com/attestations/{messageHash}`
 *   4. MessageTransmitter.receiveMessage on destination
 *
 * Until the wiring lands, the adapter reports `isLive: false`. The bridge
 * router treats CCTP as an unavailable provider and falls back to Socket /
 * LI.FI as before. This keeps the registry honest: CCTP stays `docs-only`
 * in `/system/providers` until the implementation flips.
 *
 * Reference docs:
 *   https://developers.circle.com/cctp
 *   https://developers.circle.com/cctp/v2-vs-v1
 *   https://www.circle.com/cross-chain-transfer-protocol
 */

import { log } from '../log.js';
import type { Chain, BridgeAdapter, BridgeQuote, BridgeQuoteInput } from '../bridge-router.js';

const IRIS_API_BASE = 'https://iris-api.circle.com';
const IRIS_TIMEOUT_MS = 6000;
const ATTESTATION_POLL_INTERVAL_MS = 5000;
const ATTESTATION_POLL_MAX_ATTEMPTS = 60; // ~5 min — Circle finality on Base is typically <2 min

/** Circle CCTP domain IDs as of 2026-06-17. */
export const CCTP_DOMAIN: Partial<Record<Chain, number>> = {
  base: 6,
  optimism: 2,
  arbitrum: 3,
  polygon: 7,
};

/** CCTP supports USDC. EURC and other assets fall back to Socket / LI.FI. */
const CCTP_ASSETS = new Set(['USDC']);

export function isCctpRoute(input: Pick<BridgeQuoteInput, 'fromChain' | 'toChain' | 'fromToken' | 'toToken'>): boolean {
  if (!CCTP_ASSETS.has(input.fromToken) || !CCTP_ASSETS.has(input.toToken)) return false;
  if (input.fromChain === input.toChain) return false;
  return CCTP_DOMAIN[input.fromChain] !== undefined && CCTP_DOMAIN[input.toChain] !== undefined;
}

/**
 * Scaffold adapter — never returns a quote today. The shape matches
 * `BridgeAdapter` so when the implementation lands, the bridge router can
 * prefer this over Socket without code changes elsewhere.
 *
 * To wire it live:
 *   1. Replace `quote()` body with the Circle TokenMessenger.depositForBurn
 *      calldata + attestation poll plan + receiveMessage destination call.
 *   2. Flip `get isLive` to gate on Circle availability (RPC reachable + CCTP
 *      contracts deployed on both chains in question).
 *   3. Add `lib/chain/cctp.spec.ts` to assert the attestation flow.
 *   4. Update `apps/api/src/lib/provider-registry.ts` `circle-cctp` entry
 *      from `docs-only` to a dynamic `resolveStatus()`.
 */
export class CctpAdapter implements BridgeAdapter {
  readonly name = 'socket' as const; // placeholder until BridgeAdapter type widens
  /** Always false today. Flip to `features.cctp` once the adapter is wired. */
  get isLive(): boolean {
    return false;
  }

  async quote(_input: BridgeQuoteInput): Promise<BridgeQuote | null> {
    // Scaffold: returning null tells the router "I have no route" so it falls
    // through to Socket / LI.FI. When the live implementation lands, this
    // method will construct the calldata for `TokenMessenger.depositForBurn`
    // and a placeholder `receiveMessage` to be invoked after Circle issues
    // the attestation.
    return null;
  }
}

export const cctpAdapter = new CctpAdapter();

/* ── Sprint 16.2 — CCTP live wiring ────────────────────────────────────────
 *
 * Three-step protocol per Circle docs:
 *   1. `TokenMessenger.depositForBurn(amount, destDomain, mintRecipient, USDC)`
 *      on the source chain. Emits a `MessageSent` log whose `body` is the
 *      raw message bytes; keccak256(body) is the `messageHash` Circle
 *      uses to key the attestation.
 *   2. Poll `${IRIS_API_BASE}/attestations/${messageHash}` until the
 *      attestation is `complete`. Circle typically signs in 30-90 seconds on
 *      Base mainnet; we cap polling at 5 minutes.
 *   3. Call `MessageTransmitter.receiveMessage(message, attestation)` on the
 *      destination chain. This mints the same USDC amount minus Circle's
 *      protocol fee (0 today on the main public CCTP V1 deployment).
 *
 * The functions below own steps 2 + 3. Step 1 (the deposit transaction) is
 * built by the caller because it owns the EVM signing context — wallet.ts's
 * `WalletHandle.signTypedData` + a viem walletClient. We expose helpers so
 * the bridge router can compose them.
 */

export type CctpAttestationStatus = 'pending' | 'complete' | 'failed';

export interface CctpAttestation {
  status: CctpAttestationStatus;
  /** Hex-encoded attestation signature when status === 'complete'. */
  attestation: `0x${string}` | null;
  /** Original message bytes (hex), echoed back from Circle. */
  message: `0x${string}` | null;
  /** Number of polls performed (0 on first hit). */
  polls: number;
}

/**
 * Fetch a single attestation snapshot from Circle Iris. No polling — call
 * `pollCctpAttestation` for the bounded retry version.
 *
 * Sprint 16.3 — 5xx, 429, network errors, timeouts all classify as PENDING
 * (still trying). Only an explicit Circle `failed` body or a 4xx≠404
 * classifies as FAILED. This stops a single transient 502 from killing a
 * 5-minute poll that would otherwise have completed successfully.
 */
export async function fetchCctpAttestation(
  messageHash: `0x${string}`,
  opts: { fetchImpl?: typeof fetch; apiBase?: string } = {},
): Promise<CctpAttestation> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? IRIS_API_BASE;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IRIS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${apiBase}/attestations/${messageHash}`, { signal: ctrl.signal });
    if (res.status === 404) return { status: 'pending', attestation: null, message: null, polls: 0 };
    // 5xx + 429 are transient — keep polling. Only 4xx≠404 is terminal.
    if (res.status >= 500 || res.status === 429) {
      return { status: 'pending', attestation: null, message: null, polls: 0 };
    }
    if (!res.ok) {
      return { status: 'failed', attestation: null, message: null, polls: 0 };
    }
    const body = (await res.json()) as {
      status?: string;
      attestation?: string;
      message?: string;
    };
    // Circle Iris (v1) reports `pending_confirmations` while the burn awaits
    // finality, `complete` when signed, and `error`/`failed` on a real failure.
    // Map ONLY complete→complete and explicit error→failed; everything else
    // (pending_confirmations, pending, unknown transient states) stays pending
    // so the poll keeps going. The prior `=== 'pending'` check treated Circle's
    // actual `pending_confirmations` string as a terminal failure, killing the
    // transfer on its very first poll.
    const rawStatus = String(body.status ?? '').toLowerCase();
    const status: CctpAttestationStatus =
      rawStatus === 'complete'
        ? 'complete'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'failed'
          : 'pending';
    return {
      status,
      attestation: (body.attestation ?? null) as `0x${string}` | null,
      message: (body.message ?? null) as `0x${string}` | null,
      polls: 0,
    };
  } catch (e) {
    // Network error / AbortError — treat as pending so the poll loop retries.
    // Programming errors (parse failures inside the success branch above) are
    // already surfaced because they happen after status checks succeed.
    log.warn({ err: e instanceof Error ? e.message : String(e), messageHash }, 'cctp: attestation fetch failed');
    return { status: 'pending', attestation: null, message: null, polls: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll Circle Iris for an attestation. Returns the first `complete` or
 * `failed` snapshot, or a final `pending` after `maxAttempts` polls.
 *
 * Sprint 16.3 — exponential-ish back-off so a flaky Iris doesn't bombard the
 * endpoint: base interval 5s, doubled each consecutive non-progress poll,
 * capped at 30s. Reset to 5s once any progress happens (in practice the only
 * progress is `complete`, but the structure supports incremental status).
 */
export async function pollCctpAttestation(
  messageHash: `0x${string}`,
  opts: {
    fetchImpl?: typeof fetch;
    apiBase?: string;
    maxAttempts?: number;
    intervalMs?: number;
    maxIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<CctpAttestation> {
  const maxAttempts = opts.maxAttempts ?? ATTESTATION_POLL_MAX_ATTEMPTS;
  const baseIntervalMs = opts.intervalMs ?? ATTESTATION_POLL_INTERVAL_MS;
  const maxIntervalMs = opts.maxIntervalMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  let last: CctpAttestation = { status: 'pending', attestation: null, message: null, polls: 0 };
  let backoff = baseIntervalMs;
  for (let i = 0; i < maxAttempts; i++) {
    last = await fetchCctpAttestation(messageHash, opts);
    last.polls = i + 1;
    if (last.status === 'complete' || last.status === 'failed') return last;
    if (i < maxAttempts - 1) await sleep(backoff);
    // Back off until we cap: 5s → 10s → 20s → 30s → 30s → ...
    backoff = Math.min(backoff * 2, maxIntervalMs);
  }
  return last;
}

/**
 * Encode + sign the `MessageTransmitter.receiveMessage(message, attestation)`
 * call on the destination chain. Returns calldata the caller can submit via
 * their existing EVM tx pipeline (alchemy gas sponsorship or direct
 * `eth_sendTransaction`).
 *
 * Function selector: 0x57ecfd28 (receiveMessage(bytes,bytes))
 * Calldata layout per ABI: selector + offset(message) + offset(attestation) +
 *   bytes(message) + bytes(attestation), each tail prefixed with length.
 */
export function buildReceiveMessageCalldata(args: {
  message: `0x${string}`;
  attestation: `0x${string}`;
}): `0x${string}` {
  const selector = '0x57ecfd28';
  const stripHex = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h);
  const message = stripHex(args.message);
  const attestation = stripHex(args.attestation);
  const messageLen = message.length / 2;
  const attestationLen = attestation.length / 2;

  // Two dynamic bytes args. ABI encoding: head = 2 * 32B offsets, then tails.
  // Offset of `message` tail = 0x40 (after the 2 offsets in head).
  // Offset of `attestation` tail = 0x40 + 32 (len) + ceil(messageLen, 32).
  const word = (n: bigint): string => n.toString(16).padStart(64, '0');
  const pad = (hex: string): string => {
    const remainder = hex.length % 64;
    return remainder === 0 ? hex : hex + '0'.repeat(64 - remainder);
  };
  const messageOffset = 64n; // 0x40
  const messageTailLen = 32 + Math.ceil(messageLen / 32) * 32;
  const attestationOffset = messageOffset + BigInt(messageTailLen);

  const head = word(messageOffset) + word(attestationOffset);
  const messageTail = word(BigInt(messageLen)) + pad(message);
  const attestationTail = word(BigInt(attestationLen)) + pad(attestation);

  return (selector + head + messageTail + attestationTail) as `0x${string}`;
}

/* ── Sprint 19 — CCTP V1 execute path ──────────────────────────────────────
 *
 * Contract registry sourced from
 *   https://developers.circle.com/cctp/evm-smart-contracts
 * (cross-checked 2026-06-21). Native USDC addresses sourced from
 *   https://developers.circle.com/stablecoins/usdc-on-main-networks
 *
 * Flow:
 *   1. executeCctpBurn  → batches USDC.approve(messenger, amt) + messenger.depositForBurn
 *                         via the existing Alchemy 7702 executor on the SOURCE chain
 *   2. (worker) extracts MessageSent(message) log from the burn receipt and
 *      records `cctpMessageBody` + `cctpMessageHash = keccak256(message)`
 *   3. (worker) pollCctpAttestation against Iris until `complete`
 *   4. executeCctpMint   → MessageTransmitter.receiveMessage(message, attestation)
 *                          via the same executor on the DESTINATION chain
 *
 * CCTP is 1:1 (no slippage). Circle's protocol fee is 0 on the public V1
 * deployment today; round-trip cost is gas on both legs only (sponsored by
 * the Alchemy Gas Manager paymaster when policy id is configured).
 *
 * Note: requires viem's `encodeFunctionData` + `keccak256`; both already in
 * node_modules via @nexa/api → viem (used by alchemy.ts).
 */

import { encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { executor } from './alchemy.js';
import { CHAIN_IDS } from '../bridge-router.js';

/** CCTP TokenMessenger (burn entrypoint) per chain — V1 deployment. */
export const CCTP_TOKEN_MESSENGER: Partial<Record<Chain, Hex>> = {
  arbitrum: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
  polygon: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
  base: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
  optimism: '0x2B4069517957735bE00ceE0fadAE88a26365528f',
};

/** CCTP MessageTransmitter (mint entrypoint) per chain — V1 deployment. */
export const CCTP_MESSAGE_TRANSMITTER: Partial<Record<Chain, Hex>> = {
  arbitrum: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
  polygon: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
  base: '0xAD09780d193884d503182aD4588450C416D6F9D4',
  optimism: '0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8',
};

/** Native USDC contract per chain. */
export const USDC_BY_CHAIN: Partial<Record<Chain, Hex>> = {
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
};

/** keccak256("MessageSent(bytes)") — topic0 for the burn receipt log. */
export const MESSAGE_SENT_TOPIC0 =
  '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036' as const;

const depositForBurnAbi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64)',
]);

const erc20ApproveAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const erc20TransferAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Encode TokenMessenger.depositForBurn calldata.
 *
 * `mintRecipient` is a bytes32 — for EVM destinations, left-pad the EVM
 * address with 12 zero bytes; for Solana destinations, encode the 32-byte
 * SPL recipient pubkey directly.
 */
export function buildDepositForBurnCalldata(args: {
  amount: bigint;
  destDomain: number;
  mintRecipient: Hex;
  burnToken: Hex;
}): Hex {
  return encodeFunctionData({
    abi: depositForBurnAbi,
    functionName: 'depositForBurn',
    args: [args.amount, args.destDomain, args.mintRecipient, args.burnToken],
  });
}

/** Encode ERC-20 approve calldata — USDC must allow TokenMessenger to burn. */
export function buildErc20ApproveCalldata(spender: Hex, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: 'approve',
    args: [spender, amount],
  });
}

/** Encode ERC-20 transfer calldata — used for the bridge-fee skim to treasury. */
export function buildErc20TransferCalldata(to: Hex, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20TransferAbi,
    functionName: 'transfer',
    args: [to, amount],
  });
}

/** Pad a 20-byte EVM address into a bytes32 (12 zero bytes prefix + address). */
export function addressToBytes32(address: Hex): Hex {
  const a = address.startsWith('0x') ? address.slice(2) : address;
  return (`0x${'0'.repeat(24)}${a.toLowerCase()}`) as Hex;
}

export interface CctpExecResult {
  /** Alchemy preparedCallId (track via wallet_getCallsStatus). */
  callId: string;
  /** True when no real userop was submitted (no Alchemy/Privy keys). */
  demo: boolean;
  submittedUnknown?: boolean;
  /** Live signing configured but failed — surface, don't fake demo success. */
  failed?: boolean;
  failureCode?: string;
}

/**
 * Submit the CCTP burn leg: approve USDC for the TokenMessenger, then
 * depositForBurn(amount, destDomain, recipientBytes32, USDC) — batched in one
 * EIP-7702 user-op via the existing Alchemy executor.
 *
 * Returns `null` when the source chain isn't on CCTP, or the destination
 * chain has no CCTP domain. The caller should pre-validate via `isCctpRoute`.
 */
export async function executeCctpBurn(input: {
  userId: string;
  srcChain: Chain;
  dstChain: Chain;
  amountAtoms: bigint;
  mintRecipientAddress: Hex;
  /** F085 — deterministic idempotency key (e.g. `${transfer.id}:burn`). */
  idempotencyKey?: string;
  /**
   * Optional NEO bridge skim — atomically transfers `feeAtoms` USDC from the
   * user's wallet to `treasury` BEFORE the CCTP burn, in the same EIP-7702
   * batched user-op. The CCTP burn still uses `amountAtoms` (the post-fee
   * net amount, as the caller already trimmed). Skipped when feeAtoms === 0n.
   */
  feeSkim?: { treasury: Hex; feeAtoms: bigint };
}): Promise<CctpExecResult | null> {
  const tokenMessenger = CCTP_TOKEN_MESSENGER[input.srcChain];
  const usdcAddress = USDC_BY_CHAIN[input.srcChain];
  const destDomain = CCTP_DOMAIN[input.dstChain];
  if (!tokenMessenger || !usdcAddress || destDomain === undefined) {
    log.warn(
      { srcChain: input.srcChain, dstChain: input.dstChain },
      'cctp: route not supported by V1 registry',
    );
    return null;
  }
  const approveCalldata = buildErc20ApproveCalldata(tokenMessenger, input.amountAtoms);
  const burnCalldata = buildDepositForBurnCalldata({
    amount: input.amountAtoms,
    destDomain,
    mintRecipient: addressToBytes32(input.mintRecipientAddress),
    burnToken: usdcAddress,
  });
  const calls: Array<{ to: Hex; data: Hex }> = [];
  if (input.feeSkim && input.feeSkim.feeAtoms > 0n) {
    calls.push({
      to: usdcAddress,
      data: buildErc20TransferCalldata(input.feeSkim.treasury, input.feeSkim.feeAtoms),
    });
  }
  calls.push({ to: usdcAddress, data: approveCalldata });
  calls.push({ to: tokenMessenger, data: burnCalldata });
  const chainId = CHAIN_IDS[input.srcChain];
  const result = await executor.sendCalls(
    input.userId,
    calls,
    { chainId, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
  );
  return { callId: result.txHash, demo: result.demo, submittedUnknown: result.submittedUnknown, ...(result.failed ? { failed: true, failureCode: result.failureCode } : {}) };
}

/**
 * Submit the CCTP mint leg: MessageTransmitter.receiveMessage(message, attestation)
 * on the destination chain. The (message, attestation) pair comes from the
 * Circle Iris poll completed by the bridge worker.
 */
export async function executeCctpMint(input: {
  userId: string;
  dstChain: Chain;
  message: Hex;
  attestation: Hex;
  /** F085 — deterministic idempotency key (e.g. `${transfer.id}:mint`). */
  idempotencyKey?: string;
  /**
   * Which protocol version's transmitter to call (ADR-0005). receiveMessage
   * keeps the same (bytes,bytes) selector across versions — only the
   * contract address differs. Defaults to 1; the worker passes the version
   * persisted on the transfer row at burn time.
   */
  version?: 1 | 2;
}): Promise<CctpExecResult | null> {
  const messageTransmitter =
    input.version === 2
      ? (CCTP_DOMAIN[input.dstChain] !== undefined ? CCTP_V2_MESSAGE_TRANSMITTER : undefined)
      : CCTP_MESSAGE_TRANSMITTER[input.dstChain];
  if (!messageTransmitter) {
    log.warn({ dstChain: input.dstChain }, 'cctp: destination chain not in MessageTransmitter registry');
    return null;
  }
  const calldata = buildReceiveMessageCalldata({
    message: input.message,
    attestation: input.attestation,
  });
  const chainId = CHAIN_IDS[input.dstChain];
  const result = await executor.sendCalls(
    input.userId,
    [{ to: messageTransmitter, data: calldata }],
    { chainId, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
  );
  return { callId: result.txHash, demo: result.demo, submittedUnknown: result.submittedUnknown, ...(result.failed ? { failed: true, failureCode: result.failureCode } : {}) };
}

/**
 * Parse the MessageSent(bytes) event from a burn-tx receipt. CCTP V1's
 * MessageTransmitter emits exactly one MessageSent log per depositForBurn;
 * the log's data is the ABI-encoded `bytes message`, which we need verbatim
 * (and whose keccak256 is the Iris attestation key).
 *
 * `receipt` is the shape returned by `eth_getTransactionReceipt`: an object
 * with `.logs: Array<{ address, topics, data }>`. We pick the log whose
 * address matches the source chain's MessageTransmitter AND whose first
 * topic is MESSAGE_SENT_TOPIC0.
 */
export interface BurnExtraction {
  messageBody: Hex;
  messageHash: Hex;
}

export function extractMessageFromBurnReceipt(
  srcChain: Chain,
  receipt: { logs: Array<{ address: string; topics: string[]; data: string }> } | null,
): BurnExtraction | null {
  if (!receipt) return null;
  const messageTransmitter = CCTP_MESSAGE_TRANSMITTER[srcChain]?.toLowerCase();
  if (!messageTransmitter) return null;
  const matches = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === messageTransmitter &&
      l.topics[0]?.toLowerCase() === MESSAGE_SENT_TOPIC0,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // depositForBurn emits exactly one MessageSent; our calldata builder only
    // batches one burn per userop. >1 means something unexpected happened —
    // could be a contract upgrade or a different burn riding in the same tx.
    // Use the first match and warn loudly so we notice in incident response.
    log.warn(
      { srcChain, count: matches.length },
      'cctp: multiple MessageSent logs in burn receipt — using first',
    );
  }
  const messageLog = matches[0]!;
  // The log.data is an ABI-encoded `bytes message`: 32B offset + 32B length +
  // padded data. Extract the inner message verbatim — Iris signs over EXACTLY
  // these bytes, so any padding/truncation breaks the attestation match.
  const dataHex = messageLog.data.startsWith('0x')
    ? messageLog.data.slice(2)
    : messageLog.data;
  // Sanity: bytes-encoded payload is always ≥ 64 hex chars (offset + length).
  // Bail out gracefully on truncated data rather than throw and kill the worker.
  if (dataHex.length < 128) {
    log.warn({ srcChain, dataLen: dataHex.length }, 'cctp: MessageSent log too short');
    return null;
  }
  // offset is always 0x20 for a single bytes arg; length comes next.
  const lengthHex = dataHex.slice(64, 128);
  const length = parseInt(lengthHex, 16);
  if (!Number.isFinite(length) || length <= 0 || length * 2 > dataHex.length - 128) {
    log.warn({ srcChain, length }, 'cctp: MessageSent log length field invalid');
    return null;
  }
  const message = ('0x' + dataHex.slice(128, 128 + length * 2)) as Hex;
  const messageHash = keccak256(message);
  return { messageBody: message, messageHash };
}

/**
 * Flip CctpAdapter live when both chains in the route are in our V1 contract
 * registry. The scaffolded adapter at the top of this file is kept for the
 * bridge-router single-shot path; the load-bearing call site for CCTP today
 * is the bridge worker via executeCctpBurn / executeCctpMint, which doesn't
 * go through bridge-router.
 */
export function isCctpExecutable(srcChain: Chain, dstChain: Chain, token: string): boolean {
  if (token !== 'USDC') return false;
  return (
    CCTP_TOKEN_MESSENGER[srcChain] !== undefined &&
    CCTP_MESSAGE_TRANSMITTER[dstChain] !== undefined &&
    CCTP_DOMAIN[srcChain] !== undefined &&
    CCTP_DOMAIN[dstChain] !== undefined
  );
}

/* ── 2026-07-08 — CCTP V2 (ADR-0005) ──────────────────────────────────────
 *
 * V1 begins manual phase-out 2026-07-31 (Circle announcement 2025-11-14).
 * V2 is the same burn/attest/mint shape with three differences:
 *   1. New contracts, SAME address on every EVM chain (CREATE2 deploy):
 *      TokenMessengerV2 / MessageTransmitterV2 below. Verified against
 *      circlefin/evm-cctp-contracts source + per-chain explorer labels.
 *   2. depositForBurn gains destinationCaller / maxFee / minFinalityThreshold.
 *      Threshold 2000 = Standard (waits hard finality, fee 0 today);
 *      1000 = Fast (attested at soft finality, fee 0–14bps by source chain,
 *      quoted via GET /v2/burn/USDC/fees). Values ≤1000 are treated as 1000,
 *      >1000 as 2000.
 *   3. Attestation is keyed by BURN TX HASH via
 *      GET /v2/messages/{srcDomain}?transactionHash=… (no MessageSent log
 *      extraction needed — the endpoint echoes message + attestation).
 *
 * receiveMessage(bytes,bytes) keeps the V1 selector/encoding — the existing
 * buildReceiveMessageCalldata is reused; only the transmitter address
 * changes. Domain ids are unchanged from V1.
 *
 * Fee semantics (from TokenMessengerV2.sol): maxFee is an ABSOLUTE amount in
 * USDC atoms; burn requires maxFee < amount; the destination mint REVERTS if
 * Circle's executed fee exceeds maxFee (never clipped). Standard transfers
 * carry fee 0 today, so maxFee 0 + threshold 2000 is the conservative
 * default; Fast quotes get a 20% buffer like Circle's own sample app.
 */

export const CCTP_V2_TOKEN_MESSENGER: Hex = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const CCTP_V2_MESSAGE_TRANSMITTER: Hex = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
export const CCTP_V2_FINALITY_STANDARD = 2000;
export const CCTP_V2_FINALITY_FAST = 1000;
/** bytes32(0) — any address may broadcast receiveMessage on destination. */
const ANY_DESTINATION_CALLER = ('0x' + '00'.repeat(32)) as Hex;

const depositForBurnV2Abi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);

export function buildDepositForBurnV2Calldata(args: {
  amount: bigint;
  destDomain: number;
  mintRecipient: Hex;
  burnToken: Hex;
  destinationCaller?: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
}): Hex {
  return encodeFunctionData({
    abi: depositForBurnV2Abi,
    functionName: 'depositForBurn',
    args: [
      args.amount,
      args.destDomain,
      args.mintRecipient,
      args.burnToken,
      args.destinationCaller ?? ANY_DESTINATION_CALLER,
      args.maxFee,
      args.minFinalityThreshold,
    ],
  });
}

/**
 * Quote the V2 Fast Transfer fee rate for a route. Returns the minimum fee in
 * HUNDREDTHS of a bp (Circle quotes fractional bps), or null when the quote
 * is unavailable — callers must fall back to Standard (threshold 2000,
 * maxFee 0) rather than guess a fee for a money path.
 */
export async function fetchCctpV2FastFeeBpsHundredths(
  srcDomain: number,
  dstDomain: number,
  opts: { fetchImpl?: typeof fetch; apiBase?: string } = {},
): Promise<number | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? IRIS_API_BASE;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IRIS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${apiBase}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ finalityThreshold?: number; minimumFee?: number }>;
    if (!Array.isArray(body)) return null;
    const fast = body.find((e) => e.finalityThreshold === CCTP_V2_FINALITY_FAST);
    if (!fast || typeof fast.minimumFee !== 'number' || !Number.isFinite(fast.minimumFee)) return null;
    // minimumFee is a rate in bps (possibly fractional). Convert to integer
    // hundredths-of-a-bp so downstream math stays in integers.
    return Math.ceil(fast.minimumFee * 100);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e), srcDomain, dstDomain }, 'cctp-v2: fee quote failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** maxFee for a Fast burn: rate applied to amount, +20% buffer (Circle's own sample), min 1 atom. */
export function cctpV2MaxFeeAtoms(amountAtoms: bigint, feeBpsHundredths: number): bigint {
  const raw = (amountAtoms * BigInt(feeBpsHundredths)) / 1_000_000n;
  const buffered = (raw * 120n) / 100n;
  return buffered > 0n ? buffered : 1n;
}

/**
 * Submit the CCTP V2 burn: approve + TokenMessengerV2.depositForBurn batched
 * in one user-op. Attempts a Fast Transfer when a fee quote succeeds and the
 * buffered fee stays under the amount; otherwise Standard (free, hard
 * finality). Returns the mode used so the worker can log/event it.
 */
export async function executeCctpV2Burn(input: {
  userId: string;
  srcChain: Chain;
  dstChain: Chain;
  amountAtoms: bigint;
  mintRecipientAddress: Hex;
  idempotencyKey?: string;
  feeSkim?: { treasury: Hex; feeAtoms: bigint };
  /** Test seam for the fee quote. */
  fetchImpl?: typeof fetch;
}): Promise<(CctpExecResult & { mode: 'fast' | 'standard'; maxFeeAtoms: bigint }) | null> {
  const usdcAddress = USDC_BY_CHAIN[input.srcChain];
  const srcDomain = CCTP_DOMAIN[input.srcChain];
  const destDomain = CCTP_DOMAIN[input.dstChain];
  if (!usdcAddress || srcDomain === undefined || destDomain === undefined) {
    log.warn({ srcChain: input.srcChain, dstChain: input.dstChain }, 'cctp-v2: route not supported');
    return null;
  }
  const feeBpsHundredths = await fetchCctpV2FastFeeBpsHundredths(srcDomain, destDomain, {
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  let mode: 'fast' | 'standard' = 'standard';
  let maxFee = 0n;
  let minFinalityThreshold = CCTP_V2_FINALITY_STANDARD;
  if (feeBpsHundredths !== null) {
    const candidate = cctpV2MaxFeeAtoms(input.amountAtoms, feeBpsHundredths);
    // Contract requires maxFee < amount; a fee that large means the route
    // quote is nonsense for this size — take the free Standard path.
    if (candidate < input.amountAtoms) {
      mode = 'fast';
      maxFee = candidate;
      minFinalityThreshold = CCTP_V2_FINALITY_FAST;
    }
  }
  const burnCalldata = buildDepositForBurnV2Calldata({
    amount: input.amountAtoms,
    destDomain,
    mintRecipient: addressToBytes32(input.mintRecipientAddress),
    burnToken: usdcAddress,
    maxFee,
    minFinalityThreshold,
  });
  const calls: Array<{ to: Hex; data: Hex }> = [];
  if (input.feeSkim && input.feeSkim.feeAtoms > 0n) {
    calls.push({
      to: usdcAddress,
      data: buildErc20TransferCalldata(input.feeSkim.treasury, input.feeSkim.feeAtoms),
    });
  }
  calls.push({ to: usdcAddress, data: buildErc20ApproveCalldata(CCTP_V2_TOKEN_MESSENGER, input.amountAtoms) });
  calls.push({ to: CCTP_V2_TOKEN_MESSENGER, data: burnCalldata });
  const chainId = CHAIN_IDS[input.srcChain];
  const result = await executor.sendCalls(
    input.userId,
    calls,
    { chainId, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
  );
  return {
    callId: result.txHash,
    demo: result.demo,
    submittedUnknown: result.submittedUnknown,
    ...(result.failed ? { failed: true, failureCode: result.failureCode } : {}),
    mode,
    maxFeeAtoms: maxFee,
  };
}

/**
 * Fetch the V2 message + attestation for a burn tx. Keyed by tx hash, not
 * message hash — no receipt log extraction needed. 404 means "not yet
 * indexed" and classifies as pending (per Circle's own sample app), as do
 * 5xx/429/network errors; only an explicit failure or another 4xx is
 * terminal.
 */
export async function fetchCctpV2Message(
  sourceDomain: number,
  burnTxHash: string,
  opts: { fetchImpl?: typeof fetch; apiBase?: string } = {},
): Promise<CctpAttestation> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? IRIS_API_BASE;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IRIS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${apiBase}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(burnTxHash)}`,
      { signal: ctrl.signal },
    );
    if (res.status === 404) return { status: 'pending', attestation: null, message: null, polls: 0 };
    if (res.status >= 500 || res.status === 429) {
      return { status: 'pending', attestation: null, message: null, polls: 0 };
    }
    if (!res.ok) {
      return { status: 'failed', attestation: null, message: null, polls: 0 };
    }
    const body = (await res.json()) as {
      messages?: Array<{ status?: string; message?: string; attestation?: string }>;
    };
    const msg = body.messages?.[0];
    if (!msg) return { status: 'pending', attestation: null, message: null, polls: 0 };
    const rawStatus = String(msg.status ?? '').toLowerCase();
    // 'complete' → done; explicit failure → failed; everything else
    // (pending_confirmations et al) keeps polling — same taxonomy as V1.
    const status: CctpAttestationStatus =
      rawStatus === 'complete'
        ? 'complete'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'failed'
          : 'pending';
    return {
      status,
      attestation: (msg.attestation ?? null) as `0x${string}` | null,
      message: (msg.message ?? null) as `0x${string}` | null,
      polls: 0,
    };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), sourceDomain, burnTxHash },
      'cctp-v2: message fetch failed',
    );
    return { status: 'pending', attestation: null, message: null, polls: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * EIP-7702 batch executor — the write-path keystone.
 *
 * Every on-chain mutation in MAZE (Aave supply/withdraw, yoUSD deposit/redeem,
 * future LIFI swaps) funnels through `executor.sendCalls(userId, calls)`. The
 * executor batches the calls into a single gas-sponsored user operation via
 * Alchemy's Wallet API (Gas Manager paymaster + EIP-7702 default mode), so the
 * user never holds ETH and never signs more than one prompt.
 *
 * ── Gating ──
 * Live only when `features.alchemy` (ALCHEMY_API_KEY set) AND `features.chain`
 * (BASE_RPC_URL set) AND Privy is wired (server wallet can sign). Anything
 * missing → the demo path returns a synthetic `0xdemo…` hash and the route
 * layer mirrors the move into the in-memory ledger (same contract as the
 * Aave/x402/LIFI demo fallbacks).
 *
 * ── Live JSON-RPC flow (Alchemy Wallet API, verified against docs) ──
 * Endpoint: POST https://api.g.alchemy.com/v2/${ALCHEMY_API_KEY}
 *
 *   1. wallet_prepareCalls — batch + request a paymaster-sponsored userop:
 *      params: [{
 *        from:    "0x<signerAddress>",
 *        chainId: "0x2105",                       // Base mainnet, hex
 *        calls:   [{ to, data, value? }, …],      // our SponsoredCall[]
 *        capabilities: { paymasterService: { policyId: ALCHEMY_GAS_POLICY_ID } }
 *      }]
 *      → result is one of two shapes:
 *        • already-delegated account: a single
 *          { type:"user-operation-v070", data, chainId,
 *            signatureRequest:{ type:"personal_sign", data:{raw}, rawPayload } }
 *        • first-time (EOA has no code): { type:"array", data:[ …items ] } where
 *          item[0] is an `eip7702Auth` authorization (delegate the EOA to
 *          Modular Account v2 0x69007702764179f14F51cdce752f4f775d74E139) and
 *          item[1] is the userop — each with its own signatureRequest.
 *
 *   2. Sign each item's signatureRequest.rawPayload with a RAW secp256k1
 *      signature (Privy `secp256k1Sign`), NOT personal_sign. rawPayload is the
 *      final digest; personal_sign would (a) break the 7702 authorization
 *      (recovered authority ≠ sender) and (b) mis-encode the userop digest as a
 *      UTF-8 string ("Invalid account signature"). Verified live 2026-07-04.
 *
 *   3. wallet_sendPreparedCalls — submit the signed userop:
 *      • single: [{ type, data, chainId, signature:{type:"secp256k1", data} }]
 *      • array:  [{ type:"array", data:[ …items each with .signature ] }]
 *      → result: { preparedCallIds: ["0x<callId>"] }  (track via wallet_getCallsStatus)
 *
 * Docs: https://www.alchemy.com/docs/wallets/transactions/sponsor-gas
 *       https://www.alchemy.com/docs/wallets/transactions/using-eip-7702
 *
 * The whole live block is best-effort: any throw (missing key, RPC error,
 * signer null) DEGRADES to the demo result. sendCalls never throws.
 */

import { randomBytes } from 'node:crypto';
import { base } from 'viem/chains';
import { env, features } from '../env.js';
import { log } from '../log.js';
import { walletService } from './wallet.js';
import { signHashWithPrivy } from '../privy.js';

export interface SponsoredCall {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
}

export interface ExecResult {
  txHash: string;
  /** true when no real userop was submitted (no keys) — ledger mirrors the move. */
  demo: boolean;
  submittedUnknown?: boolean;
  /** true when gas was paid by the Alchemy Gas Manager paymaster. */
  sponsored: boolean;
  /** Live signing was configured and ATTEMPTED but failed — a real error, not
      demo. Callers must surface this, never mirror it to the ledger as done. */
  failed?: boolean;
  /** Actionable failure code when `failed` — e.g. 'server_signing_unavailable'. */
  failureCode?: string;
}

export interface SendCallsOptions {
  chainId?: number;
  /**
   * F085 Sprint 18 — Idempotency hint for retry safety. When set, the same key
   * across retries guarantees deterministic dedup at the API edge:
   *
   *   1. Sent as the `Idempotency-Key` HTTP header on both `wallet_prepareCalls`
   *      and `wallet_sendPreparedCalls` requests (RFC 9110 convention; honored
   *      by Alchemy-side request dedup where supported).
   *   2. Used as the JSON-RPC envelope `id` field so the response is correlated
   *      to the request even under retry-storm conditions.
   *
   * Callers (bridge-worker.ts) should thread `${transfer.id}:${stage}` where
   * `stage` is one of 'burn' / 'mint' / 'hl-deposit' — each FSM step gets its
   * own deterministic key. Without this, a BullMQ retry could resubmit the
   * same prepared userop twice and charge the paymaster twice.
   */
  idempotencyKey?: string;
}

const ALCHEMY_RPC = 'https://api.g.alchemy.com/v2';

/** `0xdemo` + 28 hex chars — matches the x402 / defi demo-ref convention. */
function demoTxHash(): string {
  return '0xdemo' + randomBytes(14).toString('hex');
}

function demoResult(): ExecResult {
  return { txHash: demoTxHash(), demo: true, sponsored: false };
}

/** Live signing was configured but failed — surface a real error rather than
    masquerading as a demo success (which silently loses the user's deposit). */
function signFailure(code: string): ExecResult {
  return { txHash: '', demo: false, sponsored: false, failed: true, failureCode: code };
}

interface SignatureRequest {
  type: string;
  data?: { raw?: string };
  rawPayload?: string;
}

/**
 * `wallet_prepareCalls` returns one of two shapes:
 *  - a single `user-operation-v070` object with a top-level `signatureRequest`
 *    (the account is already 7702-delegated), or
 *  - a `type: 'array'` envelope whose `data` is a list of items — the first an
 *    `eip7702Auth` authorization (delegating the EOA to Modular Account v2), the
 *    second the userop — each with its own `signatureRequest`. This is what a
 *    never-delegated EOA gets on its first call.
 * Every `signatureRequest.rawPayload` is the final digest to raw-sign.
 */
interface PrepareCallsItem {
  type: string;
  data?: unknown;
  chainId?: string;
  signatureRequest?: SignatureRequest;
  /** Attached by the executor after signing, before `wallet_sendPreparedCalls`. */
  signature?: { type: string; data: string };
}
interface PrepareCallsResult {
  type: string;
  data: unknown;
  chainId?: string;
  signatureRequest?: SignatureRequest;
}

// F029 — class is module-private; the singleton `executor` is the public surface.
class BatchExecutor {
  /**
   * Live requires the sponsor (Alchemy), a chain RPC, and a signer (Privy).
   * All three gate together — a half-configured stack stays on demo.
   */
  get isLive(): boolean {
    return features.alchemy && features.chain && features.privy;
  }

  /**
   * Batch `calls` into one EIP-7702 gas-sponsored user operation submitted from
   * the user's wallet. Returns the userop/tx hash. Demo mode (or any live
   * failure) returns a `0xdemo…` hash with `demo:true` — never throws.
   */
  async sendCalls(
    userId: string,
    calls: SponsoredCall[],
    opts: SendCallsOptions = {},
  ): Promise<ExecResult> {
    if (!this.isLive) return demoResult();

    try {
      // Resolve the user's signing wallet. privyDid threading from the session
      // is a follow-up (the route layer still uses placeholders for address);
      // without a live handle we degrade to demo rather than guess an address.
      const wallet = await walletService.getOrCreateUserWallet(userId, null);
      if (!wallet.live) return demoResult();

      const apiKey = env.ALCHEMY_API_KEY;
      const policyId = env.ALCHEMY_GAS_POLICY_ID;
      if (!apiKey) return demoResult();

      const rpcUrl = `${ALCHEMY_RPC}/${apiKey}`;
      const chainIdHex = `0x${(opts.chainId ?? base.id).toString(16)}`;
      // F085 — idempotency-key surface; threaded into both rpc() calls below.
      const idemKey = opts.idempotencyKey;

      // ── 1. wallet_prepareCalls ──
      const capabilities = policyId
        ? { paymasterService: { policyId } }
        : undefined;
      const prepared = await this.rpc<PrepareCallsResult>(
        rpcUrl,
        'wallet_prepareCalls',
        [
          {
            from: wallet.address,
            chainId: chainIdHex,
            calls: calls.map((c) => ({
              to: c.to,
              data: c.data,
              ...(c.value !== undefined ? { value: `0x${c.value.toString(16)}` } : {}),
            })),
            ...(capabilities ? { capabilities } : {}),
          },
        ],
        idemKey ? `${idemKey}:prepare` : undefined,
      );

      // ── 2. Sign every signatureRequest with a RAW secp256k1 signature over
      // its `rawPayload` (the final digest). Handles both response shapes:
      //   • single userop  → one signatureRequest
      //   • `type:'array'` → an eip7702Auth authorization + the userop, each
      //                      signed independently and sent back as an array.
      // `rawPayload` (not `data.raw`) is signed raw via Privy secp256k1Sign —
      // personal_sign would break the 7702 authorization and mis-encode the
      // userop digest as a string. See signHashWithPrivy. ──
      const isArray = prepared.type === 'array' && Array.isArray(prepared.data);
      const items: PrepareCallsItem[] = isArray
        ? (prepared.data as PrepareCallsItem[])
        : [prepared as PrepareCallsItem];

      const digests = items.map((it) => it.signatureRequest?.rawPayload ?? it.signatureRequest?.data?.raw);
      if (digests.some((d) => !d)) {
        log.warn('alchemy: prepareCalls returned an item without a signature digest — degrading to demo');
        return demoResult();
      }

      const signedItems: Array<Record<string, unknown>> = [];
      for (let i = 0; i < items.length; i++) {
        const signature = await signHashWithPrivy(wallet.walletId, digests[i] as string);
        if (!signature) {
          // When server signing is CONFIGURED, a null signature is a real
          // failure (e.g. the wallet has no authorized signer) — surface it
          // instead of faking a 0xdemo success that silently swallows the
          // user's deposit.
          if (features.privyServerSigning) {
            log.error({ userId }, 'alchemy: live sign failed with server signing configured');
            return signFailure('server_signing_unavailable');
          }
          log.warn('alchemy: Privy secp256k1Sign returned null — degrading to demo');
          return demoResult();
        }
        signedItems.push({ ...items[i], signature: { type: 'secp256k1', data: signature } });
      }

      // ── 3. wallet_sendPreparedCalls ── array shape passes the signed items
      // back under a `type:'array'` envelope; single shape passes one object.
      const sendParams = isArray
        ? [{ type: 'array', data: signedItems }]
        : [
            {
              type: prepared.type,
              data: prepared.data,
              chainId: prepared.chainId,
              signature: signedItems[0]?.signature,
            },
          ];
      let sent: { preparedCallIds?: string[]; callIds?: string[] };
      try {
        sent = await this.rpc<{ preparedCallIds?: string[]; callIds?: string[] }>(
          rpcUrl,
          'wallet_sendPreparedCalls',
          sendParams,
          idemKey ? `${idemKey}:send` : undefined,
        );
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), userId },
          'alchemy: sendPreparedCalls result unknown',
        );
        return { ...demoResult(), submittedUnknown: true };
      }

      const callId = sent.preparedCallIds?.[0] ?? sent.callIds?.[0];
      if (!callId) {
        log.warn('alchemy: sendPreparedCalls returned no callId — degrading to demo');
        return { ...demoResult(), submittedUnknown: true };
      }

      const sponsored = Boolean(policyId);
      log.info({ userId, callId, chainId: chainIdHex, sponsored }, 'alchemy: 7702 batch submitted');
      return { txHash: callId, demo: false, sponsored };
    } catch (e) {
      // Any failure (RPC down, sign error, malformed response) degrades to demo
      // so the deposit/withdraw flow still completes against the ledger.
      log.warn(
        { err: e instanceof Error ? e.message : String(e), userId },
        'alchemy: sendCalls failed — degrading to demo',
      );
      return demoResult();
    }
  }

  /**
   * Minimal JSON-RPC POST helper. Throws on transport or RPC-level error.
   *
   * F085 — when `idempotencyKey` is provided, it's sent as both:
   *   - HTTP `Idempotency-Key` header (RFC 9110; Alchemy edge dedup where
   *     supported, harmless no-op otherwise)
   *   - JSON-RPC envelope `id` (response correlation under retry-storm)
   */
  private async rpc<T>(
    url: string,
    method: string,
    params: unknown[],
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: idempotencyKey ?? 1, jsonrpc: '2.0', method, params }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} → ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(`${method} rpc error: ${json.error.message ?? 'unknown'}`);
    if (json.result === undefined) throw new Error(`${method} returned no result`);
    return json.result;
  }

  /**
   * Snapshot the status of a previously-submitted preparedCalls batch.
   * Wraps Alchemy's `wallet_getCallsStatus`.
   *
   * Returns:
   *   - { status: "PENDING" }            → keep polling
   *   - { status: "CONFIRMED", txHash, receipt? } → mined; receipt has logs
   *   - { status: "FAILED", error? }     → terminal failure
   *
   * Demo callIds (those returned when `isLive` is false) short-circuit to
   * CONFIRMED with a synthetic receipt so the worker state machine can
   * advance in tests without a real Alchemy round-trip.
   */
  async getCallStatus(callId: string, chainId?: number): Promise<CallStatusSnapshot> {
    if (callId.startsWith('0xdemo')) {
      return {
        status: 'CONFIRMED',
        txHash: callId,
        receipt: { logs: [], status: '0x1' },
        demo: true,
      };
    }
    if (!this.isLive) {
      // We can't ask Alchemy without a key; treat as pending so callers don't
      // mark the transfer terminal on a config gap.
      return { status: 'PENDING' };
    }
    try {
      const apiKey = env.ALCHEMY_API_KEY;
      if (!apiKey) return { status: 'PENDING' };
      const rpcUrl = `${ALCHEMY_RPC}/${apiKey}`;
      const raw = await this.rpc<RawCallStatus>(rpcUrl, 'wallet_getCallsStatus', [callId]);
      // Alchemy `wallet_getCallsStatus` reports a NUMERIC status code
      // (100 = pending, 200 = confirmed/mined, 400/500 = failed off/on-chain);
      // some SDK versions return the string state instead. Normalize both — the
      // pre-live code only handled the string form, so real 7702 burns (which
      // return 200) were mis-read as "unexpected status" and failed the transfer.
      const code = Number(raw.status);
      const s = String(raw.status ?? '').toUpperCase();
      const isPending = code === 100 || s === 'PENDING' || s === 'SUBMITTED';
      const isConfirmed = code === 200 || s === 'CONFIRMED';
      const isFailed = (Number.isFinite(code) && code >= 400) || s === 'FAILED';
      const r0 = raw.receipts?.[0];
      if (isFailed) {
        return { status: 'FAILED', error: raw.atomic === false ? 'reverted' : `status_${s || code}` };
      }
      if (isConfirmed) {
        // Mined but the receipt hasn't propagated yet → poll once more rather
        // than declaring terminal state on a race.
        if (!r0) return { status: 'PENDING' };
        if (String(r0.status ?? '0x1').toLowerCase() === '0x0') {
          return { status: 'FAILED', error: 'receipt_status_0x0' };
        }
        return {
          status: 'CONFIRMED',
          txHash: r0.transactionHash,
          receipt: { logs: r0.logs ?? [], status: r0.status ?? '0x1' },
          chainId,
        };
      }
      if (isPending) return { status: 'PENDING' };
      // Unknown/absent status — keep polling instead of failing the transfer.
      return { status: 'PENDING' };
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), callId },
        'alchemy: getCallsStatus failed — treating as pending',
      );
      return { status: 'PENDING' };
    }
  }
}

export interface CallReceipt {
  logs: Array<{ address: string; topics: string[]; data: string }>;
  status: string;
}

export type CallStatusSnapshot =
  | { status: 'PENDING' }
  | { status: 'CONFIRMED'; txHash: string; receipt: CallReceipt; chainId?: number; demo?: boolean }
  | { status: 'FAILED'; error: string };

interface RawCallStatus {
  status?: string | number;
  atomic?: boolean;
  receipts?: Array<{
    transactionHash: string;
    status?: string;
    logs?: Array<{ address: string; topics: string[]; data: string }>;
  }>;
}

export const executor = new BatchExecutor();

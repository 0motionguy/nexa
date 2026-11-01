/**
 * F060 — minimal shared fetch wrapper for outbound vendor calls. Each chain/
 * markets adapter (Bridge, Sumsub, Gnosis Pay, LIFI, Socket, x402,
 * Hyperliquid, Polymarket, Resend) currently rolls its own `fetch()` with
 * its own retry/error/header idioms. This wrapper unifies the contract so
 * adapter authors don't have to redo timeout + retry + structured error.
 *
 * Migration is incremental: adapters can adopt at their own pace. Until
 * then, this module is opt-in and doesn't affect existing call sites.
 *
 * Scope (kept small on purpose — bigger versions go vendor-specific):
 *   - timeout via AbortSignal
 *   - exponential backoff retry for GET/HEAD (idempotent verbs) on 5xx + network errors
 *   - structured HttpError (status + url + vendor + body excerpt) for consumers to wrap
 *   - log hook on retry + final failure
 *
 * NOT scoped here:
 *   - request signing (vendor-specific; signers stay in their adapter)
 *   - body schema validation (use Zod at the call site)
 *   - rate limiting (use lib/rate-limit.ts at the route layer)
 */

import { log } from './log.js';

export interface HttpRequestOptions extends Omit<RequestInit, 'signal'> {
  /** Logical vendor name surfaced in errors + logs. */
  vendor: string;
  /** Timeout per attempt, ms. Default 10_000. */
  timeoutMs?: number;
  /** Max attempts including the first; default 3 for GET/HEAD, 1 for everything else. */
  maxAttempts?: number;
  /** Override the default backoff (linear 200/400/800 ms). Receives 1-based attempt number. */
  backoffMs?: (attempt: number) => number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly vendor: string;
  readonly bodyExcerpt: string;
  constructor(status: number, url: string, vendor: string, bodyExcerpt: string) {
    super(`${vendor}: ${status} on ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.vendor = vendor;
    this.bodyExcerpt = bodyExcerpt;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF = (attempt: number): number => 200 * 2 ** (attempt - 1);

function isIdempotent(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

function isRetryable(status: number): boolean {
  return status === 408 || (status >= 500 && status < 600);
}

/**
 * Fetch with timeout + retry + structured error. On failure, throws
 * `HttpError`; on success, returns the raw Response (caller decodes).
 *
 * Usage:
 *   const res = await httpRequest('https://api.bridge.xyz/v0/customers', {
 *     vendor: 'bridge',
 *     method: 'POST',
 *     headers: { ...auth, 'content-type': 'application/json' },
 *     body: JSON.stringify(payload),
 *     timeoutMs: 15_000,
 *   });
 *   if (!res.ok) throw new BridgeProvisioningError('customer_failed', res.status);
 *   return await res.json();
 */
export async function httpRequest(url: string, opts: HttpRequestOptions): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? (isIdempotent(opts.method) ? 3 : 1);
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(t);
      if (res.ok || !isRetryable(res.status) || attempt === maxAttempts) {
        return res;
      }
      log.warn(
        { vendor: opts.vendor, url, status: res.status, attempt, maxAttempts },
        'http: retryable status, retrying',
      );
    } catch (e) {
      clearTimeout(t);
      lastError = e;
      if (attempt === maxAttempts) break;
      log.warn(
        { vendor: opts.vendor, url, attempt, maxAttempts, err: e instanceof Error ? e.message : String(e) },
        'http: network error, retrying',
      );
    }
    await new Promise((r) => setTimeout(r, backoff(attempt)));
  }
  // We exhausted attempts. Build a structured error.
  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');
  throw new HttpError(0, url, opts.vendor, msg.slice(0, 200));
}

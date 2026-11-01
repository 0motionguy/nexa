/**
 * lib/writes.mjs — write-cohort safety gate + sandbox order construction
 * (spec point 2: "write-cohort 5% — DISABLED unless --enable-writes AND
 * the base URL host is in an explicit --write-allowlist; ... Hard-refuse
 * writes when the base host matches any production domain — exit 2").
 *
 * assertWriteSafety() is a pure function (no I/O) specifically so it can
 * be unit-tested directly against fabricated inputs without needing a
 * live server or the --self-test stub to cooperate — this is
 * money-adjacent-adjacent logic and deserves a direct test, not just
 * indirect subprocess coverage.
 */

import { randomUUID } from 'node:crypto';
import { FALLBACK_HL_COINS } from './cohorts.mjs';

/** Known production hosts. Hard-refused unconditionally — even if a
 * caller mistakenly adds one of these to --write-allowlist, the
 * production check runs first and wins. */
export const PRODUCTION_HOSTS = Object.freeze(['nexa.aiso.tools']);

/** $1-$10 notional cap (spec point 2). HL enforces a live $10 minimum
 * (apps/api/src/routes/markets.ts HL_MIN_ORDER_USD) only when
 * hyperliquid.isLiveTrading is true; below-minimum rejections against a
 * live-trading target are an expected, non-fatal outcome the caller
 * should count, not crash on. */
export const WRITE_QTY_USD_MIN = 1;
export const WRITE_QTY_USD_MAX = 10;

export class WriteSafetyError extends Error {}

/**
 * Throws WriteSafetyError when the write-cohort must not run:
 *   - writes not explicitly enabled (--enable-writes)
 *   - target host is a known production domain (unconditional refusal)
 *   - target host is not in the explicit --write-allowlist
 * Returns normally (void) when writes are safe to run.
 */
export function assertWriteSafety({ baseUrl, enableWrites, writeAllowlist }) {
  if (!enableWrites) {
    throw new WriteSafetyError('write-cohort disabled: pass --enable-writes to run money-adjacent sandbox writes.');
  }
  let host;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new WriteSafetyError(`write-cohort refused: --base "${baseUrl}" is not a valid URL.`);
  }
  if (PRODUCTION_HOSTS.includes(host)) {
    throw new WriteSafetyError(
      `write-cohort refused: "${host}" is a production domain (${PRODUCTION_HOSTS.join(', ')}). ` +
      `Never run 1,000 money-writing users against production. This check is unconditional and ` +
      `ignores --write-allowlist.`
    );
  }
  if (!writeAllowlist.includes(host)) {
    throw new WriteSafetyError(
      `write-cohort refused: "${host}" is not in --write-allowlist (${writeAllowlist.join(', ') || '<empty>'}). ` +
      `Pass --write-allowlist ${host} to explicitly opt this host into money-adjacent writes.`
    );
  }
}

/** Build a small, capped sandbox HL order body. Field names match the
 * real handler's body shape (routes/markets.ts POST /hyperliquid/order):
 * coin, sideLong, qtyUsd, orderType, tif, reduceOnly. */
export function buildSandboxOrderBody(rng, catalog) {
  const coins = catalog?.hlCoins?.length ? catalog.hlCoins : FALLBACK_HL_COINS;
  const coin = coins[Math.floor(rng() * coins.length)];
  const qtyUsd = +(WRITE_QTY_USD_MIN + rng() * (WRITE_QTY_USD_MAX - WRITE_QTY_USD_MIN)).toFixed(2);
  return {
    coin,
    sideLong: rng() < 0.5,
    qtyUsd,
    orderType: 'market',
    tif: 'Ioc',
    reduceOnly: false,
  };
}

/** Per-user-unique idempotency key (spec point 2: "per-user unique
 * idempotency keys"). Always sent — cheap, and required server-side
 * whenever the target venue is live. */
export function buildIdempotencyKey(userId) {
  return `load-harness:${userId}:${randomUUID()}`;
}

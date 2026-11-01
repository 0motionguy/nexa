/**
 * Hyperliquid canonical number formatting for L1 `order` actions.
 *
 * WHY THIS EXISTS — the money-path bug of 2026-07-04: order prices/sizes were
 * serialized with `.toFixed(n)`, which emits TRAILING ZEROS (e.g. "28.198400",
 * "28.20"). Hyperliquid normalizes numbers before it re-hashes the action to
 * verify the signature, so a non-canonical price makes HL hash a DIFFERENT
 * action than the one we signed. `ecrecover` then lands on a phantom address
 * and HL rejects with "User or API Wallet 0x… does not exist" — proven live:
 * `p:"28.198400"` → phantom reject, `p:"28.198"` → order rests. The phantom
 * address even changes per malformed input, confirming it is never a wallet
 * problem.
 *
 * HL wire rules (https://hyperliquid.gitbook.io/hyperliquid-docs):
 *  - prices: at most 5 significant figures, and at most (MAX_DECIMALS -
 *    szDecimals) decimal places, where MAX_DECIMALS is 6 for perps and 8 for
 *    spot; integer prices are always allowed. No trailing zeros.
 *  - sizes: rounded to szDecimals decimals. No trailing zeros.
 *
 * hyperliquid-hip3.ts shipped the working version of this first; this module
 * is the shared, spot-aware extraction so perps + spot + HIP-3 all agree.
 */

/** Strip trailing zeros (and a dangling dot) from a decimal string. */
export function trimDecimalString(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** Canonical decimal string: no trailing zeros, never exponential. */
function normalizeHlNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error('invalid_number');
  let s = String(n);
  if (s.includes('e') || s.includes('E')) s = n.toFixed(12);
  return trimDecimalString(s);
}

/** Format an order size to `szDecimals` (defaults to 6). Throws if it rounds to 0. */
export function formatHlSize(sizeNative: number, szDecimals: number | null | undefined): string {
  const decimals = Math.max(0, Math.min(8, Math.floor(szDecimals ?? 6)));
  const out = trimDecimalString(sizeNative.toFixed(decimals));
  if (!(Number(out) > 0)) throw new Error('size_below_lot');
  return out;
}

/**
 * Format an order price: 5 significant figures, then clamp to the venue's
 * decimal ceiling when szDecimals is known. `maxDecimalsBase` is 6 for perps,
 * 8 for spot. When szDecimals is unknown we still apply the 5-sig-fig rule
 * (which kills the phantom) and skip the decimal clamp.
 */
function formatHlPrice(price: number, szDecimals: number | null | undefined, maxDecimalsBase: number): string {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('invalid_price');
  const sig = Number(price.toPrecision(5));
  let out: string;
  if (szDecimals == null) {
    out = normalizeHlNumber(sig);
  } else {
    const cap = Math.max(0, maxDecimalsBase - Math.max(0, Math.min(8, Math.floor(szDecimals))));
    out = trimDecimalString(sig.toFixed(cap));
  }
  if (!(Number(out) > 0)) throw new Error('invalid_price');
  return out;
}

/** Perp / HIP-3 price (MAX_DECIMALS = 6). */
export function formatHlPerpPx(price: number, szDecimals: number | null | undefined): string {
  return formatHlPrice(price, szDecimals, 6);
}

/** Spot price (MAX_DECIMALS = 8). */
export function formatHlSpotPx(price: number, szDecimals: number | null | undefined): string {
  return formatHlPrice(price, szDecimals, 8);
}

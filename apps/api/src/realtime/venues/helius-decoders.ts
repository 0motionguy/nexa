/**
 * On-chain account decoders for the Helius Solana realtime adapter.
 *
 * Scope of this module: PURE byte-layout parsers. No network, no WS, no
 * adapter wiring. The sibling `helius-sol.ts` adapter is the only consumer.
 *
 * Architectural note — Raydium AMM v4 requires THREE subscriptions per mint:
 *   1. The pool state account → exposes the two vault pubkeys + decimals
 *      (parsed by `decodeRaydiumV4PoolMeta` here).
 *   2. The base-coin SPL token vault → balance updates on every swap
 *      (parsed by `decodeSplTokenAmount`).
 *   3. The pc/quote SPL token vault → balance updates on every swap
 *      (parsed by `decodeSplTokenAmount`).
 *
 * The pool state account itself does NOT carry live reserves — it stores
 * monotonic running counters (`swap_base_in_amount`, etc.) that are useless
 * for instantaneous mid. The reserves live in the two SPL token accounts
 * whose pubkeys are embedded in the pool state. Once the adapter has both
 * vault balances, mid = (pcAmount / 10^pcDecimals) / (coinAmount / 10^coinDecimals).
 *
 * Wiring this multi-subscribe shape into the adapter is OUT OF SCOPE here;
 * the adapter currently subscribes to ONE pool account per mint. This
 * module ships the byte-level primitives the architectural refactor will use.
 */

/** Result of parsing a Raydium AMM v4 pool state account. */
export interface RaydiumV4PoolMeta {
  /** Base (coin) SPL token vault pubkey, base58. */
  coinVault: string;
  /** Quote (pc) SPL token vault pubkey, base58. */
  pcVault: string;
  /** Decimals for the base token. */
  coinDecimals: number;
  /** Decimals for the quote token. */
  pcDecimals: number;
}

/**
 * SPL token account layout — well-known and stable across all SPL Token v1
 * accounts. Total size is 165 bytes; we only read the `amount` field at
 * offset 64. Length isn't gated against the full 165 — see decodeSplTokenAmount.
 */
const SPL_TOKEN_AMOUNT_OFFSET = 64;

/** Raydium AMM v4 pool state account total size. */
const RAYDIUM_V4_POOL_STATE_SIZE = 752;

/**
 * Parse the `amount` field (u64 little-endian) from an SPL Token v1 account.
 * Layout (165 bytes total):
 *   mint:          Pubkey (32B) @ 0
 *   owner:         Pubkey (32B) @ 32
 *   amount:        u64 LE  (8B) @ 64   ← this is what we read
 *   delegate:      COption<Pubkey> (36B) @ 72
 *   state:         u8     (1B) @ 108
 *   isNative:      COption<u64> (12B) @ 109
 *   delegatedAmount: u64 LE (8B) @ 121
 *   closeAuthority: COption<Pubkey> (36B) @ 129
 *
 * Returns null when the buffer is too short to safely read 8 bytes at offset 64.
 * Reads as bigint to preserve precision past Number.MAX_SAFE_INTEGER (≈ 9e15) —
 * meme token supplies routinely exceed that when expressed in raw lamports.
 */
export function decodeSplTokenAmount(data: Uint8Array): bigint | null {
  if (!(data instanceof Uint8Array)) return null;
  if (data.length < SPL_TOKEN_AMOUNT_OFFSET + 8) return null;
  // Hand-roll LE u64 read — DataView.getBigUint64 also works, but constructing
  // a DataView over an arbitrary Uint8Array slice gets fiddly with byteOffset.
  // Direct byte access is unambiguous and 8 iterations is free.
  let amount = 0n;
  for (let i = 7; i >= 0; i--) {
    amount = (amount << 8n) | BigInt(data[SPL_TOKEN_AMOUNT_OFFSET + i]!);
  }
  return amount;
}

/**
 * Pure math: given current vault balances + decimals, return the mid price
 * in pc-per-coin units (e.g. USDC-per-SOL when coin=SOL, pc=USDC).
 *
 * mid = (pcAmount / 10^pcDecimals) / (coinAmount / 10^coinDecimals)
 *
 * Returns NaN if `coinAmount` is zero (degenerate pool). Returns Infinity if
 * the division overflows Number range (shouldn't happen for real pools).
 *
 * The division is done in floating point AFTER converting to scaled Number,
 * not in BigInt, because we want a finite-precision mid suitable for the
 * `TickEvent.px` field which is `number`. Caller is responsible for clamping
 * extreme values if they propagate to the UI.
 */
export function deriveRaydiumMid(args: {
  coinAmount: bigint;
  pcAmount: bigint;
  coinDecimals: number;
  pcDecimals: number;
}): number {
  const { coinAmount, pcAmount, coinDecimals, pcDecimals } = args;
  if (coinAmount === 0n) return Number.NaN;
  // Convert each leg through Number AFTER applying decimals. For meme tokens
  // with raw u64 supplies near 2^60 the Number cast loses ~14 trailing bits
  // of precision; that's fine for a UI mid price (we only need ~6-8 sig figs).
  const coin = Number(coinAmount) / Math.pow(10, coinDecimals);
  const pc = Number(pcAmount) / Math.pow(10, pcDecimals);
  return pc / coin;
}

/**
 * Decode a Raydium AMM v4 pool state account into the metadata the adapter
 * needs to wire up the 3-account-subscribe flow (pool meta + base vault +
 * quote vault).
 *
 * Offsets verified against the authoritative source — `liquidityStateV4Layout`
 * in https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/liquidity/layout.ts.
 * The relevant tuples (field : offset : type) inside the 752-byte struct:
 *
 *   baseDecimal  :  32 : u64
 *   quoteDecimal :  40 : u64
 *   baseVault    : 336 : publicKey (32 bytes)
 *   quoteVault   : 368 : publicKey (32 bytes)
 *
 * Naming: this module exposes `coinVault`/`pcVault`/`coinDecimals`/`pcDecimals`
 * (Serum/legacy Raydium nomenclature, which the helius-sol adapter already
 * uses internally). The mapping is one-to-one with the SDK's `baseVault`/
 * `quoteVault`/`baseDecimal`/`quoteDecimal`.
 *
 * Returns null if:
 *   - input is not a Uint8Array
 *   - buffer is not exactly 752 bytes (wrong account type — Orca, Meteora, SPL
 *     token account, etc.)
 *   - decimals are outside the plausible 0..18 range (defensive: a real
 *     Raydium pool always has decimals that fit in a u8 even though the
 *     field width is u64; values outside this range indicate the buffer is
 *     not actually a Raydium pool state)
 */
export function decodeRaydiumV4PoolMeta(data: Uint8Array): RaydiumV4PoolMeta | null {
  if (!(data instanceof Uint8Array) || data.length !== RAYDIUM_V4_POOL_STATE_SIZE) {
    return null;
  }
  const coinDecimals = readU64LeAsNumber(data, RAYDIUM_BASE_DECIMAL_OFFSET);
  const pcDecimals = readU64LeAsNumber(data, RAYDIUM_QUOTE_DECIMAL_OFFSET);
  if (coinDecimals === null || pcDecimals === null) return null;
  // Real mints have decimals 0..18; defensive bound rejects garbage buffers
  // whose 752-byte length matched by coincidence.
  if (coinDecimals < 0 || coinDecimals > 18) return null;
  if (pcDecimals < 0 || pcDecimals > 18) return null;
  const coinVault = bs58Encode(data.slice(RAYDIUM_BASE_VAULT_OFFSET, RAYDIUM_BASE_VAULT_OFFSET + 32));
  const pcVault = bs58Encode(data.slice(RAYDIUM_QUOTE_VAULT_OFFSET, RAYDIUM_QUOTE_VAULT_OFFSET + 32));
  if (!coinVault || !pcVault) return null;
  return { coinVault, pcVault, coinDecimals, pcDecimals };
}

const RAYDIUM_BASE_DECIMAL_OFFSET = 32;
const RAYDIUM_QUOTE_DECIMAL_OFFSET = 40;
const RAYDIUM_BASE_VAULT_OFFSET = 336;
const RAYDIUM_QUOTE_VAULT_OFFSET = 368;

/**
 * Read 8 bytes LE at `offset` as a Number. Returns null if the buffer is too
 * short. Saturates beyond Number.MAX_SAFE_INTEGER (≈ 9e15) — fine for decimals
 * (real values fit in a byte) but caller must use BigInt for vault balances.
 */
function readU64LeAsNumber(data: Uint8Array, offset: number): number | null {
  if (data.length < offset + 8) return null;
  let v = 0;
  // Iterate from high byte down — accumulate in Number. Will saturate but
  // remains accurate for any value ≤ 2^53; decimals are always single-digit.
  for (let i = 7; i >= 0; i--) {
    v = v * 256 + data[offset + i]!;
  }
  return v;
}

/**
 * Base58 encode a byte array using the Bitcoin / Solana alphabet.
 *
 * Algorithm: arbitrary-precision base-256 → base-58 conversion via long
 * division on a Number array. Preserves a leading-zero "1" character for
 * every leading zero byte (Solana pubkeys never have leading zeros in
 * practice, but the property is part of the base58 contract).
 *
 * This is the standard alphabet — `0`, `O`, `I`, `l` are intentionally
 * excluded for visual-ambiguity reasons.
 *
 * Pure function, no dependencies. Hand-rolled because the project doesn't
 * carry the `bs58` package and pulling a new dep for one 30-line function
 * would be wasteful.
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58Encode(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) return '';
  if (bytes.length === 0) return '';

  // Count leading zero bytes — each becomes a leading '1' in the output.
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  // Allocate the output digits buffer. ⌈N · log(256) / log(58)⌉ ≈ N · 1.366.
  // For a 32-byte Solana pubkey that's 44 base58 chars — well within bounds.
  const digits: number[] = [];
  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Compose the output: leading '1' per leading-zero byte, then digits MSB→LSB.
  let out = '';
  for (let i = 0; i < leadingZeros; i++) out += BASE58_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

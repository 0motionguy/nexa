/**
 * Collector Crypt adapter — Solana NFT marketplace for tokenized trading cards
 * (Sprint 20).
 *
 * Two surfaces:
 *   1. Read  — public REST at `${env.CC_API_BASE}/marketplace`. Listings + per-
 *              card detail + sale history. No auth; CDN-cached upstream.
 *   2. Write — buy (and later list/offer) goes through the standard pattern:
 *              build unsigned tx → sign with Privy server wallet → broadcast
 *              via Solana RPC. Same code path as Jupiter swaps; only the
 *              upstream URL differs.
 *
 * Live trading requires features.markets + features.privy + features.solanaRpc
 * + a user with a Privy Solana wallet (auto-provisioned via walletService).
 *
 * Docs: https://docs.collectorcrypt.com/
 *       https://docs.collectorcrypt.com/marketplace/api
 *       https://docs.collectorcrypt.com/marketplace/program
 *
 * Program: CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr (mainnet)
 */

import { env, features } from '../env.js';
import { log } from '../log.js';
import { httpRequest } from '../http.js';
import { resolveSolanaRpcUrl } from '../chain/solana-tx.js';
import { signSolanaTxWithPrivy } from '../privy.js';

const FETCH_TIMEOUT_MS = 8_000;
const BROADCAST_TIMEOUT_MS = 20_000;
const SUPPORTED_COLLECTIONS = [
  'Pokemon',
  'Pokemon JP',
  'NBA',
  'NFL',
  'Soccer',
  'MTG',
  'F1',
  'UFC',
] as const;
export type CcCollection = (typeof SUPPORTED_COLLECTIONS)[number] | 'All';
export type CcTokenStandard = 'Pnft' | 'Cnft' | 'Nft' | 'Core';
export type CcSort = 'trending' | 'floor' | 'recent' | 'movers';

export interface CcListing {
  /** CC card db id — canonical key throughout the system. */
  id: string;
  /** Solana SPL mint address. */
  nftAddress: string;
  name: string;
  imageUrl: string | null;
  priceUsdc: number;
  collection: string;
  /** Grading service + numeric grade, e.g. "PSA 10", "BGS 9.5". Null when un-graded. */
  gradeLabel: string | null;
  tokenStandard: CcTokenStandard;
  ownerWallet: string;
  listedAt: string;
}

export interface CcCardDetail extends CcListing {
  /** Raw HTTP for collection floor / 24h volume — best-effort, null when CC omits. */
  collectionFloorUsdc: number | null;
  collectionVolume24hUsdc: number | null;
  /** Recent sales (most-recent first). CC returns up to 50 by default. */
  saleHistory: Array<{
    at: string;
    priceUsdc: number;
    buyer: string;
    seller: string;
    signature: string | null;
  }>;
}

export interface CcListingsPage {
  items: CcListing[];
  total: number | null;
  cursor: string | null;
  totalPages: number | null;
}

export function ccListingToDetail(base: CcListing): CcCardDetail {
  return {
    ...base,
    collectionFloorUsdc: null,
    collectionVolume24hUsdc: null,
    saleHistory: [],
  };
}

/* ── Read surface ─────────────────────────────────────────────────────────── */

/**
 * Real CC API response row shape — probed against
 * `GET https://api.collectorcrypt.com/marketplace?page=1` on 2026-06-21.
 *
 * Notable differences from the docs:
 *   - Image lives at `frontImage` (Arweave URL), not `imageUrl`
 *   - Collection is `category` (top-level string), not `collection.name`
 *   - Grade is split: `grade` + `gradeNum` + `gradingCompany`
 *   - Price lives under `listing.price`, not at the row root
 *   - `nftStandard` is often null — default to 'Pnft'
 *   - Default `/marketplace` ONLY returns rows with active listings
 *     (all 100 rows on page 1 had `listing != null` when probed)
 */
interface RawListingRow {
  id?: string;
  itemName?: string;
  nftAddress?: string;
  frontImage?: string;
  backImage?: string;
  category?: string;
  grade?: string;
  gradeNum?: number;
  gradingCompany?: string;
  nftStandard?: string | null;
  language?: string;
  year?: string;
  listing?: {
    createdAt?: string;
    currency?: string;
    price?: number;
    sellerId?: string;
    receiptId?: string;
  } | null;
  owner?: {
    id?: string;
    wallet?: string;
  } | null;
}

function normaliseTokenStandard(input?: string | null): CcTokenStandard {
  switch ((input ?? '').toLowerCase()) {
    case 'pnft':
    case 'programmable':
      return 'Pnft';
    case 'cnft':
    case 'compressed':
      return 'Cnft';
    case 'core':
    case 'mpl-core':
      return 'Core';
    default:
      return 'Nft';
  }
}

function rowToListing(row: RawListingRow): CcListing | null {
  const id = row.id;
  const nftAddress = row.nftAddress;
  if (!id || !nftAddress) return null;
  // Skip un-listed inventory rows (no active sale price).
  if (!row.listing || typeof row.listing.price !== 'number') return null;
  const gradeLabel =
    row.gradingCompany && row.grade
      ? `${row.gradingCompany} ${row.grade}`
      : row.gradingCompany && typeof row.gradeNum === 'number'
        ? `${row.gradingCompany} ${row.gradeNum}`
        : row.grade ?? null;
  return {
    id,
    nftAddress,
    name: row.itemName ?? 'Untitled card',
    imageUrl: row.frontImage ?? null,
    priceUsdc: row.listing.price,
    collection: row.category ?? 'Other',
    gradeLabel,
    tokenStandard: normaliseTokenStandard(row.nftStandard ?? null),
    ownerWallet: row.owner?.wallet ?? '',
    listedAt: row.listing.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Probed CC accepted query params (2026-06-21): `page`, `search`, `language`,
 * `gradingCompany`, `blockchain`, `categories`. The `sort` param the docs
 * mention is rejected; CC returns rows in their internal order. Category
 * filtering at the API level didn't actually narrow results, so we filter
 * client-side by `row.category` on the response when `collection` is set.
 *
 * Pagination is page-based, 100 rows per page server-side. We surface
 * `page` as the "cursor" so the route can keep the same external contract.
 */
export async function fetchCcListings(opts: {
  collection?: CcCollection;
  sort?: CcSort;
  cursor?: string;
  limit?: number;
}): Promise<CcListingsPage> {
  if (!features.ccEnabled) {
    return { items: [], total: 0, cursor: null, totalPages: 0 };
  }
  const params = new URLSearchParams();
  const page = opts.cursor ? Math.max(1, Number(opts.cursor) || 1) : 1;
  params.set('page', String(page));

  const url = `${env.CC_API_BASE}/marketplace?${params.toString()}`;
  const res = await httpRequest(url, {
    vendor: 'collector-crypt',
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxAttempts: 2,
  });
  if (!res.ok) {
    log.warn({ status: res.status, url }, 'cc: listings fetch rejected');
    return { items: [], total: 0, cursor: null, totalPages: 0 };
  }
  const body = (await res.json().catch(() => null)) as
    | { filterNFtCard?: RawListingRow[]; findTotal?: number; totalPages?: number }
    | null;
  const rows = body?.filterNFtCard ?? [];
  let items = rows.map(rowToListing).filter((x): x is CcListing => x !== null);

  // Client-side filters (CC's category param is broken at write time).
  if (opts.collection && opts.collection !== 'All') {
    items = items.filter((x) => x.collection === opts.collection);
  }

  // Client-side sort — CC ignores `sort`. Defaults to listed-most-recent.
  switch (opts.sort) {
    case 'floor':
      items.sort((a, b) => a.priceUsdc - b.priceUsdc);
      break;
    case 'movers':
    case 'trending':
      items.sort((a, b) => b.priceUsdc - a.priceUsdc); // proxy until CC ships real volume sort
      break;
    case 'recent':
    default:
      items.sort((a, b) => (a.listedAt < b.listedAt ? 1 : -1));
      break;
  }

  // Soft client-side limit (CC's server-side page size is fixed at 100).
  if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);

  const totalPages = typeof body?.totalPages === 'number' ? body.totalPages : null;
  const nextPage = totalPages && page < totalPages ? String(page + 1) : null;

  return {
    items,
    total: typeof body?.findTotal === 'number' ? body.findTotal : null,
    cursor: nextPage,
    totalPages,
  };
}

export async function fetchCcCard(id: string): Promise<CcCardDetail | null> {
  if (!features.ccEnabled) return null;
  const url = `${env.CC_API_BASE}/marketplace/${encodeURIComponent(id)}`;
  const res = await httpRequest(url, {
    vendor: 'collector-crypt',
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxAttempts: 2,
  });
  if (!res.ok) {
    log.warn({ status: res.status, id }, 'cc: card detail fetch rejected');
    return null;
  }
  const body = (await res.json().catch(() => null)) as
    | (RawListingRow & {
        collectionFloor?: number;
        collectionVolume24h?: number;
        saleHistory?: Array<{
          at?: string;
          createdAt?: string;
          priceUsdc?: number;
          buyer?: { wallet?: string } | string;
          seller?: { wallet?: string } | string;
          signature?: string;
        }>;
      })
    | null;
  if (!body) return null;
  const base = rowToListing(body);
  if (!base) return null;
  const sales = (body.saleHistory ?? []).map((s) => ({
    at: s.at ?? s.createdAt ?? new Date().toISOString(),
    priceUsdc: typeof s.priceUsdc === 'number' ? s.priceUsdc : 0,
    buyer: typeof s.buyer === 'string' ? s.buyer : (s.buyer?.wallet ?? ''),
    seller: typeof s.seller === 'string' ? s.seller : (s.seller?.wallet ?? ''),
    signature: s.signature ?? null,
  }));
  return {
    ...base,
    collectionFloorUsdc: typeof body.collectionFloor === 'number' ? body.collectionFloor : null,
    collectionVolume24hUsdc:
      typeof body.collectionVolume24h === 'number' ? body.collectionVolume24h : null,
    saleHistory: sales,
  };
}

export async function fetchCcCardFromListings(
  id: string,
  opts: { maxPages?: number } = {},
): Promise<CcCardDetail | null> {
  const maxPages = Math.max(1, opts.maxPages ?? 3);
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await fetchCcListings({ cursor, limit: 100 });
    const found = page.items.find((item) => item.id === id || item.nftAddress === id);
    if (found) return ccListingToDetail(found);
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return null;
}

export async function fetchCcPositionsByOwner(ownerWallet: string): Promise<CcListing[]> {
  if (!features.ccEnabled) return [];
  const params = new URLSearchParams({ owner: ownerWallet, limit: '50' });
  const url = `${env.CC_API_BASE}/marketplace?${params.toString()}`;
  const res = await httpRequest(url, {
    vendor: 'collector-crypt',
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxAttempts: 2,
  });
  if (!res.ok) {
    log.warn({ status: res.status, ownerWallet }, 'cc: positions fetch rejected');
    return [];
  }
  const body = (await res.json().catch(() => null)) as
    | { filterNFtCard?: RawListingRow[] }
    | null;
  return (body?.filterNFtCard ?? []).map(rowToListing).filter((x): x is CcListing => x !== null);
}

/* ── Write surface ────────────────────────────────────────────────────────── */

export interface CcBuyInput {
  privyWalletId: string | null;
  buyerSolanaAddress: string | null;
  nftAddress: string;
  expectedPriceUsdc: number;
  tokenStandard: CcTokenStandard;
  /** CC card db id — for the audit row. Optional but recommended. */
  cardId?: string;
  /** Display name + image — for the audit row. Optional. */
  name?: string;
  imageUrl?: string | null;
}

export type CcBuyResult =
  | {
      ok: true;
      demo: boolean;
      signature: string;
      confirmed: boolean;
      nftAddress: string;
      pricePaidUsdc: number;
    }
  | { ok: false; reason: string; demo?: false };

/**
 * `false` when CC is disabled OR we can't actually sign on chain (no Privy,
 * no Solana RPC). Routes can short-circuit with a 503 instead of pretending.
 */
export function isCcLiveTrading(): boolean {
  return features.ccEnabled && features.privy && features.solanaRpc;
}

/**
 * Execute a buy end-to-end: CC `/marketplace/buy` → Privy server-wallet sign →
 * broadcast. Returns a Solana signature on success, structured error on
 * failure. Never throws on transport errors — callers can persist an audit
 * row in either branch.
 */
export async function executeCcBuy(input: CcBuyInput): Promise<CcBuyResult> {
  if (env.DEMO_MODE && (!isCcLiveTrading() || !input.privyWalletId || !input.buyerSolanaAddress)) {
    return {
      ok: true,
      demo: true,
      signature: `cc_demo_${Buffer.from(`${input.cardId ?? ''}:${input.nftAddress}`).toString('base64url').slice(0, 32)}`,
      confirmed: true,
      nftAddress: input.nftAddress,
      pricePaidUsdc: input.expectedPriceUsdc,
    };
  }
  if (!isCcLiveTrading() || !input.privyWalletId || !input.buyerSolanaAddress) {
    return { ok: false, reason: 'cc_not_live' };
  }
  const url = `${env.CC_API_BASE}/marketplace/buy`;
  const reqBody = {
    wallet: input.buyerSolanaAddress,
    nftAddress: input.nftAddress,
    currency: 'USDC',
    expectedPrice: input.expectedPriceUsdc,
    tokenStandard: input.tokenStandard,
    // CC uses this hint to decide whether to prepay rent for the buyer.
    userHasSol: true,
  };
  let unsignedTxBase64: string | null;
  try {
    const res = await httpRequest(url, {
      vendor: 'collector-crypt',
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(reqBody),
      timeoutMs: FETCH_TIMEOUT_MS,
      maxAttempts: 2,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn(
        { status: res.status, snippet: text.slice(0, 200) },
        'cc: buy build rejected',
      );
      return { ok: false, reason: `cc_build_${res.status}` };
    }
    // CC may return either a raw base64 string or `{ tx: <base64> }`. Handle both.
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('application/json')) {
      const data = (await res.json().catch(() => null)) as
        | { tx?: string; transaction?: string; unsignedTransaction?: string }
        | null;
      unsignedTxBase64 = data?.tx ?? data?.transaction ?? data?.unsignedTransaction ?? null;
    } else {
      unsignedTxBase64 = (await res.text().catch(() => '')).trim();
    }
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'cc: buy build failed (network)',
    );
    return { ok: false, reason: 'cc_build_network' };
  }
  if (!unsignedTxBase64) return { ok: false, reason: 'cc_build_empty' };

  const rpcUrl = resolveSolanaRpcUrl();
  if (!rpcUrl) return { ok: false, reason: 'rpc_unavailable' };

  try {
    const web3 = await import('@solana/web3.js');
    const txBytes = Buffer.from(unsignedTxBase64, 'base64');
    // CC may return either VersionedTransaction or legacy Transaction.
    // Try VersionedTransaction first; fall back to legacy Transaction on parse error.
    let signature: string | null = null;
    let confirmed = false;
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    try {
      const versionedTx = web3.VersionedTransaction.deserialize(txBytes);
      const messageBytes = Buffer.from(versionedTx.message.serialize()).toString('base64');
      const sigBase64 = await signSolanaTxWithPrivy(input.privyWalletId, messageBytes);
      if (!sigBase64) return { ok: false, reason: 'privy_signature_unavailable' };
      const buyerPubkey = new web3.PublicKey(input.buyerSolanaAddress);
      versionedTx.addSignature(buyerPubkey, Buffer.from(sigBase64, 'base64'));
      signature = await connection.sendRawTransaction(versionedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
    } catch (_versionedErr) {
      // Fall back to legacy Transaction.
      const legacyTx = web3.Transaction.from(txBytes);
      if (!legacyTx.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        legacyTx.recentBlockhash = blockhash;
      }
      legacyTx.feePayer = new web3.PublicKey(input.buyerSolanaAddress);
      const messageBytes = Buffer.from(legacyTx.serializeMessage()).toString('base64');
      const sigBase64 = await signSolanaTxWithPrivy(input.privyWalletId, messageBytes);
      if (!sigBase64) return { ok: false, reason: 'privy_signature_unavailable' };
      legacyTx.addSignature(
        new web3.PublicKey(input.buyerSolanaAddress),
        Buffer.from(sigBase64, 'base64'),
      );
      signature = await connection.sendRawTransaction(legacyTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
    }

    // Best-effort 30s confirm — signature is the authoritative receipt.
    try {
      const result = await Promise.race([
        connection.confirmTransaction(signature, 'confirmed').then(() => 'confirmed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), BROADCAST_TIMEOUT_MS)),
      ]);
      confirmed = result === 'confirmed';
    } catch {
      // ignore — tx may still land; signature is the receipt.
    }
    return {
      ok: true,
      demo: false,
      signature,
      confirmed,
      nftAddress: input.nftAddress,
      pricePaidUsdc: input.expectedPriceUsdc,
    };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'cc: buy sign+send failed',
    );
    return { ok: false, reason: 'sign_or_broadcast_failed' };
  }
}

/** Static list — UI chips. CC's actual collection set is dynamic but these are
 *  the load-bearing ones that always show up. Falls back gracefully if upstream
 *  adds new collections (the "All" chip still works regardless). */
export function listSupportedCollections(): readonly CcCollection[] {
  return ['All', ...SUPPORTED_COLLECTIONS];
}

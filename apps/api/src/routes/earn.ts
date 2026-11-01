/**
 * Earn (deposit/withdraw) + swap. DEMO_MODE settles instantly against the
 * ledger; production routes through the EarnRouter, which picks between the
 * Morpho-curated Standard tier and the highest-APY Higher Yield tier per the
 * user's preference (BUILD-PLAN §DeFi + Stack upgrades Phase 1). LIFI handles
 * USDC⇄EURC swap.
 */

import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { EarnTierInput } from '@nexa/shared-zod';
import { requireSession } from '../lib/auth.js';
import { store } from '../store/index.js';
import { PolicyError } from '../store/types.js';
import {
  transferStore,
  type Transfer,
  type TransferBucket,
  type TransferChain,
  type TransferRail,
} from '../store/transfers.js';
import { ApiError } from '../lib/errors.js';
import { getChainStack } from '../lib/chain/index.js';
import { log } from '../lib/log.js';
import { earnDeposit, earnWithdraw } from '../lib/metrics.js';
import { env } from '../lib/env.js';
import { fetchMorphoVaultsList } from '../lib/chain/morpho.js';
import { liveMeta, providerDemoMeta, sourced, unavailableMeta } from '../lib/sourced.js';
import { mayanAdapter, type MayanQuoteInput } from '../lib/chain/mayan.js';
import * as marinade from '../lib/chain/marinade.js';
import type { SolanaWalletHandle } from '../lib/chain/wallet.js';
import { ethenaAdapter } from '../lib/chain/ethena.js';
import { jupiterLendAdapter } from '../lib/chain/jupiter-lend.js';
import { fetchMarinadeApyBps } from '../lib/chain/marinade.js';
import {
  buildLandingFromSources,
  fetchLlamaPools,
  type AssetLanding,
  type FirstPartyApy,
} from '../lib/chain/yields-landscape.js';
import { aaveAdapter } from '../lib/chain/defi.js';
import { compoundAdapter } from '../lib/chain/compound.js';
import { morphoAdapter } from '../lib/chain/morpho.js';
import { yoUsdAdapter } from '../lib/chain/yousd.js';

export const earnRoutes = new Hono();

/**
 * Ethena sUSDe headline yield tile. Read-only — returns live sUSDe APY plus
 * the deposit URL the UI deep-links to (ethena.fi). NEXA never custodies
 * sUSDe in this phase; the user mints/stakes directly with Ethena. UI must
 * render the risk copy verbatim. Registered BEFORE the session gate on
 * purpose: it is a public tile (rate-limited at index.ts).
 */
earnRoutes.get('/ethena', async (c) => {
  try {
    const summary = await ethenaAdapter.getTileSummary();
    return c.json({ ok: true, ...summary });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'earn: ethena tile read failed',
    );
    return c.json(
      { ok: false, error: { code: 'ethena_unavailable', message: 'Ethena APY is currently unavailable.' } },
      503,
    );
  }
});

/**
 * Jupiter Lend headline yield tile. Read-only — returns live USDC supply APY
 * + deposit URL. Symmetric to /earn/ethena. Public (no session required) so
 * the Earn landing card can render before sign-in.
 */
earnRoutes.get('/jupiter-lend', async (c) => {
  const asset = (c.req.query('asset') ?? 'USDC').toUpperCase() === 'USDT' ? 'USDT' : 'USDC';
  try {
    const summary = await jupiterLendAdapter.getTileSummary(asset);
    return c.json({ ok: true, ...summary });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), asset },
      'earn: jupiter-lend tile read failed',
    );
    return c.json(
      { ok: false, error: { code: 'jupiter_lend_unavailable', message: 'Jupiter Lend APY is currently unavailable.' } },
      503,
    );
  }
});

/**
 * Best-yield landscape — public read. Returns per-asset (USDC, USDT, SOL,
 * BTC, ETH, sUSDe) the top three venues by live APY, drawing from:
 *   - First-party adapters we already custody: Morpho / Aave v3 / Compound III
 *     / yoUSD on Base, Marinade on Solana, Jupiter Lend on Solana, Ethena
 *     sUSDe (informational tile)
 *   - DefiLlama Yields API for assets/venues we don't have native adapters
 *     for (Fluid Ethereum, Kamino Solana, Aave Ethereum/Arbitrum/Polygon, etc.)
 *
 * The route absorbs per-source read failures internally and surfaces whatever
 * data IS available — better to show 2/6 assets ranked than to 503 the whole
 * landing because one upstream is slow.
 *
 * Each row carries `mode`: `native` (NEXA can deposit on-platform), `deeplink`
 * (user opens the venue's site), or `informational`. UI renders the CTA based
 * on this field.
 *
 * Cached 60s in the route — DefiLlama refreshes ~hourly and the on-chain
 * adapters are cheap-but-not-free.
 */
let landingCache: { snapshot: AssetLanding[]; expiresAt: number } | null = null;
const LANDING_TTL_MS = 60_000;

earnRoutes.get('/landing', async (c) => {
  const now = Date.now();
  if (landingCache && landingCache.expiresAt > now) {
    return c.json({ ok: true, landscape: landingCache.snapshot, cached: true });
  }

  // First-party reads in parallel. Each catches its own failure so one slow
  // upstream doesn't drag the entire response.
  const safe = async <T>(label: string, p: Promise<T>): Promise<T | null> => {
    try { return await p; }
    catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), label }, 'landing: first-party read failed');
      return null;
    }
  };

  const [
    morphoBps,
    aaveBps,
    compoundBps,
    yoUsdBps,
    marinade,
    jupiterLendUsdc,
    jupiterLendUsdt,
    ethena,
    llamaPools,
  ] = await Promise.all([
    safe('morpho', morphoAdapter.getApyBps()),
    safe('aave', aaveAdapter.getApy('USDC')),
    safe('compound', compoundAdapter.getApyBps()),
    safe('yousd', yoUsdAdapter.getApyBps()),
    safe('marinade', fetchMarinadeApyBps()),
    safe('jup-lend-usdc', jupiterLendAdapter.getTileSummary('USDC')),
    safe('jup-lend-usdt', jupiterLendAdapter.getTileSummary('USDT')),
    safe('ethena', ethenaAdapter.getTileSummary()),
    fetchLlamaPools(),
  ]);

  const firstParty: FirstPartyApy[] = [];
  if (morphoBps != null) firstParty.push({
    asset: 'USDC', venue: 'Morpho (Steakhouse)', chain: 'base',
    apyBps: morphoBps, tvlUsd: null, hasNativeDeposit: true, riskBand: 'B',
  });
  if (aaveBps != null) firstParty.push({
    asset: 'USDC', venue: 'Aave v3', chain: 'base',
    apyBps: aaveBps, tvlUsd: null, hasNativeDeposit: true, riskBand: 'A',
  });
  if (compoundBps != null) firstParty.push({
    asset: 'USDC', venue: 'Compound III', chain: 'base',
    apyBps: compoundBps, tvlUsd: null, hasNativeDeposit: true, riskBand: 'A',
  });
  if (yoUsdBps != null) firstParty.push({
    asset: 'USDC', venue: 'yoUSD', chain: 'base',
    apyBps: yoUsdBps, tvlUsd: null, hasNativeDeposit: true, riskBand: 'B',
  });
  if (marinade != null) firstParty.push({
    asset: 'SOL', venue: 'Marinade', chain: 'solana',
    apyBps: marinade.apyBps, tvlUsd: null, hasNativeDeposit: true, riskBand: 'A',
  });
  if (jupiterLendUsdc != null && jupiterLendUsdc.apyBps > 0) firstParty.push({
    asset: 'USDC', venue: 'Jupiter Lend', chain: 'solana',
    apyBps: jupiterLendUsdc.apyBps,
    tvlUsd: jupiterLendUsdc.tvlUsd,
    hasNativeDeposit: false,
    url: jupiterLendUsdc.depositUrl,
    riskBand: 'B',
  });
  if (jupiterLendUsdt != null && jupiterLendUsdt.apyBps > 0) firstParty.push({
    asset: 'USDT', venue: 'Jupiter Lend', chain: 'solana',
    apyBps: jupiterLendUsdt.apyBps,
    tvlUsd: jupiterLendUsdt.tvlUsd,
    hasNativeDeposit: false,
    url: jupiterLendUsdt.depositUrl,
    riskBand: 'B',
  });
  if (ethena != null && ethena.apyBps > 0) firstParty.push({
    asset: 'sUSDe', venue: 'Ethena', chain: 'ethereum',
    apyBps: ethena.apyBps, tvlUsd: null,
    hasNativeDeposit: false, url: ethena.depositUrl, riskBand: 'B',
  });

  const landscape = buildLandingFromSources(firstParty, llamaPools ?? []);
  landingCache = { snapshot: landscape, expiresAt: now + LANDING_TTL_MS };
  return c.json({ ok: true, landscape, cached: false });
});

earnRoutes.use('*', requireSession);

earnRoutes.get('/apy', async (c) => {
  const u = c.get('user');
  const stack = getChainStack();
  const protocols = await stack.earnRouter.getProtocols(u);
  const tier = u.preferredVaultTier ?? 'standard';
  const pick = tier === 'standard' ? protocols.standard : protocols.higherYield;

  if (protocols.blendedApy <= 0) {
    // No live APY available — return 503 with the per-provider sourced metadata
    // so the frontend can render "APY unavailable · Provider · Docs" instead
    // of a fake number.
    return c.json(
      {
        ok: false,
        error: { code: 'apy_unavailable', message: 'Live APY is unavailable.' },
        sourced: pick.sourced,
        adapters: protocols.adapters.map((a) => ({ name: a.name, sourced: a.sourced })),
      },
      503,
    );
  }
  return c.json({
    ok: true,
    apyBps: protocols.blendedApy,
    source: 'earn-router',
    sourced: pick.sourced,
    blended: sourced(protocols.blendedApy, pick.sourced),
  });
});

/**
 * Protocol-comparison view via the EarnRouter — returns the user's two tier
 * picks (Standard = Morpho-curated; Higher Yield = top risk-weighted APY)
 * plus the blended APY currently realized for the user's stored tier. The
 * router absorbs per-adapter read failures internally (apy 0 + available=false)
 * so this route never 500s on a single slow RPC.
 */
earnRoutes.get('/protocols', async (c) => {
  const u = c.get('user');
  const stack = getChainStack();
  const protocols = await stack.earnRouter.getProtocols(u);
  return c.json({ ok: true, ...protocols });
});

// (The `/ethena` tile is registered above the session gate — a second,
// byte-identical registration lived here until 2026-07-02; Hono first-match
// made it unreachable dead code, flagged by scripts/route-inventory.mjs.)

const EarnAmountBody = z.object({
  amountUsd: z.number().positive().max(999999),
  tier: EarnTierInput.shape.tier.optional(),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

function earnIdempotencyKeyOf(c: { req: { header(name: string): string | undefined } }, bodyKey?: string): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? bodyKey ?? '').trim();
  if (!key) return null;
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key;
}

earnRoutes.post('/deposit', zValidator('json', EarnAmountBody), async (c) => {
  const u = c.get('user');
  const { amountUsd, tier, idempotencyKey: bodyIdempotencyKey } = c.req.valid('json');
  const idempotencyKey = earnIdempotencyKeyOf(c, bodyIdempotencyKey);
  if (!env.DEMO_MODE && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  let move;
  try {
    move = await store.earnDeposit(u, amountUsd, { idempotencyKey, mirror: false });
  } catch (e) {
    if (e instanceof Error && e.message === 'idempotency_key_reused') throw ApiError.conflict('idempotency_key_reused');
    if (e instanceof PolicyError) throw ApiError.badRequest(e.message, { policyCode: e.code });
    throw e;
  }
  // Best-effort on-chain mirror via the router. Demo mode → result.demo is
  // true and the response stays 'ledger'. Live mode → the router has logged
  // the chosen adapter; we surface its name so dashboards can see it.
  let chain: { txHash: string; demo: boolean; adapter: string } | null = null;
  try {
    const stack = getChainStack();
    if (move.fresh) {
      const r = await stack.earnRouter.deposit(
        u,
        amountUsd,
        tier,
        (uu, t) => store.setPreferredVaultTier(uu, t),
        { idempotencyKey },
      );
      if (!r.demo) chain = { txHash: r.txHash, demo: r.demo, adapter: r.adapter };
    }
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'earn: router deposit mirror failed');
  }
  // Adapter label tracks what the user sees (the ledger-truth deposit). For
  // metrics, we report the chain-mirror's adapter when live, falling back to
  // the user's stored tier resolved through the router otherwise.
  earnDeposit.inc({ adapter: chain?.adapter ?? 'router' });
  return c.json({
    ok: true,
    balUsd: u.balUsd,
    earnUsd: u.earnUsd,
    txHash: chain?.txHash ?? null,
    adapter: chain?.adapter ?? null,
    source: chain ? chain.adapter : 'ledger',
  });
});

earnRoutes.post('/withdraw', zValidator('json', EarnAmountBody), async (c) => {
  const u = c.get('user');
  const { amountUsd, tier, idempotencyKey: bodyIdempotencyKey } = c.req.valid('json');
  const idempotencyKey = earnIdempotencyKeyOf(c, bodyIdempotencyKey);
  if (!env.DEMO_MODE && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }
  let move;
  try {
    move = await store.earnWithdraw(u, amountUsd, { idempotencyKey, mirror: false });
  } catch (e) {
    if (e instanceof Error && e.message === 'idempotency_key_reused') throw ApiError.conflict('idempotency_key_reused');
    if (e instanceof PolicyError) throw ApiError.badRequest(e.message, { policyCode: e.code });
    throw e;
  }
  // Best-effort on-chain mirror; demo stays ledger-only.
  let chain: { txHash: string; demo: boolean; adapter: string } | null = null;
  try {
    const stack = getChainStack();
    if (move.fresh) {
      const r = await stack.earnRouter.withdraw(u, amountUsd, tier, { idempotencyKey });
      if (!r.demo) chain = { txHash: r.txHash, demo: r.demo, adapter: r.adapter };
    }
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'earn: router withdraw mirror failed');
  }
  earnWithdraw.inc({ adapter: chain?.adapter ?? 'router' });
  return c.json({
    ok: true,
    balUsd: u.balUsd,
    earnUsd: u.earnUsd,
    txHash: chain?.txHash ?? null,
    adapter: chain?.adapter ?? null,
    source: chain ? chain.adapter : 'ledger',
  });
});

/**
 * Sprint 10 Item A — earn-by-default + auto-divest-on-spend toggles. All three
 * fields default false / false / $50; users opt in. The body is a partial patch
 * so a single field can flip without resending the others.
 */
const EarnConfigBody = z.object({
  earnByDefault: z.boolean().optional(),
  autoDivestOnSpend: z.boolean().optional(),
  divestThresholdUsd: z.number().nonnegative().max(999999).optional(),
});

earnRoutes.post('/configure', zValidator('json', EarnConfigBody), async (c) => {
  const u = c.get('user');
  const patch = c.req.valid('json');
  const updated = await store.setEarnConfig(u, patch);
  return c.json({
    ok: true,
    config: {
      earnByDefault: updated.earnByDefault,
      autoDivestOnSpend: updated.autoDivestOnSpend,
      divestThresholdUsd: updated.divestThresholdUsd,
    },
  });
});

/**
 * Stack upgrades Phase 1 — set the user's vault tier preference. The
 * EarnRouter uses this to pick adapters on subsequent deposit/withdraw calls.
 */
earnRoutes.post('/tier', zValidator('json', EarnTierInput), async (c) => {
  const u = c.get('user');
  const { tier } = c.req.valid('json');
  const updated = await store.setPreferredVaultTier(u, tier);
  return c.json({ ok: true, tier: updated.preferredVaultTier ?? tier });
});

/**
 * Sprint 15 — full Morpho curated vault list. Surfaces the top Base USDC
 * vaults (Steakhouse / Gauntlet / Moonwell / Spark / etc.) so the Earn UI
 * can present a picker rather than a single pinned address. Read-only;
 * gated by VITEST so tests stay deterministic.
 */
earnRoutes.get('/morpho/vaults', async (c) => {
  if (process.env['VITEST']) {
    return c.json(
      {
        ok: false,
        error: { code: 'vitest_disabled', message: 'Morpho vaults read disabled in vitest.' },
        sourced: unavailableMeta('morpho', 'vaults', new Error('VITEST guard')),
      },
      503,
    );
  }
  const asset = (c.req.query('asset') ?? 'USDC').toUpperCase();
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 12), 1), 50);
  try {
    const vaults = await fetchMorphoVaultsList({ assetSymbol: asset, first: 25 });
    const top = vaults
      .filter((v) => v.apyBps != null)
      .sort((a, b) => (b.apyBps ?? 0) - (a.apyBps ?? 0))
      .slice(0, limit);
    return c.json({
      ok: true,
      asset,
      vaults: top,
      pinnedAddress: env.MORPHO_VAULT_ADDRESS,
      sourced: liveMeta('morpho', 'vaults'),
    });
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: { code: 'morpho_vaults_unavailable', message: 'Morpho vaults list unavailable.' },
        sourced: unavailableMeta('morpho', 'vaults', e),
      },
      503,
    );
  }
});

const MarinadeStakeBody = z.object({
  amountSol: z.number().positive().max(1000),
});

const MarinadeUnstakeBody = z.object({
  amountMSol: z.number().positive().max(1000),
  immediate: z.boolean().optional(),
});

function solToLamports(amount: number): bigint {
  const lamports = Math.round(amount * 1_000_000_000);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw ApiError.badRequest('invalid_amount');
  }
  return BigInt(lamports);
}

earnRoutes.post('/marinade/stake', zValidator('json', MarinadeStakeBody), async (c) => {
  const u = c.get('user');
  const { amountSol } = c.req.valid('json');
  let wallet: SolanaWalletHandle;
  try {
    wallet = await getChainStack().wallets.getOrCreateUserSolanaWallet(u.id, null);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'earn: Marinade stake wallet unavailable');
    return c.json(
      { ok: false, error: { code: 'wallet_unavailable', message: 'Solana wallet unavailable.' } },
      503,
    );
  }

  const result = await marinade.marinadeStake({
    walletAddress: wallet.address,
    signTx: wallet.signTx,
    solLamports: solToLamports(amountSol),
  });
  if (result.status !== 'submitted') {
    return c.json(
      { ok: false, error: { code: 'marinade_unavailable', message: result.reason } },
      502,
    );
  }
  return c.json({
    ok: true,
    signature: result.signature,
    confirmed: result.confirmed,
    mSolMint: result.mSolMint,
    walletAddress: wallet.address,
    sourced: liveMeta('marinade', 'stake'),
  });
});

earnRoutes.post('/marinade/unstake', zValidator('json', MarinadeUnstakeBody), async (c) => {
  const u = c.get('user');
  const { amountMSol, immediate } = c.req.valid('json');
  let wallet: SolanaWalletHandle;
  try {
    wallet = await getChainStack().wallets.getOrCreateUserSolanaWallet(u.id, null);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'earn: Marinade unstake wallet unavailable');
    return c.json(
      { ok: false, error: { code: 'wallet_unavailable', message: 'Solana wallet unavailable.' } },
      503,
    );
  }

  const result = await marinade.marinadeUnstake({
    walletAddress: wallet.address,
    signTx: wallet.signTx,
    mSolAmount: solToLamports(amountMSol),
    immediate,
  });
  if (result.status !== 'submitted') {
    return c.json(
      { ok: false, error: { code: 'marinade_unavailable', message: result.reason } },
      502,
    );
  }
  return c.json({
    ok: true,
    signature: result.signature,
    confirmed: result.confirmed,
    via: result.via,
    walletAddress: wallet.address,
    sourced: liveMeta('marinade', 'unstake'),
  });
});

export const swapRoutes = new Hono();

swapRoutes.use('*', requireSession);

/**
 * Phase 2 — multi-chain swap surface. Same-chain (Base USDC⇄EURC) is the
 * existing path; cross-chain (Base→Gnosis USDC→EURe) reuses the same router
 * so the front-end only needs one code path. Defaults preserve the prior
 * Base-only contract — `direction` alone keeps the legacy call shape working.
 */
const SUPPORTED_CHAINS = ['base', 'gnosis', 'polygon', 'optimism', 'arbitrum', 'solana'] as const;
const SUPPORTED_TOKENS = ['USDC', 'EURC', 'EURe', 'USDT', 'SOL', 'mSOL'] as const;
type SwapChain = typeof SUPPORTED_CHAINS[number];
type SwapToken = typeof SUPPORTED_TOKENS[number];

const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAYAN_TOKENS: Record<string, Partial<Record<SwapToken, string>>> = {
  base: { USDC: env.USDC_ADDRESS },
  polygon: { USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  optimism: { USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  arbitrum: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  solana: { USDC: SOLANA_USDC_MINT, SOL: SOL_MINT, mSOL: marinade.MSOL_MINT },
};

function isMayanRoute(fromChain: SwapChain, toChain: SwapChain): boolean {
  return fromChain === 'solana' || toChain === 'solana';
}

function isBridgeChain(chain: SwapChain): chain is Exclude<SwapChain, 'solana'> {
  return chain !== 'solana';
}

function isBridgeToken(token: SwapToken): token is Exclude<SwapToken, 'SOL' | 'mSOL'> {
  return token !== 'SOL' && token !== 'mSOL';
}

function mayanInputForRoute(input: {
  amount: number;
  fromChain: SwapChain;
  toChain: SwapChain;
  fromToken: SwapToken;
  toToken: SwapToken;
}): MayanQuoteInput | null {
  const fromChain = input.fromChain === 'gnosis' ? null : input.fromChain;
  const toChain = input.toChain === 'gnosis' ? null : input.toChain;
  if (!fromChain || !toChain) return null;
  const fromToken = MAYAN_TOKENS[input.fromChain]?.[input.fromToken];
  const toToken = MAYAN_TOKENS[input.toChain]?.[input.toToken];
  if (!fromToken || !toToken) return null;
  return {
    amountIn: input.amount,
    fromChain,
    toChain,
    fromToken,
    toToken,
    slippageBps: 300,
  };
}

const SwapBody = z.object({
  amount: z.number().positive().max(999999),
  direction: z.enum(['usd-eur', 'eur-usd']).optional(),
  fromChain: z.enum(SUPPORTED_CHAINS).optional(),
  toChain: z.enum(SUPPORTED_CHAINS).optional(),
  fromToken: z.enum(SUPPORTED_TOKENS).optional(),
  toToken: z.enum(SUPPORTED_TOKENS).optional(),
  enableRefuel: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

const SwapQuoteQuery = z.object({
  amount: z.coerce.number().positive().max(999999),
  direction: z.enum(['usd-eur', 'eur-usd']).optional(),
  fromChain: z.enum(SUPPORTED_CHAINS).optional(),
  toChain: z.enum(SUPPORTED_CHAINS).optional(),
  fromToken: z.enum(SUPPORTED_TOKENS).optional(),
  toToken: z.enum(SUPPORTED_TOKENS).optional(),
  enableRefuel: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
});

/** Resolve the legacy `direction` field into chain/token pairs (Base USDC⇄EURC). */
function fromDirection(direction: 'usd-eur' | 'eur-usd'): {
  fromChain: 'base';
  toChain: 'base';
  fromToken: 'USDC' | 'EURC';
  toToken: 'USDC' | 'EURC';
} {
  return direction === 'usd-eur'
    ? { fromChain: 'base', toChain: 'base', fromToken: 'USDC', toToken: 'EURC' }
    : { fromChain: 'base', toChain: 'base', fromToken: 'EURC', toToken: 'USDC' };
}

function swapIdempotencyKeyOf(c: { req: { header(name: string): string | undefined } }, bodyKey?: string): string | null {
  const key = (c.req.header('Idempotency-Key') ?? c.req.header('X-Idempotency-Key') ?? bodyKey ?? '').trim();
  if (!key) return null;
  if (key.length > 120) throw ApiError.badRequest('invalid_idempotency_key');
  return key;
}

type SwapExecuteSource = 'mayan' | 'socket' | 'lifi';

function scopedSwapIdempotencyKey(key: string): string {
  return `swap-execute:${createHash('sha256').update(key).digest('hex')}`;
}

function swapTokenPair(fromToken: SwapToken, toToken: SwapToken): string {
  return `${fromToken}->${toToken}`;
}

function swapAmountAtoms(amount: number): string {
  return String(Math.round(amount * 1_000_000));
}

function swapBucketForChain(chain: SwapChain): TransferBucket {
  return chain === 'base' ? 'cash' : 'external';
}

function transferProvider(transfer: Transfer, fallback: SwapExecuteSource): SwapExecuteSource {
  return transfer.rail === 'lifi' || transfer.rail === 'socket' || transfer.rail === 'mayan'
    ? transfer.rail
    : fallback;
}

function swapTransferMatches(
  transfer: Transfer,
  expected: {
    amount: number;
    amountAtoms: string;
    fromChain: SwapChain;
    toChain: SwapChain;
    tokenPair: string;
    rail?: TransferRail;
  },
): boolean {
  return (
    Math.abs(transfer.amountUsd - expected.amount) <= 0.000001 &&
    transfer.amountTokenAtoms === expected.amountAtoms &&
    transfer.fromChain === expected.fromChain &&
    transfer.toChain === expected.toChain &&
    transfer.token === expected.tokenPair &&
    (expected.rail ? transfer.rail === expected.rail : true)
  );
}

function swapReconciliationRequired(c: Context, transfer: Transfer): Response {
  return c.json(
    {
      ok: false,
      transfer,
      error: {
        code: 'swap_reconciliation_required',
        message: 'swap_reconciliation_required',
      },
    },
    503,
  );
}

function eventNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function replayedSwapNumbers(
  transfer: Transfer,
): Promise<{ out: number; rate: number; fees: number }> {
  const events = await transferStore.listEvents(transfer.id);
  const submitted = [...events].reverse().find(
    (event) =>
      event.eventType === 'swap_submitted' &&
      event.payload !== null &&
      typeof event.payload === 'object' &&
      !Array.isArray(event.payload),
  );
  const payload = submitted?.payload as Record<string, unknown> | undefined;
  return {
    out: payload ? eventNumber(payload, 'out') ?? transfer.amountUsd : transfer.amountUsd,
    rate: payload ? eventNumber(payload, 'rate') ?? 1 : 1,
    fees: payload ? eventNumber(payload, 'fees') ?? transfer.feesUsd : transfer.feesUsd,
  };
}

async function replayProviderSwap(
  c: Context,
  transfer: Transfer,
  fallbackSource: SwapExecuteSource,
  balUsd: number,
): Promise<Response> {
  if (transfer.status === 'failed') {
    throw ApiError.conflict('idempotency_key_used', { transferId: transfer.id, status: transfer.status });
  }
  const txHash = transfer.srcTxHash ?? transfer.dstTxHash;
  if (transfer.status !== 'complete' || !txHash) {
    return swapReconciliationRequired(c, transfer);
  }
  const source = transferProvider(transfer, fallbackSource);
  const numbers = await replayedSwapNumbers(transfer);
  return c.json({
    ok: true,
    ...numbers,
    balUsd,
    txHash,
    source,
    sourced: liveMeta(source, 'swap-execute'),
    transferId: transfer.id,
    idempotent: true,
  });
}

async function failSwapTransfer(
  transfer: Transfer | null,
  code: string,
  message: string,
): Promise<void> {
  if (!transfer) return;
  const error = { code, message };
  await transferStore.update(transfer.id, { status: 'failed', error });
  await transferStore.appendEvent(transfer.id, 'error', error);
}

swapRoutes.get('/quote', async (c) => {
  const parsed = SwapQuoteQuery.safeParse({
    amount: c.req.query('amount') ?? '',
    direction: c.req.query('direction'),
    fromChain: c.req.query('fromChain'),
    toChain: c.req.query('toChain'),
    fromToken: c.req.query('fromToken'),
    toToken: c.req.query('toToken'),
    enableRefuel: c.req.query('enableRefuel'),
  });
  if (!parsed.success) {
    const isAmount = parsed.error.issues.some((issue) => issue.path[0] === 'amount');
    throw ApiError.badRequest(isAmount ? 'invalid_amount' : 'invalid_swap_route');
  }
  const amount = parsed.data.amount;
  const direction = parsed.data.direction ?? 'usd-eur';
  // Per-axis overrides — when the caller sends explicit fromChain/toChain/etc.
  // the router crosses chains; otherwise default to the legacy Base-only path.
  const u = c.get('user');
  const stack = getChainStack();
  const fromChain = parsed.data.fromChain ?? 'base';
  const toChain = parsed.data.toChain ?? 'base';
  const dirPair = fromDirection(direction);
  const fromToken = parsed.data.fromToken ?? dirPair.fromToken;
  const toToken = parsed.data.toToken ?? dirPair.toToken;
  const enableRefuel = parsed.data.enableRefuel ?? fromChain !== toChain;

  if (isMayanRoute(fromChain, toChain)) {
    const mayanInput = mayanInputForRoute({ amount, fromChain, toChain, fromToken, toToken });
    if (!mayanInput) throw ApiError.badRequest('invalid_swap_route');
    try {
      const quote = (await mayanAdapter.quote(mayanInput))[0];
      if (!quote) throw new Error('mayan_no_route');
      return c.json({
        ok: true,
        amount,
        direction,
        fromChain,
        toChain,
        fromToken,
        toToken,
        rate: quote.price,
        out: quote.expectedAmountOut,
        fees: quote.redeemRelayerFee,
        refuelGasUsd: null,
        source: 'mayan',
        sourced: liveMeta('mayan', 'swap-quote'),
      });
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'swap: Mayan quote failed');
      if (!env.DEMO_MODE) {
        return c.json(
          {
            ok: false,
            error: { code: 'quote_unavailable', message: 'Live swap quote is unavailable.' },
            sourced: unavailableMeta('mayan', 'swap-quote', e),
          },
          502,
        );
      }
      return c.json({
        ok: true,
        amount,
        direction,
        fromChain,
        toChain,
        fromToken,
        toToken,
        rate: 1,
        out: amount,
        fees: 0,
        refuelGasUsd: null,
        source: 'demo',
        sourced: providerDemoMeta('mayan', 'swap-quote'),
      });
    }
  }
  if (!isBridgeChain(fromChain) || !isBridgeChain(toChain) || !isBridgeToken(fromToken) || !isBridgeToken(toToken)) {
    throw ApiError.badRequest('invalid_swap_route');
  }

  try {
    const wallet = await stack.wallets.getOrCreateUserWallet(u.id, null);
    const quote = await stack.bridgeRouter.quote({
      fromChain,
      toChain,
      fromToken,
      toToken,
      amountUsd: amount,
      userAddress: wallet.address,
      enableRefuel,
    });
    const out = Number(quote.estimate.toAmount) / 1e6;
    const meta = liveMeta(quote.provider, 'swap-quote');
    return c.json({
      ok: true,
      amount,
      direction,
      fromChain,
      toChain,
      fromToken,
      toToken,
      rate: quote.estimate.rate,
      out,
      fees: quote.estimate.estimatedGasUsd,
      refuelGasUsd: quote.estimate.refuelGasUsd ?? null,
      source: quote.provider,
      sourced: meta,
    });
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'swap: quote via router failed');
    if (!env.DEMO_MODE) {
      const meta = unavailableMeta('socket', 'swap-quote', e);
      return c.json(
        {
          ok: false,
          error: { code: 'quote_unavailable', message: 'Live swap quote is unavailable.' },
          sourced: meta,
        },
        502,
      );
    }
    const RATE = 0.92;
    const rate = direction === 'usd-eur' ? RATE : 1 / RATE;
    return c.json({
      ok: true,
      amount,
      direction,
      fromChain,
      toChain,
      fromToken,
      toToken,
      rate,
      out: amount * rate,
      fees: 0,
      refuelGasUsd: null,
      source: 'demo',
      sourced: providerDemoMeta('socket', 'swap-quote'),
    });
  }
});

swapRoutes.post('/execute', zValidator('json', SwapBody), async (c) => {
  const u = c.get('user');
  const body = c.req.valid('json');
  const direction = body.direction ?? 'usd-eur';
  const dirPair = fromDirection(direction);
  const fromChain = body.fromChain ?? 'base';
  const toChain = body.toChain ?? 'base';
  const fromToken = body.fromToken ?? dirPair.fromToken;
  const toToken = body.toToken ?? dirPair.toToken;
  const enableRefuel = body.enableRefuel ?? fromChain !== toChain;
  const idempotencyKey = swapIdempotencyKeyOf(c, body.idempotencyKey);
  if (!env.DEMO_MODE && !idempotencyKey) {
    throw ApiError.badRequest('idempotency_key_required');
  }

  const isLegacySwap = fromChain === 'base' && toChain === 'base'
    && ((fromToken === 'USDC' && toToken === 'EURC') || (fromToken === 'EURC' && toToken === 'USDC'));
  const tokenPair = swapTokenPair(fromToken, toToken);
  const amountAtoms = swapAmountAtoms(body.amount);
  const scopedIdempotencyKey = idempotencyKey ? scopedSwapIdempotencyKey(idempotencyKey) : null;

  if (isMayanRoute(fromChain, toChain)) {
    const mayanInput = mayanInputForRoute({ amount: body.amount, fromChain, toChain, fromToken, toToken });
    if (!mayanInput) throw ApiError.badRequest('invalid_swap_route');
    if (scopedIdempotencyKey) {
      const existing = await transferStore.findByUserIdempotencyKey(u.id, scopedIdempotencyKey);
      if (existing) {
        if (
          !swapTransferMatches(existing, {
            amount: body.amount,
            amountAtoms,
            fromChain,
            toChain,
            tokenPair,
            rail: 'mayan',
          })
        ) {
          throw ApiError.conflict('idempotency_key_reused', {
            transferId: existing.id,
            originalAmountUsd: existing.amountUsd,
            originalFromChain: existing.fromChain,
            originalToChain: existing.toChain,
          });
        }
        return replayProviderSwap(c, existing, 'mayan', u.balUsd);
      }
    }

    let transfer: Transfer | null = null;
    try {
      const quote = (await mayanAdapter.quote(mayanInput))[0];
      if (!quote) throw new Error('mayan_no_route');
      const stack = getChainStack();
      const evmWallet = await stack.wallets.getOrCreateUserWallet(u.id, null);
      const solWallet = await stack.wallets.getOrCreateUserSolanaWallet(u.id, null);
      if (scopedIdempotencyKey) {
        const created = await transferStore.create({
          userId: u.id,
          fromBucket: swapBucketForChain(fromChain),
          toBucket: swapBucketForChain(toChain),
          fromChain: fromChain as TransferChain,
          toChain: toChain as TransferChain,
          amountUsd: body.amount,
          amountTokenAtoms: amountAtoms,
          token: tokenPair,
          rail: 'mayan',
          idempotencyKey: scopedIdempotencyKey,
        });
        transfer = created.transfer;
        if (!created.fresh) {
          if (
            !swapTransferMatches(created.transfer, {
              amount: body.amount,
              amountAtoms,
              fromChain,
              toChain,
              tokenPair,
              rail: 'mayan',
            })
          ) {
            throw ApiError.conflict('idempotency_key_reused', {
              transferId: created.transfer.id,
              originalAmountUsd: created.transfer.amountUsd,
              originalFromChain: created.transfer.fromChain,
              originalToChain: created.transfer.toChain,
            });
          }
          return replayProviderSwap(c, created.transfer, 'mayan', u.balUsd);
        }
        await transferStore.appendEvent(transfer.id, 'created', {
          rail: 'mayan',
          fromChain,
          toChain,
          fromToken,
          toToken,
          amountUsd: body.amount,
        });
      }
      const result = await mayanAdapter.execute({
        quote,
        fromAddress: fromChain === 'solana' ? solWallet.address : evmWallet.address,
        toAddress: toChain === 'solana' ? solWallet.address : evmWallet.address,
        signSolanaTx: solWallet.signTx,
        userId: u.id,
        idempotencyKey,
      });
      if (result.status !== 'submitted') {
        await failSwapTransfer(transfer, 'swap_unavailable', result.reason);
        return c.json(
          { ok: false, error: { code: 'swap_unavailable', message: result.reason } },
          502,
        );
      }
      if (transfer) {
        await transferStore.update(transfer.id, {
          status: 'complete',
          srcTxHash: result.sourceTxId,
          feesUsd: quote.redeemRelayerFee,
        });
        await transferStore.appendEvent(transfer.id, 'swap_submitted', {
          source: 'mayan',
          txHash: result.sourceTxId,
          out: quote.expectedAmountOut,
          rate: quote.price,
          fees: quote.redeemRelayerFee,
        });
      }
      return c.json({
        ok: true,
        out: quote.expectedAmountOut,
        rate: quote.price,
        fees: quote.redeemRelayerFee,
        balUsd: u.balUsd,
        txHash: result.sourceTxId,
        source: 'mayan',
        sourced: liveMeta('mayan', 'swap-execute'),
        ...(transfer ? { transferId: transfer.id, idempotent: false } : {}),
      });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      await failSwapTransfer(
        transfer,
        'swap_unavailable',
        e instanceof Error ? e.message : String(e),
      );
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'swap: Mayan execute failed');
      return c.json(
        { ok: false, error: { code: 'swap_unavailable', message: 'Live swap route is unavailable.' } },
        502,
      );
    }
  }
  if (!isBridgeChain(fromChain) || !isBridgeChain(toChain) || !isBridgeToken(fromToken) || !isBridgeToken(toToken)) {
    throw ApiError.badRequest('invalid_swap_route');
  }

  if (!env.DEMO_MODE && isLegacySwap && direction === 'usd-eur' && body.amount > u.balUsd) {
    throw ApiError.badRequest('More than your spending balance.', { policyCode: 'insufficient_funds' });
  }

  // Claim the route idempotency key before any provider submit. A retry with the
  // same key replays this transfer row and never calls Socket/LIFI again.
  let chain: { txHash: string; provider: 'socket' | 'lifi'; demo: boolean } | null = null;
  let transfer: Transfer | null = null;
  let freshTransfer = false;
  try {
    if (scopedIdempotencyKey) {
      const created = await transferStore.create({
        userId: u.id,
        fromBucket: swapBucketForChain(fromChain),
        toBucket: swapBucketForChain(toChain),
        fromChain: fromChain as TransferChain,
        toChain: toChain as TransferChain,
        amountUsd: body.amount,
        amountTokenAtoms: amountAtoms,
        token: tokenPair,
        rail: 'socket',
        idempotencyKey: scopedIdempotencyKey,
      });
      transfer = created.transfer;
      freshTransfer = created.fresh;
      if (
        !swapTransferMatches(created.transfer, {
          amount: body.amount,
          amountAtoms,
          fromChain,
          toChain,
          tokenPair,
        })
      ) {
        throw ApiError.conflict('idempotency_key_reused', {
          transferId: created.transfer.id,
          originalAmountUsd: created.transfer.amountUsd,
          originalFromChain: created.transfer.fromChain,
          originalToChain: created.transfer.toChain,
        });
      }
      if (!created.fresh) {
        if (created.transfer.status === 'failed') {
          throw ApiError.conflict('idempotency_key_used', {
            transferId: created.transfer.id,
            status: created.transfer.status,
          });
        }
        const txHash = created.transfer.srcTxHash ?? created.transfer.dstTxHash;
        if (created.transfer.status !== 'complete' || !txHash) {
          return swapReconciliationRequired(c, created.transfer);
        }
        const provider = transferProvider(created.transfer, 'socket');
        chain = { txHash, provider: provider === 'mayan' ? 'socket' : provider, demo: false };
      } else {
        await transferStore.appendEvent(created.transfer.id, 'created', {
          rail: 'bridge-router',
          fromChain,
          toChain,
          fromToken,
          toToken,
          amountUsd: body.amount,
        });
      }
    }

    if (!chain) {
      const stack = getChainStack();
      const wallet = await stack.wallets.getOrCreateUserWallet(u.id, null);
      const r = await stack.bridgeRouter.execute(
        {
          fromChain,
          toChain,
          fromToken,
          toToken,
          amountUsd: body.amount,
          userAddress: wallet.address,
          enableRefuel,
        },
        u.id,
        { idempotencyKey },
      );
      chain = { txHash: r.txHash, provider: r.provider, demo: r.demo };
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    await failSwapTransfer(
      freshTransfer ? transfer : null,
      'swap_unavailable',
      e instanceof Error ? e.message : String(e),
    );
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'swap: router execute failed');
    if (!env.DEMO_MODE) {
      return c.json(
        { ok: false, error: { code: 'swap_unavailable', message: 'Live swap route is unavailable.' } },
        502,
      );
    }
  }

  if (!env.DEMO_MODE && (!chain || chain.demo)) {
    await failSwapTransfer(transfer, 'swap_unavailable', 'Live swap route is unavailable.');
    return c.json(
      { ok: false, error: { code: 'swap_unavailable', message: 'Live swap route is unavailable.' } },
      502,
    );
  }

  if (freshTransfer && transfer && chain) {
    await transferStore.update(transfer.id, {
      status: 'complete',
      rail: chain.provider,
      srcTxHash: chain.txHash,
      feesUsd: 0,
    });
    await transferStore.appendEvent(transfer.id, 'swap_submitted', {
      source: chain.provider,
      txHash: chain.txHash,
      out: body.amount,
      rate: 1,
      fees: 0,
    });
  }

  // Only Base USDC ⇄ EURC is part of the fiat-mirrored ledger; other pairs
  // settle on-chain and don't touch balUsd.
  let ledgerOut = body.amount;
  let ledgerRate = 1;
  if (isLegacySwap) {
    try {
      const { out, rate } = await store.swap(u, body.amount, direction, { idempotencyKey });
      ledgerOut = out;
      ledgerRate = rate;
    } catch (e) {
      if (e instanceof Error && e.message === 'idempotency_key_reused') throw ApiError.conflict('idempotency_key_reused');
      if (e instanceof PolicyError) throw ApiError.badRequest(e.message, { policyCode: e.code });
      throw e;
    }
  }

  const executeMeta: ReturnType<typeof liveMeta> = chain && !chain.demo
    ? liveMeta(chain.provider, 'swap-execute')
    : providerDemoMeta(chain?.provider ?? 'socket', 'swap-execute');

  return c.json({
    ok: true,
    out: ledgerOut,
    rate: ledgerRate,
    fees: 0,
    balUsd: u.balUsd,
    txHash: chain?.txHash ?? null,
    source: chain && !chain.demo ? chain.provider : 'demo',
    sourced: executeMeta,
    ...(transfer ? { transferId: transfer.id, idempotent: !freshTransfer } : {}),
  });
});

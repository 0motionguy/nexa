/**
 * /onramp/* — fiat-to-USDC onramp surfaces.
 *
 * Today's only adapter: Stripe Crypto Onramp. Bridge KYB is the longest
 * critical path before native US/EU bank rails work; Stripe Crypto Onramp
 * gives us a real-money onramp via a hosted Stripe page while Bridge is
 * pending. The session endpoint is session-gated; the webhook is public but
 * HMAC-verified.
 *
 *   POST /onramp/stripe/session   — create a Stripe Crypto Onramp session
 *   POST /onramp/stripe/webhook   — handle fulfillment_completed; credit ledger
 *
 * Demo path: returns a synthetic `cs_onramp_demo_*` session that lands on a
 * /onramp-demo-success page, mirrors the offer-checkout demo loop so the e2e
 * harness round-trips without a real Stripe key.
 *
 * Sprint 15 alternative-providers drop — companion to /bridge/* for users
 * waiting on the Bridge KYB approval.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireSession } from '../lib/auth.js';
import { env, features } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { getChainStack } from '../lib/chain/index.js';
import { log } from '../lib/log.js';
import {
  createOnrampSession,
  parseOnrampCompleted,
  verifyAndParseWebhook,
} from '../lib/psp/stripe.js';
import { liveMeta, providerDemoMeta, unavailableMeta } from '../lib/sourced.js';
import { store } from '../store/index.js';
import { markWebhookSeen } from '../lib/webhook-dedup.js';

export const onrampRoutes = new Hono();

const SessionInput = z.object({
  amountUsd: z.number().positive().max(50000),
  destinationNetwork: z
    .enum(['base', 'ethereum', 'polygon', 'optimism', 'arbitrum'])
    .default('base'),
});

onrampRoutes.post('/stripe/session', requireSession, zValidator('json', SessionInput), async (c) => {
  const u = c.get('user');
  const { amountUsd, destinationNetwork } = c.req.valid('json');
  const stack = getChainStack();
  const wallet = await stack.wallets.getOrCreateUserWallet(u.id, null);
  const idempotencyKey = `${u.id}-${Math.floor(Date.now() / 60000)}-${amountUsd}-${destinationNetwork}`;

  if (!features.stripe && !env.DEMO_MODE) {
    return c.json(
      {
        ok: false,
        error: { code: 'onramp_unavailable', message: 'Stripe onramp is not configured.' },
        sourced: unavailableMeta('stripe', 'onramp-session', new Error('STRIPE_SECRET_KEY missing')),
      },
      503,
    );
  }

  try {
    const session = await createOnrampSession({
      buyerEmail: u.email,
      walletAddress: wallet.address,
      destinationNetwork,
      amountUsdCents: Math.round(amountUsd * 100),
      idempotencyKey,
      metadata: { userId: u.id, buyerEmail: u.email },
    });
    const sourced = session.demo
      ? providerDemoMeta('stripe', 'onramp-session')
      : liveMeta('stripe', 'onramp-session');
    return c.json({
      ok: true,
      sessionId: session.sessionId,
      redirectUrl: session.redirectUrl,
      destinationNetwork,
      walletAddress: wallet.address,
      amountUsd,
      demo: session.demo,
      sourced,
    });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), userId: u.id },
      'onramp: stripe session create failed',
    );
    throw ApiError.badRequest('Failed to start onramp.', { providerCode: 'stripe_failed' });
  }
});

/**
 * Public webhook for `crypto.onramp_session.fulfillment_completed`. When the
 * user finishes the hosted page and Stripe confirms the on-chain delivery of
 * USDC, we credit the ledger with the USD amount they paid.
 *
 * HMAC verification is strict — webhooks without `STRIPE_WEBHOOK_SECRET` are
 * rejected with 400 (matching the offer-checkout webhook behavior).
 */
onrampRoutes.post('/stripe/webhook', async (c) => {
  const sig = c.req.header('stripe-signature') ?? null;
  const raw = await c.req.text();
  const result = verifyAndParseWebhook(raw, sig);
  if (!result) {
    throw ApiError.badRequest('invalid_signature');
  }
  // SEC-04 — replay protection. The Stripe SDK enforces a 5-min freshness
  // tolerance on the signature, but a captured event can still be POSTed
  // multiple times within that window. Without this dedup the topUp side
  // effect would credit twice.
  if (await markWebhookSeen('stripe', result.event.id)) {
    log.info({ eventId: result.event.id, type: result.event.type }, 'onramp: webhook replay skipped');
    return c.json({ ok: true, ignored: 'replay' });
  }
  const parsed = parseOnrampCompleted(result.event);
  if (!parsed) {
    return c.json({ ok: true, ignored: true, type: result.event.type });
  }
  if (await markWebhookSeen('stripe-onramp-session', parsed.sessionId)) {
    return c.json({ ok: true, ignored: 'session_replay' });
  }

  // Stripe's onramp session metadata is set on creation; we use it to scope
  // the ledger credit to the right user. The buyer email is also on the
  // session for cross-checking.
  const userId = parsed.metadata['userId'];
  const completedStatuses = new Set(['fulfillment_complete', 'completed']);
  if (!completedStatuses.has(parsed.status)) {
    return c.json({ ok: true, status: parsed.status, ignored: true });
  }
  if (!userId) {
    log.warn(
      { sessionId: parsed.sessionId, status: parsed.status },
      'onramp: stripe webhook missing userId metadata',
    );
    return c.json({ ok: true, ignored: true, reason: 'no_user_metadata' });
  }
  let user;
  try {
    user = await store.user(userId);
  } catch (e) {
    log.warn(
      { sessionId: parsed.sessionId, userId, err: e instanceof Error ? e.message : String(e) },
      'onramp: stripe webhook user lookup failed',
    );
    return c.json({ ok: true, ignored: true, reason: 'user_not_found' });
  }
  const deliveredAmountUsd = Number(parsed.destinationAmount);
  const amountUsd = Number.isFinite(deliveredAmountUsd)
    ? Math.round(deliveredAmountUsd * 1_000_000) / 1_000_000
    : 0;
  if (amountUsd <= 0) {
    return c.json({ ok: true, ignored: true, reason: 'zero_amount' });
  }
  await store.topUp(user, amountUsd, 'Stripe Crypto Onramp');
  log.info(
    { sessionId: parsed.sessionId, userId, amountUsd },
    'onramp: stripe credited ledger',
  );
  return c.json({ ok: true, credited: amountUsd });
});

/** Demo-success endpoint for the synthetic flow — closes the loop in DEMO_MODE. */
onrampRoutes.get('/demo-success', requireSession, async (c) => {
  const u = c.get('user');
  const amount = Number(c.req.query('amount') ?? '0');
  if (!env.DEMO_MODE) {
    throw ApiError.forbidden('demo_only_endpoint');
  }
  if (!(amount > 0)) {
    throw ApiError.badRequest('invalid_amount');
  }
  const amountUsd = amount / 100;
  await store.topUp(u, amountUsd, 'Stripe Crypto Onramp · Demo');
  return c.json({
    ok: true,
    balUsd: u.balUsd,
    amountUsd,
    sourced: providerDemoMeta('stripe', 'onramp-session'),
  });
});

/** Status probe for the registry / system docs screen. */
onrampRoutes.get('/stripe/status', (c) => {
  const sourced = features.stripe
    ? liveMeta('stripe', 'onramp-session')
    : providerDemoMeta('stripe', 'onramp-session');
  return c.json({
    ok: true,
    available: features.stripe,
    provider: 'stripe',
    sourced,
  });
});

/* ── Sprint 19 — Onramper widget (aggregator with smart KYC routing) ──────
 *
 * Onramper is a meta-aggregator (30+ onramp providers, 175+ payment methods).
 * Their widget smart-routes small-tx users to the lowest-KYC vendor that fits
 * the amount + region + payment method. Backend integration is just generating
 * a signed iframe URL — no Onramper-side custody, no NEXA-side KYC.
 *
 * Docs: https://docs.onramper.com/docs/widget
 *
 * The route is gated on ONRAMPER_API_KEY. Without the key the response includes
 * a demo widget URL pointing at the demo sandbox so the UI can still render.
 */

const OnramperSessionInput = z.object({
  amountUsd: z.number().positive().max(50000).optional(),
  /** Which NEXA bucket to land in. Drives the default destination chain. */
  bucket: z.enum(['perps', 'predictions', 'memes', 'stocks-spot', 'cash']).default('cash'),
});

/** Bucket → Onramper widget chain slug. */
const BUCKET_TO_ONRAMPER_CHAIN: Record<'perps' | 'predictions' | 'memes' | 'stocks-spot' | 'cash', string> = {
  perps: 'arbitrum',
  predictions: 'polygon',
  memes: 'solana',
  'stocks-spot': 'solana',
  cash: 'base',
};

onrampRoutes.post(
  '/onramper/session',
  requireSession,
  zValidator('json', OnramperSessionInput),
  async (c) => {
    const u = c.get('user');
    const { amountUsd, bucket } = c.req.valid('json');
    const stack = getChainStack();
    const isSolana = bucket === 'memes' || bucket === 'stocks-spot';
    const wallet = isSolana
      ? await stack.wallets.getOrCreateUserSolanaWallet(u.id, null)
      : await stack.wallets.getOrCreateUserWallet(u.id, null);
    const chain = BUCKET_TO_ONRAMPER_CHAIN[bucket];
    const apiKey = env.ONRAMPER_API_KEY ?? null;

    // Build the iframe URL with the user's wallet pre-filled. Onramper's widget
    // reads `wallets` as comma-separated `chain:address` pairs.
    const params = new URLSearchParams({
      apiKey: apiKey ?? 'pk_test_demo',
      defaultCrypto: 'USDC',
      onlyCryptos: 'USDC',
      networkWallets: `${chain}:${wallet.address}`,
      defaultFiat: 'USD',
      ...(amountUsd ? { defaultAmount: String(Math.round(amountUsd)) } : {}),
      // Best-converting smart-router lane (Onramper picks the lowest-KYC
      // provider that supports the amount + region).
      mode: 'buy',
    });
    const widgetUrl = apiKey
      ? `https://buy.onramper.com?${params.toString()}`
      : `https://buy-sandbox.onramper.com?${params.toString()}`;

    const sourced = apiKey
      ? liveMeta('onramper', 'widget-session')
      : providerDemoMeta('onramper', 'widget-session');

    log.info(
      { userId: u.id, bucket, chain, walletAddress: wallet.address, demo: !apiKey },
      'onramp: onramper widget session generated',
    );

    return c.json({
      ok: true,
      widgetUrl,
      bucket,
      chain,
      walletAddress: wallet.address,
      demo: !apiKey,
      sourced,
    });
  },
);

/* ── deposit-address — the canonical "Transfer crypto in" surface ────────
 *
 * Returns the user's Privy receive address for the chain implied by the
 * trading bucket. EVM wallets share one base address across all EVM chains
 * (Privy server-wallets are bech32-like portable); Solana sits on a separate
 * wallet. Use this to render the "Send USDC to ..." panel in the Deposit
 * sheet.
 *
 * Buckets:
 *   - cash / perps        → EVM wallet on Base (most liquid USDC)
 *   - predictions         → EVM wallet on Polygon (Polymarket native chain)
 *   - memes / stocks-spot → Solana wallet (Jupiter / Backed xStocks)
 *
 * No write — purely a lookup that provisions a wallet on first call. Same
 * Privy back-end as /onramp/onramper/session uses, just exposed directly
 * for users who'd rather send from their own wallet than route through a
 * fiat-onramp aggregator.
 */
const DepositAddressBucket = z.enum(['cash', 'perps', 'predictions', 'memes', 'stocks-spot']);
type DepositAddressBucket = z.infer<typeof DepositAddressBucket>;

const BUCKET_TO_DEPOSIT_CHAIN: Record<DepositAddressBucket, { chain: string; network: 'evm' | 'solana'; tokens: string[] }> = {
  cash:           { chain: 'base',     network: 'evm',    tokens: ['USDC'] },
  perps:          { chain: 'arbitrum', network: 'evm',    tokens: ['USDC'] },
  predictions:    { chain: 'polygon',  network: 'evm',    tokens: ['USDC.e', 'USDC'] },
  memes:          { chain: 'solana',   network: 'solana', tokens: ['USDC', 'SOL'] },
  'stocks-spot':  { chain: 'solana',   network: 'solana', tokens: ['USDC'] },
};

onrampRoutes.get('/deposit-address', requireSession, async (c) => {
  const u = c.get('user');
  const rawBucket = (c.req.query('bucket') ?? 'cash').toLowerCase();
  const parsed = DepositAddressBucket.safeParse(rawBucket);
  if (!parsed.success) {
    throw ApiError.badRequest('invalid_bucket');
  }
  const bucket = parsed.data;
  const target = BUCKET_TO_DEPOSIT_CHAIN[bucket];
  const stack = getChainStack();

  const wallet = target.network === 'solana'
    ? await stack.wallets.getOrCreateUserSolanaWallet(u.id, u.privyDid ?? null)
    : await stack.wallets.getOrCreateUserWallet(u.id, u.privyDid ?? null);

  const sourced = wallet.live
    ? liveMeta('privy', 'wallet-create')
    : providerDemoMeta('privy', 'wallet-create');

  log.info(
    { userId: u.id, bucket, chain: target.chain, network: target.network, live: wallet.live },
    'onramp: deposit-address resolved',
  );

  return c.json({
    ok: true,
    bucket,
    chain: target.chain,
    network: target.network,
    address: wallet.address,
    walletId: wallet.walletId,
    tokens: target.tokens,
    live: wallet.live,
    sourced,
  });
});

/** Status probe — mirror of /stripe/status for the registry. */
onrampRoutes.get('/onramper/status', (c) => {
  const live = Boolean(env.ONRAMPER_API_KEY);
  return c.json({
    ok: true,
    available: live,
    provider: 'onramper',
    sourced: live
      ? liveMeta('onramper', 'widget-session')
      : providerDemoMeta('onramper', 'widget-session'),
  });
});

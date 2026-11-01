/**
 * Stripe Checkout adapter — Upgrade 4 (multi-method hosted checkout).
 *
 * Three surfaces:
 *   - createCheckoutSession: provisions a hosted Stripe Checkout session for
 *     one offer + one buyer and returns { sessionId, redirectUrl }. Demo
 *     fallback (no STRIPE_SECRET_KEY) returns a synthetic `cs_demo_<hex>` + a
 *     local `/checkout-demo-success` redirect so the e2e flow round-trips
 *     without a Stripe account.
 *   - verifyAndParseWebhook: wraps `stripe.webhooks.constructEvent` with
 *     timing-safe HMAC verification. Returns `null` (rather than throwing)
 *     when the secret is missing, the signature is malformed, or the body
 *     doesn't match — the route returns 400 on null.
 *   - parseCheckoutCompleted: pulls `{sessionId, paymentStatus, amountTotalCents,
 *     metadata}` out of a `checkout.session.completed` event for the route's
 *     idempotent settle path.
 *
 * Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_SUCCESS_URL,
 * STRIPE_CANCEL_URL. features.stripe = Boolean(STRIPE_SECRET_KEY).
 *
 * apiVersion pinned to `2026-05-27.dahlia` — the version @stripe/stripe-node
 * v22.2.1 pins by default. Source:
 *   https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md
 *   Retrieved 2026-06-14.
 */

import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { env, features } from '../env.js';
import { log } from '../log.js';

/** @stripe/stripe-node v22.2.1 default — change in lockstep with package upgrades. */
const STRIPE_API_VERSION = '2026-05-27.dahlia';

let client: Stripe | null = null;
/** Test override — when non-null, getClient() returns this regardless of env. */
let injectedClient: Stripe | null = null;

/** Singleton lazy init — undefined when STRIPE_SECRET_KEY is unset. */
function getClient(): Stripe | null {
  if (injectedClient) return injectedClient;
  if (!features.stripe || !env.STRIPE_SECRET_KEY) return null;
  if (!client) {
    // The Stripe constructor expects a literal-typed apiVersion. We pin the
    // version as a plain string and cast at the boundary so this file stays
    // version-agnostic; upgrading the package only changes the literal here.
    const config = { apiVersion: STRIPE_API_VERSION } as unknown as ConstructorParameters<
      typeof Stripe
    >[1];
    client = new Stripe(env.STRIPE_SECRET_KEY, config);
  }
  return client;
}

/** Test-only — clears the cached client + the injected override. */
export function resetStripeClient(): void {
  client = null;
  injectedClient = null;
  webhookSecretOverride = null;
}

/** Allow tests to inject a mock Stripe client without spinning up the real SDK. */
export function setStripeClient(mock: Stripe | null): void {
  injectedClient = mock;
}

/** Test override for STRIPE_WEBHOOK_SECRET. null means "fall back to env". */
let webhookSecretOverride: string | null = null;
export function setStripeWebhookSecret(secret: string | null): void {
  webhookSecretOverride = secret;
}
function resolvedWebhookSecret(): string | undefined {
  return webhookSecretOverride ?? env.STRIPE_WEBHOOK_SECRET;
}

export interface CreateSessionInput {
  offer: { id: string; title: string; amountUsd: number; sellerId: string };
  buyerEmail: string;
  idempotencyKey: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreatedCheckoutSession {
  sessionId: string;
  redirectUrl: string;
  /** True when the synthetic `cs_demo_…` path ran (no live Stripe call). */
  demo: boolean;
}

/**
 * Create a Stripe Checkout session for one offer + one buyer.
 *
 * Demo path (no key): returns `cs_demo_<hex>` + a relative
 * `/checkout-demo-success` redirect. The route still persists the row so the
 * web app's return-page polling closes the loop without a real Stripe call.
 *
 * Live path: POST to `checkout.sessions.create`, pin the idempotency key so
 * a retried client doesn't double-create the session, and return Stripe's
 * hosted `session.url`.
 */
export async function createCheckoutSession(
  input: CreateSessionInput,
): Promise<CreatedCheckoutSession> {
  const c = getClient();
  if (!c) {
    const sessionId = 'cs_demo_' + randomBytes(16).toString('hex');
    // Demo redirect lands back on the same hosted checkout.html page with
    // ?session=… (no offer id). checkout-main.ts boots into return-page mode,
    // polls /checkout/session-status, and shows the success state. The query
    // string carries `mode=demo` for the e2e selector.
    // Sprint 13 COMMIT 5 (SR1) — include the buyer email so the return-page
    // poll can send the auth-gate query param. The status endpoint requires it.
    const redirectUrl = `/checkout.html?session=${sessionId}&mode=demo&buyer=${encodeURIComponent(input.buyerEmail)}`;
    return { sessionId, redirectUrl, demo: true };
  }
  try {
    const session = await c.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(input.offer.amountUsd * 100),
              product_data: { name: input.offer.title },
            },
            quantity: 1,
          },
        ],
        customer_email: input.buyerEmail,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          offerId: input.offer.id,
          sellerId: input.offer.sellerId,
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) {
      throw new Error('stripe: session.url missing');
    }
    return { sessionId: session.id, redirectUrl: session.url, demo: false };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'stripe: createCheckoutSession failed',
    );
    throw e;
  }
}

export interface ParsedCheckoutCompleted {
  sessionId: string;
  paymentStatus: string;
  amountTotalCents: number;
  metadata: Record<string, string>;
}

/**
 * Wrap `stripe.webhooks.constructEvent` with null-on-failure semantics —
 * route returns 400 when this returns null. Verifies the `t=…,v1=…` HMAC
 * against STRIPE_WEBHOOK_SECRET. Always null when the secret is unset (the
 * route can't trust unsigned events even in demo, because settling debits
 * money — keep it strict).
 */
export function verifyAndParseWebhook(
  rawBody: string,
  signature: string | null,
): { event: Stripe.Event } | null {
  const secret = resolvedWebhookSecret();
  if (!secret || !signature) return null;
  const c = getClient();
  if (!c) return null;
  try {
    const event = c.webhooks.constructEvent(rawBody, signature, secret);
    return { event };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'stripe: webhook signature verify failed',
    );
    return null;
  }
}

/**
 * Pull the fields the settle path needs out of one `checkout.session.completed`
 * event. Returns null for any other event type so the route can `ignored`-out
 * unrelated events without throwing.
 */
export function parseCheckoutCompleted(event: Stripe.Event): ParsedCheckoutCompleted | null {
  if (event.type !== 'checkout.session.completed') return null;
  const session = event.data.object as Stripe.Checkout.Session;
  return {
    sessionId: session.id,
    paymentStatus: session.payment_status,
    amountTotalCents: session.amount_total ?? 0,
    metadata: (session.metadata ?? {}) as Record<string, string>,
  };
}

/* ── Stripe Crypto Onramp ───────────────────────────────────────────────────
 * Alternative to Bridge for USD/EUR → USDC onramp while Bridge KYB is
 * pending. Hosted page handled by Stripe (KYC included). The user signs in
 * with a card; USDC is delivered to the wallet address we pass.
 *
 * Endpoint: POST https://api.stripe.com/v1/crypto/onramp_sessions
 * Source: https://docs.stripe.com/crypto/onramp
 *
 * The Onramp API is not yet typed in @stripe/stripe-node — we call it via
 * `c.rawRequest` so we still get the client's HTTP layer (idempotency keys,
 * retry, telemetry) without redoing auth from scratch.
 */

export interface OnrampSessionInput {
  /** Email of the buyer (Stripe pre-fills KYC fields). */
  buyerEmail: string;
  /** Destination wallet address (must be hex 0x… for EVM). */
  walletAddress: string;
  /** Network the USDC lands on. Base is the default for MAZE. */
  destinationNetwork: 'base' | 'ethereum' | 'polygon' | 'optimism' | 'arbitrum';
  /** Amount in cents the user wants to onramp (Stripe handles fx + fees). */
  amountUsdCents: number;
  /** Idempotency key so a retry doesn't double-charge. */
  idempotencyKey: string;
  /** Metadata passed through to the webhook on completion (userId etc.). */
  metadata?: Record<string, string>;
  /**
   * Sprint 16.4 — buyer IP for Stripe risk scoring. Optional but strongly
   * recommended by Stripe docs (https://docs.stripe.com/crypto/onramp).
   * Pass null/undefined to skip; the SDK won't send the param then.
   */
  customerIpAddress?: string | null;
}

export interface CreatedOnrampSession {
  sessionId: string;
  /** Hosted-page URL the SPA opens for the user to complete the purchase. */
  redirectUrl: string;
  /** Client secret for the embedded iframe (not used today; kept for future). */
  clientSecret: string | null;
  /** True when the synthetic demo path ran (no live Stripe call). */
  demo: boolean;
}

/**
 * Create a Stripe Crypto Onramp session.
 *
 * Demo path (no key): returns a synthetic `cs_onramp_demo_<hex>` + a relative
 * redirect to `/onramp-demo-success` so the e2e flow round-trips.
 *
 * Live path: POSTs to `/v1/crypto/onramp_sessions` via the Stripe client's
 * rawRequest helper. Idempotency-keyed so the SPA can safely retry.
 */
export async function createOnrampSession(
  input: OnrampSessionInput,
): Promise<CreatedOnrampSession> {
  const c = getClient();
  if (!c) {
    const sessionId = 'cs_onramp_demo_' + randomBytes(12).toString('hex');
    const redirectUrl =
      `/onramp-demo-success?session=${sessionId}` +
      `&buyer=${encodeURIComponent(input.buyerEmail)}` +
      `&amount=${input.amountUsdCents}`;
    return { sessionId, redirectUrl, clientSecret: null, demo: true };
  }
  try {
    // Stripe Crypto Onramp expects form-encoded params. We use rawRequest so
    // we get the client's retry + telemetry + idempotency-key handling.
    //
    // Sprint 16.4 fixes per official Stripe Crypto Onramp docs review:
    //   - `lock_wallet_address: true` so the user can't swap the destination
    //     in the Stripe UI (we want them to fund THEIR MAZE wallet, not
    //     someone else's address)
    //   - `customer_ip_address` for fraud scoring when the caller passes it
    //   - `wallet_addresses[ethereum]` works for any EVM dest (ethereum,
    //     base, polygon, optimism, arbitrum) — same hex address shape.
    //     Stripe still requires the per-network key.
    const params = new URLSearchParams({
      'customer_information[email]': input.buyerEmail,
      'wallet_addresses[ethereum]': input.walletAddress,
      'source_currency': 'usd',
      'destination_currencies[]': 'usdc',
      'destination_networks[]': input.destinationNetwork,
      'source_amount': (input.amountUsdCents / 100).toFixed(2),
      'lock_wallet_address': 'true',
    });
    if (input.customerIpAddress) {
      params.set('customer_ip_address', input.customerIpAddress);
    }
    for (const [k, v] of Object.entries(input.metadata ?? {})) {
      params.set(`metadata[${k}]`, v);
    }
    const session = (await (c as unknown as {
      rawRequest: (
        method: string,
        path: string,
        body?: string,
        opts?: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    }).rawRequest(
      'POST',
      '/v1/crypto/onramp_sessions',
      params.toString(),
      { idempotencyKey: input.idempotencyKey },
    )) as {
      id: string;
      redirect_url?: string;
      client_secret?: string;
    };
    if (!session.redirect_url) {
      throw new Error('stripe: onramp redirect_url missing');
    }
    return {
      sessionId: session.id,
      redirectUrl: session.redirect_url,
      clientSecret: session.client_secret ?? null,
      demo: false,
    };
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'stripe: createOnrampSession failed',
    );
    throw e;
  }
}

export interface ParsedOnrampUpdated {
  sessionId: string;
  status: string;
  /** USD cents the user actually paid (after Stripe fees). */
  sourceAmountCents: number;
  /** USDC the user received (decimal string from Stripe). */
  destinationAmount: string;
  metadata: Record<string, string>;
}

/**
 * Parse a `crypto.onramp_session.fulfillment_completed` event. Returns null
 * for any other event type so the webhook route can `ignored`-out unrelated
 * notifications without throwing. The crypto.onramp_session event family is
 * beta-tier and not yet in @stripe/stripe-node's typed event union, so we
 * cast through `unknown` at the boundary.
 */
const ONRAMP_EVENT_TYPES = new Set(['crypto.onramp_session.fulfillment_completed']);

export function parseOnrampCompleted(event: Stripe.Event): ParsedOnrampUpdated | null {
  const eventType = (event as unknown as { type: string }).type;
  if (!ONRAMP_EVENT_TYPES.has(eventType)) return null;
  const data = (event as unknown as { data: { object: Record<string, unknown> } }).data;
  const session = data.object as {
    id?: string;
    status?: string;
    source_total_amount?: string;
    destination_amount?: string;
    metadata?: Record<string, string>;
  };
  if (!session.id || !session.status) return null;
  return {
    sessionId: session.id,
    status: session.status,
    sourceAmountCents: session.source_total_amount
      ? Math.round(parseFloat(session.source_total_amount) * 100)
      : 0,
    destinationAmount: session.destination_amount ?? '0',
    metadata: session.metadata ?? {},
  };
}

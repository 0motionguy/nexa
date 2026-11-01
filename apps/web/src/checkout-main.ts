/**
 * MAZE hosted checkout — standalone buyer surface (not the app shell).
 *
 * Sprint 10 Item G + Stack upgrades Phase 4 — three checkout methods:
 *   1. Resolve the offer id (?id= first, then the /o/<id> path tail) →
 *      GET /checkout/:id → render the offer.
 *   2. Three payment paths render together:
 *      - Balance pay (signed-in): POST /checkout/:id/pay { method: 'balance' }
 *      - Card / Apple Pay: POST /checkout/:id/pay { method: 'card' } returns
 *        { redirectUrl } → window.location to Stripe (or the demo success
 *        page if STRIPE_SECRET_KEY is unset).
 *      - Bank wire: POST /checkout/:id/pay { method: 'bank_topup' } returns
 *        { accountNumber, routingNumber, bankName, livemode } → render
 *        wire instructions in-page.
 *   3. Signed-out: an inline magic-link OTP is offered alongside the card and
 *      bank paths so MAZE-balance users can still sign in inline.
 *   4. Return page (?session=… in the URL): poll
 *      GET /checkout/session-status until status flips to 'completed' →
 *      show success.
 *
 * Buyer-facing copy is FIAT ONLY ("Pay $9.99") — no crypto/wallet/USDC
 * vocabulary ever reaches this page.
 */

import { ApiFailure, getToken, nexaApi, setToken } from '@/lib/api.js';
import type { CheckoutView } from '@nexa/shared-zod';

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}

/* Apply the theme the inline boot script resolved (shared with /app.html). */
(() => {
  const boot = document.documentElement.getAttribute('data-boot-theme');
  if (boot === 'dark' || boot === 'light') $('#stage').setAttribute('data-theme', boot);
})();

/** A stable id per page load — replaying Pay reuses the same payment. */
function makeKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 'co-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
const idempotencyKey = makeKey();

/** ?id= wins; otherwise the tail of a /o/<id> (or /checkout/<id>) path. */
function resolveOfferId(): string | null {
  const q = new URLSearchParams(location.search).get('id');
  if (q && q.trim()) return q.trim();
  const m = location.pathname.match(/\/(?:o|checkout)\/([^/?#]+)/);
  if (m && m[1]) return decodeURIComponent(m[1]);
  return null;
}

/** Fiat formatter — USD/EUR symbol in front, two decimals. */
function fiat(amountUsd: number, currency: 'USD' | 'EUR'): string {
  const symbol = currency === 'EUR' ? '€' : '$';
  return (
    symbol +
    amountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function show(which: 'loading' | 'error' | 'offer' | 'success'): void {
  ($('#coLoading') as HTMLElement).hidden = which !== 'loading';
  ($('#coError') as HTMLElement).hidden = which !== 'error';
  ($('#coOffer') as HTMLElement).hidden = which !== 'offer';
  ($('#coSuccess') as HTMLElement).hidden = which !== 'success';
}

function showError(message?: string): void {
  if (message) $('#coErrorMsg').textContent = message;
  show('error');
}

let priceLabel = '';
let offerAmount = 0;
let offerCurrency: 'USD' | 'EUR' = 'USD';

function renderOffer(c: CheckoutView): void {
  document.title = `${c.title} · MAZE`;
  $('#coSeller').textContent = c.sellerName ? `${c.sellerName.toUpperCase()} · SECURE CHECKOUT` : 'SECURE CHECKOUT';
  $('#coTitle').textContent = c.title;
  priceLabel = fiat(c.amountUsd, c.currency);
  offerAmount = c.amountUsd;
  offerCurrency = c.currency;
  $('#coAmount').textContent = priceLabel;

  const desc = $('#coDesc');
  if (c.description) {
    desc.textContent = c.description;
    desc.hidden = false;
  } else {
    desc.hidden = true;
  }

  const img = $<HTMLImageElement>('#coImage');
  if (c.imageUrl) {
    img.src = c.imageUrl;
    img.alt = c.title;
    img.hidden = false;
    img.addEventListener('error', () => (img.hidden = true), { once: true });
  } else {
    img.hidden = true;
  }

  $('#coPayLabel').textContent = `Pay ${priceLabel}`;
  show('offer');
}

/* ── fulfillment rendering (DOM-built; server values reach the DOM via
   textContent / a sanitized link only) ── */
function renderFulfillment(kind: 'url' | 'message' | 'none', value: string | null): void {
  const slot = $('#coFulfillment');
  slot.textContent = '';

  if (kind === 'url' && value) {
    let safe: URL | null;
    try {
      safe = new URL(value);
    } catch {
      safe = null;
    }
    if (safe && (safe.protocol === 'https:' || safe.protocol === 'http:')) {
      const a = document.createElement('a');
      a.className = 'co-fulfill-link';
      a.href = safe.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open your purchase';
      slot.appendChild(a);
      return;
    }
    // Non-http(s) value — show as plain text rather than a clickable link.
    const p = document.createElement('p');
    p.className = 'co-fulfill-msg';
    p.textContent = value;
    slot.appendChild(p);
    return;
  }

  if (kind === 'message' && value) {
    const p = document.createElement('p');
    p.className = 'co-fulfill-msg';
    p.textContent = value;
    slot.appendChild(p);
    return;
  }

  const p = document.createElement('p');
  p.className = 'co-fulfill-msg';
  p.textContent = 'The seller will be in touch.';
  slot.appendChild(p);
}

/* ── auth state ── */

interface BuyerState {
  email: string;
  name: string;
  balUsd: number;
}

let buyer: BuyerState | null = null;
let challengeId: string | null = null;

/** Pull the balance from /auth/me. Returns null if the token is stale. */
async function loadBuyer(): Promise<BuyerState | null> {
  if (!getToken()) return null;
  try {
    const me = await nexaApi.me();
    return {
      email: me.user.email,
      name: me.user.name,
      balUsd: me.balance.balUsd,
    };
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 401) {
      // Stale token — clear it so the OTP form is rendered cleanly.
      setToken(null);
    }
    return null;
  }
}

/* ── render the right pay surface based on the auth state ── */

function renderPayForms(): void {
  const balanceForm = $<HTMLFormElement>('#coForm');
  const authForm = $<HTMLFormElement>('#coAuthForm');
  const otpForm = $<HTMLFormElement>('#coOtpForm');
  const altMethods = $('#coAltMethods');
  const altDivider = $('#coAltDivider');

  // Stack upgrades Phase 4 — alt methods (card / bank wire) render alongside
  // both the balance and auth surfaces so every buyer has a one-click card path.
  altMethods.hidden = false;
  altDivider.hidden = false;

  if (buyer) {
    balanceForm.hidden = false;
    authForm.hidden = true;
    otpForm.hidden = true;
    renderBalancePanel();
    return;
  }

  // Signed-out — render the auth form unless an OTP is already in flight.
  balanceForm.hidden = true;
  authForm.hidden = challengeId != null;
  otpForm.hidden = challengeId == null;
}

function renderBalancePanel(): void {
  if (!buyer) return;
  $('#coBalancePanel').hidden = false;
  $('#coBalanceNow').textContent = fiat(buyer.balUsd, offerCurrency);

  const after = buyer.balUsd - offerAmount;
  const afterRow = $('#coBalanceAfter');
  const next = $('#coBalanceNext');
  next.textContent = fiat(after, offerCurrency);
  afterRow.hidden = false;
  const short = after < 0;
  afterRow.classList.toggle('co-balance-short', short);
  $('#coLowBal').hidden = !short;
  $('#coTrust').hidden = short;
}

/* ── pay ── */
let paying = false;

async function pay(offerId: string): Promise<void> {
  if (paying || !buyer) return;
  paying = true;
  const btn = $<HTMLButtonElement>('#coPay');
  btn.disabled = true;
  btn.classList.add('co-pay-busy');
  $('#coPayLabel').textContent = 'Processing…';

  try {
    const res = await nexaApi.payCheckout(offerId, {
      buyerEmail: buyer.email,
      method: 'balance',
      idempotencyKey,
    });
    $('#coPaidLine').textContent = `${priceLabel} paid · from ${buyer.email}.`;
    renderFulfillment(res.fulfillment?.kind ?? 'none', res.fulfillment?.value ?? null);
    show('success');
  } catch (e) {
    btn.disabled = false;
    btn.classList.remove('co-pay-busy');
    $('#coPayLabel').textContent = `Pay ${priceLabel}`;
    paying = false;
    const msg =
      e instanceof ApiFailure && e.status === 404
        ? 'This checkout is no longer available.'
        : e instanceof ApiFailure && e.code === 'insufficient_funds'
        ? 'Not enough balance — please top up first.'
        : 'Payment could not be completed. Please try again.';
    if (e instanceof ApiFailure && e.status === 404) {
      showError(msg);
    } else {
      $('#coPayError')?.remove();
      const p = document.createElement('p');
      p.id = 'coPayError';
      p.className = 'co-pay-error';
      p.textContent = msg;
      $('#coForm').appendChild(p);
    }
  }
}

/* ── inline OTP ── */

async function startAuth(): Promise<void> {
  const email = $<HTMLInputElement>('#coAuthEmail').value.trim();
  if (!email) return;
  const btn = $<HTMLButtonElement>('#coAuthStart');
  btn.disabled = true;
  $('#coAuthStartLabel').textContent = 'Sending…';
  try {
    const r = await nexaApi.authStart(email);
    challengeId = r.challengeId;
    renderPayForms();
    $<HTMLInputElement>('#coOtpCode').focus();
  } catch {
    btn.disabled = false;
    $('#coAuthStartLabel').textContent = 'Continue';
  }
}

async function verifyAuth(): Promise<void> {
  if (!challengeId) return;
  const code = $<HTMLInputElement>('#coOtpCode').value.trim();
  if (!/^\d{6}$/.test(code)) return;
  const btn = $<HTMLButtonElement>('#coOtpVerify');
  btn.disabled = true;
  $('#coOtpVerifyLabel').textContent = 'Verifying…';
  try {
    const r = await nexaApi.authVerify(challengeId, code);
    setToken(r.token);
    challengeId = null;
    buyer = await loadBuyer();
    renderPayForms();
  } catch {
    btn.disabled = false;
    $('#coOtpVerifyLabel').textContent = 'Verify';
  }
}

/* ── Stack upgrades Phase 4: card + bank wire methods ── */

let cardBusy = false;
async function payWithCard(offerId: string): Promise<void> {
  if (cardBusy) return;
  const email = ($<HTMLInputElement>('#coCardEmail').value || buyer?.email || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    showAltError('Email is required for card checkout.');
    return;
  }
  cardBusy = true;
  const btn = $<HTMLButtonElement>('#coPayCard');
  btn.disabled = true;
  $('#coPayCardLabel').textContent = 'Redirecting…';
  try {
    const res = await nexaApi.payCheckout(offerId, {
      method: 'card',
      buyerEmail: email,
      idempotencyKey,
    });
    if (!res.redirectUrl) {
      throw new Error('redirect_url_missing');
    }
    // F097 Sprint 18 — domain allowlist for the Stripe / demo redirect. The
    // URL comes from our own server, but a misconfigured STRIPE_SUCCESS_URL
    // or future code path that synthesises the URL from buyer input would
    // open a redirect-to-attacker hole. Validating here keeps the trust
    // boundary at the client edge:
    //   - https://checkout.stripe.com  — Stripe Checkout proper
    //   - https://*.stripe.com         — Stripe redirect chain (e.g.
    //                                    pay.stripe.com, link.stripe.com)
    //   - same-origin                  — demo `cs_demo_*` success page
    let target: URL;
    try {
      target = new URL(res.redirectUrl, window.location.origin);
    } catch {
      throw new Error('redirect_url_malformed');
    }
    const sameOrigin = target.origin === window.location.origin;
    const stripeHost =
      target.protocol === 'https:' &&
      (target.hostname === 'checkout.stripe.com' || target.hostname.endsWith('.stripe.com'));
    if (!sameOrigin && !stripeHost) {
      throw new Error('redirect_url_untrusted');
    }
    window.location.href = target.toString();
  } catch {
    btn.disabled = false;
    $('#coPayCardLabel').textContent = 'Pay with card or Apple Pay';
    cardBusy = false;
    showAltError('Could not start card checkout. Please try again.');
  }
}

let bankBusy = false;
async function revealBankInstructions(offerId: string): Promise<void> {
  if (bankBusy) return;
  const email = ($<HTMLInputElement>('#coBankEmail').value || buyer?.email || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    showAltError('Email is required for bank transfer.');
    return;
  }
  bankBusy = true;
  const btn = $<HTMLButtonElement>('#coBankReveal');
  btn.disabled = true;
  $('#coBankRevealLabel').textContent = 'Loading…';
  try {
    const res = await nexaApi.payCheckout(offerId, {
      method: 'bank_topup',
      buyerEmail: email,
    });
    $('#coBankName').textContent = res.bankName ?? 'Lead Bank';
    $('#coBankRouting').textContent = res.routingNumber ?? '—';
    $('#coBankAccount').textContent = res.accountNumber ?? '—';
    $('#coBankAmount').textContent = fiat(res.amountUsd ?? offerAmount, offerCurrency);
    if (res.note) $('#coBankNote').textContent = res.note;
    $('#coBankInstructions').hidden = false;
    $('#coBankRevealLabel').textContent = 'Instructions shown';
  } catch {
    btn.disabled = false;
    $('#coBankRevealLabel').textContent = 'Show wire instructions';
    showAltError('Could not provision a wire account. Please try card or balance pay.');
  } finally {
    bankBusy = false;
  }
}

function showAltError(msg: string): void {
  $('#coPayError')?.remove();
  const p = document.createElement('p');
  p.id = 'coPayError';
  p.className = 'co-pay-error';
  p.textContent = msg;
  $('#coAltMethods').appendChild(p);
}

/* ── Stack upgrades Phase 4: return page polling ── */

function isReturnPage(): { sessionId: string; buyerEmail: string } | null {
  const q = new URLSearchParams(location.search);
  const session = q.get('session');
  if (!session) return null;
  // Sprint 13 COMMIT 5 (SR1) — the demo redirect carries `?buyer=` and the
  // Stripe successUrl is configured to substitute `{CUSTOMER_EMAIL}` so the
  // return-page poll has the auth-gate value. Fall back to empty string for
  // pre-update sessions; status endpoint returns 400, page shows error.
  const buyerEmail = q.get('buyer') ?? '';
  return { sessionId: session, buyerEmail };
}

async function pollReturnPage(sessionId: string, buyerEmail: string): Promise<void> {
  show('loading');
  document.title = 'Processing payment · MAZE';
  const deadline = Date.now() + 60_000; // hard stop at one minute
  while (Date.now() < deadline) {
    try {
      const status = await nexaApi.checkoutSessionStatus(sessionId, buyerEmail);
      if (status.status === 'completed') {
        priceLabel = '$' + status.amountUsd.toFixed(2);
        $('#coPaidLine').textContent = `${priceLabel} paid · receipt sent by email.`;
        renderFulfillment('none', null);
        show('success');
        return;
      }
      if (status.status === 'failed' || status.status === 'expired') {
        showError('Payment did not complete. Please try again.');
        return;
      }
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) {
        showError('Could not find this payment. Please try again.');
        return;
      }
      // network blip — keep polling until deadline
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  showError('Still waiting on confirmation — please refresh in a minute.');
}

/* ── boot ── */
async function boot(): Promise<void> {
  // Stripe return page short-circuit — no offer id, just a session token.
  const ret = isReturnPage();
  if (ret && !resolveOfferId()) {
    await pollReturnPage(ret.sessionId, ret.buyerEmail);
    return;
  }

  const offerId = resolveOfferId();
  if (!offerId) {
    showError('No checkout was specified.');
    return;
  }

  $('#coForm').addEventListener('submit', (e) => {
    e.preventDefault();
    void pay(offerId);
  });
  $('#coAuthForm').addEventListener('submit', (e) => {
    e.preventDefault();
    void startAuth();
  });
  $('#coOtpForm').addEventListener('submit', (e) => {
    e.preventDefault();
    void verifyAuth();
  });
  $('#coTopupLink').addEventListener('click', (e) => {
    e.preventDefault();
    // Hosted top-up lives in the app shell; deep-link to it for the
    // signed-in MAZE balance flow.
    window.open('/app.html', '_blank');
  });
  $('#coPayCard').addEventListener('click', (e) => {
    e.preventDefault();
    void payWithCard(offerId);
  });
  $('#coBankReveal').addEventListener('click', (e) => {
    e.preventDefault();
    void revealBankInstructions(offerId);
  });

  buyer = await loadBuyer();

  try {
    const { checkout } = await nexaApi.getCheckout(offerId);
    if (!checkout.active) {
      showError('The seller has paused this checkout.');
      return;
    }
    renderOffer(checkout);
    renderPayForms();
    // Pre-fill the card/bank email if the buyer is signed in.
    if (buyer) {
      ($<HTMLInputElement>('#coCardEmail')).value = buyer.email;
      ($<HTMLInputElement>('#coBankEmail')).value = buyer.email;
    }
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404) {
      showError();
    } else {
      showError('Could not load this checkout. Please try again.');
    }
  }
}

void boot();

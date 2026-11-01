/**
 * Get-paid loop — seller creates a hosted checkout, a buyer signs in inline
 * and pays from their MAZE balance. Sprint 10 Item G refactor: the legacy
 * sandbox card form is gone (no input[name=cvc] / cardnumber) — humans pay
 * via x402/MAZE balance just like agents.
 *
 *   1. Onboard the seller account → bind the app to the server ledger.
 *   2. Open the "New offer" surface, create "Priority queue" @ $9.99.
 *   3. Open /checkout.html?id=<id> as a signed-out buyer → assert no card
 *      inputs, see the inline OTP form, complete it (demo OTP 482019).
 *   4. Confirm the balance panel renders, click pay, receipt shows.
 *   5. The seller's Home feed shows the "Sale ·" credit (via SSE; the server
 *      ledger is asserted as the source of truth in case SSE lags).
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`;
const OFFER_TITLE = 'Priority queue';

async function demoSessionToken(request: APIRequestContext, email: string): Promise<string> {
  const start = await request.post(`${API}/auth/start`, { data: { email } });
  expect(start.ok()).toBe(true);
  const startBody = (await start.json()) as { challengeId: string };
  const verify = await request.post(`${API}/auth/verify`, {
    data: { challengeId: startBody.challengeId, code: '482019' },
  });
  expect(verify.ok()).toBe(true);
  const verifyBody = (await verify.json()) as { token: string };
  return verifyBody.token;
}

async function bootSignedInApp(page: Page, token: string): Promise<string> {
  await page.addInitScript((sessionToken) => {
    sessionStorage.setItem('nexa.session', sessionToken);
  }, token);
  await page.goto('/app.html?motion=off#s08');
  await expect(page.locator('#s08')).toHaveClass(/\bon\b/);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('nexa.session')))
    .not.toBe(token);
  return (await page.evaluate(() => sessionStorage.getItem('nexa.session'))) ?? '';
}

test('get-paid loop: new offer → hosted checkout → inline OTP → balance pay → sale in feed', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(60_000);

  // Isolated identities per project — never live-mode.spec's mirko@studio.co,
  // so this test's sale credit can't race that balance assertion.
  const sellerEmail = `seller-${test.info().project.name}@maze.test`;
  const buyerEmail = `buyer-${test.info().project.name}@maze.test`;

  // ── 1. onboard the seller account (binds the app to the server ledger)
  const initialToken = await demoSessionToken(request, sellerEmail);
  expect(initialToken).toBeTruthy();
  const token = await bootSignedInApp(page, initialToken);

  // ── 2. create an offer via the seller surface (LIVE-only CTA must be visible)
  const cta = page.locator('[data-act="new-offer"]');
  await expect(cta).toBeVisible({ timeout: 8000 });
  await cta.click();
  await page.locator('#offer-title').fill(OFFER_TITLE);
  await page.locator('#offer-amount').fill('9.99');
  await page.locator('[data-act="offer-create"]').click();

  const offerLink = page.locator('[data-offer-link]');
  await expect(offerLink).toBeVisible({ timeout: 8000 });
  await expect(offerLink).toHaveAttribute('data-offer-id', /.+/);
  const offerId = await offerLink.getAttribute('data-offer-id');
  expect(offerId).toBeTruthy();
  await expect(offerLink).toContainText('checkout.html');

  // ── 3. buyer opens the hosted checkout signed-out
  const buyer = await context.newPage();
  await buyer.goto(`/checkout.html?id=${offerId}&motion=off`);
  await expect(buyer.locator('[data-testid=checkout-title]')).toHaveText(OFFER_TITLE, {
    timeout: 8000,
  });
  await expect(buyer.locator('[data-testid=checkout-amount]')).toContainText('9.99');

  // Sprint 10 Item G — the demo card form is gone. Assert no card inputs
  // anywhere on the page (the api never accepts them again).
  expect(await buyer.locator('input[name="cvc"]').count()).toBe(0);
  expect(await buyer.locator('input[name="cardnumber"]').count()).toBe(0);
  expect(await buyer.locator('input[autocomplete="cc-number"]').count()).toBe(0);

  // The inline auth form is visible. The buyer enters their email + OTP.
  await buyer.locator('#coAuthEmail').fill(buyerEmail);
  await buyer.locator('[data-testid=checkout-auth-start]').click();
  await buyer.locator('[data-testid=checkout-otp-code]').fill('482019');
  await buyer.locator('[data-testid=checkout-otp-verify]').click();

  // ── 4. balance panel renders, click pay, receipt shows
  await expect(buyer.locator('#coBalancePanel')).toBeVisible({ timeout: 8000 });
  await buyer.locator('[data-testid=checkout-pay]').click();
  await expect(buyer.locator('[data-testid=checkout-success]')).toBeVisible({ timeout: 8000 });
  await expect(buyer.locator('[data-testid=checkout-fulfillment]')).toBeVisible();
  await buyer.close();

  // ── 5. the sale is recorded server-side (source of truth) …
  await expect
    .poll(
      async () => {
        try {
          const r = await request.get(`${API}/ledger/activity`, {
            headers: { authorization: `Bearer ${token}` },
          });
          if (!r.ok()) return false;
          const body = await r.json();
          const rows: Array<{ n: string }> = body.activity ?? [];
          return rows.some((row) => row.n === `Sale · ${OFFER_TITLE}`);
        } catch {
          return false;
        }
      },
      { timeout: 12_000 },
    )
    .toBe(true);

  // … and lands in the seller's Home activity feed (SSE → syncFromServer).
  await expect(page.locator('#actList .tx-row', { hasText: `Sale · ${OFFER_TITLE}` }).first())
    .toBeVisible({ timeout: 15_000 });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Stack upgrades Phase 4 — multi-method hosted checkout. A signed-out buyer
 * lands on /checkout.html and sees THREE payment paths render alongside the
 * inline OTP: balance pay (gated behind sign-in), card/Apple Pay, and a
 * bank-transfer fold. We exercise the card and bank-transfer fold here; the
 * balance-pay e2e remains the test above.
 *
 * No STRIPE_SECRET_KEY in the env → /pay { method:'card' } returns the
 * synthetic cs_demo_* redirect path, which our checkout-main.ts honors. We
 * intercept the demo redirect so the test doesn't actually navigate away.
 * ────────────────────────────────────────────────────────────────────────── */
test('multi-method checkout: card path returns a Stripe redirect, bank fold reveals wire instructions', async ({
  context,
  request,
}) => {
  test.setTimeout(45_000);

  const sellerEmail = `seller-multi-${test.info().project.name}@maze.test`;
  const buyerEmail = `buyer-multi-${test.info().project.name}@maze.test`;

  const sellerTok = await demoSessionToken(request, sellerEmail);

  const created = await request.post(`${API}/offers`, {
    headers: { authorization: `Bearer ${sellerTok}` },
    data: { title: 'Multi-method offer', amountUsd: 9.99 },
  });
  const createdBody = await created.json();
  const offerId = createdBody.offer.id as string;

  // Open the hosted checkout as a signed-out buyer.
  const buyer = await context.newPage();
  await buyer.goto(`/checkout.html?id=${offerId}&motion=off`);
  await expect(buyer.locator('[data-testid=checkout-title]')).toHaveText('Multi-method offer', {
    timeout: 8000,
  });

  // The alt-methods block renders with a card + bank panel.
  await expect(buyer.locator('[data-testid=checkout-pay-card]')).toBeVisible({ timeout: 8000 });
  await expect(buyer.locator('[data-testid=checkout-bank-summary]')).toBeVisible();

  // Card path: fill the email + click pay → intercept the navigation to the
  // demo success URL. The demo redirect lands back on /checkout.html with
  // ?session=cs_demo_* and triggers return-page polling.
  await buyer.locator('#coCardEmail').fill(buyerEmail);

  const navPromise = buyer
    .waitForURL((url) => /session=cs_demo_/.test(url.toString()), { timeout: 8000 })
    .catch(() => null);
  await buyer.locator('[data-testid=checkout-pay-card]').click();
  await navPromise;
  expect(buyer.url()).toContain('mode=demo');
  expect(buyer.url()).toMatch(/session=cs_demo_/);
  await buyer.close();

  // Bank-transfer fold: a second buyer page opens the bank panel and reveals
  // the wire instructions. Bridge is disabled in CI → demo numbers come back.
  const bank = await context.newPage();
  await bank.goto(`/checkout.html?id=${offerId}&motion=off`);
  await expect(bank.locator('[data-testid=checkout-bank-summary]')).toBeVisible({ timeout: 8000 });
  await bank.locator('[data-testid=checkout-bank-summary]').click();
  await bank.locator('#coBankEmail').fill(buyerEmail);
  await bank.locator('[data-testid=checkout-bank-reveal]').click();
  await expect(bank.locator('[data-testid=checkout-bank-instructions]')).toBeVisible({
    timeout: 8000,
  });
  await expect(bank.locator('[data-testid=checkout-bank-routing]')).not.toHaveText('—');
  await expect(bank.locator('[data-testid=checkout-bank-account]')).not.toHaveText('—');
  await bank.close();
});

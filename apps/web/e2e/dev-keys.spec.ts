/**
 * Developer surface — in-app API-key management. LIVE mode (app talking to the
 * API), mirroring checkout.spec.ts: demo email login with OTP 482019, ?motion=off.
 *
 *   1. Onboard the demo account → app binds to the server ledger
 *   2. Open Profile → Developers, mint a TEST key, read the one-time secret
 *   3. The secret authenticates the PUBLIC /v1 routes (offers + balance, sandbox)
 *   4. The masked key shows in the list (last4, never the full secret)
 *   5. Revoke it → the same key can no longer call /v1 (401)
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`;

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

async function bootSignedInApp(page: Page, token: string): Promise<void> {
  await page.addInitScript((sessionToken) => {
    sessionStorage.setItem('nexa.session', sessionToken);
  }, token);
  await page.goto('/app.html?motion=off#s08');
  await expect(page.locator('#s08')).toHaveClass(/\bon\b/);
}

test('developer keys: mint test key → call /v1 → revoke → key rejected', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  // Isolated developer per project — never collides with checkout.spec.ts's
  // seller or live-mode.spec.ts on the shared in-memory API.
  const devEmail = `dev-${test.info().project.name}@maze.test`;

  // Force the onboarding auth-start race this test exposed under parallel
  // mobile load: a fast OTP click must still verify after challenge creation.
  // ── 1. onboard (binds the app to the server ledger → LIVE mode)
  const token = await demoSessionToken(request, devEmail);
  await bootSignedInApp(page, token);

  // ── 2. open Profile → Developers (LIVE-only entry must be visible)
  const moreTab = page.locator('#tabbar [data-tabgo="more"]');
  if (await moreTab.count()) {
    await moreTab.click();
  } else {
    await page.locator('#s08 [aria-label="More"]').click();
  }
  await page.locator('#moreProfile').click();
  const devEntry = page.locator('[data-act="dev-keys"]');
  await expect(devEntry).toBeVisible({ timeout: 8000 });
  await devEntry.click();
  await expect(page.locator('#keysSheet')).toHaveClass(/\bon\b/);

  // mint a TEST key — the secret is revealed exactly once
  await page.locator('[data-act="key-create-test"]').click();
  const secretEl = page.locator('[data-key-secret-value]');
  await expect(page.locator('[data-key-secret]')).toBeVisible({ timeout: 8000 });
  const secret = (await secretEl.textContent())?.trim() ?? '';
  expect(secret).toMatch(/^sk_test_/);

  // ── 3. the secret authenticates the PUBLIC /v1 routes (sandbox / test mode)
  const offerRes = await request.post(`${API}/v1/offers`, {
    headers: { authorization: `Bearer ${secret}` },
    data: { title: 'API offer', amountUsd: 12 },
  });
  expect(offerRes.status()).toBe(201);
  const offer = await offerRes.json();
  expect(offer.checkoutUrl).toBeTruthy();
  expect(offer.livemode).toBe(false);

  const balRes = await request.get(`${API}/v1/balance`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(balRes.status()).toBe(200);
  const bal = await balRes.json();
  expect(bal.livemode).toBe(false);

  // ── 4. the masked key appears in the list — last4 shown, secret never is
  const last4 = secret.slice(-4);
  const keyRow = page.locator('[data-keys-list] .key-row', { hasText: last4 });
  await expect(keyRow).toBeVisible({ timeout: 8000 });
  await expect(keyRow).toContainText('TEST');
  await expect(page.locator('[data-keys-list]')).not.toContainText(secret);

  // ── 5. revoke → the same key can no longer call /v1
  await keyRow.locator('[data-act="key-revoke"]').click();
  await expect
    .poll(
      async () => {
        const r = await request.post(`${API}/v1/offers`, {
          headers: { authorization: `Bearer ${secret}` },
          data: { title: 'API offer', amountUsd: 12 },
        });
        return r.status();
      },
      { timeout: 8000 },
    )
    .toBe(401);
});

/**
 * LIVE-mode loop — app + API together. Proves the deployed story end-to-end:
 *
 *   1. Email OTP login binds the app to the server ledger
 *   2. A send mutates the SERVER balance (verified via /auth/me)
 *   3. An MCP agent payment (Claude's path) lands in the app's activity feed
 *      through SSE without any user interaction
 *   4. The x402 policy gate rejects an over-cap payment with 402
 *
 * Uses project-scoped demo accounts/agent keys so mobile and desktop runs can
 * execute in parallel without racing the same ledger. Assertions are
 * delta-based — the API dev server may carry state across local runs.
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`;

async function demoSessionToken(
  request: APIRequestContext,
  email: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const start = await request.post(`${API}/auth/start`, { headers, data: { email } });
  expect(start.ok()).toBe(true);
  const startBody = (await start.json()) as { challengeId: string };
  const verify = await request.post(`${API}/auth/verify`, {
    headers,
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

const scenarios: Record<string, { email: string; key: string }> = {
  'chromium-mobile': {
    email: 'live-mode-chromium-mobile@maze.test',
    key: 'nx_live_e2e_mobile',
  },
  'chromium-desktop': {
    email: 'live-mode-chromium-desktop@maze.test',
    key: 'nx_live_e2e_desktop',
  },
};

function parseMoney(text: string | null): number {
  return parseFloat((text ?? '').replace(/[$,]/g, '')) || 0;
}

test('live loop: login → send → server ledger → MCP payment → SSE feed', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const scenario = scenarios[test.info().project.name] ?? {
    email: 'mirko@studio.co',
    key: 'nx_live_7f3k_demo',
  };
  const forwardedFor = test.info().project.name === 'chromium-desktop' ? '10.42.0.2' : '10.42.0.1';
  await page.route('**/auth/**', async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), 'x-forwarded-for': forwardedFor },
    });
  });

  // ── 1. onboard with the project-scoped email (binds to the MCP key's account)
  const initialToken = await demoSessionToken(request, scenario.email, { 'x-forwarded-for': forwardedFor });

  // session token lands async — poll for it
  expect(initialToken).toBeTruthy();

  // ── 2. through KYC to home
  const token = await bootSignedInApp(page, initialToken);

  // server is the source of truth now
  const me0 = await request.get(`${API}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const bal0 = (await me0.json()).balance.balUsd as number;

  // ── 3. send $20 → server balance drops by exactly 20
  await page.locator('#s08 .qa', { hasText: 'Send' }).click();
  await page.locator('#kpad button', { hasText: /^2$/ }).click();
  await page.locator('#kpad button', { hasText: /^0$/ }).click();
  await page.locator('#amtGo').click();
  await page.locator('[data-recip="bob@x.com"][data-new]:not(#recipTyped)').click();
  await page.locator('#sendNow').click();
  await expect(page.locator('#cfDone')).toBeVisible();

  await expect
    .poll(
      async () => {
        const r = await request.get(`${API}/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return (await r.json()).balance.balUsd;
      },
      { timeout: 8000 },
    )
    .toBeCloseTo(bal0 - 20, 1);

  // app header reflects the server number after sync
  await page.getByRole('button', { name: 'Done' }).click();
  await expect
    .poll(async () => parseMoney(await page.locator('#balEl').textContent()), { timeout: 8000 })
    .toBeCloseTo(bal0 - 20, 1);

  // ── 4. MCP agent payment (Claude's path) → appears in the feed via SSE
  const mcpHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-nexa-key': scenario.key,
  };
  const pay = await request.post(`${API}/mcp`, {
    headers: mcpHeaders,
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'pay_endpoint',
        arguments: {
          agent: 'ResearchBot-01',
          endpoint: 'weather.api/v1/daily',
          amountUsd: 0.002,
          reason: 'forecast pull',
        },
      },
    },
  });
  expect(pay.status()).toBe(200);
  const payBody = await pay.json();
  expect(payBody.result.content[0].text).toContain('200 OK');

  // the human watches it land — no reload, no tap
  await expect(page.locator('#actList .tx-row').first()).toContainText('Paid weather.api', {
    timeout: 15_000,
  });

  // ── 5. policy gate over REST: above human-approval threshold → 402
  // Stack upgrades Phase 3 — `humanApprovalThresholdUsd` now fires before the
  // per-tx-cap check, so 2.4 > threshold(1) maps to `needs_human_approval`.
  const blocked = await request.post(`${API}/x402/pay`, {
    headers: { 'content-type': 'application/json', 'x-nexa-key': scenario.key },
    data: {
      agent: 'ResearchBot-01',
      endpoint: 'api.exa.ai/v1/search',
      amountUsd: 2.4,
      reason: 'dataset access',
    },
  });
  expect(blocked.status()).toBe(402);
  expect((await blocked.json()).error.code).toBe('needs_human_approval');
});

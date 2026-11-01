/**
 * Lane C — Polymarket top traders + one-tap Copy:
 *  - The Predictions tab renders the leaderboard strip (rank, name, PnL,
 *    dot-mark avatar) from GET /markets/polymarket/leaderboard.
 *  - Copy fetches the trader's copy-intent, opens the PM order sheet
 *    prefilled with the copied outcome, live price, and suggested size,
 *    and the placed order carries copiedFrom attribution.
 */

import { expect, test, type Page } from '@playwright/test';

const API = `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`;
const APP = '/app.html?motion=off';
const TRADER = '0x1111111111111111111111111111111111111111';

async function bootLiveAt(page: Page, screen: string, email: string): Promise<void> {
  const start = await page.context().request.post(`${API}/auth/start`, { data: { email } });
  const { challengeId } = (await start.json()) as { challengeId: string };
  const verify = await page.context().request.post(`${API}/auth/verify`, {
    data: { challengeId, code: '482019' },
  });
  const { token } = (await verify.json()) as { token: string };
  await page.addInitScript((t) => {
    try {
      sessionStorage.setItem('nexa.session', t);
      sessionStorage.removeItem('nexa.localDemoLedger');
      localStorage.setItem('maze.region', 'NL');
    } catch {
      /* ignore */
    }
  }, token);
  // Deterministic LIVE flip: tryResumeSession awaits /auth/me before setting
  // LIVE=true (which unlocks trade CTAs). Mock it like markets-and-perks does
  // and wait for the response so Copy never races the session resume.
  const me = {
    ok: true,
    user: { id: 'u-copy', email, name: 'Copy Tester' },
    balance: { balUsd: 4820.4, earnUsd: 0, earnApy: 0 },
    earnConfig: { earnByDefault: false, autoDivestOnSpend: false, divestThresholdUsd: 50 },
  };
  await page.route(/\/(?:api\/)?auth\/me(?:\?|$)/, async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(me) }));
  await page.route(/\/(?:api\/)?ledger\/activity(?:\?|$)/, async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activity: [] }) }));
  await page.route(/\/(?:api\/)?ledger\/me(?:\?|$)/, async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...me, virtualAccounts: {}, card: null, earn: { apyBps: 0, posUsd: 0 } }),
    }));
  const meSeen = page.waitForResponse(/\/(?:api\/)?auth\/me(?:\?|$)/, { timeout: 15_000 });
  await page.goto(`${APP}#${screen}`);
  await page.waitForSelector('.scr.on');
  await meSeen;
  await page.waitForTimeout(250);
}

async function mockLaneC(page: Page): Promise<void> {
  await page.route(/\/markets\/polymarket\/leaderboard(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'polymarket',
        traders: [
          { wallet: TRADER, name: 'orangewhale', pnl: 329619.99, realizedPnl: 0, value: 760749.16, positions: 23, winRate: 0.3913 },
          { wallet: '0x2222222222222222222222222222222222222222', name: null, pnl: -4210.5, realizedPnl: 120, value: 90000, positions: 41, winRate: 0.61 },
        ],
      }),
    });
  });
  await page.route(new RegExp(`/markets/polymarket/traders/${TRADER}/copy-intent`), async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'polymarket',
        intent: {
          wallet: TRADER,
          marketId: '30615',
          outcome: 'Yes',
          outcomeIndex: 0,
          title: 'Will France win the 2026 FIFA World Cup?',
          slug: 'france-2026',
          icon: null,
          currentValueUsd: 5000,
          suggestedQtyUsd: 25,
          entryPriceCents: 18,
          currentPriceCents: 22,
          pnlUsd: 1234.5,
          endDate: null,
        },
      }),
    });
  });
}

test('predictions tab renders the top-traders strip', async ({ page }, testInfo) => {
  await mockLaneC(page);
  await bootLiveAt(page, 's27', `pm-copy-strip-${testInfo.project.name}@maze.test`);
  await page.click('[data-trade-venue="predictions"]');

  const strip = page.locator('#pmTradersStrip');
  await expect(strip.locator('.pm-trader-card')).toHaveCount(2);
  const first = strip.locator('.pm-trader-card').first();
  await expect(first.locator('.nm')).toHaveText('orangewhale');
  await expect(first.locator('.rk')).toHaveText('#1');
  await expect(first.locator('.pnl')).toContainText('+$329');
  expect(await first.locator('.avatar circle').count()).toBeGreaterThanOrEqual(8);
  // Anonymous wallet falls back to a shortened address.
  await expect(strip.locator('.pm-trader-card').nth(1).locator('.nm')).toContainText('0x2222');
});

test('one-tap Copy prefills the sheet and the order carries copiedFrom', async ({ page }, testInfo) => {
  await mockLaneC(page);
  let orderBody: Record<string, unknown> | null = null;
  await page.route(/\/markets\/polymarket\/order$/, async (route) => {
    orderBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        order: { orderId: 'copy-1', demo: true },
        position: {
          id: 'pos-copy-1',
          venue: 'polymarket',
          status: 'open',
          marketId: '30615',
          title: 'Will France win the 2026 FIFA World Cup?',
          sideLong: true,
          qtyUsd: 25,
          createdAt: new Date(0).toISOString(),
        },
      }),
    });
  });
  await bootLiveAt(page, 's27', `pm-copy-order-${testInfo.project.name}@maze.test`);
  await page.click('[data-trade-venue="predictions"]');

  await page.click(`[data-copy-trader="${TRADER}"]`);
  await expect(page.locator('#pmOrderSheet')).toHaveClass(/on/);
  await expect(page.locator('#pmOrderQuestion')).toHaveText('Will France win the 2026 FIFA World Cup?');
  await expect(page.locator('#pmQty')).toHaveValue('25');
  await expect(page.locator('#pmPrice')).toHaveValue('22');

  await page.click('#pmPlaceOrderBtn');
  await expect
    .poll(() => orderBody, { timeout: 10_000 })
    .toMatchObject({ marketId: '30615', outcome: 'Yes', priceCents: 22, qtyUsd: 25, copiedFrom: TRADER });
});

/**
 * PLANB fluid-UI W1 — list-engine contract:
 *  - "Show all" expansion of a 200-row Hyperliquid list is fast (generous CI
 *    bound; the real budget lives in docs/PLANB_FLUID_UI_SYSTEM.md) and
 *    REUSES the first-page row elements (keyed reconcile, no host rebuild).
 *  - Market lists render skeleton rows while the first hydrate is in flight,
 *    not a premature "Couldn't load" state.
 *  - A five-screen walk produces zero application console errors (network
 *    noise from the e2e sandbox — blocked sockets, 404 logos — is excluded).
 *
 * Runs with ?motion=off like the rest of the suite.
 */

import { expect, test, type Page } from '@playwright/test';

const APP = '/app.html?motion=off';

function hlMarketsBody(count: number): string {
  const markets = Array.from({ length: count }, (_, i) => ({
    coin: `C${String(i).padStart(3, '0')}`,
    priceUsd: 100 + i,
    change24hPct: (i % 7) - 3,
    maxLeverage: 20,
    dayVolumeUsd: 1_000_000 + i * 1_000,
    openInterest: 1_000 + i,
    fundingRate: 0.0001,
  }));
  return JSON.stringify({ ok: true, source: 'demo', markets });
}

/** Everything the trade tab hydrates, mocked empty-but-ok; the Hyperliquid
    list route is layered on top by each test (Playwright matches routes in
    reverse registration order). */
async function mockQuietMarkets(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'demo',
        markets: [],
        tokens: [],
        stocks: [],
        items: [],
        events: [],
      }),
    });
  });
  await page.route('https://gamma-api.polymarket.com/events?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.route('https://api.hyperliquid.xyz/info', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: '[{},[]]' });
  });
}

async function bootAt(page: Page, screen?: string): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('nexa.localDemoLedger', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto(screen ? `${APP}#${screen}` : APP);
  await page.waitForSelector('.scr.on');
}

test('Show-all expands 200 rows fast and reuses first-page row elements', async ({ page }) => {
  await mockQuietMarkets(page);
  await page.route(/\/markets\/hyperliquid(?:\?|$)/, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: hlMarketsBody(200) });
  });
  await bootAt(page, 's27');

  const host = page.locator('#hlMarketsList');
  await expect(host.locator('nexa-market-row')).toHaveCount(12);
  await expect(host.locator('.market-show-all')).toHaveText(/Show all 200/);

  const firstRow = await host.locator('nexa-market-row').first().elementHandle();
  expect(firstRow).not.toBeNull();

  const result = await page.evaluate(async () => {
    const listHost = document.querySelector('#hlMarketsList');
    const btn = listHost?.querySelector<HTMLButtonElement>('.market-show-all');
    if (!listHost || !btn) return { error: 'missing show-all' };
    const t0 = performance.now();
    btn.click();
    void (listHost as HTMLElement).offsetHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const elapsedMs = performance.now() - t0;
    return { elapsedMs, rows: listHost.querySelectorAll('nexa-market-row').length };
  });

  expect(result.rows).toBe(200);
  // Generous CI bound — desktop dev machines do this in well under 120ms;
  // the bound exists to catch a return to O(rebuild-everything).
  expect(result.elapsedMs).toBeLessThan(500);
  await expect(host.locator('.market-show-all')).toHaveCount(0);

  // Keyed reconcile reuses the already-rendered first page: the pre-click
  // first row element is still connected and still first in the host.
  const reused = await firstRow!.evaluate((el) => {
    const parent = el.parentElement;
    return Boolean(el.isConnected && parent && parent.id === 'hlMarketsList' && parent.firstElementChild === el);
  });
  expect(reused).toBe(true);
});

test('market lists skeleton while the first hydrate is in flight', async ({ page }) => {
  await mockQuietMarkets(page);
  await page.route(/\/markets\/hyperliquid(?:\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.fulfill({ contentType: 'application/json', body: hlMarketsBody(3) });
  });
  await bootAt(page, 's27');

  const host = page.locator('#hlMarketsList');
  await expect(host.locator('.skel-row').first()).toBeVisible();
  await expect(host.locator('nexa-market-row')).toHaveCount(3, { timeout: 5_000 });
  await expect(host.locator('.skel-row')).toHaveCount(0);
});

test('five-screen walk logs zero application console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Sandbox network noise, not app defects: blocked sockets + mock 404s.
    if (/WebSocket|Failed to load resource|net::|ERR_|blob:/i.test(text)) return;
    errors.push(text.slice(0, 300));
  });
  await mockQuietMarkets(page);
  await page.route(/\/markets\/hyperliquid(?:\?|$)/, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: hlMarketsBody(20) });
  });
  await bootAt(page, 's08');
  for (const screen of ['s27', 's14', 's25', 's29', 's08']) {
    await page.evaluate((id) => {
      location.hash = `#${id}`;
    }, screen);
    await page.waitForSelector(`#${screen}.scr.on`);
    await page.waitForTimeout(250);
  }
  expect(errors).toEqual([]);
});

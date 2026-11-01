/**
 * Visual screenshot of the Earn-landing card for the user. Lives in e2e/ so
 * Playwright's webServer auto-starts the api + web for us. Not part of the
 * regular test suite — invoke explicitly with `--grep "landing screenshot"`.
 */
import { expect, test, type Page } from '@playwright/test';

const APP = '/app.html?motion=off';

async function bootAt(page: Page, screen?: string): Promise<void> {
  await page.addInitScript(() => {
    try { sessionStorage.setItem('nexa.localDemoLedger', '1'); } catch { /* ignore */ }
  });
  await page.goto(screen ? `${APP}#${screen}` : APP);
  await page.waitForSelector('.scr.on');
}

test('landing screenshot — best yields card on Earn screen', async ({ page }) => {
  // Mock /earn/landing with a realistic snapshot so the screenshot is
  // populated even if the dev server can't reach DefiLlama in this run.
  await page.route(/\/earn\/landing(\?|$)/, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        cached: false,
        landscape: [
          {
            asset: 'USDC',
            bestApyBps: 701,
            readAt: new Date().toISOString(),
            picks: [
              { asset: 'USDC', venue: 'Fluid', chain: 'arbitrum', apyBps: 701, apyBaseBps: 432, apyRewardBps: 269, tvlUsd: 33_900_000, url: 'https://fluid.instadapp.io', mode: 'deeplink', riskBand: 'B' },
              { asset: 'USDC', venue: 'Aave V3', chain: 'ethereum', apyBps: 689, apyBaseBps: 312, apyRewardBps: 377, tvlUsd: 61_000_000, url: 'https://app.aave.com', mode: 'deeplink', riskBand: 'A' },
              { asset: 'USDC', venue: 'Morpho (Steakhouse)', chain: 'base', apyBps: 520, apyBaseBps: null, apyRewardBps: null, tvlUsd: null, url: null, mode: 'native', riskBand: 'B' },
            ],
          },
          {
            asset: 'USDT',
            bestApyBps: 620,
            readAt: new Date().toISOString(),
            picks: [
              { asset: 'USDT', venue: 'Aave V3', chain: 'ethereum', apyBps: 620, apyBaseBps: 207, apyRewardBps: 413, tvlUsd: 84_000_000, url: 'https://app.aave.com', mode: 'deeplink', riskBand: 'A' },
              { asset: 'USDT', venue: 'Jupiter Lend', chain: 'solana', apyBps: 363, apyBaseBps: null, apyRewardBps: null, tvlUsd: 17_900_000, url: 'https://jup.ag/lend/earn', mode: 'deeplink', riskBand: 'B' },
            ],
          },
          {
            asset: 'SOL',
            bestApyBps: 720,
            readAt: new Date().toISOString(),
            picks: [
              { asset: 'SOL', venue: 'Marinade', chain: 'solana', apyBps: 720, apyBaseBps: null, apyRewardBps: null, tvlUsd: null, url: null, mode: 'native', riskBand: 'A' },
              { asset: 'SOL', venue: 'Kamino Lend', chain: 'solana', apyBps: 487, apyBaseBps: null, apyRewardBps: null, tvlUsd: 21_400_000, url: 'https://app.kamino.finance', mode: 'deeplink', riskBand: 'B' },
            ],
          },
          {
            asset: 'BTC',
            bestApyBps: 14,
            readAt: new Date().toISOString(),
            picks: [
              { asset: 'BTC', venue: 'Fluid', chain: 'ethereum', apyBps: 14, apyBaseBps: 14, apyRewardBps: null, tvlUsd: 23_000_000, url: 'https://fluid.instadapp.io', mode: 'deeplink', riskBand: 'B' },
            ],
          },
          {
            asset: 'ETH',
            bestApyBps: 513,
            readAt: new Date().toISOString(),
            picks: [
              { asset: 'ETH', venue: 'Aave V3', chain: 'ethereum', apyBps: 513, apyBaseBps: 147, apyRewardBps: 366, tvlUsd: 13_000_000, url: 'https://app.aave.com', mode: 'deeplink', riskBand: 'A' },
            ],
          },
          {
            asset: 'sUSDe',
            bestApyBps: 1820,
            readAt: new Date().toISOString(),
            picks: [
              { asset: 'sUSDe', venue: 'Ethena', chain: 'ethereum', apyBps: 1820, apyBaseBps: null, apyRewardBps: null, tvlUsd: null, url: 'https://app.ethena.fi/buy', mode: 'deeplink', riskBand: 'B' },
            ],
          },
        ],
      }),
    });
  });

  // Mobile viewport — that's where the app's tuned.
  await page.setViewportSize({ width: 414, height: 900 });
  await bootAt(page, 's14');

  // Wait for the landing card to populate.
  await expect(page.locator('[data-earn-asset="USDC"]')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-earn-asset="sUSDe"]')).toBeVisible({ timeout: 5_000 });

  // Scroll to the landing card so the screenshot frames it.
  await page.locator('#earnLandingList').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  // Full screen first.
  await page.screenshot({ path: 'test-results/earn-landing-full.png', fullPage: true });
  // Just the landing card.
  const card = page.locator('#earnLandingList').locator('xpath=..');
  await card.screenshot({ path: 'test-results/earn-landing-card.png' });
});

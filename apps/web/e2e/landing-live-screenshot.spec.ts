/**
 * LIVE landing screenshot — no mock on /earn/landing so the page hits the
 * real running API and renders whatever DefiLlama returns right now.
 * Invoke with `--grep "landing live"`.
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

test('landing live — best yields card on Earn screen', async ({ page }) => {
  await page.setViewportSize({ width: 414, height: 900 });
  await bootAt(page, 's14');

  // Wait for at least one real row to land (data-earn-asset only set after
  // the live read resolves).
  await expect(page.locator('[data-earn-asset]').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#earnLandingList').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  await page.screenshot({ path: 'test-results/earn-landing-live-full.png', fullPage: true });
  const card = page.locator('#earnLandingList').locator('xpath=..');
  await card.screenshot({ path: 'test-results/earn-landing-live-card.png' });
});

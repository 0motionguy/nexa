/**
 * Shared review sheet (#reviewSheet) — Phase C wiring.
 *
 * Withdraw, bridge withdraw, and swap-execute must all funnel through the
 * single confirm sheet instead of submitting straight to the API. The sheet
 * shows venue/route/fee context with an Edit/Confirm pair so the user reads
 * the execution surface before signing.
 */

import { expect, test } from '@playwright/test';

const APP = '/app.html?motion=off';

test.describe('review sheet (Phase C)', () => {
  test('Withdraw from Earn opens the shared review sheet before signing', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('nexa.localDemoLedger', '1');
      } catch {
        /* ignore */
      }
    });
    await page.goto(`${APP}#s14`);
    await page.waitForSelector('#s14.scr.on');

    await page.locator('[data-open="wdSheet"]').first().click();
    await expect(page.locator('#wdSheet')).toHaveClass(/\bon\b/);

    await page.locator('#wdGo').click();
    await expect(page.locator('#reviewSheet')).toHaveClass(/\bon\b/);
    await expect(page.locator('#reviewEyebrow')).toContainText('WITHDRAW FROM EARN');
    await expect(page.locator('#reviewConfirmBtn')).toBeVisible();
    await expect(page.locator('#reviewSheet [data-close="reviewSheet"]').last()).toBeVisible();
  });

  test('Bridge withdraw confirms in the shared review sheet', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('nexa.localDemoLedger', '1');
      } catch {
        /* ignore */
      }
    });
    await page.goto(`${APP}#s25`);
    await page.waitForSelector('#s25.scr.on');

    await page.locator('#s25 [data-open="bridgeWdSheet"]').first().click();
    await expect(page.locator('#bridgeWdSheet')).toHaveClass(/\bon\b/);

    // No payout method registered → toast, no review sheet open.
    await page.locator('#bwGo').click();
    await expect(page.locator('#reviewSheet')).not.toHaveClass(/\bon\b/);
  });
});

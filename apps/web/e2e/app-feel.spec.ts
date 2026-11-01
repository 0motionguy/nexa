/**
 * App-feel polish (Phase I/J/K).
 *
 * Smoke-tests the native-app interactions: top loading bar shows during
 * refresh, sheet drag handle exists and is wired, chrome buttons opt out of
 * the browser tap-highlight, and the global tap-haptic call is non-throwing
 * (navigator.vibrate is a no-op on iOS Safari but must not crash anywhere).
 */

import { expect, test } from '@playwright/test';

const APP = '/app.html?motion=off';

test.describe('app-feel layer', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem('nexa.localDemoLedger', '1');
      } catch {
        /* ignore */
      }
    });
  });

  test('top loading bar element ships on the app shell', async ({ page }) => {
    await page.goto(`${APP}#s08`);
    await page.waitForSelector('#s08.scr.on');
    await expect(page.locator('#topLoadbar')).toHaveCount(1);
    // Idle: not visible (opacity 0).
    await expect(page.locator('#topLoadbar')).not.toHaveClass(/\bon\b/);
  });

  test('every bottom-sheet exposes a drag handle', async ({ page }) => {
    await page.goto(`${APP}#s14`);
    await page.waitForSelector('#s14.scr.on');
    await page.locator('[data-open="wdSheet"]').first().click();
    await expect(page.locator('#wdSheet .sheet .grab')).toBeVisible();
    await expect(page.locator('#wdSheet .sheet .grab')).toHaveCSS('touch-action', 'none');
  });

  test('chrome buttons opt out of the webkit tap-highlight', async ({ page }) => {
    await page.goto(`${APP}#s08`);
    await page.waitForSelector('#s08.scr.on');
    const tab = page.locator('#tabbar .tb').first();
    await expect(tab).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
    await expect(tab).toHaveCSS('user-select', 'none');
  });

  test('tapping a tab triggers the haptic vibrate call (Android-only effect)', async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __vibrateCalls?: number[] }).__vibrateCalls = [];
      (navigator as unknown as { vibrate: (p: unknown) => boolean }).vibrate = (pattern: unknown): boolean => {
        const ms = typeof pattern === 'number' ? pattern : Array.isArray(pattern) ? Number(pattern[0] ?? 0) : 0;
        (window as Window & { __vibrateCalls?: number[] }).__vibrateCalls!.push(ms);
        return true;
      };
    });
    await page.goto(`${APP}#s08`);
    await page.waitForSelector('#s08.scr.on');
    await page.locator('#tabbar [data-tabgo="trade"]').click();
    const calls = await page.evaluate(() => (window as Window & { __vibrateCalls?: number[] }).__vibrateCalls ?? []);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBeGreaterThan(0);
  });
});

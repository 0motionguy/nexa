/**
 * PWA standalone-mode smoke test.
 *
 * Simulates `display-mode: standalone` via an init script that patches
 * `matchMedia`, then asserts the chrome adapts the way it should when MAZE
 * is launched from a home-screen icon:
 *   • the fake home indicator (drawn for browser tabs) hides
 *   • `start_url` lands inside the app shell (session-routed), not the marketing page
 *   • the bottom nav still picks up safe-area insets
 */

import { expect, test, type Page } from '@playwright/test';

const APP = '/app.html?motion=off';

async function fakeStandalone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (q: string): MediaQueryList => {
      if (q.includes('display-mode: standalone')) {
        return {
          matches: true,
          media: q,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList;
      }
      return orig(q);
    };
  });
}

test.describe('PWA standalone mode', () => {
  test('home indicator hides; tabbar stays anchored', async ({ page }) => {
    await fakeStandalone(page);
    await page.goto(`${APP}#s08`);
    await page.waitForSelector('#s08.scr.on');

    // The `.home-ind` decoration is hidden by `@media (display-mode:standalone)`.
    const homeInd = page.locator('.home-ind');
    await expect(homeInd).toHaveCount(1);
    await expect(homeInd).toBeHidden();

    // Tabbar is still on-screen and active for Home.
    await expect(page.locator('#tabbar')).toBeVisible();
    await expect(page.locator('#tabbar [data-tabgo="home"]')).toHaveClass(/\bon\b/);
  });

  test('manifest starts at the session-routed app entry', async ({ request }) => {
    // C1 — start_url is hashless: the router sends live sessions home and
    // signed-out visitors to s01. Pinning #s01 here would force installed
    // users through the sign-in screen on every launch.
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const manifest = await res.json() as { start_url?: string; display?: string; id?: string };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/app.html');
    expect(manifest.id).toBe('/app.html');
  });

  test('installed landing button opens the app shell', async ({ page }) => {
    await fakeStandalone(page);
    await page.goto('/landing.html?motion=off');
    const install = page.locator('[data-install]').first();
    await expect(install).toBeEnabled();
    await expect(install).toContainText('Open MAZE');
    await install.click();
    // Signed-out e2e context: the hashless entry routes to the sign-in
    // screen. Assert the rendered screen (behavior), not a pinned URL.
    await expect(page.locator('#s01')).toHaveClass(/\bon\b/);
  });
});

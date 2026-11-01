/**
 * MAZE mobile QA screenshots.
 *
 * Captures the brief's route list across iPhone SE / iPhone 15 / Pixel widths
 * in light and dark, into screenshots/<viewport>/<theme>/<route>.png.
 *
 * Run only this project (it sets its own viewports, so one project is enough):
 *   pnpm exec playwright test screenshots.spec.ts --project=screenshots
 *
 * For a before/after pair: stash the design branch, run once (before), restore,
 * run again into a sibling folder (after).
 */

import { test, type Page } from '@playwright/test';

const APP = '/app.html?motion=off';

// Brief QA routes → hash screen ids in the single-file app.
const ROUTES = [
  { name: 'onboarding', hash: 's01' },
  { name: 'home', hash: 's08' },
  { name: 'trade', hash: 's27' },
  { name: 'pay', hash: 's25' },
  { name: 'earn', hash: 's14' },
  { name: 'activity', hash: 's29' },
  { name: 'agents', hash: 's19' },
  { name: 'more', hash: 's26' },
  { name: 'card', hash: 's17' },
  { name: 'swap', hash: 's16' },
  { name: 'addmoney', hash: 's09' },
  { name: 'connect', hash: 's24' },
] as const;

// Three widths the brief asks for (360 / 390 / 430) plus the legacy
// iPhone SE (375) and a Pixel (393) for desktop-side parity.
const VIEWPORTS = [
  { name: 'w360', width: 360, height: 800 },
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'w390', width: 390, height: 844 },
  { name: 'iphone-15', width: 393, height: 852 },
  { name: 'pixel', width: 393, height: 851 },
  { name: 'w430', width: 430, height: 932 },
] as const;

const THEMES = ['light', 'dark'] as const;

async function applyTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  // Flip the scoped theme directly; CSS tokens cascade immediately.
  await page.evaluate((t) => {
    document.querySelector('#stage')?.setAttribute('data-theme', t);
  }, theme);
}

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`${vp.name} · ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const route of ROUTES) {
        await page.goto(`${APP}#${route.hash}`);
        await page.waitForSelector('.scr.on');
        await applyTheme(page, theme);
        await page.waitForTimeout(150); // settle layout + token flip
        await page.screenshot({ path: `screenshots/${vp.name}/${theme}/${route.name}.png` });
      }
    });
  }
}

/**
 * Signed-out shell must not render any demo balance fixtures.
 *
 * Regression guard: before this sprint the app shipped with L.bal = 4820.40 and
 * a $1,692.45 spend card hardcoded into the markup, both visible to anyone who
 * navigated directly to /app.html#s08 without a session. Removing those was
 * the highest-value piece of Phase A of the mobile-app polish.
 */

import { expect, test } from '@playwright/test';

const APP = '/app.html?motion=off';

test.describe('signed-out shell', () => {
  test.beforeEach(async ({ page }) => {
    // No demo-ledger flag — bootAt counterparts in other suites flip this on
    // intentionally. Here we want the *real* unauthenticated paint.
    await page.addInitScript(() => {
      try {
        sessionStorage.removeItem('nexa.localDemoLedger');
        sessionStorage.removeItem('nexa.session');
      } catch {
        /* ignore */
      }
    });
  });

  test('Home shows empty balance + sign-in CTA, never the $4,820.40 fixture', async ({ page }) => {
    await page.goto(`${APP}#s08`);
    await page.waitForSelector('#s08.scr.on');

    await expect(page.locator('#balEl')).toHaveText('—');
    await expect(page.locator('.home-greet')).toHaveText('Welcome');

    // The legacy fixtures must not appear anywhere on the page.
    const body = page.locator('body');
    await expect(body).not.toContainText('$4,820.40');
    await expect(body).not.toContainText('$1,692.45');
    await expect(body).not.toContainText('$3,200.00');

    // The signed-out empty state and CTA are visible.
    await expect(page.locator('#homeEmpty')).toBeVisible();
    await expect(page.locator('#homeEmpty h3')).toContainText('Sign in');
    await expect(page.locator('#homeEmpty button.btn')).toContainText('Sign in');
  });

  test('Activity tab shows sign-in empty state, never the seeded demo rows', async ({ page }) => {
    await page.goto(`${APP}#s29`);
    await page.waitForSelector('#s29.scr.on');

    await expect(page.locator('#actListFull')).not.toContainText('Salary · Acme Studio');
    await expect(page.locator('#actListFull')).not.toContainText('api.exa.ai');

    await expect(page.locator('#activityEmpty')).toBeVisible();
    await expect(page.locator('#activityEmpty')).toContainText('Sign in');
  });

  test('Earn tab shows — for the position when signed out', async ({ page }) => {
    await page.goto(`${APP}#s14`);
    await page.waitForSelector('#s14.scr.on');
    await expect(page.locator('#earnPos')).toHaveText('—');
    await expect(page.locator('body')).not.toContainText('$3,200.00');
  });
});

/**
 * Session 2026-06-22 — Earn-landing smoke. Verifies:
 *   - "BEST YIELDS RIGHT NOW" card renders on s14 (Earn)
 *   - Per-asset rows show venue + APY + a CTA tag (EARN for native, OPEN ↗ for deeplink)
 *   - Native rows route to s14a / s14b in-app
 *   - Deeplink rows surface a target URL (we stub window.open to assert)
 *
 * Backend `/earn/landing` is mocked so the test is hermetic.
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

async function mockLanding(page: Page): Promise<void> {
  await page.route(/\/earn\/landing(\?|$)/, async (route) => {
    const usdcMorpho = { asset: 'USDC', venue: 'Morpho (Steakhouse)', chain: 'base', apyBps: 520, apyBaseBps: null, apyRewardBps: null, tvlUsd: null, url: null, mode: 'native', riskBand: 'B' };
    const usdcAaveEth = { asset: 'USDC', venue: 'Aave V3', chain: 'ethereum', apyBps: 689, apyBaseBps: 312, apyRewardBps: 377, tvlUsd: 61_000_000, url: 'https://app.aave.com', mode: 'deeplink', riskBand: 'A' };
    const solMarinade = { asset: 'SOL', venue: 'Marinade', chain: 'solana', apyBps: 720, apyBaseBps: null, apyRewardBps: null, tvlUsd: null, url: null, mode: 'native', riskBand: 'A' };
    const sUSDeEthena = { asset: 'sUSDe', venue: 'Ethena', chain: 'ethereum', apyBps: 1850, apyBaseBps: null, apyRewardBps: null, tvlUsd: null, url: 'https://app.ethena.fi/buy', mode: 'deeplink', riskBand: 'B' };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        cached: false,
        landscape: [
          {
            asset: 'USDC',
            bestApyBps: 689,
            readAt: '2026-06-22T13:30:00.000Z',
            // Top market is a deeplink (Aave Ethereum); best native is Morpho
            // Base. Renderer should show BOTH rows.
            picks: [usdcAaveEth, usdcMorpho],
            bestNative: usdcMorpho,
          },
          {
            asset: 'SOL',
            bestApyBps: 720,
            readAt: '2026-06-22T13:30:00.000Z',
            // Top IS native — renderer collapses to one row with EARN tag.
            picks: [solMarinade],
            bestNative: solMarinade,
          },
          {
            asset: 'sUSDe',
            bestApyBps: 1850,
            readAt: '2026-06-22T13:30:00.000Z',
            // No native option — single deeplink row.
            picks: [sUSDeEthena],
            bestNative: null,
          },
        ],
      }),
    });
  });
}

test.describe('session 2026-06-22 — earn landing', () => {
  test('Best yields card renders on Earn screen with per-asset rows', async ({ page }) => {
    await mockLanding(page);
    await bootAt(page, 's14');

    const card = page.locator('#earnLandingList');
    await expect(card).toBeVisible();

    // Each asset row carries a data-earn-asset attribute.
    const usdcRows = card.locator('[data-earn-asset="USDC"]');
    await expect(usdcRows.first()).toBeVisible({ timeout: 5_000 });
    await expect(usdcRows.first()).toContainText('Aave V3');
    await expect(usdcRows.first()).toContainText('6.89%');

    const solRow = card.locator('[data-earn-asset="SOL"]');
    await expect(solRow).toBeVisible();
    await expect(solRow).toContainText('Marinade');
    await expect(solRow).toContainText('7.20%');

    const ethenaRow = card.locator('[data-earn-asset="sUSDe"]');
    await expect(ethenaRow).toBeVisible();
    await expect(ethenaRow).toContainText('Ethena');
    await expect(ethenaRow).toContainText('18.50%');
  });

  test('Two-row layout: deeplink top + native in-app fallback for USDC', async ({ page }) => {
    await mockLanding(page);
    await bootAt(page, 's14');

    const card = page.locator('#earnLandingList');
    // USDC should render TWO rows since top market is deeplink and a
    // separate native option exists.
    const usdcRows = card.locator('[data-earn-asset="USDC"]');
    await expect(usdcRows.first()).toBeVisible({ timeout: 5_000 });
    expect(await usdcRows.count()).toBe(2);

    const topRow = card.locator('[data-earn-asset="USDC"][data-earn-kind="top"]');
    await expect(topRow).toContainText('Aave V3');
    await expect(topRow).toContainText('6.89%');
    await expect(topRow).toContainText('OPEN');

    const inAppRow = card.locator('[data-earn-asset="USDC"][data-earn-kind="in-app"]');
    await expect(inAppRow).toContainText('In-app');
    await expect(inAppRow).toContainText('Morpho');
    await expect(inAppRow).toContainText('5.20%');
    await expect(inAppRow).toContainText('EARN');
  });

  test('Single-row layout when top pick is native (SOL) OR no native exists (sUSDe)', async ({ page }) => {
    await mockLanding(page);
    await bootAt(page, 's14');

    const card = page.locator('#earnLandingList');

    // SOL: top IS native (Marinade) → renderer collapses to one row.
    const solRows = card.locator('[data-earn-asset="SOL"]');
    expect(await solRows.count()).toBe(1);
    await expect(solRows.first()).toContainText('EARN');
    await expect(solRows.first()).toHaveAttribute('data-earn-kind', 'only');

    // sUSDe: no native option → single deeplink row.
    const eRows = card.locator('[data-earn-asset="sUSDe"]');
    expect(await eRows.count()).toBe(1);
    await expect(eRows.first()).toContainText('OPEN');
    await expect(eRows.first()).toHaveAttribute('data-earn-kind', 'only');
  });

  test('Native row routes to the in-app Earn flow', async ({ page }) => {
    await mockLanding(page);
    await bootAt(page, 's14');

    const solRow = page.locator('[data-earn-asset="SOL"]');
    await expect(solRow).toBeVisible({ timeout: 5_000 });
    // Marinade is `native` mode → tap should route to s14b (SOL Staking).
    await solRow.click();
    await expect(page.locator('#s14b')).toHaveClass(/\bon\b/);
  });

  test('Deeplink row opens an external URL', async ({ page }) => {
    await mockLanding(page);
    await bootAt(page, 's14');

    // Capture the URL the row attempts to open.
    const opened: string[] = [];
    await page.exposeFunction('__captureOpen', (url: string) => { opened.push(url); });
    await page.evaluate(() => {
      const orig = window.open;
      // @ts-expect-error patch for assertion
      window.open = (url?: string) => { (window as unknown as { __captureOpen: (u: string) => void }).__captureOpen(String(url ?? '')); return null; };
      void orig;
    });

    // Top USDC pick is Aave V3 (deeplink) → tap the kind=top row, which is
    // the deeplink, not the kind=in-app row beneath it.
    const usdcTopRow = page.locator('[data-earn-asset="USDC"][data-earn-kind="top"]');
    await expect(usdcTopRow).toBeVisible({ timeout: 5_000 });
    await usdcTopRow.click();
    await expect.poll(() => opened.length, { timeout: 3_000 }).toBeGreaterThan(0);
    expect(opened[0]).toContain('app.aave.com');
  });
});

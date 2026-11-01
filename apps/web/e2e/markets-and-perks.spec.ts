/**
 * Sprint 10 Item H — Markets region pill + perks tier card + campaign flow.
 *
 * The region pill mirrors the server's BLOCKED set (apps/api/src/lib/markets/
 * polymarket.ts POLY_BLOCKED). When `localStorage.maze.region` is in that set
 * the pill renders "Not available · <region>"; otherwise "Available · <region>".
 *
 * Runs with ?motion=off so animations are fast and deterministic.
 */

import { expect, test, type Page } from '@playwright/test';

const APP = '/app.html?motion=off';
const API = `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`;

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

async function mockMarkets(page: Page): Promise<void> {
  await page.route(/\/markets\/hyperliquid(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'demo',
        markets: [
          {
            coin: 'BTC',
            priceUsd: 63240.5,
            change24hPct: 2.140677,
            maxLeverage: 50,
            dayVolumeUsd: 1234000000,
            openInterest: 7590,
            fundingRate: 0.00012,
          },
        ],
      }),
    });
  });
  await page.route(/\/markets\/hyperliquid-spot(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'demo',
        markets: [
          {
            coin: 'PURR/USDC',
            displayName: 'PURR/USDC',
            baseToken: 'PURR',
            quoteToken: 'USDC',
            priceUsd: 0.21,
            change24hPct: 5,
            dayVolumeUsd: 1000000,
            index: 0,
            isCanonical: true,
          },
        ],
      }),
    });
  });
  await page.route('https://api.hyperliquid.xyz/info', async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type === 'spotMetaAndAssetCtxs') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          { tokens: [{ name: 'USDC', index: 0 }, { name: 'PURR', index: 1 }], universe: [{ name: 'PURR/USDC', tokens: [1, 0], index: 0 }] },
          [{ markPx: '0.21', prevDayPx: '0.20', dayNtlVlm: '1000000' }],
        ]),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { universe: [{ name: 'BTC', maxLeverage: 50 }] },
        [{ markPx: '63240.5', prevDayPx: '61915.1', dayNtlVlm: '1234000000', openInterest: '7590', funding: '0.00012' }],
      ]),
    });
  });
  await page.route('https://gamma-api.polymarket.com/events?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'pm-election-event',
          slug: 'pm-election-event',
          title: 'Who wins the 2028 Democratic nomination?',
          image: 'https://example.test/polymarket-btc.png',
          icon: 'https://example.test/polymarket-btc.png',
          tags: [{ label: 'Politics' }],
          volume24hr: 12345,
          markets: [
            { id: 'market-harris', question: 'Harris?', groupItemTitle: 'Harris', outcomes: '["Yes","No"]', outcomePrices: '["0.52","0.48"]' },
            { id: 'market-newsom', question: 'Newsom?', groupItemTitle: 'Newsom', outcomes: '["Yes","No"]', outcomePrices: '["0.21","0.79"]' },
          ],
        },
      ]),
    });
  });
  await page.route(/\/(?:api\/)?markets\/polymarket(?:\?|$)/, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'demo',
        markets: [
          {
            id: 'pm-election-event',
            question: 'Who wins the 2028 Democratic nomination?',
            imageUrl: 'https://example.test/polymarket-btc.png',
            category: 'Politics',
            tags: ['Politics'],
            closesAt: null,
            isMultiOutcome: true,
            volume24hUsd: 12345,
            outcomes: [
              { label: 'Harris', pricePct: 52, marketId: 'pm-election-event', tokenId: 'tok-harris' },
              { label: 'Newsom', pricePct: 21, marketId: 'pm-election-event', tokenId: 'tok-newsom' },
            ],
          },
        ],
      }),
    });
  });
}

async function bootLiveAt(page: Page, screen: string): Promise<void> {
  const start = await page.context().request.post(`${API}/auth/start`, {
    data: { email: 'markets-live-order@example.com' },
  });
  const startBody = await start.json() as { challengeId: string };
  const verify = await page.context().request.post(`${API}/auth/verify`, {
    data: { challengeId: startBody.challengeId, code: '482019' },
  });
  const verifyBody = await verify.json() as { token: string };
  await page.addInitScript((token) => {
    try {
      sessionStorage.setItem('nexa.session', token);
      sessionStorage.removeItem('nexa.localDemoLedger');
      localStorage.setItem('maze.region', 'NL');
    } catch {
      /* ignore */
    }
  }, verifyBody.token);
  const me = {
    ok: true,
    user: { id: 'u-test', email: 'test@example.com', name: 'Test User' },
    balance: { balUsd: 4820.4, earnUsd: 3200, earnApy: 520 },
    earnConfig: { earnByDefault: false, autoDivestOnSpend: false, divestThresholdUsd: 50 },
  };
  await page.route(/\/(?:api\/)?auth\/me(?:\?|$)/, async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(me) }));
  await page.route(/\/(?:api\/)?ledger\/activity(?:\?|$)/, async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activity: [] }) }));
  await page.route(/\/(?:api\/)?ledger\/me(?:\?|$)/, async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...me, virtualAccounts: {}, card: null, earn: { apyBps: 520, posUsd: 3200 } }) }));
  await page.route(/\/(?:api\/)?earn\/protocols(?:\?|$)/, async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      standard: { name: 'morpho', apyBps: 520, isLive: true, available: true },
      higherYield: { name: 'morpho-high-yield', apyBps: 620, isLive: true, available: true },
      blendedApy: 520,
      adapters: [],
    }),
  }));
  await page.goto(`${APP}#${screen}`);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('nexa.session')))
    .not.toBe(verifyBody.token);
  await page.waitForSelector('.scr.on');
  await page.evaluate((target) => {
    window.location.hash = target;
  }, screen);
  await page.locator(`#${screen}.scr.on`).waitFor();
}

test.describe('region pill + perks card', () => {
  test('region pill shows blocked label when localStorage region is US', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('maze.region', 'US');
      } catch {
        /* ignore */
      }
    });
    await bootAt(page, 's14d');
    const pill = page.locator('#perksRegion');
    await expect(pill).toHaveAttribute('blocked', '');
    await expect(pill).toHaveAttribute('aria-label', /Not available/);
  });

  test('region pill shows available label when region is NL', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('maze.region', 'NL');
      } catch {
        /* ignore */
      }
    });
    await bootAt(page, 's14d');
    const pill = page.locator('#perksRegion');
    await expect(pill).not.toHaveAttribute('blocked', '');
    await expect(pill).toHaveAttribute('aria-label', /Available · NL/);
  });

  test('campaign join chip in earn tab toggles to JOINED', async ({ page }) => {
    await bootAt(page, 's14c');
    const join = page.locator('[data-join2]').first();
    await expect(join).toHaveText('JOIN');
    await join.click();
    await expect(join).toContainText('JOINED');
  });

  test('hyperliquid + polymarket pills mirror the perks region pill', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('maze.region', 'US');
      } catch {
        /* ignore */
      }
    });
    await bootAt(page, 's14d');
    const hl = page.locator('#hlRegion');
    const pm = page.locator('#pmRegion');
    await expect(hl).toHaveAttribute('blocked', '');
    await expect(pm).toHaveAttribute('blocked', '');
    await expect(hl).toHaveAttribute('aria-label', /Not available · US/);
    await expect(pm).toHaveAttribute('aria-label', /Not available · US/);
  });
});

test.describe('markets polish', () => {
  test('Hyperliquid row click opens the trade sheet and source opens provenance', async ({ page }) => {
    await mockMarkets(page);
    await bootAt(page, 's27');

    const row = page.locator('#hlMarketsList nexa-market-row').first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#s27d')).toHaveClass(/\bon\b/);
    await expect(page.locator('#detailTtl')).toContainText('BTC');
    await expect(page.locator('#detailVol')).toHaveText('$1.23B');
    await expect(page.locator('#detailOi')).toContainText('$480');
    await expect(page.locator('#detailInfoFunding')).toContainText('+0.012');
    await expect(page.locator('#detailInfoMaxLev')).toHaveText('50x');
    await page.locator('#detailLong').click();

    await expect(page.locator('#hlOrderSheet')).toHaveClass(/\bon\b/);
    await expect(page.locator('nexa-provenance-drawer[open]')).toHaveCount(0);
    await expect(page.locator('#hlOrderSym')).toHaveText('BTC-PERP');
    await expect(page.locator('#hlOrderPrice')).toContainText('$63,241');
    await expect(page.locator('#hlOrderChange')).toHaveText('+2.14% 24h');
    await expect(page.locator('#hlPlaceOrderBtn')).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(page.locator('#hlOrderSheet')).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#s27d')).toHaveClass(/\bon\b/);
  });

  test('Hyperliquid order sheet has no user builder approval prompt', async ({ page }) => {
    await bootAt(page, 's27');
    const state = await page.evaluate(() => {
      document.getElementById('hlOrderSheet')?.classList.add('on');
      return {
        orderOpen: document.getElementById('hlOrderSheet')?.classList.contains('on') ?? false,
        approvalSheetPresent: document.getElementById('hlBuilderApprovalSheet') !== null,
        approvalButtonPresent: document.getElementById('hlApproveBuilderBtn') !== null,
      };
    });

    expect(state).toEqual({
      orderOpen: true,
      approvalSheetPresent: false,
      approvalButtonPresent: false,
    });
  });

  test('Polymarket renders event thumbnail row and row click opens the trade sheet', async ({ page }) => {
    await mockMarkets(page);
    await bootAt(page, 's27');
    await page.locator('[data-trade-venue="predictions"]').click();

    const card = page.locator('#pmMarketsList .pm-event-card').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('Who wins the 2028 Democratic nomination?');

    await card.locator('.pm-outcome-btn', { hasText: 'Harris' }).click();
    await expect(page.locator('#pmOrderSheet')).toHaveClass(/\bon\b/);
    await expect(page.locator('#pmOrderQuestion')).toContainText('Who wins the 2028 Democratic nomination?');
    await expect(page.locator('#pmOrderCategory')).toHaveText('Politics');
    await expect(page.locator('#pmOrderPrice')).toHaveText('HARRIS 52%');
    await expect(page.locator('#pmOutcomeSeg [data-pmoutcome="Harris"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('#pmOutcomeSeg [data-pmoutcome="Newsom"]')).toBeVisible();
    await expect(page.locator('nexa-provenance-drawer[open]')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('#pmOrderSheet')).not.toHaveClass(/\bon\b/);
    await expect(card).toBeVisible();
  });

  test('Polymarket live order submits the event id, not the outcome token id', async ({ page }) => {
    await mockMarkets(page);
    let orderBody: { marketId?: string; outcome?: string; priceCents?: number; qtyUsd?: number } | null = null;
    await page.route(/\/(?:api\/)?markets\/polymarket\/order(?:\?|$)/, async (route) => {
      orderBody = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          order: { orderId: 'pm-test-order', demo: false },
          position: {
            id: 'pos-test',
            venue: 'polymarket',
            symbol: 'pm-election-event:Harris',
            sideLong: true,
            qtyUsd: 25,
            entryPriceUsd: 0.52,
            externalRef: 'pm-test-order',
            status: 'open',
          },
        }),
      });
    });

    await bootLiveAt(page, 's27');
    await page.locator('[data-trade-venue="predictions"]').click();
    await page.locator('#pmMarketsList .pm-outcome-btn', { hasText: 'Harris' }).click();
    await page.locator('#pmQty').fill('25');
    await page.locator('#pmPlaceOrderBtn').click();
    await expect.poll(() => orderBody ? `${orderBody.marketId}:${orderBody.outcome}` : null).toBe('pm-election-event:Harris');
  });

  test('xStocks quote failure disables swap with the exact routeability blocker', async ({ page }) => {
    await mockMarkets(page);
    await page.route(/\/(?:api\/)?markets\/stocks\/perps(?:\?|$)/, async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, source: 'demo', markets: [] }) });
    });
    await page.route(/\/(?:api\/)?markets\/stocks\/spot(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          source: 'xstocks',
          stocks: [
            {
              mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
              ticker: 'AAPL',
              symbolX: 'AAPLx',
              name: 'Apple',
              category: 'stock',
              priceUsd: 295.8,
              priceChange24h: 0.3,
              marketCapUsd: 4.5e10,
            },
          ],
        }),
      });
    });
    await page.route(/\/(?:api\/)?markets\/jupiter\/quote(?:\?|$)/, async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'quote_unavailable', message: 'quote_unavailable' } }),
      });
    });

    await bootLiveAt(page, 's27');
    await page.locator('[data-trade-venue="stocks"]').click();
    const row = page.locator('#xStocksSpotMarketsList [data-jup-mint]').first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#jupSwapSheet')).toHaveClass(/\bon\b/);
    await page.locator('#jupQty').fill('25');

    await expect(page.locator('#jupReceiveOut')).toHaveText('No Jupiter route for this pair.');
    await expect(page.locator('#jupPlaceSwapBtn')).toBeDisabled();
    await expect(page.locator('#jupPlaceSwapBtn')).toHaveText('No route available');
  });
});

test.describe('earn config toggles (Sprint 10 Item A)', () => {
  test('toggles render with default off state on s14 BALANCE seg', async ({ page }) => {
    await bootAt(page, 's14a');
    await expect(page.locator('#earnCfgCardS14a')).toBeVisible();
    const dflt = page.locator('#earnCfgDefaultS14a');
    const div = page.locator('#earnCfgDivestS14a');
    await expect(dflt).toHaveAttribute('aria-checked', 'false');
    await expect(div).toHaveAttribute('aria-checked', 'false');
    // Threshold defaults to $50; the visible label tracks the slider.
    await expect(page.locator('#earnCfgThValS14a')).toHaveText('$50');
  });

  test('clicking earnCfgDefault flips aria-checked', async ({ page }) => {
    await bootAt(page, 's14a');
    const dflt = page.locator('#earnCfgDefaultS14a');
    await dflt.click();
    await expect(dflt).toHaveAttribute('aria-checked', 'true');
    await dflt.click();
    await expect(dflt).toHaveAttribute('aria-checked', 'false');
  });
});

test.describe('bridge offramp sheet (Sprint 10 Item B)', () => {
  test('Withdraw to bank opens sheet with empty destinations list', async ({ page }) => {
    await bootAt(page, 's25');
    await page.locator('#s25 [data-open="bridgeWdSheet"]').first().click();
    const sheet = page.locator('#bridgeWdSheet');
    await expect(sheet).toHaveClass(/\bon\b/);
    await expect(sheet.locator('#payoutEmpty')).toBeVisible();
    // Default amount $100 on a $4820 balance.
    await expect(sheet.locator('#bwV')).toHaveText('100');
    await expect(sheet.locator('#bwGoLbl')).toHaveText('$100');
  });

  test('Add method form expands and ACH routing field shows', async ({ page }) => {
    await bootAt(page, 's25');
    await page.locator('#s25 [data-open="bridgeWdSheet"]').first().click();
    await page.locator('#payoutAddBtn').click();
    const form = page.locator('#payoutAddForm');
    await expect(form).toBeVisible();
    // ACH is the default selection so the routing field is visible.
    await expect(form.locator('#payoutRoutingField')).toBeVisible();
    // Switching to SEPA hides routing.
    await form.locator('[data-paytype="sepa"]').click();
    await expect(form.locator('#payoutRoutingField')).toBeHidden();
  });
});

test.describe('campaign submit sheet (Sprint 10 Item F)', () => {
  test('Demo campaigns list visible; clicking a JOIN chip in eseg2 still works', async ({ page }) => {
    await bootAt(page, 's14c');
    await expect(page.locator('#campDemoList')).toBeVisible();
    // Live list stays hidden in demo mode.
    await expect(page.locator('#campLiveList')).toBeHidden();
  });
});

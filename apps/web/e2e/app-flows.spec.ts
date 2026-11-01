/**
 * NEXA app — end-to-end flow suite against the ported 24-screen surface.
 *
 * Runs with ?motion=off so the engine takes its reduced-motion branches
 * (KYC sim 50/100ms, FaceID 100ms, no tweens) — fast and deterministic.
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const APP = '/app.html?motion=off';
const API = `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`;
const WEB_ORIGIN = `http://localhost:${process.env['NEXA_WEB_PORT'] ?? 5173}`;

async function bootAt(page: Page, screen?: string, opts: { demoLedger?: boolean } = {}): Promise<void> {
  const demoLedger = opts.demoLedger ?? Boolean(screen);
  await page.addInitScript((enabled) => {
    try {
      if (enabled) sessionStorage.setItem('nexa.localDemoLedger', '1');
      else sessionStorage.removeItem('nexa.localDemoLedger');
    } catch {
      /* ignore */
    }
  }, demoLedger);
  await page.goto(screen ? `${APP}#${screen}` : APP);
  await page.waitForSelector(`#${screen ?? 's01'}.scr.on`);
}

async function openMore(page: Page): Promise<void> {
  const tab = page.locator('#tabbar [data-tabgo="more"]');
  if (await tab.count()) {
    await tab.click();
    return;
  }
  await page.locator('#tabbar [data-tabgo="home"]').click();
  await page.locator('#s08 [aria-label="More"]').click();
}

async function demoSessionToken(request: APIRequestContext): Promise<string> {
  const email = `app-flow-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const start = await request.post(`${API}/auth/start`, { data: { email } });
  expect(start.ok()).toBe(true);
  const startBody = (await start.json()) as { challengeId: string };
  const verify = await request.post(`${API}/auth/verify`, {
    data: { challengeId: startBody.challengeId, code: '482019' },
  });
  expect(verify.ok()).toBe(true);
  const verifyBody = (await verify.json()) as { token: string };
  return verifyBody.token;
}

test.describe('boot + chrome', () => {
  test('boots at welcome with no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await bootAt(page);
    await expect(page.locator('#s01')).toHaveClass(/\bon\b/);
    await expect(page.locator('#s01 h1')).toContainText('self-custody dollar account');
    expect(errors).toEqual([]);
  });

  test('deep link to home shows balance + activity', async ({ page }) => {
    await bootAt(page, 's08');
    await expect(page.locator('#balEl')).toHaveText('$4,820.40');
    await expect(page.locator('#actList .tx-row')).toHaveCount(2);
    await expect(page.locator('#tabbar')).toHaveClass(/\bon\b/);
  });

  test('root tab screens keep the shared top header visible', async ({ page }) => {
    for (const screen of ['s14', 's19', 's25', 's26']) {
      await bootAt(page, screen);
      await expect(page.locator(`#${screen} .appbar .home-wordmark`)).toBeVisible();
    }
  });

  test('legacy onboarding hashes redirect to the Privy auth entry', async ({ page }) => {
    await page.goto(`${APP}#s06`);
    await expect(page.locator('#s01')).toHaveClass(/\bon\b/);
    await expect(page).toHaveURL(/\/app\.html\?motion=off#s01$/);
    // Without the MazePrivy e2e bridge the React island shows "Connecting..."
    // until the Privy embed readies — both labels are the auth entry.
    await expect(page.getByRole('button', { name: /Continue with Google|Connecting/ })).toBeVisible();
    await expect(page.locator('#s06')).toHaveCount(0);
  });

  test('receive screen renders Base wallet QR and bank details when signed in', async ({ page, request }) => {
    const token = await demoSessionToken(request);
    await page.route('**/ledger/me**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          user: { id: 'u_receive', email: 'mirko@example.com', name: 'Mirko' },
          balance: { balUsd: 12, earnUsd: 0, earnApy: 0 },
          virtualAccounts: {
            us: { number: '1234567890', routing: '021000021' },
            eu: { iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
          },
          wallet: { baseAddress: '0x1111111111111111111111111111111111111111' },
          card: null,
          earn: { apyBps: null, posUsd: 0 },
          agents: { count: 0, killSwitch: false },
        }),
      });
    });
    await page.addInitScript((sessionToken) => {
      sessionStorage.setItem('nexa.session', sessionToken);
    }, token);

    await bootAt(page, 's30');
    await expect(page.locator('#receiveBaseAddr')).toHaveText('0x1111111111111111111111111111111111111111');
    await expect(page.locator('#receiveQr')).toBeVisible();
    await expect(page.locator('#copyReceiveBase')).toBeEnabled();
    await expect(page.locator('#copyReceiveBank')).toBeEnabled();
    await expect(page.locator('#copyReceiveHandle')).toBeEnabled();
    await expect(page.locator('#s30 [data-acct="us-routing"]')).toHaveText('021000021');
  });

  test('keeps a valid bearer session when sliding refresh is temporarily unavailable', async ({ page, request }) => {
    const token = await demoSessionToken(request);
    await page.route('**/auth/refresh', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'temporarily_unavailable' }),
      }),
    );
    await page.addInitScript((sessionToken) => {
      sessionStorage.setItem('nexa.session', sessionToken);
    }, token);

    await bootAt(page, 's08', { demoLedger: false });
    await expect(page.locator('#newOfferCta')).toBeVisible();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('nexa.session'))).toBe(token);
  });

  test('wallet surface exposes Base address from More and chips on Earn/Trade', async ({ page, request }) => {
    const token = await demoSessionToken(request);
    await page.route('**/ledger/me**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          user: { id: 'u_wallet', email: 'wallet@example.com', name: 'Wallet' },
          balance: { balUsd: 12, earnUsd: 0, earnApy: 0 },
          virtualAccounts: {},
          wallet: { baseAddress: '0x3333333333333333333333333333333333333333' },
          card: null,
          earn: { apyBps: null, posUsd: 0 },
          agents: { count: 0, killSwitch: false },
        }),
      });
    });
    await page.route('**/api/balances', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          totalUsd: 15.118582,
          buckets: {
            cash: { usd: 0, chain: 'base' },
            perps: { usd: 15.118582, chain: 'arbitrum', sources: { arbitrum: 0, hyperliquidSpot: 15.118582 } },
            predictions: { usd: 0, chain: 'polygon' },
            memes: { usd: 0, chain: 'solana' },
            'stocks-spot': { usd: 3.5, chain: 'solana' },
          },
          byChain: { base: 0, arbitrum: 0, polygon: 0, solana: 0, hyperliquidSpot: 15.118582 },
          wallets: { evm: '0x3333333333333333333333333333333333333333', solana: '11111111111111111111111111111111' },
        }),
      });
    });
    await page.addInitScript((sessionToken) => {
      sessionStorage.setItem('nexa.session', sessionToken);
    }, token);

    await bootAt(page, 's26', { demoLedger: false });
    await page.locator('#s26 [data-go="s31"]').click();
    await expect(page.locator('#s31')).toHaveClass(/\bon\b/);
    await expect(page.locator('#walletBaseAddr')).toHaveText('0x3333333333333333333333333333333333333333');
    await expect(page.locator('[data-wallet-hl-spot-bal]')).toHaveText('$15.12');
    await expect(page.locator('[data-wallet-hl-spot-addr]')).toHaveText('0x3333333333333333333333333333333333333333');
    await expect(page.locator('#copyWalletBase')).toBeEnabled();
    await expect(page.locator('#walletBasescan')).toHaveAttribute('href', /basescan\.org\/address\/0x3333/);

    await bootAt(page, 's14', { demoLedger: false });
    await expect(page.locator('#earnWalletChip')).toContainText('0x3333…3333');
    await bootAt(page, 's27', { demoLedger: false });
    await expect(page.locator('#tradeWalletChip')).toContainText('0x3333…3333');
  });

  test('More exposes Web Push notification opt-in honestly', async ({ page }) => {
    await bootAt(page, 's26');
    await expect(page.locator('#notificationToggle')).toBeVisible();
    await expect(page.locator('#notificationStatus')).toContainText('OFF');
    await page.locator('#notificationToggle').click();
    await expect(page.locator('.toast.err').last()).toContainText('Sign in to enable notifications.');
    await expect(page.locator('#notificationToggle')).toHaveAttribute('aria-checked', 'false');
  });

  test('fresh signed-in home shows activation checklist progress', async ({ page, request }) => {
    const token = await demoSessionToken(request);
    await page.route('**/ledger/activity', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activity: [] }) });
    });
    await page.route('**/ledger/me**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          user: { id: 'u_activation', email: 'activation@example.com', name: 'Activation' },
          balance: { balUsd: 0, earnUsd: 0, earnApy: 0 },
          kycStatus: 'pending',
          virtualAccounts: {},
          wallet: { baseAddress: null },
          card: null,
          earn: { apyBps: null, posUsd: 0 },
          agents: { count: 0, killSwitch: false },
        }),
      });
    });
    await page.addInitScript((sessionToken) => {
      sessionStorage.setItem('nexa.session', sessionToken);
    }, token);

    await bootAt(page, 's08', { demoLedger: false });
    await expect(page.locator('#activationChecklist')).toBeVisible();
    await expect(page.locator('#activationProgress')).toHaveText('0/2');
    await expect(page.locator('#activationKyc')).toBeHidden();
    await expect(page.locator('#activationFund')).toContainText('Add first dollars');
    await expect(page.locator('#activationAgent')).toContainText('Connect first agent');
  });

  test('home spend insight uses real monthly endpoint', async ({ page, request }) => {
    const token = await demoSessionToken(request);
    await page.route('**/ledger/activity', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activity: [] }) });
    });
    await page.route('**/ledger/me**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          user: { id: 'u_spend', email: 'spend@example.com', name: 'Spend' },
          balance: { balUsd: 100, earnUsd: 0, earnApy: 0 },
          kycStatus: 'verified',
          virtualAccounts: {},
          wallet: { baseAddress: '0x3333333333333333333333333333333333333333' },
          card: null,
          earn: { apyBps: null, posUsd: 0 },
          agents: { count: 1, killSwitch: false },
        }),
      });
    });
    await page.route('**/spend/monthly', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          month: '2026-06',
          totalUsd: 42.5,
          categories: [{ key: 'card', label: 'Card', totalUsd: 42.5 }],
        }),
      });
    });
    await page.addInitScript((sessionToken) => {
      sessionStorage.setItem('nexa.session', sessionToken);
    }, token);

    await bootAt(page, 's08', { demoLedger: false });
    await expect(page.locator('#spendInsightCard')).toBeVisible();
    await expect(page.locator('#spendInsightAmount')).toHaveText('$42.50');
    await expect(page.locator('#spendInsightSub')).toContainText('Card');
  });

  test('tabbar navigates home → trade → pay → earn → activity; home More opens settings', async ({ page }) => {
    await bootAt(page, 's08');
    await page.locator('#tabbar [data-tabgo="trade"]').click();
    await expect(page.locator('#s27')).toHaveClass(/\bon\b/);
    await page.locator('#tabbar [data-tabgo="pay"]').click();
    await expect(page.locator('#s25')).toHaveClass(/\bon\b/);
    await page.locator('#tabbar [data-tabgo="earn"]').click();
    await expect(page.locator('#s14')).toHaveClass(/\bon\b/);
    await page.locator('#tabbar [data-tabgo="activity"]').click();
    await expect(page.locator('#s29')).toHaveClass(/\bon\b/);
    await openMore(page);
    await expect(page.locator('#s26')).toHaveClass(/\bon\b/);
  });

  test('More rows stay inside the app shell instead of opening public pages', async ({ page }) => {
    await bootAt(page, 's26');

    await expect(page.locator('#s26 .lrow .grow').first()).toHaveCSS('flex-grow', '1');
    await page.locator('#moreX402').click();
    await expect(page).toHaveURL(/\/app\.html\?motion=off#s24$/);
    await expect(page.locator('#s24')).toHaveClass(/\bon\b/);

    await openMore(page);
    await expect(page.locator('#s26')).toHaveClass(/\bon\b/);
    await page.locator('#moreDevelopers').click();
    await expect(page).toHaveURL(/\/app\.html\?motion=off#s28$/);
    await expect(page.locator('#s28')).toHaveClass(/\bon\b/);
  });
});

test.describe('Privy auth entry', () => {
  test('signs in with Privy only, then lands in the app home', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as {
        MazePrivy?: { login: () => Promise<string> };
        __mazePrivyLoginCalls?: number;
      }).MazePrivy = {
        login: async () => {
          (window as unknown as { __mazePrivyLoginCalls?: number }).__mazePrivyLoginCalls =
            ((window as unknown as { __mazePrivyLoginCalls?: number }).__mazePrivyLoginCalls ?? 0) + 1;
          return 'privy-access-token';
        },
      };
    });
    await page.route(/\/(?:api\/)?auth\/privy-verify$/, async (route) => {
      const body = route.request().postDataJSON() as { accessToken?: string };
      expect(body.accessToken).toBe('privy-access-token');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          token: 'maze-session-token',
          user: { id: 'u_privy', email: 'privy@example.com', name: 'Privy User' },
        }),
      });
    });
    await page.route(/\/(?:api\/)?auth\/me(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          user: { id: 'u_privy', email: 'privy@example.com', name: 'Privy User' },
          balance: { balUsd: 0, earnUsd: 0, earnApy: 0 },
          earnConfig: { earnByDefault: false, autoDivestOnSpend: false, divestThresholdUsd: 0 },
        }),
      });
    });
    await page.route('**/api/balances', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          totalUsd: 0,
          buckets: {
            cash: { usd: 0, chain: 'base' },
            perps: { usd: 0, chain: 'arbitrum', sources: { arbitrum: 0, hyperliquidSpot: 0 } },
            predictions: { usd: 0, chain: 'polygon' },
            memes: { usd: 0, chain: 'solana' },
          },
          byChain: { base: 0, arbitrum: 0, polygon: 0, solana: 0, hyperliquidSpot: 0 },
          wallets: { evm: null, solana: null },
        }),
      });
    });
    await page.route(/\/(?:api\/)?ledger\/activity(?:\?|$)/, async (route) => {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activity: [] }) });
    });
    await page.route(/\/(?:api\/)?ledger\/activity\/stream(?:\?|$)/, async (route) => {
      await route.fulfill({ contentType: 'text/event-stream', body: '' });
    });
    await page.route(/\/(?:api\/)?spend\/monthly(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, month: '2026-06', totalUsd: 0, categories: [] }),
      });
    });
    await page.route(/\/(?:api\/)?ledger\/me(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          user: { id: 'u_privy', email: 'privy@example.com', name: 'Privy User' },
          kycStatus: 'none',
          balance: { balUsd: 0, earnUsd: 0 },
          virtualAccounts: {},
          wallet: {},
          card: null,
          earn: { apyBps: null, posUsd: 0 },
          agents: { count: 0, killSwitch: false },
        }),
      });
    });
    await page.route(/\/(?:api\/)?onramp\/deposit-address(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          bucket: 'memes',
          chain: 'solana',
          network: 'solana',
          address: 'So11111111111111111111111111111111111111112',
          walletId: 'wallet_privy_sol',
          tokens: ['USDC'],
          live: true,
        }),
      });
    });
    await page.route(/\/(?:api\/)?earn\/protocols(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          standard: { id: 'morpho', name: 'Morpho', available: false, apyBps: 0, tvlUsd: null },
          higherYield: { id: 'ethena', name: 'Ethena', available: false, apyBps: 0, tvlUsd: null },
          blendedApy: 0,
          adapters: [],
        }),
      });
    });
    await page.route(/\/(?:api\/)?markets\/hyperliquid\/builder-status(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          builder: {
            address: null,
            currentFeeTenthsBp: 0,
            currentFeeBps: 0,
            currentFeeRate: '0',
            capBps: 10,
          },
          user: {
            approved: true,
            approvedAt: new Date().toISOString(),
            approvedMaxFeeTenthsBp: 0,
            hasPrivyWallet: true,
          },
          needsApproval: false,
        }),
      });
    });
    await page.route(/\/(?:api\/)?earn\/ethena(?:\?|$)/, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, apyBps: 0, depositUrl: 'https://ethena.fi', riskCopy: '', readAt: new Date().toISOString() }),
      });
    });

    await bootAt(page);

    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.locator('#s08')).toHaveClass(/\bon\b/);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('nexa.session'))).toBe('maze-session-token');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __mazePrivyLoginCalls?: number }).__mazePrivyLoginCalls ?? 0))
      .toBe(1);
    await expect(page.locator('#kycBanner')).toBeHidden();
  });
});

test.describe('send flow', () => {
  test('keypad → recipient → confirm → sent updates ledger', async ({ page }) => {
    await bootAt(page, 's08');

    await page.locator('#s08 .qa', { hasText: 'Send' }).click();
    await expect(page.locator('#s10')).toHaveClass(/\bon\b/);

    await expect(page.locator('#amtGo')).toBeDisabled();
    await page.locator('#kpad button', { hasText: /^2$/ }).click();
    await page.locator('#kpad button', { hasText: /^0$/ }).click();
    await expect(page.locator('#amtGo')).toBeEnabled();
    await page.locator('#amtGo').click();

    await expect(page.locator('#sendStep2')).toBeVisible();
    await page.locator('[data-recip="bob@x.com"][data-new]:not(#recipTyped)').click();
    await expect(page.locator('#s11')).toHaveClass(/\bon\b/);
    await expect(page.locator('#cfTo')).toHaveText('bob@x.com');
    await expect(page.locator('#cfAmt')).toHaveText('$20.00');

    await page.locator('#sendNow').click();
    await expect(page.locator('#cfDone')).toBeVisible();
    await expect(page.locator('#cfDoneTxt')).toContainText('claim email');

    // email preview sheet
    await page.locator('#previewEmail').click();
    await expect(page.locator('#emailPreview')).toHaveClass(/\bon\b/);
    await expect(page.locator('#pvAmt')).toHaveText('$20.00');
    await page.getByRole('button', { name: 'Close preview' }).click();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('#s08')).toHaveClass(/\bon\b/);
    await expect(page.locator('#balEl')).toHaveText('$4,800.40');
    await expect(page.locator('#actList .tx-row').first()).toContainText('Sent · bob@x.com');
  });

  test('typed recipient appears as claim-link row', async ({ page }) => {
    await bootAt(page, 's10');
    await page.locator('#kpad button', { hasText: /^5$/ }).click();
    await page.locator('#amtGo').click();
    await page.locator('#recipInp').fill('alice@example.com');
    await expect(page.locator('#recipTyped')).toBeVisible();
    await expect(page.locator('#recipTypedT')).toHaveText('Send to alice@example.com');
    await expect(page.locator('#claimNote')).toBeVisible();
  });
});

test.describe('earn', () => {
  test('deposit moves balance into earn position', async ({ page }) => {
    await bootAt(page, 's14');
    await expect(page.locator('#earnPos')).toHaveText('$3,200.00');

    await page.getByRole('button', { name: 'Deposit', exact: true }).click();
    await expect(page.locator('#s15')).toHaveClass(/\bon\b/);
    await page.locator('#depKpad [data-depk="5"]').click();
    await page.locator('#depKpad [data-depk="0"]').click();
    await page.locator('#depKpad [data-depk="0"]').click();
    await expect(page.locator('#depGo')).toBeEnabled();
    await page.locator('#depGo').click();

    await expect(page.locator('#s14')).toHaveClass(/\bon\b/);
    await expect(page.locator('#earnPos')).toHaveText('$3,700.00');
    await expect(page.locator('.toast').last()).toContainText('now earning');
  });

  test('withdraw sheet returns funds to balance', async ({ page }) => {
    await bootAt(page, 's14');
    // The earn area gained a "Withdraw to bank" button alongside "Withdraw",
    // so target the exact label to avoid the role-name partial match.
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await expect(page.locator('#wdSheet')).toHaveClass(/\bon\b/);
    await page.locator('#wdGo').click();
    await expect(page.locator('#wdSheet')).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#reviewSheet')).toHaveClass(/\bon\b/);
    await page.locator('#reviewConfirmBtn').click();
    await expect(page.locator('#reviewSheet')).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#earnPos')).toHaveText('$2,700.00');
  });

  test('campaigns: join + claim payout', async ({ page }) => {
    await bootAt(page, 's14c');
    await expect(page.locator('#eseg2')).toBeVisible();

    const join = page.locator('[data-join2]').first();
    await join.click();
    await expect(join).toHaveText('JOINED ✓');

    await page.locator('#claimPay').click();
    await expect(page.locator('#claimRow')).toContainText('CLAIMED ✓');
  });

  test('payment link composer emits one-time link', async ({ page }) => {
    await bootAt(page, 's14c');
    await page.locator('#e2Go').click();
    await expect(page.locator('#e2Out')).toBeVisible();
    await expect(page.locator('#e2Link')).toContainText('maze.to/pay/');
  });
});

test.describe('swap', () => {
  test('renders the server quote and fee for supported live tokens', async ({ page, request }) => {
    const token = await demoSessionToken(request);
    const quoteCalls: string[] = [];
    await page.route('**/api/swap/quote**', async (route) => {
      const url = new URL(route.request().url());
      quoteCalls.push(url.search);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          amount: Number(url.searchParams.get('amount') ?? 0),
          direction: 'usd-eur',
          fromChain: 'base',
          toChain: 'base',
          fromToken: 'USDC',
          toToken: 'EURC',
          rate: 0.923456,
          out: 461.728,
          fees: 0.37,
          refuelGasUsd: null,
          source: 'lifi',
        }),
      });
    });
    await page.addInitScript((sessionToken) => {
      sessionStorage.setItem('nexa.session', sessionToken);
    }, token);

    await bootAt(page, 's16');
    await expect(page.locator('#swFromSym')).toHaveText('USDC');
    await expect(page.locator('#swToSym')).toHaveText('EURC');
    await expect(page.locator('#swOut')).toHaveText('461.73');
    await expect(page.locator('#swRate')).toHaveText('1 USDC = 0.923456 EURC');
    await expect(page.locator('#swFee')).toHaveText('$0.37');
    expect(quoteCalls.length).toBeGreaterThan(0);

    await page.locator('#swFlip').click();
    await expect(page.locator('#swFromSym')).toHaveText('EURC');
    await expect(page.locator('#swToSym')).toHaveText('USDC');

    await page.locator('#swToBtn').click();
    await expect(page.locator('#tokenSheet')).toHaveClass(/\bon\b/);
    await expect(page.locator('#tokenList')).toContainText('EURC');
    await expect(page.locator('#tokenList')).toContainText('EURe');
    await expect(page.locator('#tokenList')).toContainText('USD Coin on Solana');
    await expect(page.locator('#tokenList')).toContainText('Marinade staked SOL');
  });
});

test.describe('brand marks', () => {
  test('renders inline brand SVGs with real geometry', async ({ page }) => {
    for (const { screen, count } of [
      { screen: 's09', count: 0 },
      { screen: 's17', count: 0 },
      { screen: 's24', count: 1 },
    ]) {
      await bootAt(page, screen);
      await expect(page.locator(`#${screen} [data-brand] svg`)).toHaveCount(count);
      const boxes = await page.locator(`#${screen} [data-brand] path`).evaluateAll((paths) =>
        paths.map((path) => {
          if (!(path instanceof SVGGraphicsElement)) return { width: 0, height: 0 };
          const box = path.getBBox();
          return { width: box.width, height: box.height };
        }),
      );
      for (const box of boxes) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
      }
    }
  });
});

test.describe('card', () => {
  test('reveal does not synthesize a PAN when card details are unavailable', async ({ page }) => {
    await bootAt(page, 's17');
    await page.locator('#revealBtn').click();
    await expect(page.locator('.toast.err').last()).toContainText('unavailable');
    await expect(page.locator('#vPan')).toHaveText('Card not issued');
    await expect(page.locator('#vPan')).not.toHaveText('4929 1182 0034 4406');
  });

  test('freeze blocks reveal and greys card', async ({ page }) => {
    await bootAt(page, 's17');
    await page.locator('#freezeBtn2').click();
    await expect(page.locator('#vCard')).toHaveClass(/frozen/);
    await expect(page.locator('#freezeBtn2')).toHaveText('UNFREEZE');

    await page.locator('#revealBtn').click();
    await expect(page.locator('.toast.err').last()).toContainText('frozen');
  });

  test('card settings: limit sheet + merchant rules', async ({ page }) => {
    await bootAt(page, 's18');
    await page.locator('[data-open="limitSheet"]').click();
    await expect(page.locator('#limitSheet')).toHaveClass(/\bon\b/);
    await page.locator('#limSave').click();
    await expect(page.locator('#limitSheet')).not.toHaveClass(/\bon\b/);

    await page.locator('[data-open="merchSheet"]').click();
    const gambling = page.locator('#merchSheet .sw[aria-label="Gambling"]');
    await expect(gambling).toHaveAttribute('aria-checked', 'false');
    await gambling.click();
    await expect(gambling).toHaveAttribute('aria-checked', 'true');
    await page.locator('#merchDone').click();
  });
});

test.describe('agents', () => {
  test('kill switch pauses every agent pill', async ({ page }) => {
    await bootAt(page, 's19');
    await expect(page.locator('#agStatus')).toHaveText(/ACTIVE/);
    await page.locator('#killSw').click();
    await expect(page.locator('#agStatus')).toHaveText('PAUSED');
    await expect(page.locator('[data-agpill]').first()).toHaveText('PAUSED');
    await page.locator('#killSw').click();
    await expect(page.locator('#agStatus')).toHaveText(/ACTIVE/);
  });

  test('create agent adds policy row', async ({ page }) => {
    await bootAt(page, 's19');
    await page.getByRole('button', { name: '+ CREATE' }).click();
    await expect(page.locator('#s20')).toHaveClass(/\bon\b/);
    await page.locator('#agName').fill('TestAgent-99');
    await page.locator('#agCreate').click();
    await expect(page.locator('#s19')).toHaveClass(/\bon\b/);
    await expect(page.locator('#agentList')).toContainText('TestAgent-99');
    await expect(page.locator('#agentList')).toContainText('NOT FUNDED');
  });

  test('fund agent resets weekly meter', async ({ page }) => {
    await bootAt(page, 's21');
    await page.locator('#fundGo').click();
    await expect(page.locator('#s19')).toHaveClass(/\bon\b/);
    await expect(page.locator('#agSpent')).toHaveText('$0.00');
  });

  test('agent activity: approve releases held payment', async ({ page }) => {
    await bootAt(page, 's22');
    await page.locator('#agApprove').click();
    await expect(page.locator('#agFeed')).toContainText('Released $2.40');
  });

  test('ops review sheet approve flips agent live', async ({ page }) => {
    await bootAt(page, 's19');
    await page.locator('[data-open="opsSheet"]').click();
    await expect(page.locator('#opsSheet')).toHaveClass(/\bon\b/);
    await page.locator('#opsApprove').click();
    await expect(page.locator('#opsTag')).toHaveText('LIVE');
    await expect(page.locator('#opsSub')).toContainText('VENDOR PAYMENTS OK');
  });

  test('mcp connect reveals scoped key', async ({ page }) => {
    await bootAt(page, 's24');
    await expect(page.locator('#apiKey')).toContainText('••••');
    await page.locator('#keyReveal').click();
    await expect(page.locator('#apiKey')).toHaveText('<paste-your-agent-key>');
    await expect(page.locator('#mcpCfg')).toContainText(`${WEB_ORIGIN}/api/mcp`);
    await expect(page.locator('#mcpCfg')).not.toContainText('nx_live_7f3k_demo');
    await expect(page.locator('#directApiCfg')).toContainText(`${WEB_ORIGIN}/api/v1/agent/pay`);
    await expect(page.locator('#directApiCfg')).not.toContainText('api.nexa.aiso.tools');
  });
});

test.describe('profile + theme', () => {
  test('dark mode flips stage theme; agents reachable from profile', async ({ page }) => {
    await bootAt(page, 's08');
    await openMore(page);
    await expect(page.locator('#s26')).toHaveClass(/\bon\b/);
    await page.locator('#moreProfile').click();
    const profileDialog = page.getByRole('dialog', { name: 'Profile' });
    await expect(profileDialog).toBeVisible();

    await page.locator('#themeSw').click();
    await expect(page.locator('#stage')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#themeLbl')).toHaveText('DARK');
    await expect(profileDialog).toBeVisible();

    // Agents row navigates and closes the sheet (prototype dead-end fix)
    await profileDialog.getByRole('button', { name: 'Open Agents settings' }).click();
    await expect(page.locator('#s19')).toHaveClass(/\bon\b/);
    await expect(page.locator('#profileSheet')).not.toHaveClass(/\bon\b/);
  });
});

test.describe('add money', () => {
  test('card rail owns a single visible checkout control', async ({ page }) => {
    await bootAt(page, 's09', { demoLedger: false });
    await page.locator('[data-addrail="card"]').click();

    await expect(page.locator('#addRailDetail #onrampStripeBtn')).toBeVisible();
    await expect(page.locator('#onrampStripeBtn')).toHaveCount(1);
    await expect(page.locator('#applepayBtn')).toHaveCount(0);
  });

  test('signed-out top-up does not mutate the local balance', async ({ page }) => {
    await bootAt(page, 's09', { demoLedger: false });
    await page.locator('[data-addrail="card"]').click();
    await expect(page.locator('#addRailDetail #onrampStripeBtn')).toBeVisible();
    await page.locator('#addRailDetail #onrampStripeBtn').click();
    await expect(page.locator('.toast.err').last()).toContainText('Sign in');
    await page.locator('#tabbar [data-tabgo="home"]').click();
    await expect(page.locator('#balEl')).toHaveText('—');
    await expect(page.locator('#actList .tx-row')).toHaveCount(0);
  });
});

test.describe('bucket transfers', () => {
  test('move money posts through the API proxy with auth and idempotency', async ({ page }) => {
    await page.route('**/api/balances', async (route) => {
      expect(route.request().headers()['authorization']).toBe('Bearer xfer-test-token');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          totalUsd: 100,
          buckets: {
            cash: { usd: 100, chain: 'base' },
            perps: { usd: 15.118582, chain: 'arbitrum', sources: { arbitrum: 0, hyperliquidSpot: 15.118582 } },
            predictions: { usd: 0, chain: 'polygon' },
            memes: { usd: 0, chain: 'solana' },
            'stocks-spot': { usd: 3.5, chain: 'solana' },
          },
          byChain: { base: 100, arbitrum: 0, polygon: 0, solana: 0, hyperliquidSpot: 15.118582 },
          wallets: { evm: '0x1111111111111111111111111111111111111111', solana: '11111111111111111111111111111111' },
        }),
      });
    });
    await page.route('**/api/transfers/tr_e2e', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, transfer: { id: 'tr_e2e', status: 'created' }, events: [] }),
      });
    });
    await page.route('**/api/transfers/internal', async (route) => {
      const headers = route.request().headers();
      expect(headers['authorization']).toBe('Bearer xfer-test-token');
      expect(headers['idempotency-key']).toMatch(/^xfer-/);
      expect(route.request().postDataJSON()).toEqual({ fromBucket: 'cash', toBucket: 'stocks-spot', amountUsd: 25 });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, transferId: 'tr_e2e', status: 'created' }),
      });
    });

    await bootAt(page, 's25', { demoLedger: false });
    await page.evaluate(() => {
      sessionStorage.setItem('nexa.session', 'xfer-test-token');
    });
    await page.locator('#s25 [data-go="s32"]').click();
    await expect(page.locator('#s32')).toHaveClass(/\bon\b/);
    await expect(page.locator('[data-xfer-bal="cash"]')).toHaveText('$100.00');
    await expect(page.locator('[data-xfer-bal="perps"]')).toHaveText('$15.12');
    await expect(page.locator('[data-xfer-bal="stocks-spot"]')).toHaveText('$3.50');
    await expect(page.locator('[data-xfer-sub="perps"]').first()).toHaveText('ARBITRUM + HL SPOT · USDC');
    await page.locator('#xferToList [data-xfer-to="stocks-spot"]').click();
    await expect(page.locator('#xferRailLabel')).toHaveText('mayan');
    await page.locator('#xferAmount').fill('25');
    await expect(page.locator('#xferSubmitBtn')).toBeEnabled();
    await page.locator('#xferSubmitBtn').click();
    await expect(page.locator('#xferIdLabel')).toHaveText('tr_e2e');
  });
});

test.describe('activity detail', () => {
  test('tapping a tx opens human-readable detail with advanced drawer', async ({ page }) => {
    await bootAt(page, 's08');
    await page.locator('#actList .tx-row').first().click();
    await expect(page.locator('#s13')).toHaveClass(/\bon\b/);
    await expect(page.locator('#adName')).toHaveText('Salary · Acme Studio');
    await expect(page.locator('#adAmt')).toHaveText('+$2,400.00');
    await expect(page.locator('#adRef')).toHaveText(/NX-\d+-\d+/);
    await page.locator('#s13 .adv summary').click();
    await expect(page.locator('#adAdv')).toContainText('USDC on Base');
  });

  test('live row detail shows venue signer tx hash and explorer link', async ({ page, request }) => {
    const token = await demoSessionToken(request);
    await page.route('**/ledger/me**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          user: { id: 'u_activity', email: 'activity@example.com', name: 'Activity' },
          balance: { balUsd: 10, earnUsd: 0, earnApy: 0 },
          virtualAccounts: {},
          wallet: { baseAddress: '0x1111111111111111111111111111111111111111' },
          card: null,
          earn: { apyBps: null, posUsd: 0 },
          agents: { count: 0, killSwitch: false },
        }),
      });
    });
    await page.route('**/ledger/activity**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          activity: [
            {
              id: 'act_live_1',
              n: 'BTC long opened',
              s: 'SUBMITTED · JUST NOW',
              a: '-$1.00',
              k: 'swap',
              at: '2026-06-20T12:34:56.000Z',
              status: 'submitted',
              venue: 'Hyperliquid',
              signer: '0x2222222222222222222222222222222222222222',
              txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              chain: 'base',
            },
          ],
        }),
      });
    });
    await page.addInitScript((sessionToken) => {
      sessionStorage.setItem('nexa.session', sessionToken);
    }, token);

    await bootAt(page, 's29', { demoLedger: false });
    await page.locator('#actListFull .tx-row').first().click();

    await expect(page.locator('#adTag')).toHaveText('SUBMITTED');
    await expect(page.locator('#adVenue')).toHaveText('Hyperliquid');
    await expect(page.locator('#adSigner')).toHaveText('0x2222…2222');
    await expect(page.locator('#adRef')).toHaveText('0xaaaa…aaaa');
    await expect(page.locator('#adExplorer')).toHaveAttribute('href', /basescan\.org\/tx\/0xaaaa/);
    await page.locator('#s13 .adv summary').click();
    await expect(page.locator('#adAdv')).toContainText('tx 0xaaaaaaaa');
  });
});

test('visual baseline screenshots', async ({ page }) => {
  await bootAt(page, 's08');
  await page.screenshot({ path: 'test-results/app-home.png', fullPage: false });
  await bootAt(page, 's17');
  await page.screenshot({ path: 'test-results/app-card.png', fullPage: false });
  await bootAt(page, 's19');
  await page.screenshot({ path: 'test-results/app-agents.png', fullPage: false });
});

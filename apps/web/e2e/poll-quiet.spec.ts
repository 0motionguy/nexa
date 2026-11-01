/**
 * PLANB fluid-UI W2 contract — no polling storms:
 *  - With the SSE activity stream healthy, the ledger refetch runs on the
 *    15s floor: a 12s idle window on Home sees at most 2 /ledger/me reads
 *    (the entry sync plus at most one timer tick).
 *  - A hidden tab is network-quiet: zero ledger reads while document.hidden.
 *
 * Bounds are deliberately generous — the pre-W2 behavior (4s blanket poll)
 * produced 3-4 reads per 12s window and kept polling while hidden, so any
 * regression trips these limits with margin.
 */

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = `http://localhost:${process.env['NEXA_API_PORT'] ?? 8090}`;

async function demoSessionToken(request: APIRequestContext, email: string): Promise<string> {
  const start = await request.post(`${API}/auth/start`, { data: { email } });
  const { challengeId } = (await start.json()) as { challengeId: string };
  const verify = await request.post(`${API}/auth/verify`, {
    data: { challengeId, code: '482019' },
  });
  const { token } = (await verify.json()) as { token: string };
  return token;
}

async function bootLiveHome(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    try {
      sessionStorage.setItem('nexa.session', t);
      sessionStorage.removeItem('nexa.localDemoLedger');
    } catch {
      /* ignore */
    }
  }, token);
  await page.goto('/app.html?motion=off#s08');
  await page.waitForSelector('#s08.scr.on', { timeout: 15_000 });
}

function countLedgerReads(page: Page): { count: () => number; reset: () => void } {
  let n = 0;
  page.on('request', (r) => {
    if (r.url().includes('/ledger/me')) n += 1;
  });
  return { count: () => n, reset: () => { n = 0; } };
}

test('SSE-healthy Home idles at the 15s ledger cadence', async ({ page, request }, testInfo) => {
  const token = await demoSessionToken(request, `poll-quiet-${testInfo.project.name}@maze.test`);
  const reads = countLedgerReads(page);
  await bootLiveHome(page, token);
  // Let the entry sync + stream settle, then measure a quiet window.
  await page.waitForTimeout(2_000);
  reads.reset();
  await page.waitForTimeout(12_000);
  expect(reads.count()).toBeLessThanOrEqual(2);
});

test('hidden tabs are ledger-quiet', async ({ page, request }, testInfo) => {
  const token = await demoSessionToken(request, `poll-hidden-${testInfo.project.name}@maze.test`);
  const reads = countLedgerReads(page);
  await bootLiveHome(page, token);
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  reads.reset();
  await page.waitForTimeout(9_000);
  expect(reads.count()).toBe(0);
});

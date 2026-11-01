import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('app-main market position polling', () => {
  function sliceBetween(source: string, start: string, end: string): string {
    const startIdx = source.indexOf(start);
    const endIdx = source.indexOf(end, startIdx + start.length);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    return source.slice(startIdx, endIdx);
  }

  it('keeps trade-screen position polling on the backed-off cadence', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');

    expect(source).toContain('const HL_POSITIONS_POLL_INTERVAL_MS = 30_000');
    // ADR-0004 part 2 wrapped the timer body in a stream-freshness gate. Pin
    // the EXECUTABLE gate, not just names near it: while the account stream
    // is fresh the poll stretches (never stops — resting orders only exist
    // in the REST list), and the interval still binds to the 30s constant.
    const timer = sliceBetween(
      source,
      'hlPositionsTimer = setInterval(',
      'HL_POSITIONS_POLL_INTERVAL_MS);',
    );
    expect(timer).toContain('Date.now() - lastAccountStreamAt < ACCOUNT_STREAM_FRESH_MS');
    expect(timer).toContain('Date.now() - lastHlPositionsFetchAt < STREAM_POLL_STRETCH_MS');
    expect(timer).toContain(') return;');
    expect(timer).toContain('void hydrateHlPositions()');
    expect(source).not.toContain('setInterval(() => void hydrateHlPositions(), 5000)');
  });

  it('does not hydrate prediction markets directly from Gamma in the browser', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');

    expect(source).toContain('nexaApi.markets.polymarket.list');
    expect(source).not.toContain('https://gamma-api.polymarket.com/events');
  });

  it('keeps market order submit buttons locked during 429 backoff', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');

    expect(source).toContain('function orderSubmitRateLimitMs');
    expect(source).toContain('function lockSubmitButtonForRateLimit');
    expect(source.match(/rateLimitLockMs = orderSubmitRateLimitMs\(e\);/g)).toHaveLength(3);
    expect(source).toContain("lockSubmitButtonForRateLimit(btn, 'Place order', rateLimitLockMs)");
    expect(source).toContain('lockSubmitButtonForRateLimit(cta, label, rateLimitLockMs)');
  });

  it('reuses idempotency keys for uncertain earn deposit and withdraw retries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');

    expect(source).toContain('let earnDepositAttempt: OrderAttemptKey | null = null');
    expect(source).toContain('earnDepositAttempt = idempotencyKeyFor(earnDepositAttempt, fingerprint)');
    expect(source).toContain('nexaApi.earnDeposit(v, undefined, { idempotencyKey })');
    expect(source).toContain('let earnWithdrawAttempt: OrderAttemptKey | null = null');
    expect(source).toContain('earnWithdrawAttempt = idempotencyKeyFor(earnWithdrawAttempt, fingerprint)');
    expect(source).toContain('nexaApi.earnWithdraw(v, undefined, { idempotencyKey })');
  });

  it('reuses idempotency keys for uncertain agent funding retries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');

    expect(source).toContain('let agentFundAttempt: OrderAttemptKey | null = null');
    expect(source).toContain('agentFundAttempt = idempotencyKeyFor(agentFundAttempt, fingerprint)');
    expect(source).toContain("nexaApi.agentFund('ResearchBot-01', v, { idempotencyKey })");
    expect(source).toContain('let agentApproveAttempt: OrderAttemptKey | null = null');
    expect(source).toContain('agentApproveAttempt = idempotencyKeyFor(agentApproveAttempt, fingerprint)');
    expect(source).toContain("nexaApi.approveOnce('ResearchBot-01', 'dataset.vendor.io/v1/access', 2.4, 'dataset access', { idempotencyKey })");
  });

  it('reuses idempotency keys for uncertain bridge withdraw retries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');

    expect(source).toContain('let bridgeWithdrawAttempt: OrderAttemptKey | null = null');
    expect(source).toContain('const fingerprint = `bridge-withdraw:${id}:${v.toFixed(2)}`');
    expect(source).toContain('bridgeWithdrawAttempt = idempotencyKeyFor(bridgeWithdrawAttempt, fingerprint)');
    expect(source).toContain('const idempotencyKey = bridgeWithdrawAttempt.idempotencyKey');
    expect(source).toContain('.bridgeWithdraw({ payoutMethodId: id, amountUsd: v }, { idempotencyKey })');
    expect(source).toContain('if (bridgeWithdrawAttempt?.idempotencyKey === idempotencyKey) bridgeWithdrawAttempt = null');
  });

  it('exposes canonical close actions for resting Polymarket positions', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const cancellable = sliceBetween(
      source,
      'function isCancellableMarketPosition(p: MarketPositionWire): boolean',
      'let hlPositionsTimer',
    );

    expect(cancellable).toContain("p.venue === 'polymarket'");
    expect(cancellable).toContain('CANCELLABLE_MARKET_POSITION_STATUSES.has(p.status)');
  });

  it('purges market row registries before clearing market hosts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const hl = sliceBetween(source, 'function renderHlMarkets(', 'function hlInfoCoin(');
    const memes = sliceBetween(source, 'function renderJupMemes(', 'async function fetchJupiterMemes(');
    const xstocks = sliceBetween(source, 'function renderXStocks(', 'function renderActiveTradeTab(');

    expect(hl.indexOf("purgeHlMarketRowsFromHost(hostId, 'nexa-market-row');")).toBeLessThan(
      hl.indexOf("host.textContent = '';"),
    );
    expect(memes.indexOf("purgeMarketRowsFromHost('jupMemesMarketsList', '.lrow', 'data-jup-mint', jupPriceRowsByMint);")).toBeLessThan(
      memes.indexOf("host.textContent = '';"),
    );
    expect(xstocks.indexOf("purgeMarketRowsFromHost('xStocksSpotMarketsList', '.lrow', 'data-jup-mint', jupPriceRowsByMint);")).toBeLessThan(
      xstocks.indexOf("host.textContent = '';"),
    );
  });

  it('reconciles HL market rows in place instead of rebuilding the host', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const hl = sliceBetween(source, 'function renderHlMarkets(', 'function hlInfoCoin(');

    // PLANB fluid-UI W1: populated renders patch keyed rows in place; only
    // the empty branch clears the host. Removals must release hub subs.
    expect(hl).toContain('reconcileKeyedList(host, markets.slice(0, shown)');
    expect(hl).toContain("rowSelector: 'nexa-market-row'");
    expect(hl).toContain('hlPriceRowsRemove(key, row)');
    expect(hl).toContain("paintListSkeleton(host, 'market-row')");
  });

  it('keeps prediction caches scoped to the selected category', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const categoryHydrate = sliceBetween(source, 'async function hydratePmCategoryImpl', 'function renderJupMemes');
    const fullHydrate = sliceBetween(source, 'async function hydrateMarketsImpl', '/* ── Sprint 15');
    const activeRender = sliceBetween(source, 'function renderActiveTradeTab', '// Category filter pills');

    expect(source).toContain("let predictionsCacheCategory = ''");
    expect(source).toContain('function cachedPredictionsForCategory(slug: string): PmEvent[] | null');
    expect(categoryHydrate).toContain("renderPmEvents(cachedPredictionsForCategory(slug) ?? [], 'unavailable')");
    expect(fullHydrate).toContain('const predictionCategory = activePmCategory;');
    expect(fullHydrate).toContain('predictionsCacheCategory = predictionCategory;');
    expect(activeRender).toContain('const predictionEvents = cachedPredictionsForCategory(activePmCategory);');
  });

  it('backs off failed market hydrates and reports cooldown refresh skips', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const backoff = sliceBetween(source, 'function marketHydrateBackoffMs', 'function hydrateMarkets');
    const hydrate = sliceBetween(source, 'function hydrateMarkets', '/* Cached results');
    const refresh = sliceBetween(source, 'function bindRefreshButton', "bindRefreshButton('homeRefreshBtn'");

    expect(source).toContain('const MARKET_HYDRATE_FAILURE_COOLDOWN_MS = 5_000');
    expect(backoff).toContain('failures === results.length');
    expect(hydrate).toContain('new MarketRefreshCooldownError');
    expect(refresh).toContain('Rate limited or unavailable. Retry in');
  });

  it('gates pollers on document.hidden and stretches ledger cadence when SSE is healthy', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const liveSync = sliceBetween(source, 'function startLiveSync()', 'function openStream()');
    const jup = sliceBetween(source, 'async function refreshJupPrices()', 'function stopJupPricePoll');
    const vis = sliceBetween(source, "onGlobal(document, 'visibilitychange'", 'interface ReviewRow');

    // PLANB fluid-UI W2: hidden tabs are network-quiet; SSE-healthy sessions
    // sync on events with a 15s floor instead of a blanket 4s refetch.
    expect(source).toContain('const LIVE_SYNC_BASE_MS = 5_000');
    expect(source).toContain('const LIVE_SYNC_SSE_IDLE_MS = 15_000');
    expect(liveSync).toContain('if (document.hidden) return;');
    expect(liveSync).toContain('sseHealthy && Date.now() - lastLedgerSyncAt < LIVE_SYNC_SSE_IDLE_MS');
    expect(jup).toContain('if (document.hidden) return;');
    expect(vis).toContain('stopJupPricePoll();');
    expect(vis).toContain('stopHlPositionsPoll();');
    expect(vis).toContain('syncTradeVenueLiveStreams();');
  });

  it('dedupes live account sync and backs off 429s', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const syncWrapper = sliceBetween(source, 'function syncFromServer()', 'async function syncFromServerImpl');
    const syncImpl = sliceBetween(source, 'async function syncFromServerImpl', '/** Sprint 10 Item A');

    expect(source).toContain('const LIVE_SYNC_RATE_LIMIT_BACKOFF_MS = 30_000');
    expect(source).toContain('let syncFromServerInflight: Promise<void> | null = null');
    expect(source).toContain('let syncFromServerCooldownUntil = 0');
    expect(syncWrapper).toContain('if (syncFromServerInflight) return syncFromServerInflight');
    expect(syncWrapper).toContain('Date.now() < syncFromServerCooldownUntil');
    expect(syncImpl).toContain("e.status === 429 || e.code === 'too_many_requests'");
    expect(syncImpl).toContain('syncFromServerCooldownUntil = Date.now() + rateLimitBackoffMs(e, LIVE_SYNC_RATE_LIMIT_BACKOFF_MS)');
  });

  it('debounces swap quote refreshes from amount typing', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const swapQuote = sliceBetween(source, 'let swapQuoteSeq = 0;', '/* Slippage chips on s16');

    expect(source).toContain('const SWAP_QUOTE_INPUT_DEBOUNCE_MS = 300');
    expect(swapQuote).toContain('let swapQuoteDebounceTimer: number | null = null');
    expect(source).toContain('function scheduleSwapQuoteRefresh()');
    expect(source).toContain('window.clearTimeout(swapQuoteDebounceTimer)');
    expect(source).toContain("on($('#swAmt'), 'input', scheduleSwapQuoteRefresh)");
    expect(source).not.toContain("on($('#swAmt'), 'input', swRender)");
  });

  it('backs off Jupiter row price polling on provider failures, not only 429s', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const refresh = sliceBetween(source, 'async function refreshJupPrices()', 'function stopJupPricePoll');

    expect(source).toContain('const JUP_PRICE_PROVIDER_ERROR_BACKOFF_MS = 30_000');
    expect(refresh).toContain("e.status === 429 || e.code === 'too_many_requests'");
    expect(refresh).toContain('e.status === 408 || e.status >= 500');
    expect(refresh).toContain('JUP_PRICE_PROVIDER_ERROR_BACKOFF_MS');
  });

  it('releases stale prediction live-price subscriptions', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const render = sliceBetween(source, 'function renderPmEvents', 'function openPolymarketOrderForOutcome');
    const socket = sliceBetween(source, 'function openPmCloblSocket', 'function schedulePmWsReconnect');

    expect(render).toContain('closePmCloblSocket();');
    expect(socket).toContain("operation: 'unsubscribe'");
    expect(socket).toContain('removedTokens');
  });

  it('threads copy-trade attribution from the top-traders strip into orders', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const laneC = sliceBetween(source, 'function renderPmTopTraders', 'function openHyperliquidOrder');
    const openPm = sliceBetween(source, 'function openPolymarketOrder(', 'function syncPmPayout');

    // Lane C: strip renders Copy buttons keyed by wallet; hydrate is TTL-gated;
    // every non-copy sheet open clears stale attribution; the order body only
    // carries copiedFrom while a copy is active.
    expect(laneC).toContain("copy.setAttribute('data-copy-trader', t.wallet)");
    expect(laneC).toContain('pmCopySource = intent.wallet;');
    expect(source).toContain('const PM_TRADERS_TTL_MS = 300_000');
    expect(openPm).toContain('pmCopySource = null;');
    expect(source).toContain('...(pmCopySource ? { copiedFrom: pmCopySource } : {})');
    expect(source).toContain('void hydratePmTopTraders();');
  });

  it('renders cards-position outages instead of hiding ownership state', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app-main.ts'), 'utf8');
    const positions = sliceBetween(source, 'function renderCardsPositions', 'function findCollectorCard');

    expect(positions).toContain("status === 'unavailable'");
    expect(positions).toContain("Couldn't load cards.");
    expect(positions).toContain("Couldn't load latest cards.");
    expect(positions).toContain('Showing cached rows');
  });
});

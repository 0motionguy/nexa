/**
 * lib/cohorts.mjs — realistic traffic cohorts (spec point 2). Route
 * paths below are all confirmed against apps/api/src/routes/markets.ts,
 * routes/me.ts, routes/ledger.ts (grep-verified, not guessed).
 *
 * Public topic grammar: `<kind>:<venue>:<symbol>[:<param>]`
 *   (apps/api/src/realtime/topic.ts). Private topic grammar:
 *   `priv:<userId>:<orders|account|fills>`.
 */

/** Top-12 majors fallback — used when the live HL catalog can't be
 * sampled (network hiccup, unexpected shape, or the self-test stub).
 * Mirrors SCALE-PLAN-10K.md's "top-12 majors" traffic-model convention. */
export const FALLBACK_HL_COINS = Object.freeze([
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'ARB', 'OP', 'SUI', 'APT', 'NEAR',
]);

export const DEFAULT_COHORT_WEIGHTS = Object.freeze({
  'markets-browser': 55,
  'authed-trader': 20,
  'portfolio-only': 10,
  predictions: 10,
  'write-cohort': 5,
});

/**
 * Parse --mix "cohort=weight,cohort=weight,...". Unlisted cohorts keep
 * their default weight. Values need not sum to 100 — pickCohort()
 * normalizes against the running total.
 */
export function resolveMix(mixString) {
  const weights = { ...DEFAULT_COHORT_WEIGHTS };
  if (!mixString) return weights;
  for (const pair of mixString.split(',')) {
    const [name, w] = pair.split('=').map((s) => s.trim());
    if (!name) continue;
    if (!(name in DEFAULT_COHORT_WEIGHTS)) {
      throw new Error(`--mix: unknown cohort "${name}" — expected one of ${Object.keys(DEFAULT_COHORT_WEIGHTS).join(', ')}`);
    }
    const n = Number(w);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--mix: weight for "${name}" must be a non-negative number, got "${w}"`);
    weights[name] = n;
  }
  return weights;
}

/** Fold the write-cohort's weight into markets-browser (the largest,
 * safest, read-only cohort) when writes are disabled, so the remaining
 * cohorts still sum to the original total instead of silently losing 5%
 * of simulated traffic. */
export function foldOutWriteCohort(weights) {
  const out = { ...weights };
  const w = out['write-cohort'] ?? 0;
  out['write-cohort'] = 0;
  out['markets-browser'] = (out['markets-browser'] ?? 0) + w;
  return out;
}

/** Weighted-random cohort pick. `weights` need not sum to 100. */
export function pickCohort(weights, rng = Math.random) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) throw new Error('pickCohort: all cohort weights are zero');
  let r = rng() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

/** Read-route families per cohort. `dynamic` entries are resolved at run
 * time against sampled catalog ids (see run.mjs's catalog cache). */
export const COHORT_READS = Object.freeze({
  'markets-browser': Object.freeze([
    '/markets/hyperliquid',
    '/markets/hyperliquid/all-mids',
    '/markets/hyperliquid-spot?limit=100',
    '/markets/polymarket?view=compact&limit=40',
    { dynamic: 'hyperliquid-detail' },
    { dynamic: 'polymarket-detail' },
  ]),
  'authed-trader': Object.freeze([
    '/me/profile',
    '/markets/portfolio/summary',
    '/markets/positions',
    '/markets/orders',
    '/markets/fills',
  ]),
  'portfolio-only': Object.freeze([
    '/markets/portfolio/summary',
    '/ledger/activity',
  ]),
  predictions: Object.freeze([
    '/markets/polymarket?view=compact&limit=40',
    { dynamic: 'polymarket-detail' },
  ]),
  'write-cohort': Object.freeze([
    '/me/profile',
    '/markets/portfolio/summary',
  ]),
});

/** WS behavior policy per cohort: topic count range + whether private
 * (priv:<userId>:*) topics are included. `null` policy => no WS (spec:
 * portfolio-only is poll-only). */
export const COHORT_WS_POLICY = Object.freeze({
  'markets-browser': Object.freeze({ topicsRange: [5, 12], private: false }),
  'authed-trader': Object.freeze({ topicsRange: [10, 20], private: true }),
  'portfolio-only': null,
  predictions: Object.freeze({ topicsRange: [5, 10], private: false, predictionsOnly: true }),
  'write-cohort': Object.freeze({ topicsRange: [10, 20], private: true }),
});

/** Portfolio-only cohort polls every 30s (spec point 2: "portfolio poll
 * every 30s + activity") instead of hammering continuously. */
export const PORTFOLIO_POLL_INTERVAL_MS = 30_000;

/** Route switching cadence (spec point 3: "route switching every 30-120s"). */
export const ROUTE_SWITCH_MIN_MS = 30_000;
export const ROUTE_SWITCH_MAX_MS = 120_000;

/** Background/resume + flaky-reconnect population fractions (spec point 3). */
export const BACKGROUND_RESUME_FRACTION = 0.25;
export const FLAKY_RECONNECT_FRACTION = 0.05;
export const BACKGROUND_RESUME_DELAY_RANGE_MS = [10_000, 60_000];

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Pick N distinct random items from an array (no replacement when
 * possible; falls back to with-replacement if N > array length). */
function sampleN(rng, arr, n) {
  if (!arr.length) return [];
  if (n >= arr.length) return [...arr];
  const pool = [...arr];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Build the WS topic list for one VU given its cohort + a catalog cache
 * ({ hlCoins: string[], pmIds: string[] }) + userId (for private topics).
 */
export function buildTopicsForCohort(cohortName, catalog, userId, rng = Math.random) {
  const policy = COHORT_WS_POLICY[cohortName];
  if (!policy) return [];
  const count = randInt(rng, policy.topicsRange[0], policy.topicsRange[1]);
  const topics = [];
  const hlCoins = catalog.hlCoins?.length ? catalog.hlCoins : FALLBACK_HL_COINS;

  if (policy.predictionsOnly) {
    const ids = catalog.pmIds?.length ? catalog.pmIds : [];
    for (const id of sampleN(rng, ids, count)) topics.push(`predictions:pm:${id}`);
  } else {
    const kinds = ['ticker', 'book', 'trades'];
    const publicSlots = policy.private ? Math.max(1, count - 3) : count;
    const coins = sampleN(rng, hlCoins, Math.min(publicSlots, hlCoins.length));
    let i = 0;
    while (topics.length < publicSlots && coins.length) {
      const coin = coins[i % coins.length];
      const kind = kinds[i % kinds.length];
      // Real clients always request book depth (r4 finding: depthless book
      // topics exercised a server default path no production client uses).
      topics.push(kind === 'book' ? `book:hl:${coin}:10` : `${kind}:hl:${coin}`);
      i += 1;
      if (i > publicSlots * 2) break; // safety valve against tiny coin pools
    }
  }

  if (policy.private && userId) {
    topics.push(`priv:${userId}:orders`, `priv:${userId}:account`, `priv:${userId}:fills`);
  }
  return topics;
}

/** Resolve a `{ dynamic }` read-route entry against the catalog cache.
 * Returns null if the catalog has nothing to sample yet (falls back to
 * a static path by the caller). */
export function resolveDynamicRead(entry, catalog, rng = Math.random) {
  if (entry.dynamic === 'hyperliquid-detail') {
    const coins = catalog.hlCoins?.length ? catalog.hlCoins : FALLBACK_HL_COINS;
    const coin = coins[Math.floor(rng() * coins.length)];
    return `/markets/hyperliquid/${encodeURIComponent(coin)}`;
  }
  if (entry.dynamic === 'polymarket-detail') {
    if (!catalog.pmIds?.length) return null;
    const id = catalog.pmIds[Math.floor(rng() * catalog.pmIds.length)];
    return `/markets/polymarket/${encodeURIComponent(id)}`;
  }
  return null;
}

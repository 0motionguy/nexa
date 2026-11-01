#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, 'docs', 'probes');
const IN_PROCESS = process.env.PLANB_IN_PROCESS === '1';
const API_BASE = IN_PROCESS ? 'in-process' : (process.env.PLANB_API_BASE ?? process.env.NEXA_API_BASE ?? 'https://nexa.aiso.tools/api').replace(/\/+$/, '');
const AUTH_TOKEN = process.env.PLANB_AUTH_TOKEN ?? process.env.NEXA_AUTH_TOKEN ?? process.env.NEO_AUTH_TOKEN ?? process.env.AUTH_TOKEN ?? '';
const EMAIL = process.env.PLANB_AUTH_EMAIL ?? `planb-probe-${Date.now()}@example.com`;
const OTP = process.env.PLANB_DEMO_OTP_CODE ?? process.env.NEXA_DEMO_OTP_CODE ?? '482019';
const TIMEOUT_MS = Number(process.env.PLANB_PROBE_TIMEOUT_MS ?? 15000);
const QUOTE_CANDIDATE_LIMIT = Number(process.env.PLANB_QUOTE_CANDIDATE_LIMIT ?? 8);
const WRITES_ENABLED = writesEnabled({ env: process.env, inProcess: IN_PROCESS });
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

if (IN_PROCESS && process.env.VITEST === undefined) process.env.VITEST = '1';
if (IN_PROCESS && WRITES_ENABLED) {
  process.env.DEMO_MODE = 'true';
  if (process.env.PLANB_PROBE_USE_DATABASE !== '1') {
    process.env.DATABASE_URL = '';
    process.env.REDIS_URL = '';
  }
  if (process.env.PLANB_PROBE_ALLOW_LIVE_PROVIDERS !== '1') {
    process.env.PRIVY_APP_ID = '';
    process.env.PRIVY_APP_SECRET = '';
    process.env.PRIVY_VERIFICATION_KEY = '';
    process.env.JUPITER_SWAPS_ENABLED = '0';
    process.env.HL_BUILDER_ADDRESS = '';
    process.env.POLY_API_KEY = '';
    process.env.POLYMARKET_BUILDER_API_SECRET = '';
    process.env.POLYMARKET_BUILDER_API_PASSPHRASE = '';
  }
}

const READS = [
  ['/auth/me', 'profile'],
  ['/me/profile', 'profile'],
  ['/balances', 'balances'],
  ['/transfers', 'transfers'],
  ['/markets/orders?limit=50', 'orders'],
  ['/markets/positions', 'positions'],
  ['/markets/fills?limit=50', 'fills'],
  ['/markets/portfolio/summary', 'portfolio'],
  ['/markets/hyperliquid/positions', 'perps positions'],
  ['/markets/hyperliquid-spot/positions', 'spot positions'],
  ['/markets/stocks/positions', 'stocks positions'],
  ['/markets/jupiter/positions', 'jupiter positions'],
  ['/markets/polymarket/positions', 'polymarket positions'],
  ['/markets/cards/positions', 'card positions'],
  ['/markets/hyperliquid/builder-status', 'perps builder gate'],
  ['/markets/polymarket/trading-status', 'polymarket gate'],
];

async function request(method, route, { token, body, idempotencyKey } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const started = Date.now();
  try {
    const res = await dispatch(route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { method, route, statusCode: res.status, ok: res.ok && (json?.ok ?? true) !== false, body: json, elapsedMs: Date.now() - started };
  } catch (e) {
    return { method, route, statusCode: 0, ok: false, body: null, elapsedMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

function writesEnabled({ env, inProcess }) {
  if (env.PLANB_PROBE_WRITES !== '1') return false;
  return inProcess || env.PLANB_ALLOW_PRODUCTION_WRITES === '1';
}

let appPromise;
async function dispatch(route, init) {
  if (!IN_PROCESS) return fetch(`${API_BASE}${route}`, init);
  appPromise ??= import('../apps/api/src/index.ts').then((m) => m.app);
  const app = await appPromise;
  return app.request(route, init);
}

async function getToken() {
  if (AUTH_TOKEN) return { ok: true, source: 'env', token: AUTH_TOKEN };
  const start = await request('POST', '/auth/start', { body: { email: EMAIL } });
  if (!start.ok || !start.body?.challengeId) {
    return { ok: false, source: 'demo-otp', blocker: start.body?.mode === 'privy' ? 'target uses Privy auth; set PLANB_AUTH_TOKEN' : errorOf(start) || 'auth_start_failed' };
  }
  const verify = await request('POST', '/auth/verify', { body: { challengeId: start.body.challengeId, code: OTP } });
  if (!verify.ok || !verify.body?.token) return { ok: false, source: 'demo-otp', blocker: errorOf(verify) || 'auth_verify_failed' };
  return { ok: true, source: 'demo-otp', token: verify.body.token };
}

async function candidateMintsFromRoute(route, keys, exclude = []) {
  const res = await request('GET', route);
  return candidateMints(res.body, keys, exclude);
}

function candidateMints(body, keys, exclude = []) {
  const blocked = new Set(exclude.map((value) => String(value).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const row of firstRows(body)) {
    for (const key of keys) {
      if (!row?.[key]) continue;
      const mint = String(row[key]);
      const lower = mint.toLowerCase();
      if (!blocked.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        out.push(mint);
      }
    }
  }
  return out;
}

async function firstWorkingQuote(label, candidates, token) {
  let last = null;
  const limited = candidates.slice(0, Math.max(1, QUOTE_CANDIDATE_LIMIT));
  for (let i = 0; i < limited.length; i++) {
    const target = limited[i];
    const row = summarize(label, await request('POST', '/markets/jupiter/quote', {
      token,
      body: { inputMint: SOL_MINT, outputMint: target, amountAtomic: '1000000', slippageBps: 100 },
    }));
    row.target = target;
    row.attempt = i + 1;
    row.candidates = candidates.length;
    if (row.ok) return row;
    last = row;
  }
  return last;
}

async function runProbe() {
  const auth = await getToken();
  const rows = [];
  const quotes = [];
  const writes = [];
  if (auth.ok) {
    for (const [route, label] of READS) rows.push(summarize(label, await request('GET', route, { token: auth.token })));

  const memeQuote = await firstWorkingQuote(
    'jupiter meme quote',
    await candidateMintsFromRoute('/markets/jupiter?limit=50&source=both', ['mint'], [SOL_MINT, SOLANA_USDC_MINT]),
    auth.token,
  );
    if (memeQuote) quotes.push(memeQuote);

    const stockQuote = await firstWorkingQuote(
      'xStocks spot quote',
      await candidateMintsFromRoute('/markets/stocks/spot?limit=20', ['mint']),
      auth.token,
    );
    if (stockQuote) quotes.push(stockQuote);

    if (WRITES_ENABLED) {
      writes.push(...await runWriteProbes(auth.token, { memeQuote, stockQuote }));
      rows.push(summarize('fills after writes', await request('GET', '/markets/fills?limit=50', { token: auth.token })));
    } else if (process.env.PLANB_PROBE_WRITES === '1') {
      writes.push({
        label: 'write probes',
        method: 'POST',
        route: 'production writes',
        statusCode: 0,
        ok: false,
        blocker: 'production_writes_require_PLANB_ALLOW_PRODUCTION_WRITES',
      });
    }
  }

  const fillsRow = fillsRowOf(rows);
  const fillVenues = [...new Set(firstRows(fillsRow?.body).map((f) => f.venue).filter(Boolean))].sort();
  const unsupportedFills = Array.isArray(fillsRow?.body?.unsupported)
    ? fillsRow.body.unsupported.map((u) => typeof u === 'string' ? u : `${u.venue ?? 'unknown'} via ${u.route ?? 'unknown'}`)
    : [];
  const report = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    auth: auth.ok ? { ok: true, source: auth.source } : { ok: false, source: auth.source, blocker: auth.blocker },
    rows,
    quotes,
    writes,
    actionMatrix: actionMatrix(writes),
    fills: {
      routeStatus: fillsRow?.statusCode ?? null,
      count: firstRows(fillsRow?.body).length,
      venuesSeen: fillVenues,
      supportedByCode: ['hyperliquid', 'hyperliquid-spot', 'hyperliquid-hip3', 'polymarket', 'jupiter', 'xstocks', 'collector-crypt'],
      unsupported: unsupportedFills,
    },
  };
  return report;
}

function fillsRowOf(rows) {
  return rows.filter((r) => r.route.includes('/markets/fills')).at(-1);
}

function actionMatrix(writes = []) {
  const byLabel = new Map(writes.map((w) => [w.label, w]));
  const status = (label) => {
    const row = byLabel.get(label);
    if (!row) return 'not posted by probe';
    return row.ok ? `posted ${row.statusCode}` : `blocked ${row.statusCode} ${row.blocker}`;
  };
  return [
    { action: 'Hyperliquid Perps trade', route: 'POST /markets/hyperliquid/order', probe: status('hyperliquid perps order') },
    { action: 'Hyperliquid Spot trade', route: 'POST /markets/hyperliquid-spot/order', probe: status('hyperliquid spot order') },
    { action: 'Polymarket buy', route: 'POST /markets/polymarket/order', probe: status('polymarket buy') },
    { action: 'Polymarket sell', route: 'POST /markets/polymarket/sell', probe: status('polymarket sell') },
    { action: 'Jupiter meme quote', route: 'POST /markets/jupiter/quote', probe: 'quoted when a token is available' },
    { action: 'Jupiter meme swap', route: 'POST /markets/jupiter/swap', probe: status('jupiter meme swap') },
    { action: 'Backed xStocks quote', route: 'POST /markets/jupiter/quote', probe: 'quoted when a stock mint is available' },
    { action: 'Backed xStocks swap', route: 'POST /markets/jupiter/swap', probe: status('xStocks spot swap') },
    { action: 'HIP-3 stock perp order', route: 'POST /markets/stocks/order', probe: status('hip3 stock perp order') },
    { action: 'Collector Crypt buy', route: 'POST /markets/cards/buy', probe: status('collector crypt buy') },
    { action: 'Order cancel', route: 'POST /markets/orders/:id/cancel', probe: status('order cancel') },
    { action: 'Deposit address', route: 'GET /transfers/onramp/deposit-address?bucket=cash', probe: status('deposit address cash') },
    { action: 'Transfer internal', route: 'POST /transfers/internal', probe: status('transfer internal') },
    { action: 'Hyperliquid deposit', route: 'POST /transfers/hl-deposit', probe: status('hl deposit') },
  ];
}

async function runWriteProbes(token, { memeQuote, stockQuote }) {
  const id = Date.now().toString(36);
  const out = [];
  const get = async (label, route) => {
    out.push(summarizeWrite(label, await request('GET', route, { token })));
    return out[out.length - 1];
  };
  const post = async (label, route, body, idempotencyKey) => {
    out.push(summarizeWrite(label, await request('POST', route, { token, body, idempotencyKey })));
    return out[out.length - 1];
  };

  const perps = await post('hyperliquid perps order', '/markets/hyperliquid/order', {
    coin: 'BTC',
    sideLong: true,
    qtyUsd: 5,
    leverage: 1,
  }, `probe-perps-${id}`);

  const cancelable = await post('hyperliquid perps resting order', '/markets/hyperliquid/order', {
    coin: 'ETH',
    sideLong: true,
    qtyUsd: 5,
    leverage: 1,
    orderType: 'limit',
    limitPriceUsd: 1,
    tif: 'Gtc',
  }, `probe-cancelable-${id}`);
  if (cancelable.positionId) {
    await post('order cancel', `/markets/orders/${encodeURIComponent(cancelable.positionId)}/cancel`, {}, `probe-cancel-${id}`);
  }

  await post('hyperliquid spot order', '/markets/hyperliquid-spot/order', {
    coin: 'PURR/USDC',
    sideLong: true,
    qtyUsd: 5,
  }, `probe-spot-${id}`);

  const pm = await post('polymarket buy', '/markets/polymarket/order', {
    marketId: 'demo-btc-100k',
    outcome: 'Yes',
    priceCents: 50,
    qtyUsd: 5,
  }, `probe-pm-buy-${id}`);
  if (pm.positionId) {
    await post('polymarket sell', '/markets/polymarket/sell', {
      positionId: pm.positionId,
      limitPriceCents: 50,
      qtyUsd: 2,
    }, `probe-pm-sell-${id}`);
  }

  await post('hip3 stock perp order', '/markets/stocks/order', {
    coin: 'AAPL',
    sideLong: true,
    qtyUsd: 5,
    leverage: 1,
  }, `probe-hip3-${id}`);

  await swapWrite(out, token, 'jupiter meme swap', memeQuote, `probe-jup-${id}`);
  await swapWrite(out, token, 'xStocks spot swap', stockQuote, `probe-xstock-${id}`);
  await cardWrite(out, token, id);
  await get('deposit address cash', '/transfers/onramp/deposit-address?bucket=cash');
  await post('transfer internal', '/transfers/internal', {
    fromBucket: 'cash',
    toBucket: 'predictions',
    amountUsd: 25,
  }, `probe-transfer-${id}`);
  await post('hl deposit', '/transfers/hl-deposit', { amountUsd: 5 }, `probe-hl-deposit-${id}`);
  return out;
}

async function swapWrite(out, token, label, quoteRow, idempotencyKey) {
  if (!quoteRow?.ok || !quoteRow.target) return;
  out.push(summarizeWrite(label, await request('POST', '/markets/jupiter/swap', {
    token,
    idempotencyKey,
    body: {
      inputMint: SOL_MINT,
      outputMint: quoteRow.target,
      amountAtomic: '1000000',
      slippageBps: 100,
      quote: quoteRow.body?.quote,
    },
  })));
}

async function cardWrite(out, token, id) {
  const cards = await request('GET', '/markets/cards?limit=1');
  const card = firstRows(cards.body)[0];
  if (!card?.id || !card?.nftAddress) return;
  out.push(summarizeWrite('collector crypt buy', await request('POST', '/markets/cards/buy', {
    token,
    idempotencyKey: `probe-card-${id}`,
    body: {
      cardId: card.id,
      nftAddress: card.nftAddress,
      expectedPriceUsdc: Number(card.priceUsdc ?? 1),
      tokenStandard: card.tokenStandard ?? 'Nft',
      name: card.name,
      imageUrl: card.imageUrl,
    },
  })));
}

function summarize(label, res) {
  return {
    label,
    method: res.method,
    route: res.route,
    statusCode: res.statusCode,
    ok: res.ok,
    count: firstRows(res.body).length,
    source: sourceOf(res.body),
    blocker: res.ok ? '' : errorOf(res),
    body: res.body,
  };
}

function summarizeWrite(label, res) {
  const position = res.body?.position;
  const order = res.body?.order;
  return {
    label,
    method: res.method,
    route: res.route,
    statusCode: res.statusCode,
    ok: res.ok,
    blocker: res.ok ? '' : errorOf(res),
    orderId: order?.orderId ?? order?.signature ?? res.body?.tradeId ?? res.body?.transferId ?? res.body?.address ?? '',
    positionId: position?.id ?? '',
    status: position?.status ?? order?.state ?? res.body?.status ?? (res.body?.live === false ? 'demo' : ''),
    demo: order?.demo ?? undefined,
    body: res.body,
  };
}

function firstRows(body) {
  if (!body || typeof body !== 'object') return [];
  for (const key of ['orders', 'positions', 'fills', 'transfers', 'items', 'markets', 'tokens', 'stocks']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function sourceOf(body) {
  if (!body || typeof body !== 'object') return '';
  if (body.source) return String(body.source);
  if (body.sourced?.source) return String(body.sourced.source);
  return '';
}

function errorOf(res) {
  const body = res.body;
  if (res.error) return res.error;
  if (!body || typeof body !== 'object') return `HTTP ${res.statusCode}`;
  return body.error?.message ?? body.error?.code ?? body.message ?? body.code ?? `HTTP ${res.statusCode}`;
}

function renderMarkdown(report) {
  const lines = ['# PLANB Authenticated Market Action Probe', '', `Generated: ${report.generatedAt}`, `API base: ${report.apiBase}`, ''];
  lines.push(`Auth: ${report.auth.ok ? `ok (${report.auth.source})` : `blocked (${report.auth.blocker})`}`, '');
  lines.push('| Label | Route | Status | OK | Count | Source | Blocker |');
  lines.push('|---|---|---:|---|---:|---|---|');
  for (const r of report.rows) lines.push(mdRow([r.label, `${r.method} ${r.route}`, r.statusCode, r.ok, r.count, r.source || '-', r.blocker || '-']));
  lines.push('', '## Quote Probes', '', '| Label | Route | Status | OK | Count | Target | Attempts | Blocker |', '|---|---|---:|---|---:|---|---:|---|');
  for (const r of report.quotes) lines.push(mdRow([r.label, `${r.method} ${r.route}`, r.statusCode, r.ok, r.count, r.target || '-', r.attempt ? `${r.attempt}/${r.candidates}` : '-', r.blocker || '-']));
  if (!report.quotes.length) lines.push('|-|no token or no quoteable mint|-|-|-|-|-|-|');
  lines.push('', '## Write Probes', '');
  if (report.writes?.length) {
    lines.push('| Label | Route | Status | OK | Order | Position | State | Blocker |');
    lines.push('|---|---|---:|---|---|---|---|---|');
    for (const r of report.writes) lines.push(mdRow([r.label, `${r.method} ${r.route}`, r.statusCode, r.ok, r.orderId || '-', r.positionId || '-', r.status || '-', r.blocker || '-']));
  } else {
    lines.push('Not run. Set `PLANB_PROBE_WRITES=1` for local/in-process demo writes. Production writes also require `PLANB_ALLOW_PRODUCTION_WRITES=1`.');
  }
  lines.push('', '## Action Matrix', '', '| Action | Route | Probe stance |', '|---|---|---|');
  for (const a of report.actionMatrix) lines.push(mdRow([a.action, a.route, a.probe]));
  lines.push('', '## Fills Support', '');
  lines.push(`Route status: ${report.fills.routeStatus ?? '-'}`);
  lines.push(`Fills returned: ${report.fills.count}`);
  lines.push(`Venues seen in this run: ${report.fills.venuesSeen.join(', ') || '-'}`);
  lines.push(`Supported by code: ${report.fills.supportedByCode.join(', ')}`);
  lines.push(`Unsupported metadata: ${report.fills.unsupported.join('; ') || '-'}`);
  return `${lines.join('\n')}\n`;
}

function mdRow(values) {
  return `|${values.map((v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join('|')}|`;
}

async function write(report) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `auth-market-actions-${TODAY}.json`);
  const mdPath = path.join(OUT_DIR, `auth-market-actions-${TODAY}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath };
}

function selfTest() {
  assert.equal(firstRows({ fills: [{ venue: 'jupiter' }] }).length, 1);
  assert.equal(fillsRowOf([{ route: '/markets/fills', statusCode: 200 }, { route: '/markets/fills?limit=50', statusCode: 201 }]).statusCode, 201);
  assert.equal(sourceOf({ sourced: { source: 'live' } }), 'live');
  assert.equal(errorOf({ statusCode: 503, body: { error: { code: 'service_unavailable', message: 'cards_execution_unavailable' } } }), 'cards_execution_unavailable');
  assert.deepEqual(candidateMints({ stocks: [{ mint: 'skip' }, { mint: 'use' }] }, ['mint'], ['skip']), ['use']);
  assert.match(renderMarkdown({ generatedAt: 'x', apiBase: 'b', auth: { ok: false, blocker: 'no' }, rows: [], quotes: [], actionMatrix: [], fills: { routeStatus: 401, count: 0, venuesSeen: [], supportedByCode: [], unsupported: [] } }), /Auth: blocked/);
  assert.match(renderMarkdown({ generatedAt: 'x', apiBase: 'b', auth: { ok: true, source: 's' }, rows: [], quotes: [{ label: 'q', method: 'POST', route: '/q', statusCode: 200, ok: true, count: 0, blocker: '', target: 'mint', attempt: 2, candidates: 3 }], actionMatrix: [], fills: { routeStatus: 200, count: 0, venuesSeen: [], supportedByCode: [], unsupported: [] } }), /Target/);
  assert.equal(writesEnabled({ env: {}, inProcess: true }), false);
  assert.equal(writesEnabled({ env: { PLANB_PROBE_WRITES: '1' }, inProcess: true }), true);
  assert.match(
    actionMatrix([
      { label: 'transfer internal', statusCode: 200, ok: true, blocker: '' },
      { label: 'hl deposit', statusCode: 503, ok: false, blocker: 'hl_deposit_unavailable' },
    ]).map((a) => `${a.action}:${a.probe}`).join('\n'),
    /Transfer internal:posted 200/,
  );
  assert.match(renderMarkdown({ generatedAt: 'x', apiBase: 'b', auth: { ok: true, source: 's' }, rows: [], quotes: [], writes: [{ label: 'perps order', method: 'POST', route: '/markets/hyperliquid/order', statusCode: 200, ok: true, blocker: '', orderId: 'o1', positionId: 'p1', status: 'filled' }], actionMatrix: [], fills: { routeStatus: 200, count: 0, venuesSeen: [], supportedByCode: [], unsupported: [] } }), /Write Probes/);
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    console.log('probe-auth-market-actions self-test ok');
    return;
  }
  const report = await runProbe();
  const files = await write(report);
  console.log(`auth market action probe wrote ${path.relative(ROOT, files.jsonPath)} and ${path.relative(ROOT, files.mdPath)}`);
  if (!report.auth.ok) process.exitCode = 2;
  if (report.rows.some((r) => !r.ok)) process.exitCode = process.exitCode || 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
  process.exit(process.exitCode ?? 0);
}

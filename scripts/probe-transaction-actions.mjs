#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, 'docs', 'probes');
const MODE = argValue('--mode') ?? 'contract';
const IN_PROCESS = process.env.TRANSACTION_PROBE_IN_PROCESS === '1' || process.env.PLANB_IN_PROCESS === '1';
const API_BASE = IN_PROCESS ? 'in-process' : (process.env.NEXA_API_BASE ?? process.env.PLANB_API_BASE ?? 'https://nexa.aiso.tools/api').replace(/\/+$/, '');
const AUTH_TOKEN = process.env.NEXA_AUTH_TOKEN ?? process.env.PLANB_AUTH_TOKEN ?? process.env.AUTH_TOKEN ?? '';
const AGENT_KEY = process.env.NEXA_AGENT_KEY ?? process.env.PLANB_AGENT_KEY ?? process.env.X402_AGENT_KEY ?? 'nx_live_7f3k_demo';
const EMAIL = process.env.TRANSACTION_PROBE_EMAIL ?? `tx-probe-${Date.now()}@example.com`;
const OTP = process.env.NEXA_DEMO_OTP_CODE ?? process.env.PLANB_DEMO_OTP_CODE ?? '482019';
const TIMEOUT_MS = Number(process.env.TRANSACTION_PROBE_TIMEOUT_MS ?? 15000);

if (IN_PROCESS && process.env.VITEST === undefined) process.env.VITEST = '1';
if (IN_PROCESS && MODE === 'demo') {
  process.env.DEMO_MODE = 'true';
  if (process.env.TRANSACTION_PROBE_USE_DATABASE !== '1') {
    process.env.DATABASE_URL = '';
    process.env.REDIS_URL = '';
  }
  if (process.env.TRANSACTION_PROBE_ALLOW_LIVE_PROVIDERS !== '1') {
    process.env.BRIDGE_API_KEY = '';
    process.env.STRIPE_SECRET_KEY = '';
    process.env.STRIPE_WEBHOOK_SECRET = '';
    process.env.PRIVY_APP_ID = '';
    process.env.PRIVY_APP_SECRET = '';
    process.env.PRIVY_VERIFICATION_KEY = '';
    process.env.JUPITER_SWAPS_ENABLED = '0';
    process.env.HL_BUILDER_ADDRESS = '';
    process.env.POLY_API_KEY = '';
    process.env.POLYMARKET_BUILDER_API_SECRET = '';
    process.env.POLYMARKET_BUILDER_API_PASSPHRASE = '';
    process.env.MONERIUM_API_KEY = '';
  }
}

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const XSTOCK_MINT = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
const CARD_ID = '202605230C136034';
const CARD_NFT = 'WxUTBhnFg3jG4768MZSdm11vbaVSwxQHovD4ZfvkCaY';
const EVM_DESTINATION = '0x1111111111111111111111111111111111111111';
const EVM_DESTINATION_2 = '0x00000000000000000000000000000000000000bb';
const BALANCE_BUCKETS = ['cash', 'perps', 'predictions', 'memes', 'stocks-spot'];
const INTERNAL_TRANSFER_ACTIONS = BALANCE_BUCKETS.flatMap((fromBucket) =>
  BALANCE_BUCKETS
    .filter((toBucket) => toBucket !== fromBucket)
    .map((toBucket) =>
      action(`internal transfer ${fromBucket} to ${toBucket}`, '/transfers/internal', {
        fromBucket,
        toBucket,
        amountUsd: 25,
      }, { idempotency: 'always' }),
    ),
);
const DEPOSIT_ADDRESS_READS = BALANCE_BUCKETS.flatMap((bucket) => [
  [`transfer deposit address ${bucket}`, 'GET', `/transfers/onramp/deposit-address?bucket=${bucket}`, 'session'],
  [`onramp deposit address ${bucket}`, 'GET', `/onramp/deposit-address?bucket=${bucket}`, 'session'],
]);

const READ_ROUTES = [
  ['profile', 'GET', '/me/profile', 'session'],
  ['balances', 'GET', '/balances', 'session'],
  ['ledger', 'GET', '/ledger/me', 'session'],
  ['transfers history', 'GET', '/transfers?limit=20', 'session'],
  ['orders history', 'GET', '/markets/orders?limit=10', 'session'],
  ['positions history', 'GET', '/markets/positions', 'session'],
  ['fills history', 'GET', '/markets/fills?limit=10', 'session'],
  ...DEPOSIT_ADDRESS_READS,
  ['bridge accounts', 'GET', '/bridge/accounts', 'session'],
  ['bridge payout methods', 'GET', '/bridge/payout-methods', 'session'],
  ['monerium profile', 'GET', '/monerium/profile', 'session'],
  ['markets hl positions', 'GET', '/markets/hyperliquid/positions', 'session'],
  ['markets hl spot positions', 'GET', '/markets/hyperliquid-spot/positions', 'session'],
  ['markets jupiter positions', 'GET', '/markets/jupiter/positions', 'session'],
  ['markets stocks positions', 'GET', '/markets/stocks/positions', 'session'],
  ['markets polymarket positions', 'GET', '/markets/polymarket/positions', 'session'],
  ['markets cards positions', 'GET', '/markets/cards/positions', 'session'],
  ['markets cards trades', 'GET', '/markets/cards/trades/me', 'session'],
  ['card state', 'GET', '/card', 'session'],
  ['agents', 'GET', '/agent', 'session'],
  ['x402 contracts', 'GET', '/x402/contracts', 'session'],
  ['x402 quote', 'GET', '/x402/quote?resource=/v1/clip-analytics', 'session'],
  ['x402 events', 'GET', '/x402/events', 'session'],
];

function action(label, route, body, opts = {}) {
  return {
    label,
    method: 'POST',
    route,
    body,
    auth: 'session',
    idempotency: 'none',
    contractMalformed: true,
    ...opts,
  };
}

const ACTIONS = [
  action('payments send', '/payments/send', { amountUsd: 5, to: 'tx-probe-recipient@example.com' }, { idempotency: 'outside-demo' }),
  action('payments request link', '/payments/request-link', { amountUsd: 5, note: 'transaction probe' }),
  action('payments demo topup', '/payments/topup', { amountUsd: 10, label: 'Transaction probe topup' }),

  action('earn deposit', '/earn/deposit', { amountUsd: 10, tier: 'standard' }, { idempotency: 'outside-demo' }),
  action('earn withdraw', '/earn/withdraw', { amountUsd: 5 }, { idempotency: 'outside-demo' }),
  action('earn configure', '/earn/configure', { earnByDefault: true, autoDivestOnSpend: false, divestThresholdUsd: 50 }, { contractMalformed: false }),
  action('earn tier', '/earn/tier', { tier: 'higher_yield' }),
  action('earn marinade stake', '/earn/marinade/stake', { amountSol: 0.05 }),
  action('earn marinade unstake', '/earn/marinade/unstake', { amountMSol: 0.05, immediate: true }),
  action('swap execute', '/swap/execute', { amount: 10, direction: 'usd-eur' }, { idempotency: 'outside-demo' }),

  ...INTERNAL_TRANSFER_ACTIONS,
  action('external transfer base usdc', '/transfers/external', { chain: 'base', destinationAddress: EVM_DESTINATION, amountUsd: 12.5 }, { idempotency: 'always' }),
  action('hl deposit', '/transfers/hl-deposit', { amountUsd: 5 }, { idempotency: 'always' }),

  action('onramp stripe session', '/onramp/stripe/session', { amountUsd: 50, destinationNetwork: 'base' }),
  action('onramp stripe webhook', '/onramp/stripe/webhook', { type: 'crypto.onramp_session.fulfillment_completed' }, { auth: 'public', contractMalformed: false }),
  action('onramp onramper session', '/onramp/onramper/session', { amountUsd: 50, bucket: 'stocks-spot' }, { contractMalformed: false }),
  action('bridge customer', '/bridge/customer', {}, { contractMalformed: false }),
  action('bridge virtual account', '/bridge/virtual-account', { currency: 'USD' }),
  action('bridge payout method', '/bridge/payout-method', bridgePayoutBody),
  action('bridge withdraw', '/bridge/withdraw', bridgeWithdrawBody, { idempotency: 'always' }),
  action('bridge deposit webhook', '/bridge/webhook', { type: 'customer.deposit.completed', amount: 10 }, { auth: 'public', contractMalformed: false }),
  action('bridge transfer webhook', '/bridge/transfer-webhook', { type: 'transfer.updated', status: 'completed' }, { auth: 'public', contractMalformed: false }),
  action('monerium offramp', '/monerium/offramp', { amountEur: 5, reference: 'transaction-probe' }),

  action('card order', '/card/order', {}, { idempotency: 'outside-demo', contractMalformed: false }),
  action('card topup', '/card/topup', { amountUsd: 25 }, { idempotency: 'outside-demo' }),
  action('card freeze', '/card/freeze', { frozen: true }),
  action('card limit', '/card/limit', { dayLimitUsd: 750 }),

  action('agent create', '/agent/create', uniqueAgentBody),
  action('agent kill switch off', '/agent/kill-switch', { on: false }),
  action('agent fund', agentRoute('fund-agent', '/fund'), { amountUsd: 5 }, { idempotency: 'always' }),
  action('agent defund', agentRoute('defund-agent', '/defund'), {}, { contractMalformed: false }),
  action('agent pause', agentRoute('pause-agent', '/pause'), { paused: true }),
  action('agent policy', agentRoute('policy-agent', '/policy'), { perTxCapUsd: 1, endpointAllowlist: ['api.exa.ai'] }),
  action('agent approve once', agentRoute('approve-agent', '/approve-once'), { endpoint: 'api.exa.ai/v1/search', amountUsd: 0.1, reason: 'probe' }, { idempotency: 'always' }),
  action('agent card', agentRoute('card-agent', '/card'), {}, { idempotency: 'provider-live', contractMalformed: false }),
  action('agent bank', agentRoute('bank-agent', '/bank'), {}, { idempotency: 'provider-live', contractMalformed: false }),

  action('x402 pay', '/x402/pay', x402Body, { auth: 'agent', idempotency: 'outside-demo' }),
  action('x402 settle', '/x402/settle', x402Body, { auth: 'agent', idempotency: 'outside-demo' }),
  action('x402 contracts create', '/x402/contracts', uniqueContractBody),
  action('x402 contracts status', contractStatusRoute, { status: 'paused' }, { contractMalformed: false }),

  action('hl approve builder', '/markets/hyperliquid/approve-builder', { maxFeeBps: 10 }, { contractMalformed: false }),
  action('hl perps order', '/markets/hyperliquid/order', { coin: 'BTC', sideLong: true, qtyUsd: 10, leverage: 1 }, { idempotency: 'live' }),
  action('hl perps cancel', '/markets/hyperliquid/cancel', hlCancelBody, { idempotency: 'live' }),
  action('hl perps cancel many', '/markets/hyperliquid/cancel-many', { cancels: [{ coin: 'BTC', orderId: 'hl_111' }] }, { idempotency: 'live' }),
  action('hl perps modify', '/markets/hyperliquid/modify', hlModifyBody),
  action('hl update leverage', '/markets/hyperliquid/update-leverage', { coin: 'BTC', leverage: 2, isCross: true }),
  action('hl update isolated margin', '/markets/hyperliquid/update-isolated-margin', { coin: 'BTC', sideLong: true, amountUsd: 5 }, { idempotency: 'live' }),
  action('hl usd class transfer', '/markets/hyperliquid/usd-class-transfer', { amountUsd: 5, toPerp: true }, { idempotency: 'live' }),
  action('hl usd send', '/markets/hyperliquid/usd-send', { destination: EVM_DESTINATION_2, amountUsd: 5 }, { idempotency: 'always' }),
  action('hl transfer to dex', '/markets/hyperliquid/transfer-to-dex', { amountUsd: 5, destinationDex: 'xyz' }, { idempotency: 'live' }),
  action('hl withdraw', '/markets/hyperliquid/withdraw', { destination: EVM_DESTINATION_2, amountUsd: 5 }, { idempotency: 'always' }),

  action('hl spot order', '/markets/hyperliquid-spot/order', { coin: 'PURR/USDC', sideLong: true, qtyUsd: 10 }, { idempotency: 'live' }),
  action('hl spot cancel', '/markets/hyperliquid-spot/cancel', hlSpotCancelBody, { idempotency: 'live' }),

  action('jupiter quote', '/markets/jupiter/quote', { inputMint: USDC_SOL, outputMint: BONK_MINT, amountAtomic: '1000000', slippageBps: 300 }),
  action('jupiter swap memes', '/markets/jupiter/swap', { inputMint: USDC_SOL, outputMint: SOL_MINT, amountAtomic: '100000', slippageBps: 300, quote: { demo: true } }, { idempotency: 'live' }),
  action('xstocks spot swap via jupiter', '/markets/jupiter/swap', { inputMint: USDC_SOL, outputMint: XSTOCK_MINT, amountAtomic: '100000', slippageBps: 300, quote: { demo: true } }, { idempotency: 'live' }),

  action('stocks order', '/markets/stocks/order', { coin: 'AAPL', sideLong: true, qtyUsd: 10, leverage: 1 }, { idempotency: 'live' }),
  action('stocks cancel', '/markets/stocks/cancel', stocksCancelBody, { idempotency: 'live' }),

  action('polymarket buy', '/markets/polymarket/order', { marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 50, qtyUsd: 5 }, { idempotency: 'live' }),
  action('polymarket sell', '/markets/polymarket/sell', polymarketSellBody, { idempotency: 'live' }),
  action('polymarket enable trading', '/markets/polymarket/enable-trading', {}, { contractMalformed: false }),
  action('polymarket wrap', '/markets/polymarket/wrap', { amountUsd: 10 }, { contractMalformed: false }),
  action('polymarket unwrap', '/markets/polymarket/unwrap', { amountUsd: 10 }, { contractMalformed: false }),

  action('cross venue cancel by internal id', crossVenueCancelRoute, {}, { idempotency: 'live', contractMalformed: false }),
  action('cards buy', '/markets/cards/buy', { cardId: CARD_ID, nftAddress: CARD_NFT, expectedPriceUsdc: 1, tokenStandard: 'Pnft' }, { idempotency: 'always' }),
];

const WRITE_ROUTES = ACTIONS.map((a) => [a.label, a.method, displayRoute(a.route), a.idempotency !== 'none']);

function argValue(name) {
  return argValueFrom(process.argv, name);
}

function argValueFrom(argv, name) {
  const idx = argv.indexOf(name);
  if (idx >= 0) return argv[idx + 1] ?? null;
  const eq = argv.find((arg) => arg.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

let appPromise;
async function dispatch(route, init) {
  if (!IN_PROCESS) return fetch(`${API_BASE}${route}`, init);
  appPromise ??= import('../apps/api/src/index.ts').then((m) => m.app);
  return (await appPromise).request(route, init);
}

async function request(method, route, { token, agentKey, body, idempotencyKey, headers: extraHeaders } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { accept: 'application/json', ...(extraHeaders ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (agentKey) headers['x-nexa-key'] = agentKey;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
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
    return { method, route, statusCode: res.status, ok: res.ok && json?.ok !== false, body: json };
  } catch (e) {
    return { method, route, statusCode: 0, ok: false, body: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function getToken() {
  if (AUTH_TOKEN) return { ok: true, source: 'env', token: AUTH_TOKEN };
  if (!IN_PROCESS) return { ok: false, source: 'none', blocker: 'set NEXA_AUTH_TOKEN or TRANSACTION_PROBE_IN_PROCESS=1' };
  const start = await request('POST', '/auth/start', { body: { email: EMAIL } });
  const verify = start.body?.challengeId
    ? await request('POST', '/auth/verify', { body: { challengeId: start.body.challengeId, code: OTP } })
    : null;
  return verify?.body?.token
    ? { ok: true, source: 'demo-otp', token: verify.body.token }
    : { ok: false, source: 'demo-otp', blocker: errorOf(verify ?? start) };
}

function authOptions(authKind, token) {
  if (authKind === 'agent') return { agentKey: AGENT_KEY };
  if (authKind === 'session') return { token };
  return {};
}

function classifyUnauth(res) {
  if (res.statusCode === 0) return 'fail';
  if (res.statusCode === 401 || res.statusCode === 403) return 'ok';
  if (res.statusCode >= 500 || res.ok) return 'fail';
  return 'warn';
}

function classifyMalformed(res) {
  if (res.statusCode === 0) return 'fail';
  if ([400, 401, 403, 404, 409, 412, 422, 423, 451].includes(res.statusCode)) return 'ok';
  if (isStructuredProviderBlocker(res)) return 'ok';
  if (res.statusCode >= 500 || res.ok) return 'fail';
  return 'warn';
}

function classifyDemo(res) {
  if (res.statusCode === 0) return 'fail';
  if (res.ok) return 'ok';
  if ([400, 401, 402, 403, 404, 409, 412, 422, 423, 429, 451].includes(res.statusCode)) return 'blocked';
  if (isStructuredProviderBlocker(res)) return 'blocked';
  if (res.statusCode >= 500) return 'fail';
  return 'warn';
}

function isStructuredProviderBlocker(res) {
  if (![502, 503].includes(res.statusCode)) return false;
  return Boolean(res.body && typeof res.body === 'object' && (res.body.error || res.body.ok === false));
}

async function runProbe() {
  if (MODE === 'live-smoke' && process.env.NEXA_LIVE_TX_PROBE !== '1') {
    throw new Error('live-smoke requires NEXA_LIVE_TX_PROBE=1');
  }
  if (MODE === 'demo' && process.env.DEMO_MODE !== '1' && process.env.DEMO_MODE !== 'true') {
    throw new Error('demo mode requires DEMO_MODE=true');
  }

  const auth = await getToken();
  const rows = [];
  const demoExecutions = [];
  const idempotencyChecks = [];
  const ctx = { token: auth.ok ? auth.token : null, memo: new Map(), runId: Date.now().toString(36) };

  for (const a of ACTIONS) {
    const route = displayRoute(a.route);
    if (a.auth !== 'public') {
      const unauth = await request(a.method, route, { body: {} });
      rows.push(row('unauth write rejects', a.label, a.method, route, unauth, classifyUnauth(unauth)));
    } else {
      rows.push(skipRow('unauth write rejects', a.label, a.method, route, 'public callback route has no session gate'));
    }
    if (auth.ok || a.auth === 'agent' || a.auth === 'public') {
      if (!a.contractMalformed || typeof a.route === 'function') {
        rows.push(skipRow('malformed authed write rejects', a.label, a.method, route, 'no harmless malformed payload for this dynamic/no-body route'));
      } else {
        const malformed = await request(a.method, route, {
          ...authOptions(a.auth, auth.token),
          body: {},
        });
        rows.push(row('malformed authed write rejects', a.label, a.method, route, malformed, classifyMalformed(malformed)));
      }
    }
  }

  if (auth.ok) {
    for (const [label, method, route, authKind] of READ_ROUTES) {
      const res = await request(method, route, authOptions(authKind, auth.token));
      rows.push(row('authed read/history', label, method, route, res, res.statusCode < 500 || isStructuredProviderBlocker(res) ? 'ok' : 'fail'));
    }
  }

  if (MODE === 'demo' && auth.ok) {
    for (const a of ACTIONS) {
      const display = displayRoute(a.route);
      try {
        const route = typeof a.route === 'function' ? await a.route(ctx) : a.route;
        const body = typeof a.body === 'function' ? await a.body(ctx) : a.body;
        const idempotencyKey = a.idempotency === 'none' ? undefined : idem(a.label, ctx);
        const res = await request(a.method, route, {
          ...authOptions(a.auth, auth.token),
          body,
          idempotencyKey,
        });
        demoExecutions.push(row('demo execution', a.label, a.method, route, res, classifyDemo(res)));
      } catch (e) {
        demoExecutions.push({
          check: 'demo execution',
          label: a.label,
          method: a.method,
          route: display,
          statusCode: null,
          status: 'blocked',
          ok: true,
          blocker: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  for (const a of ACTIONS.filter((item) => item.idempotency !== 'none')) {
    idempotencyChecks.push({
      check: 'idempotency policy',
      label: a.label,
      method: a.method,
      route: displayRoute(a.route),
      statusCode: null,
      status: MODE === 'demo' ? 'checked_with_key' : 'documented',
      blocker: idempotencyText(a.idempotency),
    });
  }

  const all = [...rows, ...demoExecutions];
  return {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    apiBase: API_BASE,
    safety: {
      inProcess: IN_PROCESS,
      isolatedDemo: IN_PROCESS && MODE === 'demo' && process.env.TRANSACTION_PROBE_USE_DATABASE !== '1',
      liveProvidersAllowed: process.env.TRANSACTION_PROBE_ALLOW_LIVE_PROVIDERS === '1',
      agentKeySource: AGENT_KEY === 'nx_live_7f3k_demo' ? 'seeded-demo' : 'env',
    },
    auth: auth.ok ? { ok: true, source: auth.source } : { ok: false, source: auth.source, blocker: auth.blocker },
    rows,
    demoExecutions,
    idempotencyChecks,
    notes: [
      'xStocks spot has no separate execution POST; it is probed as Jupiter swap with an xStock mint.',
      'Sports has no separate execution POST; it maps to Polymarket category/read surfaces and Polymarket order/sell writes.',
      'Admin withdraw-all is intentionally excluded because this probe covers user-visible transaction actions, not ops drains.',
    ],
    summary: {
      total: all.length + idempotencyChecks.length,
      failed: all.filter((r) => r.status === 'fail').length,
      warned: all.filter((r) => r.status === 'warn').length,
      blocked: all.filter((r) => r.status === 'blocked').length,
      skipped: all.filter((r) => r.status === 'skipped').length,
      demoExecuted: demoExecutions.length,
    },
  };
}

function idempotencyText(policy) {
  if (policy === 'always') return 'Idempotency-Key required by route before submit.';
  if (policy === 'outside-demo') return 'Idempotency-Key required outside DEMO_MODE; probe still sends one.';
  if (policy === 'live') return 'Idempotency-Key required when venue live trading is enabled; probe sends one.';
  if (policy === 'provider-live') return 'Idempotency-Key required only when provider is live; probe sends one.';
  return String(policy);
}

function row(check, label, method, route, res, status) {
  return {
    check,
    label,
    method,
    route,
    statusCode: res.statusCode,
    status,
    ok: status === 'ok' || status === 'blocked',
    blocker: status === 'ok' ? '' : errorOf(res),
  };
}

function skipRow(check, label, method, route, blocker) {
  return { check, label, method, route, statusCode: null, status: 'skipped', ok: true, blocker };
}

function errorOf(res) {
  if (!res) return 'request_not_run';
  if (res.error) return res.error;
  const body = res.body;
  if (!body || typeof body !== 'object') return `HTTP ${res.statusCode}`;
  if (typeof body.error === 'string') return body.error;
  return body.error?.message ?? body.error?.code ?? body.message ?? body.code ?? `HTTP ${res.statusCode}`;
}

function displayRoute(route) {
  return typeof route === 'function' ? route.displayRoute : route;
}

function idem(label, ctx) {
  return `txp-${ctx.runId}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72)}`;
}

async function authedPost(ctx, route, body, label) {
  const res = await request('POST', route, { token: ctx.token, body, idempotencyKey: idem(`setup-${label}`, ctx) });
  if (!res.ok) throw new Error(`setup ${label} failed: ${res.statusCode} ${errorOf(res)}`);
  return res.body;
}

async function memo(ctx, key, fn) {
  if (!ctx.memo.has(key)) ctx.memo.set(key, fn());
  return ctx.memo.get(key);
}

function uniqueAgentBody(ctx) {
  return {
    name: `ProbeAgent-${ctx.runId}`,
    perDayCapUsd: 10,
    perTxCapUsd: 1,
    endpointAllowlist: ['api.exa.ai'],
  };
}

function uniqueContractBody(ctx) {
  return {
    name: `Probe contract ${ctx.runId}`,
    endpointPath: `/v1/probe-${ctx.runId}`,
    method: 'GET',
    priceUsd: 0.01,
    currency: 'USDC',
  };
}

function x402Body() {
  return {
    agent: 'ResearchBot-01',
    endpoint: 'api.exa.ai/v1/search',
    amountUsd: 0.01,
    reason: 'probe',
  };
}

function bridgePayoutBody() {
  return {
    type: 'ach',
    label: 'Transaction probe ACH',
    accountDetails: { routing: '101019644', account: '8841294078' },
  };
}

async function bridgeMethod(ctx) {
  return memo(ctx, 'bridge-method', async () => {
    const body = await authedPost(ctx, '/bridge/payout-method', bridgePayoutBody(), 'bridge-method');
    const method = body.method;
    if (!method?.id) throw new Error('setup bridge-method missing method.id');
    return method;
  });
}

async function bridgeWithdrawBody(ctx) {
  const method = await bridgeMethod(ctx);
  return { payoutMethodId: method.id, amountUsd: 40 };
}

function agentRoute(key, suffix) {
  const fn = async (ctx) => {
    const agent = await probeAgent(ctx, key, suffix === '/defund' || suffix === '/approve-once');
    return `/agent/${agent.id}${suffix}`;
  };
  fn.displayRoute = `/agent/:id${suffix}`;
  return fn;
}

async function probeAgent(ctx, key, funded = false) {
  return memo(ctx, `agent-${key}-${funded ? 'funded' : 'plain'}`, async () => {
    const body = await authedPost(ctx, '/agent/create', {
      name: `Probe-${key}-${ctx.runId}`,
      perDayCapUsd: 10,
      perTxCapUsd: 1,
      endpointAllowlist: ['api.exa.ai'],
    }, `agent-${key}`);
    const agent = body.agent;
    if (!agent?.id) throw new Error(`setup agent-${key} missing agent.id`);
    if (funded) {
      await authedPost(ctx, `/agent/${agent.id}/fund`, { amountUsd: 2 }, `fund-${key}`);
    }
    return agent;
  });
}

async function createHlResting(ctx, key) {
  return memo(ctx, `hl-resting-${key}`, async () => {
    const body = await authedPost(ctx, '/markets/hyperliquid/order', {
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 10,
      leverage: 1,
      kind: 'limit',
      limitPriceUsd: 50000,
      tif: 'Gtc',
    }, `hl-resting-${key}`);
    return requirePosition(body, `hl-resting-${key}`);
  });
}

async function createSpotResting(ctx, key) {
  return memo(ctx, `spot-resting-${key}`, async () => {
    const body = await authedPost(ctx, '/markets/hyperliquid-spot/order', {
      coin: 'PURR/USDC',
      sideLong: true,
      qtyUsd: 10,
      orderType: 'limit',
      limitPriceUsd: 0.1,
      tif: 'Gtc',
    }, `spot-resting-${key}`);
    return requirePosition(body, `spot-resting-${key}`);
  });
}

async function createStocksResting(ctx, key) {
  return memo(ctx, `stocks-resting-${key}`, async () => {
    const body = await authedPost(ctx, '/markets/stocks/order', {
      coin: 'AAPL',
      sideLong: true,
      qtyUsd: 10,
      leverage: 1,
      orderType: 'limit',
      limitPriceUsd: 295,
      tif: 'Gtc',
    }, `stocks-resting-${key}`);
    return requirePosition(body, `stocks-resting-${key}`);
  });
}

function requirePosition(body, label) {
  const position = body?.position;
  if (!position?.id || !position?.externalRef) throw new Error(`setup ${label} missing position/externalRef`);
  return position;
}

async function hlCancelBody(ctx) {
  const position = await createHlResting(ctx, 'cancel');
  return { externalRef: position.externalRef, coin: 'BTC' };
}

async function hlModifyBody(ctx) {
  const position = await createHlResting(ctx, 'modify');
  return {
    coin: 'BTC',
    orderId: position.externalRef,
    order: {
      coin: 'BTC',
      sideLong: true,
      qtyUsd: 10,
      leverage: 1,
      orderType: 'limit',
      limitPriceUsd: 51000,
      tif: 'Gtc',
    },
  };
}

async function hlSpotCancelBody(ctx) {
  const position = await createSpotResting(ctx, 'cancel');
  return { externalRef: position.externalRef, coin: 'PURR/USDC' };
}

async function stocksCancelBody(ctx) {
  const position = await createStocksResting(ctx, 'cancel');
  return { externalRef: position.externalRef, coin: 'AAPL' };
}

async function polymarketBuy(ctx, key) {
  return memo(ctx, `pm-buy-${key}`, async () => {
    const body = await authedPost(ctx, '/markets/polymarket/order', {
      marketId: 'demo-btc-100k',
      outcome: 'Yes',
      priceCents: 50,
      qtyUsd: 5,
    }, `pm-buy-${key}`);
    return requirePosition(body, `pm-buy-${key}`);
  });
}

async function polymarketSellBody(ctx) {
  const position = await polymarketBuy(ctx, 'sell');
  return { positionId: position.id, limitPriceCents: 50, qtyUsd: 2 };
}

async function contractStatusRoute(ctx) {
  const contract = await memo(ctx, 'contract-status', async () => {
    const body = await authedPost(ctx, '/x402/contracts', {
      name: `Status contract ${ctx.runId}`,
      endpointPath: `/v1/status-${ctx.runId}`,
      method: 'GET',
      priceUsd: 0.01,
      currency: 'USDC',
    }, 'contract-status');
    if (!body.contract?.id) throw new Error('setup contract-status missing contract.id');
    return body.contract;
  });
  return `/x402/contracts/${contract.id}/status`;
}
contractStatusRoute.displayRoute = '/x402/contracts/:id/status';

async function crossVenueCancelRoute(ctx) {
  const position = await createHlResting(ctx, 'cross-cancel');
  return `/markets/orders/${position.id}/cancel`;
}
crossVenueCancelRoute.displayRoute = '/markets/orders/:id/cancel';

function mdRow(values) {
  return `|${values.map((v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join('|')}|`;
}

function renderMarkdown(report) {
  const lines = [
    '# PLANB Transaction Action Probe',
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `API base: ${report.apiBase}`,
    `Auth: ${report.auth.ok ? `ok (${report.auth.source})` : `blocked (${report.auth.blocker})`}`,
    `Safety: inProcess=${report.safety.inProcess}, isolatedDemo=${report.safety.isolatedDemo}, liveProvidersAllowed=${report.safety.liveProvidersAllowed}`,
    '',
    '## Contract Checks',
    '',
    '| Check | Label | Route | Status code | Status | Blocker |',
    '|---|---|---|---:|---|---|',
  ];
  for (const r of report.rows) lines.push(mdRow([r.check, r.label, `${r.method} ${r.route}`, r.statusCode, r.status, r.blocker || '-']));
  lines.push('', '## Demo Executions', '', '| Label | Route | Status code | Status | Blocker |', '|---|---|---:|---|---|');
  for (const r of report.demoExecutions) lines.push(mdRow([r.label, `${r.method} ${r.route}`, r.statusCode, r.status, r.blocker || '-']));
  lines.push('', '## Idempotency Policy', '', '| Label | Route | Status | Policy |', '|---|---|---|---|');
  for (const r of report.idempotencyChecks) lines.push(mdRow([r.label, `${r.method} ${r.route}`, r.status, r.blocker]));
  lines.push('', '## Notes', '');
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push(
    '',
    '## Summary',
    '',
    `Failed: ${report.summary.failed}`,
    `Warned: ${report.summary.warned}`,
    `Blocked with exact route/provider reason: ${report.summary.blocked}`,
    `Skipped contract-only checks: ${report.summary.skipped}`,
    `Demo executions attempted: ${report.summary.demoExecuted}`,
  );
  return `${lines.join('\n')}\n`;
}

async function write(report) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `transaction-actions-${TODAY}.json`);
  const mdPath = path.join(OUT_DIR, `transaction-actions-${TODAY}.md`);
  const modeJsonPath = path.join(OUT_DIR, `transaction-actions-${TODAY}-${report.mode}.json`);
  const modeMdPath = path.join(OUT_DIR, `transaction-actions-${TODAY}-${report.mode}.md`);
  const md = renderMarkdown(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(mdPath, md);
  await fs.writeFile(modeJsonPath, json);
  await fs.writeFile(modeMdPath, md);
  return { jsonPath, mdPath, modeJsonPath, modeMdPath };
}

function selfTest() {
  assert.equal(classifyUnauth({ statusCode: 401, ok: false }), 'ok');
  assert.equal(classifyUnauth({ statusCode: 0, ok: false }), 'fail');
  assert.equal(classifyMalformed({ statusCode: 422, ok: false }), 'ok');
  assert.equal(classifyMalformed({ statusCode: 0, ok: false }), 'fail');
  assert.equal(classifyMalformed({ statusCode: 200, ok: true }), 'fail');
  assert.equal(classifyDemo({ statusCode: 200, ok: true }), 'ok');
  assert.equal(classifyDemo({ statusCode: 503, ok: false, body: { error: { message: 'provider_disabled' } } }), 'blocked');
  assert.equal(classifyDemo({ statusCode: 500, ok: false, body: { error: { message: 'boom' } } }), 'fail');
  assert.equal(argValueFrom(['node', 'probe', '--mode', 'demo'], '--mode'), 'demo');
  assert.equal(argValueFrom(['node', 'probe', '--mode=demo'], '--mode'), 'demo');
  assert.ok(WRITE_ROUTES.some(([, , route]) => route === '/markets/hyperliquid/cancel-many'));
  assert.ok(WRITE_ROUTES.some(([, , route]) => route === '/agent/:id/fund'));
  assert.ok(ACTIONS.some((a) => a.label === 'xstocks spot swap via jupiter' && a.route === '/markets/jupiter/swap'));
  assert.equal(ACTIONS.filter((a) => a.label.startsWith('internal transfer ')).length, 20);
  assert.equal(READ_ROUTES.filter(([label]) => label.startsWith('transfer deposit address ')).length, 5);
  assert.equal(READ_ROUTES.filter(([label]) => label.startsWith('onramp deposit address ')).length, 5);
  assert.ok(ACTIONS.some((a) => a.label === 'onramp stripe webhook' && a.auth === 'public'));
  assert.ok(ACTIONS.some((a) => a.label === 'bridge transfer webhook' && a.auth === 'public'));
  assert.equal(errorOf({ statusCode: 503, body: { error: { message: 'provider_disabled' } } }), 'provider_disabled');
  assert.match(renderMarkdown({
    generatedAt: 'x',
    mode: 'contract',
    apiBase: 'b',
    auth: { ok: false, blocker: 'no' },
    safety: { inProcess: true, isolatedDemo: true, liveProvidersAllowed: false },
    rows: [],
    demoExecutions: [],
    idempotencyChecks: [],
    notes: [],
    summary: { failed: 0, warned: 0, blocked: 0, skipped: 0, demoExecuted: 0 },
  }), /Demo Executions/);
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    console.log('probe-transaction-actions self-test ok');
    return;
  }
  const report = await runProbe();
  const files = await write(report);
  console.log(`transaction action probe wrote ${path.relative(ROOT, files.jsonPath)} and ${path.relative(ROOT, files.mdPath)}`);
  console.log(`failed=${report.summary.failed} warned=${report.summary.warned} blocked=${report.summary.blocked} demoExecuted=${report.summary.demoExecuted}`);
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
  process.exit(process.exitCode ?? 0);
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, 'docs', 'probes');
const API_BASE = (process.env.NEXA_PROD_API_BASE ?? 'https://nexa.aiso.tools/api').replace(/\/+$/, '');
const ORIGIN = process.env.NEXA_PROD_ORIGIN ?? 'https://nexa.aiso.tools';

function writeGate(label, path) {
  return {
    label,
    method: 'POST',
    path,
    expected: [401, 403],
    headers: {
      Origin: ORIGIN,
      'content-type': 'application/json',
      'Idempotency-Key': 'prod-readiness-probe',
    },
    body: '{}',
    cors: true,
  };
}

function publicCallbackGate(label, path) {
  return {
    label,
    method: 'POST',
    path,
    expected: [400, 401, 403],
    headers: {
      Origin: ORIGIN,
      'content-type': 'application/json',
    },
    body: '{}',
    cors: true,
  };
}

function readGate(label, path) {
  return {
    label,
    method: 'GET',
    path,
    expected: [401, 403],
    headers: { Origin: ORIGIN },
    cors: true,
  };
}

function publicRead(label, path) {
  return {
    label,
    method: 'GET',
    path,
    expected: [200],
    headers: { Origin: ORIGIN },
    cors: false,
  };
}

function preflight(label, path, requestHeaders) {
  return {
    label,
    method: 'OPTIONS',
    path,
    expected: [204],
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': requestHeaders,
    },
    cors: true,
  };
}

const CHECKS = [
  preflight('credentialed ticket preflight', '/v1/stream/ticket', 'authorization,content-type'),
  preflight('idempotent transfer preflight', '/transfers/external', 'authorization,content-type,idempotency-key'),
  preflight('agent-key x402 preflight', '/x402/pay', 'x-nexa-key,content-type,idempotency-key'),
  {
    label: 'ticket unauth write gate',
    method: 'POST',
    path: '/v1/stream/ticket',
    expected: [401, 403],
    headers: { Origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
    cors: true,
  },
  writeGate('auth refresh cookie gate', '/auth/refresh'),
  readGate('auth me gate', '/auth/me'),
  readGate('me profile gate', '/me/profile'),
  readGate('card route mounted', '/card'),
  readGate('card slash route mounted', '/card/'),
  readGate('balances auth gate', '/balances'),
  readGate('ledger auth gate', '/ledger/me'),
  readGate('transfers history auth gate', '/transfers?limit=20'),
  readGate('transfer deposit cash auth gate', '/transfers/onramp/deposit-address?bucket=cash'),
  readGate('transfer deposit perps auth gate', '/transfers/onramp/deposit-address?bucket=perps'),
  readGate('transfer deposit predictions auth gate', '/transfers/onramp/deposit-address?bucket=predictions'),
  readGate('transfer deposit memes auth gate', '/transfers/onramp/deposit-address?bucket=memes'),
  readGate('transfer deposit xstocks auth gate', '/transfers/onramp/deposit-address?bucket=stocks-spot'),
  readGate('onramp deposit xstocks auth gate', '/onramp/deposit-address?bucket=stocks-spot'),
  readGate('orders history auth gate', '/markets/orders?limit=10'),
  readGate('positions history auth gate', '/markets/positions'),
  readGate('fills history auth gate', '/markets/fills?limit=10'),
  readGate('portfolio summary auth gate', '/markets/portfolio/summary'),
  readGate('perps positions auth gate', '/markets/hyperliquid/positions'),
  readGate('spot positions auth gate', '/markets/hyperliquid-spot/positions'),
  readGate('stocks positions auth gate', '/markets/stocks/positions'),
  readGate('jupiter positions auth gate', '/markets/jupiter/positions'),
  readGate('polymarket positions auth gate', '/markets/polymarket/positions'),
  readGate('cards positions auth gate', '/markets/cards/positions'),
  readGate('cards trades auth gate', '/markets/cards/trades/me'),
  readGate('bridge accounts auth gate', '/bridge/accounts'),
  readGate('bridge payout methods auth gate', '/bridge/payout-methods'),
  readGate('monerium profile auth gate', '/monerium/profile'),
  readGate('agents auth gate', '/agent'),
  readGate('x402 contracts auth gate', '/x402/contracts'),
  readGate('x402 events auth gate', '/x402/events'),
  writeGate('payments send write gate', '/payments/send'),
  writeGate('payments request link write gate', '/payments/request-link'),
  writeGate('payments demo topup write gate', '/payments/topup'),
  writeGate('earn deposit write gate', '/earn/deposit'),
  writeGate('earn withdraw write gate', '/earn/withdraw'),
  writeGate('earn configure write gate', '/earn/configure'),
  writeGate('earn tier write gate', '/earn/tier'),
  writeGate('marinade stake write gate', '/earn/marinade/stake'),
  writeGate('marinade unstake write gate', '/earn/marinade/unstake'),
  writeGate('swap execute write gate', '/swap/execute'),
  writeGate('internal transfer write gate', '/transfers/internal'),
  writeGate('external transfer write gate', '/transfers/external'),
  writeGate('hl deposit write gate', '/transfers/hl-deposit'),
  writeGate('stripe onramp write gate', '/onramp/stripe/session'),
  writeGate('onramper session write gate', '/onramp/onramper/session'),
  publicCallbackGate('stripe webhook signature gate', '/onramp/stripe/webhook'),
  writeGate('bridge customer write gate', '/bridge/customer'),
  writeGate('bridge virtual account write gate', '/bridge/virtual-account'),
  writeGate('bridge payout method write gate', '/bridge/payout-method'),
  writeGate('bridge withdraw write gate', '/bridge/withdraw'),
  publicCallbackGate('bridge deposit webhook signature gate', '/bridge/webhook'),
  publicCallbackGate('bridge transfer webhook signature gate', '/bridge/transfer-webhook'),
  writeGate('monerium offramp write gate', '/monerium/offramp'),
  writeGate('card order write gate', '/card/order'),
  writeGate('card topup write gate', '/card/topup'),
  writeGate('card freeze write gate', '/card/freeze'),
  writeGate('card limit write gate', '/card/limit'),
  writeGate('agent create write gate', '/agent/create'),
  writeGate('agent kill-switch write gate', '/agent/kill-switch'),
  writeGate('agent fund write gate', '/agent/prod-readiness-agent/fund'),
  writeGate('agent defund write gate', '/agent/prod-readiness-agent/defund'),
  writeGate('agent pause write gate', '/agent/prod-readiness-agent/pause'),
  writeGate('agent policy write gate', '/agent/prod-readiness-agent/policy'),
  writeGate('agent approve-once write gate', '/agent/prod-readiness-agent/approve-once'),
  writeGate('agent card write gate', '/agent/prod-readiness-agent/card'),
  writeGate('agent bank write gate', '/agent/prod-readiness-agent/bank'),
  writeGate('x402 pay write gate', '/x402/pay'),
  writeGate('x402 settle write gate', '/x402/settle'),
  writeGate('x402 contracts create write gate', '/x402/contracts'),
  writeGate('x402 contracts status write gate', '/x402/contracts/prod-readiness-contract/status'),
  writeGate('perps approve builder write gate', '/markets/hyperliquid/approve-builder'),
  writeGate('perps order write gate', '/markets/hyperliquid/order'),
  writeGate('perps cancel write gate', '/markets/hyperliquid/cancel'),
  writeGate('perps cancel-many write gate', '/markets/hyperliquid/cancel-many'),
  writeGate('perps modify write gate', '/markets/hyperliquid/modify'),
  writeGate('perps update leverage write gate', '/markets/hyperliquid/update-leverage'),
  writeGate('perps isolated margin write gate', '/markets/hyperliquid/update-isolated-margin'),
  writeGate('perps usd class transfer write gate', '/markets/hyperliquid/usd-class-transfer'),
  writeGate('perps usd send write gate', '/markets/hyperliquid/usd-send'),
  writeGate('perps transfer to dex write gate', '/markets/hyperliquid/transfer-to-dex'),
  writeGate('perps withdraw write gate', '/markets/hyperliquid/withdraw'),
  writeGate('spot order write gate', '/markets/hyperliquid-spot/order'),
  writeGate('spot cancel write gate', '/markets/hyperliquid-spot/cancel'),
  writeGate('jupiter quote write gate', '/markets/jupiter/quote'),
  writeGate('jupiter swap write gate', '/markets/jupiter/swap'),
  writeGate('stocks order write gate', '/markets/stocks/order'),
  writeGate('stocks cancel write gate', '/markets/stocks/cancel'),
  writeGate('polymarket order write gate', '/markets/polymarket/order'),
  writeGate('polymarket sell write gate', '/markets/polymarket/sell'),
  writeGate('polymarket enable trading write gate', '/markets/polymarket/enable-trading'),
  writeGate('polymarket wrap write gate', '/markets/polymarket/wrap'),
  writeGate('polymarket unwrap write gate', '/markets/polymarket/unwrap'),
  writeGate('cross venue cancel write gate', '/markets/orders/prod-readiness-order/cancel'),
  writeGate('cards buy write gate', '/markets/cards/buy'),
  publicRead('public market data still alive', '/markets/hyperliquid?limit=1'),
  publicRead('public cards data still alive', '/markets/cards?limit=1'),
];

function header(headers, name) {
  return headers.get(name) ?? '';
}

function rowOk(row) {
  return row.statusOk && row.edgeOk && row.vercelOk && (!row.needsCredentialedCors || row.corsCredentialsOk);
}

async function check(c) {
  const started = Date.now();
  try {
    const res = await fetch(`${API_BASE}${c.path}`, {
      method: c.method,
      headers: c.headers,
      body: c.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(process.env.NEXA_PROD_PROBE_TIMEOUT_MS ?? 15_000)),
    });
    const text = await res.text().catch(() => '');
    const headers = res.headers;
    const row = {
      label: c.label,
      method: c.method,
      url: `${API_BASE}${c.path}`,
      status: res.status,
      statusOk: c.expected.includes(res.status),
      accessControlAllowOrigin: header(headers, 'access-control-allow-origin'),
      accessControlAllowCredentials: header(headers, 'access-control-allow-credentials'),
      needsCredentialedCors: c.cors,
      corsCredentialsOk: !c.cors || (
        header(headers, 'access-control-allow-origin') === ORIGIN &&
        header(headers, 'access-control-allow-credentials').toLowerCase() === 'true'
      ),
      server: header(headers, 'server'),
      edgeOk: header(headers, 'server').toLowerCase().includes('cloudflare'),
      vercelOk: !Array.from(headers.keys()).some((h) => h.toLowerCase().startsWith('x-vercel')),
      bodyPreview: text.slice(0, 240),
      elapsedMs: Date.now() - started,
    };
    return { ...row, ok: rowOk(row), blocker: blocker(row) };
  } catch (e) {
    return {
      label: c.label,
      method: c.method,
      url: `${API_BASE}${c.path}`,
      status: 0,
      ok: false,
      blocker: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - started,
    };
  }
}

function blocker(row) {
  if (!row.statusOk) return `unexpected_status_${row.status}`;
  if (!row.edgeOk) return 'not_cloudflare_edge';
  if (!row.vercelOk) return 'unexpected_vercel_header';
  if (row.needsCredentialedCors && !row.corsCredentialsOk) return 'missing_credentialed_cors';
  return '';
}

async function runProbe() {
  const rows = [];
  for (const c of CHECKS) rows.push(await check(c));
  const failed = rows.filter((r) => !r.ok).length;
  return { generatedAt: new Date().toISOString(), apiBase: API_BASE, origin: ORIGIN, rows, summary: { total: rows.length, failed, passed: rows.length - failed } };
}

function renderMarkdown(report) {
  const lines = [
    '# Production Transaction Readiness Probe',
    '',
    `Generated: ${report.generatedAt}`,
    `API base: ${report.apiBase}`,
    `Origin: ${report.origin}`,
    '',
    '| Label | Method | URL | Status | ACAO | ACAC | OK | Blocker |',
    '|---|---|---|---:|---|---|---|---|',
  ];
  for (const r of report.rows) {
    lines.push(`|${r.label}|${r.method}|${r.url}|${r.status}|${r.accessControlAllowOrigin ?? '-'}|${r.accessControlAllowCredentials ?? '-'}|${r.ok}|${r.blocker || '-'}|`);
  }
  lines.push('', '## Summary', '', `Passed: ${report.summary.passed}`, `Failed: ${report.summary.failed}`, `Total: ${report.summary.total}`);
  return `${lines.join('\n')}\n`;
}

async function write(report) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `production-transaction-readiness-${TODAY}.json`);
  const mdPath = path.join(OUT_DIR, `production-transaction-readiness-${TODAY}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath };
}

function selfTest() {
  assert.equal(rowOk({ statusOk: true, edgeOk: true, vercelOk: true, needsCredentialedCors: false }), true);
  assert.equal(rowOk({ statusOk: true, edgeOk: true, vercelOk: true, needsCredentialedCors: true, corsCredentialsOk: false }), false);
  assert.equal(blocker({ statusOk: true, edgeOk: true, vercelOk: true, needsCredentialedCors: true, corsCredentialsOk: false }), 'missing_credentialed_cors');
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    console.log('probe-production-transaction-readiness self-test ok');
    return;
  }
  const report = await runProbe();
  const files = await write(report);
  console.log(`production transaction readiness probe wrote ${path.relative(ROOT, files.jsonPath)} and ${path.relative(ROOT, files.mdPath)}`);
  console.log(`failed=${report.summary.failed} passed=${report.summary.passed} total=${report.summary.total}`);
  if (report.summary.failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

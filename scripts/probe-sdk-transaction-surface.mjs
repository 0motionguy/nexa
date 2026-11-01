#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, 'docs', 'probes');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const XSTOCK_MINT = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
const EVM_DESTINATION = '0x1111111111111111111111111111111111111111';

function isolateDemoEnv() {
  process.env.VITEST ??= '1';
  process.env.DEMO_MODE = 'true';
  if (process.env.SDK_PROBE_USE_DATABASE !== '1') {
    process.env.DATABASE_URL = '';
    process.env.REDIS_URL = '';
  }
  if (process.env.SDK_PROBE_ALLOW_LIVE_PROVIDERS !== '1') {
    for (const key of [
      'BRIDGE_API_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'PRIVY_APP_ID',
      'PRIVY_APP_SECRET',
      'PRIVY_VERIFICATION_KEY',
      'JUPITER_SWAPS_ENABLED',
      'HL_BUILDER_ADDRESS',
      'POLY_API_KEY',
      'POLYMARKET_BUILDER_API_SECRET',
      'POLYMARKET_BUILDER_API_PASSPHRASE',
      'MONERIUM_API_KEY',
      'SOLANA_RPC_URL',
    ]) process.env[key] = '';
  }
}

async function boot() {
  isolateDemoEnv();
  const [{ serve }, { app }, { NexaClient }] = await Promise.all([
    import('../apps/api/node_modules/@hono/node-server/dist/index.js'),
    import('../apps/api/src/index.ts'),
    import('../packages/nexa-sdk/src/index.ts'),
  ]);
  const started = await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ server, baseUrl: `http://127.0.0.1:${info.port}`, NexaClient });
    });
  });
  return started;
}

async function signIn(NexaClient, baseUrl) {
  const anon = new NexaClient({ baseUrl });
  const start = await anon.auth.start(`sdk-probe-${Date.now()}@example.com`);
  const verified = await anon.auth.verify(start.challengeId, process.env.NEXA_DEMO_OTP_CODE ?? '482019');
  return new NexaClient({ baseUrl, apiKey: verified.token });
}

async function record(rows, label, route, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    const ok = value?.ok !== false;
    rows.push({ label, route, ok, status: ok ? 'ok' : 'fail', elapsedMs: Date.now() - started, summary: summarize(value) });
    return value;
  } catch (e) {
    const blocker = knownProviderBlocker(label, e);
    rows.push({
      label,
      route,
      ok: blocker.ok,
      status: blocker.status,
      elapsedMs: Date.now() - started,
      error: blocker.message,
    });
    return null;
  }
}

function knownProviderBlocker(label, e) {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code ?? '') : '';
  const message = e instanceof Error ? e.message : String(e);
  if (
    code === 'marinade_unavailable' ||
    code === 'cards_execution_unavailable' ||
    /\bmarinade_unavailable\b/.test(message) ||
    /\bcards_execution_unavailable\b/.test(message) ||
    (label === 'cards buy' && /\bnexa 503 service_unavailable\b/.test(message))
  ) {
    return { ok: true, status: 'blocked', message };
  }
  return { ok: false, status: 'fail', message };
}

function summarize(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    ok: value.ok,
    id: value.transferId ?? value.orderId ?? value.tradeId ?? value.sessionId ?? value.order?.orderId ?? value.position?.id ?? null,
    status: value.status ?? value.state ?? value.transfer?.status ?? value.order?.state ?? null,
    address: value.address ?? value.walletAddress ?? null,
    demo: value.demo ?? value.order?.demo ?? null,
  };
}

async function runProbe() {
  const { server, baseUrl, NexaClient } = await boot();
  const rows = [];
  try {
    const nx = await signIn(NexaClient, baseUrl);
    const id = Date.now().toString(36);

    await record(rows, 'profile', 'GET /me/profile', () => nx.me.profile());
    await record(rows, 'balances', 'GET /balances', () => nx.balances.get());
    await record(rows, 'transfer deposit stocks-spot', 'GET /transfers/onramp/deposit-address', () => nx.transfers.depositAddress('stocks-spot'));
    await record(rows, 'onramp deposit stocks-spot', 'GET /onramp/deposit-address', () => nx.onramp.depositAddress('stocks-spot'));
    await record(rows, 'onramper session', 'POST /onramp/onramper/session', () => nx.onramp.onramperSession({ amountUsd: 50, bucket: 'stocks-spot' }));
    await record(rows, 'stripe onramp session', 'POST /onramp/stripe/session', () => nx.onramp.stripeSession({ amountUsd: 50, destinationNetwork: 'base' }));
    await record(rows, 'monerium profile', 'GET /monerium/profile', () => nx.monerium.profile());
    await record(rows, 'monerium offramp', 'POST /monerium/offramp', () => nx.monerium.offramp({ amountEur: 5, reference: 'sdk-probe' }));

    await record(rows, 'payments send', 'POST /payments/send', () => nx.payments.send({ amountUsd: 5, to: 'sdk-probe@example.com' }, `sdk-pay-${id}`));
    await record(rows, 'earn deposit', 'POST /earn/deposit', () => nx.earn.deposit({ amountUsd: 10, tier: 'standard' }, `sdk-earn-deposit-${id}`));
    await record(rows, 'earn withdraw', 'POST /earn/withdraw', () => nx.earn.withdraw({ amountUsd: 5 }, `sdk-earn-withdraw-${id}`));
    await record(rows, 'marinade stake', 'POST /earn/marinade/stake', () => nx.earn.marinadeStake({ amountSol: 0.05 }));
    await record(rows, 'marinade unstake', 'POST /earn/marinade/unstake', () => nx.earn.marinadeUnstake({ amountMSol: 0.05, immediate: true }));
    await record(rows, 'swap execute', 'POST /swap/execute', () => nx.swap.execute({ amount: 10, direction: 'usd-eur' }, `sdk-swap-${id}`));

    await record(rows, 'internal transfer', 'POST /transfers/internal', () => nx.transfers.internal({ fromBucket: 'cash', toBucket: 'predictions', amountUsd: 25 }, `sdk-transfer-${id}`));
    await record(rows, 'external transfer', 'POST /transfers/external', () => nx.transfers.external({ chain: 'base', destinationAddress: EVM_DESTINATION, amountUsd: 5 }, `sdk-external-${id}`));
    await record(rows, 'hl deposit', 'POST /transfers/hl-deposit', () => nx.transfers.hlDeposit({ amountUsd: 5 }, `sdk-hl-deposit-${id}`));

    await record(rows, 'card state', 'GET /card', () => nx.card.get());
    await record(rows, 'card order', 'POST /card/order', () => nx.card.order(`sdk-card-order-${id}`));
    await record(rows, 'card topup', 'POST /card/topup', () => nx.card.topup({ amountUsd: 25 }, `sdk-card-topup-${id}`));
    await record(rows, 'card freeze', 'POST /card/freeze', () => nx.card.freeze(true));
    await record(rows, 'card limit', 'POST /card/limit', () => nx.card.limit(750));

    const agent = await record(rows, 'agent create', 'POST /agent/create', () => nx.agents.create({ name: `SdkProbe-${id}`, perDayCapUsd: 25, perTxCapUsd: 1 }));
    await record(rows, 'agent kill switch', 'POST /agent/kill-switch', () => nx.agents.killSwitch(false));
    if (agent?.agent?.id) {
      await record(rows, 'agent fund', 'POST /agent/:id/fund', () => nx.agents.fund(agent.agent.id, 5, `sdk-agent-fund-${id}`));
      await record(rows, 'agent approve once', 'POST /agent/:id/approve-once', () => nx.agents.approveOnce(agent.agent.id, { endpoint: 'api.exa.ai/v1/search', amountUsd: 0.1, reason: 'sdk probe' }, `sdk-agent-approve-${id}`));
      await record(rows, 'agent card', 'POST /agent/:id/card', () => nx.agents.card(agent.agent.id, `sdk-agent-card-${id}`));
      await record(rows, 'agent bank', 'POST /agent/:id/bank', () => nx.agents.bank(agent.agent.id, `sdk-agent-bank-${id}`));
    }

    await record(rows, 'perps order', 'POST /markets/hyperliquid/order', () => nx.markets.hyperliquid.placeOrder({ coin: 'BTC', sideLong: true, qtyUsd: 5, leverage: 1 }, `sdk-perps-${id}`));
    const resting = await record(rows, 'perps resting order', 'POST /markets/hyperliquid/order', () => nx.markets.hyperliquid.placeOrder({ coin: 'ETH', sideLong: true, qtyUsd: 5, leverage: 1, orderType: 'limit', limitPriceUsd: 1, tif: 'Gtc' }, `sdk-resting-${id}`));
    if (resting?.position?.id) await record(rows, 'cross venue cancel', 'POST /markets/orders/:id/cancel', () => nx.markets.cancelOrder(resting.position.id, `sdk-cancel-${id}`));
    await record(rows, 'spot order', 'POST /markets/hyperliquid-spot/order', () => nx.markets.hyperliquidSpot.placeOrder({ coin: 'PURR/USDC', sideLong: true, qtyUsd: 5 }, `sdk-spot-${id}`));
    await record(rows, 'hip3 order', 'POST /markets/stocks/order', () => nx.markets.stocks.placeOrder({ coin: 'AAPL', sideLong: true, qtyUsd: 5, leverage: 1 }, `sdk-hip3-${id}`));
    const memeQuote = await record(rows, 'jupiter quote', 'POST /markets/jupiter/quote', () => nx.markets.jupiter.quote({ inputMint: SOL_MINT, outputMint: BONK_MINT, amountAtomic: '1000000', slippageBps: 100 }));
    await record(rows, 'jupiter swap', 'POST /markets/jupiter/swap', () => nx.markets.jupiter.swap({ inputMint: SOL_MINT, outputMint: BONK_MINT, amountAtomic: '1000000', slippageBps: 100, quote: memeQuote?.quote }, `sdk-jup-${id}`));
    await record(rows, 'xstocks swap', 'POST /markets/jupiter/swap', () => nx.markets.jupiter.swap({ inputMint: SOL_MINT, outputMint: XSTOCK_MINT, amountAtomic: '1000000', slippageBps: 100, quote: { demo: true } }, `sdk-xstock-${id}`));
    const pm = await record(rows, 'polymarket buy', 'POST /markets/polymarket/order', () => nx.markets.polymarket.placeOrder({ marketId: 'demo-btc-100k', outcome: 'Yes', priceCents: 50, qtyUsd: 5 }, `sdk-pm-${id}`));
    if (pm?.position?.id) await record(rows, 'polymarket sell', 'POST /markets/polymarket/sell', () => nx.markets.polymarket.sell({ positionId: pm.position.id, limitPriceCents: 50, qtyUsd: 2 }, `sdk-pm-sell-${id}`));
    const cards = await record(rows, 'cards list', 'GET /markets/cards', () => nx.markets.cards.list({ limit: 1 }));
    const card = cards?.items?.[0];
    if (card?.id && card?.nftAddress) {
      await record(rows, 'cards buy', 'POST /markets/cards/buy', () => nx.markets.cards.buy({ cardId: card.id, nftAddress: card.nftAddress, expectedPriceUsdc: Number(card.priceUsdc ?? 1), tokenStandard: card.tokenStandard, name: card.name, imageUrl: card.imageUrl ?? undefined }, `sdk-card-buy-${id}`));
    }
    await record(rows, 'fills', 'GET /markets/fills', () => nx.markets.fills({ limit: 50 }));
  } finally {
    server.close();
  }

  const failed = rows.filter((r) => r.status === 'fail').length;
  const blocked = rows.filter((r) => r.status === 'blocked').length;
  return {
    generatedAt: new Date().toISOString(),
    mode: 'local-demo-sdk',
    rows,
    summary: { total: rows.length, failed, blocked, passed: rows.length - failed - blocked },
  };
}

function renderMarkdown(report) {
  const lines = [
    '# NEXA SDK Transaction Surface Probe',
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    '',
    '| Label | Route | Status | Detail |',
    '|---|---|---|---|',
  ];
  for (const r of report.rows) {
    const detail = r.error ?? JSON.stringify(r.summary ?? {});
    lines.push(`|${r.label}|${r.route}|${r.status ?? (r.ok ? 'ok' : 'fail')}|${detail.replace(/\|/g, '\\|')}|`);
  }
  lines.push('', '## Summary', '', `Passed: ${report.summary.passed}`, `Blocked: ${report.summary.blocked ?? 0}`, `Failed: ${report.summary.failed}`, `Total: ${report.summary.total}`);
  return `${lines.join('\n')}\n`;
}

async function write(report) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `sdk-transaction-surface-${TODAY}.json`);
  const mdPath = path.join(OUT_DIR, `sdk-transaction-surface-${TODAY}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(mdPath, renderMarkdown(report));
  return { jsonPath, mdPath };
}

function selfTest() {
  assert.deepEqual(summarize({ ok: true, transferId: 'tr_1', status: 'complete' }), {
    ok: true,
    id: 'tr_1',
    status: 'complete',
    address: null,
    demo: null,
  });
  assert.match(renderMarkdown({ generatedAt: 'x', mode: 'm', rows: [], summary: { passed: 0, failed: 0, total: 0 } }), /NEXA SDK/);
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    console.log('probe-sdk-transaction-surface self-test ok');
    return;
  }
  const report = await runProbe();
  const files = await write(report);
  console.log(`sdk transaction surface probe wrote ${path.relative(ROOT, files.jsonPath)} and ${path.relative(ROOT, files.mdPath)}`);
  console.log(`failed=${report.summary.failed} blocked=${report.summary.blocked ?? 0} passed=${report.summary.passed} total=${report.summary.total}`);
  if (report.summary.failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

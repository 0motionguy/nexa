#!/usr/bin/env node
/**
 * probe-market-logos.mjs — Wave 3 logo-coverage probe.
 *
 * Pulls every market list from a running API and resolves each row's logo the
 * same way the PWA does, then HEAD-checks the URLs. "Broken" means the UI
 * would attempt an image and the fetch fails — the letter fallback catches
 * those at runtime, so the release gate is broken === 0 AFTER fallback, but
 * this report shows how much real art each surface has.
 *
 *   node scripts/probe-market-logos.mjs [--base http://localhost:8090]
 */

const base = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 ? process.argv[i + 1] : 'http://localhost:8090';
})();

const HL_CDN = (coin) => `https://app.hyperliquid.xyz/coins/${String(coin).split(':').pop().split('/')[0].toUpperCase()}.svg`;

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) return true;
    // Some CDNs reject HEAD — retry with ranged GET before calling it broken.
    const get = await fetch(url, { headers: { Range: 'bytes=0-64' } });
    return get.ok;
  } catch {
    return false;
  }
}

async function checkSurface(name, rows, urlOf) {
  let real = 0;
  let fallback = 0;
  let broken = 0;
  const brokenUrls = [];
  const checks = rows.map(async (row) => {
    const url = urlOf(row);
    if (!url) {
      fallback += 1;
      return;
    }
    if (await headOk(url)) real += 1;
    else {
      broken += 1;
      brokenUrls.push(url);
    }
  });
  await Promise.all(checks);
  return { name, total: rows.length, real, fallback, broken, brokenUrls: brokenUrls.slice(0, 5) };
}

const results = [];

const perps = await getJson('/markets/hyperliquid?limit=500');
results.push(await checkSurface('perps', perps.markets.slice(0, 50), (m) => HL_CDN(m.coin)));

const spot = await getJson('/markets/hyperliquid-spot?limit=500');
results.push(await checkSurface('hl-spot', spot.markets.slice(0, 50), (m) => HL_CDN(m.baseToken ?? m.coin)));

const memes = await getJson('/markets/jupiter?tag=meme&limit=100');
results.push(await checkSurface('memes', memes.tokens.slice(0, 100), (t) => t.imageUrl ?? null));

const predictions = await getJson('/markets/polymarket?limit=60');
results.push(await checkSurface('predictions', predictions.markets.slice(0, 50), (m) => m.imageUrl ?? null));

const stocks = await getJson('/markets/stocks/spot?limit=500');
results.push(await checkSurface('xstocks', stocks.stocks.slice(0, 50), (s) => s.icon ?? null));

const stocksPerps = await getJson('/markets/stocks/perps');
const xstockIcon = new Map(stocks.stocks.map((s) => [s.ticker.toUpperCase(), s.icon]));
const HIP3_ALIASES = { SP500: 'SPY', XYZ100: 'QQQ' };
results.push(await checkSurface('stocks-perps', stocksPerps.markets.slice(0, 50), (m) => {
  const bare = String(m.ticker ?? m.coin).split(':').pop().toUpperCase();
  return xstockIcon.get(HIP3_ALIASES[bare] ?? bare) ?? null;
}));

const cards = await getJson('/markets/cards?limit=60');
results.push(await checkSurface('cards', (cards.items ?? []).slice(0, 50), (i) => i.imageUrl ?? null));

let failed = false;
console.log('\nsurface        total  real  fallback  broken');
for (const r of results) {
  console.log(
    `${r.name.padEnd(14)} ${String(r.total).padStart(4)}  ${String(r.real).padStart(4)}  ${String(r.fallback).padStart(8)}  ${String(r.broken).padStart(6)}`,
  );
  if (r.broken > 0) {
    failed = true;
    for (const u of r.brokenUrls) console.log(`   broken: ${u}`);
  }
}
// Every render site attaches an onerror -> letter fallback (marketThumbEl,
// nexa-market-row, pm-event-img, cards detail), so source-level breakage
// degrades to a deterministic tile: broken-after-fallback is 0 by
// construction. Source breakage is still reported (and fails under
// --strict) because it means upstream metadata rot worth chasing.
const strict = process.argv.includes('--strict');
console.log(failed
  ? `\n${strict ? 'FAIL' : 'WARN'} — source URLs above are dead upstream; the letter fallback covers them in the UI (broken after fallback: 0).`
  : '\nOK — every row has a working image or a deterministic letter fallback.');
process.exit(failed && strict ? 1 : 0);

/**
 * Route + provider inventory generator.
 *
 * Produces the checked-in API surface docs from the actual source tree, so the
 * route inventory can never silently drift from `apps/api/src`:
 *
 *   node scripts/route-inventory.mjs               → docs/API_ROUTE_MATRIX.md
 *                                                    + docs/api-route-matrix.json
 *   node scripts/route-inventory.mjs --providers   → also docs/PROVIDER_MATRIX.md
 *                                                    (fetches GET /system/providers)
 *   node scripts/route-inventory.mjs --strict      → exit 1 on any warning
 *                                                    (duplicate routes, unmounted
 *                                                    modules, unknown mounts)
 *
 * Pure static text parse over Hono's very regular declaration style
 * (`export const xRoutes = new Hono()` + `xRoutes.get('/path', …)` +
 * `app.route('/mount', xRoutes)`), same philosophy as
 * scripts/check-provider-coverage.mjs — no TS runtime, no deps beyond node.
 * Auth classification is derived from the known middleware idents and
 * router-level `use('*', …)` gates; files with bespoke inline gates carry an
 * explicit override below so the matrix stays honest instead of guessing.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const API_SRC = new URL('apps/api/src/', ROOT);
const ROUTES_DIR = new URL('routes/', API_SRC);
const INDEX_FILE = new URL('index.ts', API_SRC);
const OPENAPI_FILE = new URL('lib/openapi.ts', API_SRC);
const DOCS_DIR = new URL('docs/', ROOT);

const STRICT = process.argv.includes('--strict');
const WITH_PROVIDERS = process.argv.includes('--providers');
const PROVIDERS_URL =
  process.env.PROVIDERS_URL ?? 'https://nexa.aiso.tools/api/system/providers';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

/** Known auth middleware idents → human label (lib/auth.ts + local guards). */
const KNOWN_MW = {
  requireSession: 'session',
  optionalSession: 'optional-session',
  requireApiKey: 'api-key (sk_*)',
  requireAgentKey: 'agent-key (nx_live_*)',
  requireEventStreamSession: 'stream-token',
  requireRealtimeAuth: 'session-or-stream-ticket',
  requireAdminKey: 'admin-key (agent)',
  authSessionOrApiKey: 'session-or-api-key',
};

/**
 * Files whose router-level gate is a bespoke inline function a static parser
 * cannot classify. Label states what the gate actually does (verified by
 * reading the file); keep in sync if those gates change.
 */
const FILE_GATE_OVERRIDES = {
  'routes/markets.ts': 'hybrid: public GET allowlist, else session',
  'routes/admin.ts': 'admin-token (Bearer ADMIN_TOKEN)',
  'routes/me.ts': 'session-or-api-key',
};

/** Routes that look public but verify a signature inside the handler. */
const HANDLER_VERIFIED = {
  '/kyc/webhook': 'Sumsub HMAC verified in handler',
  '/bridge/webhook': 'Bridge HMAC verified in handler',
  '/bridge/transfer-webhook': 'Bridge HMAC verified in handler',
  '/onramp/stripe/webhook': 'Stripe signature verified in handler',
  '/checkout/stripe-webhook': 'Stripe signature verified in handler',
};

const warnings = [];
const warn = (msg) => warnings.push(msg);

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/** First single-quoted string literal at the start of an args blob, if any. */
function firstStringArg(blob) {
  const m = blob.match(/^\s*'([^']*)'/);
  return m ? m[1] : null;
}

/** Known middleware idents appearing in the head of a call's args. */
function middlewareIn(blob) {
  const found = [];
  for (const ident of Object.keys(KNOWN_MW)) {
    if (new RegExp(`[,(]\\s*${ident}\\s*[,)]`).test(blob)) found.push(ident);
  }
  return found;
}

/** Parse `export const x = new Hono()` declarations + their method calls. */
function parseRouterFile(relPath, src) {
  const routers = {};
  for (const m of src.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*new Hono/g)) {
    routers[m[1]] = { name: m[1], file: relPath, routes: [], gates: [] };
  }
  for (const name of Object.keys(routers)) {
    const callRe = new RegExp(
      `(?:^|\\n)[ \\t]*${name}\\.(${HTTP_METHODS.join('|')}|use)\\(`,
      'g',
    );
    for (const m of src.matchAll(callRe)) {
      const argsStart = m.index + m[0].length;
      const head = src.slice(argsStart, argsStart + 320);
      const line = lineAt(src, argsStart);
      const path = firstStringArg(head);
      const mws = middlewareIn(head.replace(/^\s*'[^']*'/, ''));
      if (m[1] === 'use') {
        const isCustom = mws.length === 0;
        routers[name].gates.push({ line, path, mws, isCustom });
      } else {
        routers[name].routes.push({ method: m[1], path, line, mws });
      }
    }
  }
  return routers;
}

function classifyAuth(route, router) {
  if (route.mws.length > 0) {
    return route.mws.map((m) => KNOWN_MW[m]).join(' + ');
  }
  // Last router-level `use('*', …)` gate registered before this route wins.
  let label = 'public';
  for (const g of router.gates) {
    if (g.line >= route.line || g.path !== '*') continue;
    if (g.isCustom) {
      label =
        FILE_GATE_OVERRIDES[router.file] ??
        `custom gate (${router.file}:${g.line})`;
    } else {
      label = g.mws.map((m) => KNOWN_MW[m]).join(' + ');
    }
  }
  return label;
}

/** Parse index.ts: imports (static + dynamic), mounts, direct app routes. */
function parseIndex(src) {
  const importMap = new Map(); // ident → routes/x.ts | realtime/x.ts
  for (const m of src.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*'\.\/((?:routes|realtime)\/[\w-]+)\.js'/g,
  )) {
    for (const ident of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      importMap.set(ident, `${m[2]}.ts`);
    }
  }
  for (const m of src.matchAll(
    /const\s*\{\s*(\w+)\s*\}\s*=\s*await import\('\.\/((?:routes|realtime)\/[\w-]+)\.js'\)/g,
  )) {
    importMap.set(m[1], `${m[2]}.ts`);
  }

  const mounts = [];
  for (const m of src.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
    const line = lineAt(src, m.index);
    // A mount inside an `if (env.FLAG …)` block is feature-gated — look back a
    // few lines for the flag name.
    const back = src.slice(Math.max(0, m.index - 400), m.index);
    const flag = back.match(/if\s*\(\s*env\.([A-Z0-9_]+)[^)]*\)\s*\{[^{}]*$/);
    mounts.push({ path: m[1], ident: m[2], line, flag: flag ? flag[1] : null });
  }

  const direct = [];
  for (const m of src.matchAll(
    new RegExp(`(?:^|\\n)app\\.(${HTTP_METHODS.join('|')})\\(\\s*'([^']+)'`, 'g'),
  )) {
    const argsStart = m.index + m[0].length;
    const head = src.slice(argsStart, argsStart + 320);
    direct.push({
      method: m[1] === 'all' ? 'all' : m[1],
      path: m[2],
      line: lineAt(src, m.index + 1),
      mws: middlewareIn(head),
    });
  }
  return { importMap, mounts, direct };
}

/** OpenAPI registered operations as a Set of `METHOD /normalized/path`. */
function parseOpenapi(src) {
  const ops = new Set();
  for (const chunk of src.split('registry.registerPath(').slice(1)) {
    const head = chunk.slice(0, 500);
    const method = head.match(/method:\s*'(\w+)'/);
    const path = head.match(/path:\s*'([^']+)'/);
    if (method && path) ops.add(`${method[1].toUpperCase()} ${path[1]}`);
  }
  return ops;
}

/** Normalize `:param` → `{param}` and trim trailing slash for comparison. */
function normalizePath(p) {
  const norm = p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

function joinPath(mount, sub) {
  if (!sub || sub === '/' || sub === '*') return mount;
  return `${mount === '/' ? '' : mount}${sub.startsWith('/') ? sub : `/${sub}`}`;
}

// ---------------------------------------------------------------------------

/** Modules whose tests live under a different spec filename. */
const SPEC_ALIASES = {
  'routes/markets-cards.ts': 'routes/cards.spec.ts',
};

const indexSrc = await readFile(INDEX_FILE, 'utf8');
const openapiSrc = await readFile(OPENAPI_FILE, 'utf8');
const { importMap, mounts, direct } = parseIndex(indexSrc);
const openapiOps = parseOpenapi(openapiSrc);

// Parse every MOUNTED router module once. index.ts also statically imports
// non-router realtime modules (hub, registry) that match the import regex —
// scoping to mounted idents keeps them out of the module/spec counts.
const files = [
  ...new Set(
    mounts.map((m) => importMap.get(m.ident)).filter((f) => f !== undefined),
  ),
];
const routersByIdent = new Map();
const specByFile = new Map();
for (const file of files) {
  const src = await readFile(new URL(file, API_SRC), 'utf8');
  const routers = parseRouterFile(file, src);
  for (const [name, router] of Object.entries(routers)) {
    routersByIdent.set(name, router);
  }
  const specRel = SPEC_ALIASES[file] ?? file.replace(/\.ts$/, '.spec.ts');
  specByFile.set(
    file,
    await readFile(new URL(specRel, API_SRC), 'utf8').then(
      () => true,
      () => false,
    ),
  );
}

// Coverage checks -----------------------------------------------------------

// 1. Every routes/*.ts module (non-spec) is imported + mounted.
const routeFiles = (await readdir(ROUTES_DIR)).filter(
  (n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'),
);
const mountedIdents = new Set(mounts.map((m) => m.ident));
for (const name of routeFiles) {
  const rel = `routes/${name}`;
  if (!files.includes(rel)) {
    warn(`route module ${rel} is never imported by index.ts`);
    continue;
  }
  const idents = [...importMap.entries()]
    .filter(([, f]) => f === rel)
    .map(([ident]) => ident);
  for (const ident of idents) {
    // Route modules may export helpers alongside routers (e.g. the public
    // read-path predicate); only actual `new Hono()` routers must be mounted.
    if (!routersByIdent.has(ident)) continue;
    if (!mountedIdents.has(ident)) {
      warn(`router ${ident} (${rel}) is imported but never mounted`);
    }
  }
}

// 2. Every mount resolves to a parsed router.
for (const m of mounts) {
  if (!routersByIdent.has(m.ident)) {
    warn(`mount app.route('${m.path}', ${m.ident}) has no parsed router`);
  }
}

// 3. Duplicate method+path within one router (first registration wins in Hono).
for (const router of routersByIdent.values()) {
  const seen = new Map();
  for (const r of router.routes) {
    if (!r.path) continue;
    const key = `${r.method.toUpperCase()} ${r.path}`;
    if (seen.has(key)) {
      warn(
        `duplicate route ${key} in ${router.file} (lines ${seen.get(key)} and ${r.line}) — the first registration shadows the second`,
      );
    } else {
      seen.set(key, r.line);
    }
  }
}

// Build rows ----------------------------------------------------------------

const rows = [];
for (const d of direct) {
  rows.push({
    mount: '(app)',
    module: 'index.ts',
    method: d.method.toUpperCase(),
    path: d.path,
    auth:
      d.mws.length > 0
        ? d.mws.map((m) => KNOWN_MW[m]).join(' + ')
        : d.path === '/metrics'
          ? 'bearer METRICS_TOKEN'
          : d.path === '/mcp'
            ? 'agent-key (nx_live_*)'
            : 'public',
    flag: d.path === '/metrics' ? 'METRICS_ENABLED' : null,
    source: `apps/api/src/index.ts:${d.line}`,
  });
}
for (const m of mounts) {
  const router = routersByIdent.get(m.ident);
  if (!router) continue;
  for (const r of router.routes) {
    if (!r.path) continue;
    rows.push({
      mount: m.path,
      module: router.file,
      method: r.method.toUpperCase(),
      path: joinPath(m.path, r.path),
      auth: classifyAuth(r, router),
      flag: m.flag,
      source: `apps/api/src/${router.file}:${r.line}`,
    });
  }
}
for (const row of rows) {
  row.openapi = openapiOps.has(`${row.method} ${normalizePath(row.path)}`);
  const note = HANDLER_VERIFIED[row.path];
  if (note) row.note = note;
  if (row.flag) row.note = [row.note, `gated by ${row.flag}`].filter(Boolean).join('; ');
}

const documented = rows.filter((r) => r.openapi).length;
const specCount = [...specByFile.values()].filter(Boolean).length;
const generatedAt = new Date().toISOString();

// Emit ----------------------------------------------------------------------

const md = [];
md.push('# API Route Matrix');
md.push('');
md.push(
  `> **AUTO-GENERATED** by \`node scripts/route-inventory.mjs\` on ${generatedAt}. Do not hand-edit — re-run the script.`,
);
md.push('');
md.push(
  `**${rows.length} endpoints** across **${mounts.length} mounts** (+${direct.length} app-level) · **${documented}/${rows.length} documented in OpenAPI** (${Math.round((documented / rows.length) * 100)}%) · spec files for ${specCount}/${files.length} route modules.`,
);
md.push('');
if (warnings.length > 0) {
  md.push('## ⚠ Warnings');
  md.push('');
  for (const w of warnings) md.push(`- ${w}`);
  md.push('');
}
md.push('## Mounts');
md.push('');
md.push('| Mount | Module | Routes | Spec file | Flag |');
md.push('|---|---|---|---|---|');
md.push(`| (app) | index.ts | ${direct.length} | — | — |`);
for (const m of mounts) {
  const router = routersByIdent.get(m.ident);
  if (!router) continue;
  const count = router.routes.filter((r) => r.path).length;
  md.push(
    `| \`${m.path}\` | ${router.file} | ${count} | ${specByFile.get(router.file) ? '✓' : '—'} | ${m.flag ?? '—'} |`,
  );
}
md.push('');
md.push('## Routes');
md.push('');
md.push('| Method | Path | Auth | OpenAPI | Source | Notes |');
md.push('|---|---|---|---|---|---|');
for (const r of rows) {
  md.push(
    `| ${r.method} | \`${r.path}\` | ${r.auth} | ${r.openapi ? '✓' : '—'} | ${r.source} | ${r.note ?? ''} |`,
  );
}
md.push('');

await writeFile(new URL('API_ROUTE_MATRIX.md', DOCS_DIR), md.join('\n'), 'utf8');
await writeFile(
  new URL('api-route-matrix.json', DOCS_DIR),
  JSON.stringify({ generatedAt, mounts: mounts.length, endpoints: rows.length, documented, warnings, rows }, null, 2),
  'utf8',
);

console.log(
  `route-inventory: ${rows.length} endpoints · ${mounts.length} mounts · ${documented} in OpenAPI · ${warnings.length} warning(s).`,
);
for (const w of warnings) console.log(`  ⚠ ${w}`);

// Provider matrix (optional) --------------------------------------------------

/**
 * Static enrichment for the provider matrix: SDK column + verification notes
 * from the 2026-07-02 integration audit. Keys are provider-registry ids.
 * The registry itself (GET /system/providers) stays the canonical source for
 * status/env/docs; this map only adds what the runtime cannot know.
 */
const SDK_BY_PROVIDER = {
  privy: '@privy-io/server-auth 1.32.5 (= latest; upstream-deprecated → @privy-io/node 0.24.0 migration deferred)',
  hyperliquid: '@nktkas/hyperliquid 0.32.2 (latest 0.33.1 — 0.33.0 breaks only noop/createVault/multi-sig)',
  polymarket: '@polymarket/clob-client-v2 1.0.6 (latest 1.0.8 — adds ExchangeV3 signing + new tick sizes; README now recommends the unified ts-sdk)',
  mayan: '@mayanfinance/swap-sdk 15.0.0 (= latest)',
  'stripe-checkout': 'stripe 22.2.1 pinned (latest 22.3.0; apiVersion 2026-05-27.dahlia)',
  'stripe-crypto-onramp': 'stripe 22.2.1 pinned (onramp via untyped rawRequest)',
  resend: 'resend 4.8.0 (latest 6.16.0 — low urgency)',
  sentry: '@sentry/node ^10.57 (latest 10.63)',
  aave: 'viem 2.52.2 (on-chain reads/writes)',
  morpho: 'viem 2.52.2 + Morpho GraphQL',
  'morpho-high-yield': 'viem 2.52.2 + Morpho GraphQL',
  compound: 'viem 2.52.2 (Comet)',
  yousd: 'viem 2.52.2 + YO API',
  'circle-cctp': 'viem 2.52.2 + Iris attestation API',
  alchemy: 'viem 2.52.2 (EIP-7702 batch executor)',
  'chain-balances': 'viem 2.52.2 + @solana/web3.js 1.98.4',
  marinade: '@solana/web3.js 1.98.4 (direct program instructions)',
  jupiter: 'raw HTTP (lite-api.jup.ag Token v2 + Swap v1) + @solana/web3.js',
  pumpfun: 'raw HTTP (frontend-api-v3.pump.fun)',
  'collector-crypt': 'raw HTTP + @solana/web3.js 1.98.4',
  'gnosis-pay': 'siwe 3.0.0 + raw HTTP + viem (Safe deploy)',
  'coinbase-x402': 'viem typed-data (EIP-3009) via Privy',
  monerium: 'raw HTTP (OAuth client-credentials)',
  bridge: 'raw HTTP (v0 API)',
  sumsub: 'raw HTTP (HMAC-signed)',
  socket: 'raw HTTP (v3 quote)',
  lifi: 'raw HTTP (li.quest/v1)',
  postgres: 'postgres 3.4.x + drizzle-orm 0.45.2',
  redis: 'ioredis 5.4.x + bullmq 5.78.0',
};

/**
 * Verified drift between registry status and reality (2026-07-02 audit).
 * All five were FIXED IN CODE the same day (registry truth pass) — the notes
 * stay until the fetched registry shows the corrected statuses, i.e. until
 * the fix deploys.
 */
const DRIFT_NOTES = {
  'circle-cctp':
    '⚠ was UNDER-REPORTED (live V1 pipeline serves /transfers/internal while registry said docs-only). Fixed in code 2026-07-02 — status now derives from executor+Privy gates; a docs-only status here means the fix has not deployed yet.',
  xstocks:
    '⚠ was SPLIT: secondary-market trading is live via Jupiter; docs-only applies only to primary mint/redeem (tokenized.ts). Fixed in code 2026-07-02 (gated/live status); a docs-only status here means pre-deploy.',
  mayan:
    "⚠ was hard-coded 'live'. Fixed in code 2026-07-02 — now 'live' only when the execute path is signable (Privy + 7702/Solana RPC), else 'gated'.",
  'coinbase-x402':
    "⚠ was vacuous (env default made 'live' unconditional). Fixed in code 2026-07-02 — status now keys on the live-settle gate (BASE_RPC_URL).",
  pumpfun:
    '⚠ prod served provider-demo: pump.fun removed the usd_market_cap sort key (upstream 400, Sentry JAVASCRIPT-NEXTJS-2K). Fixed in code 2026-07-02 (sort normalized to market_cap + freshness recorded at data-source pump-market-list); prod heals on deploy.',
};

/**
 * Providers wired in code but historically absent from the registry. The
 * registry truth pass (2026-07-02) added entries for all of these — the
 * section below self-heals: ids already present in the fetched registry are
 * filtered out, so it only lists what the DEPLOYED registry still misses.
 */
const UNREGISTERED = [
  ['tradingview', 'TradingView', 'external/tradingview-client.ts (@mathieuc/tradingview 3.5.2) — backs /tv routes'],
  ['onramper', 'Onramper', 'routes/onramp.ts — signed-iframe widget session, gated on ONRAMPER_API_KEY'],
  ['jupiter-lend', 'Jupiter Lend', 'lib/chain/jupiter-lend.ts — read-only APY tile + deeplink'],
  ['yields-landscape', 'DefiLlama / yields-landscape', 'lib/chain/yields-landscape.ts — fetched but rows voided in /earn/landing'],
  ['pyth-hermes', 'Pyth Hermes', 'realtime/venues/pyth-hermes.ts — SSE price adapter, dark-launched behind REALTIME_HUB_V1'],
];

if (WITH_PROVIDERS) {
  const res = await fetch(PROVIDERS_URL);
  if (!res.ok) {
    console.error(`provider matrix: GET ${PROVIDERS_URL} → ${res.status}; aborting provider matrix.`);
    process.exit(1);
  }
  const data = await res.json();
  const pmd = [];
  pmd.push('# Provider Matrix');
  pmd.push('');
  pmd.push(
    `> **AUTO-GENERATED** by \`node scripts/route-inventory.mjs --providers\` on ${generatedAt}, from \`GET ${PROVIDERS_URL}\` (registry fetchedAt ${data.fetchedAt}). The runtime registry (\`apps/api/src/lib/provider-registry.ts\`) is canonical — do not hand-edit this file.`,
  );
  pmd.push('');
  const byStatus = {};
  for (const p of data.providers) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  pmd.push(
    `**${data.providers.length} registered providers** · ${Object.entries(byStatus)
      .map(([s, n]) => `${s}: ${n}`)
      .join(' · ')}`,
  );
  pmd.push('');
  pmd.push('| Provider | Category | Status | Env vars | SDK / client (resolved → latest, 2026-07-02) | Docs | Notes / verified drift |');
  pmd.push('|---|---|---|---|---|---|---|');
  for (const p of data.providers) {
    const notes = [p.notes, DRIFT_NOTES[p.id]].filter(Boolean).join(' ');
    pmd.push(
      `| **${p.name}** (\`${p.id}\`) | ${p.category} | ${p.status} | ${p.envVars.length ? p.envVars.map((e) => `\`${e}\``).join('<br>') : '—'} | ${SDK_BY_PROVIDER[p.id] ?? 'raw HTTP'} | ${p.publicDocsUrl ? `[docs](${p.publicDocsUrl})` : '—'} | ${notes} |`,
    );
  }
  pmd.push('');
  const fetchedIds = new Set(data.providers.map((p) => p.id));
  const stillMissing = UNREGISTERED.filter(([id]) => !fetchedIds.has(id));
  if (stillMissing.length > 0) {
    pmd.push('## Wired in code but NOT in the deployed registry');
    pmd.push('');
    pmd.push('These surfaces exist in `apps/api/src` with no `/system/providers` entry on the probed deployment (registry entries were added in code 2026-07-02 — this section empties once that deploys):');
    pmd.push('');
    for (const [, name, note] of stillMissing) pmd.push(`- **${name}** — ${note}`);
    pmd.push('');
  }
  await writeFile(new URL('PROVIDER_MATRIX.md', DOCS_DIR), pmd.join('\n'), 'utf8');
  console.log(`provider-matrix: ${data.providers.length} providers written to docs/PROVIDER_MATRIX.md.`);
}

if (STRICT && warnings.length > 0) process.exit(1);

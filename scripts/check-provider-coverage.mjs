/**
 * F075 — provider-registry coverage gate.
 *
 * Catches three classes of drift between code and the registry:
 *
 *   1. A new adapter lands in lib/chain/ or lib/markets/ but nobody wires it
 *      into `provider-registry.ts`. The System screen would silently miss it.
 *   2. The registry references a `backendFiles` path that no longer exists
 *      (rename, deletion). The "Code path" link in the system view 404s.
 *   3. The registry references an `envVars` key that no longer exists in
 *      `env.ts`. Status resolution would either always be missing-keys, or
 *      worse, an empty env override masks the real flag.
 *
 * Pure static text parse — no TypeScript runtime, no dependencies beyond
 * node:fs. Exit 1 on misalignment so a pre-merge CI step can wire this in.
 */

import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const REGISTRY = new URL('apps/api/src/lib/provider-registry.ts', ROOT);
const ENV_FILE = new URL('apps/api/src/lib/env.ts', ROOT);
const CHAIN_DIR = new URL('apps/api/src/lib/chain/', ROOT);
const MARKETS_DIR = new URL('apps/api/src/lib/markets/', ROOT);

/**
 * Adapters that live in lib/chain or lib/markets but are infrastructure
 * (shared helpers, mirrors, internal units) rather than a vendor surface
 * the registry should advertise. Listed explicitly so a new adapter cannot
 * silently slip past coverage by reusing one of these names.
 */
const ADAPTER_EXEMPT = new Set([
  'index.ts',
  'chain-mirror.ts',
  'units.ts',
  'wallet.ts',
  'apy.ts',
  'tokenized.ts', // xstocks/dinari PRIMARY mint/redeem stays docs-only (secondary market is the xstocks entry)
  'defi.ts', // shared aave/compound APY surface; aave+compound entries cover it
  'privy-agent-wallet.ts', // listed under privy entry
  'privy-claim.ts', // listed under privy entry
  'hl-signer.ts', // signing helper; hyperliquid entry covers parent adapter
  'provider-errors.ts', // shared provider error helper; covered by venue adapters
  'types.ts', // F093 — unified MarketAdapter contract; pure type shapes, no adapter wiring
  'region.ts', // shared region gate policy (tradeGate + /me/profile); not a provider adapter
  'hl-format.ts', // shared HL canonical number formatting; not a provider adapter
]);

/**
 * Env keys we synthesize internally (e.g. NEXA_AGENT_KEYS, JWT_SECRET) or
 * that the registry doesn't surface (LOG_LEVEL, NODE_ENV). Anything in
 * provider-registry envVars MUST be present in env.ts — this list is only
 * used for the reverse check we don't run today.
 */
const _ENV_INTERNAL_PREFIXES = ['NODE_ENV', 'LOG_LEVEL', 'API_PORT', 'JWT_'];
void _ENV_INTERNAL_PREFIXES;

const failures = [];
const note = (msg) => failures.push(msg);

/** Pull every adapter-file ts that isn't a spec/test. */
async function listAdapterFiles(dirUrl) {
  const entries = await readdir(dirUrl);
  return entries.filter(
    (name) =>
      name.endsWith('.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.test.ts'),
  );
}

/**
 * Brittle but deterministic registry parser. We only need three field shapes
 * per entry, and the registry is hand-maintained with consistent formatting,
 * so a regex pass beats spawning TS just to read static data.
 */
function parseRegistry(src) {
  // Scope the scan to the ENTRIES array; the DATA_SOURCES array below also
  // uses `id:` keys but covers metric tuples, not vendors, and would inflate
  // the entry count without contributing real coverage signal.
  const entriesStart = src.indexOf('const ENTRIES');
  const entriesEnd = src.indexOf('export function buildProviderRegistry');
  if (entriesStart < 0 || entriesEnd < 0 || entriesEnd <= entriesStart) {
    note(
      'parseRegistry: could not locate ENTRIES/buildProviderRegistry markers — registry layout changed; update the parser.',
    );
    return [];
  }
  const region = src.slice(entriesStart, entriesEnd);
  const entries = [];
  const idRe = /id:\s*'([^']+)'/g;
  const idMatches = [...region.matchAll(idRe)];
  for (let i = 0; i < idMatches.length; i++) {
    const start = idMatches[i].index;
    const end = i + 1 < idMatches.length ? idMatches[i + 1].index : region.length;
    const block = region.slice(start, end);
    const envMatch = block.match(/envVars:\s*\[([\s\S]*?)\]/);
    const beMatch = block.match(/backendFiles:\s*\[([\s\S]*?)\]/);
    const envVars = envMatch
      ? [...envMatch[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1])
      : [];
    const backendFiles = beMatch
      ? [...beMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      : [];
    entries.push({ id: idMatches[i][1], envVars, backendFiles });
  }
  return entries;
}

function parseEnvKeys(src) {
  // Capture every `<KEY>: z…` line inside the schema object. env.ts mixes
  // single-line (`KEY: z.string().optional(),`) and multi-line shapes
  // (`KEY: z\n  .string()\n  .optional(),`) — the regex stops at `z` and
  // accepts either `.method()` or a newline before the chain begins.
  const keys = new Set();
  const re = /^\s+([A-Z][A-Z0-9_]+):\s*z(?=[\s.])/gm;
  for (const m of src.matchAll(re)) {
    keys.add(m[1]);
  }
  return keys;
}

const registrySrc = await readFile(REGISTRY, 'utf8');
const envSrc = await readFile(ENV_FILE, 'utf8');

const entries = parseRegistry(registrySrc);
const envKeys = parseEnvKeys(envSrc);
const chainFiles = await listAdapterFiles(CHAIN_DIR);
const marketFiles = await listAdapterFiles(MARKETS_DIR);
const adapterFiles = [
  ...chainFiles.map((n) => `apps/api/src/lib/chain/${n}`),
  ...marketFiles.map((n) => `apps/api/src/lib/markets/${n}`),
];

// 1. Every adapter file is referenced by at least one entry, or exempted.
const referencedFiles = new Set(entries.flatMap((e) => e.backendFiles));
for (const path of adapterFiles) {
  const base = path.split('/').pop();
  if (ADAPTER_EXEMPT.has(base)) continue;
  if (!referencedFiles.has(path)) {
    note(
      `adapter ${path} is not referenced by any provider-registry entry; add it to backendFiles or to ADAPTER_EXEMPT.`,
    );
  }
}

// 2. Every backendFiles path resolves to a real file on disk.
const allKnownFiles = new Set(adapterFiles);
// Routes + other top-level files referenced by the registry — read them
// lazily so a typo in any path still trips this check.
for (const e of entries) {
  for (const path of e.backendFiles) {
    if (allKnownFiles.has(path)) continue;
    try {
      await readFile(new URL(path, ROOT), 'utf8');
    } catch {
      note(
        `provider-registry entry '${e.id}' references missing file ${path}.`,
      );
    }
  }
}

// 3. Every envVar declared in the registry exists in env.ts.
for (const e of entries) {
  for (const key of e.envVars) {
    if (!envKeys.has(key)) {
      note(
        `provider-registry entry '${e.id}' references env key ${key} which is not declared in apps/api/src/lib/env.ts.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('check-provider-coverage: drift detected\n');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  console.error(
    `\n${failures.length} issue(s). Fix the misalignment or update provider-registry.ts.`,
  );
  process.exit(1);
}

console.log(
  `check-provider-coverage: OK · ${entries.length} entries · ${adapterFiles.length} adapter files · ${envKeys.size} env keys.`,
);

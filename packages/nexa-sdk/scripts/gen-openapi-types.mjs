#!/usr/bin/env node
/**
 * F088 Sprint 18 — Generate TypeScript types for the @nexa/sdk client from the
 * live `/v1/openapi.json` served by the NEXA API.
 *
 * Why this script exists
 * ----------------------
 * The hand-maintained types in `src/index.ts:246-481` have been observed to
 * drift from the actual server response (`MeProfile.trading` is the canonical
 * example — declared as `Record<string, Record<string, unknown>>` here but
 * returned as a typed `{ enabled, liveTrading, regionAllowed, walletReady,
 * feeBps }` shape by `apps/api/src/routes/me.ts`). The server already serves
 * a zod-derived OpenAPI 3.0 document via `apps/api/src/lib/openapi.ts`; this
 * script turns it into a `src/generated/api-schema.ts` file the SDK can
 * import from.
 *
 * Workflow
 * --------
 *   1. Start the NEXA API locally (`pnpm --filter @nexa/api dev`) or point
 *      `NEXA_API_URL` at a deployed instance.
 *   2. Run `pnpm --filter @nexa/sdk gen:types`.
 *   3. The script fetches `${NEXA_API_URL ?? 'http://localhost:8090'}/v1/openapi.json`,
 *      runs `npx openapi-typescript` against it, and writes the result to
 *      `src/generated/api-schema.ts`.
 *   4. Re-run `pnpm --filter @nexa/sdk typecheck` — any drift between the
 *      hand-maintained types and the generated `paths['/me']['get']['responses'][200]`
 *      surfaces as a compile error rather than a silent runtime mismatch.
 *
 * Why not generate at SDK build time
 * ----------------------------------
 * The SDK ships as a zero-dep npm package; its build must not require a
 * running server. Run this script manually whenever the API surface changes,
 * commit the regenerated `api-schema.ts`, and the SDK build stays standalone.
 *
 * Reasons this script does NOT install `openapi-typescript`
 * ---------------------------------------------------------
 * Per the project's K-rule "New dependencies require a stated reason. Don't
 * change package managers or upgrade unrelated packages." the dep landing is
 * left to a human review:
 *
 *   pnpm --filter @nexa/sdk add -D openapi-typescript
 *
 * Once that lands, this script Just Works.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const OUT_FILE = resolve(PKG_ROOT, 'src/generated/api-schema.ts');
const TMP_SPEC = resolve(PKG_ROOT, '.openapi.tmp.json');

const baseUrl = (process.env.NEXA_API_URL ?? 'http://localhost:8090').replace(/\/$/, '');
const specUrl = `${baseUrl}/v1/openapi.json`;

mkdirSync(dirname(OUT_FILE), { recursive: true });

// Strategy: try fetching from a running server first; if that fails, fall back
// to invoking the in-process dump-openapi.ts script via tsx — same result, no
// dependency on the API process being booted (which would require Redis +
// Postgres for unrelated paths).
let spec;
try {
  console.log(`[gen-openapi-types] fetching ${specUrl}…`);
  const res = await fetch(specUrl);
  if (!res.ok) throw new Error(`${specUrl} returned ${res.status}`);
  spec = await res.json();
  console.log('[gen-openapi-types] got spec from running server');
} catch (e) {
  console.log(
    `[gen-openapi-types] server fetch failed (${e instanceof Error ? e.message : String(e)}); falling back to in-process dump`,
  );
  const dumpScript = resolve(PKG_ROOT, 'scripts/dump-openapi.ts');
  const tsxBin = resolve(
    PKG_ROOT,
    '../../apps/api/node_modules/.bin/tsx' + (process.platform === 'win32' ? '.CMD' : ''),
  );
  try {
    // .CMD files on Windows can't be spawned directly by Node — they require
    // a shell. Use `spawnSync` with shell:true. Wrap each path-with-spaces in
    // double quotes so the shell parses them as single arguments. POSIX uses
    // execFileSync (no shell needed for ELF binaries / shebangs).
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(`"${tsxBin}" "${dumpScript}"`, {
        stdio: 'inherit',
        cwd: PKG_ROOT,
        shell: true,
      });
      if (r.status !== 0) throw new Error(`tsx exit ${r.status}`);
    } else {
      execFileSync(tsxBin, [dumpScript], { stdio: 'inherit', cwd: PKG_ROOT });
    }
  } catch (err) {
    console.error('[gen-openapi-types] in-process dump also failed:');
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      '[gen-openapi-types] either start the API (`pnpm --filter @nexa/api dev`) or install tsx in apps/api.',
    );
    process.exit(1);
  }
  const { readFileSync } = await import('node:fs');
  spec = JSON.parse(readFileSync(TMP_SPEC, 'utf8'));
}
writeFileSync(TMP_SPEC, JSON.stringify(spec, null, 2));

console.log(`[gen-openapi-types] running openapi-typescript → ${OUT_FILE}`);
try {
  // Use `pnpm exec` from PKG_ROOT (workspace cwd). Pass RELATIVE paths so
  // workspace roots with spaces (e.g. "D:\dev\Neo Bank") don't confuse the
  // openapi-typescript CLI's path-parsing — it doesn't tolerate spaces in
  // absolute argv paths on Windows.
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'openapi-typescript', '.openapi.tmp.json', '-o', 'src/generated/api-schema.ts'],
    { stdio: 'inherit', cwd: PKG_ROOT, shell: process.platform === 'win32' },
  );
  if (r.status !== 0) throw new Error(`openapi-typescript exit ${r.status}`);
} catch (e) {
  console.error(
    `[gen-openapi-types] openapi-typescript failed: ${e instanceof Error ? e.message : String(e)}`,
  );
  console.error('[gen-openapi-types] install it first:');
  console.error('  pnpm --filter @nexa/sdk add -D openapi-typescript');
  process.exit(1);
}

console.log('[gen-openapi-types] done. Generated types at src/generated/api-schema.ts');
console.log(
  '[gen-openapi-types] next step: import { paths } from "./generated/api-schema.js" in src/index.ts',
);
console.log(
  '                    and replace hand-maintained response shapes with paths[...][...][...].',
);

#!/usr/bin/env node
/**
 * verify:neo — cross-repo verification gate for the NEO Expo/native/web
 * workspace.
 *
 * Why this exists
 * ---------------
 * NEXA and NEO are two separate git repositories at:
 *
 *   D:/dev/Neo Bank/nexa/   (this repo, "@nexa" workspace)
 *   D:/dev/Neo Bank/neo/    (NEO Expo client, separate git repo)
 *
 * The root `pnpm verify` chain only filters `--filter @nexa/*`, so NEO
 * (whose package name is just `neo`, not under that filter) gets skipped.
 * This script bridges the gap by invoking install + typecheck + test
 * inside neo/ and bubbling up the exit code.
 *
 * Skip switch
 * -----------
 * `SKIP_NEO_VERIFY=1 pnpm verify` will print a warning and exit 0 without
 * touching neo/. Use this only when neo/ is mid-refactor (lockfile drift,
 * known broken state) and you specifically want to verify nexa/ alone.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const NEO_DIR = resolve(here, '..', '..', 'neo');

if (process.env.SKIP_NEO_VERIFY === '1') {
  console.log('[verify:neo] SKIP_NEO_VERIFY=1 — skipping NEO verification.');
  process.exit(0);
}

if (!existsSync(NEO_DIR)) {
  console.error(`[verify:neo] NEO workspace not found at: ${NEO_DIR}`);
  console.error('[verify:neo] Either NEO has moved or the cross-repo layout has changed.');
  console.error('[verify:neo] Set SKIP_NEO_VERIFY=1 to bypass while investigating.');
  process.exit(1);
}

const steps = [
  { name: 'install', cmd: 'pnpm', args: ['install', '--frozen-lockfile'] },
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'test', cmd: 'pnpm', args: ['test'] },
];

console.log(`[verify:neo] Running gate in ${NEO_DIR}`);
const started = Date.now();

for (const step of steps) {
  console.log(`[verify:neo] -> ${step.name}: ${step.cmd} ${step.args.join(' ')}`);
  const result = spawnSync(step.cmd, step.args, {
    cwd: NEO_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`[verify:neo] FAILED at "${step.name}" (exit ${result.status ?? 'null'})`);
    console.error('[verify:neo] If NEO is mid-refactor and this is a known-WIP failure,');
    console.error('[verify:neo] re-run with SKIP_NEO_VERIFY=1 — but fix the failure soon.');
    process.exit(result.status ?? 1);
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`[verify:neo] OK (${seconds}s)`);

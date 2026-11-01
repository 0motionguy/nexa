#!/usr/bin/env node
/**
 * Fetches IBM Plex Mono + Inter woff2 files (latin subset, weights 400/500/600)
 * into public/fonts/. Idempotent — skips files that already exist.
 *
 * Usage: node scripts/fetch-fonts.mjs
 */
import { writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = resolve(__dirname, '..', 'public', 'fonts');

const SOURCES = [
  {
    name: 'IBMPlexMono-Regular.woff2',
    url: 'https://github.com/IBM/plex/raw/master/packages/plex-mono/fonts/complete/woff2/IBMPlexMono-Regular.woff2',
  },
  {
    name: 'IBMPlexMono-Medium.woff2',
    url: 'https://github.com/IBM/plex/raw/master/packages/plex-mono/fonts/complete/woff2/IBMPlexMono-Medium.woff2',
  },
  {
    name: 'IBMPlexMono-SemiBold.woff2',
    url: 'https://github.com/IBM/plex/raw/master/packages/plex-mono/fonts/complete/woff2/IBMPlexMono-SemiBold.woff2',
  },
  {
    name: 'Inter-Regular.woff2',
    url: 'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Regular.woff2',
  },
  {
    name: 'Inter-Medium.woff2',
    url: 'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Medium.woff2',
  },
  {
    name: 'Inter-SemiBold.woff2',
    url: 'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-SemiBold.woff2',
  },
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(FONTS_DIR, { recursive: true });

  let fetched = 0;
  let skipped = 0;

  for (const { name, url } of SOURCES) {
    const dest = resolve(FONTS_DIR, name);
    if (await exists(dest)) {
      console.log(`✓ skip ${name} (exists)`);
      skipped++;
      continue;
    }
    process.stdout.write(`↓ ${name}... `);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      console.error(`FAILED (${res.status} ${res.statusText})`);
      process.exitCode = 1;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    console.log(`${(buf.length / 1024).toFixed(1)} KB`);
    fetched++;
  }

  console.log(`\nDone. ${fetched} fetched, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

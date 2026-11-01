#!/usr/bin/env node
/**
 * Rasterize public/icons/m-emblem.svg into PWA PNGs (192, 512, 1024-maskable).
 *
 * Uses Playwright (already installed for E2E). Headless Chromium renders the
 * SVG sized to each viewport, then screenshots the element with transparent
 * background. The maskable variant adds a safe-area pad so iOS home-screen
 * masking doesn't crop the M.
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(__dirname, '../public/icons');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#FF6A1A"/>
  <g fill="#F5F6FA">
    <rect x="14" y="14" width="8" height="36"/>
    <rect x="28" y="22" width="8" height="28"/>
    <rect x="42" y="14" width="8" height="36"/>
  </g>
</svg>`;

const MASKABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#FF6A1A"/>
  <g fill="#F5F6FA" transform="translate(22, 22) scale(0.875)">
    <rect x="14" y="14" width="8" height="36"/>
    <rect x="28" y="22" width="8" height="28"/>
    <rect x="42" y="14" width="8" height="36"/>
  </g>
</svg>`;

async function render(svg, size, outFile) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.setContent(
      `<html><body style="margin:0;padding:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
      { waitUntil: 'load' },
    );
    const buf = await page.locator('svg').screenshot({ omitBackground: true });
    writeFileSync(outFile, buf);
    console.log(`wrote ${outFile}`);
  } finally {
    await browser.close();
  }
}

await render(SVG, 192, resolve(ICONS_DIR, 'icon-192.png'));
await render(SVG, 512, resolve(ICONS_DIR, 'icon-512.png'));
await render(MASKABLE_SVG, 1024, resolve(ICONS_DIR, 'icon-1024-maskable.png'));
console.log('icons regenerated.');

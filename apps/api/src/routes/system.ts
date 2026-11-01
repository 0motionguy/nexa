/**
 * System — observability surface for vendor + data-source status.
 *
 *   GET /system/providers      → registry of every vendor we depend on, with
 *                                live/sandbox/missing-keys/etc status
 *   GET /system/data-sources   → running snapshot of (provider, metric) freshness
 *                                so the System screen can show "APY · Morpho ·
 *                                Live · 12s ago" for everything the user can see
 *   GET /system/health         → liveness probe. Anonymous: ok/name/fetchedAt
 *                                only. Session-authenticated: also exposes
 *                                demo/backend/features. Sprint 17 F070 — the
 *                                full envelope used to be public, which
 *                                fingerprinted the deployment posture (demo
 *                                mode, store backend, vendor coverage).
 *
 * /providers + /data-sources stay public by design — they document the
 * integration surface and have no secrets. /health/detail is the new
 * authenticated companion to /health.
 */

import { Hono } from 'hono';
import { env, features } from '../lib/env.js';
import { optionalSession } from '../lib/auth.js';
import { buildDataSources, buildProviderRegistry } from '../lib/provider-registry.js';
import { detectTokenizedCapabilities } from '../lib/markets/tokenized.js';
import { storeBoot } from '../store/index.js';

/** Default tokenized-stocks symbols the UI asks about when no override is provided. */
const DEFAULT_TOKENIZED_SYMBOLS = ['AAPLx', 'TSLAx', 'SPYx', 'NVDAx', 'GOOGLx', 'MSFTx'];

export const systemRoutes = new Hono();

systemRoutes.get('/providers', (c) => {
  const fetchedAt = new Date().toISOString();
  return c.json({
    ok: true,
    fetchedAt,
    providers: buildProviderRegistry(),
  });
});

systemRoutes.get('/data-sources', (c) => {
  const fetchedAt = new Date().toISOString();
  return c.json({
    ok: true,
    fetchedAt,
    sources: buildDataSources(),
  });
});

systemRoutes.get('/health', optionalSession, (c) => {
  // Sprint 17 F070 — anonymous callers get a stripped envelope; authenticated
  // callers (the in-app System screen) get the full feature flag matrix +
  // backend + demo flag.
  const u = c.get('user');
  const base = {
    ok: true as const,
    name: 'nexa-api',
    fetchedAt: new Date().toISOString(),
  };
  if (!u) return c.json(base);
  return c.json({
    ...base,
    demo: env.DEMO_MODE,
    backend: storeBoot.backend,
    features,
  });
});

/**
 * Tokenized-stocks capability snapshot. `?symbols=AAPLx,TSLAx,...` overrides
 * the default list. The frontend uses this to decide which assets to render
 * — anything with `routable: false` stays hidden so users never see "Buy
 * Apple stock" we can't actually execute.
 */
systemRoutes.get('/tokenized-stocks', async (c) => {
  const raw = c.req.query('symbols');
  const symbols = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TOKENIZED_SYMBOLS;
  const capabilities = await detectTokenizedCapabilities(symbols);
  return c.json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    capabilities,
  });
});

/**
 * /system surface integration tests — Sprint 15.
 *
 * Covers the provider registry, data-sources snapshot, and the health probe.
 * Verifies the no-leak invariants the live-wiring rollout demands:
 *   - every provider in the registry has a documented status that matches the
 *     active features.* flag
 *   - data-sources never report `provider-demo` outside DEMO_MODE
 *   - the system surface is unauthenticated (no session token required)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';

let server: ServerType;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

describe('system routes', () => {
  it('GET /system/providers is unauthenticated and returns the registry', async () => {
    const { status, body } = await get('/system/providers');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThanOrEqual(15);
    expect(body.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('every provider entry carries a documented shape', async () => {
    const { body } = await get('/system/providers');
    for (const p of body.providers) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect([
        'wallet',
        'kyc',
        'onramp',
        'offramp',
        'stablecoin',
        'swap',
        'defi-yield',
        'card',
        'agent-wallet',
        'x402',
        'markets',
        'tokenized-stocks',
        'observability',
        'email',
        'persistence',
        'auth',
      ]).toContain(p.category);
      expect([
        'live',
        'sandbox',
        'gated',
        'docs-only',
        'missing-keys',
        'disabled',
      ]).toContain(p.status);
      expect(Array.isArray(p.envVars)).toBe(true);
      expect(typeof p.demoFallbackAllowed).toBe('boolean');
    }
  });

  it('tokenized-stocks: dinari stays docs-only; xstocks reflects the live Jupiter secondary market', async () => {
    const { body } = await get('/system/providers');
    const xstocks = body.providers.find((p: { id: string }) => p.id === 'xstocks');
    const dinari = body.providers.find((p: { id: string }) => p.id === 'dinari');
    expect(xstocks).toBeDefined();
    expect(dinari).toBeDefined();
    // Secondary-market xStocks trade through Jupiter today (reads public,
    // swaps behind JUPITER_SWAPS_ENABLED + Privy + RPC) — never docs-only.
    // Only primary mint/redeem (lib/markets/tokenized.ts) stays partner-gated.
    expect(xstocks.status).toBe('gated'); // flagless test env: markets on, swaps off
    expect(xstocks.notes).toMatch(/primary mint\/redeem/i);
    expect(dinari.status).toBe('docs-only');
    expect(xstocks.demoFallbackAllowed).toBe(false);
    expect(dinari.demoFallbackAllowed).toBe(false);
  });

  it('registry truth: money-rail statuses derive from real gates, not env defaults', async () => {
    const { body } = await get('/system/providers');
    const byId = new Map<string, { status: string }>(
      body.providers.map((p: { id: string; status: string }) => [p.id, p]),
    );
    // Flagless test env: none of these can execute — none may claim live.
    expect(byId.get('circle-cctp')?.status).toBe('missing-keys');
    expect(byId.get('coinbase-x402')?.status).toBe('missing-keys');
    expect(byId.get('mayan')?.status).toBe('gated');
    // Surfaces wired in code must be registered (were invisible before).
    for (const id of ['onramper', 'jupiter-lend', 'yields-landscape', 'tradingview', 'pyth-hermes']) {
      expect(byId.get(id), `registry entry missing: ${id}`).toBeDefined();
    }
    // Dark-launched realtime venue reports disabled while the hub flag is off;
    // keyless Onramper serves the public sandbox widget.
    expect(byId.get('pyth-hermes')?.status).toBe('disabled');
    expect(byId.get('onramper')?.status).toBe('sandbox');
  });

  it('yoUSD is live through the public YO Protocol API (no demo APY)', async () => {
    const { body } = await get('/system/providers');
    const yousd = body.providers.find((p: { id: string }) => p.id === 'yousd');
    expect(yousd).toBeDefined();
    expect(yousd.status).toBe('live');
    expect(yousd.demoFallbackAllowed).toBe(false);
  });

  it('GET /system/data-sources returns every documented mapping', async () => {
    const { status, body } = await get('/system/data-sources');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources.length).toBeGreaterThan(0);
    const ids = body.sources.map((s: { id: string }) => s.id);
    expect(ids).toContain('home-blended-apy');
    expect(ids).toContain('swap-quote');
    expect(ids).toContain('hl-market-list');
  });

  it('data-source meta carries a documented kind only', async () => {
    const { body } = await get('/system/data-sources');
    const allowed = ['live', 'sandbox', 'cached-live', 'provider-demo', 'unavailable', 'error'];
    for (const src of body.sources) {
      expect(allowed).toContain(src.meta.source);
      expect(typeof src.meta.provider).toBe('string');
    }
  });

  it('GET /system/health unauthenticated returns stripped envelope (F070)', async () => {
    const { status, body } = await get('/system/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.name).toBe('nexa-api');
    expect(typeof body.fetchedAt).toBe('string');
    // Sprint 17 F070 — the deployment-fingerprinting fields no longer leak
    // to anonymous callers.
    expect(body).not.toHaveProperty('demo');
    expect(body).not.toHaveProperty('backend');
    expect(body).not.toHaveProperty('features');
  });

  it('GET /system/health with a session bearer exposes the feature flag matrix', async () => {
    // Boot a demo OTP session so we can call /system/health authenticated.
    const start = await fetch(base + '/auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'system-health@example.com' }),
    });
    expect(start.status).toBe(200);
    const { challengeId } = (await start.json()) as { challengeId: string };
    expect(typeof challengeId).toBe('string');

    const verify = await fetch(base + '/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, code: '482019' }),
    });
    expect(verify.status).toBe(200);
    const { token } = (await verify.json()) as { token: string };
    expect(typeof token).toBe('string');

    const res = await fetch(base + '/system/health', {
      headers: { authorization: 'Bearer ' + token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.demo).toBe('boolean');
    expect(['in-memory', 'postgres']).toContain(body.backend);
    expect(typeof body.features).toBe('object');
    const features = body.features as Record<string, unknown>;
    expect(features).toHaveProperty('privy');
    expect(features).toHaveProperty('chain');
    expect(features).toHaveProperty('markets');
  });

  it('GET /system/tokenized-stocks returns capability=false for every default symbol', async () => {
    const { status, body } = await get('/system/tokenized-stocks');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.fetchedAt).toBe('string');
    expect(body.capabilities).toBeDefined();
    for (const [_symbol, cap] of Object.entries(body.capabilities) as Array<[
      string,
      { provider: string; routable: boolean; reason?: string },
    ]>) {
      expect(['none', 'xstocks', 'dinari']).toContain(cap.provider);
      expect(cap.routable).toBe(false); // never routable without partner keys
    }
  });

  it('GET /system/tokenized-stocks honours ?symbols= override', async () => {
    const { body } = await get('/system/tokenized-stocks?symbols=AAPLx,TSLAx');
    expect(Object.keys(body.capabilities)).toEqual(['AAPLx', 'TSLAx']);
  });
});

/**
 * Tests for the Prometheus instrument layer + the /metrics endpoint gate.
 *
 * The /metrics endpoint is mounted in apps/api/src/index.ts so we import the
 * full app + reset env before the import to test the auth/feature gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

describe('lib/metrics', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('exposes the http_request_duration_seconds histogram', async () => {
    const m = await import('./metrics.js');
    const reg = m.getRegistry();
    const metric = reg.getSingleMetric('http_request_duration_seconds');
    expect(metric).toBeDefined();
  });

  it('exposes every domain counter we promise downstream', async () => {
    const m = await import('./metrics.js');
    const reg = m.getRegistry();
    const expected = [
      'payments_created_total',
      'payments_paid_total',
      'payments_failed_total',
      'claims_created_total',
      'claims_claimed_total',
      'claims_expired_total',
      'earn_deposit_total',
      'earn_withdraw_total',
      'mcp_requests_total',
      'x402_settlements_total',
      'markets_orders_total',
      'campaign_payouts_total',
      'bullmq_queue_depth',
    ];
    for (const name of expected) {
      expect(reg.getSingleMetric(name), `missing instrument: ${name}`).toBeDefined();
    }
  });

  it('recordHttpDuration observes only when METRICS_ENABLED', async () => {
    // Disabled path: no observation recorded.
    process.env = { ...ORIGINAL_ENV };
    delete process.env['METRICS_ENABLED'];
    vi.resetModules();
    const m1 = await import('./metrics.js');
    const reg1 = m1.getRegistry();
    const before = await reg1.getSingleMetric('http_request_duration_seconds')?.get();
    m1.recordHttpDuration('GET', '/healthz', 200, 12);
    const after = await reg1.getSingleMetric('http_request_duration_seconds')?.get();
    // Disabled — values arrays are identical.
    expect(JSON.stringify(after?.values)).toBe(JSON.stringify(before?.values));

    // Enabled path: count goes up by one for the matching label set.
    process.env = { ...ORIGINAL_ENV, METRICS_ENABLED: '1' };
    vi.resetModules();
    const m2 = await import('./metrics.js');
    m2.recordHttpDuration('GET', '/healthz', 200, 25);
    const series = await m2
      .getRegistry()
      .getSingleMetric('http_request_duration_seconds')
      ?.get();
    const matches = series?.values.filter(
      (v) => v.labels.method === 'GET' && v.labels.route === '/healthz' && v.labels.status === '200',
    );
    expect((matches?.length ?? 0) > 0).toBe(true);
  });

  it('skips /metrics path observations to avoid scraping pollution', async () => {
    process.env = { ...ORIGINAL_ENV, METRICS_ENABLED: '1' };
    vi.resetModules();
    const m = await import('./metrics.js');
    const reg = m.getRegistry();
    const before = await reg.getSingleMetric('http_request_duration_seconds')?.get();
    m.recordHttpDuration('GET', '/metrics', 200, 99);
    const after = await reg.getSingleMetric('http_request_duration_seconds')?.get();
    // values for route=/metrics never appear — same snapshot before/after.
    expect(JSON.stringify(after?.values)).toBe(JSON.stringify(before?.values));
  });
});

describe('GET /metrics endpoint gate', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it(
    'returns 404 when METRICS_ENABLED is off',
    async () => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env['METRICS_ENABLED'];
      const { app } = await import('../index.js');
      const res = await app.request('/metrics');
      expect(res.status).toBe(404);
    },
    30_000,
  );

  it(
    'returns 401 when METRICS_ENABLED is on but Bearer token is wrong',
    async () => {
      process.env = {
        ...ORIGINAL_ENV,
        METRICS_ENABLED: '1',
        METRICS_TOKEN: 'real-secret',
      };
      const { app } = await import('../index.js');
      const res = await app.request('/metrics', {
        headers: { authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    },
    30_000,
  );

  it(
    'returns 200 with prom-text body when the Bearer token matches',
    async () => {
      process.env = {
        ...ORIGINAL_ENV,
        METRICS_ENABLED: '1',
        METRICS_TOKEN: 'real-secret',
      };
      const { app } = await import('../index.js');
      const res = await app.request('/metrics', {
        headers: { authorization: 'Bearer real-secret' },
      });
      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type') ?? '';
      expect(contentType.startsWith('text/plain')).toBe(true);
      const body = await res.text();
      // The body should at least contain our HTTP histogram name.
      expect(body).toContain('http_request_duration_seconds');
    },
    30_000,
  );
});

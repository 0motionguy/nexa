/**
 * Unit tests for the sliding-window rate limit middleware. Exercises the
 * in-memory backend end-to-end via a synthetic Hono app, and the Redis backend
 * via an ioredis mock.
 *
 * The vitest config (apps/api/vitest.config.ts) sets `RATE_LIMIT_ENABLED=0`
 * globally so the rest of the suite isn't 429'd by the new middleware. To
 * exercise the limiter here we set `RATE_LIMIT_ENABLED=1` and `vi.resetModules`
 * before importing rate-limit + env so the limiter sees the override.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORIGINAL_ENV = { ...process.env };

interface RateLimitModule {
  rateLimit: typeof import('./rate-limit.js').rateLimit;
  clientIp: typeof import('./rate-limit.js').clientIp;
  _resetForTests: typeof import('./rate-limit.js')._resetForTests;
  _memSizeForTests: typeof import('./rate-limit.js')._memSizeForTests;
}

async function loadEnabled(): Promise<RateLimitModule> {
  process.env = { ...ORIGINAL_ENV, RATE_LIMIT_ENABLED: '1' };
  delete process.env['REDIS_URL'];
  vi.resetModules();
  const mod = await import('./rate-limit.js');
  mod._resetForTests();
  return mod;
}

function buildApp(
  rl: RateLimitModule['rateLimit'],
  errorHandler: typeof import('./errors.js').errorHandler,
  opts: {
    windowSeconds: number;
    limit: number;
    keyFn?: (c: import('hono').Context) => string | null | Promise<string | null>;
    namespace?: string;
  },
): Hono {
  const app = new Hono();
  app.use(
    '/limited',
    rl({
      windowSeconds: opts.windowSeconds,
      limit: opts.limit,
      keyFn: opts.keyFn ?? ((): string => 'fixed'),
      ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
    }),
  );
  app.get('/limited', (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

describe('rateLimit — in-memory backend', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('allows up to `limit` requests, then 429s with Retry-After', async () => {
    const mod = await loadEnabled();
    const { errorHandler } = await import('./errors.js');
    const app = buildApp(mod.rateLimit, errorHandler, {
      windowSeconds: 60,
      limit: 3,
      namespace: 'mem1',
    });
    let ok = 0;
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/limited');
      if (res.status === 200) ok++;
    }
    expect(ok).toBe(3);

    const blocked = await app.request('/limited');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
    const body = await blocked.json();
    expect(body).toMatchObject({ ok: false, error: { code: 'too_many_requests' } });
  });

  it('resets after the window expires', async () => {
    const mod = await loadEnabled();
    const { errorHandler } = await import('./errors.js');
    const app = buildApp(mod.rateLimit, errorHandler, {
      windowSeconds: 1,
      limit: 1,
      namespace: 'mem2',
    });
    expect((await app.request('/limited')).status).toBe(200);
    expect((await app.request('/limited')).status).toBe(429);
    // 1.5s gives the 1s window comfortable headroom on a busy CI; without
    // it the test was occasionally flaky on Windows where setTimeout drift
    // is more pronounced.
    await new Promise<void>((r) => setTimeout(r, 1_500));
    expect((await app.request('/limited')).status).toBe(200);
  });

  it('uses the keyFn to bucket per-caller', async () => {
    const mod = await loadEnabled();
    const { errorHandler } = await import('./errors.js');
    let n = 0;
    const app = buildApp(mod.rateLimit, errorHandler, {
      windowSeconds: 60,
      limit: 1,
      namespace: 'mem3',
      keyFn: () => `caller-${n++}`,
    });
    // Each request gets a distinct key — never 429s.
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/limited');
      expect(res.status).toBe(200);
    }
  });

  it('keyFn returning null skips the check', async () => {
    const mod = await loadEnabled();
    const { errorHandler } = await import('./errors.js');
    const app = buildApp(mod.rateLimit, errorHandler, {
      windowSeconds: 60,
      limit: 1,
      namespace: 'mem4',
      keyFn: () => null,
    });
    expect((await app.request('/limited')).status).toBe(200);
    expect((await app.request('/limited')).status).toBe(200);
  });

  it('short-circuits when RATE_LIMIT_ENABLED is off', async () => {
    process.env = { ...ORIGINAL_ENV, RATE_LIMIT_ENABLED: '0' };
    vi.resetModules();
    const { rateLimit: rl } = await import('./rate-limit.js');
    const { errorHandler } = await import('./errors.js');
    const app = new Hono();
    app.use('/x', rl({ windowSeconds: 60, limit: 1, keyFn: () => 'k', namespace: 'mem5' }));
    app.get('/x', (c) => c.json({ ok: true }));
    app.onError(errorHandler);
    expect((await app.request('/x')).status).toBe(200);
    expect((await app.request('/x')).status).toBe(200);
  });

  it('caps the map size and lazily evicts under pressure', async () => {
    const mod = await loadEnabled();
    const { errorHandler } = await import('./errors.js');
    const app = buildApp(mod.rateLimit, errorHandler, {
      windowSeconds: 60,
      limit: 100,
      namespace: 'memcap',
      keyFn: (c) => c.req.header('x-key') ?? 'a',
    });
    for (let i = 0; i < 10_500; i++) {
      await app.request('/limited', { headers: { 'x-key': `k${i}` } });
    }
    expect(mod._memSizeForTests()).toBeLessThanOrEqual(10_000);
  });
});

describe('rateLimit — Redis backend (mocked)', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uses INCR + EXPIRE on the first hit and 429s on the (limit+1)th', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      RATE_LIMIT_ENABLED: '1',
      REDIS_URL: 'redis://localhost:6379/0',
    };
    vi.resetModules();

    // Mock ioredis BEFORE importing rate-limit so getRedis() picks it up.
    const incr = vi.fn();
    const expire = vi.fn();
    const ttl = vi.fn();
    let counter = 0;
    incr.mockImplementation(async () => {
      counter += 1;
      return counter;
    });
    expire.mockResolvedValue(1);
    ttl.mockResolvedValue(42);

    vi.doMock('ioredis', () => ({
      Redis: vi.fn().mockImplementation(() => ({
        incr,
        expire,
        ttl,
        on: vi.fn(),
      })),
    }));

    const { rateLimit: rl, _resetForTests: reset } = await import('./rate-limit.js');
    reset();
    const { errorHandler: handle } = await import('./errors.js');

    const app = new Hono();
    app.use('/r', rl({ windowSeconds: 60, limit: 2, keyFn: () => 'raw-secret-token', namespace: 'rd' }));
    app.get('/r', (c) => c.json({ ok: true }));
    app.onError(handle);

    expect((await app.request('/r')).status).toBe(200);
    expect((await app.request('/r')).status).toBe(200);
    const blocked = await app.request('/r');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('42');

    expect(incr).toHaveBeenCalledTimes(3);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(ttl).toHaveBeenCalledTimes(1);

    const redisKey = incr.mock.calls[0]?.[0] as string;
    expect(redisKey).toMatch(/^rl:rd:[a-f0-9]{32}$/);
    expect(redisKey).not.toContain('raw-secret-token');
    expect(expire).toHaveBeenCalledWith(redisKey, 60);

    vi.doUnmock('ioredis');
  });
});

describe('clientIp', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /**
   * clientIp reads env.TRUSTED_PROXY_HOPS from the env singleton, so each
   * test loads a fresh module with its own env override — importing the
   * cached module would leak the previous test's hops value.
   */
  async function loadClientIp(
    envOverrides: Record<string, string> = {},
  ): Promise<RateLimitModule['clientIp']> {
    process.env = { ...ORIGINAL_ENV, ...envOverrides };
    vi.resetModules();
    const { clientIp } = await import('./rate-limit.js');
    return clientIp;
  }

  it('takes the rightmost x-forwarded-for hop by default (TRUSTED_PROXY_HOPS=1) — the spoofable leftmost is ignored', async () => {
    const clientIp = await loadClientIp();
    const app = new Hono();
    app.get('/ip', (c) => c.text(clientIp(c)));
    const res = await app.request('/ip', {
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
    });
    expect(await res.text()).toBe('203.0.113.9');
  });

  it('TRUSTED_PROXY_HOPS=2 picks two from the right; shorter lists fall back to the leftmost entry', async () => {
    const clientIp = await loadClientIp({ TRUSTED_PROXY_HOPS: '2' });
    const app = new Hono();
    app.get('/ip', (c) => c.text(clientIp(c)));
    const res = await app.request('/ip', {
      headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.7, 10.0.0.1' },
    });
    expect(await res.text()).toBe('198.51.100.7');
    const short = await app.request('/ip', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(await short.text()).toBe('203.0.113.9');
  });

  it('TRUSTED_PROXY_HOPS=0 distrusts x-forwarded-for and x-real-ip entirely', async () => {
    const clientIp = await loadClientIp({ TRUSTED_PROXY_HOPS: '0' });
    const app = new Hono();
    app.get('/ip', (c) => c.text(clientIp(c)));
    const res = await app.request('/ip', {
      headers: { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '5.6.7.8' },
    });
    expect(await res.text()).toBe('unknown');
  });

  it('falls back to x-real-ip then "unknown"', async () => {
    const clientIp = await loadClientIp();
    const app = new Hono();
    app.get('/ip', (c) => c.text(clientIp(c)));
    const res1 = await app.request('/ip', { headers: { 'x-real-ip': '5.6.7.8' } });
    expect(await res1.text()).toBe('5.6.7.8');
    const res2 = await app.request('/ip');
    expect(await res2.text()).toBe('unknown');
  });
});

describe('rateLimit — fail modes (W2-B)', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /** ioredis mock whose INCR always rejects — a dead/unreachable Redis. */
  function mockErroringRedis(): void {
    vi.doMock('ioredis', () => ({
      Redis: vi.fn().mockImplementation(() => ({
        incr: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        expire: vi.fn(),
        ttl: vi.fn(),
        on: vi.fn(),
      })),
    }));
  }

  it('closed: 503s instead of degrading to in-memory when Redis errors', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      RATE_LIMIT_ENABLED: '1',
      REDIS_URL: 'redis://localhost:6379/0',
      RATE_LIMIT_FAIL_MODE: 'closed',
    };
    vi.resetModules();
    mockErroringRedis();

    const { rateLimit: rl, _resetForTests: reset } = await import('./rate-limit.js');
    reset();
    const { errorHandler: handle } = await import('./errors.js');
    const app = buildApp(rl, handle, { windowSeconds: 60, limit: 100, namespace: 'fmc' });

    expect((await app.request('/limited')).status).toBe(503);
    expect((await app.request('/limited')).status).toBe(503);

    vi.doUnmock('ioredis');
  });

  it('closed: 503s when Redis is expected but not configured', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      RATE_LIMIT_ENABLED: '1',
      RATE_LIMIT_FAIL_MODE: 'closed',
    };
    delete process.env['REDIS_URL'];
    vi.resetModules();

    const { rateLimit: rl, _resetForTests: reset } = await import('./rate-limit.js');
    reset();
    const { errorHandler: handle } = await import('./errors.js');
    const app = buildApp(rl, handle, { windowSeconds: 60, limit: 100, namespace: 'fmu' });

    expect((await app.request('/limited')).status).toBe(503);
  });

  it('open (dev/test default): falls back to in-memory and still enforces the budget when Redis errors', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      RATE_LIMIT_ENABLED: '1',
      REDIS_URL: 'redis://localhost:6379/0',
    };
    delete process.env['RATE_LIMIT_FAIL_MODE'];
    vi.resetModules();
    mockErroringRedis();

    const { rateLimit: rl, _resetForTests: reset } = await import('./rate-limit.js');
    reset();
    const { errorHandler: handle } = await import('./errors.js');
    const app = buildApp(rl, handle, { windowSeconds: 60, limit: 1, namespace: 'fmo' });

    expect((await app.request('/limited')).status).toBe(200);
    expect((await app.request('/limited')).status).toBe(429);

    vi.doUnmock('ioredis');
  });

  it('enforceRateLimit follows the same fail mode', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      RATE_LIMIT_ENABLED: '1',
      REDIS_URL: 'redis://localhost:6379/0',
      RATE_LIMIT_FAIL_MODE: 'closed',
    };
    vi.resetModules();
    mockErroringRedis();

    const closedMod = await import('./rate-limit.js');
    closedMod._resetForTests();
    await expect(
      closedMod.enforceRateLimit({ rawKey: 'k', namespace: 'fme', windowSeconds: 60, limit: 5 }),
    ).rejects.toThrow(/rate_limiter_unavailable/);

    process.env['RATE_LIMIT_FAIL_MODE'] = 'open';
    vi.resetModules();
    mockErroringRedis();
    const openMod = await import('./rate-limit.js');
    openMod._resetForTests();
    await expect(
      openMod.enforceRateLimit({ rawKey: 'k', namespace: 'fme', windowSeconds: 60, limit: 5 }),
    ).resolves.toEqual({ ok: true, retryAfter: 0 });

    vi.doUnmock('ioredis');
  });
});

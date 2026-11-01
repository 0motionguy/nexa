/**
 * F011 — coverage for the auth surface. Routes:
 *
 *   POST /auth/start          — OTP request (demo) or Privy hand-off
 *   POST /auth/verify         — OTP verification → session JWT
 *   POST /auth/privy-verify   — Privy access-token exchange → session JWT
 *   GET  /auth/me             — current session + balance + earn config
 *
 * Demo path only — Privy paths require live keys and are exercised in the
 * vendor-mode specs (kyc-live, bridge-live). Rate limiting is bypassed via
 * the vitest.config.ts default `RATE_LIMIT_ENABLED=0`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

async function loadApp() {
  // Each test imports a fresh app so the in-memory store starts empty + any
  // env override takes effect.
  const mod = await import('../index.js');
  return mod.app;
}

async function postJson(app: Awaited<ReturnType<typeof loadApp>>, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('routes/auth — /auth/start (demo mode)', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env['PRIVY_APP_ID'];
    delete process.env['PRIVY_APP_SECRET'];
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it(
    'returns mode=demo + challengeId for an unknown email',
    async () => {
      const app = await loadApp();
      const { status, body } = await postJson(app, '/auth/start', { email: 'alice@test.co' });
      expect(status).toBe(200);
      expect(body['ok']).toBe(true);
      expect(body['mode']).toBe('demo');
      expect(typeof body['challengeId']).toBe('string');
    },
    30_000,
  );

  it('rejects malformed email at Zod boundary (400)', async () => {
    const app = await loadApp();
    const { status } = await postJson(app, '/auth/start', { email: 'not-an-email' });
    // zod-validator returns its own 400 envelope before reaching onError;
    // only the status code is part of the contract here.
    expect(status).toBe(400);
  });

  it('rejects empty body with a 400', async () => {
    const app = await loadApp();
    const { status } = await postJson(app, '/auth/start', {});
    expect(status).toBe(400);
  });
});

describe('routes/auth — /auth/verify (demo OTP)', () => {
  it('issues a token when challengeId + correct code matches', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'bob@test.co' });
    const challengeId = start.body['challengeId'] as string;

    const verify = await postJson(app, '/auth/verify', { challengeId, code: '482019' });
    expect(verify.status).toBe(200);
    expect(verify.body['ok']).toBe(true);
    expect(typeof verify.body['token']).toBe('string');
    const user = verify.body['user'] as { id: string; email: string };
    expect(user.email).toBe('bob@test.co');
  });

  it('auto-claims pending email escrow when the recipient signs up', async () => {
    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const sender = await store.upsertUserByEmail('claim-sender@test.co', 'Sender');
    const baseline = await store.upsertUserByEmail('claim-baseline@test.co');
    const sent = await store.send(sender, 20, 'claim-recipient@test.co');
    expect(sent.claim).toBe(true);
    const claim = await store.recordClaim(sender, 'claim-recipient@test.co', 20);

    const start = await postJson(app, '/auth/start', { email: 'claim-recipient@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });

    expect(verify.status).toBe(200);
    const user = verify.body['user'] as { id: string; email: string };
    expect(user.email).toBe('claim-recipient@test.co');
    const recipient = await store.user(user.id);
    expect(recipient.balUsd).toBeCloseTo(baseline.balUsd + 20);
    expect((await store.getClaim(claim.slug))?.status).toBe('claimed');
  });

  it('rejects a wrong code with bad_code', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'carol@test.co' });
    const challengeId = start.body['challengeId'] as string;

    const verify = await postJson(app, '/auth/verify', { challengeId, code: '000000' });
    expect(verify.status).toBe(400);
    // Sprint 17 F062 — ApiError envelope wraps the code in error.message.
    expect((verify.body['error'] as { message: string }).message).toBe('bad_code');
  });

  it('rejects an unknown challengeId with challenge_expired', async () => {
    const app = await loadApp();
    const verify = await postJson(app, '/auth/verify', {
      challengeId: '00000000-0000-4000-8000-000000000000',
      code: '482019',
    });
    expect(verify.status).toBe(400);
    expect((verify.body['error'] as { message: string }).message).toBe('challenge_expired');
  });

  it('rejects a reused challengeId (single-use)', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'dave@test.co' });
    const challengeId = start.body['challengeId'] as string;
    await postJson(app, '/auth/verify', { challengeId, code: '482019' });
    const second = await postJson(app, '/auth/verify', { challengeId, code: '482019' });
    expect(second.status).toBe(400);
    expect((second.body['error'] as { message: string }).message).toBe('challenge_expired');
  });
});

describe('routes/auth — /auth/privy-verify', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      PRIVY_APP_ID: 'privy_app_test',
      PRIVY_APP_SECRET: 'privy_secret_test',
    };
    vi.resetModules();
    vi.doMock('../lib/privy.js', () => ({
      isPrivyEnabled: () => true,
      verifyPrivyToken: vi.fn(async () => ({
        did: 'did:privy:user_live_123',
        email: 'privy-user@test.co',
      })),
      getOrCreatePrivyWallet: vi.fn(),
      getOrCreatePrivySolanaWallet: vi.fn(),
      signTypedDataWithPrivy: vi.fn(),
      signRawWithPrivy: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.doUnmock('../lib/privy.js');
    vi.doUnmock('../lib/markets/hl-builder-approval.js');
    vi.resetModules();
    process.env = ORIGINAL_ENV;
  });

  it('persists the Privy did onto the session user', async () => {
    const app = await loadApp();
    const verify = await postJson(app, '/auth/privy-verify', {
      accessToken: 'valid-privy-token',
    });
    expect(verify.status).toBe(200);
    expect(verify.body['ok']).toBe(true);

    const user = verify.body['user'] as { id: string; email: string };
    expect(user.email).toBe('privy-user@test.co');

    const { store } = await import('../store/index.js');
    const stored = await store.user(user.id);
    expect(stored.privyDid).toBe('did:privy:user_live_123');
  });

  it('runs the backend builder agreement on sign-in when an EVM wallet is already cached', async () => {
    const ensureHlBuilderApproval = vi.fn(async () => ({
      ok: true,
      approved: true,
      requiredTenthsBp: 25,
      maxFeeRate: '0.25%',
    }));
    vi.doMock('../lib/markets/hl-builder-approval.js', () => ({
      ensureHlBuilderApproval,
    }));

    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const user = await store.upsertUserByEmail('privy-user@test.co', undefined, {
      privyDid: 'did:privy:user_live_123',
    });
    await store.setPrivyWallet(user.id, 'wallet_cached', '0x1111111111111111111111111111111111111111');

    const verify = await postJson(app, '/auth/privy-verify', {
      accessToken: 'valid-privy-token',
    });

    expect(verify.status).toBe(200);
    expect(ensureHlBuilderApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        walletId: 'wallet_cached',
        walletAddress: '0x1111111111111111111111111111111111111111',
      }),
    );
  });
});

describe('lib/privy - verifyPrivyToken', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      PRIVY_APP_ID: 'privy_app_test',
      PRIVY_APP_SECRET: 'privy_secret_test',
      PRIVY_VERIFICATION_KEY: 'test-verification-key',
    };
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@privy-io/server-auth');
    vi.resetModules();
    process.env = ORIGINAL_ENV;
  });

  it('accepts the SDK user.email.address shape when linkedAccounts is omitted', async () => {
    const verifyAuthToken = vi.fn(async () => ({
      userId: 'did:privy:user_top_email',
    }));
    const getUserById = vi.fn(async () => ({
      id: 'did:privy:user_top_email',
      email: { address: 'top-email@test.co' },
    }));

    vi.doMock('@privy-io/server-auth', () => ({
      PrivyClient: vi.fn().mockImplementation(() => ({
        verifyAuthToken,
        getUserById,
        walletApi: {},
      })),
    }));

    const { verifyPrivyToken } = await import('../lib/privy.js');
    const verified = await verifyPrivyToken('valid-privy-token');

    expect(verified).toEqual({
      did: 'did:privy:user_top_email',
      email: 'top-email@test.co',
    });
    expect(verifyAuthToken).toHaveBeenCalledWith('valid-privy-token', 'test-verification-key');
    expect(getUserById).toHaveBeenCalledWith('did:privy:user_top_email');
  });

  it('normalizes one-line PEM verification keys from Docker env files', async () => {
    process.env['PRIVY_VERIFICATION_KEY'] =
      '-----BEGIN PUBLIC KEY-----abc123-----END PUBLIC KEY-----';
    const verifyAuthToken = vi.fn(async () => ({
      userId: 'did:privy:user_top_email',
    }));
    const getUserById = vi.fn(async () => ({
      id: 'did:privy:user_top_email',
      email: { address: 'top-email@test.co' },
    }));

    vi.doMock('@privy-io/server-auth', () => ({
      PrivyClient: vi.fn().mockImplementation(() => ({
        verifyAuthToken,
        getUserById,
        walletApi: {},
      })),
    }));

    const { verifyPrivyToken } = await import('../lib/privy.js');
    await verifyPrivyToken('valid-privy-token');

    expect(verifyAuthToken).toHaveBeenCalledWith(
      'valid-privy-token',
      '-----BEGIN PUBLIC KEY-----\nabc123\n-----END PUBLIC KEY-----',
    );
  });
});

describe('routes/auth — /auth/me', () => {
  it('rejects requests without a Bearer token', async () => {
    const app = await loadApp();
    const res = await app.request('/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user + balance + earnConfig for a valid token', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'eve@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;

    const res = await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    const balance = body['balance'] as Record<string, unknown>;
    expect(typeof balance['balUsd']).toBe('number');
    expect(typeof balance['earnUsd']).toBe('number');
    const earnConfig = body['earnConfig'] as Record<string, unknown>;
    expect(typeof earnConfig['earnByDefault']).toBe('boolean');
    expect(typeof earnConfig['autoDivestOnSpend']).toBe('boolean');
  });

  it('auto-claims pending email escrow when a signed-in recipient resumes', async () => {
    const app = await loadApp();
    const { store } = await import('../store/index.js');

    const start = await postJson(app, '/auth/start', { email: 'resume-claim@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;
    const recipient = verify.body['user'] as { id: string; email: string };
    const before = await store.user(recipient.id);
    const beforeBalUsd = before.balUsd;

    const sender = await store.upsertUserByEmail('resume-claim-sender@test.co', 'Sender');
    const sent = await store.send(sender, 25, recipient.email);
    expect(sent.claim).toBe(true);
    const claim = await store.recordClaim(sender, recipient.email, 25);

    const res = await app.request('/auth/me?claim=1', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const balance = body['balance'] as Record<string, unknown>;
    expect(balance['balUsd']).toBeCloseTo(beforeBalUsd + 25);
    expect((await store.getClaim(claim.slug))?.status).toBe('claimed');
  });

  it('does not scan and claim pending email escrow on normal session refresh', async () => {
    const app = await loadApp();
    const { store } = await import('../store/index.js');

    const start = await postJson(app, '/auth/start', { email: 'refresh-no-claim@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;
    const recipient = verify.body['user'] as { id: string; email: string };
    const beforeBalUsd = (await store.user(recipient.id)).balUsd;

    const sender = await store.upsertUserByEmail('refresh-no-claim-sender@test.co', 'Sender');
    const sent = await store.send(sender, 25, recipient.email);
    expect(sent.claim).toBe(true);
    const claim = await store.recordClaim(sender, recipient.email, 25);

    const res = await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const balance = body['balance'] as Record<string, unknown>;
    expect(balance['balUsd']).toBeCloseTo(beforeBalUsd);
    expect((await store.getClaim(claim.slug))?.status).toBe('pending');
  });

  it('rejects a token with a malformed signature', async () => {
    const app = await loadApp();
    const res = await app.request('/auth/me', {
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.status).toBe(401);
  });
});

describe('routes/auth — /auth/refresh', () => {
  it('rejects requests without a Bearer token', async () => {
    const app = await loadApp();
    const res = await app.request('/auth/refresh', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns a fresh token and expiry for a valid bearer', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'refresh-token@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;

    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(typeof body['token']).toBe('string');
    expect(typeof body['expiresAt']).toBe('number');
    const user = body['user'] as { email: string };
    expect(user.email).toBe('refresh-token@test.co');
  });

  it('refreshes via the httpOnly cookie alone — the PWA cold-boot resume path', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'refresh-cookie@test.co' });
    const verifyRes = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: start.body['challengeId'], code: '482019' }),
    });
    const setCookie = verifyRes.headers.get('set-cookie') ?? '';
    const cookieValue = /nexa_session=([^;]+)/.exec(setCookie)?.[1];
    expect(cookieValue).toBeTruthy();

    // No Authorization header — only the cookie, exactly like a fresh PWA
    // launch where sessionStorage died with the old tab.
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { cookie: `nexa_session=${cookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string; expiresAt: number };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe('string');
    // The refreshed response re-issues the cookie (sliding window).
    expect(res.headers.get('set-cookie')).toMatch(/nexa_session=/);
  });

  it('mints 30-day sessions (C1 go-live TTL)', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'refresh-ttl@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const expiresAt = verify.body['expiresAt'] as number;
    const days = (expiresAt - Date.now() / 1000) / 86_400;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

/**
 * F096 Sprint 18 — httpOnly session cookie. /auth/verify + /privy-verify
 * drop a `nexa_session` cookie alongside the Bearer JWT so browser clients
 * can stop mirroring the token into XSS-readable storage. requireSession
 * accepts the cookie OR the Bearer header. /auth/signout clears the cookie.
 */
describe('routes/auth — F096 httpOnly session cookie', () => {
  function parseSetCookie(header: string | null): {
    name: string;
    value: string;
    attrs: Record<string, string | true>;
  } | null {
    if (!header) return null;
    const parts = header.split(';').map((p) => p.trim());
    const first = parts[0] ?? '';
    const eq = first.indexOf('=');
    if (eq < 0) return null;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    const attrs: Record<string, string | true> = {};
    for (const p of parts.slice(1)) {
      const e = p.indexOf('=');
      if (e < 0) attrs[p.toLowerCase()] = true;
      else attrs[p.slice(0, e).toLowerCase()] = p.slice(e + 1);
    }
    return { name, value, attrs };
  }

  it('/auth/verify sets nexa_session cookie with HttpOnly + SameSite=Lax + Path=/', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'cookie-verify@test.co' });
    const challengeId = start.body['challengeId'] as string;

    const res = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, code: '482019' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    const parsed = parseSetCookie(setCookie);
    expect(parsed?.name).toBe('nexa_session');
    expect(parsed?.value.length).toBeGreaterThan(10);
    expect(parsed?.attrs['httponly']).toBe(true);
    expect(parsed?.attrs['samesite']).toMatch(/lax/i);
    expect(parsed?.attrs['path']).toBe('/');
    // Body still includes the Bearer for native callers — both shapes coexist.
    const body = (await res.json()) as { token?: string };
    expect(typeof body.token).toBe('string');
  });

  it('protected route authenticates via cookie alone (no Authorization header)', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'cookie-only@test.co' });
    const res = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: start.body['challengeId'], code: '482019' }),
    });
    const setCookie = res.headers.get('set-cookie');
    const parsed = parseSetCookie(setCookie);
    expect(parsed?.name).toBe('nexa_session');

    // Replay the cookie back without any Authorization header. /auth/me is
    // gated by requireSession — succeeds = cookie path works.
    const meRes = await app.request('/auth/me', {
      headers: { cookie: `nexa_session=${parsed!.value}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { ok: boolean; user: { email: string } };
    expect(meBody.ok).toBe(true);
    expect(meBody.user.email).toBe('cookie-only@test.co');
  });

  it('Bearer header still works (native callers unaffected)', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'bearer-still-works@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;

    const meRes = await app.request('/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
  });

  it('/auth/signout clears the cookie via expired Set-Cookie', async () => {
    const app = await loadApp();
    const res = await app.request('/auth/signout', { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/nexa_session=/);
    // Hono's deleteCookie writes Max-Age=0; either explicit zero or an
    // expires=epoch tells the browser to drop it.
    expect(setCookie).toMatch(/max-age=0|expires=thu, 01 jan 1970/i);
  });
});

/**
 * NEO Session 1 — session revocation. issueToken now embeds a `jti` and persists
 * a session row; signout / refresh-rotation / /auth/revoke flip it to revoked so
 * the presented bearer stops authenticating. Pre-upgrade tokens (no jti) keep
 * working forever.
 */
describe('routes/auth — session revocation (NEO Session 1)', () => {
  it('signout revokes the presented bearer — a subsequent request 401s', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'revoke-signout@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const auth = { authorization: `Bearer ${verify.body['token'] as string}` };

    // Live before signout.
    expect((await app.request('/auth/me', { headers: auth })).status).toBe(200);

    const out = await app.request('/auth/signout', { method: 'POST', headers: auth });
    expect(out.status).toBe(200);

    // Dead after signout.
    expect((await app.request('/auth/me', { headers: auth })).status).toBe(401);
  });

  it('POST /auth/revoke { all: true } kills a second session too', async () => {
    const app = await loadApp();
    const email = 'revoke-all@test.co';
    const s1 = await postJson(app, '/auth/start', { email });
    const v1 = await postJson(app, '/auth/verify', {
      challengeId: s1.body['challengeId'] as string,
      code: '482019',
    });
    const tokenA = v1.body['token'] as string;
    const s2 = await postJson(app, '/auth/start', { email });
    const v2 = await postJson(app, '/auth/verify', {
      challengeId: s2.body['challengeId'] as string,
      code: '482019',
    });
    const tokenB = v2.body['token'] as string;

    // Both sessions (same user) live.
    expect((await app.request('/auth/me', { headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(200);
    expect((await app.request('/auth/me', { headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(200);

    const revoke = await app.request('/auth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ all: true }),
    });
    expect(revoke.status).toBe(200);

    // The OTHER session for the same user is dead too.
    expect((await app.request('/auth/me', { headers: { authorization: `Bearer ${tokenB}` } })).status).toBe(401);
    expect((await app.request('/auth/me', { headers: { authorization: `Bearer ${tokenA}` } })).status).toBe(401);
  });

  it('/auth/refresh rotates: the old token 401s and the new one works', async () => {
    const app = await loadApp();
    const start = await postJson(app, '/auth/start', { email: 'refresh-rotate@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const oldToken = verify.body['token'] as string;

    const refreshed = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(refreshed.status).toBe(200);
    const newToken = ((await refreshed.json()) as { token: string }).token;
    expect(newToken).not.toBe(oldToken);

    // The rotated-out token is revoked; the fresh token authenticates.
    expect((await app.request('/auth/me', { headers: { authorization: `Bearer ${oldToken}` } })).status).toBe(401);
    expect((await app.request('/auth/me', { headers: { authorization: `Bearer ${newToken}` } })).status).toBe(200);
  });

  it('pre-upgrade tokens minted without a jti still authenticate (back-compat)', async () => {
    // Craft a session JWT with NO jti using the same secret + HS256 as
    // issueToken. A missing session row = NOT revoked, so it must still work.
    // Pinned to a pre-cutover instant: after SESSION_JTI_REQUIRED_AFTER_MS
    // (2026-08-11) no-jti tokens are rejected by default, so this back-compat
    // assertion must run on the clock it describes or it self-breaks on that date.
    const { sign } = await import('hono/jwt');
    const { store } = await import('../store/index.js');
    const { env } = await import('../lib/env.js');
    const app = await loadApp();
    const user = await store.upsertUserByEmail('pre-upgrade@test.co');
    const secret = (env.JWT_SECRETS && env.JWT_SECRETS.split(',')[0]?.trim()) || env.JWT_SECRET;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
    try {
      const legacy = await sign(
        { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, kid: 'k1' },
        secret,
      );
      const res = await app.request('/auth/me', { headers: { authorization: `Bearer ${legacy}` } });
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Red-team P1-8 — session hardening. Four regressions guarded here:
 *   1. issueToken fails CLOSED when the session row can't persist (503, no cookie)
 *   2. mutating requests read revocation authoritatively (a revoke on another pod
 *      is enforced on the very next money POST, not up to 30s later)
 *   3. no-jti tokens are rejected after the 2026-08-11 cutover or SESSION_REQUIRE_JTI=1
 *   4. a store-read error fails closed on mutations (503) but open on reads (200),
 *      and never caches the error-derived answer
 *
 * The describe manages its own module + env lifecycle (resetModules in beforeEach)
 * so env overrides + store spies bind to the freshly-loaded app graph.
 */
describe('routes/auth — session hardening (red-team P1-8)', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env['SESSION_REQUIRE_JTI'];
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  // ── Case 1: fail-closed session issuance ──
  it('issuance fails closed: /auth/verify 503s and sets NO cookie when the session row cannot persist', async () => {
    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const start = await postJson(app, '/auth/start', { email: 'issue-fail@test.co' });
    const challengeId = start.body['challengeId'] as string;
    // Reject BOTH the initial write and the single retry so issuance gives up.
    const spy = vi.spyOn(store, 'createSession').mockRejectedValue(new Error('db down'));

    const res = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, code: '482019' }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('service_unavailable');
    // No unrevokable token may leak to the browser when the row didn't persist.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // initial + one retry
  });

  it('issuance fails closed on /auth/refresh: 503 AND the old bearer stays valid', async () => {
    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const start = await postJson(app, '/auth/start', { email: 'refresh-fail@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;

    const spy = vi.spyOn(store, 'createSession').mockRejectedValue(new Error('db down'));
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('service_unavailable');
    spy.mockRestore();

    // Refresh threw BEFORE it revoked the old jti, so the presented bearer is intact —
    // no mid-trade lockout on a transient store blip.
    const me = await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  // ── Case 2: authoritative revocation read on mutating requests ──
  it('a revoke on another pod is enforced on the next mutating request, while reads stay cached', async () => {
    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const { _resetRevocationCacheForTests } = await import('../lib/auth.js');
    _resetRevocationCacheForTests();

    const start = await postJson(app, '/auth/start', { email: 'xpod@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;
    // Decode jti + sub straight off the JWT so we can revoke "on pod B".
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] as string, 'base64url').toString(),
    ) as { sub: string; jti: string };

    // Prime this pod's negative cache with a GET — it now believes the token is live.
    expect(
      (await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);

    // Pod B revokes directly in the store — no cache priming on THIS pod.
    await store.revokeSession(claims.sub, claims.jti);

    // Read path: still 200 — documented ≤30s cache staleness, money-irrelevant.
    expect(
      (await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);

    // Mutating path: authoritative store read bypasses the cache → 401 on THIS request.
    const mutate = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mutate.status).toBe(401);
  });

  // ── Case 4: store-read error fails closed on mutations, open on reads, no error caching ──
  it('a store-read error 503s mutations, 200s reads, and never caches the error answer', async () => {
    const app = await loadApp();
    const { store } = await import('../store/index.js');
    const { _resetRevocationCacheForTests } = await import('../lib/auth.js');

    const start = await postJson(app, '/auth/start', { email: 'readfail@test.co' });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
    });
    const token = verify.body['token'] as string;

    _resetRevocationCacheForTests();
    const spy = vi.spyOn(store, 'isSessionRevoked').mockRejectedValue(new Error('db down'));

    // Mutating request: a store error is NOT proof of revocation → fail closed with 503.
    const mutate = await app.request('/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mutate.status).toBe(503);
    expect(((await mutate.json()) as { error: { code: string } }).error.code).toBe('service_unavailable');

    // Read request: fail OPEN for this request only → 200 (hot polled GETs keep working).
    const read = await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200);

    // Both requests re-hit the store — the error answer was never cached.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);

    spy.mockRestore();
    // After recovery the session is intact — nothing was poisoned by the error answer.
    const recovered = await app.request('/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(recovered.status).toBe(200);
  });

  // ── Case 3: no-jti cutover ──
  async function craftLegacyNoJtiToken(email: string): Promise<string> {
    const { sign } = await import('hono/jwt');
    const { store } = await import('../store/index.js');
    const { env } = await import('../lib/env.js');
    const user = await store.upsertUserByEmail(email);
    const secret = (env.JWT_SECRETS && env.JWT_SECRETS.split(',')[0]?.trim()) || env.JWT_SECRET;
    return sign(
      { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, kid: 'k1' },
      secret,
    );
  }

  it('SESSION_REQUIRE_JTI=1 rejects a no-jti token immediately (emergency cutover)', async () => {
    process.env['SESSION_REQUIRE_JTI'] = '1';
    vi.resetModules();
    const app = await loadApp();
    const legacy = await craftLegacyNoJtiToken('cutover-force@test.co');
    const res = await app.request('/auth/me', { headers: { authorization: `Bearer ${legacy}` } });
    expect(res.status).toBe(401);
  });

  it('rejects a no-jti token after the 2026-08-11 date cutover (default env)', async () => {
    const app = await loadApp();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z'));
    try {
      const legacy = await craftLegacyNoJtiToken('cutover-date@test.co');
      const res = await app.request('/auth/me', { headers: { authorization: `Bearer ${legacy}` } });
      expect(res.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still accepts a no-jti token before the cutover (default env, pre-cutoff clock)', async () => {
    const app = await loadApp();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
    try {
      const legacy = await craftLegacyNoJtiToken('cutover-preok@test.co');
      const res = await app.request('/auth/me', { headers: { authorization: `Bearer ${legacy}` } });
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SESSION_REQUIRE_JTI=0 holds the no-jti gate open past the cutover (escape hatch)', async () => {
    process.env['SESSION_REQUIRE_JTI'] = '0';
    vi.resetModules();
    const app = await loadApp();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z')); // past the date cutover
    try {
      const legacy = await craftLegacyNoJtiToken('cutover-holdopen@test.co');
      const res = await app.request('/auth/me', { headers: { authorization: `Bearer ${legacy}` } });
      expect(res.status).toBe(200); // env '0' overrides the date → still allowed
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * P1-4 (W3) — sign-in replace-with-revoke, keyed by installationId. A re-auth
 * from the same install must kill the previous session (no orphaned live
 * bearers riding the 30-day TTL); different installs (multi-device) and
 * clients that don't send installationId (old builds, web — H4) keep today's
 * stack-another-session behavior. /auth/refresh is the revocation probe:
 * it's a mutating POST, so requireSession does the authoritative revocation
 * read (W1) — a revoked bearer must bounce with 401 deterministically.
 */
describe('routes/auth — P1-4 replace-with-revoke by installation', () => {
  async function signIn(
    app: Awaited<ReturnType<typeof loadApp>>,
    email: string,
    installationId?: string,
  ) {
    const start = await postJson(app, '/auth/start', { email });
    const verify = await postJson(app, '/auth/verify', {
      challengeId: start.body['challengeId'] as string,
      code: '482019',
      ...(installationId ? { installationId } : {}),
    });
    expect(verify.status).toBe(200);
    return verify.body['token'] as string;
  }

  function refresh(app: Awaited<ReturnType<typeof loadApp>>, token: string) {
    return app.request('/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('second sign-in from the SAME installation revokes the first session', async () => {
    const app = await loadApp();
    const t1 = await signIn(app, 'replace-same@test.co', 'install-A');
    const t2 = await signIn(app, 'replace-same@test.co', 'install-A');

    const dead = await refresh(app, t1);
    expect(dead.status).toBe(401);
    const live = await refresh(app, t2);
    expect(live.status).toBe(200);
  });

  it('different installations coexist — multi-device stays live', async () => {
    const app = await loadApp();
    const phone = await signIn(app, 'replace-multi@test.co', 'install-phone');
    const tablet = await signIn(app, 'replace-multi@test.co', 'install-tablet');

    expect((await refresh(app, phone)).status).toBe(200);
    expect((await refresh(app, tablet)).status).toBe(200);
  });

  it('no installationId ⇒ back-compat: prior session stays live', async () => {
    const app = await loadApp();
    const t1 = await signIn(app, 'replace-legacy@test.co');
    const t2 = await signIn(app, 'replace-legacy@test.co');

    expect((await refresh(app, t1)).status).toBe(200);
    expect((await refresh(app, t2)).status).toBe(200);
  });
});

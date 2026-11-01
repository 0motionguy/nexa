import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;
const TEST_VAPID_PUBLIC_KEY = 'BNAwtze3fUvVWyAOr36l0d0tam5D7L-x4PeZINaprsDrFf77GR2vL412nMKX8Iw-_482_H3AdWUopeVFI9DPJdM';
const TEST_VAPID_PRIVATE_KEY = '146ReI9fqAnZCl-0a_pjEgA-wNdGmyOlhwOjQVvqu00';

async function loadApp(): Promise<typeof import('../index.js').app> {
  const mod = await import('../index.js');
  return mod.app;
}

async function postJson(
  app: Awaited<ReturnType<typeof loadApp>>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function freshSessionToken(app: Awaited<ReturnType<typeof loadApp>>): Promise<string> {
  const email = `push-test-${randomBytes(4).toString('hex')}@example.com`;
  const start = await postJson(app, '/auth/start', { email });
  const verify = await postJson(app, '/auth/verify', {
    challengeId: start.body['challengeId'] as string,
    code: '482019',
  });
  return verify.body['token'] as string;
}

function pushSubscription(endpoint = `https://push.example/sub/${randomBytes(4).toString('hex')}`) {
  return {
    endpoint,
    keys: {
      p256dh: 'BNYqySgH4cB4kX7j5X-kA2c5xH2mH7nSg2b5vFcJ9P6J0s7gS3s8RjA7vA9xD4fQ7eXh9R2pK4b3fA6dP8xC1m',
      auth: 'auth-secret-for-tests',
    },
  };
}

function expoToken(index: number): string {
  return `ExponentPushToken[${String(index).padStart(2, '0')}${'a'.repeat(20)}]`;
}

describe('routes/push', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: 'mailto:ops@maze.to',
    };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('requires a session for the VAPID public key', async () => {
    const app = await loadApp();
    const res = await app.request('/push/vapid-public-key');
    expect(res.status).toBe(401);
  });

  it('returns the configured VAPID public key for a signed-in user', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/push/vapid-public-key', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(true);
    expect(body['publicKey']).toBe(TEST_VAPID_PUBLIC_KEY);
  });

  it('fails closed when VAPID keys are not configured', async () => {
    delete process.env['VAPID_PUBLIC_KEY'];
    delete process.env['VAPID_PRIVATE_KEY'];
    vi.resetModules();
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await app.request('/push/vapid-public-key', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body['ok']).toBe(false);
    expect(body['error']?.message).toBe('push_unavailable');
  });

  it('stores, updates, lists, and deletes a subscription scoped to the user', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };
    const first = pushSubscription();

    const created = await postJson(app, '/push/subscribe', first, auth);
    expect(created.status).toBe(200);
    expect(created.body['ok']).toBe(true);
    expect(created.body['subscribed']).toBe(true);
    expect(typeof created.body['id']).toBe('string');

    const updated = await postJson(
      app,
      '/push/subscribe',
      { ...first, keys: { ...first.keys, auth: 'rotated-auth-secret' } },
      auth,
    );
    expect(updated.status).toBe(200);
    expect(updated.body['id']).toBe(created.body['id']);

    const list = await app.request('/push/subscriptions', { headers: auth });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as Record<string, any>;
    expect(listBody['ok']).toBe(true);
    expect(listBody['subscriptions']).toEqual([
      expect.objectContaining({
        id: created.body['id'],
        endpoint: first.endpoint,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(listBody)).not.toContain('rotated-auth-secret');

    const deleted = await app.request('/push/subscribe', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ endpoint: first.endpoint }),
    });
    expect(deleted.status).toBe(200);
    const deleteBody = (await deleted.json()) as Record<string, any>;
    expect(deleteBody['ok']).toBe(true);
    expect(deleteBody['deleted']).toBe(true);

    const after = await app.request('/push/subscriptions', { headers: auth });
    const afterBody = (await after.json()) as Record<string, any>;
    expect(afterBody['subscriptions']).toEqual([]);
  });

  it('rejects invalid subscription payloads', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await postJson(
      app,
      '/push/subscribe',
      { endpoint: 'javascript:alert(1)', keys: { p256dh: '', auth: '' } },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(400);
  });

  it('stores Expo tokens per user and evicts oldest entries over the cap', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    for (let i = 0; i < 12; i++) {
      const res = await postJson(
        app,
        '/push/expo-subscribe',
        { token: expoToken(i), platform: 'ios' },
        auth,
      );
      expect(res.status).toBe(200);
    }

    const list = await app.request('/push/expo-subscriptions', { headers: auth });
    expect(list.status).toBe(200);
    const body = (await list.json()) as Record<string, any>;
    const tokens = (body['subscriptions'] as Array<{ token: string }>).map((s) => s.token);
    expect(tokens).toHaveLength(10);
    expect(tokens).not.toContain(expoToken(0));
    expect(tokens).not.toContain(expoToken(1));
    expect(tokens).toContain(expoToken(11));
  });

  it('rejects non-Expo push tokens', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const res = await postJson(
      app,
      '/push/expo-subscribe',
      { token: 'not-an-expo-token-but-long-enough', platform: 'ios' },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(400);
  });

  it('legacy /push/expo-subscribe devices surface on /me/devices with a legacy- installation id', async () => {
    const app = await loadApp();
    const token = await freshSessionToken(app);
    const auth = { authorization: `Bearer ${token}` };

    const reg = await postJson(app, '/push/expo-subscribe', { token: expoToken(3), platform: 'ios' }, auth);
    expect(reg.status).toBe(200);

    const list = await app.request('/me/devices', { headers: auth });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      devices: Array<{ installationId: string; platform: string; enabled: boolean }>;
    };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.installationId).toMatch(/^legacy-/);
    expect(body.devices[0]?.platform).toBe('ios');
    expect(body.devices[0]?.enabled).toBe(true);
  });
});

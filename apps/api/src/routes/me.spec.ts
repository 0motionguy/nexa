import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { env } from '../lib/env.js';
import { store } from '../store/index.js';

const originalAdminToken = env.ADMIN_TOKEN;

afterEach(() => {
  env.ADMIN_TOKEN = originalAdminToken;
});

describe('/me admin fees', () => {
  it('requires a live API key plus admin token', async () => {
    env.ADMIN_TOKEN = 'admin-test-token';
    const user = await store.upsertUserByEmail('fees-admin@example.com', 'Fees Admin');
    const live = await store.createApiKey(user, 'live', true);
    const test = await store.createApiKey(user, 'test', false);

    const noAdmin = await app.request('/me/admin/fees/summary', {
      headers: { authorization: `Bearer ${live.secret}` },
    });
    expect(noAdmin.status).toBe(403);
    expect((await noAdmin.json()).error.message).toBe('admin_token_required');

    const sandbox = await app.request('/me/admin/fees/summary', {
      headers: { authorization: `Bearer ${test.secret}`, 'x-admin-token': 'admin-test-token' },
    });
    expect(sandbox.status).toBe(403);
    expect((await sandbox.json()).error.message).toBe('live_api_key_required');

    const ok = await app.request('/me/admin/fees/summary', {
      headers: { authorization: `Bearer ${live.secret}`, 'x-admin-token': 'admin-test-token' },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
  });
});

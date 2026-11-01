/**
 * NEO Session 1 — /me device registration + notification preferences.
 *
 *   PUT    /me/devices/:installationId/push   — upsert a device (installation-keyed)
 *   DELETE /me/devices/:installationId/push   — deregister (idempotent)
 *   GET    /me/devices                        — list devices
 *   PATCH  /me/notification-preferences       — merge-patch prefs user-wide
 *
 * Demo (in-memory) store; unique emails isolate each test's user.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { store } from '../store/index.js';

async function reqJson(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function freshSession(): Promise<{ auth: Record<string, string>; userId: string }> {
  const email = `dev-${randomBytes(5).toString('hex')}@example.com`;
  const start = await reqJson('/auth/start', 'POST', { email });
  const verify = await reqJson('/auth/verify', 'POST', {
    challengeId: start.body['challengeId'],
    code: '482019',
  });
  const auth = { authorization: `Bearer ${verify.body['token']}` };
  const me = await reqJson('/auth/me', 'GET', undefined, auth);
  return { auth, userId: (me.body['user'] as { id: string }).id };
}

const expoToken = (): string => `ExponentPushToken[${randomBytes(10).toString('hex')}]`;

describe('routes/me — devices + notification preferences (NEO Session 1)', () => {
  it('rejects unauthenticated device access with 401', async () => {
    const res = await app.request('/me/devices');
    expect(res.status).toBe(401);
  });

  it('PUT registers a device (enabled defaults true) and GET lists it', async () => {
    const { auth } = await freshSession();
    const installationId = `install-${randomBytes(4).toString('hex')}`;

    const put = await reqJson(
      `/me/devices/${installationId}/push`,
      'PUT',
      { expoPushToken: expoToken(), platform: 'ios', appVersion: '1.2.3' },
      auth,
    );
    expect(put.status).toBe(200);
    expect(put.body['ok']).toBe(true);
    expect(put.body['device'].installationId).toBe(installationId);
    expect(put.body['device'].enabled).toBe(true);
    expect(put.body['device'].platform).toBe('ios');
    expect(put.body['device'].appVersion).toBe('1.2.3');

    const list = await reqJson('/me/devices', 'GET', undefined, auth);
    expect(list.status).toBe(200);
    const devices = list.body['devices'] as Array<{ installationId: string; enabled: boolean }>;
    expect(devices).toHaveLength(1);
    expect(devices[0]!.installationId).toBe(installationId);
    expect(devices[0]!.enabled).toBe(true);
    // The raw push token is never exposed on the management surface.
    expect(JSON.stringify(list.body)).not.toContain('ExponentPushToken');
  });

  it('PUT twice with the same installationId keeps ONE row and rotates the token', async () => {
    const { auth, userId } = await freshSession();
    const installationId = `install-${randomBytes(4).toString('hex')}`;
    const token1 = expoToken();
    const token2 = expoToken();

    await reqJson(`/me/devices/${installationId}/push`, 'PUT', { expoPushToken: token1, platform: 'android' }, auth);
    await reqJson(`/me/devices/${installationId}/push`, 'PUT', { expoPushToken: token2, platform: 'android' }, auth);

    const list = await reqJson('/me/devices', 'GET', undefined, auth);
    expect(list.body['devices'] as unknown[]).toHaveLength(1);

    // The token isn't on the wire; verify the rotation via the store directly.
    const rows = await store.listDevices(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(token2);
  });

  it('DELETE is idempotent (200 whether or not the device exists)', async () => {
    const { auth } = await freshSession();
    const installationId = `install-${randomBytes(4).toString('hex')}`;
    await reqJson(`/me/devices/${installationId}/push`, 'PUT', { expoPushToken: expoToken(), platform: 'web' }, auth);

    const del1 = await reqJson(`/me/devices/${installationId}/push`, 'DELETE', undefined, auth);
    expect(del1.status).toBe(200);
    expect(del1.body['ok']).toBe(true);

    const del2 = await reqJson(`/me/devices/${installationId}/push`, 'DELETE', undefined, auth);
    expect(del2.status).toBe(200);
    expect(del2.body['ok']).toBe(true);

    const list = await reqJson('/me/devices', 'GET', undefined, auth);
    expect(list.body['devices'] as unknown[]).toHaveLength(0);
  });

  it('PATCH /me/notification-preferences merges and returns the merged map', async () => {
    const { auth } = await freshSession();
    const installationId = `install-${randomBytes(4).toString('hex')}`;
    await reqJson(`/me/devices/${installationId}/push`, 'PUT', { expoPushToken: expoToken(), platform: 'ios' }, auth);

    const first = await reqJson('/me/notification-preferences', 'PATCH', { fills: false }, auth);
    expect(first.status).toBe(200);
    expect(first.body['preferences']).toEqual({ fills: false });

    const second = await reqJson('/me/notification-preferences', 'PATCH', { orders: false }, auth);
    expect(second.status).toBe(200);
    expect(second.body['preferences']).toEqual({ fills: false, orders: false });

    // The merged prefs land on the device row and surface on /me/devices.
    const list = await reqJson('/me/devices', 'GET', undefined, auth);
    const device = (list.body['devices'] as Array<{ preferences: Record<string, boolean> }>)[0]!;
    expect(device.preferences).toEqual({ fills: false, orders: false });
  });

  it('PUT does not clobber preferences already set via PATCH', async () => {
    const { auth, userId } = await freshSession();
    const installationId = `install-${randomBytes(4).toString('hex')}`;
    await reqJson(`/me/devices/${installationId}/push`, 'PUT', { expoPushToken: expoToken(), platform: 'ios' }, auth);
    await reqJson('/me/notification-preferences', 'PATCH', { fills: false }, auth);

    // App-open re-register (no preferences in the body) must keep prior prefs.
    await reqJson(`/me/devices/${installationId}/push`, 'PUT', { expoPushToken: expoToken(), platform: 'ios' }, auth);
    const rows = await store.listDevices(userId);
    expect(rows[0]!.preferences).toEqual({ fills: false });
    expect(rows[0]!.enabled).toBe(true);
  });

  it('PATCH rejects non-boolean preference values at the zod boundary (400)', async () => {
    const { auth } = await freshSession();
    const res = await reqJson('/me/notification-preferences', 'PATCH', { fills: 'nope' }, auth);
    expect(res.status).toBe(400);
  });
});

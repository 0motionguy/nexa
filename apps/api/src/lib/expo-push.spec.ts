/**
 * NEO Session 1 — Expo push delivery gating. A device only receives a push when
 * it's enabled AND hasn't opted out of the push's category.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceAllowsCategory, sendExpoPushToUser } from './expo-push.js';
import { store } from '../store/index.js';

describe('lib/expo-push — deviceAllowsCategory gate', () => {
  it('allows an enabled device with no opt-out (undefined category = ON)', () => {
    expect(deviceAllowsCategory({ enabled: true, preferences: null }, 'fills')).toBe(true);
    expect(deviceAllowsCategory({ enabled: true, preferences: { orders: false } }, 'fills')).toBe(true);
  });

  it('blocks a disabled device regardless of preferences', () => {
    expect(deviceAllowsCategory({ enabled: false, preferences: null }, 'fills')).toBe(false);
    expect(deviceAllowsCategory({ enabled: false, preferences: { fills: true } }, 'fills')).toBe(false);
  });

  it('blocks only the opted-out category; others stay allowed', () => {
    expect(deviceAllowsCategory({ enabled: true, preferences: { fills: false } }, 'fills')).toBe(false);
    expect(deviceAllowsCategory({ enabled: true, preferences: { fills: false } }, 'orders')).toBe(true);
  });
});

describe('lib/expo-push — sendExpoPushToUser respects the per-device gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends only to enabled devices whose category is not opted out', async () => {
    const user = await store.upsertUserByEmail(
      `push-gate-${Math.random().toString(16).slice(2)}@example.com`,
    );
    const allowedToken = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]';
    // a: eligible · b: disabled · c: opted out of 'fills'.
    await store.upsertDeviceByInstallation(user.id, {
      installationId: 'a',
      expoPushToken: allowedToken,
      platform: 'ios',
    });
    await store.upsertDeviceByInstallation(user.id, {
      installationId: 'b',
      expoPushToken: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbb]',
      platform: 'ios',
      enabled: false,
    });
    await store.upsertDeviceByInstallation(user.id, {
      installationId: 'c',
      expoPushToken: 'ExponentPushToken[cccccccccccccccccccc]',
      platform: 'ios',
      preferences: { fills: false },
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const count = await sendExpoPushToUser(user.id, { title: 't', body: 'b' }, { category: 'fills' });

    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as Array<{ to: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(allowedToken);
  });

  it('sends to no one when every device is disabled or opted out', async () => {
    const user = await store.upsertUserByEmail(
      `push-gate-off-${Math.random().toString(16).slice(2)}@example.com`,
    );
    await store.upsertDeviceByInstallation(user.id, {
      installationId: 'x',
      expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxx]',
      platform: 'ios',
      preferences: { fills: false },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const count = await sendExpoPushToUser(user.id, { title: 't', body: 'b' }, { category: 'fills' });
    expect(count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

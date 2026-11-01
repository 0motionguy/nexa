import { describe, expect, it, vi } from 'vitest';
import { createActivityPushNotifier } from './push-notifications.js';
import type { Activity, PushSubscriptionRecord, Store } from '../store/types.js';

const baseSubscription: PushSubscriptionRecord = {
  id: 'sub_1',
  userId: 'user_1',
  endpoint: 'https://push.example/sub/one',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  userAgent: 'vitest',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
};

const sensitiveActivity: Activity = {
  id: 'act_1',
  n: 'Sent · alice@example.com',
  s: 'BASE · 0xabc123',
  a: '-$100.00',
  k: 'out',
  txHash: '0xabc123',
  at: '2026-06-20T00:00:00.000Z',
};

function fakeStore(subscriptions: PushSubscriptionRecord[]): Store {
  return {
    pushSubscriptionsForUser: vi.fn(async () => subscriptions),
    deletePushSubscription: vi.fn(async () => true),
  } as unknown as Store;
}

describe('activity push notifications', () => {
  it('sends a privacy-safe generic payload for activity events', async () => {
    const store = fakeStore([baseSubscription]);
    const send = vi.fn(async () => {});
    const notifier = createActivityPushNotifier({ store, sender: { send }, enabled: true });

    await notifier.notifyActivity('user_1', sensitiveActivity);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0]![1]) as Record<string, string>;
    expect(payload).toEqual({
      title: 'MAZE activity',
      body: 'Open MAZE to view your latest update.',
      url: '/app.html#s29',
    });
    expect(JSON.stringify(payload)).not.toContain('alice@example.com');
    expect(JSON.stringify(payload)).not.toContain('$100.00');
    expect(JSON.stringify(payload)).not.toContain('0xabc123');
  });

  it('does nothing when push is disabled or no subscriptions exist', async () => {
    const store = fakeStore([]);
    const send = vi.fn(async () => {});
    const notifier = createActivityPushNotifier({ store, sender: { send }, enabled: false });

    await notifier.notifyActivity('user_1', sensitiveActivity);

    expect(store.pushSubscriptionsForUser).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes stale browser subscriptions after push gateway 404 or 410', async () => {
    const store = fakeStore([baseSubscription]);
    const err = new Error('gone') as Error & { statusCode: number };
    err.statusCode = 410;
    const send = vi.fn(async () => {
      throw err;
    });
    const notifier = createActivityPushNotifier({ store, sender: { send }, enabled: true });

    await notifier.notifyActivity('user_1', sensitiveActivity);

    expect(store.deletePushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1' }),
      baseSubscription.endpoint,
    );
  });
});

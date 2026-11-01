import webPush from 'web-push';
import { env, features } from './env.js';
import { log } from './log.js';
import type { Activity, PushSubscriptionRecord, Store, User } from '../store/types.js';
import type { PushSubscription } from 'web-push';

export interface PushNotificationSender {
  send(subscription: PushSubscription, payload: string): Promise<void>;
}

export interface ActivityPushNotifier {
  notifyActivity(userId: string, activity: Activity): Promise<void>;
}

export function createWebPushSender(): PushNotificationSender | null {
  if (!features.push || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  webPush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  return {
    async send(subscription, payload) {
      await webPush.sendNotification(subscription, payload);
    },
  };
}

export function createActivityPushNotifier(opts: {
  store: Store;
  sender: PushNotificationSender | null;
  enabled?: boolean;
}): ActivityPushNotifier {
  const enabled = opts.enabled ?? Boolean(opts.sender);
  return {
    async notifyActivity(userId: string, _activity: Activity): Promise<void> {
      if (!enabled || !opts.sender) return;
      const subscriptions = await opts.store.pushSubscriptionsForUser(userId);
      if (subscriptions.length === 0) return;
      const payload = JSON.stringify({
        title: 'MAZE activity',
        body: 'Open MAZE to view your latest update.',
        url: '/app.html#s29',
      });
      await Promise.allSettled(
        subscriptions.map((subscription) =>
          sendToSubscription(opts.store, opts.sender!, userId, subscription, payload),
        ),
      );
    },
  };
}

async function sendToSubscription(
  store: Store,
  sender: PushNotificationSender,
  userId: string,
  subscription: PushSubscriptionRecord,
  payload: string,
): Promise<void> {
  try {
    await sender.send({ endpoint: subscription.endpoint, keys: subscription.keys }, payload);
  } catch (err) {
    if (isStaleSubscriptionError(err)) {
      await store.deletePushSubscription({ id: userId } as User, subscription.endpoint);
      return;
    }
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        endpoint: subscription.endpoint,
        userId,
      },
      'push: notification send failed',
    );
  }
}

function isStaleSubscriptionError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('statusCode' in err)) return false;
  const statusCode = Number((err as { statusCode?: unknown }).statusCode);
  return statusCode === 404 || statusCode === 410;
}

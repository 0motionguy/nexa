import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { env, features } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { requireSession } from '../lib/auth.js';
import { isExpoPushToken } from '../lib/expo-push.js';
import { store } from '../store/index.js';
import type { PushSubscriptionRecord } from '../store/types.js';

const PushEndpoint = z.string().url().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'invalid_endpoint');

const PushSubscriptionBody = z.object({
  endpoint: PushEndpoint,
  keys: z.object({
    p256dh: z.string().min(16).max(4096),
    auth: z.string().min(8).max(512),
  }),
});

const PushDeleteBody = z.object({
  endpoint: PushEndpoint,
});

export const pushRoutes = new Hono();

pushRoutes.use('*', requireSession);

pushRoutes.get('/vapid-public-key', (c) => {
  if (!features.push || !env.VAPID_PUBLIC_KEY) throw ApiError.notFound('push_unavailable');
  return c.json({ ok: true, publicKey: env.VAPID_PUBLIC_KEY });
});

pushRoutes.post('/subscribe', zValidator('json', PushSubscriptionBody), async (c) => {
  if (!features.push) throw ApiError.notFound('push_unavailable');
  const u = c.get('user');
  const body = c.req.valid('json');
  const sub = await store.savePushSubscription(u, {
    ...body,
    userAgent: c.req.header('user-agent') ?? null,
  });
  return c.json({ ok: true, subscribed: true, id: sub.id });
});

pushRoutes.delete('/subscribe', zValidator('json', PushDeleteBody), async (c) => {
  const u = c.get('user');
  const { endpoint } = c.req.valid('json');
  const deleted = await store.deletePushSubscription(u, endpoint);
  return c.json({ ok: true, deleted });
});

pushRoutes.get('/subscriptions', async (c) => {
  const u = c.get('user');
  const subscriptions = await store.listPushSubscriptions(u);
  return c.json({ ok: true, subscriptions: subscriptions.map(subscriptionView) });
});

const ExpoSubscribeBody = z.object({
  /** Expo push token — opaque string starting with `ExponentPushToken[…]`. */
  token: z.string().min(20).max(256).refine(isExpoPushToken, 'invalid_expo_token'),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().min(1).max(32).optional(),
});

const ExpoUnsubscribeBody = z.object({
  token: z.string().min(20).max(256).refine(isExpoPushToken, 'invalid_expo_token'),
});

/**
 * Register an Expo Push token for the authenticated mobile user. v1 stores
 * in-memory (see apps/api/src/lib/expo-push.ts) — tokens re-register on every
 * Neo app open. v1.1 migrates to a `nb_expo_push_subscriptions` table.
 */
pushRoutes.post('/expo-subscribe', zValidator('json', ExpoSubscribeBody), async (c) => {
  const u = c.get('user');
  const body = c.req.valid('json');
  const sub = await store.saveExpoPushSubscription(u, body);
  return c.json({
    ok: true,
    subscription: { token: sub.token, platform: sub.platform, updatedAt: sub.updatedAt },
  });
});

pushRoutes.delete('/expo-subscribe', zValidator('json', ExpoUnsubscribeBody), async (c) => {
  const u = c.get('user');
  const { token } = c.req.valid('json');
  const deleted = await store.deleteExpoPushSubscription(u, token);
  return c.json({ ok: true, deleted });
});

pushRoutes.get('/expo-subscriptions', async (c) => {
  const u = c.get('user');
  const subs = await store.listExpoPushSubscriptions(u);
  return c.json({
    ok: true,
    subscriptions: subs.map((s) => ({
      token: s.token,
      platform: s.platform,
      appVersion: s.appVersion,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
  });
});

function subscriptionView(sub: PushSubscriptionRecord): {
  id: string;
  endpoint: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: sub.id,
    endpoint: sub.endpoint,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

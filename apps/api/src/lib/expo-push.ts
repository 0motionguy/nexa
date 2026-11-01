/**
 * Expo Push sender.
 *
 * Storage moved to the DB (`nb_expo_push_subscriptions` via the store,
 * competitor sprint push channel 2026-07-03) — was an in-memory Map that the
 * scheduler process (where the fills worker runs) could not see. This module
 * now owns only the wire concerns: token-shape validation, the exp.host HTTP
 * call, and pruning DeviceNotRegistered tokens through the store.
 *
 * Expo Push HTTP API docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */
import { log } from './log.js';
import { store } from '../store/index.js';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
export const MAX_EXPO_PUSH_TOKENS_PER_USER = 10;

export interface ExpoPushPayload {
  title: string;
  body: string;
  /** Deep-link path inside the Neo app — e.g. "/markets/BTC" or "/portfolio". */
  link?: string;
  /** Arbitrary data the notification handler can read off. */
  data?: Record<string, unknown>;
  /** Push channel id for Android (defaults to "default"). */
  channelId?: string;
  badge?: number;
}

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channelId?: string;
  sound?: 'default';
  badge?: number;
  priority?: 'high';
};

export function isExpoPushToken(token: string): boolean {
  return /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token);
}

/**
 * Notification category (NEO Session 1). A device can opt out per-category via
 * its `preferences` map ({ fills:false } etc.). `general` is the default for
 * callers that don't specify one — it preserves prior "send to everyone"
 * behavior since an undefined preference is always allowed.
 */
export type PushCategory = 'fills' | 'orders' | 'markets' | 'rewards' | 'general';

/**
 * Pure delivery gate for a device (NEO Session 1). A device receives a push in
 * `category` unless it's disabled outright (`enabled === false`) or has
 * explicitly opted out of that category (`preferences[category] === false`).
 * An undefined preference means ON. Extracted so the gating logic is
 * unit-testable without mocking the network.
 */
export function deviceAllowsCategory(
  device: { enabled: boolean; preferences: Record<string, boolean> | null },
  category: string,
): boolean {
  if (device.enabled === false) return false;
  if (device.preferences && device.preferences[category] === false) return false;
  return true;
}

/**
 * Fire a notification to every ELIGIBLE Expo device registered for `userId` —
 * skipping devices that are disabled or have opted out of `category` (default
 * 'general'). Never throws — failures log a warning. Returns the number of
 * devices we attempted to push to (not necessarily delivered). Reads devices
 * from the store, so it works identically from the API and the scheduler/worker.
 */
export async function sendExpoPushToUser(
  userId: string,
  payload: ExpoPushPayload,
  opts?: { category?: PushCategory },
): Promise<number> {
  const category = opts?.category ?? 'general';
  const all = await store.expoPushSubscriptionsForUser(userId).catch((e) => {
    log.warn({ err: e instanceof Error ? e.message : String(e), userId }, 'expo-push: token read failed');
    return [];
  });
  // NEO Session 1 — respect per-device enable + per-category opt-out.
  const subs = all.filter((s) => deviceAllowsCategory(s, category));
  if (subs.length === 0) return 0;
  const messages: ExpoPushMessage[] = subs.map((sub) => ({
    to: sub.token,
    title: payload.title,
    body: payload.body,
    data: { ...(payload.data ?? {}), link: payload.link },
    channelId: payload.channelId ?? 'default',
    sound: 'default',
    badge: payload.badge,
    priority: 'high',
  }));
  try {
    const res = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, userId, count: messages.length },
        'expo-push: send returned non-ok',
      );
      return messages.length;
    }
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{ status?: string; message?: string; details?: { error?: string } }>;
    } | null;
    const tickets = body?.data ?? [];
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (t?.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
        const dead = subs[i];
        if (dead) {
          void store.pruneExpoPushToken(userId, dead.token).catch(() => false);
          log.info(
            { userId, token: dead.token.slice(0, 12) + '…' },
            'expo-push: pruned DeviceNotRegistered token',
          );
        }
      }
    }
    return messages.length;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), userId, count: messages.length },
      'expo-push: send failed',
    );
    return messages.length;
  }
}


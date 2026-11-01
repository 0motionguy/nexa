/**
 * webhook-dedup tests — replay protection mechanics.
 *
 * Backend coverage: in-memory only here (the Redis path goes through
 * lib/redis.ts and is exercised in the bridge/onramp route integration
 * specs when REDIS_URL is set).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetWebhookDedupForTests,
  _webhookDedupSizeForTests,
  markWebhookSeen,
} from './webhook-dedup.js';

describe('webhook-dedup (in-memory)', () => {
  afterEach(() => _resetWebhookDedupForTests());

  it('returns false on first sighting, true on replay', async () => {
    expect(await markWebhookSeen('stripe', 'evt_001')).toBe(false);
    expect(await markWebhookSeen('stripe', 'evt_001')).toBe(true);
    expect(await markWebhookSeen('stripe', 'evt_001')).toBe(true);
  });

  it('source namespaces are isolated', async () => {
    expect(await markWebhookSeen('stripe', 'shared-id')).toBe(false);
    expect(await markWebhookSeen('bridge', 'shared-id')).toBe(false);
    expect(await markWebhookSeen('stripe', 'shared-id')).toBe(true);
    expect(await markWebhookSeen('bridge', 'shared-id')).toBe(true);
  });

  it('passes through (returns false) when source or id is missing', async () => {
    expect(await markWebhookSeen('', 'evt_001')).toBe(false);
    expect(await markWebhookSeen('stripe', '')).toBe(false);
    // Repeat: still false (no record was made).
    expect(await markWebhookSeen('', 'evt_001')).toBe(false);
  });

  it('records each unique event in the in-memory map', async () => {
    expect(_webhookDedupSizeForTests()).toBe(0);
    await markWebhookSeen('stripe', 'a');
    await markWebhookSeen('stripe', 'b');
    await markWebhookSeen('stripe', 'c');
    expect(_webhookDedupSizeForTests()).toBe(3);
  });
});

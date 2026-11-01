/**
 * Unit tests for the webhook signing primitives. Pure functions — no server, no
 * store, no network. Verifies determinism, sensitivity to every input, and the
 * `t=…,v1=…` header format receivers parse.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEndpoint } from '../store/types.js';

const safeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/safe-fetch.js', () => ({
  safeFetch: safeFetchMock,
}));

import { fireWebhooks, signWebhook, signatureHeader } from '../lib/webhooks.js';

const SECRET = 'whsec_test_abc123';
const TS = 1_700_000_000;
const PAYLOAD = JSON.stringify({ id: 'evt_1', type: 'payment.paid' });

beforeEach(() => {
  safeFetchMock.mockReset();
});

describe('signWebhook', () => {
  it('is deterministic for fixed (secret, timestamp, payload)', () => {
    const a = signWebhook(SECRET, TS, PAYLOAD);
    const b = signWebhook(SECRET, TS, PAYLOAD);
    expect(a).toBe(b);
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(signWebhook(SECRET, TS, PAYLOAD)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when the secret changes', () => {
    expect(signWebhook(SECRET, TS, PAYLOAD)).not.toBe(signWebhook('whsec_other', TS, PAYLOAD));
  });

  it('changes when the timestamp changes', () => {
    expect(signWebhook(SECRET, TS, PAYLOAD)).not.toBe(signWebhook(SECRET, TS + 1, PAYLOAD));
  });

  it('changes when the payload changes', () => {
    expect(signWebhook(SECRET, TS, PAYLOAD)).not.toBe(signWebhook(SECRET, TS, PAYLOAD + ' '));
  });
});

describe('signatureHeader', () => {
  it('formats as t=<timestamp>,v1=<hex64>', () => {
    const header = signatureHeader(SECRET, TS, PAYLOAD);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('embeds the timestamp and the matching signature', () => {
    const sig = signWebhook(SECRET, TS, PAYLOAD);
    expect(signatureHeader(SECRET, TS, PAYLOAD)).toBe(`t=${TS},v1=${sig}`);
  });
});

describe('fireWebhooks', () => {
  it('caps concurrent deliveries at five endpoints', async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    safeFetchMock.mockImplementation(
      async () =>
        new Promise<Response>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          release.push(() => {
            active -= 1;
            resolve(new Response('', { status: 200 }));
          });
        }),
    );

    const endpoints: WebhookEndpoint[] = Array.from({ length: 12 }, (_, i) => ({
      id: `wh_${i}`,
      sellerId: 'seller_1',
      url: `https://public.example.com/${i}`,
      secret: SECRET,
      active: true,
      createdAt: new Date(0).toISOString(),
    }));

    const done = fireWebhooks(endpoints, {
      id: 'evt_1',
      type: 'payment.paid',
      created: new Date(0).toISOString(),
      data: {},
    });

    await vi.waitFor(() => expect(safeFetchMock).toHaveBeenCalledTimes(5));
    release.splice(0, 5).forEach((fn) => fn());
    await vi.waitFor(() => expect(safeFetchMock).toHaveBeenCalledTimes(10));
    release.splice(0, 5).forEach((fn) => fn());
    await vi.waitFor(() => expect(safeFetchMock).toHaveBeenCalledTimes(12));
    release.splice(0).forEach((fn) => fn());

    await done;
    expect(maxActive).toBe(5);
  });
});

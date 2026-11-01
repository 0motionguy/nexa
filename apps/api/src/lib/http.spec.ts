import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from './http.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpRequest', () => {
  it('does not retry upstream 429 responses', async () => {
    const fetchSpy = vi.fn(async () => new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '60' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await httpRequest('https://vendor.test/limited', {
      vendor: 'vendor',
      method: 'GET',
      maxAttempts: 3,
      backoffMs: () => 0,
    });

    expect(res.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

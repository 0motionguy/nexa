/**
 * Unit tests for the SSRF-guard. Verifies the private-range checks against
 * the canonical CIDRs and that the URL/scheme guards reject the obvious
 * attack vectors. DNS lookup is mocked so the test stays offline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => {
  return {
    lookup: vi.fn(async (host: string, opts?: { all?: boolean }) => {
      // Tiny stub resolver. The test cases below all use these hosts.
      const table: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
        'public.example.com': [{ address: '93.184.216.34', family: 4 }],
        'mixed.example.com': [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
        'internal.test': [{ address: '10.0.0.1', family: 4 }],
        'metadata.example': [{ address: '169.254.169.254', family: 4 }],
        'v6public.example': [{ address: '2606:4700:4700::1111', family: 6 }],
        'v6loopback.example': [{ address: '::1', family: 6 }],
        'v6linklocal.example': [{ address: 'fe80::1', family: 6 }],
        'mapped.example': [{ address: '::ffff:10.0.0.1', family: 6 }],
        'nx.example': [],
      };
      const hit = table[host];
      if (!hit || hit.length === 0) throw new Error('ENOTFOUND');
      return opts?.all ? hit : hit[0];
    }),
  };
});

import { _internals, safeFetch, validateUrl } from './safe-fetch.js';

describe('safe-fetch IP range checks', () => {
  const { isPrivateV4, isPrivateV6 } = _internals;

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254', // AWS metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1', // benchmark
    '224.0.0.1', // multicast
  ])('rejects private IPv4 %s', (addr) => {
    expect(isPrivateV4(addr)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.255'])(
    'accepts public IPv4 %s',
    (addr) => {
      expect(isPrivateV4(addr)).toBe(false);
    },
  );

  it.each(['::1', 'fe80::1', 'fc00::1', '::', '::ffff:10.0.0.1'])(
    'rejects private IPv6 %s',
    (addr) => {
      expect(isPrivateV6(addr)).toBe(true);
    },
  );

  it.each(['2606:4700:4700::1111', '2001:db8::1'])('accepts public IPv6 %s', (addr) => {
    expect(isPrivateV6(addr)).toBe(false);
  });
});

describe('validateUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a public URL', async () => {
    const r = await validateUrl('https://public.example.com/hook');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ip).toBe('93.184.216.34');
  });

  it('rejects non-http schemes', async () => {
    const r1 = await validateUrl('file:///etc/passwd');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('non_http');

    const r2 = await validateUrl('ftp://example.com');
    expect(r2.ok).toBe(false);
  });

  it('rejects malformed URLs', async () => {
    const r = await validateUrl('not-a-url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_url');
  });

  it('rejects literal private IPv4 addresses', async () => {
    const r = await validateUrl('http://127.0.0.1/admin');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('internal_ip');
  });

  it('rejects literal private IPv6 addresses', async () => {
    const r = await validateUrl('http://[::1]:8080/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('internal_ip');
  });

  it('rejects DNS-resolved private IPv4', async () => {
    const r = await validateUrl('https://internal.test/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('internal_ip');
  });

  it('rejects DNS answers when any resolved address is private', async () => {
    const r = await validateUrl('https://mixed.example.com/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('internal_ip');
  });

  it('rejects DNS-resolved AWS metadata host', async () => {
    const r = await validateUrl('https://metadata.example/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('internal_ip');
  });

  it('rejects DNS-resolved IPv4-mapped IPv6', async () => {
    const r = await validateUrl('https://mapped.example/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('internal_ip');
  });

  it('rejects DNS failures', async () => {
    const r = await validateUrl('https://nx.example/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dns_failed');
  });
});

describe('safeFetch', () => {
  it('throws ssrf_blocked:<reason> on private targets', async () => {
    await expect(safeFetch('http://127.0.0.1/x')).rejects.toThrow(/ssrf_blocked:internal_ip/);
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/ssrf_blocked:non_http/);
  });

  it('delegates to global fetch when validation passes', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('hi', { status: 200 }));
    try {
      const res = await safeFetch('https://public.example.com/');
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith('https://public.example.com/', undefined);
    } finally {
      spy.mockRestore();
    }
  });
});

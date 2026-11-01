import { describe, expect, it } from 'vitest';
import { normalizeIpfsUrl } from './ipfs-url.js';

describe('normalizeIpfsUrl', () => {
  it('passes healthy URLs through untouched', () => {
    expect(normalizeIpfsUrl('https://ipfs.io/ipfs/QmQr3Fz4h1etNsF7oLGMRHiCzhB5y9a7GjyodnF7zLHK1g')).toBe(
      'https://ipfs.io/ipfs/QmQr3Fz4h1etNsF7oLGMRHiCzhB5y9a7GjyodnF7zLHK1g',
    );
    expect(normalizeIpfsUrl('https://static.jup.ag/img/bonk.png')).toBe(
      'https://static.jup.ag/img/bonk.png',
    );
  });

  it('returns null for empty-ish input', () => {
    expect(normalizeIpfsUrl(null)).toBeNull();
    expect(normalizeIpfsUrl(undefined)).toBeNull();
    expect(normalizeIpfsUrl('   ')).toBeNull();
  });

  it('rewrites bare ipfs:// URIs onto the gateway', () => {
    expect(normalizeIpfsUrl('ipfs://QmWV8QgmH1gSw41yapzsFwkC8yPbzoSreAcJbzqfvo2sVq')).toBe(
      'https://ipfs.io/ipfs/QmWV8QgmH1gSw41yapzsFwkC8yPbzoSreAcJbzqfvo2sVq',
    );
    // Redundant ipfs/ prefix variant seen in older pump.fun metadata.
    expect(normalizeIpfsUrl('ipfs://ipfs/QmWV8QgmH1gSw41yapzsFwkC8yPbzoSreAcJbzqfvo2sVq/icon.png')).toBe(
      'https://ipfs.io/ipfs/QmWV8QgmH1gSw41yapzsFwkC8yPbzoSreAcJbzqfvo2sVq/icon.png',
    );
    expect(normalizeIpfsUrl('ipfs://')).toBeNull();
  });

  it('rewrites dead path-style Cloudflare gateways (the live console failure)', () => {
    expect(normalizeIpfsUrl('https://cf-ipfs.com/ipfs/QmWV8QgmH1gSw41yapzsFwkC8yPbzoSreAcJbzqfvo2sVq')).toBe(
      'https://ipfs.io/ipfs/QmWV8QgmH1gSw41yapzsFwkC8yPbzoSreAcJbzqfvo2sVq',
    );
    expect(
      normalizeIpfsUrl('https://cloudflare-ipfs.com/ipfs/QmSBgFtpXnxLMeyU1Czs1PW5Zv7nFjy8ZXe5ZDhA8fyyPD?img-width=64'),
    ).toBe('https://ipfs.io/ipfs/QmSBgFtpXnxLMeyU1Czs1PW5Zv7nFjy8ZXe5ZDhA8fyyPD?img-width=64');
  });

  it('rewrites dead subdomain-style gateways', () => {
    expect(
      normalizeIpfsUrl('https://qmwv8qgmh1gsw41yapzsfwkc8ypbzosreacjbzqfvo2svq.ipfs.cf-ipfs.com/'),
    ).toBe('https://ipfs.io/ipfs/qmwv8qgmh1gsw41yapzsfwkc8ypbzosreacjbzqfvo2svq');
    expect(
      normalizeIpfsUrl('https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.cloudflare-ipfs.com/art/1.png'),
    ).toBe('https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/art/1.png');
  });

  it('drops dead-gateway URLs with no recoverable CID', () => {
    expect(normalizeIpfsUrl('https://cf-ipfs.com/about')).toBeNull();
  });

  it('leaves non-URL garbage to the caller', () => {
    expect(normalizeIpfsUrl('not a url')).toBe('not a url');
  });
});

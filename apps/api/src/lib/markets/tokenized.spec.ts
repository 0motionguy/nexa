/**
 * Tokenized-stocks capability detector tests — Sprint 15.
 *
 * The detector must default to `none / not routable` until provider keys land,
 * so the UI keeps the asset class hidden. These tests guard that invariant
 * and exercise the caching behavior.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTokenizedCache,
  detectTokenizedCapabilities,
  detectTokenizedCapability,
  peekTokenizedCapability,
} from './tokenized.js';

beforeEach(() => {
  clearTokenizedCache();
  delete process.env['XSTOCKS_API_KEY'];
  delete process.env['DINARI_API_KEY'];
});

describe('lib/markets/tokenized', () => {
  it('defaults to provider=none / routable=false when no env keys are set', async () => {
    const cap = await detectTokenizedCapability('AAPLx');
    expect(cap.provider).toBe('none');
    expect(cap.routable).toBe(false);
    expect(cap.reason).toBe('no_provider_keys_configured');
  });

  it('caches the result for subsequent peeks', async () => {
    await detectTokenizedCapability('TSLAx');
    const peek = peekTokenizedCapability('TSLAx');
    expect(peek).not.toBeNull();
    expect(peek!.provider).toBe('none');
    expect(peek!.routable).toBe(false);
  });

  it('caches by uppercased symbol so casing is irrelevant', async () => {
    await detectTokenizedCapability('spyx');
    expect(peekTokenizedCapability('SPYx')).not.toBeNull();
    expect(peekTokenizedCapability('spyx')).not.toBeNull();
  });

  it('returns provider=xstocks with routable=false when XSTOCKS_API_KEY is set (probe stub)', async () => {
    process.env['XSTOCKS_API_KEY'] = 'fake-test-key';
    const cap = await detectTokenizedCapability('AAPLx');
    expect(cap.provider).toBe('xstocks');
    expect(cap.routable).toBe(false);
    expect(cap.reason).toBe('xstocks_probe_failed');
  });

  it('returns provider=dinari with routable=false when only DINARI_API_KEY is set', async () => {
    process.env['DINARI_API_KEY'] = 'fake-test-key';
    const cap = await detectTokenizedCapability('AAPLx');
    expect(cap.provider).toBe('dinari');
    expect(cap.routable).toBe(false);
    expect(cap.reason).toBe('dinari_probe_failed');
  });

  it('bulk capability lookup returns one entry per symbol', async () => {
    const result = await detectTokenizedCapabilities(['AAPLx', 'TSLAx', 'SPYx']);
    expect(Object.keys(result)).toEqual(['AAPLx', 'TSLAx', 'SPYx']);
    for (const cap of Object.values(result)) {
      expect(cap.provider).toBe('none');
      expect(cap.routable).toBe(false);
    }
  });
});

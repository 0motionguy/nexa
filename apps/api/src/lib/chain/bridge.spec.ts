/**
 * Sprint 11 Phase 0 — webhook freshness gate for the Bridge adapter.
 *
 * Live-mode + demo-mode behaviour is covered in bridge-live.spec.ts. These
 * tests focus on the new `t=<ts>` parse: when the header carries a timestamp
 * outside `WEBHOOK_FRESHNESS_WINDOW_SECONDS`, verifyWebhook returns false
 * even when the HMAC itself is valid. Headers without a `t=` field still
 * pass through to the HMAC check unchanged so existing Bridge events that
 * don't carry a timestamp continue to verify.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;
const SECRET = 'whsec_test_freshness';
const BODY = '{"type":"funds.received","amount":"1.00"}';

function signedHeaderAt(secret: string, timestamp: number, body: string): string {
  const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `t=${timestamp},v1=${hex}`;
}

describe('Bridge webhook freshness', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      BRIDGE_API_KEY: 'bridge_test_key',
      BRIDGE_API_BASE: 'https://bridge.test',
      BRIDGE_WEBHOOK_SECRET: SECRET,
      WEBHOOK_FRESHNESS_WINDOW_SECONDS: '300',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('accepts a header with a current t=', async () => {
    const bridge = await import('./bridge.js');
    const ts = Math.floor(Date.now() / 1000);
    expect(bridge.verifyWebhook(signedHeaderAt(SECRET, ts, BODY), BODY)).toBe(true);
  });

  it('rejects a header with a t= older than the window', async () => {
    const bridge = await import('./bridge.js');
    const ts = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    expect(bridge.verifyWebhook(signedHeaderAt(SECRET, ts, BODY), BODY)).toBe(false);
  });

  it('rejects a header with a t= far in the future', async () => {
    const bridge = await import('./bridge.js');
    const ts = Math.floor(Date.now() / 1000) + 3600;
    expect(bridge.verifyWebhook(signedHeaderAt(SECRET, ts, BODY), BODY)).toBe(false);
  });

  it('still verifies legacy headers without a t= field', async () => {
    const bridge = await import('./bridge.js');
    // Plain hex digest, no Stripe-style prefix — should pass HMAC check.
    const hex = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
    expect(bridge.verifyWebhook(hex, BODY)).toBe(true);
  });
});

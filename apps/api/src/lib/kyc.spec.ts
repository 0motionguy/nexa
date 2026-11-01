/**
 * Sprint 11 Phase 0 — webhook freshness gate for the Sumsub adapter.
 *
 * Pairs with bridge.spec.ts: the parse pattern is identical. The Sumsub
 * surface itself has additional live-mode coverage in kyc-live.spec.ts; this
 * file is scoped to the new `t=<ts>` reject path.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;
const SECRET = 'whsec_kyc_test_freshness';
const BODY = '{"type":"applicantReviewed","reviewResult":{"reviewAnswer":"GREEN"}}';

function signedHeaderAt(secret: string, timestamp: number, body: string): string {
  const hex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `t=${timestamp},v1=${hex}`;
}

describe('Sumsub webhook freshness', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      SUMSUB_APP_TOKEN: 'sumsub_test_token',
      SUMSUB_SECRET_KEY: SECRET,
      WEBHOOK_FRESHNESS_WINDOW_SECONDS: '300',
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('accepts a header with a current t=', async () => {
    const kyc = await import('./kyc.js');
    const ts = Math.floor(Date.now() / 1000);
    expect(kyc.verifyWebhook(signedHeaderAt(SECRET, ts, BODY), BODY)).toBe(true);
  });

  it('rejects a header with a t= older than the window', async () => {
    const kyc = await import('./kyc.js');
    const ts = Math.floor(Date.now() / 1000) - 3600; // 1 hour old
    expect(kyc.verifyWebhook(signedHeaderAt(SECRET, ts, BODY), BODY)).toBe(false);
  });

  it('rejects a header with a t= far in the future', async () => {
    const kyc = await import('./kyc.js');
    const ts = Math.floor(Date.now() / 1000) + 3600;
    expect(kyc.verifyWebhook(signedHeaderAt(SECRET, ts, BODY), BODY)).toBe(false);
  });

  it('still verifies legacy headers without a t= field', async () => {
    const kyc = await import('./kyc.js');
    const hex = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
    expect(kyc.verifyWebhook(hex, BODY)).toBe(true);
  });
});

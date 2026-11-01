import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

describe('Sumsub webhook guardrails', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      SUMSUB_APP_TOKEN: 'sumsub_test_token',
    };
    delete process.env.SUMSUB_SECRET_KEY;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('rejects unsigned webhooks when Sumsub is enabled without a webhook secret', async () => {
    const kyc = await import('./kyc.js');
    expect(kyc.verifyWebhook(null, '{"type":"applicantReviewed"}')).toBe(false);
  });
});

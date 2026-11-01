import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('worker boot wiring', () => {
  it('keeps request-time approval jobs in the API process', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).toContain('startApprovalWorker');
    expect(source).toContain('stopApprovalWorker');
    expect(source).not.toContain('startClaimSweeper');
    expect(source).not.toContain('startSubscriptionRenewer');
    expect(source).not.toContain('stopClaimSweeper');
    expect(source).not.toContain('stopSubscriptionRenewer');
  });

  it('runs recurring money sweeps from the standalone scheduler', () => {
    const source = readFileSync(new URL('./scheduler.ts', import.meta.url), 'utf8');

    expect(source).toContain('startClaimSweeper');
    expect(source).toContain('startSubscriptionRenewer');
    expect(source).toContain('stopClaimSweeper');
    expect(source).toContain('stopSubscriptionRenewer');
  });
});

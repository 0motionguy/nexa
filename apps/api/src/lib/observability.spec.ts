import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('observability source invariants', () => {
  it('keeps JSON stdout when Sentry transport is enabled', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/log.ts'), 'utf8');
    const prodSentryStart = source.indexOf("if (env.NODE_ENV === 'production' && features.sentry)");
    const prodSentryBlock = source.slice(prodSentryStart);

    expect(prodSentryStart).toBeGreaterThan(-1);
    expect(prodSentryBlock).toContain("target: 'pino/file'");
    expect(prodSentryBlock).toContain('destination: 1');
    expect(prodSentryBlock).toContain("target: 'pino-sentry-transport'");
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('landing earn hydration', () => {
  it('does not request authenticated earn protocols for visitors', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/landing-main.ts'), 'utf8');
    const start = source.indexOf('async function hydrateLandingYieldRamp()');
    const end = source.indexOf('void hydrateLandingMarkets()', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const hydrate = source.slice(start, end);
    expect(source).toContain("import { getToken, nexaApi, type EarnAdapterSummary } from '@/lib/api.js';");
    expect(hydrate).toContain('if (!getToken()) {');
    expect(hydrate).toContain('renderLandingYieldFallback(ramp);');
    expect(hydrate.indexOf('if (!getToken())')).toBeLessThan(hydrate.indexOf('nexaApi.earnProtocols()'));
  });
});

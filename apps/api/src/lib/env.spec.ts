/**
 * W2-A — production fail-closed env guards (lib/env.ts parseEnv).
 *
 * NOTE: the wave plan says "extend the existing env spec" but no env.spec.ts
 * existed in the tree — this file introduces it. parseEnv is exercised
 * directly with synthetic raw envs, so nothing here mutates process.env or
 * re-imports the module singleton.
 */

import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const PROD_NON_DEMO_BASE: Record<string, string> = {
  NODE_ENV: 'production',
  DEMO_MODE: '0',
  JWT_SECRET: 'prod-secret-0123456789abcdef',
  NEXA_AGENT_KEYS: 'nx_live_prodkey=ops@maze.bank',
  PRIVY_APP_ID: 'privy-app-id',
  PRIVY_APP_SECRET: 'privy-app-secret',
  DATABASE_URL: 'postgresql://maze:pw@postgres:5432/maze',
  REDIS_URL: 'redis://:pw@redis:6379/2',
};

function without(base: Record<string, string>, ...keys: string[]): Record<string, string> {
  const copy = { ...base };
  for (const k of keys) delete copy[k];
  return copy;
}

describe('parseEnv — production non-demo fails closed', () => {
  it('accepts a fully-configured production non-demo env', () => {
    const env = parseEnv(PROD_NON_DEMO_BASE);
    expect(env.NODE_ENV).toBe('production');
    expect(env.DEMO_MODE).toBe(false);
    expect(env.DATABASE_URL).toBe(PROD_NON_DEMO_BASE['DATABASE_URL']);
    expect(env.REDIS_URL).toBe(PROD_NON_DEMO_BASE['REDIS_URL']);
  });

  it('throws without DATABASE_URL', () => {
    expect(() => parseEnv(without(PROD_NON_DEMO_BASE, 'DATABASE_URL'))).toThrow(/DATABASE_URL/);
  });

  it('throws without REDIS_URL', () => {
    expect(() => parseEnv(without(PROD_NON_DEMO_BASE, 'REDIS_URL'))).toThrow(/REDIS_URL/);
  });

  it('throws naming both when both are missing', () => {
    expect(() => parseEnv(without(PROD_NON_DEMO_BASE, 'DATABASE_URL', 'REDIS_URL'))).toThrow(
      /DATABASE_URL and REDIS_URL/,
    );
  });
});

describe('parseEnv — demo unaffected', () => {
  it('demo-in-production (ALLOW_DEMO_IN_PRODUCTION=1) boots without DATABASE_URL/REDIS_URL', () => {
    const env = parseEnv({
      ...without(PROD_NON_DEMO_BASE, 'DATABASE_URL', 'REDIS_URL'),
      DEMO_MODE: '1',
      ALLOW_DEMO_IN_PRODUCTION: '1',
    });
    expect(env.DEMO_MODE).toBe(true);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('development defaults (empty env) stay demo + in-memory', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.DEMO_MODE).toBe(true);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('NODE_ENV=test without persistence stays bootable', () => {
    const env = parseEnv({ NODE_ENV: 'test' });
    expect(env.DEMO_MODE).toBe(true);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('regression pin: prod demo without ALLOW_DEMO_IN_PRODUCTION still throws', () => {
    expect(() =>
      parseEnv({ ...without(PROD_NON_DEMO_BASE, 'DATABASE_URL', 'REDIS_URL'), DEMO_MODE: '1' }),
    ).toThrow(/ALLOW_DEMO_IN_PRODUCTION/);
  });
});

describe('parseEnv — blank DATABASE_URL means "unset" (Codex review 2026-07-16)', () => {
  // Demo/in-process producers export DATABASE_URL='' — Compose's
  // `${MAZE_DATABASE_URL:-}` fallback and the probe scripts that clear the
  // DSN to force the in-memory store. The DSN-scheme regex must not reject
  // those environments: blank normalizes to undefined and the in-memory
  // store engages, exactly as if the key were absent.
  it('treats DATABASE_URL="" as unset in dev/demo', () => {
    const env = parseEnv({ DATABASE_URL: '' });
    expect(env.DEMO_MODE).toBe(true);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('treats whitespace-only DATABASE_URL as unset', () => {
    const env = parseEnv({ DATABASE_URL: '   ' });
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('blank does NOT weaken prod fail-closed: prod non-demo with DATABASE_URL="" still throws', () => {
    expect(() => parseEnv({ ...PROD_NON_DEMO_BASE, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('typo pin: a non-postgres scheme still fails loudly at boot', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://maze:pw@db:3306/maze' })).toThrow(/postgres/);
  });
});

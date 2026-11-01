import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sharedZodSrc = resolve(here, '../../packages/shared-zod/src/index.ts');

/**
 * Vitest config — Sprint 11 Phase 0 introduces this file primarily to inject
 * env defaults the test suite relies on:
 *
 *   - RATE_LIMIT_ENABLED=0 — the new sliding-window middleware would 429 the
 *     auth-loop tests after the 5th attempt. Per-test overrides can flip this
 *     back on (see rate-limit.spec.ts).
 *
 * Prior to this file the suite ran on `vitest run` defaults. No reporter /
 * include changes — the default file glob still picks every *.spec.ts.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@nexa/shared-zod',
        replacement: sharedZodSrc,
      },
    ],
  },
  test: {
    // F036 / parallel-boot flake — cold imports of '../index.js' through
    // multiple spec files under parallel pressure on Windows exceed Vitest's
    // default windows. Keep tests parallel, but cap worker pressure and give
    // hooks the same budget as tests so aggregate runs match targeted runs.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
    env: {
      RATE_LIMIT_ENABLED: '0',
      // W2-B — keep unit tests hermetic: the stream-ticket store (lib/auth.ts)
      // eagerly connects through makeRedis(env.REDIS_URL) on first consume, so
      // a REDIS_URL exported in the dev shell would leak real connections into
      // the suite. Specs that want Redis set process.env.REDIS_URL explicitly
      // after vi.resetModules() (see rate-limit.spec.ts fail-mode tests).
      REDIS_URL: '',
      // WORKER-P1-1 — the fills-notifier per-lane throttle floor defaults to
      // 100ms in real deployments; at test scale (hundreds of synthetic
      // users per spec) that would add tens of seconds to the suite for no
      // signal. Specs that specifically exercise the floor set it back via
      // the env singleton (mirrors the MAX_USERS_PER_SWEEP override pattern).
      FILLS_NOTIFIER_MIN_DELAY_MS: '0',
    },
    // F038 — coverage opt-in via `pnpm test -- --coverage`. The defaults are
    // tuned for "show me what's covered" (text + html); CI can flip the
    // threshold checks on when the team agrees on a floor. Starts unenforced
    // so the new instrumentation isn't a blocker.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/db/migrations/**',
        'dist/**',
      ],
      // Threshold left intentionally unset — when the team picks a floor
      // (suggest 60% per audit F038 recommendation), uncomment:
      // thresholds: { statements: 60, branches: 55, functions: 60, lines: 60 },
    },
  },
});

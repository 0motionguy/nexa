/**
 * apps/api/src/scripts/load-harness.spec.ts
 *
 * Coverage for scripts/load-harness/ (audit blocker #11 — the
 * 1,000-distinct-user load-certification harness that replaces
 * scripts/load-gate.mjs's 30-VUs-on-one-token simulation). Two layers:
 *
 *   1. Direct unit tests of the pure functions that encode the harness's
 *      safety invariants — identity dedup/refusal, write-cohort
 *      production hard-refusal, private-event ACL classification, route
 *      family classification (regression lock for a substring-match bug
 *      caught in review — see the classifyFamily block below), gate
 *      evaluation including the short-run rate-amplification guard.
 *   2. One end-to-end subprocess run: `node run.mjs --self-test` against
 *      the harness's own local stub server, asserting exit 0 and a PASS
 *      artifact in the exact required shape.
 *
 * Lives under apps/api because this is the repo's only wired vitest
 * runner (`pnpm --filter @nexa/api exec vitest run`); the harness itself
 * is dependency-free plain .mjs living outside any workspace package
 * (spec point 6 — "apps/api or root scripts test pattern"). Note:
 * apps/api/tsconfig.json's exclude list drops every spec file from
 * typecheck, so importing untyped .mjs modules here does not affect
 * `pnpm -r typecheck`.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPrivateEvent } from '../../../../scripts/load-harness/lib/ws-client.mjs';
import { assertWriteSafety, WriteSafetyError, PRODUCTION_HOSTS } from '../../../../scripts/load-harness/lib/writes.mjs';
import { assignIdentities, IdentityPoolError } from '../../../../scripts/load-harness/lib/identity-pool.mjs';
import { pickCohort, resolveMix, foldOutWriteCohort, DEFAULT_COHORT_WEIGHTS } from '../../../../scripts/load-harness/lib/cohorts.mjs';
import { evaluateGates, percentile, summarizeLatencies, GATES, MIN_DURATION_FOR_DISCONNECT_RATE_GATE_SECONDS } from '../../../../scripts/load-harness/lib/metrics.mjs';
import { classifyFamily } from '../../../../scripts/load-harness/lib/http-client.mjs';
import { parseArgs, UsageError } from '../../../../scripts/load-harness/lib/args.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');
const runScript = resolve(repoRoot, 'scripts/load-harness/run.mjs');

describe('load-harness: identity pool (audit blocker #11 core fix)', () => {
  it('refuses to start when distinct tokens < requested users', () => {
    expect(() => assignIdentities(['a', 'a', 'a'], 5)).toThrow(IdentityPoolError);
  });

  it('refusal message cites the no-one-token-simulation rule', () => {
    expect(() => assignIdentities(['only-one'], 3)).toThrow(/DISTINCT authenticated users/);
  });

  it('assigns exactly one distinct token per user with no duplicates', () => {
    const tokens = Array.from({ length: 10 }, (_, i) => `tok-${i}`);
    const assigned = assignIdentities(tokens, 7);
    expect(assigned).toHaveLength(7);
    expect(new Set(assigned).size).toBe(7);
    for (const t of assigned) expect(tokens).toContain(t);
  });

  it('tolerates duplicate tokens in the pool as long as the distinct count suffices', () => {
    const tokens = ['a', 'a', 'b', 'c', 'c', 'c'];
    const assigned = assignIdentities(tokens, 3);
    expect(new Set(assigned)).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('load-harness: write-cohort safety gate', () => {
  it('refuses when writes are not explicitly enabled', () => {
    expect(() => assertWriteSafety({ baseUrl: 'https://staging.example/api', enableWrites: false, writeAllowlist: [] }))
      .toThrow(WriteSafetyError);
  });

  it('hard-refuses a production host even if it is allowlisted (unconditional check)', () => {
    const host = PRODUCTION_HOSTS[0];
    const call = () => assertWriteSafety({ baseUrl: `https://${host}/api`, enableWrites: true, writeAllowlist: [host] });
    expect(call).toThrow(WriteSafetyError);
    expect(call).toThrow(/unconditional/);
  });

  it('refuses a non-production host that is not in the allowlist', () => {
    expect(() => assertWriteSafety({ baseUrl: 'https://staging.example/api', enableWrites: true, writeAllowlist: [] }))
      .toThrow(WriteSafetyError);
  });

  it('allows a non-production, allowlisted host', () => {
    expect(() => assertWriteSafety({ baseUrl: 'https://staging.example/api', enableWrites: true, writeAllowlist: ['staging.example'] }))
      .not.toThrow();
  });
});

describe('load-harness: cross-user private-event correctness probe', () => {
  it("classifies a topic addressed to the VU's own userId as own", () => {
    expect(classifyPrivateEvent('priv:user-123:orders', 'user-123')).toBe('own');
  });
  it('classifies a topic addressed to a different userId as cross_user', () => {
    expect(classifyPrivateEvent('priv:user-999:orders', 'user-123')).toBe('cross_user');
  });
  it('classifies non-private topics as not_private', () => {
    expect(classifyPrivateEvent('ticker:hl:BTC', 'user-123')).toBe('not_private');
  });
});

describe('load-harness: HTTP route family classification', () => {
  // Regression lock: an earlier draft classified by `path.includes('/order')`,
  // which misclassified the GET /markets/orders READ route as a write
  // because '/markets/orders'.includes('/order') is true. Method-based
  // classification is the fix — this pins it.
  it('classifies GET /markets/orders as authed, not write', () => {
    expect(classifyFamily('/markets/orders', 'GET')).toBe('authed');
  });
  it('classifies any non-GET method as write regardless of path', () => {
    expect(classifyFamily('/markets/hyperliquid/order', 'POST')).toBe('write');
  });
  it('classifies a venue detail path as public-detail', () => {
    expect(classifyFamily('/markets/hyperliquid/BTC', 'GET')).toBe('public-detail');
  });
  it('keeps all-mids as public-catalog, not public-detail', () => {
    expect(classifyFamily('/markets/hyperliquid/all-mids', 'GET')).toBe('public-catalog');
  });
});

describe('load-harness: cohort mix + gate evaluation', () => {
  it('pickCohort respects weight ordering at the boundaries', () => {
    expect(pickCohort(DEFAULT_COHORT_WEIGHTS, () => 0)).toBe(Object.keys(DEFAULT_COHORT_WEIGHTS)[0]);
    expect(pickCohort(DEFAULT_COHORT_WEIGHTS, () => 0.999999)).toBe('write-cohort');
  });

  it('foldOutWriteCohort zeroes write-cohort and preserves total weight', () => {
    const folded = foldOutWriteCohort(DEFAULT_COHORT_WEIGHTS);
    expect(folded['write-cohort']).toBe(0);
    const totalBefore = Object.values(DEFAULT_COHORT_WEIGHTS).reduce((a, b) => a + b, 0);
    const totalAfter = Object.values(folded).reduce((a, b) => a + b, 0);
    expect(totalAfter).toBe(totalBefore);
  });

  it('resolveMix rejects an unknown cohort name', () => {
    expect(() => resolveMix('not-a-real-cohort=10')).toThrow(/unknown cohort/);
  });

  it('evaluateGates PASSes a clean artifact', () => {
    const artifact = {
      durationSeconds: 120,
      http: {
        overall: { errorRatePct: 0 },
        edge: { count: 10, p95: 50 },
        originMiss: { count: 10, p95: 100 },
        byFamily: { authed: { count: 10, p95: 100 } },
      },
      websocket: {
        connections: 5, readyRatePct: 100, readyP95Ms: 50,
        eventsReceived: 10, eventLagP95Ms: 20, eventLagP99Ms: 30,
        unplannedDisconnectsPerHour: 0,
      },
      correctness: { crossUserPrivateEvents: 0, idempotencyReplayMismatches: 0 },
    };
    expect(evaluateGates(artifact, GATES)).toEqual({ result: 'PASS', failures: [] });
  });

  it('evaluateGates FAILs on a cross-user private-event leak regardless of everything else', () => {
    const artifact = {
      durationSeconds: 120,
      http: { overall: { errorRatePct: 0 }, edge: { count: 0 }, originMiss: { count: 0 }, byFamily: {} },
      websocket: { connections: 1, readyRatePct: 100, readyP95Ms: 1, eventsReceived: 0, unplannedDisconnectsPerHour: 0 },
      correctness: { crossUserPrivateEvents: 1, idempotencyReplayMismatches: 0 },
    };
    const { result, failures } = evaluateGates(artifact, GATES);
    expect(result).toBe('FAIL');
    expect(failures.some((f) => f.includes('cross_user_private_event'))).toBe(true);
  });

  it('skips the disconnects-per-hour gate below the minimum-duration floor (short-run rate amplification)', () => {
    expect(MIN_DURATION_FOR_DISCONNECT_RATE_GATE_SECONDS).toBeGreaterThan(0);
    const base = {
      http: { overall: { errorRatePct: 0 }, edge: { count: 0 }, originMiss: { count: 0 }, byFamily: {} },
      websocket: { connections: 1, readyRatePct: 100, readyP95Ms: 1, eventsReceived: 0, unplannedDisconnectsPerHour: 999 },
      correctness: { crossUserPrivateEvents: 0, idempotencyReplayMismatches: 0 },
    };
    const shortRun = { ...base, durationSeconds: MIN_DURATION_FOR_DISCONNECT_RATE_GATE_SECONDS - 1 };
    expect(evaluateGates(shortRun, GATES).result).toBe('PASS');

    const longRun = { ...base, durationSeconds: MIN_DURATION_FOR_DISCONNECT_RATE_GATE_SECONDS };
    expect(evaluateGates(longRun, GATES).result).toBe('FAIL');
  });
});

describe('load-harness: percentile math', () => {
  it('computes nearest-rank percentiles over a known sample', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(samples, 50)).toBe(60);
    expect(percentile(samples, 95)).toBe(100);
  });
  it('summarizeLatencies handles an empty sample set without throwing', () => {
    expect(summarizeLatencies([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0 });
  });
});

describe('load-harness: CLI arg parsing', () => {
  it('requires --tokens-file outside --self-test', () => {
    expect(() => parseArgs(['--base', 'https://staging.example/api'], {})).toThrow(UsageError);
  });
  it('does not require --tokens-file when --self-test is set', () => {
    expect(() => parseArgs(['--self-test'], {})).not.toThrow();
  });
  it('rejects an out-of-range --gate', () => {
    expect(() => parseArgs(['--gate', '9', '--tokens-file', 'x'], {})).toThrow(UsageError);
  });
});

describe('load-harness: end-to-end self-test subprocess', () => {
  it('runs the full pipeline against the local stub and produces a PASS artifact', () => {
    const res = spawnSync(process.execPath, [runScript, '--self-test'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 45_000,
    });

    if (res.error || res.status !== 0) {
      console.error('SPAWN ERROR:', res.error);
      console.error('STDOUT:', res.stdout);
      console.error('STDERR:', res.stderr);
    }
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);

    const lines = res.stdout.trim().split('\n').filter(Boolean);
    const artifact = JSON.parse(lines[lines.length - 1]);

    expect(artifact.result).toBe('PASS');
    expect(artifact.failures).toEqual([]);
    expect(artifact.users).toBe(5);
    expect(artifact.database).toBeNull();
    expect(artifact.redis).toBeNull();
    expect(artifact.workers).toBeNull();
    expect(artifact).toHaveProperty('neoSha');
    expect(artifact).toHaveProperty('nexaSha');
    expect(artifact).toHaveProperty('gatesApplied');

    expect(artifact.http.overall.count).toBeGreaterThan(0);
    expect(artifact.http.overall.errorRatePct).toBe(0);

    // 4 of the 5 self-test cohorts carry a WS policy (all but portfolio-only).
    expect(artifact.websocket.connections).toBeGreaterThan(0);
    expect(artifact.websocket.ready).toBe(artifact.websocket.connections);

    // The correctness invariants this whole harness exists to police.
    expect(artifact.correctness.crossUserPrivateEvents).toBe(0);
    expect(artifact.correctness.idempotencyReplaysAttempted).toBeGreaterThan(0);
    expect(artifact.correctness.idempotencyReplayMismatches).toBe(0);
  }, 50_000);
});

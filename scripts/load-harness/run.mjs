#!/usr/bin/env node
/**
 * run.mjs — 1,000-distinct-user load-certification harness.
 *
 * Fixes audit blocker #11: scripts/load-gate.mjs simulates fleet load
 * with 30 HTTP VUs and ONE authenticated token. Certification requires
 * N DISTINCT authenticated users with realistic cohorts. This harness
 * refuses to start without enough distinct tokens (lib/identity-pool.mjs)
 * and models five weighted traffic cohorts (lib/cohorts.mjs) instead of
 * hammering one hot path.
 *
 * Dependency-free — Node 22 global fetch + WebSocket, same convention as
 * scripts/load-gate.mjs (which stays in place as a fast prod-safe smoke
 * gate; this harness is the certification-grade replacement for staged
 * ramp/soak runs against staging).
 *
 * Usage: see README.md. Quick reference:
 *   node scripts/load-harness/run.mjs --self-test
 *   node scripts/load-harness/run.mjs --base https://staging.example/api \
 *     --tokens-file ./tokens.txt --gate 1
 *
 * Exit codes: 0 = gate PASS, 1 = gate FAIL (or self-test pipeline broke),
 * 2 = usage/validation/safety refusal (bad args, insufficient distinct
 * tokens, write-cohort safety refusal).
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { parseArgs, UsageError } from './lib/args.mjs';
import { loadTokenPool, assignIdentities, IdentityPoolError } from './lib/identity-pool.mjs';
import {
  DEFAULT_COHORT_WEIGHTS, resolveMix, foldOutWriteCohort, pickCohort,
  COHORT_READS, COHORT_WS_POLICY, resolveDynamicRead,
  ROUTE_SWITCH_MIN_MS, ROUTE_SWITCH_MAX_MS, PORTFOLIO_POLL_INTERVAL_MS,
  BACKGROUND_RESUME_FRACTION, FLAKY_RECONNECT_FRACTION,
} from './lib/cohorts.mjs';
import { timedRequest } from './lib/http-client.mjs';
import { assertWriteSafety, WriteSafetyError, buildSandboxOrderBody, buildIdempotencyKey } from './lib/writes.mjs';
import { runVuLifecycle, createWsStatsAccumulator, summarizeWsStats } from './lib/ws-client.mjs';
import { summarizeHttpFamily, summarizeLatencies, buildArtifact } from './lib/metrics.mjs';
import { startStubServer } from './lib/stub-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

function log(obj) { console.log(JSON.stringify(obj)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }

function gitShaSafe(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function countMigrationsSafe() {
  try {
    const dir = join(repoRoot, 'apps', 'api', 'src', 'db', 'migrations');
    return readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
  } catch {
    return null;
  }
}

function newHttpStats() {
  return { overallLat: [], overallErrors: 0, overallTotal: 0, byFamily: {}, edgeLat: [], originMissLat: [] };
}

function recordHttp(httpStats, result) {
  httpStats.overallLat.push(result.ms);
  httpStats.overallTotal += 1;
  if (!result.ok) httpStats.overallErrors += 1;
  const fam = httpStats.byFamily[result.family] ?? (httpStats.byFamily[result.family] = { lat: [], errors: 0 });
  fam.lat.push(result.ms);
  if (!result.ok) fam.errors += 1;
  if (result.family === 'public-catalog' || result.family === 'public-detail') {
    if (result.cfCacheHit) httpStats.edgeLat.push(result.ms);
    else httpStats.originMissLat.push(result.ms);
  }
}

function summarizeHttp(httpStats, durationSeconds) {
  return {
    overall: { ...summarizeHttpFamily(httpStats.overallLat, httpStats.overallErrors), rps: durationSeconds ? +(httpStats.overallTotal / durationSeconds).toFixed(2) : 0 },
    byFamily: Object.fromEntries(Object.entries(httpStats.byFamily).map(([k, v]) => [k, summarizeHttpFamily(v.lat, v.errors)])),
    edge: summarizeLatencies(httpStats.edgeLat),
    originMiss: summarizeLatencies(httpStats.originMissLat),
  };
}

/** Best-effort public-catalog sample so markets-browser/predictions VUs
 * hit realistic detail routes/topics instead of only the static list
 * endpoints. Never throws — an empty catalog just means cohorts.mjs
 * falls back to FALLBACK_HL_COINS and skips PM detail sampling. */
async function warmCatalog(base) {
  const catalog = { hlCoins: [], pmIds: [] };
  try {
    const hl = await timedRequest(base, '/markets/hyperliquid');
    const coins = (hl.bodyJson?.markets ?? []).map((m) => m?.coin).filter((c) => typeof c === 'string' && c);
    if (coins.length) catalog.hlCoins = [...new Set(coins)];
  } catch { /* fallback list covers this */ }
  try {
    const pm = await timedRequest(base, '/markets/polymarket?view=compact&limit=40');
    const ids = (pm.bodyJson?.markets ?? []).map((m) => m?.id).filter((id) => typeof id === 'string' && id);
    if (ids.length) catalog.pmIds = [...new Set(ids)];
  } catch { /* predictions cohort degrades to public-catalog-only reads */ }
  return catalog;
}

async function bootstrapVu(base, token, httpStats) {
  const result = await timedRequest(base, '/me/profile', { headers: { authorization: `Bearer ${token}` } });
  recordHttp(httpStats, result);
  const userId = result.bodyJson?.user?.id;
  return typeof userId === 'string' && userId ? userId : `unresolved:${token.slice(0, 8)}`;
}

/** One write-cohort action: place a capped sandbox order, then
 * deliberately replay the SAME idempotency key + body and assert the
 * server returns the identical original response — the "duplicate
 * idempotent write responses" correctness probe (spec point 4). */
async function doSandboxWrite({ base, token, userId, catalog, httpStats, correctness }) {
  const body = buildSandboxOrderBody(Math.random, catalog);
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': buildIdempotencyKey(userId) };
  const first = await timedRequest(base, '/markets/hyperliquid/order', { method: 'POST', headers, body });
  recordHttp(httpStats, first);
  correctness.idempotencyReplaysAttempted += 1;
  const replay = await timedRequest(base, '/markets/hyperliquid/order', { method: 'POST', headers, body });
  recordHttp(httpStats, replay);
  const bothOk = first.ok && replay.ok;
  // A below-minimum-notional rejection (422 on a live-trading target) is
  // an expected, non-fatal outcome for a $1-$10 sandbox order as long as
  // BOTH calls are rejected identically — that's still a correct replay.
  const bothRejectedSameWay = !first.ok && !replay.ok && first.status === replay.status;
  // Real API shape (routes/markets.ts): { order: { orderId, ... } } — a replay
  // must return the SAME orderId (fresh path echoes the venue ref, replay path
  // echoes position.externalRef). `order.id` does not exist on the wire.
  const idsMatch = first.bodyJson?.order?.orderId && first.bodyJson.order.orderId === replay.bodyJson?.order?.orderId;
  if (!(bothRejectedSameWay || (bothOk && idsMatch))) {
    correctness.idempotencyReplayMismatches += 1;
  }
}

async function httpVuLoop({ base, token, userId, cohortName, catalog, deadlineMs, httpStats, writesEnabled, correctness }) {
  const reads = COHORT_READS[cohortName] ?? [];
  const isPortfolioOnly = cohortName === 'portfolio-only';
  while (Date.now() < deadlineMs) {
    if (reads.length) {
      const entry = reads[Math.floor(Math.random() * reads.length)];
      const path = typeof entry === 'string' ? entry : (resolveDynamicRead(entry, catalog, Math.random) ?? '/markets/hyperliquid');
      // eslint-disable-next-line no-await-in-loop -- one VU's own request cadence is inherently serial
      const result = await timedRequest(base, path, { headers: { authorization: `Bearer ${token}` } });
      recordHttp(httpStats, result);
    }
    if (cohortName === 'write-cohort' && writesEnabled) {
      // eslint-disable-next-line no-await-in-loop
      await doSandboxWrite({ base, token, userId, catalog, httpStats, correctness });
    }
    if (Date.now() >= deadlineMs) break;
    const gapMs = isPortfolioOnly
      ? PORTFOLIO_POLL_INTERVAL_MS
      : ROUTE_SWITCH_MIN_MS + Math.random() * (ROUTE_SWITCH_MAX_MS - ROUTE_SWITCH_MIN_MS);
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(gapMs, Math.max(0, deadlineMs - Date.now())));
  }
}

async function driveVu({ base, token, cohortName, behaviorClass, catalog, deadlineMs, httpStats, wsStats, writesEnabled, correctness }) {
  const userId = await bootstrapVu(base, token, httpStats);
  const tasks = [httpVuLoop({ base, token, userId, cohortName, catalog, deadlineMs, httpStats, writesEnabled, correctness })];
  if (COHORT_WS_POLICY[cohortName]) {
    tasks.push(runVuLifecycle({ base, token, userId, cohortName, catalog, deadlineMs, behaviorClass, stats: wsStats }));
  }
  await Promise.all(tasks);
}

function assignBehaviorClass(rng) {
  const r = rng();
  if (r < FLAKY_RECONNECT_FRACTION) return 'flaky';
  if (r < FLAKY_RECONNECT_FRACTION + BACKGROUND_RESUME_FRACTION) return 'background';
  return 'normal';
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) { console.error(`USAGE ERROR: ${e.message}`); process.exit(2); return; }
    throw e;
  }

  let stub = null;
  let tempDir = null;
  const cleanup = async () => {
    if (stub) await stub.close().catch(() => {});
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    let base = args.base;
    let users = args.users;
    let durationSeconds = args.durationSeconds;
    let mix = resolveMix(args.mix);
    let enableWrites = args.enableWrites;
    let writeAllowlist = args.writeAllowlist;
    let identities;
    let forcedAssignment = null; // self-test: deterministic cohort/behavior coverage

    if (args.selfTest) {
      log({ selfTest: true, note: 'spawning local stub server — self-test ignores --base/--tokens-file/--users/--duration/--gate/--mix and forces --enable-writes against the stub only' });
      stub = await startStubServer();
      base = stub.url;
      users = 5;
      durationSeconds = 8;
      mix = { ...DEFAULT_COHORT_WEIGHTS };
      enableWrites = true;
      writeAllowlist = [new URL(stub.url).host];

      tempDir = mkdtempSync(join(tmpdir(), 'nexa-load-harness-selftest-'));
      const tokens = Array.from({ length: users }, (_, i) => `st-user-${i}`);
      const tokensFile = join(tempDir, 'tokens.txt');
      writeFileSync(tokensFile, tokens.join('\n'), 'utf8');
      identities = assignIdentities(loadTokenPool(tokensFile), users);

      const cohortNames = Object.keys(DEFAULT_COHORT_WEIGHTS);
      forcedAssignment = identities.map((token, i) => ({
        token,
        cohortName: cohortNames[i % cohortNames.length],
        // Deterministic non-'normal' coverage so background/flaky code
        // paths execute every self-test run instead of ~1-in-20 by luck.
        behaviorClass: i === cohortNames.length - 2 ? 'background' : i === cohortNames.length - 1 ? 'flaky' : 'normal',
      }));
    } else {
      let tokens;
      try {
        tokens = loadTokenPool(args.tokensFile);
      } catch (e) {
        console.error(`USAGE ERROR: could not read --tokens-file "${args.tokensFile}": ${e.message}`);
        process.exit(2); return;
      }
      try {
        identities = assignIdentities(tokens, users);
      } catch (e) {
        if (e instanceof IdentityPoolError) { console.error(`REFUSED: ${e.message}`); process.exit(2); return; }
        throw e;
      }
    }

    if (!enableWrites) {
      mix = foldOutWriteCohort(mix);
    } else {
      try {
        assertWriteSafety({ baseUrl: base, enableWrites, writeAllowlist });
      } catch (e) {
        if (e instanceof WriteSafetyError) { console.error(`REFUSED: ${e.message}`); process.exit(2); return; }
        throw e;
      }
    }

    log({ base, users, durationSeconds, gate: args.gateLabel ?? args.gate, mix, writesEnabled: enableWrites });

    const catalog = await warmCatalog(base);
    log({ catalogWarmed: true, hlCoins: catalog.hlCoins.length, pmIds: catalog.pmIds.length });

    const assignments = forcedAssignment ?? identities.map((token) => ({
      token,
      cohortName: pickCohort(mix, Math.random),
      behaviorClass: assignBehaviorClass(Math.random),
    }));

    const httpStats = newHttpStats();
    const wsStats = createWsStatsAccumulator();
    const correctness = { idempotencyReplaysAttempted: 0, idempotencyReplayMismatches: 0 };

    const startedAt = Date.now();
    const deadlineMs = startedAt + durationSeconds * 1000;
    await Promise.all(assignments.map(({ token, cohortName, behaviorClass }) => driveVu({
      base, token, cohortName, behaviorClass, catalog, deadlineMs, httpStats, wsStats, writesEnabled: enableWrites, correctness,
    })));
    const actualDurationSeconds = +((Date.now() - startedAt) / 1000).toFixed(1);

    const artifact = buildArtifact({
      neoSha: args.neoSha ?? gitShaSafe(join(repoRoot, '..', 'neo')),
      nexaSha: args.nexaSha ?? gitShaSafe(repoRoot),
      databaseMigrationCount: args.migrationCount ?? countMigrationsSafe(),
      apiReplicas: args.apiReplicas,
      schedulerReplicas: args.schedulerReplicas,
      users: identities.length,
      durationSeconds: actualDurationSeconds,
      http: summarizeHttp(httpStats, actualDurationSeconds),
      websocket: summarizeWsStats(wsStats, actualDurationSeconds),
      correctness: {
        crossUserPrivateEvents: wsStats.crossUserPrivateEvents,
        crossUserPrivateEventSamples: wsStats.crossUserSamples,
        idempotencyReplaysAttempted: correctness.idempotencyReplaysAttempted,
        idempotencyReplayMismatches: correctness.idempotencyReplayMismatches,
      },
      gates: args.gates,
    });

    const outPath = args.out
      ? resolve(args.out)
      : args.selfTest
        ? join(tempDir, 'artifact.json')
        : join(repoRoot, 'load-results', `${new Date().toISOString().replace(/[:.]/g, '-')}-gate${args.gate}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

    log({ ...artifact, outPath });
    await cleanup();
    process.exit(artifact.result === 'PASS' ? 0 : 1);
  } catch (e) {
    console.error(JSON.stringify({ fatal: true, error: String(e?.stack ?? e) }));
    await cleanup();
    process.exit(1);
  }
}

await main();

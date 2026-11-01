/**
 * bench-hub.mjs — diagnostic load benchmark for the realtime SSE hub.
 *
 * Goal: get repeatable numbers for concurrent client capacity, per-tick
 * fan-out lag (p50/p99), drop rate, RSS growth, and CPU usage. Drives the
 * Hono app in-process via `app.request()` so there's no real socket — the
 * limiting factor is the hub fan-out path + the SSE writer, which is what
 * we want to measure.
 *
 * Invoke (REALTIME_HUB_V1 must be set for the SSE route to be mounted):
 *
 *   pnpm --filter @nexa/api exec tsx scripts/bench-hub.mjs
 *
 * or directly from apps/api:
 *
 *   REALTIME_HUB_V1=1 BENCH_N=1000 BENCH_TICK_HZ=20 BENCH_DURATION_SEC=60 \
 *     tsx scripts/bench-hub.mjs
 *
 * Knobs (env):
 *   BENCH_N=1000            number of concurrent SSE clients
 *   BENCH_TICK_HZ=20        publishes per second from the simulated upstream
 *   BENCH_DURATION_SEC=60   how long the publish loop runs
 *   BENCH_TOPIC=ticker:hl:BTC  single shared topic — perfect fan-out test
 *   BENCH_RAMP_MS=50        delay between client connects (avoids thundering herd)
 *   BENCH_EMAIL=bench@example.com
 *
 * Notes:
 *   - Ticker events flow through the Hub's 100ms coalescer. At BENCH_TICK_HZ
 *     above ~10 some ticks will be merged before fan-out — that's expected
 *     and the "drop rate" output accounts for it (see CoalesceMerged stat).
 *     To measure raw fan-out without coalesce, set BENCH_TOPIC=candle:hl:BTC:1m
 *     and the script will emit candle events instead (no coalesce path).
 *   - We use `app.request()` (Hono's in-memory dispatcher) — there's no real
 *     TCP socket and no node:http buffer. This isolates hub/SSE-writer cost
 *     from kernel networking and gives a clean upper bound for one process.
 */

import process from 'node:process';

// REALTIME_HUB_V1 must be set BEFORE the env validator runs (top-level in env.ts).
// Default it on for the bench so the operator doesn't need to remember.
process.env.REALTIME_HUB_V1 = process.env.REALTIME_HUB_V1 ?? '1';
// Silence pino so the SSE response noise doesn't drown the summary.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
// Force in-memory store + rate limit off so 1k clients aren't rate-limited
// to oblivion and we don't depend on Postgres/Redis being up.
process.env.RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED ?? 'false';
process.env.DEMO_MODE = process.env.DEMO_MODE ?? 'true';

const N = Number(process.env.BENCH_N ?? '1000');
const TICK_HZ = Number(process.env.BENCH_TICK_HZ ?? '20');
const DURATION_SEC = Number(process.env.BENCH_DURATION_SEC ?? '60');
const TOPIC = process.env.BENCH_TOPIC ?? 'ticker:hl:BTC';
const RAMP_MS = Number(process.env.BENCH_RAMP_MS ?? '5');
const EMAIL = process.env.BENCH_EMAIL ?? `bench-${Date.now()}@example.com`;

const isTicker = TOPIC.startsWith('ticker:');

console.log('bench-hub.mjs — realtime hub load benchmark');
console.log({ N, TICK_HZ, DURATION_SEC, TOPIC, RAMP_MS, isTicker });
console.log('booting app...');

// Note: tsx resolves the .ts import. The `app` is exported but `serve()` is
// gated on !process.env.VITEST — set VITEST so the listen() call is skipped.
process.env.VITEST = process.env.VITEST ?? '1';

const { app } = await import('../src/index.ts');
const registry = await import('../src/realtime/registry.ts');

// Pre-warm the hub so adapter wiring doesn't show up in lag samples.
const hub = await registry.ensureStarted();
console.log('hub started, adapters:', hub.listAdapters().map((a) => a.venue).join(','));

/* ── auth: mint a session via the demo OTP flow ────────────────────────────── */

async function mintToken() {
  const start = await app.request('/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });
  if (start.status !== 200) throw new Error(`/auth/start: ${start.status}`);
  const { challengeId } = await start.json();

  const verify = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: '482019' }),
  });
  if (verify.status !== 200) throw new Error(`/auth/verify: ${verify.status}`);
  const { token } = await verify.json();
  return token;
}

const token = await mintToken();
console.log('auth token minted');

/* ── client harness ────────────────────────────────────────────────────────── */

// Track delivered counts + per-tick latency. Each published event carries an
// id `bench_ts` (the wall time at publish); when a client parses it, we compute
// `now - bench_ts` and add to the histogram.
//
// Histogram uses fixed buckets (ms). For a 60s run with 1k clients × 20Hz we'd
// see up to 1.2M samples — keep it cheap, just bump bucket counts.
const BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const bucketCounts = new Array(BUCKETS_MS.length + 1).fill(0);
let totalDelivered = 0;
let totalLagMs = 0;
let maxLagMs = 0;

function recordLag(ms) {
  totalDelivered++;
  totalLagMs += ms;
  if (ms > maxLagMs) maxLagMs = ms;
  let i = 0;
  while (i < BUCKETS_MS.length && ms > BUCKETS_MS[i]) i++;
  bucketCounts[i]++;
}

function percentile(p) {
  const target = totalDelivered * p;
  let cum = 0;
  for (let i = 0; i < bucketCounts.length; i++) {
    cum += bucketCounts[i];
    if (cum >= target) return i < BUCKETS_MS.length ? BUCKETS_MS[i] : BUCKETS_MS[BUCKETS_MS.length - 1] * 2;
  }
  return -1;
}

/**
 * Connect one SSE client. Returns a handle with an abort controller + a
 * background promise that drains the response body, parses SSE frames, and
 * calls recordLag() for every tick/candle frame carrying our bench_ts.
 */
async function connectClient(idx) {
  const controller = new AbortController();
  const url = `/v1/stream/sse?topics=${encodeURIComponent(TOPIC)}`;
  const res = await app.request(url, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new Error(`client ${idx}: SSE status ${res.status}`);
  }
  if (!res.body) {
    throw new Error(`client ${idx}: no body`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ready = false;
  let resolveReady;
  const readyPromise = new Promise((r) => {
    resolveReady = r;
  });

  const targetEvent = isTicker ? 'tick' : 'candle';

  const drain = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx2;
        while ((idx2 = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx2);
          buf = buf.slice(idx2 + 2);
          const lines = frame.split('\n');
          let evt = 'message';
          let data = '';
          for (const ln of lines) {
            if (ln.startsWith('event: ')) evt = ln.slice(7);
            else if (ln.startsWith('data: ')) data = ln.slice(6);
          }
          if (evt === 'ready' && !ready) {
            ready = true;
            resolveReady();
            continue;
          }
          if (evt === targetEvent && data) {
            // Parse minimally — we only need `bench_ts`. Avoid full JSON.parse
            // when possible by string-scanning, but JSON.parse on a small
            // 200-byte payload is fast enough; keep it simple.
            try {
              const parsed = JSON.parse(data);
              const bts = parsed.bench_ts;
              if (typeof bts === 'number') {
                recordLag(Date.now() - bts);
              }
            } catch {
              // ignore malformed
            }
          }
        }
      }
    } catch {
      // expected on abort
    }
  })();

  await readyPromise;
  return { controller, drain };
}

/* ── ramp up clients ───────────────────────────────────────────────────────── */

console.log(`connecting ${N} clients (ramp ${RAMP_MS}ms between)...`);
const rssStart = process.memoryUsage().rss;
const cpuStart = process.cpuUsage();
const t0 = Date.now();

const clients = [];
let connectFailures = 0;
for (let i = 0; i < N; i++) {
  try {
    const c = await connectClient(i);
    clients.push(c);
  } catch (err) {
    connectFailures++;
    if (connectFailures < 5) console.error(`connect failed ${i}:`, err.message);
  }
  if (RAMP_MS > 0 && i < N - 1) {
    await new Promise((r) => setTimeout(r, RAMP_MS));
  }
  if ((i + 1) % 100 === 0) {
    const rss = process.memoryUsage().rss;
    console.log(`  connected ${i + 1}/${N}  rss=${(rss / 1024 / 1024).toFixed(1)}MB`);
  }
}
const connectedAt = Date.now();
console.log(`all clients connected (${clients.length}/${N}) in ${connectedAt - t0}ms`);
console.log(`hub.activeTopicCount=${hub.activeTopicCount()}  refCount(${TOPIC})=${hub.refCountFor(TOPIC)}`);

/* ── publish loop ──────────────────────────────────────────────────────────── */

console.log(`publishing at ${TICK_HZ}Hz for ${DURATION_SEC}s...`);
const periodMs = 1000 / TICK_HZ;
let published = 0;
const rssSamples = [{ t: 0, rss: rssStart }];
const rssTimer = setInterval(() => {
  rssSamples.push({ t: Date.now() - connectedAt, rss: process.memoryUsage().rss });
}, 5000);

const publishStart = Date.now();
const publishEndTarget = publishStart + DURATION_SEC * 1000;
let nextFireAt = publishStart;

while (Date.now() < publishEndTarget) {
  const benchTs = Date.now();
  if (isTicker) {
    hub.publish({
      t: 'tick',
      topic: TOPIC,
      px: 50000 + Math.random() * 1000,
      ts: benchTs,
      lastTickAgeMs: 0,
      src: 'hl',
      bench_ts: benchTs,
    });
  } else {
    hub.publish({
      t: 'candle',
      topic: TOPIC,
      ts: benchTs,
      lastTickAgeMs: 0,
      src: 'hl',
      o: 50000, h: 50100, l: 49900, c: 50000, v: 1,
      closed: false,
      bench_ts: benchTs,
    });
  }
  published++;
  nextFireAt += periodMs;
  const sleep = nextFireAt - Date.now();
  if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
}
const publishEnd = Date.now();
clearInterval(rssTimer);

// Coalescer flushes every 100ms; give it + the SSE writers a moment so the
// final batch of frames lands before we tear down.
console.log('publish loop done; draining for 1500ms...');
await new Promise((r) => setTimeout(r, 1500));

const rssEnd = process.memoryUsage().rss;
const cpuEnd = process.cpuUsage(cpuStart);

/* ── tear down ─────────────────────────────────────────────────────────────── */

for (const c of clients) c.controller.abort();
// Race the drain promises against a 2s timeout — Hono's in-memory app.request()
// doesn't propagate AbortSignal into the SSE response stream cleanly, so the
// readers never see `done` and these promises would hang the report forever.
// The publish + delivery counters are already final by this point; we don't
// lose data by skipping a clean drain.
await Promise.race([
  Promise.allSettled(clients.map((c) => c.drain)),
  new Promise((r) => setTimeout(r, 2000)),
]);

/* ── report ────────────────────────────────────────────────────────────────── */

const connected = clients.length;
const ticksPublished = published;
// For tickers, the 100ms coalescer caps delivered events to ~10/sec per topic
// regardless of TICK_HZ — that's not a "drop", it's a feature. Report the
// effective fan-out so the operator sees raw vs post-coalesce.
const effectivePerClient = isTicker
  ? Math.min(ticksPublished, Math.ceil(DURATION_SEC * 10))
  : ticksPublished;
const expectedDelivered = effectivePerClient * connected;
const dropRate = expectedDelivered === 0 ? 0 : (expectedDelivered - totalDelivered) / expectedDelivered;
const meanLag = totalDelivered > 0 ? totalLagMs / totalDelivered : 0;
const p50 = percentile(0.5);
const p99 = percentile(0.99);
const cpuUserSec = cpuEnd.user / 1e6;
const cpuSysSec = cpuEnd.system / 1e6;

const fmtMB = (b) => (b / 1024 / 1024).toFixed(1);

console.log('\n──────────────────────────────────────────────────────────────');
console.log('  bench-hub.mjs results');
console.log('──────────────────────────────────────────────────────────────');
console.log(`  Topic:                  ${TOPIC} (${isTicker ? 'coalesced @ 100ms' : 'direct'})`);
console.log(`  Clients requested:      ${N}`);
console.log(`  Clients connected:      ${connected}`);
console.log(`  Connect failures:       ${connectFailures}`);
console.log(`  Connect time:           ${connectedAt - t0}ms (ramp ${RAMP_MS}ms)`);
console.log(`  Publish duration:       ${((publishEnd - publishStart) / 1000).toFixed(2)}s`);
console.log(`  Ticks published:        ${ticksPublished}`);
console.log(`  Per-client expected:    ${effectivePerClient}${isTicker ? ' (post-coalesce cap)' : ''}`);
console.log(`  Total expected:         ${expectedDelivered}`);
console.log(`  Total delivered:        ${totalDelivered}`);
console.log(`  Drop rate:              ${(dropRate * 100).toFixed(3)}%`);
console.log(`  Lag mean:               ${meanLag.toFixed(2)}ms`);
console.log(`  Lag p50:                ${p50}ms`);
console.log(`  Lag p99:                ${p99}ms`);
console.log(`  Lag max:                ${maxLagMs}ms`);
console.log(`  RSS start:              ${fmtMB(rssStart)}MB`);
console.log(`  RSS end:                ${fmtMB(rssEnd)}MB`);
console.log(`  RSS growth:             ${fmtMB(rssEnd - rssStart)}MB`);
console.log(`  RSS per client (avg):   ${connected > 0 ? ((rssEnd - rssStart) / connected / 1024).toFixed(2) : 'n/a'}KB`);
console.log(`  CPU user:               ${cpuUserSec.toFixed(2)}s`);
console.log(`  CPU system:             ${cpuSysSec.toFixed(2)}s`);
console.log(`  CPU total/wall:         ${((cpuUserSec + cpuSysSec) / DURATION_SEC * 100).toFixed(1)}%`);
console.log('──────────────────────────────────────────────────────────────');
console.log('  Lag histogram:');
for (let i = 0; i < BUCKETS_MS.length; i++) {
  if (bucketCounts[i] === 0) continue;
  console.log(`    ≤ ${String(BUCKETS_MS[i]).padStart(5)}ms : ${bucketCounts[i]}`);
}
if (bucketCounts[BUCKETS_MS.length] > 0) {
  console.log(`    > ${BUCKETS_MS[BUCKETS_MS.length - 1]}ms : ${bucketCounts[BUCKETS_MS.length]}`);
}
console.log('──────────────────────────────────────────────────────────────');
console.log('  RSS over time (5s samples):');
for (const s of rssSamples) {
  console.log(`    t+${String(Math.round(s.t / 1000)).padStart(3)}s : ${fmtMB(s.rss)}MB`);
}
console.log('──────────────────────────────────────────────────────────────\n');

// Force exit — the realtime ws server + store keep handles open and we don't
// want to wire the full shutdown path for a diagnostic.
process.exit(0);

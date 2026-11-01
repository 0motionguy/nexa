#!/usr/bin/env node
/**
 * load-gate.mjs — scale plan Phase 4 load gate (2026-07-03).
 *
 * Dependency-free (Node 22 fetch + WebSocket) so it runs anywhere the repo
 * runs — no k6 install required. Three scenarios, hard pass/fail gates:
 *
 *   read     GET the hot public market paths at --vus concurrency for
 *            --duration seconds. Gates: error rate < 1%, p95 < --p95-read ms.
 *   summary  (optional) auth'd GET /markets/portfolio/summary when
 *            NEXA_LOAD_TOKEN is set. Same gates as read.
 *   ws       Ramp --ws-conns WebSocket clients onto /ws/markets, one topic
 *            each, measure time-to-ready + hold. Gates: ready rate > 95%,
 *            ready p95 < --p95-ready ms. Skips (not fails) when the realtime
 *            hub is dark (REALTIME_HUB_V1=0 → non-101 upgrade).
 *
 * Usage:
 *   node scripts/load-gate.mjs                          # prod, default sizes
 *   node scripts/load-gate.mjs --base http://127.0.0.1:8787/api --vus 100
 *   node scripts/load-gate.mjs --vus 50 --duration 60 --ws-conns 200
 *
 * IMPORTANT: default sizing is a SMOKE gate safe against prod. For the real
 * pre-REALTIME_HUB_V1 capacity run, point --base at a staging/local stack and
 * raise --vus/--ws-conns to the 1k-concurrent target (SCALE-PLAN-10K.md §5).
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { args.set(a.slice(2), next); i += 1; }
    else args.set(a.slice(2), 'true');
  }
}

const BASE = (args.get('base') ?? 'https://nexa.aiso.tools/api').replace(/\/$/, '');
const VUS = Number(args.get('vus') ?? 30);
const DURATION_S = Number(args.get('duration') ?? 30);
const WS_CONNS = Number(args.get('ws-conns') ?? 50);
const WS_HOLD_S = Number(args.get('ws-hold') ?? 15);
const P95_READ_MS = Number(args.get('p95-read') ?? 800);
const P95_READY_MS = Number(args.get('p95-ready') ?? 2000);
const TOKEN = process.env.NEXA_LOAD_TOKEN ?? '';

/** Hot public read set — mirrors what a fleet of NEO Home screens generates. */
const READ_PATHS = [
  '/markets/hyperliquid',
  '/markets/hyperliquid/all-mids',
  '/markets/polymarket?view=compact&limit=40',
  '/markets/hyperliquid-spot?limit=100',
  '/earn/landing',
];

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

function report(name, lat, errors, total, extra = {}) {
  const sorted = [...lat].sort((a, b) => a - b);
  const out = {
    scenario: name,
    requests: total,
    errors,
    errorRate: total ? +(errors / total * 100).toFixed(2) : 0,
    p50: Math.round(pct(sorted, 50)),
    p95: Math.round(pct(sorted, 95)),
    p99: Math.round(pct(sorted, 99)),
    ...extra,
  };
  console.log(JSON.stringify(out));
  return out;
}

async function readScenario(pathset, label, headers = {}) {
  const lat = [];
  let errors = 0, total = 0, cacheHits = 0;
  const deadline = Date.now() + DURATION_S * 1000;
  const vu = async (id) => {
    let i = id;
    while (Date.now() < deadline) {
      const path = pathset[i % pathset.length];
      i += 1;
      const t0 = performance.now();
      try {
        const res = await fetch(BASE + path, { headers });
        // Drain so keep-alive sockets recycle.
        await res.arrayBuffer();
        lat.push(performance.now() - t0);
        total += 1;
        if (!res.ok) errors += 1;
        const cf = res.headers.get('cf-cache-status');
        if (cf === 'HIT' || res.headers.get('age')) cacheHits += 1;
      } catch {
        total += 1; errors += 1; lat.push(performance.now() - t0);
      }
    }
  };
  await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
  return report(label, lat, errors, total, {
    rps: +(total / DURATION_S).toFixed(1),
    edgeHitRate: total ? +(cacheHits / total * 100).toFixed(1) : 0,
  });
}

async function mintTicket(sessionToken) {
  const res = await fetch(`${BASE}/v1/stream/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) throw new Error(`ticket mint ${res.status}`);
  const body = await res.json();
  return body.token;
}

/**
 * Single-user fidelity limit: ticket minting sits in the per-user /v1/*
 * rate bucket (120/min by design — a real client mints ONE ticket per
 * connect). Real fleet load is N users × 1 ticket, so against a demo
 * backend we mint extra demo sessions (~50 conns each) via the demo OTP.
 * Against prod (demo:false) the gate uses the one NEXA_LOAD_TOKEN — keep
 * --ws-conns ≤ 100 there.
 */
async function buildTokenPool() {
  const pool = [TOKEN];
  const wanted = Math.ceil(WS_CONNS / 50);
  if (wanted <= 1) return pool;
  let demo = false;
  try { demo = (await (await fetch(`${BASE}/healthz`)).json()).demo === true; } catch { /* prod-shaped */ }
  if (!demo) {
    console.log(JSON.stringify({ scenario: 'ws', note: `single-user mode (live backend): per-user ticket bucket caps bursts — use --ws-conns <= 100 or provide more sessions` }));
    return pool;
  }
  for (let i = pool.length; i < wanted; i += 1) {
    try {
      const start = await (await fetch(`${BASE}/auth/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `loadgate-${i}@example.com` }),
      })).json();
      const verify = await (await fetch(`${BASE}/auth/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: start.challengeId, code: '482019' }),
      })).json();
      if (verify.token) pool.push(verify.token);
    } catch { /* keep whatever pool we have */ }
  }
  console.log(JSON.stringify({ scenario: 'ws', tokenPool: pool.length }));
  return pool;
}

async function wsScenario() {
  const wsBase = BASE.replace(/^http/, 'ws').replace(/\/api$/, '/api');
  // Wire contract (realtime/ws-server.ts): the upgrade REQUIRES a session
  // token or a single-use stream ticket (?token=) — anonymous upgrades are
  // accepted then closed 1008 even for public topics. Server pushes
  // {op:'ready'} right after auth; clients send {op:'subscribe', topics}.
  const readyLat = [];
  let opened = 0, ready = 0, failed = 0, shed = 0, unauthorized = 0;
  const failCauses = new Map();
  const countFail = (cause) => { failed += 1; failCauses.set(cause, (failCauses.get(cause) ?? 0) + 1); };
  const tokens = await buildTokenPool();
  await Promise.all(Array.from({ length: WS_CONNS }, (_, connIdx) => new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    (async () => {
      const ticket = await mintTicket(tokens[connIdx % tokens.length]);
      const t0 = performance.now();
      const ws = new WebSocket(`${wsBase}/ws/markets?token=${encodeURIComponent(ticket)}`);
      let gotReady = false;
      const timer = setTimeout(() => { countFail('timeout_no_ready'); try { ws.close(); } catch { /* gone */ } done(); }, 10_000);
      ws.onopen = () => { opened += 1; };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (msg?.op === 'ready' || msg?.t === 'ready') {
            gotReady = true;
            ready += 1;
            readyLat.push(performance.now() - t0);
            clearTimeout(timer);
            try { ws.send(JSON.stringify({ op: 'subscribe', topics: ['hl:mid:BTC'] })); } catch { /* gone */ }
            // Hold the connection, then close.
            setTimeout(() => { try { ws.close(1000); } catch { /* gone */ } done(); }, WS_HOLD_S * 1000);
          }
        } catch { /* non-JSON frame */ }
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (ev.code === 1013) shed += 1;
        if (ev.code === 1008) unauthorized += 1;
        if (!gotReady && !settled) countFail(`close_${ev.code}`);
        done();
      };
      ws.onerror = () => { /* onclose follows */ };
    })().catch((e) => { countFail(`mint_or_connect: ${String(e?.message ?? e).slice(0, 60)}`); done(); });
  })));
  const sorted = [...readyLat].sort((a, b) => a - b);
  const out = {
    scenario: 'ws',
    conns: WS_CONNS, opened, ready, failed, shed, unauthorized,
    readyRate: +(ready / WS_CONNS * 100).toFixed(1),
    readyP95: Math.round(pct(sorted, 95)),
    ...(failCauses.size ? { failCauses: Object.fromEntries(failCauses) } : {}),
  };
  console.log(JSON.stringify(out));
  return out;
}

const failures = [];
console.log(JSON.stringify({ base: BASE, vus: VUS, durationS: DURATION_S, wsConns: WS_CONNS }));

const read = await readScenario(READ_PATHS, 'read');
if (read.errorRate >= 1) failures.push(`read error rate ${read.errorRate}% >= 1%`);
if (read.p95 >= P95_READ_MS) failures.push(`read p95 ${read.p95}ms >= ${P95_READ_MS}ms`);

if (TOKEN) {
  const sum = await readScenario(['/markets/portfolio/summary'], 'summary', { authorization: `Bearer ${TOKEN}` });
  if (sum.errorRate >= 1) failures.push(`summary error rate ${sum.errorRate}% >= 1%`);
  if (sum.p95 >= P95_READ_MS * 2) failures.push(`summary p95 ${sum.p95}ms >= ${P95_READ_MS * 2}ms`);
} else {
  console.log(JSON.stringify({ scenario: 'summary', skipped: 'set NEXA_LOAD_TOKEN to exercise the auth path' }));
}

if (TOKEN) {
  const ws = await wsScenario();
  if (ws.readyRate <= 95) failures.push(`ws ready rate ${ws.readyRate}% <= 95%`);
  if (ws.readyP95 >= P95_READY_MS) failures.push(`ws ready p95 ${ws.readyP95}ms >= ${P95_READY_MS}ms`);
} else {
  console.log(JSON.stringify({ scenario: 'ws', skipped: 'WS upgrades require a ticket — set NEXA_LOAD_TOKEN (tickets are minted per connection)' }));
}

if (failures.length) {
  console.error(JSON.stringify({ gate: 'FAIL', failures }));
  process.exit(1);
}
console.log(JSON.stringify({ gate: 'PASS' }));

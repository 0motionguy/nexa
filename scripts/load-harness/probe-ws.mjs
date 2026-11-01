// probe-ws.mjs — r8 external probe (150s hold).
// r6's probe sampled only 10s and could not see the 60s idle-kill window.
// r7 held 150s but gated on a SINGLE coin's tick gaps — and a direct tap of
// HL mainnet from this host (2026-07-17) showed allMids arrives as ~5s
// coalesced snapshots (0.2/s, not ~20Hz), inside which one coin's mid can
// legitimately hold still >20s (observed: 20.6s BTC no-change tail in 75s).
// Single-coin quiescence is upstream reality, not a stack defect.
//
// r8 therefore gates on a BASKET of majors — any tick from any subscribed
// ticker resets the gap clock; five simultaneously-frozen majors across 20s
// of snapshots is not a plausible healthy state. l2Book (high-frequency) is
// subscribed WITH depth (r7 sent `book:hl:BTC`, which the topic grammar
// rejects — that was the mystery err:1) and gated >0 as a second liveness
// channel. Any err frame now fails the probe outright.
//
// Run (from toolbox): docker run --rm --network host \
//   -v /opt/neobank-staging:/work node:22-alpine node /work/probe-ws.mjs
import { readFileSync } from 'node:fs';

const base = process.env.PROBE_BASE || 'http://127.0.0.1:18090';
const holdMs = Number(process.env.PROBE_HOLD_MS || 150_000);
const token = readFileSync('/work/tokens.txt', 'utf8').split('\n')[0].trim();

const TICKERS = ['ticker:hl:BTC', 'ticker:hl:ETH', 'ticker:hl:SOL', 'ticker:hl:AVAX', 'ticker:hl:LINK'];
const TOPICS = [...TICKERS, 'book:hl:BTC:25', 'trades:hl:BTC'];

const res = await fetch(base + '/v1/stream/ticket', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token },
});
const body = await res.json();
const ticket = body?.token;
if (!ticket) { console.error('NO_TICKET', JSON.stringify(body).slice(0, 200)); process.exit(1); }

const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/stream/ws?token=' + encodeURIComponent(ticket));
const t0 = Date.now();
let n = 0;
let ready = false;
let closed = null;
const byKind = {};
const tickByTopic = {};
let lastTickAt = 0;
let maxTickGapMs = 0;
let maxLagMs = 0;
let lagSum = 0;
let lagSamples = 0;

// Keep client->server traffic flowing so no idle-client policy can reap the
// control lane; 1 msg / 25s is far under the inbound rate cap.
const pinger = setInterval(() => {
  try { ws.send(JSON.stringify({ op: 'ping' })); } catch { /* closing */ }
}, 25_000);

ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
  if (m.op === 'ready' || m.t === 'ready') {
    ready = true;
    console.log('READY at', Date.now() - t0, 'ms');
    ws.send(JSON.stringify({ op: 'sub', topics: TOPICS }));
    return;
  }
  n++;
  const k = (m.t ?? m.op ?? 'unknown') + '';
  byKind[k] = (byKind[k] || 0) + 1;
  const now = Date.now();
  if (m.t === 'tick') {
    // Basket clock: ANY subscribed ticker's tick proves the allMids channel
    // end-to-end. Per-topic counts stay visible for single-coin diagnosis.
    if (typeof m.topic === 'string') tickByTopic[m.topic] = (tickByTopic[m.topic] || 0) + 1;
    if (lastTickAt) maxTickGapMs = Math.max(maxTickGapMs, now - lastTickAt);
    lastTickAt = now;
  }
  if (m.t === 'err' || m.op === 'err') {
    console.log('ERR_FRAME', JSON.stringify(m).slice(0, 200));
  }
  if (typeof m.ts === 'number') {
    const lag = now - m.ts;
    if (lag >= 0 && lag < 3_600_000) { maxLagMs = Math.max(maxLagMs, lag); lagSum += lag; lagSamples++; }
  }
};
ws.onclose = (ev) => {
  closed = { code: ev.code, reason: ev.reason || '', at: Date.now() - t0 };
  console.log('CLOSE', ev.code, ev.reason || '', 'at', Date.now() - t0, 'ms');
};

setTimeout(() => {
  clearInterval(pinger);
  const tailTickGapMs = lastTickAt ? Date.now() - lastTickAt : -1;
  const errCount = (byKind.err || 0);
  const bookCount = (byKind.book || 0);
  console.log('SUMMARY', JSON.stringify({
    holdMs, ready, events: n, byKind, tickByTopic,
    maxTickGapMs, tailTickGapMs, errCount, bookCount,
    avgLagMs: lagSamples ? Math.round(lagSum / lagSamples) : null,
    maxLagMs, closed,
  }));
  // Fail: never ready; socket died mid-hold; basket ticker starved (>20s gap
  // anywhere, or silent death near the end of the hold); any rejected sub /
  // server err frame; book channel entirely absent.
  const fail = !ready || closed !== null || n === 0
    || maxTickGapMs > 20_000 || tailTickGapMs > 20_000 || tailTickGapMs < 0
    || errCount > 0 || bookCount === 0;
  console.log(fail ? 'PROBE_FAIL' : 'PROBE_PASS');
  process.exit(fail ? 1 : 0);
}, holdMs);

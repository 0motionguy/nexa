/**
 * HyperliquidRealtimeAdapter — regression coverage for the gate-1 r4
 * zero-tick incident (2026-07-15) on a stubbed global WebSocket. No network.
 *
 * Incident mechanics being pinned here:
 *   1. allMids is ONE shared upstream channel. Pre-fix, every ticker topic
 *      whose refcount hit zero sent a global allMids unsubscribe, killing
 *      tick flow for every still-referenced ticker topic.
 *   2. A constructor failure while no topics were active stranded wsState
 *      at 'reconnecting' with no pending timer — ensureOpen() then treated
 *      the socket as in-flight forever (permanent wedge).
 *   3. lastEventAt advanced on pong/subscriptionResponse heartbeats, so the
 *      stall watchdog stayed quiet while real event channels were dead.
 *
 * Plus the gate-1 r5/r6 flap incident (2026-07-16):
 *   4. No client ping — HL kills any connection with 60s of client-inbound
 *      silence (measured: exact 60.000s open→close cycle).
 *   5. A stale socket's onclose clobbered live state (`this.ws = null` +
 *      reconnect on top of a healthy replacement) — self-sustaining ~1s
 *      open/close metronome once two sockets ever overlapped.
 *   6. The watchdog judged fresh sockets by pre-open silence (stale
 *      lastEventAt) → silent closeSocket ~1s after a healthy open, which
 *      seeded exactly that overlap; and stall recovery relied on incidental
 *      subscribe churn instead of scheduling its own reconnect.
 *
 * The user-stream manager spec (hyperliquid-user.spec.ts) injects WsLike;
 * this adapter constructs the global WebSocket directly, so we stub the
 * global instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HyperliquidRealtimeAdapter } from './venues/hyperliquid.js';
import type { Topic } from './types.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static failCtorTimes = 0;

  readonly OPEN = 1;
  readyState = 0; // CONNECTING
  readonly sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(_url: string) {
    if (FakeWebSocket.failCtorTimes > 0) {
      FakeWebSocket.failCtorTimes -= 1;
      throw new Error('ctor refused (test)');
    }
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Test helper — flip to OPEN and fire onopen (triggers replay). */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Test helper — push one upstream frame through onmessage. */
  frame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

/** Sent frames matching {method, subscription.type}. */
function subs(ws: FakeWebSocket, type: string, method = 'subscribe') {
  return ws.sent.filter(
    (m) => m.method === method && (m.subscription as { type?: string } | undefined)?.type === type,
  );
}

describe('HyperliquidRealtimeAdapter upstream channel management', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.failCtorTimes = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('subscribes allMids once for many ticker topics; unsubscribes only when the LAST releases', () => {
    const a = new HyperliquidRealtimeAdapter();
    a.subscribe('ticker:hl:BTC' as Topic);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    a.subscribe('ticker:hl:ETH' as Topic);
    a.subscribe('ticker:hl:SOL' as Topic);
    expect(subs(ws, 'allMids')).toHaveLength(1);

    // r4 regression: releasing SOME ticker topics must NOT tear down the
    // shared channel while others still hold refs.
    a.unsubscribe('ticker:hl:BTC' as Topic);
    a.unsubscribe('ticker:hl:ETH' as Topic);
    expect(subs(ws, 'allMids', 'unsubscribe')).toHaveLength(0);

    a.unsubscribe('ticker:hl:SOL' as Topic);
    expect(subs(ws, 'allMids', 'unsubscribe')).toHaveLength(1);
  });

  it('replays allMids exactly once on socket open; per-coin channels once each', () => {
    const a = new HyperliquidRealtimeAdapter();
    a.subscribe('ticker:hl:BTC' as Topic);
    a.subscribe('ticker:hl:ETH' as Topic);
    a.subscribe('trades:hl:SOL' as Topic);
    const ws = FakeWebSocket.instances[0];
    // Pre-open sends are dropped by the readyState guard — the onopen replay
    // is the authoritative subscription pass.
    ws.open();
    expect(subs(ws, 'allMids')).toHaveLength(1);
    expect(subs(ws, 'trades')).toHaveLength(1);
  });

  it('recovers after a ctor failure strands the state machine with no active topics', () => {
    vi.useFakeTimers();
    const a = new HyperliquidRealtimeAdapter();
    FakeWebSocket.failCtorTimes = 2;
    a.subscribe('ticker:hl:BTC' as Topic); // ctor throw #1 → reconnect scheduled (refs=1)
    a.unsubscribe('ticker:hl:BTC' as Topic); // refs → 0 while backoff timer pending
    vi.runOnlyPendingTimers(); // reconnect fires → ctor throw #2 with refs=0 → must park CLOSED
    expect(FakeWebSocket.instances).toHaveLength(0);

    // Pre-fix: wsState stuck at 'reconnecting' with no timer — this subscribe
    // would never reopen the socket.
    a.subscribe('ticker:hl:ETH' as Topic);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('ignores pong/ack heartbeats for stall accounting; real event channels count', () => {
    const a = new HyperliquidRealtimeAdapter();
    a.subscribe('ticker:hl:BTC' as Topic);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(a.healthSnapshot().lastEventAgeMs).toBe(-1);

    // r4: upstream kept acking while allMids was dead — heartbeats must not
    // reset the stall clock.
    ws.frame({ channel: 'pong', data: {} });
    ws.frame({ channel: 'subscriptionResponse', data: { ok: true } });
    expect(a.healthSnapshot().lastEventAgeMs).toBe(-1);

    ws.frame({ channel: 'allMids', data: { mids: {} } });
    expect(a.healthSnapshot().lastEventAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('pings every 30s so HL\'s 60s client-inbound idle reaper never fires (r6)', () => {
    vi.useFakeTimers();
    const a = new HyperliquidRealtimeAdapter();
    a.subscribe('ticker:hl:BTC' as Topic);
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const pings = () => ws.sent.filter((m) => m.method === 'ping').length;
    expect(pings()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(pings()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(pings()).toBe(3);
  });

  it('a stale socket close cannot clobber the live socket (r5/r6 flap)', () => {
    vi.useFakeTimers();
    const a = new HyperliquidRealtimeAdapter();
    a.subscribe('ticker:hl:BTC' as Topic);
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();

    ws1.onclose?.({ code: 1006 }); // organic drop → reconnect on 1s backoff
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();

    // The orphan finishes dying AFTER its replacement is live — pre-fix this
    // nulled this.ws and scheduled a reconnect on top of the healthy socket.
    ws1.onclose?.({ code: 1006 });
    expect(a.healthSnapshot().ws).toBe('open');
    vi.advanceTimersByTime(30_000); // no reconnect storm from the orphan
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Live socket still fully wired: frames flow, event clock advances.
    ws2.frame({ channel: 'allMids', data: { mids: { BTC: '1' } } });
    expect(a.healthSnapshot().lastEventAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('stall recovery schedules its own reconnect — no subscribe churn needed (r6)', async () => {
    vi.useFakeTimers();
    const a = new HyperliquidRealtimeAdapter();
    await a.start({} as never); // arms the watchdog interval
    a.subscribe('ticker:hl:BTC' as Topic);
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    ws1.frame({ channel: 'allMids', data: { mids: { BTC: '1' } } });

    // Silence past stallMs: watchdog closes the socket AND schedules the
    // backoff reconnect. Pre-fix, the feed stayed dead until the next
    // organic subscribe() — with steady subscribers, forever.
    //
    // Timing pins the ORDERING too: stall detected at 15s, backoff 1s →
    // ws2 by 16s. The fake hub here has no lastFor/publish, so a throwing
    // onBreakerOpen used to abort the FIRST stall's recovery (ws2 only
    // after a second detection at 20s → instances would still be 1 at 17s).
    vi.advanceTimersByTime(17_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('a fresh socket gets stall grace from the connection attempt, not pre-open silence (r6 seed)', async () => {
    vi.useFakeTimers();
    const a = new HyperliquidRealtimeAdapter();
    await a.start({} as never);
    vi.advanceTimersByTime(120_000); // long idle, refs=0, event clock ancient

    a.subscribe('ticker:hl:BTC' as Topic);
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    // First watchdog check after open — pre-fix: age measured from the idle
    // era → instant stall → silent closeSocket of a healthy 1s-old socket.
    vi.advanceTimersByTime(6_000);
    expect(a.healthSnapshot().ws).toBe('open');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a dead allMids channel behind live trades: in-place resub first, socket recycle second (r7)', async () => {
    vi.useFakeTimers();
    const a = new HyperliquidRealtimeAdapter();
    await a.start({} as never); // arms BOTH watchdog intervals
    a.subscribe('ticker:hl:BTC' as Topic);
    a.subscribe('trades:hl:BTC' as Topic);
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    ws1.frame({ channel: 'allMids', data: { mids: { BTC: '1' } } });

    // allMids dies; trades keep flowing. Every 5s check, the trades frame
    // re-arms the SOCKET watchdog clock — pre-fix this masked the dead
    // ticker channel forever (r7 probe: 7 ticks, 79.7s tail gap, 308 live
    // trades, zero socket closes).
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(5_000);
      ws1.frame({ channel: 'trades', data: [] });
    }
    // 15s of channel silence → rung 1: in-place resubscribe, SAME socket.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(a.healthSnapshot().ws).toBe('open');
    expect(subs(ws1, 'allMids', 'unsubscribe')).toHaveLength(1);
    expect(subs(ws1, 'allMids')).toHaveLength(2); // onopen replay + resub

    // Resub gets one full stall budget; still silent → rung 2: recycle the
    // socket through the shared escalation path (close + self-scheduled
    // reconnect — same ordering guarantees as the socket watchdog).
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      ws1.frame({ channel: 'trades', data: [] }); // dropped once ws1 is dead
    }
    expect(ws1.readyState).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('an allMids frame after the in-place resub resets the ladder — next stall resubs again, no recycle (r7)', async () => {
    vi.useFakeTimers();
    const a = new HyperliquidRealtimeAdapter();
    await a.start({} as never);
    a.subscribe('ticker:hl:BTC' as Topic);
    a.subscribe('trades:hl:BTC' as Topic);
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    ws1.frame({ channel: 'allMids', data: { mids: { BTC: '1' } } });

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      ws1.frame({ channel: 'trades', data: [] });
    }
    expect(subs(ws1, 'allMids')).toHaveLength(2); // rung 1 fired at 15s

    // Channel recovers — one real frame resets the escalation ladder.
    ws1.frame({ channel: 'allMids', data: { mids: { BTC: '2' } } });

    // A LATER stall must start back at the cheap rung: resubscribe on the
    // same socket, not a recycle (pre-reset it would have escalated).
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      ws1.frame({ channel: 'trades', data: [] });
    }
    expect(subs(ws1, 'allMids')).toHaveLength(3);
    expect(subs(ws1, 'allMids', 'unsubscribe')).toHaveLength(2);
    expect(a.healthSnapshot().ws).toBe('open');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

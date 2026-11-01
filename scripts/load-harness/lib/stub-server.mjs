/**
 * lib/stub-server.mjs — local HTTP + hand-rolled RFC6455 WebSocket stub
 * used ONLY by --self-test (spec point 6). No new npm dependencies are
 * allowed for this harness, so the WS server side (handshake + minimal
 * frame encode/decode) is hand-rolled here rather than pulled from
 * apps/api's `ws`/`@hono/node-ws` — those are workspace-internal
 * transitive deps that would not resolve cleanly from a bare script
 * directory, and pulling them in would defeat the "no new deps" intent
 * anyway. This is a fixture double, not a reimplementation of the real
 * realtime hub — it exists to prove the harness's own pipeline (mint,
 * connect, subscribe, measure, gate, write artifact) end-to-end without
 * a network.
 */

import http from 'node:http';
import crypto from 'node:crypto';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STUB_HL_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const STUB_PM_MARKETS = [
  { id: 'pm-stub-1', question: 'Stub market one?', outcomes: [{ label: 'Yes', pricePct: 61 }, { label: 'No', pricePct: 39 }] },
  { id: 'pm-stub-2', question: 'Stub market two?', outcomes: [{ label: 'Yes', pricePct: 22 }, { label: 'No', pricePct: 78 }] },
  { id: 'pm-stub-3', question: 'Stub market three?', outcomes: [{ label: 'Yes', pricePct: 50 }, { label: 'No', pricePct: 50 }] },
];

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(code, reason = '') {
  const reasonBuf = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

/** Decode one client->server frame off the front of `buf`. Returns null
 * if `buf` doesn't yet contain a complete frame. Client frames are
 * always masked per RFC6455. Handles up to 64-bit lengths for
 * correctness, though real payloads here are tiny. */
function tryDecodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset); offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset)); offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  }
  return { opcode, payload, frameLength: offset + len };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function bearerUserId(req) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : null;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const cacheHeaders = Math.random() < 0.5 ? { 'cf-cache-status': 'HIT' } : {};
  res.writeHead(status, { 'content-type': 'application/json', ...cacheHeaders, ...extraHeaders });
  res.end(JSON.stringify(body));
}

export async function startStubServer() {
  const tickets = new Map(); // ticket -> { userId, expiresAt }
  const idempotency = new Map(); // `${userId}:${key}` -> { status, body }
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub.local');
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && path === '/api/healthz') {
      return sendJson(res, 200, { ok: true, demo: true, name: 'nexa-stub', version: 'selftest', backend: 'stub', db: 'ok', redis: 'ok', features: {}, realtime: { hub: true } });
    }
    if (method === 'POST' && path === '/api/v1/stream/ticket') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const ticket = crypto.randomUUID();
      const expiresAt = Date.now() + 60_000;
      tickets.set(ticket, { userId, expiresAt });
      return sendJson(res, 200, { ok: true, token: ticket, expiresAt });
    }
    if (method === 'GET' && path === '/api/me/profile') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, livemode: false, region: 'US', user: { id: userId, email: `${userId}@stub.test`, name: userId, kycStatus: 'approved', killSwitch: false }, wallets: {} });
    }
    if (method === 'GET' && path === '/api/markets/hyperliquid') {
      return sendJson(res, 200, { ok: true, source: 'demo', markets: STUB_HL_COINS.map((coin) => ({ coin, markPx: 100, funding: 0 })) });
    }
    if (method === 'GET' && path === '/api/markets/hyperliquid/all-mids') {
      return sendJson(res, 200, { ok: true, mids: Object.fromEntries(STUB_HL_COINS.map((c) => [c, '100'])) });
    }
    if (method === 'GET' && path === '/api/markets/hyperliquid-spot') {
      return sendJson(res, 200, { ok: true, source: 'demo', markets: STUB_HL_COINS.map((coin) => ({ coin: `${coin}-SPOT` })) });
    }
    if (method === 'GET' && path === '/api/markets/polymarket') {
      return sendJson(res, 200, { ok: true, source: 'demo', markets: STUB_PM_MARKETS });
    }
    if (method === 'GET' && path === '/api/markets/portfolio/summary') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, summary: { equityUsd: 100, availableUsd: 100 } });
    }
    if (method === 'GET' && path === '/api/markets/positions') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, positions: [] });
    }
    if (method === 'GET' && path === '/api/markets/orders') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, orders: [] });
    }
    if (method === 'GET' && path === '/api/markets/fills') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, fills: [] });
    }
    if (method === 'GET' && path === '/api/ledger/activity') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, activity: [] });
    }
    if (method === 'POST' && path === '/api/markets/hyperliquid/order') {
      const userId = bearerUserId(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const idKey = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
      if (!idKey) return sendJson(res, 400, { ok: false, error: 'idempotency_key_required' });
      const cacheKey = `${userId}:${idKey}`;
      if (idempotency.has(cacheKey)) {
        const cached = idempotency.get(cacheKey);
        return sendJson(res, cached.status, cached.body, { 'x-idempotent-replay': '1' });
      }
      const body = await readJsonBody(req);
      const qtyUsd = Number(body?.qtyUsd ?? 0);
      if (!(qtyUsd > 0) || !body?.coin) return sendJson(res, 400, { ok: false, error: 'invalid_order' });
      // Shape parity with routes/markets.ts: the wire field is `orderId`, not `id`.
      const respBody = { ok: true, order: { orderId: crypto.randomUUID(), coin: body.coin, sideLong: Boolean(body.sideLong), qtyUsd, status: 'filled' } };
      idempotency.set(cacheKey, { status: 200, body: respBody });
      return sendJson(res, 200, respBody);
    }
    // Dynamic detail routes — checked after all static ones above, same
    // precedence as the real Hono router (static paths registered first).
    const hlDetail = /^\/api\/markets\/hyperliquid\/([^/]+)$/.exec(path);
    if (method === 'GET' && hlDetail) {
      return sendJson(res, 200, { ok: true, market: { coin: decodeURIComponent(hlDetail[1]), markPx: 100 } });
    }
    const pmDetail = /^\/api\/markets\/polymarket\/([^/]+)$/.exec(path);
    if (method === 'GET' && pmDetail) {
      const id = decodeURIComponent(pmDetail[1]);
      const found = STUB_PM_MARKETS.find((m) => m.id === id) ?? { id, question: 'Unknown stub market', outcomes: [] };
      return sendJson(res, 200, { ok: true, market: found });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    sockets.add(socket);

    const url = new URL(req.url, 'http://stub.local');
    const token = url.searchParams.get('token');
    const entry = token ? tickets.get(token) : null;
    if (!entry || entry.expiresAt < Date.now()) {
      // Mirrors apps/api/src/realtime/ws-server.ts: the upgrade completes,
      // then the server closes unauthorized/expired connections with 1008.
      socket.write(encodeCloseFrame(1008, 'unauthorized'));
      socket.end();
      return;
    }
    tickets.delete(token); // single-use ticket
    const userId = entry.userId;
    socket.write(encodeTextFrame(JSON.stringify({ op: 'ready', accepted: [], serverVersion: '1' })));

    const subscribed = new Set();
    const pushInterval = setInterval(() => {
      if (!subscribed.size) return;
      const topics = [...subscribed];
      const topic = topics[Math.floor(Math.random() * topics.length)];
      const kind = topic.startsWith('priv:')
        ? (topic.endsWith(':orders') ? 'order' : topic.endsWith(':fills') ? 'fill' : 'account')
        : 'ticker';
      socket.write(encodeTextFrame(JSON.stringify({ t: kind, topic, ts: Date.now(), src: 'stub' })));
    }, 300);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frame = tryDecodeFrame(buffer);
      while (frame) {
        buffer = buffer.subarray(frame.frameLength);
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode === 0x1) {
          let msg = null;
          try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { /* ignore non-JSON */ }
          if (msg?.op === 'sub' && Array.isArray(msg.topics)) {
            for (const t of msg.topics) {
              if (typeof t !== 'string') continue;
              if (t.startsWith('priv:')) {
                const parts = t.split(':');
                if (parts[1] !== userId) {
                  socket.write(encodeTextFrame(JSON.stringify({ op: 'err', code: 'denied_acl', topic: t })));
                  continue;
                }
              }
              subscribed.add(t);
            }
          } else if (msg?.op === 'unsub' && Array.isArray(msg.topics)) {
            for (const t of msg.topics) subscribed.delete(t);
          } else if (msg?.op === 'ping') {
            socket.write(encodeTextFrame(JSON.stringify({ op: 'pong' })));
          }
        }
        frame = tryDecodeFrame(buffer);
      }
    });
    socket.on('close', () => { clearInterval(pushInterval); sockets.delete(socket); });
    socket.on('error', () => { clearInterval(pushInterval); });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}/api`,
    port,
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) { try { s.destroy(); } catch { /* already gone */ } }
        server.close(() => resolve());
      });
    },
  };
}

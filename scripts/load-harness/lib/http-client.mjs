/**
 * lib/http-client.mjs — timed fetch wrapper + route-family / edge-cache
 * classification, dependency-free (Node 22 global fetch — same
 * convention as scripts/load-gate.mjs).
 */

const AUTHED_PREFIXES = [
  '/me/', '/markets/positions', '/markets/orders',
  '/markets/fills', '/ledger/',
];

/**
 * Classify a request into a route family for gate bucketing. Mutating
 * methods are always 'write' — this MUST be method-based, not a path
 * substring check: '/markets/orders' (GET, a read route) contains the
 * substring '/order', which a naive `path.includes('/order')` check
 * would misclassify as a write.
 */
export function classifyFamily(path, method = 'GET') {
  if (method !== 'GET') return 'write';
  const bare = path.split('?')[0];
  // Portfolio summary is a fan-out aggregate with its own (looser) plan
  // gate — p95 <1200ms vs <750ms for point authed reads. Lumping it into
  // 'authed' let its tail mask regressions in cheap profile/balance reads.
  if (bare.startsWith('/markets/portfolio')) return 'portfolio';
  if (AUTHED_PREFIXES.some((p) => bare.startsWith(p))) return 'authed';
  if (/\/(hyperliquid|polymarket|hyperliquid-spot)\/[^/]+$/.test(bare) && !bare.endsWith('all-mids')) {
    return 'public-detail';
  }
  return 'public-catalog';
}

/**
 * Timed GET/POST. Returns { ok, status, ms, cfCacheHit, isPublic, family,
 * bodyJson? }. Never throws — network errors resolve as { ok:false,
 * status:0 } so VU loops don't need try/catch at every call site.
 */
export async function timedRequest(baseUrl, path, { method = 'GET', headers = {}, body, drain = true } = {}) {
  const family = classifyFamily(path, method);
  const t0 = performance.now();
  try {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let bodyJson;
    if (drain) {
      try { bodyJson = await res.json(); } catch { /* non-JSON or empty body */ }
    }
    const ms = performance.now() - t0;
    const cf = res.headers.get('cf-cache-status');
    const cfCacheHit = cf === 'HIT' || (cf == null && res.headers.get('age') != null);
    return { ok: res.ok, status: res.status, ms, cfCacheHit, family, bodyJson, headers: res.headers };
  } catch {
    return { ok: false, status: 0, ms: performance.now() - t0, cfCacheHit: false, family, bodyJson: undefined, headers: null };
  }
}

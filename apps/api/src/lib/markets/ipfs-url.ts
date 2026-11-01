/**
 * IPFS gateway normalization for token media URLs.
 *
 * Cloudflare sunset its public IPFS gateways (`cf-ipfs.com` and
 * `cloudflare-ipfs.com`) — but pump.fun / Jupiter token metadata still ships
 * icon URLs pinned to those hosts, which now fail DNS entirely
 * (`ERR_NAME_NOT_RESOLVED`, live-tested in NEO console 2026-07-06 on
 * `cf-ipfs.com/ipfs/QmWV8Qgm…` = TROLL's icon). Everything that serves token
 * art to clients funnels through {@link normalizeIpfsUrl} so dead gateways
 * and bare `ipfs://` URIs are rewritten onto one working public gateway.
 *
 * Gateway choice: `ipfs.io` — verified reachable for this exact CID set in
 * `docs/probes/market-assets-2026-07-03.md` (docs repo). Alternate public
 * fallback if ipfs.io ever degrades: `dweb.link` (same path scheme).
 */

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** Gateways that no longer resolve — rewrite or drop, never pass through. */
const DEAD_GATEWAY_HOSTS = new Set(['cf-ipfs.com', 'cloudflare-ipfs.com']);

/** `<cid>.ipfs.<dead-host>` subdomain-style gateway suffixes. */
const DEAD_SUBDOMAIN_SUFFIXES = ['.ipfs.cf-ipfs.com', '.ipfs.cloudflare-ipfs.com'];

/**
 * Rewrite an IPFS-ish URL onto a working gateway.
 *
 * - `ipfs://CID[/path]` (and `ipfs://ipfs/CID`) → `https://ipfs.io/ipfs/CID[/path]`
 * - `https://cf-ipfs.com/ipfs/CID[/path]` (path style, dead host) → ipfs.io
 * - `https://CID.ipfs.cf-ipfs.com[/path]` (subdomain style, dead host) → ipfs.io
 * - dead host without a recoverable CID → `null` (a guaranteed-broken URL is
 *   worse than none: clients fall back to their letter-avatar placeholder)
 * - anything else (including already-healthy gateways) passes through as-is
 */
export function normalizeIpfsUrl(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;

  // Bare ipfs:// protocol — no DNS host at all.
  if (/^ipfs:\/\//i.test(raw)) {
    const rest = raw.replace(/^ipfs:\/\//i, '').replace(/^ipfs\//i, '');
    return rest ? IPFS_GATEWAY + rest : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a URL — leave it for the caller's own validation to reject.
    return raw;
  }
  const host = parsed.hostname.toLowerCase();

  // Path-style dead gateway: https://cf-ipfs.com/ipfs/CID[/path][?q]
  if (DEAD_GATEWAY_HOSTS.has(host)) {
    const m = parsed.pathname.match(/^\/ipfs\/(.+)$/);
    return m ? IPFS_GATEWAY + m[1] + parsed.search : null;
  }

  // Subdomain-style dead gateway: https://CID.ipfs.cf-ipfs.com[/path][?q]
  for (const suffix of DEAD_SUBDOMAIN_SUFFIXES) {
    if (host.endsWith(suffix)) {
      const cid = host.slice(0, host.length - suffix.length);
      if (!cid || cid.includes('.')) return null;
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return IPFS_GATEWAY + cid + path + parsed.search;
    }
  }

  return raw;
}

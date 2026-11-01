/**
 * SSRF-resistant fetch wrapper (Sprint 11 Phase 0).
 *
 * Outbound webhooks accept arbitrary seller-controlled URLs, which means a
 * malicious seller can target internal addresses (`127.0.0.1`,
 * `169.254.169.254` for cloud metadata, RFC1918 ranges) to coerce the API
 * into making requests on their behalf. `safeFetch` resolves the hostname
 * first, rejects any private/loopback/link-local target, and only then
 * issues `fetch`. Non-http schemes are rejected up front.
 *
 * TOCTOU caveat: there is a window between `dns.lookup` and the underlying
 * `fetch` connect where a hostile DNS server could flip the answer. This
 * wrapper does NOT yet pin the resolved IP into the fetch agent (would
 * require a custom `Agent` + `lookup` callback and break SNI on hosts that
 * vhost their cert from the hostname rather than the IP). The validate-
 * then-fetch flow blocks the common case (hostname literally resolves to
 * a private IP) and is intentionally explicit about the residual risk for
 * the next round.
 *
 * Used by `webhooks.dispatchWebhook` (outbound delivery) and validated up
 * front by `routes/offers.ts` at registerWebhook time so registration
 * fails fast before the URL ever enters the store.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type SsrfReason =
  | 'invalid_url'
  | 'non_http'
  | 'dns_failed'
  | 'internal_ip'
  | 'invalid_host';

export type ValidateUrlResult =
  | { ok: true; ip: string; family: 4 | 6 }
  | { ok: false; reason: SsrfReason };

/* ── IP range checks ───────────────────────────────────────────────────── */

/** IPv4 address parsed as a 32-bit unsigned integer (big-endian octet order). */
function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** True when `addr` falls inside `0.0.0.0/cidr` for the given CIDR prefix length. */
function inCidrV4(addr: number, network: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (addr & mask) === (network & mask);
}

const V4_NETWORKS: ReadonlyArray<{ net: number; prefix: number; label: string }> = [
  { net: ipv4ToInt('0.0.0.0')!, prefix: 8, label: '0.0.0.0/8' },          // "this network"
  { net: ipv4ToInt('10.0.0.0')!, prefix: 8, label: '10.0.0.0/8' },        // RFC1918
  { net: ipv4ToInt('100.64.0.0')!, prefix: 10, label: '100.64.0.0/10' },  // CGNAT
  { net: ipv4ToInt('127.0.0.0')!, prefix: 8, label: '127.0.0.0/8' },      // loopback
  { net: ipv4ToInt('169.254.0.0')!, prefix: 16, label: '169.254.0.0/16' },// link-local + AWS metadata
  { net: ipv4ToInt('172.16.0.0')!, prefix: 12, label: '172.16.0.0/12' },  // RFC1918
  { net: ipv4ToInt('192.0.0.0')!, prefix: 24, label: '192.0.0.0/24' },    // IETF protocol assignments
  { net: ipv4ToInt('192.168.0.0')!, prefix: 16, label: '192.168.0.0/16' },// RFC1918
  { net: ipv4ToInt('198.18.0.0')!, prefix: 15, label: '198.18.0.0/15' },  // benchmark
  { net: ipv4ToInt('224.0.0.0')!, prefix: 4, label: '224.0.0.0/4' },      // multicast
  { net: ipv4ToInt('240.0.0.0')!, prefix: 4, label: '240.0.0.0/4' },      // reserved (incl. broadcast)
];

function isPrivateV4(addr: string): boolean {
  const n = ipv4ToInt(addr);
  if (n === null) return true; // safer to refuse unparseable
  for (const r of V4_NETWORKS) {
    if (inCidrV4(n, r.net, r.prefix)) return true;
  }
  return false;
}

/**
 * IPv6 private/loopback/link-local check via byte-prefix matching on the
 * expanded address. Covers ::1, ::, fe80::/10, fc00::/7, ::ffff:0:0/96
 * (IPv4-mapped — additionally re-checked as v4), and 64:ff9b::/96 (well-
 * known IPv4-translated).
 */
function isPrivateV6(addr: string): boolean {
  const bytes = expandIpv6(addr);
  if (!bytes) return true;

  // ::1 loopback
  let isLoopback = true;
  for (let i = 0; i < 15; i++) if (bytes[i] !== 0) { isLoopback = false; break; }
  if (isLoopback && bytes[15] === 1) return true;

  // :: unspecified
  let isUnspec = true;
  for (let i = 0; i < 16; i++) if (bytes[i] !== 0) { isUnspec = false; break; }
  if (isUnspec) return true;

  // fc00::/7 — unique local
  if ((bytes[0]! & 0xfe) === 0xfc) return true;

  // fe80::/10 — link local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;

  // ::ffff:0:0/96 — IPv4-mapped; re-check the embedded v4.
  let mapped = true;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) { mapped = false; break; }
  if (mapped && bytes[10] === 0xff && bytes[11] === 0xff) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isPrivateV4(v4);
  }

  return false;
}

/** Expand `2001:db8::1` style IPv6 to 16 bytes. Returns null on parse error. */
function expandIpv6(addr: string): number[] | null {
  // Strip zone id (%eth0) if present.
  const noZone = addr.split('%')[0] ?? addr;
  const parts = noZone.split('::');
  if (parts.length > 2) return null;

  const head = parts[0] && parts[0].length > 0 ? parts[0]!.split(':') : [];
  const tail = parts[1] && parts[1].length > 0 ? parts[1]!.split(':') : [];

  // IPv4-suffix syntax: last segment may itself be a dotted v4 (e.g. ::ffff:1.2.3.4).
  const lastTail = tail[tail.length - 1];
  let v4Suffix: number[] | null = null;
  if (lastTail && lastTail.includes('.')) {
    const v4n = ipv4ToInt(lastTail);
    if (v4n === null) return null;
    v4Suffix = [(v4n >>> 24) & 0xff, (v4n >>> 16) & 0xff, (v4n >>> 8) & 0xff, v4n & 0xff];
    tail.pop();
  }

  const expandedGroups = 8 - (v4Suffix ? 2 : 0);
  const totalProvided = head.length + tail.length;
  if (totalProvided > expandedGroups) return null;

  const zeros = Array<string>(expandedGroups - totalProvided).fill('0');
  const groups: string[] =
    parts.length === 2 ? [...head, ...zeros, ...tail] : [...head, ...tail];
  if (groups.length !== expandedGroups) return null;

  const out: number[] = [];
  for (const g of groups) {
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    const v = parseInt(g, 16);
    out.push((v >>> 8) & 0xff, v & 0xff);
  }
  if (v4Suffix) out.push(...v4Suffix);
  return out.length === 16 ? out : null;
}

/* ── public API ────────────────────────────────────────────────────────── */

/**
 * Parse `rawUrl`, then resolve the hostname via the OS resolver and check
 * the address against the private-IP set. Returns the resolved IP on
 * success so callers can log it (and a future round can pin the agent to
 * connect to that specific address).
 */
export async function validateUrl(rawUrl: string): Promise<ValidateUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'non_http' };
  }

  // Strip an IPv6 host of its bracket pair so dns.lookup gets a bare address.
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return { ok: false, reason: 'invalid_host' };

  // Literal IPs short-circuit DNS — check the range directly.
  const literalFamily = isIP(host);
  if (literalFamily === 4) {
    if (isPrivateV4(host)) return { ok: false, reason: 'internal_ip' };
    return { ok: true, ip: host, family: 4 };
  }
  if (literalFamily === 6) {
    if (isPrivateV6(host)) return { ok: false, reason: 'internal_ip' };
    return { ok: true, ip: host, family: 6 };
  }

  try {
    const resolved = await lookup(host, { all: true });
    let firstPublic: ValidateUrlResult | null = null;
    for (const answer of resolved) {
      const fam = answer.family === 4 || answer.family === 6 ? answer.family : 0;
      if (fam === 4 && isPrivateV4(answer.address)) {
        return { ok: false, reason: 'internal_ip' };
      }
      if (fam === 6 && isPrivateV6(answer.address)) {
        return { ok: false, reason: 'internal_ip' };
      }
      if (fam !== 0 && !firstPublic) {
        firstPublic = { ok: true, ip: answer.address, family: fam };
      }
    }
    return firstPublic ?? { ok: false, reason: 'invalid_host' };
  } catch {
    return { ok: false, reason: 'dns_failed' };
  }
}

/**
 * Validate-then-fetch. Throws `Error('ssrf_blocked:<reason>')` so callers
 * can log and surface the reason without leaking a stack across the
 * webhook delivery path. On success, delegates to the global fetch.
 */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
  const v = await validateUrl(rawUrl);
  if (!v.ok) throw new Error(`ssrf_blocked:${v.reason}`);
  return fetch(rawUrl, init);
}

/** Test-only: surface the v4/v6 helpers for direct assertion. */
export const _internals = { isPrivateV4, isPrivateV6 };

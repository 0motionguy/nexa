import { randomUUID } from 'node:crypto';
import { sign, verify } from 'hono/jwt';
import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { env, runtimeFailClosed } from './env.js';
import { log } from './log.js';
import { makeRedis, RedisKeys, type RedisClient } from './redis.js';
import { ApiError } from './errors.js';
import { store } from '../store/index.js';
import type { SessionUser } from '../store/types.js';
import { userForAgentKey } from './agent-keys.js';
import { setSentryUser } from './sentry.js';

/**
 * F096 Sprint 18 — session cookie name. httpOnly + Secure + SameSite=Lax
 * cookie issued alongside the Bearer-token response on /auth/verify and
 * /auth/privy-verify. Browser clients (neo web target, apps/web checkout)
 * can rely on the cookie instead of mirroring the JWT into XSS-readable
 * localStorage / AsyncStorage. Native + server-to-server clients keep
 * using the Authorization: Bearer header.
 */
export const SESSION_COOKIE_NAME = 'nexa_session';

export interface SessionClaims {
  sub: string;
  email: string;
  exp: number;
  [key: string]: unknown;
}

/**
 * F020 — signing + verification secret list. New tokens are signed with the
 * FIRST element; verification accepts any. When JWT_SECRETS is unset the
 * list is just `[JWT_SECRET]`, so single-secret deployments are unchanged.
 */
function jwtSecrets(): string[] {
  if (env.JWT_SECRETS) {
    const list = env.JWT_SECRETS.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return [env.JWT_SECRET];
}

/**
 * C1 go-live 2026-07-02 — 30 days (was 7). The PWA holds the session in the
 * httpOnly cookie across launches; the web client slides this window by calling
 * POST /auth/refresh when the token is within its refresh window (the final ~24h
 * before expiry), so only 30 days of TOTAL inactivity signs a user out. Founder-
 * approved trade-off; re-auth gating for large transfers is tracked as a
 * follow-up in docs/GO-LIVE-PLAN.md.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Red-team P1-8 — no-jti session cutover. The jti-anchored revocation upgrade
 * landed at the 5eeb8d0 deploy (2026-07-10); with the 30-day TTL (live since
 * 2026-07-02) every legitimate no-jti token is expired by 2026-08-10. +1 day of
 * clock-skew margin → after this instant a token without a jti is rejected by
 * default, so a stolen pre-jti (unrevokable) token can't outlive its cohort.
 */
export const SESSION_JTI_REQUIRED_AFTER_MS = Date.parse('2026-08-11T00:00:00Z');

/**
 * Whether a token carrying no jti may still authenticate.
 *   SESSION_REQUIRE_JTI=1 → force the cutover early (emergency).
 *   SESSION_REQUIRE_JTI=0 → hold the gate open past the date (escape hatch, e.g.
 *                           if the cohort estimate was wrong) — no deploy needed.
 *   unset (default)       → date-based: allowed until SESSION_JTI_REQUIRED_AFTER_MS.
 */
function legacyNoJtiAllowed(): boolean {
  if (env.SESSION_REQUIRE_JTI === '1') return false;
  if (env.SESSION_REQUIRE_JTI === '0') return true;
  return Date.now() < SESSION_JTI_REQUIRED_AFTER_MS;
}

/**
 * Stream-ticket TTL. Tickets are bound to a single SSE/WS connect attempt and
 * are immediately consumed; 60s is the most generous window we ever need (the
 * client mints + connects within tens of ms in practice). Reducing this is
 * always safe.
 */
export const STREAM_TICKET_TTL_SECONDS = 60;

export async function issueToken(
  user: SessionUser,
  opts?: { installationId?: string | null },
): Promise<{ token: string; expiresAt: number; jti: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  // NEO Session 1 — jti anchors this token in the revocation registry so
  // sign-out / refresh-rotation / /auth/revoke can kill this exact session.
  const jti = randomUUID();
  const claims: SessionClaims = {
    sub: user.id,
    email: user.email,
    exp: expiresAt,
    // F020 — embed kid in the payload so operators can audit which signing
    // secret minted a token without parsing the header. The verifier still
    // iterates jwtSecrets() so a missing-or-mismatched kid never rejects;
    // this is observability metadata, not an authorization gate.
    kid: env.JWT_KID_CURRENT || 'k1',
    jti,
  };
  const token = await sign(claims, jwtSecrets()[0]!);
  // Persist the session row so isSessionRevoked can answer for this jti. This is
  // FAIL-CLOSED: minting a token whose revocation row never landed would create
  // an unrevokable session (sign-out / rotate / /auth/revoke could not kill it).
  // One bounded retry — createSession is idempotent (onConflictDoNothing), so a
  // partial-write flake is retry-safe — then refuse to issue.
  try {
    await store.createSession({ userId: user.id, jti, installationId: opts?.installationId ?? null });
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    try {
      await store.createSession({ userId: user.id, jti, installationId: opts?.installationId ?? null });
    } catch (e2) {
      log.error(
        { err: e2 instanceof Error ? e2.message : String(e2), userId: user.id },
        'auth: session-row persist failed — refusing to mint an unrevokable token',
      );
      throw ApiError.serviceUnavailable('session_persist_failed');
    }
  }
  // P1-4: expose the jti so sign-in routes can replace-with-revoke the
  // installation's prior session (revokeSessionsByInstallation exceptJti).
  return { token, expiresAt, jti };
}

/**
 * Mint a short-lived single-use stream ticket bound to `user`. The ticket is
 * a JWT with the same signing path as session tokens, but:
 *   - TTL is 60s (vs 30 days for session)
 *   - `type === 'ticket'` claim distinguishes it from full session tokens
 *   - `jti` claim lets us mark it consumed on first use
 *
 * The realtime SSE/WS endpoints accept ONLY ticket tokens via `?token=`. Full
 * session JWTs are rejected from the query string — they can only ride a
 * Bearer header or the httpOnly cookie. This closes the URL-leakage attack
 * surface (referrer headers, server logs, browser history) for long-lived
 * credentials without breaking SSE's no-custom-header constraint.
 */
export interface TicketClaims extends SessionClaims {
  jti: string;
  type: 'ticket';
  sessionExp?: number;
}

export async function issueTicket(user: SessionUser, sessionExp?: number): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + STREAM_TICKET_TTL_SECONDS;
  const claims: TicketClaims = {
    sub: user.id,
    email: user.email,
    exp: expiresAt,
    kid: env.JWT_KID_CURRENT || 'k1',
    jti: randomUUID(),
    type: 'ticket',
  };
  if (typeof sessionExp === 'number') claims.sessionExp = sessionExp;
  const token = await sign(claims, jwtSecrets()[0]!);
  return { token, expiresAt };
}

/**
 * Stream-ticket replay guard (W2-B: Redis-backed one-shot).
 *
 * With REDIS_URL set, consumption is an atomic `SET nb:ticket_jti:<jti> 1
 * PX <ttl> NX` — the first consumer on ANY pod wins; every replay (including
 * cross-pod) sees the existing key and is rejected. Without Redis, the
 * pre-W2 in-process Map keeps dev/demo behavior unchanged: reusing the same
 * jti returns false, closing the replay window for stolen tickets on this
 * pod.
 *
 * Fail mode: in real production (`runtimeFailClosed()`) a ticket whose
 * single-use cannot be PROVEN — Redis errored, or no shared store is
 * configured at all — is rejected rather than optimistically accepted; a
 * per-process Map cannot rule out a replay against another pod. Dev/demo
 * fall back to the Map as before.
 */
const ticketJtiUsed = new Map<string, number>();

let ticketRedis: RedisClient | null = null;
let ticketRedisInitTried = false;

function getTicketRedis(): RedisClient | null {
  if (!ticketRedisInitTried) {
    ticketRedisInitTried = true;
    ticketRedis = makeRedis(env.REDIS_URL);
  }
  return ticketRedis;
}

function evictExpiredJtis(now: number): void {
  for (const [jti, expiry] of ticketJtiUsed) {
    if (expiry <= now) ticketJtiUsed.delete(jti);
  }
}

function markTicketUsedInProcess(jti: string, ttlMs: number): boolean {
  const now = Date.now();
  // Cheap GC — every call peeks, only walks the map when it's grown beyond
  // the eviction threshold. With 60s TTLs and typical traffic the map size
  // stays bounded at the steady-state of (mint rate × 60s).
  if (ticketJtiUsed.size > 256) evictExpiredJtis(now);
  const existing = ticketJtiUsed.get(jti);
  if (existing != null && existing > now) return false; // replay
  ticketJtiUsed.set(jti, now + ttlMs);
  return true;
}

/** True iff the jti was unused (this call consumed it). See guard doc above. */
async function consumeTicketJti(jti: string, ttlMs: number): Promise<boolean> {
  const redis = getTicketRedis();
  if (redis) {
    try {
      const res = await redis.set(RedisKeys.ticketJti(jti), '1', 'PX', Math.ceil(ttlMs), 'NX');
      return res === 'OK';
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (runtimeFailClosed()) {
        log.warn({ err }, 'ticket consume: redis unavailable; failing closed');
        return false;
      }
      log.warn({ err }, 'ticket consume: redis unavailable; falling back to in-process map');
    }
  } else if (runtimeFailClosed()) {
    log.warn('ticket consume: no shared store in real production; failing closed');
    return false;
  }
  return markTicketUsedInProcess(jti, ttlMs);
}

/**
 * Verify a stream ticket and hydrate the user on the context. Used by SSE/WS
 * `?token=` handlers in `realtime/router.ts` and `realtime/ws-server.ts`.
 *
 * Returns false when:
 *   - JWT verification fails against any rotation secret
 *   - claims.type is not 'ticket' (e.g. a full session JWT was supplied)
 *   - claims.jti is missing
 *   - consumeTicketJti returns false (jti already consumed — here or on another
 *     pod — or, in real production, the shared store couldn't prove single-use)
 *   - user lookup throws (already-deleted account, etc.)
 *
 * On success the context's `user` is set the same way `setSessionFromToken`
 * does, so downstream handlers don't need to know which auth path they came
 * through.
 */
export async function setSessionFromTicket(c: Context, token: string): Promise<boolean> {
  let claims: TicketClaims | null = null;
  for (const secret of jwtSecrets()) {
    try {
      claims = (await verify(token, secret, 'HS256')) as TicketClaims;
      break;
    } catch {
      // try next secret
    }
  }
  if (!claims) return false;
  if (claims.type !== 'ticket') return false;
  if (typeof claims.jti !== 'string' || claims.jti.length < 8) return false;
  // Bind the consumed-window to the ticket's own exp so the entry stays in the
  // dedupe map until the ticket itself would have expired anyway. ttlMs is
  // (claims.exp - now) + a tiny grace period for clock skew.
  const ttlMs = Math.max(1_000, (claims.exp * 1000) - Date.now() + 5_000);
  if (!(await consumeTicketJti(claims.jti, ttlMs))) return false;
  try {
    const user = await store.userSession(claims.sub);
    c.set('user', user);
    c.set('sessionExpiresAt', typeof claims.sessionExp === 'number' ? claims.sessionExp : claims.exp);
    withSentryUser(user);
    return true;
  } catch {
    return false;
  }
}

/** Test-only — clear the in-process jti dedupe map. */
export function _resetTicketJtisForTests(): void {
  ticketJtiUsed.clear();
}

/**
 * Test-only — inject a fake Redis for the ticket store, or null to force the
 * in-process fallback (deterministic even when the shell exports REDIS_URL).
 */
export function _setTicketRedisForTests(client: RedisClient | null): void {
  ticketRedis = client;
  ticketRedisInitTried = true;
}

/**
 * F096 Sprint 18 — set the httpOnly session cookie. Call this immediately
 * after `issueToken()` from /auth/verify + /auth/privy-verify (and any
 * future session-mint surface). Browser clients land the cookie; native /
 * server clients ignore it and use the Bearer token from the JSON response.
 *
 * Secure attribute is opt-out in non-production so the cookie still rides
 * `http://localhost` in dev. SameSite=Lax preserves top-level navigation
 * (Stripe / Privy redirect back) while blocking cross-site POST XSRF.
 */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** F096 — clear the session cookie. Used by /auth/signout (and tests). */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
}

/**
 * F096 — resolve the session token from either the Authorization: Bearer
 * header (native / server-to-server callers) or the httpOnly cookie (browser
 * callers). Bearer wins when both are present so a stale cookie can't
 * override an explicit header.
 */
function readSessionToken(c: Context): string | null {
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  return cookie ? cookie : null;
}

declare module 'hono' {
  interface ContextVariableMap {
    /** Scale wave 3 — the session projection, NOT the full aggregate. Routes
     *  that need activity/agents/contracts/x402Events/virtualAccounts must
     *  call `store.user(u.id)` explicitly (type-enforced; see SessionUser). */
    user: SessionUser;
    /** Set by requireApiKey: the mode (sk_live_ → true, sk_test_ → false) of the presented key. */
    livemode: boolean;
    /** Expiry of the credential that authenticated this request, unix seconds. */
    sessionExpiresAt: number;
    /** NEO Session 1 — jti of the session JWT that authenticated this request
     *  (set by setSessionFromToken when the token carries one). Absent for
     *  pre-upgrade tokens + API-key auth. Read by /auth/refresh + /auth/revoke +
     *  /auth/signout to revoke the presented session. */
    sessionJti?: string;
    /** Short request id surfaced in access logs + Sentry extras. */
    requestId: string;
  }
}

/**
 * NEO Session 1 — session-revocation cache for SAFE (read) methods only. Mutating
 * requests bypass this cache and read the store authoritatively (see isJtiRevoked),
 * so a revoke is enforced on the very next money POST. This in-process Map exists
 * to spare the hot polled GETs (balances/positions) a DB round-trip per request.
 *
 * Multi-pod note: the cache is per-process, so a revoke on pod A becomes visible
 * to pod B's READS only after B's cached entry expires — a bounded ≤30s staleness
 * window, accepted for read latency and irrelevant to money (mutations never use
 * the cache). The store is always the source of truth; revokes issued on THIS pod
 * prime the cache (markJtiRevokedInCache) so even local reads see them immediately.
 */
const REVOCATION_CACHE_TTL_MS = 30_000;
const revokedJtiCache = new Map<string, { revoked: boolean; expires: number }>();

/** Methods that never mutate state — their revocation check may ride the 30s
 *  cache. Every other method reads the store authoritatively (see isJtiRevoked). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolve whether a session jti is revoked.
 *
 * authoritative=false (safe / read methods): serve the 30s cache when warm; on a
 *   store error fail OPEN for THIS request only and never cache the answer, so a
 *   hot polled GET (balances/positions) keeps working and a transient blip can't
 *   poison the cache with a false negative.
 * authoritative=true (mutating methods): bypass the cache and read the store
 *   directly, so a revoke on any pod is enforced on the very next money POST. A
 *   store error is NOT proof of a live session — fail CLOSED with a 503.
 */
async function isJtiRevoked(jti: string, opts: { authoritative: boolean }): Promise<boolean> {
  const now = Date.now();
  if (!opts.authoritative) {
    const cached = revokedJtiCache.get(jti);
    if (cached && cached.expires > now) return cached.revoked;
  }
  let revoked: boolean;
  try {
    revoked = await store.isSessionRevoked(jti);
  } catch {
    if (opts.authoritative) throw ApiError.serviceUnavailable('session_check_unavailable'); // fail closed
    return false; // read path: fail open for this request only — never cache an error answer
  }
  revokedJtiCache.set(jti, { revoked, expires: now + REVOCATION_CACHE_TTL_MS });
  return revoked;
}

/** Prime the local cache after revoking a jti on THIS pod (immediate effect
 *  for local requests without waiting for the 30s TTL to lapse). */
export function markJtiRevokedInCache(jti: string): void {
  revokedJtiCache.set(jti, { revoked: true, expires: Date.now() + REVOCATION_CACHE_TTL_MS });
}

/** Drop every cached revocation answer — used after a revoke-all (we can't
 *  enumerate the affected jtis) so subsequent checks re-read the store. */
export function clearRevocationCache(): void {
  revokedJtiCache.clear();
}

/** Test-only — reset the in-process revocation cache between specs. */
export function _resetRevocationCacheForTests(): void {
  revokedJtiCache.clear();
}

/**
 * Tag the current Sentry scope with the resolved user. Called from session/
 * agent-key middleware so every captured exception carries `{ id, email }`.
 * No-op when SENTRY_DSN is unset (the helper itself short-circuits).
 *
 * Per-request scoping comes from Sentry's async-context tracking — we do not
 * need to clear at request end.
 */
export function withSentryUser(user: SessionUser): void {
  setSentryUser({ id: user.id, email: user.email, cohort: user.cohort });
}

export async function setSessionFromToken(c: Context, token: string): Promise<boolean> {
  // F020 — try each secret in order. The first match wins. Failure of one
  // secret falls through to the next; only if all reject do we return false.
  let claims: SessionClaims | null = null;
  for (const secret of jwtSecrets()) {
    try {
      claims = (await verify(token, secret, 'HS256')) as SessionClaims;
      break;
    } catch {
      // try next secret
    }
  }
  if (!claims) return false;
  if ((claims as Partial<TicketClaims>).type === 'ticket') return false;
  const jti = typeof claims.jti === 'string' ? claims.jti : null;
  // NEO Session 1 — reject revoked sessions. Mutating requests (money POSTs) read
  // revocation authoritatively; reads ride the 30s cache. The method split covers
  // every mutating route by construction — no per-route registry to forget a flag on.
  const authoritative = !SAFE_METHODS.has(c.req.method);
  // Pre-jti tokens (minted before the jti upgrade landed 2026-07-10) keep working
  // until the dated cutover so the 2026-07-02..07-10 cohort isn't mass-signed-out;
  // after SESSION_JTI_REQUIRED_AFTER_MS — or under SESSION_REQUIRE_JTI=1 — they 401.
  if (!jti) {
    if (!legacyNoJtiAllowed()) return false;
  } else if (await isJtiRevoked(jti, { authoritative })) {
    return false;
  }
  try {
    const user = await store.userSession(claims.sub);
    c.set('user', user);
    c.set('sessionExpiresAt', claims.exp);
    if (jti) c.set('sessionJti', jti);
    withSentryUser(user);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sprint 10 Item G — public checkout that ALSO supports a session-authed
 * "pay from MAZE balance" mode. If a valid Bearer token is present, set the
 * user on the context; otherwise pass through without rejecting. The handler
 * downstream decides whether to require it.
 */
export async function optionalSession(c: Context, next: Next): Promise<Response | void> {
  // F096 — accept either Bearer header OR the httpOnly session cookie.
  const token = readSessionToken(c);
  if (token) {
    try {
      await setSessionFromToken(c, token);
    } catch (e) {
      // Authoritative-read 503 on a mutating optional-auth route (/auth/signout,
      // the Sprint-10 "pay from MAZE balance" checkout): degrade to anonymous
      // rather than hard-fail. The downstream handler's own auth requirement still
      // fails closed for money; signout still clears the cookie during a store blip.
      if (!(e instanceof ApiError)) throw e;
    }
  }
  await next();
}

/** Bearer-JWT or httpOnly-cookie auth for the app surface. */
export async function requireSession(c: Context, next: Next): Promise<Response | void> {
  const token = readSessionToken(c);
  if (!token) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!(await setSessionFromToken(c, token))) return c.json({ ok: false, error: 'unauthorized' }, 401);
  await next();
}

/**
 * Legacy SSE auth — accepts session JWTs via `?token=` for back-compat with
 * the ledger/activity stream and other non-realtime stream endpoints. The
 * realtime hub uses `requireRealtimeAuth` below, which restricts URL tokens
 * to short-lived tickets only.
 *
 * If you are designing a new stream endpoint, prefer `requireRealtimeAuth`
 * to close the URL-leakage surface for long-lived credentials.
 */
export async function requireEventStreamSession(c: Context, next: Next): Promise<Response | void> {
  const sessionToken = readSessionToken(c);
  if (sessionToken && (await setSessionFromToken(c, sessionToken))) {
    await next();
    return;
  }
  const queryToken = c.req.query('token') ?? null;
  if (
    queryToken &&
    ((await setSessionFromTicket(c, queryToken)) || (await setSessionFromToken(c, queryToken)))
  ) {
    await next();
    return;
  }
  return c.json({ ok: false, error: 'unauthorized' }, 401);
}

/**
 * Realtime hub auth — cookie/Bearer take the full session JWT path; the
 * `?token=` query parameter is reserved for **stream tickets only** —
 * short-lived single-use credentials minted at POST /v1/stream/ticket.
 * Long-lived session JWTs are NOT accepted in URLs (referrer leakage,
 * log retention).
 *
 * Browser SSE callers cannot set custom headers and httpOnly cookies aren't
 * always available cross-origin; they call POST /v1/stream/ticket to mint
 * a ticket bound to the cookie session and connect with `?token=<ticket>`.
 *
 * Same-origin/native callers should keep using Bearer headers directly; no
 * ticket dance is required for them.
 */
export async function requireRealtimeAuth(c: Context, next: Next): Promise<Response | void> {
  const sessionToken = readSessionToken(c);
  if (sessionToken && (await setSessionFromToken(c, sessionToken))) {
    await next();
    return;
  }
  const ticket = c.req.query('token');
  if (ticket && (await setSessionFromTicket(c, ticket))) {
    await next();
    return;
  }
  return c.json({ ok: false, error: 'unauthorized' }, 401);
}

/**
 * Public-API auth (sk_test_/sk_live_) for the /v1 developer surface. Reads the
 * raw secret from `Authorization: Bearer <sk_…>`, resolves it via the store, and
 * sets both the owning user and the key's mode on the context. Public-API errors
 * use the bare `{ error: { type, message } }` shape (not the app `{ ok }` envelope).
 */
export async function requireApiKey(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header('authorization') ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!secret || !secret.startsWith('sk_')) {
    return c.json(
      { error: { type: 'authentication_error', message: 'Missing or invalid API key.' } },
      401,
    );
  }
  const r = await store.userForApiKey(secret);
  if (!r) {
    return c.json(
      { error: { type: 'authentication_error', message: 'Missing or invalid API key.' } },
      401,
    );
  }
  c.set('user', r.user);
  c.set('livemode', r.livemode);
  withSentryUser(r.user);
  await next();
}

/** Agent-key auth (nx_live_*) for MCP + x402 pay — scoped, logged. */
export async function requireAgentKey(c: Context, next: Next): Promise<Response | void> {
  const provided =
    c.req.header('x-nexa-key') ??
    (c.req.header('authorization')?.startsWith('Bearer ')
      ? c.req.header('authorization')!.slice(7)
      : null);
  const user = provided ? await userForAgentKey(provided) : null;
  if (!provided || !user) {
    return c.json({ ok: false, error: 'invalid_agent_key' }, 401);
  }
  c.set('user', user);
  withSentryUser(user);
  await next();
}

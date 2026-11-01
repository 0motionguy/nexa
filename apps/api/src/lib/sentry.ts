/**
 * Sentry wrapper — env-gated (SENTRY_DSN). All exports are no-ops when the DSN
 * is unset, so we can sprinkle setSentryUser / captureException freely without
 * threading a "is Sentry on?" check through every call site.
 *
 * `initSentry()` runs at top-level import time so that lib/sentry-bootstrap.ts
 * — the FIRST line of apps/api/src/index.ts — hooks Sentry's http auto-
 * instrumentation before Hono binds its server. Re-entry is idempotent via
 * the `initialized` flag.
 *
 * Dedup policy with the pino-sentry transport in log.ts: the transport fires
 * on `warn` level and above; explicit `captureException` calls in app.onError
 * cover errors (with structured `extra` context). Sentry's own fingerprinting
 * collapses dupes so a warn-level log + an explicit capture from the same
 * unhandled error end up as one issue.
 */

import * as Sentry from '@sentry/node';
import { env } from './env.js';

let initialized = false;

/**
 * PII scrubbing (F052). Sentry stores events on third-party infra; a handler
 * that ever logs an email, wallet, or token (by design or by a future PR
 * accident) would ship that PII upstream. beforeSend walks strings in the
 * event body and replaces matches with `[redacted-kind]` placeholders.
 *
 * Scope: event.message, event.exception.values[*].value, event.request
 * (url/headers/cookies/data), event.extra, event.contexts, breadcrumbs.
 * NOT scrubbed: event.user (set explicitly by setSentryUser — known-safe).
 */
const PII_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/0x[a-fA-F0-9]{40}\b/g, '[wallet]'],
  [/\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/g, '[stripe-key]'],
  [/\bnx_(?:live|test)_[A-Za-z0-9_]+\b/g, '[agent-key]'],
  [/\bdid:privy:[A-Za-z0-9_-]+\b/g, '[privy-did]'],
  [/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [token]'],
  // Sprint 17 F071 — Monerium routes return IBAN values; without this an
  // exception path that stringifies the response would ship the IBAN to
  // Sentry's third-party storage. Pattern: 2 country letters + 2 check
  // digits + 1..30 alphanumerics (the spec ceiling is 34 chars total).
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[iban]'],
  // Phone shapes: require either an explicit international `+` prefix or
  // a US-style `(XXX) XXX-XXXX` shape. Word-anchored so a long digit-run
  // inside an opaque order id doesn't get mangled to '[phone]'.
  [/\B\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,9}\b/g, '[phone]'],
  [/\(\d{3}\)\s?\d{3}[-.\s]?\d{4}\b/g, '[phone]'],
];

/**
 * Headers we strip wholesale even if the value doesn't match a PII pattern —
 * opaque session cookies, agent keys, signature headers carry sensitive state
 * regardless of shape. Lower-cased; the lookup is case-insensitive.
 */
const HEADER_KEYS_TO_REDACT: ReadonlyArray<string> = [
  'authorization',
  'cookie',
  'x-nexa-key',
  'stripe-signature',
  'maze-signature',
];

/**
 * Sprint 13 COMMIT 7 (SR6) — object keys whose VALUES we always redact in
 * extra / contexts blocks. userId + agentId are user-correlatable; amountUsd
 * can leak balance information when sliced across many events. The scrubber
 * walks every object key recursively and replaces the value with '[redacted]'.
 */
const VALUE_KEYS_TO_REDACT: ReadonlyArray<string> = [
  'userid',
  'agentid',
  'amountusd',
];

/**
 * Sprint 13 COMMIT 7 (SR6) — UUID-shaped strings are user/agent/offer IDs in
 * disguise. Strip them anywhere a string value lands in the scrubber, not
 * just in known keys.
 */
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function scrubString(s: string): string {
  let out = s;
  for (const [re, repl] of PII_PATTERNS) {
    out = out.replace(re, repl);
  }
  // Sprint 13 COMMIT 7 (SR6) — UUID-shaped values land in stack traces,
  // log messages, breadcrumb text. Scrub them everywhere a string flows.
  out = out.replace(UUID_RE, '[uuid]');
  return out;
}

function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // Sprint 13 COMMIT 7 (SR6) — keys like userId / agentId / amountUsd
      // are wholesale-redacted regardless of value shape so sliced events
      // can't leak balance or identity correlation.
      if (VALUE_KEYS_TO_REDACT.includes(k.toLowerCase())) {
        out[k] = '[redacted]';
      } else {
        out[k] = scrubValue(val);
      }
    }
    return out;
  }
  return v;
}

/** Internal: exported for unit tests. Mutates and returns the event. */
export function scrubSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.message) event.message = scrubString(event.message);
  if (event.exception?.values) {
    for (const v of event.exception.values) {
      if (v.value) v.value = scrubString(v.value);
    }
  }
  if (event.request) {
    if (event.request.url) event.request.url = scrubString(event.request.url);
    if (event.request.headers) {
      const headers = event.request.headers as Record<string, string>;
      // Wholesale-strip known-sensitive header keys before pattern scrubbing,
      // since e.g. an opaque session cookie or a signature header won't match
      // any PII regex but still leaks privileged state.
      for (const key of Object.keys(headers)) {
        if (HEADER_KEYS_TO_REDACT.includes(key.toLowerCase())) {
          headers[key] = '[redacted]';
        }
      }
      event.request.headers = scrubValue(headers) as typeof event.request.headers;
    }
    if (event.request.cookies) {
      event.request.cookies = '[redacted]' as unknown as typeof event.request.cookies;
    }
    if (event.request.data !== undefined) {
      event.request.data = scrubValue(event.request.data);
    }
  }
  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.message) b.message = scrubString(b.message);
      if (b.data) b.data = scrubValue(b.data) as typeof b.data;
    }
  }
  return event;
}

export function initSentry(): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) return; // no-op when DSN unset
  const sampleRate = Number(env.SENTRY_TRACES_SAMPLE_RATE);
  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: Number.isFinite(sampleRate) ? sampleRate : 0.1,
    environment: env.NODE_ENV,
    release: process.env['npm_package_version'] ?? undefined,
    integrations: [Sentry.httpIntegration(), Sentry.nodeContextIntegration()],
    beforeSend: (event) => scrubSentryEvent(event),
  });
  initialized = true;
}

// Side-effect: kick init as soon as this module loads. sentry-bootstrap.ts
// imports this file as the very first line of index.ts so the auto-
// instrumentation patches global http before any server binds.
initSentry();

export function captureException(err: unknown, ctx?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(err, ctx ? { extra: ctx } : undefined);
}

/**
 * F086 Sprint 18 — explicit operator-alert helper for non-exception conditions
 * the worker discovers (e.g. attestation timeout, high-value transfer failure).
 *
 * `tags` end up as Sentry tags — slicable in the dashboard and routable by
 * Sentry alert rules (Slack / PagerDuty / Discord). `extra` is for structured
 * context that doesn't need slicing. `level` defaults to 'error' so the message
 * shows up in the error feed alongside genuine exceptions.
 */
export function captureMessage(
  message: string,
  opts: {
    level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
    tags?: Record<string, string | number | boolean | undefined>;
    extra?: Record<string, unknown>;
  } = {},
): void {
  if (!initialized) return;
  const filteredTags: Record<string, string> = {};
  if (opts.tags) {
    for (const [k, v] of Object.entries(opts.tags)) {
      if (v === undefined || v === null) continue;
      filteredTags[k] = String(v);
    }
  }
  Sentry.captureMessage(message, {
    level: opts.level ?? 'error',
    tags: filteredTags,
    ...(opts.extra ? { extra: opts.extra } : {}),
  });
}

export function setSentryUser(u: { id: string; email?: string; cohort?: string | null }): void {
  if (!initialized) return;
  Sentry.setUser({ id: u.id, email: u.email });
  // Audit 2026-06-19 — cohort tag so the Sentry dashboard can filter to the
  // test cohort and surface errors specific to our friendly testers.
  if (u.cohort) Sentry.setTag('cohort', u.cohort);
}

export function clearSentryUser(): void {
  if (!initialized) return;
  Sentry.setUser(null);
}

/** Test-only: surface the initialized flag without exposing the Sentry SDK. */
export function isSentryInitialized(): boolean {
  return initialized;
}

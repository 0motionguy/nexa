/**
 * Tests for the Sentry wrapper. We exercise the no-op path (DSN unset) and
 * the initialised path (DSN set) by re-importing the module after mutating
 * process.env. `Sentry.init` is mocked so we can assert it was called with
 * the right options without actually opening a network connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = process.env;

// Hoisted mock factory — vi.mock is lifted above imports so any test importing
// `../lib/sentry.js` sees the stubbed surface.
const sentryStubs = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  httpIntegration: vi.fn(() => ({ name: 'http' })),
  nodeContextIntegration: vi.fn(() => ({ name: 'nodeContext' })),
}));

vi.mock('@sentry/node', () => sentryStubs);

describe('lib/sentry', () => {
  beforeEach(() => {
    vi.resetModules();
    sentryStubs.init.mockClear();
    sentryStubs.captureException.mockClear();
    sentryStubs.setUser.mockClear();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('is a no-op when SENTRY_DSN is unset', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env['SENTRY_DSN'];

    const sentry = await import('./sentry.js');
    // initSentry() ran at import time — without DSN it should not call init.
    expect(sentryStubs.init).not.toHaveBeenCalled();
    expect(sentry.isSentryInitialized()).toBe(false);

    // Subsequent helpers silently no-op.
    sentry.captureException(new Error('boom'));
    sentry.setSentryUser({ id: 'u_1', email: 'a@b.com' });
    sentry.clearSentryUser();
    expect(sentryStubs.captureException).not.toHaveBeenCalled();
    expect(sentryStubs.setUser).not.toHaveBeenCalled();
  });

  it('initialises Sentry exactly once when DSN is set', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      SENTRY_DSN: 'https://test@sentry.example/1',
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
    };

    const sentry = await import('./sentry.js');
    expect(sentryStubs.init).toHaveBeenCalledTimes(1);
    const call = sentryStubs.init.mock.calls[0]![0]! as {
      dsn: string;
      tracesSampleRate: number;
    };
    expect(call.dsn).toBe('https://test@sentry.example/1');
    expect(call.tracesSampleRate).toBe(0.25);
    expect(sentry.isSentryInitialized()).toBe(true);

    // Calling initSentry again is a no-op (idempotency guard).
    sentry.initSentry();
    expect(sentryStubs.init).toHaveBeenCalledTimes(1);
  });

  it('forwards captureException + setSentryUser once initialised', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      SENTRY_DSN: 'https://test@sentry.example/1',
    };

    const sentry = await import('./sentry.js');
    const err = new Error('boom');
    sentry.captureException(err, { route: '/x' });
    expect(sentryStubs.captureException).toHaveBeenCalledWith(err, {
      extra: { route: '/x' },
    });

    sentry.setSentryUser({ id: 'u_2', email: 'b@c.com' });
    expect(sentryStubs.setUser).toHaveBeenCalledWith({ id: 'u_2', email: 'b@c.com' });

    sentry.clearSentryUser();
    expect(sentryStubs.setUser).toHaveBeenLastCalledWith(null);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * scrubSentryEvent (Sprint 11 Phase 0) — covers the F052 PII redactor plus
 * the explicit header-strip set the plan calls out (authorization, cookie,
 * x-nexa-key, stripe-signature, maze-signature). Tests the pure function
 * directly so we don't have to boot Sentry's transport in CI.
 * ────────────────────────────────────────────────────────────────────────── */

describe('scrubSentryEvent', () => {
  it('strips sensitive request headers wholesale', async () => {
    const { scrubSentryEvent } = await import('./sentry.js');
    const event = {
      request: {
        url: 'https://api.maze.to/auth/start',
        headers: {
          authorization: 'Bearer abc123xyz',
          cookie: 'session=opaqueOpaque',
          'x-nexa-key': 'nx_live_secret_token',
          'stripe-signature': 't=1700000000,v1=deadbeef',
          'maze-signature': 't=1700000000,v1=cafebabe',
          'user-agent': 'curl/8',
        },
      },
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    const headers = out.request!.headers as Record<string, string>;
    expect(headers.authorization).toBe('[redacted]');
    expect(headers.cookie).toBe('[redacted]');
    expect(headers['x-nexa-key']).toBe('[redacted]');
    expect(headers['stripe-signature']).toBe('[redacted]');
    expect(headers['maze-signature']).toBe('[redacted]');
    // Unrelated headers survive (post-scrub).
    expect(headers['user-agent']).toBe('curl/8');
  });

  it('redacts email + wallet + agent-key + bearer + stripe-key in extra/contexts', async () => {
    const { scrubSentryEvent } = await import('./sentry.js');
    const event = {
      extra: {
        whoami: 'mirko@example.com paid via 0xAbC1234567890abcdef1234567890abcdef12345',
        bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        agent: 'agent key is nx_live_abcdef_demo',
        stripe: 'sk_live_alongkey1234567890abcd',
      },
      contexts: {
        runtime: {
          name: 'node',
          notes: 'hit /v1/x402 with Bearer eyJTOKENSTRING.aaaa.bbbb',
        },
      },
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    const extra = out.extra as Record<string, string>;
    expect(extra.whoami).toContain('[email]');
    expect(extra.whoami).toContain('[wallet]');
    expect(extra.bearer).toBe('Bearer [token]');
    expect(extra.agent).toContain('[agent-key]');
    expect(extra.stripe).toContain('[stripe-key]');
    const ctx = out.contexts as { runtime: { notes: string } };
    expect(ctx.runtime.notes).toContain('Bearer [token]');
  });

  it('walks exception values and breadcrumbs', async () => {
    const { scrubSentryEvent } = await import('./sentry.js');
    const event = {
      exception: {
        values: [
          { type: 'Error', value: 'failed to email alice@example.com' },
        ],
      },
      breadcrumbs: [
        { message: 'auth attempt for bob@example.com' },
        { message: 'paid 0xAbC1234567890abcdef1234567890abcdef12345' },
      ],
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    expect(out.exception!.values![0]!.value).toContain('[email]');
    expect(out.breadcrumbs![0]!.message).toContain('[email]');
    expect(out.breadcrumbs![1]!.message).toContain('[wallet]');
  });

  /* Sprint 13 COMMIT 7 (SR6) — wholesale-redact userId / agentId / amountUsd
   * values plus UUID-shaped strings, so a sliced Sentry view can't correlate
   * users or leak balances. */

  it('wholesale-redacts userId, agentId, amountUsd in extra + contexts', async () => {
    const { scrubSentryEvent } = await import('./sentry.js');
    const event = {
      extra: {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        agentId: 'a1b2c3d4-e5f6-7890-1234-567890abcdef',
        amountUsd: 1234.56,
        note: 'unrelated field stays',
      },
      contexts: {
        biz: {
          userId: 'plain-text-id',
          amountUsd: 99,
        },
      },
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    const extra = out.extra as Record<string, unknown>;
    expect(extra.userId).toBe('[redacted]');
    expect(extra.agentId).toBe('[redacted]');
    expect(extra.amountUsd).toBe('[redacted]');
    expect(extra.note).toBe('unrelated field stays');
    const ctx = out.contexts as { biz: Record<string, unknown> };
    expect(ctx.biz.userId).toBe('[redacted]');
    expect(ctx.biz.amountUsd).toBe('[redacted]');
  });

  it('redacts UUID-shaped substrings inside string values everywhere', async () => {
    const { scrubSentryEvent } = await import('./sentry.js');
    const event = {
      message: 'lookup failed for user 550e8400-e29b-41d4-a716-446655440000',
      extra: {
        trace: 'GET /v1/agents/a1b2c3d4-e5f6-7890-1234-567890abcdef returned 404',
      },
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    expect(out.message).toContain('[uuid]');
    expect(out.message).not.toContain('550e8400');
    const extra = out.extra as Record<string, string>;
    expect(extra.trace).toContain('[uuid]');
    expect(extra.trace).not.toContain('a1b2c3d4');
  });

  /* Sprint 17 F071 — Monerium pushed IBAN values through the API surface;
   * phone numbers are a known PII shape that could land in support payloads.
   * Both must scrub before reaching Sentry. */

  it('redacts IBAN values in message + extra', async () => {
    const { scrubSentryEvent } = await import('./sentry.js');
    const event = {
      message: 'offramp failed for DE89370400440532013000',
      extra: {
        recipient: 'GB29NWBK60161331926819',
        ok: 'unrelated text',
      },
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    expect(out.message).toContain('[iban]');
    expect(out.message).not.toContain('DE89370400440532013000');
    const extra = out.extra as Record<string, string>;
    expect(extra.recipient).toContain('[iban]');
    expect(extra.recipient).not.toContain('GB29NWBK60161331926819');
  });

  it('redacts phone-number shapes (international + US) without mangling ISO dates', async () => {
    const { scrubSentryEvent } = await import('./sentry.js');
    const event = {
      message: 'contact +1 415 555 0199 or (555) 123-4567 on 2026-06-17',
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    expect(out.message).toContain('[phone]');
    expect(out.message).not.toContain('+1 415 555 0199');
    expect(out.message).not.toContain('(555) 123-4567');
    // ISO date must survive — phone regex is bounded to + or () shapes.
    expect(out.message).toContain('2026-06-17');
  });
});

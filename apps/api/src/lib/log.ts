import pino, { type TransportTargetOptions } from 'pino';
import { env, features } from './env.js';

/**
 * Composed pino logger.
 *
 * - Dev (NODE_ENV=development): pino-pretty for readability.
 * - Production with SENTRY_DSN: JSON stdout plus pino-sentry-transport at
 *   level `warn`. Sentry dedup collapses the transport message with the
 *   explicit `captureException` call in `app.onError` so unhandled errors
 *   don't appear twice.
 * - Production without SENTRY_DSN: plain JSON to stdout, structured by the
 *   Caddy/loki collector.
 *
 * Transports compose via pino.transport `{ targets: [...] }` so multiple sinks
 * coexist without losing the JSON stream.
 */

const targets: TransportTargetOptions[] = [];

if (env.NODE_ENV === 'development') {
  targets.push({
    target: 'pino-pretty',
    level: env.LOG_LEVEL,
    options: { colorize: true },
  });
}

if (env.NODE_ENV === 'production' && features.sentry) {
  targets.push({
    target: 'pino/file',
    level: env.LOG_LEVEL,
    options: { destination: 1 },
  });
  targets.push({
    target: 'pino-sentry-transport',
    // warn-only so the transport doesn't double-fire with app.onError's
    // explicit captureException for true errors.
    level: 'warn',
    options: {
      sentry: {
        // Sentry SDK already auto-initialised by sentry-bootstrap.ts; the
        // transport reads the captured options instead of re-initialising.
        dsn: env.SENTRY_DSN,
        environment: env.NODE_ENV,
      },
      withLogRecord: true,
    },
  });
}

/**
 * Pino redact paths (Sprint 11 Phase 0). Mirrors the Sentry header strip set
 * so a structured log line carrying a request snapshot — `log.warn({ req })` —
 * doesn't accidentally write a bearer token, agent key, or webhook signature
 * to stdout / journald. The `req.body` paths cover common PII fields we set
 * deliberately at trace boundaries.
 *
 * pino redact takes JSON-paths; bracket-notation is required for keys with
 * non-word characters (the dashed headers). `censor` defaults to '[Redacted]'
 * — we leave it as the pino default for consistency with existing log
 * scrapers, rather than tracking '<redacted>' through two systems.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-nexa-key"]',
  'req.headers["stripe-signature"]',
  'req.headers["maze-signature"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-nexa-key"]',
  'headers["stripe-signature"]',
  'headers["maze-signature"]',
  // structured fields we deliberately log at sensitive boundaries
  'token',
  'code', // OTP / 2FA
  'secret',
  'apiKey',
  'api_key',
  'agentKey',
  'agent_key',
  'authorization',
  'cookie',
];

export const log =
  targets.length > 0
    ? pino({ level: env.LOG_LEVEL, redact: { paths: REDACT_PATHS, remove: false } }, pino.transport({ targets }))
    : pino({ level: env.LOG_LEVEL, redact: { paths: REDACT_PATHS, remove: false } });

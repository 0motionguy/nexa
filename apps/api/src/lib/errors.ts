/**
 * Structured error normalizer for the Hono surface.
 *
 * Provides:
 *   - ApiError class — typed shorthand for the 4xx/5xx codes the API surfaces.
 *     Routes throw `ApiError.badRequest(msg)`; the global handler renders the
 *     wire shape so we never hand-write `c.json({ ok: false, error: '…' }, 4xx)`
 *     at the call site again.
 *   - errorHandler middleware — wired into `app.onError` in apps/api/src/index.ts.
 *     Branches on instanceof ApiError → carry status + code; ZodError → 422 with
 *     flattened field-level details; everything else → 500 internal + Sentry
 *     capture (preserves δ's existing capture inside the previous inline
 *     handler).
 *
 * Wire shape (stable across every branch):
 *   { ok: false, error: { code, message, requestId, details? } }
 *
 * Sprint 10 adopts this in routes/admin.ts and routes/payments.ts as exemplars.
 * Broader migration across the other ~28 route files is Sprint 11 — the handler
 * is back-compat with the existing `c.json({ ok: false, error: '…' }, 4xx)`
 * shape so the existing wire contract continues to hold.
 */

import type { Context } from 'hono';
import { ZodError } from 'zod';
import { log } from './log.js';
import { captureException } from './sentry.js';
import { httpErrors } from './metrics.js';
import { features } from './env.js';

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable_entity'
  | 'too_many_requests'
  | 'service_unavailable'
  | 'internal';

/**
 * The HTTP statuses we surface from the API. Pinning to a union keeps the
 * Hono `c.json(payload, status)` overload happy without depending on a hono
 * internal `hono/utils/http-status` re-export (which has shifted location across
 * 4.x minors). New statuses can be added one at a time.
 */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ApiErrorStatus;
  readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    status: ApiErrorStatus,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static badRequest(msg: string, details?: unknown): ApiError {
    return new ApiError('bad_request', 400, msg, details);
  }
  static unauthorized(msg = 'unauthorized'): ApiError {
    return new ApiError('unauthorized', 401, msg);
  }
  static forbidden(msg = 'forbidden'): ApiError {
    return new ApiError('forbidden', 403, msg);
  }
  static notFound(msg = 'not found'): ApiError {
    return new ApiError('not_found', 404, msg);
  }
  static conflict(msg: string, details?: unknown): ApiError {
    return new ApiError('conflict', 409, msg, details);
  }
  static unprocessable(zod: ZodError): ApiError {
    return new ApiError('unprocessable_entity', 422, 'validation failed', zod.flatten().fieldErrors);
  }
  static tooManyRequests(msg = 'too many requests'): ApiError {
    return new ApiError('too_many_requests', 429, msg);
  }
  static serviceUnavailable(msg = 'service unavailable', details?: unknown): ApiError {
    return new ApiError('service_unavailable', 503, msg, details);
  }
  static internal(msg = 'internal error'): ApiError {
    return new ApiError('internal', 500, msg);
  }
}

interface ErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId?: string;
  details?: unknown;
}

/**
 * Hono error handler — call this from `app.onError(errorHandler)`. Always
 * returns a JSON response with `{ ok: false, error: { … } }`.
 *
 * Dedup with the pino-sentry transport (warn-level only) is preserved by
 * δ's wiring: we capture explicitly here for 5xx; the transport handles
 * warns; Sentry collapses duplicates by fingerprint.
 */
export function errorHandler(err: Error, c: Context): Response {
  const requestId = c.get('requestId') as string | undefined;
  const route = c.req.routePath ?? c.req.path;

  // F058 — bump the bucketed counter for every error branch. The status label
  // is bounded by the ApiErrorStatus union + 422 for Zod + 500 for unhandled.
  // Templated `route` keeps cardinality safe; nothing else gets stringified.
  const bumpHttpError = (status: number): void => {
    if (!features.metrics) return;
    httpErrors.inc({ method: c.req.method, route, status: String(status) });
  };

  if (err instanceof ApiError) {
    bumpHttpError(err.status);
    const body: ErrorBody = {
      code: err.code,
      message: err.message,
      ...(requestId ? { requestId } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
    return c.json({ ok: false, error: body }, err.status);
  }

  if (err instanceof ZodError) {
    bumpHttpError(422);
    const body: ErrorBody = {
      code: 'unprocessable_entity',
      message: 'validation failed',
      ...(requestId ? { requestId } : {}),
      details: err.flatten().fieldErrors,
    };
    return c.json({ ok: false, error: body }, 422);
  }

  bumpHttpError(500);
  // F087 Sprint 18 — thread userId into Sentry tags so operators can slice
  // by-user. requireSession sets c.set('user', user); for sessioned routes
  // this is always present. Anonymous routes (e.g. unauthenticated webhooks,
  // /healthz) leave it undefined and we tag without it.
  const sessionUser = c.get('user') as { id?: string } | undefined;
  const userId = sessionUser?.id;
  log.error(
    { err: err.message, stack: err.stack, requestId, route, ...(userId ? { userId } : {}) },
    'unhandled error',
  );
  captureException(err, {
    route,
    method: c.req.method,
    requestId,
    ...(userId ? { userId } : {}),
  });
  const body: ErrorBody = {
    code: 'internal',
    message: 'internal error',
    ...(requestId ? { requestId } : {}),
  };
  return c.json({ ok: false, error: body }, 500);
}

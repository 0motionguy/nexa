/**
 * Sprint 10 Phase 2 ε — lib/errors structured normalizer.
 *
 * Unit tests on the pure helpers + a small Hono harness for the wire shape
 * of errorHandler under the three branches: ApiError, ZodError, unknown.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { ApiError, errorHandler } from './errors.js';

function harness(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.onError(errorHandler);
  return app;
}

describe('ApiError factories', () => {
  it('carries the right code + status + message for each named factory', () => {
    expect(ApiError.badRequest('boom').code).toBe('bad_request');
    expect(ApiError.badRequest('boom').status).toBe(400);
    expect(ApiError.unauthorized().status).toBe(401);
    expect(ApiError.unauthorized().code).toBe('unauthorized');
    expect(ApiError.forbidden().status).toBe(403);
    expect(ApiError.notFound().status).toBe(404);
    expect(ApiError.conflict('x').status).toBe(409);
    expect(ApiError.tooManyRequests().status).toBe(429);
    expect(ApiError.internal().status).toBe(500);
  });

  it('badRequest carries details when provided', () => {
    const e = ApiError.badRequest('boom', { policyCode: 'insufficient_funds' });
    expect(e.details).toEqual({ policyCode: 'insufficient_funds' });
  });

  it('unprocessable wraps a ZodError and flattens fieldErrors into details', () => {
    const schema = z.object({ amountUsd: z.number().positive() });
    let zErr: ZodError | null = null;
    try {
      schema.parse({ amountUsd: -5 });
    } catch (e) {
      if (e instanceof ZodError) zErr = e;
    }
    expect(zErr).not.toBeNull();
    const wrapped = ApiError.unprocessable(zErr!);
    expect(wrapped.status).toBe(422);
    expect(wrapped.code).toBe('unprocessable_entity');
    expect(wrapped.details).toMatchObject({
      amountUsd: expect.any(Array),
    });
  });
});

describe('errorHandler — wire shape', () => {
  it('renders ApiError as { ok:false, error:{ code, message, requestId, details? } }', async () => {
    const app = harness();
    app.get('/boom', () => {
      throw ApiError.conflict('already paid', { paymentId: 'pi_123' });
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string; requestId: string; details: unknown } };
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: 'already paid',
        requestId: 'req-test',
        details: { paymentId: 'pi_123' },
      },
    });
  });

  it('renders ApiError without details when none were provided', async () => {
    const app = harness();
    app.get('/auth', () => {
      throw ApiError.unauthorized('admin token required');
    });
    const res = await app.request('/auth');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string; details?: unknown } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBe('admin token required');
    expect(body.error).not.toHaveProperty('details');
  });

  it('renders ZodError as 422 with field-level details', async () => {
    const app = harness();
    const schema = z.object({ amountUsd: z.number().positive() });
    app.post('/p', async (c) => {
      const body = (await c.req.json()) as unknown;
      // Throw directly so the handler branches on ZodError, not the zValidator
      // middleware path (which we cover indirectly through the route tests).
      schema.parse(body);
      return c.json({ ok: true });
    });
    const res = await app.request('/p', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountUsd: -5 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: { code: string; details: Record<string, unknown> } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unprocessable_entity');
    expect(body.error.details).toHaveProperty('amountUsd');
  });

  it('renders an unknown Error as 500 internal + still carries requestId', async () => {
    const app = harness();
    app.get('/oops', () => {
      throw new Error('something exploded');
    });
    const res = await app.request('/oops');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string; requestId: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal');
    // Don't leak the underlying error message to clients.
    expect(body.error.message).toBe('internal error');
    expect(body.error.requestId).toBe('req-test');
  });
});

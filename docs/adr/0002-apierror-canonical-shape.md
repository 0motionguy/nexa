# ADR-0002: Canonical `ApiError` response shape

## Status

Accepted (route migration complete; framework middleware follow-up remains)

## Date

2026-06-15

## Context

Route error responses in `apps/api/src/routes/*.ts` historically used an
ad-hoc shape per route, typically constructed inline:

```ts
return c.json({ ok: false, error: 'invalid_request' }, 400);
return c.json({ ok: false, error: 'not_found' }, 404);
return c.json({ ok: false, error: 'unauthorized' }, 401);
```

The `error` field is a free-form string. Three problems followed from this:

1. **No typed details.** Clients can't carry structured field-level error
   information (e.g., which Zod field failed, which idempotency key collided).
2. **SDK generation is broken.** Auto-generating a typed SDK from the
   OpenAPI spec (introduced in Sprint 12 Phase 1) requires a stable error
   envelope; a free-form string field type leaks `any` into every method.
3. **Inconsistency across routes.** Different routes used different error
   codes for similar conditions ("not_found" vs "missing" vs "no_such_resource"),
   and some routes returned `{ error: { code, message } }` while others
   returned `{ error: 'string' }`. Integrators had to special-case per route.

Listed as **F062** in `TECH_DEBT_AUDIT.md` (Sprint 13 deferred backlog).

## Decision

Adopt one canonical error envelope across every route:

```ts
{
  ok: false,
  error: {
    code: ApiErrorCode,     // bounded union — see below
    message: string,        // human-readable
    requestId?: string,     // injected by middleware when present
    details?: unknown,      // typed per-error structure (Zod fields, etc.)
  }
}
```

The shape lives in `apps/api/src/lib/errors.ts`. Routes throw via the static
factories on the `ApiError` class:

```ts
throw ApiError.badRequest('amount required');
throw ApiError.conflict('idempotency replay');
throw ApiError.notFound('offer');
throw ApiError.unauthorized();
throw ApiError.forbidden();
throw ApiError.tooManyRequests();
throw ApiError.unprocessable(zodError);
throw ApiError.internal();
```

The global `errorHandler` middleware (wired into `app.onError` in
`apps/api/src/index.ts`) renders the envelope. It also branches on:

- `instanceof ApiError` → carry the status + code declared on the instance.
- `instanceof ZodError` → 422 with `flatten().fieldErrors` in `details`.
- Anything else → 500 + Sentry capture + log line.

The bounded `ApiErrorCode` union is:

```ts
type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unprocessable_entity'
  | 'too_many_requests'
  | 'internal';
```

The bounded `ApiErrorStatus` union is:

```ts
type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;
```

## Drivers

- **SDK generation.** Stable typed envelope unblocks auto-generation of a typed
  client from the OpenAPI spec at `/v1/openapi.json`.
- **OpenAPI alignment.** One error response schema covers every route's
  4xx/5xx responses; the OpenAPI spec stays compact.
- **Typed structured details.** Clients can read `error.details.fieldErrors`
  for Zod validation failures without parsing message strings.
- **Route consistency.** Same code → same status → same message convention
  across the whole `/v1` surface.
- **Observability.** Status code + route + method are templated into the
  `http_errors_total` Prometheus counter; the bounded union keeps cardinality
  safe.

## Considered alternatives

### Hand-rolled per-route error responses

Rejected. The status quo before this ADR. Diverges over time as different
engineers add new routes with slightly different shapes. The OpenAPI / SDK
case alone makes this untenable.

### RFC-7807 Problem Details (`application/problem+json`)

Rejected. RFC-7807 specifies `{ type, title, status, detail, instance }` with
a content-type of `application/problem+json`. Three reasons against:

1. Too heavy for the current scale — content-type negotiation adds complexity
   without observable benefit when every client already expects JSON.
2. The `type` URI requirement (which should resolve to an HTML problem
   description page) is mostly ceremonial — no internal team would maintain
   the URIs.
3. The `details` field on the canonical envelope already covers the structured
   error case that RFC-7807 motivates.

We can revisit RFC-7807 if a federation or partner-integration use case ever
demands it; for now, the canonical envelope is sufficient.

### `{ ok: true | false }` discriminated union with arbitrary error payload

Rejected. The `ok: false` flag is already in the envelope (and load-bearing
for the OpenAPI response schema), but leaving the inner error free-form
defeats the whole purpose of typing the envelope.

## Important note (status code constraint)

**`ApiError`'s status union does NOT include 410 (Gone).** When refactoring
routes that previously returned 410 (e.g., "claim already taken / expired"),
**use 409 (Conflict)** as the closest semantically-aligned status the union
allows.

Example — `apps/api/src/routes/claim.ts` (Sprint 13 Round 5 fix):

```ts
// F062 — 410 isn't in ApiError's status union; use conflict (409) which is
// semantically closer for "claim already taken/expired" than 4xx generic.
if (!res) throw ApiError.conflict('unavailable');
```

The corresponding spec was updated to assert 409 (`claim.spec.ts`). 410 can
be added to the union if a future use case justifies it; today no route
strictly needs it.

## Consequences

### Positive

- Uniform shape across all migrated routes — clients can parse one envelope.
- Structured `details` field enables typed client-side error handling.
- OpenAPI-friendly — one error response schema covers every 4xx/5xx.
- Sentry + log capture is centralised in one handler (no duplicated
  `captureException` calls across routes).
- Prometheus `http_errors_total{method, route, status}` counter is wired into
  the handler; bounded label cardinality is safe.

### Negative

- A few framework-level middleware/fallback paths still render legacy string
  errors outside `apps/api/src/routes` (notably `src/lib/auth.ts` and
  `src/index.ts`).
- The migration must touch the call site **and** the matching spec file (the
  spec asserts the old shape). Routes with extensive spec coverage take
  longer to migrate.
- Future maintainers must remember the 410→409 substitution rule (documented
  here and inline at the call site).

## Migration status

**Route migration complete.** `rg --fixed-strings "error: '" apps/api/src/routes`
and `rg --fixed-strings 'error: "' apps/api/src/routes` now return no matches.

Most route errors use `throw ApiError.X(...)`. Routes that must preserve HTTP
statuses outside `ApiErrorStatus` keep inline responses, but still render the
same structured envelope (`{ ok: false, error: { code, message, details? } }`).
Current examples include 402 (`x402.ts`), 412/423/451/502/503
(`markets.ts`), 423/502 (`bridge.ts`), 502 and Stripe webhook 200 acks
(`offers.ts`), and sourced 503 responses in `card.ts`, `monerium.ts`,
`earn.ts`, and `onramp.ts`.

Remaining follow-up is outside the route migration: framework middleware and
fallback handlers in `apps/api/src/lib/auth.ts` and `apps/api/src/index.ts`
still have legacy string bodies.

## References

- Canonical implementation: `apps/api/src/lib/errors.ts`
- Wire-up: `apps/api/src/index.ts` (`app.onError(errorHandler)`)
- Original finding: `TECH_DEBT_AUDIT.md` F062
- Round 5 closure (410→409 substitution): `apps/api/src/routes/claim.ts:42-44`
- Round 5 spec update: `apps/api/src/routes/claim.spec.ts`
- Sprint 12 prep batch (~4 files): commit `ffebc95`
- Sprint 10 exemplar adoption: `apps/api/src/routes/admin.ts` and
  `apps/api/src/routes/payments.ts`
- Prometheus error counter: `httpErrors` in
  `apps/api/src/lib/metrics.ts` (wired in `errorHandler`)

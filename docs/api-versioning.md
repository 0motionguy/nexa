# API versioning + deprecation policy

**Scope.** The stable surface mounted at `/v1` ([apps/api/src/routes/v1.ts](../apps/api/src/routes/v1.ts)): offers, payments, payouts, sub-accounts, balance, subscriptions, plus the webhook callbacks (`payment.paid`, `subscription.renewed`, `payout.completed`). API-key authenticated via `sk_test_` / `sk_live_` keys.

The internal, browser-facing routes under `/auth`, `/ledger`, `/agent`, `/card`, `/earn`, `/markets`, `/campaigns`, `/perks`, `/bridge`, `/kyc`, `/x402`, `/admin` are NOT covered by this policy. They evolve alongside the web client and have no deprecation contract — they're a single deploy unit with the frontend.

## Compatibility contract for `/v1`

A change is **backward-compatible** (ship freely) if it:
- Adds a new optional field to a response
- Adds a new endpoint
- Adds a new optional header
- Adds a new event type to webhook callbacks
- Adds a new enum value to a field documented as "more values may be added in future" — today that's `Payment.status`, `Subscription.status`, and `Payout.status`

A change is **breaking** (requires the deprecation process below) if it:
- Removes or renames a field, header, endpoint, or event type
- Tightens validation on an input (a previously-accepted value is now rejected)
- Changes a response status code on a previously-supported path
- Changes the semantics of an existing field (e.g., `amountUsd` switching from dollars to cents)
- Removes an enum value from `Offer.type`, `Payout.method`, or any other field that today has a closed enum

## Deprecation process

Breaking changes ship through a parallel version (`/v2`) — never in-place on `/v1`.

1. **Announce.** Add a row to `CHANGELOG.md` under "Deprecations" with the date, the deprecated surface, and the replacement on `/v2`. Email any integrator listed in `support/integrators.txt` (today: none — first integrator triggers the file).
2. **Headers.** Every response from the deprecated `/v1` endpoint includes `Deprecation: true` and `Sunset: <RFC 9745 date>` (six months out, minimum). [RFC 9745 reference](https://datatracker.ietf.org/doc/html/rfc9745).
3. **Sunset window.** Minimum 6 months between announcement and removal. Longer if any integrator's last call against the deprecated path is inside the window — the sunset bumps to "last call + 6 months".
4. **Removal.** After the sunset date passes AND nobody has called the deprecated path for 30 days, remove it from `/v1`. The path returns `410 Gone` for 60 days, then `404`.

## Versions

| Version | Status | Sunset |
|---------|--------|--------|
| `/v1` | Active. Sole stable surface. | — |
| `/v2` | Not yet authored. | — |

When `/v2` ships, this table is the source of truth for what each version supports. `/v2` may share implementation code with `/v1` (most fields are stable) — versioning is a wire contract, not a code split.

## Idempotency

`/v1/offers`, `/v1/payments`, `/v1/payouts`, and `/v1/sub-accounts` accept an `Idempotency-Key` request header (Stripe + IETF RFC 9110 compatible). The server returns the original response for any retry with the same key.

- **Scope**: keys are scoped per **API key (seller)** — two different sellers can use the same key value without colliding. The compound unique constraint `(seller_id, idempotency_key)` was added in migration `0012_seller_scoped_idempotency_plus_indexes.sql` (F009).
- **TTL**: keys are deduplicated **forever** today. The on-disk row carries the original response indefinitely. Industry norm is 24 h; we'll match that the first time storage cost matters. **Policy**: until further notice, treat keys as "valid for as long as the corresponding payment/payout row exists." Don't recycle keys.
- **Header transport**: `Idempotency-Key` HTTP header is the canonical surface. Bridge withdraw also accepts a body field `idempotencyKey` for back-compat with the prior sandbox-card client; the header wins when both are present.

## OpenAPI spec

The `/v1` API is documented as OpenAPI 3.0.

- **Spec (JSON)**: `https://api.maze.bank/v1/openapi.json`
- **Interactive docs (Swagger UI)**: `https://api.maze.bank/v1/docs`

The spec is generated at runtime from Zod schemas in `packages/shared-zod` via [`@asteasolutions/zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi). Schemas are imported in [`apps/api/src/lib/openapi.ts`](../apps/api/src/lib/openapi.ts) and registered with one `registry.registerPath(...)` call per endpoint. The document is cached after first generation, so there's no per-request perf cost.

The Swagger UI shell is the unauthenticated [`@hono/swagger-ui`](https://github.com/honojs/middleware/tree/main/packages/swagger-ui) middleware, mounted at `/v1/docs` and pointing at `/v1/openapi.json` client-side.

### Adding a new endpoint

1. Define its request/response Zod schemas in `@nexa/shared-zod`.
2. Add a `registry.registerPath(...)` block in `apps/api/src/lib/openapi.ts` following the existing pattern: `method`, `path`, `summary`, `security: [{ ApiKeyAuth: [] }]`, request body (for POST/PATCH), response shapes per status code. Reuse the `IdParam`, `IdempotencyKeyHeader`, `Unauthorized`, `NotFound`, and `ValidationError` constants where they apply.
3. The round-trip in [`apps/api/src/lib/openapi.spec.ts`](../apps/api/src/lib/openapi.spec.ts) will catch missing summaries, missing 401 contracts, or missing response shapes the moment you save.

## Open questions

- Do we emit `API-Version` headers on responses today? No. When `/v2` lands, both versions should echo `API-Version: v1` / `API-Version: v2` so clients can verify they hit the version they expected.
- Do we want client SDKs versioned independently? Out of scope for this doc — decide when the first integration partner asks.

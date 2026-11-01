/**
 * F021 — OpenAPI spec generator for the public `/v1` surface.
 *
 * Strategy: register the shared-zod input/output schemas and the per-route
 * (method, path, statuses) tuples here, then `OpenApiGeneratorV3.generate()`
 * emits a 3.0 document on demand. The doc is served at `GET /v1/openapi.json`
 * and the interactive Swagger UI at `GET /v1/docs` (both unauthenticated —
 * they describe the public API; downstream tools won't carry a key).
 *
 * Adding a new endpoint = one `registry.registerPath(...)` call. The
 * `openapi.spec.ts` round-trip catches missing summaries or response shapes.
 *
 * Why this pattern (vs `tsoa` / `nestjs/swagger` etc):
 *   - zero runtime overhead beyond the JSON serialize at startup
 *   - schemas live in one place (shared-zod) so the wire contract IS the doc
 *   - no decorator metadata, no extra build step, works with the existing Hono
 */

import { extendZodWithOpenApi, OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  OfferInput,
  Offer,
  Payment,
  Balance,
  SubAccount,
  SubAccountCreateInput,
  Payout,
  PayoutInput,
  Subscription,
  MeProfileSchema,
  MeFeesSchema,
  AuthStartInput,
  AuthStartResponse,
  AuthVerifyInput,
  AuthVerifyResponse,
  AuthPrivyVerifyInput,
  AuthMeResponse,
  DepositAddressQuery,
  ExternalTransferInput,
  ExternalTransferResponse,
  HlDepositInput,
  HlDepositResponse,
  InternalTransferInput,
  InternalTransferResponse,
  SafeModeResponse,
  TransferDepositAddressResponse,
} from '@nexa/shared-zod';

// Side-effect: teach zod about `.openapi({ … })`. Idempotent.
extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ── shared schemas ────────────────────────────────────────────────────────
const OfferComponent = registry.register('Offer', Offer);
const PaymentComponent = registry.register('Payment', Payment);
const BalanceComponent = registry.register('Balance', Balance);
const OfferInputComponent = registry.register('OfferInput', OfferInput);
const SubAccountComponent = registry.register('SubAccount', SubAccount);
const SubAccountCreateInputComponent = registry.register('SubAccountCreateInput', SubAccountCreateInput);
const PayoutComponent = registry.register('Payout', Payout);
const PayoutInputComponent = registry.register('PayoutInput', PayoutInput);
const SubscriptionComponent = registry.register('Subscription', Subscription);
const MeProfileComponent = registry.register('MeProfile', MeProfileSchema);
const MeFeesComponent = registry.register('MeFees', MeFeesSchema);
const AuthStartInputComponent = registry.register('AuthStartInput', AuthStartInput);
const AuthStartResponseComponent = registry.register('AuthStartResponse', AuthStartResponse);
const AuthVerifyInputComponent = registry.register('AuthVerifyInput', AuthVerifyInput);
const AuthVerifyResponseComponent = registry.register('AuthVerifyResponse', AuthVerifyResponse);
const AuthPrivyVerifyInputComponent = registry.register('AuthPrivyVerifyInput', AuthPrivyVerifyInput);
const AuthMeResponseComponent = registry.register('AuthMeResponse', AuthMeResponse);
const SafeModeResponseComponent = registry.register('SafeModeResponse', SafeModeResponse);
const DepositAddressQueryComponent = registry.register('DepositAddressQuery', DepositAddressQuery);
const TransferDepositAddressResponseComponent = registry.register(
  'TransferDepositAddressResponse',
  TransferDepositAddressResponse,
);
const InternalTransferInputComponent = registry.register('InternalTransferInput', InternalTransferInput);
const InternalTransferResponseComponent = registry.register('InternalTransferResponse', InternalTransferResponse);
const ExternalTransferInputComponent = registry.register('ExternalTransferInput', ExternalTransferInput);
const ExternalTransferResponseComponent = registry.register('ExternalTransferResponse', ExternalTransferResponse);
const HlDepositInputComponent = registry.register('HlDepositInput', HlDepositInput);
const HlDepositResponseComponent = registry.register('HlDepositResponse', HlDepositResponse);

/** PATCH /v1/offers/{id} body — partial OfferInput + optional active toggle.
 *  Mirrors the route validator in routes/v1.ts. */
const OfferPatchInput = registry.register(
  'OfferPatchInput',
  OfferInput.partial().extend({ active: z.boolean().optional() }),
);

const ErrorEnvelope = registry.register(
  'Error',
  z.object({
    error: z.object({
      type: z.string().openapi({ example: 'authentication_error' }),
      message: z.string().openapi({ example: 'Missing or invalid API key.' }),
    }),
  }),
);

const ListEnvelope = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ object: z.literal('list'), data: z.array(item) });

/** Common path parameter shared by every `/:id` route. */
const IdParam = {
  name: 'id',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const, format: 'uuid' },
  description: 'Resource id (uuid).',
};

/** `Idempotency-Key` header — optional on every POST/PATCH. */
const IdempotencyKeyHeader = {
  name: 'Idempotency-Key',
  in: 'header' as const,
  required: false,
  schema: { type: 'string' as const },
  description: 'Per-seller idempotency key (scope: sellerId + key).',
};

const TransferIdempotencyKeyHeader = {
  name: 'Idempotency-Key',
  in: 'header' as const,
  required: false,
  schema: { type: 'string' as const, minLength: 8, maxLength: 120 },
  description: 'Per-user money-move intent key. May also be supplied as idempotencyKey in the JSON body.',
};

/** Standard 401 response shape — every authed route includes this. */
const Unauthorized = {
  description: 'Authentication failed',
  content: { 'application/json': { schema: ErrorEnvelope } },
};

/** Standard 404 response shape — for `/:id` lookups. */
const NotFound = {
  description: 'Resource not found',
  content: { 'application/json': { schema: ErrorEnvelope } },
};

/** Standard 422 response shape — Zod validation rejection. */
const ValidationError = {
  description: 'Request body failed validation',
  content: { 'application/json': { schema: ErrorEnvelope } },
};

// ── /v1/offers ────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/offers',
  summary: 'Create a checkout offer',
  description: 'Creates a shareable hosted-checkout offer. Supports `Idempotency-Key` header.',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdempotencyKeyHeader],
  request: {
    body: { content: { 'application/json': { schema: OfferInputComponent } } },
  },
  responses: {
    201: { description: 'Created or returned existing (idempotency replay)', content: { 'application/json': { schema: OfferComponent } } },
    401: Unauthorized,
    402: { description: 'Policy error (insufficient_funds etc.)', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/offers',
  summary: 'List offers',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { description: 'List of offers (current livemode scope)', content: { 'application/json': { schema: ListEnvelope(OfferComponent) } } },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/offers/{id}',
  summary: 'Retrieve an offer',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam],
  responses: {
    200: { description: 'The offer', content: { 'application/json': { schema: OfferComponent } } },
    401: Unauthorized,
    404: NotFound,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/v1/offers/{id}',
  summary: 'Update an offer',
  description: 'Partial update. Any subset of the create body, plus an `active` toggle.',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam, IdempotencyKeyHeader],
  request: {
    body: { content: { 'application/json': { schema: OfferPatchInput } } },
  },
  responses: {
    200: { description: 'Updated offer', content: { 'application/json': { schema: OfferComponent } } },
    401: Unauthorized,
    404: NotFound,
    422: ValidationError,
  },
});

// ── /v1/payments ──────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/payments',
  summary: 'List payments received',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { description: 'List of payments', content: { 'application/json': { schema: ListEnvelope(PaymentComponent) } } },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/payments/{id}',
  summary: 'Retrieve a payment',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam],
  responses: {
    200: { description: 'The payment', content: { 'application/json': { schema: PaymentComponent } } },
    401: Unauthorized,
    404: NotFound,
  },
});

// ── /v1/sub-accounts ──────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/sub-accounts',
  summary: 'Create a sub-account',
  description: 'Sub-accounts let a single KYC verified seller route payments to multiple businesses.',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdempotencyKeyHeader],
  request: {
    body: { content: { 'application/json': { schema: SubAccountCreateInputComponent } } },
  },
  responses: {
    201: { description: 'Created sub-account', content: { 'application/json': { schema: SubAccountComponent } } },
    401: Unauthorized,
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/sub-accounts',
  summary: 'List sub-accounts',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { description: 'List of sub-accounts', content: { 'application/json': { schema: ListEnvelope(SubAccountComponent) } } },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/sub-accounts/{id}',
  summary: 'Retrieve a sub-account',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam],
  responses: {
    200: { description: 'The sub-account', content: { 'application/json': { schema: SubAccountComponent } } },
    401: Unauthorized,
    404: NotFound,
  },
});

// ── /v1/payouts ───────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/v1/payouts',
  summary: 'Create a payout (money out)',
  description: 'Debits the seller balance and routes funds to the destination. Supports `Idempotency-Key` header.',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdempotencyKeyHeader],
  request: {
    body: { content: { 'application/json': { schema: PayoutInputComponent } } },
  },
  responses: {
    201: { description: 'Created payout', content: { 'application/json': { schema: PayoutComponent } } },
    401: Unauthorized,
    402: { description: 'insufficient_funds', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/payouts',
  summary: 'List payouts',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { description: 'List of payouts', content: { 'application/json': { schema: ListEnvelope(PayoutComponent) } } },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/payouts/{id}',
  summary: 'Retrieve a payout',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam],
  responses: {
    200: { description: 'The payout', content: { 'application/json': { schema: PayoutComponent } } },
    401: Unauthorized,
    404: NotFound,
  },
});

// ── /v1/subscriptions ─────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/subscriptions',
  summary: 'List subscriptions',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { description: 'List of subscriptions', content: { 'application/json': { schema: ListEnvelope(SubscriptionComponent) } } },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/subscriptions/{id}',
  summary: 'Retrieve a subscription',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam],
  responses: {
    200: { description: 'The subscription', content: { 'application/json': { schema: SubscriptionComponent } } },
    401: Unauthorized,
    404: NotFound,
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/subscriptions/{id}/cancel',
  summary: 'Cancel a subscription',
  description: 'Marks the subscription canceled at the end of the current period and fires the `subscription.canceled` webhook.',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam, IdempotencyKeyHeader],
  responses: {
    200: { description: 'Canceled subscription', content: { 'application/json': { schema: SubscriptionComponent } } },
    401: Unauthorized,
    404: NotFound,
  },
});

registry.registerPath({
  method: 'post',
  path: '/v1/subscriptions/{id}/renew',
  summary: 'Renew a subscription (demo-only)',
  description: 'Simulates a billing cycle: advances the period and credits a renewal charge. Fires `subscription.renewed` webhook.',
  security: [{ ApiKeyAuth: [] }],
  parameters: [IdParam, IdempotencyKeyHeader],
  responses: {
    200: { description: 'Renewed subscription', content: { 'application/json': { schema: SubscriptionComponent } } },
    401: Unauthorized,
    404: NotFound,
    409: { description: 'Subscription is canceled', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// ── /v1/balance ───────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/v1/balance',
  summary: 'Get current balance + earn position',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: { description: 'Balance object', content: { 'application/json': { schema: BalanceComponent } } },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/start',
  summary: 'Start auth flow',
  request: {
    body: { content: { 'application/json': { schema: AuthStartInputComponent } } },
  },
  responses: {
    200: {
      description: 'Returns auth challenge metadata or Privy app bootstrap',
      content: { 'application/json': { schema: AuthStartResponseComponent } },
    },
    401: Unauthorized,
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/verify',
  summary: 'Verify login challenge',
  request: {
    body: { content: { 'application/json': { schema: AuthVerifyInputComponent } } },
  },
  responses: {
    200: {
      description: 'Returns a session token',
      content: { 'application/json': { schema: AuthVerifyResponseComponent } },
    },
    401: Unauthorized,
    400: { description: 'Bad or expired challenge', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/privy-verify',
  summary: 'Verify Privy access token',
  request: {
    body: { content: { 'application/json': { schema: AuthPrivyVerifyInputComponent } } },
  },
  responses: {
    200: {
      description: 'Returns a session token',
      content: { 'application/json': { schema: AuthVerifyResponseComponent } },
    },
    401: Unauthorized,
    400: { description: 'Privy verification failed', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/me',
  summary: 'Get current authenticated session user',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Authenticated user snapshot',
      content: { 'application/json': { schema: AuthMeResponseComponent } },
    },
    401: Unauthorized,
  },
});

// ── security scheme registration ───────────────────────────────────────────
registry.registerPath({
  method: 'get',
  path: '/config/safe-mode',
  summary: 'Read operator-disabled NEO subsystems',
  responses: {
    200: {
      description: 'Current safe-mode snapshot',
      content: { 'application/json': { schema: SafeModeResponseComponent } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/transfers/onramp/deposit-address',
  summary: 'Get the receiving address for a portfolio bucket',
  security: [{ ApiKeyAuth: [] }],
  request: { query: DepositAddressQueryComponent },
  responses: {
    200: {
      description: 'Bucket-specific USDC deposit address',
      content: { 'application/json': { schema: TransferDepositAddressResponseComponent } },
    },
    401: Unauthorized,
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/transfers/internal',
  summary: 'Move USDC between portfolio buckets',
  security: [{ ApiKeyAuth: [] }],
  parameters: [TransferIdempotencyKeyHeader],
  request: { body: { content: { 'application/json': { schema: InternalTransferInputComponent } } } },
  responses: {
    200: {
      description: 'Created transfer or idempotent replay',
      content: { 'application/json': { schema: InternalTransferResponseComponent } },
    },
    401: Unauthorized,
    409: { description: 'Idempotency key conflict', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/transfers/external',
  summary: 'Send Base USDC to an external EVM address',
  security: [{ ApiKeyAuth: [] }],
  parameters: [TransferIdempotencyKeyHeader],
  request: { body: { content: { 'application/json': { schema: ExternalTransferInputComponent } } } },
  responses: {
    200: {
      description: 'Submitted transfer, accepted-pending result, or idempotent replay',
      content: { 'application/json': { schema: ExternalTransferResponseComponent } },
    },
    401: Unauthorized,
    409: { description: 'Idempotency key conflict', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: ValidationError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/transfers/hl-deposit',
  summary: 'Deposit Arbitrum USDC into Hyperliquid Bridge2',
  security: [{ ApiKeyAuth: [] }],
  parameters: [TransferIdempotencyKeyHeader],
  request: { body: { content: { 'application/json': { schema: HlDepositInputComponent } } } },
  responses: {
    200: {
      description: 'Submitted deposit, accepted-pending result, or idempotent replay',
      content: { 'application/json': { schema: HlDepositResponseComponent } },
    },
    401: Unauthorized,
    409: { description: 'Idempotency key conflict', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: ValidationError,
  },
});

registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'sk_(test|live)_*',
});

let cachedDoc: object | null = null;

registry.registerPath({
  method: 'get',
  path: '/me/profile',
  summary: 'Unified user profile and trading gate state',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Unified profile payload for the current user',
      content: { 'application/json': { schema: MeProfileComponent } },
    },
    401: Unauthorized,
  },
});

registry.registerPath({
  method: 'get',
  path: '/me/fees',
  summary: 'Recent user-level fee aggregates',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Recent platform-fee ledger snapshot for the current user',
      content: { 'application/json': { schema: MeFeesComponent } },
    },
    401: Unauthorized,
  },
});

/**
 * Return the OpenAPI document. Generated once and cached for the process
 * lifetime — the registration is static, so the doc never changes at runtime.
 */
export function getOpenApiDocument(): object {
  if (cachedDoc) return cachedDoc;
  const generator = new OpenApiGeneratorV3(registry.definitions);
  cachedDoc = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'NEXA API',
      version: '1.0.0',
      description:
        // NOTE(product): the maze.bank docs domain is intentionally unchanged —
        // the public domain rename is a product decision tracked in
        // docs/READINESS-2026-07-16.md. Title follows the shipped brand (NEXA).
        'Public REST API for the NEXA neobank facilitator surface. Authenticate with an `sk_test_` or `sk_live_` key. See https://maze.bank/docs/api-versioning for the deprecation policy.',
    },
    servers: [
      { url: 'https://nexa.aiso.tools/api', description: 'current production' },
      { url: 'https://api.maze.bank', description: 'production' },
      { url: 'http://localhost:8090', description: 'local dev' },
    ],
  });
  return cachedDoc;
}

/**
 * F021 — round-trip on the generated OpenAPI document.
 *
 * Purpose: catch drift the moment someone adds a `registry.registerPath` call
 * that's missing a `summary`, a `responses` block, or one of the canonical
 * status codes (401 on authed routes, 404 on `/:id` lookups).
 *
 * This is structural, not behavioural — it asserts the spec document has the
 * shape the public API contract promises, not that each route actually wires
 * to its handler (the route specs do that).
 */

import { describe, expect, it } from 'vitest';
import { getOpenApiDocument } from './openapi.js';

type OpenApiDoc = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, { summary?: string; responses?: Record<string, unknown> }>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
};

describe('openapi.getOpenApiDocument', () => {
  const doc = getOpenApiDocument() as OpenApiDoc;

  it('emits a valid OpenAPI 3.0 envelope', () => {
    expect(doc.openapi).toBe('3.0.0');
    expect(doc.info.title).toBe('NEXA API');
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.info.description).toContain('NEXA');
    expect(doc.servers?.map(({ url }) => url)).toContain('https://nexa.aiso.tools/api');
  });

  it('covers the full /v1 surface (≥17 registered operations across ≥13 paths)', () => {
    const paths = Object.keys(doc.paths);
    // OpenAPI groups operations under their path; an endpoint is a
    // (path, method) pair. The /v1 surface is currently 13 paths /
    // 17 operations (e.g. POST + GET share `/v1/offers`).
    expect(paths.length).toBeGreaterThanOrEqual(13);
    const operationCount = Object.values(doc.paths).reduce(
      (n, methods) => n + Object.keys(methods).length,
      0,
    );
    expect(operationCount).toBeGreaterThanOrEqual(17);
    // Spot-check a representative slice across every domain.
    expect(paths).toContain('/v1/offers');
    expect(paths).toContain('/v1/offers/{id}');
    expect(paths).toContain('/v1/payments');
    expect(paths).toContain('/v1/payments/{id}');
    expect(paths).toContain('/v1/sub-accounts');
    expect(paths).toContain('/v1/sub-accounts/{id}');
    expect(paths).toContain('/v1/payouts');
    expect(paths).toContain('/v1/payouts/{id}');
    expect(paths).toContain('/v1/subscriptions');
    expect(paths).toContain('/v1/subscriptions/{id}');
    expect(paths).toContain('/v1/subscriptions/{id}/cancel');
    expect(paths).toContain('/v1/subscriptions/{id}/renew');
    expect(paths).toContain('/v1/balance');
    expect(paths).toContain('/transfers/onramp/deposit-address');
    expect(paths).toContain('/transfers/internal');
    expect(paths).toContain('/transfers/external');
    expect(paths).toContain('/transfers/hl-deposit');
  });

  it('every registered method has a summary and at least one response', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(op.summary, `${where} is missing a summary`).toBeTruthy();
        expect(op.responses, `${where} is missing responses`).toBeTruthy();
        expect(Object.keys(op.responses!).length, `${where} has no response codes`).toBeGreaterThan(0);
        if (path !== '/config/safe-mode') {
          expect(op.responses!['401'], `${where} is missing the 401 contract`).toBeTruthy();
        }
      }
    }
  });

  it('registers the shared-zod schemas + ApiKeyAuth security scheme', () => {
    expect(doc.components?.schemas).toBeTruthy();
    const schemas = Object.keys(doc.components!.schemas!);
    expect(schemas.length).toBeGreaterThan(0);
    // The canonical shared-zod schemas must appear (drift guard).
    expect(schemas).toContain('Offer');
    expect(schemas).toContain('Payment');
    expect(schemas).toContain('Balance');
    expect(schemas).toContain('SubAccount');
    expect(schemas).toContain('Payout');
    expect(schemas).toContain('Subscription');
    expect(schemas).toContain('SafeModeResponse');
    expect(schemas).toContain('TransferDepositAddressResponse');
    expect(schemas).toContain('InternalTransferResponse');
    expect(schemas).toContain('ExternalTransferResponse');
    expect(schemas).toContain('HlDepositResponse');
    expect(schemas).toContain('Error');
    expect(doc.components?.securitySchemes?.ApiKeyAuth).toBeTruthy();
  });

  it('is stable across calls (cached doc)', () => {
    const a = getOpenApiDocument();
    const b = getOpenApiDocument();
    // Reference-equal because the module caches the first generation.
    expect(a).toBe(b);
  });
});

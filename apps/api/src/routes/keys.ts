/**
 * API-key management (/keys) — session-authed, because issuing and revoking
 * keys is a human dashboard action, not something an API key can do to itself.
 *
 * Stays on the app `{ ok: … }` envelope (this is the seller app surface, not
 * the public /v1 API). The raw secret crosses the wire exactly once: in the
 * POST response. listApiKeys returns masked keys (last4 only) thereafter.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ApiKeyCreateInput } from '@nexa/shared-zod';
import { requireSession } from '../lib/auth.js';
import { store } from '../store/index.js';
import { emitAudit } from '../lib/audit.js';

export const keyRoutes = new Hono();

keyRoutes.use('*', requireSession);

keyRoutes.post('/', zValidator('json', ApiKeyCreateInput), async (c) => {
  const u = c.get('user');
  const body = c.req.valid('json');
  const created = await store.createApiKey(u, body.label ?? null, body.livemode);
  // F066 — every key issuance generates a forensic row (mode + last4 only;
  // never the raw secret).
  emitAudit(c, {
    action: 'key.created',
    actorType: 'user',
    actorId: u.id,
    targetType: 'api_key',
    targetId: created.id,
    metadata: { livemode: body.livemode, label: body.label ?? null, last4: created.last4 },
  });
  // Only response that carries `secret` — show it once, store hashed.
  return c.json(created, 201);
});

keyRoutes.get('/', async (c) => {
  const u = c.get('user');
  const keys = await store.listApiKeys(u);
  return c.json({ object: 'list', data: keys });
});

keyRoutes.delete('/:id', async (c) => {
  const u = c.get('user');
  const id = c.req.param('id');
  // Sprint 12 Phase 0 — Stripe/Twilio idempotency semantics. Unknown id →
  // 200 with revoked:false (re-deleting an unknown resource is fine). Owned
  // id → 200 with revoked:true whether or not the row was already revoked.
  const result = await store.revokeApiKey(u, id);
  // F066 — log every revoke attempt, including no-op revokes on unknown ids
  // so we can spot scan-like behaviour against the keys surface.
  emitAudit(c, {
    action: 'key.revoked',
    actorType: 'user',
    actorId: u.id,
    targetType: 'api_key',
    targetId: id,
    metadata: { revoked: Boolean(result) },
  });
  return c.json({ ok: true, revoked: Boolean(result) });
});

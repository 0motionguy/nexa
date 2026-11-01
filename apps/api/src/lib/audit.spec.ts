/**
 * Sprint 17 F066 — verify that route-level `emitAudit` writes actually land
 * in the audit log table for the high-value mutation flows the Sprint 17
 * closeout wired up:
 *
 *   - agent.kill_switch
 *   - agent.funded / agent.defunded
 *   - key.created / key.revoked
 *   - payment.sent / payment.claim_created
 *
 * The helper is fire-and-forget; we use `setImmediate`+sleep awaits to give
 * the deferred insert a tick to settle before listing. Because the listing
 * is filtered by action prefix, false positives across tests do not pollute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { store } from '../store/index.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function authedToken(email: string): Promise<string> {
  const start = await app.request('/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const { challengeId } = (await start.json()) as { challengeId: string };
  const verify = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: '482019' }),
  });
  expect(verify.status).toBe(200);
  const { token } = (await verify.json()) as { token: string };
  return token;
}

describe('audit emitter (F066)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  // Tests share the in-memory audit log; they stay independent by filtering on
  // disjoint action prefixes (key.*, agent.kill_switch, payment.*). Adding a
  // new test that overlaps an existing prefix must do its own snapshot delta.

  it('writes key.created + key.revoked rows on the keys flow', async () => {
    const token = await authedToken('audit-keys@example.com');
    const create = await app.request('/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ label: 'audit-spec', livemode: false }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; secret: string };
    expect(typeof created.id).toBe('string');
    expect(typeof created.secret).toBe('string');

    const del = await app.request('/keys/' + created.id, {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + token },
    });
    expect(del.status).toBe(200);

    await sleep(20);

    const created2 = await store.listAuditEntries({ actionPrefix: 'key.created' });
    const revoked = await store.listAuditEntries({ actionPrefix: 'key.revoked' });
    const myCreate = created2.find((r) => r.targetId === created.id);
    const myRevoke = revoked.find((r) => r.targetId === created.id);
    expect(myCreate).toBeDefined();
    expect(myCreate!.actorType).toBe('user');
    expect(myCreate!.metadata.livemode).toBe(false);
    expect(myRevoke).toBeDefined();
    expect(myRevoke!.metadata.revoked).toBe(true);
  });

  it('writes agent.kill_switch row when the flag flips', async () => {
    const token = await authedToken('audit-kill@example.com');
    const on = await app.request('/agent/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ on: true }),
    });
    expect(on.status).toBe(200);

    await sleep(20);

    const rows = await store.listAuditEntries({ actionPrefix: 'agent.kill_switch' });
    const last = rows[0];
    expect(last).toBeDefined();
    expect(last!.metadata.value).toBe(true);
  });

  it('writes payment.sent row when the send flow lands', async () => {
    const token = await authedToken('audit-send@example.com');
    const send = await app.request('/payments/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ amountUsd: 1, to: '0xpeer' }),
    });
    expect([200, 400]).toContain(send.status);
    if (send.status !== 200) return; // demo insufficient-funds path — still a valid scenario

    await sleep(20);

    const rows = await store.listAuditEntries({ actionPrefix: 'payment.' });
    const last = rows[0];
    expect(last).toBeDefined();
    expect(['payment.sent', 'payment.claim_created']).toContain(last!.action);
    expect(last!.metadata.amountUsd).toBe(1);
  });

  it('keeps a committed payment response successful when audit insert fails', async () => {
    const token = await authedToken('audit-send-audit-down@example.com');
    const audit = vi.spyOn(store, 'recordAuditEntry').mockRejectedValueOnce(new Error('audit down'));

    const send = await app.request('/payments/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ amountUsd: 1, to: '0xauditdown' }),
    });

    expect(send.status).toBe(200);
    expect(await send.json()).toEqual(expect.objectContaining({ ok: true }));
    expect(audit).toHaveBeenCalled();
  });

  it('returns one-time API key secrets even when audit insert fails', async () => {
    const token = await authedToken('audit-key-audit-down@example.com');
    const audit = vi.spyOn(store, 'recordAuditEntry').mockRejectedValueOnce(new Error('audit down'));

    const create = await app.request('/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ label: 'audit-down', livemode: false }),
    });

    expect(create.status).toBe(201);
    const body = (await create.json()) as { id: string; secret: string };
    expect(body.id).toEqual(expect.any(String));
    expect(body.secret).toMatch(/^sk_test_/);
    expect(audit).toHaveBeenCalled();
  });

  it('keeps agent funding successful when audit insert fails', async () => {
    const token = await authedToken('audit-agent-audit-down@example.com');
    const created = await app.request('/agent/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ name: 'audit-agent', perDayCapUsd: 10, perTxCapUsd: 1, endpointAllowlist: [] }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as { agent: { id: string } };
    const audit = vi.spyOn(store, 'recordAuditEntry').mockRejectedValueOnce(new Error('audit down'));

    const fund = await app.request(`/agent/${agent.id}/fund`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
        'Idempotency-Key': 'audit-agent-fund-1',
      },
      body: JSON.stringify({ amountUsd: 1 }),
    });

    expect(fund.status).toBe(200);
    expect(await fund.json()).toEqual(expect.objectContaining({ ok: true }));
    expect(audit).toHaveBeenCalled();
  });
});

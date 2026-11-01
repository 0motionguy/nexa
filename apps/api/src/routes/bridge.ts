/**
 * Bridge.xyz routes — KYC customer + fiat virtual accounts + deposit webhook
 * + (Sprint 10 Item B) offramp: payout methods, withdrawals, transfer webhook.
 *
 * The authed sub-routes (session JWT) provision Bridge objects and persist them
 * via the store. The deposit and transfer webhooks are PUBLIC (Bridge has no
 * session) — each verifies the HMAC signature, resolves the owner from the
 * customer id / transfer ref, and applies the ledger effect via the store.
 * Both always 200-ack so Bridge doesn't retry-storm, and dedupe — the deposit
 * path on `nb_bridge_webhook_events.ref`, the transfer path on the
 * `nb_bridge_transfers.status` transition.
 *
 * Everything degrades to demo when BRIDGE_API_KEY is unset (see lib/chain/bridge).
 * The withdraw handler additionally schedules a synthetic completion in demo so
 * the round-trip closes without a real Bridge contract.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { BridgeWithdrawInput, PayoutMethodCreateInput } from '@nexa/shared-zod';
import { requireSession } from '../lib/auth.js';
import { features } from '../lib/env.js';
import { log } from '../lib/log.js';
import * as bridge from '../lib/chain/bridge.js';
import { store } from '../store/index.js';
import { PolicyError } from '../store/types.js';
import { fireWebhooks } from '../lib/webhooks.js';
import { ApiError } from '../lib/errors.js';

export const bridgeRoutes = new Hono();

type PayoutMethodType = 'ach' | 'sepa' | 'wire' | 'crypto';

function detailValue(
  details: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function requirePayoutDestinationDetails(
  type: PayoutMethodType,
  details: Record<string, unknown> | undefined,
): void {
  if (type === 'crypto') return;

  if (type === 'ach') {
    const account = detailValue(details, ['account', 'accountNumber']);
    const routing = detailValue(details, ['routing', 'routingNumber']);
    if (!account || !routing) {
      throw ApiError.badRequest('bank_account_details_required', {
        type,
        missing: [
          ...(!account ? ['account'] : []),
          ...(!routing ? ['routing'] : []),
        ],
      });
    }
    return;
  }

  const account = detailValue(details, ['account', 'accountNumber', 'iban']);
  if (!account) {
    throw ApiError.badRequest('bank_account_details_required', {
      type,
      missing: [type === 'sepa' ? 'iban' : 'account'],
    });
  }
}

function bridgeStructuredError(c: Context, status: 423 | 502, code: string): Response {
  return c.json({ ok: false, error: { code, message: code } }, status);
}

function bridgeUpstreamError(c: Context, code: string): Response {
  // F062: 502 is outside ApiErrorStatus, so keep gateway semantics inline.
  return bridgeStructuredError(c, 502, code);
}

function bridgeReconciliationRequired(c: Context, transfer: unknown): Response {
  return c.json(
    {
      ok: false,
      transfer,
      error: {
        code: 'bridge_transfer_reconciliation_required',
        message: 'bridge_transfer_reconciliation_required',
      },
    },
    503,
  );
}

function accountFrozenError(c: Context): Response {
  // F062: 423 is outside ApiErrorStatus, so keep locked-account semantics inline.
  return bridgeStructuredError(c, 423, 'account_frozen');
}

/* ── authed: customer + virtual accounts ────────────────────────────────── */

bridgeRoutes.post('/customer', requireSession, async (c) => {
  const u = c.get('user');
  if (u.bridgeCustomerId) {
    return c.json({ ok: true, customerId: u.bridgeCustomerId, kycUrl: null });
  }

  try {
    const { customerId, kycUrl } = await bridge.createCustomer({ email: u.email, name: u.name });
    await store.setBridgeCustomer(u, customerId);
    return c.json({ ok: true, customerId, kycUrl });
  } catch (e) {
    const error = e instanceof bridge.BridgeProvisioningError ? e.code : 'bridge_customer_failed';
    return bridgeUpstreamError(c, error);
  }
});

bridgeRoutes.post(
  '/virtual-account',
  requireSession,
  zValidator('json', z.object({ currency: z.enum(['USD', 'EUR']) })),
  async (c) => {
    const u = c.get('user');
    const { currency } = c.req.valid('json');

    try {
      // A virtual account needs a Bridge customer — create one on the fly if missing.
      let customerId = u.bridgeCustomerId;
      if (!customerId) {
        const created = await bridge.createCustomer({ email: u.email, name: u.name });
        customerId = created.customerId;
        await store.setBridgeCustomer(u, customerId);
      }

      const va = await bridge.createVirtualAccount(customerId, currency);
      const account = await store.saveVirtualAccount(u, va);
      return c.json({ ok: true, account });
    } catch (e) {
      const error = e instanceof bridge.BridgeProvisioningError ? e.code : 'bridge_virtual_account_failed';
      return bridgeUpstreamError(c, error);
    }
  },
);

bridgeRoutes.get('/accounts', requireSession, async (c) => {
  const u = c.get('user');
  return c.json({ ok: true, accounts: await store.listVirtualAccounts(u) });
});

/* ── authed: offramp payout methods + withdrawals (Item B) ─────────────── */

/**
 * Register a payout destination (bank / crypto) on the user's Bridge customer.
 * Creates a customer on the fly if one doesn't exist yet (same lift-out as
 * /virtual-account). Persists the resulting external_account_id locally so
 * /bridge/withdraw can target it without re-asking Bridge.
 */
bridgeRoutes.post(
  '/payout-method',
  requireSession,
  zValidator('json', PayoutMethodCreateInput),
  async (c) => {
    const u = c.get('user');
    const { type, label, accountDetails } = c.req.valid('json');
    requirePayoutDestinationDetails(type, accountDetails);
    try {
      let customerId = u.bridgeCustomerId;
      if (!customerId) {
        const created = await bridge.createCustomer({ email: u.email, name: u.name });
        customerId = created.customerId;
        await store.setBridgeCustomer(u, customerId);
      }

      const { externalAccountId, livemode } = await bridge.createExternalAccount(customerId, {
        type,
        label,
        details: accountDetails ?? {},
      });
      const method = await store.savePayoutMethod(u, {
        type,
        externalAccountId,
        label,
        livemode,
      });
      return c.json({ ok: true, method });
    } catch (e) {
      const error =
        e instanceof bridge.BridgeProvisioningError ? e.code : 'bridge_external_account_failed';
      return bridgeUpstreamError(c, error);
    }
  },
);

bridgeRoutes.get('/payout-methods', requireSession, async (c) => {
  const u = c.get('user');
  return c.json({ ok: true, methods: await store.listPayoutMethods(u) });
});

/**
 * Initiate a withdrawal from the user's MAZE balance to a registered payout
 * method. Kill-switch honored. auto-divest-on-spend honored (Item A).
 * Insufficient funds → 400. Bridge failure → 502 + refund. Demo mode schedules
 * a synthetic completion on the next tick so the round-trip closes for the UI.
 */
bridgeRoutes.post(
  '/withdraw',
  requireSession,
  zValidator('json', BridgeWithdrawInput),
  async (c) => {
    const u = c.get('user');
    const { payoutMethodId, amountUsd, idempotencyKey: bodyIdempotencyKey } = c.req.valid('json');

    if (u.killSwitch) {
      return accountFrozenError(c);
    }
    const methods = await store.listPayoutMethods(u);
    const method = methods.find((m) => m.id === payoutMethodId);
    if (!method) {
      throw ApiError.notFound('payout_method_not_found');
    }
    if (method.status !== 'active') {
      throw ApiError.badRequest('payout_method_disabled');
    }
    if (!u.bridgeCustomerId) {
      throw ApiError.badRequest('bridge_customer_missing');
    }

    const idempotencyKey =
      (c.req.header('Idempotency-Key') ?? bodyIdempotencyKey ?? '').trim();
    if (!idempotencyKey) {
      throw ApiError.badRequest('idempotency_key_required');
    }
    if (idempotencyKey.length > 120) {
      throw ApiError.badRequest('invalid_idempotency_key');
    }

    let reserved: Awaited<ReturnType<typeof store.createBridgeTransferDebit>>;
    try {
      reserved = await store.createBridgeTransferDebit(u, {
        payoutMethodId: method.id,
        amountUsd,
        idempotencyKey,
        label: 'Bank - ' + method.label,
      });
    } catch (e) {
      if (e instanceof PolicyError) {
        throw ApiError.badRequest(e.message, { policyCode: e.code });
      }
      throw e;
    }

    if (!reserved.fresh) {
      if (
        reserved.transfer.payoutMethodId !== method.id ||
        Math.abs(reserved.transfer.amountUsd - amountUsd) > 0.005
      ) {
        throw ApiError.conflict('idempotency_key_reused', {
          transferId: reserved.transfer.id,
          originalAmountUsd: reserved.transfer.amountUsd,
          originalPayoutMethodId: reserved.transfer.payoutMethodId,
        });
      }
      if (reserved.transfer.status === 'pending' && !reserved.transfer.externalRef) {
        log.warn(
          { localTransferId: reserved.transfer.id, idempotencyKey },
          'bridge: replay hit pending transfer without external ref',
        );
        return bridgeReconciliationRequired(c, reserved.transfer);
      }
      if (reserved.transfer.status === 'failed') {
        throw ApiError.conflict('idempotency_key_used', { transferId: reserved.transfer.id, status: reserved.transfer.status });
      }
      return c.json({ ok: true, transfer: reserved.transfer });
    }

    let externalRef: string;
    let transfer: typeof reserved.transfer;
    try {
      const tr = await bridge.createTransfer({
        source: { customerId: u.bridgeCustomerId },
        destination: { externalAccountId: method.externalAccountId, type: method.type },
        amountUsd,
        idempotencyKey,
      });
      externalRef = tr.externalRef;
    } catch (e) {
      if (
        e instanceof bridge.BridgeProvisioningError &&
        e.code === 'bridge_transfer_failed' &&
        e.ambiguous
      ) {
        log.warn(
          {
            localTransferId: reserved.transfer.id,
            idempotencyKey,
            err: e.message,
          },
          'bridge: transfer submission ambiguous; leaving debit pending',
        );
        return bridgeReconciliationRequired(c, reserved.transfer);
      }
      await store.failBridgeTransferById(reserved.transfer.id);
      const error =
        e instanceof bridge.BridgeProvisioningError ? e.code : 'bridge_transfer_failed';
      return bridgeUpstreamError(c, error);
    }

    try {
      transfer = await store.setBridgeTransferExternalRef(reserved.transfer.id, externalRef);
    } catch (e) {
      log.error(
        {
          localTransferId: reserved.transfer.id,
          externalRef,
          err: e instanceof Error ? e.message : String(e),
        },
        'bridge: transfer created but local ref persistence failed',
      );
      return bridgeUpstreamError(c, 'bridge_transfer_persist_failed');
    }

    // Demo mode: close the round-trip synthetically. setImmediate yields to the
    // route's response cycle first so the client sees the pending transfer,
    // then the next tick flips it to completed (same shape the real webhook
    // would produce).
    if (!features.bridge) {
      setImmediate(() => {
        store
          .markTransferStatus(externalRef, 'completed')
          .catch((err) =>
            log.warn(
              { externalRef, err: err instanceof Error ? err.message : String(err) },
              'bridge: synthetic completion failed',
            ),
          );
      });
    }

    return c.json({ ok: true, transfer });
  },
);

/* ── public: deposit webhook ────────────────────────────────────────────── */

bridgeRoutes.post('/webhook', async (c) => {
  const raw = await c.req.text();
  if (!bridge.verifyWebhook(c.req.header('X-Bridge-Signature') ?? null, raw)) {
    throw ApiError.badRequest('invalid_signature');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON — ack anyway so Bridge stops retrying a bad payload.
    return c.json({ ok: true });
  }

  const ev = bridge.parseDepositEvent(parsed);
  if (ev) await store.applyBridgeDeposit(ev.customerId, ev.amountUsd, ev.ref);

  return c.json({ ok: true });
});

/* ── public: transfer (offramp) webhook ─────────────────────────────────── */

/**
 * Bridge fires this for transfer.completed / transfer.failed (or failed
 * variants). Verifies the same HMAC; idempotent via markTransferStatus
 * returning null when the row is already in the target state.
 *
 * On success, fans out a transfer.completed event to the user's seller
 * webhooks (so a developer surface sees the settlement). On failed, the store
 * has already credited the balance back; we forward transfer.failed so any
 * developer monitoring knows the rollback happened.
 */
bridgeRoutes.post('/transfer-webhook', async (c) => {
  const raw = await c.req.text();
  if (!bridge.verifyWebhook(c.req.header('X-Bridge-Signature') ?? null, raw)) {
    throw ApiError.badRequest('invalid_signature');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ ok: true });
  }

  const ev = bridge.parseTransferEvent(parsed);
  if (!ev) return c.json({ ok: true });

  const user = await store.userForBridgeTransfer(ev.ref);
  const transfer = await store.markTransferStatus(ev.ref, ev.status, {
    amountUsd: ev.amountUsd,
    externalAccountId: ev.externalAccountId,
  });

  if (user && transfer) {
    const endpoints = await store.webhooksForSeller(user.id);
    void fireWebhooks(endpoints, {
      id: transfer.id,
      type: ev.status === 'completed' ? 'transfer.completed' : 'transfer.failed',
      created: new Date().toISOString(),
      data: { transfer },
    });
  }

  return c.json({ ok: true });
});

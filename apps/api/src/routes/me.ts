/**
 * /me — unified user-state surface. Aggregates everything a Neo / third-party
 * client needs to render a profile or gate trading across all 6 venues in
 * ONE request:
 *
 *   - identity            (id, email, name, kyc tier, geo)
 *   - wallets             (Privy EVM, Privy Solana, walletAddress)
 *   - balances            (balUsd, earnUsd, earnApy)
 *   - trading eligibility (HL backend builder agreement, PM CLOB creds,
 *                          region gating, kill switch, feature flags per-venue)
 *   - fees collected      (per-user view, aggregated from the fee tracker)
 *
 * This replaces calls to /auth/me + /markets/hyperliquid/builder-status +
 * /markets/polymarket/positions + ... with a single roundtrip.
 *
 * Auth: session JWT OR API key (so third-party clients can read on behalf
 *       of a user via sk_*).
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireSession, requireApiKey } from '../lib/auth.js';
import { env, features } from '../lib/env.js';
import { hyperliquid } from '../lib/markets/hyperliquid.js';
import { hyperliquidSpot } from '../lib/markets/hyperliquid-spot.js';
import { hyperliquidHip3 } from '../lib/markets/hyperliquid-hip3.js';
import { jupiter } from '../lib/markets/jupiter.js';
import { polymarket } from '../lib/markets/polymarket.js';
import { isLiveWriteCountryAllowed, isRegionExemptUser } from '../lib/markets/region.js';
import { configuredRateBps, summarizeFees } from '../lib/fees.js';
import { store } from '../store/index.js';
import type { ExpoPushSubscriptionRecord } from '../store/types.js';
import {
  MeProfileSchema,
  MeFeesSchema,
  MeDeviceSchema,
  MeDevicesResponseSchema,
  NotificationPreferencesSchema,
} from '@nexa/shared-zod';

export const meRoutes = new Hono();

/**
 * Accept either a session JWT (mobile/web client) or an API key (third-party
 * server). API key auth runs first; if absent, fall through to session.
 */
async function authSessionOrApiKey(c: Context, next: Next) {
  const authz = c.req.header('Authorization') ?? '';
  if (authz.startsWith('Bearer sk_')) {
    return requireApiKey(c, next);
  }
  return requireSession(c, next);
}

meRoutes.use('*', authSessionOrApiKey);

/**
 * Unified profile aggregator. ONE call returns the full per-user state
 * across identity, wallets, balances, KYC, geo, and per-venue trading
 * gates. The response is stable JSON keyed for forward compatibility:
 * new venues add new entries under `trading`, not new top-level fields.
 */
meRoutes.get('/profile', async (c) => {
  const u = c.get('user');
  const livemode = c.get('livemode');
  const region = c.req.header('cf-ipcountry') ?? null;

  // Region state MUST mirror the tradeGate (same shared list, same explicit
  // exemption) or the client enables actions the API then answers with 451.
  const regionExempt = isRegionExemptUser(u);
  const regionAllowed = (venue: string): boolean =>
    !region || regionExempt || isLiveWriteCountryAllowed(venue, region);

  // Per-venue trading eligibility — each entry self-describes why it's
  // unavailable (missing wallet, region block, feature flag) so the client
  // can render the right gate without a second roundtrip.
  const evmWallet = u.privyWalletId && u.privyWalletAddress
    ? { walletId: u.privyWalletId, address: u.privyWalletAddress }
    : null;

  const trading = {
    'hyperliquid': {
      enabled: hyperliquid.isLive,
      liveTrading: hyperliquid.isLiveTrading,
      regionAllowed: regionAllowed('hyperliquid'),
      walletReady: Boolean(evmWallet),
      builderApproved: Boolean(u.hlBuilderApprovedAt),
      builderMaxFeeTenthsBp: u.hlBuilderMaxFeeTenthsBp ?? null,
      feeBps: configuredRateBps('hyperliquid').bps,
    },
    'hyperliquid-spot': {
      enabled: hyperliquidSpot.isLive,
      liveTrading: hyperliquidSpot.isLiveTrading,
      regionAllowed: regionAllowed('hyperliquid-spot'),
      walletReady: Boolean(evmWallet),
      feeBps: 0,
    },
    'hyperliquid-hip3': {
      enabled: hyperliquidHip3.isLive,
      liveTrading: hyperliquidHip3.isLiveTrading,
      regionAllowed: regionAllowed('hyperliquid-hip3'),
      walletReady: Boolean(evmWallet),
      builderApproved: Boolean(u.hlBuilderApprovedAt),
      feeBps: configuredRateBps('hyperliquid-hip3').bps,
      dex: 'xyz',
    },
    'jupiter': {
      enabled: jupiter.isLive,
      liveTrading: jupiter.isLiveTrading,
      // Was hardcoded true while the order gate blocked the same countries —
      // the UI showed swap enabled, then the API 451'd. Report the gate truth.
      regionAllowed: regionAllowed('jupiter'),
      walletReady: features.privy,
      feeBps: configuredRateBps('jupiter').bps,
      feeAccountConfigured: Boolean(env.JUPITER_PLATFORM_FEE_ACCOUNT),
    },
    'xstocks': {
      enabled: jupiter.isLive,
      liveTrading: jupiter.isLiveTrading,
      regionAllowed: regionAllowed('xstocks'),
      walletReady: features.privy,
      feeBps: configuredRateBps('xstocks').bps,
    },
    'polymarket': {
      enabled: polymarket.isLive,
      liveTrading: polymarket.isLiveTrading,
      regionAllowed: regionAllowed('polymarket'),
      walletReady: Boolean(evmWallet),
      clobCredsReady: Boolean(u.pmClobKey && u.pmClobSecret && u.pmClobPassphrase),
      feeBps: configuredRateBps('polymarket').bps,
    },
  };

  const payload = {
    ok: true,
    livemode: livemode ?? null,
    region,
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      kycStatus: u.kycStatus,
      killSwitch: Boolean(u.killSwitch),
    },
    wallets: {
      primary: u.privyWalletAddress ?? null,
      privy: {
        evm: evmWallet,
        // Solana wallet is provisioned lazily by walletService; the
        // address is not on the User row today. Surface null so clients
        // know to call the trade route to provision on first use.
        solana: null,
      },
    },
    balances: {
      balUsd: u.balUsd,
      eurUsd: u.eurUsd,
      earnUsd: u.earnUsd,
      earnApy: u.earnApy,
    },
    earnConfig: {
      earnByDefault: u.earnByDefault,
      autoDivestOnSpend: u.autoDivestOnSpend,
      divestThresholdUsd: u.divestThresholdUsd,
    },
    trading,
    features: {
      markets: features.markets,
      privy: features.privy,
      jupiterSwaps: features.jupiterSwaps,
      bridge: features.bridge,
      monerium: features.monerium,
    },
  };
  return c.json(MeProfileSchema.parse(payload));
});

/**
 * User-scoped fee summary. Returns fees the platform has collected on this
 * user's behalf, in a recent window. Aggregated from the in-memory fee
 * tracker — durable accounting lives on-chain at the fee receiver wallets.
 */
meRoutes.get('/fees', async (c) => {
  const u = c.get('user');
  const all = summarizeFees(500);
  const recent = all.recent.filter((e) => e.userId === u.id).slice(0, 100);
  const byVenue: Record<string, { feeUsd: number; orderCount: number; notionalUsd: number }> = {};
  let totalFeeUsd = 0;
  let totalNotionalUsd = 0;
  for (const e of recent) {
    const slot = (byVenue[e.venue] ??= { feeUsd: 0, orderCount: 0, notionalUsd: 0 });
    slot.feeUsd += e.feeUsd;
    slot.orderCount += 1;
    slot.notionalUsd += e.notionalUsd;
    totalFeeUsd += e.feeUsd;
    totalNotionalUsd += e.notionalUsd;
  }
  const payload = {
    ok: true,
    userId: u.id,
    windowFrom: recent[recent.length - 1]?.at ?? null,
    windowTo: new Date().toISOString(),
    totalFeeUsd: Math.round(totalFeeUsd * 1_000_000) / 1_000_000,
    totalNotionalUsd: Math.round(totalNotionalUsd * 100) / 100,
    byVenue,
    recent,
  };
  return c.json(MeFeesSchema.parse(payload));
});

/* ──────────────────────────────────────────────────────────────────────────
 * NEO Session 1 — per-device push registration + notification preferences.
 * Devices are keyed by the client's stable installationId (survives token
 * rotation). Delivery is gated per-device by `enabled` + per-category
 * `preferences`. Guarded by the same authSessionOrApiKey middleware as the
 * rest of /me.
 * ────────────────────────────────────────────────────────────────────────── */

const InstallationParam = z.object({ installationId: z.string().min(1).max(64) });

const DevicePushBody = z.object({
  expoPushToken: z.string().min(1).max(256),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().min(1).max(32).optional(),
  enabled: z.boolean().optional(),
  preferences: z.record(z.string().min(1).max(64), z.boolean()).optional(),
});

/** Public projection of a device row — drops internal id/userId and the raw
 *  push token (the client already holds its own token; management keys off
 *  installationId). */
function deviceView(d: ExpoPushSubscriptionRecord) {
  return {
    installationId: d.installationId,
    platform: d.platform,
    appVersion: d.appVersion,
    enabled: d.enabled,
    preferences: d.preferences,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/** Register / update the push device for a given installation. Upsert keyed on
 *  (user, installationId): re-registering with a rotated token updates in place
 *  instead of creating a second row. */
meRoutes.put(
  '/devices/:installationId/push',
  zValidator('param', InstallationParam),
  zValidator('json', DevicePushBody),
  async (c) => {
    const u = c.get('user');
    const { installationId } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = await store.upsertDeviceByInstallation(u.id, {
      installationId,
      expoPushToken: body.expoPushToken,
      platform: body.platform,
      appVersion: body.appVersion ?? null,
      enabled: body.enabled,
      preferences: body.preferences,
    });
    return c.json({ ok: true, device: MeDeviceSchema.parse(deviceView(device)) });
  },
);

/** Deregister a device (e.g. sign-out on that install). Idempotent — 200 even
 *  when no row matched. */
meRoutes.delete(
  '/devices/:installationId/push',
  zValidator('param', InstallationParam),
  async (c) => {
    const u = c.get('user');
    const { installationId } = c.req.valid('param');
    await store.deleteDeviceByInstallation(u.id, installationId);
    return c.json({ ok: true });
  },
);

/** List the user's registered devices (management surface). */
meRoutes.get('/devices', async (c) => {
  const u = c.get('user');
  const devices = await store.listDevices(u.id);
  return c.json(MeDevicesResponseSchema.parse({ ok: true, devices: devices.map(deviceView) }));
});

/** Merge-patch notification preferences user-wide (across every device). Body
 *  is a `Record<string, boolean>` per-category opt-out map; unknown value types
 *  are rejected at the zod boundary. Returns the merged result. */
meRoutes.patch(
  '/notification-preferences',
  zValidator('json', NotificationPreferencesSchema),
  async (c) => {
    const u = c.get('user');
    const prefs = c.req.valid('json');
    const merged = await store.setNotificationPreferences(u.id, prefs);
    return c.json({ ok: true, preferences: NotificationPreferencesSchema.parse(merged) });
  },
);

/**
 * Platform-wide fee summary. Admin only — the kill-switch gate doubles as
 * the admin gate today (operators that can kill an account can see fees).
 * Production should add a proper admin role check.
 */
meRoutes.get('/admin/fees/summary', async (c) => {
  // Admin gating: the API key tier (`sk_live_*`) doubles as the ops surface
  // today — full per-user fee history requires a real admin role. Tighten
  // this once `nb_users.role` lands.
  const livemode = c.get('livemode');
  if (livemode !== true) {
    return c.json({ ok: false, error: { code: 'forbidden', message: 'live_api_key_required' } }, 403);
  }
  if (!env.ADMIN_TOKEN || c.req.header('x-admin-token') !== env.ADMIN_TOKEN) {
    return c.json({ ok: false, error: { code: 'forbidden', message: 'admin_token_required' } }, 403);
  }
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') ?? 50)));
  return c.json({ ok: true, ...summarizeFees(limit) });
});

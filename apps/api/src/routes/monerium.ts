/**
 * /monerium/* — EUR rails alternative to Bridge.
 *
 * Bridge KYB is the longest critical path before US/EU bank rails work; Monerium
 * is the EUR-only alternative we wire while Bridge is pending. Monerium issues
 * a SEPA-addressable IBAN in the user's name and ties it to EURe on Gnosis
 * Chain (so receiving EUR mints EURe, redeeming EURe wires EUR).
 *
 *   GET  /monerium/status         — registry probe (available + sourced meta)
 *   GET  /monerium/profile        — user's IBAN/BIC + KYC state
 *   POST /monerium/offramp        — burn EURe -> SEPA wire to user's bank
 *
 * Demo path: returns synthetic IBAN/BIC + a `mn_demo_*` order id so the e2e
 * flow round-trips without a live Monerium account.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireSession } from '../lib/auth.js';
import { features } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { moneriumAdapter } from '../lib/chain/monerium.js';
import { liveMeta, providerDemoMeta } from '../lib/sourced.js';
import { getChainStack } from '../lib/chain/index.js';
import { log } from '../lib/log.js';

export const moneriumRoutes = new Hono();

moneriumRoutes.get('/status', (c) => {
  return c.json({ ok: true, ...moneriumAdapter.status() });
});

moneriumRoutes.get('/profile', requireSession, async (c) => {
  const u = c.get('user');
  const stack = getChainStack();
  const wallet = await stack.wallets.getOrCreateUserWallet(u.id, null);
  if (!features.monerium) {
    // Demo path — synthesise a stable IBAN that maps deterministically to the
    // user's address so the UI can render a "Your IBAN" tile in DEMO_MODE.
    const seed = wallet.address.slice(2, 12).toUpperCase();
    const iban = `DE${seed.slice(0, 2)}50010517${seed.slice(2, 10)}${seed.slice(0, 2)}`;
    return c.json({
      ok: true,
      iban,
      bic: 'INGDDEFFXXX',
      profileId: `pf_demo_${seed.toLowerCase()}`,
      kycStatus: 'pending',
      walletAddress: wallet.address,
      sourced: providerDemoMeta('monerium', 'profile'),
    });
  }
  try {
    const profile = await moneriumAdapter.profile(wallet.address);
    if (!profile) {
      return c.json(
        {
          ok: false,
          error: { code: 'profile_missing', message: 'Monerium profile not yet onboarded.' },
          sourced: moneriumAdapter.unavailableMeta(new Error('profile not yet onboarded')),
        },
        404,
      );
    }
    return c.json({
      ok: true,
      iban: profile.iban,
      bic: profile.bic,
      profileId: profile.profileId,
      kycStatus: profile.kycStatus,
      walletAddress: wallet.address,
      sourced: liveMeta('monerium', 'profile'),
    });
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'monerium: profile fetch failed');
    throw ApiError.badRequest('Failed to load Monerium profile.', { providerCode: 'monerium_failed' });
  }
});

const OfframpInput = z.object({
  amountEur: z.number().positive().max(50000),
  reference: z.string().max(140).optional(),
});

moneriumRoutes.post('/offramp', requireSession, zValidator('json', OfframpInput), async (c) => {
  const u = c.get('user');
  const { amountEur, reference } = c.req.valid('json');
  const stack = getChainStack();
  const wallet = await stack.wallets.getOrCreateUserWallet(u.id, null);
  try {
    const order = await moneriumAdapter.offramp({
      amountEur,
      sourceAddress: wallet.address,
      reference,
    });
    const sourced = order.demo
      ? providerDemoMeta('monerium', 'offramp')
      : liveMeta('monerium', 'offramp');
    return c.json({
      ok: true,
      orderId: order.orderId,
      state: order.state,
      amountEur,
      walletAddress: wallet.address,
      sourced,
    });
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e), userId: u.id },
      'monerium: offramp failed',
    );
    throw ApiError.badRequest('Failed to start offramp.', { providerCode: 'monerium_offramp_failed' });
  }
});

/**
 * Sprint 10 Item F — perks read surface.
 *
 *   GET /perks → { ok, tier, points, multiplier, lifetimeEarnedUsd, nextTierAt }
 *
 * Awards are recorded by store.awardPoints in three call sites:
 *   - releaseBonus (earn) — campaign payouts
 *   - card charge path   — cardSpend
 *   - x402/earn surfaces — earn
 *
 * Constants live in `lib/campaigns/perks.ts`; edit there to redirect economics.
 */

import { Hono } from 'hono';
import { requireSession } from '../lib/auth.js';
import { nextTierAt as nextTierAtPoints } from '../lib/campaigns/perks.js';
import { store } from '../store/index.js';

export const perksRoutes = new Hono();

perksRoutes.use('*', requireSession);

perksRoutes.get('/', async (c) => {
  const u = c.get('user');
  const perks = await store.getPerks(u);
  return c.json({
    ok: true,
    tier: perks.tier,
    points: perks.points,
    multiplier: perks.multiplier,
    lifetimeEarnedUsd: perks.lifetimeEarnedUsd,
    nextTierAt: nextTierAtPoints(perks.tier),
  });
});

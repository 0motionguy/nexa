/**
 * Sprint 10 Item F — campaigns + submissions.
 *
 * Public surface (session-gated):
 *   POST /campaigns                                — create a campaign (any user, v1)
 *   GET  /campaigns                                — list (optional ?status=active|closed)
 *   GET  /campaigns/:id                            — campaign + own submission inline
 *   POST /campaigns/:id/submit                     — submit a clip (1/user/campaign)
 *
 * Admin surface (agent-key gated):
 *   POST /campaigns/:id/submissions/:subId/approve         { viewsVerified }
 *   POST /campaigns/:id/submissions/:subId/release-bonus   computes payout
 *
 * Admin key note: v1 accepts any configured agent-key as admin because the key
 * catalog (lib/agent-keys.ts) doesn't yet carry a role/label field. The
 * Sprint 11 follow-up is to extend NEXA_AGENT_KEYS to support
 * `nx_live_xxx=email,role=campaign_admin` triples and tighten this gate.
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { requireSession, withSentryUser } from '../lib/auth.js';
import { userForAgentKey } from '../lib/agent-keys.js';
import { verifySubmission } from '../lib/campaigns/verify.js';
import { env } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { store } from '../store/index.js';
import { PolicyError } from '../store/types.js';
import type { CampaignPlatform, CampaignStatus } from '../store/types.js';
import { campaignPayouts } from '../lib/metrics.js';

export const campaignsRoutes = new Hono();

/**
 * Admin gate — accepts the same agent-key format as MCP/x402 (`X-Nexa-Key` or
 * `Authorization: Bearer <key>`). v1 grants admin to any configured key; see
 * the file header note for the Sprint 11 label scope.
 */
async function requireAdminKey(c: Context, next: Next): Promise<Response | void> {
  const provided =
    c.req.header('x-nexa-key') ??
    (c.req.header('authorization')?.startsWith('Bearer ')
      ? c.req.header('authorization')!.slice(7)
      : null);
  const user = provided ? await userForAgentKey(provided) : null;
  if (!provided || !user) {
    throw ApiError.unauthorized('invalid_admin_key');
  }
  c.set('user', user);
  withSentryUser(user);
  await next();
}

/* ── public (session-gated) ─────────────────────────────────────────────── */

campaignsRoutes.post('/', requireSession, async (c) => {
  const u = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    brand?: string;
    baseUsd?: number;
    bonusTiers?: Array<{ viewsThreshold: number; bonusUsd: number }>;
    topPrizeUsd?: number;
    endAt?: string | null;
  };
  const title = String(body.title ?? '').trim();
  const brand = String(body.brand ?? '').trim();
  const baseUsd = Number(body.baseUsd ?? 0);
  if (!title) throw ApiError.badRequest('invalid_title');
  if (!brand) throw ApiError.badRequest('invalid_brand');
  if (!(baseUsd >= 0)) throw ApiError.badRequest('invalid_base_usd');
  const tiers = Array.isArray(body.bonusTiers) ? body.bonusTiers : [];
  // Scale wave 3 — createCampaign's Store signature still takes the full
  // record; hydrate at this rare admin/creator boundary.
  const campaign = await store.createCampaign(await store.user(u.id), {
    title,
    brand,
    baseUsd,
    bonusTiers: tiers.map((t) => ({
      viewsThreshold: Math.max(0, Math.floor(Number(t.viewsThreshold) || 0)),
      bonusUsd: Math.max(0, Number(t.bonusUsd) || 0),
    })),
    topPrizeUsd: Math.max(0, Number(body.topPrizeUsd) || 0),
    endAt: body.endAt ?? null,
  });
  return c.json({ ok: true, campaign });
});

campaignsRoutes.get('/', requireSession, async (c) => {
  const statusQ = c.req.query('status');
  const status: CampaignStatus | undefined =
    statusQ === 'active' || statusQ === 'closed' ? statusQ : undefined;
  const campaigns = await store.listCampaigns({ status });
  return c.json({ ok: true, campaigns });
});

campaignsRoutes.get('/:id', requireSession, async (c) => {
  const id = c.req.param('id') ?? '';
  if (!id) throw ApiError.notFound('not_found');
  const all = await store.listCampaigns();
  const campaign = all.find((x) => x.id === id);
  if (!campaign) throw ApiError.notFound('not_found');
  // Surface the caller's own submission inline so the UI can render state.
  // listCampaigns has no per-user submission read; we do it via the admin-free
  // route surface keeping the store contract small.
  return c.json({ ok: true, campaign });
});

campaignsRoutes.post('/:id/submit', requireSession, async (c) => {
  const u = c.get('user');
  const id = c.req.param('id') ?? '';
  if (!id) throw ApiError.badRequest('invalid_campaign');
  const body = (await c.req.json().catch(() => ({}))) as {
    clipUrl?: string;
    platform?: CampaignPlatform;
    viewsAttested?: number;
  };
  const clipUrl = String(body.clipUrl ?? '').trim();
  const platformInput = body.platform;
  if (!clipUrl) throw ApiError.badRequest('invalid_clip_url');
  if (
    platformInput !== 'tiktok' &&
    platformInput !== 'instagram' &&
    platformInput !== 'youtube' &&
    platformInput !== 'x'
  ) {
    throw ApiError.badRequest('invalid_platform');
  }
  const platform: CampaignPlatform = platformInput;
  const viewsAttested = Math.max(0, Math.floor(Number(body.viewsAttested ?? 0)));
  // v2 hook reserved here — verifySubmission is currently a no-op manual path
  // that returns viewsAttested unchanged. Admin still overrides at approve-time.
  void (await verifySubmission({ platform, clipUrl, viewsAttested }));
  try {
    const submission = await store.submitToCampaign(u, id, { clipUrl, platform, viewsAttested });
    return c.json({ ok: true, submission });
  } catch (e) {
    if (e instanceof PolicyError && e.message === 'submission_cap') {
      throw ApiError.conflict('submission_cap');
    }
    if (e instanceof Error && e.message === 'campaign_not_found') {
      throw ApiError.notFound('not_found');
    }
    if (e instanceof Error && e.message === 'campaign_closed') {
      // F062: 410 is outside ApiErrorStatus; ADR-0002 uses 409 for unavailable resources.
      throw ApiError.conflict('campaign_closed');
    }
    throw e;
  }
});

/* ── admin (agent-key) ──────────────────────────────────────────────────── */

campaignsRoutes.post(
  '/:id/submissions/:subId/approve',
  requireAdminKey,
  async (c) => {
    const subId = c.req.param('subId') ?? '';
    if (!subId) throw ApiError.badRequest('invalid_submission');
    const body = (await c.req.json().catch(() => ({}))) as { viewsVerified?: number };
    const viewsVerified = Math.max(0, Math.floor(Number(body.viewsVerified ?? 0)));
    try {
      const submission = await store.approveSubmission(subId, viewsVerified);
      return c.json({ ok: true, submission });
    } catch (e) {
      if (e instanceof Error && e.message === 'submission_not_found') {
        throw ApiError.notFound('not_found');
      }
      if (e instanceof Error && e.message === 'submission_already_paid') {
        throw ApiError.conflict('already_paid');
      }
      throw e;
    }
  },
);

campaignsRoutes.post(
  '/:id/submissions/:subId/release-bonus',
  requireAdminKey,
  async (c) => {
    const campaignId = c.req.param('id') ?? '';
    const subId = c.req.param('subId') ?? '';
    if (!subId) throw ApiError.badRequest('invalid_submission');
    if (!env.DEMO_MODE) {
      throw ApiError.forbidden('campaign_payouts_unavailable');
    }
    try {
      // Sprint 13 COMMIT 6 (SR4) — pass campaignId so the store can assert
      // the submission belongs to this campaign. Prevents an admin key
      // compromise from paying out across campaigns.
      const result = await store.releaseBonus(campaignId, subId);
      campaignPayouts.inc({ tier: result.tier });
      return c.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof Error && e.message === 'submission_not_found') {
        throw ApiError.notFound('not_found');
      }
      if (e instanceof Error && e.message === 'submission_already_paid') {
        throw ApiError.conflict('already_paid');
      }
      if (e instanceof Error && e.message === 'submission_not_approved') {
        throw ApiError.conflict('not_approved');
      }
      // PolicyError('expired', 'subId_campaignId_mismatch') → 422
      if (e instanceof PolicyError && e.message === 'subId_campaignId_mismatch') {
        throw new ApiError('unprocessable_entity', 422, 'subId_campaignId_mismatch');
      }
      throw e;
    }
  },
);

/**
 * Sprint 10 Item F — campaigns + submissions routes, full lifecycle.
 *
 * Boots the real Hono app on an ephemeral port, signs in via the demo OTP, and
 * exercises: create → list → submit → submit-twice (409 cap) → admin approve →
 * admin release-bonus → /perks reflects the tier multiplier.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { app } from '../index.js';
import { env } from '../lib/env.js';

let server: ServerType;
let base: string;
const originalDemoMode = env.DEMO_MODE;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  env.DEMO_MODE = originalDemoMode;
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

const ADMIN_KEY = env.NEXA_AGENT_KEYS.split(',')[0]!.split('=')[0]!.trim();

function expectApiError(body: any, code: string, message: string): void {
  expect(body).toMatchObject({
    ok: false,
    error: { code, message },
  });
}

async function login(email: string): Promise<string> {
  const start = await json('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const verify = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.challengeId, code: '482019' }),
  });
  return verify.body.token as string;
}

describe('campaigns + admin lifecycle', () => {
  let campaignId = '';
  let submissionId = '';
  let creatorToken = '';
  let submitterToken = '';

  beforeAll(async () => {
    creatorToken = await login('camp-creator@example.com');
    submitterToken = await login('camp-submitter@example.com');
  });

  it.each([
    ['missing title', { brand: 'MAZE', baseUsd: 5 }, 'invalid_title'],
    ['missing brand', { title: 'Clip launch', baseUsd: 5 }, 'invalid_brand'],
    ['negative baseUsd', { title: 'Clip launch', brand: 'MAZE', baseUsd: -1 }, 'invalid_base_usd'],
  ])('POST /campaigns rejects %s with ApiError envelope', async (_label, payload, message) => {
    const { status, body } = await json('/campaigns', {
      method: 'POST',
      headers: { authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify(payload),
    });
    expect(status).toBe(400);
    expectApiError(body, 'bad_request', message);
  });

  it('POST /campaigns creates a campaign', async () => {
    const { status, body } = await json('/campaigns', {
      method: 'POST',
      headers: { authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify({
        title: 'Clip launch · S10',
        brand: 'MAZE',
        baseUsd: 5,
        bonusTiers: [
          { viewsThreshold: 10_000, bonusUsd: 20 },
          { viewsThreshold: 100_000, bonusUsd: 80 },
        ],
        topPrizeUsd: 100,
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.campaign.title).toBe('Clip launch · S10');
    campaignId = body.campaign.id as string;
  });

  it('GET /campaigns returns the created campaign', async () => {
    const { status, body } = await json('/campaigns', {
      headers: { authorization: `Bearer ${creatorToken}` },
    });
    expect(status).toBe(200);
    const ids = body.campaigns.map((c: { id: string }) => c.id);
    expect(ids).toContain(campaignId);
  });

  it('GET /campaigns/:id returns the campaign', async () => {
    const { status, body } = await json(`/campaigns/${campaignId}`, {
      headers: { authorization: `Bearer ${submitterToken}` },
    });
    expect(status).toBe(200);
    expect(body.campaign.id).toBe(campaignId);
  });

  it('GET /campaigns/:id returns 404 ApiError envelope for an unknown campaign', async () => {
    const { status, body } = await json('/campaigns/00000000-0000-0000-0000-000000000000', {
      headers: { authorization: `Bearer ${submitterToken}` },
    });
    expect(status).toBe(404);
    expectApiError(body, 'not_found', 'not_found');
  });

  it.each([
    ['missing clipUrl', { platform: 'tiktok', viewsAttested: 7500 }, 'invalid_clip_url'],
    ['invalid platform', { clipUrl: 'https://example.com/clip', platform: 'vine', viewsAttested: 7500 }, 'invalid_platform'],
  ])('POST /campaigns/:id/submit rejects %s with ApiError envelope', async (_label, payload, message) => {
    const { status, body } = await json(`/campaigns/${campaignId}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${submitterToken}` },
      body: JSON.stringify(payload),
    });
    expect(status).toBe(400);
    expectApiError(body, 'bad_request', message);
  });

  it('POST /campaigns/:id/submit returns 404 ApiError envelope for an unknown campaign', async () => {
    const { status, body } = await json('/campaigns/00000000-0000-0000-0000-000000000000/submit', {
      method: 'POST',
      headers: { authorization: `Bearer ${submitterToken}` },
      body: JSON.stringify({
        clipUrl: 'https://tiktok.com/@me/video/unknown',
        platform: 'tiktok',
        viewsAttested: 7500,
      }),
    });
    expect(status).toBe(404);
    expectApiError(body, 'not_found', 'not_found');
  });

  it('POST /campaigns/:id/submit creates a submission', async () => {
    const { status, body } = await json(`/campaigns/${campaignId}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${submitterToken}` },
      body: JSON.stringify({
        clipUrl: 'https://tiktok.com/@me/video/1234',
        platform: 'tiktok',
        viewsAttested: 7500,
      }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.submission.campaignId).toBe(campaignId);
    expect(body.submission.status).toBe('submitted');
    submissionId = body.submission.id as string;
  });

  it('POST /campaigns/:id/submit twice → 409 submission_cap', async () => {
    const { status, body } = await json(`/campaigns/${campaignId}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${submitterToken}` },
      body: JSON.stringify({
        clipUrl: 'https://tiktok.com/@me/video/5678',
        platform: 'tiktok',
        viewsAttested: 8000,
      }),
    });
    expect(status).toBe(409);
    expectApiError(body, 'conflict', 'submission_cap');
  });

  it('POST /campaigns/:id/submissions/:subId/approve without admin key → 401', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/${submissionId}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ viewsVerified: 12_000 }),
      },
    );
    expect(status).toBe(401);
    expectApiError(body, 'unauthorized', 'invalid_admin_key');
  });

  it('POST /campaigns/:id/submissions/:subId/approve returns 404 ApiError envelope for an unknown submission', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/00000000-0000-0000-0000-000000000000/approve`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
        body: JSON.stringify({ viewsVerified: 12_000 }),
      },
    );
    expect(status).toBe(404);
    expectApiError(body, 'not_found', 'not_found');
  });

  it('release-bonus returns 404 ApiError envelope for an unknown submission', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/00000000-0000-0000-0000-000000000000/release-bonus`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
      },
    );
    expect(status).toBe(404);
    expectApiError(body, 'not_found', 'not_found');
  });

  it('release-bonus on a submitted submission returns 409 not_approved ApiError envelope', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/${submissionId}/release-bonus`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
      },
    );
    expect(status).toBe(409);
    expectApiError(body, 'conflict', 'not_approved');
  });

  it('POST /campaigns/:id/submissions/:subId/approve with admin key → status approved', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/${submissionId}/approve`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
        body: JSON.stringify({ viewsVerified: 12_000 }),
      },
    );
    expect(status).toBe(200);
    expect(body.submission.status).toBe('approved');
    expect(body.submission.viewsVerified).toBe(12_000);
  });

  it('release-bonus is unavailable outside demo mode until campaign escrow exists', async () => {
    const tempCampaign = await json('/campaigns', {
      method: 'POST',
      headers: { authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify({ title: 'Escrow required', brand: 'MAZE', baseUsd: 10 }),
    });
    const tempCampaignId = tempCampaign.body.campaign.id as string;
    const tempSubmission = await json(`/campaigns/${tempCampaignId}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${submitterToken}` },
      body: JSON.stringify({
        clipUrl: 'https://x.com/me/status/escrow-required',
        platform: 'x',
        viewsAttested: 10,
      }),
    });
    const tempSubmissionId = tempSubmission.body.submission.id as string;
    await json(`/campaigns/${tempCampaignId}/submissions/${tempSubmissionId}/approve`, {
      method: 'POST',
      headers: { 'X-Nexa-Key': ADMIN_KEY },
      body: JSON.stringify({ viewsVerified: 10 }),
    });

    env.DEMO_MODE = false;
    const { status, body } = await json(
      `/campaigns/${tempCampaignId}/submissions/${tempSubmissionId}/release-bonus`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
      },
    );
    expect(status).toBe(403);
    expectApiError(body, 'forbidden', 'campaign_payouts_unavailable');
  });

  it('release-bonus with a mismatched campaign id returns 422 ApiError envelope', async () => {
    const other = await json('/campaigns', {
      method: 'POST',
      headers: { authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify({ title: 'Other campaign', brand: 'MAZE', baseUsd: 1 }),
    });
    const otherCampaignId = other.body.campaign.id as string;
    const { status, body } = await json(
      `/campaigns/${otherCampaignId}/submissions/${submissionId}/release-bonus`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
      },
    );
    expect(status).toBe(422);
    expectApiError(body, 'unprocessable_entity', 'subId_campaignId_mismatch');
  });

  it('POST /campaigns/:id/submissions/:subId/release-bonus credits submitter and recomputes tier', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/${submissionId}/release-bonus`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
      },
    );
    expect(status).toBe(200);
    expect(body.submission.status).toBe('paid');
    // base ($5) + first tier bonus ($20) at views 12k ≥ 10k threshold = $25
    // submitter starts as starter (multiplier 1.00x) → $25.00 paid.
    expect(body.paidUsd).toBeCloseTo(25, 2);
    expect(body.multiplier).toBe(1);
    expect(body.tier).toBe('starter');

    // After awarding 25 earn-points the submitter is still starter (<100 pts).
    const perks = await json('/perks', {
      headers: { authorization: `Bearer ${submitterToken}` },
    });
    expect(perks.body.tier).toBe('starter');
    expect(perks.body.points).toBeGreaterThanOrEqual(25);
    expect(perks.body.lifetimeEarnedUsd).toBeCloseTo(25, 2);
  });

  it('release-bonus on a paid submission → 409 already_paid', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/${submissionId}/release-bonus`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
      },
    );
    expect(status).toBe(409);
    expectApiError(body, 'conflict', 'already_paid');
  });

  it('approve on a paid submission returns 409 and keeps it paid', async () => {
    const { status, body } = await json(
      `/campaigns/${campaignId}/submissions/${submissionId}/approve`,
      {
        method: 'POST',
        headers: { 'X-Nexa-Key': ADMIN_KEY },
        body: JSON.stringify({ viewsVerified: 50_000 }),
      },
    );

    expect(status).toBe(409);
    expectApiError(body, 'conflict', 'already_paid');
  });
});

describe('campaigns: rising tier multiplier applies to payout', () => {
  let campaignId = '';
  let submissionId = '';
  let creatorToken = '';
  let submitterToken = '';

  beforeAll(async () => {
    creatorToken = await login('camp-rising-creator@example.com');
    submitterToken = await login('camp-rising-submitter@example.com');
  });

  it('rising-tier submitter gets 1.05x multiplier on a $100 base payout', async () => {
    const camp = await json('/campaigns', {
      method: 'POST',
      headers: { authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify({
        title: 'Bigger campaign',
        brand: 'MAZE',
        baseUsd: 100,
        bonusTiers: [],
      }),
    });
    campaignId = camp.body.campaign.id as string;
    const sub = await json(`/campaigns/${campaignId}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${submitterToken}` },
      body: JSON.stringify({
        clipUrl: 'https://x.com/me/status/42',
        platform: 'x',
        viewsAttested: 1,
      }),
    });
    submissionId = sub.body.submission.id as string;
    await json(`/campaigns/${campaignId}/submissions/${submissionId}/approve`, {
      method: 'POST',
      headers: { 'X-Nexa-Key': ADMIN_KEY },
      body: JSON.stringify({ viewsVerified: 1 }),
    });

    // Pre-load submitter with rising-tier points (≥100 earn-pts) so the
    // multiplier on the release equals 1.05x. We do that by paying out a prior
    // bootstrap campaign worth 200 base USD (200 earn-pts → rising).
    const bootstrap = await json('/campaigns', {
      method: 'POST',
      headers: { authorization: `Bearer ${creatorToken}` },
      body: JSON.stringify({ title: 'bootstrap', brand: 'MAZE', baseUsd: 200, bonusTiers: [] }),
    });
    const bId = bootstrap.body.campaign.id as string;
    const bSub = await json(`/campaigns/${bId}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${submitterToken}` },
      body: JSON.stringify({ clipUrl: 'https://x.com/me/status/0', platform: 'x', viewsAttested: 1 }),
    });
    const bSubId = bSub.body.submission.id as string;
    await json(`/campaigns/${bId}/submissions/${bSubId}/approve`, {
      method: 'POST',
      headers: { 'X-Nexa-Key': ADMIN_KEY },
      body: JSON.stringify({ viewsVerified: 1 }),
    });
    await json(`/campaigns/${bId}/submissions/${bSubId}/release-bonus`, {
      method: 'POST',
      headers: { 'X-Nexa-Key': ADMIN_KEY },
    });

    const perks = await json('/perks', {
      headers: { authorization: `Bearer ${submitterToken}` },
    });
    expect(perks.body.tier).toBe('rising');

    const release = await json(`/campaigns/${campaignId}/submissions/${submissionId}/release-bonus`, {
      method: 'POST',
      headers: { 'X-Nexa-Key': ADMIN_KEY },
    });
    expect(release.body.multiplier).toBe(1.05);
    expect(release.body.tier).toBe('rising');
    // 100 * 1.05 = 105.00
    expect(release.body.paidUsd).toBeCloseTo(105, 2);
  });
});

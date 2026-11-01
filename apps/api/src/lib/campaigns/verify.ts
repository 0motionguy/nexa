/**
 * Sprint 10 Item F — campaign submission verification hook.
 *
 * v1 (this sprint) is manual: an admin reviews each clip and calls the approve
 * route with the verified view count. The helper here exists so the wiring
 * survives the v2 migration: when TIKTOK_API_KEY or YOUTUBE_API_KEY is set,
 * swap the manual fallthrough for a real view-count fetch and the rest of the
 * pipeline (approveSubmission / releaseBonus / tier-multipliers) stays put.
 *
 * Never throws — failure of the live API still degrades to manual review.
 */
import { env } from '../env.js';
import { log } from '../log.js';
import type { CampaignPlatform } from '../../store/types.js';

export interface VerifyInput {
  platform: CampaignPlatform;
  clipUrl: string;
  viewsAttested: number;
}

export interface VerifyResult {
  viewsVerified: number;
  source: 'manual' | 'tiktok' | 'youtube';
}

/**
 * Best-effort view-count verification. v1 returns the attested view count and
 * marks the source 'manual' so admin approval can override later. v2 plugs in
 * the platform API behind the env-gated branches below.
 */
export async function verifySubmission(input: VerifyInput): Promise<VerifyResult> {
  // v2 hooks reserved — when TIKTOK_API_KEY / YOUTUBE_API_KEY are wired we
  // call the platform endpoint here and return a real `viewsVerified`. Any
  // network or schema failure logs and degrades to manual so the admin path
  // always works.
  const platform = input.platform;
  const tiktokKey =
    typeof (env as unknown as { TIKTOK_API_KEY?: string }).TIKTOK_API_KEY === 'string'
      ? (env as unknown as { TIKTOK_API_KEY?: string }).TIKTOK_API_KEY
      : undefined;
  const youtubeKey =
    typeof (env as unknown as { YOUTUBE_API_KEY?: string }).YOUTUBE_API_KEY === 'string'
      ? (env as unknown as { YOUTUBE_API_KEY?: string }).YOUTUBE_API_KEY
      : undefined;

  if (platform === 'tiktok' && tiktokKey) {
    try {
      // TODO v2: replace with the real TikTok Display API call once the
      // partner key is provisioned. Until then we fall through to manual.
      log.info({ platform, clipUrl: input.clipUrl }, 'campaigns: tiktok verify hook reserved (manual)');
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'campaigns: tiktok verify hook failed, falling back to manual',
      );
    }
  }

  if (platform === 'youtube' && youtubeKey) {
    try {
      // TODO v2: YouTube Data API v3 videos.list?part=statistics
      log.info({ platform, clipUrl: input.clipUrl }, 'campaigns: youtube verify hook reserved (manual)');
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'campaigns: youtube verify hook failed, falling back to manual',
      );
    }
  }

  return { viewsVerified: input.viewsAttested, source: 'manual' };
}

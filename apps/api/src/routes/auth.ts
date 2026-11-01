/**
 * Email auth.
 *
 * Two paths, gated by Privy env presence:
 *
 *  PRIVY_APP_ID set (live):
 *    /start → returns { mode: 'privy', appId } (frontend uses Privy SDK)
 *    /privy-verify → exchanges Privy access token → MAZE session JWT
 *
 *  Privy unset (demo):
 *    /start → generates 6-digit challenge, calls sendEmail('otp', {code}),
 *             returns { mode: 'demo', challengeId, hint? }
 *    /verify → validates code (env.DEMO_OTP_CODE), issues JWT
 *
 * The session-token surface is identical regardless of path.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'node:crypto';
import { store } from '../store/index.js';
import {
  clearRevocationCache,
  clearSessionCookie,
  issueToken,
  markJtiRevokedInCache,
  optionalSession,
  requireSession,
  setSessionCookie,
} from '../lib/auth.js';
import { env } from '../lib/env.js';
import { isPrivyEnabled, verifyPrivyToken } from '../lib/privy.js';
import { walletService } from '../lib/chain/wallet.js';
import { ensureHlBuilderApproval } from '../lib/markets/hl-builder-approval.js';
import { sendEmail } from '../lib/email.js';
import { log } from '../lib/log.js';
import { ApiError } from '../lib/errors.js';
import { claimsClaimed } from '../lib/metrics.js';
import type { SessionUser } from '../store/types.js';

const challenges = new Map<string, { email: string; code: string; expiresAt: number }>();

export const authRoutes = new Hono();

function publicUser(u: SessionUser) {
  const evm = u.privyWalletAddress
    ? { walletId: u.privyWalletId ?? null, address: u.privyWalletAddress }
    : null;
  const solana = u.privySolWalletAddress
    ? { walletId: u.privySolWalletId ?? null, address: u.privySolWalletAddress }
    : null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    wallet: { baseAddress: u.privyWalletAddress ?? null },
    wallets: { evm, solana },
    walletReady: Boolean(evm || solana),
  };
}

async function claimPendingForSignedInEmail(email: string): Promise<number> {
  try {
    const res = await store.claimPendingFundsForEmail(email);
    if (res.claimed > 0) claimsClaimed.inc(res.claimed);
    return res.claimed;
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'auth: post-sign-in claim sweep failed (non-blocking)',
    );
    return 0;
  }
}

authRoutes.post(
  '/start',
  zValidator('json', z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid('json');

    if (isPrivyEnabled()) {
      return c.json({
        ok: true,
        mode: 'privy' as const,
        appId: env.PRIVY_APP_ID,
        email,
      });
    }

    const challengeId = randomUUID();
    const code = env.DEMO_OTP_CODE;
    challenges.set(challengeId, { email, code, expiresAt: Date.now() + 10 * 60_000 });
    void sendEmail(email, 'otp', { code, expiresInMinutes: 10 });
    const body: { ok: true; mode: 'demo'; challengeId: string; hint?: string } = {
      ok: true,
      mode: 'demo',
      challengeId,
    };
    if (env.NODE_ENV !== 'production') body.hint = 'demo code: ' + code;
    return c.json(body);
  },
);

authRoutes.post(
  '/verify',
  zValidator(
    'json',
    z.object({
      challengeId: z.string().uuid(),
      code: z.string().length(6),
      // P1-4 — optional so old clients (and web, H4) keep today's behavior.
      // Shape mirrors routes/me.ts InstallationParam.
      installationId: z.string().min(1).max(64).optional(),
    }),
  ),
  async (c) => {
    const { challengeId, code, installationId } = c.req.valid('json');
    const ch = challenges.get(challengeId);
    if (!ch || ch.expiresAt < Date.now()) {
      throw ApiError.badRequest('challenge_expired');
    }
    if (code !== ch.code) throw ApiError.badRequest('bad_code');
    challenges.delete(challengeId);
    const user = await store.upsertUserByEmail(ch.email);
    await claimPendingForSignedInEmail(user.email);
    const { token, expiresAt, jti } = await issueToken(user, {
      installationId: installationId ?? null,
    });
    // P1-4 — sign-in REPLACES this installation's prior session: revoke every
    // other live jti for (user, installation) so re-auth (reinstall, OTP
    // re-login) never leaves an orphaned live bearer riding the 30-day TTL.
    if (installationId) {
      const revoked = await store.revokeSessionsByInstallation(user.id, installationId, jti);
      for (const j of revoked) markJtiRevokedInCache(j);
    }
    // F096 — also drop the httpOnly session cookie so browser clients can
    // stop mirroring the JWT into XSS-readable storage. Native + server
    // callers ignore the Set-Cookie header and keep using the Bearer token
    // from the JSON body.
    setSessionCookie(c, token);
    return c.json({
      ok: true,
      token,
      expiresAt,
      user: publicUser(user),
    });
  },
);

authRoutes.post(
  '/privy-verify',
  zValidator(
    'json',
    z.object({
      accessToken: z.string().min(10),
      // P1-4 — optional, same contract as /verify above.
      installationId: z.string().min(1).max(64).optional(),
    }),
  ),
  async (c) => {
    if (!isPrivyEnabled()) throw ApiError.badRequest('privy_disabled');
    const { accessToken, installationId } = c.req.valid('json');
    const verified = await verifyPrivyToken(accessToken);
    if (!verified || !verified.email) {
      log.warn({ did: verified?.did }, 'auth: privy verify rejected');
      throw ApiError.unauthorized('invalid_privy_token');
    }
    const user = await store.upsertUserByEmail(verified.email, undefined, {
      privyDid: verified.did,
    });

    // Sprint 16.4 — opportunistically cache the Privy server wallet on the
    // user row. We do this here (not at order time) so the Hyperliquid /
    // Polymarket order routes can rely on a single user lookup without
    // re-provisioning per request. Best-effort: a Privy outage shouldn't
    // block sign-in, so failures log and fall through.
    let evmWallet = user.privyWalletId && user.privyWalletAddress
      ? { walletId: user.privyWalletId, address: user.privyWalletAddress as `0x${string}` }
      : null;
    if (!evmWallet) {
      try {
        const wallet = await walletService.getOrCreateUserWallet(user.id, verified.did);
        if (wallet.address && wallet.walletId) {
          await store.setPrivyWallet(user.id, wallet.walletId, wallet.address);
          evmWallet = { walletId: wallet.walletId, address: wallet.address as `0x${string}` };
        }
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), userId: user.id },
          'auth: post-sign-in wallet cache failed (non-blocking)',
        );
      }
    }

    if (evmWallet) {
      try {
        const agreementUser = await store.user(user.id);
        const approval = await ensureHlBuilderApproval({
          userId: user.id,
          walletId: evmWallet.walletId,
          walletAddress: evmWallet.address,
          approvedAt: agreementUser.hlBuilderApprovedAt ?? null,
          approvedMaxFeeTenthsBp: agreementUser.hlBuilderMaxFeeTenthsBp ?? null,
        });
        if (!approval.ok) {
          log.warn(
            { userId: user.id, code: approval.code },
            'auth: post-sign-in builder agreement failed (non-blocking)',
          );
        }
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), userId: user.id },
          'auth: post-sign-in builder agreement failed (non-blocking)',
        );
      }
    }

    // Audit 2026-06-19 — provision + cache the Solana sibling wallet at
    // sign-in so Marinade stake / Mayan swap can use it without a per-request
    // wallet round-trip. Same best-effort semantics as the EVM cache above:
    // Solana RPC / Privy outage logs and falls through (live trade routes
    // still gate on the persisted address via store).
    if (!user.privySolWalletId || !user.privySolWalletAddress) {
      try {
        const solWallet = await walletService.getOrCreateUserSolanaWallet(user.id, verified.did);
        if (solWallet.live && solWallet.address && solWallet.walletId) {
          await store.setPrivySolWallet(user.id, solWallet.walletId, solWallet.address);
        }
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e), userId: user.id },
          'auth: post-sign-in Solana wallet cache failed (non-blocking)',
        );
      }
    }

    await claimPendingForSignedInEmail(user.email);
    const sessionUser = await store.user(user.id);
    const { token, expiresAt, jti } = await issueToken(sessionUser, {
      installationId: installationId ?? null,
    });
    // P1-4 — replace-with-revoke, same contract as /verify above.
    if (installationId) {
      const revoked = await store.revokeSessionsByInstallation(sessionUser.id, installationId, jti);
      for (const j of revoked) markJtiRevokedInCache(j);
    }
    // F096 — drop the httpOnly session cookie for browser clients (same as
    // /verify above). Native callers ignore Set-Cookie and use the Bearer.
    setSessionCookie(c, token);
    return c.json({
      ok: true,
      token,
      expiresAt,
      user: publicUser(sessionUser),
    });
  },
);

/**
 * F096 Sprint 18 — sign-out path. Clears the httpOnly cookie so a shared
 * browser doesn't keep the session alive after the user explicitly hits
 * "sign out".
 *
 * NEO Session 1 — also REVOKES the presented session's jti so a stolen bearer
 * (native callers hold it in SecureStore) can't outlive an explicit sign-out.
 * optionalSession populates user + sessionJti when the token is valid; a
 * missing / expired / already-revoked token just clears the cookie (idempotent).
 */
authRoutes.post('/signout', optionalSession, async (c) => {
  clearSessionCookie(c);
  const jti = c.get('sessionJti');
  const user = c.get('user');
  if (jti && user) {
    await store.revokeSession(user.id, jti);
    markJtiRevokedInCache(jti);
  }
  return c.json({ ok: true });
});

/**
 * NEO Session 1 — explicit session revocation. Body `{ all?: boolean }`:
 * revokes the CURRENT session by default, or EVERY session for the user when
 * `all` is true (sign-out-everywhere). The revoked bearer(s) stop authenticating
 * on the next request — immediate on this pod, ≤30s elsewhere (revocation-cache
 * window). Pre-upgrade tokens without a jti have nothing to revoke.
 */
authRoutes.post('/revoke', requireSession, async (c) => {
  const sessionUser = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as { all?: unknown };
  if (body?.all === true) {
    await store.revokeSession(sessionUser.id, { all: true });
    // Can't enumerate every affected jti to prime the cache — drop it all so the
    // next check per token re-reads the store (source of truth).
    clearRevocationCache();
  } else {
    const jti = c.get('sessionJti');
    if (jti) {
      await store.revokeSession(sessionUser.id, jti);
      markJtiRevokedInCache(jti);
    }
  }
  return c.json({ ok: true });
});

/**
 * Mint a fresh session token for the currently-authenticated user. Clients
 * should call this when the existing token is within ~1 day of expiry to
 * avoid mid-flight 401s on order POSTs. Requires a still-valid bearer; this
 * is NOT a lost-token recovery path.
 */
authRoutes.post('/refresh', requireSession, async (c) => {
  const sessionUser = c.get('user');
  const oldJti = c.get('sessionJti');
  const { token, expiresAt } = await issueToken(sessionUser);
  // NEO Session 1 — rotate: the new token supersedes the old, so revoke the old
  // jti (the presented bearer stops working after this). Pre-upgrade tokens have
  // no jti and simply expire on their own 30-day TTL.
  if (oldJti) {
    await store.revokeSession(sessionUser.id, oldJti);
    markJtiRevokedInCache(oldJti);
  }
  // F096 — refresh the cookie alongside the Bearer in the JSON response.
  setSessionCookie(c, token);
  return c.json({
    ok: true,
    token,
    expiresAt,
    user: publicUser(sessionUser),
  });
});

authRoutes.get('/me', requireSession, async (c) => {
  const sessionUser = c.get('user');
  const claimed = c.req.query('claim') === '1'
    ? await claimPendingForSignedInEmail(sessionUser.email)
    : 0;
  const u = claimed > 0 ? await store.user(sessionUser.id) : sessionUser;
  return c.json({
    ok: true,
    user: publicUser(u),
    wallet: { baseAddress: u.privyWalletAddress ?? null },
    wallets: publicUser(u).wallets,
    walletReady: Boolean(u.privyWalletAddress || u.privySolWalletAddress),
    balance: { balUsd: u.balUsd, eurUsd: u.eurUsd, earnUsd: u.earnUsd, earnApy: u.earnApy },
    /* Sprint 10 Item A — earn config surfaces here so the web can hydrate the
     * toggles on s14 from the same call it already makes on boot. Defaults are
     * applied by setEarnConfig; the User shape always carries them. */
    earnConfig: {
      earnByDefault: u.earnByDefault,
      autoDivestOnSpend: u.autoDivestOnSpend,
      divestThresholdUsd: u.divestThresholdUsd,
    },
  });
});

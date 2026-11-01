/**
 * PgAuth — user upsert, session-key bindings, and identity lookups.
 *
 * Delegates user-state seeding + hydration to LedgerStateManager so
 * upsertUserByEmail can pre-populate nb_user_state + seed demo data
 * inside the same code path the rest of the modules use.
 */

import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nbAgentKeys, nbCardState, nbUsers } from '../../db/schema/index.js';
import { env } from '../../lib/env.js';
import { ApiError } from '../../lib/errors.js';
import { log } from '../../lib/log.js';
import type { RedisClient } from '../../lib/redis.js';
import { RedisKeys } from '../../lib/redis.js';
import type { SessionUser, User } from '../types.js';
import type { LedgerStateManager } from '../core/ledger-state.js';
import { encrypt } from '../../lib/crypto.js';

/**
 * W2-C — narrow a driver error to "unique violation on nb_users.privy_did"
 * (pg SQLSTATE 23505). postgres.js exposes `code`/`constraint_name`; the
 * message match keeps the check portable across drivers and pg-mem.
 */
function isPrivyDidUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; constraint_name?: string };
  const unique = e.code === '23505' || /duplicate key|unique/i.test(e.message ?? '');
  if (!unique) return false;
  return /privy_did/i.test(`${e.constraint_name ?? ''} ${e.message ?? ''}`);
}

/**
 * W2-C — agent keys are stored hashed (SHA-256 hex, 64 chars); the raw key
 * exists only in the caller's hands. Map, Redis and Postgres are all keyed
 * by this hash so the raw key is never at rest anywhere.
 */
function hashAgentKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class PgAuth {
  /** in-process agent-key cache when Redis absent */
  private agentKeyMap = new Map<string, string>();

  constructor(
    private db: Db,
    private redis: RedisClient | null,
    private core: LedgerStateManager,
  ) {}

  async upsertUserByEmail(
    email: string,
    name?: string,
    opts: { privyDid?: string | null } = {},
  ): Promise<User> {
    const norm = email.trim().toLowerCase();
    const fallback = norm.split('@')[0] ?? 'Member';
    const display = name ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
    const privyDid = opts.privyDid ?? null;

    // W2-C — DID-first resolution. The Privy DID is the stable identity
    // anchor; the email is user-editable at the IdP. A DID hit wins outright
    // (no seed, no email rebind) and an email drift is logged for follow-up.
    if (privyDid) {
      const [byDid] = await this.db
        .select({ id: nbUsers.id, email: nbUsers.email })
        .from(nbUsers)
        .where(eq(nbUsers.privyDid, privyDid))
        .limit(1);
      if (byDid) {
        if (byDid.email !== norm) {
          log.warn(
            {
              event: 'identity_email_mismatch',
              userId: byDid.id,
              storedEmail: byDid.email,
              presentedEmail: norm,
            },
            'privy DID resolved a user whose stored email differs from the presented one',
          );
        }
        return this.core.hydrateUser(byDid.id);
      }
    }

    // Email path. Fast path first (a plain SELECT on the common re-login),
    // then a race-safe INSERT … ON CONFLICT (email) DO NOTHING: two
    // concurrent first logins collapse onto one row and the loser re-reads
    // instead of surfacing a uniqueness error. The demo seed runs only for
    // the row the INSERT actually created.
    let userId: string;
    let isNew = false;
    const existing = await this.userRowByEmail(norm);
    if (existing) {
      userId = existing.id;
      await this.adoptOrVerifyDid(existing, privyDid);
    } else {
      let created: { id: string } | undefined;
      try {
        [created] = await this.db
          .insert(nbUsers)
          .values({ email: norm, name: display, privyDid })
          .onConflictDoNothing({ target: nbUsers.email })
          .returning({ id: nbUsers.id });
      } catch (err) {
        // The same DID raced in under a different email — a genuine identity
        // conflict (privy_did is UNIQUE), not a retryable hiccup.
        if (isPrivyDidUniqueViolation(err)) {
          throw ApiError.conflict('identity_did_conflict', { privyDid });
        }
        throw err;
      }
      if (created) {
        userId = created.id;
        isNew = true;
      } else {
        // Lost the insert race; the winner's row exists now.
        const winner = await this.userRowByEmail(norm);
        if (!winner) throw new Error('identity_upsert_race');
        userId = winner.id;
        await this.adoptOrVerifyDid(winner, privyDid);
      }
    }

    if (isNew) {
      // Demo seed keeps local previews familiar. Live/non-demo accounts start
      // at zero and are funded only by provider-confirmed settlement.
      const demoSeed = env.DEMO_MODE;
      await this.db.insert(nbCardState).values({ userId, frozen: false, dayLimitUsd: 500 }).onConflictDoNothing();
      await this.core.setUserState(userId, {
        balUsd: demoSeed ? 4820.4 : 0,
        eurUsd: 0,
        sandboxBalUsd: 0,
        earnUsd: demoSeed ? 3200 : 0,
        killSwitch: false,
        earnByDefault: false,
        autoDivestOnSpend: false,
        divestThresholdUsd: 50,
        preferredVaultTier: 'standard',
      });
      if (demoSeed) await this.core.seedDemoData(userId);
    }

    return this.core.hydrateUser(userId);
  }

  private async userRowByEmail(
    norm: string,
  ): Promise<{ id: string; privyDid: string | null } | null> {
    const rows = await this.db
      .select({ id: nbUsers.id, privyDid: nbUsers.privyDid })
      .from(nbUsers)
      .where(eq(nbUsers.email, norm))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * W2-C — adopt-once DID semantics on an email-resolved row: a null DID
   * adopts (guarded by `privy_did IS NULL` so concurrent adopters can't
   * overwrite each other), the same DID is a no-op, and a different bound
   * DID is a 409 — a bound identity is never silently rebound.
   */
  private async adoptOrVerifyDid(
    row: { id: string; privyDid: string | null },
    privyDid: string | null,
  ): Promise<void> {
    if (!privyDid || row.privyDid === privyDid) return;
    if (row.privyDid !== null) {
      throw ApiError.conflict('identity_did_conflict', { userId: row.id });
    }
    try {
      await this.db
        .update(nbUsers)
        .set({ privyDid })
        .where(and(eq(nbUsers.id, row.id), isNull(nbUsers.privyDid)));
    } catch (err) {
      // The DID is already bound to another row (privy_did is UNIQUE).
      if (isPrivyDidUniqueViolation(err)) {
        throw ApiError.conflict('identity_did_conflict', { userId: row.id });
      }
      throw err;
    }
    // Re-read instead of trusting rowCount (driver-portable): the guarded
    // UPDATE either adopted our DID or a concurrent login adopted another.
    const [after] = await this.db
      .select({ privyDid: nbUsers.privyDid })
      .from(nbUsers)
      .where(eq(nbUsers.id, row.id))
      .limit(1);
    if (after?.privyDid !== privyDid) {
      throw ApiError.conflict('identity_did_conflict', { userId: row.id });
    }
    await this.core.invalidateUser(row.id);
  }

  async user(id: string): Promise<User> {
    return this.core.hydrateUser(id);
  }

  /** Scale wave 3 — session-auth projection: 3 PK reads, no aggregates. */
  async userSession(id: string): Promise<SessionUser> {
    return this.core.hydrateUserCore(id);
  }

  /** Sprint 16.4 — persist the Privy wallet id + address on the user row. */
  async setPrivyWallet(
    userId: string,
    walletId: string,
    walletAddress: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (opts.force) {
      await this.db
        .update(nbUsers)
        .set({ privyWalletId: walletId, privyWalletAddress: walletAddress })
        .where(eq(nbUsers.id, userId));
    } else {
      // Set-once semantics — only persist when both columns are currently null.
      // Avoids racing two parallel sign-ins overwriting each other and avoids
      // accidentally replacing a wallet a previous flow already wrote.
      const [existing] = await this.db
        .select({ wid: nbUsers.privyWalletId, addr: nbUsers.privyWalletAddress })
        .from(nbUsers)
        .where(eq(nbUsers.id, userId))
        .limit(1);
      if (!existing) return;
      if (existing.wid && existing.addr) return; // already set
      await this.db
        .update(nbUsers)
        .set({ privyWalletId: walletId, privyWalletAddress: walletAddress })
        .where(eq(nbUsers.id, userId));
    }
    await this.core.invalidateUser(userId);
  }

  /** Sprint 16.4 — record the backend-managed HL builder agreement timestamp + max fee. */
  async setHlBuilderApproval(userId: string, maxFeeTenthsBp: number): Promise<void> {
    await this.db
      .update(nbUsers)
      .set({
        hlBuilderApprovedAt: new Date(),
        hlBuilderMaxFeeTenthsBp: maxFeeTenthsBp,
      })
      .where(eq(nbUsers.id, userId));
    await this.core.invalidateUser(userId);
  }

  /**
   * Audit 2026-06-19 — persist Polymarket CLOB L2 creds. Set-once unless
   * `force` (rotation). Mirrors setPrivyWallet semantics.
   */
  async setPmClobCredentials(
    userId: string,
    creds: { key: string; secret: string; passphrase: string },
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (!opts.force) {
      const [existing] = await this.db
        .select({
          k: nbUsers.pmClobKey,
          s: nbUsers.pmClobSecret,
          p: nbUsers.pmClobPassphrase,
        })
        .from(nbUsers)
        .where(eq(nbUsers.id, userId))
        .limit(1);
      if (!existing) return;
      if (existing.k && existing.s && existing.p) return;
    }
    // SEC-01 — encrypt at rest under PM_CLOB_ENC_KEY (AES-256-GCM). In
    // dev/test with no key set, `encrypt` is a pass-through (rolling
    // migration). The hydrate path uses decryptIfWrapped to handle both.
    await this.db
      .update(nbUsers)
      .set({
        pmClobKey: encrypt(creds.key),
        pmClobSecret: encrypt(creds.secret),
        pmClobPassphrase: encrypt(creds.passphrase),
      })
      .where(eq(nbUsers.id, userId));
    await this.core.invalidateUser(userId);
  }

  /** Audit 2026-06-19 — persist Solana sibling wallet. Set-once unless force. */
  async setPrivySolWallet(
    userId: string,
    walletId: string,
    walletAddress: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (!opts.force) {
      const [existing] = await this.db
        .select({ wid: nbUsers.privySolWalletId, addr: nbUsers.privySolWalletAddress })
        .from(nbUsers)
        .where(eq(nbUsers.id, userId))
        .limit(1);
      if (!existing) return;
      if (existing.wid && existing.addr) return;
    }
    await this.db
      .update(nbUsers)
      .set({ privySolWalletId: walletId, privySolWalletAddress: walletAddress })
      .where(eq(nbUsers.id, userId));
    await this.core.invalidateUser(userId);
  }

  /** Audit 2026-06-19 — set or clear a user's cohort tag. */
  async setUserCohort(userId: string, cohort: string | null): Promise<void> {
    await this.db
      .update(nbUsers)
      .set({ cohort })
      .where(eq(nbUsers.id, userId));
    await this.core.invalidateUser(userId);
  }

  /** Audit 2026-06-19 — list users tagged with the given cohort. */
  async listUsersByCohort(cohort: string): Promise<User[]> {
    const wanted = cohort.trim();
    if (!wanted) return [];
    const rows = await this.db
      .select({ id: nbUsers.id })
      .from(nbUsers)
      .where(eq(nbUsers.cohort, wanted));
    const users = await Promise.all(rows.map((r) => this.core.hydrateUser(r.id)));
    return users;
  }

  async bindAgentKeyToUser(key: string, userId: string): Promise<void> {
    const keyHash = hashAgentKey(key);
    // W2-C — Postgres is the source of truth (bindings survive restarts);
    // Redis and the in-process map are read-through caches keyed by the
    // hash. Rebinding an existing key to a new user keeps prior semantics
    // (last write wins).
    await this.db
      .insert(nbAgentKeys)
      .values({ key: keyHash, userId })
      .onConflictDoUpdate({ target: nbAgentKeys.key, set: { userId } });
    if (this.redis) {
      await this.redis.setex(RedisKeys.agentKey(keyHash), 60 * 60, userId);
    }
    this.agentKeyMap.set(keyHash, userId);
  }

  async userForAgentKey(key: string): Promise<User | null> {
    const keyHash = hashAgentKey(key);
    let userId: string | null = this.agentKeyMap.get(keyHash) ?? null;
    if (!userId && this.redis) {
      userId = await this.redis.get(RedisKeys.agentKey(keyHash)).catch(() => null);
      if (userId) this.agentKeyMap.set(keyHash, userId);
    }
    if (!userId) {
      // Cache miss (e.g. fresh process after a restart) — fall back to the
      // durable binding and repopulate the caches.
      const [row] = await this.db
        .select({ userId: nbAgentKeys.userId })
        .from(nbAgentKeys)
        .where(eq(nbAgentKeys.key, keyHash))
        .limit(1);
      if (row) {
        userId = row.userId;
        this.agentKeyMap.set(keyHash, userId);
        if (this.redis) {
          await this.redis
            .setex(RedisKeys.agentKey(keyHash), 60 * 60, userId)
            .catch(() => {});
        }
      }
    }
    if (!userId) return null;
    try {
      await this.db
        .update(nbAgentKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(nbAgentKeys.key, keyHash));
    } catch {
      // last-used telemetry must never fail auth
    }
    try {
      return await this.core.hydrateUser(userId);
    } catch {
      return null;
    }
  }
}

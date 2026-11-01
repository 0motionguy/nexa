/**
 * Regression guard: naked JS Date bind params in raw sql`` fragments.
 *
 * Incident (prod, discovered 2026-07-15): subscription-renewer failed on
 * every hourly run (649 failures) and claim-sweep on every daily run (27)
 * since the features shipped. postgres-js@3.4.9 with prepare:false throws
 * TypeError ERR_INVALID_ARG_TYPE (Buffer.byteLength receiving a Date) while
 * building the Bind message — client-side, ~35ms, so the statement never
 * reaches Postgres and nothing is server-logged. Drizzle wraps it as
 * "Failed query: ..." and hides the cause, which is why the failure looked
 * like a schema problem.
 *
 * Builder operators (lt/gt/eq/...) are safe: they route the value through
 * the column's mapToDriverValue (Date -> ISO string) before the driver.
 * Raw sql`` interpolation skips that mapping entirely.
 *
 * Rule: never interpolate a Date into a raw sql`` fragment. Use builder
 * operators or pre-stringify. pg-mem-based specs cannot catch this class of
 * defect (they never exercise postgres-js wire serialization), so this spec
 * pins the driver-visible param shapes via .toSQL().
 */
import { describe, expect, it } from 'vitest';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { makeDb } from '../../db/client.js';
import { nbClaimWallets, nbSubscriptions } from '../../db/schema/index.js';

// postgres-js is lazy — no socket is opened until a query executes, and
// .toSQL() only renders the AST, so a dummy URL is CI-safe.
const { db } = makeDb('postgresql://spec:spec@127.0.0.1:5432/spec', { max: 1 });

const cutoff = new Date('2026-07-15T13:07:00.000Z');
const isMappedCutoff = (p: unknown): boolean =>
  typeof p === 'string' && /^2026-07-15[T ]13:07:00/.test(p);

describe('driver params never contain Date instances', () => {
  it('findSubscriptionsDueBefore (subscription-renewer) maps cutoff via lt()', () => {
    const q = db
      .select()
      .from(nbSubscriptions)
      .where(
        and(eq(nbSubscriptions.status, 'active'), lt(nbSubscriptions.currentPeriodEnd, cutoff)),
      )
      .orderBy(desc(nbSubscriptions.createdAt))
      .toSQL();
    expect(q.params.some((p) => p instanceof Date)).toBe(false);
    expect(q.params.some(isMappedCutoff)).toBe(true);
  });

  it('expireClaimsBefore (claim-sweep) maps cutoff via lt()', () => {
    const q = db
      .select()
      .from(nbClaimWallets)
      .where(and(eq(nbClaimWallets.status, 'pending'), lt(nbClaimWallets.expiresAt, cutoff)))
      .toSQL();
    expect(q.params.some((p) => p instanceof Date)).toBe(false);
    expect(q.params.some(isMappedCutoff)).toBe(true);
  });

  it('canary: raw sql`` fragments still leak Date instances to the driver', () => {
    // Documents WHY the rule exists. If drizzle ever starts mapping raw
    // fragment params through column encoders, this flips to false and the
    // guard/comment set can be revisited.
    const q = db
      .select()
      .from(nbSubscriptions)
      .where(sql`${nbSubscriptions.currentPeriodEnd} < ${cutoff}`)
      .toSQL();
    expect(q.params.some((p) => p instanceof Date)).toBe(true);
  });
});

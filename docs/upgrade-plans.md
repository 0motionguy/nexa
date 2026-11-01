# Dependency upgrade plans (F005, F025, F026, F027)

Each entry has a current → target version, the breaking-change risk surface, the work order, and a rollback cue. Land these one at a time on a dedicated branch; the audit's principle is "spike + plan before code" for every major bump.

## F005 — @privy-io/server-auth (auth critical path)

**Current**: `^1.18.0` (per `apps/api/package.json` declared range; lockfile may be on `1.32.5` per `pnpm outdated`). The `1.x` line is deprecated by Privy.

**Target**: TBD. Privy publishes a successor SDK; the migration path is documented on their changelog. Determine the target before touching code.

**Risk surface**:
- [apps/api/src/lib/privy.ts](../apps/api/src/lib/privy.ts) — the only direct importer. `verifyAuthToken` + `getUserById` are the call sites.
- `/auth/privy-verify` route ([apps/api/src/routes/auth.ts](../apps/api/src/routes/auth.ts)) is the production entry point.
- Demo mode bypasses Privy entirely — so the demo OTP path is unaffected.

**Work order**:
1. Read Privy's deprecation notice + successor SDK docs.
2. Check the production `NODE_ENV=production` deploys: is `PRIVY_APP_ID` set? If yes, this is critical-path. If no (still demo), the migration is lower urgency.
3. Pin the target version in a feature branch, swap the import + the two function calls. Confirm shape compatibility.
4. Update [apps/api/src/routes/auth.spec.ts](../apps/api/src/routes/auth.spec.ts) to cover the Privy path (currently demo-only).
5. Stage on a preview deployment with a real Privy app id, run `pnpm verify`, smoke-test `/auth/privy-verify` end-to-end.
6. Land + monitor `auth_failure_*` Prometheus counters for 24h.

**Rollback cue**: any spike in `auth_failure_*` counter or Sentry `verifyAuthToken` errors → revert the PR.

---

## F025 — zod 3 → 4

**Current**: `^3.23.8`. **Target**: `^4.x` (currently 4.4.3 per audit).

**Risk surface** (everything that imports zod):
- [packages/shared-zod/src/index.ts](../packages/shared-zod/src/index.ts) — 60+ schemas, the canonical wire surface.
- Every route file using `zValidator('json', schema)` via `@hono/zod-validator`.
- [apps/api/src/lib/env.ts](../apps/api/src/lib/env.ts) — env validation at boot.

**Breaking changes to verify** (per zod 4 changelog):
- `z.string().datetime()` → may have stricter ISO parsing
- `z.object().passthrough()` / `.strict()` semantics
- Discriminated union API
- Error issue shape (downstream code that introspects `ZodError.issues`)

**Work order**:
1. Read the zod 4 migration guide top-to-bottom.
2. Check `@hono/zod-validator` compatibility — the audit's note flagged this as the highest-risk consumer. If zod-validator doesn't support zod 4, this blocks the whole upgrade.
3. Check `@asteasolutions/zod-to-openapi` — currently pinned to v7 because v8 wants zod 4. After zod 4, can move to zod-to-openapi v8.
4. Run zod's automated codemod on `packages/shared-zod/src/index.ts`.
5. `pnpm typecheck` — most issues surface here.
6. Run the full test suite — Zod schemas are exercised across every route spec.
7. Manual: hit `/v1/offers` POST with a malformed body, verify the 400 error shape hasn't changed.

**Rollback cue**: type errors that can't be resolved in < 1 day → revert. v3 LTS is fine for 2026.

---

## F026 — vite 6 → 8 (two majors)

**Current**: `^6.4.3`. **Target**: `^8.x` via `7.x` step.

**Risk surface**:
- [apps/web/vite.config.ts](../apps/web/vite.config.ts) (or equivalent) — root config.
- The 5 entry-point HTML files (`app.html`, `landing.html`, `portal.html`, `checkout.html`, `developers.html`).
- The `@/` path alias (vitest reads it too).
- Vite plugins — confirm each plugin's compat matrix.

**Breaking changes to verify**:
- Vite 7 dropped Node 18 support — we're on Node 22, fine.
- Plugin API changes (transformIndexHtml hook signature drift).
- CSS handling tweaks affecting the tokens.css cascade.

**Work order**:
1. Bump to vite 7 first (not 8 directly). `pnpm add -D vite@^7` in `apps/web`.
2. `pnpm typecheck && pnpm build`. Fix any plugin issues.
3. `pnpm dev` smoke — load each of the 5 entry HTMLs, verify the globe + dark theme still render.
4. Run e2e suite. If green, land vite 7.
5. Wait one sprint (let any vite 7 bugs surface), then plan vite 8 step.

**Rollback cue**: e2e regressions → revert; pin vite 6 for another quarter.

---

## F027 — pino 9 → 10, resend 4 → 6, jsdom 25 → 29

Three independent upgrades; do them in their own PRs.

### pino 9 → 10

**Current**: `^9.5.0` → **Target**: `^10.x`.

- Risk: structured log format change could break downstream parsing (loki, datadog).
- Compatibility: confirm `pino-pretty` and `pino-sentry-transport` support pino 10.
- Work: bump version, run tests, manual check of `apps/api/src/lib/log.ts` boot output.
- Rollback: revert + repin v9.

### resend 4 → 6 (email critical path)

**Current**: `^4.0.1` → **Target**: `^6.x`.

- Risk: HIGH — email is the claim escrow + OTP delivery surface.
- Breaking change: v5 changed the API client shape; v6 may have further changes.
- Work: spike on a fork branch. Read v5 + v6 changelogs. Update [apps/api/src/lib/email.ts](../apps/api/src/lib/email.ts) call sites. Run claim flow E2E.
- Verification: send a real OTP email through Resend on a preview deployment.
- Rollback: revert + repin v4 — claims would silently fail on a bad upgrade.

### jsdom 25 → 29 (4 majors!)

**Current**: `^25.0.1` → **Target**: `^29.x`. Dev-only (test environment).

- Risk: LOW (test infrastructure only).
- Breaking changes: 4 majors' worth of DOM API tweaks.
- Work: bump, run vitest, fix any DOM mock failures.
- Rollback: trivial — pin back.

---

## Cross-cutting

- **Never combine two majors in one PR.** Each above is its own branch.
- **`pnpm verify` GREEN is mandatory before merge.** No skipped tests.
- **Stage on a preview deploy.** The `vercel:deploy` skill ships a preview URL; smoke test the auth + payment flows before promoting.
- **Watch `payments_failed_total`, `x402_settlements_total{result="failure"}`, and any 5xx alert** for 24h after each merge. Roll back at the first whiff.

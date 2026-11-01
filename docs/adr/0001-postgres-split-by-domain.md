# ADR-0001: Split `postgres.ts` by domain

## Status

Accepted

## Date

2026-06-14

## Context

The production Store implementation in `apps/api/src/store/postgres.ts` had
grown to **3,650 LOC** by the end of Sprint 11. It was the single biggest debt
concentration in the repo, called out as F001 in `TECH_DEBT_AUDIT.md`:

> 3,430-LOC store implementing ~90 methods across 12+ domains (user state,
> agents, payments, offers, bridge, earn, x402, campaigns, perks, claims, card,
> sub-accounts). Every entity in the system flows through it, 21 transactions
> live inside it, and it has zero direct test coverage.

The mirror file `store/in-memory.ts` had grown to **1,734 LOC** following the
same trajectory. Both files churned ~10 times each during Sprints 10–11 alone,
signalling drift risk between the two implementations.

Pain points that surfaced during code review:

- Every diff touching the store had to be read against 3,650 lines of context.
- Reviewers could not localise a change to a single domain; one PR could touch
  agent policy, payments, and earn in the same hunk window.
- Test coverage was 0% direct on `postgres.ts` (all unit tests ran against the
  in-memory mirror), so SQL constraint behaviour and transaction isolation were
  invisible until staging.
- The `Store` interface in `store/types.ts` was 827 LOC declaring every
  domain's methods in one file — touching one entity forced re-reading the
  whole contract.
- Parallel work was blocked: any two engineers editing different domains in
  the same store file had to coordinate to avoid merge conflicts.

## Decision

Extract `postgres.ts` into a **facade + 12 domain modules + 1 shared kernel**:

```
apps/api/src/store/
  postgres.ts                          (195 LOC facade — re-exports + wiring)
  postgres/
    _shared.ts                         (row → domain mappers, money helpers)
    agents.ts                          (PgAgents — agent CRUD + policy + wallets)
    auth.ts                            (PgAuth — users, sessions, OTP, API keys)
    bridge.ts                          (PgBridge — virtual accounts, transfers)
    campaigns.ts                       (PgCampaigns — campaigns, submissions, perks)
    cards.ts                           (PgCards — Gnosis Pay card state)
    claims.ts                          (PgClaims — Privy pregen wallet claims)
    kyc.ts                             (PgKyc — Sumsub status mutations)
    ledger.ts                          (PgLedger — money mutators: send / topUp / earn)
    markets.ts                         (PgMarkets — Hyperliquid + Polymarket positions)
    payments.ts                        (PgPayments — offers, payouts, sub-accounts, Stripe)
    subscriptions.ts                   (PgSubscriptions — subscription renewals)
  core/
    ledger-state.ts                    (LedgerStateManager — 477 LOC shared kernel)
    in-memory-state.ts                 (mirror kernel for InMemoryStore)
  in-memory.ts                         (204 LOC facade)
  in-memory/                           (parallel module structure)
```

Key invariants:

1. **The public `Store` interface in `store/types.ts` does not change.** All
   downstream code (routes, workers, MCP server) imports through the facade and
   sees the same surface.
2. **The facade is wire-up only.** `postgres.ts` constructs the domain classes,
   passes them the shared `LedgerStateManager` kernel and `ChainMirror`
   dependency, and forwards `Store`-interface methods to the correct module.
3. **Each domain module owns its own transactions.** Money-mutating methods
   still run inside one `db.transaction` with row-level locks (`SELECT ... FOR
   UPDATE`); the activity bus emit still fires after commit.
4. **`LedgerStateManager` is the only place that touches `nb_user_state`.**
   Lock / write / invalidate + activity emit + demo seed live in one class
   that all domain modules call into for balance / earn / kill-switch reads.
5. **`store/in-memory.ts` mirrors the same shape.** Every Pg* class has a
   matching Mem* class in `store/in-memory/`. Both implement the same domain
   facet; the facade keeps the demo/prod swap transparent.

## Drivers

- **Maintainability.** Reviewing 200 LOC of payments diff against a 250-LOC
  module is materially easier than against 3,650 lines.
- **Smaller diffs.** Most feature work touches one or two domains; the patch
  footprint now reflects that.
- **Isolated domain testing.** Per-domain `*.spec.ts` files can stub other
  domains' dependencies and exercise SQL behaviour for one module at a time.
- **Review velocity.** Smaller files load faster in the GitHub diff view and
  carry less cognitive overhead per file.
- **Parallel work.** Two engineers editing different domains no longer race
  for the same file.
- **Drift prevention.** Mirroring the same module shape between `postgres/`
  and `in-memory/` makes drift visible at the module boundary instead of
  hidden inside a 3,650-line file.

## Considered alternatives

### Leave as-is

Rejected. The churn cost compounded with every sprint. By Sprint 12 the file
was the largest in the repo and the single biggest review-velocity blocker.
Doing nothing meant the cost grew monotonically.

### Migrate to an ORM (Prisma, MikroORM, Sequelize)

Rejected. Three reasons:

1. Drizzle was already wired and well-fitted to the schema; replacing it would
   be a multi-week migration touching every store method.
2. No clear win at the current scale — the existing `Store` interface already
   abstracts persistence; an ORM would replace one abstraction with another.
3. ORM-driven query generation would obscure the row-level lock semantics that
   the money paths depend on.

The ORM migration could be revisited at >100k DAU when query optimisation
becomes the bottleneck; today it isn't.

### Split by feature instead of by domain

Rejected. Features cross domain boundaries — "pay an offer" touches payments,
ledger, agents (policy check), campaigns (bonus accrual), perks (multiplier),
and sub-accounts. Splitting by feature would either duplicate domain logic
across files or create god-modules that imported from everywhere.

Splitting by domain (the entity being mutated) gives stable module boundaries
that follow the schema, not the use case.

### Generate code from schema

Rejected. The store methods carry domain rules (split calculation, idempotency
replay, kill-switch enforcement) that can't be auto-generated. A code generator
would only handle the CRUD surface, and the rest of the file would still need
to live somewhere.

## Consequences

### Positive

- Smaller diffs per change (typical PR now touches 1–2 modules of <400 LOC).
- Isolated tests per domain module are now feasible (Sprint 13 added 15 tests
  in `45af675..24478aa`; further per-module specs are tracked in
  `TECH_DEBT_AUDIT.md`).
- Easier review velocity — reviewers load less context per PR.
- Parallel work possible — Sprint 13 had two streams of concurrent edits to
  `agents.ts` and `payments.ts` with zero merge conflicts.
- Drift between postgres and in-memory is now visible at the module boundary;
  Sprint 13 review caught one cross-domain routing gap (chain mirror coverage)
  precisely because the modules made the gap legible.

### Negative

- More files to navigate. `find apps/api/src/store -type f` went from 4 to 28
  files. The IDE outline view + facade re-exports keep this manageable but it
  is a real cognitive shift for engineers who learned the old layout.
- Facade indirection adds one extra step: `Store.payOffer(...)` →
  `postgres.ts` facade → `PgPayments.payOffer(...)`. Negligible at runtime;
  measurable when grep'ing for "where is this method actually implemented".
- Cross-domain calls must route through `PgLedger` (the kernel) rather than
  module-to-module imports. Sprint 13 review caught one violation of this and
  closed it; the rule must be remembered for future cross-domain work.

## Validation

- All **502 API tests** still green after the split (no behavioural drift).
- Sprint 13 quality review (`/code-review` + `/security-review` against the
  Sprint 12 range) caught one chain-mirror routing gap which was closed in
  commits `45af675..24478aa`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter @nexa/api
  drizzle:check`, and `pnpm build` all clean against the new layout.
- File-size hotspot table in `STATE-OF-BUILD.md` reflects the new numbers
  (line 164): `postgres.ts: 195 LOC` (was 3,650).

## References

- Sprint 12 Phase 3 split commit: `e2f216b`
- Sprint 13 chain-mirror routing fix: commits `45af675..24478aa`
- File-size hotspot table: `STATE-OF-BUILD.md` line 164
- Sprint summary: `STATE-OF-BUILD.md` line 203
- Original audit finding: `TECH_DEBT_AUDIT.md` F001
- Public `Store` contract (unchanged by this ADR):
  `apps/api/src/store/types.ts`
- Facade entry point: `apps/api/src/store/postgres.ts`
- Shared kernel: `apps/api/src/store/core/ledger-state.ts`

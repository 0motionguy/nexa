# Feature flags

Every flag controlling production code paths in NEXA gets an entry here.
Flags without an owner + a deletion date rot — both legacy and new code
paths stay live forever, blame on the original committer for not closing
the loop.

## Required fields

```text
name             — env var or `features.*` key
owner            — github handle / role; the person who flips and deletes
created          — YYYY-MM-DD when the flag was introduced
purpose          — one sentence: what changes when the flag flips
default          — current production default
current state   — actual rollout state (off / canary / partial / 100%)
rollout method   — internal-only / cohort / percentage / time / global
metrics          — prometheus instruments that prove v1 vs v2 health
rollback trigger — what observation forces a flag flip back to default
target flip date — when 100% rollout should land
target delete dt — when the flag + the dead branch get removed
linked issue     — github issue / linear ticket tracking the rollout
```

## Active flags

### `MARKETS_ROUTER_V2`

```text
name              MARKETS_ROUTER_V2
owner             @mirko (NEXA CTO) — primary; @0motionguy as backup
created           2026-06-22
purpose           When true, POST /markets/{hyperliquid,hyperliquid-spot,stocks,jupiter,polymarket}/order
                  routes through the unified MarketAdapter pipeline (apps/api/src/routes/markets.ts
                  handleAdapterPlaceOrder) instead of the per-venue legacy handler bodies.
                  Response shape stays byte-identical; the experiment is structural.
default           false (production: env unset)
current state     off — canary owner has not started rollout yet
rollout method    env-toggle on the API host. NOT a per-request header (would let arbitrary
                  clients pick the router). For canary, point a single internal test account
                  at a separate API replica with MARKETS_ROUTER_V2=1; all other replicas stay
                  off.
                  NEVER call v1 and v2 for the same incoming order — that would risk duplicate
                  fills. The flag selects ONE path per request.
metrics           market_router_requests_total{version, venue, result}
                  market_router_duration_seconds{version, venue}
                  Compare v1 vs v2 distributions in Grafana:
                  - Error rate by version+venue:
                    sum(rate(market_router_requests_total{result!~"success|idempotency_replay"}[5m])) by (version, venue)
                  - P95 latency by version+venue:
                    histogram_quantile(0.95, sum(rate(market_router_duration_seconds_bucket[5m])) by (version, venue, le))
                  Existing markets_orders_total{venue, result} still tracks detailed v1
                  outcomes; market_router_requests_total adds the version cut.
rollback trigger  Any of:
                  - v2 error rate > 1.5× v1 for the same venue over a 30-min window
                  - v2 p95 latency > 1.5× v1 for the same venue over a 1-hour window
                  - Any byte-mismatch in JSON response shape between v1 and v2 (caught by
                    the v2 shadow spec tests in apps/api/src/routes/markets.spec.ts:951+)
                  Rollback is one env-config change: set MARKETS_ROUTER_V2=0 on every replica.
target flip date  2026-06-29 (start canary on one internal account)
                  2026-07-01 (50% if canary is clean)
                  2026-07-06 (100% if 50% is clean for 24h)
target delete dt  2026-07-13 (delete legacy v1 handler bodies + the env flag check
                  from apps/api/src/routes/markets.ts; collapse v2 metric to a single
                  bucket; close this entry)
linked issue      (open in GitHub when canary starts; reference here)
```

### `SESSION_REQUIRE_JTI`

```text
name              SESSION_REQUIRE_JTI
owner             @mirko (NEXA CTO)
created           2026-07-12
purpose           Overrides the dated no-jti session cutover. Session tokens minted before the
                  jti upgrade (5eeb8d0, 2026-07-10) carry no `jti` and cannot be revoked; they
                  are honored until SESSION_JTI_REQUIRED_AFTER_MS (2026-08-11, lib/auth.ts) so
                  the 2026-07-02..07-10 sign-in cohort isn't mass-signed-out.
                  '1' → force the cutover early (reject every no-jti token now, emergency);
                  '0' → hold the gate open past the date (escape hatch, no deploy);
                  unset → date-based default.
default           unset (no-jti allowed until 2026-08-11, then rejected by date)
current state     unset — date-based default; no override in production
rollout method    env-toggle on the API host. Global, not per-request (a client must not be
                  able to pick its own session-validation rule).
metrics           No dedicated counter — the gate emits a plain 401 (indistinguishable from an
                  expired session). Watch after a flip to '1':
                  - 401 rate on requireSession routes (auth_* + mutation routes) for a
                    sign-out spike
                  - service_unavailable rate on /auth/* (session_persist_failed) to confirm the
                    fail-closed issuance path is not co-firing
rollback trigger  Unexpected sign-out spike after setting '1' before 2026-08-11 → unset (or set
                  '0') to restore the date-based grace. A known-stolen pre-jti token is handled by
                  rotating JWT_SECRETS, NOT by this flag.
target flip date  2026-08-11 — the dated cutover self-executes; no manual flip required.
target delete dt  2026-09-11 — once every pre-jti token is provably expired (30d past the last
                  mint), delete SESSION_REQUIRE_JTI + the legacyNoJtiAllowed branch in
                  lib/auth.ts and require a jti unconditionally.
linked issue      red-team audit finding P1-8 (session-revocation hardening)
```

### Other live env flags worth tracking

These predate this doc; entries are placeholders to be filled when they
next touch production state. None should ship a new behavior change
without filling out the full template above.

```text
NEO_BRIDGE_FEE_BPS       — NEO bridge skim rate; introduced 2026-06-22 (commit 8a01b81). owner: @mirko.
MARKETS_ROUTER_V2        — see above.
SESSION_REQUIRE_JTI      — see above.
SENTRY_TRACES_SAMPLE_RATE — Sentry trace sampling; no rollout sequence (always live in prod).
```

## How to add a new flag

1. Copy the `MARKETS_ROUTER_V2` block above.
2. Fill every field. If a field is genuinely n/a, write `n/a` with a one-line
   reason — empty fields default to "owner forgot".
3. Add the matching metrics in `apps/api/src/lib/metrics.ts`. Keep label
   cardinality bounded (`version`, `venue`, finite `result` enums — no
   user ids, order ids, or symbols in labels).
4. Open a GitHub issue with the rollout sequence + the target flip/delete
   dates. Link it here.
5. Wire the flag in code as a single env check (`env.<NAME>`) so flipping
   is one config change.

## How to delete a flag

When `current state` reaches `100%` and stays clean past `target delete dt`:

1. Delete the dead branch (legacy or new, whichever lost).
2. Remove the env var check.
3. Move the metric to a stable post-rollout shape (drop the `version`
   label or repurpose for the next experiment).
4. Move the entry from "Active flags" to a "History" section below (or
   delete it once the issue is closed).
5. Close the linked issue.

## What flags MUST NOT do

- **No financial shadow execution.** A market order may execute on v1 OR
  v2, never both. The canary mechanism is account-level routing, not
  side-by-side execution.
- **No client-controlled routing.** No `X-Router-Version` header, no
  cookie, no query param. Server picks the path.
- **No flag without a deletion date.** Every entry must have a
  `target delete dt`. "Forever" is not a value.
- **No silent rollout.** Every flag flip is announced in the linked
  issue + the deploy log.

## History

(none yet — `MARKETS_ROUTER_V2` is the first formally tracked flag)

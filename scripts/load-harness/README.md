# load-harness — 1,000-distinct-user certification harness

Fixes audit blocker #11: `scripts/load-gate.mjs` (still in place as a fast
prod-safe smoke gate) simulates fleet load with 30 HTTP VUs and **one**
authenticated token fanned out across connections. Certification requires
**N distinct authenticated users** with realistic traffic cohorts, not one
token replayed N times. This harness:

- **Refuses to start** if the token pool has fewer distinct tokens than
  requested users (`lib/identity-pool.mjs`) — no silent one-token fallback.
- Models five weighted **traffic cohorts** instead of hammering one route
  (`lib/cohorts.mjs`): `markets-browser` (55%), `authed-trader` (20%),
  `portfolio-only` (10%), `predictions` (10%), `write-cohort` (5%, disabled
  by default).
- Simulates real client behavior: route switching every 30-120s, 25% of
  VUs backgrounding/resuming their WS connection, 5% flaky reconnects.
- Runs a **correctness probe**, not just a perf probe: any private
  WebSocket event delivered to a userId that isn't the receiving VU's own
  is a hard-fail (`cross_user_private_event`), and every write-cohort
  order is immediately replayed with the same idempotency key to catch
  double-execution.
- Is dependency-free plain `.mjs` — Node 22 global `fetch`/`WebSocket`
  only, same convention as `load-gate.mjs`. No new npm packages.

It does **not** replace `load-gate.mjs` for CI smoke checks — that stays
as the fast single-token prod-safe gate. This harness is for staged
ramp/soak certification runs against **staging**, run by a human/CI job
that has a real token pool, not for routine CI.

## Quickstart — self-test (no network, no tokens needed)

```bash
node scripts/load-harness/run.mjs --self-test
```

Spins up a local HTTP+WS stub (`lib/stub-server.mjs`, hand-rolled
RFC6455 — no `ws` package), runs the full pipeline against it with 5
synthetic users deterministically spread across all five cohorts plus
background/flaky behavior coverage, and asserts the artifact writes with
`result: "PASS"`. This is what CI runs
(`apps/api/src/scripts/load-harness.spec.ts`) — it never touches the
network and never needs `--tokens-file`.

## Token-pool provisioning

Each VU owns exactly one bearer token for its lifetime — `--tokens-file`
(or env `NEXA_LOAD_TOKENS_FILE`) points at a newline-separated file of
session JWTs, one per line (`#`-prefixed lines and blanks are ignored).
The harness computes the **distinct** count and refuses to start if it's
below the requested `--users` — pad the file with more real tokens, don't
reuse one.

**If the target runs `DEMO_MODE=1`** (check `GET <base>/healthz` →
`demo: true`, same check `load-gate.mjs` already does), you can mint N
demo sessions the same way `load-gate.mjs`'s `buildTokenPool()` does —
`POST /auth/start {email}` → `challengeId`, then
`POST /auth/verify {challengeId, code: DEMO_OTP_CODE}` (default
`482019`, `apps/api/src/lib/env.ts`) → `{token}`. Example provisioning
loop for a staging demo target:

```bash
BASE=https://staging.example/api
> tokens.txt
for i in $(seq 1 1000); do
  cid=$(curl -s -X POST "$BASE/auth/start" -H 'content-type: application/json' \
    -d "{\"email\":\"loadharness-$i@example.com\"}" | node -e \
    "process.stdin.on('data',d=>console.log(JSON.parse(d).challengeId))")
  tok=$(curl -s -X POST "$BASE/auth/verify" -H 'content-type: application/json' \
    -d "{\"challengeId\":\"$cid\",\"code\":\"482019\"}" | node -e \
    "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
  [ -n "$tok" ] && echo "$tok" >> tokens.txt
done
```

**If the target requires real auth** (no `DEMO_MODE`), the token pool
has to come from whatever real-account provisioning process ops
maintains for staging — one real session JWT per account, same
newline-per-token file format. That process is outside this harness's
scope; the harness only consumes the resulting file.

## Staging ladder — gates 0 through 5

`--gate` selects a preset `{users, durationSeconds}` from the staged plan
(`lib/args.mjs` `GATE_PRESETS`); `--users`/`--duration` override either
half of a preset. Run them in order — don't jump straight to gate 4.

```bash
# Gate 0 — smoke, 25 users / 60s
node scripts/load-harness/run.mjs --base https://staging.example/api \
  --tokens-file ./tokens.txt --gate 0

# Gate 1 — ramp, 100 users / 120s
node scripts/load-harness/run.mjs --base https://staging.example/api \
  --tokens-file ./tokens.txt --gate 1

# Gate 2 — ramp, 250 users / 180s
node scripts/load-harness/run.mjs --base https://staging.example/api \
  --tokens-file ./tokens.txt --gate 2

# Gate 3 — ramp, 500 users / 300s
node scripts/load-harness/run.mjs --base https://staging.example/api \
  --tokens-file ./tokens.txt --gate 3

# Gate 4 — certification, 1,000 users / 600s (the audit-blocker number)
node scripts/load-harness/run.mjs --base https://staging.example/api \
  --tokens-file ./tokens.txt --gate 4

# Gate 5 — soak, 500 users held for 1 hour (drift/leak check)
node scripts/load-harness/run.mjs --base https://staging.example/api \
  --tokens-file ./tokens.txt --gate 5
```

Each run prints progress lines and the final artifact as NDJSON to
stdout, and writes the same artifact to
`load-results/<iso-timestamp>-gate<N>.json` (override with `--out`;
`load-results/` is gitignored — these are run outputs, not source).
Exit code is `0` on `result: "PASS"`, `1` on `"FAIL"`, `2` on a
usage/safety refusal.

### Enabling the write-cohort

The 5% `write-cohort` is **folded into `markets-browser` (read-only) by
default** — it only runs money-adjacent sandbox orders when you pass
both flags:

```bash
node scripts/load-harness/run.mjs --base https://staging.example/api \
  --tokens-file ./tokens.txt --gate 1 \
  --enable-writes --write-allowlist staging.example
```

`--write-allowlist` is an explicit, comma-separated opt-in — the target
host must be listed or the harness refuses (exit 2). Orders are capped
$1-$10 notional, `tif: Ioc` (fill-or-kill-ish, no resting risk), one
unique idempotency key per attempt, and every write is immediately
replayed with the same key + body to assert the server returns the
identical response (`correctness.idempotencyReplayMismatches` must be 0).

### Overriding gate thresholds

Every number in `lib/metrics.mjs`'s `GATES` is CLI-overridable —
`--p95-read-edge`, `--p95-read-origin`, `--p95-authed`, `--ws-ready-rate`,
`--p95-ready`, `--event-lag-p95`, `--event-lag-p99`,
`--max-disconnects-per-hour`, `--max-cross-user-events`,
`--max-idempotency-mismatches`. Do this when you have the real audit
doc's numbers — see the provenance comment at the top of `lib/metrics.mjs`
for which thresholds are cited vs. judgment calls pending that doc.

## DO NOT

- **Never run 1,000 (or any) money-writing users against production.**
  `lib/writes.mjs` hard-refuses `nexa.aiso.tools` unconditionally, even
  if you mistakenly pass it in `--write-allowlist` — but don't rely on
  that as your only safety net. Point `--base` at staging, always.
- **Never point `--base` at production for a real certification run.**
  The default `--base` (`https://nexa.aiso.tools/api`) is production —
  it exists so a bare `--self-test` doesn't need a flag, not as an
  invitation to gate-run against prod. Every real ladder run above passes
  `--base` explicitly.
- **Never fan one token out across multiple simulated users.** That's
  the exact defect this harness replaces `load-gate.mjs` for for
  certification purposes — `assignIdentities()` refuses to start rather
  than silently degrade.
- **Never skip gates 0-3 and jump to gate 4.** The ladder exists so a
  regression shows up at 100 or 250 users, not for the first time at
  1,000.
- **Never treat a `--self-test` PASS as a certification result.** It
  proves the harness's own pipeline works against a local fixture, not
  that staging passes. Only a real `--gate 4` run against staging with a
  real 1,000-token pool is a certification result.

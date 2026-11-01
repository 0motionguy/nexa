# MAZE — Non-custodial pivot path

**2026-06-15 · Architecture synthesis · Code-grounded · NO code changes.**

Synthesises the per-surface custody map in
[`CUSTODY-ANALYSIS.md`](./CUSTODY-ANALYSIS.md) and the vendor matrix in
[`ONRAMP-WIDGET-OPTIONS.md`](./ONRAMP-WIDGET-OPTIONS.md) into a single
file-by-file seam map an implementer can walk top-to-bottom when (and if)
Mirko decides to pivot.

---

## 1. Purpose & scope

A **map, not a commitment.** When the pivot is taken, the implementer
opens this doc and knows precisely which files to touch, what each
change risks, and how to back out if a phase goes sideways. The pivot
remains **deferred** per Mirko's standing direction; this doc preserves
the option by documenting the route. Not a decision artifact, sprint
plan, or code change. Every claim cites a file:line; no source modified.

---

## 2. The `CUSTODY_MODE` flag — a research artifact

The pivot becomes safe to start only when a single switch gates new code
paths. **This flag is not added to the codebase in this session.** It
exists in this doc as a design artifact, to be implemented if-and-when
Mirko decides to pivot. It would sit beside the existing per-vendor
booleans at `lib/env.ts:213-232` as a 3-value enum:

`'semi-custodial'` (default — today) · `'non-custodial-prep'` (dual-write
transitional) · `'non-custodial'` (pivoted).

### Behaviour table per surface

| Surface | `semi-custodial` (today) | `non-custodial-prep` (dual-write) | `non-custodial` (pivoted) |
|---|---|---|---|
| Receive | on-chain (already) | on-chain | on-chain |
| Send | ledger debit `balUsd` | ledger + best-effort USDC transfer | user-signed USDC transfer; ledger=read-cache |
| Earn deposit | ledger move + chain mirror best-effort | ledger move + required chain submit | user-signed deposit; ledger row removed |
| Onramp | Bridge VA on MAZE | Bridge VA + widget URL (UI A/B) | widget redirect only |
| Offramp | Bridge transfer + ledger debit | dual path | widget redirect only |
| Card top-up (Gnosis) | MAZE-signed `createProxyWithNonce` | dual: MAZE OR user signs | user-signed Safe deploy |
| x402 settle | `store.x402Pay` pre-debits ledger | settle then observe ledger | settle only; pre-debit removed |
| Email-claim escrow | MAZE-held 30-day | on-chain escrow + MAZE-sweep fallback | on-chain escrow only |
| Subscription cron | MAZE-signed ledger debit | dual: cron + EIP-2612 attempts | permit-driven user-signed pull |

`non-custodial-prep` exists so the chain side can be proven in production
before the ledger debit is removed — and is the rollback target if a
later phase fails. Same shape as today's best-effort
`chain-mirror.ts:53-66`.

---

## 3. File-by-file seam map

Effort: **S** ≤1 wk · **M** 2–4 wk · **L** 4–8 wk.
Risk: **low** (mechanical) · **med** (test churn + integration) ·
**high** (chain UX + audit + on-call).

### 3.1 `apps/api/src/lib/privy.ts:21-24` — module-level `PrivyClient`

Hardcoded `PrivyClient` instantiation behind `features.privy`. Every
`signTypedDataWithPrivy` / `signRawWithPrivy` call (lines 88-100,
108-123) resolves through this single module client.

**Replace.** Introduce `WalletProvider` interface matching the
`WalletHandle` shape at `lib/chain/wallet.ts:33-39` plus a
`wallets/index.ts` factory: `privy` (today), `walletconnect`,
`coinbase-wallet`, `injected`. Privy stays as one provider.
**Effort M · Risk med.** Test fallout: every Privy-mocking fixture
either swaps to the abstraction or tags `@custody:semi-custodial`.

### 3.2 `apps/api/src/lib/chain/wallet.ts:81-97` — `getOrCreateUserWallet`

Always returns a Privy handle (per `CUSTODY-ANALYSIS.md` §3.1) — no
client-side escape hatch.

**Replace.** Branch on `features.custodyMode`. `non-custodial` returns
a relayer-style handle whose `signTypedData` proxies via EIP-1193 to
the user's connected wallet; `non-custodial-prep` provisions both —
ledger writes via Privy, chain submits via user-side. **Effort M · Risk
high** (signing latency + UX dead-ends if disconnected). Tests:
`apps/api/tests/chain/*` fixtures asserting `wallet.live === true` need
a user-signed mode.

### 3.3 `apps/api/src/lib/chain/privy-agent-wallet.ts:21-23` — agent wallets

Module-level `PrivyClient` plus `createPrivyAgentWallet` calling
`walletApi.create` directly (line 30) so each agent gets a fresh wallet
owned by the human's `did`.

**Replace.** Demote `PrivyClient` to the §3.1 abstraction. Under
`non-custodial`, agents either (a) keep Privy (Privy is TEE, human is
`did` owner — defensible per `CUSTODY-ANALYSIS.md` §1), or (b) require
the human to pre-fund an EIP-4337 smart account with per-agent session
keys + spend caps. **Effort S (a) / M (b) · Risk med.** Tests:
`apps/api/tests/agents/*` fixtures expecting a fresh walletId per agent.

### 3.4 `apps/api/src/store/postgres/ledger.ts:61-103` — `send`

`state.balUsd -= amountUsd` inside a Postgres tx; no chain transfer
signed. **The ledger debit IS the send** (per `CUSTODY-ANALYSIS.md` §3.3).

**Replace.** Under `non-custodial`: resolve user wallet handle (§3.2),
sign USDC `transfer(to, amount)`, submit via Alchemy 7702 executor
(`lib/chain/alchemy.ts:20-47`), write activity row post-confirmation.
`lockUserState` / `writeUserState` disappear. Under `non-custodial-prep`:
both fire — debit + chain attempt — mirroring today's chain-mirror.
**Effort M · Risk high** (most-tested ledger path; `insufficient_funds`
semantics flip from row-check to chain-revert). Tests:
`store/ledger/*.send.test.ts`, `routes/payments.test.ts`, all
`send-*` e2es.

### 3.5 `apps/api/src/store/postgres/ledger.ts:157-194` — `earnDeposit`

Ledger-first (`state.balUsd -= ...; state.earnUsd += ...`), then
`void this.chainMirror?.depositEarn(...)` fire-and-forget at line 193.

**Replace.** Invert: user-signs the Morpho/Aave deposit via the existing
mirror path (already implemented as best-effort, called post-commit);
submit via 7702 executor. `state.earnUsd` becomes a cached
vault-share read reconciled by a worker, or is removed entirely with
the read-path moved to `balanceOf(vaultShares) * sharePrice`.
**Effort M · Risk med** (the chain mirror is already best-effort —
this upgrades it to required, so failures must surface). Tests:
`store/ledger/*.earn.test.ts`, `chain/chain-mirror.test.ts`.

### 3.6 `apps/api/src/store/postgres/ledger.ts:105-155` — `topUp` + auto-divest

Credits `balUsd` from external rails (Bridge / Stripe webhooks, claim
refunds); auto-deposits tail above `divestThresholdUsd` (lines 144-153).

**Replace.** Under `non-custodial`, `topUp` invoked by Onramper webhook
(§3.13) writes only an activity row — USDC already landed in user's
wallet. Auto-divest tail becomes a user-side "move $X to Earn?" prompt
signing an Aave deposit on accept. **Effort S · Risk low.** Tests:
`store/ledger/*.topup.test.ts` + 3 webhook tests need non-custodial
variants.

### 3.7 `apps/api/src/store/postgres/ledger.ts:196-235` — `earnWithdraw`

Ledger-first reverse of §3.5; fires `chainMirror?.withdrawEarn`
post-commit (line 234).

**Replace.** Mirror §3.5's inversion — user-signs the Aave/Morpho
withdraw; ledger row becomes observation. **Effort S · Risk med** —
paired with §3.5.

### 3.8 `apps/api/src/store/postgres/ledger.ts:237-279` — `swap`

Pure ledger entry — no chain involvement, no FX vendor. Hardcoded
`RATE = 0.92` at line 238.

**Replace.** Either (a) leave as-is — swap is a demo-grade feature
not in the pivot critical path per `CUSTODY-ANALYSIS.md` §6 — or (b)
route through a DEX aggregator (1inch / 0x) with user-signed swap.
Recommend (a). **Effort S (defer) / L (DEX) · Risk low / high.**

### 3.9 `apps/api/src/store/in-memory/ledger.ts:30-80` — mirror module

Mirrors the Postgres shape with no transactions / locks (single-threaded
JS = atomic by construction). Used by tests + DEMO_MODE path.

**Replace.** Mirror every Postgres change — same `features.custodyMode`
branches. **Critical:** in-memory store stays semi-custodial in
DEMO_MODE even when `CUSTODY_MODE=non-custodial`, else demo loses its
tutorial property. Add a fixture toggle to flip in-memory non-custodial
for the §3.4 / §3.5 test suites. **Effort S · Risk low.** Tests:
`apps/api/tests/store/in-memory/*`.

### 3.10 `apps/api/src/store/postgres/claims.ts:33-58` — `recordClaim`

`send()` already debited the sender; parks the escrow row with
`expiresAt = now + 30 days` and a pregenerated Privy wallet address
(line 35, via `lib/chain/privy-claim.ts`). `claimFunds` (lines 70-125)
flips status + credits via `PgLedger.topUp`. `expireClaimsBefore`
(lines 136-176) refunds the sender similarly.

**Replace.** Phase 6 (hardest). On-chain escrow contract takes funds at
`send()` time under `non-custodial`, with two unlock paths: (a)
recipient's first-wallet signature (EIP-1271 lookup against the
pregenerated address as seed), (b) `block.timestamp > expiresAt` refund.
MAZE becomes relayer — never custodian during the window. **Effort L ·
Risk high** (smart-contract bug = lost funds). Tests:
`store/postgres/claims.test.ts`, e2e claim flow, new Foundry/Hardhat
suite.

### 3.11 `apps/api/src/routes/offers.ts:271-301` — `bank_topup` Bridge VA

`bridgeCreateCustomer` + `bridgeCreateVirtualAccount` returns ACH/SEPA
wire instructions in MAZE's name. Deposit webhook at
`routes/bridge.ts:238-256` credits `balUsd`.

**Replace.** Drop in the widget redirect sketched in
`ONRAMP-WIDGET-OPTIONS.md` §4 lines 88-131. Route returns `redirectUrl`
to Onramper; new `POST /checkout/onramper-webhook` writes activity row
when webhook fires (mirrors Bridge webhook pattern). Buyer's USDC lands
in their wallet — MAZE never custodies. **Effort L · Risk med** (UX
divergence: redirect away from MAZE). Tests: `routes/offers.test.ts`
`bank_topup` cases; new `routes/onramper-webhook.test.ts`.

### 3.12 `apps/api/src/routes/bridge.ts:137-234` — `/withdraw` (offramp)

`createBridgeTransferDebit` reserves `balUsd` + creates local
`nb_bridge_transfers` row; `bridge.createTransfer` sends fiat; transfer
webhook (lines 258+) flips local status. Demo synthesizes completion
via `setImmediate` (lines 219-230).

**Replace.** Inverse of §3.11 — return `redirectUrl` to a vendor-hosted
"sell USDC for fiat" page; user signs USDC transfer to vendor's address;
vendor sends fiat. No MAZE-held funds. **Effort L · Risk med.** Tests:
`routes/bridge.test.ts` withdraw cases need mode-tagged variants.

### 3.13 `apps/api/src/routes/bridge.ts:238-256` — deposit webhook

Bridge webhook → `applyBridgeDeposit(customerId, amountUsd, ref)` →
ledger credit.

**Replace.** Add `apps/api/src/routes/onramper-webhook.ts` verifying
Onramper's HMAC, calling a new
`store.applyOnrampDeposit(walletAddress, amountUsd, ref)`. Existing
`applyBridgeDeposit` stays for legacy Bridge customers still being
served (rollback target during `non-custodial-prep`). **Effort S · Risk
low.**

### 3.14 `apps/api/src/routes/claim.ts` — recipient surface

Public `GET /claim/:slug` reads the escrow row;
`POST /claim/:slug` calls `store.claimFunds` which credits via
`PgLedger.topUp` (per §3.10).

**Replace.** Route shape unchanged but `store.claimFunds` becomes
"relay the recipient's signature against the escrow contract." When the
contract unlocks, USDC arrives at the recipient's first-wallet address;
no MAZE ledger row is credited. **Effort M · Risk high** — paired with
§3.10. Tests: `apps/api/tests/routes/claim.test.ts` needs a
contract-integration fixture.

### 3.15 `apps/api/src/routes/payments.ts:33-80` — `/send`

Calls `store.send` (the ledger debit path at §3.4) and optionally
`store.recordClaim` for email recipients (§3.10).

**Replace.** Route surface unchanged — the swap is entirely inside
`store.send` per §3.4. The only route-side change is dropping `balUsd`
from the response (line 65) once it's no longer authoritative. **Effort
S · Risk low.**

### 3.16 `apps/api/src/routes/x402.ts:32-137` — `/x402/pay`

Per `CUSTODY-ANALYSIS.md` §3.7 — `store.x402Pay` at line 49 writes the
ledger debit BEFORE the chain settlement at lines 52-87 attempts
EIP-3009. The chain path is already non-custodial; the ledger write is
the semi-custodial fingerprint.

**Replace.** Invert order: try chain settle first; on success, write
activity row (OBSERVATION, not debit). Under `non-custodial`, chain
failure = request fails (no demo fallback). Under `non-custodial-prep`,
demo fallback at lines 89-93 stays. **Effort S · Risk low** (chain path
already production-tested; reorder + remove pre-debit). **Smallest-lift
surface — Mirko could pilot here.**

### 3.17 `apps/api/src/routes/card.ts:54-93` — `/card/order` + `/card/topup`

`/order` calls `getChainStack().gnosis.deploySafe(u.id)` (executor signs
the `createProxyWithNonce`). `/topup` routes the cross-chain deposit
through `stack.bridgeRouter` with the user's wallet handle.

**Replace.** Under `non-custodial`, `deploySafe` is signed by the user's
wallet handle (§3.2), making the Safe genuinely user-owned (salt at
`gnosisPay.ts:122` already keys off `userId` so deterministic-address
survives). Top-up is already user-handle based — just needs §3.2 in
place. **Effort M · Risk med** (user must sign Safe deploy at first use;
breaks "card works in 30 seconds" UX).

### 3.18 `apps/api/src/lib/chain/gnosisPay.ts:109-136` — `deploySafe`

Encodes `SafeProxyFactory.createProxyWithNonce` with `userId`-derived
salt; routes through `executor.sendCalls` (line 126). Falls back to a
deterministic demo address on any failure.

**Replace.** Swap executor for the user's wallet handle (§3.2). CREATE2
salt stays — `digest(userId, 'safe').slice(0, 16)` at line 122 — so
the deterministic Safe address property is preserved across the pivot.
User signs once at card creation; never again (Safe ownership is then
on-chain). **Effort S · Risk med.**

### 3.19 `apps/api/src/lib/chain/sponge.ts:52-88` — `createAgentCard`

Sponge issues card under MAZE's `SPONGE_API_KEY`. **Custodial by issuer
construction** — no non-custodial card-network path.

**Replace.** **None.** Document that `features.sponge` is incompatible
with `CUSTODY_MODE === 'non-custodial'` — either (a) block the mode for
users with a Sponge card, or (b) hybrid: agent runs custodial for Sponge
balance, non-custodial for everything else. **Effort none · Risk product.**

### 3.20 `apps/api/src/lib/chain/bridge.ts` — Bridge adapter

All Bridge calls degrade to demo when `features.bridge` is false (line
26 `isBridgeEnabled`). Used by §3.11 (deposit VA), §3.12 (offramp),
§3.13 (deposit webhook).

**Replace.** Adapter stays — backwards compatibility for any user
mid-flight on a Bridge VA. Add `apps/api/src/lib/chain/onramper.ts`
mirroring the same env-gate-or-demo shape (per
`ONRAMP-WIDGET-OPTIONS.md` §4 env-vars block). Both adapters coexist
during `non-custodial-prep`; under `non-custodial`, Bridge reachable
only for legacy VA holders. **Effort S · Risk low.**

### 3.21 `apps/api/src/workers/subscription-renewer.ts` (per `CUSTODY-ANALYSIS.md` §4.3)

Cron iterates active subscriptions past `currentPeriodEnd` and calls
`store.renewSubscription` — ledger debit inside MAZE-owned cron context.

**Replace.** Rewrite to (a) check for valid EIP-2612 permit on buyer's
USDC (signed at first checkout, `deadline` covers renewal), (b) submit
permit + transfer via 7702 executor, (c) write observation
post-confirmation. UX: "renew permission" prompt as `deadline` nears
expiry. **Effort M · Risk med** (permit UX is the main unknown).

---

## 4. Migration phase plan

Each phase ships behind `CUSTODY_MODE`; the prior mode remains a
deploy-time fallback until the phase is proven stable.

### Phase 1 — Add `CUSTODY_MODE` interface (1 wk, 1 file)

Add the flag to `lib/env.ts:213-232` (per §2). Default `semi-custodial`.
No behaviour changes — purely interface.
- Files: `lib/env.ts`. Tests: none.
- Rollback: revert single PR.

### Phase 2 — Onramp pivot (4–6 wk)

Replace `routes/offers.ts:271-301` `bank_topup` under the non-custodial
flag; add `routes/onramper-webhook.ts`; add `lib/chain/onramper.ts`
adapter. Bridge offramp at `routes/bridge.ts:137-234` follows the same
vendor pick.
- Files: 4 (`routes/offers.ts`, `routes/bridge.ts`, new
  `lib/chain/onramper.ts`, `lib/env.ts` for env additions per
  `ONRAMP-WIDGET-OPTIONS.md` §4). Tests: ~6 files need mode variants.
- Rollback: flip `CUSTODY_MODE` env to `semi-custodial`; Bridge VA path
  is still wired, immediately resumes serving.

### Phase 3 — Ledger read-path swap (3–4 wk)

Under `non-custodial`, `balUsd` = cached on-chain USDC `balanceOf`
read (debounced); `earnUsd` = cached vault-share read. No write-path
changes yet.
- Files: 3 (`store/postgres/ledger.ts`, `store/in-memory/ledger.ts`,
  new `lib/chain/balance-reader.ts`). Tests: ~12 files.
- Rollback: flip to `non-custodial-prep` — write-path still primary;
  read falls back to row.

### Phase 4 — Wallet ownership swap (4–6 wk)

Introduce `WalletProvider` abstraction (§3.1); branch
`getOrCreateUserWallet` on `features.custodyMode` (§3.2). Upgrade `send`
(§3.4), `earnDeposit` (§3.5), `earnWithdraw` (§3.7), `x402.pay` (§3.16)
to user-signed under the flag.
- Files: 7 (`lib/privy.ts`, `lib/chain/wallet.ts`,
  `store/postgres/ledger.ts`, `store/in-memory/ledger.ts`,
  `routes/x402.ts`, `routes/payments.ts`, new `lib/chain/wallets/*`).
  Tests: ~20 files.
- Rollback: `non-custodial-prep` keeps both paths wired (chain attempt
  best-effort, ledger source of truth). Drop to `semi-custodial` to
  fully revert.

### Phase 5 — Card path decision (3–5 wk)

Resolve §3.19 hybrid. If Gnosis only: upgrade `gnosisPay.ts:109-136`
deploySafe to user-signed (§3.18); update `routes/card.ts:54-93`. If
hybrid: per-agent flag distinguishing Sponge-custodial vs everything-else
non-custodial.
- Files: 3 (`lib/chain/gnosisPay.ts`, `routes/card.ts`, optionally
  `lib/chain/sponge.ts`). Tests: ~5 files.
- Rollback: flag flip; executor-signed deploys still work for new users.

### Phase 6 — Claim escrow on-chain (6–8 wk)

Author + audit escrow contract; rewire `claims.ts:33-58` and
`claims.ts:136-176` (§3.10); update `routes/claim.ts` to relay recipient
signatures (§3.14). Subscription cron rewrite (§3.21) ideally bundles in.
- Files: 4 + new contract repo (`store/postgres/claims.ts`,
  `routes/claim.ts`, `workers/subscription-renewer.ts`,
  `lib/chain/privy-claim.ts`). Tests: ~8 API + new contract suite.
- Rollback: contract pause + `non-custodial-prep` for claims (MAZE-held
  escrow resumes for new claims; existing on-chain ones need unlock).

**Total.** 10–14 wk single engineer, 6–8 wk with two (per
`CUSTODY-ANALYSIS.md` §6 Option A). Phase 6 carries the longest tail
due to the contract audit.

---

## 5. Rollback strategy

The `CUSTODY_MODE` flag enables instant deploy-level fallback — no code
revert required. Per-phase signals:

- **Phase 2:** Onramp completion rate drops >20% w/w → flip to
  `semi-custodial`; Bridge VA resumes.
- **Phase 3:** Balance display lag >5s (RPC slow) → flip to
  `non-custodial-prep`; ledger row read returns.
- **Phase 4:** Chain settle failure rate >2% on `send` → flip to
  `non-custodial-prep` for dual-write, then `semi-custodial` if wedged.
- **Phase 5:** First-card-creation drop-off >30% (user can't sign Safe
  deploy) → flip card path to executor-signed.
- **Phase 6:** Escrow contract bug surfaces → contract pause (admin
  role) + flip claim flow to `non-custodial-prep`.

**Persistent state caveat.** Per `CUSTODY-ANALYSIS.md` §7 closing:
"C → B → A is reversible; A → C is not trivially reversible." Once a
user's funds are at their own wallet address (Phase 3+), rolling back
to `semi-custodial` cannot retroactively pull those funds into MAZE's
ledger — rollback gates NEW transactions only. Document this in the
rollback runbook.

---

## 6. Surfaces that don't pivot (restated from B1)

Stay semi-custodial regardless of `CUSTODY_MODE`.

- **Email-claim 30-day window (§3.10).** Even after Phase 6, MAZE
  remains the only party that can submit the expiry sweep. Custody of
  funds flips from ledger to contract; operational role doesn't.
- **US debit cards via Sponge (§3.19).** Card-network rails require
  issuer custody to settle Visa/MC authorization within seconds — no
  non-custodial path at the card-network layer (`CUSTODY-ANALYSIS.md`
  §4.1).
- **Subscription renewal cron (§3.21).** The cron triggers permit
  submits but the permit must be periodically refreshed by the buyer —
  UX surface that doesn't exist today (`CUSTODY-ANALYSIS.md` §4.3).

---

## 7. Test impact

| Phase | API | E2E | New |
|---|---|---|---|
| 1 | 0 | 0 | 1 (`env.test.ts`) |
| 2 | ~6 | 2 | 2 (onramper webhook + adapter) |
| 3 | ~12 | ~4 | 2 (balance-reader + RPC fallback) |
| 4 | ~20 | ~6 | 3 (wallet-factory, user-signed-send, mode-branch) |
| 5 | ~5 | 1 | 1 (user-signed Safe deploy) |
| 6 | ~8 | 2 | 5+ (Foundry suite + relay tests) |
| **Total** | **~51** | **~15** | **~14** |

~70 tests across the full pivot. Repo today runs 502 API + 12 web + 6
shared-zod + 74 Playwright (per `STATE-OF-BUILD.md`) — churn is ~14%.
Tag affected tests with `@custody:<mode>` so the runner filters by mode
under CI matrix builds.

---

## 8. Open questions for the implementer

This doc CANNOT decide these — they require Mirko's product input,
vendor sales conversations, or pending security reviews.

1. **Onramper vs. Stripe Crypto vs. direct vendor** —
   `ONRAMP-WIDGET-OPTIONS.md` §3 default is Onramper. Mirko's call
   depends on whether MAZE's Stripe relationship is leveraged or
   replaced.
2. **Escrow contract pattern (§3.10)** — custom contract, fork of an
   audited template (Sablier? Disperse?), or generic primitive (Across?)
   — audit budget + timeline are the constraints.
3. **Card hybrid model (§3.19)** — drop Sponge entirely, keep it only
   for agent cards (flagged separately), or "custodial-card-or-no-card"
   toggle? Affects agent-card product surface.
4. **Wallet provider lineup (§3.1)** — WalletConnect alone, or
   WalletConnect + Coinbase Wallet + injected? Each additional provider
   = ~1 wk integration + test coverage.
5. **Subscription permit UX (§3.21)** — re-sign cadence? 30 days, 365
   days, indefinite `deadline`? Trades UX friction against blast radius.
6. **Dual-write phase duration** — `non-custodial-prep` is meant as
   transient but might stay on for months while metrics are gathered.
   Define a sunset trigger before Phase 3 ships.
7. **In-memory store posture (§3.9)** — does DEMO_MODE flip to
   non-custodial with the env, or stay semi-custodial for the tutorial?
   Affects the onboarding flow `STATE-OF-BUILD.md` cites as primary
   demo path.
8. **Regulatory review** — does dropping Bridge KYB actually eliminate
   MTL exposure across MAZE's target jurisdictions? `CUSTODY-ANALYSIS.md`
   §6 Option A claims yes; Mirko's lawyer must confirm.

---

**End of pivot path.** Phase count: 6. Estimated total weeks: 10–14
(single engineer) / 6–8 (two engineers). Files touched across all
phases: 23 distinct files + 1 new contract repo. The pivot remains an
**option, not a decision**; this doc exists so the option stays cheap
to take.

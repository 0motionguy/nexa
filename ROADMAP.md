# MAZE — Integration Roadmap

> **Status (2026-06-21):** Forward-looking build roadmap. Pairs with [`HANDOVER-2026-06-21-EVENING-API-LAYER.md`](docs/handovers/HANDOVER-2026-06-21-EVENING-API-LAYER.md) (authoritative *current* state) — this doc is the authoritative *next* state. Brand is **MAZE** (internal packages stay `@nexa/*`; the rename is user-visible only). Every integration below lands as an **env-gated adapter** like the existing sweep: code ships now, flips live when the vendor key / KYB clears.
>
> **Sprint 21 closeout (2026-06-21):** Six-venue markets surface + Stocks tab (trade.xyz HIP-3 + Backed xStocks) + fees layer + unified `/me/profile` aggregator + `@nexa/sdk` typed client + `@nexa/mcp` stdio server. **104/106 markets+auth tests pass**; backend + SDK typecheck clean. See [HANDOVER-2026-06-21-EVENING-API-LAYER.md](docs/handovers/HANDOVER-2026-06-21-EVENING-API-LAYER.md).
>
> **Sprint 17 Phase E closeout (2026-06-19):** 11-protocol audit + 9 CP remediations + post-merge security/code review shipped. 727/727 tests, lint + typecheck clean. **150+ catalogued improvements** for Sprint 18+ in [HANDOVER-2026-06-19.md §5](docs/handovers/HANDOVER-2026-06-19.md#part-5--deep-improvement-catalog).

---

## Sprint 21 — Six-venue markets + Stocks + Public API (closed 2026-06-21)

**Driver:** "We have a Trade tab — make it complete (all venues, real data, real trades), add tokenized stocks, and give third parties + AI agents a way to consume the surface."

| Item | Status | Evidence |
|---|---|---|
| Lift HL perps cap (30 → 500) | ✅ | `hyperliquid.ts` `HL_VISIBLE_PERPS_LIMIT` |
| Lift Polymarket pagination (12 → 50 pages, ~5k markets reachable) | ✅ | `polymarket.ts` `MAX_PAGES` |
| HL Spot adapter + tab + sheet (307 pairs, asset id `10000 + idx`) | ✅ | `hyperliquid-spot.ts`, `app/(tabs)/spot.tsx`, `HyperliquidSpotOrderSheet.tsx` |
| Memes tab (pump.fun + Jupiter merged) + swap via Jupiter | ✅ | `pumpfun.ts`, `jupiter.ts`, `app/(tabs)/memes.tsx`, `JupiterSwapSheet.tsx` |
| **Stocks tab — trade.xyz HIP-3 perps + Backed xStocks spot** | ✅ | `hyperliquid-hip3.ts`, `xstocks.ts`, `app/(tabs)/stocks.tsx`, `StocksPerpOrderSheet.tsx`, `StockLogo.tsx` |
| Real-time charts on stocks (LightweightChart wired to HL candles) | ✅ | `app/markets/stocks/perp/[coin].tsx` |
| **Fees layer** — Jupiter `platformFeeBps` env-driven + tracker + Prometheus | ✅ | `lib/fees.ts`, `JUPITER_PLATFORM_FEE_*` env, `recordFee` in 5 success paths |
| **`GET /me/profile`** unified aggregator | ✅ | `routes/me.ts` |
| **`@nexa/sdk`** typed TS client | ✅ | `packages/nexa-sdk/` |
| **`@nexa/mcp`** stdio MCP server with 14 tools | ✅ | `apps/mcp/` |
| Docs: API.md, FEES.md, PROFILE.md, SDK.md, MCP.md | ✅ | `docs/` |

**Next gate:** Set production fee env vars (`HL_BUILDER_ADDRESS` +
`HYPERLIQUID_BUILDER_FEE_TENTHS_BP` + `JUPITER_PLATFORM_FEE_BPS` +
`JUPITER_PLATFORM_FEE_ACCOUNT`), pre-create Solana fee-receiver ATAs, $1
live smoke trade on trade.xyz HIP-3 to confirm asset-id encoding. See
[HANDOVER-2026-06-21-EVENING-API-LAYER.md §7](docs/handovers/HANDOVER-2026-06-21-EVENING-API-LAYER.md#part-7--production-action-list-for-the-user).

---

## Sprint 22 — Production fee enablement + SDK publish + nb_fees_earned (next)

Suggested sequence, all small or medium tasks:

1. **Set production env vars** + restart API + verify revenue flows
2. **Live $1 smoke trade** on trade.xyz HIP-3 (confirms asset-id encoding)
3. **`pnpm install` + build SDK + MCP** (workspace pickup of new packages)
4. **Publish `@nexa/sdk`** to npm (`cd packages/nexa-sdk && pnpm publish`)
5. **`nb_fees_earned` table** — durable accounting alongside the in-memory ring (migration `0023_fees_earned.sql` + schema + store methods)
6. **Wire `developers.html`** with SDK quickstart + Swagger UI iframe → branded `developers.maze.to` URL
7. **Polymarket spread monetization** if PM volume warrants (1-cent server-side markup on limits)
8. **`userSetAbstraction`** wiring for HIP-3 — if the canonical builder approval doesn't transparently cover it
9. **Publish `@nexa/mcp` to npm** so agent hosts can `npx -y @nexa/mcp`

Derived from the seven planning docs (`BUILD-PLAN`, `CARD-LAYER-DECISION`, `PLAN-ADDENDUM-V2`, the strategy doc, `MAYZ-FACILITATOR`, `GAMER-GTM`) audited against the live codebase on 2026-06-13. Refreshed for Sprint 17 Phase E protocol audit on 2026-06-19.

---

## Sprint 17 Phase E — Test-cohort readiness (closed 2026-06-19)

**Driver:** Mirko wants 2–3 friendly testers funding with crypto, executing Send / Swap / Trade-perps / Trade-prediction / Stake / Yield. Audit ran across 11 protocols; remediated everything that blocked the pilot.

| CP | Description | Status |
|---|---|---|
| CP-1 | Polymarket CLOB L2 auth (L1 EIP-712 derive + L2 HMAC) + tokenId fix | ✅ |
| CP-2 | Hyperliquid pilot prep (operational) | ✅ pending Mirko |
| CP-3 | Hyperliquid backend verify (already used `metaAndAssetCtxs`) | ✅ verified |
| CP-4 | Solana foundation (DB columns + sign-in caching) | ✅ |
| CP-5 | Marinade live stake/unstake via SDK | ✅ |
| CP-6 | Mayan Swift both directions (Solana-source via SDK; EVM-source via executor) | ✅ |
| CP-7 | x402 facilitator URL fix (was 404) | ✅ |
| CP-8 | Privy SDK deprecation noted (defer migration) | ✅ documented |
| CP-9 | Admin tooling (cohort + dashboard + force-recovery) + Sentry cohort tag | ✅ |

**Post-merge polish (Phase H):** shared `solana-tx.ts` helper with `confirmTransaction`, admin HTML console (XSS-safe), security review HIGH/MED fixes (self-drain block, rate limiting, audit-before-throw, PM derive coalescing).

**Next gate:** $20 pilot run (Mirko, 60 min). See [HANDOVER-2026-06-19.md §6](docs/handovers/HANDOVER-2026-06-19.md#part-6--operational-runbook-next-30-days).

---

## The keystone insight (why the ordering is what it is)

Nearly every stubbed write-path throws `not_implemented` for the **same** missing primitive: an **EIP-7702 batch executor** — `apps/api/src/lib/chain/alchemy.ts` (Privy server-wallet `signAuthorization` + Alchemy `wallet_prepareCalls`/`sendPreparedCalls` + Gas Manager sponsorship). One file unblocks **six** features at once: Aave deposit/withdraw, yoUSD, Compound, Morpho, LIFI execute, Gnosis card top-up.

The **facilitator core is the exception** — offer → link → card-pay → balance → fulfillment → webhook needs only card acceptance + the existing ledger + Resend, **no 7702**. So the get-paid product (the commercial headline) ships first; the 7702 engine sprint comes after.

---

## Parallel track — vendor gates (non-code, start now; the real long poles)

- [ ] **Bridge.xyz KYB** — longest pole (1–4 wk). Gates real account numbers, onramp/offramp, checkout card acceptance.
- [ ] **Sumsub** account — hosted KYC SDK.
- [ ] **Gnosis Pay** partnership application (permissionless works day 1; partner mode unlocks PAN display + webhooks).
- [ ] **Rain** intro email — engage only when credit model or a geo Bridge can't serve is needed.
- [ ] **Domain** — register `maze.to` (payment links) + confirm app/portal hostnames in Cloudflare.
- [ ] **Apple Developer** — only when a mobile shell is in scope.
- [ ] **Brand consolidation** — collapse stray NEXA / MAYZ / KEIN references to MAZE in user-visible copy.

---

## Phase 1 — The get-paid product (facilitator-first, demo/sandbox rails)

### Sprint 1 — Get-paid core ✅ *(shipped 2026-06-13)*
Offer + hosted `maze.to/o/<id>` checkout + sandbox card-pay → `payment.paid` → balance credit + Resend fulfillment + signed (HMAC) webhook.
- [x] `nb_offers` / `nb_payments` / `nb_webhook_endpoints` schema + migration (`0001_chemical_baron_strucker.sql`) + store methods (in-memory + postgres)
- [x] `routes/offers.ts` (seller CRUD) + `checkoutRoutes` (public `GET /checkout/:id` + `POST /checkout/:id/pay`) + `lib/webhooks.ts` (HMAC, retry/backoff)
- [x] `checkout.html` hosted page + seller "New offer" surface in `app.html` (LIVE-only)
- [x] fulfillment email template; `payment.paid` credits seller + activity row (SSE) + webhook
- [x] unit (store + webhook) + e2e (`checkout.spec.ts`) tests; `pnpm verify` green (52 e2e)

### Sprint 2 — Developer surface ✅ *(shipped 2026-06-13)*
- [x] API keys `sk_test_` / `sk_live_` (sha256-hashed, masked prefix+last4, shown once), managed in the app's Developers surface (`/keys` session routes)
- [x] `/v1` REST (api-key auth via `requireApiKey`): `POST/GET/PATCH /v1/offers`, `GET /v1/payments[/:id]`, `GET /v1/balance` — bare resources + `{object:'list'}` + `{error:{type,message}}` dialect
- [x] Sandbox mode — `sk_test_` keys write `livemode:false` offers/payments crediting an isolated `sandboxBalUsd`; `Idempotency-Key` on `POST /v1/offers`
- [x] Public API reference page (`developers.html`) + unit (`v1`, `keys`) + e2e (`dev-keys.spec.ts`); migration `0002_nasty_the_professor.sql`

### Sprint 3 — Payouts + sub-accounts ✅ *(shipped 2026-06-13)*
- [x] `POST/GET /v1/payouts` (+ `/:id`) — pay a dev/collaborator; debits balance (live or sandbox), `402` on insufficient funds
- [x] `POST/GET /v1/sub-accounts` (+ `/:id`) — isolated balance per business (one KYC, many businesses), live + sandbox buckets
- [x] `split_revenue` — offers take `subAccountId` + `splits:[{subAccountId|email, percent}]`; sub-account splits credit balances, email splits become auto-payouts
- [x] `payout.completed` webhook (fires on direct payout + each email split); migration `0003_glamorous_solo.sql`; `payouts.spec.ts` + `v1.spec.ts` (70 API tests)

### Sprint 4 — Facilitator MCP + subscriptions ✅ *(shipped 2026-06-13)*
- [x] MCP facilitator tools `create_offer` / `get_payments` / `create_payout` / `split_revenue` (alongside the agent-wallet tools) — verified live over `POST /mcp`
- [x] Subscriptions: `payOffer` mints a subscription on `type:'subscription'`; `/v1/subscriptions` list/get + `renew` (advances period, credits seller) + `cancel`; `subscription.renewed` / `subscription.canceled` webhooks
- [x] **Headline demo proven:** an agent creates a priced offer → gets a link → and splits revenue across a crew, all via MCP. Migration `0004_fast_thunderbolt.sql`; `subscriptions.spec.ts` + `v1.spec.ts` (80 API tests)

> **Phase 1 (the get-paid product) is COMPLETE** — offers, hosted checkout, payments, fulfillment, webhooks, API keys, sandbox, payouts, sub-accounts, splits, subscriptions, and full MCP. All demo/sandbox-rail; real money turns on with Bridge KYB (Phase 2).

---

## Phase 2 — Make the money real (vendor-gated engine)

### Sprint 5 — Bridge.xyz compliance perimeter ✅ *(onramp shipped 2026-06-13; offramp shipped in S10 Phase 1 β)*
- [x] `lib/chain/bridge.ts` (env-gated, demo fallback) — `createCustomer` (hosted KYC) + `createVirtualAccount` (US ACH + EU IBAN) + `verifyWebhook` (HMAC) + `parseDepositEvent`
- [x] `/bridge` routes: `POST /customer`, `POST /virtual-account`, `GET /accounts` (session), `POST /webhook` (public) → a real ACH/SEPA deposit credits the live balance (idempotent, acks)
- [x] Virtual accounts seeded in demo + exposed on `/ledger/me` (the money screen is the global-account hero); migration `0005_tearful_rictor.sql`; `bridge.spec.ts` (13) + store tests → 97 API tests
- [x] **Offramp (Item B):** Done in S10 Phase 1 β — `createExternalAccount` + `createTransfer` + `/bridge/payout-method` (CRUD) + `/bridge/withdraw` + `transfer-webhook` with idempotency on `external_ref` (durable dedup via `nb_bridge_webhook_events`); failed transfers re-credit balUsd; fires `payment.paid`/`transfer.completed` via existing `fireWebhooks`. UI wiring in S10 Phase 3 (Withdraw to bank sheet on s14).
- [x] **Card acceptance refactor (Item G):** Done in S10 Phase 1 β — `checkout.html` no longer ships a demo card form; humans pay via `payOffer` against `balUsd` (same path as agents). Inline OTP for signed-out buyers + magic-link OTP. The `method:'card'` demo branch is retained behind `DEMO_MODE=1` for legacy e2e.

### Sprint 6 — KYC + pregenerated wallets ✅ *(shipped 2026-06-13; reclaim sweep shipped in S10 Phase 1 α)*
- [x] `lib/kyc.ts` — Sumsub applicant-token flow + `/kyc/start` `/kyc/status` `/kyc/webhook` (review → `setKyc`), env-gated demo fallback
- [x] `lib/chain/privy-claim.ts` — pregenerated wallet keyed to the email; `recordClaim` parks the escrow (30-day expiry) on `/payments/send` to an email
- [x] `/claim/:slug` (public view + claim → credits recipient via find-or-create); `nb_claim_wallets` gains slug/status/sender_name (migration `0006_black_avengers.sql`); `claims.spec.ts` + `claim.spec.ts` → 126 API tests
- [x] **Reclaim sweep (Item C):** Done in S10 Phase 1 α — `expireClaimsBefore(cutoff)` (postgres uses `FOR UPDATE SKIP LOCKED`) refunds the sender via `topUp(senderUser, amountUsd, 'Refund · Claim expired')`. Daily BullMQ Repeat `0 3 * * *` UTC (`workers/claim-sweeper.ts`) + manual `POST /admin/sweep-claims` via the ε admin token.

### Sprint 7 — The engine (7702 keystone) + earn done right ✅ *(keystone + yoUSD + auto-divest all shipped)*
- [x] `lib/chain/alchemy.ts` — **EIP-7702 batch executor** (the keystone): `wallet_prepareCalls` + Gas Manager sponsorship + Privy `signRawWithPrivy`, all degrading to a demo tx on any error
- [x] `lib/chain/yousd.ts` — **primary** earn (yoUSD ERC-4626 vault, `YOUSD_ADDRESS` default `0x0000000f2eB9f69274678c76222B35eEc7588a65`), `getApyBps`/`deposit`/`withdraw` via the executor
- [x] Aave `depositUsd`/`withdrawUsd` finished on the executor (the old `not_implemented` throws are gone); earn route routes through yoUSD-primary when chain-live, demo stays ledger-only; `earn.spec.ts` (chain 11 + route 5) → 113 API tests
- [x] `lib/chain/compound.ts` (Comet) + `lib/chain/morpho.ts` (MetaMorpho) earn adapters + `lifi.executeSwap` finished + `GET /earn/protocols` diversification view (yoUSD/Aave/Compound/Morpho APYs) → 165 API tests
- [x] **Earn-by-default + auto-divest (Item A):** Done in S10 Phase 1 α — `nb_user_state.{earn_by_default, auto_divest_on_spend, divest_threshold_usd}` columns; toggles persist via `POST /earn/configure`; auto-divest wired in `send`, `payOffer` buyer-debit, `x402Pay`; `topUp` tail auto-deposits the excess above `divestThresholdUsd` when `earnByDefault` is on. UI wiring in S10 Phase 3 (AUTOMATION card on s14). **Live path needs:** `ALCHEMY_API_KEY` + `ALCHEMY_GAS_POLICY_ID` + Privy server wallets + `privyDid` threaded into the executor.

---

## Phase 3 — Cards, markets, creator loop

### Sprint 8 — Card layer ✅ *(shipped 2026-06-13)*
- [x] `lib/chain/gnosisPay.ts` finished — `deploySafe` (SafeProxyFactory calldata via the executor, no SDK dep) + `orderVirtualCard` (permissionless mint) + `getCard`/`getCardBalanceUsd`/`getCardTransactions`; `/card` GET details + `POST /card/order`
- [x] `lib/chain/lifi.ts` cross-chain — `topUpCardCrossChain` (Base USDC → Gnosis EURe via the executor); `POST /card/topup` logs the move (no ledger credit)
- [x] `lib/chain/sponge.ts` — agent virtual cards + agent bank accounts (REST + demo, no SDK dep); `POST /agent/:id/card` + `POST /agent/:id/bank`; `cards.spec.ts` ×2 → 141 API tests
- *(Live needs `GNOSIS_PAY_API_KEY` / `SPONGE_API_KEY` + the executor's wallet threading; demo deterministic per user)*

### Sprint 9 — Markets (gated, read-only) ✅ + Sprint 10 trading layer (gated, write) ✅
- [x] `lib/markets/hyperliquid.ts` — read-only market data (info API) + `builderApprovalParams` (clamped to the 10 bps perps cap, returns the human's approval sheet, executes nothing)
- [x] `lib/markets/polymarket.ts` — Gamma read-only + `isRegionAllowed` geo-gate (US/GB/DE/FR/IT/JP/SG/AU/BE/PL/RU/IR/KP blocked → 451)
- [x] `/markets` routes (`requireSession`, eligibility-flag gated); read-only by default. `markets.spec.ts` ×2 → 155 API tests
- [x] **Markets trading (Item E):** Done in S10 Phase 1 γ — Hyperliquid `placeOrder/cancel` (EIP-712 L1 action via Privy server wallet, builder cap honored) + Polymarket `placeOrder` (CLOB signed limit order). Strict guards on every POST: geo-block (451), $1k pre-KYC cap (403 `kyc_required`), kill-switch (423). Live needs `PRIVY_APP_ID` + `HL_BUILDER_ADDRESS` (Hyperliquid) or Polymarket equivalent. Compliance review required before flipping `MARKETS_TRADE_ENABLED=1`.
- [x] **Geo UI (Item H):** Done in S10 Phase 1 γ — `<region-pill>` custom element mirrors server BLOCKED set; reads from `localStorage['maze.region']` with `Accept-Language` fallback. UI wiring in S10 Phase 3 (pill on perks tab + per-venue pills for Hyperliquid + Polymarket in s14 PERKS seg). Server still authoritative.

### Sprint 10 — Creator / earn loop ✅ *(all closeout items shipped 2026-06-14)*
- [x] Clip campaigns + payment-link composer already ship as working **demo web** surfaces (covered by `app-flows.spec.ts`: "campaigns: join + claim payout", "payment link composer emits one-time link"); the composer is backed by `/payments/request-link`
- [x] **Campaigns/perks backend (Item F):** Done in S10 Phase 1 γ — `nb_campaigns` / `nb_campaign_submissions` / `nb_user_perks` schema + `POST/GET /campaigns`, `POST /campaigns/:id/submit`, admin agent-key `POST /campaigns/:id/submissions/:subId/{approve, release-bonus}`, `GET /perks`. v1 redirect constants live in `lib/campaigns/perks.ts` (`TIER_THRESHOLDS`, `TIER_MULTIPLIERS`, `POINTS_PER_USD`, `MAX_SUBMISSIONS_PER_CAMPAIGN`). `awardPoints` called from `releaseBonus` + `routes/card.ts` charge path. `lib/campaigns/verify.ts` reserves a v2 view-count hook (TikTok/YouTube API, env-gated).
- [x] **UI wiring (Phase 3):** Done in S10 Phase 3 — live campaigns list + submit sheet (clipUrl + platform + viewsAttested) on s14 GET-PAID seg; perks tier card on s14 PERKS seg; admin approve/release-bonus intentionally *not* exposed (agent-key only).

### Sprint 10 Phase 2 — Infra closeout ✅ *(all shipped 2026-06-13)*
- [x] **Observability (δ):** Done in S10 Phase 2 δ — `@sentry/node` v8 init as first import in `apps/api/src/index.ts` (gated on `SENTRY_DSN`); user context via `withSentryUser`; pino-sentry-transport at warn level to dedupe with `app.onError → captureException`. `prom-client` histogram + counters + queue-depth gauges (`http_request_duration_seconds`, `payments_*`, `claims_*`, `earn_*`, `mcp_requests_total`, `x402_settlements_total`, `markets_orders_total`, `campaign_payouts_total`, `bullmq_queue_depth`). `/metrics` mounted before auth, gated on `METRICS_ENABLED && Authorization: Bearer ${METRICS_TOKEN}`; Caddy also blocks `/metrics` at edge.
- [x] **Scheduler + admin + errors (ε):** Done in S10 Phase 2 ε — standalone `neobank-scheduler` container (same image as API, `node dist/workers/scheduler.js`), `restart: on-failure` with inline degradation when Redis unavailable. `POST /admin/sweep-claims`, `POST /admin/sweep-subscriptions` gated by `Authorization: Bearer ${ADMIN_TOKEN}`. `ApiError` class + `errorHandler` middleware in `lib/errors.ts` (JSON `{ ok:false, error:{code, message, requestId, details?} }`; ZodError 422 + flatten; 500 `internal` else; Sentry capture for ≥500). Adopted in `admin.ts` + `payments.ts` as exemplars.
- [x] **Deploy fragments + RUNBOOK + DNS + CI (ζ):** Done in S10 Phase 2 ζ — `infra/compose-fragment.yml` extended with `neobank-migrate` one-shot + `neobank-scheduler` long-running; `infra/caddy-fragment.conf` gains `app.maze.bank`, `checkout.maze.bank`, `dev.maze.bank`, `mcp.maze.bank` host blocks (CF Origin Certs, `auto_https off`). `nexa/RUNBOOK.md` (bring-up + smoke + backups + vendor flip + rollback + incident matrix), `nexa/DNS-CONFIG.md` (6 records + CF Origin Cert install + `dig +trace` smoke script). CI: `drizzle:check` in `build-and-push.yml`; weekly `verify` cron (Monday 06:17 UTC).

### Sprint 10 Phase 3 — UI wiring + verify gate + docs reconcile ✅ *(shipped 2026-06-14)*
- [x] Earn config toggles (Item A) on s14 BALANCE seg, hydrated from `/auth/me`, persist via `/earn/configure`.
- [x] Bridge offramp Withdraw to bank sheet (Item B) with payout-method picker + add-method form (ACH/SEPA/wire/crypto) on s14.
- [x] Campaigns live list + submit sheet (Item F) on s14 GET-PAID seg; perks tier card hydrates on PERKS seg.
- [x] Markets region pills (Item H) on Hyperliquid + Polymarket cards in s14 PERKS seg.
- [x] ROADMAP + HANDOVER reconciled. Commit range `915533e..640ad14` covers Phase 0/1/2; Phase 3 lands on top.

### Sprint 11 stubs (follow-up, not built yet)
- [ ] Broader `ApiError` migration across all 30 route files (exemplar in `payments.ts`; back-compat handler in place).
- [ ] v2 view-count API verification for campaign submissions (TikTok/YouTube; hook reserved in `lib/campaigns/verify.ts`, env-gated).
- [ ] Admin agent-key role/label support — campaigns approve/release currently accepts any agent key, not a scoped role.
- [ ] TikTok/YouTube API plumbing for automated `viewsVerified` updates (paired with the v2 verify hook).
- [ ] DNS cutover: register `maze.bank` (domain registration + CF Zero Trust hostnames per the prior session's deferred note in §10 of HANDOVER).

---

## Stack upgrades (2026-06-14)

Commit range: `d0146b7..aa1c994`. See `UPGRADE-REPORT.md` for the full report
(addresses verified, testnet vs mainnet, documentation drift caught).

- [x] **Upgrade 1 — Earn router** (Standard / Higher-Yield tiers, Morpho
  Steakhouse vault pinned, blended-APY view). Commit `70f3f53`.
- [x] **Upgrade 2 — Socket bridge router** (Socket primary with LIFI fallback,
  Refuel destination-gas drop on Base→Gnosis). Commit `5beaac7`.
- [x] **Upgrade 3 — Per-agent wallets + agent moat** (Privy server wallet per
  agent, `agent.blocked` webhook, `humanApprovalThresholdUsd` enforced, daily
  Resend digest cron). Commit `8c0e422`.
- [x] **Upgrade 4 — Stripe Checkout multi-method** (balance / card / bank_topup
  on the same hosted checkout, Stripe v22.2.1 / apiVersion `2026-05-27.dahlia`).
  Commit `aa1c994`.

### Watch-list — research only

See `docs/FUTURE-BACKENDS.md`:
- **Liminal limUSD** — potential earn-router HIGH-YIELD adapter pending audit +
  90 days of mainnet TVL track record. HyperEVM hub + Arbitrum/Ethereum spokes.
- **Sera Protocol** — potential FX/swap backend pending mainnet maturity on
  Base + a confirmed access model (whitelist vs open).
- **Hyperliquid perps** — belongs in a separate legal entity, never inside
  MAYZ. Read-only market data already shipped Sprint 9.

---

## Sprint 11 — Hardening + Performance (2026-06-14)

Commit range: `3ddb038..af285ad` (6 commits — 4 phase + 3 prep). See
`UPGRADE-REPORT.md` for the full Sprint 11 section.

- [x] **Phase 0** — Rate limit / webhook freshness / SSRF / Sentry PII scrubber. Commit `3ddb038`.
- [x] **Phase 1** — `app-main.ts` listener leak: 70 `addEventListener` → `on()` helper + `AbortController` teardown. Commit `3c00a01`.
- [x] **Phase 2** — DB perf (idempotency seller-scope migration `0012` + perf indexes migration `0013` + N+1 fixes in `findAgentsDueForDigest` + `checkoutView`). Landed via prep commits `700833b` + `c9fdba8` + `136f7eb`; verification no-op confirmed.
- [x] **Phase 3** — Spec coverage for 8 ghost routes (auth/payments/card/agent/x402/kyc/ledger/keys). Commits `c9fdba8` (auth) + `136f7eb` (payments) + `af285ad` (rest).
- [x] **Phase 4** — Docs + Sprint 12 stubs. This commit.

Final gate: **478 API vitest + 12 web + 6 shared-zod + 74 playwright** — all green.

### Sprint 12+ stubs (carried + new)

- `postgres.ts` split-by-domain refactor (~3,430 LOC; split into payments/agents/claims/markets/campaigns modules).
- Privy SDK migration (deprecated `@privy-io/server-auth@1.32.5`; wait for EOL).
- Schema drift reconcile (User wire missing balance + earn fields; Agent state enum 8 wire vs 5 DB).
- Dep drift cycle (zod 3→4, vite 6→8, resend 4→6, pino 9→10).
- Broader `ApiError` migration across 30 route files (carry from Sprint 10).
- Prometheus Alertmanager wiring (rules stubs in `infra/prometheus/alerts.yml`; need Slack/Pager fanout).
- Audit log table `nb_audit_log` for compliance.
- **DELETE /keys/:id idempotency fix** — currently 500 on unknown id; make idempotent 200. Latent bug surfaced by Phase 3 spec coverage.
- Auto-divest router migration (carry — still hits yoUSD specifically, ignores `preferredVaultTier`).
- v2 view-count API verification (carry from Sprint 10).
- Admin agent-key role gating (carry).
- DNS cutover for `maze.bank` (carry).
- **Liminal adapter** (only if audit passes — see `docs/FUTURE-BACKENDS.md`).

---

## Sprint 12 — Tier 1 close-out (2026-06-15)

Commit range: `8d020ed..<new HEAD>` (6 commits — 4 phase + 2 prep).

- ✅ Phase 0 — `DELETE /keys/:id` idempotent 200 (latent bug from Sprint 11 Phase 3) + auto-divest chain mirror through EarnRouter (respects user.preferredVaultTier). Commit `8d020ed`.
- ✅ Phase 1 — OpenAPI spec covers full /v1 surface (17 operations across 13 paths) + Swagger UI at `/v1/docs`. Commit `8e4b846`.
- ✅ Phase 2 — Alertmanager fanout config (2-receiver Slack: default warning + critical with shorter group_wait/repeat) + inhibit rule + deploy step in scripts/deploy-vps.sh. Commit `44c5a0d`.
- ✅ Phase 3 — postgres.ts split-by-domain: 3,650 → **195 LOC** facade. 12 domain modules + LedgerStateManager core. Mirror in-memory.ts split. Public Store interface unchanged. Commit `e2f216b`.

Prep commits absorbed concurrent work: `d72ec1d` (dom.ts hardening + sweeps refactor), `ffebc95` (tech-debt session F062 ApiError migration + F045 a11y).

Final gate: **487 API + 12 web + 6 shared-zod + 74 playwright** — all green.

### Sprint 13+ stubs (carried + new)

Tier 2 (vendor — Mirko's parallel track):
- Submit Socket access form (drafted).
- Bridge KYB (1–4 weeks; longest critical path).
- DNS cutover to `maze.bank` (one Cloudflare step).
- Stripe live keys when ready to take card payments.

Tier 3 (quality):
- Privy SDK migration off `@privy-io/server-auth@1.32.5` (deprecated; wait for EOL notice).
- Schema drift reconcile (User wire missing balance + earn fields; Agent state enum 8 vs 5).
- Dep drift (zod 3→4, vite 6→8, resend 4→6, pino 9→10).
- Broader `ApiError` migration across the remaining ~28 route files (Phase 0–2 sprint work touched ~4).
- Audit log table `nb_audit_log` for compliance.
- View-count APIs for campaigns (TikTok / YouTube / Instagram / X).
- Real APY fetching in earn adapters (currently hardcoded constants).
- Postgres connection pool tuning + read replica wire-up.

---

## Sprint 13 — Quality review + handover (2026-06-15)

Commit range: `45af675..24478aa` (6 fix commits + 1 audit append). Sprint 12 Tier 1 (`8d020ed..2a95f57`) is reviewed and signed off; Sprint 13 closes the verified P0/P1 findings + ships the authoritative handover doc.

- ✅ Phase 0 — `/code-review` (high effort) against Sprint 12 range. 15 findings: 6 P0, 7 P1, 2 P2.
- ✅ Phase 1 — `/security-review` against same range. 10 findings: 6 NEW security-specific (SR1–SR7) + overlap with code-review.
- ✅ Phase 2 — `/verify` skipped; Sprint 12 spec coverage already runs HTTP-level probes on every changed route.
- ✅ Phase 3 — 6 fix commits, one concern per commit:
  - `45af675` — Cross-domain modules (`payments`, `bridge`, `campaigns`, `claims`) route through `PgLedger` facade via constructor injection. Chain mirror now fires on every earn-state mutation. Closes C1 / C2 / Sweep #2 / #3 / #8 + bundles in-memory bridge race (C5) + amountUsd guard (Sweep #7) + release-bonus subId-binding (SR4).
  - `a97127e` — `payOffer` credits seller's main balance when `offer.subAccountId` points at deleted sub instead of dropping the remainder. Closes Sweep #1.
  - `003ff78` — `setKillSwitch` wrapped in `db.transaction` + `lockUserState`; `x402Pay` re-locks `nb_user_state` inside tx + re-reads `killSwitch`. Closes C4 + SR2.
  - `572b3c8` — `/checkout/session-status` requires `?buyerEmail=` + IP-keyed rate-limit binding. Constant-shape 404 hides existence oracle. Closes SR1.
  - `ace8d46` — Bundle: `chain_mirror_failures_total{op, tier}` Prom counter + `maze-chain-mirror` alert group; `/v1/docs` Swagger UI gated behind `requireSession`; Sentry scrubber redacts `userId`/`amountUsd`/`agentId` in extras + contexts. Closes C9 / SR3 / SR6.
- ✅ Phase 4 (this commit) — `HANDOVER-2026-06-15.md` (new authoritative point-in-time snapshot) + STATE-OF-BUILD/ROADMAP refresh. `TECH_DEBT_AUDIT.md` was already updated by `24478aa` (Sprint 13 appendix; do not edit).

Final gate: **502 API + 12 web + 6 shared-zod + 74 playwright** — all green. Tree clean. Nothing pushed.

### Sprint 14+ stubs (deferred from Sprint 13 review)

13 P2/cleanup items tracked in `TECH_DEBT_AUDIT.md` Sprint 13 appendix:

- C6 (in-memory split-path subtitle 'BALANCE' branch missing — cosmetic, in-memory only)
- C7 (in-memory `setKillSwitch` only mutates parameter, not `state.usersById`)
- C10 (`cancelSubscription` TOCTOU — admin coordination only, no live exploit)
- C11 (`round2`/`money`/`n` helper triplication — extract to `lib/format.ts`)
- C12 (ASCII `-` vs en-dash drift in `bridge.ts` activity titles)
- C13 (default `UserState` literal duplicated 4× — extract `defaultUserState()`)
- C14 (agent policy validation duplicated route zod vs store updateAgentPolicy)
- C15 (`upsertUserByEmail` Redis cache stale risk)
- Sweep #4 (`PgAgents.agent` name-lookup fails on cache miss)
- Sweep #5 (OpenAPI `Idempotency-Key` advertised but ignored on 4 routes)
- Sweep #6 (`InMemoryAgents.clearAll` missing)
- SR5 (Alertmanager `${VAR}` envsubst — `deploy-vps.sh` audit needed)
- SR7 (DELETE /keys/:id `revoked:true` vs `false` distinguishes owned-from-unknown — marginal info disclosure)

Plus carry items from Sprint 12+ stubs above (Privy migration, schema drift, dep drift, broader ApiError migration, audit log table, view-count APIs, real APY fetching, Postgres pool tuning, PagerDuty fanout).

---

## Later / watch
Bridge Cards (post-KYB human-card migration), Rain (credit + geo), Tempo chain (watch — Sponge-native), native mobile shell (Capacitor / PWA), Hyperliquid execution + Polymarket trading (compliance-gated).

---

## Hard red lines (carried from every doc — non-negotiable)
1. Real goods/services for real money only. **Never** operate inside a game's economy (Rockstar/FiveM ban crypto + outside payment integrations platform-wide).
2. Zero Rockstar/Take-Two IP. Maze/vault motif is generic and ours.
3. Buyer-facing pages stay free of crypto vocabulary — "pay $9.99", not "send USDC".
4. All consumer money flows through licensed rails (Bridge) — never route around the KYC perimeter into unlicensed money transmission.
5. Never use "deposits / FDIC / savings account" in copy — "balance, earn, rewards".

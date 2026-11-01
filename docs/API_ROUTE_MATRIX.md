# API Route Matrix

> **AUTO-GENERATED** by `node scripts/route-inventory.mjs` on 2026-07-16T11:58:45.432Z. Do not hand-edit — re-run the script.

**240 endpoints** across **32 mounts** (+8 app-level) · **24/240 documented in OpenAPI** (10%) · spec files for 27/29 route modules.

## Mounts

| Mount | Module | Routes | Spec file | Flag |
|---|---|---|---|---|
| (app) | index.ts | 8 | — | — |
| `/auth` | routes/auth.ts | 7 | ✓ | — |
| `/me` | routes/me.ts | 7 | ✓ | — |
| `/ledger` | routes/ledger.ts | 4 | ✓ | — |
| `/payments` | routes/payments.ts | 3 | ✓ | — |
| `/offers` | routes/offers.ts | 7 | ✓ | — |
| `/checkout` | routes/offers.ts | 4 | ✓ | — |
| `/v1` | routes/v1.ts | 17 | ✓ | — |
| `/keys` | routes/keys.ts | 3 | ✓ | — |
| `/earn` | routes/earn.ts | 12 | ✓ | — |
| `/swap` | routes/earn.ts | 2 | ✓ | — |
| `/card` | routes/card.ts | 5 | ✓ | — |
| `/agent` | routes/agent.ts | 11 | ✓ | — |
| `/x402` | routes/x402.ts | 8 | ✓ | — |
| `/bridge` | routes/bridge.ts | 8 | ✓ | — |
| `/kyc` | routes/kyc.ts | 3 | ✓ | — |
| `/claim` | routes/claim.ts | 2 | ✓ | — |
| `/markets` | routes/markets.ts | 70 | ✓ | — |
| `/v1` | realtime/router.ts | 3 | ✓ | REALTIME_HUB_V1 |
| `/markets/cards` | routes/markets-cards.ts | 6 | ✓ | — |
| `/tv` | routes/tv.ts | 2 | ✓ | — |
| `/campaigns` | routes/campaigns.ts | 6 | ✓ | — |
| `/perks` | routes/perks.ts | 1 | ✓ | — |
| `/admin` | routes/admin.ts | 10 | ✓ | — |
| `/monerium` | routes/monerium.ts | 3 | ✓ | — |
| `/onramp` | routes/onramp.ts | 7 | ✓ | — |
| `/balances` | routes/transfers.ts | 1 | ✓ | — |
| `/transfers` | routes/transfers.ts | 6 | ✓ | — |
| `/spend` | routes/spend.ts | 1 | — | — |
| `/push` | routes/push.ts | 7 | ✓ | — |
| `/system` | routes/system.ts | 4 | ✓ | — |
| `/config` | routes/config.ts | 1 | ✓ | — |
| `/.well-known` | routes/wellknown.ts | 1 | — | — |

## Routes

| Method | Path | Auth | OpenAPI | Source | Notes |
|---|---|---|---|---|---|
| GET | `/metrics` | bearer METRICS_TOKEN | — | apps/api/src/index.ts:171 | gated by METRICS_ENABLED |
| GET | `/healthz` | public | — | apps/api/src/index.ts:190 |  |
| GET | `/health/ready` | public | — | apps/api/src/index.ts:250 |  |
| GET | `/health/money` | public | — | apps/api/src/index.ts:271 |  |
| GET | `/v1/openapi.json` | public | — | apps/api/src/index.ts:513 |  |
| GET | `/v1/docs` | session | — | apps/api/src/index.ts:523 |  |
| GET | `/card/` | session | — | apps/api/src/index.ts:528 |  |
| ALL | `/mcp` | agent-key (nx_live_*) | — | apps/api/src/index.ts:572 |  |
| POST | `/auth/start` | public | ✓ | apps/api/src/routes/auth.ts:77 |  |
| POST | `/auth/verify` | public | ✓ | apps/api/src/routes/auth.ts:106 |  |
| POST | `/auth/privy-verify` | public | ✓ | apps/api/src/routes/auth.ts:152 |  |
| POST | `/auth/signout` | optional-session | — | apps/api/src/routes/auth.ts:272 |  |
| POST | `/auth/revoke` | session | — | apps/api/src/routes/auth.ts:290 |  |
| POST | `/auth/refresh` | session | — | apps/api/src/routes/auth.ts:314 |  |
| GET | `/auth/me` | session | ✓ | apps/api/src/routes/auth.ts:335 |  |
| GET | `/me/profile` | session-or-api-key | ✓ | apps/api/src/routes/me.ts:65 |  |
| GET | `/me/fees` | session-or-api-key | ✓ | apps/api/src/routes/me.ts:185 |  |
| PUT | `/me/devices/:installationId/push` | session-or-api-key | — | apps/api/src/routes/me.ts:249 |  |
| DELETE | `/me/devices/:installationId/push` | session-or-api-key | — | apps/api/src/routes/me.ts:271 |  |
| GET | `/me/devices` | session-or-api-key | — | apps/api/src/routes/me.ts:283 |  |
| PATCH | `/me/notification-preferences` | session-or-api-key | — | apps/api/src/routes/me.ts:292 |  |
| GET | `/me/admin/fees/summary` | session-or-api-key | — | apps/api/src/routes/me.ts:308 |  |
| GET | `/ledger/balance` | session | — | apps/api/src/routes/ledger.ts:39 |  |
| GET | `/ledger/activity` | session | — | apps/api/src/routes/ledger.ts:76 |  |
| GET | `/ledger/me` | session | — | apps/api/src/routes/ledger.ts:111 |  |
| GET | `/ledger/activity/stream` | stream-token | — | apps/api/src/routes/ledger.ts:156 |  |
| POST | `/payments/send` | session | — | apps/api/src/routes/payments.ts:45 |  |
| POST | `/payments/request-link` | session | — | apps/api/src/routes/payments.ts:120 |  |
| POST | `/payments/topup` | session | — | apps/api/src/routes/payments.ts:144 |  |
| POST | `/offers` | session | — | apps/api/src/routes/offers.ts:66 |  |
| GET | `/offers` | session | — | apps/api/src/routes/offers.ts:73 |  |
| GET | `/offers/payments` | session | — | apps/api/src/routes/offers.ts:79 |  |
| POST | `/offers/webhooks` | session | — | apps/api/src/routes/offers.ts:85 |  |
| GET | `/offers/webhooks` | session | — | apps/api/src/routes/offers.ts:102 |  |
| GET | `/offers/:id` | session | — | apps/api/src/routes/offers.ts:111 |  |
| PATCH | `/offers/:id` | session | — | apps/api/src/routes/offers.ts:125 |  |
| GET | `/checkout/session-status` | public | — | apps/api/src/routes/offers.ts:158 |  |
| GET | `/checkout/:id` | public | — | apps/api/src/routes/offers.ts:180 |  |
| POST | `/checkout/:id/pay` | optional-session | — | apps/api/src/routes/offers.ts:206 |  |
| POST | `/checkout/stripe-webhook` | public | — | apps/api/src/routes/offers.ts:383 | Stripe signature verified in handler |
| POST | `/v1/offers` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:78 |  |
| GET | `/v1/offers` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:91 |  |
| GET | `/v1/offers/:id` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:98 |  |
| PATCH | `/v1/offers/:id` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:112 |  |
| GET | `/v1/payments` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:135 |  |
| GET | `/v1/payments/:id` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:142 |  |
| POST | `/v1/sub-accounts` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:158 |  |
| GET | `/v1/sub-accounts` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:165 |  |
| GET | `/v1/sub-accounts/:id` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:171 |  |
| POST | `/v1/payouts` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:187 |  |
| GET | `/v1/payouts` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:225 |  |
| GET | `/v1/payouts/:id` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:232 |  |
| GET | `/v1/subscriptions` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:248 |  |
| GET | `/v1/subscriptions/:id` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:255 |  |
| POST | `/v1/subscriptions/:id/cancel` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:269 |  |
| POST | `/v1/subscriptions/:id/renew` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:290 |  |
| GET | `/v1/balance` | custom gate (routes/v1.ts:38) | ✓ | apps/api/src/routes/v1.ts:320 |  |
| POST | `/keys` | session | — | apps/api/src/routes/keys.ts:21 |  |
| GET | `/keys` | session | — | apps/api/src/routes/keys.ts:39 |  |
| DELETE | `/keys/:id` | session | — | apps/api/src/routes/keys.ts:45 |  |
| GET | `/earn/ethena` | public | — | apps/api/src/routes/earn.ts:57 |  |
| GET | `/earn/jupiter-lend` | public | — | apps/api/src/routes/earn.ts:78 |  |
| GET | `/earn/landing` | public | — | apps/api/src/routes/earn.ts:118 |  |
| GET | `/earn/apy` | session | — | apps/api/src/routes/earn.ts:206 |  |
| GET | `/earn/protocols` | session | — | apps/api/src/routes/earn.ts:243 |  |
| POST | `/earn/deposit` | session | — | apps/api/src/routes/earn.ts:267 |  |
| POST | `/earn/withdraw` | session | — | apps/api/src/routes/earn.ts:315 |  |
| POST | `/earn/configure` | session | — | apps/api/src/routes/earn.ts:363 |  |
| POST | `/earn/tier` | session | — | apps/api/src/routes/earn.ts:381 |  |
| GET | `/earn/morpho/vaults` | session | — | apps/api/src/routes/earn.ts:394 |  |
| POST | `/earn/marinade/stake` | session | — | apps/api/src/routes/earn.ts:449 |  |
| POST | `/earn/marinade/unstake` | session | — | apps/api/src/routes/earn.ts:484 |  |
| GET | `/swap/quote` | session | — | apps/api/src/routes/earn.ts:741 |  |
| POST | `/swap/execute` | session | — | apps/api/src/routes/earn.ts:883 |  |
| GET | `/card` | session | — | apps/api/src/routes/card.ts:58 |  |
| POST | `/card/order` | session | — | apps/api/src/routes/card.ts:60 |  |
| POST | `/card/topup` | session | — | apps/api/src/routes/card.ts:97 |  |
| POST | `/card/freeze` | session | — | apps/api/src/routes/card.ts:184 |  |
| POST | `/card/limit` | session | — | apps/api/src/routes/card.ts:194 |  |
| GET | `/agent` | session | — | apps/api/src/routes/agent.ts:32 |  |
| POST | `/agent/create` | session | — | apps/api/src/routes/agent.ts:39 |  |
| POST | `/agent/kill-switch` | session | — | apps/api/src/routes/agent.ts:70 |  |
| POST | `/agent/:id/fund` | session | — | apps/api/src/routes/agent.ts:90 |  |
| POST | `/agent/:id/defund` | session | — | apps/api/src/routes/agent.ts:122 |  |
| POST | `/agent/:id/pause` | session | — | apps/api/src/routes/agent.ts:144 |  |
| POST | `/agent/:id/policy` | session | — | apps/api/src/routes/agent.ts:160 |  |
| POST | `/agent/:id/approve-once` | session | — | apps/api/src/routes/agent.ts:183 |  |
| GET | `/agent/:id/activity` | session | — | apps/api/src/routes/agent.ts:214 |  |
| POST | `/agent/:id/card` | session | — | apps/api/src/routes/agent.ts:228 |  |
| POST | `/agent/:id/bank` | session | — | apps/api/src/routes/agent.ts:245 |  |
| POST | `/x402/pay` | agent-key (nx_live_*) | — | apps/api/src/routes/x402.ts:201 |  |
| POST | `/x402/settle` | agent-key (nx_live_*) | — | apps/api/src/routes/x402.ts:298 |  |
| GET | `/x402/quote` | session | — | apps/api/src/routes/x402.ts:355 |  |
| GET | `/x402/contracts` | session | — | apps/api/src/routes/x402.ts:376 |  |
| POST | `/x402/contracts` | session | — | apps/api/src/routes/x402.ts:381 |  |
| GET | `/x402/contracts/:id` | session | — | apps/api/src/routes/x402.ts:402 |  |
| POST | `/x402/contracts/:id/status` | session | — | apps/api/src/routes/x402.ts:411 |  |
| GET | `/x402/events` | session | — | apps/api/src/routes/x402.ts:426 |  |
| POST | `/bridge/customer` | session | — | apps/api/src/routes/bridge.ts:106 |  |
| POST | `/bridge/virtual-account` | session | — | apps/api/src/routes/bridge.ts:122 |  |
| GET | `/bridge/accounts` | session | — | apps/api/src/routes/bridge.ts:149 |  |
| POST | `/bridge/payout-method` | session | — | apps/api/src/routes/bridge.ts:162 |  |
| GET | `/bridge/payout-methods` | session | — | apps/api/src/routes/bridge.ts:198 |  |
| POST | `/bridge/withdraw` | session | — | apps/api/src/routes/bridge.ts:209 |  |
| POST | `/bridge/webhook` | public | — | apps/api/src/routes/bridge.ts:349 | Bridge HMAC verified in handler |
| POST | `/bridge/transfer-webhook` | public | — | apps/api/src/routes/bridge.ts:381 | Bridge HMAC verified in handler |
| POST | `/kyc/start` | session | — | apps/api/src/routes/kyc.ts:20 |  |
| GET | `/kyc/status` | session | — | apps/api/src/routes/kyc.ts:27 |  |
| POST | `/kyc/webhook` | public | — | apps/api/src/routes/kyc.ts:35 | Sumsub HMAC verified in handler |
| GET | `/claim/:slug` | public | — | apps/api/src/routes/claim.ts:20 |  |
| POST | `/claim/:slug` | public | — | apps/api/src/routes/claim.ts:37 |  |
| GET | `/markets/hyperliquid` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:1588 |  |
| GET | `/markets/hyperliquid/builder-approval` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:1615 |  |
| GET | `/markets/hyperliquid/builder-status` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:1630 |  |
| POST | `/markets/hyperliquid/approve-builder` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:1673 |  |
| POST | `/markets/hyperliquid/order` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:1779 |  |
| POST | `/markets/hyperliquid/cancel` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:1963 |  |
| POST | `/markets/hyperliquid/cancel-many` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2030 |  |
| POST | `/markets/hyperliquid/modify` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2093 |  |
| POST | `/markets/hyperliquid/update-leverage` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2157 |  |
| POST | `/markets/hyperliquid/update-isolated-margin` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2189 |  |
| POST | `/markets/hyperliquid/usd-class-transfer` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2224 |  |
| POST | `/markets/hyperliquid/usd-send` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2303 |  |
| POST | `/markets/hyperliquid/transfer-to-dex` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2378 |  |
| POST | `/markets/hyperliquid/withdraw` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2476 |  |
| GET | `/markets/hyperliquid/open-orders` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2553 |  |
| GET | `/markets/hyperliquid/user-fills` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2562 |  |
| GET | `/markets/hyperliquid/user-state` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2572 |  |
| GET | `/markets/hyperliquid/positions` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2580 |  |
| GET | `/markets/hyperliquid/candles` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2681 |  |
| GET | `/markets/hyperliquid/all-mids` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2697 |  |
| GET | `/markets/hyperliquid/orderbook` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2706 |  |
| GET | `/markets/hyperliquid/recent-trades` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2721 |  |
| GET | `/markets/hyperliquid/funding-history` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2740 |  |
| GET | `/markets/hyperliquid/:coin` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2755 |  |
| GET | `/markets/global` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2785 |  |
| GET | `/markets/polymarket` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2800 |  |
| GET | `/markets/polymarket/leaderboard` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2848 |  |
| POST | `/markets/polymarket/order` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:2901 |  |
| POST | `/markets/polymarket/sell` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3182 |  |
| GET | `/markets/polymarket/trading-status` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3509 |  |
| POST | `/markets/polymarket/enable-trading` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3521 |  |
| GET | `/markets/polymarket/builder-status` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3540 |  |
| POST | `/markets/polymarket/builder-setup` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3561 |  |
| POST | `/markets/polymarket/builder-fund` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3588 |  |
| POST | `/markets/polymarket/wrap` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3616 |  |
| POST | `/markets/polymarket/unwrap` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3628 |  |
| GET | `/markets/polymarket/positions` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3640 |  |
| GET | `/markets/polymarket/traders/:wallet/copy-intent` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3652 |  |
| GET | `/markets/polymarket/:id` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3669 |  |
| GET | `/markets/polymarket/:id/book` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3696 |  |
| GET | `/markets/polymarket/:id/top-traders` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3720 |  |
| GET | `/markets/hyperliquid-spot` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3755 |  |
| GET | `/markets/hyperliquid-spot/detail` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3779 |  |
| GET | `/markets/hyperliquid-spot/user-state` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3802 |  |
| GET | `/markets/hyperliquid-spot/positions` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3810 |  |
| POST | `/markets/hyperliquid-spot/order` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3818 |  |
| POST | `/markets/hyperliquid-spot/cancel` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3939 |  |
| GET | `/markets/hyperliquid-spot/all-mids` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:3984 |  |
| GET | `/markets/jupiter` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4007 |  |
| GET | `/markets/jupiter/detail` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4180 |  |
| GET | `/markets/jupiter/prices` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4202 |  |
| GET | `/markets/jupiter/candles` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4239 |  |
| POST | `/markets/jupiter/quote` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4259 |  |
| POST | `/markets/jupiter/swap` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4289 |  |
| GET | `/markets/jupiter/positions` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4483 |  |
| GET | `/markets/stocks` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4504 |  |
| GET | `/markets/stocks/perps` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4529 |  |
| GET | `/markets/stocks/spot` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4549 |  |
| GET | `/markets/stocks/detail` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4581 |  |
| GET | `/markets/stocks/candles` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4619 |  |
| GET | `/markets/stocks/all-mids` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4638 |  |
| POST | `/markets/stocks/order` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4654 |  |
| POST | `/markets/stocks/cancel` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4777 |  |
| GET | `/markets/stocks/positions` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4817 |  |
| GET | `/markets/orders` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4886 |  |
| GET | `/markets/orders/:id` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4902 |  |
| GET | `/markets/positions` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4919 |  |
| GET | `/markets/portfolio/summary` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:4937 |  |
| GET | `/markets/fills` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:5002 |  |
| POST | `/markets/orders/:id/cancel` | hybrid: public GET allowlist, else session | — | apps/api/src/routes/markets.ts:5054 |  |
| GET | `/v1/feeds/health` | public | — | apps/api/src/realtime/router.ts:76 | gated by REALTIME_HUB_V1 |
| POST | `/v1/stream/ticket` | session | — | apps/api/src/realtime/router.ts:93 | gated by REALTIME_HUB_V1 |
| GET | `/v1/stream/sse` | session-or-stream-ticket | — | apps/api/src/realtime/router.ts:101 | gated by REALTIME_HUB_V1 |
| GET | `/markets/cards` | public | — | apps/api/src/routes/markets-cards.ts:74 |  |
| GET | `/markets/cards/collections` | public | — | apps/api/src/routes/markets-cards.ts:95 |  |
| GET | `/markets/cards/positions` | session | — | apps/api/src/routes/markets-cards.ts:106 |  |
| GET | `/markets/cards/:id` | public | — | apps/api/src/routes/markets-cards.ts:126 |  |
| POST | `/markets/cards/buy` | session | — | apps/api/src/routes/markets-cards.ts:151 |  |
| GET | `/markets/cards/trades/me` | session | — | apps/api/src/routes/markets-cards.ts:296 |  |
| GET | `/tv/snapshot` | public | — | apps/api/src/routes/tv.ts:84 |  |
| GET | `/tv/quote/:symbol` | public | — | apps/api/src/routes/tv.ts:108 |  |
| POST | `/campaigns` | session | — | apps/api/src/routes/campaigns.ts:56 |  |
| GET | `/campaigns` | session | — | apps/api/src/routes/campaigns.ts:89 |  |
| GET | `/campaigns/:id` | session | — | apps/api/src/routes/campaigns.ts:97 |  |
| POST | `/campaigns/:id/submit` | session | — | apps/api/src/routes/campaigns.ts:109 |  |
| POST | `/campaigns/:id/submissions/:subId/approve` | admin-key (agent) | — | apps/api/src/routes/campaigns.ts:154 |  |
| POST | `/campaigns/:id/submissions/:subId/release-bonus` | admin-key (agent) | — | apps/api/src/routes/campaigns.ts:177 |  |
| GET | `/perks` | session | — | apps/api/src/routes/perks.ts:23 |  |
| POST | `/admin/sweep-claims` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:66 |  |
| POST | `/admin/sweep-deposits` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:87 |  |
| POST | `/admin/sweep-subscriptions` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:101 |  |
| POST | `/admin/dispatch-digests` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:125 |  |
| POST | `/admin/sweep-fills` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:147 |  |
| POST | `/admin/sentry-test` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:155 |  |
| GET | `/admin/audit-log` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:192 |  |
| POST | `/admin/cohort` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:237 |  |
| POST | `/admin/withdraw-all` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:330 |  |
| GET | `/admin/test-users` | admin-token (Bearer ADMIN_TOKEN) | — | apps/api/src/routes/admin.ts:570 |  |
| GET | `/monerium/status` | session | — | apps/api/src/routes/monerium.ts:30 |  |
| GET | `/monerium/profile` | session | — | apps/api/src/routes/monerium.ts:34 |  |
| POST | `/monerium/offramp` | session | — | apps/api/src/routes/monerium.ts:85 |  |
| POST | `/onramp/stripe/session` | session | — | apps/api/src/routes/onramp.ts:47 |  |
| POST | `/onramp/stripe/webhook` | public | — | apps/api/src/routes/onramp.ts:104 | Stripe signature verified in handler |
| GET | `/onramp/demo-success` | session | — | apps/api/src/routes/onramp.ts:168 |  |
| GET | `/onramp/stripe/status` | public | — | apps/api/src/routes/onramp.ts:188 |  |
| POST | `/onramp/onramper/session` | session | — | apps/api/src/routes/onramp.ts:228 |  |
| GET | `/onramp/deposit-address` | session | — | apps/api/src/routes/onramp.ts:310 |  |
| GET | `/onramp/onramper/status` | public | — | apps/api/src/routes/onramp.ts:348 |  |
| GET | `/balances` | session | — | apps/api/src/routes/transfers.ts:137 |  |
| GET | `/transfers/onramp/deposit-address` | session | — | apps/api/src/routes/transfers.ts:160 |  |
| POST | `/transfers/internal` | session | — | apps/api/src/routes/transfers.ts:187 |  |
| POST | `/transfers/external` | session | — | apps/api/src/routes/transfers.ts:541 |  |
| POST | `/transfers/hl-deposit` | session | — | apps/api/src/routes/transfers.ts:757 |  |
| GET | `/transfers` | session | — | apps/api/src/routes/transfers.ts:997 |  |
| GET | `/transfers/:id` | session | — | apps/api/src/routes/transfers.ts:1010 |  |
| GET | `/spend/monthly` | session | — | apps/api/src/routes/spend.ts:28 |  |
| GET | `/push/vapid-public-key` | session | — | apps/api/src/routes/push.ts:35 |  |
| POST | `/push/subscribe` | session | — | apps/api/src/routes/push.ts:40 |  |
| DELETE | `/push/subscribe` | session | — | apps/api/src/routes/push.ts:51 |  |
| GET | `/push/subscriptions` | session | — | apps/api/src/routes/push.ts:58 |  |
| POST | `/push/expo-subscribe` | session | — | apps/api/src/routes/push.ts:80 |  |
| DELETE | `/push/expo-subscribe` | session | — | apps/api/src/routes/push.ts:90 |  |
| GET | `/push/expo-subscriptions` | session | — | apps/api/src/routes/push.ts:97 |  |
| GET | `/system/providers` | public | — | apps/api/src/routes/system.ts:33 |  |
| GET | `/system/data-sources` | optional-session | — | apps/api/src/routes/system.ts:42 |  |
| GET | `/system/health` | optional-session | — | apps/api/src/routes/system.ts:51 |  |
| GET | `/system/tokenized-stocks` | public | — | apps/api/src/routes/system.ts:76 |  |
| GET | `/config/safe-mode` | public | ✓ | apps/api/src/routes/config.ts:6 |  |
| GET | `/.well-known/x402-catalog` | public | — | apps/api/src/routes/wellknown.ts:128 |  |

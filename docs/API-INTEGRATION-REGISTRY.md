# API-INTEGRATION-REGISTRY.md

**Last updated:** 2026-07-02 (integration verification pass)

This is the canonical vendor matrix for MAZE/NEXA. It mirrors the data shape returned by `GET /system/providers`. When you add or remove a vendor, update both this doc and `apps/api/src/lib/provider-registry.ts`. For the auto-generated table (live registry + SDK currency + drift annotations) see [`PROVIDER_MATRIX.md`](PROVIDER_MATRIX.md); umbrella inventory: [`TECH_STACK_ROUTE_PROVIDER_INVENTORY.md`](TECH_STACK_ROUTE_PROVIDER_INVENTORY.md); route tree: [`API_ROUTE_MATRIX.md`](API_ROUTE_MATRIX.md) (regenerate all three with `pnpm route:inventory`).

**2026-07-02 verification pass (full audit — code sweeps + live probes + upstream changelogs):**
- **Production status** (probed): 23 providers live, 6 missing-keys (Bridge, Monerium, Sumsub, Socket, Gnosis Pay, Sponge — the fiat/card/KYC edge awaits vendor keys), 3 docs-only, 1 gated. Core trading + earn + swap + x402 rails confirmed live with `sourced.source:"live"`.
- **Registry-truth drift found** (fix list tracked in `TECH_STACK_ROUTE_PROVIDER_INVENTORY.md §5`): `circle-cctp` says docs-only but the live CCTP V1 pipeline serves `/transfers/internal` via the bridge-worker; `coinbase-x402` status is vacuous (env default always set — `lib/env.ts:152`); `mayan` status hard-coded live; `xstocks` docs-only label conflicts with live secondary-market trading; `pumpfun` says live while production serves `provider-demo` data (API reachable externally — server-side cause, open). Unregistered surfaces: TradingView, Onramper, Jupiter Lend, DefiLlama/yields-landscape, Pyth Hermes.
- **SDK currency**: `@polymarket/clob-client-v2` 1.0.6 → **1.0.8** upstream (2026-07-01: ExchangeV3 order signing + new tick sizes; README now recommends Polymarket's unified ts-sdk) — upgrade soon. `@nktkas/hyperliquid` 0.32.2 → 0.33.1 (breaking changes limited to `noop`/`createVault`/multi-sig — unused here). `stripe` 22.2.1 → 22.3.0. `resend` 4.8 → 6.x. `@privy-io/server-auth` 1.32.5 current but deprecated upstream (`@privy-io/node` now 0.24.0). Everything else ≈ current; provenance of `@polymarket/clob-client-v2` verified official (npm maintainers @polymarket.com).
- **Post-Sprint-21 surface deltas**: Polymarket top-traders + cross-market leaderboard endpoints (copy-trading), idempotency now required on live money moves (orders, transfers, usd-class-transfer).

**Sprint 21 updates (2026-06-21):**
- **Hyperliquid Spot** — read-only adapter shipped + UI tab + order sheet; 307 SPL pairs; asset id `10000 + universe.index`; reuses canonical perp signing path
- **Hyperliquid HIP-3 / trade.xyz** — LIVE for the `xyz` builder DEX: 93 markets (TSLA, AAPL, NVDA, MSFT, META, AMZN, GOOGL, COIN, HOOD, MSTR, PLTR, SP500 perp @ 50× — S&P Dow Jones licensed Mar 2026 — Nasdaq, commodities, FX). Same backend-managed builder fee mechanism as canonical perps. Asset id `100_000 + 10_000 * perpDexIndex + universe.index`.
- **Backed Finance xStocks** — LIVE via Jupiter routing: 131 SPL Token-2022 mints (AAPLx, TSLAx, NVDAx, SPYx, QQQx, …). No new signing code — same Privy Solana wallet path as memes.
- **Jupiter platform fee** — env-driven now (was hardcoded 0). `JUPITER_PLATFORM_FEE_BPS` (cap 100) + `JUPITER_PLATFORM_FEE_ACCOUNT` (NEXA-owned Solana ATA).
- **Pump.fun** — already live read-only via `frontend-api-v3.pump.fun/coins`; merged into Memes tab.

**Sprint 17 Phase F updates (2026-06-20):**
- **Polymarket CLOB** - L2 credential derivation remains in `lib/markets/pm-clob.ts`; live limit-order submit uses `@polymarket/clob-client-v2` with a Privy-backed typed-data signer and sends the market event id.
- **Marinade Finance** - public APY read remains live; stake and instant liquid unstake submit via direct Marinade program instructions when Solana RPC plus Privy Solana signing are configured.
- **Mayan Swift** - public quotes remain live; `/swap/quote` and `/swap/execute` route Solana legs through Mayan.
- **x402 facilitator** - default URL corrected (was 404)
- **Privy server-auth** - flagged as deprecated; migration to `@privy-io/node@0.22.0` deferred

Protocol-audit direct dependencies in [apps/api/package.json](../apps/api/package.json):
- `@polymarket/clob-client-v2@1.0.6`
- `@mayanfinance/swap-sdk@15.0.0`
- `@solana/web3.js@^1.x`

No direct dependency remains on legacy `@polymarket/clob-client`, `@marinade.finance/marinade-ts-sdk`, `@solana/spl-token`, `ethers`, or `bn.js`.

The runtime registry is authoritative — this doc is a human-readable mirror.

Status legend:
- **live**: API key configured + vendor reachable, used in production paths
- **sandbox**: keys point at the vendor's test/staging environment
- **gated**: feature flag on, but a runtime check (geo, wallet readiness, idempotency, kill switch, venue-specific backend agreement) still gates execution
- **docs-only**: vendor identified in code/spec but no live wiring yet
- **missing-keys**: feature flag off because the env vars aren't set
- **disabled**: explicitly turned off via env

---

## Auth / wallet

### Privy
- Status: gated on `PRIVY_APP_ID` + `PRIVY_APP_SECRET`
- Docs: https://docs.privy.io/wallets/wallets/create/create-a-wallet
- Backend: `apps/api/src/lib/privy.ts`, `lib/chain/privy-agent-wallet.ts`, `lib/chain/privy-claim.ts`
- Frontend: s01, s02, s03, s08
- Demo fallback: OTP `482019` accepted in DEMO_MODE

### Alchemy
- Status: `ALCHEMY_API_KEY` + `ALCHEMY_GAS_POLICY_ID`
- Docs: https://www.alchemy.com/docs/wallets, https://www.alchemy.com/docs/wallets/transactions/sponsor-gas
- Backend: `apps/api/src/lib/chain/alchemy.ts` (EIP-7702 sponsored batch executor)

### Chain USDC balances
- Status: live when configured RPC URLs exist; falls back to public RPC for best-effort reads
- Backend: `apps/api/src/lib/chain/balances.ts`, `apps/api/src/routes/transfers.ts`
- Chains: Arbitrum, Polygon, Base, Optimism, Solana
- Use: `/balances` portfolio bucket reads for Trade/Memes/Cash surfaces

---

## KYC

### Sumsub
- Status: `SUMSUB_APP_TOKEN` + `SUMSUB_SECRET_KEY`
- Docs: https://docs.sumsub.com/reference/get-started-with-api, https://docs.sumsub.com/reference/generate-access-token
- Backend: `apps/api/src/lib/kyc.ts`, `apps/api/src/routes/kyc.ts`
- Demo fallback: synthetic SDK token in DEMO_MODE
- KYC freshness window: 5 minutes (webhook replay-attack guard)

---

## Onramp / offramp / fiat

### Bridge
- Status: `BRIDGE_API_KEY` + sandbox base URL by default
- Docs: https://apidocs.bridge.xyz/platform/orchestration/overview, https://apidocs.bridge.xyz/platform/orchestration/liquidation_address/liquidation_address
- Developer agreement: https://www.bridge.xyz/legal/developer-agreement
- Backend: `apps/api/src/lib/chain/bridge.ts`, `apps/api/src/routes/bridge.ts`
- Frontend: s09 (add money), s10 (send), virtual accounts
- Demo fallback: synthetic `bridge_demo_*` customer IDs
- Live readiness: **KYB approval is the longest critical path before US bank rails work**

### Stripe
- Status: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- Docs: https://docs.stripe.com/crypto/onramp
- Backend: `apps/api/src/lib/psp/stripe.ts`, used by `apps/api/src/routes/offers.ts` (hosted checkout)
- API version pin: `2026-05-27.dahlia` (matches `stripe@22.2.1`)
- Demo fallback: synthetic `cs_demo_*` session + `/checkout-demo-success` redirect

### Circle CCTP (Sprint 19 — LIVE)
- Status: V1 wired for Arbitrum / Polygon / Base / Optimism USDC. Gated on `ALCHEMY_API_KEY` + `PRIVY_APP_ID/SECRET` (uses the Alchemy 7702 batch executor and Privy server-wallet signing).
- **V2 (ADR-0005, 2026-07-08)**: implemented behind `CCTP_V2=1` (default off). TokenMessengerV2/MessageTransmitterV2 (same CREATE2 address on all EVM chains), iris `/v2/messages` attestation keyed by burn tx hash, Fast Transfer (threshold 1000, fee 0–14 bps quoted via `/v2/burn/USDC/fees`, 20% buffer) with automatic fallback to Standard (2000, free). Per-transfer version pinned in `nb_transfers.cctp_version` (migration 0032). **Deadline: Circle begins V1 phase-out 2026-07-31** — flip the flag after one supervised live transfer.
- Docs: https://developers.circle.com/cctp, https://www.circle.com/cross-chain-transfer-protocol, https://www.circle.com/blog/cctp-version-updates
- Backend: `apps/api/src/lib/chain/cctp.ts` (V1 + V2 calldata builders, Iris pollers, execute helpers), `apps/api/src/workers/bridge-worker.ts` (version-aware state machine), `apps/api/src/routes/transfers.ts` (POST /transfers/internal, GET /transfers/:id)
- Schema: `nb_transfers`, `nb_transfer_events` (migrations 0022_transfers, 0032_add_transfers_cctp_version)
- Architecture: see `docs/BRIDGING-ARCHITECTURE.md`, `docs/CCTP-WIRING.md`, `docs/TRANSFER-STATE-MACHINE.md`, `docs/adr/0005-cctp-v2-migration.md`

### Onramper widget (Sprint 19 — LIVE)
- Status: `ONRAMPER_API_KEY` (optional). Without the key, route returns the public sandbox widget URL.
- Docs: https://docs.onramper.com/docs/widget
- Backend: `apps/api/src/routes/onramp.ts` (POST `/onramp/onramper/session`, GET `/onramp/onramper/status`)
- Use: smart-routing aggregator across 30+ onramp providers; routes small-tx users to lowest-KYC vendor automatically
- Architecture: see `docs/ONRAMP-OPTIONS.md`

---

## Swap / bridge router

### Socket
- Status: `SOCKET_API_KEY` (primary), `SOCKET_API_BASE`, `SOCKET_AFFILIATE_ID` (optional, earns integrator fees)
- Docs: https://docs.socket.tech/integrate/get-api-access, https://docs.socket.tech/integrate/integration-guides/socket-api.md
- Backend: `apps/api/src/lib/chain/socket.ts`, `apps/api/src/lib/bridge-router.ts`
- Frontend: s16 (swap), s17 (card top-up via bridge)
- Note: key received; go-live runbook in `docs/SWAP-WIRING.md`. Adapter sends the key under both `API-KEY` + `x-api-key` (header name pending live confirm), sends `AFFILIATE-ID` when set, and prepends the ERC-20 approval call so first-time bridgers don't revert.

### LI.FI
- Status: `LIFI_API_KEY` (optional)
- Docs: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer, https://docs.li.fi/sdk/overview
- Backend: `apps/api/src/lib/chain/lifi.ts`
- Use: fallback when Socket has no route; works without key at low volume

### Mayan Finance
- Status: live public quote API; `/swap/execute` routes Solana legs through Mayan
- Docs: https://docs.mayan.finance/
- Backend: `apps/api/src/lib/chain/mayan.ts`
- Use: Solana/EVM route discovery and execution for supported SOL/mSOL/USDC legs

---

## DeFi yield

### Morpho (Standard tier)
- Status: live when `BASE_RPC_URL` is set
- Docs: https://docs.morpho.org/build/earn/resources/all, https://docs.morpho.org/build/earn/tutorials/get-data, https://docs.morpho.org/tools/offchain/api/morpho-vaults/
- Backend: `apps/api/src/lib/chain/morpho.ts`
- Vault: Steakhouse-curated USDC on Base (`0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183`) — the same vault that backs Coinbase's USDC lending product
- APY source: Morpho GraphQL `vaultV2ByAddress.avgNetApy`

### Aave v3
- Status: live when `BASE_RPC_URL` is set
- Docs: https://aave.com/docs/aave-v3/overview, https://aave.com/docs/aave-v3/markets/data, https://aave.com/docs/aave-v3/smart-contracts/interest-rate-strategy
- Backend: `apps/api/src/lib/chain/defi.ts`
- APY source: `Pool.getReserveData()` → liquidityRate (RAY) → bps via `rayToBps`

### Compound III
- Status: live when `BASE_RPC_URL` is set
- Docs: https://docs.compound.finance/, https://docs.compound.finance/interest-rates/
- Backend: `apps/api/src/lib/chain/compound.ts`
- APY source: `Comet.getSupplyRate(getUtilization())` → per-second compounded to APR/APY

### yoUSD
- Status: public read via YO Protocol API
- Backend: `apps/api/src/lib/chain/yousd.ts`
- APY source: `GET https://api.yo.xyz/api/v1/vault/yield/timeseries/base/{vault}`

### Ethena sUSDe
- Status: public read-only APY tile; deposit CTA deep-links to Ethena
- Docs: https://docs.ethena.fi/
- Backend: `apps/api/src/lib/chain/ethena.ts`, `apps/api/src/routes/earn.ts`
- APY source: `GET https://app.ethena.fi/api/yields/protocol-and-staking-yield` unless `ETHENA_API_URL` overrides it
- Custody: NEXA does not mint, hold, or stake sUSDe in this phase

### Jupiter Lend (Solana USDC + USDT)
- Status: read-only headline tile + included in `/earn/landing`; deposit deep-links to jup.ag/lend
- Docs: https://jup.ag/lend/earn, https://dev.jup.ag/docs/lend/sdk, https://github.com/jup-ag/jupiter-lend
- Backend: `apps/api/src/lib/chain/jupiter-lend.ts`, `apps/api/src/routes/earn.ts` (`/earn/jupiter-lend`)
- APY source: `GET https://lend-api.jup.ag/earn/tokens` (no auth) — env `JUPITER_LEND_API_URL` overrides
- Risk: ~10 months old as of 2026-06-21; built on Fluid (Instadapp); high LTV / aggressive liquidation; rehypothecation flagged by Kamino Dec 2025. Show risk copy + cap stable allocation until model is documented
- Custody: NEXA does not custody Jupiter Lend positions in this phase; users deposit directly via jup.ag

### DefiLlama Yields API (cross-protocol comparator)
- Status: public read; only used by `/earn/landing` to fill assets/venues that don't have a first-party adapter (BTC, ETH, Fluid Ethereum, Kamino Solana, Aave on chains other than Base)
- Docs: https://defillama.com/docs/api, https://yields.llama.fi/pools
- Backend: `apps/api/src/lib/chain/yields-landscape.ts`
- APY source: `GET https://yields.llama.fi/pools` (no auth; refreshes ~hourly) — env `DEFILLAMA_YIELDS_URL` overrides
- Whitelist: aave-v3/v2, morpho, compound-v3, spark, fluid, jupiter-lend, kamino-lend, marginfi, save-finance, solend, yo-protocol, sky-savings-rate, ethena. Any other project is silently dropped from the landscape until risk-vetted
- Cache: route-layer 60s TTL — DefiLlama refreshes hourly so we don't need to be tighter

### Sky Protocol (sUSDS) — DEFERRED
- Status: researched 2026-06-21, not integrated. Yield 3.6–3.75% sits below Morpho USDC 5–11% on Base; ship only when SSR catches up OR a non-yield use case lands (RWA-backed Conservative tier, USDS payment rails, marketing angle around MakerDAO lineage)
- Docs: https://developers.sky.money/, https://docs.spark.fi/dev/savings/susds-token, https://sky.money/susds
- Base contracts (chain id 8453):
  - USDS (ERC-20, 18 decimals): `0x820C137fa70C8691f0e44Dc420a5e53c168921Dc`
  - sUSDS (ERC-4626 vault, 18 decimals): `0x5875eEE11Cf8398102FdAd704C9E96607675467a`
  - Spark PSM3 (fee-free USDC↔USDS↔sUSDS swap): `0x1601843c5E9bC251A3272907010AFa41Fa18347E`
- Integration shape when ready: ERC-4626 adapter identical to `morpho.ts` (deposit/redeem/convertToAssets). PSM3 entry point is `swapExactIn(assetIn, assetOut, amountIn, minAmountOut, receiver, referralCode)` — no protocol fee in either direction. No first-party REST; SSR + price-per-share read on-chain via Chainstack/Alchemy
- Why not now: adding it as Earn default would route users into a worse yield than Morpho. Carrying the addresses + research here so when the rate flips or marketing pulls the trigger, the integration spike is half a day, not two

### Marinade Finance
- Status: APY read is public; stake and instant liquid unstake submit when Solana RPC plus Privy Solana signing are configured
- Docs: https://docs.marinade.finance/
- Backend: `apps/api/src/lib/chain/marinade.ts`, `apps/api/src/lib/chain/solana-tx.ts`, `apps/api/src/routes/earn.ts`
- Write support: `/earn/marinade/stake` and `/earn/marinade/unstake`; delayed ticket unstake remains unavailable

---

## Cards

### Gnosis Pay
- Status: `GNOSIS_PAY_API_KEY`
- Docs: https://docs.gnosispay.com/, https://gnosispay.com/
- Backend: `apps/api/src/lib/chain/gnosisPay.ts`
- Frontend: s17 (card), s18 (settings)
- Demo fallback: synthetic Safe deploy + card details

### Sponge (US debit + agent accounts)
- Status: `SPONGE_API_KEY`
- Backend: `apps/api/src/lib/chain/sponge.ts`
- Public docs: not yet linked — see `docs/MISSING-PROVIDER-DOCS.md#sponge`

---

## Agent settlement / x402

### Coinbase x402
- Status: `X402_FACILITATOR_URL` (defaults to https://x402.coinbase.com)
- Docs: https://docs.cdp.coinbase.com/x402/welcome, https://docs.cdp.coinbase.com/x402/core-concepts/http-402
- Standard: https://docs.x402.org/introduction
- Backend: `apps/api/src/lib/chain/x402.ts`, `apps/api/src/routes/x402.ts`
- EIP-3009 `transferWithAuthorization` signed via Privy server wallet → POSTed to facilitator
- Demo fallback: synthetic `0x…` tx hash

---

## Markets

### Hyperliquid perps (canonical)
- Status: `MARKETS_ENABLED=1` + optional `HL_BUILDER_ADDRESS` for builder-fee earning
- Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes, https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- Backend: `apps/api/src/lib/markets/hyperliquid.ts`, `apps/api/src/routes/markets.ts`
- Frontend (neo Expo): `app/(tabs)/markets.tsx`, `app/markets/[coin].tsx`
- 230 markets at last probe; trading gated by kill switch, persisted Privy wallet ID, idempotency key, and backend-managed builder agreement when a fee is configured

### Hyperliquid spot
- Status: `MARKETS_ENABLED=1`
- Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/spot
- Backend: `apps/api/src/lib/markets/hyperliquid-spot.ts`, `apps/api/src/routes/markets.ts`
- Frontend (neo): `app/(tabs)/spot.tsx`, `app/markets/spot/[coin].tsx`
- 307 SPL pairs; asset id encoding `10000 + universe.index`; NO native builder fee (HL spot has no rebate channel); shares HL `allMids` WebSocket with perps; demo fallback array

### Hyperliquid HIP-3 — trade.xyz (`xyz` DEX) — TOKENIZED EQUITIES + COMMODITIES + FX
- Status: LIVE — `MARKETS_ENABLED=1` + shares HL builder env (`HL_BUILDER_ADDRESS` + `HYPERLIQUID_BUILDER_FEE_TENTHS_BP`); same builder address earns on canonical perps AND HIP-3 stocks
- Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3, https://docs.trade.xyz/, https://docs.trade.xyz/asset-directory/stocks/us
- Backend: `apps/api/src/lib/markets/hyperliquid-hip3.ts`, `apps/api/src/routes/markets.ts` (route prefix `/markets/stocks/perps` + `/markets/stocks/order|cancel|positions`)
- Frontend (neo): `app/(tabs)/stocks.tsx` (Perps rail), `app/markets/stocks/perp/[coin].tsx`, `components/StocksPerpOrderSheet.tsx`
- 93 markets at last probe — TSLA, AAPL, NVDA, MSFT, META, AMZN, GOOGL, COIN, HOOD, MSTR, PLTR, SPCX, BX, COST, INTC, AMD, AVGO, ASML, QCOM, MRVL, ARM, SMSN, HYUNDAI, SOFTBANK, ZHIPU, MINIMAX, SP500 (S&P Dow Jones licensed Mar 2026, 50× lev), Nasdaq XYZ100 (30× lev), NIFTY/JP225/KR200/IBOV/EWJ/EWT/EWY/EWZ/XLE/SMH/URNM (indices/ETFs), GOLD/SILVER/PLATINUM/PALLADIUM/COPPER/ALUMINIUM/URANIUM/CL/BRENTOIL/NATGAS/TTF/CORN/WHEAT (commodities), EUR/GBP/JPY/KRW/NOK/DXY (FX)
- 24/7 markets; same Privy EVM signing path as canonical perps (phantom-agent EIP-712)
- Asset id encoding: `100_000 + 10_000 * perpDexIndex + index_in_meta`; live `perpDexs` currently returns a leading `null` and `xyz` at index 1, so trade.xyz order/cancel asset ids are `110_000 + index_in_meta`
- Live `clearinghouseState` with `dex:"xyz"`; positions tagged `'hyperliquid-hip3'`

### Backed Finance xStocks — TOKENIZED EQUITIES + ETFs (Solana)
- Status: LIVE — `MARKETS_ENABLED=1`; trades route through `JUPITER_SWAPS_ENABLED=1` + Privy Solana wallet + Solana RPC
- Docs: https://docs.xstocks.fi/, https://backed.fi/news-updates/xstocks-are-going-live-tokenized-stocks-for-the-defi-era, https://support.kraken.com/articles/xstocks-faq
- Backend: `apps/api/src/lib/markets/xstocks.ts` (curation over Jupiter `tokens/v2/tag?query=verified` filtered by `*xStock` name pattern), `apps/api/src/routes/markets.ts` (route prefix `/markets/stocks/spot`)
- Frontend (neo): `app/(tabs)/stocks.tsx` (Spot rail), `app/markets/stocks/spot/[mint].tsx`, reuses `components/JupiterSwapSheet.tsx`
- 131 SPL Token-2022 mints at last probe — AAPLx, TSLAx, NVDAx, MSFTx, GOOGLx, AMZNx, METAx, COINx, HOODx, MSTRx, STRCx, CRCLx, SPCXx, SPYx (S&P 500), QQQx (Nasdaq), TQQQx, GLDx (Gold), AVGOx, KOx, PFEx, AMDx, JPMx, ORCLx, Vx, BRK.Bx, UNHx, XOMx, INTCx, PLTRx, DFDVx, and more
- Permissionless secondary trading (users buy from any wallet); primary mint/redeem at backed.fi requires KYC
- Multi-chain: Solana (primary), Ethereum, TON, Ink — we route Solana only via Jupiter
- Trade fee = Jupiter `platformFeeBps` (same as memes)

### Polymarket
- Status: `MARKETS_ENABLED=1` for reads; live trading requires Privy wallet, resolved CLOB `tokenId`, per-user L2 CLOB creds, kill switch clear, region eligibility, and idempotency key; KYC is not a prediction-trading gate
- Docs: https://docs.polymarket.com/market-data/overview, https://docs.polymarket.com/trading/overview, https://docs.polymarket.com/api-reference/authentication, https://docs.polymarket.com/api-reference/geoblock
- Backend: `apps/api/src/lib/markets/polymarket.ts`, `apps/api/src/routes/markets.ts`
- Frontend (neo): `app/(tabs)/predictions.tsx`, `app/predictions/[id].tsx`
- 1,000+ active markets reachable; Sprint 21 raised pagination depth (12 → 50 pages); CLOB WebSocket already wired
- Native builder/referrer fee mechanism NOT exposed by Polymarket; revenue path TODO via spread/markup

### Jupiter (memes + xStock routing)
- Status: `MARKETS_ENABLED=1` for reads; live swaps require `JUPITER_SWAPS_ENABLED=1`, Privy Solana wallet signing, Solana RPC, region eligibility, and idempotency key; KYC is not a meme/xStock trading gate
- Docs: https://developers.jup.ag/
- Backend: `apps/api/src/lib/markets/jupiter.ts`, `apps/api/src/routes/markets.ts`
- Frontend (neo): `app/(tabs)/memes.tsx`, `app/markets/memes/[mint].tsx`, `components/JupiterSwapSheet.tsx`
- Use: Token API v2 for Solana token enrichment/prices (incl. meme + xStock detection); Swap v1 for execution; routes through PumpSwap + Raydium + Orca + Meteora
- **Platform fee:** `JUPITER_PLATFORM_FEE_BPS` (cap 100 = 1%) + `JUPITER_PLATFORM_FEE_ACCOUNT` (Solana ATA) — fee collected in OUTPUT token
- Privy Solana wallet provisioned via `walletService.getOrCreateUserSolanaWallet`; same flow as Marinade + Mayan

### Pump.fun
- Status: `MARKETS_ENABLED=1`
- Docs/API: `https://frontend-api-v3.pump.fun/coins`
- Backend: `apps/api/src/lib/markets/pumpfun.ts`, `apps/api/src/routes/markets.ts` (route prefix `/markets/jupiter?source=pump`)
- Frontend (neo): `app/(tabs)/memes.tsx` (Pump.fun source filter)
- Use: discovery metadata for pump.fun-native memes (incl. bonding curve % + KOTH timestamp + reply count); execution routes through Jupiter

### PumpPortal WebSocket (deferred)
- Status: **docs-only** — requires API key + 0.02 SOL bond
- Docs: https://pumpportal.fun/data-api/real-time/
- Would unlock: live `subscribeNewToken` (free) + `subscribeMigration` (free) + `subscribeTokenTrade` (0.01 SOL / 10k events)
- Not wired this session; deferred to user opt-in

## Email

### Resend
- Status: `RESEND_API_KEY`
- Docs: https://resend.com/docs/api-reference/emails/send-email
- Backend: `apps/api/src/lib/email.ts`
- Demo fallback: stdout (no email actually sent)
- Templates: `otp`, `claim`, `digest`, `welcome`

---

## Observability

### Sentry
- Status: `SENTRY_DSN` + `SENTRY_TRACES_SAMPLE_RATE`
- Backend: `apps/api/src/lib/sentry.ts`, bootstrapped first in `index.ts`
- Pino transport: warn-level (filters out 200-OK access logs)
- PII scrubber: drops `userId` + `amountUsd` from breadcrumbs (Sprint 13 SR6)

### Prometheus
- Status: `METRICS_ENABLED=1` + `METRICS_TOKEN`
- Endpoint: `GET /metrics` (Bearer-gated; scrape from the internal toolbox data network because public Caddy hosts block `/metrics`)
- Counters: `chain_mirror_failed_total`, `markets_orders_total{venue,result}`, `earn_deposit_total{adapter}`, `earn_withdraw_total{adapter}`
- Histogram: `http_request_duration_ms{method,route,status}`

---

## Persistence

### Postgres
- Status: `DATABASE_URL`
- Backend: `apps/api/src/store/postgres.ts` facade + 12 domain modules
- Migrations: 14 files under `db/migrations/`, idempotent boot-time apply
- Demo fallback: in-memory store

### Redis (BullMQ workers)
- Status: `REDIS_URL`
- Used by: approval worker, scheduler (claim sweep, subscription renewer, digest sender)
- Demo fallback: in-memory queue

---

## Quick reference

| Vendor | Env var | Demo fallback allowed? |
|--------|---------|------------------------|
| Privy | `PRIVY_APP_ID` + `PRIVY_APP_SECRET` | yes (OTP) |
| Bridge | `BRIDGE_API_KEY` | no |
| Sumsub | `SUMSUB_APP_TOKEN` + `SUMSUB_SECRET_KEY` | yes |
| Stripe | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | yes |
| Resend | `RESEND_API_KEY` | yes (stdout) |
| Socket | `SOCKET_API_KEY` | no |
| LI.FI | `LIFI_API_KEY` (optional) | no |
| Morpho | `BASE_RPC_URL` | no |
| Aave | `BASE_RPC_URL` | no |
| Compound | `BASE_RPC_URL` | no |
| yoUSD | `YOUSD_APY_URL` | no |
| Ethena | `ETHENA_API_URL` (optional) | no |
| Marinade | Solana RPC (`CHAINSTACK_SOLANA_RPC_URL` / `SOLANA_RPC_URL` / `HELIUS_RPC_URL`) | no |
| Hyperliquid | `MARKETS_ENABLED=1` (+ HL_BUILDER_ADDRESS for build) | yes (read-only sample) |
| Polymarket | `MARKETS_ENABLED=1` + Privy wallet + per-user CLOB creds | yes (market sample; writes require live creds) |
| Gnosis Pay | `GNOSIS_PAY_API_KEY` | yes |
| Sponge | `SPONGE_API_KEY` | yes |
| Coinbase x402 | `X402_FACILITATOR_URL` | yes |
| Alchemy | `ALCHEMY_API_KEY` + `ALCHEMY_GAS_POLICY_ID` | yes |
| xStocks | (none yet) | no |
| Dinari | (none yet) | no |
| Sentry | `SENTRY_DSN` | yes |
| Postgres | `DATABASE_URL` | yes (in-memory) |
| Redis | `REDIS_URL` | yes (in-memory) |

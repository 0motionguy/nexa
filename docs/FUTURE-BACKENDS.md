# Future Backends — Watch-list (DO NOT BUILD)

> Research-only notes captured during the Stack-upgrades sprint (2026-06-14).
> Three candidates were surfaced in the upgrade audit as plausible future
> adapters but **explicitly out of scope** for this sprint. None of the code
> paths below exist in the repo. The earn router (`lib/earn-router.ts`) and
> bridge router (`lib/bridge-router.ts`) are designed so a new adapter is one
> file + an env flag — when the watch-list items mature, integration is bound
> by docs + audits + vendor access, not by architectural rework.

---

## 1. Liminal — Future high-yield earn adapter pending audit

**Source:** https://docs.liminal.money and https://docs.liminal.money/welcome.md?ask=...
**Retrieved:** 2026-06-14
**Status:** **DO NOT BUILD.** Research only.

Liminal positions itself as "Hyperliquid's Native Yield Layer." It exposes
two product surfaces: **xTokens** (asset-level yield wrappers — `xHYPE`,
`xBTC`, `xETH`, `xLEND`, plus dynamically-added markets) and **limUSD**, a
portfolio-level allocator built on top of the xToken set. Revenue streams
backing limUSD are documented as "funding rates, staking rewards, and money
markets." All redemptions settle in USDC (6 decimals).

**Peg / redemption mechanics:**
- **Instant Redemption** (omnichain) — settles at current price-per-share when
  liquidity permits. Fee 0.3%.
- **Standard Redemption** (queued) — unwinds positions over up to 7 days for
  limUSD. Fee 0%.

**Deployment:** mainnet live. **HyperEVM** (chainId 999) hosts the hub
(share logic, NAV tracking). Spoke chains include **Arbitrum** (42161) and
**Ethereum** (1). Audit status is **not disclosed** on the docs pages we
fetched.

**Integration shape (if MAYZ ever ships a Liminal adapter):**
- Discovery endpoint: `GET https://api.liminal.money/sdk/tokenized/xtokens?chainId=<id>`
  returns vault addresses, DepositPipe / RedemptionPipe contracts,
  navOracle, and OFT address. No hardcoding of addresses.
- Per chain, call DepositPipe with ERC-4626 `deposit(assets, receiver)` /
  `mint(shares, receiver)` patterns; slippage protection via `minShares` /
  `maxAssets`.
- Cross-chain deposits use **LayerZero V2 compose** with
  `ACTION_DEPOSIT_ASSET` / `ACTION_REDEEM_SHARES` payloads.
- xTokens / limUSD are treated as yield-bearing ERC-4626 assets — share
  value appreciates with NAV growth (same call-site shape as our existing
  yoUSD / Morpho / Aave adapters).

**Why it would slot in:** the earn router already routes
`tier: 'higher_yield'` to the highest-APY adapter. Adding Liminal as a
fifth adapter (gated on `LIMINAL_API_KEY` or equivalent) would make limUSD
selectable when its risk-adjusted yield exceeds Aave/Compound/Morpho/yoUSD.
Hyperliquid funding-rate exposure inside limUSD is the differentiator vs
the current pool of money-market vaults.

**Why we are not building it now:** mainnet is young, audit posture is not
public, and Hyperliquid-funding exposure layered through limUSD is a
materially different risk profile than the curated MetaMorpho / Aave vaults
we ship. Wait for an audit report + 90 days of mainnet TVL track record
before exposing user funds.

---

## 2. Sera Protocol — Future FX/swap backend pending mainnet maturity

**Source:** https://sera.cx, https://sera.cx/technology, https://docs.sera.cx
**Retrieved:** 2026-06-14
**Status:** **DO NOT BUILD.** Research only.

Sera Protocol is "a purpose-built CLOB, not an AMM" for on-chain stablecoin
FX. The pitch is direct N×N stablecoin pairs — `MYR ↔ BRL` without forcing a
USD intermediary and "paying the spread twice." Mainnet is live (page
header reads "Sera protocol · v2.1 · mainnet").

**Scope claim:** the homepage states **600+ supported stablecoins** and
**30k+ synthetic + direct pairs**. (The original upgrade-doc draft cited
"70+" — that figure is stale; the live homepage shows 600+ as of
2026-06-14.) Listed examples: USDC, EURC, XSGD, BRLA, plus 600+ more.
Settlement: ~1 block on-chain finality; quote latency: 300 ms median (p50).

**Architecture:**
- CLOB with two-sided pricing and market-maker depth (no AMM bonding curves).
- Multi-leg atomic routing for exotic corridors lacking direct liquidity.
- EIP-712 signatures for trading-operation authorization.
- Single-call API surface: pay-in, FX swap, pay-out in one call.

**Deployment:** Ethereum mainnet (live) + Ethereum Sepolia (testnet). No
Base or L2 deployment documented as of retrieval.

**Integration shape (if MAYZ ever ships Sera as a bridge-router provider):**
- REST endpoints under `https://docs.sera.cx/api-reference/` covering
  System, Orders, Swaps, Account. Specific endpoint URLs not enumerated in
  the homepage / technology pages we fetched — full surface lives behind
  the docs.sera.cx API reference.
- Access model — whitelist vs open vs API key — is **not documented** on
  the public surface. The page directs integration inquiries to "Talk to
  BD" via `/contact`. Treat as **whitelist-gated by default** until
  confirmed.
- Would replace LIFI / Socket *only for stablecoin-FX pairs* (e.g.
  USDC→EURC, USDC→XSGD). Cross-chain remains LIFI / Socket territory; Sera
  is a same-chain stablecoin-FX specialist.

**Why it would slot in:** the `BridgeRouter` already abstracts provider
selection between Socket and LIFI. Adding a third provider `'sera'` for
stablecoin-pair quotes on Ethereum mainnet is mechanically straightforward
once the API surface is locked.

**Why we are not building it now:** Ethereum-mainnet-only deployment is a
poor fit when our active venues are Base + Gnosis. Vendor access model is
unconfirmed (likely whitelist). 600+ stablecoins is overkill for the 3–4
pairs we actually route. Revisit once Sera deploys to Base or once the
card-top-up path needs stablecoin-FX legs Sera uniquely handles well.

---

## 3. Hyperliquid perps — Belongs in a separate legal entity, never inside MAYZ

**Source:** https://hyperliquid.gitbook.io/hyperliquid-docs
**Retrieved:** 2026-06-14
**Status:** **DO NOT BUILD INSIDE MAYZ.** No code path.

Hyperliquid perpetuals (leveraged perps; up to 50× on majors) are a
distinct legal and regulatory product from MAYZ's spot, earn, and
payments surface. Read-only market data (info API, funding rates,
public orderbook) is already shipped via `lib/markets/hyperliquid.ts`
(Sprint 9). Write paths — `placeOrder`, `cancel`, builder-fee approval —
are wired but intentionally **gated behind `MARKETS_TRADE_ENABLED=1`** and
require a compliance review before flipping live (HANDOVER.md §3).

Trade-endpoint integration for perps belongs in a separate legal entity,
never inside MAYZ. The two products are not bundled regardless of code
reuse opportunities — leverage-product licensing, geo-blocking,
suitability, and disclosure obligations are categorically distinct from
the MAYZ payments/earn perimeter.

No further work planned on the perps surface inside this repo.

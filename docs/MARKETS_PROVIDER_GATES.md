# Markets · Provider Gates — the single truth table

**Written 2026-07-02 (Wave 3).** This is the operator answer to "why is X
unavailable / not tradeable". Machine-readable versions of the same truth:
`GET /system/providers` (public registry, 27 vendors, drives the s28 System
screen) and `GET /system/health` (authed; full `features` flags — the trade
sheets read this to disable their CTA with the exact blocker).

Rule of the codebase (ADR-0003): a vendor is enabled when its env vars are
present. There is no second switch. Demo mode (`DEMO_MODE=1`) trades
synthetically and never calls vendors.

## Per-venue trading gates

| Venue (tab) | Reads work when | Trading works when | Blocked-CTA label |
|---|---|---|---|
| Perps (HL) | `MARKETS_ENABLED` (default on) | + `PRIVY_APP_ID`/`PRIVY_APP_SECRET` | `Trading disabled (MARKETS_ENABLED)` / `No signing wallet (PRIVY_APP_ID)` |
| HL Spot | same | same | same |
| Stocks perps (HIP-3) | same | same | same |
| Predictions (Polymarket) | same (gamma is public) | + Privy; L2 CLOB creds auto-derive on first order | same |
| Memes (Jupiter/Pump.fun) | same | + Privy + **`JUPITER_SWAPS_ENABLED=1`** (default **0**) + one Solana RPC | `Live swaps off (JUPITER_SWAPS_ENABLED)` / `No Solana RPC (SOLANA_RPC_URL)` |
| xStocks spot | same | same as Memes (Jupiter swap path) | same |
| Cards (Collector Crypt) | `CC_ENABLED` (default on) | + Privy Solana wallet + Solana RPC | `Cards disabled (CC_ENABLED)` / `No Solana RPC (SOLANA_RPC_URL)` |

Gate sources in code: `apps/api/src/lib/env.ts:450-454` (features),
`apps/api/src/lib/markets/{hyperliquid,hyperliquid-spot,hyperliquid-hip3}.ts`
(`isLiveTrading = markets && privy`), `jupiter.ts:206`
(`markets && privy && jupiterSwaps && solanaRpc`),
`routes/markets-cards.ts` (`features.ccEnabled`). Client-side surfacing:
`venueTradeBlock()` in `apps/web/src/app-main.ts` (fed by
`/system/health`; silent in demo mode).

## Every env var from the Wave-3 checklist, located

| Var | Role | Default | Where |
|---|---|---|---|
| `MARKETS_ENABLED` | All market reads + gate base | **on** | env.ts:252 |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` (+`PRIVY_VERIFICATION_KEY`) | Signing wallets, auth | off | env.ts |
| `JUPITER_SWAPS_ENABLED` | Meme + xStock swap execution | **off** | env.ts:256 |
| `SOLANA_RPC_URL` / `CHAINSTACK_SOLANA_RPC_URL` / `HELIUS_RPC_URL` | Solana sends/reads (`features.solanaRpc` = any one) | off | env.ts:338-341 |
| `POLY_API_KEY` / `POLYMARKET_BUILDER_*` | Optional PM builder-fee earning; NOT required to trade | off | provider-registry polymarket entry |
| `PM_CLOB_ENC_KEY` | Encrypts stored per-user CLOB creds | see env.ts | search `PM_CLOB` |
| `HL_BUILDER_ADDRESS` / `HYPERLIQUID_BUILDER_FEE_TENTHS_BP` / `HYPERLIQUID_REFERRAL_CODE` | Optional HL builder-fee/referral earning; NOT required to trade | off | lib/markets/hl-builder-approval.ts |
| `CC_ENABLED` / `CC_API_BASE` | Collector Crypt surface | **on** | env.ts:278-280 |
| `REALTIME_HUB_V1` | Server fan-out hub (WS/SSE). Off today → clients poll; ticket route 404s (client now stops retrying) | off | env.ts:63 |
| `BRIDGE_API_KEY` | US bank rails (KYB-gated) | off | env.ts |
| `STRIPE_SECRET_KEY` | Card onramp + hosted checkout | off | env.ts |
| `ONRAMPER_API_KEY` | Onramper widget sessions | off | env.ts:105 |
| `GNOSIS_PAY_API_KEY` / `CARD_ISSUER` | Debit card issuing (`laso` alt via `LASO_API_KEY`/`LASO_API_BASE`) | off | env.ts:196-201, lib/card/factory.ts |
| `SPONGE_API_KEY` | Agent cards/bank accounts | off | env.ts |

## To make the current decentralised build fully tradeable in production

```
MARKETS_ENABLED=1            # already the default
PRIVY_APP_ID=... PRIVY_APP_SECRET=...   # already set in prod
JUPITER_SWAPS_ENABLED=1      # ← the flip for memes + xStocks
SOLANA_RPC_URL=...           # ← or CHAINSTACK_/HELIUS_ variant
CC_ENABLED=1                 # already the default
```

Everything else in the table is optional revenue (builder fees) or a
different product surface (bank rails, cards issuing) — not a blocker for
market trading.

**Verified on production 2026-07-02** via `GET https://api.nexa.aiso.tools/system/providers`:
`privy: live`, `chain-balances: live`, `marinade: live` (⇒ a Solana RPC is
configured and the API resolves it), `hyperliquid/polymarket/collector-crypt:
live`, `jupiter: gated` ⇒ the ONLY missing piece for meme/xStock trading is
`JUPITER_SWAPS_ENABLED=1`.

## Rate-limit policy for market data (Wave 3 root-cause fix)

Public market GETs are **not** rate limited. They are all served through the
in-process route cache (request-coalesced + stale-serving), which makes the
cache the abuse shield: a read burst costs cache hits and upstream sees at
most one call per TTL per key. The old per-IP read buckets (600/min quotes +
lists, 120/min generic) were the actual cause of the intermittent
"Couldn't load X · provider unavailable or rate limited" screens — normal
chart + list polling exhausted them, especially with clients sharing an IP
behind the Cloudflare tunnel. Mutations (`POST` orders/cancels/transfers)
keep the 120/min auth-or-IP bucket; authed position reads keep their own
300/min bucket; volumetric abuse belongs to the Cloudflare/Caddy layer in
front.

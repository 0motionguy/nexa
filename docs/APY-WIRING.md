# APY-WIRING.md

**Last updated:** 2026-06-19 (Sprint 17)

How the Earn screen's APY values are computed and rendered, end-to-end. Covers the DeFi adapters that feed `EarnRouter`, the Ethena headline tile, and the source-attribution layer that surfaces freshness to the user.

## High-level flow

```
                                       ┌─────────────────────┐
                                       │ /earn/apy           │
                                       │ /earn/protocols     │
PWA Earn screen (s14) ──── reads ─────▶│ routes/earn.ts      │
                                       └──────────┬──────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │ lib/earn-router.ts  │
                                       │   summaries()       │
                                       │   pick(tier)        │
                                       └──────────┬──────────┘
                                                  │
                          ┌───────────────────────┼───────────────────────┐
                          │                       │                       │
                          ▼                       ▼                       ▼
            ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
            │ lib/chain/morpho   │  │ lib/chain/defi     │  │ lib/chain/compound │
            │ Morpho GraphQL     │  │ Aave Pool.getRD()  │  │ Comet.getSR(util)  │
            └────────────────────┘  └────────────────────┘  └────────────────────┘
                          │                       │                       │
                          └───────────────────────┴───────────────────────┘
                                                  │
                                                  ▼
                                       SourcedValueMeta envelope
                                       attached via lib/sourced.ts
```

yoUSD (`lib/chain/yousd.ts`) reads YO Protocol's public vault yield timeseries endpoint. Ethena (`lib/chain/ethena.ts`) is a separate read-only headline tile and is not allocated through `EarnRouter`.

## Adapter: Morpho (Standard tier)

- **Vault**: Steakhouse-curated USDC MetaMorpho on Base (`0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183`)
- **APY source**: Morpho GraphQL `vaultV2ByAddress { avgNetApy }`
- **API URL**: `MORPHO_API_URL` env, default `https://api.morpho.org/graphql`
- **Conversion**: `apyToBps()` in `lib/chain/apy.ts` — decimal to bps with rewards aggregated
- **Demo behavior**: `morpho.ts:137` throws `apyUnavailable('Morpho')` when `env.DEMO_MODE || process.env.VITEST`
- **Deposit**: `usdToUsdcWei(amt)` → `approve` + `vault.deposit(amt, receiver)` via EIP-7702 batch
- **Withdraw**: `vault.withdraw(amt, wallet, wallet)`

```
GraphQL query (lib/chain/morpho.ts:45-55):

  query MorphoVaultApy($address: String!, $chainId: Int!) {
    vaultV2ByAddress(address: $address, chainId: $chainId) {
      avgNetApy
      avgNetApyExcludingRewards
      rewards { supplyApr }
    }
  }
```

If `avgNetApy` is null, falls back to `avgNetApyExcludingRewards + sum(rewards.supplyApr)`.

## Adapter: Aave v3

- **Pool**: Base mainnet (`AAVE_POOL_ADDRESS`, default `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`)
- **APY source**: `Pool.getReserveData(USDC.address).liquidityRate` (ray-scaled APR)
- **Conversion**: `rayToBps()` in `lib/chain/units.ts` — `liquidityRate * 10000 / 1e27`
- **Demo behavior**: adapter `apyUnavailable('Aave')` outside live mode
- **Deposit**: `pool.supply(USDC, amt, wallet)`
- **Withdraw**: `pool.withdraw(USDC, amt, wallet)`

## Adapter: Compound III

- **Market**: cUSDCv3 on Base (`COMPOUND_COMET_ADDRESS`, default `0xb125E6687d4313864e53df431d5425969c15Eb2F`)
- **APY source**: `Comet.getSupplyRate(Comet.getUtilization())` returns per-second supply rate
- **Conversion**: per-second rate → APY via `(1 + rate)^(seconds_per_year) - 1`, then to bps
- **Demo behavior**: adapter `apyUnavailable('Compound')` outside live mode
- **Deposit**: `comet.supply(USDC, amt)`
- **Withdraw**: `comet.withdraw(USDC, amt)`

## Adapter: yoUSD

- **Vault**: `YOUSD_ADDRESS` on Base
- **APY source**: `https://api.yo.xyz/api/v1/vault/yield/timeseries/base/{YOUSD_ADDRESS}` by default; `YOUSD_APY_URL` can override it
- **Status**: public read; no auth required
- **Conversion**: last timeseries `yield` value is treated as percent APR and converted to bps

## Ethena sUSDe

- **Surface**: read-only headline yield tile with a CTA that opens Ethena; NEXA does not mint, hold, or stake sUSDe in this phase
- **APY source**: `https://app.ethena.fi/api/yields/protocol-and-staking-yield` by default; `ETHENA_API_URL` can override it
- **Deposit URL**: `https://app.ethena.fi/buy` by default; `ETHENA_DEPOSIT_URL` can override it
- **Risk copy**: UI surfaces that sUSDe yield comes from perp funding rates and can go negative
- **Route**: `GET /earn/ethena`

## EarnRouter selection rules

`lib/earn-router.ts:RISK_WEIGHTS`:

```ts
{
  morpho: 1.00,   // curator-vetted baseline
  yousd:  0.95,
  aave:   0.95,
  compound: 0.93,
}
```

`pick(tier, summaries)`:
- `tier === 'standard'` → Morpho deterministically, regardless of APY (curated tier promise)
- `tier === 'higher_yield'` → highest risk-weighted APY among `available: true` adapters
- when no adapter is available → returns a zero-APY Morpho stub; the route reports 503

`summaries()` queries each adapter in parallel, absorbing per-adapter errors and marking `available: false` so one slow RPC can't 500 the whole list. Sprint 15 enhancement: each summary now carries a `sourced: SourcedValueMeta` envelope.

## /earn/apy response shape (Sprint 15)

Success:

```json
{
  "ok": true,
  "apyBps": 712,
  "source": "earn-router",
  "sourced": {
    "source": "live",
    "provider": "morpho",
    "fetchedAt": "2026-06-17T10:13:24.123Z",
    "docsUrl": "https://docs.morpho.org/..."
  },
  "blended": {
    "value": 712,
    "source": "live",
    "provider": "morpho",
    "fetchedAt": "2026-06-17T10:13:24.123Z",
    "docsUrl": "..."
  }
}
```

Failure (no live provider):

```json
{
  "ok": false,
  "error": { "code": "apy_unavailable", "message": "Live APY is unavailable." },
  "sourced": {
    "source": "unavailable",
    "provider": "morpho",
    "fetchedAt": null,
    "errorCode": "apy_unavailable",
    "errorMessage": "Morpho APY unavailable",
    "docsUrl": "https://docs.morpho.org/..."
  },
  "adapters": [
    { "name": "morpho", "sourced": { "source": "unavailable", ... } },
    { "name": "yousd",  "sourced": { "source": "unavailable", ... } },
    { "name": "aave",   "sourced": { "source": "unavailable", ... } },
    { "name": "compound","sourced": { "source": "unavailable", ... } }
  ]
}
```

Frontend renders the unavailable envelope as `<nexa-source-badge source="unavailable" provider="Morpho" docs-url="...">` next to "APY unavailable" copy. No number is ever displayed when the source is not live.

## Frontend rendering (s14)

- `apps/web/src/app-main.ts:apyLabel(bps)` returns `"X.XX% APY"` or `"APY unavailable"`
- `apps/web/src/app-main.ts:applySourceBadge(el, meta)` paints the badge from a `SourcedValueMetaWire` envelope
- `apps/web/src/app-main.ts:renderEarnYield()` repaints the badge each time the data refreshes
- `apps/web/src/app-main.ts:renderEarnProtocolRows(protocols)` paints a per-adapter badge inside each `[data-earn-protocol="..."]` row

## Tests

- `apps/api/src/lib/earn-router.spec.ts` — unit tests for `pick()` / `summaries()` / blended APY math
- `apps/api/src/routes/earn.spec.ts` — integration tests for `/earn/apy` and `/earn/protocols`
- `apps/api/src/routes/no-leak.spec.ts` — Sprint 15 no-leak guards (every adapter row carries `sourced` envelope; `available: false` ⇒ source ∈ unavailable/error)
- `apps/api/src/lib/chain/morpho.spec.ts` (if present) — Morpho GraphQL parsing tests

## Future work

- **yoUSD position reads**: APY is live, but per-wallet share balance / accrued-yield history still needs a real read path before the UI can show second-by-second earned value.
- **Per-position blending**: today's blended APY = picked-tier APY (positions don't yet track per-adapter balance). Once per-adapter positions land, weight by USD across positions
- **Risk-tier display**: the registry already classifies adapters; the UI could surface a "Risk: Low/Medium" badge per tier

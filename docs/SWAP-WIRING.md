# SWAP-WIRING.md

**Last updated:** 2026-06-20 (Sprint 17 Phase F)

How the Swap screen and card top-up flow get live quotes and execute cross-chain transfers.

## High-level flow

```
                                    ┌──────────────────────┐
                                    │ /swap/quote          │
                                    │ /swap/execute        │
PWA Swap screen (s16) ─── reads ───▶│ routes/earn.ts       │
                                    │ (swapRoutes)         │
                                    └──────────┬───────────┘
                                               │
                                               ▼
                                    ┌──────────────────────┐
                                    │ lib/bridge-router.ts │
                                    │   quote() / execute()│
                                    └──────────┬───────────┘
                                               │
                              ┌────────────────┴────────────────┐
                              │                                 │
                              ▼                                 ▼
                  ┌────────────────────┐              ┌────────────────────┐
                  │ lib/chain/socket   │   fallback   │ lib/chain/lifi     │
                  │ Socket V3 API      │ ───────────▶ │ LI.FI API          │
                  └────────────────────┘              └────────────────────┘
                              │                                 │
                              └────────────────┬────────────────┘
                                               │
                                               ▼
                                    SourcedValueMeta envelope
                                    attached via lib/sourced.ts
```

## Provider selection rules

`routes/earn.ts`:

0. **Route any swap involving Solana through Mayan** for quote and execute. Unsupported Solana token/chain pairs fail closed with `invalid_swap_route`.

`lib/bridge-router.ts`:

1. **Try Socket first** when `features.socket` (i.e. `SOCKET_API_KEY` is set)
2. **Fall back to LI.FI** when Socket has no route or fails
3. **Synthesize 0.92 rate** when both providers fail **and** `env.DEMO_MODE` is true
4. **Return 502 quote_unavailable** otherwise (production guard)

This rule order is asserted by `lib/bridge-router.spec.ts`.

## Supported routes

`SUPPORTED_CHAINS = ['base', 'gnosis', 'polygon', 'optimism', 'arbitrum', 'solana']`
`SUPPORTED_TOKENS = ['USDC', 'EURC', 'EURe', 'USDT', 'SOL', 'mSOL']`

The "legacy" Base USDC -> EURC route uses the same router but settles on the ledger via `store.swap()` for fiat parity. All other routes settle on-chain only and never touch `balUsd`.

Mayan-supported Solana routes map Solana USDC/SOL/mSOL and EVM USDC routes into `lib/chain/mayan.ts`. Execution requires a Privy Solana wallet plus a Solana RPC URL.

## Card top-up

`routes/card.ts:topup` uses the same bridge router. Direction is Base USDC → Gnosis EURe so the user lands on the card's home network. `enableRefuel: true` is forced so the user lands with xDAI to settle.

## Socket go-live runbook (operator)

Socket is coded + spec-tested but has run dormant because no `SOCKET_API_KEY`
was set — **LIFI has carried every bridge/top-up route so far**. When the key
is set, `features.socket` flips on and Socket becomes primary with LIFI as the
automatic fallback. The adapter now also (a) prepends the ERC-20 **approval**
call when a route needs one (a first-time bridger otherwise reverts) and (b)
sends an **`AFFILIATE-ID`** header to earn integrator fees.

**Steps (on the VPS — secrets never live in the repo):**

1. Put the credentials in `/opt/neobank/secrets/maze.env` (env only):
   `SOCKET_API_KEY=…`, `SOCKET_AFFILIATE_ID=…`. Confirm
   `SOCKET_API_BASE=https://backend.socket.tech`.
2. Redeploy. `features.socket` is now true; the bridge router prefers Socket.
3. **Supervised $5 Base→Gnosis EURe card top-up.** Expect: quote/execute with
   `provider:'socket'`, the refuel gas drop present (`refuelGasUsd`), and — for
   a wallet with no prior USDC allowance — a **two-call** execution
   (`[approve, swap]`). Then confirm a fresh order still falls back to
   `provider:'lifi'` when Socket returns no route (kill the key momentarily or
   pick an unsupported pair).

**Live-doc re-verify (couldn't be done from the sandbox — Cloudflare 403 on
`docs.socket.tech` through the CI proxy). Confirm against
https://docs.socket.tech/integrate/get-api-access :**

- **Auth header name** — the adapter sends the key under **both** `API-KEY`
  and `x-api-key` to avoid a 401 from the contested spelling. Once the live
  request succeeds, collapse `socket.ts` to the single confirmed header.
- **Approval object shape** — `buildApprovalCall` parses two documented
  shapes (`approval.txData.object` executable tx, or `allowanceTarget` +
  `approvalTokenAddress` metadata → synthesized `approve()`). Confirm which
  the live API returns; if the field names differ it's a one-line change.
- **Endpoint** — that `GET /v3/swap/quote` on `backend.socket.tech` is current
  (Socket has been rebranding to Bungee).

**Security:** the `SOCKET_API_KEY` / `SOCKET_AFFILIATE_ID` values were shared in
a chat transcript during wiring — rotate them from the Socket/Bungee dashboard
after go-live if that exposure is a concern. They must never be committed.

## Tokenized stocks (capability-gated)

xStocks and Dinari are listed in the provider registry as `docs-only`. The capability detection layer (planned for next sprint) will:

1. Ask Socket / LI.FI if the route `USDC → AAPLx` (etc.) exists
2. If a route exists, mark `tokenized-stocks` capability as live and surface the asset class in the swap picker
3. If no route exists, keep the asset hidden from the UI

The PWA must **never** show tokenized stocks as buyable until step 2 succeeds. Sprint 15 adds the registry hook; the UI hides the asset class by default.

Allowed labels (when capability lands):
- `AAPLx`, `TSLAx`, `SPYx`, `NVDAx`

Forbidden labels:
- "Buy Apple stock", "Own Apple shares", "Guaranteed 24/7 stocks"

Required copy when shown:
- "Tokenized exposure · Availability depends on provider and region · Not direct shareholder ownership unless provider terms say so"

## CCTP (planned)

Circle CCTP is registered as `docs-only`. The integration plan:

1. Add `lib/chain/cctp.ts` calling `CCTP::depositForBurn(amt, destination)`
2. Add CCTP as a route option in `bridge-router.ts` before Socket/LI.FI when both endpoints are USDC + chains are CCTP-supported
3. Drop the registry status to `live`

This unblocks native USDC cross-chain transfer without going through a swap aggregator. Not in Sprint 15 scope.

## /swap/quote response shape (Sprint 15)

Success (live):

```json
{
  "ok": true,
  "amount": 100,
  "direction": "usd-eur",
  "fromChain": "base",
  "toChain": "base",
  "fromToken": "USDC",
  "toToken": "EURC",
  "rate": 0.9210,
  "out": 92.10,
  "fees": 0.10,
  "refuelGasUsd": null,
  "source": "socket",
  "sourced": {
    "source": "live",
    "provider": "socket",
    "fetchedAt": "2026-06-17T10:13:24.123Z",
    "docsUrl": "https://docs.socket.tech/..."
  }
}
```

Failure (production, no live route):

```json
{
  "ok": false,
  "error": { "code": "quote_unavailable", "message": "Live swap quote is unavailable." },
  "sourced": {
    "source": "unavailable",
    "provider": "socket",
    "fetchedAt": null,
    "errorCode": "rpc_failed",
    "errorMessage": "..."
  }
}
```

Demo (DEMO_MODE only):

```json
{
  "ok": true,
  "amount": 100,
  "rate": 0.92,
  "out": 92,
  "source": "demo",
  "sourced": {
    "source": "provider-demo",
    "provider": "socket",
    "fetchedAt": "2026-06-17T10:13:24.123Z",
    "docsUrl": "..."
  }
}
```

`source: "demo"` and `sourced.source: "provider-demo"` are equivalent — the legacy string is kept for backward compat, the sourced envelope is the canonical signal.

## Frontend rendering (s16)

- `apps/web/src/app-main.ts:refreshSwapQuote()` paints the route name + the source badge
- `apps/web/src/app-main.ts:setSwapQuotePending()` clears the badge before fetching
- `apps/web/app.html`: `[data-swap-source]` is a `<nexa-source-badge>` placed in the swap card under "BEST ROUTE"

## Tests

- `apps/api/src/lib/bridge-router.spec.ts` — Socket/LIFI selection, demo fallback, error pass-through
- `apps/api/src/lib/chain/socket.spec.ts` — Socket V3 API parsing, `API-KEY`/`x-api-key`/`AFFILIATE-ID` headers, approval-tx prepend (`[approve, swap]`)
- `apps/api/src/lib/chain/mayan.spec.ts` - Mayan quote capability and execute surface
- `apps/api/src/routes/earn.spec.ts` - Solana swap route validation and Mayan execute submission
- `apps/api/src/routes/no-leak.spec.ts` — Sprint 15 guards: `/swap/quote` response carries a `sourced` envelope; demo response declares `provider-demo` (never silently live)

## Future work

- CCTP integration (above)
- Tokenized stocks capability detection (above)
- Multi-hop routes (Socket already returns these; UI doesn't surface the hops yet)
- Quote expiry countdown on the UI (response carries `expiresAt`; UI doesn't render the countdown yet)

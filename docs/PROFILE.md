# `GET /me/profile` — Unified Profile Aggregator

One endpoint that returns the full Neo Bank user state across identity,
wallets, balances, KYC, geo, and per-venue trading eligibility. Replaces
~6 separate roundtrips with one call.

## When to use it

- **On app boot** — to hydrate the entire client state in one shot
- **Before opening a trade sheet** — `trading[venue].liveTrading` tells you whether to gate
- **After deposit / KYC events** — re-fetch to see new eligibility
- **For server-side gating** — third-party clients with sk_* can read on behalf of users

## Auth

Accepts EITHER a session JWT (mobile/web) OR an API key. The route detects
the token shape and dispatches to the right middleware.

```
GET /me/profile
Authorization: Bearer <token | sk_test_… | sk_live_…>
```

## Response schema

```ts
{
  ok: true,
  livemode: boolean | null,     // null for session JWTs; true/false for sk_*
  region: string | null,         // CF-IPCountry header (e.g. "DE")

  user: {
    id: string,                  // UUID
    email: string,
    name: string | null,
    kycStatus: 'pending' | 'reviewing' | 'approved' | 'rejected',
    killSwitch: boolean,         // admin froze the account → all trades return 423
  },

  wallets: {
    primary: string | null,            // EVM 0x… (used for Privy embedded EVM wallet)
    privy: {
      evm: { walletId: string, address: '0x…' } | null,
      solana: { address: '…' } | null,   // base58; null until first Jupiter swap
    },
  },

  balances: {
    balUsd: number,              // primary USD balance (cash)
    earnUsd: number,             // amount in earn tier
    earnApy: number | null,      // current APY estimate
  },

  earnConfig: {
    earnByDefault: boolean,
    autoDivestOnSpend: boolean,
    divestThresholdUsd: number,
  },

  trading: {
    // Keys are MarketVenue strings — same as venue tags in nb_market_positions.
    'hyperliquid':       VenueGate,
    'hyperliquid-spot':  VenueGate,
    'hyperliquid-hip3':  VenueGate,      // trade.xyz stocks
    'jupiter':           VenueGate,      // memes
    'xstocks':           VenueGate,
    'polymarket':        VenueGate,
  },

  features: {
    markets: boolean,
    privy: boolean,
    jupiterSwaps: boolean,
    bridge: boolean,
    monerium: boolean,
  },
}

type VenueGate = {
  enabled: boolean,              // feature flag on?
  liveTrading: boolean,          // ready to take a live order? (all deps satisfied)
  regionAllowed: boolean,        // not geo-blocked?
  walletReady: boolean,          // user has the wallet this venue needs?
  feeBps: number,                // platform fee rate in basis points
  // Venue-specific extras:
  builderApproved?: boolean,           // HL backend agreement completed?
  builderMaxFeeTenthsBp?: number | null,// HL only
  clobCredsReady?: boolean,            // Polymarket only
  feeAccountConfigured?: boolean,      // Jupiter only
  dex?: string,                        // HIP-3 only — "xyz"
}
```

## How to gate a trade

Pseudocode for "should I let the user trade venue V?":

```ts
const me = await nx.me.profile();
const gate = me.trading[venue];

if (!gate.enabled)        showError('comingSoon');
else if (!gate.regionAllowed) showError('regionBlocked');
else if (!gate.walletReady)   promptWalletProvision();
else if (venue === 'polymarket' && !gate.clobCredsReady)
                              promptPmCredsBootstrap();
else                          openTradeSheet();
```

Hyperliquid builder fee agreement is backend-managed during account setup or
the first live HL action. Clients should not show an order-time builder
approval prompt.

## Live signal vs cached

`/me/profile` is computed fresh on every call (no caching). Most of the
state is in `nb_users` and `nb_users` is read in `requireSession`, so the
roundtrip is one Postgres query plus the per-venue feature checks. Sub-50ms
in production.

## Privacy

- Returns the user's own data only
- API-key callers see scoped data per the key's mode (`livemode: true|false`)
- Region is inferred from CF-IPCountry header; not stored

## Related

- Source: `apps/api/src/routes/me.ts`
- SDK: `nx.me.profile()` in [`@nexa/sdk`](../packages/nexa-sdk)
- MCP: `get_profile` tool in [`@nexa/mcp`](../apps/mcp)
- Venue tags: `MarketVenue` union in `apps/api/src/store/types.ts`

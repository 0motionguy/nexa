# @nexa/sdk

TypeScript client for the **Neo Bank / NEXA** public API. One typed surface
covering all six markets venues (Hyperliquid perps + spot, trade.xyz HIP-3
stocks, Backed Finance xStocks, Jupiter memes, Polymarket predictions), the
unified `/me/profile` aggregator, and the payments / x402 surface.

Zero runtime dependencies. Works in Node 20+, modern browsers, Bun, and
Cloudflare Workers (uses global `fetch`).

## Install

```bash
pnpm add @nexa/sdk
# or
npm install @nexa/sdk
```

## Quickstart

```ts
import { NexaClient } from '@nexa/sdk';

const nx = new NexaClient({
  baseUrl: 'https://nexa.aiso.tools',
  apiKey: process.env.NEXA_API_KEY, // sk_live_... or a session JWT
});

// Unified profile — replaces ~6 separate endpoint calls
const me = await nx.me.profile();
console.log(me.user, me.balances, me.trading);

// List markets across venues
const perps   = await nx.markets.hyperliquid.list();
const stocks  = await nx.markets.stocks.list();
const memes   = await nx.markets.jupiter.list({ tag: 'meme' });
const events  = await nx.markets.polymarket.list({ limit: 100 });

// Place a trade (idempotent — required for live)
const builder = await nx.markets.hyperliquid.builderStatus();
console.log(builder.needsApproval); // false: backend-managed agreement

const r = await nx.markets.stocks.placeOrder({
  coin: 'xyz:TSLA',
  sideLong: true,
  qtyUsd: 100,
  leverage: 5,
  orderType: 'market',
}, crypto.randomUUID());

// Hyperliquid wallet movement is not a KYC/bank-offramp flow.
await nx.markets.hyperliquid.usdClassTransfer({ amountUsd: 50, toPerp: true }, crypto.randomUUID());
await nx.markets.hyperliquid.usdSend({
  destination: '0x0000000000000000000000000000000000000000',
  amountUsd: 25,
}, crypto.randomUUID());
await nx.markets.hyperliquid.withdraw({
  destination: '0x0000000000000000000000000000000000000000',
  amountUsd: 25,
}, crypto.randomUUID());

// Portfolio bucket movement is also typed.
const balances = await nx.balances.get();
const deposit = await nx.transfers.depositAddress('perps');
const transfer = await nx.transfers.internal({
  fromBucket: 'cash',
  toBucket: 'perps',
  amountUsd: 100,
}, crypto.randomUUID());
const status = await nx.transfers.get(transfer.transferId);
```

## Authentication

Both auth modes share one wire: an opaque token in the `Authorization` header.

| Caller | Token shape | Where it comes from |
|---|---|---|
| Mobile/web user | Session JWT | `POST /auth/start` → email OTP → `POST /auth/verify` returns `token` |
| Server-to-server | API key `sk_live_*` / `sk_test_*` | Create via the developer dashboard or `POST /keys` |

```ts
// Server-side with API key
const nx = new NexaClient({ apiKey: 'sk_live_...' });

// Or sign a user in from your own client:
const r = await nx.auth.start('user@example.com');
const session = await nx.auth.verify(r.challengeId, '482019');
const userClient = new NexaClient({ apiKey: session.token });
```

`sk_test_*` keys see only sandbox data — same wire shape, but `/balance`
and trade-route writes are sandboxed.

## Error handling

Every non-2xx response throws `NexaError` with the status, machine-readable
code, and the raw response body:

```ts
import { NexaError } from '@nexa/sdk';

try {
  await nx.markets.hyperliquid.placeOrder({...});
} catch (e) {
  if (e instanceof NexaError && e.code === 'trading_wallet_unavailable') {
    // ask the user to sign in again so the server wallet can be provisioned
  }
}
```

Stable error codes (subset):

- `unauthorized` — bad/expired token
- `region_blocked` — geo gate on a venue
- `polymarket_token_unavailable` — couldn't resolve the outcome tokenId
- `solana_wallet_unavailable` — Privy Solana wallet not yet provisioned
- `idempotency_key_required` — missing `Idempotency-Key` header on a live trade
- `region_blocked` / `region_unknown` — venue compliance gate; not a KYC state

## Idempotency

Every live trading endpoint **requires** an `Idempotency-Key` header. The
SDK adds it automatically when you pass it as the second argument:

```ts
await nx.markets.jupiter.swap({
  inputMint: SOL,
  outputMint: BONK,
  amountAtomic: '1000000000',
}, idempotencyKey);
```

Reuse the same key within ~24h to safely retry a request. The server replays
the original response without re-submitting to the venue.

Hyperliquid builder fees are a backend-managed agreement. `builderStatus()`
reports the agreement state, but `needsApproval` is always false for current
clients; do not build an order-time approval prompt.

## Escape hatch

If a newer endpoint isn't in the typed surface yet, call it raw:

```ts
const data = await nx.request('/markets/some-new-venue', {
  method: 'POST',
  body: { foo: 1 },
  idempotencyKey: 'abc',
});
```

Same auth, same error handling, untyped response.

## Versioning

Semver. The SDK targets the public `/v1` + the `/markets/*` + `/me/*`
surface; both are versioned in the OpenAPI spec at
`https://nexa.aiso.tools/v1/openapi.json`.

## Regenerating types from the live OpenAPI spec (F088)

The response types in `src/index.ts` are hand-maintained and can drift
from the server. The `gen:types` script keeps them honest:

```bash
# one-time: install the codegen tool
pnpm --filter @nexa/sdk add -D openapi-typescript

# with the API running locally (`pnpm --filter @nexa/api dev`):
pnpm --filter @nexa/sdk gen:types

# or against a deployed instance:
NEXA_API_URL=https://nexa.aiso.tools pnpm --filter @nexa/sdk gen:types
```

The script fetches `${NEXA_API_URL}/v1/openapi.json`, runs
`openapi-typescript` against it, and writes
`src/generated/api-schema.ts`. From there, replace hand-maintained
response interfaces with `paths['/<route>']['get'|'post']['responses'][200]`
slices and `pnpm typecheck` will catch any future drift at compile time.

## Links

- API reference: [docs/API.md](../../docs/API.md)
- Fee model + revenue: [docs/FEES.md](../../docs/FEES.md)
- Profile aggregator: [docs/PROFILE.md](../../docs/PROFILE.md)
- MCP server: [docs/MCP.md](../../docs/MCP.md)

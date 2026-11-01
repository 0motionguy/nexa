# Neo Bank SDK — `@nexa/sdk`

Typed TypeScript client for the Neo Bank public API. **Zero runtime
dependencies**. Works in Node 20+, modern browsers, Bun, Cloudflare
Workers.

See the README at `packages/nexa-sdk/README.md` for the full reference;
this doc covers the parts a partner integrator most often needs.

## Why use the SDK

- **One typed surface** for all six markets venues + profile + payments
- **Idempotency keys** added automatically when you pass them
- **Errors** map to a `NexaError` instance with the wire status + code
- **Future endpoints** — escape hatch via `nx.request(path, init)` keeps you unblocked

## Install

```bash
pnpm add @nexa/sdk
```

## Typical flows

### 1. Server-to-server (Node/Bun/Cloudflare Worker)

```ts
import { NexaClient } from '@nexa/sdk';

const nx = new NexaClient({
  baseUrl: process.env.NEXA_BASE_URL,
  apiKey: process.env.NEXA_API_KEY,         // sk_live_…
});

// Hydrate everything in one call
const me = await nx.me.profile();

// Stream-friendly markets list
const stocks = await nx.markets.stocks.list();
for (const s of stocks.perps) {
  console.log(s.ticker, s.priceUsd);
}

// Trade
const idem = crypto.randomUUID();
const builder = await nx.markets.hyperliquid.builderStatus();
console.log(builder.needsApproval); // false: backend-managed, no order-time prompt

const r = await nx.markets.stocks.placeOrder(
  { coin: 'xyz:TSLA', sideLong: true, qtyUsd: 100, leverage: 5, orderType: 'market' },
  idem,
);

// Move USDC between portfolio buckets. This is not a bank/offramp KYC flow.
const balances = await nx.balances.get();
const deposit = await nx.transfers.depositAddress('perps');
const transfer = await nx.transfers.internal(
  { fromBucket: 'cash', toBucket: 'perps', amountUsd: 100 },
  crypto.randomUUID(),
);
const status = await nx.transfers.get(transfer.transferId);

// Hyperliquid wallet movement.
await nx.markets.hyperliquid.usdClassTransfer({ amountUsd: 50, toPerp: true }, crypto.randomUUID());
await nx.markets.hyperliquid.usdSend({
  destination: '0x0000000000000000000000000000000000000000',
  amountUsd: 25,
}, crypto.randomUUID());
await nx.markets.hyperliquid.withdraw({
  destination: '0x0000000000000000000000000000000000000000',
  amountUsd: 25,
}, crypto.randomUUID());
```

### 2. Browser (after the user is signed in)

```ts
import { NexaClient } from '@nexa/sdk';

// Get session JWT via your own login flow, or wrap nx.auth
const session = await nx.auth.verify(challengeId, code);
const userNx = new NexaClient({ apiKey: session.token });

const me = await userNx.me.profile();
```

### 3. Drop-in for an existing fetch loop

```ts
// If you've got code that hits /markets/* via fetch already, swap in:
const data = await nx.request(`/markets/jupiter?source=both&limit=50`);
// Same auth, same errors, untyped response.
```

## Errors

```ts
import { NexaError } from '@nexa/sdk';

try {
  await nx.markets.hyperliquid.placeOrder({...}, idem);
} catch (e) {
  if (e instanceof NexaError) {
    // e.status: 503
    // e.code:   'trading_wallet_unavailable'
    // e.details: { ok:false, error: {...} }
    if (e.code === 'trading_wallet_unavailable') {
      // ask the user to sign in again so the server wallet can be provisioned
    }
  }
}
```

Full code list in [API.md](./API.md#stable-error-codes).

## Idempotency

Every live trade and transfer route requires an `Idempotency-Key`. The SDK adds it
when you pass it as the **second** argument:

```ts
await nx.markets.jupiter.swap({
  inputMint: SOL_MINT,
  outputMint: BONK_MINT,
  amountAtomic: '1000000000',
}, idempotencyKey);
```

Reuse the same key within ~24h to safely retry. The server replays the
original response without re-submitting to the venue.

Generate keys with `crypto.randomUUID()`, or your own scheme that includes
user id + market + size + minute bucket — anything that's stable across
your retries.

## Types you'll touch most

```ts
import type {
  MeProfile,         // /me/profile response
  MeFees,            // /me/fees response
  HlMarket,          // Hyperliquid perp market
  Hip3Market,        // trade.xyz HIP-3 stock perp
  XStock,            // Backed Finance xStock token
  MemeToken,         // pump.fun + Jupiter merged
  PmMarket,          // Polymarket prediction
  MarketPosition,    // nb_market_positions row
  PortfolioBalancesResponse,
  TransferRecord,
  HlOrderRequest,    // body shape for HL order POST
  Hip3OrderRequest,  // body shape for HIP-3 order POST
  JupSwapRequest,    // body shape for Jupiter swap POST
} from '@nexa/sdk';
```

## Versioning

Semver. We bump minor for additive surface, major for breaking changes.
The `request()` escape hatch always works regardless of the typed surface.

## Related

- README: `packages/nexa-sdk/README.md`
- API reference: [API.md](./API.md)
- Profile aggregator: [PROFILE.md](./PROFILE.md)
- Fee model: [FEES.md](./FEES.md)
- MCP server (uses the SDK): [MCP.md](./MCP.md)

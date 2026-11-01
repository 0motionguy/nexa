# Portfolio data flow

**2026-06-21 · Sprint 19 · How the Trade-tab Portfolio reads and writes · Code-grounded.**

The Trade tab's Portfolio surface (and the bottom-nav balance pill) read from
`GET /balances`. Bucket-to-bucket transfers post to `POST /transfers/internal`.
This doc traces the data both directions.

Parent: [BRIDGING-ARCHITECTURE.md](BRIDGING-ARCHITECTURE.md). Related: [TRANSFER-STATE-MACHINE.md](TRANSFER-STATE-MACHINE.md), [ONRAMP-OPTIONS.md](ONRAMP-OPTIONS.md).

---

## 1. Read path — GET /balances

```
┌──────────────────────┐
│  Trade tab Portfolio │  ← polls every 15s (or on visibility change)
│  Bottom nav balance  │
└─────────┬────────────┘
          │  fetch('/balances')
          ▼
┌──────────────────────┐
│  routes/transfers.ts │  balancesRoutes.get('/')
│  balancesRoutes      │
└─────────┬────────────┘
          │  walletService.getOrCreateUserWallet + getOrCreateUserSolanaWallet
          │  readPortfolioBalances({ evmAddress, solanaAddress })
          ▼
┌──────────────────────┐
│ lib/chain/balances.ts│
│ readPortfolioBalances│  Promise.all over chain + venue reads
└─────────┬────────────┘
          ├─→ viem.readContract(USDC.balanceOf) on arbitrum   ──┐
          ├─→ viem.readContract(USDC.balanceOf) on polygon    ──┤
          ├─→ viem.readContract(USDC.balanceOf) on base       ──┤ in parallel
          ├─→ viem.readContract(USDC.balanceOf) on optimism   ──┤
          └─→ @solana/web3.js getParsedTokenAccountsByOwner   ──┘
                                                              ▼
                                              ┌────────────────────────────┐
                                              │ { totalUsd, buckets,       │
                                              │   byChain, wallets, live } │
                                              └────────────────────────────┘
```

Each chain read is **best-effort** — a failure on one chain returns 0 with a warn log, the others still complete. So a Solana RPC blip doesn't black out the Perps/Predictions/Cash readings.

Response shape:
```json
{
  "ok": true,
  "totalUsd": 4820.40,
  "buckets": {
    "perps":       { "usd": 1215.12, "chain": "arbitrum", "sources": { "arbitrum": 1200.00, "hyperliquidSpot": 15.12 } },
    "predictions": { "usd":  340.00, "chain": "polygon"  },
    "memes":       { "usd":  280.40, "chain": "solana"   },
    "cash":        { "usd": 3000.00, "chain": "base"     }
  },
  "byChain": {
    "arbitrum": 1200, "polygon": 340, "base": 3000, "solana": 280.40, "hyperliquidSpot": 15.12
  },
  "wallets": {
    "evm": "0x…",
    "solana": "…"
  },
  "live": true,
  "sourced": { … }
}
```

`live: true` means at least one EVM RPC URL was configured. `live: false` means we're hitting public RPC defaults (still works; rate-limited).

---

## 2. Write path — POST /transfers/internal

```
User taps "Move 50 from Perps to Memes" in the Transfer sheet
  │
  ▼
fetch POST /transfers/internal
  Body: { fromBucket:"perps", toBucket:"memes", amountUsd:50, idempotencyKey?:"…" }
  │
  ▼
routes/transfers.ts:
  ▪ Validates buckets, amount, kill-switch
  ▪ Derives idempotencyKey (header → body → deterministic fallback)
  ▪ pickRail(arbitrum, solana) → 'mayan'   (any side Solana = Mayan)
  ▪ transferStore.create({ … })
      → INSERT nb_transfers (status='created')
      → SELECT first if (user_id, idempotency_key) replay
  ▪ if rail === 'cctp': enqueueTransferProgress(transfer.id)
  ▪ Returns: { transferId, status, rail, etaSec, idempotent }
  │
  ▼
Client polls GET /transfers/:id every 5s OR subscribes to SSE
  │
  ▼
When status reaches 'complete' or 'failed', refetch GET /balances
```

For round 1, only CCTP rail goes through the worker. Mayan / Socket / LIFI single-shot would happen inline in the route (not yet implemented for `/transfers/internal` — current code logs a TODO).

---

## 3. Why poll vs. WS for balances?

Trade-tab price ticks (Hyperliquid allMids) flow over a single shared WebSocket. Balance ticks are different:

- **Lower frequency** — balances change only on deposit, transfer, or trade. Sub-second pushing is overkill.
- **Cheaper RPC** — viem `balanceOf` is one call per chain per refresh. WebSocket subscriptions to USDC `Transfer` events on every chain would be 5+ WS connections per user, with delta logic on the client.
- **Restart-safe** — a polled API self-heals after a network blip; a WS-subscribed client has to reconcile on reconnect.

Recommendation: 15s poll on the visible tab, longer on background. Hard-refresh on transfer completion.

---

## 4. Identity & wallet provisioning

Both Privy wallets get provisioned **lazily** when `walletService.getOrCreate*` is called for the first time. The /balances route is the first call most users hit, so the wallet creation happens in-line on first /balances fetch — adds ~300-800ms for new users.

If this latency becomes a UX issue, two options:
- Provision both wallets eagerly during sign-in (one extra Privy call per user, one-time)
- Add a `/me/wallets` route the frontend calls during onboarding to warm the cache

---

## 5. Demo path

When `features.privy === false`:
- `walletService.getOrCreateUserWallet` returns a deterministic mock 0x address derived from `userId`
- `walletService.getOrCreateUserSolanaWallet` returns a deterministic base58-shaped mock
- `readPortfolioBalances` reads against the public RPC defaults using those mock addresses → all 0
- The route returns the full shape with `totalUsd: 0`, `live: false`, demo-sourced envelope

This lets the UI render shape-correctly with no live wallet, no Postgres, no Redis. The Trade-tab Portfolio shows zeros under each bucket, with the "Available · Live in production" microcopy from the sourced envelope.

---

## 6. Caching

The plan called for 10s in-Redis caching keyed `bal:{userId}`. Not yet implemented — round 1 is uncached. Adding the cache is a one-file change to `readPortfolioBalances`:

```ts
// pseudo
const cached = await redis.get(`bal:${userId}`);
if (cached) return JSON.parse(cached);
const fresh = await /* the parallel reads */;
await redis.setex(`bal:${userId}`, 10, JSON.stringify(fresh));
return fresh;
```

Cache invalidation: clear `bal:{userId}` on successful POST /transfers/internal commit. The cache layer can land when production traffic justifies it.

---

## 7. SSE / live updates (not in this round)

The plan mentioned SSE for transfer progress. Current state: the client polls `GET /transfers/:id`. SSE would land as:

- Add `transfersRoutes.get('/:id/stream', requireEventStreamSession, …)` mirroring [routes/ledger.ts:activity/stream](../apps/api/src/routes/ledger.ts)
- Worker calls `store.bus.emit('transfer:state_change', { transferId, from, to })` after every transition
- Route writes the event to the SSE stream when `transferId` matches the user's

Defer until poll volume becomes a real concern.

# Bridging architecture

**2026-06-21 · Sprint 19 · Cross-chain settlement layer · Code-grounded.**

NEXA is the routing mothership for the AISO ecosystem. The Portfolio in the
Trade tab needs to move USDC between four "buckets" (Perps · Arbitrum,
Predictions · Polygon, Memes · Solana, Cash · Base) without the user thinking
about chains. This doc explains the rail stack that makes that work.

Related: [CCTP-WIRING.md](CCTP-WIRING.md), [TRANSFER-STATE-MACHINE.md](TRANSFER-STATE-MACHINE.md), [ONRAMP-OPTIONS.md](ONRAMP-OPTIONS.md), [PORTFOLIO-DATA-FLOW.md](PORTFOLIO-DATA-FLOW.md).

---

## 1. Bucket × chain map

| Bucket | Chain | Token | Settlement venue |
|---|---|---|---|
| Perps | Arbitrum | USDC native | Hyperliquid Bridge2 → HL L1 |
| Predictions | Polygon | USDC native + USDC.e | Polymarket CTF Exchange (CLOB) |
| Memes | Solana | USDC SPL | Jupiter / Pump.fun via Privy Solana wallet |
| Cash | Base | USDC | Default home; earn vaults (Aave, Morpho, Compound) |

Each user has two Privy server wallets:
- One **EVM wallet** — same address across Arbitrum / Polygon / Base / Optimism (signed via [lib/privy.ts:135-164](../apps/api/src/lib/privy.ts#L135-L164))
- One **Solana wallet** — base58 address ([lib/privy.ts:177-204](../apps/api/src/lib/privy.ts#L177-L204))

Address resolution flows through [lib/chain/wallet.ts:WalletService](../apps/api/src/lib/chain/wallet.ts#L119-L130) — never re-derive from scratch.

---

## 2. Rail selection

| Route | Rail | Why |
|---|---|---|
| Arbitrum ↔ Polygon / Base / Optimism USDC | **CCTP V1** | Canonical USDC burn-and-mint; 1:1, no slippage, ~60-120s finality. Circle attestation between burn and mint. |
| EVM ↔ Solana USDC | **Mayan Swift** | Same Circle attestation under the hood + Solana hop. Public quote API, ~3s execution. |
| Any EVM ↔ EVM non-USDC | **Socket → LI.FI fallback** | Already-wired aggregators; fall back when CCTP can't route. |
| HL L1 deposit (Arbitrum USDC → HL balance) | **HL Bridge2** | Native Hyperliquid deposit path (`0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7`). No aggregator. |
| Same-chain bucket move | **internal** | No on-chain hop. Cash ↔ Cash within Base is a ledger update only. |

Rail picking lives in [routes/transfers.ts:pickRail](../apps/api/src/routes/transfers.ts) — order:
1. `from === to` → `internal`
2. Either side is Solana → `mayan`
3. Both EVM + both in CCTP registry + token=USDC → `cctp`
4. Otherwise → `socket`

**Rejected rails (and why):**
- **LayerZero / Stargate** — wrap USDC into LZ-OFT pool tokens (slippage, LP depeg risk, extra contract surface).
- **fun.xyz / FunKit** — EVM-only ([@funkit/core](https://www.npmjs.com/package/@funkit/core)), `@funkit/connect` onramp is closed-beta. Use as UX reference, not integration.
- **Decent.xyz** (now [swaps.xyz](https://docs.swaps.xyz/)) — no incremental coverage over Socket + LI.FI + Mayan already in tree.

---

## 3. Contract registry

CCTP V1 addresses live in [lib/chain/cctp.ts:CCTP_TOKEN_MESSENGER / CCTP_MESSAGE_TRANSMITTER / USDC_BY_CHAIN](../apps/api/src/lib/chain/cctp.ts). Sourced from
https://developers.circle.com/cctp/evm-smart-contracts. See [CCTP-WIRING.md](CCTP-WIRING.md) for the full list with byte-level layouts.

Per-chain RPC URLs read in [lib/chain/balances.ts:rpcUrlFor](../apps/api/src/lib/chain/balances.ts). Env vars: `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL`, `BASE_RPC_URL`, `OPTIMISM_RPC_URL`, `SOLANA_RPC_URL` / `HELIUS_RPC_URL`. All optional with public-RPC defaults.

---

## 4. The four load-bearing routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/balances` | Aggregate per-chain USDC balances plus Hyperliquid Spot USDC → bucket totals. Powers Trade Portfolio + bottom nav. |
| POST | `/transfers/internal` | Bucket → bucket transfer. Creates `nb_transfers` row, enqueues bridge-worker job, returns transferId in <500ms. |
| GET | `/transfers/:id` | Single transfer with full state-machine event audit. |
| GET | `/transfers/onramp/deposit-address?bucket=perps\|predictions\|memes\|cash` | Per-bucket Privy address for external deposits. |

Routes live in [routes/transfers.ts](../apps/api/src/routes/transfers.ts). Mounted at `/balances` and `/transfers` in [index.ts](../apps/api/src/index.ts).

---

## 5. Per-chain wallet provisioning

Both Privy wallets are provisioned on demand (no eager setup at sign-in):

- First call to `walletService.getOrCreateUserWallet(userId, null)` → Privy `walletApi.create({chainType:'ethereum'})` if missing → returns 0x address shared across all EVM chains.
- First call to `walletService.getOrCreateUserSolanaWallet(userId, null)` → Privy `walletApi.create({chainType:'solana'})` if missing → returns base58 address.

Per-agent wallets are SEPARATE (one Privy wallet per `(agent_id, chain)` in [nb_privy_wallets](../apps/api/src/db/schema/index.ts)). Agent wallets sign their own x402 payments, not the human's.

---

## 6. Gas policy

Today: every on-chain hop goes through the Alchemy 7702 batch executor ([lib/chain/alchemy.ts](../apps/api/src/lib/chain/alchemy.ts)) with `ALCHEMY_GAS_POLICY_ID` paying gas. NEXA absorbs the gas cost; the user signs zero ETH.

Future cap (recommended, not yet implemented): $0.50/transfer/day per user, capped at 10 transfers/day. Over the cap, the user pays from their USDC balance. Implementation note: track in a new `nb_gas_meter` table keyed `(user_id, date)`.

---

## 7. Failure modes

| Failure | What happens | Recovery |
|---|---|---|
| Iris attestation slow (>5 min) | Worker keeps polling up to MAX_ATTESTATION_ATTEMPTS (~25 min) | Attestation almost always lands; if it doesn't, transfer marks `failed` with `attestation_timeout` |
| Burn tx reverted | `wallet_getCallsStatus` returns FAILED | Transfer marks `failed` with `burn_failed`; user can retry with new idempotency key |
| Mint tx reverted | Same shape on the dst chain | Transfer marks `failed` with `mint_failed`. Funds are NOT lost — the burned USDC is still claimable via `MessageTransmitter.receiveMessage` from any wallet, but admin tooling is needed. |
| API restart mid-flight | `transferStore.listMidFlight()` re-enqueues every non-terminal transfer on boot (see [workers/bridge-worker.ts:startBridgeWorker](../apps/api/src/workers/bridge-worker.ts)) | Automatic. State machine resumes from the last persisted status. |
| Redis down | Routes still create the `nb_transfers` row but the worker can't run | When Redis comes back, a manual `enqueueTransferProgress(id)` per orphan resumes them. Future: admin endpoint. |

---

## 8. What's NOT in this round

- **Native Solana CCTP** (Circle's Solana program `CCTPv2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`). Mayan handles the same flow internally; native Solana CCTP would let us skip the Mayan fee.
- **Bucket-specific final-hop deposit** beyond the cross-chain leg:
  - HL Bridge2 `depositForAccount` (Arbitrum USDC → HL L1 balance)
  - Polymarket USDC.e hop (Polygon native USDC → USDC.e, until Polymarket's direct USDC support rolls out)
  - SPL ATA creation if the user's Solana wallet has no USDC ATA yet
- **CCTP V2** — fast-finality + hooks variant. V1 is fine for round 1.
- **Webhook from Circle** — currently we POLL Iris. V2 supports push notifications via webhook, which would cut Iris poll volume.
- **Onramper backend transaction creation** — round 1 only generates the iframe URL. Future: server-side transaction tracking via Onramper's `/v3/transactions` for full lifecycle.
- **Three-tab Pay modal frontend** — backend ready (`/transfers/onramp/deposit-address`, `/onramp/onramper/session`); markup deferred to a later session to avoid racing the market-data work in `app.html` / `app-main.ts`.

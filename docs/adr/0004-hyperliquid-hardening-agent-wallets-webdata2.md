# ADR-0004: Hyperliquid hardening — agent wallets + webData2 streaming

## Status

Part 1 (agent wallets): **Accepted + implemented 2026-07-08** behind
`HL_AGENT_WALLETS=1` (default off) with option (a) — ephemeral per-process
unnamed agent, zero persistent key custody. Fail-open to master signing on
any approval failure. Audit trail in `nb_hl_agents` (migration 0033). Code:
`lib/markets/hl-agent.ts` + the L1 branch in `hl-signer.ts`; specs in
`hl-agent.spec.ts`. Flip the flag after one supervised live order confirms
the venue accepts the agent-signed action.

Part 2 (webData2 streaming): **Accepted + implemented 2026-07-08** behind
`HL_USER_STREAMS=1` (default off). `realtime/venues/hyperliquid-user.ts`
opens sharded upstream sockets (≤10 users per connection, ≤9 connections —
one slot reserved for the public-market adapter) subscribing `webData2` +
`userFills` per user and fanning out on `priv:<userId>:account` /
`priv:<userId>:fills` (hub demand via `registerPrivHook`; ACL unchanged at
the transports). The web client feature-detects by event arrival and
suppresses its 30s positions poll while the stream is fresh (<45s), so the
flag can be flipped off server-side with zero client change. Upstream
`orderUpdates` is deferred — our own order lifecycle already streams via the
in-process bridge. Flip the flag on one pod and confirm a supervised fill
reaches the UI in <2s before fleet-wide enable; the sandbox proxy blocks
`wss://api.hyperliquid.xyz`, so this live canary is the remaining
validation step.

## Date

2026-07-08

## Context

Two deviations from Hyperliquid's officially recommended integration pattern
remain after the 2026-07 overhaul:

### 1. All exchange writes sign with the user's master Privy wallet

Every `/exchange` action (orders, cancels, leverage, class transfers,
withdrawals) is EIP-712-signed directly by the user's Privy server wallet
(`hl-signer.ts`). Hyperliquid's nonce rules are per-signer: the chain stores
the 100 highest nonces per signer, and a new nonce must exceed the smallest
stored one and sit within (T−2 days, T+1 day) of block time. Our nonce
generator is a process-local monotonic counter (`hl-signer.ts:27-33`) —
under a multi-process deploy two processes signing for the same user race
the same signer's nonce window and produce intermittent
"nonce already used" rejections.

Hyperliquid's sanctioned fix is **agent (API) wallets** via the
`approveAgent` user-signed action: the master wallet registers an agent
pubkey; the agent may then sign L1 actions (trade-only — agents **cannot**
move funds; `usdSend`/`withdraw3`/`usdClassTransfer` stay master-signed) and
each agent has its own independent 100-nonce window. One agent per process
eliminates the race. Limits: 1 unnamed + up to 3 named agents per account,
named agents valid up to 180 days, re-approving a name replaces the old key.
Two footguns the implementation must encode: info endpoints must always be
queried with the MASTER address (agent addresses return empty data), and
user-signed fund-moving actions remain the master's domain.

### 2. Account state is polled, not streamed

Positions poll every 30s, balances every 5–15s. Hyperliquid's own frontend
subscribes to the `webData2` WebSocket stream (aggregate portfolio /
margin / positions per user), plus `orderUpdates` and `userFills`. WS caps:
10 connections, 1000 subscriptions, 10 unique users per connection across
user-specific subs, 2000 client→server msgs/min — so the design must be ONE
upstream connection multiplexed server-side through the existing realtime
hub (`apps/api/src/realtime/`), not per-client connections.

## Decision (proposed)

1. **Agent wallets**: generate one agent keypair per API process at boot,
   register via `approveBuilderFee`-style master-signed `approveAgent` on the
   user's first live action, store approved agent pubkeys + expiry in a new
   append-only `nb_hl_agents` table. L1 actions route through the process
   agent; user-signed fund moves keep the master path.
   **Open question blocking implementation — agent PRIVATE key custody**:
   (a) ephemeral in-memory per process (re-approve on restart; simplest,
   burns one approveAgent signature per boot), or (b) Privy-managed second
   wallet per user (no raw keys on our boxes, but per-user not per-process —
   doesn't fix the multi-process nonce race), or (c) KMS-encrypted at rest.
   Recommendation: (a) ephemeral per-process unnamed agent — zero persistent
   key custody, matches the per-process nonce isolation goal. Needs security
   sign-off because a compromised process can then trade (not withdraw) for
   any user that approved it.

2. **webData2 hub venue**: extend the realtime hub's HL venue
   (`realtime/venues/hyperliquid.ts`) with user-scoped `webData2` +
   `orderUpdates` + `userFills` subscriptions fanned out as `priv:*` topics
   (existing ACL grammar via `parsePrivTopic`), replacing the 30s positions
   poll and shortening the balance staleness window that produced the
   "insufficient balance" UX class of bugs. Respect the 10-unique-users cap
   per upstream connection by sharding connections.

## Consequences

- Eliminates the multi-process nonce collision class entirely.
- Reduces blast radius of a leaked signing credential from "can withdraw"
  to "can trade" for L1 actions.
- Removes ~2 req/s/user of steady-state polling against the 1200/min IP
  REST budget.
- Adds operational surface: agent expiry (180d) re-approval, WS connection
  sharding, reconciliation between streamed and REST state on reconnect.

## References

- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- Overhaul context: branch `claude/cash-transfer-trading-issues-jt8bqm` (2026-07).

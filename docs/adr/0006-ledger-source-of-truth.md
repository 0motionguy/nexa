# ADR-0006: Ledger source of truth — on-chain canonical, phased

## Status

Accepted (direction) 2026-07-08. Phase 1 shipped; Phases 2–3 are gated,
sequenced work items, not open questions.
Copy to the ecosystem control plane on next sync.

## Date

2026-07-08

## Context

NEXA has run two disjoint accounting worlds:

1. **Off-chain app ledger** (`nb_user_state.balUsd/eurUsd/earnUsd`) — gates
   send / swap / earn / **bank withdrawals** (`/bridge/withdraw` debits it).
   Historically seeded with a fake $4,820.40 / $3,200 for every user via
   column defaults.
2. **On-chain reality** — USDC across Base/Arbitrum/Polygon/Solana in the
   user's Privy wallets + Hyperliquid balances. Gates cross-chain transfers
   and trading.

They were never reconciled: a user could show a healthy app balance with an
empty wallet (or vice versa), and no endpoint could state total net worth.
This is untenable for a crypto-rails neobank whose actual custody IS the
on-chain wallets.

## Decision

**On-chain is canonical.** The app ledger becomes a derived view of real
custody, not an independent money supply. Phased:

- **Phase 1 — honesty (SHIPPED 2026-07)**: column defaults zeroed
  (migration 0031; demo seed is an explicit `DEMO_MODE` code path only);
  `/markets/portfolio/summary` exposes every leg including a labeled `cash`
  ledger leg; the wallet UI renders the ledger as its own line, never summed
  into on-chain totals.
- **Phase 2 — deposit reconciliation (NEXT)**: a worker credits the app
  ledger from observed on-chain deposits to the user's Base wallet
  (idempotency-keyed `nb_transactions` rows, `kind:'in'`, one per deposit
  tx hash — append-only). From this point the ledger can only contain money
  that verifiably arrived. Bank withdrawals then debit a balance that is
  backed 1:1.
- **Phase 3 — spendability flip**: send/swap/earn spendability checks read
  the reconciled figure (ledger row, now provably ≤ custody) with the
  on-chain read as the fail-closed cross-check. `balUsd` remains as the
  fast-path cache; discrepancies beyond an epsilon page reconciliation
  instead of silently choosing a side.

Rejected alternative: ledger-canonical ("classic neobank"). Right for fiat
core banking with a licensed custodian; wrong here — our custody is the
chain, and an authoritative ledger that can drift from it is how phantom
withdrawals happen.

## Consequences

- No user can ever spend or withdraw money the chain can't account for.
- Earn/eurUsd sub-balances stay ledger-tracked (they represent positions the
  chain mirror manages) but inherit Phase 2's "credited only from verified
  events" rule.
- Demo mode is unaffected — the in-memory store keeps its synthetic
  balances; production Postgres is where the invariant matters.

## References

- Migration 0031, `store/postgres/auth.ts` DEMO_MODE seed gate.
- `docs/CUSTODY-ANALYSIS.md`, `docs/NON-CUSTODIAL-PIVOT-PATH.md`.
- Overhaul branch `claude/cash-transfer-trading-issues-jt8bqm`.

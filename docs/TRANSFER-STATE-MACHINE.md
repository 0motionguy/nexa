# Transfer state machine

**2026-06-21 · Sprint 19 · Bridge worker state machine · Code-grounded.**

The cross-chain CCTP transfer lifecycle. Every `nb_transfers` row walks
this state machine; every transition writes a `nb_transfer_events` audit row.

Parent: [BRIDGING-ARCHITECTURE.md](BRIDGING-ARCHITECTURE.md). Related: [CCTP-WIRING.md](CCTP-WIRING.md).

---

## 1. State diagram

```
                   ┌────────────┐
                   │  created   │  ← POST /transfers/internal
                   └─────┬──────┘
                         │  executeCctpBurn
                         ▼
                   ┌────────────┐
                   │  burning   │  ← Alchemy preparedCall submitted to src chain
                   └─────┬──────┘
                         │  getCallStatus = CONFIRMED + extract MessageSent log
                         ▼
                   ┌────────────┐
                   │ attesting  │  ← Iris polled at 30s intervals
                   └─────┬──────┘
                         │  Iris status = complete
                         ▼
                   ┌────────────┐
                   │  minting   │  ← Alchemy preparedCall submitted to dst chain
                   └─────┬──────┘
                         │  getCallStatus = CONFIRMED
                         ▼
                   ┌────────────┐
                   │ depositing │  ← (round 1: no extra hop; marks complete)
                   └─────┬──────┘
                         │
                         ▼
                   ┌────────────┐
                   │  complete  │
                   └────────────┘

  Any state → failed   on terminal error (logged + row.error populated)
```

Code: [workers/bridge-worker.ts](../apps/api/src/workers/bridge-worker.ts).

---

## 2. State transitions in detail

| From | Trigger | Action | To | Re-enqueue delay |
|---|---|---|---|---|
| created | Job picked up | `executeCctpBurn` batches `USDC.approve` + `depositForBurn` via Alchemy. Returns Alchemy `callId`. | burning | 10s (await burn confirm) |
| burning | Burn tx CONFIRMED | Read receipt logs, extract `MessageSent(bytes)` body + hash. Persist both. | attesting | 30s (Iris typical sign time ~60-120s) |
| burning | Status PENDING | (no transition) | burning | 10s |
| burning | Status FAILED | failTransfer | failed | — |
| attesting | Iris pending | (no transition) | attesting | 30s, increment `attestationAttempts` |
| attesting | Iris complete | Persist attestation. Continue immediately. | minting | 0 |
| attesting | Iris failed | failTransfer | failed | — |
| attesting | `attestationAttempts >= 50` (~25 min) | failTransfer `attestation_timeout` | failed | — |
| minting | Job picked up | `executeCctpMint` submits `receiveMessage(message, attestation)` on dst chain | depositing | 10s |
| depositing | Mint tx CONFIRMED | Mark complete with dst tx hash | complete | — |
| depositing | Status PENDING | (no transition) | depositing | 10s |
| depositing | Status FAILED | failTransfer | failed | — |

All delays are defined in `DELAY` const in [bridge-worker.ts](../apps/api/src/workers/bridge-worker.ts).

---

## 3. Idempotency

The route layer (POST /transfers/internal) derives an idempotency key from `Idempotency-Key` header → request body → deterministic fallback `tr_{userId}_{from}_{to}_{amount}_{secondsTimestamp}`. The DB constraint `nb_transfers_user_idempotency_key_uq` enforces uniqueness; replay returns the same `tr_*` id without enqueueing a second job.

The worker is also idempotent at each state: re-enqueueing a job for a transfer already past the target state is a no-op (the switch matches the current status, not the requested one). Terminal states (`complete` | `failed`) return immediately.

---

## 4. Demo mode

When `features.alchemy === false` (no `ALCHEMY_API_KEY`):
- `executor.sendCalls` returns `{ txHash: '0xdemo<hex>', demo: true }`
- `executor.getCallStatus` short-circuits demo callIds to CONFIRMED with an empty receipt
- `extractMessageFromBurnReceipt` returns null on empty logs → worker synthesizes a placeholder message + hash so the rest of the machine can advance
- `fetchCctpAttestation` is NEVER called in demo (the worker checks `srcTxHash.startsWith('0xdemo')` and short-circuits)

End-to-end demo round-trip: ~20s total (5 ticks × 4s each in tests). Real-money: ~90s for Arbitrum ↔ Polygon.

---

## 5. Persistence + restart safety

Every transfer's state is in Postgres. On worker boot, [startBridgeWorker](../apps/api/src/workers/bridge-worker.ts) calls `transferStore.listMidFlight()` which selects every `nb_transfers` row whose status is in `{created, burning, attesting, minting, depositing}` and re-enqueues each one.

Worker restart cost: the in-flight `attestationAttempts` counter (job data only, not persisted) resets to 0. Net effect: a re-enqueue can extend an Iris timeout by up to MAX_ATTESTATION_ATTEMPTS × 30s = ~25 min once. Acceptable for round 1; future hardening could persist the counter in `nb_transfers.cctp_attestation_attempts`.

---

## 6. Observability

Per-state-change `nb_transfer_events` row with structured payload:

| eventType | payload shape |
|---|---|
| `created` | `{ rail, fromBucket, toBucket, amountUsd }` |
| `state_change` | `{ from, to, ...stateSpecificFields }` |
| `attestation_poll` | `{ attempt, status }` |
| `error` | `{ code, message?, ...context }` |

Query the timeline via `GET /transfers/:id` — the route returns `{ transfer, events }`. Sorted by `created_at ASC` so the audit reads top-to-bottom.

Prometheus gauges:
- `bullmq_queue_depth{queue="bridge-transfer", state="…"}` — wait/active/delayed/failed/completed
- `worker_heartbeat_seconds{worker="bridge-transfer"}` — last-tick unix seconds. Alert on `time() - worker_heartbeat_seconds > 60`.

---

## 7. Concurrency

`Worker` constructor takes `concurrency: 4` — one transfer per slot, each is mostly I/O-bound (chain RPC + Iris polls). Tune up if Redis queue depth grows; tune down if Privy rate-limits.

Per-user fairness is NOT enforced. A single user spamming /transfers/internal could saturate the 4 slots; mitigation is rate-limiting at the route layer (not yet implemented).

---

## 8. Adding a new rail

To plug a non-CCTP rail (e.g. Mayan, Socket, LIFI) into this state machine:

1. Add a new `rail` enum value to [store/transfers.ts:TransferRail](../apps/api/src/store/transfers.ts).
2. Update [routes/transfers.ts:pickRail](../apps/api/src/routes/transfers.ts) to route to the new rail when applicable.
3. Either:
   - **Single-shot rails (Mayan / Socket)**: handle inline in the route, mark `complete` immediately, don't enqueue.
   - **Multi-step rails**: add a new branch in `advanceTransfer` for `t.rail === 'mayan' && t.status === 'X'`. Implement the per-state advance functions. The state machine schema (`created → ... → complete | failed`) can stay the same; the rail decides what each transition does.

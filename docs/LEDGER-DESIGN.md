# NEXA Internal Ledger — Double-Entry Design (DB-P1-4)

**Status:** design accepted for Wave 3+ · shadow-write first
**Date:** 2026-07-15 audit remediation, wave-3 planning
**Audit refs:** DB-P1-4 (mutable balance is not a ledger), DB-P1-5 (JS float money math), DB-P2-2 (restore integrity checks)

## 1. Problem

Internal money truth today is a **mutable projection**:

```text
nb_user_state   current balances (bal_usd, eur_usd, sandbox_bal_usd, earn_usd — numeric(18,6))
nb_transactions user-visible activity rows
```

Nothing guarantees `sum(debits) = sum(credits)`. A partial write, a buggy
mutator, or an operator UPDATE can silently mint or destroy internal money,
and a backup restore has no invariant to verify against. Wave 2 removed the
worst float arithmetic and locked mutators behind `SELECT … FOR UPDATE`
transactions, but the accounting model itself remains assertion-free.

## 2. Scope

**In scope:** internal cash, earn, sandbox, agent balances; platform fees;
payouts/refunds; bridge in-flight legs (internal side).
**Out of scope:** externally custodied venue positions (Hyperliquid,
Polymarket) — those remain venue-truth mirrored into `nb_market_positions`;
the ledger only books their internal settlement legs (deposit out, proceeds
in, fees).

## 3. Target schema (migration `0037_ledger_journal`, Drizzle)

```sql
CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type  text NOT NULL CHECK (owner_type IN
                ('user','platform','venue_clearing','fee','bridge_inflight')),
  owner_id    uuid,                -- NULL for platform singletons
  bucket      text NOT NULL CHECK (bucket IN
                ('cash','eur','earn','sandbox','agent','fees','clearing')),
  currency    text NOT NULL DEFAULT 'USD',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, bucket, currency)
);

CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN
                    ('deposit','withdrawal','transfer','trade_settle',
                     'fee','refund','payout','adjustment')),
  external_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid   NOT NULL REFERENCES ledger_transactions(id),
  account_id     uuid   NOT NULL REFERENCES ledger_accounts(id),
  amount_micros  bigint NOT NULL CHECK (amount_micros <> 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_txn_idx     ON ledger_entries (transaction_id);
```

**Balance invariant:** per transaction, `SUM(amount_micros) = 0` (signed
entries; positive = debit, negative = credit — documented in schema.ts).

Enforcement: entries for one transaction are inserted in a single statement
(multi-row `INSERT … SELECT`), followed in the same DB transaction by

```sql
SELECT 1 FROM ledger_entries
WHERE transaction_id = $1
HAVING sum(amount_micros) <> 0;   -- any row → RAISE / rollback
```

wrapped in a `postLedgerTransaction()` helper that is the ONLY write path
(no direct table access from routes/workers). A `CONSTRAINT TRIGGER
DEFERRABLE INITIALLY DEFERRED` doing the same check is the belt-and-braces
follow-up once shadow-phase performance is measured.

## 4. Precision

`bigint` micro-USD (10⁻⁶) — exact, matches the existing `numeric(18,6)`
resolution, and eliminates the remaining `Number(numericMoney)` hazards
(DB-P1-5): business logic passes integer micros or strings, never floats.
Conversion helpers live beside the schema with property-based tests near
`2^53/10^6` boundaries.

## 5. `nb_user_state` becomes a projection

- Rebuild rule: `balance(bucket) = SUM(entries.amount_micros) / 10^6` over
  the owner's account.
- During cutover the projection is updated in the SAME transaction as the
  journal write (no read-path change, no dual-read complexity).
- Nightly reconciliation job: recompute per-account sums, diff against
  `nb_user_state`, emit `ledger_drift_micros` metric — any nonzero pages.

## 6. Rollout — three phases

| Phase | Flag | Behavior |
|---|---|---|
| 1 SHADOW | `LEDGER_SHADOW_WRITE=1` | Every money mutator, inside its existing `FOR UPDATE` transaction, also posts balanced journal rows. Reads untouched. Drift job reports only. Zero user-facing risk; rollback = flag off. |
| 2 VERIFY | flag stays on | ≥2 weeks zero-drift in staging + prod, load ladder (100→1,000) passes with shadow writes on. Perf budget: +1 multi-row insert per money mutation. |
| 3 CUTOVER | `LEDGER_AUTHORITATIVE=1` | Journal is truth; `nb_user_state` maintained as same-transaction projection; ad-hoc idempotency checks replaced by `ledger_transactions.idempotency_key`. |

## 7. What this buys (audit mapping)

- **DB-P1-4** — balanced double-entry journal for all internal money.
- **DB-P1-5** — integer-micros end of float money arithmetic.
- **DB-P2-2** — restore drills gain a real integrity check: per-txn zero-sum
  + projection match, runnable via one SQL block appended to
  `02_PRODUCTION_DB_READONLY_CHECK.sql`.
- Idempotency unified: one UNIQUE key for internal money instead of
  per-table conventions.

## 8. Non-goals

- Multi-currency accounting (column exists; only `USD` booked today).
- External venue position accounting (venue remains truth; we book legs).
- Event-sourcing the whole platform — this is money-only.

## 9. Open questions for founder review

1. Adjustment policy: who may post `kind='adjustment'` and with what audit
   trail (proposal: admin route + dual-log to `nb_audit_log`).
2. Retention: journal rows are append-only forever vs. archived after N
   years to cold storage (regulatory input needed).
3. Sandbox: book sandbox in the same journal (cheap, uniform) or exempt it
   (proposal: same journal, `bucket='sandbox'` — uniformity wins).

## 10. Effort estimate

- Migration + schema + `postLedgerTransaction()` + shadow wiring: ~1 lane-day.
- Reconciliation job + metrics + drift alert: ~0.5 lane-day.
- Cutover (after verify window): ~1 lane-day incl. removal of ad-hoc paths.

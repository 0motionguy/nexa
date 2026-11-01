# Onramp options

**2026-06-21 · Sprint 19 · Fiat → crypto entry surfaces · Code-grounded.**

NEXA exposes multiple onramp paths. They differ in KYC posture, payment
methods, and which chain the user lands on. This doc maps which onramp to
show under which conditions.

Parent: [BRIDGING-ARCHITECTURE.md](BRIDGING-ARCHITECTURE.md). Related: [PORTFOLIO-DATA-FLOW.md](PORTFOLIO-DATA-FLOW.md).

---

## 1. Per-provider matrix

| Provider | Path | Status | KYC posture | Payment methods | Lands on chain | NEXA-side custody? |
|---|---|---|---|---|---|---|
| **Stripe Crypto Onramp** | `POST /onramp/stripe/session` → hosted Stripe page | LIVE | Stripe handles all KYC at the user level; threshold-based. Apple Pay path is lowest friction. | Apple Pay, debit card, bank | base / ethereum / polygon / optimism / arbitrum (user's choice; we default to bucket-aware) | No — Stripe ships USDC directly to user's Privy wallet |
| **Onramper widget** (NEW) | `POST /onramp/onramper/session` → iframe URL → embed | LIVE behind `ONRAMPER_API_KEY`, demo sandbox otherwise | Smart-routes small-tx users to the lowest-KYC provider that fits the amount + region + payment method | 175+ via 30+ providers (MoonPay, Transak, Banxa, Ramp, etc.) | Any (NEXA pre-fills the destination address per bucket) | No — widget runs in browser, vendor settles directly to user's Privy wallet |
| **Bridge.xyz** | `POST /bridge/customer` + `/bridge/virtual-account` + `/bridge/withdraw` | LIVE behind `BRIDGE_API_KEY` + KYB approval | Full KYC + Bridge KYB approval before any rail works | ACH (US), SEPA (EU), wire | Base | **Yes** — Bridge custodies USD between deposit and NEXA-side crediting |
| **Receive (no onramp)** | `GET /transfers/onramp/deposit-address?bucket=…` | LIVE | None — just showing an address | (user sends from external wallet / CEX) | Per-bucket (perps→arbitrum, predictions→polygon, memes→solana, cash→base) | No — user controls the source |

---

## 2. Decision tree (recommend UI flow)

```
User opens Pay → Add money:
  ├─ Tab 1: Buy
  │    ├─ Card / Apple Pay (default — Stripe Crypto Onramp)
  │    └─ More options (Onramper widget; surfaces smart-routed providers)
  ├─ Tab 2: Transfer
  │    ├─ Between MAZE buckets (POST /transfers/internal)
  │    └─ From external wallet (shows the Receive addresses below)
  └─ Tab 3: Receive
       ├─ Solana USDC + SOL address     (bucket=memes)
       ├─ Arbitrum USDC address         (bucket=perps)
       ├─ Polygon USDC address          (bucket=predictions)
       └─ Base USDC address             (bucket=cash, default home)
```

This is the [Bullpen](https://bullpen.fi/) pattern. Mirrors what crypto traders already know.

---

## 3. Why Onramper specifically?

Two reasons we picked Onramper over going direct to MoonPay / Transak / Ramp:

1. **Smart routing** — Onramper's engine picks the lowest-KYC provider that supports the user's amount, region, and payment method. For small txs (<$200 in most regions), this often means the user completes a purchase WITHOUT signing up for an account anywhere.
2. **Single integration, 30+ vendors** — Adding a second vendor later is a widget config flip, not a new backend integration.

Onramper's [widget docs](https://docs.onramper.com/docs/widget) — embeddable iframe; pre-fill user wallet address per bucket; we never see funds.

---

## 4. Why NOT fun.xyz / FunKit?

- `@funkit/core` ([npm](https://www.npmjs.com/package/@funkit/core)) is **EVM-only** ("Each FunWallet exists on an EVM-compatible blockchain"). No Solana, which is one of our four buckets.
- `@funkit/connect` (the onramp piece) is **closed-beta**. Quote from the npm description: "This package is currently in closed beta. To learn more, reach out to developers@fun.xyz."
- NEXA already has Mayan ([lib/chain/mayan.ts](../apps/api/src/lib/chain/mayan.ts)) for Solana ↔ EVM, Socket + LI.FI for non-USDC EVM aggregation, and Stripe + Bridge for fiat. fun.xyz overlaps these without adding new coverage.

We use fun.xyz's ERC-4337 smart-wallet model + Bullpen's Buy/Transfer/Receive triad as UX references — not as integrations.

---

## 5. Sandbox vs production

| Provider | Sandbox indicator | Production switch |
|---|---|---|
| Stripe Crypto Onramp | `STRIPE_SECRET_KEY=sk_test_…` | swap to `sk_live_…` |
| Onramper | no `ONRAMPER_API_KEY` → `buy-sandbox.onramper.com` iframe | set `ONRAMPER_API_KEY` → `buy.onramper.com` |
| Bridge.xyz | `BRIDGE_API_BASE` points at sandbox; KYB unapproved | KYB approval flips the apex DNS to prod base |

When all three are in sandbox, the `/onramp/*/status` routes return `available: false` with a `provider_demo` sourced envelope so the frontend can render a "Coming soon" affordance per provider.

---

## 6. Compliance posture

NEXA does **not** perform any KYC itself for the onramp path. KYC is owned by the vendor handling the payment (Stripe, the Onramper-routed provider, or Bridge). NEXA's only compliance obligation here is to validate the destination address and surface vendor-imposed limits truthfully.

The vendor → NEXA settlement flow:
1. User pays vendor
2. Vendor delivers USDC on-chain to user's Privy wallet (Stripe / Onramper) OR to NEXA's omnibus then credits the ledger (Bridge)
3. NEXA picks up the deposit via webhook → `store.topUp(user, amountUsd, label)`

The Bridge path is the only one that creates an obligation on NEXA's side (NEXA holds the user's USD between Bridge crediting and on-chain delivery). The Stripe + Onramper paths route around this entirely — funds never sit in a NEXA-controlled account.

---

## 7. Future additions (not in this round)

- **Coinbase OAuth** — pull USDC from a Coinbase account via OAuth. Free, well-documented API. Lowest-friction path for the US user who already has Coinbase.
- **Kraken / Binance Connect** — regional. Add as cohort-gated options.
- **WalletConnect v2** — connect MetaMask / Phantom / Rainbow as source. Same outcome as Receive but with a UX prompt that does the send for the user.
- **Onramper transaction-creation API** (`/v3/transactions`) — round 1 only generates iframe URLs. Adding the server-side transaction creation gives us full lifecycle visibility (status webhooks, refund handling).

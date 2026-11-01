# ADR-0005: CCTP V1 → V2 migration behind `CCTP_V2` env flag

## Status

Accepted (implementation shipped 2026-07-08, flag default OFF; production
cutover pending a supervised live transfer).
Copy to the ecosystem control plane (`aiso-ecosystem/contracts` /ADR store)
on next sync — same rail (Circle CCTP), new protocol version, so this is a
version upgrade rather than a new payment rail, but it changes on-chain
contracts and the attestation API, and V2's Solana support may later
displace Mayan for USDC legs (that displacement would be a separate
routing-policy ADR).

## Date

2026-07-08

## Context

- Our bridge worker executes CCTP **V1** (per-chain TokenMessenger /
  MessageTransmitter, iris `/attestations/{messageHash}`).
- Circle announced (2025-11-14) that V2 is canonical; V1 is "Legacy" with
  **manual phase-out commencing 2026-07-31** and full contract pause at the
  end of a ~10-month deprecation period (no exact sunset date published yet).
- V2 additionally offers **Fast Transfer** (attested at soft finality,
  seconds instead of minutes, fee 0–14 bps by source chain) and Hooks.

## Decision

Implement V2 alongside V1 in `lib/chain/cctp.ts` (append-only — V1 functions
untouched), cut over per-transfer via `CCTP_V2=1`:

- **Contracts** (same address on every EVM chain, CREATE2):
  TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`,
  MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`.
  Verified against `circlefin/evm-cctp-contracts` source + explorer labels
  on arbitrum/base/optimism/polygon; pinned in `cctp.spec.ts`.
- **Burn**: `depositForBurn(amount, destDomain, mintRecipient, burnToken,
  destinationCaller=0, maxFee, minFinalityThreshold)`. Fast (threshold 1000)
  when `GET /v2/burn/USDC/fees/{src}/{dst}` quotes a fee — maxFee = quote ×
  amount × 1.2 buffer (Circle's own sample-app buffer); otherwise Standard
  (threshold 2000, maxFee 0, free). Never guess a fee: quote failure ⇒
  Standard.
- **Attestation**: `GET /v2/messages/{srcDomain}?transactionHash=…` keyed by
  the burn tx hash (no MessageSent log extraction). 404/5xx/429 classify as
  pending, same taxonomy as the hardened V1 poller.
- **Mint**: same `receiveMessage(bytes,bytes)` selector, V2 transmitter
  address; the existing calldata builder is reused.
- **Version stickiness**: `nb_transfers.cctp_version` (migration 0032,
  append-only ADD COLUMN) is persisted at burn-submit time; the attest and
  mint hops follow the version of the burn, so flipping the flag mid-flight
  cannot misroute an in-flight transfer.
- Domain ids unchanged from V1 (arb 3 / base 6 / op 2 / polygon 7).

## Cutover plan

1. Deploy with `CCTP_V2` unset (V1 behavior, byte-identical path).
2. On the VPS: `CCTP_V2=1`, then run one supervised $5 cash→predictions
   transfer; watch `state_change` events for `cctpVersion: 2` and
   `cctpV2Mode` (expect `fast` on base→polygon).
3. If Fast mints in seconds and the ladder completes, leave the flag on.
   In-flight V1 transfers finish on V1 automatically.
4. Before Circle's full V1 pause: remove the flag and make V2 the only path
   (follow-up PR; keep V1 code until then for the manual-reconciliation
   window Circle promised for pending V1 attestations).

## Consequences

- Cross-chain EVM transfers drop from ~90s to seconds when Fast is used, at
  0–14 bps (surfaced via the transfer's fee fields; the NEO_BRIDGE_FEE_BPS
  treasury skim is unchanged and independent).
- One new nullable column on `nb_transfers`; no destructive schema change.
- Solana (Mayan) legs unchanged — V2-Solana adoption is a separate decision.

## References

- https://www.circle.com/blog/cctp-version-updates (deprecation timeline)
- https://developers.circle.com/cctp/evm-smart-contracts (address table —
  re-verify once from an unproxied network; our sandbox could only confirm
  via the contracts repo + explorers)
- https://developers.circle.com/cctp/cctp-finality-and-fees
- https://github.com/circlefin/evm-cctp-contracts (`src/v2/TokenMessengerV2.sol`,
  `src/v2/FinalityThresholds.sol`)

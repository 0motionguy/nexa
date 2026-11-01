# CCTP wiring

**2026-06-21 · Sprint 19 · Circle Cross-Chain Transfer Protocol V1 · Code-grounded.**

This doc tracks NEXA's Circle CCTP V1 execute path — the rail behind every
Arbitrum ↔ Polygon / Base / Optimism USDC transfer in the Portfolio.

Parent: [BRIDGING-ARCHITECTURE.md](BRIDGING-ARCHITECTURE.md). Related: [TRANSFER-STATE-MACHINE.md](TRANSFER-STATE-MACHINE.md).

---

## 1. Protocol summary

CCTP is **native USDC burn-and-mint**:

1. **Burn** on source chain — `TokenMessenger.depositForBurn(amount, destDomain, mintRecipient, USDC)` burns the user's USDC and emits a `MessageSent(bytes message)` event.
2. **Attest** — Circle's Iris service watches the source chain, signs the message hash, exposes the attestation via `GET https://iris-api.circle.com/v1/messages/{srcDomain}/{txHash}` (also at `/attestations/{messageHash}`).
3. **Mint** on destination — `MessageTransmitter.receiveMessage(message, attestation)` mints native USDC to `mintRecipient`.

No slippage (1:1 redemption). Circle's protocol fee on V1 public deployment is **0 today**. Wall-clock: 60-120s for Arbitrum/Polygon/Base/Optimism.

References:
- https://developers.circle.com/cctp
- https://developers.circle.com/cctp/v2-vs-v1
- https://developers.circle.com/cctp/evm-smart-contracts

---

## 2. Domain registry

CCTP keys each chain by a numeric "domain":

| Chain | Domain |
|---|---|
| Ethereum | 0 |
| Avalanche | 1 |
| Optimism | 2 |
| Arbitrum | 3 |
| Base | 6 |
| Polygon PoS | 7 |
| Solana | 5 |

NEXA exports the EVM subset in [lib/chain/cctp.ts:CCTP_DOMAIN](../apps/api/src/lib/chain/cctp.ts).

---

## 3. Contract registry (V1)

| Chain | TokenMessenger (burn entrypoint) | MessageTransmitter (mint entrypoint) | Native USDC |
|---|---|---|---|
| Arbitrum | `0x19330d10D9Cc8751218eaf51E8885D058642E08A` | `0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Polygon | `0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE` | `0xF3be9355363857F3e001be68856A2f96b4C39Ba9` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| Base | `0x1682Ae6375C4E4A97e4B583BC394c861A46D8962` | `0xAD09780d193884d503182aD4588450C416D6F9D4` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Optimism | `0x2B4069517957735bE00ceE0fadAE88a26365528f` | `0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |

Code: [lib/chain/cctp.ts:CCTP_TOKEN_MESSENGER / CCTP_MESSAGE_TRANSMITTER / USDC_BY_CHAIN](../apps/api/src/lib/chain/cctp.ts).

---

## 4. Calldata layouts

### `depositForBurn(uint256, uint32, bytes32, address)`

Function signature → selector `0x6fd3504e`. Encoded via viem's `encodeFunctionData` in [lib/chain/cctp.ts:buildDepositForBurnCalldata](../apps/api/src/lib/chain/cctp.ts).

| Arg | Encoding |
|---|---|
| `amount` | uint256, USDC atoms (6 decimals — e.g. 5 USDC = 5000000) |
| `destinationDomain` | uint32, per the table above |
| `mintRecipient` | bytes32 — for EVM, left-pad the 20-byte address with 12 zero bytes; for Solana, the 32-byte SPL recipient pubkey |
| `burnToken` | address — native USDC on source chain |

Helper `addressToBytes32` does the EVM padding. Before depositForBurn the user must approve the TokenMessenger to spend USDC; NEXA batches `USDC.approve(messenger, amount)` + `depositForBurn` in a single Alchemy 7702 user-op.

### `receiveMessage(bytes message, bytes attestation)`

Function signature → selector `0x57ecfd28`. Two dynamic `bytes` args; manually-encoded in [lib/chain/cctp.ts:buildReceiveMessageCalldata](../apps/api/src/lib/chain/cctp.ts) (the inline encoder predates the viem-based depositForBurn builder).

| | Length |
|---|---|
| selector | 4 bytes |
| message offset | 32 bytes (always `0x40`) |
| attestation offset | 32 bytes (depends on message length) |
| message tail | 32 (length) + ceil(len, 32) (padded data) |
| attestation tail | 32 (length) + ceil(len, 32) (padded data) |

Pure function — no signing involved. Caller submits via the Alchemy executor.

---

## 5. Iris attestation flow

`fetchCctpAttestation(messageHash)` snapshots Iris once; `pollCctpAttestation(messageHash)` retries with exponential backoff. Both in [lib/chain/cctp.ts](../apps/api/src/lib/chain/cctp.ts).

| Iris response | Treated as |
|---|---|
| 200 with `status: complete` | **complete** — attestation + message bytes in body |
| 200 with `status: pending` | **pending** — keep polling |
| 404 | **pending** — burn not propagated yet |
| 429 / 5xx | **pending** — transient, don't kill the transfer |
| 4xx ≠ 404 | **failed** — terminal |
| Network error / abort | **pending** (logged warn) |

Sprint 16.3 hardened the classification so a single transient 5xx doesn't kill a 5-min poll. See cctp.ts:125-165 comments.

---

## 6. Message extraction from burn receipt

After the burn tx confirms, the worker reads `transactionHash` from `wallet_getCallsStatus`, fetches the receipt logs, and finds the `MessageSent(bytes)` event:

- **Emitter**: the source chain's `MessageTransmitter` (NOT the TokenMessenger)
- **topic0**: `keccak256("MessageSent(bytes)")` = `0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036`
- **data**: ABI-encoded `bytes message` — 32B offset, 32B length, padded data

[lib/chain/cctp.ts:extractMessageFromBurnReceipt](../apps/api/src/lib/chain/cctp.ts) decodes the inner message bytes verbatim (Iris signs over EXACTLY these bytes — any padding or truncation breaks the attestation match).

`messageHash` = `keccak256(messageBody)`. Both are persisted in `nb_transfers.cctp_message_body` and `cctp_message_hash` so a worker restart between attest and mint doesn't lose state.

---

## 7. End-to-end execute flow

```
1. POST /transfers/internal      → routes/transfers.ts
2. transferStore.create          → INSERT nb_transfers row
3. enqueueTransferProgress(id)   → BullMQ "bridge-transfer.progress"
4. Worker advances:
   created  →  executeCctpBurn   (approve + depositForBurn batched)   →  burning
   burning  →  getCallStatus (Alchemy) + extract MessageSent           →  attesting
   attest   →  fetchCctpAttestation (Iris)                             →  minting
   minting  →  executeCctpMint  (receiveMessage)                       →  depositing
   deposit  →  getCallStatus (dst chain)                                →  complete
```

Each transition writes a row to `nb_transfer_events`. See [TRANSFER-STATE-MACHINE.md](TRANSFER-STATE-MACHINE.md) for delay constants and failure handling.

---

## 8. What V1 doesn't do (deferred to V2)

- **Fast finality** — V1 always waits for source chain finality (Arbitrum ~10s, Polygon ~30s, Base ~10s). V2 has an opt-in fast-finality lane.
- **Hooks** (`depositForBurnWithCaller`) — V2 lets you call an arbitrary contract on the destination after mint (e.g. auto-deposit into Aave). V1 mints to the recipient address and stops.
- **Solana native** — V2's Solana program (`CCTPv2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`) is supported via Mayan today instead, since Mayan already wraps the same Circle attestation.

Migration path to V2: replace `CCTP_TOKEN_MESSENGER` addresses + add `depositForBurnWithCaller` calldata builder. The state machine in [TRANSFER-STATE-MACHINE.md](TRANSFER-STATE-MACHINE.md) doesn't need to change.

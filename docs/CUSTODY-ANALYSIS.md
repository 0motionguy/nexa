# MAZE — Per-surface custody analysis

**2026-06-15 · Architecture analyst snapshot · Code-grounded · NO code changes.**
**2026-06-19 — Sprint 17 Phase E addendum:** Privy server-wallet signing model section added (§1.1).

Scaffold source: `HANDOVER-FULL.md` §2 (lines 29–99). This doc goes deeper
than the handover by citing the exact files and lines where custody
crystallizes today, so a future reviewer can verify every claim by reading
the code.

---

## 1.1 Privy server-wallet signing model (added 2026-06-19)

This section was added as part of the Sprint 17 Phase E protocol-audit closeout to address a recurring question from testers: "When I place a trade, does Privy ask me to confirm?"

### Short answer

**No.** Every signature signs server-side via Privy's REST API without user interaction.

### What we use

We use Privy **server wallets**, NOT browser-embedded wallets. Implications:

| | Embedded wallet (MetaMask-like) | Server wallet (what we use) |
|---|---|---|
| Where keys live | User's device | Privy HSM (cloud) |
| Who calls sign | Frontend → user clicks | MAZE backend → Privy REST API |
| Per-tx popup | Yes — user confirms each | **No — signed silently** |
| User consent | Per-action | One-time at sign-in |

### The flow when a tester clicks "Place $5 YES" on Polymarket

```
tester clicks button (frontend)
    ↓
MAZE backend (apps/api/src/routes/markets.ts) builds EIP-712 Order typed data
    ↓
backend calls Privy walletApi.ethereum.signTypedData({walletId, typedData})
    ↓
Privy signs server-side — no popup, no user interaction — returns signature
    ↓
backend wraps with L2 HMAC headers (apps/api/src/lib/markets/pm-clob.ts)
    ↓
backend POSTs to clob.polymarket.com/order
    ↓
Polymarket confirms → backend mirrors to nb_market_positions
    ↓
tester sees position appear (no confirmation step ever popped)
```

Same shape for Hyperliquid orders, x402 settlement, Marinade stake/instant unstake, and Mayan Solana swap execution. These write paths use Privy-backed server-wallet signing without a browser wallet popup.

### The trust model

- **Tester trusts MAZE** not to place trades they didn't initiate from the UI.
- **MAZE trusts Privy** to custody the key in their HSM (Privy is SOC 2; keys never leave).
- The tester does NOT have the private key in their browser. They cannot import to MetaMask.

### What safety nets we have (route layer)

- Geo block (HTTP 451) for HL + PM in 13 blocked countries — [routes/markets.ts](../apps/api/src/routes/markets.ts)
- Trading is not KYC-gated; live writes still require region eligibility, an idempotency key, and an unfrozen account
- Per-order idempotency key
- Per-user `killSwitch` on `nb_user_state`
- `/admin/withdraw-all` force-recovery (Base USDC + Solana SOL) — [routes/admin.ts](../apps/api/src/routes/admin.ts)
- Hyperliquid builder-fee approval is backend-managed: NEXA completes the one-time `approveBuilderFee` agreement at account setup or first live HL action and persists `nb_users.hl_builder_max_fee_tenths_bp`.

### What we do NOT have

- **No per-trade confirmation popup.** Adding a "review window" UI would be a 3-second countdown over the server-wallet model, not a real key-side prompt. See [HANDOVER-2026-06-19.md UX-09](../HANDOVER-2026-06-19.md#part-5--deep-improvement-catalog).
- **No daily caps per tester.** Considered in [HANDOVER-2026-06-19.md SEC-10](../HANDOVER-2026-06-19.md#part-5--deep-improvement-catalog).
- **No per-trade fee prompt.** Hyperliquid builder approval is a backend-managed one-time agreement, not a user-facing order-time approval sheet.

### Where this fits in the custody spectrum

This is the **semi-custodial** position described in §1 below. Tester onboarding messaging should be explicit: "MAZE manages your keys via Privy; you bring crypto, not keys. If you want self-custody with per-trade confirmation, use an external wallet directly with each venue — this product is not for that case."

---

## 1. Executive summary

MAZE today is **semi-custodial** by construction. The single biggest reason
is the `nb_user_state.balUsd` / `earnUsd` Postgres ledger
(`store/postgres/ledger.ts`), where every money-touching route mutates a
DB row inside a transaction and only **optionally** fires a fire-and-forget
chain mirror after commit (`lib/chain/chain-mirror.ts:53–66`). The ledger
is the source of truth; the chain is best-effort.

Privy server wallets are hardcoded as the wallet provider at three
distinct seams (`lib/privy.ts:21–24`, `lib/chain/wallet.ts:78`,
`lib/chain/privy-agent-wallet.ts:21–23`), and are reachable only behind
the `features.privy` boolean (`lib/env.ts:214`). Because Privy holds the
signing key in a TEE under a `did` owned by the human, the legal-custody
position is defensible-as-self-custody but the architectural position is
"MAZE composes and submits, the user is the principal." That gap is the
semi-custodial line.

The achievable non-custodial path is **mostly** clean: Receive, Send, Earn,
Card (Gnosis), Onramp, Offramp, x402 settlement, and Agent wallets can all
be flipped to read-and-relay against on-chain state with no MAZE-owned
balance row. Two surfaces stay semi-custodial **by physics**: the 30-day
email-claim escrow and any non-Gnosis card path (US debit issuers require
issuer custody). The deferral decision is a product call, not a technical
one — the rebuild surface for "fully non-custodial" is bounded but real.

---

## 2. Per-surface custody table

| Surface | Today's posture | Files / decision points | Hardcoded vs abstracted | Achievable target | Effort to switch |
|---|---|---|---|---|---|
| Receive USDC | **non-custodial** | `lib/chain/wallet.ts:81–97`, `lib/privy.ts:62–85` | Privy provider hardcoded; wallet itself is on-chain | non-custodial ✅ | none (already there) |
| Send USDC | **semi-custodial** | `routes/payments.ts:46–66`, `store/postgres/ledger.ts:61–103` | Ledger debit before claim; no chain transfer signed | non-custodial (direct USDC transfer) | M (2–3 wk) |
| Earn (Morpho / Aave / yoUSD) | **semi-custodial** | `routes/earn.ts:55–89`, `store/postgres/ledger.ts:157–194`, `lib/chain/chain-mirror.ts:53–66` | `state.earnUsd` is ledger truth; chain mirror is best-effort | non-custodial (user holds vault shares) | M (2–4 wk) |
| Card — Gnosis Pay | **semi-custodial** | `routes/card.ts:54–93`, `lib/chain/gnosisPay.ts:109–136` | MAZE's userId seeds Safe CREATE2 salt; executor signs deploy | non-custodial (user signs Safe deploy) | M (3–4 wk) |
| Card — US debit (Sponge) | **custodial-by-issuer** | `lib/chain/sponge.ts:52–88`, `routes/agent.ts` (createAgentCard surface) | Sponge issues card under MAZE's API key | custodial — unavoidable | not changeable |
| Onramp (fiat → USDC) | **custodial** | `routes/bridge.ts:34–80`, `lib/chain/bridge.ts:76–101` | Bridge KYB on MAZE; virtual accounts in MAZE's name | non-custodial via widget (Ramp / MoonPay / Stripe Crypto) | L (4–6 wk) |
| Offramp (USDC → fiat) | **custodial** | `routes/bridge.ts:137–234`, `store/postgres/ledger.ts:69–98` | Bridge transfer reserved + ledger-debited inside the same DB tx | non-custodial via widget (same vendors) | L (4–6 wk) |
| x402 agent settlement | **semi-custodial** | `routes/x402.ts:32–137`, `lib/chain/x402.ts:71–168` | EIP-3009 signed by Privy on behalf of agent wallet | non-custodial (EIP-3009 abstraction already supports it) | S (~1 wk to remove ledger fallback) |
| Email-claim escrow | **custodial 30-day** | `routes/claim.ts:20–48`, `store/postgres/claims.ts:33–58`, `lib/chain/privy-claim.ts` | Pregenerated Privy wallet keyed to email; MAZE holds funds 30 days | non-custodial via on-chain escrow contract | L (4–8 wk, contract audit) |
| Subscription renewal | **custodial cron** | `workers/subscription-renewer.ts` (see Glob), `store/types.ts:670–671` | `renewSubscription` writes ledger inside MAZE-owned cron | non-custodial via EIP-2612 permits / session keys | M (3–5 wk) |
| Cross-chain bridge (Base→Gnosis) | **semi-custodial** | `routes/card.ts:71–84`, `lib/chain/socket.ts`, `lib/chain/lifi.ts` | MAZE's executor signs UserOp; bridge contract is on-chain | non-custodial (user signs bridge, 7702 batched) | S (~1 wk) |
| Agent wallets (Privy) | **semi-custodial (TEE-custodied)** | `lib/chain/wallet.ts:100–178`, `lib/chain/privy-agent-wallet.ts:25–42` | Per-agent Privy wallet, owned by human's `did` | non-custodial (Privy is TEE; tighten policy gate) | S (~1 wk) |

---

## 3. Code seam map — where custody crystallizes

These are the specific points where the custody decision is encoded. Each
is what would change in an Option-A pivot.

### 3.1 `lib/chain/wallet.ts:81–97` — `getOrCreateUserWallet` always Privy

```ts
async getOrCreateUserWallet(userId, privyDid): Promise<WalletHandle> {
  if (!features.privy || !privyDid) {
    return mockHandle('user_' + userId);
  }
  const wallet = await getOrCreatePrivyWallet(privyDid, 'base');
  if (!wallet) {
    throw new ChainError('wallet_missing', 'failed to provision Privy wallet for user');
  }
  return { address, walletId, live: true, async signTypedData(typedData) { ... } };
}
```

**This is the hardcoded custody assumption.** The only branching is
"Privy on or off" — there is no `WalletProvider` interface that the user
could plug a self-custodied wallet (MetaMask, WalletConnect, Rainbow,
Coinbase Wallet) into. The signature path goes through
`signTypedDataWithPrivy` (`lib/privy.ts:88–100`), which calls
`client.walletApi.ethereum.signTypedData({ walletId, ... })`. The walletId
lives on Privy; MAZE is the one talking to Privy. In legal terms the user
owns the `did`, but in code terms there is no escape hatch where the
signature originates client-side.

### 3.2 `lib/chain/privy-agent-wallet.ts:21–23` — Privy client is module-level

```ts
let client: PrivyClient | null = null;
if (features.privy && env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
  client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
}
```

**This is the hardcoded provider.** The same shape appears in
`lib/privy.ts:21–24`. There is no `interface WalletProvider`, no factory,
no `wallets/index.ts` dispatcher. Swapping Privy for another TEE
(Turnkey, Capsule, Lit) or for a true client-side WalletConnect path
requires touching every `signTypedDataWithPrivy` / `signRawWithPrivy`
call site (4 references across `lib/chain/x402.ts`, `lib/chain/alchemy.ts`
and `lib/chain/wallet.ts`). This is the abstraction debt to repay before
Option A.

### 3.3 `store/postgres/ledger.ts:61–103` — `send` mutates `balUsd` first

```ts
async send(u: User, amountUsd: number, to: string): Promise<SendResult> {
  if (!(amountUsd >= 1)) throw new PolicyError('insufficient_funds', 'Minimum send is $1.');
  await this.autoDivestIfNeeded(u, amountUsd);
  const claim = to.includes('@');
  await this.db.transaction(async (tx) => {
    const state = await this.core.lockUserState(tx, u.id);
    if (amountUsd > state.balUsd)
      throw new PolicyError('insufficient_funds', 'Not enough balance.');
    state.balUsd -= amountUsd;            // ← the custody mutation
    await this.core.writeUserState(tx, u.id, state);
    ...
  });
  ...
}
```

**This is the hardcoded custody mutation.** Note: no chain transfer is
signed for a peer-to-peer send today. The ledger debit IS the send. The
recipient is either a MAZE user (their `balUsd` rises via `claimFunds` or
direct credit) or an email claim (parked in escrow). A non-custodial send
would replace `state.balUsd -= amountUsd` with a USDC `transfer(to,
amount)` signed by the user's wallet handle and submitted via Alchemy's
batch executor. The `lockUserState` / `writeUserState` pair would either
disappear or shrink to "verify pre-balance, observe post-balance."

### 3.4 `store/postgres/ledger.ts:157–194` — `earnDeposit` is ledger-first, chain-best-effort

```ts
async earnDeposit(u: User, amountUsd: number): Promise<void> {
  ...
  await this.db.transaction(async (tx) => {
    const state = await this.core.lockUserState(tx, u.id);
    state.balUsd -= amountUsd;
    state.earnUsd += amountUsd;
    await this.core.writeUserState(tx, u.id, state);
    ...
  });
  ...
  void this.chainMirror?.depositEarn(u, amountUsd, u.preferredVaultTier);  // ← fire-and-forget
}
```

**This is the hardcoded custody assumption for Earn.** The transaction
mutates the ledger; the chain mirror runs after commit and is allowed to
fail silently (`lib/chain/chain-mirror.ts:58–66` swallows errors and bumps
a Prom counter). A non-custodial Earn would invert this: user signs a
Morpho/Aave deposit, MAZE submits via Alchemy's 7702 executor
(`lib/chain/alchemy.ts:20–47`), and `state.earnUsd` either disappears or
becomes a cached read of the user's vault-share balance reconciled by a
worker.

### 3.5 `routes/offers.ts:271–301` — `bank_topup` provisions Bridge VA on buyer

```ts
if (method === 'bank_topup') {
  ...
  try {
    const customer = await bridgeCreateCustomer({ email: buyerEmail, name: buyerEmail });
    const va = await bridgeCreateVirtualAccount(customer.customerId, 'USD');
    return c.json({
      ok: true,
      method: 'bank_topup' as const,
      amountUsd: offer.amountUsd,
      accountNumber: va.accountNumber,
      routingNumber: va.routingNumber,
      ...
      note: 'Wire the offer amount from your bank to this account. We credit on receipt (typically 1–3 business days for ACH).',
    });
  } catch (e) { ... }
}
```

**This is the hardcoded custody assumption for fiat onramp.** Bridge is
the KYB perimeter and the issuer of the virtual ACH/SEPA account — the
account is in MAZE's name (or the buyer's, KYC'd by Bridge under MAZE's
KYB). The deposit webhook (`routes/bridge.ts:238–256`) then writes
`applyBridgeDeposit` to `balUsd`. A non-custodial onramp would hand the
buyer to a widget (Ramp / MoonPay / Stripe Crypto) where the vendor does
KYC, the buyer receives USDC directly to their own address, and MAZE never
mints a virtual account.

### 3.6 `routes/claim.ts:20–48` + `store/postgres/claims.ts:33–58` — 30-day MAZE-held escrow

```ts
// routes/claim.ts:37–48
claimRoutes.post('/:slug',
  zValidator('json', z.object({ email: z.string().email() })),
  async (c) => {
    const res = await store.claimFunds(c.req.param('slug'), c.req.valid('json').email);
    if (!res) throw ApiError.conflict('unavailable');
    claimsClaimed.inc();
    return c.json({ ok: true, amountUsd: res.amountUsd });
  },
);
```

```ts
// store/postgres/claims.ts:33–58
async recordClaim(u: User, email: string, amountUsd: number): Promise<ClaimRecord> {
  // send() already debited the sender — we only park the escrow row here.
  const walletAddress = await createPregeneratedWallet(email);
  ...
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const [row] = await this.db.insert(nbClaimWallets).values({ ... status: 'pending' ... }).returning();
  return claimFromRow(row!);
}
```

**This is the hardcoded custody assumption for email-claim escrow.** The
sender's `balUsd` was already debited inside `send()`; the escrow row
parks the amount in MAZE's ledger for 30 days. `claim-sweeper.ts` refunds
the sender if expired. A non-custodial equivalent would deposit the
amount into an on-chain escrow contract (e.g. an ERC-1271 contract that
releases on signed claim by the recipient's first wallet, or refunds
after `expiresAt`) — MAZE would be the relayer, not the custodian. The
pregenerated Privy wallet idea
(`lib/chain/privy-claim.ts:createPregeneratedWallet`) already provides
the receiving address; the gap is that funds currently sit in MAZE's
ledger, not at that address.

### 3.7 `routes/x402.ts:53–87` — settlement already abstraction-ready

```ts
const stack = getChainStack();
if (stack.x402.isLive && stack.wallets.isLive()) {
  try {
    const agentObj = await store.agent(u, agent);
    const wallet = await stack.wallets.getOrCreateAgentWallet(u.id, null, agentObj.id, agentObj.name);
    const payee = await resolvePayeeAddress({ endpoint, fallbackAddress: wallet.address });
    const signed = await stack.x402.signTransferAuth(
      wallet.address,
      payee.address as `0x${string}`,
      amountUsd,
      'USDC',
      wallet,
    );
    if (signed) {
      const result = await stack.x402.settleViaCoinbase(signed);
      c.header('X-PAYMENT', stack.x402.buildXPaymentHeader(signed));
      ...
      return c.json({ ok: true, receipt: { ...receipt, ref: result.txHash, settlement: result } });
    }
  } catch (e) { ... /* logs, demo fallback */ }
}
```

**This is the surface closest to non-custodial today.** EIP-3009
`transferWithAuthorization` is signed by the agent wallet handle and
submitted to the Coinbase facilitator — no MAZE-held balance moves in
the chain path. The semi-custodial bit is that `store.x402Pay` is
called BEFORE the chain attempt (line 49) and writes a ledger debit that
the chain settlement then mirrors. Option A here is the smallest lift:
make the ledger row a post-settlement observation, not a pre-condition.

---

## 4. Surfaces that stay semi-custodial by physics

### 4.1 US debit cards (Sponge / any non-Gnosis issuer)

Card issuers (Sponge, Stripe Issuing, Marqeta, Lithic) settle merchant
authorizations against a balance the issuer can debit on demand. There is
no "the user's on-chain wallet is the funding source" path that current
card networks accept — the issuer must custody float to settle Visa/MC
authorization messages within seconds. `lib/chain/sponge.ts:52–88`
provisions the card under MAZE's `SPONGE_API_KEY`; the float for that
card has to sit somewhere the issuer controls. **This cannot move
non-custodial without re-architecting the card-network rails themselves.**
Gnosis Pay is the exception precisely because it routes authorizations
through a user-owned Safe on Gnosis Chain, which IS user-custodied.

### 4.2 Email-claim 30-day holding window

The point of email-claim send is that the recipient has no wallet, no
account, no `did`. To make this truly non-custodial you'd need either:
(a) an on-chain escrow contract where MAZE has no withdraw key (the
contract releases on a recipient-signature gate), or (b) push the
escrow off-chain to a multisig (still semi-custodial). Option (a) is
buildable but requires a contract audit and adds an `expiresAt` check to
the contract rather than the cron. The 30-day window itself isn't the
custody — it's MAZE's role as custodian DURING the window that is.

### 4.3 Subscription renewal cron

`workers/subscription-renewer.ts` calls `store.renewSubscription` for
each active subscription past `currentPeriodEnd`. The renewal credits the
seller and debits the buyer inside a DB transaction. Going non-custodial
means moving to EIP-2612 permits (signed at first checkout, replayable
within their `deadline`) or to session keys (EIP-4337 / 7702 delegations
with spend caps). Both require ongoing buyer-side signing infrastructure
to extend authorizations as they expire — not insurmountable, but a
real UX surface that doesn't exist today.

---

## 5. Surfaces already non-custodial-friendly

### 5.1 Receive USDC

`getOrCreateUserWallet` returns an address (`lib/chain/wallet.ts:89`);
USDC sent to that address is already in the user's Privy wallet. MAZE's
balance display would need to read the ERC-20 `balanceOf(address)`
instead of `state.balUsd`, but no custody transition is needed — the
funds are already there.

### 5.2 x402 settlement (EIP-3009)

`lib/chain/x402.ts:87–116` builds and signs an EIP-3009 authorization
where `from` is the agent wallet and `to` is the payee — no MAZE
intermediary signs, no MAZE-held balance row moves on the chain path. The
only ledger entanglement is the pre-flight `store.x402Pay` call at
`routes/x402.ts:49` which writes the ledger debit before attempting the
chain settlement. That can be inverted with a small refactor.

### 5.3 Cross-chain bridge (Base→Gnosis card top-up)

`routes/card.ts:71–84` already uses the bridge router with the user's
wallet handle. The 7702 executor batches the calls; the user is the
authorizer. The remaining custodial fingerprint is that
`getOrCreateUserWallet` returns a Privy handle rather than a
user-side-signing handle — same Privy abstraction debt as §3.2.

---

## 6. Decision matrix — three options

### Option A — Full non-custodial pivot

**Surfaces affected:** Send, Earn, Card-Gnosis, Onramp, Offramp, x402
settlement, Cross-chain bridge, Agent wallets, Subscription renewal
(8 of 12 surfaces flip; Email-claim becomes "non-custodial via escrow
contract"; US-debit-card stays custodial; Receive is already there).

**Code seams touched:**
- Introduce `WalletProvider` interface (replaces hardcoded Privy refs at
  `lib/privy.ts:21–24`, `lib/chain/wallet.ts:81–97`,
  `lib/chain/privy-agent-wallet.ts:21–23`). Add WalletConnect /
  injected-wallet provider alongside the Privy provider; keep Privy as
  one option for users who want the managed experience.
- Refactor `store/postgres/ledger.ts:61–103` (send), `:157–194`
  (earnDeposit), `:196–235` (earnWithdraw), `:237–279` (swap) so the
  ledger row becomes a cached observation of on-chain state rather than
  the source of truth.
- Replace `routes/offers.ts:271–301` (bank_topup Bridge VA path) with
  widget-issued onramp redirect URLs. Eliminates Bridge KYB on MAZE.
- Replace `routes/bridge.ts:137–234` (withdraw path) with a widget
  offramp redirect.
- Deploy an on-chain escrow contract for `routes/claim.ts` →
  `lib/chain/privy-claim.ts` becomes "fund the contract on behalf of the
  pregenerated address" instead of "park in MAZE's ledger."
- Subscription cron: rewrite `workers/subscription-renewer.ts` to read
  on-chain authorization state and submit prepared calls rather than
  mutate `balUsd` directly.

**Regulatory burden delta:** Bridge KYB drops (eliminates the 1–4 week
critical path documented in `STATE-OF-BUILD.md` line 96). No
money-transmitter license needed in most jurisdictions. State-by-state
US MSB/MTL registration drops. Sumsub KYC stays only for the card path.

**Estimated effort:** 10–14 weeks for a single engineer; 6–8 weeks with
two. Card audit + escrow contract audit are the long tails.

### Option B — Partial pivot (keep card semi-custodial)

**Same as A except:** card-Gnosis stays as deployed-by-MAZE for a faster
"day-one card works" UX, and any US-debit-card path stays
custodial-by-issuer. Save ~2 weeks vs Option A.

**Surfaces affected:** Send, Earn, Onramp, Offramp, x402 settlement,
Cross-chain bridge, Agent wallets, Subscription renewal, Email-claim
(8 surfaces). Card-Gnosis remains as today.

**Regulatory burden delta:** Same Bridge KYB drop as A (the big one).
Card surface still touches Sumsub and the Gnosis Pay vendor account.

**Estimated effort:** 8–11 weeks single engineer; 5–6 weeks with two.

### Option C — Status quo (semi-custodial)

**Surfaces affected:** none. The build is shippable today as documented
in `STATE-OF-BUILD.md` TL;DR.

**Regulatory burden:** Bridge KYB stays the longest critical path to going
live (1–4 weeks per `STATE-OF-BUILD.md` line 96). Money-transmitter
exposure remains a state-by-state US question. Sumsub KYC retained for
card and Bridge offramp.

**The case for C:**
- Fastest to ship — the build is green today (502 API tests, 12 web,
  6 shared-zod, 74 playwright per `STATE-OF-BUILD.md` line 11).
- Lowest UX friction for non-crypto users (no per-action signatures).
- The agent / x402 / MCP surface — `HANDOVER-FULL.md` line 93 calls this
  "the unique-to-MAZE wedge" — is already non-custodial-enough through
  the EIP-3009 path. The compliance burden for the wedge alone is
  smaller than for the full neobank.
- Custodial primitives like ledgered earn give MAZE the ability to pay
  yield on balances and run the auto-divest-on-spend toggle
  (`store/postgres/ledger.ts:305–312`) which is harder to replicate
  non-custodially.

**Estimated effort:** 0 weeks. Continue current vendor wiring path
(submit Socket form, kick Bridge KYB, DNS cutover, Stripe live keys).

---

## 7. What this doc does not decide

This is a code-grounded research artifact. It does not push a
recommendation. The relevant trade-offs (audience targeting, regulatory
appetite, capital-efficiency of yield, brand position vs Revolut / Wise /
N26 / Mercury / Stripe Atlas) are product-level and live in
`HANDOVER-FULL.md` §2 lines 89–95.

The architectural reality is: **A is buildable, B is buildable, C is
shippable**. The custody pivot is reversible from C → B → A but not
trivially A → C (you can't un-eliminate Bridge KYB once you've routed
users to a widget for a year).

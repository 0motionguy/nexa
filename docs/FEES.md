# Neo Bank — Fee + Revenue Model

This document maps how Neo Bank monetizes every trade we route, where the
money lands, and which env vars control the rates.

> TL;DR: HL stack collects builder fees on every order (configurable, capped
> at 10 bps by HL). Jupiter swaps collect a platform fee (configurable,
> capped at 100 bps by Jupiter) into a NEXA-owned Solana ATA. HL Spot and
> Polymarket don't have a native fee channel — monetize via spread/markup
> (not implemented yet).

## Per-venue fee table

| Venue | Mechanism | Cap | Env knobs | Receiver |
|---|---|---|---|---|
| **HL Perps** | HL builder fee on signed order action | 10 bps | `HL_BUILDER_ADDRESS`, `HYPERLIQUID_BUILDER_FEE_TENTHS_BP` (tenths-of-bp: 25 = 2.5 bps) | EVM address at `HL_BUILDER_ADDRESS` |
| **HL Spot** | None — HL doesn't expose builder fees on spot | n/a | n/a | n/a |
| **HL HIP-3 / trade.xyz stocks** | Same builder fee as canonical perps | 10 bps | Shares `HL_BUILDER_ADDRESS` + `HYPERLIQUID_BUILDER_FEE_TENTHS_BP` | Same EVM address |
| **Jupiter (memes)** | `platformFeeBps` on quote → fee instruction inserted into swap tx | 100 bps | `JUPITER_PLATFORM_FEE_BPS` (50 = 0.5%), `JUPITER_PLATFORM_FEE_ACCOUNT` (base58 SPL ATA) | Solana ATA owned by NEXA |
| **xStocks** | Routes through Jupiter — same fee channel | 100 bps | Shares Jupiter env vars | Same Solana ATA |
| **Pump.fun (direct)** | We route via Jupiter — no separate channel | covered by Jupiter | covered by Jupiter | covered by Jupiter |
| **Polymarket** | No native referrer model; could spread the limit price | n/a | `POLYMARKET_BUILDER_FEE_BPS`, `POLYMARKET_BUILDER_ADDRESS` (env reserved, unwired) | n/a |

## How the math works

### Hyperliquid builder fee

The order action carries `builder: { b: <address>, f: <tenths-of-bp> }`.
Hyperliquid deducts the fee on every fill and credits it to the builder
address on settlement. NEXA completes the one-time `approveBuilderFee`
agreement from the backend during account setup or the first live HL action,
then later orders only attach the configured builder fee. Gating logic lives
in `liveTradingWalletGate` (`apps/api/src/routes/markets.ts`).

Production settings example:

```env
HL_BUILDER_ADDRESS=0xYOUR_FEE_RECEIVER
HYPERLIQUID_BUILDER_FEE_TENTHS_BP=25   # 2.5 bps on every perp + stock order
```

This means a $1,000 order pays $0.25 to NEXA. At 10× monthly turnover per
power user, that's $30/mo per user. HIP-3 / trade.xyz uses the same wire
so adding stocks doubles the surface without doubling the integration.

### Jupiter platform fee

Set in env:

```env
JUPITER_PLATFORM_FEE_BPS=50                                    # 0.50%
JUPITER_PLATFORM_FEE_ACCOUNT=YourSolanaATAForFeeReceiver…
```

On every quote, the route passes `platformFeeBps=50` to Jupiter. Jupiter
re-prices the route to insert a fee transfer instruction into the assembled
swap tx, deducting from the OUTPUT token. On a $100 USDC → BONK swap,
Jupiter sends ~$0.50 worth of BONK to the fee account.

> ⚠️ **Critical**: the fee account must be an existing ATA for the **output**
> token. For SOL outputs use the wrapped-SOL ATA (one address works for all
> SOL receivers). For any other mint, the receiver must have ATAs pre-created
> per mint. Easiest setup: a single Solana address with the
> `createAssociatedTokenAccount` + JIT-init pattern, OR maintain a static map
> of mint → ATA on the fee-receiver side.

### Polymarket

No native builder mechanism. Two monetization paths:

1. **Spread the limit price** — server-side, add 1 cent to buy orders, drop 1 cent from sell orders, keep the difference. Risky — user-visible.
2. **Stake the float** — when we hold user USDC.e between deposit and trade, route it through Polymarket's USDC.e vault or rehypothecate to Aave for a few bps of yield. Doesn't require user opt-in beyond ToS.

Neither is implemented; track as TODO.

## Tracking + ops

### Prometheus metrics

Wired in `apps/api/src/lib/metrics.ts`:

- `fees_earned_usd_total{venue, kind}` — Counter, cumulative USD of fees
- `fees_attempted_total{venue, kind}` — Counter, order count where a fee
  instruction was written into the action (success or not)

Grafana rules:

```promql
# Daily revenue by venue
sum by (venue) (rate(fees_earned_usd_total[1d]))

# Attempt-vs-collected gap (mis-configured fee account)
rate(fees_attempted_total[1h]) - rate(fees_earned_usd_total[1h])
```

### Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/me/fees` | Per-user recent fees, aggregated by venue |
| GET | `/me/admin/fees/summary` | Platform-wide rolling summary (sk_live_ only) |

### In-memory ring buffer

`apps/api/src/lib/fees.ts` keeps a 1000-event ring. Survives a single
process lifetime; durable accounting lives on-chain at the receiver
addresses. For historical revenue queries, use Prometheus.

## Production checklist

1. **Generate fee receivers**:
   - EVM: a dedicated address (NOT an exchange-deposit address). Hardware wallet or Privy server wallet recommended.
   - Solana: a fresh address. Pre-create ATAs for the top-100 output mints (top memes + xStocks + SOL + USDC). Script in `scripts/precreate-atas.ts` (TODO).

2. **Set env vars** (production):

   ```env
   HL_BUILDER_ADDRESS=0x…              # earns on perps + HIP-3 stocks
   HYPERLIQUID_BUILDER_FEE_TENTHS_BP=25 # 2.5 bps. Bump to 50 (5 bps) after first 30 days.

   JUPITER_PLATFORM_FEE_BPS=50         # 0.50% on every Jupiter swap
   JUPITER_PLATFORM_FEE_ACCOUNT=…      # NEXA-owned ATA
   ```

3. **Verify config** via `GET /me/profile.trading.*.feeBps` — every venue
   should report the expected rate.

4. **Wire Grafana alerts**:
   - Daily revenue < $X → notify ops
   - Attempt-vs-collected gap > Y% → fee account mis-configured

5. **Document with users** — the marketing page should disclose the
   platform fee for compliance with EU MiCA + UK FCA disclosure rules.

## Cost-side reality

The user asked: *"we need to pay for RPCs, wallets, KYC. So all have a cost."*

Approximate monthly cost floor for the current stack (10k DAU):

| Line item | Vendor | ~$/mo |
|---|---|---|
| Solana RPC (Helius growth) | Helius | $500–2,000 |
| Solana RPC fallback | Chainstack | $200 |
| EVM RPC | Alchemy | $200–500 |
| Privy embedded wallets | Privy | $1,000 (10k MAU @ $0.10) |
| Sumsub KYC | Sumsub | $500–1,500 (1k verifications) |
| Postgres + Redis | VPS | $80 |
| Sentry | Sentry | $80 |
| Cloudflare | Cloudflare | $20 |
| **Total floor** | | **~$2.5–4.5k/mo** |

To break even, need ~$5,000/mo gross fee revenue. With the rates above
that translates to roughly:

- **HL perps + HIP-3 stocks**: $100M monthly notional @ 2.5 bps = $25,000 → easily covers
- **Jupiter swaps**: $1M monthly @ 50 bps = $5,000 → break-even
- **Both stacked**: comfortable surplus from month 1 with even modest volume

## Related

- [API.md](./API.md) — endpoint reference
- [PROFILE.md](./PROFILE.md) — `/me/profile.trading.*.feeBps` schema
- `apps/api/src/lib/fees.ts` — fee tracker source
- `apps/api/src/lib/markets/jupiter.ts` — Jupiter platform fee wiring
- `apps/api/src/lib/markets/hyperliquid.ts` — HL builder fee wiring

# ADR-0003: Per-vendor feature flags derived from env-var presence

## Status

Accepted (pattern emerged organically across Sprints 5–12; codified
retrospectively on 2026-06-15)

## Date

2026-06-15

## Context

MAZE integrates **15 third-party vendors** for production functionality:

| Domain | Vendor |
|---|---|
| Identity / wallet | Privy (auth + server wallets) |
| On/off-ramp | Bridge.xyz |
| KYC | Sumsub |
| Cards | Gnosis Pay, Sponge |
| Earn / DeFi | Morpho (Steakhouse vault), Aave v3, Compound v3, yoUSD |
| Swap / bridge | Socket (primary), LIFI (fallback) |
| Payment | Stripe Checkout |
| Email | Resend |
| Observability | Sentry |
| Markets | Hyperliquid, Polymarket |
| x402 | Coinbase Facilitator |
| Infra | Chainstack RPC, Alchemy gas-sponsorship |

Each vendor requires one or more environment variables (API key, base URL,
webhook secret, contract address) to function. Without those vars set, calling
the vendor would either fail with a 401 from the vendor, fail with an
undefined network endpoint, or — worst case — accidentally hit the vendor's
production API with a half-configured demo build.

The team established a strict **dev/demo parity rule**:

> Running the API with `pnpm dev` (no vendor keys) must never make an outbound
> call to a real vendor. Demo behaviour must be observable in code, not as a
> "did anyone leak a key" runtime surprise.

This rule must hold even as the vendor matrix grows.

## Decision

**Every vendor integration has a boolean feature flag in
`apps/api/src/lib/env.ts` whose value is derived from the presence of the
vendor's required environment variables.**

The flags live in a single exported `features` const (`apps/api/src/lib/env.ts`
lines 213–232):

```ts
/** Feature flags derived from env. */
export const features = {
  privy: Boolean(env.PRIVY_APP_ID && env.PRIVY_APP_SECRET),
  resend: Boolean(env.RESEND_API_KEY),
  chain: Boolean(env.BASE_RPC_URL),
  alchemy: Boolean(env.ALCHEMY_API_KEY),
  lifi: Boolean(env.BASE_RPC_URL), // works without API key for low volume
  /** Socket bridge aggregator — primary in bridge-router when set. */
  socket: Boolean(env.SOCKET_API_KEY),
  bridge: Boolean(env.BRIDGE_API_KEY),
  stripe: Boolean(env.STRIPE_SECRET_KEY),
  gnosisPay: Boolean(env.GNOSIS_PAY_API_KEY),
  sponge: Boolean(env.SPONGE_API_KEY),
  sumsub: Boolean(env.SUMSUB_APP_TOKEN),
  markets: env.MARKETS_ENABLED,
  postgres: Boolean(env.DATABASE_URL),
  redis: Boolean(env.REDIS_URL),
  sentry: Boolean(env.SENTRY_DSN),
  metrics: env.METRICS_ENABLED,
  admin: Boolean(env.ADMIN_TOKEN),
} as const;
```

Routes, libs, and workers consume the flag at the call site and degrade
gracefully:

```ts
// apps/api/src/lib/email.ts — example
if (!features.resend) {
  log.info({ to, subject }, 'resend disabled — printing to stdout');
  return { ok: true };
}
return await resendClient.emails.send({ from, to, subject, html });
```

```ts
// apps/api/src/routes/bridge.ts — example
if (!features.bridge) {
  // Demo path — return mocked virtual account
  return c.json({ ok: true, virtualAccount: demoVirtualAccount(userId) });
}
return c.json({ ok: true, virtualAccount: await bridge.createVA(userId) });
```

The `/healthz` endpoint exposes the entire `features` object so operators can
verify on the deployed host:

```bash
curl https://api.maze.bank/healthz | jq '.features'
# → { "privy": true, "bridge": true, "stripe": true, ... }
```

## Drivers

- **Dev/demo parity** — no environment surprises. Running with no keys never
  calls a real vendor.
- **Single config truth** — env vars are already the source of truth for
  credentials; the feature flag is derived, not declared.
- **Graceful degradation** — every vendor has an in-code demo path that fires
  when the flag is false. Demo mode "just works".
- **Operator legibility** — `/healthz` shows the complete vendor enablement
  state at a glance, removing guesswork on a fresh deploy.
- **Test ergonomics** — flipping a flag in a test via env-var injection is
  cheaper than mocking the entire vendor SDK.

## Considered alternatives

### Explicit `ENABLE_X` flags per vendor

Rejected. Adding `ENABLE_BRIDGE=true`, `ENABLE_STRIPE=true`, etc., is
redundant — if `BRIDGE_API_KEY` is set, the operator clearly wants Bridge
enabled. Adding a second knob would introduce a class of misconfiguration
("I set the key but forgot ENABLE_X") for no observable benefit.

The presence of the credential **is** the enablement signal.

### Config files / JSON

Rejected. Three reasons:

1. The team's deploy story is already env-var driven (Caddy + systemd +
   `/opt/neobank/secrets/maze.env`), and adding a second config surface would
   create a "which source wins" question.
2. Env vars + a small parser keep the bootstrap path simpler than
   loading + validating a JSON file.
3. Config files leak into git history more easily than env vars (which live
   in a sealed `.env` outside the repo); the env-var path is harder to commit
   by accident.

### Runtime feature-flag service (LaunchDarkly, GrowthBook, Unleash)

Rejected. The "is the vendor configured" question is a deploy-time question,
not a runtime question. Adding a runtime flag service would introduce:

- Another vendor in the dependency chain (ironic, given the question being
  answered).
- A failure mode where the flag service is down and the gate becomes
  ambiguous.
- Latency on every gated call.

Runtime feature flags are still appropriate for A/B and progressive rollouts
(neither is in scope yet); per-vendor enablement isn't either of those.

## Consequences

### Positive

- Auto-degrades when keys are missing — no extra config to maintain.
- No environment surprises — demo behaviour is observable in code; nothing
  hits a real vendor without an env-var being set.
- Single source of truth — the `features` object is the one place to look.
- Demo mode "just works" — `pnpm dev` boots without any vendor keys and every
  flow demos end-to-end (OTP fallback `482019`, `cs_demo_*` Stripe sessions,
  mock virtual account numbers, demo card last4, etc.).
- Operators verify enablement via `curl /healthz | jq '.features'`.
- The integration matrix in `STATE-OF-BUILD.md` (line 93) maps 1:1 to the
  `features` const, so documentation drift is bounded by one file.

### Negative

- Route handlers must check the flag explicitly. The pattern is regular but
  not enforced by types — a new route that forgets to check
  `features.<vendor>` will hit the vendor unconditionally. Mitigation: code
  review + the demo-mode CI run (boots without vendor keys and asserts no
  outbound network).
- Env-var presence ≠ env-var validity. An invalid (e.g., revoked) `BRIDGE_API_KEY`
  will fail downstream at the vendor's 401, **not** at the flag-check time.
  This is a known and accepted trade-off — validating every key at boot would
  require making 15 vendor calls on cold start.
- Cannot easily express partial enablement (e.g., "Bridge onramp enabled,
  Bridge offramp disabled") with one flag per vendor. If a vendor's API splits
  along enabled/disabled features, the flag needs to be split (see the Socket
  vs LIFI router for one such case — separate `features.socket` and
  `features.lifi`).

## Reference

- Feature flag definition: `apps/api/src/lib/env.ts` lines 213–232
- Integration matrix (vendor ↔ env keys ↔ demo state ↔ live-ready status):
  `STATE-OF-BUILD.md` line 93
- Healthz exposure: `apps/api/src/routes/healthz.ts`
- Demo behaviour catalogue (per-vendor): `STATE-OF-BUILD.md` Integration
  Matrix
- Going-live env checklist: `STATE-OF-BUILD.md` line 258 (item 6)

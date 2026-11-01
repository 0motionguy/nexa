# NEXA

**NEXA: an end-to-end, forkable neobank.** One ledger for people and AI agents: get paid, hold dollars, earn yield, spend by card, trade markets, and give an agent a budget it can spend over x402 and MCP.

NEXA is the source for a complete crypto-rails neobank: API, mobile-first web app, MCP server, typed SDK and the infra to run it. It is aimed at teams that want to launch their own branded money product without writing the ledger, checkout, agent-policy and market-routing layers from scratch. It runs on Base for payments and yield and on Solana for swaps and staking, through Privy-managed wallets, and keeps every vendor integration behind its own keys, so a deployment turns on only what it has accounts for.

Earlier brand: MAZE. The web copy still says MAZE in places; packages and API are `nexa`.

## What it does

- **Get paid.** Offers, hosted checkout and payment links. Buyers pay by balance, card (Stripe Checkout) or bank top-up. Payouts, sub-accounts, revenue splits and subscriptions sit behind a `/v1` REST API with test and live keys, idempotency keys and signed outbound webhooks. The API serves its OpenAPI spec at `/v1/openapi.json`, with a session-gated Swagger UI.
- **Earn.** One deposit/withdraw API over Morpho, Aave, Compound and yoUSD vaults on Base (`lib/earn-router.ts`), with vault tiers. Marinade SOL staking, Ethena and Jupiter Lend readers sit alongside.
- **Agents with budgets.** Each agent gets its own Privy wallet and a server-enforced policy: per-transaction cap, daily cap, hostname allowlist and a user-level kill switch. The check runs before money moves, not in the client.
- **x402 on both sides.** Agents pay x402 endpoints (EIP-3009 USDC/EURC authorisations settled on Base through a facilitator). Vendors list priced endpoints in a portal. A discovery manifest is served under `/.well-known/x402-catalog`.
- **MCP.** A Streamable HTTP MCP server inside the API (10 tools: balance, agents, policy, `pay_endpoint`, funds and transfers, plus `create_offer`, `get_payments`, `create_payout`, `split_revenue`). A separate stdio package, `@nexa/mcp`, exposes 13 market and trade tools.
- **Markets.** Hyperliquid perps and spot, trade.xyz stock perps (HIP-3), Backed xStocks and Solana memes through Jupiter, Polymarket CLOB, and tokenized trading cards. Orders are signed by the user's Privy wallet; platform fees use builder codes and Jupiter's platform fee. Region and KYC gates, a market kill switch, and an optional shared realtime WebSocket/SSE hub.
- **Money movement.** Cross-chain swaps and bridges via Socket, LI.FI, CCTP v2 and Mayan. Fiat rails via Stripe and Bridge, EUR via Monerium, KYC via Sumsub, cards via Gnosis Pay and Sponge. Each one is live only when its keys are set; without them the API falls back to demo behaviour.
- **Operations.** Postgres through Drizzle (40 tables, 38 migrations) with an in-memory store for demos, a BullMQ scheduler (claim sweeper, subscription renewals, digests, deposit reconciler, fills notifier), Prometheus metrics and alert rules, Sentry with PII scrubbing, and a restore-drill script.

## How it's built

```
apps/web (PWA, portal, checkout) -------+
apps/mcp (stdio) -> @nexa/sdk ----------+
NEO (separate repo) --------------------+--> apps/api (Hono) --> Postgres (Drizzle), Redis (BullMQ)
AI agents -> POST /mcp, /x402/pay ------+                   --> Privy, Stripe, Bridge, Sumsub, Monerium
                                                            --> Base and Solana RPC, Hyperliquid, Polymarket, Jupiter
```

TypeScript throughout. Node 22, pnpm 9 workspaces, Hono, zod schemas shared between client and server, Drizzle ORM, Redis and BullMQ, viem and `@solana/web3.js`, Privy for sign-in and wallets. The web app is Vite multi-page with vanilla web components and a small React island for Privy sign-in. Tests: Vitest (141 API spec files, 30 web spec files) and 17 Playwright specs.

## Repository layout

| Path | Contents |
|---|---|
| `apps/api` | Hono API: routes, store (Postgres and in-memory), workers, realtime hub, MCP endpoint, Drizzle schema and migrations |
| `apps/web` | PWA (about 30 screens), landing page, x402 vendor portal, hosted checkout, developer reference, admin console |
| `apps/mcp` | stdio MCP server over the SDK |
| `packages/shared-zod` | Request/response schemas shared by web, API and SDK |
| `packages/nexa-sdk` | Typed client for auth, profile, earn, transfers, markets and cards |
| `packages/realtime-client` | WebSocket client and React hooks for the realtime hub |
| `packages/charts` | Chart engine used by the web app and by NEO |
| `infra/` | Compose and Caddy fragments, Prometheus, Alertmanager, Uptime Kuma, local Postgres/Redis compose |
| `scripts/` | Deploy, verification, probes, load gate, restore drill |
| `docs/` | API, SDK, MCP, fees, wiring maps, ADRs, custody analysis, readiness audit |

## Run it locally

```bash
pnpm install
pnpm dev            # web on :5173, API on :8090
SKIP_NEO_VERIFY=1 pnpm verify   # providers, deploy contract, typecheck, lint, tests, build
```

`pnpm verify` also runs the NEO client's checks when that repo sits next to this one in a folder named `neo`; the skip flag is for a standalone checkout. NEO in turn expects this repo in a sibling folder named `nexa`.

With no environment set, the API starts in demo mode: in-memory ledger, mock sign-in, no external calls. To run against Postgres and Redis, start `infra/local-pg-compose.yml`, set `DATABASE_URL` and `REDIS_URL`, then `pnpm db:migrate`. Copy `apps/api/.env.example` and `apps/web/.env.example` and fill in only the vendors you use. Other scripts: `pnpm test:e2e`, `pnpm route:inventory`, `pnpm verify:deploy`.

More detail: [docs/API.md](docs/API.md), [docs/SDK.md](docs/SDK.md), [docs/MCP.md](docs/MCP.md), [docs/FEES.md](docs/FEES.md).

## White-label

Fork it and you have a neobank codebase, not a template.

**What a team gets**
- The API, with the full `/v1` developer surface, hosted checkout, payment links, payouts, subscriptions, earn, agents, x402 and MCP.
- The consumer PWA, the vendor portal, the developer docs page and the admin console.
- The typed SDK, the realtime client and the chart package, so a second client ([NEO](https://github.com/0motionguy/neo-terminal) is one) can sit on the same API.
- Docker images for API and web, compose and Caddy fragments, alert rules and verification scripts.

**What you configure**
- Brand: design tokens in `apps/web/src/tokens.css` and `tokens.json`, plus page copy in the HTML files. Tokens cover colour, type and radii; names and copy are not parameterised, so a rebrand is an edit pass.
- Public URLs: `PAY_LINK_BASE_URL`, `CLAIM_LINK_BASE_URL`, `CHECKOUT_BASE_URL`, `WEB_ORIGIN`, `PORTAL_ORIGIN`, `RESEND_FROM`; web build args `VITE_NEXA_API_BASE`, `VITE_MAZE_PAY_BASE_URL`.
- Vendors, each switched on by its keys: Stripe, Bridge, Monerium, Sumsub, Gnosis Pay, Sponge, Alchemy, Socket, LI.FI, Resend.
- Chains and yield: `BASE_RPC_URL`, Solana RPC (`HELIUS_RPC_URL` or `SOLANA_RPC_URL`), `X402_FACILITATOR_URL`, vault addresses.
- Revenue: `HL_BUILDER_ADDRESS` and builder fee, `JUPITER_PLATFORM_FEE_BPS`, `POLYMARKET_BUILDER_*`. Market access: `MARKETS_ENABLED`, `JUPITER_SWAPS_ENABLED`, `REALTIME_HUB_V1`.

**What it needs to run**
- Node 22, Postgres, Redis, and a container host. `infra/` holds Docker Compose and Caddy fragments for a setup with shared Postgres and Redis; adapt them to your host.
- A Privy app (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`) for sign-in and wallets, plus `JWT_SECRET` and `ADMIN_TOKEN`.
- Accounts with whichever vendors you switch on. Fiat rails need partner approval (Bridge KYB) and card issuing depends on the card partners' programs; the code does not replace licensing or compliance work.
- Custody: wallets are Privy-managed and balances are ledgered in Postgres with on-chain mirroring; `docs/CUSTODY-ANALYSIS.md` covers the trade-offs and a non-custodial path.

**Not a config switch:** the product name in copy, the demo fixtures, and the infra fragments' host assumptions.

## Status

Beta. The private codebase deploys from `main` to a live environment, with money paths covered by tests and run in sandbox or demo mode. Market-trading paths have been exercised against live venues; fiat on/off-ramp and card issuing were still waiting on partner approval, and an internal July 2026 readiness audit graded it ready with conditions.

## About this repository

A public snapshot of the private NEXA codebase (`main` at `d35a0f0`, 1 November 2026), published as reference work. Development continues privately. Operations material (deploy scripts, runbooks, probe output, internal reports) is left out, so the CI and deploy workflows are not included. No open-source licence is attached: reading is welcome; reuse needs the author's permission.

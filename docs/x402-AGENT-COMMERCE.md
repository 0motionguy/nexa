# Agent commerce on NEXA — x402 + MCP integration guide

## TL;DR

NEXA exposes a Bitrefill-style discoverable product manifest at
`/.well-known/x402-catalog`. Agent runtimes (Claude, GPT-Codex, autonomous
crews) can fetch it once, pick a product, then settle via either:

- **x402** for one-shot priced calls (`X-PAYMENT` header on `/x402/pay`)
- **MCP** for stateful tool use (`Authorization: Bearer nx_live_…` on `/mcp`)

Both rails terminate on the same agent-key + ledger, so spending limits and
policy enforcement are uniform regardless of which protocol the agent picks.

## Discovery

```bash
curl -s https://nexa.aiso.tools/.well-known/x402-catalog | jq .
```

Returns:

```json
{
  "version": "1.0",
  "issuer": "nexa.aiso.tools",
  "name": "NEXA Neo Bank",
  "mcp": "https://nexa.aiso.tools/mcp",
  "x402": "https://nexa.aiso.tools/x402/pay",
  "products": [
    {
      "id": "x402-pay",
      "title": "Pay any x402 endpoint",
      "endpoint": "/x402/pay",
      "method": "POST",
      "auth": "agent-key",
      "pricing": { "currency": "USDC", "min": 0.001, "max": 100, "typical": 0.05 }
    },
    ...
  ]
}
```

The manifest is **stable and version-tagged**. Downstream agents can codegen
clients against it.

## Pattern 1 — x402 facilitator

An agent encounters an upstream endpoint that returns HTTP 402 with an
`X-PAYMENT-REQUIRED` body. To settle:

```http
POST /x402/pay HTTP/1.1
Host: nexa.aiso.tools
Authorization: Bearer nx_live_<agent_key>
Content-Type: application/json

{
  "url": "https://upstream.example/v1/expensive-thing",
  "challenge": { "amount": "0.05", "currency": "USDC", "chain": "base", "payee": "0x..." }
}
```

Response includes a signed `X-PAYMENT` header that the agent forwards on
retry of the original call. The agent's policy envelope (`perTxCapUsd`,
`endpointAllowlist`, `humanApprovalThresholdUsd`) is enforced before the
EIP-3009 transfer is signed.

## Pattern 2 — MCP tools

For multi-turn workflows (e.g. an autonomous agent that opens a payment
link, waits for the human to fund it, then dispatches a payout), use the
MCP server at `/mcp` (Streamable HTTP transport).

```bash
curl -X POST https://nexa.aiso.tools/mcp \
  -H "Authorization: Bearer nx_live_<agent_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/list"
  }'
```

The exposed tools mirror the catalog: `pay_endpoint`, `transfer`,
`create_payout`, `split_revenue`, plus the `*_get` read-only counterparts.

## Pattern 3 — Pre-funded model (Bitrefill lesson)

Bitrefill's agent surface works because agents don't manage wallets — they
spend from a pre-funded NEXA account. This is the cleanest UX for autonomous
agents:

1. User funds their NEXA balance via onramp / send / earn-withdraw.
2. User mints an agent key on `/agent/keys` with a policy envelope.
3. Agent uses the key against `/mcp` or `/x402/pay`.
4. NEXA ledger debits the user balance per call; the agent never holds funds.

For the agent runtime this is one HTTP header (the key) and one endpoint.
For the user it's a per-agent kill switch + spend cap that can be revoked
at any time without rotating wallet keys.

## Discoverability outside NEXA

Once the catalog is exposed on production, we should ping the following
agent registries so external runtimes find us:

- Anthropic MCP server registry (https://github.com/modelcontextprotocol/servers)
- x402 facilitator directory (Coinbase-published list, when available)
- OpenAI Agents SDK example registry (TBD as of 2026-06)
- Manual outreach to LangChain / LlamaIndex / Sourcegraph Cody for inclusion

The catalog itself is self-describing enough that an agent runtime should
be able to consume it without prior knowledge of NEXA. That's the whole
point of the `/.well-known/` placement — RFC 8615 well-known URI convention.

## Lessons from Bitrefill

Bitrefill (https://bitrefill.com/agents) is the reference implementation:

- **Stateless agent API** — no per-agent provisioning UI; agents discover
  via catalog and authenticate via bearer token.
- **Custody separation** — agents spend from prefunded accounts; the
  vendor (Bitrefill) holds custody and settles on each purchase.
- **Permissionless catalog** — 10,000+ products listed without per-product
  gating. Discoverable by any agent runtime.
- **MCP-first** — Bitrefill ships an MCP server alongside REST so agents in
  Claude / GPT can use it without a custom integration.

NEXA mirrors all four of these: the catalog at `/.well-known/x402-catalog`,
agent-key auth, MCP server at `/mcp`, custody held server-side via Privy.

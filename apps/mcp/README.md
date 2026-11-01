# @nexa/mcp

Model Context Protocol server for the **Neo Bank / NEXA** public API. Lets
AI agents (Claude Desktop, ChatGPT MCP hosts, custom agents) call the
Neo Bank markets + profile + payments surface as MCP tools.

Thin adapter around [`@nexa/sdk`](../../packages/nexa-sdk) — every tool
maps 1:1 to an SDK method.

## What's exposed

Read tools (no API key required for public data):

- `get_profile` — unified user state (identity, balances, KYC, trading eligibility per venue)
- `get_fees` — recent fees collected on this user's behalf
- `list_perps` — Hyperliquid perpetual futures (~230 coins)
- `list_spot` — Hyperliquid spot pairs (~307)
- `list_stocks` — trade.xyz HIP-3 perps + Backed xStocks
- `list_memes` — pump.fun + Jupiter merged
- `list_predictions` — Polymarket
- `get_stock_candles` — OHLCV for a HIP-3 stock
- `get_meme_prices` — bulk price lookup for Solana mints

Trade tools (require `sk_live_*` or `sk_test_*` API key):

- `place_perp_order` — HL perps
- `place_stock_order` — trade.xyz HIP-3 (TSLA, AAPL, SP500, …)
- `swap_token` — Jupiter swap (memes + xStocks)
- `place_prediction_order` — Polymarket

All trade tools require an `idempotencyKey` argument — the server replays
the original response on duplicate keys.

## Install + run

```bash
pnpm install
pnpm --filter @nexa/mcp build
NEXA_API_KEY=sk_live_... node apps/mcp/dist/index.js
```

## Claude Desktop config

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "nexa": {
      "command": "node",
      "args": ["/abs/path/to/nexa/apps/mcp/dist/index.js"],
      "env": {
        "NEXA_API_KEY": "sk_live_...",
        "NEXA_API_URL": "https://nexa.aiso.tools"
      }
    }
  }
}
```

Then ask Claude things like:

> Show me TSLA stock candles for the last 24 hours, then buy $50 of 5x long
> if the 4h candle is green.

Claude will fan out to `get_stock_candles` and (with confirmation)
`place_stock_order` with a fresh idempotency key.

## Auth modes

| Env var | What it does |
|---|---|
| `NEXA_API_KEY=sk_live_...` | Live trades + balances; production keys |
| `NEXA_API_KEY=sk_test_...` | Sandbox trades against demo data |
| _unset_ | Anonymous reads only — markets lists + public detail; trades return 401 |

## Wire

MCP stdio JSON-RPC per the spec. Tool results are stringified JSON in a
single `content[0].text` block — agents parse them back to objects. Errors
return `isError: true` with a human-readable message.

## Links

- API reference: [docs/API.md](../../../docs/API.md)
- SDK: [packages/nexa-sdk](../../packages/nexa-sdk)
- MCP wire spec: https://modelcontextprotocol.io

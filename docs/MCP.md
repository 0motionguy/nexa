# Neo Bank MCP server — `@nexa/mcp`

A Model Context Protocol server that wraps the Neo Bank public API so AI
agents (Claude Desktop, ChatGPT MCP, custom hosts) can:

- Read markets + profile + fees
- Place trades on every venue (HL perps + spot, HIP-3 stocks, Jupiter
  swaps, Polymarket) with idempotency

Thin adapter around [`@nexa/sdk`](../packages/nexa-sdk). Every tool
maps 1:1 to an SDK method.

## Tools

Read tools (no API key needed):

| Tool | What it does |
|---|---|
| `get_profile` | Unified user state across all venues |
| `get_fees` | Recent fees collected on this user's behalf |
| `list_perps` | Hyperliquid perpetual futures |
| `list_spot` | Hyperliquid spot pairs |
| `list_stocks` | trade.xyz HIP-3 perps + Backed xStocks |
| `list_memes` | pump.fun + Jupiter merged |
| `list_predictions` | Polymarket |
| `get_stock_candles` | OHLCV for a HIP-3 stock |
| `get_meme_prices` | Bulk price lookup for Solana mints |

Trade tools (require `sk_live_*` or `sk_test_*`):

| Tool | What it does |
|---|---|
| `place_perp_order` | HL perps |
| `place_stock_order` | trade.xyz HIP-3 (TSLA, AAPL, SP500, …) |
| `swap_token` | Jupiter swap (memes + xStocks) |
| `place_prediction_order` | Polymarket |

## Install + run

```bash
pnpm install
pnpm --filter @nexa/mcp build
NEXA_API_KEY=sk_live_... node apps/mcp/dist/index.js
```

## Claude Desktop config

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Then ask Claude:

> Show me TSLA stock candles for the last 24h. If the 4h candle is green,
> buy $50 of 5× long.

Claude calls `get_stock_candles`, evaluates, then (with your confirmation)
`place_stock_order` with a fresh idempotency key.

## Auth modes

| Env | What |
|---|---|
| `NEXA_API_KEY=sk_live_…` | Live trades; production keys |
| `NEXA_API_KEY=sk_test_…` | Sandbox trades against demo data |
| _unset_ | Anonymous reads only — markets lists + public detail. Trades return 401. |

## Security notes

- API keys are **per-user** — give Claude a key that you own
- Trade tools require **idempotency keys** the agent generates (or you supply)
- For destructive actions (close positions, cancel orders), require the
  agent to ask you for confirmation in chat — MCP itself doesn't enforce
  this, your agent host does
- All trades are gated by the same server-side guards as the mobile app:
  region, wallet readiness, idempotency, kill switch, and venue-specific
  backend agreements.

## Wire

stdio JSON-RPC per the MCP spec. Tool results are stringified JSON in a
single `content[0].text` block. Errors return `isError: true` with the
human-readable `NexaError` message.

## Related

- README: `apps/mcp/README.md`
- SDK: [`@nexa/sdk`](./SDK.md)
- API reference: [API.md](./API.md)
- MCP spec: https://modelcontextprotocol.io

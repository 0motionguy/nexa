#!/usr/bin/env node
/**
 * @nexa/mcp — Model Context Protocol server for the Neo Bank / NEXA API.
 *
 * Lets AI agents (Claude Desktop, ChatGPT MCP, custom hosts) call the NEXA
 * markets + profile + payments surface as MCP tools. The server is a thin
 * adapter around @nexa/sdk: tool calls map 1:1 to SDK methods, results
 * are JSON.
 *
 * Auth: read `NEXA_API_KEY` from env (sk_test_* or sk_live_*) on startup.
 * Without a key the server runs read-only against demo data — markets list
 * + profile work, trade routes return 401.
 *
 * Wire: stdio JSON-RPC per the MCP spec. Run via:
 *
 *   NEXA_API_KEY=sk_live_… node dist/index.js
 *
 * Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "nexa": {
 *         "command": "node",
 *         "args": ["/abs/path/to/apps/mcp/dist/index.js"],
 *         "env": { "NEXA_API_KEY": "sk_live_…" }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { NexaClient, NexaError } from '@nexa/sdk';

const BASE_URL = process.env.NEXA_API_URL ?? 'https://nexa.aiso.tools';
const API_KEY = process.env.NEXA_API_KEY;

const nx = new NexaClient({ baseUrl: BASE_URL, apiKey: API_KEY });

const server = new Server(
  {
    name: 'nexa',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

/**
 * Tool catalog. Each entry maps an MCP tool name to a description, a JSON
 * Schema for the input, and a handler that calls the SDK. The descriptions
 * are written for AI agents — they should be self-explanatory so the agent
 * picks the right tool.
 */
const TOOLS = [
  {
    name: 'get_profile',
    description:
      'Get the unified Neo Bank profile for the authenticated user. Returns identity, balances, KYC status, per-venue trading eligibility, and platform fee rates in a single response. Use this BEFORE trying to trade so you know which venues are gated.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => nx.me.profile(),
  },
  {
    name: 'get_fees',
    description:
      'Get the recent platform fees collected on this user\'s behalf, aggregated by venue. Useful for fee-receipt UIs or revenue summaries.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => nx.me.fees(),
  },
  {
    name: 'list_perps',
    description:
      'List Hyperliquid perpetual futures markets. Up to ~230 coins. Returns price, 24h change, max leverage, funding rate.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max markets to return (1–500, default 500)' },
      },
    },
    handler: (args: { limit?: number }) => nx.markets.hyperliquid.list(args.limit),
  },
  {
    name: 'list_spot',
    description:
      'List Hyperliquid SPOT markets (canonical + memecoin pairs). Returns ~307 pairs.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    },
    handler: (args: { limit?: number }) => nx.markets.hyperliquidSpot.list(args.limit ?? 500),
  },
  {
    name: 'list_stocks',
    description:
      'List tokenized stocks (perps from trade.xyz via Hyperliquid HIP-3, and Backed Finance xStocks on Solana via Jupiter). Includes individual tickers (TSLA, AAPL, NVDA, MSFT, …), indices (SP500, NIFTY, JP225), commodities (GOLD, OIL), and FX.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max markets per rail (default 200)' },
      },
    },
    handler: (args: { limit?: number }) => nx.markets.stocks.list(args.limit),
  },
  {
    name: 'list_memes',
    description:
      'List Solana meme tokens — merged pump.fun + Jupiter Token API. Use the `tag` filter for "meme" or "verified", and `source` to scope to "pump" / "jupiter" / "both".',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['pump', 'jupiter', 'both'] },
        tag: { type: 'string', description: 'verified | meme | launchpad | lst | …' },
        sort: { type: 'string', enum: ['market_cap', 'volume', 'recent', 'koth'] },
        limit: { type: 'number' },
      },
    },
    handler: (args: { source?: 'pump' | 'jupiter' | 'both'; tag?: string; sort?: 'market_cap' | 'volume' | 'recent' | 'koth'; limit?: number }) => nx.markets.jupiter.list(args),
  },
  {
    name: 'list_predictions',
    description:
      'List Polymarket prediction markets. Each market has Yes/No outcomes with current cent prices. Optional category filter (e.g. politics, sports, crypto).',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    handler: (args: { category?: string; limit?: number }) => nx.markets.polymarket.list(args),
  },
  {
    name: 'get_stock_candles',
    description:
      'Get OHLCV candles for a tokenized stock perp (e.g. xyz:TSLA). Used for charting + technical analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Full coin with xyz: prefix, e.g. "xyz:TSLA"' },
        interval: { type: 'string', description: '1m, 5m, 15m, 1h, 4h, 1d, …' },
        lookbackMs: { type: 'number' },
      },
      required: ['coin'],
    },
    handler: (args: { coin: string; interval?: string; lookbackMs?: number }) =>
      nx.markets.stocks.candles(args.coin, args.interval, args.lookbackMs),
  },
  {
    name: 'get_meme_prices',
    description:
      'Bulk price lookup for Solana meme mints. Up to 100 mints per call.',
    inputSchema: {
      type: 'object',
      properties: {
        mints: { type: 'array', items: { type: 'string' } },
      },
      required: ['mints'],
    },
    handler: (args: { mints: string[] }) => nx.markets.jupiter.prices(args.mints),
  },
  {
    name: 'place_perp_order',
    description:
      'Place a Hyperliquid perp order on behalf of the user. Requires an Idempotency-Key. If an HL builder fee is configured, the backend manages the one-time builder agreement before live order submission.',
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Bare ticker e.g. "BTC", "ETH", "FARTCOIN"' },
        sideLong: { type: 'boolean' },
        qtyUsd: { type: 'number' },
        leverage: { type: 'number' },
        orderType: { type: 'string', enum: ['market', 'limit'] },
        limitPriceUsd: { type: 'number' },
        idempotencyKey: { type: 'string' },
      },
      required: ['coin', 'sideLong', 'qtyUsd', 'leverage', 'orderType', 'idempotencyKey'],
    },
    handler: (args: { idempotencyKey: string; coin: string; sideLong: boolean; qtyUsd: number; leverage: number; orderType: 'market' | 'limit'; limitPriceUsd?: number }) =>
      nx.markets.hyperliquid.placeOrder(
        {
          coin: args.coin,
          sideLong: args.sideLong,
          qtyUsd: args.qtyUsd,
          leverage: args.leverage,
          orderType: args.orderType,
          limitPriceUsd: args.limitPriceUsd,
        },
        args.idempotencyKey,
      ),
  },
  {
    name: 'place_stock_order',
    description:
      'Place a tokenized stock perp order via trade.xyz HIP-3 (e.g. xyz:TSLA, xyz:NVDA, xyz:SP500). 24/7 markets, leverage up to 50x on indices. Requires Idempotency-Key.',
    inputSchema: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'Either "xyz:TSLA" or bare "TSLA"' },
        sideLong: { type: 'boolean' },
        qtyUsd: { type: 'number' },
        leverage: { type: 'number' },
        orderType: { type: 'string', enum: ['market', 'limit'] },
        limitPriceUsd: { type: 'number' },
        idempotencyKey: { type: 'string' },
      },
      required: ['coin', 'sideLong', 'qtyUsd', 'leverage', 'orderType', 'idempotencyKey'],
    },
    handler: (args: { idempotencyKey: string; coin: string; sideLong: boolean; qtyUsd: number; leverage: number; orderType: 'market' | 'limit'; limitPriceUsd?: number }) =>
      nx.markets.stocks.placeOrder(
        {
          coin: args.coin,
          sideLong: args.sideLong,
          qtyUsd: args.qtyUsd,
          leverage: args.leverage,
          orderType: args.orderType,
          limitPriceUsd: args.limitPriceUsd,
        },
        args.idempotencyKey,
      ),
  },
  {
    name: 'swap_token',
    description:
      'Execute a Solana token swap via Jupiter (memes + xStocks). Routes through PumpSwap/Raydium/Orca/Meteora automatically. Requires Idempotency-Key. The platform fee (configured server-side) is deducted from the output token.',
    inputSchema: {
      type: 'object',
      properties: {
        inputMint: { type: 'string' },
        outputMint: { type: 'string' },
        amountAtomic: { type: 'string', description: 'Atomic units (smallest unit of input mint)' },
        slippageBps: { type: 'number', description: '50 = 0.5%, default 300' },
        idempotencyKey: { type: 'string' },
      },
      required: ['inputMint', 'outputMint', 'amountAtomic', 'idempotencyKey'],
    },
    handler: (args: { idempotencyKey: string; inputMint: string; outputMint: string; amountAtomic: string; slippageBps?: number }) =>
      nx.markets.jupiter.swap(
        {
          inputMint: args.inputMint,
          outputMint: args.outputMint,
          amountAtomic: args.amountAtomic,
          slippageBps: args.slippageBps,
        },
        args.idempotencyKey,
      ),
  },
  {
    name: 'place_prediction_order',
    description:
      'Place a Polymarket prediction-market order (buy Yes/No on a market). Outcome string matches the market\'s outcome label. Idempotency required.',
    inputSchema: {
      type: 'object',
      properties: {
        marketId: { type: 'string' },
        outcome: { type: 'string', description: 'Outcome label, e.g. "Yes" or "No"' },
        priceCents: { type: 'number', description: '1..99 cents' },
        qtyUsd: { type: 'number' },
        idempotencyKey: { type: 'string' },
      },
      required: ['marketId', 'outcome', 'priceCents', 'qtyUsd', 'idempotencyKey'],
    },
    handler: (args: { idempotencyKey: string; marketId: string; outcome: string; priceCents: number; qtyUsd: number }) =>
      nx.markets.polymarket.placeOrder(
        {
          marketId: args.marketId,
          outcome: args.outcome,
          priceCents: args.priceCents,
          qtyUsd: args.qtyUsd,
        },
        args.idempotencyKey,
      ),
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await (tool.handler as (a: unknown) => Promise<unknown>)(req.params.arguments ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    if (e instanceof NexaError) {
      return {
        isError: true,
        content: [{ type: 'text', text: `NexaError ${e.status} ${e.code ?? ''}\n${JSON.stringify(e.details, null, 2)}` }],
      };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is the MCP wire); helpful for "is it running?" smoke tests.
process.stderr.write(
  `nexa-mcp listening on stdio · base=${BASE_URL} · auth=${API_KEY ? 'sk_*' : 'anonymous'}\n`,
);

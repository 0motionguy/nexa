/**
 * Well-known discovery endpoints (no auth required).
 *
 * `/.well-known/x402-catalog` — Bitrefill-inspired manifest that lets agents
 * discover the priced products NEXA offers under the x402 / MCP rails. An
 * agent fetches this once, picks a product, then calls the listed endpoint
 * with an `X-PAYMENT` header (x402) or `Authorization: Bearer nx_…` (MCP).
 *
 * Manifest shape is stable and version-tagged so downstream agent runtimes
 * can codegen against it. Pricing is illustrative — actual amounts vary by
 * route and are enforced server-side (this manifest is discovery, not a
 * billing contract).
 */

import { Hono } from 'hono';
import { env } from '../lib/env.js';

export const wellknownRoutes = new Hono();

interface CatalogProduct {
  id: string;
  title: string;
  description: string;
  endpoint: string;
  method: 'GET' | 'POST';
  auth: 'agent-key' | 'session' | 'public' | 'x402';
  pricing: {
    currency: 'USDC' | 'EURC' | 'USD';
    min?: number;
    max?: number;
    typical?: number;
  };
  chains?: string[];
  docs?: string;
}

const CATALOG_PRODUCTS: CatalogProduct[] = [
  {
    id: 'x402-pay',
    title: 'Pay any x402 endpoint',
    description:
      'Settle a 402 Payment Required challenge against any upstream x402-capable endpoint. ' +
      'NEXA acts as the facilitator: the agent presents the x402 challenge, NEXA signs the ' +
      'EIP-3009 transfer with the per-agent Privy wallet, returns X-PAYMENT, and records the ' +
      'event on the agent ledger.',
    endpoint: '/x402/pay',
    method: 'POST',
    auth: 'agent-key',
    pricing: { currency: 'USDC', min: 0.001, max: 100, typical: 0.05 },
    chains: ['base'],
    docs: 'https://nexa.aiso.tools/v1/openapi.json#tag/x402',
  },
  {
    id: 'mcp',
    title: 'MCP server (Streamable HTTP)',
    description:
      'Model Context Protocol server exposing money-capable tools to agents: pay_endpoint, ' +
      'transfer, create_payout, split_revenue. Each tool is policy-gated by the calling agent ' +
      'key (per-tx cap, per-day cap, endpoint allowlist).',
    endpoint: '/mcp',
    method: 'POST',
    auth: 'agent-key',
    pricing: { currency: 'USDC', min: 0, typical: 0 },
    docs: 'https://nexa.aiso.tools/docs/x402-AGENT-COMMERCE.md',
  },
  {
    id: 'card-topup',
    title: 'Load funds to virtual card',
    description:
      'Bridge USDC on Base to EURe on Gnosis and credit the user virtual card. Idempotency via ' +
      'Idempotency-Key header. Route via Socket (primary) or LIFI (fallback) with destination-gas refuel.',
    endpoint: '/card/topup',
    method: 'POST',
    auth: 'session',
    pricing: { currency: 'USDC', min: 1, max: 1000, typical: 25 },
    chains: ['base', 'gnosis'],
  },
  {
    id: 'onramp',
    title: 'Fiat → USDC onramp',
    description:
      'Stripe Onramp checkout that lands USDC in the user Privy wallet on Base. KYC handled ' +
      'by Stripe. Webhook settles ledger.',
    endpoint: '/onramp/stripe/session',
    method: 'POST',
    auth: 'session',
    pricing: { currency: 'USD', min: 10, max: 10_000, typical: 100 },
    chains: ['base'],
  },
  {
    id: 'swap',
    title: 'Token swap (Mayan + Socket)',
    description:
      'Cross-asset swap on Base (Socket / LIFI) or cross-chain Base ↔ Solana (Mayan). Pre-flight ' +
      'quote at /swap/quote, execution at /swap.',
    endpoint: '/swap',
    method: 'POST',
    auth: 'session',
    pricing: { currency: 'USD', min: 0.1, max: 10_000, typical: 50 },
    chains: ['base', 'solana'],
  },
  {
    id: 'payment-link',
    title: 'Generate a maze.to/pay link',
    description:
      'Shareable, signed payment-request link. Recipient claims via email + OTP. Used by ' +
      'humans to send to a contact OR by an agent to bill a counterparty.',
    endpoint: '/payments/request-link',
    method: 'POST',
    auth: 'session',
    pricing: { currency: 'USD', min: 0.01, max: 100_000 },
    docs: 'https://nexa.aiso.tools/v1/openapi.json#tag/payments',
  },
  {
    id: 'agent-key',
    title: 'Provision a new agent key',
    description:
      'Mint a per-agent nx_live_… or nx_test_… key with a policy envelope ' +
      '(perTxCapUsd, perDayCapUsd, endpointAllowlist, humanApprovalThresholdUsd, expiresAt). ' +
      'Surface for end-users wiring their own agents.',
    endpoint: '/agent/keys',
    method: 'POST',
    auth: 'session',
    pricing: { currency: 'USD', min: 0, typical: 0 },
  },
];

wellknownRoutes.get('/x402-catalog', (c) => {
  const issuer = env.NODE_ENV === 'production' ? 'nexa.aiso.tools' : `localhost:${env.API_PORT}`;
  return c.json({
    version: '1.0',
    issuer,
    name: 'NEXA Neo Bank',
    description:
      'Crypto-rails neobank for humans and agents on one ledger. Discoverable agent commerce via ' +
      'x402 + MCP. Settlements on Base USDC + EURC; cross-chain to Solana via Mayan.',
    contact: 'hello@nexa.aiso.tools',
    docs: `https://${issuer}/v1/openapi.json`,
    mcp: `https://${issuer}/mcp`,
    x402: `https://${issuer}/x402/pay`,
    products: CATALOG_PRODUCTS,
  });
});

/**
 * MAZE developers.html — provider ecosystem hydrator.
 *
 * Loads <nexa-provider-card> + <nexa-provenance-drawer> so the docs page can
 * render the same 18-integration grid the app's s28 transparency hub shows.
 * Reuses /api/system/providers as the single source of truth.
 */

import { nexaApi, type ProviderRegistryEntryWire } from '@/lib/api.js';
import '@/components/nexa-source-badge.js';
import '@/components/nexa-provider-card.js';

/* Lazy-load the drawer on first card click. */
let drawerLoader: Promise<typeof import('@/components/nexa-provenance-drawer.js')> | null = null;
async function ensureProvenanceDrawer(): Promise<import('@/components/nexa-provenance-drawer.js').NexaProvenanceDrawer> {
  if (!drawerLoader) drawerLoader = import('@/components/nexa-provenance-drawer.js');
  const mod = await drawerLoader;
  return mod.ensureProvenanceDrawer();
}

const SUMMARY: Record<string, string> = {
  privy: 'Wallet provisioning and passkey auth for users and agents.',
  alchemy: 'EIP-7702 gas sponsorship + Wallet API on Base.',
  stripe: 'Hosted Crypto Onramp from card to USDC on Base.',
  monerium: 'EU IBAN paired with EURe on Gnosis. SEPA in, redeem out.',
  bridge: 'US bank rails — ACH, wire. Awaiting KYB approval.',
  socket: 'Cross-chain bridge aggregator.',
  lifi: 'Bridge aggregator. Live route when Socket is unconfigured.',
  mayan: 'Mayan Swift cross-chain quotes and execute between Solana and EVM.',
  cctp: 'Circle native USDC bridge. Scaffolded; live wiring next.',
  aave: 'On-chain USDC supply rate from Aave v3 on Base.',
  compound: 'Compound III USDC supply rate, on-chain read.',
  'morpho-standard': 'Steakhouse-curated USDC vault on Base.',
  'morpho-high-yield': 'bbqUSDC — Ethena-powered, Steakhouse-curated.',
  yousd: 'yoUSD realised APY from api.yo.xyz.',
  marinade: 'Solana liquid SOL staking, APY, stake, and instant unstake.',
  'gnosis-pay': 'EU Visa card issuer on Gnosis chain.',
  sponge: 'US debit card issuer.',
  hyperliquid: 'Perpetual futures DEX. Public reads live.',
  polymarket: 'Prediction market CLOB. Public reads live.',
  x402: 'Coinbase x402 micropayments for agents.',
  sumsub: 'KYC / liveness checks.',
  resend: 'Transactional email.',
  sentry: 'Error reporting and traces.',
  postgres: 'Durable ledger.',
  redis: 'BullMQ worker queues.',
};

async function hydrate(): Promise<void> {
  const grid = document.getElementById('devProviderGrid');
  if (!grid) return;
  try {
    const res = await nexaApi.systemProviders();
    grid.textContent = '';
    const order: Record<string, number> = {
      live: 0, sandbox: 1, gated: 2, 'docs-only': 3, 'missing-keys': 4, disabled: 5,
    };
    const sorted = [...res.providers]
      .filter((p: ProviderRegistryEntryWire) => p.status !== 'disabled')
      .sort((a, b) => {
        const sa = order[a.status] ?? 9;
        const sb = order[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return a.name.localeCompare(b.name);
      });
    for (const p of sorted) {
      const card = document.createElement('nexa-provider-card');
      card.setAttribute('provider', p.id);
      card.setAttribute('name', p.name);
      card.setAttribute('category', p.category);
      card.setAttribute('status', p.status);
      if (p.publicDocsUrl) card.setAttribute('docs-url', p.publicDocsUrl);
      if (p.lastCheckedAt) card.setAttribute('last-fetch', p.lastCheckedAt);
      const oneLiner = SUMMARY[p.id] ?? p.notes ?? '';
      if (oneLiner) card.setAttribute('summary', oneLiner);
      card.setAttribute('drawer-target', p.id);
      card.addEventListener('click', async (e) => {
        const link = (e.target as HTMLElement | null)?.closest?.('a');
        if (link) return;
        const drawer = await ensureProvenanceDrawer();
        drawer.open({
          provider: p.id,
          name: p.name,
          category: p.category,
          status: p.status,
          summary: oneLiner,
          docsUrl: p.publicDocsUrl ?? undefined,
          fetchedAt: p.lastCheckedAt,
          endpoint: p.envVars.length ? `Env: ${p.envVars.join(', ')}` : undefined,
          notes: p.notes,
        });
      });
      grid.appendChild(card);
    }
  } catch {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-family:var(--mono);color:var(--meta);font-size:12px;letter-spacing:.08em';
    empty.textContent = 'Provider registry unreachable. Try `GET /v1/system/providers` directly.';
    grid.appendChild(empty);
  }
}

void hydrate();

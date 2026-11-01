/**
 * NEXA app engine — TypeScript port of app-v2.html's interaction script
 * (design contract lines 1032-1548). One ledger, hash router, real
 * interactions. Behavior is 1:1 with the prototype, with three deliberate fixes:
 *
 *   1. Activity rows / created-agent rows are DOM-built (textContent), not
 *      innerHTML — the prototype interpolated user input (recipient names)
 *      into innerHTML, an XSS vector.
 *   2. go() closes any open sheet/overlay — in the prototype, navigating from
 *      a sheet left it open over the next screen.
 *   3. The review-sidebar data-nav handling is gone (sidebar is prototype
 *      chrome, removed in production); Agents is reachable via Profile sheet.
 *
 * Phase D will swap the ledger mutations for API calls — IDs and the data-*
 * contract stay stable for that.
 */

import { bootGlobesIn } from '@/lib/globe.js';
import { svg } from '@/lib/svg.js';
import { on, onGlobal, resetMount } from '@/lib/dom.js';
import { BRAND_PATHS } from '@/lib/brand-icons.js';
import { registerMazeServiceWorker } from '@/lib/pwa.js';
import {
  API_BASE,
  ApiFailure,
  getToken,
  hasSessionHint,
  nexaApi,
  openActivityStream,
  setToken,
  shouldResetMarketOrderAttempt,
  type CardsBuyInput,
  type CollectorCardWire,
  type EarnAdapterSummary,
  type MarketPositionStatusWire,
  type MarketPositionWire,
  type PortfolioBalancesResponse,
  type PortfolioSummaryResponse,
  type ProviderRegistryEntryWire,
  type PushSubscriptionPayload,
  type ServerActivity,
  type SpendMonthlyResponse,
  type SourcedValueMetaWire,
} from '@/lib/api.js';
import { reconcileKeyedList } from '@/lib/list-reconcile.js';
import { paintListSkeleton } from '@/lib/list-skeleton.js';
import type { ApiKey, ApiKeyCreated } from '@nexa/shared-zod';
import {
  WsTransport,
  privAccountTopic,
  privFillsTopic,
  tickerTopic,
  type AccountEvent,
  type FeedEvent,
  type FillEvent,
  type Topic,
} from '@nexa/realtime-client';
import '@/components/region-pill.js';
import { isRegionBlocked, regionFromStorage } from '@/components/region-pill.js';
import '@/components/nexa-source-badge.js';
import '@/components/nexa-provider-card.js';
import '@/components/nexa-state-bar.js';
import '@/components/nexa-yield-ramp.js';
import '@/components/nexa-market-row.js';
import { dotMarkSvgElement } from '@/components/nexa-dot-mark.js';
import type { NexaYieldRamp, YieldSegment } from '@/components/nexa-yield-ramp.js';

/* Lazy-load the provenance drawer the first time anything wants to open it.
   Saves ~13KB on initial paint — the drawer is only shown after a click. */
let provenanceDrawerLoader: Promise<typeof import('@/components/nexa-provenance-drawer.js')> | null = null;
async function ensureProvenanceDrawer(): Promise<import('@/components/nexa-provenance-drawer.js').NexaProvenanceDrawer> {
  if (!provenanceDrawerLoader) {
    provenanceDrawerLoader = import('@/components/nexa-provenance-drawer.js');
  }
  const mod = await provenanceDrawerLoader;
  return mod.ensureProvenanceDrawer();
}

const RM = document.documentElement.classList.contains('rm');
function rateLimitBackoffMs(e: ApiFailure, fallbackMs: number): number {
  return e.retryAfterMs != null && e.retryAfterMs > 0 ? e.retryAfterMs : fallbackMs;
}

function orderSubmitRateLimitMs(e: unknown, fallbackMs = 30_000): number | null {
  if (!(e instanceof ApiFailure)) return null;
  if (e.status !== 429 && e.code !== 'too_many_requests') return null;
  return rateLimitBackoffMs(e, fallbackMs);
}

function lockSubmitButtonForRateLimit(btn: HTMLButtonElement, label: string, retryAfterMs: number): void {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  btn.disabled = true;
  btn.textContent = `Retry in ${seconds}s`;
  window.setTimeout(() => {
    btn.disabled = false;
    btn.textContent = label;
  }, retryAfterMs);
}

const navWithStandalone = navigator as Navigator & { standalone?: boolean };
if (window.matchMedia('(display-mode: standalone)').matches || navWithStandalone.standalone === true) {
  document.documentElement.classList.add('standalone');
}
const configuredPayLinkBase = import.meta.env.VITE_MAZE_PAY_BASE_URL?.trim().replace(/\/+$/, '');
const PAY_LINK_BASE = configuredPayLinkBase || 'https://maze.to/pay';
/** NEO terminal deep-link base. Detail sheets show an "Open advanced
 *  terminal" button that links here. Default is the public Expo web build;
 *  the env var lets QA point at a preview channel. Empty string disables
 *  the button entirely. */
const NEO_TERMINAL_BASE = (() => {
  const raw = (import.meta.env['VITE_NEO_TERMINAL_URL'] as string | undefined)?.trim().replace(/\/+$/, '') ?? '';
  if (raw === '' || raw === '0' || raw === 'false') return '';
  return raw || 'https://neo.aiso.tools';
})();
function openNeoTerminal(path: string): void {
  if (!NEO_TERMINAL_BASE) return;
  const url = `${NEO_TERMINAL_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  // On mobile UA, expo-router maps https URLs to the installed app via
  // universal links. We don't try a `nexa://` deep-link first — that would
  // require the app to be installed AND registered, and a wrong-app prompt
  // is worse than a web fallback that always works.
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    window.location.href = url;
  }
}
function copyableApiBase(): string {
  const base = API_BASE.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(base)) return base;
  if (typeof window === 'undefined') return 'https://api.maze.bank';
  return new URL(base || '/api', window.location.origin).toString().replace(/\/+$/, '');
}
const MCP_API_BASE = copyableApiBase();

/**
 * LIVE mode — when a session exists and the API answers, the server ledger is
 * the source of truth (mutations call the API, then sync). Signed-out users see
 * no fake balances unless an explicit local demo ledger is requested.
 */
let LIVE = false;

function $<T extends HTMLElement = HTMLElement>(sel: string, ctx: ParentNode = document): T {
  const el = ctx.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}
function $$<T extends HTMLElement = HTMLElement>(sel: string, ctx: ParentNode = document): T[] {
  return Array.from(ctx.querySelectorAll<T>(sel));
}

/* ── ledger (single source of truth) ── */
type TxKind = 'in' | 'out' | 'card' | 'agent' | 'swap' | 'x402' | 'amazon' | 'spotify' | 'uber';
interface TxRow {
  id?: string;
  n: string;
  s: string;
  a: string;
  k: TxKind;
  pos?: boolean;
  logo?: string;
  at?: string;
  status?: string;
  venue?: string;
  signer?: string;
  txHash?: string;
  chain?: string;
  explorerUrl?: string;
}
const L = {
  bal: null as number | null,
  earnPos: null as number | null,
  spentAg: 0,
  capAg: 50,
  sendAmt: 0,
  sendTo: '',
  sendNew: true,
  fresh: false,
  homeLoaded: false,
  frozen: false,
  killed: false,
  activity: [] as TxRow[],
};

const LOCAL_DEMO_LEDGER_KEY = 'nexa.localDemoLedger';

function shouldUseLocalDemoLedger(): boolean {
  try {
    return sessionStorage.getItem(LOCAL_DEMO_LEDGER_KEY) === '1';
  } catch {
    return false;
  }
}

function seedLocalDemoLedger(): void {
  L.bal = 4820.4;
  L.earnPos = 3200;
  L.spentAg = 13.2;
  L.capAg = 50;
  L.sendAmt = 20;
  L.sendTo = 'bob@x.com';
  L.fresh = false;
  L.activity = [
    { n: 'Salary · Acme Studio', s: 'ACH · TODAY', a: '+$2,400.00', k: 'in', pos: true, logo: 'S' },
    { n: 'api.exa.ai', s: 'AGENT · POLICY OK', a: '-$0.12', k: 'x402', logo: 'AI' },
  ];
}

if (shouldUseLocalDemoLedger()) seedLocalDemoLedger();

const ICO: Record<string, string> = {
  in: '<path d="M17 7 7 17M15 17H7V9"/>',
  out: '<path d="M7 17 17 7M9 7h8v8"/>',
  card: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18"/>',
  agent: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9.5 12h5M12 9.5v5"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
};

/* Official brand marks injected into [data-brand] placeholders (see brand-icons). */
function fillBrands(ctx: ParentNode = document): void {
  ctx.querySelectorAll<HTMLElement>('[data-brand]').forEach((el) => {
    if (el.childElementCount) return;
    const path = BRAND_PATHS[el.getAttribute('data-brand') ?? ''];
    if (!path) return;
    el.appendChild(
      svg(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`),
    );
  });
}

function money(v: number | null): string {
  if (v == null) return '…';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let earnApyBps: number | null = null;
let earnApySourced: SourcedValueMetaWire | null = null;
let swapQuoteSourced: SourcedValueMetaWire | null = null;

/**
 * Sprint 15 — paint a <nexa-source-badge> element from a SourcedValueMeta
 * envelope. Hides the badge when `meta` is null so screens degrade cleanly
 * outside live mode.
 */
function applySourceBadge(
  el: HTMLElement | null,
  meta: SourcedValueMetaWire | null,
): void {
  if (!el) return;
  if (!meta) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.setAttribute('source', meta.source);
  el.setAttribute('provider', meta.provider);
  if (meta.fetchedAt) {
    el.setAttribute('fetched-at', meta.fetchedAt);
  } else {
    el.removeAttribute('fetched-at');
  }
  if (meta.docsUrl) {
    el.setAttribute('docs-url', meta.docsUrl);
  } else {
    el.removeAttribute('docs-url');
  }
  if (meta.errorCode) {
    el.setAttribute('error-code', meta.errorCode);
  } else {
    el.removeAttribute('error-code');
  }
  if (meta.errorMessage) {
    el.setAttribute('error-message', meta.errorMessage);
  } else {
    el.removeAttribute('error-message');
  }
}

interface CardViewState {
  last4: string | null;
  network: string | null;
  kind?: string;
  frozen: boolean;
  dayLimitUsd: number;
  demo?: boolean;
}

let cardView: CardViewState | null = null;

interface AccountViewState {
  us?: { number: string | null; routing: string | null } | null;
  eu?: { iban: string | null; bic?: string | null } | null;
}

let accountView: AccountViewState = {};

interface WalletViewState {
  baseAddress?: string | null;
  solanaAddress?: string | null;
}

let walletView: WalletViewState = {};
let portfolioBalances: PortfolioBalancesResponse | null = null;
let portfolioSummaryView: PortfolioSummaryResponse | null = null;
let portfolioSummaryFetchedAt = 0;
let receiveUserEmail: string | null = null;
let activationView = { kyc: false, funded: false, agent: false };
let spendInsight: SpendMonthlyResponse | null = null;

function apyLabel(bps: number | null): string {
  if (bps == null || bps <= 0) return 'APY unavailable';
  return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% APY`;
}

function projectedYield(amountUsd: number | null, signed = false): string {
  if (amountUsd == null) return '…';
  if (earnApyBps == null || earnApyBps <= 0) return 'Live APY pending';
  const projected = money(amountUsd * (earnApyBps / 10000));
  return signed ? `≈ +${projected.slice(1)}` : `≈ ${projected}`;
}

function renderEarnYield(): void {
  document.querySelectorAll<HTMLElement>('[data-earn-apy]').forEach((el) => {
    // The header pill shows the user's own blended rate; label it so it
    // doesn't read as a contradiction next to per-protocol "up to" rates.
    el.textContent = el.id === 'earnApyTag' && earnApyBps
      ? `Your rate · ${apyLabel(earnApyBps)}`
      : apyLabel(earnApyBps);
  });
  const earnProj = document.getElementById('earnProj');
  if (earnProj) earnProj.textContent = projectedYield(L.earnPos);
  const depRange = document.getElementById('depRange') as HTMLInputElement | null;
  const depProj = document.getElementById('depProj');
  if (depProj && depRange) depProj.textContent = projectedYield(Number(depRange.value), true);
  const example = document.querySelector<HTMLElement>('[data-earn-example]');
  if (example) example.textContent = projectedYield(5000);
  // Sprint 15 — paint source badges next to every APY tile that owns one.
  document
    .querySelectorAll<HTMLElement>('[data-earn-apy-source]')
    .forEach((el) => applySourceBadge(el, earnApySourced));
}

const EARN_PROTOCOL_LABELS: Record<string, { name: string; docsUrl: string; endpoint: string; summary: string }> = {
  morpho: {
    name: 'Morpho · Standard',
    docsUrl: 'https://docs.morpho.org',
    endpoint: 'Morpho V1 GraphQL · vaultByAddress.state.netApy',
    summary: 'Steakhouse-curated USDC vault on Base. Parity with Coinbase USDC Prime.',
  },
  'morpho-high-yield': {
    name: 'Morpho · High Yield',
    docsUrl: 'https://docs.morpho.org',
    endpoint: 'Morpho V1 GraphQL · bbqUSDC vault',
    summary: 'bbqUSDC, Steakhouse-curated, Ethena-powered. Parity with Coinbase USDC High Yield.',
  },
  aave: {
    name: 'Aave v3',
    docsUrl: 'https://aave.com/docs',
    endpoint: 'Base · Pool.getReserveData(USDC).currentLiquidityRate',
    summary: 'On-chain read from Aave v3 USDC reserve on Base.',
  },
  compound: {
    name: 'Compound III',
    docsUrl: 'https://docs.compound.finance',
    endpoint: 'Base · Comet.getSupplyRate(getUtilization())',
    summary: 'Compound III USDC supply rate, on-chain read on Base.',
  },
  yousd: {
    name: 'yoUSD',
    docsUrl: 'https://yo.xyz',
    endpoint: 'api.yo.xyz/api/v1/vault/yield/timeseries, last entry',
    summary: 'yoUSD realised APY from the public timeseries endpoint.',
  },
  marinade: {
    name: 'Marinade · SOL',
    docsUrl: 'https://docs.marinade.finance',
    endpoint: 'api.marinade.finance/msol/apy/30d',
    summary: 'Marinade Finance Solana liquid SOL staking, 30-day rolling APY.',
  },
};

function renderEarnProtocolRows(protocols: EarnAdapterSummary[]): void {
  for (const p of protocols) {
    const row = document.querySelector<HTMLElement>(`[data-earn-protocol="${p.name}"]`);
    if (!row) continue;
    const apy = row.querySelector<HTMLElement>('.num');
    if (apy) apy.textContent = p.available ? apyLabel(p.apyBps) : 'Unavailable';
    const sub = row.querySelector<HTMLElement>('.s');
    if (sub) sub.textContent = `${sub.textContent?.replace(/\s·\s(LIVE|UNAVAILABLE).*$/, '') ?? ''} · ${p.available ? 'LIVE RATE' : 'UNAVAILABLE'}`;
    // Sprint 15 — each protocol row owns its own source badge so the user
    // can read "Live · Morpho · 12s ago" alongside the rate.
    const badge = row.querySelector<HTMLElement>('nexa-source-badge');
    applySourceBadge(badge, p.sourced ?? null);
  }
}

/** Maps an earn protocol id to its official ICON-only logo under
   /public/integrations/{name}-icon.svg. Square crops render properly in the
   18×18 legend slot; wordmarks live in the landing trust strip only. */
const APP_EARN_LOGO_URLS: Record<string, string> = {
  morpho: '/integrations/morpho-icon.svg',
  'morpho-high-yield': '/integrations/morpho-icon.svg',
  aave: '/integrations/aave.svg',
  compound: '/integrations/compound-icon.svg',
  yousd: '/integrations/yousd.png',
  marinade: '/integrations/marinade-icon.svg',
  ethena: '/integrations/ethena.svg',
};

/** Sprint 16 — paint the s14 <nexa-yield-ramp> from the adapter list. */
function renderYieldRamp(protocols: EarnAdapterSummary[], blendedBps: number): void {
  const ramp = document.getElementById('earnYieldRamp') as NexaYieldRamp | null;
  if (!ramp) return;
  const segments: YieldSegment[] = [];
  for (const p of protocols) {
    if (!p.available || p.apyBps <= 0) continue;
    const meta = EARN_PROTOCOL_LABELS[p.name];
    const source = p.sourced?.source ?? (p.isLive ? 'live' : 'unavailable');
    const logoUrl = APP_EARN_LOGO_URLS[p.name];
    segments.push({
      name: meta?.name ?? p.name.toUpperCase(),
      apyBps: p.apyBps,
      weight: 1,
      source: source as YieldSegment['source'],
      fetchedAt: p.sourced?.fetchedAt ?? null,
      docsUrl: meta?.docsUrl ?? p.sourced?.docsUrl,
      ...(logoUrl ? { logoUrl } : {}),
    });
  }
  if (segments.length === 0) {
    ramp.segments = [];
    ramp.setAttribute('caption', 'No live sources yet');
    return;
  }
  // Re-weight so width = APY contribution share (heavier APY → wider segment).
  const totalApy = segments.reduce((a, s) => a + s.apyBps, 0);
  for (const s of segments) s.weight = s.apyBps / totalApy;
  ramp.segments = segments;
  if (blendedBps > 0) ramp.setAttribute('blended-bps', String(blendedBps));
  else ramp.removeAttribute('blended-bps');
  const live = segments.filter((s) => s.source === 'live').length;
  ramp.setAttribute(
    'caption',
    live === segments.length
      ? `${segments.length} of ${segments.length} sources live`
      : `${live} of ${segments.length} sources live`,
  );
}

/** Open the provenance drawer for an Earn protocol row. */
async function openEarnProtocolDrawer(protocolKey: string, summary: EarnAdapterSummary | undefined): Promise<void> {
  const meta = EARN_PROTOCOL_LABELS[protocolKey];
  const drawer = await ensureProvenanceDrawer();
  const status =
    summary?.sourced?.source ?? (summary?.isLive ? 'live' : 'unavailable');
  const metric = summary && summary.apyBps > 0 ? `${(summary.apyBps / 100).toFixed(2)}% APY` : undefined;
  drawer.open({
    provider: protocolKey,
    name: meta?.name ?? protocolKey,
    category: 'defi-yield',
    status: status as ProvenanceArg,
    summary: meta?.summary,
    docsUrl: meta?.docsUrl ?? summary?.sourced?.docsUrl,
    endpoint: meta?.endpoint,
    fetchedAt: summary?.sourced?.fetchedAt ?? null,
    metric,
  });
}

type ProvenanceArg =
  | 'live' | 'sandbox' | 'gated' | 'docs-only' | 'missing-keys'
  | 'disabled' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error';

let earnProtocolDelegated = false;
function wireEarnProtocolClicks(): void {
  if (earnProtocolDelegated) return;
  const list = document.getElementById('earnProtocolList');
  if (!list) return;
  earnProtocolDelegated = true;
  on(list, 'click', (e) => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-earn-protocol]');
    if (!row) return;
    const key = row.getAttribute('data-earn-protocol');
    if (!key) return;
    if (key === 'ethena') {
      openEthenaDepositSheet();
      return;
    }
    const cached = lastEarnProtocols.find((p) => p.name === key);
    openEarnProtocolDrawer(key, cached);
  });
}

/**
 * Ethena tile click — opens a sheet showing live APY, risk copy, and a CTA
 * that opens ethena.fi in a new tab for the actual deposit. NEXA never
 * custodies sUSDe at this phase; users sign at Ethena directly.
 */
function openEthenaDepositSheet(): void {
  const apyPct = (ethenaTile.apyBps / 100).toFixed(2);
  openReviewSheet({
    eyebrow: 'Ethena · sUSDe',
    amount: `${apyPct}% APY`,
    rows: [
      { k: 'Strategy', v: 'Synthetic dollar, delta-neutral perps' },
      { k: 'Custody', v: 'Ethena (not NEXA)' },
      { k: 'Underlying', v: 'sUSDe (ERC-4626)' },
      { k: 'TVL', v: '$5B+' },
    ],
    badge: { source: 'live', provider: 'Ethena · sUSDe', docsUrl: 'https://docs.ethena.fi' },
    finePrint: ethenaTile.riskCopy,
    confirmLabel: 'Open ethena.fi to deposit',
    onConfirm: () => {
      window.open(ethenaTile.depositUrl, '_blank', 'noopener,noreferrer');
    },
  });
}

let lastEarnProtocols: EarnAdapterSummary[] = [];

/**
 * Visitor-mode provider demo fallback. It is replaced by /api/earn/protocols
 * once the user is authenticated.
 */
const EARN_FALLBACK_SNAPSHOT: EarnAdapterSummary[] = [
  { name: 'morpho', apyBps: 323, isLive: true, available: true, sourced: { source: 'provider-demo', provider: 'Morpho · Standard', fetchedAt: null, docsUrl: 'https://docs.morpho.org' } },
  { name: 'morpho-high-yield', apyBps: 526, isLive: true, available: true, sourced: { source: 'provider-demo', provider: 'Morpho · High Yield', fetchedAt: null, docsUrl: 'https://docs.morpho.org' } },
  { name: 'aave', apyBps: 321, isLive: true, available: true, sourced: { source: 'provider-demo', provider: 'Aave v3', fetchedAt: null, docsUrl: 'https://aave.com/docs' } },
  { name: 'compound', apyBps: 322, isLive: true, available: true, sourced: { source: 'provider-demo', provider: 'Compound III', fetchedAt: null, docsUrl: 'https://docs.compound.finance' } },
  { name: 'yousd', apyBps: 480, isLive: true, available: true, sourced: { source: 'provider-demo', provider: 'yoUSD', fetchedAt: null, docsUrl: 'https://yo.xyz' } },
  { name: 'marinade', apyBps: 607, isLive: true, available: true, sourced: { source: 'provider-demo', provider: 'Marinade', fetchedAt: null, docsUrl: 'https://docs.marinade.finance' } },
  // Ethena = "Aggressive · Synthetic Dollar" headline tile. APY is dynamic (12-25%)
  // depending on perp funding rates; demo fallback anchors the preview value and
  // is replaced by the live read in syncEarnEthena() shortly after sync. The
  // row's click handler diverts to a deposit-at-ethena.fi sheet — no in-app
  // deposit path exists yet (deferred to Phase 2 once swap-then-stake batch is wired).
  { name: 'ethena', apyBps: 1800, isLive: true, available: true, sourced: { source: 'provider-demo', provider: 'Ethena · sUSDe', fetchedAt: null, docsUrl: 'https://ethena.fi' } },
];

/** Live Ethena tile state — replaced by syncEarnEthena() once the read succeeds. */
let ethenaTile: { apyBps: number; depositUrl: string; riskCopy: string } = {
  apyBps: 1800,
  depositUrl: 'https://app.ethena.fi/buy',
  riskCopy:
    'Synthetic dollar. Yield from perp funding rates. Can go negative when funding flips. Custody stays at ethena.fi. NEXA never holds your sUSDe.',
};

/* ── Best-yield landing ────────────────────────────────────────────────
   Renders the per-asset top venue inside #earnLandingList on the Earn
   screen (s14). Backend `/earn/landing` is public, so this hydrates for
   signed-out users too. Native rows route to the in-app deposit flow;
   deeplink rows open the venue's own URL. */

interface EarnLandingPick {
  asset: string;
  venue: string;
  chain: string;
  apyBps: number;
  apyBaseBps: number | null;
  apyRewardBps: number | null;
  tvlUsd: number | null;
  url: string | null;
  mode: 'native' | 'deeplink' | 'informational';
  riskBand: 'A' | 'B' | 'C';
  note?: string;
}
interface EarnLandingAsset {
  asset: 'USDC' | 'USDT' | 'SOL' | 'BTC' | 'ETH' | 'sUSDe';
  picks: EarnLandingPick[];
  bestApyBps: number;
  bestNative: EarnLandingPick | null;
  readAt: string;
}

const LANDING_ASSET_LABEL: Record<EarnLandingAsset['asset'], string> = {
  USDC: 'USDC stablecoin',
  USDT: 'USDT stablecoin',
  SOL: 'Solana',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  sUSDe: 'Ethena sUSDe',
};
const LANDING_ASSET_SUBTITLE: Record<EarnLandingAsset['asset'], string> = {
  USDC: 'Lend USDC',
  USDT: 'Lend USDT',
  SOL: 'Stake or lend SOL',
  BTC: 'Lend WBTC / cbBTC',
  ETH: 'Lend wETH',
  sUSDe: 'Synthetic dollar yield',
};

function formatApy(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

function formatLandingTvl(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return '';
  if (usd >= 1e9) return `· $${(usd / 1e9).toFixed(1)}B TVL`;
  if (usd >= 1e6) return `· $${(usd / 1e6).toFixed(0)}M TVL`;
  if (usd >= 1e3) return `· $${(usd / 1e3).toFixed(0)}K TVL`;
  return `· $${usd.toFixed(0)} TVL`;
}

/* Build a single row inside the landing card. `kind` controls labeling +
   subtitle context:
     'top'        — best APY overall for this asset; could be deeplink or native
     'in-app'     — secondary row shown when the top is a deeplink and we have
                    a meaningfully different native option
     'only'       — only one row needed (top IS native, or no native exists) */
function buildLandingRow(
  asset: EarnLandingAsset['asset'],
  pick: EarnLandingPick,
  kind: 'top' | 'in-app' | 'only',
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lrow';
  row.style.cursor = 'pointer';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.setAttribute('data-earn-asset', asset);
  row.setAttribute('data-earn-kind', kind);

  const grow = document.createElement('span');
  grow.className = 'grow';
  const title = document.createElement('span');
  title.className = 't';
  title.style.fontWeight = '600';
  // For the secondary in-app row, prepend "In-app: " so users see it's the
  // app-resident counterpart to the top-of-market deeplink row above.
  const prefix = kind === 'in-app' ? 'In-app · ' : '';
  title.textContent = `${prefix}${LANDING_ASSET_LABEL[asset]} · ${pick.venue}`;
  grow.appendChild(title);
  grow.appendChild(document.createElement('br'));
  const sub = document.createElement('span');
  sub.className = 's';
  const chainLabel = pick.chain ? pick.chain.toUpperCase() : '';
  const tvlLabel = formatLandingTvl(pick.tvlUsd);
  sub.textContent = `${LANDING_ASSET_SUBTITLE[asset]} · ${chainLabel} ${tvlLabel}`.trim();
  grow.appendChild(sub);
  row.appendChild(grow);

  const num = document.createElement('span');
  num.className = 'num';
  num.style.fontVariantNumeric = 'tabular-nums';
  num.style.fontWeight = '600';
  num.style.color = 'var(--success)';
  num.textContent = formatApy(pick.apyBps);
  row.appendChild(num);

  const mode = document.createElement('span');
  mode.className = 'tag';
  mode.style.marginLeft = '8px';
  mode.style.fontSize = '10px';
  if (pick.mode === 'native') {
    mode.classList.add('ok');
    mode.textContent = 'EARN';
  } else {
    mode.textContent = 'OPEN ↗';
  }
  row.appendChild(mode);

  on(row, 'click', () => {
    if (pick.mode === 'native') {
      // In-app deposit flow. Best-effort routing by asset: SOL → s14b
      // (SOL staking), everything else → s14a (stablecoin yields).
      if (asset === 'SOL') {
        go('s14b');
      } else {
        go('s14a');
      }
    } else if (pick.url) {
      window.open(pick.url, '_blank', 'noopener,noreferrer');
    }
  });

  return row;
}

function renderEarnLanding(landscape: EarnLandingAsset[]): void {
  const host = document.getElementById('earnLandingList');
  if (!host) return;
  host.textContent = '';
  if (!landscape.length) {
    const empty = document.createElement('div');
    empty.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = 'Yield landscape unavailable.';
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = 'Retry in a moment.';
    grow.appendChild(s);
    empty.appendChild(grow);
    host.appendChild(empty);
    return;
  }
  for (const a of landscape) {
    const top = a.picks[0];
    if (!top || !(top.apyBps > 0)) continue;
    // Decide row layout: if the top pick is already native OR there's no
    // native option for this asset, render one row. Otherwise render the
    // top market row PLUS the best native row underneath so users always
    // see what they can earn in-app right now.
    const topIsNative = top.mode === 'native';
    const hasNative = a.bestNative != null && a.bestNative.apyBps > 0;
    const showSecondary = !topIsNative && hasNative;
    host.appendChild(buildLandingRow(a.asset, top, showSecondary ? 'top' : 'only'));
    if (showSecondary && a.bestNative) {
      host.appendChild(buildLandingRow(a.asset, a.bestNative, 'in-app'));
    }
  }
}

let lastEarnLanding: EarnLandingAsset[] = [];
let syncEarnLandingInflight: Promise<void> | null = null;
function syncEarnLanding(): Promise<void> {
  if (syncEarnLandingInflight) return syncEarnLandingInflight;
  syncEarnLandingInflight = (async () => {
    try {
      const res = await nexaApi.earnLanding();
      lastEarnLanding = res.landscape as EarnLandingAsset[];
      renderEarnLanding(lastEarnLanding);
    } catch {
      renderEarnLanding([]);
    }
  })().finally(() => {
    syncEarnLandingInflight = null;
  });
  return syncEarnLandingInflight;
}

let syncEthenaInflight: Promise<void> | null = null;
function syncEarnEthena(): Promise<void> {
  if (syncEthenaInflight) return syncEthenaInflight;
  syncEthenaInflight = (async () => {
    try {
      const res = await nexaApi.earnEthena();
      ethenaTile = {
        apyBps: res.apyBps,
        depositUrl: res.depositUrl,
        riskCopy: res.riskCopy,
      };
      // Patch the live snapshot so the next render reflects the latest APY.
      const idx = lastEarnProtocols.findIndex((p) => p.name === 'ethena');
      if (idx >= 0 && lastEarnProtocols[idx]) {
        lastEarnProtocols[idx] = {
          ...lastEarnProtocols[idx]!,
          apyBps: res.apyBps,
          sourced: { source: 'live', provider: 'Ethena · sUSDe', fetchedAt: res.readAt, docsUrl: 'https://ethena.fi' },
        };
        renderEarnProtocolRows(lastEarnProtocols);
      }
    } catch {
      /* silent — fallback snapshot value stays */
    }
  })().finally(() => {
    syncEthenaInflight = null;
  });
  return syncEthenaInflight;
}

function blendedFromAdapters(adapters: EarnAdapterSummary[]): number {
  const live = adapters.filter((a) => a.available && a.apyBps > 0);
  if (!live.length) return 0;
  const total = live.reduce((a, p) => a + p.apyBps, 0);
  return Math.round(total / live.length);
}

let syncEarnInflight: Promise<void> | null = null;
function syncEarnProtocols(): Promise<void> {
  if (syncEarnInflight) return syncEarnInflight;
  syncEarnInflight = syncEarnProtocolsImpl().finally(() => {
    syncEarnInflight = null;
  });
  return syncEarnInflight;
}

async function syncEarnProtocolsImpl(): Promise<void> {
  // Visitors get a provider demo APY snapshot without hitting the authenticated route;
  // signed-in sessions replace it with live adapter data.
  let protocols: EarnAdapterSummary[] | null = null;
  let blendedBps = 0;
  let badgeMeta: SourcedValueMetaWire | null = null;
  if (getToken()) {
    try {
      const res = await nexaApi.earnProtocols();
      protocols = res.adapters;
      blendedBps = res.blendedApy;
      badgeMeta = res.standard.sourced ?? res.sourced ?? null;
    } catch {
      /* fall through to snapshot */
    }
  }
  if (!protocols || protocols.length === 0) {
    protocols = EARN_FALLBACK_SNAPSHOT;
    blendedBps = blendedFromAdapters(protocols);
    badgeMeta = { source: 'provider-demo', provider: 'Morpho · Standard', fetchedAt: null };
  }
  earnApyBps = blendedBps > 0 ? blendedBps : null;
  earnApySourced = badgeMeta;
  lastEarnProtocols = protocols;
  renderEarnProtocolRows(protocols);
  renderYieldRamp(protocols, blendedBps);
  wireEarnProtocolClicks();
  renderEarnYield();
  // Fetch the live Ethena APY in the background. Failures are silent — the
  // snapshot value remains visible. Public endpoint, no auth required.
  void syncEarnEthena();
}

function payLink(slug: string): string {
  return `${PAY_LINK_BASE}/${slug}`;
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function isSignedOutEmptyLedger(): boolean {
  return !LIVE && !getToken() && L.bal == null && L.earnPos == null && L.activity.length === 0;
}

function renderBal(): void {
  const signedOutEmpty = isSignedOutEmptyLedger();
  const txt = signedOutEmpty ? '—' : money(L.bal);
  $('#balEl').textContent = txt;
  $('#balMini').textContent = txt;
  const earnTile = document.getElementById('earnTile');
  if (earnTile) earnTile.hidden = signedOutEmpty || (L.bal ?? 0) <= 0;
  const swBal = document.getElementById('swBalLbl');
  if (swBal) {
    swBal.textContent = signedOutEmpty
      ? 'BALANCE —'
      : L.bal == null
        ? 'BALANCE …'
        : `BALANCE ${L.bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

function txLogoEl(r: TxRow): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = 'tx-logo ' + r.k;
  if (r.logo) {
    mark.textContent = r.logo;
  } else {
    mark.appendChild(
      svg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="1.7">${ICO[r.k] ?? ICO['card']}</svg>`,
      ),
    );
  }
  return mark;
}

function cardLabel(card: CardViewState | null): string {
  if (!card?.last4) return 'Unavailable';
  const parts = [card.network ?? 'Card', card.kind ?? 'Debit'];
  if (card.demo) parts.push('Demo');
  return parts.join(' · ');
}

function setCardControls(card: CardViewState | null): void {
  cardView = card;
  L.frozen = Boolean(card?.frozen);
  $('#vCard').classList.toggle('frozen', L.frozen);
  $('#freezeBtn2').textContent = L.frozen ? 'UNFREEZE' : 'FREEZE';
  $('#freezeSw').setAttribute('aria-checked', String(L.frozen));
  $('#dayLimitVal').textContent = '$' + (card?.dayLimitUsd ?? 500).toLocaleString('en-US');

  if (card?.last4) {
    $('#vPan').textContent = `•••• •••• •••• ${card.last4}`;
    $('#vCvv').textContent = cardLabel(card);
    document.querySelectorAll<HTMLElement>('[data-card-last4]').forEach((el) => {
      el.textContent = card.last4 ?? '';
    });
    return;
  }

  $('#vPan').textContent = 'Card not issued';
  $('#vCvv').textContent = 'Unavailable';
  document.querySelectorAll<HTMLElement>('[data-card-last4]').forEach((el) => {
    el.textContent = '';
  });
}

function setTextAll(sel: string, value: string | null | undefined, fallback = 'Unavailable'): void {
  document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
    el.textContent = value || fallback;
  });
}

function setCopyValue(id: string, value: string | null): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return;
  if (value) {
    btn.disabled = false;
    btn.setAttribute('data-copy', value);
  } else {
    btn.disabled = true;
    btn.removeAttribute('data-copy');
  }
}

function receiveHandle(email: string | null): string | null {
  const local = email?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return local || null;
}

function renderReceiveSurface(): void {
  const baseAddress = walletView.baseAddress ?? null;
  const qr = document.getElementById('receiveQr') as HTMLImageElement | null;
  const qrEmpty = document.getElementById('receiveQrEmpty');
  const addrEl = document.getElementById('receiveBaseAddr');
  if (addrEl) addrEl.textContent = baseAddress ?? 'Unavailable';
  if (qr && qrEmpty) {
    qr.hidden = !baseAddress;
    qrEmpty.hidden = Boolean(baseAddress);
    if (baseAddress) {
      qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=172x172&data=${encodeURIComponent(baseAddress)}`;
    } else {
      qr.removeAttribute('src');
    }
  }

  const us = accountView.us;
  const eu = accountView.eu;
  const usCopy = us?.number && us.routing ? `ACH account ${us.number} - routing ${us.routing}` : null;
  const euCopy = eu?.iban ? `IBAN ${eu.iban}${eu.bic ? ` - BIC ${eu.bic}` : ''}` : null;
  const handle = receiveHandle(receiveUserEmail);
  setCopyValue('copyReceiveBase', baseAddress ? `USDC on Base address ${baseAddress}` : null);
  setCopyValue('copyReceiveBank', [usCopy, euCopy].filter(Boolean).join('\n') || null);
  setCopyValue('copyReceiveHandle', handle ? `${payLink(handle)} - MAZE @${handle}` : null);
  // Decentralised builds have no bank rails — hide the bank-deposit card
  // instead of stacking "Unavailable" fields the user can't fix.
  const bankCard = document.getElementById('receiveBankCard');
  if (bankCard) bankCard.hidden = LIVE && !usCopy && !euCopy;
  renderWalletSurface();
  renderAddMoneyCrypto();
}

function baseAddressUrl(address: string): string {
  return `https://basescan.org/address/${address}`;
}

/* ── s09 Add money · crypto rail ──
   The inline app.html script only swaps the template and renders the
   "Loading address..." placeholder; the real deposit address is filled here
   from walletView (Base/ETH share the embedded EVM address, SOL has its own).
   Demo mode keeps fixture addresses so the flow still demos end-to-end. */
const DEMO_DEPOSIT_ADDRESSES: Record<string, string> = {
  solana: '9yDdmq1vcM8cikKE11nmTCkgsJS7VxgV3x3f9SMszNFu',
  base: '0x4f2e8c1d9a1c7b2e5f4d8a3b9c1e2d7f6a5b4c3d',
  ethereum: '0x4f2e8c1d9a1c7b2e5f4d8a3b9c1e2d7f6a5b4c3d',
};

function renderAddMoneyCrypto(): void {
  const detail = document.getElementById('addRailDetail');
  const addrEl = detail?.querySelector<HTMLElement>('#addCryptoAddr');
  const qrEl = detail?.querySelector<HTMLImageElement>('#addCryptoQr');
  if (!detail || !addrEl || !qrEl) return;
  const net = detail.querySelector<HTMLElement>('[data-addnet].onx')?.getAttribute('data-addnet') ?? 'base';
  const address = LIVE
    ? (net === 'solana' ? walletView.solanaAddress : walletView.baseAddress) ?? null
    : DEMO_DEPOSIT_ADDRESSES[net] ?? null;
  if (address) {
    addrEl.textContent = address;
    qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=168x168&data=${encodeURIComponent(address)}`;
    qrEl.style.display = 'block';
    setCopyValue('copyBaseAddr', address);
  } else {
    addrEl.textContent = 'Your wallet is still being created. Check back in a moment.';
    qrEl.removeAttribute('src');
    qrEl.style.display = 'none';
    setCopyValue('copyBaseAddr', null);
  }
}

onGlobal(document, 'click', (e) => {
  const pill = (e.target as HTMLElement).closest<HTMLElement>('#addRailDetail [data-addnet]');
  if (!pill) return;
  // The inline app.html handler toggles .onx first (registered earlier);
  // defer one tick so we read the updated selection.
  window.setTimeout(renderAddMoneyCrypto, 0);
});
// Boot can land directly on #s09. The inline script renders the crypto
// template on DOMContentLoaded, which can fall on either side of this
// module's execution in dev — cover both orderings.
renderAddMoneyCrypto();
if (document.readyState !== 'complete') {
  onGlobal(window, 'load', () => renderAddMoneyCrypto());
}

function renderWalletSurface(): void {
  const baseAddress = walletView.baseAddress ?? null;
  const short = baseAddress ? shortRef(baseAddress) : 'Unavailable';
  const hlSpotUsd = portfolioBalances?.byChain.hyperliquidSpot ?? 0;
  setTextAll('[data-wallet-short]', short);
  setTextAll('[data-wallet-solana]', walletView.solanaAddress, 'Unavailable');
  setTextAll('[data-wallet-hl-spot-addr]', baseAddress, 'Unavailable');
  setTextAll('[data-wallet-hl-spot-bal]', money(hlSpotUsd));
  renderWalletOverview();
  const baseEl = document.getElementById('walletBaseAddr');
  if (baseEl) baseEl.textContent = baseAddress ?? 'Unavailable';
  setCopyValue('copyWalletBase', baseAddress ? `USDC on Base address ${baseAddress}` : null);
  ['earnWalletChip', 'tradeWalletChip'].forEach((id) => {
    const chip = document.getElementById(id);
    if (chip) chip.hidden = !baseAddress;
  });
  const basescan = document.getElementById('walletBasescan') as HTMLAnchorElement | null;
  if (basescan) {
    basescan.hidden = !baseAddress;
    if (baseAddress) basescan.href = baseAddressUrl(baseAddress);
  }
}

async function hydratePortfolioBalances(): Promise<void> {
  if (!LIVE) return;
  try {
    portfolioBalances = await nexaApi.balances();
    activationView.funded = activationView.funded || portfolioBalances.totalUsd > 0;
    renderWalletSurface();
    renderActivation();
  } catch {
    /* wallet balances are best-effort; ledger sync still drives spendability */
  }
}

/**
 * All-assets overview (Wallet s31): on-chain buckets from /balances plus the
 * Hyperliquid perp + HIP-3 equity legs from /markets/portfolio/summary — the
 * two legs the /balances aggregate cannot see. Short TTL: the summary fans
 * out to three HL clearinghouse reads, so screen entry shouldn't refetch on
 * every back-and-forth.
 */
const PORTFOLIO_SUMMARY_TTL_MS = 15_000;

async function hydratePortfolioSummary(force = false): Promise<void> {
  if (!LIVE || !getToken()) return;
  if (!force && portfolioSummaryView && Date.now() - portfolioSummaryFetchedAt < PORTFOLIO_SUMMARY_TTL_MS) {
    renderWalletOverview();
    return;
  }
  try {
    portfolioSummaryView = await nexaApi.markets.portfolioSummary();
    portfolioSummaryFetchedAt = Date.now();
  } catch {
    /* fails soft — the overview renders whatever legs it has */
  }
  renderWalletOverview();
}

function renderWalletOverview(): void {
  const totalEl = document.querySelector<HTMLElement>('[data-wallet-total]');
  if (!totalEl) return;
  const b = portfolioBalances;
  const s = portfolioSummaryView;
  const setRow = (sel: string, usd: number | null | undefined): void => {
    setTextAll(sel, usd == null ? '—' : money(usd));
  };
  setRow('[data-wallet-bucket="cash"]', b?.buckets.cash.usd);
  setRow('[data-wallet-bucket="predictions"]', b?.buckets.predictions.usd);
  setRow('[data-wallet-bucket="memes"]', b?.buckets.memes.usd);
  setRow('[data-wallet-bucket="stocks-spot"]', b?.buckets['stocks-spot']?.usd);
  setRow('[data-wallet-arb-usdc]', b?.buckets.perps.sources?.arbitrum);
  // Own attribute (not data-wallet-hl-spot-bal) — the dedicated HL card below
  // uses that one, and e2e locators are strict about uniqueness.
  setRow('[data-wallet-ov-hl-spot]', b?.byChain['hyperliquidSpot']);
  const hlPerpUsd = s?.legs.hyperliquid === 'ok' ? (s.hyperliquid?.equityUsd ?? 0) : null;
  const hip3Usd = s?.legs.hyperliquidHip3 === 'ok' ? (s.hyperliquidHip3?.equityUsd ?? 0) : null;
  setRow('[data-wallet-hl-perp]', hlPerpUsd);
  setRow('[data-wallet-hip3]', hip3Usd);
  // Total = on-chain USDC (incl. HL spot) + HL perp equity + HIP-3 equity.
  // The app cash ledger is deliberately NOT summed in — it is a separate
  // accounting world (see the labeled line) until ledger reconciliation.
  const totalUsd = b ? b.totalUsd + (hlPerpUsd ?? 0) + (hip3Usd ?? 0) : null;
  totalEl.textContent = totalUsd == null ? '…' : money(totalUsd);
  // Prefer the summary's authoritative cash leg; fall back to the local
  // ledger sync while the summary is still loading.
  const ledgerUsd = s?.cash ? s.cash.balUsd : isSignedOutEmptyLedger() ? null : L.bal;
  setRow('[data-wallet-ledger]', ledgerUsd);
  const degraded = document.querySelector<HTMLElement>('[data-wallet-degraded]');
  if (degraded) {
    const failedLeg =
      s != null && (s.legs.hyperliquid === 'failed' || s.legs.hyperliquidHip3 === 'failed' || s.legs.balances === 'failed');
    degraded.hidden = !failedLeg;
  }
}

/* ── Hyperliquid spot ⇄ perp class transfer (hlClassSheet) ────────────────
 * First manual UI over the existing POST /markets/hyperliquid/usd-class-transfer.
 * Direction is bidirectional (`toPerp`); amounts are capped at the source
 * side's balance (spot USDC / perp withdrawable) read from the portfolio
 * summary. */

let hlClassToPerp = true;
let hlClassBusy = false;

function hlClassBalances(): { spotUsd: number | null; perpUsd: number | null } {
  const s = portfolioSummaryView;
  const spotUsd =
    s?.legs.hyperliquidSpot === 'ok'
      ? (s.hyperliquidSpot?.usdcUsd ?? 0)
      : (portfolioBalances?.byChain.hyperliquidSpot ?? null);
  const perpUsd = s?.legs.hyperliquid === 'ok' ? (s.hyperliquid?.withdrawableUsd ?? 0) : null;
  return { spotUsd, perpUsd };
}

function hlClassAvailable(): number | null {
  const { spotUsd, perpUsd } = hlClassBalances();
  return hlClassToPerp ? spotUsd : perpUsd;
}

function renderHlClassSheet(): void {
  const go = document.getElementById('hlClassGo') as HTMLButtonElement | null;
  if (!go) return;
  const { spotUsd, perpUsd } = hlClassBalances();
  setTextAll('[data-hlclass-spot-bal]', spotUsd == null ? '—' : money(spotUsd));
  setTextAll('[data-hlclass-perp-bal]', perpUsd == null ? '—' : money(perpUsd));
  $$('[data-hlclass-dir]').forEach((b) =>
    b.classList.toggle('onx', (b.getAttribute('data-hlclass-dir') === 'toPerp') === hlClassToPerp),
  );
  const amountEl = document.getElementById('hlClassAmount') as HTMLInputElement | null;
  const amount = Number(amountEl?.value) || 0;
  const available = hlClassAvailable();
  go.disabled = hlClassBusy || amount <= 0 || available == null || amount > available + 0.000001;
  go.textContent = hlClassBusy ? 'Moving…' : hlClassToPerp ? 'Move to Perps' : 'Move to Spot';
}

function openHlClassSheet(opts: { toPerp?: boolean; prefillUsd?: number } = {}): void {
  if (typeof opts.toPerp === 'boolean') hlClassToPerp = opts.toPerp;
  const amountEl = document.getElementById('hlClassAmount') as HTMLInputElement | null;
  if (amountEl && opts.prefillUsd != null && opts.prefillUsd > 0) {
    amountEl.value = (Math.ceil(opts.prefillUsd * 100) / 100).toFixed(2);
  }
  openOvl('hlClassSheet');
  renderHlClassSheet();
  void hydratePortfolioSummary(true).then(renderHlClassSheet);
}

onGlobal(document, 'click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-open="hlClassSheet"]')) {
    // The generic [data-open] handler shows the sheet; we hydrate balances.
    renderHlClassSheet();
    void hydratePortfolioSummary(true).then(renderHlClassSheet);
    return;
  }
  const dir = t.closest<HTMLElement>('[data-hlclass-dir]');
  if (dir) {
    hlClassToPerp = dir.getAttribute('data-hlclass-dir') === 'toPerp';
    renderHlClassSheet();
    return;
  }
  if (t.closest('#hlClassMaxBtn')) {
    const available = hlClassAvailable();
    const amountEl = document.getElementById('hlClassAmount') as HTMLInputElement | null;
    if (amountEl && available != null) {
      amountEl.value = (Math.floor(available * 100) / 100).toFixed(2);
      renderHlClassSheet();
    }
    return;
  }
});

onGlobal(document, 'input', (e) => {
  if ((e.target as HTMLElement).id === 'hlClassAmount') renderHlClassSheet();
});

onGlobal(document, 'click', (e) => {
  const go = (e.target as HTMLElement).closest('#hlClassGo');
  if (!go || hlClassBusy) return;
  const amountEl = document.getElementById('hlClassAmount') as HTMLInputElement | null;
  const amountUsd = Number(amountEl?.value) || 0;
  if (amountUsd <= 0) return;
  hlClassBusy = true;
  renderHlClassSheet();
  void (async () => {
    try {
      await nexaApi.markets.hyperliquid.usdClassTransfer(
        { amountUsd, toPerp: hlClassToPerp },
        { idempotencyKey: crypto.randomUUID() },
      );
      toast(
        hlClassToPerp
          ? `Moved ${money(amountUsd)} spot → perps`
          : `Moved ${money(amountUsd)} perps → spot`,
      );
      if (amountEl) amountEl.value = '';
      document.getElementById('hlClassSheet')?.classList.remove('on');
      syncScrollLock();
      void hydratePortfolioSummary(true);
      void hydratePortfolioBalances();
    } catch (err) {
      toast(err instanceof ApiFailure ? `Move failed · ${err.message}` : 'Move failed', 'err');
    } finally {
      hlClassBusy = false;
      renderHlClassSheet();
    }
  })();
});

/* s32 Move money is owned by the inline script in app.html (e2e-tested
   contract: apps/web/e2e/app-flows.spec.ts 'bucket transfers'). A duplicate
   module here briefly double-posted transfers (PR #55) — do not re-add
   handlers for [data-xfer-*] / #xferSubmitBtn in this file. */

function renderActivation(): void {
  const box = document.getElementById('activationChecklist');
  if (!box) return;
  const done = Number(activationView.funded) + Number(activationView.agent);
  box.hidden = !LIVE || done === 2;
  const progress = document.getElementById('activationProgress');
  if (progress) {
    progress.textContent = `${done}/2`;
    progress.className = 'tag ' + (done === 0 ? 'warnx' : 'ok');
  }
  const kycStep = document.getElementById('activationKyc');
  if (kycStep) kycStep.hidden = true;
  ([
    ['fund', activationView.funded, '1'],
    ['agent', activationView.agent, '2'],
  ] as const).forEach(([key, complete, label]) => {
    const dot = document.querySelector<HTMLElement>(`[data-activation-dot="${key}"]`);
    if (!dot) return;
    dot.className = 'tag ' + (complete ? 'ok' : 'warnx');
    dot.textContent = complete ? 'OK' : label;
  });
}

function renderSpendInsight(): void {
  const card = document.getElementById('spendInsightCard');
  if (!card) return;
  if (!LIVE || !spendInsight) {
    card.hidden = true;
    return;
  }
  // Keep the card visible at $0 spend — it is the only door into the
  // Insights screen, and an empty state teaches what will appear there.
  card.hidden = false;
  const amount = document.getElementById('spendInsightAmount');
  const sub = document.getElementById('spendInsightSub');
  if (spendInsight.totalUsd <= 0) {
    if (amount) amount.textContent = '$0.00';
    if (sub) sub.textContent = 'Your monthly breakdown lands here';
    return;
  }
  if (amount) amount.textContent = money(spendInsight.totalUsd);
  if (sub) {
    const top = spendInsight.categories[0];
    sub.textContent = top ? `${top.label} leads this month` : 'Real ledger activity';
  }
}

function insightMonthLabel(month: string): string {
  const [year, mm] = month.split('-').map(Number);
  if (!year || !mm) return 'This month';
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, mm - 1, 1)));
}

function renderInsights(): void {
  const total = document.getElementById('insightsTotal');
  const month = document.getElementById('insightsMonth');
  const pace = document.getElementById('insightsPace');
  const list = document.getElementById('insightsCategoryList');
  if (!total || !month || !pace || !list) return;

  const data = spendInsight;
  if (!LIVE) {
    total.textContent = '—';
    month.textContent = 'INSIGHTS';
    pace.textContent = 'Sign in to see real spend.';
    list.textContent = '';
    emptyMarketRow(list, 'Sign in required.', 'Monthly spend is private account data');
    return;
  }
  if (!data) {
    total.textContent = '...';
    month.textContent = 'THIS MONTH';
    pace.textContent = 'Loading spend...';
    return;
  }

  total.textContent = money(data.totalUsd);
  month.textContent = insightMonthLabel(data.month).toUpperCase();
  pace.textContent = data.totalUsd > 0
    ? `${data.categories.length} active ${data.categories.length === 1 ? 'category' : 'categories'}`
    : 'No spend yet.';
  list.textContent = '';
  if (!data.categories.length) {
    emptyMarketRow(list, 'No categorized spend yet.', 'Card, agent, and transfer spend appears here');
    return;
  }
  data.categories.forEach((cat) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = cat.label;
    const sub = document.createElement('span');
    sub.className = 's';
    const pct = data.totalUsd > 0 ? Math.round((cat.totalUsd / data.totalUsd) * 100) : 0;
    sub.textContent = `${pct}% of month`;
    const bar = document.createElement('span');
    bar.className = 'insight-bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(4, pct)}%`;
    bar.appendChild(fill);
    grow.append(title, document.createElement('br'), sub, bar);
    const amt = document.createElement('span');
    amt.className = 'num';
    amt.textContent = money(cat.totalUsd);
    row.append(grow, amt);
    list.appendChild(row);
  });
}

async function syncInsights(): Promise<void> {
  if (spendInsight || !LIVE) {
    renderInsights();
    return;
  }
  try {
    spendInsight = await nexaApi.spendMonthly();
  } catch {
    spendInsight = { ok: true, month: new Date().toISOString().slice(0, 7), totalUsd: 0, categories: [] };
  }
  renderInsights();
}

on(document, 'click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('#insightsExportCsv');
  if (!btn || !spendInsight) return;
  const rows = [['category', 'amount_usd'], ...spendInsight.categories.map((cat) => [cat.label, String(cat.totalUsd)])];
  const csv = rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `maze-spend-${spendInsight.month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

function applyVirtualAccounts(accounts: AccountViewState | null | undefined): void {
  accountView = accounts ?? {};
  const us = accountView.us;
  const eu = accountView.eu;
  setTextAll('[data-acct="us-number"]', us?.number);
  setTextAll('[data-acct="us-routing"]', us?.routing);
  setTextAll('[data-acct="eu-iban"]', eu?.iban);

  const usCopy = us?.number && us.routing ? `ACH account ${us.number} · routing ${us.routing}` : null;
  const euCopy = eu?.iban ? `IBAN ${eu.iban}${eu.bic ? ` · BIC ${eu.bic}` : ''}` : null;
  setCopyValue('copyUsAcct', usCopy);
  setCopyValue('copyEuAcct', euCopy);
  setCopyValue('copyFundingDetails', [usCopy, euCopy].filter(Boolean).join('\n') || null);
  // No bank rails on this deployment → the Add-money bank row is a dead end;
  // hide it rather than walking users into "Unavailable" account fields.
  const bankRail = document.querySelector<HTMLElement>('[data-addrail="bank"]');
  if (bankRail) bankRail.hidden = LIVE && !usCopy && !euCopy;
  renderReceiveSurface();
}
onGlobal(document, 'nexa:addrail-rendered', () => {
  applyVirtualAccounts(accountView);
  renderReceiveSurface();
});

function renderCardActivity(): void {
  const list = document.getElementById('cardActivityList');
  if (!list) return;
  list.textContent = '';
  const rows = L.activity.filter((r) => r.k === 'card').slice(0, 5);

  if (!rows.length) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.appendChild(
      svg('<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18"/></svg>'),
    );
    const grow = document.createElement('span');
    grow.className = 'grow';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = 'No card activity yet';
    const sub = document.createElement('span');
    sub.className = 's';
    sub.textContent = 'LIVE CARD TRANSACTIONS';
    grow.appendChild(title);
    grow.appendChild(document.createElement('br'));
    grow.appendChild(sub);
    row.appendChild(ic);
    row.appendChild(grow);
    list.appendChild(row);
    return;
  }

  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    const ic = document.createElement('span');
    ic.className = 'ic';
    if (r.logo) {
      ic.textContent = r.logo;
    } else {
      ic.appendChild(
        svg('<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18"/></svg>'),
      );
    }
    const grow = document.createElement('span');
    grow.className = 'grow';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = r.n;
    const sub = document.createElement('span');
    sub.className = 's';
    sub.textContent = r.s;
    grow.appendChild(title);
    grow.appendChild(document.createElement('br'));
    grow.appendChild(sub);
    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = r.a;
    row.appendChild(ic);
    row.appendChild(grow);
    row.appendChild(amt);
    list.appendChild(row);
  });
}

const ACTION_SELECTOR = '[data-go],[data-open],[data-close],[data-dismiss],[data-toast],[data-copy]';
const NATIVE_ACTION_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

function setKeyboardAction(el: HTMLElement): void {
  if (NATIVE_ACTION_TAGS.has(el.tagName)) return;
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
}

function enhanceKeyboardActions(ctx: ParentNode = document): void {
  $$<HTMLElement>(ACTION_SELECTOR, ctx).forEach(setKeyboardAction);
}

function buildTxRow(r: TxRow, idx: number): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'tx-row';
  row.dataset['go'] = 's13';
  row.dataset['act'] = String(idx);
  setKeyboardAction(row);
  on(row, 'click', () => fillDetailRow(r, idx));
  row.appendChild(txLogoEl(r));
  const main = document.createElement('span');
  main.className = 'tx-main';
  const title = document.createElement('span');
  title.className = 'tx-title';
  title.textContent = r.n;
  const sub = document.createElement('span');
  sub.className = 'tx-sub';
  sub.textContent = r.s;
  main.appendChild(title);
  main.appendChild(sub);
  row.appendChild(main);
  const amt = document.createElement('span');
  amt.className = 'tx-amt' + (r.pos ? ' pos' : '');
  amt.textContent = r.a;
  row.appendChild(amt);
  return row;
}

type ActivityFilter = 'all' | 'money' | 'trade' | 'agent';
let activityFilter: ActivityFilter = 'all';

function rowMatchesFilter(r: TxRow, f: ActivityFilter): boolean {
  if (f === 'all') return true;
  if (f === 'money') return r.k === 'in' || r.k === 'out' || r.k === 'card';
  if (f === 'trade') return r.k === 'swap';
  if (f === 'agent') return r.k === 'agent' || r.k === 'x402';
  return true;
}

function renderActivity(): void {
  const list = $('#actList');
  list.textContent = '';
  L.activity.slice(0, 6).forEach((r, i) => {
    list.appendChild(buildTxRow(r, i));
  });
  renderActivityFull();
  applyHomeAuthState();
  renderCardActivity();
}

function renderActivityFull(): void {
  const list = document.getElementById('actListFull');
  if (!list) return;
  list.textContent = '';
  const matches = L.activity
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => rowMatchesFilter(r, activityFilter));
  matches.forEach(({ r, i }) => list.appendChild(buildTxRow(r, i)));
  const empty = document.getElementById('activityEmpty');
  const card = document.getElementById('activityCard');
  const emptySub = document.getElementById('activityEmptySub');
  const emptyCta = document.getElementById('activityEmptyCta');
  if (!LIVE && L.bal == null && L.activity.length === 0) {
    if (empty) empty.hidden = false;
    if (card) card.hidden = true;
    if (emptySub) emptySub.textContent = 'Sign in to see your transactions, trades, and agent activity.';
    if (emptyCta) {
      emptyCta.textContent = 'Sign in';
      emptyCta.setAttribute('data-go', 's01');
    }
    return;
  }
  if (emptySub) emptySub.textContent = 'Your transactions, trades, and agent activity all land here the second they happen.';
  if (emptyCta) {
    emptyCta.textContent = 'Add money';
    emptyCta.setAttribute('data-go', 's09');
  }
  if (empty) empty.hidden = matches.length > 0;
  if (card) card.hidden = matches.length === 0;
}

/* ── live sync ── */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'in', 'out', 'card', 'agent', 'swap', 'x402', 'amazon', 'spotify', 'uber',
]);

function mapServerRow(r: ServerActivity): TxRow {
  const row: TxRow = {
    id: r.id,
    n: r.n,
    s: r.s,
    a: r.a,
    k: (KNOWN_KINDS.has(r.k) ? r.k : 'in') as TxKind,
    at: r.at,
  };
  if (r.pos) row.pos = true;
  if (r.logo) row.logo = r.logo;
  if (r.status) row.status = r.status;
  if (r.venue) row.venue = r.venue;
  if (r.signer) row.signer = r.signer;
  if (r.txHash) row.txHash = r.txHash;
  if (r.chain) row.chain = r.chain;
  if (r.explorerUrl) row.explorerUrl = r.explorerUrl;
  return row;
}

/* Phase I — micro-interactions: haptics, top loading bar, balance tween. */
function haptic(ms = 8): void {
  // navigator.vibrate is no-op on iOS Safari; harmless. On Android it gives
  // the tap-confirmation pulse every native app has.
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(ms);
    }
  } catch {
    /* ignore — vibrate can throw in user-gesture-restricted contexts */
  }
}

let topLoadbarDepth = 0;
function setTopLoadbar(active: boolean): void {
  topLoadbarDepth = Math.max(0, topLoadbarDepth + (active ? 1 : -1));
  const bar = document.getElementById('topLoadbar');
  if (!bar) return;
  bar.classList.toggle('on', topLoadbarDepth > 0);
}

const LIVE_SYNC_RATE_LIMIT_BACKOFF_MS = 30_000;
let syncFromServerInflight: Promise<void> | null = null;
let syncFromServerCooldownUntil = 0;

/** Pull balance + activity from the API into the local render state. */
function syncFromServer() {
  if (!LIVE) return Promise.resolve();
  if (syncFromServerInflight) return syncFromServerInflight;
  if (Date.now() < syncFromServerCooldownUntil) return Promise.resolve();
  syncFromServerInflight = syncFromServerImpl().finally(() => {
    syncFromServerInflight = null;
  });
  return syncFromServerInflight;
}

async function syncFromServerImpl() {
  setTopLoadbar(true);
  try {
    const [me, act, spend] = await Promise.all([
      nexaApi.me(),
      nexaApi.activity(),
      nexaApi.spendMonthly().catch(() => null),
    ]);
    // ADR-0004 part 2 — attach the per-user HL account/fills streams once we
    // know who's signed in. Idempotent per userId; a no-op unless the server
    // runs HL_USER_STREAMS=1 (valid-but-silent priv topics otherwise).
    if (LIVE && me.user?.id) getRealtimeHub()?.ensureUserStreams(me.user.id);
    const balChanged = L.bal !== me.balance.balUsd;
    const earnChanged = L.earnPos !== me.balance.earnUsd;
    const nextBal = me.balance.balUsd;
    const nextEarn = me.balance.earnUsd;
    L.activity = act.activity.map(mapServerRow);
    L.fresh = false;
    // Phase K — tween the headline number when refresh moves it; static set
    // when the figure is unchanged or we have no prior reading.
    if (!RM && balChanged && L.bal != null) {
      tweenMoney($('#balEl'), nextBal);
    } else {
      L.bal = nextBal;
      renderBal();
    }
    L.bal = nextBal;
    if (!RM && earnChanged && L.earnPos != null) {
      tweenMoney($('#earnPos'), nextEarn);
    } else {
      L.earnPos = nextEarn;
      $('#earnPos').textContent = money(L.earnPos);
    }
    L.earnPos = nextEarn;
    // 1.4 fix — a USD→EUR swap must never read as vanished money: surface the
    // EUR cash line under Total balance whenever the EUR balance is non-zero.
    const eurBal = me.balance.eurUsd ?? 0;
    const eurLine = $('#eurLine');
    eurLine.textContent = `+ €${eurBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
    eurLine.toggleAttribute('hidden', !(eurBal > 0));
    renderActivity();
    spendInsight = spend;
    renderSpendInsight();
    renderInsights();
    renderEarnYield();
    if (me.earnConfig) renderEarnConfig(me.earnConfig);
    void hydratePortfolioBalances();
  } catch (e) {
    if (e instanceof ApiFailure && (e.status === 429 || e.code === 'too_many_requests')) {
      syncFromServerCooldownUntil = Date.now() + rateLimitBackoffMs(e, LIVE_SYNC_RATE_LIMIT_BACKOFF_MS);
    }
    /* transient — next action retries */
  } finally {
    setTopLoadbar(false);
  }
}

/** Sprint 10 Item A — push earn config into the s14 toggles. Idempotent. */
function renderEarnConfig(cfg: { earnByDefault: boolean; autoDivestOnSpend: boolean; divestThresholdUsd: number }): void {
  document
    .querySelectorAll<HTMLElement>('#earnCfgDefault,#earnCfgDefaultS14a')
    .forEach((el) => el.setAttribute('aria-checked', String(cfg.earnByDefault)));
  document
    .querySelectorAll<HTMLElement>('#earnCfgDivest,#earnCfgDivestS14a')
    .forEach((el) => el.setAttribute('aria-checked', String(cfg.autoDivestOnSpend)));
  document
    .querySelectorAll<HTMLInputElement>('#earnCfgThresh,#earnCfgThreshS14a')
    .forEach((el) => {
      el.value = String(Math.min(1000, Math.max(0, Math.round(cfg.divestThresholdUsd))));
    });
  document
    .querySelectorAll<HTMLElement>('#earnCfgThVal,#earnCfgThValS14a')
    .forEach((el) => {
      el.textContent = '$' + Math.round(cfg.divestThresholdUsd);
    });
}

let stream: { close: () => void } | null = null;
let liveSyncTimer: number | null = null;

/* PLANB W2 — poll discipline. The blanket 4s refetch becomes a 5s timer that
   (a) skips entirely while the tab is hidden and (b) stretches to a 15s floor
   while the SSE activity stream is confirmed open — SSE rows already trigger
   an immediate sync, so the interval only covers activity-less drift (earn
   accrual, server-side corrections). SSE down or absent (signed out, hub
   disabled) falls back to the 5s cadence. */
const LIVE_SYNC_BASE_MS = 5_000;
const LIVE_SYNC_SSE_IDLE_MS = 15_000;
let sseHealthy = false;
let lastLedgerSyncAt = 0;
let resumeLiveSyncOnVisible = false;

function stopLiveSync(): void {
  if (liveSyncTimer) window.clearInterval(liveSyncTimer);
  liveSyncTimer = null;
}

function startLiveSync(): void {
  stopLiveSync();
  liveSyncTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (sseHealthy && Date.now() - lastLedgerSyncAt < LIVE_SYNC_SSE_IDLE_MS) return;
    lastLedgerSyncAt = Date.now();
    void syncFromServer();
  }, LIVE_SYNC_BASE_MS);
}

function openStream(): void {
  stream?.close();
  sseHealthy = false;
  stream = openActivityStream(
    () => {
      // Any new server-side row (e.g. an MCP agent payment) → refresh the ledger.
      lastLedgerSyncAt = Date.now();
      void syncFromServer();
    },
    (status) => {
      sseHealthy = status === 'open';
    },
  );
  startLiveSync();
}

/** Demo mode flag — true when the API runs DEMO_MODE=1 (482019 autofill on). */
let DEMO_MODE_HINT = true;

async function probeDemoMode(): Promise<void> {
  try {
    const h = await nexaApi.healthz();
    DEMO_MODE_HINT = h.demo;
  } catch {
    /* keep default true so OTP autofill keeps working offline */
  }
}

/* ── Venue trade gates ──
   /system/health (authed) exposes the deployment's feature flags. Trade
   sheets use them to disable their CTA with the EXACT blocker + env var
   instead of letting the tap fail server-side with a mystery error. Demo
   deployments trade synthetically, so gates only apply when demo is off. */
let gateHealth: { demo: boolean; features: Record<string, boolean> } | null = null;

async function syncGateHealth(): Promise<void> {
  if (!LIVE) return;
  try {
    const h = await nexaApi.systemHealth();
    gateHealth = { demo: Boolean(h.demo), features: (h.features ?? {}) as Record<string, boolean> };
  } catch {
    gateHealth = null; // unknown → sheets stay optimistic; server still gates
  }
}

type GateVenue = 'perps' | 'spot' | 'stocks' | 'predictions' | 'memes' | 'cards';

function venueTradeBlock(venue: GateVenue): string | null {
  const g = gateHealth;
  if (!g || g.demo) return null;
  const f = g.features;
  if (f['markets'] === false) return 'Trading disabled (MARKETS_ENABLED)';
  if (f['privy'] === false) return 'No signing wallet (PRIVY_APP_ID)';
  if (venue === 'memes') {
    if (f['jupiterSwaps'] === false) return 'Live swaps off (JUPITER_SWAPS_ENABLED)';
    if (f['solanaRpc'] === false) return 'No Solana RPC (SOLANA_RPC_URL)';
  }
  if (venue === 'cards') {
    if (f['ccEnabled'] === false) return 'Cards disabled (CC_ENABLED)';
    if (f['solanaRpc'] === false) return 'No Solana RPC (SOLANA_RPC_URL)';
  }
  return null;
}

/** Populate live-data placeholders from /ledger/me. Idempotent. */
async function populateLiveData(): Promise<void> {
  if (!LIVE) return;
  try {
    const me = await nexaApi.liveMe();
    receiveUserEmail = me.user.email;
    walletView = me.wallet ?? {};
    activationView = {
      kyc: me.kycStatus === 'verified',
      funded: me.balance.balUsd > 0 || me.balance.earnUsd > 0,
      agent: (me.agents?.count ?? 0) > 0,
    };
    applyVirtualAccounts(me.virtualAccounts);
    renderReceiveSurface();
    renderActivation();
    setCardControls(me.card ? { ...me.card } : null);
    earnApyBps = me.earn?.apyBps ?? null;
    renderEarnYield();
    void hydratePortfolioBalances();
  } catch {
    /* /ledger/me unavailable — keep live-only placeholders unavailable */
  }
  // Lazy-provision the Solana wallet (and verify the EVM one) so the Wallet
  // screen + Memes deposit flow have real addresses to show immediately
  // rather than the lazy "Unavailable" fallback. Fire-and-forget; the
  // render fns are idempotent so a slow Privy call still resolves cleanly.
  void hydrateDepositAddresses();
}

/* Lazy-provisions the user's Privy Solana wallet and exposes its address on
   the Wallet screen. The /ledger/me response is authoritative for the EVM
   address — we never overwrite it here. Solana is provisioned on demand by
   the deposit-address route because /ledger/me doesn't carry it today. */
async function hydrateDepositAddresses(): Promise<void> {
  if (!LIVE) return;
  // Only fetch Solana — EVM stays whatever /ledger/me supplied.
  try {
    const r = await nexaApi.depositAddress('memes');
    if (r.address && r.network === 'solana' && !walletView.solanaAddress) {
      walletView = { ...walletView, solanaAddress: r.address };
      renderWalletSurface();
    }
  } catch {
    /* silent — Solana wallet is optional */
  }
}

/* Cache per-bucket addresses so deposit toggles don't re-roundtrip the
   backend. Keyed by bucket. Populated lazily on demand. Prefixed `_` so
   eslint's no-unused-vars allows it — wired in once the deposit modal lands. */
type DepositBucket = 'cash' | 'perps' | 'predictions' | 'memes' | 'stocks-spot';
const depositAddressCache: Map<DepositBucket, { chain: string; network: 'evm' | 'solana'; address: string; tokens: string[] }> = new Map();
async function _resolveDepositAddress(bucket: DepositBucket): Promise<{ chain: string; network: 'evm' | 'solana'; address: string; tokens: string[] } | null> {
  const cached = depositAddressCache.get(bucket);
  if (cached) return cached;
  if (!LIVE) return null;
  try {
    const r = await nexaApi.depositAddress(bucket);
    const entry = { chain: r.chain, network: r.network, address: r.address, tokens: r.tokens };
    depositAddressCache.set(bucket, entry);
    return entry;
  } catch {
    return null;
  }
}

async function syncCard(): Promise<void> {
  if (!LIVE) {
    setCardControls(cardView);
    renderCardActivity();
    return;
  }
  try {
    const view = await nexaApi.card();
    setCardControls({
      last4: view.last4,
      network: view.network,
      kind: view.card?.kind ?? 'DEBIT',
      frozen: view.frozen,
      dayLimitUsd: view.dayLimitUsd,
      demo: view.demo,
    });
  } catch {
    setCardControls(null);
  } finally {
    renderCardActivity();
  }
}

/** Cap on how long the home skeleton may hold first paint while
 *  syncFromServer() hydrates. Slow ledger reads keep hydrating in the
 *  background; live-only surfaces (offers CTA, sign-out, dev keys) must not
 *  sit display:none past this. CI traced a 5s `/ledger/me` stall straight
 *  into a blank home — the cap turns worst-case boot blankness into a
 *  constant instead of a function of the slowest upstream. */
const SKELETON_HOLD_MAX_MS = 2_500;

/** Idempotent skeleton→body swap; called from the hold cap and `finally`. */
function revealHome(): void {
  const skel = document.getElementById('homeSkel');
  const body = document.getElementById('homeBody') as HTMLElement | null;
  const actSkel = document.getElementById('activitySkel');
  if (skel) skel.hidden = true;
  if (body) body.style.display = 'block';
  if (actSkel) actSkel.hidden = true;
}

async function tryResumeSession(): Promise<void> {
  if (!getToken() && hasSessionHint()) {
    // C1 — PWA cold boot: sessionStorage died with the old tab, but the
    // 30-day httpOnly cookie may still hold the session. One probe round
    // trip (only on devices that ever signed in) instead of forcing a
    // re-login on every launch. Failure = cookie expired/cleared; fall
    // through to the signed-out shell exactly as before.
    try {
      const r = await nexaApi.authRefresh({ probe: true });
      setToken(r.token);
      // The initial route painted while the probe was in flight; if it parked
      // on the sign-in screen, move the restored session home. Deep links
      // (#s27 etc.) are untouched — only s01 is hijacked.
      if (activeScreen === 's01') go('s08');
    } catch {
      setToken(null); // drop the stale hint so the next launch paints instantly
    }
  }
  if (!getToken()) {
    // Render the signed-out shell immediately so the unauthenticated paint
    // doesn't fall through to whatever defaults remained on the page.
    applyHomeAuthState();
    return;
  }
  // Returning live session: hold the home skeleton until real figures land, so
  // the demo ledger never flashes over a real account. finally restores the body
  // even if the resume fails (offline / expired token).
  const skel = document.getElementById('homeSkel');
  const body = document.getElementById('homeBody') as HTMLElement | null;
  const actSkel = document.getElementById('activitySkel');
  if (skel) skel.hidden = false;
  if (body) body.style.display = 'none';
  if (actSkel) actSkel.hidden = false;
  L.homeLoaded = true;
  try {
    // Rotate first and wait for the replacement token before any parallel
    // ledger reads. Refresh revokes the presented jti, so fire-and-forget here
    // races syncFromServer: a request carrying the old token can land after
    // revocation and incorrectly force the app back to sign-in.
    try {
      const refreshed = await nexaApi.authRefresh();
      setToken(refreshed.token);
    } catch (refreshError) {
      // A 401 clears the token in api.ts and is terminal. For a transient
      // refresh failure, validate the still-present bearer and keep the user
      // online instead of turning a sliding-expiry outage into a forced logout.
      if (!getToken()) throw refreshError;
      await nexaApi.me();
    }
    LIVE = true;
    setLiveSurfaces();
    // Cap the skeleton hold: a slow ledger read keeps hydrating in the
    // background instead of pinning the whole home (and its live-only
    // CTAs) at display:none until every byte lands.
    const sync = syncFromServer();
    await Promise.race([
      sync.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SKELETON_HOLD_MAX_MS);
      }),
    ]);
    revealHome();
    await sync; // real failure handling stays in the outer catch below
    await populateLiveData();
    void syncGateHealth();
    void syncNotificationUi();
    void syncEarnProtocols();
    if (document.getElementById('s16')?.classList.contains('on')) swRender();
    openStream();
  } catch (err) {
    // Phase E — surface session-resume failure instead of silently dropping
    // the user back into demo mode. Offline / expired token / 5xx all land here.
    setToken(null);
    stopLiveSync();
    showResumeError(err);
  } finally {
    revealHome();
  }
}

/* Phase E — visible error card inside the Home body when session resume fails.
   Replaces the prior silent .catch so the user knows what happened and can
   retry without reloading the page. */
function showResumeError(err: unknown): void {
  const body = document.getElementById('homeBody');
  if (!body) return;
  let card = document.getElementById('homeResumeError');
  if (!card) {
    card = document.createElement('div');
    card.id = 'homeResumeError';
    card.className = 'banner';
    card.setAttribute('role', 'alert');
    body.insertBefore(card, body.firstChild);
  }
  const msg = err instanceof ApiFailure ? err.message : 'Could not reconnect to your account.';
  card.textContent = '';
  const b = document.createElement('b');
  b.textContent = 'OFFLINE';
  const span = document.createElement('span');
  span.className = 'grow';
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.textContent = 'Retry';
  btn.className = 'pillbtn';
  on(btn, 'click', () => {
    card?.remove();
    void tryResumeSession();
  });
  card.appendChild(b);
  card.appendChild(span);
  card.appendChild(btn);
}

/** Live mutation helper: optimistic local UI ran already; reconcile with server. */
function liveCall(p: Promise<unknown>): void {
  p.then(() => syncFromServer()).catch((e: unknown) => {
    if (e instanceof ApiFailure) toast(e.message, 'err');
    void syncFromServer();
  });
}

/* ── toasts ── */
function toast(msg: string, kind?: 'err', actionLabel?: string, actionFn?: () => void): void {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  // Error toasts announce assertively so screen readers don't wait for the
  // user to idle. Success toasts stay polite (don't interrupt typing).
  t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  t.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
  const dot = document.createElement('i');
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(dot);
  t.appendChild(span);
  if (actionLabel) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    on(btn, 'click', () => {
      t.remove();
      actionFn?.();
    });
    t.appendChild(btn);
  }
  const host = $('#toasts');
  // Cap the queue at 5 — burst of failed retries shouldn't pile up.
  while (host.children.length >= 5) host.firstChild?.remove();
  host.appendChild(t);
  window.setTimeout(() => t.parentNode && t.remove(), actionLabel ? 6000 : 2800);
}

/* ── router ── */
const scrs = $$('.scr');
const tabbar = $('#tabbar');

function bindMoreAppShellRows(): void {
  const x402 =
    document.querySelector<HTMLAnchorElement>('#moreX402') ??
    document.querySelector<HTMLAnchorElement>('#s26 a[href="/portal.html"]');
  if (x402) {
    x402.id = 'moreX402';
    x402.dataset['go'] = 's24';
    x402.href = '#s24';
    x402.removeAttribute('target');
  }
  const developers =
    document.querySelector<HTMLAnchorElement>('#moreDevelopers') ??
    document.querySelector<HTMLAnchorElement>('#s26 a[href="/developers.html"]');
  if (developers) {
    developers.id = 'moreDevelopers';
    developers.dataset['go'] = 's28';
    developers.href = '#s28';
    developers.removeAttribute('target');
  }
}
bindMoreAppShellRows();

/* Derive the body scroll-lock from live DOM state so it can never leak: if any
   sheet/overlay or the faceid prompt is open, lock; otherwise release. Call
   after every open/close mutation. */
function syncScrollLock(): void {
  const open = !!document.querySelector('.ovl.on') || $('#faceid').classList.contains('on');
  $('#stage').classList.toggle('locked', open);
}

function closeOverlays(): void {
  $$('.ovl.on').forEach((o) => o.classList.remove('on'));
  $('#faceid').classList.remove('on');
  syncScrollLock();
}

const LEGACY_ONBOARDING_SCREENS = new Set(['s02', 's03', 's04', 's05', 's06', 's07']);
type TradeVenue = 'perps' | 'spot' | 'stocks' | 'memes' | 'predictions' | 'cards';
let activeScreen = 's01';
let activeTradeVenue: TradeVenue = 'perps';
let cardsBackTarget = 's27';
let activeCollectorCardId: string | null = null;
let cardsBuyInFlight = false;
let cardsBuyAttempt: OrderAttemptKey | null = null;

function syncCardsBackTarget(): void {
  const back = document.getElementById('cardsBackBtn');
  if (back) back.setAttribute('data-go', cardsBackTarget);
}

function go(id: string): void {
  if (LEGACY_ONBOARDING_SCREENS.has(id)) id = getToken() ? 's08' : 's01';
  if (!document.getElementById(id)) id = 's01';
  const previousScreen = activeScreen;
  const apply = (): void => {
    if (previousScreen === 's27' && id !== 's27') stopTradeRealtime();
    if (previousScreen === 's27d' && id !== 's27d') tearDownDetailChart();
    closeOverlays();
    scrs.forEach((s) => s.classList.toggle('on', s.id === id));
    const scr = $('#' + id);
    const tab = scr.getAttribute('data-tab');
    tabbar.classList.toggle('on', !!tab);
    $$('.tb', tabbar).forEach((b) => b.classList.toggle('on', b.getAttribute('data-tabgo') === tab));
    if (history.replaceState) history.replaceState(null, '', '#' + id);
    const b = scr.querySelector<HTMLElement>('.body');
    if (b) b.scrollTop = 0;
    activeScreen = id;
    enter(id);
  };
  // PLANB W3 — same-document View Transition on screen swaps where the
  // platform provides one; the fallback path is the pre-W3 code verbatim
  // (reduced motion, hidden tabs, same-screen re-renders, older engines).
  const startViewTransition = (
    document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }
  ).startViewTransition;
  if (RM || document.hidden || previousScreen === id || typeof startViewTransition !== 'function') {
    apply();
    return;
  }
  document.documentElement.classList.add('vt');
  startViewTransition.call(document, apply).finished.finally(() => {
    document.documentElement.classList.remove('vt');
  });
}

on(document, 'click', (e) => {
  const target = e.target as HTMLElement;
  const g = target.closest<HTMLElement>('[data-go]');
  if (g) {
    e.preventDefault();
    const act = g.getAttribute('data-act');
    if (act !== null && !g.classList.contains('tx-row')) fillDetail(parseInt(act, 10));
    const next = g.getAttribute('data-go')!;
    if (next === 's33') {
      cardsBackTarget = g.getAttribute('data-cards-back') ?? (activeScreen === 's26' ? 's26' : 's27');
      const cardId = g.getAttribute('data-card-id');
      if (cardId) activeCollectorCardId = cardId;
      syncCardsBackTarget();
    }
    go(next);
    return;
  }
  const op = target.closest<HTMLElement>('[data-open]');
  if (op) {
    openOvl(op.getAttribute('data-open')!);
    return;
  }
  const c = target.closest<HTMLElement>('[data-close]');
  if (c) {
    $('#' + c.getAttribute('data-close')!).classList.remove('on');
    syncScrollLock();
    return;
  }
  const d = target.closest<HTMLElement>('[data-dismiss]');
  if (d) {
    ($('#' + d.getAttribute('data-dismiss')!) as HTMLElement).hidden = true;
    return;
  }
  const sw = target.closest<HTMLElement>('[data-swtoggle]');
  if (sw) {
    sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') !== 'true' ? 'true' : 'false');
    return;
  }
  const tst = target.closest<HTMLElement>('[data-toast]');
  if (tst) {
    toast(tst.getAttribute('data-toast')!);
    return;
  }
  const cp = target.closest<HTMLElement>('[data-copy]');
  if (cp) {
    const prev = cp.textContent;
    const done = (t2: string) => {
      cp.textContent = t2;
      window.setTimeout(() => {
        cp.textContent = prev;
      }, 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(cp.getAttribute('data-copy')!).then(
        () => done('COPIED ✓'),
        () => done('PREVIEW'),
      );
    } else {
      done('PREVIEW');
    }
  }
});

// Phase I — global haptic feedback on chrome taps. Capture-phase so we fire
// even when the actual click handler stops propagation.
on(document, 'pointerdown', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (target.closest('.tb,.btn,.qa,.iconb,.pillbtn,.seg button,.tx-row,.lrow')) haptic(8);
});

// Phase J — bottom-sheet drag-to-dismiss. Native-feel: pulling the grab
// handle down by ≥90px (or fast-flicking) closes the sheet; small pulls spring
// back. Only handlebars opt in (touch-action:none) so internal scroll still
// works. Pointer events cover touch + mouse + stylus on one path.
let dragState: { sheet: HTMLElement; startY: number; lastY: number; lastT: number; vY: number; ovlId: string | null } | null = null;
on(document, 'pointerdown', (e) => {
  const grab = (e.target as HTMLElement | null)?.closest<HTMLElement>('.sheet .grab');
  if (!grab) return;
  const sheet = grab.closest<HTMLElement>('.sheet');
  if (!sheet) return;
  const ovl = sheet.closest<HTMLElement>('.ovl');
  dragState = {
    sheet,
    startY: e.clientY,
    lastY: e.clientY,
    lastT: performance.now(),
    vY: 0,
    ovlId: ovl?.id ?? null,
  };
  sheet.classList.add('dragging');
  (grab as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
});
on(document, 'pointermove', (e) => {
  if (!dragState) return;
  const dy = e.clientY - dragState.startY;
  const now = performance.now();
  dragState.vY = (e.clientY - dragState.lastY) / Math.max(1, now - dragState.lastT);
  dragState.lastY = e.clientY;
  dragState.lastT = now;
  // Resist upward drag, allow downward freely.
  const tx = dy < 0 ? dy / 4 : dy;
  dragState.sheet.style.transform = `translateY(${tx}px)`;
});
on(document, 'pointerup', () => {
  if (!dragState) return;
  const { sheet, lastY, startY, vY, ovlId } = dragState;
  sheet.classList.remove('dragging');
  sheet.style.transform = '';
  const dy = lastY - startY;
  const fastFlick = vY > 0.6; // px per ms
  if (dy > 90 || fastFlick) {
    if (ovlId) {
      const ovl = document.getElementById(ovlId);
      ovl?.classList.remove('on');
      syncScrollLock();
      haptic(12);
    }
  }
  dragState = null;
});
on(document, 'pointercancel', () => {
  if (!dragState) return;
  dragState.sheet.classList.remove('dragging');
  dragState.sheet.style.transform = '';
  dragState = null;
});

// Phase K — Visibility API refresh. Coming back to the tab after >30s of idle
// triggers a one-shot sync so users don't stare at a stale balance.
// PLANB W2: hidden tabs also go network-quiet — every poller stops. The SSE
// stream and push sockets stay connected (event-driven, not storms); pollers
// restart on return based on what was active.
let lastHidden = 0;
onGlobal(document, 'visibilitychange', () => {
  if (document.hidden) {
    lastHidden = performance.now();
    resumeLiveSyncOnVisible = liveSyncTimer != null;
    stopLiveSync();
    stopJupPricePoll();
    stopHlPositionsPoll();
    return;
  }
  if (lastHidden && performance.now() - lastHidden > 30_000 && LIVE) {
    void syncFromServer();
  }
  lastHidden = 0;
  if (resumeLiveSyncOnVisible) {
    resumeLiveSyncOnVisible = false;
    startLiveSync();
  }
  if (activeScreen === 's27') {
    startHlPositionsPoll();
    syncTradeVenueLiveStreams();
  }
});

// Phase C — shared review sheet. Used by every money action that needs an
// explicit "Confirm" step before signing (swap, withdraw, bridge withdraw).
// The send flow uses its own s11 full-screen review; the Hyperliquid and
// Polymarket order sheets already render full review-shaped details before
// submit, so they aren't re-wired through this helper.
interface ReviewRow { k: string; v: string; emphasis?: 'success' | 'danger' | 'accent' }
interface ReviewBadge { source: string; provider: string; docsUrl?: string }
interface ReviewOptions {
  eyebrow: string;
  amount: string;
  subline?: string;
  rows: ReviewRow[];
  badge?: ReviewBadge;
  finePrint?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

let reviewPending: (() => void | Promise<void>) | null = null;

function openReviewSheet(opts: ReviewOptions): void {
  const eyebrow = document.getElementById('reviewEyebrow');
  if (eyebrow) eyebrow.textContent = opts.eyebrow;
  const amount = document.getElementById('reviewAmount');
  if (amount) amount.textContent = opts.amount;
  const sub = document.getElementById('reviewSubline');
  if (sub) {
    sub.textContent = opts.subline ?? '';
    sub.hidden = !opts.subline;
  }
  const rowsHost = document.getElementById('reviewRows');
  if (rowsHost) {
    rowsHost.textContent = '';
    opts.rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'kv';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = r.k;
      const v = document.createElement('span');
      v.className = 'num';
      v.textContent = r.v;
      if (r.emphasis === 'success') v.style.color = 'var(--success)';
      else if (r.emphasis === 'danger') v.style.color = 'var(--danger)';
      else if (r.emphasis === 'accent') v.style.color = 'var(--accent)';
      row.appendChild(k);
      row.appendChild(v);
      rowsHost.appendChild(row);
    });
  }
  const badgeWrap = document.getElementById('reviewBadgeWrap');
  const badge = document.getElementById('reviewBadge');
  if (badgeWrap && badge) {
    if (opts.badge) {
      badgeWrap.hidden = false;
      badge.hidden = false;
      badge.setAttribute('source', opts.badge.source);
      badge.setAttribute('provider', opts.badge.provider);
      if (opts.badge.docsUrl) badge.setAttribute('docs-url', opts.badge.docsUrl);
      else badge.removeAttribute('docs-url');
    } else {
      badgeWrap.hidden = true;
      badge.hidden = true;
    }
  }
  const fine = document.getElementById('reviewFinePrint');
  if (fine) {
    fine.textContent = opts.finePrint ?? '';
    fine.hidden = !opts.finePrint;
  }
  const confirm = document.getElementById('reviewConfirmBtn');
  if (confirm) confirm.textContent = opts.confirmLabel ?? 'Confirm';
  reviewPending = opts.onConfirm;
  openOvl('reviewSheet');
}

on(document, 'click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('#reviewConfirmBtn');
  if (!btn) return;
  const fn = reviewPending;
  reviewPending = null;
  const sheet = document.getElementById('reviewSheet');
  if (sheet) sheet.classList.remove('on');
  syncScrollLock();
  if (fn) {
    void Promise.resolve(fn()).catch((err) => {
      toast(err instanceof Error ? err.message : 'Action failed.', 'err');
    });
  }
});

// Phase B — Activity filter chips (All / Money / Trades / Agents).
on(document, 'click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-act-filter]');
  if (!chip) return;
  const next = chip.getAttribute('data-act-filter') as ActivityFilter;
  if (!next || next === activityFilter) return;
  activityFilter = next;
  $$('[data-act-filter]').forEach((b) => {
    const on = b.getAttribute('data-act-filter') === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  renderActivityFull();
});

// Trade venue switch (Perps / Spot / Memes / Predictions). The four panels
// share the markets cache populated by hydrateMarkets — flipping tabs is a
// pure UI swap with no fetch.
on(document, 'click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-trade-venue]');
  if (!chip) return;
  const next = chip.getAttribute('data-trade-venue');
  if (!next) return;
  const nextVenue = resolveTradeVenue(next);
  if (!nextVenue) return;
  activeTradeVenue = nextVenue;
  $$('[data-trade-venue]').forEach((b) => {
    const on = b.getAttribute('data-trade-venue') === next;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('[data-trade-panel]').forEach((p) => {
    p.hidden = p.getAttribute('data-trade-panel') !== next;
  });
  if (activeScreen === 's27') {
    syncTradeVenueLiveStreams();
  }
});

// Phase E — manual refresh buttons (Home / Trade / Activity appbars).
function bindRefreshButton(id: string, onRefresh: () => Promise<void> | void): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return;
  on(btn, 'click', async () => {
    btn.disabled = true;
    btn.classList.add('spinning');
    try {
      await onRefresh();
      toast('Refreshed ✓');
    } catch (e) {
      if (e instanceof MarketRefreshCooldownError) {
        const seconds = Math.max(1, Math.ceil(e.retryAfterMs / 1000));
        toast(`Rate limited or unavailable. Retry in ${seconds}s.`, 'err');
      } else {
        toast('Could not refresh. Try again.', 'err');
      }
    } finally {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  });
}
bindRefreshButton('homeRefreshBtn', () => syncFromServer());
bindRefreshButton('activityRefreshBtn', () => syncFromServer());
bindRefreshButton('tradeRefreshBtn', () => hydrateMarkets({ force: true }));

on(document, 'keydown', (e) => {
  // Escape closes any open overlay / sheet / faceid prompt. Centralised so
  // every sheet (trade order sheets, profile, etc.) is keyboard-dismissable.
  if (e.key === 'Escape') {
    const anyOpen = document.querySelector('.ovl.on') || $('#faceid').classList.contains('on');
    if (anyOpen) {
      e.preventDefault();
      closeOverlays();
      return;
    }
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const action = (e.target as HTMLElement).closest<HTMLElement>(ACTION_SELECTOR);
  if (!action || NATIVE_ACTION_TAGS.has(action.tagName)) return;
  e.preventDefault();
  action.click();
});

on(window, 'hashchange', () => {
  const id = location.hash.slice(1);
  if (id) go(id);
});

/* ── per-screen enter hooks ── */
let t8 = 0;
let t14 = 0;

function enter(id: string): void {
  bootGlobesIn($('#' + id));
  fillBrands($('#' + id));
  if (id === 's01') {
    void ensurePrivyIsland();
  }
  if (id === 's08') {
    renderBal();
    renderActivity();
    if (!RM && L.fresh && !t8 && L.bal != null) {
      t8 = 1;
      tweenMoney($('#balEl'), L.bal);
    }
    if (!L.homeLoaded) {
      L.homeLoaded = true;
      if (!RM && L.fresh) {
        ($('#homeSkel') as HTMLElement).hidden = false;
        $('#homeBody').style.display = 'none';
        window.setTimeout(() => {
          ($('#homeSkel') as HTMLElement).hidden = true;
          $('#homeBody').style.display = 'block';
        }, 750);
      } else {
        ($('#homeSkel') as HTMLElement).hidden = true;
        $('#homeBody').style.display = 'block';
      }
    }
  }
  if (id === 's14' || id === 's15') {
    renderBal();
  }
  if (id === 's14') {
    $('#earnPos').textContent = isSignedOutEmptyLedger() ? '—' : money(L.earnPos);
    if (!RM && !t14 && L.earnPos != null) {
      t14 = 1;
      tweenMoney($('#earnPos'), L.earnPos);
    }
    renderEarnYield();
    void syncEarnProtocols();
    // Per-asset best-yield card — public read, refreshes on every visit so
    // the user sees the live cross-protocol comparison without leaving Earn.
    void syncEarnLanding();
  }
  if (id === 's34') {
    renderInsights();
    void syncInsights();
  }
  if (id === 's17' || id === 's18') {
    renderCardActivity();
    void syncCard();
  }
  if (id === 's24') {
    void hydrateMcpTools();
  }
  if (id === 's31') {
    renderWalletSurface();
    void hydratePortfolioBalances();
    void hydratePortfolioSummary();
  }
  if (id === 's27') {
    activeTradeVenue = getActiveTradeVenueFromDom();
    startTradeRealtime();
    void hydrateMarkets();
  }
  if (id === 's33') {
    syncCardsBackTarget();
    renderCardsScreen();
    void hydrateCardsScreen();
  }
  if (id === 's28') {
    void hydrateSystemDocs();
  }
  if (id === 's09') {
    void hydrateOnrampBadge();
    // The inline crypto-rail template renders before this module boots, so
    // its initial addrail-rendered event is missed — fill the address now.
    renderAddMoneyCrypto();
  }
}

/* ── onboarding ──
   Privy login is rendered by a tiny React island at #privy-island (see
   src/privy-island.tsx). The island uses Privy's headless useLoginWithOAuth
   hook so the Maze welcome screen renders custom Google + X buttons inline
   — no Privy modal. When OAuth succeeds the island hands us the access
   token via onAccessToken, and we run the same NEXA exchange the legacy
   button did. Same Privy appId as AISO + NEO, so a Google sign-in here
   yields the same DID across all three properties. */
let privySigningIn = false;

async function completePrivyLogin(accessToken: string): Promise<void> {
  if (privySigningIn) return;
  privySigningIn = true;
  try {
    const r = await nexaApi.authPrivyVerify(accessToken);
    setToken(r.token);
    LIVE = true;
    L.fresh = false;
    setLiveSurfaces();
    await syncFromServer();
    await populateLiveData();
    void syncGateHealth();
    void syncNotificationUi();
    void syncEarnProtocols();
    if (document.getElementById('s16')?.classList.contains('on')) swRender();
    openStream();
    go('s08');
  } catch (e: unknown) {
    toast(e instanceof ApiFailure ? e.message : 'Privy sign-in failed.', 'err');
  } finally {
    privySigningIn = false;
  }
}

let privyIslandMounted = false;
async function ensurePrivyIsland(): Promise<void> {
  if (privyIslandMounted) return;
  const slot = document.getElementById('privy-island');
  if (!slot) return;
  privyIslandMounted = true;
  try {
    const { mountPrivyIsland } = await import('./privy-island');
    mountPrivyIsland(slot, {
      onAccessToken: completePrivyLogin,
      onError: (msg) => toast(msg, 'err'),
    });
    slot.setAttribute('data-state', 'ready');
  } catch (e: unknown) {
    privyIslandMounted = false;
    slot.setAttribute('data-state', 'error');
    toast(e instanceof Error ? e.message : 'Privy login UI failed to load.', 'err');
  }
}

/* ── home / profile ── */
/* Profile sheet now opens from the More screen via a data-open row, which routes
   through openOvl() and so also gets the scroll-lock. No dedicated button. */

/* ── get-paid: seller "New offer" surface (LIVE mode only) ──
   The hosted checkout + offers API only exist server-side, so the CTA stays
   hidden in pure-demo mode and is revealed once the app is talking to the API. */
function setLiveSurfaces(): void {
  const cta = document.getElementById('newOfferCta');
  if (cta) cta.hidden = !LIVE;
  // Developers (API keys) entry in the Profile sheet — server-only, like offers.
  const devRow = document.getElementById('devKeysRow');
  if (devRow) devRow.hidden = !LIVE;
  // C1 — sign-out controls only make sense with a live session.
  $$('[data-act="sign-out"]').forEach((el) => {
    (el as HTMLElement).hidden = !LIVE;
  });
  applyHomeAuthState();
  // Once we're live, refresh the backend-managed HL builder agreement status.
  if (LIVE) void bootstrapLiveTrading();
}

/* Phase A — signed-out vs signed-in Home rendering. Replaces the prior demo
   balance fixtures so unauthenticated visitors never see fake numbers. */
function applyHomeAuthState(): void {
  const empty = document.getElementById('homeEmpty');
  const full = document.getElementById('homeFull');
  const greet = document.querySelector<HTMLElement>('.home-greet');
  const emptyH = empty?.querySelector<HTMLElement>('h3');
  const emptySub = empty?.querySelector<HTMLElement>('p.sub');
  const emptyCta = empty?.querySelector<HTMLButtonElement>('button.btn');
  const hasLocalLedger = L.bal != null || L.earnPos != null || L.activity.length > 0;
  if (!LIVE && !hasLocalLedger) {
    $('#balEl').textContent = '—';
    $('#balMini').textContent = '—';
    $('#earnPos').textContent = '—';
    const swBal = document.getElementById('swBalLbl');
    if (swBal) swBal.textContent = 'BALANCE —';
    if (empty) empty.hidden = false;
    if (full) (full as HTMLElement).style.display = 'none';
    if (greet) greet.textContent = 'Welcome';
    if (emptyH) emptyH.textContent = 'Sign in to see your balance';
    if (emptySub) emptySub.textContent = 'Your account, your numbers. They appear the moment you sign in.';
    if (emptyCta) {
      emptyCta.textContent = 'Sign in';
    emptyCta.setAttribute('data-go', 's01');
    }
    spendInsight = null;
    renderSpendInsight();
    return;
  }
  if (!LIVE) {
    if (greet) greet.textContent = 'Good morning, Mirko';
    if (empty) empty.hidden = L.activity.length > 0;
    if (full) (full as HTMLElement).style.display = L.activity.length > 0 ? 'block' : 'none';
    spendInsight = null;
    renderSpendInsight();
    return;
  }
  if (greet) greet.textContent = 'Welcome back';
  if (emptyH) emptyH.textContent = "Nothing here yet, and that's correct.";
  if (emptySub) emptySub.textContent = "Add your first dollars or share your new account number. Activity shows up the second money moves.";
  if (emptyCta) {
    emptyCta.textContent = 'Add money';
    emptyCta.setAttribute('data-go', 's09');
  }
  renderActivation();
  renderSpendInsight();
  // Empty state visible iff no activity (and not in fresh-account mode).
  if (empty) empty.hidden = L.activity.length > 0 && !L.fresh;
  if (full) (full as HTMLElement).style.display = L.fresh || L.activity.length === 0 ? 'none' : 'block';
}
function checkoutBase(): string {
  // Same-origin /checkout.html — works in dev (5173) and prod.
  return `${location.origin}/checkout.html`;
}
on($('#newOfferCta'), 'click', () => {
  if (!LIVE) return;
  ($('#offerResult') as HTMLElement).hidden = true;
  $('#offerSheet').classList.add('on');
});
on($('[data-act="offer-create"]'), 'click', () => {
  const title = ($('#offer-title') as HTMLInputElement).value.trim();
  if (!title) {
    toast('Name what you’re selling first.', 'err');
    return;
  }
  const amountUsd = parseFloat(String(($('#offer-amount') as HTMLInputElement).value).replace(',', '.'));
  if (!(amountUsd > 0)) {
    toast('Enter a price above $0.', 'err');
    return;
  }
  const btn = $('[data-act="offer-create"]') as HTMLButtonElement;
  btn.disabled = true;
  nexaApi
    .createOffer({ title, amountUsd })
    .then((r) => {
      const link = $('#offerLink') as HTMLAnchorElement;
      // Prefer a same-origin link so the e2e (and dev) resolve; fall back to
      // the server's absolute checkoutUrl if the id can't be derived.
      const id = r.offer.id;
      const url = id ? `${checkoutBase()}?id=${encodeURIComponent(id)}` : r.offer.checkoutUrl;
      link.textContent = displayUrl(url);
      link.href = url;
      link.setAttribute('data-offer-id', id);
      $('#offerCopy').setAttribute('data-copy', url);
      ($('#offerResult') as HTMLElement).hidden = false;
      toast('Checkout link ready · share it anywhere ✓');
    })
    .catch((e: unknown) => {
      toast(e instanceof ApiFailure ? e.message : 'Could not create the offer.', 'err');
    })
    .finally(() => {
      btn.disabled = false;
    });
});

/* ── developers: API keys surface (LIVE mode only) ──
   The /keys routes are session-authed and server-only, so the Profile entry
   stays hidden in pure-demo mode (revealed by setLiveSurfaces) and every action
   here is inert without a live session. */
function maskedKey(prefix: string, last4: string): string {
  return `${prefix}_••••${last4}`;
}

function keyRowEl(k: ApiKey): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lrow key-row';

  const grow = document.createElement('span');
  grow.className = 'grow';
  const t = document.createElement('span');
  t.className = 't mono';
  t.textContent = maskedKey(k.prefix, k.last4);
  const s = document.createElement('span');
  s.className = 's';
  const created = new Date(k.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  s.textContent = (k.label ? `${k.label} · ` : '') + created;
  grow.appendChild(t);
  grow.appendChild(document.createElement('br'));
  grow.appendChild(s);
  row.appendChild(grow);

  const badge = document.createElement('span');
  badge.className = 'tag ' + (k.livemode ? 'live' : 'ok');
  badge.textContent = k.livemode ? 'LIVE' : 'TEST';
  row.appendChild(badge);

  if (k.revokedAt) {
    const revoked = document.createElement('span');
    revoked.className = 'tag dang';
    revoked.textContent = 'REVOKED';
    row.appendChild(revoked);
  } else {
    const del = document.createElement('button');
    del.className = 'pillbtn';
    del.setAttribute('data-act', 'key-revoke');
    del.setAttribute('data-key-id', k.id);
    del.textContent = 'REVOKE';
    row.appendChild(del);
  }
  return row;
}

async function renderKeys(): Promise<void> {
  if (!LIVE) return;
  const list = $('[data-keys-list]');
  try {
    const { data } = await nexaApi.listApiKeys();
    list.textContent = '';
    if (data.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'sub key-empty';
      empty.style.cssText = 'font-size:12px;font-family:var(--mono);color:var(--meta)';
      empty.textContent = 'NO KEYS YET';
      list.appendChild(empty);
      return;
    }
    data.forEach((k) => list.appendChild(keyRowEl(k)));
  } catch (e: unknown) {
    toast(e instanceof ApiFailure ? e.message : 'Could not load keys.', 'err');
  }
}

function revealSecret(created: ApiKeyCreated): void {
  const box = $('[data-key-secret]') as HTMLElement;
  $('[data-key-secret-value]', box).textContent = created.secret;
  $('[data-key-secret-copy]', box).setAttribute('data-copy', created.secret);
  box.hidden = false;
}

on($('[data-act="dev-keys"]'), 'click', () => {
  if (!LIVE) return;
  ($('[data-key-secret]') as HTMLElement).hidden = true;
  $('#profileSheet').classList.remove('on');
  $('#keysSheet').classList.add('on');
  void renderKeys();
});

/* C1 — sign out: clear the httpOnly cookie server-side (best-effort — the
   local session ends regardless), drop the tab token + device hint, and
   reload into the sign-in screen so no in-memory account state survives. */
let signingOut = false;
async function signOut(): Promise<void> {
  if (signingOut) return;
  signingOut = true;
  try {
    await nexaApi.authSignout();
  } catch {
    /* offline sign-out still signs out locally */
  }
  setToken(null);
  location.hash = '#s01';
  location.reload();
}

$$('[data-act="sign-out"]').forEach((el) => {
  on(el, 'click', () => {
    if (!LIVE) return;
    void signOut();
  });
});

function createKey(livemode: boolean): void {
  if (!LIVE) return;
  const sel = livemode ? '[data-act="key-create-live"]' : '[data-act="key-create-test"]';
  const btn = $(sel) as HTMLButtonElement;
  btn.disabled = true;
  nexaApi
    .createApiKey({ livemode })
    .then((created) => {
      revealSecret(created);
      toast(`New ${livemode ? 'live' : 'test'} key created · save it now ✓`);
      return renderKeys();
    })
    .catch((e: unknown) => {
      toast(e instanceof ApiFailure ? e.message : 'Could not create the key.', 'err');
    })
    .finally(() => {
      btn.disabled = false;
    });
}
on($('[data-act="key-create-test"]'), 'click', () => createKey(false));
on($('[data-act="key-create-live"]'), 'click', () => createKey(true));

on($('[data-keys-list]'), 'click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act="key-revoke"]');
  if (!btn) return;
  const id = btn.getAttribute('data-key-id');
  if (!id) return;
  (btn as HTMLButtonElement).disabled = true;
  nexaApi
    .revokeApiKey(id)
    .then(() => {
      toast('Key revoked · it can no longer call the API.');
      return renderKeys();
    })
    .catch((err: unknown) => {
      toast(err instanceof ApiFailure ? err.message : 'Could not revoke the key.', 'err');
      (btn as HTMLButtonElement).disabled = false;
    });
});

/* Theme persistence — boot-time apply, write on toggle. Default to system
   preference (prefers-color-scheme: dark) when nothing is stored. The key
   `maze.theme` is shared with landing-main.ts so a choice on /app.html
   carries over to /landing.html in the same browser. */
const THEME_KEY = 'maze.theme';
type ThemeChoice = 'light' | 'dark';
function readTheme(): ThemeChoice {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(t: ThemeChoice): void {
  $('#stage').setAttribute('data-theme', t);
  document
    .querySelectorAll<HTMLElement>('[data-theme-sw]')
    .forEach((sw) => sw.setAttribute('aria-checked', String(t === 'dark')));
  document
    .querySelectorAll<HTMLElement>('[data-theme-lbl]')
    .forEach((lbl) => (lbl.textContent = t === 'dark' ? 'DARK' : 'LIGHT'));
}
applyTheme(readTheme());

// Any [data-theme-sw] switch (More → Settings + the profile sheet) flips the theme.
// onGlobal so it survives screen transitions; reads the live stage attr as truth.
onGlobal(document, 'click', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('[data-theme-sw]')) return;
  const next: ThemeChoice = $('#stage').getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

const PUSH_PREF_KEY = 'maze.push.enabled';

function pushToggle(): HTMLButtonElement | null {
  return document.getElementById('notificationToggle') as HTMLButtonElement | null;
}

function notificationSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function setNotificationUi(on: boolean, label = on ? 'ON' : 'OFF'): void {
  const btn = pushToggle();
  if (btn) btn.setAttribute('aria-checked', String(on));
  const status = document.getElementById('notificationStatus');
  if (status) status.textContent = label;
}

function rememberPushEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(PUSH_PREF_KEY, '1');
    else localStorage.removeItem(PUSH_PREF_KEY);
  } catch {
    /* private mode: UI still works for this session. */
  }
}

function pushPreferenceEnabled(): boolean {
  try {
    return localStorage.getItem(PUSH_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function pushPayloadFromSubscription(subscription: PushSubscription): PushSubscriptionPayload {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('push_subscription_incomplete');
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

async function serviceWorkerRegistrationForPush(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) throw new Error('service_worker_unavailable');
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

async function syncNotificationUi(): Promise<void> {
  if (!LIVE || !getToken()) {
    setNotificationUi(false);
    return;
  }
  if (!notificationSupported()) {
    setNotificationUi(false, 'UNAVAILABLE');
    return;
  }
  if (Notification.permission === 'denied') {
    setNotificationUi(false, 'BLOCKED');
    return;
  }
  if (!pushPreferenceEnabled()) {
    setNotificationUi(false);
    return;
  }
  try {
    const reg = await serviceWorkerRegistrationForPush();
    const sub = await reg.pushManager.getSubscription();
    setNotificationUi(Boolean(sub), sub ? 'ON' : 'OFF');
  } catch {
    setNotificationUi(false, 'UNAVAILABLE');
  }
}

async function enableNotifications(): Promise<void> {
  if (!LIVE || !getToken()) {
    setNotificationUi(false);
    toast('Sign in to enable notifications.', 'err');
    return;
  }
  if (!notificationSupported()) {
    setNotificationUi(false, 'UNAVAILABLE');
    toast('Notifications are unavailable in this browser.', 'err');
    return;
  }
  if (Notification.permission === 'denied') {
    setNotificationUi(false, 'BLOCKED');
    toast('Notifications are blocked in browser settings.', 'err');
    return;
  }

  const { publicKey } = await nexaApi.pushVapidPublicKey();
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') {
    setNotificationUi(false);
    toast('Notifications not enabled.', 'err');
    return;
  }

  const reg = await serviceWorkerRegistrationForPush();
  const existing = await reg.pushManager.getSubscription();
  const subscription = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  await nexaApi.pushSubscribe(pushPayloadFromSubscription(subscription));
  rememberPushEnabled(true);
  setNotificationUi(true);
  toast('Notifications enabled.');
}

async function disableNotifications(): Promise<void> {
  if (!LIVE || !getToken()) {
    setNotificationUi(false);
    rememberPushEnabled(false);
    toast('Sign in to change notifications.', 'err');
    return;
  }
  try {
    const reg = await serviceWorkerRegistrationForPush();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const payload = pushPayloadFromSubscription(sub);
      await nexaApi.pushUnsubscribe(payload.endpoint);
      await sub.unsubscribe();
    }
  } finally {
    rememberPushEnabled(false);
    setNotificationUi(false);
    toast('Notifications off.');
  }
}

onGlobal(document, 'click', (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest<HTMLButtonElement>('#notificationToggle');
  if (!btn || btn.getAttribute('aria-busy') === 'true') return;
  e.preventDefault();
  btn.setAttribute('aria-busy', 'true');
  const enabled = btn.getAttribute('aria-checked') === 'true';
  (enabled ? disableNotifications() : enableNotifications())
    .catch((err: unknown) => {
      setNotificationUi(false);
      const code = err instanceof ApiFailure ? err.code : '';
      toast(code === 'push_unavailable' ? 'Notifications are not configured yet.' : 'Could not update notifications.', 'err');
    })
    .finally(() => btn.removeAttribute('aria-busy'));
});

void syncNotificationUi();

const legacyApplepayBtn = document.getElementById('applepayBtn') as HTMLButtonElement | null;
if (legacyApplepayBtn) {
  on(legacyApplepayBtn, 'click', () => {
    if (!LIVE) {
      toast('Sign in to add money from a live server ledger.', 'err');
      return;
    }
    legacyApplepayBtn.disabled = true;
    nexaApi
      .topup(100, 'Balance top-up')
      .then(() => {
        toast('$100.00 added');
        void syncFromServer();
        go('s08');
      })
      .catch((e: unknown) => toast(e instanceof ApiFailure ? e.message : 'Top-up failed.', 'err'))
      .finally(() => {
        legacyApplepayBtn.disabled = false;
      });
  });
}

/**
 * Sprint 15 — Stripe Crypto Onramp button on s09. Opens a hosted Stripe page
 * for real USD/EUR -> USDC via card. Demo mode short-circuits to a synthetic
 * /onramp/demo-success that credits the local ledger so the e2e flow stays
 * green without a real Stripe key.
 */
on(document, 'click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('#addRailDetail #onrampStripeBtn');
  if (!btn) return;
  e.preventDefault();
  if (!LIVE) {
    toast('Sign in to onramp from a live server.', 'err');
    return;
  }
  btn.disabled = true;
  try {
    const session = await nexaApi.onrampStripeSession(100, 'base');
    applySourceBadge(
      document.querySelector<HTMLElement>('[data-onramp-stripe-source]'),
      session.sourced ?? null,
    );
    if (session.demo) {
      // Demo path: round-trip through the synthetic success endpoint instead
      // of opening a real Stripe page.
      const r = await nexaApi.onrampDemoSuccess(Math.round(session.amountUsd * 100));
      toast(`${money(r.amountUsd)} added · Stripe demo`);
      void syncFromServer();
      go('s08');
    } else {
      // Live path: open the Stripe hosted page in a new tab so the user can
      // complete card auth + KYC. The webhook credits the ledger.
      toast('Opening Stripe Crypto Onramp ↗');
      window.open(session.redirectUrl, '_blank', 'noopener,noreferrer');
    }
  } catch (e) {
    toast(e instanceof ApiFailure ? e.message : 'Onramp unavailable.', 'err');
  } finally {
    btn.disabled = false;
  }
});

/**
 * Sprint 16 — s24 MCP tool list. Pulls the live provider registry, groups
 * providers by category, and renders one row per agent-accessible tool with
 * a "(N live)" tally. This replaces the static two-row scaffold so the MCP
 * connect screen actually reflects what's live right now.
 */
interface McpToolEntry {
  name: string;
  description: string;
  categories: string[]; // provider categories this tool depends on
}

const MCP_TOOLS: McpToolEntry[] = [
  { name: 'get_balance', description: 'Read the agent’s spendable budget and weekly cap.', categories: ['persistence', 'agent-wallet'] },
  { name: 'pay_endpoint', description: 'Settle an x402 micropayment to any API that asks for one.', categories: ['x402'] },
  { name: 'swap_quote', description: 'Quote a cross-chain swap before executing it.', categories: ['swap'] },
  { name: 'earn_apy', description: 'Read live yield rates across the vetted earn protocols.', categories: ['defi-yield'] },
  { name: 'markets_read', description: 'Read perps and prediction market state, never trade without approval.', categories: ['markets'] },
  { name: 'wallet_address', description: 'Read the agent’s deposit address for its current chain.', categories: ['wallet', 'auth'] },
  { name: 'request_funds', description: 'Ask the operator for more budget when a planned spend exceeds the cap.', categories: ['persistence'] },
  { name: 'transfer', description: 'Move money between the agent and the main account, policy-checked.', categories: ['persistence'] },
];

async function hydrateMcpTools(): Promise<void> {
  const host = document.getElementById('mcpToolList');
  if (!host) return;
  let liveByCat: Record<string, number> = {};
  let totalByCat: Record<string, number> = {};
  try {
    const res = await nexaApi.systemProviders();
    for (const p of res.providers) {
      totalByCat[p.category] = (totalByCat[p.category] ?? 0) + 1;
      if (p.status === 'live') liveByCat[p.category] = (liveByCat[p.category] ?? 0) + 1;
    }
  } catch {
    /* render the static catalog with "—" counters when the registry is unreachable */
    liveByCat = {};
    totalByCat = {};
  }
  host.textContent = '';
  for (const tool of MCP_TOOLS) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't mono';
    t.style.fontSize = '12.5px';
    t.style.fontWeight = '600';
    t.textContent = tool.name;
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = tool.description;
    grow.appendChild(s);
    row.appendChild(grow);
    const live = tool.categories.reduce((a, c) => a + (liveByCat[c] ?? 0), 0);
    const total = tool.categories.reduce((a, c) => a + (totalByCat[c] ?? 0), 0);
    const tag = document.createElement('span');
    if (total === 0) {
      tag.className = 'tag';
      tag.textContent = 'AWAITING';
    } else if (live === 0) {
      tag.className = 'tag warnx';
      tag.textContent = `0 / ${total}`;
    } else if (live === total) {
      tag.className = 'tag ok';
      tag.textContent = `LIVE · ${live}`;
    } else {
      tag.className = 'tag live';
      tag.textContent = `${live} / ${total}`;
    }
    row.appendChild(tag);
    host.appendChild(row);
  }
}

/** Paint the s09 onramp source badge from /onramp/stripe/status. */
async function hydrateOnrampBadge(): Promise<void> {
  if (!LIVE) {
    applySourceBadge(document.querySelector<HTMLElement>('[data-onramp-stripe-source]'), null);
    applySourceBadge(document.querySelector<HTMLElement>('[data-monerium-source]'), null);
    return;
  }
  try {
    const r = await nexaApi.onrampStripeStatus();
    applySourceBadge(
      document.querySelector<HTMLElement>('[data-onramp-stripe-source]'),
      r.sourced,
    );
  } catch {
    applySourceBadge(document.querySelector<HTMLElement>('[data-onramp-stripe-source]'), null);
  }
  await hydrateMoneriumProfile();
}

/**
 * Sprint 15 — Monerium card on s09. Renders the user's IBAN + BIC (in their
 * name; not custodial-to-MAZE) and paints the source badge.
 */
async function hydrateMoneriumProfile(): Promise<void> {
  const ibanEl = document.getElementById('moneriumIban');
  const bicEl = document.getElementById('moneriumBic');
  const kycEl = document.getElementById('moneriumKyc');
  const copyBtn = document.getElementById('copyMoneriumIban') as HTMLButtonElement | null;
  const badgeEl = document.querySelector<HTMLElement>('[data-monerium-source]');

  const setUnavailable = (reason: string): void => {
    if (ibanEl) ibanEl.textContent = reason;
    if (bicEl) bicEl.textContent = 'Unavailable';
    if (kycEl) kycEl.textContent = 'Pending';
    if (copyBtn) {
      copyBtn.disabled = true;
      copyBtn.removeAttribute('data-copy');
    }
  };

  try {
    const profile = await nexaApi.moneriumProfile();
    if (ibanEl) ibanEl.textContent = profile.iban;
    if (bicEl) bicEl.textContent = profile.bic;
    if (kycEl) {
      const label = profile.kycStatus.toUpperCase();
      kycEl.textContent = label;
    }
    if (copyBtn) {
      const copyValue = `IBAN ${profile.iban} · BIC ${profile.bic}`;
      copyBtn.disabled = false;
      copyBtn.setAttribute('data-copy', copyValue);
    }
    applySourceBadge(badgeEl, profile.sourced);
  } catch (e) {
    setUnavailable(e instanceof ApiFailure && e.status === 404 ? 'Not onboarded' : 'Unavailable');
    applySourceBadge(badgeEl, null);
  }
}
on($('#viewAllActivityBtn'), 'click', () => {
  toast('Full activity history is not connected yet.', 'err');
});
const agentCardNotifyBtn = document.getElementById('agentCardNotifyBtn');
if (agentCardNotifyBtn) {
  on(agentCardNotifyBtn, 'click', () => {
    toast('Agent card issuance is not connected yet.', 'err');
  });
}

/* ── send flow ── */
let amtStr = '';
function amtVal(): number {
  return parseFloat(amtStr || '0') || 0;
}
function renderAmt(): void {
  const p = amtStr.split('.');
  const disp = $('#amtDisp');
  disp.textContent = '';
  disp.appendChild(document.createTextNode('$'));
  const whole = document.createElement('span');
  whole.textContent = p[0] || '0';
  disp.appendChild(whole);
  const cents = document.createElement('small');
  cents.textContent = p.length > 1 ? '.' + p[1] : '';
  disp.appendChild(cents);
  ($('#amtGo') as HTMLButtonElement).disabled = !(amtVal() >= 1 && L.bal != null && amtVal() <= L.bal);
}
on($('#kpad'), 'click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  const t = b.textContent ?? '';
  if (t === '⌫') amtStr = amtStr.slice(0, -1);
  else if (t === '.') {
    if (!amtStr.includes('.')) amtStr = (amtStr || '0') + '.';
  } else {
    const nx = amtStr + t;
    if (/^\d{0,5}(\.\d{0,2})?$/.test(nx)) amtStr = nx;
  }
  renderAmt();
});
on($('#amtGo'), 'click', () => {
  L.sendAmt = amtVal();
  $('#amtEcho2').textContent = money(L.sendAmt);
  ($('#sendStep1') as HTMLElement).hidden = true;
  ($('#sendStep2') as HTMLElement).hidden = false;
});
on($('#sendStep2'), 'click', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('[data-recip]');
  if (!r) return;
  const to = r.getAttribute('data-recip');
  if (!to) return;
  L.sendTo = to;
  L.sendNew = r.hasAttribute('data-new');
  $('#cfTo').textContent = L.sendTo;
  $('#cfAmt').textContent = money(L.sendAmt);
  $('#cfAmt2').textContent = money(L.sendAmt);
  ($('#cfBody') as HTMLElement).hidden = false;
  ($('#cfDone') as HTMLElement).hidden = true;
  go('s11');
});
let sendAttempt: OrderAttemptKey | null = null;
on($('#sendNow'), 'click', async () => {
  const btn = $('#sendNow') as HTMLButtonElement;
  btn.disabled = true;
  try {
    if (LIVE) {
      const fingerprint = `send:${L.sendAmt}:${L.sendTo}`;
      sendAttempt = idempotencyKeyFor(sendAttempt, fingerprint);
      await nexaApi.send(L.sendAmt, L.sendTo, { idempotencyKey: sendAttempt.idempotencyKey });
      sendAttempt = null;
      await syncFromServer();
    } else {
      L.bal = (L.bal ?? 0) - L.sendAmt;
      L.fresh = false;
      L.activity.unshift({
        n: 'Sent · ' + L.sendTo,
        s: (L.sendNew ? 'CLAIM PENDING' : 'DELIVERED') + ' · JUST NOW',
        a: '−' + money(L.sendAmt),
        k: 'out',
      });
    }
  } catch (e: unknown) {
    if (e instanceof ApiFailure) toast(e.message, 'err');
    else toast('Could not send payment.', 'err');
    if (LIVE) void syncFromServer();
    btn.disabled = false;
    return;
  }
  $('#cfDoneTxt').textContent = L.sendNew
    ? L.sendTo + ' gets a claim email right now.'
    : 'Delivered instantly to ' + L.sendTo + '.';
  $('#pvAmt').textContent = money(L.sendAmt);
  ($('#cfBody') as HTMLElement).hidden = true;
  ($('#cfDone') as HTMLElement).hidden = false;
  amtStr = '';
  renderAmt();
  ($('#sendStep1') as HTMLElement).hidden = false;
  ($('#sendStep2') as HTMLElement).hidden = true;
  btn.disabled = false;
});
on($('#previewEmail'), 'click', () => $('#emailPreview').classList.add('on'));

/* ── request ── */
function slug4(): string {
  let s = Math.floor(Math.random() * 1679616).toString(36);
  while (s.length < 4) s = 'x' + s;
  return s;
}
on($('#reqGo'), 'click', () => {
  const v = parseFloat(String(($('#reqAmt') as HTMLInputElement).value).replace(',', '.'));
  if (!(v > 0)) {
    toast('Enter an amount above $0.', 'err');
    return;
  }
  const note = ($('#reqNote') as HTMLInputElement).value;
  const showLink = (url: string) => {
    $('#reqLink').textContent = displayUrl(url);
    $('#reqCopy').setAttribute('data-copy', `${url} · ${money(v)} · ${note}`);
    ($('#reqOut') as HTMLElement).hidden = false;
  };
  if (LIVE) {
    nexaApi
      .requestLink(v, note)
      .then((r) => showLink(r.url))
      .catch(() => showLink(payLink(slug4())));
  } else {
    showLink(payLink(slug4()));
  }
});

/* ── earn ── */
on($('#depRange'), 'input', () => {
  const v = parseInt(($('#depRange') as HTMLInputElement).value, 10);
  $('#depV').textContent = v.toLocaleString('en-US');
  const depProj = document.getElementById('depProj');
  if (depProj) depProj.textContent = projectedYield(v, true);
});
let earnDepositAttempt: OrderAttemptKey | null = null;
on($('#depGo'), 'click', () => {
  const raw = $('#depV').textContent?.replace(/,/g, '') || (($('#depRange') as HTMLInputElement).value);
  const v = Number(raw);
  if (!(v > 0)) {
    toast('Enter an amount to deposit.', 'err');
    return;
  }
  if (L.bal == null || v > L.bal) {
    toast("That's more than your spending balance.", 'err');
    return;
  }
  if (LIVE) {
    const fingerprint = `earn-deposit:${v}`;
    earnDepositAttempt = idempotencyKeyFor(earnDepositAttempt, fingerprint);
    const idempotencyKey = earnDepositAttempt.idempotencyKey;
    liveCall(nexaApi.earnDeposit(v, undefined, { idempotencyKey }).then((r) => {
      earnDepositAttempt = null;
      return r;
    }));
  } else {
    L.bal -= v;
    L.earnPos = (L.earnPos ?? 0) + v;
    L.fresh = false;
    $('#earnPos').textContent = money(L.earnPos);
    renderEarnYield();
    L.activity.unshift({
      n: 'Moved to Earn',
      s: `AUTO · ${earnApyBps ? apyLabel(earnApyBps) : 'APY PENDING'} · JUST NOW`,
      a: '−' + money(v),
      k: 'in',
    });
    renderBal();
  }
  toast(earnApyBps ? `${money(v)} now earning ${apyLabel(earnApyBps)} ✓` : `${money(v)} deposited to Earn ✓`);
  go('s14');
});

/* ── swap (quote-driven Socket/LIFI routes) ── */
type SwapChain = 'base' | 'gnosis' | 'polygon' | 'optimism' | 'arbitrum' | 'solana';
type SwapSymbol = 'USDC' | 'EURC' | 'EURe' | 'SOL' | 'mSOL';
type SwapTokenId = 'base:USDC' | 'base:EURC' | 'gnosis:EURe' | 'solana:USDC' | 'solana:SOL' | 'solana:mSOL';
interface SwapToken {
  id: SwapTokenId;
  sym: SwapSymbol;
  token: SwapSymbol;
  name: string;
  chain: SwapChain;
  ic: string;
  group: 'cash';
}
const SWAP_TOKENS: SwapToken[] = [
  { id: 'base:USDC', sym: 'USDC', token: 'USDC', name: 'USD Coin on Base', chain: 'base', ic: '$', group: 'cash' },
  { id: 'base:EURC', sym: 'EURC', token: 'EURC', name: 'Euro Coin on Base', chain: 'base', ic: '€', group: 'cash' },
  { id: 'gnosis:EURe', sym: 'EURe', token: 'EURe', name: 'Monerium EURe on Gnosis', chain: 'gnosis', ic: '€', group: 'cash' },
  { id: 'solana:USDC', sym: 'USDC', token: 'USDC', name: 'USD Coin on Solana', chain: 'solana', ic: '$', group: 'cash' },
  { id: 'solana:SOL', sym: 'SOL', token: 'SOL', name: 'Solana', chain: 'solana', ic: 'S', group: 'cash' },
  { id: 'solana:mSOL', sym: 'mSOL', token: 'mSOL', name: 'Marinade staked SOL', chain: 'solana', ic: 'm', group: 'cash' },
];
const swTok = (id: string): SwapToken => SWAP_TOKENS.find((t) => t.id === id) ?? SWAP_TOKENS[0]!;
let swFrom: SwapTokenId = 'base:USDC';
let swTo: SwapTokenId = 'base:EURC';
let swPickSide: 'from' | 'to' = 'from';
let swapQuoteSeq = 0;
let latestSwapQuote: Awaited<ReturnType<typeof nexaApi.swapQuote>> | null = null;
let swapExecuteAttempt: OrderAttemptKey | null = null;
const SWAP_QUOTE_INPUT_DEBOUNCE_MS = 300;
let swapQuoteDebounceTimer: number | null = null;

function swFmt(n: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: n !== 0 && n < 1 ? 6 : 2,
  });
}
function swDirection(from: SwapToken, to: SwapToken): 'usd-eur' | 'eur-usd' {
  return from.sym === 'USDC' && to.sym !== 'USDC' ? 'usd-eur' : 'eur-usd';
}

function setSwapQuotePending(label = 'Quote pending'): void {
  $('#swOut').textContent = '0.00';
  $('#swRate').textContent = label;
  $('#swFee').textContent = label;
  $('#swRoute').textContent = label;
  $('#swToUsd').textContent = label;
  swapQuoteSourced = null;
  applySourceBadge(document.querySelector<HTMLElement>('[data-swap-source]'), null);
}

function refreshSwapQuote(): void {
  const from = swTok(swFrom);
  const to = swTok(swTo);
  const v = parseFloat(String(($('#swAmt') as HTMLInputElement).value).replace(',', '.')) || 0;
  const seq = ++swapQuoteSeq;
  latestSwapQuote = null;
  if (v <= 0) {
    setSwapQuotePending('Enter an amount');
    return;
  }
  $('#swFromUsd').textContent = money(v);
  setSwapQuotePending(getToken() ? 'Routing...' : 'Sign in for quote');
  if (!getToken()) return;

  void nexaApi
    .swapQuote({
      amount: v,
      direction: swDirection(from, to),
      fromChain: from.chain,
      toChain: to.chain,
      fromToken: from.token,
      toToken: to.token,
      enableRefuel: from.chain !== to.chain,
    })
    .then((q) => {
      if (seq !== swapQuoteSeq) return;
      if (q.source === 'demo' && !DEMO_MODE_HINT) throw new Error('demo_quote');
      latestSwapQuote = q;
      swapQuoteSourced = q.sourced ?? null;
      $('#swOut').textContent = swFmt(q.out);
      $('#swToUsd').textContent = `≈ ${swFmt(q.out)} ${to.sym}`;
      // Quote strip: route + ETA + source badge surface above the KV grid.
      const strip = document.getElementById('swQuoteStrip');
      const routeStrip = document.getElementById('swRouteStrip');
      const etaStrip = document.getElementById('swEtaStrip');
      if (strip) strip.hidden = false;
      if (routeStrip)
        routeStrip.textContent = q.source === 'demo' ? 'DEMO ROUTE' : q.source.toUpperCase();
      if (etaStrip) {
        etaStrip.textContent =
          q.source === 'lifi' ? '~22s · LI.FI'
          : q.source === 'socket' ? '~30s · Socket'
          : q.source === 'demo' ? 'Demo · ~12s'
          : '~35s';
      }
      $('#swRate').textContent =
        `1 ${from.sym} = ${q.rate.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${to.sym}`;
      const fee = q.fees + (q.refuelGasUsd ?? 0);
      $('#swFee').textContent = fee > 0 ? money(fee) : '$0.00';
      $('#swRoute').textContent = q.source === 'demo' ? 'DEMO QUOTE' : q.source.toUpperCase();
      applySourceBadge(document.querySelector<HTMLElement>('[data-swap-source]'), swapQuoteSourced);
    })
    .catch(() => {
      if (seq !== swapQuoteSeq) return;
      latestSwapQuote = null;
      swapQuoteSourced = null;
      $('#swOut').textContent = 'Unavailable';
      $('#swRate').textContent = 'Quote unavailable';
      $('#swFee').textContent = 'Unavailable';
      $('#swRoute').textContent = 'No live route';
      $('#swToUsd').textContent = 'Try another route';
      const strip = document.getElementById('swQuoteStrip');
      if (strip) strip.hidden = true;
      applySourceBadge(document.querySelector<HTMLElement>('[data-swap-source]'), null);
    });
}

/* Slippage chips on s16 — purely client-state for now; threaded into the
   quote request once /swap/quote accepts a slippage param. */
function scheduleSwapQuoteRefresh(): void {
  if (swapQuoteDebounceTimer) window.clearTimeout(swapQuoteDebounceTimer);
  swapQuoteDebounceTimer = window.setTimeout(() => {
    swapQuoteDebounceTimer = null;
    refreshSwapQuote();
  }, SWAP_QUOTE_INPUT_DEBOUNCE_MS);
}

let swSlip = 0.5;
$$('[data-slip]').forEach((b) => {
  on(b, 'click', () => {
    swSlip = Number(b.getAttribute('data-slip') ?? '0.5');
    $$('[data-slip]').forEach((bb) => bb.classList.toggle('onx', bb === b));
    const disp = document.getElementById('swSlipDisp');
    if (disp) disp.textContent = `${swSlip.toFixed(1)}%`;
  });
});
// keep swSlip used so esbuild does not warn under noUnusedLocals
void swSlip;

function swRender(): void {
  const from = swTok(swFrom);
  const to = swTok(swTo);
  $('#swFromSym').textContent = from.sym;
  $('#swToSym').textContent = to.sym;
  ($('#swFromIc') as HTMLElement).textContent = from.ic || from.sym.slice(0, 1);
  ($('#swToIc') as HTMLElement).textContent = to.ic || to.sym.slice(0, 1);
  refreshSwapQuote();
}
function renderTokenList(q = ''): void {
  const list = $('#tokenList');
  list.textContent = '';
  const groups: Array<[string, SwapToken['group']]> = [
    ['SUPPORTED CASH ROUTES', 'cash'],
  ];
  const ql = q.trim().toLowerCase();
  for (const [label, g] of groups) {
    const items = SWAP_TOKENS.filter(
      (t) => t.group === g && (!ql || t.sym.toLowerCase().includes(ql) || t.name.toLowerCase().includes(ql)),
    );
    if (!items.length) continue;
    const head = document.createElement('p');
    head.className = 'tk-group';
    head.textContent = label;
    list.appendChild(head);
    for (const t of items) {
      const row = document.createElement('button');
      row.className = 'tk-row';
      const ic = document.createElement('span');
      ic.className = 'token-ic';
      ic.textContent = t.ic || t.sym.slice(0, 2);
      const grow = document.createElement('span');
      grow.className = 'grow';
      const nm = document.createElement('span');
      nm.className = 'tk-name';
      nm.textContent = t.name;
      const sub = document.createElement('span');
      sub.className = 'tk-sub';
      sub.textContent = `${t.sym} · ${t.chain.toUpperCase()}`;
      grow.append(nm, document.createElement('br'), sub);
      row.append(ic, grow);
      row.addEventListener('click', () => {
        if (swPickSide === 'from') {
          if (swTo === t.id) swTo = swFrom;
          swFrom = t.id;
        } else {
          if (swFrom === t.id) swFrom = swTo;
          swTo = t.id;
        }
        closeOverlays();
        swRender();
      });
      list.appendChild(row);
    }
  }
  // 1.10 fix — three surfaces exchange assets (Swap, Trade→Memes, Trade→Spot)
  // and this picker is cash-only; a user hunting for SOL/memecoins here hit a
  // dead end with no signpost. Cross-link to the Trade hub instead.
  const cross = document.createElement('button');
  cross.className = 'tk-row';
  const crossIc = document.createElement('span');
  crossIc.className = 'token-ic';
  crossIc.textContent = '→';
  const crossGrow = document.createElement('span');
  crossGrow.className = 'grow';
  const crossNm = document.createElement('span');
  crossNm.className = 'tk-name';
  crossNm.textContent = 'Looking for memecoins or spot crypto?';
  const crossSub = document.createElement('span');
  crossSub.className = 'tk-sub';
  crossSub.textContent = 'OPEN TRADE · MEMES, SPOT, STOCKS, PREDICTIONS';
  crossGrow.append(crossNm, document.createElement('br'), crossSub);
  cross.append(crossIc, crossGrow);
  cross.addEventListener('click', () => {
    closeOverlays();
    go('s27');
  });
  list.appendChild(cross);
}
on($('#swAmt'), 'input', scheduleSwapQuoteRefresh);
on($('#swFlip'), 'click', () => {
  const a = swFrom;
  swFrom = swTo;
  swTo = a;
  swRender();
});
on($('#swFromBtn'), 'click', () => {
  swPickSide = 'from';
  renderTokenList();
  openOvl('tokenSheet');
});
on($('#swToBtn'), 'click', () => {
  swPickSide = 'to';
  renderTokenList();
  openOvl('tokenSheet');
});
on($('#tokenSearch'), 'input', (e) => renderTokenList((e.target as HTMLInputElement).value));
on($('#swGo'), 'click', () => {
  const from = swTok(swFrom);
  const to = swTok(swTo);
  const v = parseFloat(String(($('#swAmt') as HTMLInputElement).value).replace(',', '.')) || 0;
  if (!LIVE) {
    toast('Sign in to review a live swap quote.', 'err');
    return;
  }
  if (!latestSwapQuote) {
    toast('Live quote unavailable. Try another route.', 'err');
    refreshSwapQuote();
    return;
  }
  const route = (latestSwapQuote.source ?? '…').toString().toUpperCase();
  const fees = latestSwapQuote.fees != null ? money(Number(latestSwapQuote.fees)) : '…';
  openReviewSheet({
    eyebrow: `SWAP · ${from.sym} → ${to.sym}`,
    amount: money(v),
    subline: `~${(latestSwapQuote.out ?? 0).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${to.sym}`,
    rows: [
      { k: 'ROUTE', v: route },
      { k: 'RATE', v: String(latestSwapQuote.rate ?? '…') },
      { k: 'FROM', v: `${from.sym} · ${from.chain}` },
      { k: 'TO', v: `${to.sym} · ${to.chain}` },
      { k: 'NETWORK FEE', v: fees },
    ],
    badge: { source: 'live', provider: route },
    finePrint: 'Swap routes via external bridges. Quotes are best-effort and refresh continuously.',
    confirmLabel: 'Sign swap',
    onConfirm: () => {
      const direction = swDirection(from, to);
      const fingerprint = `swap:${v}:${direction}:${from.chain}:${from.token}:${to.chain}:${to.token}:${from.chain !== to.chain}`;
      swapExecuteAttempt = idempotencyKeyFor(swapExecuteAttempt, fingerprint);
      liveCall(
        nexaApi.swapExecute(v, direction, {
          fromChain: from.chain,
          toChain: to.chain,
          fromToken: from.token,
          toToken: to.token,
          enableRefuel: from.chain !== to.chain,
          idempotencyKey: swapExecuteAttempt.idempotencyKey,
        }).then((r) => {
          swapExecuteAttempt = null;
          return r;
        }),
      );
      toast(`Swap submitted · ${route} route`);
      go('s08');
    },
  });
});

/* ── card ── */
on($('#revealBtn'), 'click', () => {
  if (L.frozen) {
    toast('Card is frozen.', 'err');
    return;
  }
  if (!cardView?.last4) {
    toast('Card details unavailable until a live card is issued.', 'err');
    return;
  }
  $('#faceid').classList.add('on');
  syncScrollLock();
  window.setTimeout(
    () => {
      $('#faceid').classList.remove('on');
      syncScrollLock();
      const vc = $('#vCard');
      if (!RM) {
        vc.classList.add('flip');
        window.setTimeout(() => vc.classList.remove('flip'), 760);
      }
      window.setTimeout(() => {
        setCardControls(cardView);
        toast('Full card details stay masked in this app.', 'err');
      }, RM ? 0 : 340);
    },
    RM ? 100 : 1000,
  );
});
function setFrozen(f: boolean): void {
  setCardControls({
    last4: cardView?.last4 ?? null,
    network: cardView?.network ?? null,
    kind: cardView?.kind ?? 'DEBIT',
    frozen: f,
    dayLimitUsd: cardView?.dayLimitUsd ?? 500,
    demo: cardView?.demo ?? false,
  });
  if (LIVE) liveCall(nexaApi.cardFreeze(f));
  toast(f ? 'Card frozen. One tap to undo.' : 'Card active again');
}
on($('#freezeBtn2'), 'click', () => setFrozen(!L.frozen));
on($('#freezeSw'), 'click', () => setFrozen(!L.frozen));
on($('#applePayBtn'), 'click', () => {
  if (!cardView?.last4) {
    toast('Apple Pay provisioning is unavailable until a live card is issued.', 'err');
    return;
  }
  toast('Apple Pay provisioning is not connected yet.', 'err');
});

/* ── agents ── */
on($('#killSw'), 'click', () => {
  L.killed = $('#killSw').getAttribute('aria-checked') !== 'true';
  $('#killSw').setAttribute('aria-checked', String(L.killed));
  $('#agStatus').textContent = L.killed ? 'PAUSED' : 'ACTIVE';
  $('#agStatus').className = 'tag ' + (L.killed ? 'dang' : 'live');
  $$('[data-agpill]').forEach((p) => {
    p.textContent = L.killed ? 'PAUSED' : 'LIVE';
    p.className = 'tag ' + (L.killed ? 'dang' : 'live');
  });
  if (LIVE) liveCall(nexaApi.killSwitch(L.killed));
  toast(L.killed ? 'Every agent paused. Nothing can spend.' : 'Agents resumed under policy ✓');
});
let agentApproveAttempt: OrderAttemptKey | null = null;
on($('#agApprove'), 'click', () => {
  L.spentAg += 2.4;
  $('#agSpent').textContent = money(L.spentAg);
  $('#agMeter').style.width = Math.min(100, (L.spentAg / L.capAg) * 100) + '%';
  if (LIVE) {
    const fingerprint = 'agent-approve:ResearchBot-01:dataset.vendor.io/v1/access:2.4:dataset access';
    agentApproveAttempt = idempotencyKeyFor(agentApproveAttempt, fingerprint);
    const idempotencyKey = agentApproveAttempt.idempotencyKey;
    liveCall(nexaApi.approveOnce('ResearchBot-01', 'dataset.vendor.io/v1/access', 2.4, 'dataset access', { idempotencyKey }).then((r) => {
      agentApproveAttempt = null;
      return r;
    }));
  }
  const row = $('#agApprove').closest('.lrow');
  if (row) {
    row.textContent = '';
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.appendChild(
      svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="1.8"><path d="M5 12.5l4.2 4L19 7"/></svg>',
      ),
    );
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = 'Released $2.40 · dataset access';
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = 'APPROVED BY YOU · JUST NOW';
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    grow.appendChild(s);
    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = '−$2.40';
    row.appendChild(ic);
    row.appendChild(grow);
    row.appendChild(amt);
  }
  toast('Approved. $2.40 released under your rule.');
});
$$('[data-chip2],[data-chip3]').forEach((ch) => {
  on(ch, 'click', () => {
    if (ch.hasAttribute('data-chip3')) $$('[data-chip3]').forEach((o) => o.classList.remove('onx'));
    ch.classList.toggle('onx', ch.hasAttribute('data-chip3') ? true : !ch.classList.contains('onx'));
  });
});
on($('#agCreate'), 'click', () => {
  const nm = (($('#agName') as HTMLInputElement).value || '').trim();
  if (!nm) {
    toast('Give your agent a name first.', 'err');
    return;
  }
  const capD = parseFloat(String(($('#agCapDay') as HTMLInputElement).value).replace(',', '.')) || 10;
  const capT = parseFloat(String(($('#agCapTx') as HTMLInputElement).value).replace(',', '.')) || 1;
  const initials = nm.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AG';

  const row = document.createElement('div');
  row.className = 'lrow';
  row.dataset['go'] = 's22';
  row.style.cursor = 'pointer';
  setKeyboardAction(row);
  const av = document.createElement('span');
  av.className = 'agent-av';
  av.textContent = initials;
  const grow = document.createElement('span');
  grow.className = 'grow';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = nm;
  const s = document.createElement('span');
  s.className = 's';
  s.textContent = `$${capD.toFixed(2)}/DAY · $${capT.toFixed(2)}/TX · NOT FUNDED`;
  grow.appendChild(t);
  grow.appendChild(document.createElement('br'));
  grow.appendChild(s);
  const pill = document.createElement('span');
  pill.className = 'tag';
  pill.setAttribute('data-agpill', '');
  pill.textContent = 'READY';
  row.appendChild(av);
  row.appendChild(grow);
  row.appendChild(pill);
  $('#agentList').appendChild(row);

  if (LIVE) liveCall(nexaApi.agentCreate(nm, capD, capT));
  toast(nm + ' created. Fund it to switch it on.');
  go('s19');
});
let agentFundAttempt: OrderAttemptKey | null = null;
on($('#fundRange'), 'input', () => {
  const v = parseInt(($('#fundRange') as HTMLInputElement).value, 10);
  $('#fundV').textContent = String(v);
  $('#fundEcho').textContent = money(v);
});
on($('#fundGo'), 'click', () => {
  const v = parseInt(($('#fundRange') as HTMLInputElement).value, 10);
  if (L.bal == null || v > L.bal) {
    toast('Not enough in your main balance.', 'err');
    return;
  }
  L.capAg = v;
  L.spentAg = 0;
  $('#agSpent').textContent = money(0);
  $('#agMeter').style.width = '0%';
  const ofEl = $$('#s19 .sub.num')[0];
  if (ofEl) ofEl.textContent = 'of ' + money(v);
  if (LIVE) {
    const fingerprint = `agent-fund:ResearchBot-01:${v}`;
    agentFundAttempt = idempotencyKeyFor(agentFundAttempt, fingerprint);
    const idempotencyKey = agentFundAttempt.idempotencyKey;
    liveCall(nexaApi.agentFund('ResearchBot-01', v, { idempotencyKey }).then((r) => {
      agentFundAttempt = null;
      return r;
    }));
  } else {
    L.bal -= v;
    L.fresh = false;
    L.activity.unshift({
      n: 'Funded ResearchBot-01',
      s: 'AGENT BUDGET · JUST NOW',
      a: '−' + money(v),
      k: 'agent',
    });
    renderBal();
  }
  toast(money(v) + ' assigned · caps and rules apply ✓');
  go('s19');
});

/* ── detail fill, sheets, earn segments, motion helpers ── */
function tweenMoney(el: HTMLElement, target: number): void {
  const t0 = performance.now();
  const step = (t: number): void => {
    const k = Math.min(1, (t - t0) / 800);
    el.textContent = money(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  step(t0);
}

function openOvl(id: string): void {
  const o = document.getElementById(id);
  if (!o) return;
  if (id === 'wdSheet') {
    const max = Math.max(50, Math.floor((L.earnPos ?? 0) / 50) * 50);
    const range = $('#wdRange') as HTMLInputElement;
    range.max = String(max);
    range.value = String(Math.min(500, max));
    $('#wdV').textContent = parseInt(range.value, 10).toLocaleString('en-US');
  }
  if (id === 'bridgeWdSheet') {
    const max = Math.max(10, Math.floor((L.bal ?? 0) / 10) * 10);
    const range = $('#bwRange') as HTMLInputElement;
    range.max = String(max);
    range.value = String(Math.min(100, max));
    const v = parseInt(range.value, 10);
    $('#bwV').textContent = v.toLocaleString('en-US');
    $('#bwGoLbl').textContent = '$' + v.toLocaleString('en-US');
    void loadPayoutMethods();
  }
  o.classList.add('on');
  syncScrollLock();
}

const AD: Record<string, [string, string]> = {
  in: ['Bank transfer · auto-routed', 'In your balance · earning'],
  out: ['MAZE transfer · by email', 'Sent'],
  card: ['Card · Apple Pay', 'Settled'],
  agent: ['Agent · pay-per-request', 'Within policy · logged'],
  x402: ['Agent · pay-per-request', 'Within policy · logged'],
  swap: ['Swap · mid-market', 'Converted instantly'],
  amazon: ['Card · Apple Pay', 'Settled'],
  spotify: ['Card · subscription', 'Settled'],
  uber: ['Card · Apple Pay', 'Settled'],
};

function shortRef(v: string): string {
  return v.length > 13 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

function statusLabel(r: TxRow): string {
  if (r.status) return r.status.replace(/_/g, ' ').toUpperCase();
  if (r.s.includes('PENDING')) return 'CLAIM PENDING';
  if (r.s.includes('SUBMITTED')) return 'SUBMITTED';
  if (r.s.includes('FAILED')) return 'FAILED';
  return 'COMPLETED';
}

function statusClass(label: string): string {
  if (label.includes('FAILED')) return 'dang';
  if (label.includes('PENDING') || label.includes('SUBMITTED')) return 'warnx';
  return 'ok';
}

function explorerUrl(r: TxRow): string | null {
  if (r.explorerUrl) return r.explorerUrl;
  if (!r.txHash) return null;
  const chain = (r.chain ?? 'base').toLowerCase();
  if (chain === 'base') return `https://basescan.org/tx/${r.txHash}`;
  if (chain === 'ethereum' || chain === 'mainnet') return `https://etherscan.io/tx/${r.txHash}`;
  if (chain === 'gnosis') return `https://gnosisscan.io/tx/${r.txHash}`;
  if (chain === 'polygon') return `https://polygonscan.com/tx/${r.txHash}`;
  if (chain === 'optimism') return `https://optimistic.etherscan.io/tx/${r.txHash}`;
  if (chain === 'arbitrum') return `https://arbiscan.io/tx/${r.txHash}`;
  if (chain === 'solana') return `https://solscan.io/tx/${r.txHash}`;
  return null;
}

function setOptionalDetail(id: string, value: string | null): void {
  const row = document.getElementById(`${id}Row`);
  const el = document.getElementById(id);
  if (!row || !el) return;
  row.hidden = !value;
  if (value) el.textContent = value;
}

function fillDetail(i: number): void {
  const r = L.activity[i];
  if (!r) return;
  fillDetailRow(r, i);
}

function fillDetailRow(r: TxRow, i: number): void {
  $('#adAv').textContent = r.n.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'NX';
  $('#adName').textContent = r.n;
  $('#adAmt').textContent = r.a;
  $('#adAmt').style.color = r.pos ? 'var(--success)' : 'var(--fg)';
  const label = statusLabel(r);
  $('#adTag').textContent = label;
  $('#adTag').className = 'tag ' + statusClass(label);
  const m = AD[r.k] ?? AD['in']!;
  $('#adMethod').textContent = r.venue ?? m[0];
  $('#adStatus').textContent = label === 'CLAIM PENDING' ? 'Waiting for them to sign up' : m[1];
  $('#adDate').textContent = r.s.includes('JUST NOW') ? 'Just now' : (r.at ? new Date(r.at).toLocaleString() : 'Today');
  setOptionalDetail('adVenue', r.venue ?? null);
  setOptionalDetail('adSigner', r.signer ? shortRef(r.signer) : null);
  const ref = r.txHash ? shortRef(r.txHash) : (r.id ?? `NX-${2400 + i}-${8800 + i * 7}`);
  $('#adRef').textContent = ref;
  const link = explorerUrl(r);
  const linkRow = document.getElementById('adExplorerRow');
  const linkEl = document.getElementById('adExplorer') as HTMLAnchorElement | null;
  if (linkRow && linkEl) {
    linkRow.hidden = !link;
    if (link) linkEl.href = link;
  }
  $('#adAdv').textContent = r.txHash
    ? `Settlement: ${r.chain ?? 'base'} · ${r.venue ?? m[0]} · signer ${r.signer ? shortRef(r.signer) : 'unavailable'} · tx ${r.txHash}.`
    : `Settlement: USDC on Base · auto-converted · gas sponsored by MAZE · internal ref ${ref}.`;
}

/* ── Sprint 10 Item A — earn config toggles (s14 BALANCE seg) ── */
function patchEarnConfig(patch: { earnByDefault?: boolean; autoDivestOnSpend?: boolean; divestThresholdUsd?: number }): void {
  if (!LIVE) return;
  nexaApi
    .configureEarn(patch)
    .then((r) => renderEarnConfig(r.config))
    .catch((e: unknown) => {
      if (e instanceof ApiFailure) toast(e.message, 'err');
    });
}
function setEarnChecked(selector: string, isOn: boolean): void {
  $$(selector).forEach((sw) => sw.setAttribute('aria-checked', String(isOn)));
}
$$('#earnCfgDefault,#earnCfgDefaultS14a').forEach((sw) => {
  on(sw, 'click', () => {
    const isOn = sw.getAttribute('aria-checked') !== 'true';
    setEarnChecked('#earnCfgDefault,#earnCfgDefaultS14a', isOn);
    patchEarnConfig({ earnByDefault: isOn });
    if (!LIVE) toast(isOn ? 'Auto-deposit on. Demo only.' : 'Auto-deposit off. Demo only.');
  });
});
$$('#earnCfgDivest,#earnCfgDivestS14a').forEach((sw) => {
  on(sw, 'click', () => {
    const isOn = sw.getAttribute('aria-checked') !== 'true';
    setEarnChecked('#earnCfgDivest,#earnCfgDivestS14a', isOn);
    patchEarnConfig({ autoDivestOnSpend: isOn });
    if (!LIVE) toast(isOn ? 'Auto-withdraw on. Demo only.' : 'Auto-withdraw off. Demo only.');
  });
});
let earnCfgThreshTimer: number | null = null;
function setEarnThreshold(v: number): void {
  $$<HTMLInputElement>('#earnCfgThresh,#earnCfgThreshS14a').forEach((el) => {
    el.value = String(v);
  });
  $$('#earnCfgThVal,#earnCfgThValS14a').forEach((el) => {
    el.textContent = '$' + v;
  });
}
$$<HTMLInputElement>('#earnCfgThresh,#earnCfgThreshS14a').forEach((range) => {
  on(range, 'input', () => {
    setEarnThreshold(parseInt(range.value, 10));
  });
  on(range, 'change', () => {
    const v = parseInt(range.value, 10);
    if (earnCfgThreshTimer != null) window.clearTimeout(earnCfgThreshTimer);
    earnCfgThreshTimer = window.setTimeout(() => patchEarnConfig({ divestThresholdUsd: v }), 250);
  });
});

on($('#wdRange'), 'input', () => {
  $('#wdV').textContent = parseInt(($('#wdRange') as HTMLInputElement).value, 10).toLocaleString('en-US');
});
let earnWithdrawAttempt: OrderAttemptKey | null = null;
on($('#wdGo'), 'click', () => {
  const v = parseInt(($('#wdRange') as HTMLInputElement).value, 10);
  if (L.earnPos == null || v > L.earnPos) {
    toast('More than your earning balance.', 'err');
    return;
  }
  $('#wdSheet').classList.remove('on');
  syncScrollLock();
  openReviewSheet({
    eyebrow: 'WITHDRAW FROM EARN',
    amount: money(v),
    subline: 'Returns to your spending balance.',
    rows: [
      { k: 'FROM', v: 'Earn (Morpho · Aave · Compound)' },
      { k: 'TO', v: 'Spending balance' },
      { k: 'NETWORK FEE', v: 'Sponsored', emphasis: 'success' },
      { k: 'ETA', v: 'Instant' },
    ],
    finePrint: 'Auto-rebalanced earn position; live APY pauses until you redeposit.',
    confirmLabel: 'Withdraw',
    onConfirm: () => {
      if (LIVE) {
        const fingerprint = `earn-withdraw:${v}`;
        earnWithdrawAttempt = idempotencyKeyFor(earnWithdrawAttempt, fingerprint);
        const idempotencyKey = earnWithdrawAttempt.idempotencyKey;
        liveCall(nexaApi.earnWithdraw(v, undefined, { idempotencyKey }).then((r) => {
          earnWithdrawAttempt = null;
          return r;
        }));
      } else {
        L.earnPos = (L.earnPos ?? 0) - v;
        L.bal = (L.bal ?? 0) + v;
        L.fresh = false;
        $('#earnPos').textContent = money(L.earnPos);
        renderEarnYield();
        L.activity.unshift({
          n: 'From Earn',
          s: 'WITHDRAWAL · INSTANT · JUST NOW',
          a: '+' + money(v),
          pos: true,
          k: 'in',
        });
        renderBal();
      }
      toast(money(v) + ' back in your spending balance ✓');
    },
  });
});
/* ── Sprint 10 Item B — Bridge offramp: payout methods + withdraw ──
   When LIVE, the sheet hits /bridge/payout-methods on open and the API drives
   creation. Demo mode keeps the sheet usable so the screen still demos. */
type PayoutKind = 'ach' | 'sepa' | 'wire' | 'crypto';
let payoutKind: PayoutKind = 'ach';
const payoutMethods: Array<{ id: string; type: PayoutKind; label: string; externalAccountId: string }> = [];
let bridgeWithdrawAttempt: OrderAttemptKey | null = null;

function payoutLabel(t: PayoutKind): string {
  return t === 'ach' ? 'US ACH' : t === 'sepa' ? 'EU SEPA' : t === 'wire' ? 'WIRE' : 'CRYPTO';
}

function renderPayoutMethods(): void {
  const list = $('#payoutList');
  const empty = $('#payoutEmpty') as HTMLElement;
  // Wipe everything except the empty hint, then re-render selectable rows.
  list.querySelectorAll('[data-payout-row]').forEach((n) => n.remove());
  if (payoutMethods.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  payoutMethods.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    row.setAttribute('data-payout-row', m.id);
    row.style.cursor = 'pointer';
    setKeyboardAction(row);
    const av = document.createElement('span');
    av.className = 'agent-av';
    av.textContent = m.type.slice(0, 2).toUpperCase();
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = m.label;
    const s = document.createElement('span');
    s.className = 's';
    const last4 = m.externalAccountId.slice(-4);
    s.textContent = `${payoutLabel(m.type)} · •••• ${last4}`;
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    grow.appendChild(s);
    const tag = document.createElement('span');
    tag.className = 'tag ' + (i === 0 ? 'ok' : '');
    tag.textContent = i === 0 ? 'SELECTED' : '';
    row.appendChild(av);
    row.appendChild(grow);
    row.appendChild(tag);
    on(row, 'click', () => {
      list.querySelectorAll<HTMLElement>('[data-payout-row] .tag').forEach((tg) => {
        tg.className = 'tag';
        tg.textContent = '';
      });
      tag.className = 'tag ok';
      tag.textContent = 'SELECTED';
    });
    list.appendChild(row);
  });
}

function selectedPayoutMethodId(): string | null {
  const sel = $('#payoutList').querySelector<HTMLElement>('[data-payout-row] .tag.ok');
  if (!sel) return payoutMethods[0]?.id ?? null;
  const row = sel.closest<HTMLElement>('[data-payout-row]');
  return row?.getAttribute('data-payout-row') ?? null;
}

async function loadPayoutMethods(): Promise<void> {
  if (!LIVE) return;
  try {
    const r = await nexaApi.payoutMethods();
    payoutMethods.length = 0;
    r.methods.forEach((m) =>
      payoutMethods.push({
        id: m.id,
        type: m.type as PayoutKind,
        label: m.label,
        externalAccountId: m.externalAccountId,
      }),
    );
    renderPayoutMethods();
  } catch {
    /* leave demo-mode empty list */
  }
}

$$('[data-paytype]').forEach((b) => {
  on(b, 'click', () => {
    $$('[data-paytype]').forEach((o) => o.classList.remove('onx'));
    b.classList.add('onx');
    payoutKind = (b.getAttribute('data-paytype') as PayoutKind) ?? 'ach';
    // ACH wants routing; SEPA/wire/crypto don't.
    ($('#payoutRoutingField') as HTMLElement).hidden = payoutKind !== 'ach';
  });
});
on($('#payoutAddBtn'), 'click', () => {
  ($('#payoutAddForm') as HTMLElement).hidden = false;
});
on($('#payoutCancel'), 'click', () => {
  ($('#payoutAddForm') as HTMLElement).hidden = true;
});
on($('#payoutCreate'), 'click', () => {
  const label = ($('#payoutLabel') as HTMLInputElement).value.trim();
  const acct = ($('#payoutAcct') as HTMLInputElement).value.trim();
  const routing = ($('#payoutRouting') as HTMLInputElement).value.trim();
  if (!label) {
    toast('Give this method a label.', 'err');
    return;
  }
  if (!acct) {
    toast('Enter an account number, IBAN, or wallet address.', 'err');
    return;
  }
  const accountDetails: Record<string, string> = { account: acct };
  if (payoutKind === 'ach') accountDetails['routing'] = routing;
  const finalize = (id: string, externalAccountId: string): void => {
    payoutMethods.unshift({ id, type: payoutKind, label, externalAccountId });
    renderPayoutMethods();
    ($('#payoutAddForm') as HTMLElement).hidden = true;
    ($('#payoutAcct') as HTMLInputElement).value = '';
    toast(label + ' registered ✓');
  };
  if (LIVE) {
    const btn = $('#payoutCreate') as HTMLButtonElement;
    btn.disabled = true;
    nexaApi
      .createPayoutMethod({ type: payoutKind, label, accountDetails })
      .then((r) => finalize(r.method.id, r.method.externalAccountId))
      .catch((e: unknown) => toast(e instanceof ApiFailure ? e.message : 'Could not register method.', 'err'))
      .finally(() => {
        btn.disabled = false;
      });
  } else {
    finalize('demo-' + Math.random().toString(36).slice(2, 10), 'external_demo_' + acct.slice(-4).padStart(4, '0'));
  }
});

on($('#bwRange'), 'input', () => {
  const v = parseInt(($('#bwRange') as HTMLInputElement).value, 10);
  $('#bwV').textContent = v.toLocaleString('en-US');
  $('#bwGoLbl').textContent = '$' + v.toLocaleString('en-US');
});
on($('#bwGo'), 'click', () => {
  const v = parseInt(($('#bwRange') as HTMLInputElement).value, 10);
  if (L.bal == null || v > L.bal) {
    toast("That's more than your balance.", 'err');
    return;
  }
  const id = selectedPayoutMethodId();
  if (!id) {
    toast('Pick or add a destination first.', 'err');
    return;
  }
  const method = payoutMethods.find((m) => m.id === id);
  const destLabel = method ? `${method.label} · ${method.type.toUpperCase()}` : 'Selected bank account';
  const fingerprint = `bridge-withdraw:${id}:${v.toFixed(2)}`;
  bridgeWithdrawAttempt = idempotencyKeyFor(bridgeWithdrawAttempt, fingerprint);
  const idempotencyKey = bridgeWithdrawAttempt.idempotencyKey;
  $('#bridgeWdSheet').classList.remove('on');
  syncScrollLock();
  openReviewSheet({
    eyebrow: 'WITHDRAW TO BANK · BRIDGE',
    amount: money(v),
    subline: 'Settles in 1–3 business days.',
    rows: [
      { k: 'TO', v: destLabel },
      { k: 'RAIL', v: 'Bridge.xyz' },
      { k: 'NETWORK FEE', v: 'Sponsored', emphasis: 'success' },
      { k: 'ETA', v: '1–3 business days' },
    ],
    badge: { source: 'live', provider: 'Bridge.xyz' },
    finePrint: 'Bank destination required. Never withdraw to an account you do not control.',
    confirmLabel: 'Withdraw to bank',
    onConfirm: () => {
      if (LIVE) {
        nexaApi
          .bridgeWithdraw({ payoutMethodId: id, amountUsd: v }, { idempotencyKey })
          .then(() => {
            if (bridgeWithdrawAttempt?.idempotencyKey === idempotencyKey) bridgeWithdrawAttempt = null;
            toast('Withdrawal sent. Settles in 1-3 days.');
            void syncFromServer();
            // Bridge demo synth-webhook flips to completed in ~2s.
            window.setTimeout(() => void syncFromServer(), 2400);
          })
          .catch((e: unknown) => toast(e instanceof ApiFailure ? e.message : 'Withdraw failed.', 'err'));
      } else {
        L.bal = (L.bal ?? 0) - v;
        L.fresh = false;
        L.activity.unshift({
          n: 'Withdraw to bank',
          s: 'BRIDGE · PENDING · JUST NOW',
          a: '−' + money(v),
          k: 'out',
        });
        renderBal();
        renderActivity();
        toast('Demo withdraw queued. ' + money(v) + ' leaves your balance.');
      }
    },
  });
});

on($('#limRange'), 'input', () => {
  $('#limV').textContent = parseInt(($('#limRange') as HTMLInputElement).value, 10).toLocaleString('en-US');
});
on($('#limSave'), 'click', () => {
  const dayLimitUsd = parseInt(($('#limRange') as HTMLInputElement).value, 10);
  setCardControls({
    last4: cardView?.last4 ?? null,
    network: cardView?.network ?? null,
    kind: cardView?.kind ?? 'DEBIT',
    frozen: cardView?.frozen ?? L.frozen,
    dayLimitUsd,
    demo: cardView?.demo ?? false,
  });
  if (LIVE) liveCall(nexaApi.cardLimit(dayLimitUsd));
  $('#limitSheet').classList.remove('on');
  toast('Per-day limit updated');
});
on($('#merchDone'), 'click', () => {
  $('#merchSheet').classList.remove('on');
  toast('Merchant rules are not connected yet.', 'err');
});
on($('#opsApprove'), 'click', () => {
  $('#opsTag').textContent = 'LIVE';
  $('#opsTag').className = 'tag live';
  $('#opsSub').textContent = '$25.00 LEFT · VENDOR PAYMENTS OK';
  $('#opsSheet').classList.remove('on');
  toast('Rule approved. OpsAgent-02 can pay approved vendors.');
});
on($('#opsDeny'), 'click', () => {
  $('#opsSheet').classList.remove('on');
  toast('Denied. OpsAgent-02 stays without vendor payments.');
});
function setEarnTab(n: string): void {
  if (!document.getElementById('eseg1')) return;
  $$('[data-eseg]').forEach((o) => {
    const selected = o.getAttribute('data-eseg') === n;
    o.classList.toggle('on', selected);
    o.setAttribute('aria-selected', String(selected));
    o.setAttribute('aria-controls', 'eseg' + o.getAttribute('data-eseg'));
    o.tabIndex = selected ? 0 : -1;
  });
  ['1', '2', '3'].forEach((k) => {
    const panel = document.getElementById('eseg' + k);
    if (!panel) return;
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = k !== n;
  });
  // Sprint 10 Item F + H — when the Perks tab is opened in LIVE mode, hydrate
  // the tier card from /perks and stamp the region pill from localStorage.
  if (n === '3') {
    const region = regionFromStorage();
    ['#perksRegion', '#hlRegion', '#pmRegion'].forEach((sel) => {
      const pill = document.querySelector(sel);
      if (pill) pill.setAttribute('country', region);
    });
    if (LIVE) {
      void hydratePerksCard();
    }
  }
  // Sprint 10 Item F — campaigns list hydrates only when the API is reachable;
  // demo cards stay visible for the unauthenticated/offline session.
  if (n === '2' && LIVE) {
    void hydrateCampaigns();
  }
}

async function hydratePerksCard(): Promise<void> {
  try {
    const r = await nexaApi.perks();
    const card = document.querySelector<HTMLElement>('#perksLiveCard');
    if (!card) return;
    card.hidden = false;
    const t = document.querySelector<HTMLElement>('#perksTier');
    const p = document.querySelector<HTMLElement>('#perksPoints');
    const m = document.querySelector<HTMLElement>('#perksMult');
    const l = document.querySelector<HTMLElement>('#perksLife');
    if (t) t.textContent = r.tier.charAt(0).toUpperCase() + r.tier.slice(1);
    if (p) p.textContent = String(r.points);
    if (m) m.textContent = r.multiplier.toFixed(2) + '×';
    if (l) l.textContent = '$' + r.lifetimeEarnedUsd.toFixed(2);
  } catch {
    /* keep the static demo card visible */
  }
}

/* ── Sprint 10 Item F — campaigns live list + submit sheet ─────────────────
   The live list replaces the demo cards when /campaigns returns at least one
   active campaign. Each row's SUBMIT button opens campSubmitSheet pre-filled.
   The admin approve/release-bonus path is intentionally *not* in the UI —
   agent-key gated, used via API only. */
let campaignSubmitTargetId: string | null = null;
let campaignPlatform: 'tiktok' | 'instagram' | 'youtube' | 'x' = 'tiktok';

function buildCampaignRow(c: {
  id: string;
  title: string;
  brand: string;
  baseUsd: number;
  bonusTiers: Array<{ viewsThreshold: number; bonusUsd: number }>;
  topPrizeUsd: number;
}): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lrow';
  row.setAttribute('data-campaign-id', c.id);
  const grow = document.createElement('span');
  grow.className = 'grow';
  const t = document.createElement('span');
  t.className = 't mono';
  t.style.fontSize = '12.5px';
  t.style.fontWeight = '600';
  t.textContent = c.title.toUpperCase();
  const sub = document.createElement('span');
  sub.className = 'camp-pay';
  const parts: string[] = ['$' + c.baseUsd + ' base'];
  if (c.bonusTiers.length > 0) {
    const top = c.bonusTiers[c.bonusTiers.length - 1]!;
    parts.push(`+$${top.bonusUsd} at ${top.viewsThreshold.toLocaleString('en-US')} views`);
  }
  if (c.topPrizeUsd > 0) parts.push(`$${c.topPrizeUsd} top prize`);
  sub.textContent = parts.join(' · ');
  grow.appendChild(t);
  grow.appendChild(document.createElement('br'));
  grow.appendChild(sub);
  const submit = document.createElement('button');
  submit.className = 'pillbtn';
  submit.setAttribute('data-camp-submit', c.id);
  submit.setAttribute('data-camp-title', c.title);
  submit.setAttribute('data-camp-brand', c.brand);
  submit.textContent = 'SUBMIT';
  row.appendChild(grow);
  row.appendChild(submit);
  return row;
}

async function hydrateCampaigns(): Promise<void> {
  try {
    const r = await nexaApi.campaigns.list({ status: 'active' });
    const live = $('#campLiveList');
    const demo = $('#campDemoList');
    live.textContent = '';
    if (r.campaigns.length === 0) {
      (live as HTMLElement).hidden = true;
      (demo as HTMLElement).hidden = false;
      return;
    }
    r.campaigns.forEach((c) => live.appendChild(buildCampaignRow(c)));
    (live as HTMLElement).hidden = false;
    (demo as HTMLElement).hidden = true;
  } catch {
    /* leave the demo cards visible */
  }
}

on(document, 'click', (e) => {
  const submit = (e.target as HTMLElement).closest<HTMLElement>('[data-camp-submit]');
  if (!submit) return;
  campaignSubmitTargetId = submit.getAttribute('data-camp-submit');
  $('#campSubmitTitle').textContent = submit.getAttribute('data-camp-title') ?? 'Campaign';
  $('#campSubmitBrand').textContent = submit.getAttribute('data-camp-brand') ?? '';
  ($('#campClipUrl') as HTMLInputElement).value = '';
  ($('#campViews') as HTMLInputElement).value = '1000';
  campaignPlatform = 'tiktok';
  $$('[data-campplat]').forEach((b) => {
    b.classList.toggle('onx', b.getAttribute('data-campplat') === 'tiktok');
  });
  $('#campSubmitSheet').classList.add('on');
});

$$('[data-campplat]').forEach((b) => {
  on(b, 'click', () => {
    $$('[data-campplat]').forEach((o) => o.classList.remove('onx'));
    b.classList.add('onx');
    campaignPlatform = (b.getAttribute('data-campplat') as typeof campaignPlatform) ?? 'tiktok';
  });
});

on($('#campSubmitGo'), 'click', () => {
  if (!campaignSubmitTargetId) {
    toast('Pick a campaign first.', 'err');
    return;
  }
  const clipUrl = ($('#campClipUrl') as HTMLInputElement).value.trim();
  const viewsAttested = parseInt(($('#campViews') as HTMLInputElement).value, 10) || 0;
  if (!clipUrl || !/^https?:\/\//.test(clipUrl)) {
    toast('Paste a clip URL starting with http(s).', 'err');
    return;
  }
  if (viewsAttested < 0) {
    toast("Views can't be negative.", 'err');
    return;
  }
  const finish = (msg: string): void => {
    $('#campSubmitSheet').classList.remove('on');
    toast(msg);
    if (LIVE) {
      void hydrateCampaigns();
      void syncFromServer();
    }
  };
  if (LIVE) {
    const btn = $('#campSubmitGo') as HTMLButtonElement;
    btn.disabled = true;
    nexaApi.campaigns
      .submit(campaignSubmitTargetId, { clipUrl, platform: campaignPlatform, viewsAttested })
      .then(() => finish('Clip submitted. Admin reviews next.'))
      .catch((e: unknown) => toast(e instanceof ApiFailure ? e.message : 'Submit failed.', 'err'))
      .finally(() => {
        btn.disabled = false;
      });
  } else {
    finish('Demo submit queued.');
  }
});
$$('[data-eseg]').forEach((b) => {
  on(b, 'click', () => {
    setEarnTab(b.getAttribute('data-eseg') ?? '1');
  });
});

/* ── Sprint 15 — Markets (s27) read-only data + source badges ───────────── */

function emptyMarketRow(host: HTMLElement, label: string, sub: string): void {
  const row = document.createElement('div');
  row.className = 'lrow';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = label;
  grow.appendChild(t);
  grow.appendChild(document.createElement('br'));
  const s = document.createElement('span');
  s.className = 's';
  s.textContent = sub;
  grow.appendChild(s);
  row.appendChild(grow);
  host.appendChild(row);
}

type MarketSourceKind = 'live' | 'sandbox' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error';
type HlVenueKind = 'hyperliquid' | 'hyperliquid-spot' | 'hyperliquid-hip3';

interface HlMarket {
  /** Venue/API identifier used for detail/order requests. */
  coin: string;
  /** Human ticker label when `coin` is a pair (`PURR/USDC`) or namespace (`xyz:AAPL`). */
  displaySymbol?: string | null;
  venueKind?: HlVenueKind;
  name?: string | null;
  priceUsd: number;
  change24hPct: number | null;
  logoUrl?: string | null;
  imageUrl?: string | null;
  dayVolumeUsd?: number | null;
  openInterest?: number | null;
  fundingRate?: number | null;
  volume24hUsd?: number | null;
  openInterestUsd?: number | null;
  fundingRatePct?: number | null;
  funding?: number | null;
  maxLeverage?: number | null;
}

const HL_BUILDER_FEE_FALLBACK_LABEL = '2.5 bps · cached';

/* Memes view is everything on HL spot that ISN'T a stable, a known XYZ HIP-3
   stock/index/commodity, or a major-cap perp re-listed on spot. Whatever's
   left is HL-native memecoin land (WOW / NEKO / BUDDY / PURR / WOULD ...).
   Sorted by 24h volume at render time. */
const NON_MEME_SPOT_DENYLIST = new Set([
  // Stables / pegged
  'USDC', 'USDT', 'USDE', 'DAI', 'FRAX', 'TUSD',
  // XYZ HIP-3 commodities / FX surfacing on spot (NBT = T-Bill, RUB = ruble fx)
  'NBT', 'GLD', 'RUB', 'QQQ', 'SPY', 'OIL', 'BRENTOIL', 'WTIOIL', 'COPPER', 'CORN', 'GOLD',
  // Majors (not memes)
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOGE', 'HYPE',
]);
function isMemeSpot(coin: string): boolean {
  const c = (coin || '').split('/', 1)[0]?.toUpperCase() ?? '';
  if (!c) return false;
  if (c.startsWith('XYZ:')) return false;
  if (c.startsWith('@')) return false;             // numbered placeholders
  return !NON_MEME_SPOT_DENYLIST.has(c);
}

/* ── Shared realtime hub binding (Phase C) ──────────────────────────────────
    When VITE_REALTIME_HUB_ENABLED is on, MAZE consumes ticker fan-out from the
    NEXA shared WSS hub at `/ws/markets` instead of opening a direct HL socket.
    NEO + MAZE then receive identical canonical prices off one feed.
    The legacy direct HL/PM sockets below stay alive as the fallback path
    until the flag is flipped per environment in C7 (see REALTIME-MARKETS.md).
   */
const REALTIME_HUB_ENABLED = (() => {
  const raw = import.meta.env['VITE_REALTIME_HUB_ENABLED'];
  return raw === '1' || raw === 'true';
})();

interface RealtimeHubBinding {
  /** Increment refcount for `coin`; sub on the WS transport if 0→1. */
  ensureHlCoin(coin: string): void;
  /** Decrement refcount; unsub when last subscriber leaves. */
  releaseHlCoin(coin: string): void;
  /** Subscribe to a Polymarket outcome token (predictions:pm:<tokenId>). */
  ensurePmToken(tokenId: string): void;
  releasePmToken(tokenId: string): void;
  /** Subscribe to an HL candle stream (candle:hl:<coin>:<interval>). */
  ensureHlCandle(coin: string, intervalSlug: string): void;
  releaseHlCandle(coin: string, intervalSlug: string): void;
  /**
   * Subscribe the signed-in user's HL account + fills streams
   * (priv:<uid>:account / priv:<uid>:fills). Idempotent per userId; silent
   * unless the server runs HL_USER_STREAMS=1.
   */
  ensureUserStreams(userId: string): void;
  /** Idempotent teardown for pagehide / sign-out. */
  close(): void;
}

/** TradingView slug → hub Interval enum. HL native uses bare "1"/"D"; the
 *  hub's grammar requires the "1m"/"1d" form. */
const HUB_INTERVAL_FROM_TV: Record<string, '1m' | '5m' | '15m' | '1h' | '4h' | '1d'> = {
  '1': '1m', '5': '5m', '15': '15m', '60': '1h', '240': '4h', D: '1d',
};

let realtimeHubBinding: RealtimeHubBinding | null = null;

function getRealtimeHub(): RealtimeHubBinding | null {
  if (!REALTIME_HUB_ENABLED) return null;
  if (realtimeHubBinding) return realtimeHubBinding;
  realtimeHubBinding = createRealtimeHubBinding();
  (window as unknown as { __nexaRealtime?: RealtimeHubBinding }).__nexaRealtime = realtimeHubBinding;
  return realtimeHubBinding;
}

function createRealtimeHubBinding(): RealtimeHubBinding {
  let transport: WsTransport | null = null;
  const subscribed = new Map<Topic, number>();

  /** Mint a fresh 60s single-use ticket per (re)connect — server rejects long
   *  session JWTs from `?token=` so we route through /v1/stream/ticket. */
  const mintTicket = async (): Promise<string> => {
    const token = getToken();
    const base = API_BASE.replace(/\/+$/, '');
    const res = await fetch(`${base}/v1/stream/ticket`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`mintTicket: ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error('mintTicket: no token in response');
    return body.token;
  };

  function dispatch(event: FeedEvent): void {
    const topic = event.topic;
    if (event.t === 'tick' && topic.startsWith('ticker:hl:')) {
      const coin = topic.slice('ticker:hl:'.length);
      if (!coin) return;
      const rows = hlPriceRowsByCoin.get(coin);
      if (!rows) return;
      rows.forEach((el) => {
        (el as unknown as { updatePrice?: (p: number) => void }).updatePrice?.(event.px);
      });
      return;
    }
    if (event.t === 'tick' && topic.startsWith('predictions:pm:')) {
      const tokenId = topic.slice('predictions:pm:'.length);
      if (!tokenId) return;
      // PM ticks come through as a 0..1 probability; the row renderer wants
      // an integer 0..100 percent. dispatchPmTokenPrice validates the range.
      dispatchPmTokenPrice(tokenId, event.px * 100);
      return;
    }
    if (event.t === 'candle' && topic.startsWith('candle:hl:')) {
      // Route to the active detail chart if the topic matches its coin+interval.
      const rest = topic.slice('candle:hl:'.length);
      const sep = rest.lastIndexOf(':');
      if (sep <= 0) return;
      const coin = rest.slice(0, sep);
      const interval = rest.slice(sep + 1);
      if (!coin || !interval) return;
      handleHubCandleEvent(coin, interval, event);
      return;
    }
    // ADR-0004 part 2 — per-user HL streams. Only emitted when the server
    // runs HL_USER_STREAMS=1; with the flag off these branches never fire
    // and the REST polls below keep their full cadence.
    if (event.t === 'account') {
      handleAccountStreamEvent(event);
      return;
    }
    if (event.t === 'fill') {
      handleFillStreamEvent(event);
      return;
    }
  }

  function ensureTransport(initialTopics: Topic[]): void {
    if (transport) return;
    try {
      transport = new WsTransport({
        baseUrl: API_BASE,
        path: '/ws/markets',
        mintTicket,
        topics: initialTopics,
        onEvent: dispatch,
        onTransportError: (err: unknown) => {
          console.warn('[realtime hub] transport error', err);
        },
      });
    } catch (err) {
      console.warn('[realtime hub] failed to construct WsTransport', err);
    }
  }

  function ensureTopic(topic: Topic): void {
    const prev = subscribed.get(topic) ?? 0;
    subscribed.set(topic, prev + 1);
    if (prev > 0) return;
    if (!transport) ensureTransport([topic]);
    else transport.addTopics([topic]);
  }

  function releaseTopic(topic: Topic): void {
    const prev = subscribed.get(topic) ?? 0;
    if (prev <= 1) {
      subscribed.delete(topic);
      transport?.removeTopics([topic]);
    } else {
      subscribed.set(topic, prev - 1);
    }
  }

  return {
    ensureHlCoin(coin: string): void {
      ensureTopic(tickerTopic('hl', coin));
    },
    releaseHlCoin(coin: string): void {
      releaseTopic(tickerTopic('hl', coin));
    },
    ensurePmToken(tokenId: string): void {
      // Per-outcome topic. The shared hub fans out one Polymarket upstream WS
      // across every browser tab, so subscribing to 64 tokens here costs at
      // most ~64 hub-side refcounts — not 64 upstream sockets.
      ensureTopic(`predictions:pm:${tokenId}` as Topic);
    },
    releasePmToken(tokenId: string): void {
      releaseTopic(`predictions:pm:${tokenId}` as Topic);
    },
    ensureHlCandle(coin: string, intervalSlug: string): void {
      const hubInterval = HUB_INTERVAL_FROM_TV[intervalSlug];
      if (!hubInterval) return;
      ensureTopic(`candle:hl:${coin}:${hubInterval}` as Topic);
    },
    releaseHlCandle(coin: string, intervalSlug: string): void {
      const hubInterval = HUB_INTERVAL_FROM_TV[intervalSlug];
      if (!hubInterval) return;
      releaseTopic(`candle:hl:${coin}:${hubInterval}` as Topic);
    },
    ensureUserStreams(userId: string): void {
      if (userStreamsUserId === userId) return;
      if (userStreamsUserId) {
        releaseTopic(privAccountTopic(userStreamsUserId));
        releaseTopic(privFillsTopic(userStreamsUserId));
        // User switch: the previous user's stream freshness / fingerprint
        // must not gate or mask the next user's data.
        resetAccountStreamState();
      }
      userStreamsUserId = userId;
      ensureTopic(privAccountTopic(userId));
      ensureTopic(privFillsTopic(userId));
    },
    close(): void {
      transport?.close();
      transport = null;
      subscribed.clear();
      userStreamsUserId = null;
      resetAccountStreamState();
    },
  };
}

/** userId whose priv account/fills streams are currently ensured. Module-
 *  scoped so a sign-out (binding close) resets it. */
let userStreamsUserId: string | null = null;

/** Forward a hub CandleEvent to the active detail chart if its coin+interval
 *  matches. The chart instance is module-scoped (`detailChart`); this helper
 *  exists so the hub dispatch closure (defined before `detailChart`) can
 *  reach it via a function declaration that's hoisted. */
function handleHubCandleEvent(
  coin: string,
  hubInterval: string,
  event: import('@nexa/realtime-client').CandleEvent,
): void {
  if (!detailChart || detailChart.closed) return;
  const expected = HUB_INTERVAL_FROM_TV[activeDetailInterval];
  if (!expected || expected !== hubInterval) return;
  if (detailActiveCoin !== coin) return;
  try {
    detailChart.series.update({
      time: candleTimeToLwcSeconds(event.ts),
      open: event.o,
      high: event.h,
      low: event.l,
      close: event.c,
      volume: event.v,
    });
  } catch {
    // Series may have been torn down between dispatch and execution.
  }
}

/** Module-scoped flag for the active detail chart's coin — used by
 *  handleHubCandleEvent to validate inbound topics. Set/cleared by the
 *  detail-chart open/close path below. */
let detailActiveCoin: string | null = null;
/** Tracks the hub candle subscription tied to the live detail sheet so the
 *  release pairs the corresponding ensure. Null when the legacy WS path is
 *  in use OR when no detail sheet is open. */
let detailHubCandleSub: { coin: string; intervalSlug: string } | null = null;
/** Tracks PM tokens we've ensured with the hub so a teardown can release
 *  them without re-deriving from the DOM. */
const pmHubActiveTokens = new Set<string>();

/* Viewport-gated hub subscriptions. Expanded lists can hold 175+ rows and a
   ticker topic per row would storm the hub, so only rows actually on screen
   subscribe, capped at HL_HUB_SUB_CAP distinct coins. Offscreen rows keep
   the REST snapshot they rendered with. Hidden venue panels never intersect,
   so switching tabs also releases their topics. No-op when the hub flag is
   off — the legacy allMids WS covers every coin over one connection. */
const HL_HUB_SUB_CAP = 40;
const hlHubVisibleRowsByCoin: MarketRowMap = new Map();
let hlRowObserver: IntersectionObserver | null = null;

function hlHubRowVisibility(row: HTMLElement, visible: boolean): void {
  const coin = row.getAttribute('data-mkt-coin');
  if (!coin) return;
  const hub = getRealtimeHub();
  if (!hub) return;
  const set = hlHubVisibleRowsByCoin.get(coin);
  if (visible) {
    if (set?.has(row)) return;
    if (!set && hlHubVisibleRowsByCoin.size >= HL_HUB_SUB_CAP) return;
    addMarketRow(hlHubVisibleRowsByCoin, coin, row);
    if (!set) hub.ensureHlCoin(coin);
    return;
  }
  if (!set?.has(row)) return;
  removeMarketRow(hlHubVisibleRowsByCoin, coin, row);
  if (!hlHubVisibleRowsByCoin.has(coin)) hub.releaseHlCoin(coin);
}

function ensureHlRowObserver(): IntersectionObserver | null {
  if (!REALTIME_HUB_ENABLED) return null;
  if (hlRowObserver) return hlRowObserver;
  hlRowObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) hlHubRowVisibility(entry.target as HTMLElement, entry.isIntersecting);
  }, { rootMargin: '120px 0px' });
  return hlRowObserver;
}

/** Add an HL row; the hub subscription follows viewport visibility. */
function hlPriceRowsAdd(coin: string, row: HTMLElement): void {
  addMarketRow(hlPriceRowsByCoin, coin, row);
  ensureHlRowObserver()?.observe(row);
}

/** Remove an HL row and release its hub subscription if it held one. */
function hlPriceRowsRemove(coin: string, row: HTMLElement): void {
  removeMarketRow(hlPriceRowsByCoin, coin, row);
  hlRowObserver?.unobserve(row);
  hlHubRowVisibility(row, false);
}

/** HL-specific purge — mirrors purgeMarketRowsFromHost but routes through
 *  hlPriceRowsRemove so the realtime-hub binding sees the unsubs. */
function purgeHlMarketRowsFromHost(hostId: string, selector: string): void {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.querySelectorAll<HTMLElement>(selector).forEach((row) => {
    const key = row.getAttribute('data-mkt-coin');
    if (!key) return;
    hlPriceRowsRemove(key, row);
  });
}

/* ── HL allMids WebSocket — one connection feeds every list (Perps + Spot +
    Memes share the same mid-price source). Rows tag themselves with
    `data-mkt-coin`; on each tick we find them and patch the price in place.
    LEGACY: when REALTIME_HUB_ENABLED is true, this direct connection is NOT
    opened — the shared hub binding above handles dispatch instead. */
let hlWs: WebSocket | null = null;
let hlWsBackoffMs = 1000;
let hlWsClosed = false;

type MarketRowMap = Map<string, Set<HTMLElement>>;

const hlPriceRowsByCoin: MarketRowMap = new Map();
const jupPriceRowsByMint: MarketRowMap = new Map();

function addMarketRow(index: MarketRowMap, key: string, row: HTMLElement): void {
  const norm = key.trim();
  if (!norm) return;
  let set = index.get(norm);
  if (!set) {
    set = new Set();
    index.set(norm, set);
  }
  set.add(row);
}

function removeMarketRow(index: MarketRowMap, key: string, row: HTMLElement): void {
  const norm = key.trim();
  const set = index.get(norm);
  if (!set) return;
  set.delete(row);
  if (!set.size) index.delete(norm);
}

function purgeMarketRowsFromHost(hostId: string, selector: string, keyAttr: string, index: MarketRowMap): void {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.querySelectorAll<HTMLElement>(selector).forEach((row) => {
    const key = row.getAttribute(keyAttr);
    if (!key) return;
    removeMarketRow(index, key, row);
  });
}

function dispatchHlMids(mids: Record<string, string>): void {
  for (const [coin, raw] of Object.entries(mids)) {
    const next = Number(raw);
    if (!Number.isFinite(next)) continue;
    const rows = hlPriceRowsByCoin.get(coin);
    if (!rows) continue;
    rows.forEach((el) => {
      // Component method exists; cast to invoke without re-exporting the type.
      (el as unknown as { updatePrice?: (p: number) => void }).updatePrice?.(next);
    });
  }
}

function formatJupPrice(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatMarketPrice(value) : '\u2014';
}

function dispatchJupPrices(prices: Record<string, { priceUsd: number | null; ts: number }>): void {
  for (const [mint, payload] of Object.entries(prices)) {
    const rows = jupPriceRowsByMint.get(mint);
    if (!rows) continue;
    const text = formatJupPrice(payload?.priceUsd);
    rows.forEach((row) => {
      const num = row.querySelector<HTMLElement>('.num');
      if (num) num.textContent = text;
    });
  }
}

function openHlMidsSocket(): void {
  // When the shared realtime hub is enabled, MAZE consumes ticker fan-out
  // from the NEXA hub at /ws/markets (see RealtimeHubBinding above) instead
  // of opening a direct vendor socket. Skip the legacy open path entirely.
  if (REALTIME_HUB_ENABLED) return;
  if (hlWs && (hlWs.readyState === WebSocket.OPEN || hlWs.readyState === WebSocket.CONNECTING)) return;
  hlWsClosed = false;
  try {
    hlWs = new WebSocket('wss://api.hyperliquid.xyz/ws');
  } catch {
    scheduleHlWsReconnect();
    return;
  }
  hlWs.addEventListener('open', () => {
    hlWsBackoffMs = 1000;
    try {
      hlWs?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
    } catch { /* ignore */ }
  });
  hlWs.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as { channel?: string; data?: { mids?: Record<string, string> } };
      if (msg.channel === 'allMids' && msg.data?.mids) dispatchHlMids(msg.data.mids);
    } catch { /* malformed frame — ignore */ }
  });
  hlWs.addEventListener('close', () => {
    hlWs = null;
    if (!hlWsClosed) scheduleHlWsReconnect();
  });
  hlWs.addEventListener('error', () => {
    try { hlWs?.close(); } catch { /* ignore */ }
  });
}

function scheduleHlWsReconnect(): void {
  if (hlWsClosed) return;
  const wait = hlWsBackoffMs;
  hlWsBackoffMs = Math.min(hlWsBackoffMs * 2, 30000);
  setTimeout(() => { if (!hlWsClosed) openHlMidsSocket(); }, wait);
}

function closeHlMidsSocket(): void {
  hlWsClosed = true;
  try { hlWs?.close(); } catch { /* ignore */ }
  hlWs = null;
}

// Keep the socket alive across Trade tab visits within a single page session.
// Close hard on pagehide so we don't leave it dangling on iOS background.
window.addEventListener('pagehide', () => {
  closeHlMidsSocket();
  realtimeHubBinding?.close();
  realtimeHubBinding = null;
});

function resolveTradeVenue(raw: string | null): TradeVenue | null {
  if (raw === 'perps' || raw === 'spot' || raw === 'stocks' || raw === 'memes' || raw === 'predictions' || raw === 'cards') return raw;
  return null;
}

function getActiveTradeVenueFromDom(): TradeVenue {
  const active = document.querySelector<HTMLElement>('[data-trade-venue].on');
  return resolveTradeVenue(active?.getAttribute('data-trade-venue') ?? null) ?? 'perps';
}

function collectActiveJupMints(): string[] {
  const out = new Set<string>();
  if (activeTradeVenue === 'memes') {
    for (const t of marketsCache.jupMemes ?? []) out.add(t.mint);
  } else if (activeTradeVenue === 'stocks') {
    for (const t of marketsCache.xstocks ?? []) out.add(t.mint);
  }
  return [...out];
}

const JUP_PRICE_POLL_INTERVAL_MS = 10_000;
const JUP_PRICE_MIN_REFRESH_MS = 3_000;
const JUP_PRICE_RATE_LIMIT_BACKOFF_MS = 60_000;
const JUP_PRICE_PROVIDER_ERROR_BACKOFF_MS = 30_000;
let jupPricePollTimer: ReturnType<typeof setInterval> | null = null;
let jupPricePollInFlight = false;
let jupPriceRateLimitedUntilMs = 0;
let jupPriceLastPollAtMs = 0;

async function refreshJupPrices(): Promise<void> {
  if (document.hidden) return;
  if (activeScreen !== 's27') return;
  if (jupPricePollInFlight) return;
  const now = Date.now();
  if (now < jupPriceRateLimitedUntilMs) return;
  if (now - jupPriceLastPollAtMs < JUP_PRICE_MIN_REFRESH_MS) return;
  if (!(activeTradeVenue === 'memes' || activeTradeVenue === 'stocks')) return;
  const mints = collectActiveJupMints().slice(0, 100);
  if (!mints.length) return;
  jupPricePollInFlight = true;
  jupPriceLastPollAtMs = now;
  try {
    const r = await nexaApi.markets.jupiter.prices(mints);
    jupPriceRateLimitedUntilMs = 0;
    dispatchJupPrices(r.prices);
  } catch (e) {
    if (e instanceof ApiFailure && (e.status === 429 || e.code === 'too_many_requests')) {
      jupPriceRateLimitedUntilMs = Date.now() + rateLimitBackoffMs(e, JUP_PRICE_RATE_LIMIT_BACKOFF_MS);
    } else if (!(e instanceof ApiFailure) || e.status === 408 || e.status >= 500) {
      jupPriceRateLimitedUntilMs = Date.now() + JUP_PRICE_PROVIDER_ERROR_BACKOFF_MS;
    }
  } finally {
    jupPricePollInFlight = false;
  }
}

function stopJupPricePoll(): void {
  if (jupPricePollTimer) {
    clearInterval(jupPricePollTimer);
    jupPricePollTimer = null;
  }
}

function startJupPricePoll(): void {
  stopJupPricePoll();
  if (activeScreen !== 's27') return;
  if (!(activeTradeVenue === 'memes' || activeTradeVenue === 'stocks')) return;
  void refreshJupPrices();
  jupPricePollTimer = setInterval(() => {
    void refreshJupPrices();
  }, JUP_PRICE_POLL_INTERVAL_MS);
}

function syncTradeVenueLiveStreams(): void {
  if (activeScreen !== 's27') {
    stopJupPricePoll();
    closePmCloblSocket();
    return;
  }
  if (activeTradeVenue === 'predictions') {
    stopJupPricePoll();
    void hydratePmTopTraders();
    const predictionEvents = cachedPredictionsForCategory(activePmCategory);
    if (predictionEvents) {
      openPmCloblSocket(collectVisiblePmTokens(predictionEvents));
    } else {
      closePmCloblSocket();
    }
    return;
  }
  closePmCloblSocket();
  if (activeTradeVenue === 'memes' || activeTradeVenue === 'stocks') startJupPricePoll();
  else stopJupPricePoll();
}

function startTradeRealtime(): void {
  openHlMidsSocket();
  void hydrateHlPositions();
  startHlPositionsPoll();
  syncTradeVenueLiveStreams();
}

function stopTradeRealtime(): void {
  stopHlPositionsPoll();
  closeHlMidsSocket();
  closePmCloblSocket();
  stopJupPricePoll();
}

/* ── Polymarket CLOB WebSocket — live YES/NO row prices ───────────────────
 *
 * Public market channel — no auth required. We open one connection scoped
 * to the visible event cards' CLOB token ids; on each `last_trade_price` or
 * `price_change` we find the matching outcome chip via [data-pm-token=...]
 * and patch its `.pm-outcome-pct` text in place. Same DOM-diff pattern the
 * HL allMids feed uses for the perp / spot / meme rows.
 *
 * Ping/pong: Polymarket's docs say send literal "PING" every ~10s; server
 * sends its own PING every 5s and disconnects if no PONG within 10s. We
 * reply on receipt and pre-emptively ping at a 10s cadence.
 */
let pmWs: WebSocket | null = null;
let pmWsClosed = false;
let pmWsPingTimer: ReturnType<typeof setInterval> | null = null;
let pmWsBackoffMs = 1000;
let pmWsCurrentTokens: string[] = [];

function dispatchPmTokenPrice(tokenId: string, pricePct: number): void {
  if (!Number.isFinite(pricePct) || pricePct < 0 || pricePct > 100) return;
  const els = document.querySelectorAll<HTMLElement>(
    `[data-pm-token="${CSS.escape(tokenId)}"]`,
  );
  els.forEach((el) => {
    const pctEl = el.querySelector<HTMLElement>('.pm-outcome-pct');
    if (!pctEl) return;
    const style = el.getAttribute('data-pm-style');
    pctEl.textContent = style === 'cents'
      ? `${Math.round(pricePct)}¢`
      : `${Math.round(pricePct)}%`;
  });
}

/** Cap on live PM outcome-token subscriptions (hub or direct CLOB WS). */
const PM_TOKEN_SUB_CAP = 40;

function collectVisiblePmTokens(events: PmEvent[]): string[] {
  const seen = new Set<string>();
  // Only the rendered page subscribes — expanded tails stay on REST prices,
  // and the hard cap keeps a "Show all 60 events" tap from opening a
  // subscription storm.
  const rendered = events.slice(0, marketListLimit('pmMarketsList', MARKET_LIST_PAGE));
  for (const ev of rendered) {
    for (const o of ev.outcomes.slice(0, ev.isBinary ? 2 : 3)) {
      if (o.tokenId) seen.add(o.tokenId);
      if (seen.size >= PM_TOKEN_SUB_CAP) return [...seen];
    }
  }
  return [...seen];
}

function openPmCloblSocket(tokenIds: string[]): void {
  const nextTokens = [...new Set(tokenIds)];
  // When the shared realtime hub is on, route PM outcome subscriptions
  // through the NEXA hub instead of opening a direct CLOB socket.
  if (REALTIME_HUB_ENABLED) {
    const hub = getRealtimeHub();
    if (hub) {
      const next = new Set(nextTokens);
      // Release tokens that left the set.
      for (const t of pmHubActiveTokens) {
        if (!next.has(t)) {
          hub.releasePmToken(t);
          pmHubActiveTokens.delete(t);
        }
      }
      // Ensure new tokens.
      for (const t of next) {
        if (!pmHubActiveTokens.has(t)) {
          hub.ensurePmToken(t);
          pmHubActiveTokens.add(t);
        }
      }
    }
    pmWsCurrentTokens = nextTokens;
    return;
  }
  const removedTokens = pmWsCurrentTokens.filter((t) => !nextTokens.includes(t));
  pmWsCurrentTokens = nextTokens;
  if (!nextTokens.length) {
    closePmCloblSocket();
    return;
  }
  if (pmWs && (pmWs.readyState === WebSocket.OPEN || pmWs.readyState === WebSocket.CONNECTING)) {
    // Re-subscribe with the new set instead of tearing down — the server
    // accepts an in-band {operation:"subscribe"|"unsubscribe"} message.
    try {
      if (removedTokens.length) {
        pmWs.send(JSON.stringify({
          assets_ids: removedTokens,
          operation: 'unsubscribe',
          custom_feature_enabled: true,
        }));
      }
      pmWs.send(JSON.stringify({
        assets_ids: nextTokens,
        operation: 'subscribe',
        custom_feature_enabled: true,
      }));
    } catch { /* ignore */ }
    return;
  }
  pmWsClosed = false;
  try {
    pmWs = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  } catch {
    schedulePmWsReconnect();
    return;
  }
  pmWs.addEventListener('open', () => {
    pmWsBackoffMs = 1000;
    try {
      pmWs?.send(JSON.stringify({
        type: 'market',
        assets_ids: pmWsCurrentTokens,
        initial_dump: true,
        custom_feature_enabled: true,
      }));
    } catch { /* ignore */ }
    // Pre-emptive ping every 10s — server expects "PONG" reply within 10s of
    // its own ping; we send our own to keep the path warm regardless.
    if (pmWsPingTimer) clearInterval(pmWsPingTimer);
    pmWsPingTimer = setInterval(() => {
      try { pmWs?.send('PING'); } catch { /* ignore */ }
    }, 10000);
  });
  pmWs.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : '';
    // PING/PONG keep-alive: respond to the server's PING immediately.
    if (raw === 'PING') { try { pmWs?.send('PONG'); } catch { /* ignore */ } return; }
    if (raw === 'PONG') return;
    try {
      // The server may batch events into an array of frames or send singletons.
      const parsed: unknown = JSON.parse(raw);
      const frames = Array.isArray(parsed) ? parsed : [parsed];
      for (const f of frames as Array<{
        event_type?: string;
        asset_id?: string;
        price?: string;
        price_changes?: Array<{ asset_id?: string; price?: string }>;
      }>) {
        if (!f) continue;
        if (f.event_type === 'last_trade_price' && f.asset_id && f.price) {
          dispatchPmTokenPrice(f.asset_id, Number(f.price) * 100);
        } else if (f.event_type === 'price_change' && Array.isArray(f.price_changes)) {
          for (const ch of f.price_changes) {
            if (ch.asset_id && ch.price) {
              dispatchPmTokenPrice(ch.asset_id, Number(ch.price) * 100);
            }
          }
        }
      }
    } catch { /* malformed frame — ignore */ }
  });
  pmWs.addEventListener('close', () => {
    pmWs = null;
    if (pmWsPingTimer) { clearInterval(pmWsPingTimer); pmWsPingTimer = null; }
    if (!pmWsClosed) schedulePmWsReconnect();
  });
  pmWs.addEventListener('error', () => { try { pmWs?.close(); } catch { /* ignore */ } });
}

function schedulePmWsReconnect(): void {
  if (pmWsClosed) return;
  const wait = pmWsBackoffMs;
  pmWsBackoffMs = Math.min(pmWsBackoffMs * 2, 30000);
  setTimeout(() => { if (!pmWsClosed && pmWsCurrentTokens.length) openPmCloblSocket(pmWsCurrentTokens); }, wait);
}

function closePmCloblSocket(): void {
  // Release every hub-side PM subscription; idempotent when hub is off.
  if (pmHubActiveTokens.size) {
    const hub = realtimeHubBinding;
    if (hub) {
      for (const t of pmHubActiveTokens) hub.releasePmToken(t);
    }
    pmHubActiveTokens.clear();
  }
  pmWsClosed = true;
  if (pmWsPingTimer) { clearInterval(pmWsPingTimer); pmWsPingTimer = null; }
  try { pmWs?.close(); } catch { /* ignore */ }
  pmWs = null;
  pmWsCurrentTokens = [];
}

window.addEventListener('pagehide', closePmCloblSocket);

/* Read through our API cache/rate-limit layer so browser tabs do not fan out
   directly to Hyperliquid upstream. */
async function fetchHlPerps(): Promise<HlMarket[]> {
  const res = await nexaApi.markets.hyperliquid.list();
  return res.markets.map((m) => ({
    ...m,
    displaySymbol: m.coin,
    venueKind: 'hyperliquid' as const,
    volume24hUsd: m.dayVolumeUsd ?? null,
    openInterestUsd: m.openInterest != null ? m.openInterest * m.priceUsd : null,
    fundingRatePct: m.fundingRate != null ? m.fundingRate * 100 : null,
  }));
}

async function fetchHlSpot(): Promise<HlMarket[]> {
  const res = await nexaApi.markets.hyperliquidSpot.list();
  return res.markets
    .filter((m) => m.baseToken !== 'USDC')
    .map((m) => ({
      coin: m.coin || m.displayName,
      displaySymbol: m.baseToken,
      venueKind: 'hyperliquid-spot' as const,
      name: m.displayName,
      priceUsd: m.priceUsd,
      change24hPct: m.change24hPct,
      volume24hUsd: m.dayVolumeUsd ?? null,
      maxLeverage: null,
    }));
}

/* Polymarket event shape — `/events` groups child markets under one question
   ("World Cup Winner → 60 country markets", "Next PM of Ethiopia → 33"). The
   gamma response gives us image, tags, total volume, and per-child outcomes. */
interface PmEvent {
  id: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  iconUrl: string | null;
  tags: string[];
  volume24hr: number;
  marketCount: number;
  isBinary: boolean;             // single market with Yes/No only
  outcomes: PmEventOutcome[];    // pre-sorted by price desc, top 4
}
interface PmEventOutcome {
  label: string;             // e.g. "Spain", "Yes", "Abiy Ahmed"
  pricePct: number;          // 0-100
  marketId: string;          // id of the leaf market (so the order sheet can route)
  tokenId?: string | null;   // CLOB asset_id, used to subscribe over WS for live prices
}

async function fetchPolymarketEvents(tagSlug = ''): Promise<PmEvent[]> {
  const res = await nexaApi.markets.polymarket.list({
    limit: 60,
    ...(tagSlug ? { category: tagSlug } : {}),
  });
  return res.markets
    .map((m): PmEvent | null => {
      const outcomes = m.outcomes.map((o) => ({
        label: o.label,
        pricePct: o.pricePct,
        marketId: o.marketId ?? m.id,
        tokenId: o.tokenId ?? null,
      }));
      if (!outcomes.length) return null;
      const isBinary = !m.isMultiOutcome &&
        outcomes.length === 2 &&
        /^(yes|no)$/i.test(outcomes[0]?.label ?? '');
      return {
        id: m.id,
        slug: m.id,
        title: m.question,
        imageUrl: m.imageUrl ?? null,
        iconUrl: null,
        tags: m.tags ?? (m.category ? [m.category] : []),
        volume24hr: Number(m.volume24hUsd ?? 0),
        marketCount: outcomes.length,
        isBinary,
        outcomes,
      };
    })
    .filter((event): event is PmEvent => event !== null);
}

function baseCoinSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/-?PERP$/i, '').replace(/[^A-Z0-9]/g, '');
}

/* TradingView's own symbol-logo CDN — same brand marks the embedded chart
   uses, broadest coverage (BTC/ETH/SOL/HYPE/PURR/WIF/ZEC and hundreds more).
   Free, CORS-friendly, deterministic URL pattern. The row component falls
   back to a colored lettermark chip when this 404s. */
function coinLogoUrl(symbol: string): string | null {
  const coin = baseCoinSymbol(symbol);
  if (!coin) return null;
  return `https://s3-symbol-logo.tradingview.com/crypto/XTVC${coin.toUpperCase()}.svg`;
}

function displaySymbolFromCoin(coin: string): string {
  const namespaced = coin.includes(':') ? coin.split(':', 2)[1] ?? coin : coin;
  const base = namespaced.includes('/') ? namespaced.split('/', 1)[0] ?? namespaced : namespaced;
  return baseCoinSymbol(base) || base || coin;
}

function hlMarketSymbol(market: { coin: string; displaySymbol?: string | null }): string {
  return market.displaySymbol?.trim() || displaySymbolFromCoin(market.coin);
}

/** Backed xStock icon lookup by bare ticker — feeds HIP-3 stock-perp rows.
    trade.xyz index products map to their closest ETF logo. */
const HIP3_TICKER_LOGO_ALIASES: Record<string, string> = { SP500: 'SPY', XYZ100: 'QQQ' };

function xstockLogoForTicker(ticker: string | null | undefined): string | null {
  if (!ticker) return null;
  const upper = HIP3_TICKER_LOGO_ALIASES[ticker.toUpperCase()] ?? ticker.toUpperCase();
  return marketsCache.xstocks?.find((t) => t.ticker.toUpperCase() === upper)?.icon ?? null;
}

function marketLogoUrl(market: {
  coin?: string;
  displaySymbol?: string | null;
  logoUrl?: string | null;
  imageUrl?: string | null;
  venueKind?: string;
}): string | null {
  if (market.logoUrl ?? market.imageUrl) return market.logoUrl ?? market.imageUrl ?? null;
  const symbol = market.displaySymbol ?? market.coin;
  const base = symbol ? baseCoinSymbol(symbol) : '';
  // Hyperliquid serves an SVG for every listed coin (majors + natives like
  // HYPE/PURR) from its own asset CDN — the TradingView crypto CDN 404s on
  // the long tail and every stock ticker, which rendered as letter tiles.
  if (market.venueKind === 'hyperliquid' || market.venueKind === 'hyperliquid-spot') {
    return base ? `https://app.hyperliquid.xyz/coins/${base.toUpperCase()}.svg` : null;
  }
  if (market.venueKind === 'hyperliquid-hip3') {
    return xstockLogoForTicker(base) ?? null;
  }
  return symbol ? coinLogoUrl(symbol) : null;
}

function hlDisplaySymbol(market: HlMarket): string {
  const coin = hlMarketSymbol(market);
  if (market.venueKind === 'hyperliquid-spot' || !(market.maxLeverage && Number.isFinite(market.maxLeverage))) {
    return coin;
  }
  return coin.endsWith('PERP') ? coin : `${coin}-PERP`;
}

function hlDisplayName(market: HlMarket): string {
  return market.name?.trim() || `${hlMarketSymbol(market)} perpetual`;
}

function formatMarketPrice(value: number): string {
  if (!Number.isFinite(value)) return '·';
  if (value >= 100) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 1) return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function formatPctLabel(value: number | null | undefined, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return '·';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%${suffix}`;
}

function formatUsdCompact(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatFundingPct(market: HlMarket): string | null {
  const raw = market.fundingRate ?? market.fundingRatePct ?? market.funding;
  if (raw == null || !Number.isFinite(raw)) return null;
  const pct = Math.abs(raw) > 0 && Math.abs(raw) < 0.001 ? raw * 100 : raw;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(3)}%/h`;
}

function setOrderLogo(prefix: 'hl' | 'pm' | 'jup', logoUrl: string | null, fallback: string): void {
  const img = document.getElementById(`${prefix}OrderLogoImg`) as HTMLImageElement | null;
  const fallbackEl = document.getElementById(`${prefix}OrderLogoFallback`);
  if (!img || !fallbackEl) return;
  fallbackEl.textContent = fallbackLetter(fallback);
  const showFallback = (): void => {
    img.hidden = true;
    img.removeAttribute('src');
    fallbackEl.hidden = false;
  };
  if (!logoUrl) {
    showFallback();
    return;
  }
  img.hidden = false;
  fallbackEl.hidden = true;
  img.src = logoUrl;
  img.onerror = showFallback;
}

function fallbackLetter(value: string): string {
  return (value.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
}

function _setOrderRegionLabel(id: string, country: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const region = country.trim().toUpperCase();
  const unset = !region || region === '??';
  const blocked = !unset && isRegionBlocked(region);
  el.classList.toggle('blocked', blocked);
  el.textContent = unset ? 'Region check required' : `${blocked ? 'Not available' : 'Available'} · ${region}`;
}

function setHlOrderStats(market: HlMarket): void {
  const host = document.getElementById('hlOrderStats');
  if (!host) return;
  const parts: string[] = [];
  const volume = formatUsdCompact(market.dayVolumeUsd ?? market.volume24hUsd);
  if (volume) parts.push(`24H VOL ${volume}`);
  const openInterestUsd =
    market.openInterestUsd ??
    (market.openInterest != null && market.openInterest > 0 ? market.openInterest * market.priceUsd : null);
  const oi = formatUsdCompact(openInterestUsd);
  if (oi) parts.push(`OI ${oi}`);
  const funding = formatFundingPct(market);
  if (funding) parts.push(`FUNDING ${funding}`);
  if (market.maxLeverage && Number.isFinite(market.maxLeverage)) parts.push(`MAX ${market.maxLeverage}x`);
  host.textContent = parts.join(' · ');
  host.hidden = parts.length === 0;
}

/* Market lists render a compact first page, then a "Show all" row instead of
   silently dropping everything past a hard slice — the API returns hundreds
   of markets and users had no way to reach them. Keyed per host element. */
const marketListShownCount = new Map<string, number>();
const MARKET_LIST_PAGE = 12;

function marketListLimit(hostId: string, initial: number): number {
  return marketListShownCount.get(hostId) ?? initial;
}

function appendShowAllRow(
  host: HTMLElement,
  hostId: string,
  total: number,
  label: string,
  rerender: () => void,
): void {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'lrow market-show-all';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `Show all ${total} ${label}`;
  grow.appendChild(t);
  row.appendChild(grow);
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '›';
  row.appendChild(chev);
  on(row, 'click', () => {
    marketListShownCount.set(hostId, total);
    rerender();
  });
  host.appendChild(row);
}

/** 44px logo tile with dot-matrix letter fallback — shared by meme + xStock
    rows. The seeded mark rides currentColor so it adapts to both themes. */
function marketThumbEl(label: string, url: string | null | undefined): HTMLElement {
  const thumb = document.createElement('span');
  thumb.className = 'cards-thumb';
  const renderDotFallback = (): void => {
    thumb.textContent = '';
    thumb.appendChild(dotMarkSvgElement(label, 'currentColor'));
    const glyph = document.createElement('span');
    glyph.className = 'thumb-glyph';
    glyph.textContent = fallbackLetter(label);
    thumb.appendChild(glyph);
  };
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      img.remove();
      renderDotFallback();
    }, { once: true });
    thumb.appendChild(img);
  } else {
    renderDotFallback();
  }
  return thumb;
}

/** Latest hydrate's market object per live row, so a reused row's click
    handler opens current data instead of the object it was created with. */
const hlRowMarket = new WeakMap<HTMLElement, HlMarket>();

/** setAttribute that skips no-ops and treats null as removal — reused rows
    only see attribute callbacks for values that actually changed. */
function setAttrIfChanged(el: Element, name: string, value: string | null): void {
  if (value == null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function renderHlMarkets(
  markets: HlMarket[],
  sourceKind: MarketSourceKind = 'unavailable',
  hostId: string = 'hlMarketsList',
  tagLabel: string | null = null,
): void {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!markets.length) {
    purgeHlMarketRowsFromHost(hostId, 'nexa-market-row');
    host.textContent = '';
    if (hydrateMarketsInflight || marketsHydratedAt === 0) {
      // First load (or refetch with nothing cached): honest loading state in
      // the exact row geometry, not a premature "Couldn't load".
      paintListSkeleton(host, 'market-row');
      return;
    }
    const label = tagLabel ? `${tagLabel.toLowerCase()} markets` : 'perp markets';
    emptyMarketRow(
      host,
      sourceKind === 'unavailable' ? `Couldn't load ${label}.` : 'No markets available',
      sourceKind === 'unavailable' ? 'Provider unavailable or rate limited' : 'CHECK BACK LATER',
    );
    return;
  }
  const shown = marketListLimit(hostId, MARKET_LIST_PAGE);
  // Keyed reconcile: rows are patched in place (build-once element, batched
  // apply), moves keep their IntersectionObserver registration, and removals
  // route through hlPriceRowsRemove so hub subscriptions release. Show-all
  // expansion becomes append-only instead of a 175-row rebuild.
  reconcileKeyedList(host, markets.slice(0, shown), {
    keyAttr: 'data-mkt-coin',
    rowSelector: 'nexa-market-row',
    keyOf: (m) => m.coin,
    create: (m) => {
      const row = document.createElement('nexa-market-row');
      // WS price ticks find this row via [data-mkt-coin] and update .price only.
      row.setAttribute('data-mkt-coin', m.coin);
      row.dataset['clickable'] = '';
      on(row, 'click', () => {
        const live = hlRowMarket.get(row);
        if (live) openHyperliquidDetail(live);
      });
      hlPriceRowsAdd(m.coin, row);
      return row;
    },
    update: (row, m) => {
      hlRowMarket.set(row, m);
      setAttrIfChanged(row, 'symbol', hlMarketSymbol(m));
      setAttrIfChanged(row, 'name', hlDisplayName(m));
      setAttrIfChanged(row, 'price', String(m.priceUsd));
      setAttrIfChanged(row, 'currency', 'USD');
      setAttrIfChanged(row, 'change-pct', m.change24hPct != null ? String(m.change24hPct) : null);
      const lev = m.maxLeverage && Number.isFinite(m.maxLeverage) ? String(m.maxLeverage) : null;
      setAttrIfChanged(row, 'max-leverage', lev);
      setAttrIfChanged(row, 'tag-label', !lev && tagLabel ? tagLabel : null);
      setAttrIfChanged(row, 'volume-label', m.volume24hUsd != null ? formatCompactUsd(m.volume24hUsd) : null);
      setAttrIfChanged(row, 'source', sourceKind);
      setAttrIfChanged(row, 'logo-url', marketLogoUrl(m) || null);
    },
    onRemove: (row) => {
      const key = row.getAttribute('data-mkt-coin');
      if (key) hlPriceRowsRemove(key, row);
    },
  });
  if (markets.length > shown) {
    const label = tagLabel ? `${tagLabel.toLowerCase()} markets` : 'markets';
    appendShowAllRow(host, hostId, markets.length, label, () =>
      renderHlMarkets(markets, sourceKind, hostId, tagLabel),
    );
  }
}

/* ── Sprint 17 — Hyperliquid market detail (s27d) ───────────────────────── */

let activeDetailMarket: HlMarket | null = null;
let activeDetailInterval = '15'; // HL interval slug — 1 / 5 / 15 / 60 / 240 / D

/* Resolve a market into the coin name + (optional) dex the HL info endpoint
   wants. Perps are bare ("BTC"), spot is "@N", HIP-3 builder DEXes prefix
   with "<dex>:" (e.g. trade.xyz markets ship as "xyz:TSLA"). Keep the
   namespaced form intact — stripping it via baseCoinSymbol() was the root
   cause of "blank stock charts". */
function hlInfoCoin(market: HlMarket): { coin: string; dex?: string } {
  const c = market.coin;
  if (typeof c === 'string' && c.includes(':')) {
    const dex = c.slice(0, c.indexOf(':'));
    return { coin: c, dex };
  }
  return { coin: c };
}

/* TradingView's interval slug → HL candleSnapshot interval. HL supports more
   intervals than we expose; we only emit the six visible TF pills here. */
const HL_INTERVAL_FROM_TV: Record<string, string> = {
  '1': '1', '5': '5', '15': '15', '60': '60', '240': '240', D: 'D',
};
const TV_RANGE_FROM_TF: Record<string, number> = {
  '1': 360,
  '5': 288,
  '15': 200,
  '60': 168,
  '240': 150,
  D: 365,
};
const TV_SYMBOL_OVERRIDES: Record<string, string> = {
  BTC: 'BINANCE:BTCUSDT.P',
  ETH: 'BINANCE:ETHUSDT.P',
  SOL: 'BINANCE:SOLUSDT.P',
  HYPE: 'HYPERLIQUID:HYPEUSDC',
  HFUN: 'HYPERLIQUID:HFUNUSDC',
  PURR: 'HYPERLIQUID:PURRUSDC',
  RAGE: 'HYPERLIQUID:RAGEUSDC',
  AVAX: 'BINANCE:AVAXUSDT.P',
  DOGE: 'BINANCE:DOGEUSDT.P',
  MATIC: 'BINANCE:MATICUSDT.P',
  ARB: 'BINANCE:ARBUSDT.P',
  OP: 'BINANCE:OPUSDT.P',
  SUI: 'BINANCE:SUIUSDT.P',
  XRP: 'BINANCE:XRPUSDT.P',
  BNB: 'BINANCE:BNBUSDT.P',
  ADA: 'BINANCE:ADAUSDT.P',
  LINK: 'BINANCE:LINKUSDT.P',
  LTC: 'BINANCE:LTCUSDT.P',
  TRX: 'BINANCE:TRXUSDT.P',
  TON: 'BINANCE:TONUSDT.P',
  WLD: 'BINANCE:WLDUSDT.P',
  APT: 'BINANCE:APTUSDT.P',
  PEPE: 'BINANCE:PEPEUSDT.P',
};
type CandleHistorySource = 'tv' | 'nexa';

function setDetailChartSource(status: CandleHistorySource | 'loading' | 'unavailable'): void {
  const el = document.getElementById('detailChartSource');
  if (!el) return;
  if (status === 'loading') {
    el.textContent = 'Loading source';
    return;
  }
  if (status === 'unavailable') {
    el.textContent = 'Unavailable';
    return;
  }
  el.textContent = status === 'tv' ? 'TV' : 'Nexa';
}

function tvRangeForTf(tvSlug: string): number {
  return TV_RANGE_FROM_TF[tvSlug] ?? 200;
}

function candleTimeToLwcSeconds(raw: number): number {
  const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
  return Math.floor(ms / 1000);
}

function tvSymbolFromHlCoin(coin: string, dex?: string): string {
  const symbol = coin.trim().toUpperCase();
  if (!symbol) return 'BINANCE:USDTUSDT.P';
  if (symbol.includes(':')) {
    const parts = symbol.split(':', 2);
    const venue = (parts[0] ?? '').toUpperCase();
    const candidate = baseCoinSymbol(parts[1] ?? '') || baseCoinSymbol(symbol);
    if (!candidate) return `BINANCE:${baseCoinSymbol(symbol)}USDT.P`;
    const override = TV_SYMBOL_OVERRIDES[candidate];
    if (venue === 'XYZ') return `NASDAQ:${candidate}`;
    if (venue === 'HYPERLIQUID') return `HYPERLIQUID:${candidate}USDC`;
    if (override) return override;
    return `NASDAQ:${candidate}`;
  }
  const bare = symbol.startsWith('@') ? symbol.slice(1) : symbol;
  const candidate = baseCoinSymbol(bare) || baseCoinSymbol(symbol);
  if (!candidate) return `BINANCE:${baseCoinSymbol(symbol)}USDT.P`;
  const override = TV_SYMBOL_OVERRIDES[candidate];
  if (override) return override;
  const venueHint = (dex ?? '').toUpperCase();
  if (venueHint && venueHint !== 'USDT') return `${venueHint}:${candidate}USDT`;
  return `BINANCE:${candidate}USDT.P`;
}

interface ChartCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v?: string;
}
function hlIntervalFor(tvSlug: string): string {
  return HL_INTERVAL_FROM_TV[tvSlug] ?? '15m';
}
function hlLookbackMs(tvSlug: string): number {
  switch (tvSlug) {
    case '1': return 6 * 3600 * 1000;      // 6h
    case '5': return 24 * 3600 * 1000;     // 1d
    case '15': return 3 * 24 * 3600 * 1000;  // 3d
    case '60': return 14 * 24 * 3600 * 1000; // 14d
    case '240': return 60 * 24 * 3600 * 1000; // 60d
    case 'D': return 365 * 24 * 3600 * 1000; // 1y
    default: return 3 * 24 * 3600 * 1000;
  }
}

function toChartCandlesFromNexa(
  raw: Array<{ t: number; o: string; h: string; l: string; c: string; v?: string }>,
): ChartCandle[] {
  return raw.map((item) => {
    const candle: ChartCandle = {
      t: item.t,
      o: String(item.o),
      h: String(item.h),
      l: String(item.l),
      c: String(item.c),
    };
    if (item.v != null) candle.v = String(item.v);
    return candle;
  });
}

function toChartCandlesFromTv(
  raw: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
): ChartCandle[] {
  return raw.map((item) => {
    const candle: ChartCandle = {
      t: item.time > 1_000_000_000_000 ? item.time : item.time * 1000,
      o: String(item.open),
      h: String(item.high),
      l: String(item.low),
      c: String(item.close),
    };
    if (item.volume != null) candle.v = String(item.volume);
    return candle;
  });
}

async function fetchNexaCandles(
  coin: string,
  dex: string | undefined,
  interval: string,
  lookbackMs: number,
): Promise<ChartCandle[]> {
  const res = dex || coin.includes(':')
    ? await nexaApi.markets.stocks.candles(coin, { interval, lookbackMs })
    : await nexaApi.markets.hyperliquid.candles(coin, { interval, lookbackMs });
  return toChartCandlesFromNexa(res.candles);
}

async function fetchTvCandleHistory(
  coin: string,
  dex: string | undefined,
  tvSlug: string,
): Promise<ChartCandle[]> {
  const symbol = tvSymbolFromHlCoin(coin, dex);
  const interval = hlIntervalFor(tvSlug);
  const range = tvRangeForTf(tvSlug);
  const snap = await nexaApi.tv.snapshot(symbol, interval, range);
  return toChartCandlesFromTv(snap.candles);
}

async function fetchHlCandleHistory(
  coin: string,
  dex: string | undefined,
  tvSlug: string,
): Promise<{ candles: ChartCandle[]; source: CandleHistorySource }> {
  if (dex || coin.includes(':')) {
    const interval = hlIntervalFor(tvSlug);
    return {
      candles: await fetchNexaCandles(coin, dex, interval, hlLookbackMs(tvSlug)),
      source: 'nexa',
    };
  }
  try {
    return {
      candles: await fetchTvCandleHistory(coin, dex, tvSlug),
      source: 'tv',
    };
  } catch {
    const interval = hlIntervalFor(tvSlug);
    return {
      candles: await fetchNexaCandles(coin, dex, interval, hlLookbackMs(tvSlug)),
      source: 'nexa',
    };
  }
}

/* Chart engine — the in-house @nexa/charts Engine over lightweight-charts v5
   (bundled workspace dep; the engine dynamic-imports the lib so chartless
   screens don't pay for it). Replaces the old unpkg-CDN v4 candles-only
   mount: the engine adds a volume pane, EMA/VWAP overlays, and
   position/order price lines. */
async function loadChartEngine(): Promise<typeof import('@nexa/charts')> {
  return import('@nexa/charts');
}

type ChartEngine = import('@nexa/charts').Engine;
type EngineCandle = import('@nexa/charts').Candle;

/* Per-detail-screen chart state. We tear this down on every re-mount so
   switching markets or timeframes leaves no orphan WebSockets behind. */
interface DetailChartHandles {
  engine: ChartEngine;
  chart: { remove: () => void; timeScale: () => { fitContent: () => void } };
  /** lwc-v4-shaped update shim — the live candle paths (hub + direct WS)
   *  feed seconds-based bars; the engine wants ms-based Candles. */
  series: {
    update: (d: { time: number; open: number; high: number; low: number; close: number; volume?: number }) => void;
  };
  /** Last full history — indicator overlays recompute from this. */
  history: EngineCandle[];
  overlays: Map<string, ReturnType<ChartEngine['addLineOverlay']>>;
  ws: WebSocket | null;
  resizeObs: ResizeObserver | null;
  element: HTMLElement | null;
  closed: boolean;
}
let detailChart: DetailChartHandles | null = null;
/** Coin the CURRENT detail chart was mounted for. Position/order line draws
 *  and drag redraws must match this — a stale response from a previous
 *  market must never paint its lines (or drag rows) onto the new chart. */
let detailChartCoin: string | null = null;
let detailCandleSocket: WebSocket | null = null;
let detailCandleSocketClosed = true;
let detailCandleSocketBackoffMs = 1000;
let detailCandleSocketReconnect: ReturnType<typeof setTimeout> | null = null;
let detailCandleSocketKey: string | null = null;

function makeDetailCandleSocketKey(coin: string, dex: string | undefined): string {
  return `${coin}|${dex ?? ''}|${activeDetailInterval}`;
}

function closeDetailCandleSocket(): void {
  detailCandleSocketClosed = true;
  if (detailCandleSocketReconnect) clearTimeout(detailCandleSocketReconnect);
  detailCandleSocketReconnect = null;
  if (detailCandleSocket) {
    try { detailCandleSocket.close(); } catch { /* ignore */ }
    detailCandleSocket = null;
  }
  detailCandleSocketKey = null;
  // Mirror release for the hub-side candle subscription if present.
  if (detailHubCandleSub) {
    realtimeHubBinding?.releaseHlCandle(detailHubCandleSub.coin, detailHubCandleSub.intervalSlug);
    detailHubCandleSub = null;
  }
  detailActiveCoin = null;
}

function scheduleDetailCandleSocketReconnect(coin: string, dex: string | undefined, key: string): void {
  if (detailCandleSocketClosed) return;
  if (detailCandleSocketKey !== key) return;
  if (detailCandleSocketReconnect) clearTimeout(detailCandleSocketReconnect);
  const wait = detailCandleSocketBackoffMs;
  detailCandleSocketBackoffMs = Math.min(detailCandleSocketBackoffMs * 2, 30000);
  detailCandleSocketReconnect = setTimeout(() => {
    if (detailCandleSocketClosed || detailCandleSocketKey !== key || !detailChart || detailChart.closed) return;
    openDetailCandleSocket(coin, dex, key);
  }, wait);
}

function openDetailCandleSocket(coin: string, dex: string | undefined, key: string): void {
  if (!detailChart || detailChart.closed || detailCandleSocketClosed) return;
  // Shared realtime hub path. When on, subscribe to candle:hl:<coin>:<i>
  // through the hub and let handleHubCandleEvent forward updates to the
  // chart — no direct vendor socket gets opened.
  if (REALTIME_HUB_ENABLED) {
    const hub = getRealtimeHub();
    if (hub) {
      // Release any prior subscription if interval/coin changed.
      if (detailHubCandleSub && (
        detailHubCandleSub.coin !== coin ||
        detailHubCandleSub.intervalSlug !== activeDetailInterval
      )) {
        hub.releaseHlCandle(detailHubCandleSub.coin, detailHubCandleSub.intervalSlug);
        detailHubCandleSub = null;
      }
      if (!detailHubCandleSub) {
        hub.ensureHlCandle(coin, activeDetailInterval);
        detailHubCandleSub = { coin, intervalSlug: activeDetailInterval };
      }
      detailActiveCoin = coin;
      detailCandleSocketClosed = false;
      detailCandleSocketKey = key;
    }
    return;
  }
  if (detailCandleSocket && (detailCandleSocket.readyState === WebSocket.OPEN || detailCandleSocket.readyState === WebSocket.CONNECTING)) return;

  const interval = hlIntervalFor(activeDetailInterval);
  detailCandleSocketClosed = false;
  detailCandleSocketBackoffMs = 1000;
  detailCandleSocketKey = key;
  try {
    detailCandleSocket = new WebSocket('wss://api.hyperliquid.xyz/ws');
  } catch {
    scheduleDetailCandleSocketReconnect(coin, dex, key);
    return;
  }
  const socket = detailCandleSocket;
  if (detailChart) detailChart.ws = socket;

  socket.addEventListener('open', () => {
    if (!detailChart || detailChart.closed || detailCandleSocketKey !== key) {
      try { socket.close(); } catch { /* ignore */ }
      return;
    }
    try {
      socket.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'candle', coin, interval },
      }));
    } catch { /* ignore */ }
  });
  socket.addEventListener('message', (ev) => {
    if (!detailChart || detailChart.closed || detailCandleSocketKey !== key) return;
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as {
        channel?: string;
        data?: { t: number; o: string | number; h: string | number; l: string | number; c: string | number; v?: string | number };
      };
      if (msg.channel !== 'candle' || !msg.data) return;
      const k = msg.data;
      const ms = Number(k.t);
      if (!Number.isFinite(ms)) return;
      detailChart.series.update({
        time: candleTimeToLwcSeconds(ms),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        ...(k.v != null ? { volume: Number(k.v) } : {}),
      });
    } catch { /* malformed frame — ignore */ }
  });
  socket.addEventListener('close', () => {
    if (detailChart?.ws === socket) detailChart.ws = null;
    scheduleDetailCandleSocketReconnect(coin, dex, key);
  });
  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* ignore */ }
  });
}

window.addEventListener('pagehide', closeDetailCandleSocket);

function tearDownDetailChart(): void {
  if (!detailChart) return;
  detailChart.closed = true;
  detailChartCoin = null;
  closeDetailCandleSocket();
  detailOrderLineRows = [];
  try { detailChart.resizeObs?.disconnect(); } catch { /* ignore */ }
  try { detailChart.chart.remove(); } catch { /* ignore */ }
  try { detailChart.element?.remove(); } catch { /* ignore */ }
  detailChart = null;
}

async function renderCandleChart(coin: string, dex: string | undefined): Promise<void> {
  const container = document.getElementById('detailTvChart');
  if (!container) return;
  const skel = document.getElementById('detailTvSkel');
  if (skel) { skel.textContent = 'Loading chart…'; skel.classList.remove('gone'); }
  setDetailChartSource('loading');

  tearDownDetailChart();

  let charts: Awaited<ReturnType<typeof loadChartEngine>>;
  try {
    charts = await loadChartEngine();
  } catch {
    if (skel) skel.textContent = 'Chart unavailable';
    return;
  }

  const isDark = document.querySelector('.stage[data-theme="dark"]') !== null
    || document.documentElement.getAttribute('data-theme') === 'dark'
    || matchMedia('(prefers-color-scheme: dark)').matches;

  // Build the chart mount — sits behind the H/L overlay, absolute-fills.
  const chartEl = document.createElement('div');
  chartEl.className = 'detail-lwc-chart';
  chartEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  // Insert before the H/L overlay so the overlay stays on top.
  const hlOverlay = container.querySelector('.detail-tv-hl');
  container.insertBefore(chartEl, hlOverlay);

  let engine: ChartEngine;
  try {
    engine = await charts.createEngine({
      container: chartEl,
      height: chartEl.clientHeight || 360,
      theme: {
        background: 'transparent',
        text: isDark ? '#bcbec7' : '#5a5d6a',
        grid: isDark ? 'rgba(244,245,248,0.05)' : 'rgba(10,10,12,0.05)',
        border: 'rgba(128,128,128,0)',
        up: '#0EBF8C',
        down: '#FF4D4F',
        accent: '#6C7BFF',
        crosshair: isDark ? 'rgba(244,245,248,0.3)' : 'rgba(10,10,12,0.3)',
      },
    });
  } catch {
    if (skel) skel.textContent = 'Chart unavailable';
    chartEl.remove();
    return;
  }

  const handles: DetailChartHandles = {
    engine,
    chart: { remove: () => engine.destroy(), timeScale: () => engine.chart.timeScale() },
    series: {
      update: (d) => {
        const candle = {
          t: d.time * 1000,
          o: d.open,
          h: d.high,
          l: d.low,
          c: d.close,
          v: d.volume ?? 0,
          closed: false,
        };
        engine.updateCandle(candle);
        if (d.volume != null) engine.updateVolume(candle);
      },
    },
    history: [],
    overlays: new Map(),
    ws: null,
    resizeObs: null,
    element: chartEl,
    closed: false,
  };
  detailChart = handles;
  detailChartCoin = coin;
  detailCandleSocketClosed = false;

  // Initial history.
  let history: ChartCandle[];
  let source: CandleHistorySource;
  try {
    const result = await fetchHlCandleHistory(coin, dex, activeDetailInterval);
    history = result.candles;
    source = result.source;
  } catch {
    if (skel) skel.textContent = 'Chart data unavailable';
    setDetailChartSource('unavailable');
    return;
  }
  if (handles.closed) return; // user switched markets while fetching
  setDetailChartSource(source);

  if (!history.length) {
    if (skel) skel.textContent = 'No data';
    return;
  }

  const engineCandles: EngineCandle[] = history.map((k, i) => ({
    t: candleTimeToLwcSeconds(k.t) * 1000,
    o: Number(k.o),
    h: Number(k.h),
    l: Number(k.l),
    c: Number(k.c),
    v: Number(k.v ?? 0),
    closed: i < history.length - 1,
  }));
  handles.history = engineCandles;
  engine.setCandles(engineCandles);
  // Volume pane only when the feed actually carries volume — an all-zero
  // histogram is dead space on a small screen.
  if (engineCandles.some((c) => c.v > 0)) engine.setVolume(engineCandles);
  engine.chart.timeScale().fitContent();
  applyDetailOverlays();
  detailOrderLineRows = [];
  void drawDetailPositionLines(coin);
  attachOrderLineDragHandlers(chartEl, handles);
  if (skel) skel.classList.add('gone');

  // Live candle WS follows the shared detail socket lifecycle so reconnect + teardown
  // behavior stays consistent across interval and market switches.
  const key = makeDetailCandleSocketKey(coin, dex);
  openDetailCandleSocket(coin, dex, key);
}

/* ── Indicator overlays (EMA-20 / VWAP) — pure math from @nexa/charts ───── */
const detailIndicatorsOn = new Set<string>();

function applyDetailOverlays(): void {
  const h = detailChart;
  if (!h || h.closed || !h.history.length) return;
  void (async () => {
    try {
      const { ema, vwap } = await import('@nexa/charts/indicators');
      if (!detailChart || detailChart.closed || detailChart !== h) return;
      const want: Array<[string, () => readonly { t: number; v: number }[], string]> = [
        ['ema20', () => ema(h.history, 20), '#6C7BFF'],
        ['vwap', () => vwap(h.history), '#E5A50A'],
      ];
      for (const [id, compute, color] of want) {
        const existing = h.overlays.get(id);
        if (detailIndicatorsOn.has(id) && !existing) {
          h.overlays.set(id, h.engine.addLineOverlay(compute(), color, 0, 2));
        } else if (!detailIndicatorsOn.has(id) && existing) {
          h.engine.removeSeries(existing as Parameters<ChartEngine['removeSeries']>[0]);
          h.overlays.delete(id);
        }
      }
    } catch {
      /* indicator overlays are decoration — fail soft */
    }
  })();
}

$$('[data-chart-ind]').forEach((b) => {
  on(b, 'click', () => {
    const id = b.getAttribute('data-chart-ind');
    if (!id) return;
    if (detailIndicatorsOn.has(id)) detailIndicatorsOn.delete(id);
    else detailIndicatorsOn.add(id);
    b.classList.toggle('on', detailIndicatorsOn.has(id));
    applyDetailOverlays();
  });
});

/* Position + resting-order lines for the charted coin. Entry price of the
 * filled position renders as the solid LONG/SHORT line; each resting limit
 * renders dashed at its price — the chart finally shows where YOUR orders
 * sit. Order lines are also the drag-to-modify surface (see
 * attachOrderLineDragHandlers): the rows captured here carry everything the
 * modify/cancel calls need. Fails soft and never blocks the mount. */
interface DetailOrderLineRow {
  priceUsd: number;
  positionId: string;
  /** Venue order ref (`hl_<oid>`) — what POST /hyperliquid/modify wants. */
  externalRef: string;
  coin: string;
  sideLong: boolean;
  qtyUsd: number;
}
let detailOrderLineRows: DetailOrderLineRow[] = [];

async function drawDetailPositionLines(coin: string): Promise<void> {
  if (!LIVE || !getToken() || !detailChart || detailChart.closed) return;
  // Mount token: only draw onto the chart this call was made for. A slow
  // response (or a drag's .finally() redraw) racing a market switch must
  // never paint the previous coin's lines/drag-rows onto the new chart.
  const handles = detailChart;
  if (detailChartCoin !== coin) return;
  try {
    const r = await nexaApi.markets.positions();
    if (detailChart !== handles || handles.closed || detailChartCoin !== coin) return;
    const symbol = coin.trim().toUpperCase();
    const rows = r.positions.filter((p) => p.symbol.trim().toUpperCase() === symbol);
    const filled = rows.find((p) => p.status === 'filled' && Number(p.entryPriceUsd) > 0);
    detailChart.engine.setPositionLine(
      filled
        ? {
            price: Number(filled.entryPriceUsd),
            sideLong: filled.sideLong,
            label: filled.sideLong ? 'LONG' : 'SHORT',
          }
        : null,
    );
    const resting = rows.filter((p) => p.status === 'resting' && Number(p.entryPriceUsd) > 0);
    detailChart.engine.setOrderLines(
      resting.map((p) => ({
        price: Number(p.entryPriceUsd),
        sideLong: p.sideLong,
        label: p.sideLong ? 'BUY' : 'SELL',
      })),
    );
    // Drag targets: only HL perp orders with a venue ref are modifiable.
    detailOrderLineRows = resting
      .filter((p) => p.venue === 'hyperliquid' && p.externalRef)
      .map((p) => ({
        priceUsd: Number(p.entryPriceUsd),
        positionId: p.id,
        externalRef: String(p.externalRef),
        coin: symbol,
        sideLong: p.sideLong,
        qtyUsd: Number(p.qtyUsd),
      }));
  } catch {
    /* lines are decoration — fail soft */
  }
}

/* ── Drag-to-modify + tap-to-cancel on chart order lines ──────────────────
 * Grab a dashed order line (±10px band), drag it to a new price, release →
 * confirm → POST /hyperliquid/modify (venue-side cancel+replace, same oid).
 * A tap without movement offers cancel instead. Handlers run in the CAPTURE
 * phase so lightweight-charts never starts a pan for a pointer that landed
 * on an order line; everything else falls through to normal chart pan/zoom. */
const ORDER_LINE_HIT_PX = 10;
const ORDER_DRAG_MIN_MOVE_PX = 4;
let orderLineActionBusy = false;

function fmtOrderPx(p: number): string {
  return p.toLocaleString('en-US', {
    maximumFractionDigits: p >= 100 ? 2 : p >= 1 ? 4 : 6,
  });
}

function attachOrderLineDragHandlers(el: HTMLElement, handles: DetailChartHandles): void {
  let drag: {
    row: DetailOrderLineRow;
    pointerId: number;
    startY: number;
    moved: boolean;
    lastPrice: number | null;
  } | null = null;

  const hitTest = (y: number): DetailOrderLineRow | null => {
    let best: DetailOrderLineRow | null = null;
    let bestDist = ORDER_LINE_HIT_PX + 1;
    for (const row of detailOrderLineRows) {
      const cy = handles.engine.priceToCoordinate(row.priceUsd);
      if (cy == null) continue;
      const d = Math.abs(cy - y);
      if (d < bestDist) {
        best = row;
        bestDist = d;
      }
    }
    return bestDist <= ORDER_LINE_HIT_PX ? best : null;
  };

  const cleanup = (): void => {
    if (!drag) return;
    try {
      el.releasePointerCapture(drag.pointerId);
    } catch {
      /* capture may already be gone */
    }
    handles.engine.setDragLine(null);
    handles.engine.setInteractionEnabled(true);
    drag = null;
  };

  on(el, 'pointerdown', (e: PointerEvent) => {
    if (handles.closed || orderLineActionBusy || !detailOrderLineRows.length) return;
    const rect = el.getBoundingClientRect();
    const row = hitTest(e.clientY - rect.top);
    if (!row) return;
    drag = { row, pointerId: e.pointerId, startY: e.clientY, moved: false, lastPrice: null };
    handles.engine.setInteractionEnabled(false);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — drag still works while the pointer stays inside */
    }
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true });

  on(el, 'pointermove', (e: PointerEvent) => {
    if (!drag || handles.closed || e.pointerId !== drag.pointerId) return;
    if (Math.abs(e.clientY - drag.startY) >= ORDER_DRAG_MIN_MOVE_PX) drag.moved = true;
    if (!drag.moved) return;
    const rect = el.getBoundingClientRect();
    const price = handles.engine.coordinateToPrice(e.clientY - rect.top);
    if (price == null || !(price > 0)) return;
    drag.lastPrice = price;
    handles.engine.setDragLine({
      price,
      sideLong: drag.row.sideLong,
      label: `${drag.row.sideLong ? 'BUY' : 'SELL'} → $${fmtOrderPx(price)}`,
    });
    e.preventDefault();
    e.stopPropagation();
  }, { capture: true });

  const finish = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { row, moved, lastPrice } = drag;
    cleanup();
    if (handles.closed) return;
    const side = row.sideLong ? 'BUY' : 'SELL';
    if (!moved) {
      // Tap on the line → offer cancel (same generic route the list uses).
      if (!window.confirm(`Cancel resting ${side} ${row.coin} order @ $${fmtOrderPx(row.priceUsd)}?`)) return;
      orderLineActionBusy = true;
      void nexaApi.markets
        .cancelOrder(row.positionId)
        .then(() => {
          toast(`${row.coin} ${side} order canceled ✓`);
        })
        .catch((err) => {
          toast(err instanceof ApiFailure ? err.message : 'Cancel failed.', 'err');
        })
        .finally(() => {
          orderLineActionBusy = false;
          void drawDetailPositionLines(row.coin);
          void hydrateHlPositions();
        });
      return;
    }
    if (lastPrice == null) return;
    if (!window.confirm(`Move ${side} ${row.coin} order from $${fmtOrderPx(row.priceUsd)} to $${fmtOrderPx(lastPrice)}?`)) return;
    orderLineActionBusy = true;
    void nexaApi.markets.hyperliquid
      .modifyOrder({
        coin: row.coin,
        orderId: row.externalRef,
        order: {
          sideLong: row.sideLong,
          qtyUsd: row.qtyUsd,
          kind: 'limit',
          tif: 'Gtc',
          limitPriceUsd: lastPrice,
        },
      })
      .then(() => {
        toast(`${row.coin} ${side} order moved to $${fmtOrderPx(lastPrice)} ✓`);
      })
      .catch((err) => {
        toast(err instanceof ApiFailure ? err.message : 'Modify failed.', 'err');
      })
      .finally(() => {
        orderLineActionBusy = false;
        void drawDetailPositionLines(row.coin);
        void hydrateHlPositions();
      });
  };

  on(el, 'pointerup', finish, { capture: true });
  on(el, 'pointercancel', () => cleanup(), { capture: true });
}

/* HL recentTrades — public read, no auth. Used by the Trades tab. Coin is
   the namespaced form (xyz:TSLA, @N, BTC); dex is the optional HIP-3
   builder-dex name to disambiguate when the namespaced coin alone isn't
   enough on REST. */
interface HlTrade { px: string; sz: string; side: 'A' | 'B'; time: number }
async function fetchHlRecentTrades(coin: string, dex?: string): Promise<HlTrade[]> {
  const r = await nexaApi.markets.hyperliquid.recentTrades(coin, dex ? { dex } : undefined);
  return r.trades.slice(0, 40);
}

/* HL l2Book — top-of-book bids/asks for the Order Book tab. */
interface HlBookLevel { px: string; sz: string; n: number }
interface HlBook { levels: [HlBookLevel[], HlBookLevel[]] }
async function fetchHlOrderBook(coin: string, dex?: string): Promise<HlBook> {
  const r = await nexaApi.markets.hyperliquid.orderbook(coin, dex ? { dex } : undefined);
  return r.book;
}

function renderOrderBook(book: HlBook | null): void {
  const host = document.getElementById('detailObList');
  if (!host) return;
  host.textContent = '';
  if (!book) {
    const empty = document.createElement('div');
    empty.className = 'detail-empty';
    empty.textContent = 'Order book unavailable.';
    host.appendChild(empty);
    return;
  }
  const bids = (book.levels?.[0] ?? []).slice(0, 8);
  const asks = (book.levels?.[1] ?? []).slice(0, 8);
  const maxBidSz = Math.max(...bids.map((b) => Number(b.sz)), 0);
  const maxAskSz = Math.max(...asks.map((a) => Number(a.sz)), 0);
  const maxSz = Math.max(maxBidSz, maxAskSz, 0.0001);
  const len = Math.max(bids.length, asks.length);
  for (let i = 0; i < len; i++) {
    const b = bids[i];
    const a = asks[i];
    const row = document.createElement('div');
    row.className = 'ob-row';
    const bidPx = b ? formatMarketPrice(Number(b.px)) : '';
    const askPx = a ? formatMarketPrice(Number(a.px)) : '';
    const sz = b && a
      ? `${Number(b.sz).toLocaleString('en-US', { maximumFractionDigits: 4 })} / ${Number(a.sz).toLocaleString('en-US', { maximumFractionDigits: 4 })}`
      : b ? Number(b.sz).toLocaleString('en-US', { maximumFractionDigits: 4 })
      : a ? Number(a.sz).toLocaleString('en-US', { maximumFractionDigits: 4 })
      : '';
    const bidDepth = b ? `${(Number(b.sz) / maxSz) * 50}%` : '0%';
    const askDepth = a ? `${(Number(a.sz) / maxSz) * 50}%` : '0%';
    row.style.setProperty('--bid-depth', bidDepth);
    row.style.setProperty('--ask-depth', askDepth);
    const bidEl = document.createElement('span');
    bidEl.className = 'bid';
    bidEl.textContent = bidPx;
    const szEl = document.createElement('span');
    szEl.className = 'sz';
    szEl.textContent = sz;
    const askEl = document.createElement('span');
    askEl.className = 'ask';
    askEl.textContent = askPx;
    // Click a level to open the order sheet as a limit at that exact price
    // (official-app convention: clicking an ask preps a buy, a bid a sell).
    if (b) {
      const px = Number(b.px);
      bidEl.style.cursor = 'pointer';
      on(bidEl, 'click', () => openHlLimitAtPrice(px, 'short'));
    }
    if (a) {
      const px = Number(a.px);
      askEl.style.cursor = 'pointer';
      on(askEl, 'click', () => openHlLimitAtPrice(px, 'long'));
    }
    row.appendChild(bidEl);
    row.appendChild(szEl);
    row.appendChild(askEl);
    host.appendChild(row);
  }
}

/** Open the shared order sheet pre-set to a limit order at `px`. */
function openHlLimitAtPrice(px: number, side: 'long' | 'short'): void {
  if (!activeDetailMarket || !(px > 0)) return;
  hlSide = side;
  hlOrderType = 'limit';
  openHyperliquidOrder(activeDetailMarket);
  const priceInput = document.getElementById('hlLimitPrice') as HTMLInputElement | null;
  if (priceInput) priceInput.value = String(px);
  applyHlOrderTypeUi();
  syncHlNotional();
}

async function loadDetailOrderBook(coin: string, dex?: string, opts?: { silent?: boolean }): Promise<void> {
  const host = document.getElementById('detailObList');
  if (host && !opts?.silent) {
    host.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'detail-empty';
    loading.textContent = 'Loading order book…';
    host.appendChild(loading);
  }
  try {
    const book = await fetchHlOrderBook(coin, dex);
    renderOrderBook(book);
  } catch {
    // On a silent refresh keep the last good ladder instead of blanking it.
    if (!opts?.silent) renderOrderBook(null);
  }
}

/* 24h high/low — comes from 24× 1h candles for the active coin. Passes a
   dex field for HIP-3 builder DEXes so xyz:TSLA-style assets resolve. */
async function fetchHlDayHighLow(coin: string, dex?: string): Promise<{ high: number; low: number } | null> {
  try {
    const candles = (await fetchHlCandleHistory(coin, dex, '60')).candles;
    const arr = candles.slice(-24);
    if (!arr.length) return null;
    let high = -Infinity, low = Infinity;
    for (const k of arr) {
      const h = Number(k.h), l = Number(k.l);
      if (Number.isFinite(h)) high = Math.max(high, h);
      if (Number.isFinite(l)) low = Math.min(low, l);
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    return { high, low };
  } catch { return null; }
}

function renderTradesList(trades: HlTrade[]): void {
  const host = document.getElementById('detailTradesList');
  if (!host) return;
  host.textContent = '';
  if (!trades.length) {
    const empty = document.createElement('div');
    empty.className = 'detail-empty';
    empty.textContent = 'No recent trades.';
    host.appendChild(empty);
    return;
  }
  for (const t of trades) {
    const row = document.createElement('div');
    row.className = 'detail-trade-row';
    const price = document.createElement('span');
    price.className = `price ${t.side === 'B' ? 'up' : 'down'}`;
    price.textContent = formatMarketPrice(Number(t.px));
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = Number(t.sz).toLocaleString('en-US', { maximumFractionDigits: 4 });
    const time = document.createElement('span');
    time.className = 'time';
    const d = new Date(t.time);
    time.textContent = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    row.appendChild(price);
    row.appendChild(size);
    row.appendChild(time);
    host.appendChild(row);
  }
}

async function loadDetailTrades(coin: string, dex?: string, opts?: { silent?: boolean }): Promise<void> {
  const host = document.getElementById('detailTradesList');
  if (host && !opts?.silent) {
    host.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'detail-empty';
    loading.textContent = 'Loading trades…';
    host.appendChild(loading);
  }
  try {
    const t = await fetchHlRecentTrades(coin, dex);
    renderTradesList(t);
  } catch {
    if (!opts?.silent) renderTradesList([]);
  }
}

/* Timeframe pills — clicking re-mounts the TV widget at the new interval.
   The widget itself has no toolbar so this is the only way to switch range. */
function setDetailInterval(interval: string): void {
  activeDetailInterval = interval;
  $$('[data-tv-interval]').forEach((b) => {
    const on = b.getAttribute('data-tv-interval') === interval;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (activeDetailMarket) {
    const { coin, dex } = hlInfoCoin(activeDetailMarket);
    void renderCandleChart(coin, dex);
  }
}
$$('[data-tv-interval]').forEach((b) => {
  on(b, 'click', () => setDetailInterval(b.getAttribute('data-tv-interval') ?? '15'));
});

/* Tab switch — toggles the dtab .on class + reveals matching panel. Fetches
   live data lazily when entering Trades or Order book so we don't burn API
   on tabs the user never opens. */
function setDetailTab(name: string): void {
  $$('[data-detail-tab]').forEach((b) => {
    const on = b.getAttribute('data-detail-tab') === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('[data-detail-panel]').forEach((p) => {
    p.hidden = p.getAttribute('data-detail-panel') !== name;
  });
  if (!activeDetailMarket) return;
  const { coin: hlCoin, dex } = hlInfoCoin(activeDetailMarket);
  if (name === 'trades') void loadDetailTrades(hlCoin, dex);
  if (name === 'orderbook') void loadDetailOrderBook(hlCoin, dex);
  startDetailTabPoll(name);
}

/* Book/trades were one-shot REST snapshots — stale the moment they loaded.
 * Poll every 5s while the tab is actually visible. Budget: l2Book carries
 * info weight 2 of the 1200/min IP allowance, so one visible ladder costs
 * ~24 weight/min. The interval kills itself when the user leaves s27d or
 * switches to a non-live tab. */
let detailTabTimer: number | null = null;

function stopDetailTabPoll(): void {
  if (detailTabTimer != null) {
    window.clearInterval(detailTabTimer);
    detailTabTimer = null;
  }
}

function startDetailTabPoll(name: string): void {
  stopDetailTabPoll();
  if (name !== 'trades' && name !== 'orderbook') return;
  detailTabTimer = window.setInterval(() => {
    if (activeScreen !== 's27d' || !activeDetailMarket) {
      stopDetailTabPoll();
      return;
    }
    if (document.hidden) return;
    const { coin, dex } = hlInfoCoin(activeDetailMarket);
    if (name === 'trades') void loadDetailTrades(coin, dex, { silent: true });
    else void loadDetailOrderBook(coin, dex, { silent: true });
  }, 5000);
}
$$('[data-detail-tab]').forEach((b) => {
  on(b, 'click', () => setDetailTab(b.getAttribute('data-detail-tab') ?? 'positions'));
});

function formatCompactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function openHyperliquidDetail(market: HlMarket): void {
  activeDetailMarket = market;
  const isSpot = !(market.maxLeverage && Number.isFinite(market.maxLeverage));
  // Display label strips namespace so the UI reads "TSLA" not "xyz:TSLA".
  // For HL info-endpoint calls below we use the namespaced form via
  // hlInfoCoin(market).
  const coin = hlMarketSymbol(market);
  const { coin: hlApiCoin, dex: hlApiDex } = hlInfoCoin(market);
  const ttlEl = document.getElementById('detailTtl');
  if (ttlEl) ttlEl.textContent = coin;
  // Flag the screen root so CSS + JS branches can react (hide leverage chip,
  // hide funding row, rename Long/Short to Buy/Sell).
  const scr = document.getElementById('s27d');
  if (scr) scr.dataset['marketKind'] = isSpot ? 'spot' : 'perp';
  const logoImg = document.getElementById('detailLogoImg') as HTMLImageElement | null;
  const logoFallback = document.getElementById('detailLogoFallback');
  const logoUrl = marketLogoUrl(market);
  if (logoImg && logoFallback) {
    if (logoUrl) {
      logoImg.src = logoUrl;
      logoImg.hidden = false;
      logoFallback.hidden = true;
      logoImg.onerror = () => { logoImg.hidden = true; logoFallback.hidden = false; logoFallback.textContent = coin[0] ?? '?'; };
    } else {
      logoImg.hidden = true;
      logoFallback.hidden = false;
      logoFallback.textContent = coin[0] ?? '?';
    }
  }
  const symEl = document.getElementById('detailSym');
  if (symEl) symEl.textContent = coin;
  const nameEl = document.getElementById('detailName');
  if (nameEl) nameEl.textContent = hlDisplayName(market);
  const maxLev = market.maxLeverage && Number.isFinite(market.maxLeverage) ? market.maxLeverage : 20;
  const levChip = document.getElementById('detailLevChip');
  if (levChip) {
    levChip.textContent = isSpot ? '' : `${maxLev}x`;
    levChip.hidden = isSpot;
  }
  // CTAs: Long/Short for perps, Buy/Sell for spot.
  const longBtn = document.getElementById('detailLong');
  const shortBtn = document.getElementById('detailShort');
  if (longBtn) longBtn.textContent = isSpot ? 'Buy' : 'Long';
  if (shortBtn) shortBtn.textContent = isSpot ? 'Sell' : 'Short';

  // Header price + change + side stats (Vol / OI / Funding).
  const priceEl = document.getElementById('detailPrice');
  if (priceEl) priceEl.textContent = formatMarketPrice(market.priceUsd);
  const chgEl = document.getElementById('detailChange');
  if (chgEl) {
    if (market.change24hPct == null) {
      chgEl.textContent = '24h n/a';
      chgEl.classList.remove('down');
    } else {
      chgEl.textContent = `${market.change24hPct >= 0 ? '+' : ''}${market.change24hPct.toFixed(2)}%`;
      chgEl.classList.toggle('down', market.change24hPct < 0);
    }
  }
  const volEl = document.getElementById('detailVol');
  if (volEl) volEl.textContent = formatCompactUsd(market.volume24hUsd);
  const oiEl = document.getElementById('detailOi');
  if (oiEl) oiEl.textContent = formatCompactUsd(market.openInterestUsd);
  const fundingEl = document.getElementById('detailFunding');
  const fundingText = market.fundingRatePct == null ? '—' : `${market.fundingRatePct >= 0 ? '+' : ''}${market.fundingRatePct.toFixed(4)}%`;
  if (fundingEl) fundingEl.textContent = fundingText;

  // Info tab mirrors the side stats and adds max leverage.
  const infoVol = document.getElementById('detailInfoVol');
  if (infoVol) infoVol.textContent = formatCompactUsd(market.volume24hUsd);
  const infoOi = document.getElementById('detailInfoOi');
  if (infoOi) infoOi.textContent = formatCompactUsd(market.openInterestUsd);
  const infoFunding = document.getElementById('detailInfoFunding');
  if (infoFunding) infoFunding.textContent = fundingText;
  const infoLev = document.getElementById('detailInfoMaxLev');
  if (infoLev) infoLev.textContent = `${maxLev}x`;

  // 24h H/L isn't in metaAndAssetCtxs — fetch a day of 1h candles and
  // compute the high/low. Updates the stats strip in place when ready.
  const highEl = document.getElementById('detailHigh');
  const lowEl = document.getElementById('detailLow');
  if (highEl) highEl.textContent = '…';
  if (lowEl) lowEl.textContent = '…';
  void fetchHlDayHighLow(hlApiCoin, hlApiDex).then((hl) => {
    if (highEl) highEl.textContent = hl ? formatMarketPrice(hl.high) : '—';
    if (lowEl) lowEl.textContent = hl ? formatMarketPrice(hl.low) : '—';
  });

  // Reset to Positions tab when opening; mount the lightweight-charts widget
  // driven by HL's own candleSnapshot + candle WS — works uniformly for
  // perps, spot (@N) and HIP-3 builder-dex assets (xyz:TSLA, etc.) without
  // depending on TradingView's symbol-coverage gaps.
  setDetailTab('positions');
  void renderCandleChart(hlApiCoin, hlApiDex);
  // "Open advanced terminal" button. NEO renders the same coin with the
  // full trading terminal (orderbook, recent trades, advanced order sheets).
  const neoBtn = document.getElementById('detailOpenNeoTerminal') as HTMLButtonElement | null;
  if (neoBtn) {
    if (NEO_TERMINAL_BASE) {
      const path = isSpot ? `/markets/spot/${encodeURIComponent(coin)}` : `/markets/${encodeURIComponent(coin)}`;
      neoBtn.hidden = false;
      neoBtn.onclick = () => openNeoTerminal(path);
    } else {
      neoBtn.hidden = true;
    }
  }
  go('s27d');
}

// Detail Long / Short — pre-set side then open the sheet over the chart.
on($('#detailLong'), 'click', () => {
  if (!activeDetailMarket) return;
  hlSide = 'long';
  openHyperliquidOrder(activeDetailMarket);
});
on($('#detailShort'), 'click', () => {
  if (!activeDetailMarket) return;
  hlSide = 'short';
  openHyperliquidOrder(activeDetailMarket);
});

interface PmMarket {
  id: string;
  question: string;
  imageUrl?: string | null;
  logoUrl?: string | null;
  category?: string | null;
  tags?: string[];
  isNegRisk?: boolean;
  isMultiOutcome?: boolean;
  outcomes: PmOutcome[];
  closesAt: string | null;
}

interface PmOutcome {
  label: string;
  pricePct: number;
  marketId?: string;
  conditionId?: string;
  tokenId?: string | null;
}

/** Render Polymarket events as vertical cards: image + title + tags + outcome
    chips + volume footer. Each outcome chip taps into the existing PM order
    sheet pre-set to that outcome. Reference layout: docs/inspo polymarket. */
function renderPmEvents(
  events: PmEvent[],
  sourceKind: MarketSourceKind = 'unavailable',
): void {
  const host = document.getElementById('pmMarketsList');
  if (!host) return;
  host.textContent = '';
  if (!events.length) {
    closePmCloblSocket();
    const empty = document.createElement('div');
    empty.className = 'detail-empty';
    empty.textContent = sourceKind === 'unavailable'
      ? "Couldn't load prediction markets."
      : 'No markets in this category.';
    host.appendChild(empty);
    return;
  }
  if (sourceKind === 'unavailable') {
    const warning = document.createElement('div');
    warning.className = 'detail-empty';
    warning.textContent = "Couldn't load latest prediction markets. Showing cached rows.";
    host.appendChild(warning);
  }
  // One-line literacy hint: cent prices are probabilities, not fees. Rendered
  // once above the list so first-time users can read the whole tab.
  const hint = document.createElement('p');
  hint.className = 'sub pm-price-hint';
  hint.textContent = 'Price = chance. A 26¢ outcome means the market sees a 26% chance; a winning share pays $1.';
  host.appendChild(hint);
  const shownEvents = marketListLimit('pmMarketsList', MARKET_LIST_PAGE);
  for (const ev of events.slice(0, shownEvents)) {
    const card = document.createElement('article');
    card.className = 'pm-event-card';
    card.dataset['pmEvent'] = ev.id;

    // Header row: image + title
    const head = document.createElement('div');
    head.className = 'pm-event-head';
    const img = document.createElement('span');
    img.className = 'pm-event-img';
    if (ev.iconUrl || ev.imageUrl) {
      const i = document.createElement('img');
      i.src = ev.iconUrl ?? ev.imageUrl!;
      i.alt = '';
      i.loading = 'lazy';
      i.decoding = 'async';
      i.addEventListener('error', () => {
        i.remove();
        img.textContent = (ev.title[0] ?? '?').toUpperCase();
      }, { once: true });
      img.appendChild(i);
    } else {
      img.textContent = (ev.title[0] ?? '?').toUpperCase();
    }
    head.appendChild(img);
    const titleEl = document.createElement('div');
    titleEl.className = 'pm-event-title';
    titleEl.textContent = ev.title;
    head.appendChild(titleEl);
    card.appendChild(head);

    // Outcome chips: top N labels with their price. Two-column for binary,
    // single-column rows for multi-candidate.
    const outcomes = document.createElement('div');
    outcomes.className = ev.isBinary ? 'pm-outcomes-binary' : 'pm-outcomes-list';
    const shown = ev.outcomes.slice(0, ev.isBinary ? 2 : 3);
    for (const o of shown) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pm-outcome-btn';
      if (/^yes$/i.test(o.label)) btn.classList.add('yes');
      if (/^no$/i.test(o.label)) btn.classList.add('no');
      // Mark with the CLOB token id + render style so the WS dispatcher can
      // find this chip later and patch its price in place without a re-render.
      if (o.tokenId) btn.setAttribute('data-pm-token', o.tokenId);
      btn.setAttribute('data-pm-style', ev.isBinary ? 'pct' : 'cents');
      const label = document.createElement('span');
      label.className = 'pm-outcome-label';
      label.textContent = o.label;
      const pct = document.createElement('span');
      pct.className = 'pm-outcome-pct';
      pct.textContent = ev.isBinary ? `${Math.round(o.pricePct)}%` : `${Math.round(o.pricePct)}¢`;
      btn.appendChild(label);
      btn.appendChild(pct);
      // ≥99¢ means the market has effectively resolved — there is nothing
      // sensible to buy, so stop presenting it as a trade.
      const resolved = o.pricePct >= 99;
      if (resolved) {
        btn.classList.add('resolved');
        btn.disabled = true;
        pct.textContent = 'Resolved';
        // Live ticks must not resurrect a resolved chip's price display.
        btn.removeAttribute('data-pm-token');
      } else {
        on(btn, 'click', (e) => {
          e.stopPropagation();
          openPolymarketOrderForOutcome(ev, o);
        });
      }
      outcomes.appendChild(btn);
    }
    card.appendChild(outcomes);

    // Footer: more-link + volume
    const footer = document.createElement('div');
    footer.className = 'pm-event-foot';
    if (ev.marketCount > shown.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'pm-event-more';
      more.textContent = `Show more (${ev.marketCount - shown.length})`;
      on(more, 'click', () => openPolymarketOrderForOutcome(ev, ev.outcomes[0]!));
      footer.appendChild(more);
    } else {
      footer.appendChild(document.createElement('span'));
    }
    const vol = document.createElement('span');
    vol.className = 'pm-event-vol';
    vol.textContent = `${formatCompactUsd(ev.volume24hr)} vol`;
    footer.appendChild(vol);
    card.appendChild(footer);

    host.appendChild(card);
  }
  if (events.length > shownEvents) {
    appendShowAllRow(host, 'pmMarketsList', events.length, 'events', () =>
      renderPmEvents(events, sourceKind),
    );
  }
  // Subscribe the visible token ids over CLOB WS so prices patch live —
  // re-run on every render so an expanded page resubscribes its new slice.
  openPmCloblSocket(collectVisiblePmTokens(events));
}

/** Bridge: event card outcome tap → existing Polymarket order sheet. We
    synthesize a PmMarket-shaped object so the sheet doesn't need to know
    about events. */
function openPolymarketOrderForOutcome(ev: PmEvent, outcome: PmEventOutcome): void {
  const market: PmMarket = {
    id: ev.id,
    question: ev.title,
    imageUrl: ev.imageUrl,
    logoUrl: ev.iconUrl,
    category: ev.tags[0] ?? null,
    outcomes: ev.outcomes.map((o) => ({ label: o.label, pricePct: o.pricePct, marketId: o.marketId })),
    closesAt: null,
  };
  openPolymarketOrder(market);
  // Pre-select the tapped outcome inside the sheet.
  const match = market.outcomes.find((o) => o.label === outcome.label);
  if (match) setPmOutcome(match);
}

/* ── Lane C — Polymarket top traders + one-tap copy ──────────────────────
   Live leaderboard (server-computed + persisted, 5-min cache) rendered as a
   horizontal strip above the prediction categories. Copy fetches the
   trader's best open position as an order prefill and opens the existing
   PM order sheet with copiedFrom attribution threaded into the order. */
interface PmTopTraderWire {
  wallet: string;
  name: string | null;
  pnl: number;
  value: number;
  positions: number;
  winRate: number | null;
}

const PM_TRADERS_TTL_MS = 300_000;
let pmTradersLoadedAt = 0;
let pmTradersInflight: Promise<void> | null = null;
let pmCopySource: string | null = null;

function pmTraderDisplayName(t: PmTopTraderWire): string {
  const name = t.name?.trim();
  if (name) return name;
  return `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`;
}

function fmtSignedCompactUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${formatCompactUsd(Math.abs(n))}`;
}

function renderPmTopTraders(traders: PmTopTraderWire[]): void {
  const section = document.getElementById('pmTopTraders');
  const strip = document.getElementById('pmTradersStrip');
  if (!section || !strip) return;
  if (!traders.length) {
    section.hidden = true;
    return;
  }
  strip.textContent = '';
  traders.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = 'pm-trader-card';
    card.setAttribute('role', 'listitem');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.appendChild(dotMarkSvgElement(t.wallet, 'currentColor'));
    card.appendChild(avatar);

    const who = document.createElement('span');
    who.className = 'who';
    const rank = document.createElement('span');
    rank.className = 'rk';
    rank.textContent = `#${idx + 1}`;
    who.appendChild(rank);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = pmTraderDisplayName(t);
    who.appendChild(nm);
    card.appendChild(who);

    const pnl = document.createElement('span');
    pnl.className = 'pnl' + (t.pnl > 0 ? ' pos' : t.pnl < 0 ? ' neg' : '');
    pnl.textContent = `${fmtSignedCompactUsd(t.pnl)} PnL`;
    card.appendChild(pnl);

    const meta = document.createElement('span');
    meta.className = 'meta-line';
    const win = t.winRate != null ? `${Math.round(t.winRate * 100)}% WIN · ` : '';
    meta.textContent = `${win}${t.positions} POS · ${formatCompactUsd(t.value)}`;
    card.appendChild(meta);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'pillbtn';
    copy.textContent = 'Copy';
    copy.setAttribute('data-copy-trader', t.wallet);
    copy.setAttribute('aria-label', `Copy ${pmTraderDisplayName(t)}'s top position`);
    card.appendChild(copy);

    strip.appendChild(card);
  });
  section.hidden = false;
}

function hydratePmTopTraders(force = false): Promise<void> {
  if (pmTradersInflight) return pmTradersInflight;
  const host = document.getElementById('pmTopTraders');
  if (!host) return Promise.resolve();
  if (!force && Date.now() - pmTradersLoadedAt < PM_TRADERS_TTL_MS) return Promise.resolve();
  pmTradersInflight = nexaApi.markets.polymarket
    .leaderboard({ sort: 'pnl', limit: 8 })
    .then((r) => {
      pmTradersLoadedAt = Date.now();
      renderPmTopTraders(r.traders as PmTopTraderWire[]);
    })
    .catch(() => {
      // Quiet failure: the strip is an enhancement, the events list below is
      // the primary surface. A previously rendered strip stays as-is.
      if (!pmTradersLoadedAt) host.hidden = true;
    })
    .finally(() => {
      pmTradersInflight = null;
    });
  return pmTradersInflight;
}

on(document, 'click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-trader]');
  if (!btn) return;
  const wallet = btn.getAttribute('data-copy-trader');
  if (!wallet || btn.disabled) return;
  const restoreLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Copying…';
  void nexaApi.markets.polymarket
    .copyIntent(wallet)
    .then((r) => {
      const intent = r.intent;
      if (!intent) {
        toast('No copyable open position for this trader right now.', 'err');
        return;
      }
      const price = intent.currentPriceCents ?? intent.entryPriceCents ?? 50;
      openPolymarketOrder({
        id: intent.marketId,
        question: intent.title,
        imageUrl: intent.icon,
        logoUrl: intent.icon,
        category: 'Copy trade',
        outcomes: [{ label: intent.outcome, pricePct: price, marketId: intent.marketId }],
        closesAt: intent.endDate,
      });
      // AFTER the open — openPolymarketOrder clears stale attribution.
      pmCopySource = intent.wallet;
      const qty = document.getElementById('pmQty') as HTMLInputElement | null;
      if (qty && intent.suggestedQtyUsd > 0) qty.value = String(Math.max(1, Math.round(intent.suggestedQtyUsd)));
      syncPmPayout();
    })
    .catch((err) => {
      toast(err instanceof ApiFailure ? err.message : 'Could not load copy intent.', 'err');
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = restoreLabel;
    });
});

/* ── Sprint 16 — Hyperliquid trade sheet ───────────────────────────────── */
let activeHlMarket: HlMarket | null = null;
let hlSide: 'long' | 'short' = 'long';
type OrderAttemptKey = { fingerprint: string; idempotencyKey: string };
let hlOrderAttempt: OrderAttemptKey | null = null;
let pmOrderAttempt: OrderAttemptKey | null = null;

function idempotencyKeyFor(current: OrderAttemptKey | null, fingerprint: string): OrderAttemptKey {
  if (current?.fingerprint === fingerprint) return current;
  return { fingerprint, idempotencyKey: crypto.randomUUID() };
}

function openHyperliquidOrder(market: HlMarket): void {
  activeHlMarket = market;
  // hlSide is set by the caller (detail view Long/Short button); preserve it.
  // Spot markets (no maxLeverage) trade as Buy/Sell with no leverage. We flag
  // the sheet root so CSS hides leverage and JS renames the toggle/CTA.
  const isSpot = !(market.maxLeverage && Number.isFinite(market.maxLeverage));
  const sheetRoot = document.querySelector<HTMLElement>('#hlOrderSheet .trade-sheet');
  if (sheetRoot) sheetRoot.dataset['marketKind'] = isSpot ? 'spot' : 'perp';
  // Side toggle labels: Long/Short → Buy/Sell for spot.
  $$('[data-hlside]').forEach((b) => {
    const side = b.getAttribute('data-hlside');
    if (!side) return;
    b.textContent = isSpot
      ? (side === 'long' ? 'Buy' : 'Sell')
      : (side === 'long' ? 'Long' : 'Short');
  });
  void hydrateHlBuilderStatus();
  void hydrateHlOrderAvailable();
  // Reset per-open extras: TP/SL and reduce-only must not leak between
  // markets. The adv field (TP/SL legs) is perps-only — spot and HIP-3
  // routes don't accept attached triggers.
  hlReduceOnly = false;
  document.getElementById('hlReduceOnlyBtn')?.classList.remove('on');
  const advField = document.getElementById('hlAdvField');
  if (advField) advField.hidden = hlVenueFor(market) !== 'hyperliquid';
  const tpInput = document.getElementById('hlTpPrice') as HTMLInputElement | null;
  const slInput = document.getElementById('hlSlPrice') as HTMLInputElement | null;
  if (tpInput) tpInput.value = '';
  if (slInput) slInput.value = '';
  // A stale perps-only type (stop/twap) must not carry into spot/stocks.
  if (!hlTypeAllowed(hlOrderType)) hlOrderType = 'market';
  applyHlOrderTypeUi();
  setOrderLogo('hl', marketLogoUrl(market), hlMarketSymbol(market));
  const symEl = document.getElementById('hlOrderSym');
  if (symEl) symEl.textContent = hlDisplaySymbol(market);
  const nameEl = document.getElementById('hlOrderName');
  if (nameEl) nameEl.textContent = hlDisplayName(market);
  const priceEl = document.getElementById('hlOrderPrice');
  if (priceEl) priceEl.textContent = formatMarketPrice(market.priceUsd);
  const changeEl = document.getElementById('hlOrderChange');
  if (changeEl) {
    changeEl.textContent = market.change24hPct == null ? '24h · n/a' : formatPctLabel(market.change24hPct, ' 24h');
    changeEl.classList.toggle('down', (market.change24hPct ?? 0) < 0);
  }
  setHlOrderStats(market);
  // Configure leverage slider for this market's actual max. Slider tick row
  // surfaces common stops (1, 5, 10, 25, max) but the user can stop at any
  // integer step in between.
  const maxLev = market.maxLeverage && Number.isFinite(market.maxLeverage) ? Math.max(1, market.maxLeverage) : 20;
  const maxEl = document.getElementById('hlLevMax');
  if (maxEl) maxEl.textContent = `${maxLev}×`;
  configureLeverageSlider(maxLev);
  // Reflect the externally-chosen side (set by detail view Long/Short) on the
  // toggle + sheet accent.
  $$('[data-hlside]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-hlside') === hlSide));
  if (sheetRoot) sheetRoot.dataset['side'] = hlSide;
  const hlRegion = regionFromStorage();
  syncHlNotional();
  // Disabled-honest: if the user can't trade (signed out / blocked region),
  // lock the CTA copy. Otherwise let syncHlNotional own the label so it tracks
  // side flips ("Long BTC" ↔ "Short BTC").
  const hlBtn = document.getElementById('hlPlaceOrderBtn') as HTMLButtonElement | null;
  if (hlBtn) {
    delete hlBtn.dataset['lockedLabel'];
    if (!LIVE) {
      hlBtn.disabled = true;
      hlBtn.textContent = 'Sign in to trade';
      hlBtn.dataset['lockedLabel'] = '1';
    } else if (hlRegion && isRegionBlocked(hlRegion)) {
      hlBtn.disabled = true;
      hlBtn.textContent = 'Read-only in your region';
      hlBtn.dataset['lockedLabel'] = '1';
    } else {
      const gate = venueTradeBlock(
        market.venueKind === 'hyperliquid-hip3' ? 'stocks'
          : market.venueKind === 'hyperliquid-spot' ? 'spot'
          : 'perps',
      );
      if (gate) {
        hlBtn.disabled = true;
        hlBtn.textContent = gate;
        hlBtn.dataset['lockedLabel'] = '1';
      } else {
        hlBtn.disabled = false;
      }
    }
  }
  syncHlNotional();
  openOvl('hlOrderSheet');
}

let hlSelectedLev = 3;

/* Visible tick marks for the slider — common stops + max. Always 1 and max. */
function leverageTickValues(max: number): number[] {
  const candidates = [1, 5, 10, 25, 50, 100];
  const inRange = candidates.filter((n) => n < max);
  return Array.from(new Set([1, ...inRange.slice(-3), max])).sort((a, b) => a - b);
}

/* Configure the leverage slider for a market: max, value, ticks, color. */
function configureLeverageSlider(maxLev: number): void {
  const slider = document.getElementById('hlLevSlider') as HTMLInputElement | null;
  const ticksRow = document.getElementById('hlLevTicksRow');
  const valEl = document.getElementById('hlLevVal');
  if (!slider) return;
  slider.max = String(maxLev);
  if (hlSelectedLev > maxLev) hlSelectedLev = Math.max(1, Math.min(maxLev, 3));
  slider.value = String(hlSelectedLev);
  updateLeverageSliderTrack();
  if (valEl) valEl.textContent = `${hlSelectedLev}×`;
  if (ticksRow) {
    ticksRow.textContent = '';
    for (const v of leverageTickValues(maxLev)) {
      const span = document.createElement('span');
      span.textContent = v === maxLev ? `${v}×` : `${v}`;
      ticksRow.appendChild(span);
    }
  }
}

function updateLeverageSliderTrack(): void {
  const slider = document.getElementById('hlLevSlider') as HTMLInputElement | null;
  if (!slider) return;
  const min = Number(slider.min) || 1;
  const max = Number(slider.max) || 1;
  const val = Number(slider.value) || min;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  slider.style.setProperty('--pct', `${pct}%`);
}

function syncHlNotional(): void {
  const qty = Number(($('#hlQty') as HTMLInputElement)?.value ?? '0') || 0;
  const lev = hlSelectedLev || 1;
  const notional = qty * lev;
  const nEl = document.getElementById('hlNotional');
  if (nEl) nEl.textContent = '$' + notional.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Update CTA copy + sheet accent on side change. Buy/Sell for spot,
  // Long/Short for perps.
  const coin = activeHlMarket ? hlMarketSymbol(activeHlMarket) : '';
  const cta = document.getElementById('hlPlaceOrderBtn') as HTMLButtonElement | null;
  const isSpot = activeHlMarket
    ? !(activeHlMarket.maxLeverage && Number.isFinite(activeHlMarket.maxLeverage))
    : false;
  if (cta && coin && !cta.dataset['lockedLabel']) {
    if (isSpot) cta.textContent = hlSide === 'long' ? `Buy ${coin}` : `Sell ${coin}`;
    else cta.textContent = hlSide === 'long' ? `Long ${coin}` : `Short ${coin}`;
  }
  const valEl = document.getElementById('hlLevVal');
  if (valEl) valEl.textContent = `${lev}×`;
  // Estimated liquidation price — first-order approximation entry×(1∓1/lev),
  // labeled "Est." because it ignores maintenance-margin tiers and funding.
  const liqEl = document.getElementById('hlLiqEst');
  if (liqEl) {
    const limitPx = Number((document.getElementById('hlLimitPrice') as HTMLInputElement | null)?.value ?? '0') || 0;
    const trigPx = Number((document.getElementById('hlTriggerPrice') as HTMLInputElement | null)?.value ?? '0') || 0;
    // Entry approximation per type: the stop's trigger, else the limit price.
    const entry =
      hlOrderType === 'stop' && trigPx > 0
        ? trigPx
        : (hlOrderType === 'limit' || hlOrderType === 'stop') && limitPx > 0
          ? limitPx
          : activeHlMarket?.priceUsd ?? 0;
    if (isSpot || !(entry > 0) || lev <= 1) {
      liqEl.textContent = '—';
    } else {
      const liq = hlSide === 'long' ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
      liqEl.textContent = `≈ ${formatMarketPrice(liq)}`;
    }
  }
}

// Slider input → update lev state + recompute notional + repaint track fill.
on(document.getElementById('hlLevSlider'), 'input', () => {
  const slider = document.getElementById('hlLevSlider') as HTMLInputElement | null;
  if (!slider) return;
  hlSelectedLev = Math.max(1, Number(slider.value) || 1);
  updateLeverageSliderTrack();
  syncHlNotional();
});

$$('[data-hlside]').forEach((b) => {
  on(b, 'click', () => {
    hlSide = (b.getAttribute('data-hlside') as 'long' | 'short') ?? 'long';
    $$('[data-hlside]').forEach((bb) => bb.classList.toggle('on', bb === b));
    const sheetRoot = document.querySelector<HTMLElement>('#hlOrderSheet .trade-sheet');
    if (sheetRoot) sheetRoot.dataset['side'] = hlSide;
    syncHlNotional();
  });
});
on($('#hlQty'), 'input', syncHlNotional);
on(document.getElementById('hlLimitPrice'), 'input', syncHlNotional);
/* Sprint 16.4 — order type + TIF state. Live builder fee is backend-managed;
   the sheet only hydrates status labels from /markets/hyperliquid/builder-status. */
type HlOrderTypeUi = 'market' | 'limit' | 'stop' | 'twap' | 'scale';
let hlOrderType: HlOrderTypeUi = 'market';
/** Limit-order time-in-force. GTC (default) actually RESTS on the book at the
 *  user's price — the pre-2026-07 sheet hardcoded IOC, which cancelled any
 *  limit order placed away from the market and made "set my own price"
 *  impossible. Market orders always go out IOC. */
let hlTif: 'Gtc' | 'Ioc' | 'Alo' = 'Gtc';
/** Stop trigger direction: true = trigger when mark RISES to the price. */
let hlStopAbove = true;
let hlTwapRandomize = false;

/** Round a seeded price to a sane input precision (5 significant digits). */
function seedPriceForInput(px: number): number {
  if (!(px > 0)) return 0;
  const digits = Math.max(0, 5 - Math.ceil(Math.log10(px)));
  return Number(px.toFixed(Math.min(8, digits)));
}

/** Which order types the active market's venue supports. Stop + TWAP are
 *  perps-only wire kinds; scale is N GTC limits so it works wherever GTC
 *  limits do (perps, spot, HIP-3 stocks). */
function hlTypeAllowed(type: HlOrderTypeUi): boolean {
  if (type === 'stop' || type === 'twap') {
    return activeHlMarket ? hlVenueFor(activeHlMarket) === 'hyperliquid' : true;
  }
  return true;
}

/** Reflect hlOrderType/hlTif in the sheet: pill states, per-type field
 *  visibility, one-time price seeds. Shared by the type pills and the
 *  click-a-book-row entry path. */
function applyHlOrderTypeUi(): void {
  $$('[data-hltype]').forEach((bb) => {
    const t = (bb.getAttribute('data-hltype') as HlOrderTypeUi) ?? 'market';
    bb.classList.toggle('on', t === hlOrderType);
    (bb as HTMLButtonElement).hidden = !hlTypeAllowed(t);
  });
  const show = (id: string, visible: boolean): void => {
    const el = document.getElementById(id);
    if (el) el.hidden = !visible;
  };
  // Stop shows the limit field too (stop-LIMIT); scale has its own band
  // inputs; TIF stays a plain-limit concern (stop is forced GTC, scale is
  // GTC by construction, market/TWAP are venue-managed).
  show('hlLimitField', hlOrderType === 'limit' || hlOrderType === 'stop');
  show('hlTifField', hlOrderType === 'limit');
  show('hlStopField', hlOrderType === 'stop');
  show('hlTwapField', hlOrderType === 'twap');
  show('hlScaleField', hlOrderType === 'scale');
  // Seed the limit price ONCE from the live market when the field opens
  // empty. Never overwrite after that — the price belongs to the user
  // (official-app convention: ticker updates must not move a typed price).
  if (hlOrderType === 'limit' || hlOrderType === 'stop') {
    const priceInput = document.getElementById('hlLimitPrice') as HTMLInputElement | null;
    if (priceInput && !priceInput.value && activeHlMarket?.priceUsd) {
      priceInput.value = String(activeHlMarket.priceUsd);
    }
  }
  if (hlOrderType === 'scale' && activeHlMarket?.priceUsd) {
    // Seed an initial ±2% band around the market, once, same ownership rule.
    const lower = document.getElementById('hlScaleLower') as HTMLInputElement | null;
    const upper = document.getElementById('hlScaleUpper') as HTMLInputElement | null;
    if (lower && !lower.value) lower.value = String(seedPriceForInput(activeHlMarket.priceUsd * 0.98));
    if (upper && !upper.value) upper.value = String(seedPriceForInput(activeHlMarket.priceUsd * 1.02));
  }
  $$('[data-hltif]').forEach((bb) => bb.classList.toggle('on', bb.getAttribute('data-hltif') === hlTif));
  $$('[data-hlstopdir]').forEach((bb) =>
    bb.classList.toggle('on', (bb.getAttribute('data-hlstopdir') === 'above') === hlStopAbove),
  );
  document.getElementById('hlTwapRandomBtn')?.classList.toggle('on', hlTwapRandomize);
}

$$('[data-hltype]').forEach((b) => {
  on(b, 'click', () => {
    const next = (b.getAttribute('data-hltype') as HlOrderTypeUi) ?? 'market';
    if (!hlTypeAllowed(next)) return;
    hlOrderType = next;
    applyHlOrderTypeUi();
    syncHlNotional();
  });
});
$$('[data-hlstopdir]').forEach((b) => {
  on(b, 'click', () => {
    hlStopAbove = b.getAttribute('data-hlstopdir') === 'above';
    applyHlOrderTypeUi();
  });
});
on(document.getElementById('hlTwapRandomBtn'), 'click', () => {
  hlTwapRandomize = !hlTwapRandomize;
  applyHlOrderTypeUi();
});
$$('[data-hltif]').forEach((b) => {
  on(b, 'click', () => {
    const tif = b.getAttribute('data-hltif');
    if (tif !== 'Gtc' && tif !== 'Ioc' && tif !== 'Alo') return;
    hlTif = tif;
    $$('[data-hltif]').forEach((bb) => bb.classList.toggle('on', bb === b));
  });
});
on(document.getElementById('hlLimitMidBtn'), 'click', () => {
  const priceInput = document.getElementById('hlLimitPrice') as HTMLInputElement | null;
  if (priceInput && activeHlMarket?.priceUsd) {
    priceInput.value = String(activeHlMarket.priceUsd);
  }
});

/* ── Available balance in the order sheet ─────────────────────────────────
 * Size is margin USD, so the honest cap is what the venue can actually
 * draw on: perps count spot USDC too (the backend auto-sweeps spot → perp
 * on insufficient margin); spot counts only spot USDC. Soft data — when the
 * summary leg failed we show "—" and do not block the order. */
let hlAvailableUsd: number | null = null;

function hlOrderAvailable(): number | null {
  const s = portfolioSummaryView;
  if (!s) return null;
  const spotUsd = s.legs.hyperliquidSpot === 'ok' ? (s.hyperliquidSpot?.usdcUsd ?? 0) : null;
  const perpUsd = s.legs.hyperliquid === 'ok' ? (s.hyperliquid?.withdrawableUsd ?? 0) : null;
  const hip3Usd = s.legs.hyperliquidHip3 === 'ok' ? (s.hyperliquidHip3?.withdrawableUsd ?? 0) : null;
  const venueKind = activeHlMarket ? hlVenueFor(activeHlMarket) : 'hyperliquid';
  if (venueKind === 'hyperliquid-spot') return spotUsd;
  if (venueKind === 'hyperliquid-hip3') {
    if (hip3Usd == null && perpUsd == null && spotUsd == null) return null;
    return (hip3Usd ?? 0) + (perpUsd ?? 0) + (spotUsd ?? 0);
  }
  if (perpUsd == null && spotUsd == null) return null;
  return (perpUsd ?? 0) + (spotUsd ?? 0);
}

function renderHlOrderAvailable(): void {
  hlAvailableUsd = hlOrderAvailable();
  const label = document.getElementById('hlAvailLbl');
  if (label) {
    label.textContent = hlAvailableUsd == null ? 'AVAILABLE · —' : `AVAILABLE · ${money(hlAvailableUsd)}`;
  }
}

async function hydrateHlOrderAvailable(): Promise<void> {
  renderHlOrderAvailable();
  await hydratePortfolioSummary();
  renderHlOrderAvailable();
}

on(document.getElementById('hlQtyMaxBtn'), 'click', () => {
  if (hlAvailableUsd == null) return;
  const qtyInput = document.getElementById('hlQty') as HTMLInputElement | null;
  if (!qtyInput) return;
  qtyInput.value = (Math.floor(hlAvailableUsd * 100) / 100).toFixed(2);
  syncHlNotional();
});

$$('[data-hlqty-pct]').forEach((b) => {
  on(b, 'click', () => {
    if (hlAvailableUsd == null) return;
    const pct = Number(b.getAttribute('data-hlqty-pct')) || 0;
    const qtyInput = document.getElementById('hlQty') as HTMLInputElement | null;
    if (!qtyInput || !(pct > 0)) return;
    qtyInput.value = (Math.floor(hlAvailableUsd * pct) / 100).toFixed(2);
    syncHlNotional();
  });
});

/** Reduce-only toggle — perps/spot flag; order can only shrink a position. */
let hlReduceOnly = false;
on(document.getElementById('hlReduceOnlyBtn'), 'click', () => {
  hlReduceOnly = !hlReduceOnly;
  document.getElementById('hlReduceOnlyBtn')?.classList.toggle('on', hlReduceOnly);
});

/** Sprint 16.4 — pull the live builder fee for the order sheet display. */
async function hydrateHlBuilderStatus(): Promise<void> {
  const feeLabel = document.getElementById('hlBuilderFeeLabel');
  if (feeLabel) feeLabel.textContent = HL_BUILDER_FEE_FALLBACK_LABEL;
  if (!LIVE) return;
  try {
    const r = await nexaApi.markets.hyperliquid.builderStatus();
    if (feeLabel) feeLabel.textContent = `${r.builder.currentFeeBps.toFixed(2).replace(/\.?0+$/, '')} bps`;
  } catch {
    if (feeLabel) feeLabel.textContent = HL_BUILDER_FEE_FALLBACK_LABEL;
  }
}

/* The backend manages the one-time HL builder-fee agreement during account
   setup or the first live HL action. The web client only refreshes status so
   labels stay current and never prompts during order placement. */
let bootstrapLiveTradingPromise: Promise<void> | null = null;
async function bootstrapLiveTrading(): Promise<void> {
  if (bootstrapLiveTradingPromise) return bootstrapLiveTradingPromise;
  if (!LIVE) return;
  bootstrapLiveTradingPromise = (async () => {
    try {
      await hydrateHlBuilderStatus();
    } catch {
      // Status refresh is non-blocking.
    }
  })();
  return bootstrapLiveTradingPromise;
}

/* Sprint 16.4 — open positions list on s27. Polls every 5s while the screen
   is visible; stopped on navigation away. */
const ACTIVE_MARKET_POSITION_STATUSES = new Set<MarketPositionStatusWire>([
  'open',
  'filled',
  'resting',
  'partially_filled',
  'accepted',
  'cancel_requested',
]);
const CANCELLABLE_MARKET_POSITION_STATUSES = new Set<MarketPositionStatusWire>([
  'open',
  'resting',
  'partially_filled',
  'accepted',
  'cancel_requested',
]);
function isActiveMarketPosition(p: MarketPositionWire): boolean {
  return ACTIVE_MARKET_POSITION_STATUSES.has(p.status);
}
function isCancellableMarketPosition(p: MarketPositionWire): boolean {
  return (
    (
      p.venue === 'hyperliquid' ||
      p.venue === 'hyperliquid-spot' ||
      p.venue === 'hyperliquid-hip3' ||
      p.venue === 'polymarket'
    ) &&
    CANCELLABLE_MARKET_POSITION_STATUSES.has(p.status)
  );
}

let hlPositionsTimer: ReturnType<typeof setInterval> | null = null;
const HL_POSITIONS_POLL_INTERVAL_MS = 30_000;

/* ADR-0004 part 2 — HL user-data streaming. When the server runs
   HL_USER_STREAMS=1, `priv:<uid>:account` snapshots arrive within ~1s of any
   account change. While that stream is fresh the 30s positions TIMER
   stretches to STREAM_POLL_STRETCH_MS instead of stopping: the stream does
   NOT carry resting orders, so polling must keep bounding their staleness
   (an order canceled from another device would otherwise show forever).
   Stream silence past the window restores full 30s polling automatically,
   so the flag can be flipped off server-side with no client deploy. */
const ACCOUNT_STREAM_FRESH_MS = 45_000;
const STREAM_POLL_STRETCH_MS = 90_000;
let lastAccountStreamAt = 0;
let lastHlPositionsFetchAt = 0;
/** coin:side:qty fingerprint of the last streamed snapshot — a change means
 *  a fill/close happened and the REST positions list should re-render NOW. */
let lastAccountFingerprint = '';

/** Sign-out / user-switch reset — one user's stream freshness or positions
 *  fingerprint must never gate the next user's polling. */
function resetAccountStreamState(): void {
  lastAccountStreamAt = 0;
  lastAccountFingerprint = '';
}

function handleAccountStreamEvent(ev: AccountEvent): void {
  // A hidden tab must not consume freshness or the fingerprint: its hydrates
  // no-op (document.hidden guard in hydrateHlPositionsImpl), and marking the
  // change as "seen" here would leave stale positions with no repair path.
  if (document.hidden) return;
  lastAccountStreamAt = Date.now();
  // Keep the cached portfolio summary's HL perps leg current so the wallet
  // overview + spot⇄perp sheet caps track the stream between REST fetches.
  const hl = portfolioSummaryView?.hyperliquid;
  if (
    hl &&
    (hl.equityUsd !== ev.equityUsd ||
      hl.marginUsedUsd !== ev.marginUsedUsd ||
      hl.withdrawableUsd !== ev.withdrawableUsd ||
      hl.accountValueUsd !== ev.accountValueUsd)
  ) {
    hl.equityUsd = ev.equityUsd;
    hl.marginUsedUsd = ev.marginUsedUsd;
    hl.withdrawableUsd = ev.withdrawableUsd;
    hl.accountValueUsd = ev.accountValueUsd;
    renderWalletOverview();
  }
  const fingerprint = ev.positions
    .map((p) => `${p.coin}:${p.sideLong ? 'L' : 'S'}:${p.qty}`)
    .join('|');
  if (fingerprint !== lastAccountFingerprint) {
    lastAccountFingerprint = fingerprint;
    void hydrateHlPositions();
  }
}

/* Fill events can arrive in bursts (a market order sweeping N book levels,
   TWAP sub-fills). Coalesce: one toast + one positions/summary refresh per
   FILL_BURST_MS window instead of N of each — N forced fetches in one frame
   is exactly the stampede that trips the client 429 backoff. */
const FILL_BURST_MS = 400;
let fillBurstCount = 0;
let fillBurstLast: FillEvent | null = null;
let fillBurstTimer: number | null = null;

function handleFillStreamEvent(ev: FillEvent): void {
  if (document.hidden) return;
  lastAccountStreamAt = Date.now();
  fillBurstCount++;
  fillBurstLast = ev;
  if (fillBurstTimer != null) return;
  fillBurstTimer = window.setTimeout(() => {
    const count = fillBurstCount;
    const last = fillBurstLast;
    fillBurstCount = 0;
    fillBurstLast = null;
    fillBurstTimer = null;
    if (!last) return;
    const px = fmtOrderPx(last.px);
    if (count === 1) {
      const qty = last.sz.toLocaleString('en-US', { maximumFractionDigits: 6 });
      toast(`${last.coin} ${last.dir || (last.sideLong ? 'buy' : 'sell')} filled — ${qty} @ $${px} ✓`);
    } else {
      toast(`${count} fills — last ${last.coin} @ $${px} ✓`);
    }
    void hydrateHlPositions();
    void hydratePortfolioSummary(true);
  }, FILL_BURST_MS);
}
const HL_POSITIONS_RATE_LIMIT_BACKOFF_MS = 60_000;
let hlPositionsRateLimitedUntilMs = 0;
let hlPositionsInflight: Promise<void> | null = null;

function hydrateHlPositions(): Promise<void> {
  if (hlPositionsInflight) return hlPositionsInflight;
  hlPositionsInflight = hydrateHlPositionsImpl().finally(() => {
    hlPositionsInflight = null;
  });
  return hlPositionsInflight;
}

/** Authoritative liquidation price for an open HL perp, matched by coin from
 *  the portfolio summary's live positions. Null when the summary isn't loaded
 *  or the venue omitted the price — callers fall back to showing nothing. */
function liveLiquidationFor(symbol: string): number | null {
  const s = portfolioSummaryView;
  if (!s || s.legs.hyperliquid !== 'ok') return null;
  const coin = symbol.trim().toUpperCase();
  const hit = s.hyperliquid?.positions?.find((lp) => lp.coin.trim().toUpperCase() === coin);
  return hit?.liquidationPriceUsd ?? null;
}

async function hydrateHlPositionsImpl(): Promise<void> {
  if (document.hidden) return;
  const host = document.getElementById('hlPositionsList');
  const label = document.getElementById('hlPositionsLabel');
  if (!host || !label) return;
  if (!LIVE) {
    host.hidden = true;
    label.hidden = true;
    return;
  }
  if (Date.now() < hlPositionsRateLimitedUntilMs) {
    host.hidden = true;
    label.hidden = false;
    label.textContent = 'POSITIONS RATE LIMITED';
    return;
  }
  label.textContent = 'YOUR OPEN POSITIONS';
  try {
    const r = await nexaApi.markets.positions();
    lastHlPositionsFetchAt = Date.now();
    hlPositionsRateLimitedUntilMs = 0;
    const open = r.positions.filter(isActiveMarketPosition);
    if (!open.length) {
      host.hidden = true;
      label.hidden = true;
      return;
    }
    host.hidden = false;
    label.hidden = false;
    host.textContent = '';
    for (const p of open.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'lrow';
      const grow = document.createElement('span');
      grow.className = 'grow';
      const t = document.createElement('span');
      t.className = 't';
      t.style.fontWeight = '600';
      t.textContent = `${p.symbol} ${p.sideLong ? 'LONG' : 'SHORT'}`;
      grow.appendChild(t);
      grow.appendChild(document.createElement('br'));
      const s = document.createElement('span');
      s.className = 's';
      let sub = `$${Number(p.qtyUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })} @ $${Number(p.entryPriceUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      // Authoritative venue liquidation price (default polling mode) — sourced
      // from the portfolio summary's live HL positions, matched by coin. Absent
      // when the summary isn't loaded; the order form keeps its own estimate.
      const liq = liveLiquidationFor(p.symbol);
      if (liq != null) sub += ` · LIQ $${liq.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      s.textContent = sub;
      grow.appendChild(s);
      row.appendChild(grow);
      if (isCancellableMarketPosition(p)) {
        const close = document.createElement('button');
        close.className = 'pillbtn';
        close.textContent = 'CLOSE';
        const positionId = p.id;
        on(close, 'click', async () => {
          close.disabled = true;
          close.textContent = '…';
          try {
            await nexaApi.markets.cancelOrder(positionId);
            toast(`${p.symbol} position closed ✓`);
            await hydrateHlPositions();
          } catch (e) {
            toast(e instanceof ApiFailure ? e.message : 'Close failed.', 'err');
            close.disabled = false;
            close.textContent = 'CLOSE';
          }
        });
        row.appendChild(close);
      }
      // Isolated-margin management for filled HL perp positions. Signed
      // delta: a leading "-" removes margin (e.g. "-25").
      if (p.venue === 'hyperliquid' && p.status === 'filled') {
        const marginBtn = document.createElement('button');
        marginBtn.className = 'pillbtn';
        marginBtn.textContent = '± MARGIN';
        const symbol = p.symbol;
        on(marginBtn, 'click', async () => {
          const raw = window.prompt(
            `Adjust isolated margin for ${symbol} (USD).\nPositive adds, negative removes:`,
            '25',
          );
          if (raw == null) return;
          const amountUsd = Number(raw.trim());
          if (!Number.isFinite(amountUsd) || amountUsd === 0) {
            toast('Enter a non-zero USD amount.', 'err');
            return;
          }
          marginBtn.disabled = true;
          marginBtn.textContent = '…';
          try {
            await nexaApi.markets.hyperliquid.updateIsolatedMargin({
              coin: symbol,
              amountUsd,
              sideLong: p.sideLong,
            });
            toast(`${symbol} margin ${amountUsd > 0 ? '+' : '−'}${money(Math.abs(amountUsd))} ✓`);
            void hydratePortfolioSummary(true);
          } catch (e) {
            toast(e instanceof ApiFailure ? e.message : 'Margin update failed.', 'err');
          } finally {
            marginBtn.disabled = false;
            marginBtn.textContent = '± MARGIN';
          }
        });
        row.appendChild(marginBtn);
      }
      host.appendChild(row);
    }
  } catch (e) {
    if (e instanceof ApiFailure && (e.status === 429 || e.code === 'too_many_requests')) {
      hlPositionsRateLimitedUntilMs = Date.now() + rateLimitBackoffMs(e, HL_POSITIONS_RATE_LIMIT_BACKOFF_MS);
      host.hidden = true;
      label.hidden = false;
      label.textContent = 'POSITIONS RATE LIMITED';
      return;
    }
    host.hidden = true;
    label.hidden = true;
  }
}

function startHlPositionsPoll(): void {
  stopHlPositionsPoll();
  hlPositionsTimer = setInterval(() => {
    // Stream-fresh account data STRETCHES the blind poll (30s → 90s); it
    // never stops it, because resting orders only exist in the REST list.
    // Manual calls bypass this.
    if (
      Date.now() - lastAccountStreamAt < ACCOUNT_STREAM_FRESH_MS &&
      Date.now() - lastHlPositionsFetchAt < STREAM_POLL_STRETCH_MS
    ) return;
    void hydrateHlPositions();
  }, HL_POSITIONS_POLL_INTERVAL_MS);
}
function stopHlPositionsPoll(): void {
  if (hlPositionsTimer) clearInterval(hlPositionsTimer);
  hlPositionsTimer = null;
}

/* Venue routing — the order sheet is shared across perps / spot / HIP-3
   stocks because the user-facing controls (qty, side, limit, TIF) are the
   same shape. Coin namespace tells us which backend route + signing path
   to use:
     xyz:* → trade.xyz HIP-3 (stocks endpoint, EVM-signed via HL builder)
     @N    → HL spot (no leverage; same EVM signing path)
     else  → HL perps (canonical) */
function hlVenueFor(market: HlMarket): HlVenueKind {
  if (market.venueKind) return market.venueKind;
  const coin = market.coin;
  if (typeof coin === 'string' && coin.includes(':')) return 'hyperliquid-hip3';
  if (typeof coin === 'string' && coin.startsWith('@')) return 'hyperliquid-spot';
  if (!(market.maxLeverage && Number.isFinite(market.maxLeverage))) return 'hyperliquid-spot';
  return 'hyperliquid';
}

/**
 * Scale orders (official-app parity): N evenly spaced GTC limit orders across
 * [lower, upper], total size split evenly. Placed sequentially with
 * deterministic per-order idempotency keys derived from one batch key —
 * a retry of the same batch cannot double-place an order that went through.
 */
async function placeHlScaleOrders(totalQtyUsd: number, lev: number): Promise<void> {
  if (!activeHlMarket) return;
  const count = Math.floor(Number((document.getElementById('hlScaleCount') as HTMLInputElement | null)?.value ?? '0') || 0);
  const lower = Number((document.getElementById('hlScaleLower') as HTMLInputElement | null)?.value ?? '0') || 0;
  const upper = Number((document.getElementById('hlScaleUpper') as HTMLInputElement | null)?.value ?? '0') || 0;
  if (!(count >= 2 && count <= 20)) {
    toast('Scale needs 2\u201320 orders.', 'err');
    return;
  }
  if (!(lower > 0 && upper > lower)) {
    toast('Scale band needs 0 < lower < upper.', 'err');
    return;
  }
  const perOrderUsd = Math.floor((totalQtyUsd / count) * 100) / 100;
  if (perOrderUsd < 10) {
    // HL_MIN_ORDER_USD server-side \u2014 fail the whole batch up front instead
    // of placing a few and 400ing on the rest.
    toast(`Each order must be \u2265 $10 \u2014 raise size or lower the count (now $${perOrderUsd.toFixed(2)}/order).`, 'err');
    return;
  }
  const venueKind = hlVenueFor(activeHlMarket);
  const region = regionFromStorage();
  const batchKey = crypto.randomUUID();
  const btn = $('#hlPlaceOrderBtn') as HTMLButtonElement;
  btn.disabled = true;
  let placed = 0;
  try {
    for (let i = 0; i < count; i++) {
      btn.textContent = `Placing ${i + 1}/${count}\u2026`;
      const px = seedPriceForInput(lower + ((upper - lower) * i) / (count - 1));
      const opts = {
        ...(region && region !== '??' ? { region } : {}),
        idempotencyKey: `${batchKey}:${i}`,
      };
      const body = {
        coin: activeHlMarket.coin,
        sideLong: hlSide === 'long',
        qtyUsd: perOrderUsd,
        orderType: 'limit' as const,
        tif: 'Gtc' as const,
        limitPriceUsd: px,
      };
      if (venueKind === 'hyperliquid-hip3') {
        await nexaApi.markets.stocks.placeOrder({ ...body, leverage: lev }, opts);
      } else if (venueKind === 'hyperliquid-spot') {
        await nexaApi.markets.hyperliquidSpot.placeOrder(body, opts);
      } else {
        await nexaApi.markets.hyperliquid.placeOrder({ ...body, leverage: lev }, opts);
      }
      placed++;
    }
    toast(`Scale \u00b7 ${placed}/${count} GTC limits resting ${money(lower)}\u2013${money(upper)}.`);
    ($('#hlOrderSheet') as HTMLElement).classList.remove('on');
    syncScrollLock();
    void hydrateHlPositions();
  } catch (e) {
    // Orders already placed stay on the book (visible + cancellable in
    // positions) \u2014 report exactly how far the batch got.
    toast(
      `Scale stopped at ${placed}/${count}${e instanceof ApiFailure ? ` \u00b7 ${e.message}` : ''}. Placed orders remain on the book.`,
      'err',
    );
    void hydrateHlPositions();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Place order';
  }
}

on($('#hlPlaceOrderBtn'), 'click', async () => {
  if (!activeHlMarket) return;
  if (!LIVE) {
    toast('Sign in to trade Hyperliquid.', 'err');
    return;
  }
  const qty = Number(($('#hlQty') as HTMLInputElement).value) || 0;
  const lev = hlSelectedLev || 1;
  const limitPx = Number(($('#hlLimitPrice') as HTMLInputElement)?.value ?? '0') || 0;
  const triggerPx = Number((document.getElementById('hlTriggerPrice') as HTMLInputElement | null)?.value ?? '0') || 0;
  const twapMinutes = Math.floor(Number((document.getElementById('hlTwapMinutes') as HTMLInputElement | null)?.value ?? '0') || 0);
  if (!(qty > 0)) {
    toast('Enter a size above $0.', 'err');
    return;
  }
  if ((hlOrderType === 'limit' || hlOrderType === 'stop') && !(limitPx > 0)) {
    toast('Enter a limit price above $0.', 'err');
    return;
  }
  if (hlOrderType === 'stop' && !(triggerPx > 0)) {
    toast('Enter a trigger price above $0.', 'err');
    return;
  }
  if (hlOrderType === 'twap' && !(twapMinutes >= 5 && twapMinutes <= 1440)) {
    toast('TWAP duration must be 5–1440 minutes.', 'err');
    return;
  }
  // Client-side balance guard — the server re-validates, but discovering
  // insufficiency only after a signed round-trip is the UX being fixed here.
  // Only blocks when the available figure is fresh and known.
  if (hlAvailableUsd != null && qty > hlAvailableUsd + 0.01) {
    toast(`Size exceeds available ${money(hlAvailableUsd)}.`, 'err', 'MOVE FUNDS', () =>
      openHlClassSheet({ toPerp: true, prefillUsd: qty - hlAvailableUsd! }),
    );
    return;
  }
  // Venue guard — the pills are hidden per venue, but a stale selection must
  // never silently degrade into a market order on spot/stocks.
  if ((hlOrderType === 'stop' || hlOrderType === 'twap') && hlVenueFor(activeHlMarket) !== 'hyperliquid') {
    toast('Stop and TWAP are available on perps only.', 'err');
    return;
  }
  // Scale — a frontend construct: N evenly spaced GTC limits across the
  // band, size split evenly. Sequential placement with per-order idempotency
  // keys; a mid-loop failure reports placed/total honestly and leaves the
  // already-resting orders alone (visible + cancellable in positions).
  if (hlOrderType === 'scale') {
    await placeHlScaleOrders(qty, lev);
    return;
  }
  const btn = $('#hlPlaceOrderBtn') as HTMLButtonElement;
  btn.disabled = true;
  let rateLimitLockMs: number | null = null;
  btn.textContent = 'Placing…';
  try {
    const region = regionFromStorage();
    // Market orders are IOC-at-slippage-band by definition; limit orders
    // carry the user's TIF so GTC/ALO actually REST on the book. Stop-limits
    // rest at the trigger, so GTC (the route accepts Gtc/Ioc only).
    const orderType: 'market' | 'limit' = hlOrderType === 'limit' ? 'limit' : 'market';
    const tif = hlOrderType === 'limit' ? hlTif : hlOrderType === 'stop' ? ('Gtc' as const) : ('Ioc' as const);
    // Direction of the trigger relative to side picks HL's tpsl kind: a
    // trigger-above buy (breakout entry) and a trigger-below sell are 'sl';
    // the mirror cases are 'tp'. See official trigger-order semantics.
    const stopKind: 'sl' | 'tp' = (hlSide === 'long') === hlStopAbove ? 'sl' : 'tp';
    const venueKind = hlVenueFor(activeHlMarket);
    const isSpot = venueKind === 'hyperliquid-spot';
    // Spot doesn't carry leverage on the wire. Stocks (HIP-3) do.
    const fingerprint = JSON.stringify({
      venue: venueKind,
      coin: activeHlMarket.coin,
      side: hlSide,
      qty,
      lev: isSpot ? null : lev,
      uiType: hlOrderType,
      tif,
      limitPx: hlOrderType === 'limit' || hlOrderType === 'stop' ? limitPx : null,
      triggerPx: hlOrderType === 'stop' ? triggerPx : null,
      stopKind: hlOrderType === 'stop' ? stopKind : null,
      twap: hlOrderType === 'twap' ? { m: twapMinutes, r: hlTwapRandomize } : null,
      region,
    });
    hlOrderAttempt = idempotencyKeyFor(hlOrderAttempt, fingerprint);
    const idempotencyKey = hlOrderAttempt.idempotencyKey;
    const optsHeader = { ...(region && region !== '??' ? { region } : {}), idempotencyKey };

    const placeOnce = async (): Promise<{
      ok: true;
      order: { orderId: string; demo: boolean; state?: 'filled' | 'resting' | 'triggered' | 'twap_active' };
      position: MarketPositionWire;
    }> => {
      if (venueKind === 'hyperliquid-hip3') {
        return nexaApi.markets.stocks.placeOrder(
          {
            coin: activeHlMarket!.coin,
            sideLong: hlSide === 'long',
            qtyUsd: qty,
            leverage: lev,
            orderType,
            tif,
            ...(orderType === 'limit' ? { limitPriceUsd: limitPx } : {}),
          },
          optsHeader,
        );
      }
      if (venueKind === 'hyperliquid-spot') {
        return nexaApi.markets.hyperliquidSpot.placeOrder(
          {
            coin: activeHlMarket!.coin,
            sideLong: hlSide === 'long',
            qtyUsd: qty,
            orderType,
            tif,
            ...(orderType === 'limit' ? { limitPriceUsd: limitPx } : {}),
            ...(hlReduceOnly ? { reduceOnly: true } : {}),
          },
          optsHeader,
        );
      }
      // Perps carry the full wire surface: kind (stopLimit/twap), optional
      // attached TP/SL legs (normalTpsl grouping server-side), reduce-only.
      const tpPx = Number((document.getElementById('hlTpPrice') as HTMLInputElement | null)?.value ?? '0') || 0;
      const slPx = Number((document.getElementById('hlSlPrice') as HTMLInputElement | null)?.value ?? '0') || 0;
      return nexaApi.markets.hyperliquid.placeOrder(
        {
          coin: activeHlMarket!.coin,
          sideLong: hlSide === 'long',
          qtyUsd: qty,
          leverage: lev,
          ...(hlOrderType === 'stop'
            ? { kind: 'stopLimit' as const, triggerPriceUsd: triggerPx, stopKind, limitPriceUsd: limitPx, tif }
            : hlOrderType === 'twap'
              ? { kind: 'twap' as const, durationMinutes: twapMinutes, randomize: hlTwapRandomize }
              : {
                  orderType,
                  tif,
                  ...(hlOrderType === 'limit' ? { limitPriceUsd: limitPx } : {}),
                }),
          ...(hlReduceOnly ? { reduceOnly: true } : {}),
          ...(hlOrderType !== 'twap' && tpPx > 0 ? { takeProfit: { triggerPriceUsd: tpPx } } : {}),
          ...(hlOrderType !== 'twap' && slPx > 0 ? { stopLoss: { triggerPriceUsd: slPx } } : {}),
        },
        optsHeader,
      );
    };

    const r = await placeOnce();

    // Display ticker — strip "xyz:" prefix and @N for the human readout.
    const displayCoin = hlMarketSymbol(activeHlMarket);
    const actionLabel = isSpot
      ? (hlSide === 'long' ? 'Bought' : 'Sold')
      : (hlSide === 'long' ? 'Long' : 'Short');
    const levSuffix = isSpot ? '' : ` @ ${lev}×`;
    const stateLabel =
      r.order.state === 'resting'
        ? `Resting at ${money(limitPx)}`
        : r.order.state === 'triggered'
          ? `Armed · triggers at ${money(triggerPx)}`
          : r.order.state === 'twap_active'
            ? `TWAP running · ${twapMinutes}m`
            : 'Order placed';
    toast(`${stateLabel} · ${actionLabel} ${displayCoin} $${qty}${levSuffix}${r.order.demo ? ' · DEMO' : ''}`);
    hlOrderAttempt = null;
    ($('#hlOrderSheet') as HTMLElement).classList.remove('on');
    syncScrollLock();
  } catch (e) {
    rateLimitLockMs = orderSubmitRateLimitMs(e);
    const code = e instanceof ApiFailure ? e.code : 'order_failed';
    if (rateLimitLockMs !== null) toast(`Rate limited. Retry in ${Math.ceil(rateLimitLockMs / 1000)}s.`, 'err');
    else if (code === 'region_blocked') toast('Trading is not available in your region.', 'err');
    else if (code === 'trading_wallet_unavailable') toast('Live trading needs a Privy wallet. Sign out and back in to provision one.', 'err');
    else if (code === 'builder_approval_failed' || code === 'builder_approval_rejected') toast('Builder fee agreement could not be completed. Try again.', 'err');
    else if (e instanceof ApiFailure && /insufficient|margin/i.test(`${e.code} ${e.message}`)) {
      // The venue (or the backend's auto spot→perp sweep) couldn't cover the
      // margin — hand the user the class-transfer sheet instead of a dead end.
      toast('Not enough balance on this venue.', 'err', 'MOVE FUNDS', () =>
        openHlClassSheet({ toPerp: true, prefillUsd: qty }),
      );
    }
    else toast(e instanceof ApiFailure ? e.message : 'Could not place order.', 'err');
    if (shouldResetMarketOrderAttempt(e)) hlOrderAttempt = null;
  } finally {
    if (rateLimitLockMs !== null) lockSubmitButtonForRateLimit(btn, 'Place order', rateLimitLockMs);
    else {
      btn.disabled = false;
      btn.textContent = 'Place order';
    }
  }
});

/* ── Sprint 16 — Polymarket trade sheet ────────────────────────────────── */
let activePmMarket: PmMarket | null = null;
let activePmOutcome: PmOutcome | null = null;
let pmOutcome = 'YES';

function compactOutcomeLabel(label: string): string {
  const upper = label.trim().toUpperCase();
  return upper.length > 14 ? `${upper.slice(0, 12)}...` : upper;
}

function setPmOutcome(outcome: PmOutcome | null): void {
  activePmOutcome = outcome;
  pmOutcome = outcome?.label ?? 'YES';
  const priceCents = Math.min(99, Math.max(1, Math.round(outcome?.pricePct ?? 50)));
  const priceInput = document.getElementById('pmPrice') as HTMLInputElement | null;
  if (priceInput) priceInput.value = String(priceCents);
  const priceEl = document.getElementById('pmOrderPrice');
  if (priceEl) priceEl.textContent = `${pmOutcome.toUpperCase()} ${priceCents}%`;
  $$('[data-pmoutcome]').forEach((b) => {
    const label = (b.getAttribute('data-pmoutcome') ?? '').toLowerCase();
    const selected = label === pmOutcome.toLowerCase();
    b.classList.toggle('on', selected);
    b.setAttribute('aria-selected', String(selected));
  });
  // Flip sheet accent (green YES / red NO) and update CTA copy.
  const sheetRoot = document.querySelector<HTMLElement>('#pmOrderSheet .trade-sheet');
  if (sheetRoot) sheetRoot.dataset['side'] = /^no\b/i.test(pmOutcome) ? 'short' : 'long';
  const cta = document.getElementById('pmPlaceOrderBtn') as HTMLButtonElement | null;
  if (cta && !cta.dataset['lockedLabel']) cta.textContent = `Buy ${pmOutcome.toUpperCase()}`;
  syncPmPayout();
}

function renderPmOutcomeButtons(outcomes: PmOutcome[]): void {
  const host = document.getElementById('pmOutcomeSeg');
  if (!host) return;
  host.textContent = '';
  const visible = outcomes.length ? outcomes.slice(0, 4) : [{ label: 'YES', pricePct: 50 }, { label: 'NO', pricePct: 50 }];
  visible.forEach((outcome, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `side-btn ${/^no\b/i.test(outcome.label) || (visible.length === 2 && idx === 1) ? 'side-short' : 'side-long'}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-pmoutcome', outcome.label);
    btn.title = outcome.label;
    btn.textContent = compactOutcomeLabel(outcome.label);
    on(btn, 'click', () => setPmOutcome(outcome));
    host.appendChild(btn);
  });
}

function openPolymarketOrder(market: PmMarket): void {
  activePmMarket = market;
  // Any open resets copy attribution; the copy flow re-sets it right after.
  pmCopySource = null;
  const sorted = market.outcomes.slice().sort((a, b) => b.pricePct - a.pricePct);
  const top = sorted[0];
  setOrderLogo('pm', market.logoUrl ?? market.imageUrl ?? null, market.question);
  const qEl = document.getElementById('pmOrderQuestion');
  if (qEl) qEl.textContent = market.question;
  const categoryEl = document.getElementById('pmOrderCategory');
  if (categoryEl) categoryEl.textContent = market.category?.trim() || 'Polymarket event';
  renderPmOutcomeButtons(sorted);
  const region = regionFromStorage();
  // Disabled-honest: lock CTA copy when signed out or geo-blocked. Otherwise
  // let setPmOutcome own it so "Buy YES" / "Buy NO" tracks the active side.
  const btn = document.getElementById('pmPlaceOrderBtn') as HTMLButtonElement | null;
  if (btn) {
    delete btn.dataset['lockedLabel'];
    if (!LIVE) {
      btn.disabled = true;
      btn.textContent = 'Sign in to trade';
      btn.dataset['lockedLabel'] = '1';
    } else if (region && isRegionBlocked(region)) {
      btn.disabled = true;
      btn.textContent = 'Read-only in your region';
      btn.dataset['lockedLabel'] = '1';
    } else {
      const gate = venueTradeBlock('predictions');
      if (gate) {
        btn.disabled = true;
        btn.textContent = gate;
        btn.dataset['lockedLabel'] = '1';
      } else {
        btn.disabled = false;
      }
    }
  }
  setPmOutcome(top ?? null);
  // "Open advanced terminal" — deep-link to NEO's prediction detail.
  const neoBtn = document.getElementById('pmOpenNeoTerminal') as HTMLButtonElement | null;
  if (neoBtn) {
    if (NEO_TERMINAL_BASE && market.id) {
      neoBtn.hidden = false;
      neoBtn.onclick = () => openNeoTerminal(`/predictions/${encodeURIComponent(market.id)}`);
    } else {
      neoBtn.hidden = true;
    }
  }
  openOvl('pmOrderSheet');
}

function syncPmPayout(): void {
  const price = Number(($('#pmPrice') as HTMLInputElement)?.value ?? '50') || 50;
  const qty = Number(($('#pmQty') as HTMLInputElement)?.value ?? '0') || 0;
  const lvEl = document.getElementById('pmPriceVal');
  if (lvEl) lvEl.textContent = `${price}¢`;
  const priceEl = document.getElementById('pmOrderPrice');
  if (priceEl) priceEl.textContent = `${pmOutcome.toUpperCase()} ${price}%`;
  const shares = price > 0 ? Math.floor((qty / price) * 100) : 0;
  const sEl = document.getElementById('pmShares');
  if (sEl) sEl.textContent = String(shares);
  const payout = shares; // $1 max payout per share
  const pEl = document.getElementById('pmPayout');
  if (pEl) pEl.textContent = '$' + payout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

on($('#pmPrice'), 'input', syncPmPayout);
on($('#pmQty'), 'input', syncPmPayout);
on($('#pmPlaceOrderBtn'), 'click', async () => {
  if (!activePmMarket) return;
  if (!LIVE) {
    toast('Sign in to trade Polymarket.', 'err');
    return;
  }
  const price = Number(($('#pmPrice') as HTMLInputElement).value) || 0;
  const qty = Number(($('#pmQty') as HTMLInputElement).value) || 0;
  if (!(qty > 0)) {
    toast('Enter a size above $0.', 'err');
    return;
  }
  if (!(price > 0 && price < 100)) {
    toast('Price must be between 1¢ and 99¢.', 'err');
    return;
  }
  const btn = $('#pmPlaceOrderBtn') as HTMLButtonElement;
  btn.disabled = true;
  let rateLimitLockMs: number | null = null;
  btn.textContent = 'Placing…';
  try {
    const region = regionFromStorage();
    const selected = activePmOutcome ?? activePmMarket.outcomes.find((o) => o.label.toLowerCase() === pmOutcome.toLowerCase()) ?? null;
    const outcomeLabel = selected?.label ?? pmOutcome;
    const orderMarketId = activePmMarket.id;
    const fingerprint = JSON.stringify({
      venue: 'polymarket',
      marketId: orderMarketId,
      outcome: outcomeLabel,
      price,
      qty,
      region,
      copiedFrom: pmCopySource,
    });
    pmOrderAttempt = idempotencyKeyFor(pmOrderAttempt, fingerprint);
    const idempotencyKey = pmOrderAttempt.idempotencyKey;
    const r = await nexaApi.markets.polymarket.placeOrder(
      {
        marketId: orderMarketId,
        outcome: outcomeLabel,
        priceCents: price,
        qtyUsd: qty,
        ...(pmCopySource ? { copiedFrom: pmCopySource } : {}),
      },
      { ...(region && region !== '??' ? { region } : {}), idempotencyKey },
    );
    toast(`Order placed · ${pmOutcome} ${price}¢ × $${qty} ${r.order.demo ? '· DEMO' : ''}`);
    pmOrderAttempt = null;
    pmCopySource = null;
    ($('#pmOrderSheet') as HTMLElement).classList.remove('on');
    syncScrollLock();
  } catch (e) {
    rateLimitLockMs = orderSubmitRateLimitMs(e);
    const code = e instanceof ApiFailure ? e.code : 'order_failed';
    if (rateLimitLockMs !== null) toast(`Rate limited. Retry in ${Math.ceil(rateLimitLockMs / 1000)}s.`, 'err');
    else if (code === 'region_blocked') toast('Trading is not available in your region.', 'err');
    else if (code === 'wallet_unavailable' || code === 'live_trading_wallet_required' || code === 'trading_wallet_unavailable') toast('Live trading needs a Privy wallet — coming soon.', 'err');
    else toast(e instanceof ApiFailure ? e.message : 'Could not place order.', 'err');
    if (shouldResetMarketOrderAttempt(e)) pmOrderAttempt = null;
  } finally {
    if (rateLimitLockMs !== null) lockSubmitButtonForRateLimit(btn, 'Place order', rateLimitLockMs);
    else {
      btn.disabled = false;
      btn.textContent = 'Place order';
    }
  }
});

/* ── Sprint 21 — Jupiter swap sheet (memes + xStock spot share this) ──────
 *
 * Trades non-custodially via the user's Privy Solana wallet. Two-step UX:
 *   1) Debounced /markets/jupiter/quote on amount change → preview output
 *   2) Submit /markets/jupiter/swap → Privy signs, backend broadcasts
 * The sheet is mint-agnostic — same code drives meme buys, meme sells, and
 * xStock spot buys. Side toggle flips input/output mints.
 */

const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface JupSwapToken {
  mint: string;
  symbol: string;
  name?: string | null;
  logoUrl?: string | null;
  priceUsd?: number | null;
  change24hPct?: number | null;
  decimals?: number | null;
}

interface JupQuoteRequest {
  tokenMint: string;
  side: 'buy' | 'sell';
  qtyUsd: number;
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  slippageBps: number;
  outputDecimals: number;
}

interface JupQuoteWire {
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: Array<{ swapInfo: { ammKey: string; label: string } }>;
  slippageBps: number;
}

let activeJupToken: JupSwapToken | null = null;
let jupSide: 'buy' | 'sell' = 'buy';
let jupSlippageBps = 50;
let jupQuoteSeq = 0;
let jupQuoteTimer: ReturnType<typeof setTimeout> | null = null;
let jupLatestQuote: (JupQuoteWire & { fingerprint: JupQuoteRequest }) | null = null;
let jupSwapAttempt: { fingerprint: string; idempotencyKey: string } | null = null;
let jupQuoteCooldownUntil = 0;

function jupTokenDecimals(token: JupSwapToken): number {
  const d = token.decimals;
  return Number.isInteger(d) && d != null && d >= 0 && d <= 12 ? d : 6;
}

function decimalToAtomic(value: number, decimals: number): string {
  if (!Number.isFinite(value) || !(value > 0)) return '0';
  const fixed = value.toFixed(decimals);
  const [whole = '0', frac = ''] = fixed.split('.');
  const scale = 10n ** BigInt(decimals);
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * scale + BigInt(fracPadded || '0')).toString();
}

function buildJupQuoteRequest(): JupQuoteRequest | null {
  if (!activeJupToken) return null;
  const qtyUsd = Number(($('#jupQty') as HTMLInputElement)?.value ?? '0') || 0;
  if (!(qtyUsd > 0)) return null;
  const inputMint = jupSide === 'buy' ? SOLANA_USDC_MINT : activeJupToken.mint;
  const outputMint = jupSide === 'buy' ? activeJupToken.mint : SOLANA_USDC_MINT;
  const inputDecimals = jupSide === 'buy' ? 6 : jupTokenDecimals(activeJupToken);
  const outputDecimals = jupSide === 'buy' ? jupTokenDecimals(activeJupToken) : 6;
  const tokenAmount = jupSide === 'buy'
    ? qtyUsd
    : (() => {
        const px = activeJupToken!.priceUsd ?? 0;
        return px > 0 ? qtyUsd / px : 0;
      })();
  const amountAtomic = decimalToAtomic(tokenAmount, inputDecimals);
  if (amountAtomic === '0') return null;
  return {
    tokenMint: activeJupToken.mint,
    side: jupSide,
    qtyUsd,
    inputMint,
    outputMint,
    amountAtomic,
    slippageBps: jupSlippageBps,
    outputDecimals,
  };
}

function sameJupQuoteRequest(a: JupQuoteRequest, b: JupQuoteRequest): boolean {
  return a.tokenMint === b.tokenMint
    && a.side === b.side
    && a.inputMint === b.inputMint
    && a.outputMint === b.outputMint
    && a.amountAtomic === b.amountAtomic
    && a.slippageBps === b.slippageBps
    && a.outputDecimals === b.outputDecimals;
}

function jupQuotePayload(q: JupQuoteWire): JupQuoteWire {
  return {
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    priceImpactPct: q.priceImpactPct,
    routePlan: q.routePlan,
    slippageBps: q.slippageBps,
  };
}

function jupSwapButtonLabel(): string {
  return `${jupSide === 'buy' ? 'Buy' : 'Sell'} ${activeJupToken?.symbol ?? ''}`.trim() || 'Swap';
}

function setJupRouteable(routeable: boolean): void {
  const cta = document.getElementById('jupPlaceSwapBtn') as HTMLButtonElement | null;
  if (!cta || cta.dataset['lockedLabel']) return;
  cta.disabled = !routeable;
  cta.textContent = routeable ? jupSwapButtonLabel() : 'No route available';
}

function setJupSide(side: 'buy' | 'sell'): void {
  jupSide = side;
  $$('[data-jupside]').forEach((b) => {
    const on = b.getAttribute('data-jupside') === side;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  const sheetRoot = document.querySelector<HTMLElement>('#jupSwapSheet .trade-sheet');
  if (sheetRoot) sheetRoot.dataset['side'] = side === 'buy' ? 'long' : 'short';
  const cta = document.getElementById('jupPlaceSwapBtn') as HTMLButtonElement | null;
  if (cta && !cta.dataset['lockedLabel']) {
    cta.textContent = jupSwapButtonLabel();
  }
  scheduleJupQuote();
}

function openJupiterSwap(token: JupSwapToken): void {
  activeJupToken = token;
  jupSide = 'buy';
  jupLatestQuote = null;
  setOrderLogo('jup', token.logoUrl ?? null, token.symbol ?? token.name ?? '');
  const symEl = document.getElementById('jupOrderSym');
  if (symEl) symEl.textContent = token.symbol || token.name || 'TOKEN';
  const priceEl = document.getElementById('jupOrderPrice');
  if (priceEl) priceEl.textContent = token.priceUsd != null ? formatMarketPrice(token.priceUsd) : '—';
  const chgEl = document.getElementById('jupOrderChange');
  if (chgEl) {
    if (token.change24hPct == null) {
      chgEl.textContent = '24h n/a';
      chgEl.classList.remove('down');
    } else {
      chgEl.textContent = `${token.change24hPct >= 0 ? '+' : ''}${token.change24hPct.toFixed(2)}%`;
      chgEl.classList.toggle('down', token.change24hPct < 0);
    }
  }
  // Reset receive / impact / route until a fresh quote lands.
  const recv = document.getElementById('jupReceiveOut'); if (recv) recv.textContent = '—';
  const imp  = document.getElementById('jupPriceImpact'); if (imp) imp.textContent = '—';
  const route = document.getElementById('jupRouteLabel'); if (route) route.textContent = '—';
  const cta = document.getElementById('jupPlaceSwapBtn') as HTMLButtonElement | null;
  const region = regionFromStorage();
  if (cta) {
    delete cta.dataset['lockedLabel'];
    if (!LIVE) {
      cta.disabled = true;
      cta.textContent = 'Sign in to swap';
      cta.dataset['lockedLabel'] = '1';
    } else if (region && isRegionBlocked(region)) {
      cta.disabled = true;
      cta.textContent = 'Read-only in your region';
      cta.dataset['lockedLabel'] = '1';
    } else {
      const gate = venueTradeBlock('memes');
      if (gate) {
        cta.disabled = true;
        cta.textContent = gate;
        cta.dataset['lockedLabel'] = '1';
      } else {
        cta.disabled = false;
      }
    }
  }
  setJupSide('buy');
  openOvl('jupSwapSheet');
  scheduleJupQuote();
}

/* Debounced quote — 350ms after the last keystroke matches the user's
   typing cadence without spamming Jupiter's API. Stale-response guard:
   each request bumps a sequence number; only the latest response paints. */
function scheduleJupQuote(): void {
  jupLatestQuote = null;
  jupSwapAttempt = null;
  if (jupQuoteTimer) clearTimeout(jupQuoteTimer);
  jupQuoteTimer = setTimeout(() => { void runJupQuote(); }, 350);
}

async function runJupQuote(): Promise<void> {
  if (!activeJupToken) return;
  const recv = document.getElementById('jupReceiveOut');
  const imp  = document.getElementById('jupPriceImpact');
  const route = document.getElementById('jupRouteLabel');
  const quoteReq = buildJupQuoteRequest();
  if (!quoteReq) {
    if (recv) recv.textContent = '—';
    if (imp) imp.textContent = '—';
    if (route) route.textContent = '—';
    jupLatestQuote = null;
    setJupRouteable(false);
    return;
  }
  const now = Date.now();
  if (now < jupQuoteCooldownUntil) {
    const seconds = Math.ceil((jupQuoteCooldownUntil - now) / 1000);
    if (recv) recv.textContent = `Rate limited. Retry in ${seconds}s.`;
    return;
  }
  const seq = ++jupQuoteSeq;
  try {
    const r = await nexaApi.markets.jupiter.quote({
      inputMint: quoteReq.inputMint,
      outputMint: quoteReq.outputMint,
      amountAtomic: quoteReq.amountAtomic,
      slippageBps: quoteReq.slippageBps,
    });
    if (seq !== jupQuoteSeq) return;       // a newer quote landed first
    jupLatestQuote = { ...r.quote, fingerprint: quoteReq };
    const outNum = Number(r.quote.outAmount) / (10 ** quoteReq.outputDecimals);
    const outSym = jupSide === 'buy' ? (activeJupToken?.symbol ?? 'TOKEN') : 'USDC';
    if (recv) recv.textContent = `${outNum.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${outSym}`;
    if (imp) {
      const p = r.quote.priceImpactPct;
      imp.textContent = `${(p * 100).toFixed(3)}%`;
      imp.classList.toggle('warn', p > 0.01);
    }
    if (route) {
      const labels = r.quote.routePlan.map((step) => step.swapInfo?.label).filter(Boolean);
      route.textContent = labels.length ? labels.join(' → ') : 'Jupiter aggregator';
    }
    setJupRouteable(true);
  } catch (e) {
    if (seq !== jupQuoteSeq) return;
    jupLatestQuote = null;
    if (e instanceof ApiFailure && e.status === 429) {
      const retryMs = e.retryAfterMs ?? 30_000;
      jupQuoteCooldownUntil = Date.now() + retryMs;
      if (recv) recv.textContent = `Rate limited. Retry in ${Math.ceil(retryMs / 1000)}s.`;
    } else if (e instanceof ApiFailure && e.code === 'quote_unavailable') {
      if (recv) recv.textContent = 'No Jupiter route for this pair.';
      if (imp) imp.textContent = '—';
      if (route) route.textContent = 'No route';
      setJupRouteable(false);
    } else if (recv) recv.textContent = 'Quote unavailable';
  }
}

on($('#jupQty'), 'input', () => scheduleJupQuote());
on($('#jupSlippage'), 'input', () => {
  const v = Number(($('#jupSlippage') as HTMLInputElement).value) || 50;
  jupSlippageBps = Math.max(10, Math.min(300, v));
  const lbl = document.getElementById('jupSlippageVal');
  if (lbl) lbl.textContent = `${jupSlippageBps} bps`;
  scheduleJupQuote();
});
$$('[data-jupside]').forEach((b) => {
  on(b, 'click', () => setJupSide((b.getAttribute('data-jupside') as 'buy' | 'sell') ?? 'buy'));
});

on($('#jupPlaceSwapBtn'), 'click', async () => {
  if (!activeJupToken) return;
  if (!LIVE) {
    toast('Sign in to swap on Solana.', 'err');
    return;
  }
  const qtyUsd = Number(($('#jupQty') as HTMLInputElement).value) || 0;
  if (!(qtyUsd > 0)) {
    toast('Enter a size above $0.', 'err');
    return;
  }
  let quoteReq = buildJupQuoteRequest();
  if (!quoteReq) {
    toast('Could not build a quote for that size.', 'err');
    return;
  }
  if (!jupLatestQuote || !sameJupQuoteRequest(jupLatestQuote.fingerprint, quoteReq)) {
    // No quote yet — force one synchronously and bail if it still doesn't land.
    await runJupQuote();
    quoteReq = buildJupQuoteRequest();
    if (!jupLatestQuote || !quoteReq || !sameJupQuoteRequest(jupLatestQuote.fingerprint, quoteReq)) {
      toast('Could not fetch a quote — try again.', 'err');
      return;
    }
  }
  const cta = $('#jupPlaceSwapBtn') as HTMLButtonElement;
  cta.disabled = true;
  let rateLimitLockMs: number | null = null;
  cta.textContent = 'Swapping…';
  try {
    const region = regionFromStorage();
    const fingerprint = JSON.stringify({
      venue: 'jupiter',
      inputMint: quoteReq.inputMint,
      outputMint: quoteReq.outputMint,
      amountAtomic: quoteReq.amountAtomic,
      qtyUsd,
      slippageBps: quoteReq.slippageBps,
      region,
    });
    jupSwapAttempt = idempotencyKeyFor(jupSwapAttempt, fingerprint);
    const idempotencyKey = jupSwapAttempt.idempotencyKey;
    const r = await nexaApi.markets.jupiter.swap(
      {
        inputMint: quoteReq.inputMint,
        outputMint: quoteReq.outputMint,
        amountAtomic: jupLatestQuote.inAmount,
        slippageBps: quoteReq.slippageBps,
        quote: jupQuotePayload(jupLatestQuote),
      },
      { ...(region && region !== '??' ? { region } : {}), idempotencyKey },
    );
    toast(`${jupSide === 'buy' ? 'Bought' : 'Sold'} ${activeJupToken.symbol} · $${qtyUsd}${r.order.demo ? ' · DEMO' : ''}`);
    jupSwapAttempt = null;
    ($('#jupSwapSheet') as HTMLElement).classList.remove('on');
    syncScrollLock();
  } catch (e) {
    rateLimitLockMs = orderSubmitRateLimitMs(e);
    const code = e instanceof ApiFailure ? e.code : 'swap_failed';
    if (rateLimitLockMs !== null) toast(`Rate limited. Retry in ${Math.ceil(rateLimitLockMs / 1000)}s.`, 'err');
    else if (code === 'region_blocked') toast('Trading is not available in your region.', 'err');
    else if (
      code === 'wallet_unavailable'
      || code === 'live_trading_wallet_required'
      || code === 'solana_wallet_unavailable'
      || code === 'trading_wallet_unavailable'
    ) {
      toast('Solana wallet not ready — sign out and back in to provision one.', 'err');
    }
    else toast(e instanceof ApiFailure ? e.message : 'Could not place swap.', 'err');
    if (shouldResetMarketOrderAttempt(e)) jupSwapAttempt = null;
  } finally {
    const label = `${jupSide === 'buy' ? 'Buy' : 'Sell'} ${activeJupToken?.symbol ?? ''}`.trim() || 'Swap';
    if (rateLimitLockMs !== null) lockSubmitButtonForRateLimit(cta, label, rateLimitLockMs);
    else {
      cta.disabled = false;
      cta.textContent = label;
    }
  }
});

const MARKET_HYDRATE_TTL_MS = 20_000;
const MARKET_HYDRATE_FAILURE_COOLDOWN_MS = 5_000;
let hydrateMarketsInflight: Promise<void> | null = null;
let marketsHydratedAt = 0;
let marketsHydrateCooldownUntil = 0;

class MarketRefreshCooldownError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`market_refresh_cooldown:${retryAfterMs}`);
    this.name = 'MarketRefreshCooldownError';
    this.retryAfterMs = retryAfterMs;
  }
}

function hasAnyMarketCache(): boolean {
  return Object.values(marketsCache).some(Boolean);
}

function marketHydrateBackoffMs(results: PromiseSettledResult<unknown>[]): number {
  let wait = 0;
  let failures = 0;
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    failures += 1;
    const reason = r.reason;
    if (reason instanceof ApiFailure && reason.status === 429) {
      wait = Math.max(wait, rateLimitBackoffMs(reason, MARKET_HYDRATE_TTL_MS));
    } else if (reason instanceof Error && /_429$/.test(reason.message)) {
      wait = Math.max(wait, MARKET_HYDRATE_TTL_MS);
    }
  }
  if (failures === results.length && results.length > 0 && wait === 0) {
    wait = MARKET_HYDRATE_FAILURE_COOLDOWN_MS;
  }
  return wait;
}

function hydrateMarkets(opts: { force?: boolean } = {}): Promise<void> {
  if (hydrateMarketsInflight) return hydrateMarketsInflight;
  const now = Date.now();
  if (now < marketsHydrateCooldownUntil) {
    renderActiveTradeTab();
    if (opts.force) {
      return Promise.reject(new MarketRefreshCooldownError(marketsHydrateCooldownUntil - now));
    }
    return Promise.resolve();
  }
  if (!opts.force && hasAnyMarketCache() && now - marketsHydratedAt < MARKET_HYDRATE_TTL_MS) {
    renderActiveTradeTab();
    return Promise.resolve();
  }
  hydrateMarketsInflight = hydrateMarketsImpl().finally(() => {
    hydrateMarketsInflight = null;
  });
  // PLANB W1: with nothing cached yet, repaint now so first-load lists show
  // skeleton rows for the duration of the fetch instead of sitting empty.
  if (!hasAnyMarketCache()) renderActiveTradeTab();
  return hydrateMarketsInflight;
}

/* Cached results so swapping between Perps/Spot/Memes/Predictions tabs is
   instant and a single refresh hits every source in parallel. Memes pulls
   from two sources: HL spot (HL-native memecoins) and Jupiter (Solana SPL
   memes — pump.fun graduates, etc.). */
interface JupListToken {
  mint: string;
  symbol: string;
  name: string;
  logoUrl?: string | null;
  priceUsd: number | null;
  change24hPct: number | null;
  decimals?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
}

interface XStockToken {
  mint: string;
  ticker: string;
  name?: string | null;
  category?: string;
  icon?: string | null;
  priceUsd: number;
  change24hPct: number | null;
  decimals?: number | null;
}

const marketsCache: {
  perps: HlMarket[] | null;
  spot: HlMarket[] | null;
  predictions: PmEvent[] | null;
  jupMemes: JupListToken[] | null;
  stocksPerp: HlMarket[] | null;   // HIP-3 markets, shape-compatible with HlMarket
  xstocks: XStockToken[] | null;   // Backed xStocks (Solana SPL Token-2022)
  cards: CollectorCardWire[] | null;
  cardsPositions: CollectorCardWire[] | null;
} = {
  perps: null,
  spot: null,
  predictions: null,
  jupMemes: null,
  stocksPerp: null,
  xstocks: null,
  cards: null,
  cardsPositions: null,
};
type MarketCacheKey = keyof typeof marketsCache;
const marketSourceStatus: Record<MarketCacheKey, MarketSourceKind> = {
  perps: 'unavailable',
  spot: 'unavailable',
  predictions: 'unavailable',
  jupMemes: 'unavailable',
  stocksPerp: 'unavailable',
  xstocks: 'unavailable',
  cards: 'unavailable',
  cardsPositions: 'unavailable',
};

let activePmCategory = ''; // empty = "All"
let predictionsCacheCategory = '';
let pmCategoryInflight: Promise<void> | null = null;
let pmCategoryPending = false;
let pmCategoryCooldownUntil = 0;

function cachedPredictionsForCategory(slug: string): PmEvent[] | null {
  return predictionsCacheCategory === slug ? marketsCache.predictions : null;
}

function renderPmCategoryLoading(): void {
  const host = document.getElementById('pmMarketsList');
  if (!host) return;
  paintListSkeleton(host, 'pm-card', 3);
}

function hydratePmCategory(slug: string): Promise<void> {
  if (pmCategoryInflight) {
    pmCategoryPending = true;
    return pmCategoryInflight;
  }
  pmCategoryInflight = hydratePmCategoryImpl(slug).finally(() => {
    pmCategoryInflight = null;
    if (pmCategoryPending && activePmCategory !== slug) {
      pmCategoryPending = false;
      void hydratePmCategory(activePmCategory);
      return;
    }
    pmCategoryPending = false;
  });
  return pmCategoryInflight;
}

async function hydratePmCategoryImpl(slug: string): Promise<void> {
  const now = Date.now();
  if (now < marketsHydrateCooldownUntil || now < pmCategoryCooldownUntil) {
    marketSourceStatus.predictions = 'unavailable';
    renderPmEvents(cachedPredictionsForCategory(slug) ?? [], 'unavailable');
    return;
  }
  renderPmCategoryLoading();
  try {
    const events = await fetchPolymarketEvents(slug);
    if (activePmCategory !== slug) return;
    marketsCache.predictions = events;
    predictionsCacheCategory = slug;
    marketSourceStatus.predictions = 'live';
    pmCategoryCooldownUntil = 0;
    marketsHydratedAt = Date.now();
    renderPmEvents(events, 'live');
  } catch (e) {
    const backoff = marketHydrateBackoffMs([{ status: 'rejected', reason: e }]);
    if (backoff > 0) {
      const until = Date.now() + backoff;
      pmCategoryCooldownUntil = until;
      marketsHydrateCooldownUntil = Math.max(marketsHydrateCooldownUntil, until);
    }
    if (activePmCategory !== slug) return;
    marketSourceStatus.predictions = 'unavailable';
    renderPmEvents(cachedPredictionsForCategory(slug) ?? [], 'unavailable');
  }
}

function renderJupMemes(tokens: JupListToken[], status: 'live' | 'unavailable' = 'live'): void {
  const host = document.getElementById('jupMemesMarketsList');
  if (!host) return;
  purgeMarketRowsFromHost('jupMemesMarketsList', '.lrow', 'data-jup-mint', jupPriceRowsByMint);
  host.textContent = '';
  if (!tokens.length) {
    if (hydrateMarketsInflight || marketsHydratedAt === 0) {
      paintListSkeleton(host, 'lrow');
      return;
    }
    const empty = document.createElement('div');
    empty.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = status === 'unavailable' ? "Couldn't load Solana memes." : 'No Solana memes available.';
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = status === 'unavailable' ? 'Provider unavailable or rate limited' : 'Live feed empty';
    grow.appendChild(s);
    empty.appendChild(grow);
    host.appendChild(empty);
    return;
  }
  if (status === 'unavailable') {
    emptyMarketRow(host, "Couldn't load latest Solana memes.", 'Showing cached rows');
  }
  const shownMemes = marketListLimit('jupMemesMarketsList', MARKET_LIST_PAGE);
  for (const t of tokens.slice(0, shownMemes)) {
    const row = document.createElement('div');
    row.className = 'lrow cards-row';
    row.style.cursor = 'pointer';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.appendChild(marketThumbEl(t.symbol || t.name || '?', t.logoUrl));
    const grow = document.createElement('span');
    grow.className = 'grow';
    const title = document.createElement('span');
    title.className = 't';
    title.style.fontWeight = '600';
    title.textContent = t.symbol || t.name || '—';
    grow.appendChild(title);
    grow.appendChild(document.createElement('br'));
    const sub = document.createElement('span');
    sub.className = 's';
    const mcap = t.marketCapUsd ? ` · ${formatCompactUsd(t.marketCapUsd)} mcap` : '';
    sub.textContent = `SOLANA · ${t.name ?? ''}${mcap}`;
    grow.appendChild(sub);
    row.appendChild(grow);
    const num = document.createElement('span');
    num.className = 'num';
    num.style.fontVariantNumeric = 'tabular-nums';
    num.textContent = t.priceUsd != null ? formatMarketPrice(t.priceUsd) : '—';
    row.setAttribute('data-jup-mint', t.mint);
    row.appendChild(num);
    addMarketRow(jupPriceRowsByMint, t.mint, row);
    if (t.change24hPct != null) {
      const chg = document.createElement('span');
      chg.className = 'tag ' + (t.change24hPct >= 0 ? 'ok' : 'warnx');
      chg.style.marginLeft = '8px';
      chg.textContent = `${t.change24hPct >= 0 ? '+' : ''}${t.change24hPct.toFixed(2)}%`;
      row.appendChild(chg);
    }
    on(row, 'click', () => openJupiterSwap({
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      logoUrl: t.logoUrl ?? null,
      priceUsd: t.priceUsd,
      change24hPct: t.change24hPct,
      decimals: t.decimals ?? null,
    }));
    host.appendChild(row);
  }
  if (tokens.length > shownMemes) {
    appendShowAllRow(host, 'jupMemesMarketsList', tokens.length, 'memes', () =>
      renderJupMemes(tokens, status),
    );
  }
}

async function fetchJupiterMemes(): Promise<JupListToken[]> {
  const r = await nexaApi.markets.jupiter.list({ tag: 'meme', limit: 100 });
  return r.tokens.map((t) => ({
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    logoUrl: t.imageUrl ?? null,        // backend uses `imageUrl`
    priceUsd: t.priceUsd,
    change24hPct: t.priceChange24h,     // backend uses `priceChange24h`
    decimals: t.decimals ?? null,
    marketCapUsd: t.marketCapUsd ?? null,
    liquidityUsd: t.liquidityUsd ?? null,
  }));
}

async function fetchStocksPerps(): Promise<HlMarket[]> {
  // HIP-3 stocks via trade.xyz. Backend `/markets/stocks/perps` returns
  // shape-compatible rows so they slot into the existing HlMarket pipeline
  // (chart, order sheet, builder fee path) without per-venue branching.
  // Backend exposes coin (xyz:TICKER) but no `name` field — HlMarket falls
  // back to ticker for display in that case.
  const r = await nexaApi.markets.stocks.perps();
  return r.markets.map((m) => ({
    coin: m.coin,                  // "xyz:TSLA"
    displaySymbol: m.ticker,
    venueKind: 'hyperliquid-hip3' as const,
    name: m.ticker,                // perps row has no separate `name`; reuse ticker
    priceUsd: m.priceUsd,
    change24hPct: m.change24hPct,
    maxLeverage: m.maxLeverage ?? null,
    volume24hUsd: m.dayVolumeUsd ?? null,
    openInterestUsd: m.openInterest ?? null,
    fundingRatePct: m.fundingRate != null ? m.fundingRate * 100 : null,
  }));
}

async function fetchXStocks(): Promise<XStockToken[]> {
  // Backend wraps xStock rows under `stocks:` and names the 24h delta
  // `priceChange24h`. Re-key into XStockToken so the renderer can stay
  // generic across Solana SPL surfaces (memes + xStocks).
  const r = await nexaApi.markets.stocks.spot();
  return r.stocks.map((m): XStockToken => ({
    mint: m.mint,
    ticker: m.ticker,
    name: m.name ?? null,
    ...(m.category ? { category: m.category } : {}),
    icon: m.icon ?? null,
    priceUsd: m.priceUsd,
    change24hPct: m.priceChange24h,
    decimals: m.decimals ?? null,
  }));
}

function renderXStocks(tokens: XStockToken[], status: 'live' | 'unavailable' = 'live'): void {
  const host = document.getElementById('xStocksSpotMarketsList');
  if (!host) return;
  purgeMarketRowsFromHost('xStocksSpotMarketsList', '.lrow', 'data-jup-mint', jupPriceRowsByMint);
  host.textContent = '';
  if (!tokens.length) {
    if (hydrateMarketsInflight || marketsHydratedAt === 0) {
      paintListSkeleton(host, 'lrow');
      return;
    }
    const empty = document.createElement('div');
    empty.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = status === 'unavailable' ? "Couldn't load xStocks." : 'No xStocks available.';
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = status === 'unavailable' ? 'Provider unavailable or rate limited' : 'Live feed empty';
    grow.appendChild(s);
    empty.appendChild(grow);
    host.appendChild(empty);
    return;
  }
  if (status === 'unavailable') {
    emptyMarketRow(host, "Couldn't load latest xStocks.", 'Showing cached rows');
  }
  const shownStocks = marketListLimit('xStocksSpotMarketsList', MARKET_LIST_PAGE);
  for (const t of tokens.slice(0, shownStocks)) {
    const row = document.createElement('div');
    row.className = 'lrow cards-row';
    row.style.cursor = 'pointer';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.appendChild(marketThumbEl(t.ticker, t.icon));
    const grow = document.createElement('span');
    grow.className = 'grow';
    const title = document.createElement('span');
    title.className = 't';
    title.style.fontWeight = '600';
    title.textContent = t.ticker;
    grow.appendChild(title);
    grow.appendChild(document.createElement('br'));
    const sub = document.createElement('span');
    sub.className = 's';
    const cat = t.category ? ` · ${t.category.toUpperCase()}` : '';
    sub.textContent = `SOLANA · ${t.name ?? ''}${cat}`;
    grow.appendChild(sub);
    row.appendChild(grow);
    const num = document.createElement('span');
    num.className = 'num';
    num.style.fontVariantNumeric = 'tabular-nums';
    num.textContent = formatMarketPrice(t.priceUsd);
    row.setAttribute('data-jup-mint', t.mint);
    row.appendChild(num);
    if (t.change24hPct != null) {
    const chg = document.createElement('span');
      chg.className = 'tag ' + (t.change24hPct >= 0 ? 'ok' : 'warnx');
      chg.style.marginLeft = '8px';
      chg.textContent = `${t.change24hPct >= 0 ? '+' : ''}${t.change24hPct.toFixed(2)}%`;
      row.appendChild(chg);
    }
    addMarketRow(jupPriceRowsByMint, t.mint, row);
    on(row, 'click', () => openJupiterSwap({
      mint: t.mint,
      symbol: t.ticker,
      name: t.name ?? t.ticker,
      logoUrl: t.icon ?? null,
      priceUsd: t.priceUsd,
      change24hPct: t.change24hPct,
      decimals: t.decimals ?? null,
    }));
    host.appendChild(row);
  }
  if (tokens.length > shownStocks) {
    appendShowAllRow(host, 'xStocksSpotMarketsList', tokens.length, 'stocks', () =>
      renderXStocks(tokens, status),
    );
  }
}

/* Collector Crypt collection filter — the backend supports 9 collections
   (All, Pokemon, Pokemon JP, NBA, NFL, Soccer, MTG, F1, UFC); the tab now
   exposes them as pills instead of only ever showing the "recent" slice. */
let activeCardsCollection = 'All';
let cardsCollections: string[] | null = null;

async function fetchCardsMarkets(): Promise<CollectorCardWire[]> {
  const r = await nexaApi.markets.cards.list({
    limit: 60,
    sort: 'recent',
    ...(activeCardsCollection !== 'All' ? { collection: activeCardsCollection } : {}),
  });
  return r.items;
}

function renderCardsCollectionPills(): void {
  const host = document.getElementById('cardsCollectionsRow');
  if (!host || !cardsCollections?.length) return;
  host.hidden = false;
  host.textContent = '';
  for (const col of cardsCollections) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pillbtn' + (col === activeCardsCollection ? ' onx' : '');
    pill.textContent = col.toUpperCase();
    on(pill, 'click', () => {
      void selectCardsCollection(col);
    });
    host.appendChild(pill);
  }
}

async function hydrateCardsCollections(): Promise<void> {
  if (cardsCollections) return;
  try {
    const r = await nexaApi.markets.cards.collections();
    cardsCollections = r.collections;
    renderCardsCollectionPills();
  } catch {
    /* collections chip row is progressive enhancement — list still works */
  }
}

async function selectCardsCollection(col: string): Promise<void> {
  if (col === activeCardsCollection) return;
  activeCardsCollection = col;
  renderCardsCollectionPills();
  marketListShownCount.delete('cardsMarketsList');
  marketListShownCount.delete('cardsScreenList');
  marketsCache.cards = null;
  renderCardsMarkets([], 'live'); // clears to the empty row while loading
  try {
    const cards = await fetchCardsMarkets();
    marketsCache.cards = cards;
    marketSourceStatus.cards = 'live';
  } catch {
    marketSourceStatus.cards = 'unavailable';
  }
  renderCardsMarkets(marketsCache.cards ?? [], marketSourceStatus.cards);
  renderCardsScreen();
}

async function hydrateCardsMarkets(): Promise<CollectorCardWire[]> {
  return fetchCardsMarkets();
}

async function fetchCardsPositions(): Promise<CollectorCardWire[]> {
  if (!getToken()) return [];
  try {
    const r = await nexaApi.markets.cards.positions();
    return r.items;
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 401) return [];
    throw e;
  }
}

function cardPriceLabel(card: CollectorCardWire): string {
  return '$' + card.priceUsdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cardSubLabel(card: CollectorCardWire): string {
  return [card.collection, card.gradeLabel, card.tokenStandard].filter(Boolean).join(' / ');
}

function appendCardRow(
  host: HTMLElement,
  card: CollectorCardWire,
  opts: { owned?: boolean; interactive?: boolean; backTarget?: string } = {},
): void {
  const row = document.createElement('div');
  row.className = 'lrow cards-row';
  if (opts.interactive) {
    row.setAttribute('data-card-id', card.id);
    if (opts.backTarget !== 's33') {
      row.setAttribute('data-go', 's33');
      row.setAttribute('data-cards-back', opts.backTarget ?? 's27');
    }
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.style.cursor = 'pointer';
  }
  // Canonical thumb helper — dead marketplace image URLs (e.g. expired
  // Arweave gateways) degrade to the letter tile instead of a blank square.
  row.appendChild(marketThumbEl(card.name, card.imageUrl));

  const grow = document.createElement('span');
  grow.className = 'grow';
  const title = document.createElement('span');
  title.className = 't';
  title.style.fontWeight = '600';
  title.textContent = card.name;
  grow.appendChild(title);
  grow.appendChild(document.createElement('br'));
  const sub = document.createElement('span');
  sub.className = 's';
  sub.textContent = opts.owned ? `OWNED / ${cardSubLabel(card)}` : cardSubLabel(card);
  grow.appendChild(sub);
  row.appendChild(grow);

  const price = document.createElement('span');
  price.className = 'num';
  price.style.fontVariantNumeric = 'tabular-nums';
  price.textContent = cardPriceLabel(card);
  row.appendChild(price);
  if (opts.interactive) {
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '›';
    row.appendChild(chev);
  }
  host.appendChild(row);
}

function renderCardsMarkets(cards: CollectorCardWire[], status: MarketSourceKind = 'live'): void {
  const host = document.getElementById('cardsMarketsList');
  if (!host) return;
  host.textContent = '';
  if (!cards.length) {
    const scope = activeCardsCollection !== 'All' ? `${activeCardsCollection} cards` : 'cards';
    emptyMarketRow(
      host,
      status === 'unavailable' ? "Couldn't load cards." : `No ${scope} listed right now.`,
      status === 'unavailable' ? 'Collector Crypt unavailable or rate limited' : 'Try another collection',
    );
    void hydrateCardsCollections();
    return;
  }
  if (status === 'unavailable') emptyMarketRow(host, "Couldn't load latest cards.", 'Showing cached rows');
  void hydrateCardsCollections();
  const shownCards = marketListLimit('cardsMarketsList', 24);
  cards.slice(0, shownCards).forEach((card) => appendCardRow(host, card, { interactive: true, backTarget: 's27' }));
  if (cards.length > shownCards) {
    appendShowAllRow(host, 'cardsMarketsList', cards.length, 'cards', () =>
      renderCardsMarkets(cards, status),
    );
  }
}

function renderCardsPositions(cards: CollectorCardWire[], status: MarketSourceKind = 'live'): void {
  const host = document.getElementById('cardsPositionsList');
  const label = document.getElementById('cardsPositionsLabel');
  if (!host || !label) return;
  const show = status === 'live' || status === 'unavailable' || cards.length > 0;
  host.hidden = !show;
  label.hidden = !show;
  host.textContent = '';
  if (!show) return;
  if (!cards.length) {
    emptyMarketRow(
      host,
      status === 'unavailable' ? "Couldn't load cards." : 'No owned cards yet.',
      status === 'unavailable'
        ? 'Collector Crypt unavailable or rate limited'
        : 'Buy flow stays off until wallet is ready',
    );
    return;
  }
  if (status === 'unavailable') emptyMarketRow(host, "Couldn't load latest cards.", 'Showing cached rows');
  cards.slice(0, 12).forEach((card) => appendCardRow(host, card, { owned: true, interactive: true, backTarget: 's27' }));
}

function findCollectorCard(id: string | null): CollectorCardWire | null {
  const cards = [...(marketsCache.cards ?? []), ...(marketsCache.cardsPositions ?? [])];
  if (!cards.length) return null;
  return cards.find((card) => card.id === id || card.nftAddress === id) ?? cards[0] ?? null;
}

function replaceCachedCollectorCard(card: CollectorCardWire): void {
  const replace = (items: CollectorCardWire[] | null): CollectorCardWire[] | null => {
    if (!items) return items;
    const idx = items.findIndex((item) => item.id === card.id || item.nftAddress === card.nftAddress);
    if (idx < 0) return items;
    const next = items.slice();
    next[idx] = card;
    return next;
  };
  marketsCache.cards = replace(marketsCache.cards);
  marketsCache.cardsPositions = replace(marketsCache.cardsPositions);
}

function shortCardAddress(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function renderCollectorCardDetail(card: CollectorCardWire | null): void {
  const img = document.getElementById('cardsDetailImg') as HTMLImageElement | null;
  const fallback = document.getElementById('cardsDetailFallback');
  const title = document.getElementById('cardsDetailTitle');
  const meta = document.getElementById('cardsDetailMeta');
  const price = document.getElementById('cardsDetailPrice');
  const address = document.getElementById('cardsDetailAddress');
  const owner = document.getElementById('cardsDetailOwner');
  const buy = document.getElementById('cardsDetailBuy') as HTMLButtonElement | null;
  const status = document.getElementById('cardsDetailStatus');
  if (!title || !meta || !price || !address || !owner || !buy || !status) return;

  if (!card) {
    if (img) img.hidden = true;
    if (fallback) fallback.textContent = 'CC';
    title.textContent = 'Select a card';
    meta.textContent = 'Live marketplace listings';
    price.textContent = '$0.00';
    address.textContent = '-';
    owner.textContent = '-';
    buy.disabled = true;
    buy.textContent = 'Buy card';
    status.textContent = 'Pick a listing below.';
    return;
  }

  if (img) {
    img.hidden = !card.imageUrl;
    if (card.imageUrl) img.src = card.imageUrl;
  }
  if (fallback) {
    fallback.hidden = Boolean(card.imageUrl);
    fallback.textContent = fallbackLetter(card.name);
  }
  title.textContent = card.name;
  meta.textContent = cardSubLabel(card);
  price.textContent = cardPriceLabel(card);
  address.textContent = shortCardAddress(card.nftAddress);
  owner.textContent = shortCardAddress(card.ownerWallet);
  const cardsGate = getToken() ? venueTradeBlock('cards') : null;
  buy.disabled = cardsBuyInFlight || Boolean(cardsGate);
  buy.textContent = cardsGate ?? (cardsBuyInFlight ? 'Buying...' : `Buy ${cardPriceLabel(card)}`);
  status.textContent = cardsGate
    ? 'Buying is blocked on this deployment until the flag above is set.'
    : getToken() ? 'Buy uses your Privy Solana wallet.' : 'Sign in to buy with your Privy Solana wallet.';
}

function renderCardsScreen(): void {
  const host = document.getElementById('cardsScreenList');
  if (!host) return;
  const cards = marketsCache.cards ?? [];
  if (!activeCollectorCardId && cards[0]) activeCollectorCardId = cards[0].id;
  const selected = findCollectorCard(activeCollectorCardId);
  renderCollectorCardDetail(selected);
  host.textContent = '';
  if (!cards.length) {
    emptyMarketRow(
      host,
      marketSourceStatus.cards === 'unavailable' ? "Couldn't load cards." : 'No cards listed.',
      marketSourceStatus.cards === 'unavailable' ? 'Collector Crypt unavailable or disabled' : 'Collector Crypt returned no listings',
    );
    return;
  }
  const shownScreenCards = marketListLimit('cardsScreenList', 32);
  cards.slice(0, shownScreenCards).forEach((card) => appendCardRow(host, card, { interactive: true, backTarget: 's33' }));
  if (cards.length > shownScreenCards) {
    appendShowAllRow(host, 'cardsScreenList', cards.length, 'cards', renderCardsScreen);
  }
}

async function hydrateCardsScreen(): Promise<void> {
  if (marketsCache.cards) {
    renderCardsScreen();
    return;
  }
  try {
    const cards = await hydrateCardsMarkets();
    marketsCache.cards = cards;
    marketSourceStatus.cards = 'live';
  } catch {
    marketSourceStatus.cards = 'unavailable';
  }
  renderCardsScreen();
}

async function selectCollectorCard(cardId: string): Promise<void> {
  activeCollectorCardId = cardId;
  renderCardsScreen();
  try {
    const r = await nexaApi.markets.cards.detail(cardId);
    activeCollectorCardId = r.card.id;
    replaceCachedCollectorCard(r.card);
    renderCardsMarkets(marketsCache.cards ?? [], marketSourceStatus.cards);
    renderCardsPositions(marketsCache.cardsPositions ?? [], marketSourceStatus.cardsPositions);
    renderCardsScreen();
  } catch (e) {
    const status = document.getElementById('cardsDetailStatus');
    if (status) status.textContent = e instanceof ApiFailure ? e.message : 'Could not load card detail.';
  }
}

on(document, 'click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-card-id]');
  if (!row) return;
  const cardId = row.getAttribute('data-card-id');
  if (cardId) void selectCollectorCard(cardId);
});

function executeCardsBuy(card: CollectorCardWire): void {
  cardsBuyInFlight = true;
  renderCollectorCardDetail(card);
  const buyBody: CardsBuyInput = {
    cardId: card.id,
    nftAddress: card.nftAddress,
    expectedPriceUsdc: card.priceUsdc,
    tokenStandard: card.tokenStandard,
    name: card.name,
  };
  if (card.imageUrl) buyBody.imageUrl = card.imageUrl;
  const fingerprint = `cards-buy:${card.id}:${card.nftAddress}:${card.priceUsdc}:${card.tokenStandard}`;
  cardsBuyAttempt = idempotencyKeyFor(cardsBuyAttempt, fingerprint);
  nexaApi.markets.cards
    .buy(buyBody, { idempotencyKey: cardsBuyAttempt.idempotencyKey })
    .then((r) => {
      cardsBuyAttempt = null;
      toast(`Card buy submitted${r.confirmed ? ' and confirmed' : ''}.`);
      const status = document.getElementById('cardsDetailStatus');
      if (status) status.textContent = r.confirmed ? `Confirmed: ${shortCardAddress(r.signature)}` : `Submitted: ${shortCardAddress(r.signature)}`;
      return fetchCardsPositions();
    })
    .then((positions) => {
      marketsCache.cardsPositions = positions;
      marketSourceStatus.cardsPositions = 'live';
      renderCardsPositions(positions, 'live');
    })
    .catch((err: unknown) => {
      toast(err instanceof ApiFailure ? err.message : 'Card buy failed.', 'err');
      const status = document.getElementById('cardsDetailStatus');
      if (status) status.textContent = err instanceof ApiFailure ? err.message : 'Card buy failed.';
    })
    .finally(() => {
      cardsBuyInFlight = false;
      renderCardsScreen();
    });
}

on(document, 'click', (e) => {
  const buy = (e.target as HTMLElement).closest<HTMLButtonElement>('#cardsDetailBuy');
  if (!buy) return;
  e.preventDefault();
  const card = findCollectorCard(activeCollectorCardId);
  if (!card || cardsBuyInFlight) return;
  if (!getToken()) {
    toast('Sign in to buy cards.', 'err');
    go('s01');
    return;
  }
  // Same review-sheet vocabulary as swap / withdraw — a collectible purchase
  // is a money action, not a browser dialog.
  openReviewSheet({
    eyebrow: 'BUY CARD · COLLECTOR CRYPT',
    amount: cardPriceLabel(card),
    subline: card.name,
    rows: [
      { k: 'CARD', v: card.name },
      ...(cardSubLabel(card) ? [{ k: 'GRADE', v: cardSubLabel(card) }] : []),
      { k: 'PRICE', v: `${cardPriceLabel(card)} USDC` },
      { k: 'NFT', v: shortCardAddress(card.nftAddress) },
    ],
    finePrint: 'Pays with USDC from your Privy Solana wallet. The NFT transfers to the same wallet once the buy confirms.',
    confirmLabel: `Buy ${cardPriceLabel(card)}`,
    onConfirm: () => {
      executeCardsBuy(card);
    },
  });
});

function renderActiveTradeTab(): void {
  // Re-render every tab from cache. Cheap (DOM diff is one card), keeps panels
  // in sync if the user toggles back-and-forth without a fresh fetch.
  renderHlMarkets(marketsCache.perps ?? [], marketSourceStatus.perps, 'hlMarketsList', null);
  renderHlMarkets(marketsCache.spot ?? [], marketSourceStatus.spot, 'hlSpotMarketsList', 'Spot');
  const memes = (marketsCache.spot ?? [])
    .filter((m) => isMemeSpot(hlMarketSymbol(m)))
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  renderHlMarkets(memes, marketSourceStatus.spot, 'hlMemesMarketsList', 'Meme');
  renderJupMemes(marketsCache.jupMemes ?? [], marketSourceStatus.jupMemes === 'live' ? 'live' : 'unavailable');
  // Stocks: HIP-3 perps reuse the existing HL row component (same chart +
  // order-sheet flow once tapped). xStocks render through their own row
  // template and tap into the Jupiter swap sheet.
  renderHlMarkets(
    marketsCache.stocksPerp ?? [],
    marketSourceStatus.stocksPerp,
    'stocksPerpMarketsList',
    'Stock',
  );
  renderXStocks(marketsCache.xstocks ?? [], marketSourceStatus.xstocks === 'live' ? 'live' : 'unavailable');
  const predictionEvents = cachedPredictionsForCategory(activePmCategory);
  renderPmEvents(predictionEvents ?? [], marketSourceStatus.predictions);
  renderCardsMarkets(marketsCache.cards ?? [], marketSourceStatus.cards);
  renderCardsPositions(marketsCache.cardsPositions ?? [], marketSourceStatus.cardsPositions);
  if (activeScreen === 's27') syncTradeVenueLiveStreams();
}

// Category filter pills inside Predictions panel — tap re-fetches /events
// with the matching tag_slug and updates the Predictions cache only.
on(document, 'click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-pm-cat]');
  if (!chip) return;
  const slug = chip.getAttribute('data-pm-cat') ?? '';
  activePmCategory = slug;
  $$('[data-pm-cat]').forEach((b) => {
    const on = b.getAttribute('data-pm-cat') === slug;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  renderPmCategoryLoading();
  void hydratePmCategory(slug);
});

async function hydrateMarketsImpl(): Promise<void> {
  const region = regionFromStorage();
  const regionPill = document.getElementById('marketsRegion');
  if (regionPill) regionPill.setAttribute('country', region);
  const predictionCategory = activePmCategory;

  // Six parallel fetches — every venue lights up at the same time so the
  // first tab visit is instant regardless of which one the user picks.
  // HL perps/spot, Jupiter, HIP-3 and xStocks route through our backend cache;
  // Polymarket still uses Gamma events directly because the UI needs grouped
  // event cards. Each settles independently.
  const [perpsRes, spotRes, predRes, jupRes, stocksPerpRes, xstocksRes, cardsRes, cardsPositionsRes] = await Promise.allSettled([
    fetchHlPerps(),
    fetchHlSpot(),
    fetchPolymarketEvents(predictionCategory),
    fetchJupiterMemes(),
    fetchStocksPerps(),
    fetchXStocks(),
    hydrateCardsMarkets(),
    fetchCardsPositions(),
  ]);
  const settled = [perpsRes, spotRes, predRes, jupRes, stocksPerpRes, xstocksRes, cardsRes, cardsPositionsRes];
  const backoffMs = marketHydrateBackoffMs(settled);
  marketsHydratedAt = Date.now();
  marketsHydrateCooldownUntil = backoffMs > 0 ? marketsHydratedAt + backoffMs : 0;

  if (perpsRes.status === 'fulfilled') {
    marketsCache.perps = perpsRes.value;
    marketSourceStatus.perps = 'live';
  } else {
    marketSourceStatus.perps = 'unavailable';
  }
  if (spotRes.status === 'fulfilled') {
    marketsCache.spot = spotRes.value;
    marketSourceStatus.spot = 'live';
  } else {
    marketSourceStatus.spot = 'unavailable';
  }
  if (predRes.status === 'fulfilled') {
    marketsCache.predictions = predRes.value;
    predictionsCacheCategory = predictionCategory;
    marketSourceStatus.predictions = 'live';
  } else {
    marketSourceStatus.predictions = 'unavailable';
  }
  if (jupRes.status === 'fulfilled') {
    marketsCache.jupMemes = jupRes.value;
    marketSourceStatus.jupMemes = 'live';
  } else {
    marketSourceStatus.jupMemes = 'unavailable';
  }
  if (stocksPerpRes.status === 'fulfilled') {
    marketsCache.stocksPerp = stocksPerpRes.value;
    marketSourceStatus.stocksPerp = 'live';
  } else {
    marketSourceStatus.stocksPerp = 'unavailable';
  }
  if (xstocksRes.status === 'fulfilled') {
    marketsCache.xstocks = xstocksRes.value;
    marketSourceStatus.xstocks = 'live';
  } else {
    marketSourceStatus.xstocks = 'unavailable';
  }
  if (cardsRes.status === 'fulfilled') {
    marketsCache.cards = cardsRes.value;
    marketSourceStatus.cards = 'live';
  } else {
    marketSourceStatus.cards = 'unavailable';
  }
  if (cardsPositionsRes.status === 'fulfilled') {
    marketsCache.cardsPositions = cardsPositionsRes.value;
    marketSourceStatus.cardsPositions = 'live';
  } else {
    marketSourceStatus.cardsPositions = 'unavailable';
  }

  renderActiveTradeTab();
  applySourceBadge(document.querySelector<HTMLElement>('[data-hl-source]'), null);
  applySourceBadge(document.querySelector<HTMLElement>('[data-pm-source]'), null);
}

/* ── Sprint 15 — System / Docs (s28) ────────────────────────────────────── */

const SYS_PANELS: Record<string, string> = {
  providers: 'sysProviders',
  routes: 'sysRoutes',
  missing: 'sysMissing',
};

function setSystemTab(name: string): void {
  const target = SYS_PANELS[name] ? name : 'providers';
  $$('[data-sseg]').forEach((b) => {
    const selected = b.getAttribute('data-sseg') === target;
    b.classList.toggle('on', selected);
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
  });
  for (const [key, panelId] of Object.entries(SYS_PANELS)) {
    const panel = document.getElementById(panelId);
    if (panel) panel.hidden = key !== target;
  }
}

const SYS_TAB_ORDER: string[] = ['providers', 'routes', 'missing'];

$$('[data-sseg]').forEach((b) => {
  on(b, 'click', () => setSystemTab(b.getAttribute('data-sseg') ?? 'providers'));
  // WAI-ARIA APG tab pattern — Left/Right cycles through tabs, Home/End jumps
  // to first/last. Tab moves to the next focusable group, NOT between tabs.
  on(b, 'keydown', (e) => {
    const kbd = e as KeyboardEvent;
    const here = b.getAttribute('data-sseg');
    const idx = here ? SYS_TAB_ORDER.indexOf(here) : -1;
    if (idx < 0) return;
    let next: string | null = null;
    if (kbd.key === 'ArrowRight') next = SYS_TAB_ORDER[(idx + 1) % SYS_TAB_ORDER.length] ?? null;
    else if (kbd.key === 'ArrowLeft') next = SYS_TAB_ORDER[(idx - 1 + SYS_TAB_ORDER.length) % SYS_TAB_ORDER.length] ?? null;
    else if (kbd.key === 'Home') next = SYS_TAB_ORDER[0] ?? null;
    else if (kbd.key === 'End') next = SYS_TAB_ORDER[SYS_TAB_ORDER.length - 1] ?? null;
    if (!next) return;
    kbd.preventDefault();
    setSystemTab(next);
    const newTab = document.querySelector<HTMLElement>(`[data-sseg="${next}"]`);
    newTab?.focus();
  });
});

const PROVIDER_STATUS_LABEL: Record<string, string> = {
  live: 'LIVE',
  sandbox: 'SANDBOX',
  gated: 'GATED',
  'docs-only': 'DOCS ONLY',
  'missing-keys': 'MISSING KEYS',
  disabled: 'DISABLED',
};

const PROVIDER_STATUS_TAG: Record<string, string> = {
  live: 'ok',
  sandbox: '',
  gated: 'warnx',
  'docs-only': 'warnx',
  'missing-keys': 'warnx',
  disabled: '',
};

function renderProviderList(providers: ProviderRegistryEntryWire[]): void {
  const host = document.getElementById('sysProvidersList');
  if (!host) return;
  host.textContent = '';
  const sorted = [...providers].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sorted) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = p.name;
    const s = document.createElement('span');
    s.className = 's';
    const subParts = [
      p.category.toUpperCase().replace(/-/g, ' '),
      p.envVars.length ? `${p.envVars.length} ENV VAR${p.envVars.length === 1 ? '' : 'S'}` : 'NO ENV',
    ];
    s.textContent = subParts.join(' · ');
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    grow.appendChild(s);
    if (p.notes) {
      grow.appendChild(document.createElement('br'));
      const note = document.createElement('span');
      note.className = 's';
      note.style.opacity = '.7';
      note.textContent = p.notes;
      grow.appendChild(note);
    }
    if (p.publicDocsUrl) {
      grow.appendChild(document.createElement('br'));
      const link = document.createElement('a');
      link.href = p.publicDocsUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.fontFamily = 'var(--mono)';
      link.style.fontSize = '11px';
      link.style.letterSpacing = '.06em';
      link.textContent = 'Docs ↗';
      grow.appendChild(link);
    }
    const tag = document.createElement('span');
    tag.className = `tag ${PROVIDER_STATUS_TAG[p.status] ?? ''}`.trim();
    tag.textContent = PROVIDER_STATUS_LABEL[p.status] ?? p.status.toUpperCase();
    row.appendChild(grow);
    row.appendChild(tag);
    host.appendChild(row);
  }
}

function renderMissingList(providers: ProviderRegistryEntryWire[]): void {
  const host = document.getElementById('sysMissingList');
  if (!host) return;
  host.textContent = '';
  const missing = providers.filter((p) => !p.publicDocsUrl || p.status === 'docs-only');
  if (missing.length === 0) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = 'All providers have docs linked';
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = 'NO GAPS';
    grow.appendChild(s);
    row.appendChild(grow);
    host.appendChild(row);
    return;
  }
  for (const p of missing) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = p.name;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = !p.publicDocsUrl
      ? 'PUBLIC DOCS MISSING · LIVE TRADING GATED'
      : 'PROVIDER ACCESS PENDING';
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    grow.appendChild(s);
    if (p.notes) {
      grow.appendChild(document.createElement('br'));
      const note = document.createElement('span');
      note.className = 's';
      note.style.opacity = '.7';
      note.textContent = p.notes;
      grow.appendChild(note);
    }
    const tag = document.createElement('span');
    tag.className = 'tag warnx';
    tag.textContent = !p.publicDocsUrl ? 'DOCS' : 'GATED';
    row.appendChild(grow);
    row.appendChild(tag);
    host.appendChild(row);
  }
}

function renderDataSourcesList(
  sources: Array<{ id: string; domain: string; metric: string; meta: SourcedValueMetaWire; screens: string[] }>,
): void {
  const host = document.getElementById('sysSourcesList');
  if (!host) return;
  host.textContent = '';
  for (const src of sources) {
    const row = document.createElement('div');
    row.className = 'lrow';
    const grow = document.createElement('span');
    grow.className = 'grow';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${src.domain}/${src.metric}`;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = src.screens.length
      ? `RENDERED ON ${src.screens.join(', ').toUpperCase()}`
      : 'NOT RENDERED';
    grow.appendChild(t);
    grow.appendChild(document.createElement('br'));
    grow.appendChild(s);
    grow.appendChild(document.createElement('br'));
    const badge = document.createElement('nexa-source-badge') as HTMLElement;
    applySourceBadge(badge, src.meta);
    grow.appendChild(badge);
    row.appendChild(grow);
    host.appendChild(row);
  }
}

let systemDocsLoaded = false;

/* ── s28 transparency hub state ── */
type SysFilter = 'all' | 'live' | 'docs-only' | 'missing-keys';
let sysCachedProviders: ProviderRegistryEntryWire[] = [];
let sysActiveFilter: SysFilter = 'all';
let sysActiveCategory: string = 'all';
let sysFetchedAt: string | null = null;

const PROVIDER_SUMMARY: Record<string, string> = {
  privy: 'Wallet provisioning and passkey auth. EIP-7702 wallets for users and agents.',
  alchemy: 'Gas sponsorship policy + Wallet API on Base. Sponsors agent settle + user actions.',
  stripe: 'Hosted Crypto Onramp from card to USDC on Base. Live in test mode.',
  monerium: 'EU IBAN paired with EURe on Gnosis. SEPA in, redeem out.',
  bridge: 'US bank rails (ACH, wire). Awaiting KYB approval.',
  socket: 'Cross-chain bridge aggregator. LI.FI fallback already routes when Socket is absent.',
  lifi: 'Bridge aggregator. Live route for swaps when Socket is unconfigured.',
  mayan: 'Mayan Swift cross-chain quotes and execute between Solana and EVM.',
  cctp: 'Circle native USDC bridge. Scaffolded; awaiting attestation poll path.',
  aave: 'Aave v3 USDC supply on Base. On-chain read of Pool.getReserveData().',
  compound: 'Compound III USDC market on Base. Reads Comet.getSupplyRate.',
  'morpho-standard': 'Steakhouse-curated USDC vault on Base. Parity with Coinbase USDC Prime.',
  'morpho-high-yield': 'bbqUSDC — Steakhouse high-yield vault. Parity with Coinbase USDC High Yield.',
  yousd: 'yoUSD vault yield (api.yo.xyz). Realised APY from public timeseries.',
  marinade: 'Marinade Finance liquid SOL staking on Solana. Stake and instant unstake submit when Solana RPC is configured.',
  'gnosis-pay': 'EU Visa card issuer on Gnosis chain. Awaiting partnership.',
  sponge: 'US debit card issuer. Awaiting partnership.',
  hyperliquid: 'Perpetual futures DEX. Public market reads live, trading needs Privy wallet flow.',
  polymarket: 'Prediction market CLOB. Public reads live, trading geo-gated.',
  x402: 'Coinbase x402 micropayments for agents. EIP-3009 settlement on Base.',
  sumsub: 'KYC / liveness checks. Awaiting partner key.',
  resend: 'Transactional email (OTP, claim, digest). Falls back to stdout if absent.',
  sentry: 'Error reporting and traces. Sample rate 0.1.',
  postgres: 'Durable ledger. Migrations 0000–0014 applied against the maze database.',
  redis: 'BullMQ worker queues and rate limiters.',
};

function providerSummary(p: ProviderRegistryEntryWire): string {
  return PROVIDER_SUMMARY[p.id] ?? p.notes ?? '';
}

function renderProviderGrid(): void {
  const host = document.getElementById('sysProviderGrid');
  if (!host) return;
  host.textContent = '';

  const filtered = sysCachedProviders.filter((p) => {
    if (sysActiveFilter !== 'all' && p.status !== sysActiveFilter) return false;
    if (sysActiveCategory !== 'all' && p.category !== sysActiveCategory) return false;
    return true;
  });

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sys-empty';
    empty.textContent = 'NO PROVIDERS MATCH THIS FILTER';
    host.appendChild(empty);
    return;
  }

  // Sort: live first, then sandbox, then docs-only, then missing-keys, then disabled. Within group, alpha.
  const order: Record<string, number> = {
    live: 0, sandbox: 1, gated: 2, 'docs-only': 3, 'missing-keys': 4, disabled: 5,
  };
  const sorted = [...filtered].sort((a, b) => {
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
    const summary = providerSummary(p);
    if (summary) card.setAttribute('summary', summary);
    card.setAttribute('drawer-target', p.id);
    on(card, 'click', async (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.('a');
      if (link) return;
      const drawer = await ensureProvenanceDrawer();
      drawer.open({
        provider: p.id,
        name: p.name,
        category: p.category,
        status: p.status,
        summary,
        docsUrl: p.publicDocsUrl ?? undefined,
        endpoint: p.envVars.length ? `Env: ${p.envVars.join(', ')}` : undefined,
        fetchedAt: p.lastCheckedAt,
        notes: p.notes,
      });
    });
    host.appendChild(card);
  }
}

function renderCategoryRow(): void {
  const host = document.getElementById('sysCatRow');
  if (!host) return;
  host.textContent = '';
  const cats = new Set<string>();
  for (const p of sysCachedProviders) cats.add(p.category);

  const makeChip = (key: string, label: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'sys-cat' + (key === sysActiveCategory ? ' on' : '');
    b.dataset['cat'] = key;
    b.textContent = label;
    on(b, 'click', () => {
      sysActiveCategory = key;
      renderCategoryRow();
      renderProviderGrid();
    });
    return b;
  };
  host.appendChild(makeChip('all', 'All categories'));
  const labelFor = (k: string): string =>
    ({
      wallet: 'Wallet', auth: 'Auth', kyc: 'KYC', onramp: 'Onramp', offramp: 'Offramp',
      stablecoin: 'Stablecoin', swap: 'Swap', 'defi-yield': 'Earn', card: 'Card',
      'agent-wallet': 'Agent wallet', x402: 'x402', markets: 'Markets',
      'tokenized-stocks': 'Tokenized stocks', observability: 'Observability',
      email: 'Email', persistence: 'Persistence',
    }[k] ?? k.replace(/-/g, ' '));
  const sortedCats = [...cats].sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  for (const c of sortedCats) host.appendChild(makeChip(c, labelFor(c)));
}

function renderStateBar(): void {
  const bar = document.getElementById('sysStateBar');
  if (!bar) return;
  const live = sysCachedProviders.filter((p) => p.status === 'live').length;
  const docs = sysCachedProviders.filter((p) => p.status === 'docs-only').length;
  const miss = sysCachedProviders.filter((p) => p.status === 'missing-keys').length;
  bar.setAttribute('live', String(live));
  bar.setAttribute('docs-only', String(docs));
  bar.setAttribute('missing-keys', String(miss));
  bar.setAttribute('total', String(sysCachedProviders.length));
  const ids: Record<SysFilter, string> = {
    all: 'cntAll', live: 'cntLive', 'docs-only': 'cntDocs', 'missing-keys': 'cntMiss',
  };
  const counts: Record<SysFilter, number> = {
    all: sysCachedProviders.length, live, 'docs-only': docs, 'missing-keys': miss,
  };
  for (const f of ['all', 'live', 'docs-only', 'missing-keys'] as SysFilter[]) {
    const el = document.getElementById(ids[f]);
    if (el) el.textContent = String(counts[f]);
  }
}

function setSysFilter(next: SysFilter): void {
  sysActiveFilter = next;
  $$('[data-sfilter]').forEach((b) => {
    const isOn = b.getAttribute('data-sfilter') === next;
    b.classList.toggle('on', isOn);
    b.setAttribute('aria-pressed', String(isOn));
  });
  renderProviderGrid();
}

$$('[data-sfilter]').forEach((b) => {
  on(b, 'click', () => setSysFilter((b.getAttribute('data-sfilter') ?? 'all') as SysFilter));
});

let hydrateSystemInflight: Promise<void> | null = null;
function hydrateSystemDocs(): Promise<void> {
  if (hydrateSystemInflight) return hydrateSystemInflight;
  hydrateSystemInflight = hydrateSystemDocsImpl().finally(() => {
    hydrateSystemInflight = null;
  });
  return hydrateSystemInflight;
}

async function hydrateSystemDocsImpl(): Promise<void> {
  setSystemTab('providers');
  const tag = document.getElementById('sysHealthTag');
  if (tag) {
    tag.textContent = systemDocsLoaded ? 'LIVE' : 'LOADING';
    tag.className = systemDocsLoaded ? 'tag ok' : 'tag';
  }
  try {
    const [providers, sources, health] = await Promise.all([
      nexaApi.systemProviders(),
      nexaApi.systemDataSources(),
      nexaApi.systemHealth(),
    ]);
    sysCachedProviders = providers.providers;
    sysFetchedAt = providers.fetchedAt;
    renderStateBar();
    renderCategoryRow();
    renderProviderGrid();
    renderProviderList(providers.providers);
    renderMissingList(providers.providers);
    renderDataSourcesList(sources.sources);
    systemDocsLoaded = true;
    if (tag) {
      tag.textContent = health.demo ? 'DEMO' : 'LIVE';
      tag.className = health.demo ? 'tag warnx' : 'tag ok';
    }
  } catch (e) {
    const host = document.getElementById('sysProvidersList');
    if (host) {
      host.textContent = '';
      const row = document.createElement('div');
      row.className = 'lrow';
      const grow = document.createElement('span');
      grow.className = 'grow';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = 'System data unavailable';
      grow.appendChild(t);
      grow.appendChild(document.createElement('br'));
      const s = document.createElement('span');
      s.className = 's';
      s.textContent = e instanceof ApiFailure ? e.message.toUpperCase() : 'API UNREACHABLE';
      grow.appendChild(s);
      row.appendChild(grow);
      host.appendChild(row);
    }
    const grid = document.getElementById('sysProviderGrid');
    if (grid) {
      grid.textContent = '';
      const empty = document.createElement('p');
      empty.className = 'sys-empty';
      empty.textContent = 'PROVIDER REGISTRY UNAVAILABLE';
      grid.appendChild(empty);
    }
    if (tag) {
      tag.textContent = 'UNAVAILABLE';
      tag.className = 'tag warnx';
    }
  }
  // Avoid 'sysFetchedAt unused' lint while keeping the cache for future "last refreshed" labels.
  void sysFetchedAt;
}
$$('[data-join2]').forEach((b) => {
  on(b, 'click', () => {
    const j = b.classList.toggle('joined');
    b.textContent = j ? 'JOINED ✓' : 'JOIN';
    if (j) toast("You're in. Submit from this campaign anytime.");
  });
});
on($('#claimPay'), 'click', () => {
  if (LIVE) {
    liveCall(nexaApi.topup(12.4, 'Clip payout · X thread'));
  } else {
    L.bal = (L.bal ?? 0) + 12.4;
    L.fresh = false;
    L.activity.unshift({
      n: 'Clip payout · X thread',
      s: 'CAMPAIGN · CLAIMED · JUST NOW',
      a: '+$12.40',
      pos: true,
      k: 'in',
    });
    renderBal();
  }
  const claimRow = $('#claimRow');
  claimRow.textContent = '';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = 'X thread clip';
  const s = document.createElement('span');
  s.className = 's';
  s.textContent = 'PAID OUT · IN YOUR BALANCE';
  grow.appendChild(t);
  grow.appendChild(document.createElement('br'));
  grow.appendChild(s);
  const tag = document.createElement('span');
  tag.className = 'tag ok';
  tag.textContent = 'CLAIMED ✓';
  claimRow.appendChild(grow);
  claimRow.appendChild(tag);
  toast('+$12.40 claimed · already earning ✓');
});
$$('[data-echip]').forEach((ch) => {
  on(ch, 'click', () => {
    $$('[data-echip]').forEach((o) => o.classList.remove('onx'));
    ch.classList.add('onx');
  });
});
on($('#e2Go'), 'click', () => {
  const v = parseFloat(String(($('#e2Amt') as HTMLInputElement).value).replace(',', '.'));
  if (!(v > 0)) {
    $('#e2Hint').textContent = 'ENTER AN AMOUNT ABOVE $0';
    return;
  }
  const slug = slug4();
  const url = payLink(slug);
  $('#e2Link').textContent = `${displayUrl(url)} · ${money(v)}`;
  $('#e2Copy').setAttribute('data-copy', `${url} · MAZE payment link, ${money(v)}`);
  ($('#e2Out') as HTMLElement).hidden = false;
  $('#e2Hint').textContent = 'ONE-TIME CLAIM · EXPIRES IN 7 DAYS';
});

function syncRecip(): void {
  const v = ($('#recipInp') as HTMLInputElement).value.trim();
  const row = $('#recipTyped');
  (row as HTMLElement).hidden = !v;
  row.setAttribute('data-recip', v);
  if (v) $('#recipTypedT').textContent = 'Send to ' + v;
  ($('#claimNote') as HTMLElement).hidden = !(v && v.includes('@'));
  const nameEl = document.getElementById('claimNoteName');
  if (nameEl && v) nameEl.textContent = v;
}
on($('#recipInp'), 'input', syncRecip);
syncRecip();

/* ── mcp ── */
const MCP_KEY_PLACEHOLDER = '<paste-your-agent-key>';
function renderMcpConfig(): void {
  const config = {
    mcpServers: {
      maze: {
        url: `${MCP_API_BASE}/mcp`,
        key: MCP_KEY_PLACEHOLDER,
      },
    },
  };
  $('#mcpCfg').textContent = JSON.stringify(config, null, 2);
  $('#mcpCopy').setAttribute('data-copy', JSON.stringify(config));
  $('#directApiCfg').textContent = `curl ${MCP_API_BASE}/v1/agent/pay \\
  -H "Authorization: Bearer <your key>" \\
  -d '{"endpoint":"api.exa.ai","amount":0.12}'`;
}

let keyShown = false;
on($('#keyReveal'), 'click', () => {
  keyShown = !keyShown;
  $('#apiKey').textContent = keyShown ? MCP_KEY_PLACEHOLDER : 'agent_key_••••_••••';
  $('#keyReveal').textContent = keyShown ? 'HIDE' : 'REVEAL';
});

/* ── boot ── */
renderMcpConfig();
renderActivity();
renderAmt();
swRender();
enhanceKeyboardActions();
setEarnTab('1');
// C1 — hashless entry (PWA start_url, direct /app.html): a live tab session
// goes straight home; signed-out paints sign-in. Cold cookie-resume upgrades
// s01 → s08 after the probe in tryResumeSession.
go(location.hash.slice(1) || (getToken() ? 's08' : 's01'));
/* Warm-offline indicator. The in-memory ledger survives a dropped connection,
   so we tell the user the figures are last-loaded rather than live. */
const renderNet = (): void => {
  const b = document.getElementById('netBanner');
  if (b) b.hidden = navigator.onLine;
};
onGlobal(window, 'online', renderNet);
onGlobal(window, 'offline', renderNet);
renderNet();

// A 401 from the API (api.ts dispatches this after clearing the token) means the
// session expired mid-use: drop to demo surfaces and send the user to re-auth.
onGlobal(window, 'nexa:auth-required', () => {
  LIVE = false;
  stream?.close();
  stream = null;
  stopLiveSync();
  // Drop the in-memory ledger so the next signed-out paint shows '…' instead of
  // the just-expired user's last balance.
  L.bal = null;
  L.earnPos = null;
  L.activity = [];
  spendInsight = null;
  renderBal();
  renderActivity();
  renderSpendInsight();
  setLiveSurfaces();
  setNotificationUi(false);
  toast('Session expired. Sign in again.', 'err');
  go('s01');
});

void probeDemoMode();
void tryResumeSession();

registerMazeServiceWorker({
  isProd: import.meta.env.PROD,
  serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  onUpdateReady: () => toast('New version ready. Reload to update.'),
});

/* ── HMR teardown ──
 * Every on() call above binds to the current mount AbortSignal. When Vite
 * re-runs the module on hot-reload, dispose() fires first — resetMount()
 * aborts the current signal, detaching every listener registered through
 * on(). The module then re-executes from top, binding fresh listeners
 * against a new AbortController.
 *
 * Without this hook the old pattern stacked duplicate handlers across
 * every HMR cycle, which surfaced as "the back button fires twice"
 * in dev and "the e2e test flakes after a hot reload."
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stream?.close();
    stopLiveSync();
    resetMount();
  });
}

/**
 * Test-only escape hatch. Aborts the current mount signal so every listener
 * bound via on() detaches. Callers that need a fresh set of listeners must
 * re-import this module (vi.resetModules() + dynamic import) after calling
 * this — the in-place on() calls fire once at module load.
 */
export function __resetForTest(): void {
  stream?.close();
  stopLiveSync();
  resetMount();
}

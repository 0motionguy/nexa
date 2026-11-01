/**
 * NEXA landing — behavior, ported 1:1 from landing-v2.html's inline script.
 *
 *  1. PWA install flow        2. Globes (shared engine) + route-log ticker
 *  3. Count-up                4. Ledger ticker
 *  5. Agent feed sim          6. Markets ticker
 *  7. Earn slider + links     8. Card tilt + small interactions
 *  9. Scroll reveal
 *
 * Differences from the prototype, by design:
 *  - Globe rendering comes from the shared engine (@/lib/globe) instead of the
 *    prototype's inline globe script; the route log is driven by a timer that
 *    matches the prototype's arc cadence (the shared engine draws dots only).
 *  - Reduced motion reads html.rm (set by the motion gate in <head>), which
 *    also honors ?motion=off — instead of matchMedia alone.
 *  - Service-worker registration uses the same privacy-safe shell helper as
 *    /app.html, so install prompts work from the landing page too.
 *  - All dynamic rows are DOM-built; no innerHTML.
 */
import { bootGlobesIn } from '@/lib/globe.js';
import { registerMazeServiceWorker } from '@/lib/pwa.js';
import { getToken, nexaApi, type EarnAdapterSummary } from '@/lib/api.js';
import '@/components/nexa-source-badge.js';
import '@/components/nexa-yield-ramp.js';
import '@/components/nexa-market-row.js';
import type { NexaYieldRamp, YieldSegment } from '@/components/nexa-yield-ramp.js';

const RM = document.documentElement.classList.contains('rm');
const configuredPayLinkBase = import.meta.env.VITE_MAZE_PAY_BASE_URL?.trim().replace(/\/+$/, '');
const PAY_LINK_BASE = configuredPayLinkBase || 'https://maze.to/pay';

registerMazeServiceWorker({
  isProd: import.meta.env.PROD,
  serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
});

function $<T extends Element = HTMLElement>(sel: string, ctx: ParentNode = document): T | null {
  return ctx.querySelector<T>(sel);
}
function $$<T extends Element = HTMLElement>(sel: string, ctx: ParentNode = document): T[] {
  return Array.from(ctx.querySelectorAll<T>(sel));
}

/* ── 1. PWA INSTALL ─────────────────────────────────────────────── */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installBtns = $$<HTMLButtonElement>('[data-install]');
const statusEls = $$('[data-install-status]');
const ua = navigator.userAgent;
const isIOS =
  /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(ua);
const plat = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop';
const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

$$('.plat').forEach((p) => {
  if (p.getAttribute('data-plat') === plat) p.classList.add('this-device');
});

function setStatus(t: string): void {
  statusEls.forEach((e) => {
    e.textContent = t;
  });
}
function setBtns(t: string, disabled: boolean): void {
  installBtns.forEach((b) => {
    b.textContent = t;
    b.disabled = disabled;
  });
}

function payLink(slug: string): string {
  return `${PAY_LINK_BASE}/${slug}`;
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

if (standalone) {
  setBtns('Open MAZE', false);
  setStatus('MAZE is installed. Open the app shell to sign in.');
} else if (isIOS) {
  setStatus('On iPhone: Safari → Share → Add to Home Screen.');
} else {
  setStatus('If your browser supports it, install is one tap away.');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  setStatus('Ready to install on this device ✓');
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  setBtns('Open MAZE', false);
  setStatus('Installed. Open MAZE from here or from your launcher.');
});

const sheet = $('#sheet');
let lastFocus: Element | null = null;
function openSheet(): void {
  if (!sheet) return;
  sheet.hidden = false;
  requestAnimationFrame(() => {
    sheet.classList.add('open');
  });
  lastFocus = document.activeElement;
  $<HTMLButtonElement>('.sheet-x', sheet)?.focus();
}
function closeSheet(): void {
  if (!sheet) return;
  sheet.classList.remove('open');
  window.setTimeout(() => {
    sheet.hidden = true;
  }, 220);
  if (lastFocus instanceof HTMLElement) lastFocus.focus();
}
$$('[data-sheet-close]').forEach((el) => {
  el.addEventListener('click', closeSheet);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet && !sheet.hidden) closeSheet();
});
installBtns.forEach((b) => {
  b.addEventListener('click', () => {
    if (standalone || b.textContent?.includes('Open MAZE')) {
      // C1 — hashless entry: the app routes by session (signed-in → home,
      // signed-out → sign-in) instead of forcing everyone to s01.
      location.href = '/app.html';
      return;
    }
    if (deferredPrompt) {
      void deferredPrompt.prompt();
      void deferredPrompt.userChoice.then((r) => {
        if (r.outcome === 'accepted') deferredPrompt = null;
      });
    } else {
      openSheet();
    }
  });
});

/* ── 2. GLOBES (shared engine) + ROUTE LOG ──────────────────────── */
bootGlobesIn(document);

/* Route log — the prototype appended an entry whenever a globe arc landed
   (~every 2.6s while visible). The shared engine has no arcs, so a timer
   with the prototype's city + amount pools reproduces the ticker. */
const CITIES = [
  'NEW YORK', 'LONDON', 'LISBON', 'SÃO PAULO', 'DUBAI', 'SINGAPORE', 'TOKYO', 'JAKARTA',
] as const;
const ROUTE_POOL = [
  { tag: 'ACH',   amt: '+$2,400.00' },
  { tag: 'AGENT', amt: '−$0.12' },
  { tag: 'SEPA',  amt: '+€640.00' },
  { tag: 'LINK',  amt: '+$18.40' },
  { tag: 'AGENT', amt: '−$0.004' },
  { tag: 'LINK',  amt: '+$75.00' },
  { tag: 'P2P',   amt: '+$42.00' },
  { tag: 'AGENT', amt: '−$0.003' },
  { tag: 'X402',  amt: '+$0.12' },
  { tag: 'CARD',  amt: '−$6.40' },
  { tag: 'CLIP',  amt: '+$12.40' },
  { tag: 'AGENT', amt: '−$0.06' },
  { tag: 'SEPA',  amt: '+€280.00' },
  { tag: 'P2P',   amt: '+$8.20' },
  { tag: 'EARN',  amt: '+$3.20' },
] as const;

const routeLog = $('#routeLog');
if (routeLog && !RM) {
  let routeI = 0;
  let routeVisible = false;
  new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        routeVisible = entry.isIntersecting;
      });
    },
    { threshold: 0.1 },
  ).observe(routeLog);
  window.setInterval(() => {
    if (!routeVisible || document.hidden) return;
    const ev = ROUTE_POOL[routeI++ % ROUTE_POOL.length]!;
    const ai = Math.floor(Math.random() * CITIES.length);
    let bi = Math.floor(Math.random() * CITIES.length);
    if (bi === ai) bi = (bi + 1) % CITIES.length;
    const li = document.createElement('li');
    li.className = 'feed-in';
    const tag = document.createElement('i');
    tag.textContent = ev.tag;
    const amt = document.createElement('b');
    amt.textContent = ev.amt;
    li.append(tag, `${CITIES[ai]!} → ${CITIES[bi]!}`, amt);
    routeLog.insertBefore(li, routeLog.firstChild);
    while (routeLog.children.length > 6) routeLog.removeChild(routeLog.lastChild!);
  }, 1300);
}

/* ── 3. COUNT-UP ────────────────────────────────────────────────── */
function fmt(v: number, dec: number, pre: string, suf: string): string {
  return (
    pre + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf
  );
}
const cio = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      cio.unobserve(entry.target);
      const el = entry.target;
      const target = parseFloat(el.getAttribute('data-target') ?? '0');
      const dec = parseInt(el.getAttribute('data-dec') ?? '0', 10);
      const pre = el.getAttribute('data-prefix') ?? '';
      const suf = el.getAttribute('data-suffix') ?? '';
      if (RM) {
        el.textContent = fmt(target, dec, pre, suf);
        return;
      }
      const t0 = performance.now();
      const dur = 950;
      const step = (t: number): void => {
        const k = Math.min(1, (t - t0) / dur);
        el.textContent = fmt(target * (1 - Math.pow(1 - k, 3)), dec, pre, suf);
        if (k < 1) requestAnimationFrame(step);
      };
      step(t0);
    });
  },
  { threshold: 0.4 },
);
$$('[data-count]').forEach((c) => {
  cio.observe(c);
});

/* ── 4. LEDGER TICKER ───────────────────────────────────────────── */
const ledgerSet = $('.ledger-set');
if (ledgerSet?.parentNode) {
  const clone = ledgerSet.cloneNode(true) as HTMLElement;
  clone.setAttribute('aria-hidden', 'true');
  ledgerSet.parentNode.appendChild(clone);
}

/* ── 5. AGENT FEED SIM ──────────────────────────────────────────── */
type FeedPart = string | { b: string };
interface FeedEvent {
  k: 'ok' | 'blocked' | 'ask';
  parts: readonly FeedPart[];
  a?: number;
}

const feed = $('#feed');
const pill = $('#agentPill');
const pauseBtn = $<HTMLButtonElement>('#pauseBtn');
const spentEl = $('#agentSpent');
const meterEl = $('#agentMeter');
const feedState = $('#feedState');
let spent = 13.2;
let paused = false;
let pi = 0;
const POOL: readonly FeedEvent[] = [
  { k: 'ok',      parts: ['paid ', { b: 'api.exa.ai' },       ' · market data'],     a: 0.12 },
  { k: 'ok',      parts: ['paid ', { b: 'weather.api' },      ' · forecast pull'],   a: 0.002 },
  { k: 'ok',      parts: ['paid ', { b: 'search.api' },       ' · web query'],       a: 0.004 },
  { k: 'blocked', parts: ['blocked ', { b: 'unknown.vendor' }, ' · not on allowlist'] },
  { k: 'ok',      parts: ['paid ', { b: 'translate.api' },    ' · doc translation'], a: 0.004 },
  { k: 'ok',      parts: ['paid ', { b: 'sentiment.io' },     ' · model call'],      a: 0.018 },
  { k: 'ok',      parts: ['paid ', { b: 'clip-analytics' },   ' · agent feed'],      a: 0.003 },
  { k: 'blocked', parts: ['blocked ', { b: 'scrape.api' },     ' · over per-tx cap'] },
  { k: 'ok',      parts: ['paid ', { b: 'embeddings.dev' },   ' · vector batch'],    a: 0.022 },
  { k: 'ok',      parts: ['paid ', { b: 'maps.api' },         ' · geocode'],         a: 0.001 },
];

function now(): string {
  const d = new Date();
  const p = (n: number): string => (n < 10 ? '0' : '') + String(n);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function feedSpan(cls: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  return span;
}
function feedMain(parts: readonly FeedPart[]): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'f-main';
  for (const part of parts) {
    if (typeof part === 'string') {
      span.append(part);
    } else {
      const b = document.createElement('b');
      b.textContent = part.b;
      span.append(b);
    }
  }
  return span;
}
function renderSpent(): void {
  if (spentEl) spentEl.textContent = `$${spent.toFixed(2)}`;
  if (meterEl) meterEl.style.width = `${Math.min(100, (spent / 50) * 100).toFixed(1)}%`;
}
function addRow(ev: FeedEvent): void {
  if (!feed) return;
  const li = document.createElement('li');
  li.className = ev.k + (RM ? '' : ' feed-in');
  li.append(feedSpan('f-t', now()), feedMain(ev.parts));
  if (ev.a !== undefined) li.append(feedSpan('f-amt', `$${ev.a}`));
  feed.insertBefore(li, feed.firstChild);
  while (feed.children.length > 7) feed.removeChild(feed.lastChild!);
}

window.setInterval(() => {
  if (paused || document.hidden || !feed) return;
  const ev = POOL[pi++ % POOL.length]!;
  addRow(ev);
  if (ev.a !== undefined) {
    spent += ev.a;
    // Loop the budget so the demo never stalls at the cap.
    if (spent > 49) spent = 13.2;
    renderSpent();
  }
}, 1500);

if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    if (pill) {
      pill.className = 'status-pill ' + (paused ? 'halt' : 'live');
      const dot = document.createElement('i');
      dot.setAttribute('aria-hidden', 'true');
      pill.replaceChildren(dot, paused ? 'PAUSED' : 'ACTIVE');
    }
    pauseBtn.textContent = paused ? 'Resume agent' : 'Pause agent';
    if (feedState) feedState.textContent = paused ? 'HALTED' : 'STREAMING';
    addRow(
      paused
        ? { k: 'blocked', parts: ['agent ', { b: 'paused by Mirko' }, ' · kill switch'] }
        : { k: 'ok', parts: ['agent ', { b: 'resumed' }, ' · policy active'] },
    );
  });
}
if (feed) {
  feed.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest('.approve');
    if (!btn) return;
    const li = btn.closest('li');
    if (!li) return;
    li.className = 'ok';
    li.replaceChildren(
      feedSpan('f-t', now()),
      feedMain(['released ', { b: '$2.40' }, ' · dataset access · approved by you']),
      feedSpan('f-amt', '$2.40'),
    );
    spent += 2.4;
    renderSpent();
  });
}

/* ── 6. MARKETS TICKER — random walk, flash on change ───────────── */
interface MktRow {
  price: number;
  open: number;
  priceEl: HTMLElement;
  pctEl: HTMLElement;
  to: number | null;
}
const mktRows: MktRow[] = [];
$$('[data-mkt]').forEach((row) => {
  const price = parseFloat(row.getAttribute('data-price') ?? '0');
  const pct0 = parseFloat(row.getAttribute('data-pct0') ?? '0');
  const priceEl = $('.mkt-price', row);
  const pctEl = $('.mkt-pct', row);
  if (!priceEl || !pctEl) return;
  mktRows.push({ price, open: price / (1 + pct0 / 100), priceEl, pctEl, to: null });
});
const mktPanel = $('#mktPanel');
if (mktPanel && !RM) {
  let mktVisible = false;
  new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        mktVisible = entry.isIntersecting;
      });
    },
    { threshold: 0.1 },
  ).observe(mktPanel);
  let mktTick = 0;
  const mktTickEl = $('#mktTick');
  window.setInterval(() => {
    if (!mktVisible || document.hidden) return;
    mktTick++;
    if (mktTickEl) mktTickEl.textContent = String(mktTick).padStart(4, '0');
    mktRows.forEach((m) => {
      const delta = (Math.random() - 0.5) * 0.0032;
      m.price *= 1 + delta;
      const pct = (m.price / m.open - 1) * 100;
      m.priceEl.textContent =
        '$' + m.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      m.pctEl.textContent = (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(1) + '%';
      m.pctEl.className = 'mkt-pct ' + (pct >= 0 ? 'up' : 'down');
      m.priceEl.classList.remove('up', 'down');
      m.priceEl.classList.add(delta >= 0 ? 'up' : 'down');
      if (m.to !== null) window.clearTimeout(m.to);
      m.to = window.setTimeout(() => {
        m.priceEl.classList.remove('up', 'down');
      }, 520);
    });
  }, 850);
}

/* ── 7. EARN — slider calculator, campaigns, payment-link maker ─── */
const earnRange = $<HTMLInputElement>('#earnRange');
const calcBal = $('#calcBal');
const calcYr = $('#calcYr');
function calc(): void {
  if (!earnRange || !calcBal || !calcYr) return;
  const v = parseInt(earnRange.value, 10);
  calcBal.textContent = '$' + v.toLocaleString('en-US');
  calcYr.textContent = '≈ $' + Math.round(v * 0.084).toLocaleString('en-US') + ' / yr';
}
if (earnRange) {
  earnRange.addEventListener('input', calc);
  calc();
}
$$<HTMLButtonElement>('[data-join]').forEach((b) => {
  b.addEventListener('click', () => {
    const joined = b.classList.toggle('joined');
    b.textContent = joined ? 'JOINED ✓' : 'JOIN';
  });
});
$$<HTMLButtonElement>('[data-chip]').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('[data-chip]').forEach((c) => {
      c.setAttribute('aria-pressed', 'false');
    });
    chip.setAttribute('aria-pressed', 'true');
  });
});
const lmCreate = $<HTMLButtonElement>('#lmCreate');
const lmAmt = $<HTMLInputElement>('#lmAmt');
const lmResult = $('#lmResult');
const lmLink = $('#lmLink');
const lmCopy = $('#lmCopy');
const lmHint = $('#lmHint');
if (lmCreate && lmAmt && lmResult && lmLink && lmCopy && lmHint) {
  lmCreate.addEventListener('click', () => {
    const v = parseFloat(lmAmt.value.replace(',', '.'));
    if (!(v > 0)) {
      lmHint.textContent = 'Enter an amount above $0 to create a link.';
      return;
    }
    let slug = Math.floor(Math.random() * 1679616).toString(36);
    while (slug.length < 4) slug = 'x' + slug;
    const url = payLink(slug);
    lmLink.textContent = `${displayUrl(url)} · $${v.toFixed(2)}`;
    lmCopy.setAttribute(
      'data-copy',
      `${url} · MAZE payment link (product preview), $${v.toFixed(2)}`,
    );
    lmResult.classList.add('show');
    lmHint.textContent = 'One-time claim · expires in 7 days · approval optional';
  });
}

/* ── 8. CARD TILT + SMALL INTERACTIONS ──────────────────────────── */
const cardStage = $('#cardStage');
const bigCard = $('#bigCard');
if (cardStage && bigCard && !RM && window.matchMedia('(pointer: fine)').matches) {
  cardStage.addEventListener('pointermove', (e) => {
    const r = bigCard.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    bigCard.style.setProperty('--ry', `${(px * 10).toFixed(2)}deg`);
    bigCard.style.setProperty('--rx', `${(-py * 8).toFixed(2)}deg`);
    bigCard.style.setProperty('--mx', `${((px + 0.5) * 100).toFixed(1)}%`);
    bigCard.style.setProperty('--my', `${((py + 0.5) * 100).toFixed(1)}%`);
  });
  cardStage.addEventListener('pointerleave', () => {
    bigCard.style.setProperty('--rx', '0deg');
    bigCard.style.setProperty('--ry', '0deg');
  });
}
const freezeBtn = $<HTMLButtonElement>('#freezeBtn');
if (freezeBtn && bigCard) {
  freezeBtn.addEventListener('click', () => {
    const f = bigCard.classList.toggle('frozen');
    freezeBtn.textContent = f ? 'UNFREEZE' : 'FREEZE';
  });
}
$$('[data-copy]').forEach((el) => {
  el.addEventListener('click', () => {
    const prev = el.textContent;
    const done = (t: string): void => {
      el.textContent = t;
      window.setTimeout(() => {
        el.textContent = prev;
      }, 1500);
    };
    const val = el.getAttribute('data-copy') ?? '';
    if (typeof navigator.clipboard?.writeText === 'function') {
      navigator.clipboard.writeText(val).then(
        () => {
          done('COPIED ✓');
        },
        () => {
          done('PREVIEW');
        },
      );
    } else {
      done('PREVIEW');
    }
  });
});

/* ── 8a. PROVENANCE — landing hydration ─────────────────────────── */
/* Maps a provider id to the one-line copy shown under its card on the landing
   #built grid. Mirrors PROVIDER_SUMMARY in app-main.ts on purpose; the
   landing must read without an API round-trip if /api/system/providers is
   slow or unreachable. */
/**
 * Inline-SVG token logos for the markets feed. Data URLs keep this self-
 * contained — no CDN dependency. Each glyph: a colored monogram disc that
 * reads as a brand mark at 32px without being a copyright copy of the actual
 * project logo.
 */
/* Official token logos sourced from each protocol's brand page / Simple Icons /
   Wikimedia and saved under /public/integrations/. Hand-rolled monogram discs
   were removed 2026-06-20 — real marks only. */
const TOKEN_LOGOS: Record<string, string> = {
  BTC:   '/integrations/btc.svg',
  ETH:   '/integrations/eth.svg',
  SOL:   '/integrations/sol.svg',
  HYPE:  '/integrations/hype.svg',
};

function tokenLogoFor(symbol: string): string | null {
  const key = symbol.trim().toUpperCase();
  return TOKEN_LOGOS[key] ?? null;
}

/* Provider-demo data used when the live Hyperliquid API is unreachable
   (typical case: visitor browses landing without the API server). The shape
   matches `nexaApi.markets.hyperliquid.list()` so the rendering path is
   identical to the live case. */
interface MockHlMarket { coin: string; priceUsd: number; change24hPct: number }
const MOCK_HL_MARKETS: MockHlMarket[] = [
  { coin: 'BTC',  priceUsd: 96720.50, change24hPct:  2.14 },
  { coin: 'ETH',  priceUsd:  3485.20, change24hPct:  1.42 },
  { coin: 'SOL',  priceUsd:   228.50, change24hPct:  4.21 },
  { coin: 'HYPE', priceUsd:    28.40, change24hPct:  8.73 },
];

interface MockPmMarket { question: string; yesLabel: string; yesPct: number }
const MOCK_PM_MARKETS: MockPmMarket[] = [
  { question: 'Will the Fed cut rates at the March meeting?', yesLabel: 'Yes', yesPct: 64 },
  { question: 'Will BTC close above $100k by end of Q1?',     yesLabel: 'Yes', yesPct: 71 },
  { question: 'Will ETH ETFs see $5B net inflows this quarter?', yesLabel: 'Yes', yesPct: 58 },
];

function renderHlRows(
  host: HTMLElement,
  markets: ReadonlyArray<{ coin: string; priceUsd: number; change24hPct?: number | null }>,
  src: 'live' | 'sandbox' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error',
): void {
  host.textContent = '';
  for (const m of markets.slice(0, 4)) {
    const row = document.createElement('nexa-market-row');
    row.setAttribute('symbol', m.coin);
    row.setAttribute('venue', 'Hyperliquid');
    row.setAttribute('name', `${m.coin} perpetual`);
    row.setAttribute('price', String(m.priceUsd));
    row.setAttribute('currency', 'USD');
    if (m.change24hPct != null) row.setAttribute('change-pct', String(m.change24hPct));
    row.setAttribute('source', src);
    const logo = tokenLogoFor(m.coin);
    if (logo) row.setAttribute('logo-url', logo);
    host.appendChild(row);
  }
}

function renderPmRows(
  host: HTMLElement,
  markets: ReadonlyArray<{ question: string; yesLabel: string; yesPct: number }>,
  src: 'live' | 'sandbox' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error',
): void {
  host.textContent = '';
  for (const m of markets.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'pm-row';
    const q = document.createElement('p');
    q.className = 'pm-q';
    q.textContent = m.question;
    row.appendChild(q);
    const meter = document.createElement('div');
    meter.className = 'pm-meter';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(100, m.yesPct))}%`;
    meter.appendChild(fill);
    row.appendChild(meter);
    const foot = document.createElement('div');
    foot.className = 'pm-foot';
    const top = document.createElement('span');
    top.className = 'pm-top';
    top.textContent = `${m.yesLabel.toUpperCase()} ${Math.round(m.yesPct)}%`;
    foot.appendChild(top);
    if (src !== 'live') {
      const srcEl = document.createElement('span');
      srcEl.className = 'pm-src';
      srcEl.textContent = src === 'cached-live' ? 'CACHED' : src.toUpperCase();
      foot.appendChild(srcEl);
    }
    row.appendChild(foot);
    host.appendChild(row);
  }
}

async function hydrateLandingMarkets(): Promise<void> {
  const hlHost = document.getElementById('landingHlRows');
  const pmHost = document.getElementById('landingPmRows');
  if (!hlHost && !pmHost) return;

  // Hyperliquid — try live, fall back to cached snapshot. Never show "unavailable"
  // copy on the landing; a marketing page that says "unavailable" reads as broken.
  if (hlHost) {
    try {
      const hl = await nexaApi.markets.hyperliquid.list();
      const src = (hl.sourced?.source ?? (hl.source === 'hyperliquid' ? 'live' : 'provider-demo')) as
        | 'live' | 'sandbox' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error';
      if (hl.markets.length > 0) {
        renderHlRows(hlHost, hl.markets, src);
      } else {
        renderHlRows(hlHost, MOCK_HL_MARKETS, 'provider-demo');
      }
    } catch {
      renderHlRows(hlHost, MOCK_HL_MARKETS, 'provider-demo');
    }
  }

  // Polymarket — same pattern.
  if (pmHost) {
    try {
      const pm = await nexaApi.markets.polymarket.list();
      const src = (pm.sourced?.source ?? (pm.source === 'polymarket' ? 'live' : 'provider-demo')) as
        | 'live' | 'sandbox' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error';
      if (pm.markets.length > 0) {
        const liveRows = pm.markets.slice(0, 3).map((m) => {
          const sorted = m.outcomes.slice().sort((a, b) => b.pricePct - a.pricePct);
          return {
            question: m.question,
            yesLabel: sorted[0]?.label ?? 'Yes',
            yesPct: sorted[0]?.pricePct ?? 0,
          };
        });
        renderPmRows(pmHost, liveRows, src);
      } else {
        renderPmRows(pmHost, MOCK_PM_MARKETS, 'provider-demo');
      }
    } catch {
      renderPmRows(pmHost, MOCK_PM_MARKETS, 'provider-demo');
    }
  }
}

const LANDING_EARN_LABELS: Record<string, string> = {
  morpho: 'Morpho · Standard',
  'morpho-high-yield': 'Morpho · High Yield',
  aave: 'Aave v3',
  compound: 'Compound III',
  yousd: 'yoUSD',
  marinade: 'Marinade · SOL',
  ethena: 'Ethena · sUSDe',
};

/** Brand mark per integration. logoUrl points to the official ICON-ONLY
   (square) variant under /public/integrations/{name}-icon.svg, so the 18×18
   legend slot renders properly. Wordmark variants live in the trust strip
   where they have horizontal room. color+letter is a YAGNI fallback. */
const LANDING_EARN_BRANDS: Record<string, { color: string; letter: string; logoUrl: string }> = {
  morpho: { color: '#2e3192', letter: 'M', logoUrl: '/integrations/morpho-icon.svg' },
  'morpho-high-yield': { color: '#5b2cd0', letter: 'M', logoUrl: '/integrations/morpho-icon.svg' },
  aave: { color: '#b6509e', letter: 'A', logoUrl: '/integrations/aave.svg' },
  compound: { color: '#070a0e', letter: 'C', logoUrl: '/integrations/compound-icon.svg' },
  yousd: { color: '#0e7d4a', letter: 'y', logoUrl: '/integrations/yousd.png' },
  marinade: { color: '#14f195', letter: 'm', logoUrl: '/integrations/marinade-icon.svg' },
  ethena: { color: '#101316', letter: 'e', logoUrl: '/integrations/ethena.svg' },
};

function renderLandingYieldFallback(ramp: NexaYieldRamp): void {
  // Keep the public page useful without calling the authenticated earn route.
  ramp.segments = [
    { name: 'Morpho · Standard', apyBps: 323, weight: 323, source: 'provider-demo', logoUrl: '/integrations/morpho-icon.svg' },
    { name: 'Morpho · High Yield', apyBps: 526, weight: 526, source: 'provider-demo', logoUrl: '/integrations/morpho-icon.svg' },
    { name: 'Aave v3', apyBps: 321, weight: 321, source: 'provider-demo', logoUrl: '/integrations/aave.svg' },
    { name: 'Compound III', apyBps: 322, weight: 322, source: 'provider-demo', logoUrl: '/integrations/compound-icon.svg' },
    { name: 'yoUSD', apyBps: 480, weight: 480, source: 'provider-demo', logoUrl: '/integrations/yousd.png' },
    { name: 'Marinade · SOL', apyBps: 607, weight: 607, source: 'provider-demo', logoUrl: '/integrations/marinade-icon.svg' },
    { name: 'Ethena · sUSDe', apyBps: 1800, weight: 1800, source: 'provider-demo', logoUrl: '/integrations/ethena.svg' },
  ];
  ramp.setAttribute('caption', 'Preview snapshot');
}

async function hydrateLandingYieldRamp(): Promise<void> {
  const ramp = document.getElementById('landingYieldRamp') as NexaYieldRamp | null;
  if (!ramp) return;
  if (!getToken()) {
    renderLandingYieldFallback(ramp);
    return;
  }
  try {
    const protocols = await nexaApi.earnProtocols();
    const segments: YieldSegment[] = protocols.adapters
      .filter((p: EarnAdapterSummary) => p.available && p.apyBps > 0)
      .map((p: EarnAdapterSummary) => {
        const source = (p.sourced?.source ?? (p.isLive ? 'live' : 'unavailable')) as YieldSegment['source'];
        const brand = LANDING_EARN_BRANDS[p.name];
        return {
          name: LANDING_EARN_LABELS[p.name] ?? p.name.toUpperCase(),
          apyBps: p.apyBps,
          weight: p.apyBps,
          source,
          fetchedAt: p.sourced?.fetchedAt ?? null,
          docsUrl: p.sourced?.docsUrl,
          ...(brand ? { logoColor: brand.color, logoLetter: brand.letter, logoUrl: brand.logoUrl } : {}),
        };
      });
    ramp.segments = segments;
    if (protocols.blendedApy > 0) ramp.setAttribute('blended-bps', String(protocols.blendedApy));
    const live = segments.filter((s) => s.source === 'live').length;
    ramp.setAttribute(
      'caption',
      segments.length === 0
        ? 'No sources yet'
        : live === segments.length
          ? `${segments.length} of ${segments.length} sources live`
          : `${live} of ${segments.length} sources live`,
    );
  } catch {
    // Fallback to fixture if the API is unreachable, so the landing never shows
    // an empty ramp. Mirko's brand-public number stays the 8.4% claim.
    renderLandingYieldFallback(ramp);
  }
}

void hydrateLandingMarkets();
void hydrateLandingYieldRamp();

/* ── 9. SCROLL REVEAL ───────────────────────────────────────────── */
if (RM) {
  $$('.rev').forEach((el) => {
    el.classList.add('in');
  });
} else {
  const rio = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          rio.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  $$('.rev').forEach((el) => {
    rio.observe(el);
  });
}

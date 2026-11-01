/**
 * <nexa-market-row> — single-line terminal-style row for a market.
 *
 * Used on s27 (Hyperliquid perps + Polymarket events) and on the landing page
 * #markets section to replace the random-walk fixture with the real public
 * read. Pure presentation; data is set via attributes:
 *
 *   <nexa-market-row
 *     symbol="BTC-PERP"
 *     name="Bitcoin perpetual"
 *     price="63240.50"
 *     change-pct="2.1"
 *     venue="Hyperliquid"
 *     source="live"
 *     logo-url="/coins/btc.svg"
 *   ></nexa-market-row>
 *
 * The element exposes a `data-clickable` flag for the host page to wire up
 * drawer hooks. It does NOT itself open a drawer — too many host contexts
 * (table inside a card vs grid inside a section), so the consumer routes the
 * click how it wants.
 *
 * PLANB fluid-UI contract: the shadow DOM is built ONCE (style + node
 * skeleton), attribute changes mark the row dirty and one microtask-batched
 * apply() patches text/attributes in place. The old wipe-and-rebuild render
 * cost ~16 full shadow builds + <style> re-parses per row before first
 * connect; a 176-row Show-all expansion froze mobile for seconds. Styles are
 * shared across all rows via one constructable stylesheet (adoptedStyleSheets)
 * with a per-root <style> fallback for engines without it (jsdom).
 */

import { dotMarkSvgElement } from './nexa-dot-mark.js';

/* Sprint 17 — Avici-style row: square logo + symbol/leverage/volume stack on
   the left, price + 24h change stack on the right. Breathable height (~70px),
   no density creep. */
const STYLE = /* css */ `
  :host {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 2px;
    border-top: 1px solid var(--border, rgba(10,10,12,.06));
    font-family: var(--sans, system-ui);
    color: var(--fg, #090a0c);
    min-height: 70px;
    transition: background .15s var(--ease, ease);
  }
  :host(:first-of-type) { border-top: 0; }
  :host([data-clickable]) { cursor: pointer; }
  :host([data-clickable]:hover) {
    background: color-mix(in oklab, var(--fg, #090a0c) 3%, transparent);
  }

  .logo {
    width: 46px;
    height: 46px;
    border-radius: 12px;
    border: 1px solid var(--border, rgba(10,10,12,.09));
    background: var(--surface-2, #f8f9fb);
    display: grid;
    place-items: center;
    overflow: hidden;
    flex: 0 0 auto;
  }
  .logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .logo-fallback {
    position: relative;
    width: 100%; height: 100%; display: grid; place-items: center;
    font-family: var(--mono, ui-monospace);
    font-weight: 700;
    font-size: 13px;
    color: #fff;
    letter-spacing: 0;
    background: var(--logo-fallback-bg, #4f535c);
  }
  /* Deterministic dot-matrix identity behind the ticker letter: same seed,
     same mark, so a logo-less coin is still recognizable at a glance. */
  .logo-fallback svg { position: absolute; inset: 4px; width: auto; height: auto; opacity: .5; }
  .logo-fallback .glyph { position: relative; }

  /* Left stack: symbol+chip on top, volume below. */
  .body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
  .top { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .sym {
    font-family: var(--sans, system-ui);
    font-size: 15.5px;
    font-weight: 600;
    letter-spacing: -.01em;
    color: var(--fg, #090a0c);
    line-height: 1.1;
    flex: 0 0 auto;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 100%;
  }
  .lev-chip {
    font-family: var(--mono, ui-monospace);
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 5px;
    background: color-mix(in oklab, var(--accent, #FF6A1A) 18%, transparent);
    color: var(--accent, #FF6A1A);
    flex: 0 0 auto;
    letter-spacing: 0;
    line-height: 1.4;
  }
  .tag-chip {
    font-family: var(--mono, ui-monospace);
    font-size: 9.5px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 5px;
    background: color-mix(in oklab, var(--fg, #090a0c) 8%, transparent);
    color: var(--meta, #4f535c);
    text-transform: uppercase;
    letter-spacing: .04em;
    flex: 0 0 auto;
    line-height: 1.4;
  }
  .src {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--mono, ui-monospace);
    font-size: 9.5px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 5px;
    background: color-mix(in oklab, var(--fg, #090a0c) 8%, transparent);
    color: var(--meta, #4f535c);
    text-transform: uppercase;
    letter-spacing: .04em;
    flex: 0 0 auto;
    line-height: 1.4;
  }
  .src .dot {
    width: 5px;
    height: 5px;
    border-radius: 999px;
    background: currentColor;
  }
  .vol {
    font-family: var(--sans, system-ui);
    font-size: 12px;
    color: var(--muted, #4f535c);
    line-height: 1.2;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Right stack: price on top, change% below. */
  .right { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: 0 0 auto; min-width: 84px; }
  .price {
    font-family: var(--mono, ui-monospace);
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--fg, #090a0c);
    line-height: 1.1;
  }
  .chg {
    font-family: var(--mono, ui-monospace);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--meta, #8a8d96);
    line-height: 1.1;
  }
  .chg[data-dir="up"]   { color: var(--success, #18a957); }
  .chg[data-dir="down"] { color: var(--danger, #e5484d); }

  @media (max-width: 380px) {
    :host { gap: 10px; min-height: 64px; padding: 11px 0; }
    .logo { width: 42px; height: 42px; border-radius: 11px; }
    .logo-fallback { font-size: 12px; }
    .sym { font-size: 14.5px; }
    .vol { font-size: 11.5px; }
    .price { font-size: 13px; }
    .chg { font-size: 10.5px; }
    .right { min-width: 72px; }
  }
`;

/* One shared stylesheet for every row instance. jsdom (vitest) has no
   constructable CSSStyleSheet — those roots get a per-root <style> clone. */
let sharedRowSheet: CSSStyleSheet | null | undefined;
function attachRowStyle(root: ShadowRoot): void {
  if (sharedRowSheet === undefined) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      sharedRowSheet = sheet;
    } catch {
      sharedRowSheet = null;
    }
  }
  if (sharedRowSheet) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedRowSheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);
}

function fallbackInitials(symbol: string, name: string): string {
  const raw = (symbol || name || '?').trim().toUpperCase();
  if (!raw) return '?';
  return raw.match(/[A-Z0-9]/)?.[0] ?? '?';
}

function sourceLabel(source: string | null): string {
  if (!source || source === 'live') return '';
  if (source === 'cached-live') return 'Cached';
  if (source === 'provider-demo') return 'Demo';
  if (source === 'sandbox') return 'Sandbox';
  if (source === 'error') return 'Error';
  return 'Unavailable';
}

/* Deterministic hue from the symbol string so each fallback chip gets its
   own consistent color (and BTC always looks like BTC even when the real
   logo 404s). Saturation and lightness fixed so all chips read together. */
function fallbackColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 38%)`;
}

function formatPrice(input: string | null, currency: string | null, label?: string | null): string {
  if (label?.trim()) return label.trim();
  if (!input) return '·';
  const n = Number(input);
  if (!Number.isFinite(n)) return input;
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '';
  if (n >= 1000) return `${symbol}${Math.trunc(n).toLocaleString('en-US')}`;
  if (n >= 1) return `${symbol}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${symbol}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function formatPct(input: string | null, label?: string | null): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (label?.trim()) return { text: label.trim(), dir: 'flat' };
  if (input == null || input === '') return { text: '', dir: 'flat' };
  const n = Number(input);
  if (!Number.isFinite(n)) return { text: input, dir: 'flat' };
  if (n > 0) return { text: `+${n.toFixed(2)}%`, dir: 'up' };
  if (n < 0) return { text: `${n.toFixed(2)}%`, dir: 'down' };
  return { text: '0.00%', dir: 'flat' };
}

function setText(el: HTMLElement, next: string): void {
  if (el.textContent !== next) el.textContent = next;
}

export class NexaMarketRow extends HTMLElement {
  static observedAttributes = [
    'symbol',
    'name',
    'venue',
    'logo-url',
    'thumbnail-url',
    'max-leverage',
    'tag-label',
    'volume-label',
    'price',
    'price-label',
    'currency',
    'change-pct',
    'change-label',
    'source',
    'variant',
  ] as const;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    // Keyed-reconcile moves re-fire connectedCallback; build stays one-shot.
    this.build();
    this.scheduleApply();
  }

  attributeChangedCallback(): void {
    // Pre-connect attribute writes are free: build+apply happen on connect.
    if (!this.built) return;
    this.scheduleApply();
  }

  private built = false;
  private applyQueued = false;
  private kbdWired = false;

  private logoEl!: HTMLSpanElement;
  private topEl!: HTMLDivElement;
  private symEl!: HTMLSpanElement;
  private volEl!: HTMLSpanElement;
  private priceEl!: HTMLSpanElement;
  private chgEl!: HTMLSpanElement;
  private chipEl: HTMLSpanElement | null = null;
  private chipKind: 'lev' | 'tag' | null = null;
  private srcEl: HTMLSpanElement | null = null;
  private srcTextNode: Text | null = null;
  private imgEl: HTMLImageElement | null = null;
  private fallbackEl: HTMLSpanElement | null = null;
  private fallbackGlyph: HTMLSpanElement | null = null;
  private fallbackSeed: string | null = null;
  private appliedLogoUrl: string | null = null;
  private logoFailed = false;

  private build(): void {
    if (this.built) return;
    const root = this.shadowRoot;
    if (!root) return;
    attachRowStyle(root);

    this.logoEl = document.createElement('span');
    this.logoEl.className = 'logo';
    this.logoEl.setAttribute('aria-hidden', 'true');
    root.appendChild(this.logoEl);

    const body = document.createElement('div');
    body.className = 'body';
    this.topEl = document.createElement('div');
    this.topEl.className = 'top';
    this.symEl = document.createElement('span');
    this.symEl.className = 'sym';
    this.topEl.appendChild(this.symEl);
    body.appendChild(this.topEl);
    this.volEl = document.createElement('span');
    this.volEl.className = 'vol';
    body.appendChild(this.volEl);
    root.appendChild(body);

    const right = document.createElement('div');
    right.className = 'right';
    this.priceEl = document.createElement('span');
    this.priceEl.className = 'price';
    right.appendChild(this.priceEl);
    this.chgEl = document.createElement('span');
    this.chgEl.className = 'chg';
    right.appendChild(this.chgEl);
    root.appendChild(right);

    this.built = true;
  }

  private scheduleApply(): void {
    if (this.applyQueued) return;
    this.applyQueued = true;
    queueMicrotask(() => {
      this.applyQueued = false;
      this.apply();
    });
  }

  private apply(): void {
    if (!this.built) return;

    const symbol = this.getAttribute('symbol') ?? '';
    const name = this.getAttribute('name') ?? '';
    const venue = this.getAttribute('venue') ?? '';
    const logoUrl = this.getAttribute('logo-url') ?? this.getAttribute('thumbnail-url');
    const maxLev = this.getAttribute('max-leverage');
    const tagLabel = this.getAttribute('tag-label');
    const volumeLabel = this.getAttribute('volume-label');
    const priceStr = this.getAttribute('price');
    const priceLabel = this.getAttribute('price-label');
    const currency = this.getAttribute('currency');
    const chgRaw = this.getAttribute('change-pct');
    const chgLabel = this.getAttribute('change-label');
    const srcLabel = sourceLabel(this.getAttribute('source'));

    this.applyLogo(logoUrl, symbol, name);
    setText(this.symEl, symbol);
    this.applyChip(maxLev, tagLabel);
    this.applySrc(srcLabel);
    setText(this.volEl, [venue, volumeLabel?.trim() ? `Vol ${volumeLabel.trim()}` : ''].filter(Boolean).join(' | '));

    const priceText = formatPrice(priceStr, currency, priceLabel);
    setText(this.priceEl, priceText);
    const formattedChg = formatPct(chgRaw, chgLabel);
    setText(this.chgEl, formattedChg.text);
    if (this.chgEl.dataset['dir'] !== formattedChg.dir) this.chgEl.dataset['dir'] = formattedChg.dir;

    this.setAttribute(
      'aria-label',
      `${symbol}${name ? `, ${name}` : ''}${maxLev ? `, ${maxLev}x leverage` : ''}${volumeLabel ? `, volume ${volumeLabel}` : ''}, ${priceText}${formattedChg.text ? `, ${formattedChg.text}` : ''}${venue ? ` on ${venue}` : ''}`,
    );
    if (this.hasAttribute('data-clickable')) {
      this.setAttribute('role', 'button');
      if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
      if (!this.kbdWired) {
        this.addEventListener('keydown', this.onKeyActivate);
        this.kbdWired = true;
      }
    } else {
      this.setAttribute('role', 'group');
      this.removeAttribute('tabindex');
    }
  }

  /** Logo slot: <img> while a URL is set and loading works, letter fallback
      otherwise. src is only touched when the URL actually changes so applies
      never re-trigger image loads. */
  private applyLogo(logoUrl: string | null, symbol: string, name: string): void {
    if (logoUrl !== this.appliedLogoUrl) {
      this.appliedLogoUrl = logoUrl;
      this.logoFailed = false;
      if (logoUrl) {
        if (!this.imgEl) {
          this.imgEl = document.createElement('img');
          this.imgEl.alt = '';
          this.imgEl.loading = 'lazy';
          this.imgEl.setAttribute('loading', 'lazy');
          this.imgEl.decoding = 'async';
          this.imgEl.addEventListener('error', () => {
            this.logoFailed = true;
            this.scheduleApply();
          });
        }
        this.imgEl.src = logoUrl;
      }
    }
    const wantImg = Boolean(logoUrl) && !this.logoFailed;
    if (wantImg && this.imgEl) {
      this.fallbackEl?.remove();
      if (this.imgEl.parentNode !== this.logoEl) this.logoEl.appendChild(this.imgEl);
      return;
    }
    this.imgEl?.remove();
    const seed = symbol || name || '?';
    if (!this.fallbackEl) {
      this.fallbackEl = document.createElement('span');
      this.fallbackEl.className = 'logo-fallback';
      this.fallbackGlyph = document.createElement('span');
      this.fallbackGlyph.className = 'glyph';
      this.fallbackEl.appendChild(this.fallbackGlyph);
    }
    this.fallbackEl.style.setProperty('--logo-fallback-bg', fallbackColor(seed));
    if (seed !== this.fallbackSeed) {
      this.fallbackSeed = seed;
      this.fallbackEl.querySelector('svg')?.remove();
      this.fallbackEl.insertBefore(dotMarkSvgElement(seed, 'rgba(255,255,255,.55)'), this.fallbackGlyph);
    }
    if (this.fallbackGlyph) setText(this.fallbackGlyph, fallbackInitials(symbol, name));
    if (this.fallbackEl.parentNode !== this.logoEl) this.logoEl.appendChild(this.fallbackEl);
  }

  /** One chip slot next to the symbol: leverage chip wins, tag chip second,
      nothing otherwise (matches the original render precedence). */
  private applyChip(maxLev: string | null, tagLabel: string | null): void {
    const kind: 'lev' | 'tag' | null =
      maxLev && maxLev !== '0' ? 'lev' : tagLabel?.trim() ? 'tag' : null;
    if (!kind) {
      this.chipEl?.remove();
      this.chipEl = null;
      this.chipKind = null;
      return;
    }
    if (!this.chipEl || this.chipKind !== kind) {
      this.chipEl?.remove();
      this.chipEl = document.createElement('span');
      this.chipEl.className = kind === 'lev' ? 'lev-chip' : 'tag-chip';
      this.chipKind = kind;
      // Chip sits between the symbol and the source badge.
      this.topEl.insertBefore(this.chipEl, this.srcEl);
    }
    setText(this.chipEl, kind === 'lev' ? `${maxLev}x` : (tagLabel as string).trim());
  }

  /** Source badge slot — absent entirely for live rows. */
  private applySrc(srcLabel: string): void {
    if (!srcLabel) {
      this.srcEl?.remove();
      this.srcEl = null;
      this.srcTextNode = null;
      return;
    }
    if (!this.srcEl) {
      this.srcEl = document.createElement('span');
      this.srcEl.className = 'src';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      this.srcEl.appendChild(dot);
      this.srcTextNode = document.createTextNode('');
      this.srcEl.appendChild(this.srcTextNode);
      this.topEl.appendChild(this.srcEl);
    }
    if (this.srcTextNode && this.srcTextNode.data !== srcLabel) this.srcTextNode.data = srcLabel;
  }

  private onKeyActivate = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.click();
    }
  };

  /** Patch the price text in place. Skips the attribute so observedAttributes
      doesn't trigger a full apply (which would recompute from the stale
      REST-snapshot attribute and flicker). */
  updatePrice(next: number | string): void {
    if (!this.built) return;
    const currency = this.getAttribute('currency');
    setText(this.priceEl, formatPrice(typeof next === 'number' ? String(next) : next, currency, null));
  }
}

if (!customElements.get('nexa-market-row')) {
  customElements.define('nexa-market-row', NexaMarketRow);
}

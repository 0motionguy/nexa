/**
 * <region-pill> — small chip that surfaces whether the markets surface is
 * available in the user's region. Server is authoritative (POSTs return 451
 * region_blocked), this is presentational only.
 *
 * Attributes:
 *   country="US"     ISO-3166 alpha-2; falls back to localStorage["maze.region"]
 *
 * The blocked set is kept in sync by hand with
 * apps/api/src/lib/markets/polymarket.ts POLY_BLOCKED. Any drift only affects
 * the UI — the route layer still enforces the canonical list.
 */

const BLOCKED: ReadonlySet<string> = new Set([
  'US', 'GB', 'DE', 'FR', 'IT', 'JP', 'SG', 'AU', 'BE', 'PL', 'RU', 'IR', 'KP',
]);

/** Read the configured region, defaulting to the localStorage hint, else '??' (allowed). */
export function regionFromStorage(): string {
  try {
    const stored = (window.localStorage.getItem('maze.region') ?? '').trim().toUpperCase();
    if (stored) return stored;
  } catch {
    /* private mode — fall through */
  }
  return '??';
}

export function isRegionBlocked(country: string | null | undefined): boolean {
  if (!country) return false;
  const c = country.trim().toUpperCase();
  if (c === '' || c === '??') return false;
  return BLOCKED.has(c);
}

const STYLE = /* css */ `
  :host {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    letter-spacing: .06em;
    text-transform: uppercase;
    padding: 4px 9px;
    border-radius: 999px;
    border: 1px solid var(--border, rgba(0,0,0,0.15));
    background: var(--surface, transparent);
  }
  :host([blocked]) {
    color: var(--danger, #c44);
    border-color: color-mix(in oklab, var(--danger, #c44) 35%, transparent);
    background: color-mix(in oklab, var(--danger, #c44) 8%, transparent);
  }
  :host(:not([blocked])) {
    color: var(--success, #2a8);
    border-color: color-mix(in oklab, var(--success, #2a8) 35%, transparent);
    background: color-mix(in oklab, var(--success, #2a8) 8%, transparent);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: currentColor;
  }
`;

export class RegionPill extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['country'];
  }

  private shadow: ShadowRoot;
  private labelEl: HTMLSpanElement;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const dot = document.createElement('span');
    dot.className = 'dot';
    this.labelEl = document.createElement('span');
    this.shadow.append(style, dot, this.labelEl);
  }

  connectedCallback(): void {
    if (!this.hasAttribute('country')) {
      this.setAttribute('country', regionFromStorage());
    } else {
      this.render();
    }
  }

  attributeChangedCallback(): void {
    this.render();
  }

  private render(): void {
    const country = (this.getAttribute('country') ?? '').trim().toUpperCase();
    const blocked = isRegionBlocked(country);
    if (blocked) this.setAttribute('blocked', '');
    else this.removeAttribute('blocked');
    const known = country && country !== '??';
    this.labelEl.textContent = blocked
      ? `Not available · ${country}`
      : known
        ? `Available · ${country}`
        : 'Available';
    this.setAttribute('aria-label', this.labelEl.textContent);
  }
}

if (!customElements.get('region-pill')) {
  customElements.define('region-pill', RegionPill);
}

/**
 * <nexa-provider-card> — the molecule of MAZE's provenance design pattern.
 *
 * Renders one vendor as a card the user can scan: name, category chip, status
 * pill (live / docs-only / missing-keys / sandbox / gated / disabled),
 * one-liner summary, freshness, docs link. On `status="live"` the card carries
 * the same accent-edge halo + dot-pulse rhythm as <nexa-source-badge> so a row
 * of cards reads as a single living surface.
 *
 * Attributes:
 *   provider     identifier (e.g. "morpho-standard") used for the drawer hook
 *   name         display name ("Morpho · Standard")
 *   category     "defi-yield" | "onramp" | "auth" ...  (free-form, lower-kebab)
 *   status       "live" | "sandbox" | "gated" | "docs-only" | "missing-keys" | "disabled"
 *   docs-url     official docs link, opens in new tab
 *   last-fetch   ISO timestamp the data was last freshed (live cards only)
 *   summary      one-line explainer of what we read from this provider
 *   variant      "default" (full card) | "compact" (1-line strip)
 *
 * Used by:
 *   s28 transparency hub provider grid
 *   landing #built provider grid
 *   developers.html provider ecosystem
 *   <nexa-provenance-drawer> as the hero of the drawer
 */

const CATEGORY_LABEL: Record<string, string> = {
  wallet: 'Wallet',
  auth: 'Auth',
  kyc: 'KYC',
  onramp: 'Onramp',
  offramp: 'Offramp',
  stablecoin: 'Stablecoin',
  swap: 'Swap',
  'defi-yield': 'DeFi yield',
  card: 'Card',
  'agent-wallet': 'Agent wallet',
  x402: 'x402',
  markets: 'Markets',
  'tokenized-stocks': 'Tokenized stocks',
  observability: 'Observability',
  email: 'Email',
  persistence: 'Persistence',
};

const STATUS_LABEL: Record<string, string> = {
  live: 'LIVE',
  sandbox: 'SANDBOX',
  gated: 'GATED',
  'docs-only': 'DOCS ONLY',
  'missing-keys': 'MISSING KEYS',
  disabled: 'DISABLED',
};

/* Sprint 16.1 design pass — adopt the shared .card chrome (16px padding,
   var(--r-lg) radius, var(--sh-soft) shadow, var(--border) hairline) and
   re-use .tag-style pills + .lrow type scale so the registry grid reads
   as a natural extension of the rest of the app. */
const STYLE = /* css */ `
  :host {
    display: block;
    position: relative;
    padding: 16px;
    border: 1px solid var(--border, rgba(10,10,12,.09));
    border-radius: var(--r-lg, 22px);
    background: var(--surface, #fff);
    box-shadow: var(--sh-soft, 0 10px 40px rgba(10,10,12,.08));
    color: var(--fg, #090a0c);
    font-family: var(--sans, system-ui);
    transition: border-color .18s var(--ease, ease), transform .12s var(--ease, ease);
    isolation: isolate;
    cursor: default;
  }
  :host([data-clickable]) { cursor: pointer; }
  :host([data-clickable]:hover) {
    transform: translateY(-1px);
    border-color: var(--border-md, rgba(10,10,12,.16));
  }
  :host([status="live"]) {
    border-color: color-mix(in oklab, var(--accent-edge, var(--accent, #ff6a1a)) 60%, transparent);
  }
  :host([status="docs-only"]) { border-style: dashed; opacity: .9; }
  :host([status="missing-keys"]) { opacity: .65; }
  :host([status="disabled"]) { opacity: .45; }
  :host([variant="compact"]) {
    padding: 12px 14px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  /* Name uses .lrow .t scale exactly: 13.5px, weight 500, no tracking.
     Sans, not mono — provider names are proper nouns, not values. */
  .name {
    font-size: 13.5px;
    font-weight: 500;
    line-height: 1.25;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .meta-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  /* Category chip + status pill both adopt .tag styling (4px 11px, 10px,
     .08em). No background fill — keeps them quiet next to the name. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--mono, ui-monospace);
    font-size: 10px;
    letter-spacing: .08em;
    text-transform: uppercase;
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid var(--border-md, rgba(10,10,12,.16));
    color: var(--meta, #8a8d96);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--mono, ui-monospace);
    font-size: 10px;
    letter-spacing: .08em;
    text-transform: uppercase;
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid currentColor;
    color: var(--meta, #8a8d96);
    flex: none;
  }
  .pill .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
  :host([status="live"]) .pill {
    color: var(--accent, #ff6a1a);
    border-color: color-mix(in oklab, var(--accent, #ff6a1a) 45%, transparent);
  }
  :host([status="live"]) .pill .dot {
    animation: pulse 1.6s ease-in-out infinite;
  }
  :host([status="sandbox"]) .pill { color: var(--sandbox, #5a9ff0); border-color: color-mix(in oklab, var(--sandbox, #5a9ff0) 60%, transparent); }
  :host([status="gated"]) .pill,
  :host([status="docs-only"]) .pill,
  :host([status="missing-keys"]) .pill {
    color: var(--warn, #f5a524);
    border-color: color-mix(in oklab, var(--warn, #f5a524) 50%, transparent);
  }

  /* Summary matches the .sub scale (13px / 1.45) used across the app. */
  .summary {
    font-size: 13px;
    line-height: 1.5;
    margin: 10px 0 0;
    color: var(--muted, #4f535c);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border, rgba(10,10,12,.06));
  }
  /* Mono caption + docs link match the .s sub-line on .lrow. */
  .ts, .docs {
    font-family: var(--mono, ui-monospace);
    font-size: 10px;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .ts { color: var(--meta, #8a8d96); }
  .docs {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted color-mix(in oklab, currentColor 45%, transparent);
    padding-bottom: 1px;
  }
  .docs:hover, .docs:focus-visible {
    border-bottom-color: currentColor;
    outline: none;
  }

  :host([variant="compact"]) .summary,
  :host([variant="compact"]) .foot,
  :host([variant="compact"]) .meta-row .chip {
    display: none;
  }
  :host([variant="compact"]) .head { flex: 1; align-items: center; }
  :host([variant="compact"]) .meta-row { margin: 0; }

  @media (prefers-reduced-motion: reduce) {
    :host([status="live"]) .pill .dot { animation: none; }
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50%      { transform: scale(1.35); opacity: .6; }
  }
`;

function formatAge(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return 'just now';
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  // "min", not "m" — uppercased contexts turn "6M AGO" into months.
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export class NexaProviderCard extends HTMLElement {
  static observedAttributes = [
    'provider',
    'name',
    'category',
    'status',
    'docs-url',
    'last-fetch',
    'summary',
    'variant',
  ] as const;

  private timer: ReturnType<typeof setInterval> | null = null;
  private tsEl: HTMLElement | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    // Refresh only the relative-time span every 30s. Re-rendering the whole
    // shadow tree would wipe any focus inside (the docs link) and re-emit
    // status to screen readers; updating one text node is invisible.
    this.timer = setInterval(() => this.refreshAge(), 30_000);
  }

  disconnectedCallback(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tsEl = null;
  }

  attributeChangedCallback(): void {
    if (this.shadowRoot) this.render();
  }

  private refreshAge(): void {
    if (!this.tsEl) return;
    const lastFetch = this.getAttribute('last-fetch');
    const status = this.getAttribute('status') ?? 'docs-only';
    const age = formatAge(lastFetch);
    if (status === 'live' && age) this.tsEl.textContent = `Updated ${age}`;
    else if (status === 'sandbox' && age) this.tsEl.textContent = `Sandbox · ${age}`;
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const status = this.getAttribute('status') ?? 'docs-only';
    const name = this.getAttribute('name') ?? this.getAttribute('provider') ?? 'Provider';
    const category = this.getAttribute('category') ?? '';
    const docsUrl = this.getAttribute('docs-url');
    const lastFetch = this.getAttribute('last-fetch');
    const summary = this.getAttribute('summary') ?? '';

    root.textContent = '';
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const head = document.createElement('div');
    head.className = 'head';
    const nameEl = document.createElement('h3');
    nameEl.className = 'name';
    nameEl.textContent = name;
    head.appendChild(nameEl);

    const pill = document.createElement('span');
    pill.className = 'pill';
    const dot = document.createElement('span');
    dot.className = 'dot';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(STATUS_LABEL[status] ?? status.toUpperCase()));
    head.appendChild(pill);
    root.appendChild(head);

    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';
    if (category) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = CATEGORY_LABEL[category] ?? category.replace(/-/g, ' ');
      metaRow.appendChild(chip);
    }
    root.appendChild(metaRow);

    if (summary) {
      const p = document.createElement('p');
      p.className = 'summary';
      p.textContent = summary;
      root.appendChild(p);
    }

    const foot = document.createElement('div');
    foot.className = 'foot';
    const ts = document.createElement('span');
    ts.className = 'ts';
    const age = formatAge(lastFetch);
    if (status === 'live' && age) {
      ts.textContent = `Updated ${age}`;
    } else if (status === 'missing-keys') {
      ts.textContent = 'Awaiting credentials';
    } else if (status === 'docs-only') {
      ts.textContent = 'Scaffolded · not live';
    } else if (status === 'gated') {
      ts.textContent = 'Trading gated';
    } else if (status === 'sandbox') {
      ts.textContent = age ? `Sandbox · ${age}` : 'Sandbox';
    } else {
      ts.textContent = 'Disabled';
    }
    foot.appendChild(ts);
    this.tsEl = ts;
    if (docsUrl) {
      const a = document.createElement('a');
      a.className = 'docs';
      a.href = docsUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Docs ↗';
      a.setAttribute('aria-label', `Open ${name} docs in a new tab`);
      foot.appendChild(a);
    }
    root.appendChild(foot);

    const drawer = this.getAttribute('drawer-target');
    if (drawer) {
      this.dataset['clickable'] = '';
      // Keyboard activation: make the host tabbable, respond to Enter/Space.
      // The role=button is set below; without these the card was mouse-only.
      if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
      if (!this.kbdWired) {
        this.addEventListener('keydown', this.onKeyActivate);
        this.kbdWired = true;
      }
    } else {
      delete this.dataset['clickable'];
      this.removeAttribute('tabindex');
    }
    this.setAttribute(
      'aria-label',
      [name, STATUS_LABEL[status] ?? status, CATEGORY_LABEL[category] ?? category, summary].filter(Boolean).join(' · '),
    );
    this.setAttribute('role', this.hasAttribute('drawer-target') ? 'button' : 'group');
  }

  private kbdWired = false;
  private onKeyActivate = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.click();
    }
  };
}

if (!customElements.get('nexa-provider-card')) {
  customElements.define('nexa-provider-card', NexaProviderCard);
}

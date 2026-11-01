/**
 * <nexa-source-badge> — compact "Live · Provider · Xs ago" affordance.
 *
 * Sprint 15 — every financial value in the PWA carries an inline badge so the
 * user can always answer "who provided this number, and when". Reads attributes
 * (source / provider / fetched-at / docs-url / error-code / error-message) and
 * renders one of:
 *
 *   Live · Morpho · 12s ago
 *   Sandbox · Bridge · 1m ago
 *   Cached · Aave · 4m ago
 *   Unavailable · Aave · Docs
 *   Demo · DEMO MODE
 *   Error · Socket · rpc_failed
 *
 * The provider, source, and timestamp pieces are separated by U+00B7 (middle
 * dot), matching `nexa-taste-skill-rules` Rule 1 (zero em-dashes anywhere in
 * user-visible copy). The accent halo on `source="live"` matches
 * `dark-theme-pattern` Rule 10 (functional state only, no decoration).
 */

const STYLE = /* css */ `
  :host {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.4;
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--fg-soft, var(--fg));
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    transition: background .15s var(--ease, ease), border-color .15s var(--ease, ease);
  }

  :host([source="live"]) {
    color: var(--fg);
    border-color: color-mix(in oklab, var(--accent-edge, var(--accent)) 65%, transparent);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 14%, transparent);
  }

  :host([source="live"]) .dot {
    background: var(--accent);
    animation: pulse 1.6s ease-in-out infinite;
  }

  :host([source="sandbox"]) .dot {
    background: #6FB4FF;
  }

  :host([source="cached-live"]) .dot {
    background: var(--fg-soft, var(--fg));
    opacity: .55;
  }

  :host([source="provider-demo"]) {
    background: var(--surface-2, var(--surface));
    border-style: dashed;
  }

  :host([source="provider-demo"]) .dot {
    background: var(--fg-soft, var(--fg));
    opacity: .5;
  }

  :host([source="unavailable"]) {
    color: var(--fg);
    border-color: var(--border);
  }

  :host([source="unavailable"]) .dot,
  :host([source="error"]) .dot {
    background: #C44545;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
  }

  .sep {
    opacity: .55;
  }

  .label {
    font-weight: 600;
  }

  .provider {
    opacity: .9;
  }

  .ts,
  .reason {
    opacity: .7;
  }

  a {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted color-mix(in oklab, currentColor 50%, transparent);
    padding-bottom: 1px;
  }

  a:hover,
  a:focus-visible {
    border-bottom-color: currentColor;
    outline: none;
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--accent) 35%, transparent); }
    50%      { box-shadow: 0 0 0 4px color-mix(in oklab, var(--accent) 6%,  transparent); }
  }
`;

type SourceKind =
  | 'live'
  | 'sandbox'
  | 'cached-live'
  | 'provider-demo'
  | 'unavailable'
  | 'error';

const LABEL: Record<SourceKind, string> = {
  live: 'Live',
  sandbox: 'Sandbox',
  'cached-live': 'Cached',
  'provider-demo': 'Demo',
  unavailable: 'Unavailable',
  error: 'Error',
};

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return 'just now';
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  // "min", not "m" — the badge uppercases its text and "6M AGO" reads as months.
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export class NexaSourceBadge extends HTMLElement {
  static observedAttributes = [
    'source',
    'provider',
    'fetched-at',
    'docs-url',
    'error-code',
    'error-message',
  ] as const;

  private timer: ReturnType<typeof setInterval> | null = null;
  private tsEl: HTMLElement | null = null;
  private lastTsText = '';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    // Sprint 16.3 — refresh ONLY the timestamp span. The previous version
    // wiped the entire shadow tree every 15s, which:
    //   1. re-emitted role=status / aria-label to screen readers every tick
    //      ("Live · Morpho · 12s ago" announced every 15 seconds, forever)
    //   2. would have wiped focus inside a focused docs link
    // Now we update the relative-time text only when the string actually
    // changes (e.g. "12s ago" → "27s ago" → "1m ago").
    this.timer = setInterval(() => this.refreshAge(), 15000);
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
    const fetchedAt = this.getAttribute('fetched-at');
    const relative = formatRelative(fetchedAt);
    if (!relative) return;
    if (relative !== this.lastTsText) {
      this.tsEl.textContent = relative;
      this.lastTsText = relative;
    }
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const sourceAttr = (this.getAttribute('source') ?? 'unavailable') as SourceKind;
    const source: SourceKind = LABEL[sourceAttr] ? sourceAttr : 'unavailable';
    const provider = this.getAttribute('provider') ?? '';
    const fetchedAt = this.getAttribute('fetched-at');
    const docsUrl = this.getAttribute('docs-url');
    const errorCode = this.getAttribute('error-code');

    root.textContent = '';
    this.tsEl = null;
    this.lastTsText = '';

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    root.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = LABEL[source];
    root.appendChild(label);

    const append = (cls: string, text: string): HTMLSpanElement => {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      root.appendChild(sep);
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      root.appendChild(span);
      return span;
    };

    if (provider) {
      append('provider', provider);
    }

    const relative = formatRelative(fetchedAt);
    if (source === 'live' || source === 'sandbox' || source === 'cached-live') {
      if (relative) {
        // Track the ts span so refreshAge() can update just its text content
        // every 15s without rebuilding the shadow tree.
        this.tsEl = append('ts', relative);
        this.lastTsText = relative;
      }
    }

    if (source === 'unavailable' || source === 'error') {
      if (errorCode) append('reason', errorCode.replace(/_/g, ' '));
    }

    if (docsUrl) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      root.appendChild(sep);
      const link = document.createElement('a');
      link.href = docsUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Docs';
      root.appendChild(link);
    }

    // ARIA — aria-label is sufficient for screen readers to inspect on demand.
    // We deliberately do NOT set role=status (which would make every
    // attribute change emit a polite-region announcement on every page that
    // hosts a badge). The badge is decorative+informational, not live news.
    const sentence = [LABEL[source], provider, relative, errorCode]
      .filter(Boolean)
      .join(' · ');
    this.setAttribute('aria-label', sentence);
  }
}

if (!customElements.get('nexa-source-badge')) {
  customElements.define('nexa-source-badge', NexaSourceBadge);
}

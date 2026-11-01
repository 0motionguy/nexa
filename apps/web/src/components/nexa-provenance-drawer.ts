/**
 * <nexa-provenance-drawer> — slide-up sheet showing the full provider story.
 *
 * Opens when any source badge or provider card is tapped. The host page wires
 * the click handler and calls `.open({ provider, name, ... })`; the drawer
 * mounts itself into <body> on first use and traps focus while visible.
 *
 *   const drawer = ensureProvenanceDrawer();
 *   drawer.open({
 *     provider: 'morpho-standard',
 *     name: 'Morpho · Standard',
 *     category: 'defi-yield',
 *     status: 'live',
 *     summary: 'Steakhouse-curated USDC vault on Base.',
 *     docsUrl: 'https://docs.morpho.org',
 *     endpoint: 'Morpho V1 GraphQL · vaultByAddress.state.netApy',
 *     fetchedAt: '2026-06-17T15:42:18Z',
 *     metric: '3.23% APY',
 *   });
 */

import './nexa-source-badge.js';

export interface ProvenanceInfo {
  provider: string;
  name: string;
  category?: string | undefined;
  status: 'live' | 'sandbox' | 'gated' | 'docs-only' | 'missing-keys' | 'disabled' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error';
  summary?: string | undefined;
  docsUrl?: string | undefined;
  endpoint?: string | undefined;
  fetchedAt?: string | null | undefined;
  metric?: string | undefined;
  notes?: string | undefined;
}

/* Sprint 16.1 design pass — adopt the existing .ovl/.sheet rhythm so the
   drawer doesn't look like a foreign component. Same 28px radius, 8px insets,
   --sh-card shadow, --scrim scrim. The metric pop is reduced from clamp 28-42px
   down to the .bignum 32px scale. Padding mirrors .sheet exactly. */
const STYLE = /* css */ `
  :host {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: none;
    pointer-events: none;
  }
  :host([open]) {
    display: block;
    pointer-events: auto;
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim, rgba(10,10,12,.44));
    opacity: 0;
    transition: opacity .22s var(--ease, cubic-bezier(.2,.65,.25,1));
  }
  :host([open]) .scrim { opacity: 1; }

  .sheet {
    position: absolute;
    bottom: 8px;
    left: 8px;
    right: 8px;
    max-height: 78vh;
    overflow-y: auto;
    background: var(--surface, #fff);
    color: var(--fg, #090a0c);
    border: 1px solid var(--border, rgba(10,10,12,.09));
    border-radius: var(--r-lg, 22px);
    padding: 20px 20px 24px;
    transform: translateY(30px);
    opacity: 0;
    transition: transform .28s var(--ease, cubic-bezier(.2,.65,.25,1)), opacity .22s var(--ease, cubic-bezier(.2,.65,.25,1));
    font-family: var(--sans, system-ui);
    box-shadow: var(--sh-card, 0 16px 45px rgba(30,34,44,.12));
    margin-inline: auto;
    max-width: 504px;
    -webkit-overflow-scrolling: touch;
  }
  :host([open]) .sheet { transform: translateY(0); opacity: 1; }

  /* Pill-shaped grab matches the existing .sheet .grab in app.css */
  .grab {
    width: 40px;
    height: 4px;
    border-radius: 999px;
    background: var(--border-md, rgba(10,10,12,.16));
    margin: 0 auto 14px;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  /* Name uses the .h-big scale (26px) — same as titles in body cards */
  .name {
    margin: 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  /* Close button matches .iconb (40x40, var(--border), 50%) */
  .close {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid var(--border, rgba(10,10,12,.09));
    background: var(--surface, #fff);
    color: var(--fg, #090a0c);
    display: grid;
    place-items: center;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    flex: none;
  }
  .close:hover { background: var(--bg, #f5f6fa); }
  .close:focus-visible {
    outline: 2px solid var(--accent, #ff6a1a);
    outline-offset: 2px;
  }

  .meta-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  /* Chip uses .tag rhythm (4px 11px, mono 10px) */
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

  /* Metric pop uses .bignum scale (32px) — was clamp(28-42px). Eyebrow label
     above uses the standard 10px/.14em pattern. */
  .metric {
    margin-top: 16px;
    font-family: var(--mono, ui-monospace);
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1.05;
    color: var(--accent, #ff6a1a);
    font-variant-numeric: tabular-nums;
  }
  .metric .label {
    display: block;
    font-family: var(--mono, ui-monospace);
    font-size: 10px;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--meta, #8a8d96);
    font-weight: 500;
    margin-bottom: 4px;
  }

  /* Summary at .sub scale (14px / 1.55) */
  .summary {
    margin: 16px 0 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--muted, #4f535c);
  }

  .section {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--border, rgba(10,10,12,.06));
  }
  .section-eyebrow {
    font-family: var(--mono, ui-monospace);
    font-size: 10px;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--meta, #8a8d96);
    font-weight: 500;
    margin: 0 0 8px;
  }
  /* Endpoint code uses --fs-body-sm scale (12.5px). Bg lets the token cascade
     drive the surface (no light fallback) so dark theme renders correctly. */
  .endpoint {
    font-family: var(--mono, ui-monospace);
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--fg);
    background: var(--bg);
    border: 1px dashed var(--border-md, rgba(10,10,12,.16));
    border-radius: var(--r-md, 14px);
    padding: 12px;
    overflow-wrap: anywhere;
  }
  .notes {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted, #4f535c);
  }

  /* Buttons use the global .btn scale: full-width primary, ghost secondary */
  .actions {
    margin-top: 18px;
    display: flex;
    gap: 10px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex: 1;
    min-height: 46px;
    padding: 0 20px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: var(--fg, #090a0c);
    color: var(--bg, #f5f6fa);
    font-family: var(--sans, system-ui);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
  }
  .btn-primary {
    background: var(--accent, #ff6a1a);
    color: var(--accent-on, #fff);
  }
  .btn-primary:hover { background: var(--accent-deep, #c84d12); }
  .btn-ghost {
    background: transparent;
    border-color: var(--border-md, rgba(10,10,12,.16));
    color: var(--fg, #090a0c);
  }
  .btn-ghost:hover { background: var(--bg, #f5f6fa); }
  .btn:focus-visible {
    outline: 2px solid var(--accent, #ff6a1a);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .scrim, .sheet { transition: none; }
  }
`;

export class NexaProvenanceDrawer extends HTMLElement {
  private info: ProvenanceInfo | null = null;
  private previousActive: HTMLElement | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    this.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('.scrim, .close') || target.closest('.close, .scrim')) {
        this.close();
      }
    });
    document.addEventListener('keydown', this.onKey);
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.hasAttribute('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    // Focus trap: cycle Tab inside the sheet so SR/keyboard users don't leak
    // into the page behind the scrim.
    if (e.key === 'Tab') {
      const focusables = this.shadowRoot?.querySelectorAll<HTMLElement>(
        'button, a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = this.shadowRoot?.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first && last) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last && first) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  open(info: ProvenanceInfo): void {
    this.info = info;
    this.render();
    this.previousActive = (document.activeElement as HTMLElement) ?? null;
    this.setAttribute('open', '');
    document.documentElement.style.overflow = 'hidden';
    const close = this.shadowRoot?.querySelector<HTMLElement>('.close');
    requestAnimationFrame(() => close?.focus());
  }

  close(): void {
    this.removeAttribute('open');
    document.documentElement.style.overflow = '';
    this.previousActive?.focus();
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.textContent = '';
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    const info = this.info;

    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    root.appendChild(scrim);

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', info ? `${info.name} provenance` : 'Provenance');

    const grab = document.createElement('div');
    grab.className = 'grab';
    sheet.appendChild(grab);

    if (info) {
      const head = document.createElement('div');
      head.className = 'head';
      const name = document.createElement('h2');
      name.className = 'name';
      name.textContent = info.name;
      head.appendChild(name);
      const close = document.createElement('button');
      close.className = 'close';
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      head.appendChild(close);
      sheet.appendChild(head);

      const metaRow = document.createElement('div');
      metaRow.className = 'meta-row';
      if (info.category) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = info.category.replace(/-/g, ' ');
        metaRow.appendChild(chip);
      }
      const badge = document.createElement('nexa-source-badge');
      badge.setAttribute('source', info.status);
      badge.setAttribute('provider', info.name);
      if (info.fetchedAt) badge.setAttribute('fetched-at', info.fetchedAt);
      if (info.docsUrl) badge.setAttribute('docs-url', info.docsUrl);
      metaRow.appendChild(badge);
      sheet.appendChild(metaRow);

      if (info.metric) {
        const metric = document.createElement('div');
        metric.className = 'metric';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = 'Latest reading';
        metric.appendChild(label);
        metric.appendChild(document.createTextNode(info.metric));
        sheet.appendChild(metric);
      }

      if (info.summary) {
        const summary = document.createElement('p');
        summary.className = 'summary';
        summary.textContent = info.summary;
        sheet.appendChild(summary);
      }

      if (info.endpoint) {
        const section = document.createElement('div');
        section.className = 'section';
        const eb = document.createElement('p');
        eb.className = 'section-eyebrow';
        eb.textContent = 'What we read';
        section.appendChild(eb);
        const ep = document.createElement('div');
        ep.className = 'endpoint';
        ep.textContent = info.endpoint;
        section.appendChild(ep);
        sheet.appendChild(section);
      }

      if (info.notes) {
        const section = document.createElement('div');
        section.className = 'section';
        const eb = document.createElement('p');
        eb.className = 'section-eyebrow';
        eb.textContent = 'Notes';
        section.appendChild(eb);
        const notes = document.createElement('p');
        notes.className = 'notes';
        notes.textContent = info.notes;
        section.appendChild(notes);
        sheet.appendChild(section);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';
      if (info.docsUrl) {
        const a = document.createElement('a');
        a.className = 'btn btn-primary';
        a.href = info.docsUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Open provider docs ↗';
        actions.appendChild(a);
      }
      const close2 = document.createElement('button');
      close2.className = 'btn btn-ghost close';
      close2.textContent = 'Close';
      actions.appendChild(close2);
      sheet.appendChild(actions);
    }

    root.appendChild(sheet);
  }
}

if (!customElements.get('nexa-provenance-drawer')) {
  customElements.define('nexa-provenance-drawer', NexaProvenanceDrawer);
}

/** Mount one drawer per page, lazily. Returns the live element. */
export function ensureProvenanceDrawer(): NexaProvenanceDrawer {
  let el = document.querySelector('nexa-provenance-drawer') as NexaProvenanceDrawer | null;
  if (!el) {
    el = document.createElement('nexa-provenance-drawer') as NexaProvenanceDrawer;
    document.body.appendChild(el);
  }
  return el;
}

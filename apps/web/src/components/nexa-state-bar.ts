/**
 * <nexa-state-bar> — three numbers summarising provider health, scaled to
 * match the rest of MAZE's tokens.
 *
 *   18 LIVE · 4 DOCS-ONLY · 6 MISSING-KEYS
 *
 * Type scale alignment (Sprint 16.1 design pass):
 *   - value:   32px / mono / weight 600 / -0.03em  — matches `.bignum`
 *   - eyebrow: 10px / mono / .14em                  — matches `.eyebrow`
 *   - of:      10px / mono / .08em                  — matches the global meta size
 *
 * Padding and radius use the shared `--r-lg` (22px) + 16px gap so the bar
 * docks into the same `.card` rhythm everywhere it lands (s28 hero, landing
 * #transparency).
 *
 * Attributes:
 *   live          number rendered in the live slot
 *   docs-only     number rendered in the docs-only slot
 *   missing-keys  number rendered in the missing-keys slot
 *   total         optional, shown as "of N" caption under each slot
 *   variant       "default" | "compact" (single row, smaller)
 *
 * Values animate up from 0 to their target on first render (respects
 * prefers-reduced-motion).
 */

const STYLE = /* css */ `
  :host {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--border, rgba(10,10,12,.09));
    border-radius: var(--r-lg, 22px);
    background: var(--surface, #fff);
    color: var(--fg, #090a0c);
    font-family: var(--sans, system-ui);
    position: relative;
    overflow: hidden;
  }
  :host::before {
    content: '';
    position: absolute;
    inset: 0;
    background:
      radial-gradient(280px 140px at 18% 0%, color-mix(in oklab, var(--accent, #ff6a1a) 10%, transparent), transparent 60%);
    pointer-events: none;
  }

  :host([variant="compact"]) {
    padding: 12px 14px;
    gap: 10px;
  }

  .slot {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .slot + .slot {
    border-left: 1px solid var(--border, rgba(10,10,12,.09));
    padding-left: 12px;
  }

  .value {
    font-family: var(--mono, ui-monospace);
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
    color: var(--fg, #090a0c);
    white-space: nowrap;
  }
  :host([variant="compact"]) .value {
    font-size: 24px;
  }
  .slot[data-status="live"] .value {
    color: var(--accent, #ff6a1a);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .slot[data-status="live"] .value::after {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent, #ff6a1a);
    animation: pulse 1.8s ease-in-out infinite;
    flex: none;
  }

  /* Eyebrow rhythm matches .eyebrow in app.css (10px mono .18em) */
  .label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: .18em;
    text-transform: uppercase;
    color: var(--meta, #8a8d96);
    font-weight: 500;
  }

  @media (max-width: 380px) {
    .value { font-size: 24px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .slot[data-status="live"] .value::after { animation: none; }
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(.7); }
  }
`;

const SLOT_DEFINITIONS: ReadonlyArray<{ attr: string; label: string; status: string }> = [
  { attr: 'live', label: 'Live', status: 'live' },
  { attr: 'docs-only', label: 'Docs only', status: 'docs-only' },
  { attr: 'missing-keys', label: 'Missing keys', status: 'missing-keys' },
];

export class NexaStateBar extends HTMLElement {
  static observedAttributes = ['live', 'docs-only', 'missing-keys', 'total', 'variant'] as const;
  private rendered = false;
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }
  connectedCallback(): void {
    this.render();
  }
  attributeChangedCallback(): void {
    if (this.shadowRoot) this.render();
  }
  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.textContent = '';
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    const total = this.getAttribute('total');
    const reduceMotion = (() => {
      try {
        return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      } catch {
        return false;
      }
    })();
    const animate = !this.rendered && !reduceMotion;
    for (const def of SLOT_DEFINITIONS) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset['status'] = def.status;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = def.label;
      slot.appendChild(label);
      const value = document.createElement('span');
      value.className = 'value';
      const target = Number(this.getAttribute(def.attr) ?? '0');
      if (animate && target > 0) {
        countUp(value, target, 700);
      } else {
        value.textContent = String(target);
      }
      slot.appendChild(value);
      root.appendChild(slot);
    }
    this.rendered = true;
    this.setAttribute(
      'aria-label',
      `Provider state: ${this.getAttribute('live') ?? 0} live, ${this.getAttribute('docs-only') ?? 0} docs-only, ${this.getAttribute('missing-keys') ?? 0} missing keys${total ? `, of ${total} total` : ''}`,
    );
    this.setAttribute('role', 'group');
  }
}

function countUp(el: HTMLElement, target: number, durationMs: number): void {
  const start = performance.now();
  const tick = (now: number): void => {
    const elapsed = now - start;
    const t = Math.min(1, elapsed / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = String(target);
  };
  requestAnimationFrame(tick);
}

if (!customElements.get('nexa-state-bar')) {
  customElements.define('nexa-state-bar', NexaStateBar);
}

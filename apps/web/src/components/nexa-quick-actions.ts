/**
 * <nexa-quick-actions> — 4-button action row (Send / Request / Add / Swap).
 *
 * Shadow DOM (open mode) so that styles are scoped while still allowing
 * composedPath()-based event delegation from the global router (lib/router.ts).
 *
 * Slots:
 *   none — actions are configured by attributes.
 *
 * Attributes:
 *   data-send="s10"     — screen id for Send button   (default: s10)
 *   data-request="s12"  — screen id for Request       (default: s12)
 *   data-add="s09"      — screen id for Add money     (default: s09)
 *   data-swap="s16"     — screen id for Swap          (default: s16)
 *
 * Why this is the spike: if `data-go` on a child of an open shadow root is
 * still findable via document-level event.composedPath() delegation, then the
 * Phase A architecture decision (web components + delegated router) is sound.
 *
 * Security: never string-interpolate untrusted values (e.g. dataset reads)
 * into innerHTML — set them via element.dataset / textContent / setAttribute.
 * The only innerHTML use here is for the inline SVG icons, which are
 * compile-time constants under our control.
 */

const TEMPLATE_CSS = /* css */ `
  :host {
    display: block;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    text-align: center;
    margin-top: 16px;
  }
  button {
    all: unset;
    display: grid;
    justify-items: center;
    gap: 6px;
    font-family: var(--sans);
    font-size: 10.5px;
    color: var(--muted);
    font-weight: 500;
    padding: 4px 0;
    border-radius: 14px;
    min-height: 44px;
    cursor: pointer;
  }
  button:hover .ic {
    border-color: var(--fg);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .ic {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 50%;
    transition: border-color .15s var(--ease);
  }
  .ic svg {
    width: 17px;
    height: 17px;
    stroke: var(--fg);
    stroke-width: 1.6;
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
`;

import { svg } from '@/lib/svg.js';

/** SVG markup — compile-time constants, no user input. Parsed via DOMParser, never innerHTML. */
const ICON_MARKUP = {
  send: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7Z"/></svg>',
  request: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="m2 22 11-11"/><path d="m2 22 7-20 4 9 9 4-20 7Z"/></svg>',
  add: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  swap: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 7h13l-3-3M17 17H4l3 3"/></svg>',
} as const;

type ActionKey = keyof typeof ICON_MARKUP;

const ACTIONS: ReadonlyArray<{ key: ActionKey; label: string; defaultTo: string }> = [
  { key: 'send', label: 'Send', defaultTo: 's10' },
  { key: 'request', label: 'Request', defaultTo: 's12' },
  { key: 'add', label: 'Add money', defaultTo: 's09' },
  { key: 'swap', label: 'Swap', defaultTo: 's16' },
];

export class NexaQuickActions extends HTMLElement {
  static observedAttributes = ['data-send', 'data-request', 'data-add', 'data-swap'] as const;

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

    // Clear prior render
    root.textContent = '';

    // <style>
    const style = document.createElement('style');
    style.textContent = TEMPLATE_CSS;
    root.appendChild(style);

    // <div role="group">
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Quick actions');

    for (const { key, label, defaultTo } of ACTIONS) {
      // dataset returns string|undefined for arbitrary keys
      const to = this.dataset[key] ?? defaultTo;

      const btn = document.createElement('button');
      btn.type = 'button';
      // Safe: dataset.go setter HTML-escapes; never interpolated as innerHTML
      btn.dataset['go'] = to;
      btn.setAttribute('aria-label', label);

      const icSpan = document.createElement('span');
      icSpan.className = 'ic';
      icSpan.appendChild(svg(ICON_MARKUP[key]));

      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;

      btn.appendChild(icSpan);
      btn.appendChild(labelSpan);
      grid.appendChild(btn);
    }

    root.appendChild(grid);
  }
}

if (!customElements.get('nexa-quick-actions')) {
  customElements.define('nexa-quick-actions', NexaQuickActions);
}

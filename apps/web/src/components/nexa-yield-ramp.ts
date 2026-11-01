/**
 * <nexa-yield-ramp> — stacked-bar visualisation of the blended Earn rate.
 *
 * Each segment carries one DeFi adapter (Aave, Compound, Morpho ×2, yoUSD,
 * Marinade). Width = adapter weight, height encoded by APY. Hover/tap shows
 * the per-provider number with a quiet source attribution. Used on s14 Earn
 * as the hero, on the landing #earn section to prove the "8.4% est." claim,
 * and as a compact strip on s07 Earn opt-in.
 *
 * Data is set via a single .segments setter — easier than parsing JSON in
 * attributes when six rows arrive from /earn/protocols.
 *
 *   const ramp = document.querySelector<NexaYieldRamp>('nexa-yield-ramp')!;
 *   ramp.segments = [
 *     { name: 'Morpho · Standard', apyBps: 323, weight: .22, source: 'live' },
 *     { name: 'Morpho · High Yield', apyBps: 526, weight: .18, source: 'live' },
 *     { name: 'Aave v3', apyBps: 321, weight: .18, source: 'live' },
 *     { name: 'Compound III', apyBps: 322, weight: .18, source: 'live' },
 *     { name: 'yoUSD', apyBps: 480, weight: .12, source: 'live' },
 *     { name: 'Marinade SOL', apyBps: 607, weight: .12, source: 'live' },
 *   ];
 *
 * The widget computes the blended rate itself: sum(apyBps * weight) / sum(weight).
 * It also accepts a `blended-bps` attribute override if the API has already
 * computed the weighted average (preferred — keeps frontend math out of trust).
 */

export interface YieldSegment {
  name: string;
  apyBps: number;
  weight: number;
  source: 'live' | 'sandbox' | 'cached-live' | 'provider-demo' | 'unavailable' | 'error';
  fetchedAt?: string | null | undefined;
  docsUrl?: string | undefined;
  /** Brand color for the legend disc (matches the protocol mark). */
  logoColor?: string;
  /** Monogram letter shown inside the legend disc when no logoUrl. */
  logoLetter?: string;
  /** Path to the real official SVG/PNG logo. Takes precedence over color+letter. */
  logoUrl?: string;
}

const STYLE = /* css */ `
  :host {
    display: block;
    font-family: var(--sans, system-ui);
    color: var(--fg, #090a0c);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  /* Blended rate uses --fs-balance scale (32–40px) to match the rest of MAZE's
     large-number rhythm (.bignum + the home balance). Way smaller than the
     prototype's clamp(36-54px). */
  /* Wrapper for blended number + tag — single flex flow with 8px gap so the
     'Blended' caption sits beside the percent at the same baseline. */
  .head > span:first-child {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .blended {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-family: var(--mono, ui-monospace);
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
  }
  .blended .pct {
    color: var(--accent, #ff6a1a);
  }
  .blended-tag {
    font-family: var(--mono, ui-monospace);
    font-size: 10px;
    letter-spacing: .18em;
    text-transform: uppercase;
    color: var(--meta, #8a8d96);
    font-weight: 500;
  }
  .summary {
    font-family: var(--mono, ui-monospace);
    font-size: 11px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--meta, #8a8d96);
    white-space: nowrap;
  }
  .summary .live {
    color: var(--accent, #ff6a1a);
  }

  .bar {
    display: flex;
    width: 100%;
    height: 28px;
    border-radius: 999px;
    overflow: hidden;
    border: 1px solid var(--border, rgba(10,10,12,.09));
    background: var(--bg);
    position: relative;
  }
  .seg {
    position: relative;
    height: 100%;
    min-width: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--mono, ui-monospace);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .06em;
    color: var(--accent-on, #fff);
    background: var(--accent, #ff6a1a);
    border-right: 1px solid color-mix(in oklab, var(--accent-deep, #c84d12) 30%, transparent);
    cursor: default;
    transition: filter .15s var(--ease, ease), transform .12s var(--ease, ease);
  }
  .seg:last-child { border-right: 0; }
  .seg:hover, .seg:focus-visible {
    filter: brightness(1.08);
    outline: none;
  }
  .seg[data-source="unavailable"],
  .seg[data-source="error"] {
    background: var(--meta, #8a8d96);
    color: var(--bg, #f5f6fa);
  }
  .seg[data-source="cached-live"] {
    background: color-mix(in oklab, var(--accent, #ff6a1a) 70%, var(--meta, #8a8d96) 30%);
  }
  .seg[data-source="sandbox"] {
    background: var(--sandbox, #5a9ff0);
    color: #fff;
  }
  /* High-APY rows pop, low-APY rows tone down by mixing toward muted */
  .seg[data-apy="high"] { filter: saturate(1.15); }
  .seg[data-apy="low"]  { filter: saturate(.78) brightness(.92); }
  .seg .pct {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: .08em;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  /* Legend uses the same .lrow rhythm — 11px mono sub on a 12.5px name,
     thin top hairline, font-variant numeric for tabular APY column. */
  .legend {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0 16px;
    margin-top: 12px;
  }
  @media (max-width: 360px) {
    .legend { grid-template-columns: 1fr; }
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--border, rgba(10,10,12,.06));
    min-height: 32px;
  }
  .row .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent, #ff6a1a);
    flex: none;
  }
  .row[data-source="cached-live"] .dot { opacity: .55; }
  .row[data-source="unavailable"] .dot,
  .row[data-source="error"] .dot { background: #c44545; }
  .row[data-source="sandbox"] .dot { background: var(--sandbox, #5a9ff0); }
  .row[data-source="provider-demo"] .dot { background: var(--meta, #8a8d96); }
  /* Brand logo disc — 18px circle with monogram. Visible when seg.logoColor is set. */
  .row .logo-mark {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-family: var(--mono, ui-monospace);
    font-size: 9px;
    font-weight: 700;
    color: #fff;
    flex: none;
    letter-spacing: 0;
  }
  /* Real official logo (SVG/PNG). 18px square, object-contain, no clipping. */
  .row .logo-img {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex: none;
    border-radius: 4px;
  }
  .row .name {
    font-family: var(--mono, ui-monospace);
    font-size: 11px;
    color: var(--fg, #090a0c);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .apy {
    margin-left: auto;
    font-family: var(--mono, ui-monospace);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--fg, #090a0c);
  }

  :host([variant="compact"]) .bar { height: 22px; }
  :host([variant="compact"]) .legend { display: none; }
  :host([variant="compact"]) .blended { font-size: 24px; }

  @media (prefers-reduced-motion: reduce) {
    .seg { transition: none; }
  }
`;

export class NexaYieldRamp extends HTMLElement {
  static observedAttributes = ['blended-bps', 'caption', 'variant'] as const;

  private _segments: YieldSegment[] = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  set segments(s: YieldSegment[]) {
    this._segments = s;
    this.render();
  }

  get segments(): YieldSegment[] {
    return this._segments;
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

    const segments = this._segments.length ? this._segments : [];
    const totalWeight = segments.reduce((a, s) => a + s.weight, 0) || 1;
    const live = segments.filter((s) => s.source === 'live').length;
    const blendedAttr = Number(this.getAttribute('blended-bps') ?? '0');
    const blendedBps = blendedAttr > 0
      ? blendedAttr
      : segments.reduce((a, s) => a + s.apyBps * s.weight, 0) / totalWeight;
    const blendedPct = (blendedBps / 100).toFixed(2);

    const head = document.createElement('div');
    head.className = 'head';
    const blendedWrap = document.createElement('span');
    const blended = document.createElement('span');
    blended.className = 'blended';
    blended.appendChild(document.createTextNode(blendedPct));
    const pctMark = document.createElement('span');
    pctMark.className = 'pct';
    pctMark.textContent = '%';
    blended.appendChild(pctMark);
    blendedWrap.appendChild(blended);
    const blendedTag = document.createElement('span');
    blendedTag.className = 'blended-tag';
    blendedTag.textContent = 'Blended';
    blendedWrap.appendChild(blendedTag);
    head.appendChild(blendedWrap);

    const summary = document.createElement('span');
    summary.className = 'summary';
    const captionOverride = this.getAttribute('caption');
    if (captionOverride) {
      summary.textContent = captionOverride;
    } else if (segments.length === 0) {
      summary.textContent = 'No sources yet';
    } else {
      const allLive = live === segments.length;
      if (allLive) {
        const liveSpan = document.createElement('span');
        liveSpan.className = 'live';
        liveSpan.textContent = 'all live';
        summary.appendChild(liveSpan);
      } else {
        summary.appendChild(document.createTextNode(`${live} of ${segments.length} live`));
      }
      summary.appendChild(document.createTextNode(` · ${segments.length} sources`));
    }
    head.appendChild(summary);
    root.appendChild(head);

    // When there are no segments, skip the empty bar + legend so the widget
    // collapses to just the heading. Otherwise a dark dead pill sits below
    // "no sources yet", which reads broken.
    if (segments.length === 0) {
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'img');
    bar.setAttribute(
      'aria-label',
      `Blended yield ${blendedPct} percent across ${segments.length} sources`,
    );

    // APY hi/lo band for visual differentiation
    const apys = segments.map((s) => s.apyBps);
    const minApy = Math.min(...apys);
    const maxApy = Math.max(...apys);

    for (const s of segments) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.dataset['source'] = s.source;
      const widthPct = (s.weight / totalWeight) * 100;
      seg.style.flexBasis = `${widthPct}%`;
      const isHigh = s.apyBps > (minApy + maxApy) / 2;
      seg.dataset['apy'] = isHigh ? 'high' : 'low';
      seg.title = `${s.name} · ${(s.apyBps / 100).toFixed(2)}% APY · ${s.source}`;
      if (widthPct >= 12) {
        const span = document.createElement('span');
        span.className = 'pct';
        span.textContent = `${(s.apyBps / 100).toFixed(1)}%`;
        seg.appendChild(span);
      }
      bar.appendChild(seg);
    }
    root.appendChild(bar);

    const legend = document.createElement('div');
    legend.className = 'legend';
    for (const s of segments) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset['source'] = s.source;
      // Logo precedence: real official SVG/PNG > color+letter monogram > source dot.
      if (s.logoUrl) {
        const img = document.createElement('img');
        img.className = 'logo-img';
        img.src = s.logoUrl;
        img.alt = '';
        img.loading = 'lazy';
        row.appendChild(img);
      } else if (s.logoColor && s.logoLetter) {
        const mark = document.createElement('span');
        mark.className = 'logo-mark';
        mark.style.background = s.logoColor;
        mark.textContent = s.logoLetter;
        row.appendChild(mark);
      } else {
        const dot = document.createElement('span');
        dot.className = 'dot';
        row.appendChild(dot);
      }
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.name;
      row.appendChild(name);
      const apy = document.createElement('span');
      apy.className = 'apy';
      apy.textContent = s.source === 'unavailable' || s.source === 'error'
        ? '…'
        : `${(s.apyBps / 100).toFixed(2)}%`;
      row.appendChild(apy);
      legend.appendChild(row);
    }
    root.appendChild(legend);
  }
}

if (!customElements.get('nexa-yield-ramp')) {
  customElements.define('nexa-yield-ramp', NexaYieldRamp);
}

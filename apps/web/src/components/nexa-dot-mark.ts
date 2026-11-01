/**
 * <nexa-dot-mark> — deterministic dot-matrix identity mark (PLANB W4).
 *
 * The 5x7 dot grid is the classic dot-matrix character cell (LED departure
 * boards, receipt printers) — the same dot language as the virtual card's
 * emboss texture (app.css .vcard) and the landing dot-globe (lib/globe.ts),
 * turned into an identicon: seed in, same mark out, every time. Used as the
 * token/provider logo fallback (dots behind the ticker letter), for agent
 * avatars, and as a quiet empty-state glyph. Left three columns are random
 * from the seed, mirrored onto the right two, so every mark reads as a
 * "character" rather than noise.
 *
 * Purely static by design: identity is not a status, so it never animates.
 * Colors ride the same deterministic hue ramp as the letter-fallback chips
 * (hsl(hash % 360) 55% 38%) so a mark and its chip always agree.
 *
 *   <nexa-dot-mark seed="BTC"></nexa-dot-mark>
 *   <nexa-dot-mark seed="morpho" letter="M"></nexa-dot-mark>
 */

const GRID_COLS = 5;
const GRID_ROWS = 7;
const CELL = 10; // svg user units per cell

/** Same integer hash family as the market-row fallbackColor — a mark and its
    letter chip derive from identical bits. */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** mulberry32 — tiny deterministic PRNG; good enough distribution for 21 bits. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dotMarkColor(seed: string): string {
  return `hsl(${hashSeed(seed) % 360} 55% 38%)`;
}

/** Deterministic 5x7 cell map: left 3 columns from the seeded PRNG, columns
    0/1 mirrored onto 4/3. Sparse seeds get a center-column floor so no mark
    ever renders near-empty. */
export function dotMarkCells(seed: string): boolean[][] {
  const rand = mulberry32(hashSeed(seed) || 1);
  const rows: boolean[][] = [];
  for (let y = 0; y < GRID_ROWS; y++) {
    const row = new Array<boolean>(GRID_COLS).fill(false);
    for (let x = 0; x <= 2; x++) row[x] = rand() < 0.5;
    row[3] = row[1] as boolean;
    row[4] = row[0] as boolean;
    rows.push(row);
  }
  const lit = rows.flat().filter(Boolean).length;
  if (lit < 8) {
    for (let y = 1; y < GRID_ROWS - 1; y += 2) (rows[y] as boolean[])[2] = true;
  }
  return rows;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build the mark as a real SVG element (no markup strings — everything is
    derived from hashed numbers, and DOM construction keeps it injection-proof
    by shape). Hosts that don't want the custom element append this directly,
    e.g. the market-row logo fallback inside its own shadow root. */
export function dotMarkSvgElement(seed: string, color = dotMarkColor(seed)): SVGSVGElement {
  const cells = dotMarkCells(seed);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${GRID_COLS * CELL} ${GRID_ROWS * CELL}`);
  svg.setAttribute('fill', color);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      if (!(cells[y] as boolean[])[x]) continue;
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(x * CELL + CELL / 2));
      dot.setAttribute('cy', String(y * CELL + CELL / 2));
      dot.setAttribute('r', '3.4');
      svg.appendChild(dot);
    }
  }
  return svg;
}

const STYLE = /* css */ `
  :host {
    display: inline-grid;
    place-items: center;
    position: relative;
    width: 46px;
    height: 46px;
    border-radius: 12px;
    border: 1px solid var(--border, rgba(10,10,12,.09));
    background: var(--surface-2, #f8f9fb);
    overflow: hidden;
    flex: 0 0 auto;
  }
  :host([size="sm"]) { width: 34px; height: 34px; border-radius: 10px; }
  :host([size="lg"]) { width: 72px; height: 72px; border-radius: 16px; }
  svg { width: 72%; height: 82%; display: block; }
  .letter {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-family: var(--mono, ui-monospace);
    font-weight: 700;
    font-size: 13px;
    /* Seed hue (set per instance) so the glyph reads on light and dark
       surfaces alike; the dots dim underneath it. */
    color: var(--mark-color, var(--fg, #090a0c));
  }
  :host([size="sm"]) .letter { font-size: 11px; }
  :host([size="lg"]) .letter { font-size: 18px; }
  :host([letter]) svg { opacity: .38; }
`;

let sharedMarkSheet: CSSStyleSheet | null | undefined;
function attachMarkStyle(root: ShadowRoot): void {
  if (sharedMarkSheet === undefined) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      sharedMarkSheet = sheet;
    } catch {
      sharedMarkSheet = null;
    }
  }
  if (sharedMarkSheet) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedMarkSheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);
}

export class NexaDotMark extends HTMLElement {
  static observedAttributes = ['seed', 'letter', 'size'] as const;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.build();
    this.scheduleApply();
  }

  attributeChangedCallback(): void {
    if (!this.built) return;
    this.scheduleApply();
  }

  private built = false;
  private applyQueued = false;
  private markHost!: HTMLSpanElement;
  private letterEl: HTMLSpanElement | null = null;
  private appliedSeed: string | null = null;

  private build(): void {
    if (this.built) return;
    const root = this.shadowRoot;
    if (!root) return;
    attachMarkStyle(root);
    this.markHost = document.createElement('span');
    this.markHost.style.display = 'contents';
    root.appendChild(this.markHost);
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
    const seed = this.getAttribute('seed') ?? '?';
    if (seed !== this.appliedSeed) {
      this.appliedSeed = seed;
      this.style.setProperty('--mark-color', dotMarkColor(seed));
      this.markHost.textContent = '';
      this.markHost.appendChild(dotMarkSvgElement(seed));
    }
    const letter = this.getAttribute('letter');
    if (letter?.trim()) {
      if (!this.letterEl) {
        this.letterEl = document.createElement('span');
        this.letterEl.className = 'letter';
        this.shadowRoot?.appendChild(this.letterEl);
      }
      const glyph = letter.trim().charAt(0).toUpperCase();
      if (this.letterEl.textContent !== glyph) this.letterEl.textContent = glyph;
    } else {
      this.letterEl?.remove();
      this.letterEl = null;
    }
  }
}

if (!customElements.get('nexa-dot-mark')) {
  customElements.define('nexa-dot-mark', NexaDotMark);
}

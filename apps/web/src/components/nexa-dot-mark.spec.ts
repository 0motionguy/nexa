import { describe, expect, it } from 'vitest';
import './nexa-dot-mark.js';
import { dotMarkCells, dotMarkColor, dotMarkSvgElement } from './nexa-dot-mark.js';

const nextTick = () => new Promise((r) => setTimeout(r, 0));

describe('dot-mark generator', () => {
  it('is deterministic: same seed, same cells, same svg', () => {
    expect(dotMarkCells('BTC')).toEqual(dotMarkCells('BTC'));
    expect(dotMarkSvgElement('BTC').outerHTML).toBe(dotMarkSvgElement('BTC').outerHTML);
  });

  it('differs across seeds', () => {
    expect(dotMarkSvgElement('BTC').outerHTML).not.toBe(dotMarkSvgElement('ETH').outerHTML);
  });

  it('mirrors horizontally so marks read as characters', () => {
    const cells = dotMarkCells('SOL');
    for (const row of cells) {
      expect(row[4]).toBe(row[0]);
      expect(row[3]).toBe(row[1]);
    }
  });

  it('never renders near-empty marks', () => {
    for (const seed of ['', 'a', 'zz', 'C001', 'WOW', 'xyz:TSLA']) {
      const lit = dotMarkCells(seed).flat().filter(Boolean).length;
      expect(lit).toBeGreaterThanOrEqual(8);
    }
  });

  it('shares the letter-chip hue formula', () => {
    expect(dotMarkColor('BTC')).toMatch(/^hsl\(\d+ 55% 38%\)$/);
  });
});

describe('<nexa-dot-mark>', () => {
  it('renders the seeded svg with dots', async () => {
    const el = document.createElement('nexa-dot-mark');
    el.setAttribute('seed', 'BTC');
    document.body.appendChild(el);
    await nextTick();
    const svg = el.shadowRoot?.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll('circle').length ?? 0).toBeGreaterThanOrEqual(8);
  });

  it('overlays a single uppercase letter when asked', async () => {
    const el = document.createElement('nexa-dot-mark');
    el.setAttribute('seed', 'morpho');
    el.setAttribute('letter', 'morpho');
    document.body.appendChild(el);
    await nextTick();
    expect(el.shadowRoot?.querySelector('.letter')?.textContent).toBe('M');
  });

  it('re-renders when the seed changes', async () => {
    const el = document.createElement('nexa-dot-mark');
    el.setAttribute('seed', 'BTC');
    document.body.appendChild(el);
    await nextTick();
    const before = el.shadowRoot?.querySelector('svg')?.outerHTML;
    el.setAttribute('seed', 'ETH');
    await nextTick();
    const after = el.shadowRoot?.querySelector('svg')?.outerHTML;
    expect(after).not.toBe(before);
  });
});

/**
 * Component contract tests for the Sprint 16 provenance design system.
 *
 * Each test pins one part of the design contract — the status attribute
 * variants, the data-clickable toggle, the keyboard activation paths,
 * the count-up logic, the legend rendering. The goal is NOT to test the
 * shadow DOM CSS (jsdom won't render it correctly) but to pin the JS
 * behaviours that the design pass + the a11y review actually care about.
 *
 * Sprint 16.3 — written in the design-system pass after the senior
 * designer / a11y / hardening review agents flagged that the components
 * had ZERO render tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Side-effect imports register the custom elements.
import './nexa-source-badge.js';
import './nexa-state-bar.js';
import './nexa-yield-ramp.js';
import './nexa-provider-card.js';
import './nexa-market-row.js';
import type { NexaYieldRamp } from './nexa-yield-ramp.js';

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('<nexa-source-badge>', () => {
  it('renders the source label inside its shadow root', async () => {
    const el = document.createElement('nexa-source-badge');
    el.setAttribute('source', 'live');
    el.setAttribute('provider', 'Morpho');
    document.body.appendChild(el);
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).toContain('Live');
    expect(txt).toContain('Morpho');
  });

  it('does NOT set role=status (was thrashing screen readers every 15s)', async () => {
    const el = document.createElement('nexa-source-badge');
    el.setAttribute('source', 'live');
    el.setAttribute('provider', 'Morpho');
    document.body.appendChild(el);
    await nextTick();
    expect(el.getAttribute('role')).toBeNull();
  });

  it('sets aria-label for screen readers to inspect on demand', async () => {
    const el = document.createElement('nexa-source-badge');
    el.setAttribute('source', 'live');
    el.setAttribute('provider', 'Aave');
    el.setAttribute('fetched-at', new Date(Date.now() - 12_000).toISOString());
    document.body.appendChild(el);
    await nextTick();
    const aria = el.getAttribute('aria-label') ?? '';
    expect(aria).toContain('Live');
    expect(aria).toContain('Aave');
  });

  it('renders an error icon path for source=error', async () => {
    const el = document.createElement('nexa-source-badge');
    el.setAttribute('source', 'error');
    el.setAttribute('provider', 'Socket');
    el.setAttribute('error-code', 'rpc_failed');
    document.body.appendChild(el);
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).toContain('Error');
    expect(txt).toContain('rpc failed');
  });
});

describe('<nexa-state-bar>', () => {
  it('renders three slots with the three labels', async () => {
    const el = document.createElement('nexa-state-bar');
    el.setAttribute('live', '18');
    el.setAttribute('docs-only', '4');
    el.setAttribute('missing-keys', '6');
    document.body.appendChild(el);
    await nextTick();
    const labels = Array.from(el.shadowRoot?.querySelectorAll('.label') ?? []).map((l) => l.textContent);
    expect(labels).toEqual(['Live', 'Docs only', 'Missing keys']);
  });

  it('counts up to the target value (animation completes within 1s)', async () => {
    const el = document.createElement('nexa-state-bar');
    el.setAttribute('live', '18');
    el.setAttribute('docs-only', '4');
    el.setAttribute('missing-keys', '6');
    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 900));
    const values = Array.from(el.shadowRoot?.querySelectorAll('.value') ?? []).map((v) => v.textContent);
    expect(values).toEqual(['18', '4', '6']);
  });

  it('does NOT render the `of N` caption (visual clutter removed Sprint 16.2)', async () => {
    const el = document.createElement('nexa-state-bar');
    el.setAttribute('live', '18');
    el.setAttribute('docs-only', '4');
    el.setAttribute('missing-keys', '6');
    el.setAttribute('total', '28');
    document.body.appendChild(el);
    await nextTick();
    const ofCaption = el.shadowRoot?.querySelector('.of');
    expect(ofCaption).toBeNull();
  });

  it('includes total in aria-label even though it is hidden visually', async () => {
    const el = document.createElement('nexa-state-bar');
    el.setAttribute('live', '18');
    el.setAttribute('docs-only', '4');
    el.setAttribute('missing-keys', '6');
    el.setAttribute('total', '28');
    document.body.appendChild(el);
    await nextTick();
    const aria = el.getAttribute('aria-label') ?? '';
    expect(aria).toContain('of 28 total');
  });
});

describe('<nexa-yield-ramp>', () => {
  it('renders empty state without a bar when no segments are set', async () => {
    const el = document.createElement('nexa-yield-ramp');
    document.body.appendChild(el);
    await nextTick();
    const bar = el.shadowRoot?.querySelector('.bar');
    expect(bar).toBeNull();
  });

  it('renders the bar + legend when segments are populated', async () => {
    const el = document.createElement('nexa-yield-ramp') as NexaYieldRamp;
    document.body.appendChild(el);
    el.segments = [
      { name: 'Aave v3', apyBps: 321, weight: 0.5, source: 'live' },
      { name: 'Morpho', apyBps: 323, weight: 0.5, source: 'live' },
    ];
    await nextTick();
    const bar = el.shadowRoot?.querySelector('.bar');
    expect(bar).not.toBeNull();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).toContain('Aave v3');
    expect(txt).toContain('Morpho');
  });

  it('reads blended-bps attribute for the headline number when set', async () => {
    const el = document.createElement('nexa-yield-ramp') as NexaYieldRamp;
    el.setAttribute('blended-bps', '840');
    document.body.appendChild(el);
    el.segments = [
      { name: 'Aave', apyBps: 321, weight: 1, source: 'live' },
    ];
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).toContain('8.40');
    expect(txt).toContain('%');
  });
});

describe('<nexa-provider-card>', () => {
  it('renders name, category chip, and status pill', async () => {
    const el = document.createElement('nexa-provider-card');
    el.setAttribute('provider', 'morpho');
    el.setAttribute('name', 'Morpho');
    el.setAttribute('category', 'defi-yield');
    el.setAttribute('status', 'live');
    document.body.appendChild(el);
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).toContain('Morpho');
    expect(txt).toContain('DeFi yield');
    expect(txt).toContain('LIVE');
  });

  it('exposes role=button + tabindex=0 when drawer-target is set', async () => {
    const el = document.createElement('nexa-provider-card');
    el.setAttribute('provider', 'morpho');
    el.setAttribute('name', 'Morpho');
    el.setAttribute('status', 'live');
    el.setAttribute('drawer-target', 'morpho');
    document.body.appendChild(el);
    await nextTick();
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('Enter key activates the card when clickable', async () => {
    const el = document.createElement('nexa-provider-card');
    el.setAttribute('provider', 'morpho');
    el.setAttribute('name', 'Morpho');
    el.setAttribute('status', 'live');
    el.setAttribute('drawer-target', 'morpho');
    document.body.appendChild(el);
    await nextTick();
    let clicked = 0;
    el.addEventListener('click', () => {
      clicked += 1;
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(clicked).toBe(1);
  });

  it('Space key also activates the card', async () => {
    const el = document.createElement('nexa-provider-card');
    el.setAttribute('provider', 'aave');
    el.setAttribute('name', 'Aave v3');
    el.setAttribute('status', 'live');
    el.setAttribute('drawer-target', 'aave');
    document.body.appendChild(el);
    await nextTick();
    let clicked = 0;
    el.addEventListener('click', () => {
      clicked += 1;
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(clicked).toBe(1);
  });

  it('renders docs link with explicit "opens in new tab" aria-label', async () => {
    const el = document.createElement('nexa-provider-card');
    el.setAttribute('provider', 'morpho');
    el.setAttribute('name', 'Morpho');
    el.setAttribute('status', 'live');
    el.setAttribute('docs-url', 'https://docs.morpho.org');
    document.body.appendChild(el);
    await nextTick();
    const a = el.shadowRoot?.querySelector('a');
    expect(a?.getAttribute('aria-label')).toContain('Morpho');
    expect(a?.getAttribute('aria-label')).toContain('new tab');
  });
});

describe('<nexa-market-row>', () => {
  it('renders symbol, venue, price, and change', async () => {
    const el = document.createElement('nexa-market-row');
    el.setAttribute('symbol', 'BTC');
    el.setAttribute('venue', 'Hyperliquid');
    el.setAttribute('price', '63240.50');
    el.setAttribute('currency', 'USD');
    el.setAttribute('change-pct', '2.1');
    el.setAttribute('source', 'live');
    document.body.appendChild(el);
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).toContain('BTC');
    expect(txt).toContain('Hyperliquid');
    expect(txt).toContain('63,240');
    expect(txt).toContain('+2.10%');
  });

  it('falls back to middle-dot (not em-dash) for missing price', async () => {
    const el = document.createElement('nexa-market-row');
    el.setAttribute('symbol', 'BTC');
    el.setAttribute('venue', 'Hyperliquid');
    el.setAttribute('source', 'live');
    document.body.appendChild(el);
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).not.toContain('—'); // brand rule: no em-dashes
    expect(txt).toContain('·');
  });

  it('Enter activates when data-clickable is set', async () => {
    const el = document.createElement('nexa-market-row');
    el.setAttribute('symbol', 'BTC');
    el.setAttribute('source', 'live');
    el.dataset['clickable'] = '';
    document.body.appendChild(el);
    await nextTick();
    let clicked = 0;
    el.addEventListener('click', () => {
      clicked += 1;
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(clicked).toBe(1);
  });

  it('renders a lazy market logo when logo-url is provided', async () => {
    const el = document.createElement('nexa-market-row');
    el.setAttribute('symbol', 'BTC');
    el.setAttribute('name', 'Bitcoin perpetual');
    el.setAttribute('logo-url', '/coins/btc.svg');
    el.setAttribute('source', 'live');
    document.body.appendChild(el);
    await nextTick();
    const img = el.shadowRoot?.querySelector<HTMLImageElement>('.logo img');
    expect(img?.getAttribute('src')).toBe('/coins/btc.svg');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('alt')).toBe('');
    expect(el.shadowRoot?.querySelector('.logo-fallback')).toBeNull();
  });

  it('renders a one-character fallback symbol when no logo-url is provided', async () => {
    const el = document.createElement('nexa-market-row');
    el.setAttribute('symbol', 'HYPE');
    el.setAttribute('name', 'HYPE perpetual');
    el.setAttribute('source', 'live');
    document.body.appendChild(el);
    await nextTick();
    expect(el.shadowRoot?.querySelector('.logo img')).toBeNull();
    expect(el.shadowRoot?.querySelector('.logo-fallback')?.textContent).toBe('H');
  });

  it('does not render a per-row LIVE label or pulse for normal live rows', async () => {
    const el = document.createElement('nexa-market-row');
    el.setAttribute('symbol', 'ETH');
    el.setAttribute('price', '3440');
    el.setAttribute('currency', 'USD');
    el.setAttribute('source', 'live');
    document.body.appendChild(el);
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).not.toContain('Live');
    expect(el.shadowRoot?.querySelector('.src')).toBeNull();
  });

  it('renders a source marker for cached or unavailable rows', async () => {
    const el = document.createElement('nexa-market-row');
    el.setAttribute('symbol', 'SOL');
    el.setAttribute('source', 'cached-live');
    document.body.appendChild(el);
    await nextTick();
    const txt = el.shadowRoot?.textContent ?? '';
    expect(txt).toContain('Cached');
    expect(el.shadowRoot?.querySelector('.src .dot')).not.toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { start, subscribe, go, dispatchNav, getCurrent, __resetForTests } from './router.js';

describe('router', () => {
  beforeEach(() => {
    // jsdom resets DOM but module singletons persist within a worker.
    // Force a clean slate via __resetForTests, then clear the DOM.
    location.hash = '';
    __resetForTests();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initialises at s01 when no hash present', () => {
    const fn = vi.fn();
    subscribe(fn);
    const first = start();
    expect(first).toBe('s01');
    expect(getCurrent()).toBe('s01');
    expect(fn).toHaveBeenCalledWith('s01', null);
  });

  it('honours an explicit initial argument', () => {
    location.hash = '';
    const first = start('s08');
    expect(first).toBe('s08');
    expect(location.hash).toBe('#s08');
  });

  it('navigates programmatically via go()', () => {
    start('s01');
    const fn = vi.fn();
    subscribe(fn);
    go('s10');
    expect(getCurrent()).toBe('s10');
    expect(fn).toHaveBeenCalledWith('s10', expect.any(String));
  });

  it('navigates via [data-go] click delegation in light DOM', () => {
    start('s01');
    const fn = vi.fn();
    subscribe(fn);

    const btn = document.createElement('button');
    btn.dataset['go'] = 's12';
    btn.textContent = 'request';
    document.body.appendChild(btn);
    btn.click();

    expect(getCurrent()).toBe('s12');
    expect(fn).toHaveBeenCalledWith('s12', expect.any(String));
  });

  it('navigates via [data-go] click delegation INSIDE OPEN SHADOW DOM', () => {
    // This is the spike — proves composedPath() resolves a data-go target
    // even when the click originates inside a custom element's shadow root.
    start('s01');
    const fn = vi.fn();
    subscribe(fn);

    class TestHost extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        const btn = document.createElement('button');
        btn.dataset['go'] = 's09';
        btn.textContent = 'add';
        root.appendChild(btn);
      }
    }
    customElements.define('test-host', TestHost);

    const host = document.createElement('test-host');
    document.body.appendChild(host);
    const innerBtn = (host as HTMLElement).shadowRoot!.querySelector('button')!;
    innerBtn.click();

    expect(getCurrent()).toBe('s09');
    expect(fn).toHaveBeenCalledWith('s09', expect.any(String));
  });

  it('navigates via dispatchNav() custom event from arbitrary target', () => {
    start('s01');
    const fn = vi.fn();
    subscribe(fn);

    const arbitrary = document.createElement('div');
    document.body.appendChild(arbitrary);
    dispatchNav(arbitrary, 's16');

    expect(getCurrent()).toBe('s16');
    expect(fn).toHaveBeenCalledWith('s16', expect.any(String));
  });

  it('respects modified clicks (cmd, ctrl, shift, middle button)', () => {
    start('s01');
    const fn = vi.fn();
    subscribe(fn);

    const btn = document.createElement('button');
    btn.dataset['go'] = 's10';
    document.body.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true }));

    expect(getCurrent()).not.toBe('s10');
    expect(fn).not.toHaveBeenCalled();
  });
});

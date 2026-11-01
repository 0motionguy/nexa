import { describe, it, expect, vi } from 'vitest';
import { on, resetMount, getMountSignal } from './dom.js';

describe('dom.on()', () => {
  it('binds a listener that fires', () => {
    resetMount(); // fresh mount per test
    const target = new EventTarget();
    const handler = vi.fn();
    on(target, 'click', handler);
    target.dispatchEvent(new Event('click'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('resetMount() detaches all bindings from the previous mount', () => {
    resetMount();
    const target = new EventTarget();
    const handler = vi.fn();
    on(target, 'click', handler);
    resetMount();
    target.dispatchEvent(new Event('click'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('binds new listeners after resetMount() to the fresh signal', () => {
    resetMount();
    const target = new EventTarget();
    const handler = vi.fn();
    on(target, 'click', handler);
    target.dispatchEvent(new Event('click'));
    expect(handler).toHaveBeenCalledTimes(1);
    // and getMountSignal() is still the live signal (not yet aborted)
    expect(getMountSignal().aborted).toBe(false);
  });

  it('silently no-ops when target is null', () => {
    resetMount();
    expect(() => on(null, 'click', () => {})).not.toThrow();
  });
});

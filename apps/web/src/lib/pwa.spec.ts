import { describe, expect, it, vi } from 'vitest';
import { registerMazeServiceWorker } from './pwa.js';

function fakeWorker() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    state: 'installing',
    addEventListener: vi.fn((event: string, fn: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    }),
    emit(event: string) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
  };
}

describe('registerMazeServiceWorker', () => {
  it('does not register outside production', () => {
    const register = vi.fn();
    const addLoadListener = vi.fn();

    const didRegister = registerMazeServiceWorker({
      isProd: false,
      serviceWorker: { register, controller: null },
      addLoadListener,
    });

    expect(didRegister).toBe(false);
    expect(addLoadListener).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers the app shell on load and reports update readiness', async () => {
    const installing = fakeWorker();
    const registrationListeners = new Map<string, Array<() => void>>();
    const registration = {
      installing,
      addEventListener: vi.fn((event: string, fn: () => void) => {
        const list = registrationListeners.get(event) ?? [];
        list.push(fn);
        registrationListeners.set(event, list);
      }),
    };
    const register = vi.fn().mockResolvedValue(registration);
    let onLoad: (() => void) | null = null;
    const onUpdateReady = vi.fn();

    const didRegister = registerMazeServiceWorker({
      isProd: true,
      serviceWorker: { register, controller: {} },
      addLoadListener: (fn) => {
        onLoad = fn;
      },
      onUpdateReady,
    });

    expect(didRegister).toBe(true);
    expect(onLoad).toBeTypeOf('function');
    onLoad!();
    await Promise.resolve();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    for (const fn of registrationListeners.get('updatefound') ?? []) fn();
    installing.state = 'installed';
    installing.emit('statechange');

    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });
});

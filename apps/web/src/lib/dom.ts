/**
 * Mount-scoped event listener helper (F004).
 *
 * Two AbortControllers:
 * - globalAbort: app-lifetime signal for event delegation and network events.
 * - screenAbort: per-screen signal reset on navigation/HMR/test cleanup.
 *
 * Usage:
 * - on(el, 'click', handler): per-screen lifetime.
 * - onGlobal(window, 'hashchange', fn): app lifetime.
 * - resetMount(): detach all per-screen listeners.
 */

const globalAbort = new AbortController();
let screenAbort = new AbortController();

/** @deprecated Kept for back-compat with existing tests. */
export function getMountSignal(): AbortSignal {
  return screenAbort.signal;
}

function resetScreen(): void {
  screenAbort.abort();
  screenAbort = new AbortController();
}

/**
 * Back-compat alias of resetScreen(). HMR dispose + the test harness call this.
 * @deprecated Prefer resetMount() only at lifecycle teardown sites.
 */
export function resetMount(): void {
  resetScreen();
}

/**
 * Add a per-screen listener. Auto-detached on the next resetScreen().
 * The signal in opts is always the current screen signal; caller-provided
 * signals are deliberately not honored.
 */
export function on<K extends keyof HTMLElementEventMap>(
  el: EventTarget | null,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void;
export function on<K extends keyof WindowEventMap>(
  el: Window | null,
  event: K,
  handler: (e: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void;
export function on<K extends keyof DocumentEventMap>(
  el: Document | null,
  event: K,
  handler: (e: DocumentEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void;
export function on(
  el: EventTarget | null,
  event: string,
  handler: EventListenerOrEventListenerObject,
  opts?: AddEventListenerOptions,
): void;
export function on(
  el: EventTarget | null,
  event: string,
  handler: EventListenerOrEventListenerObject,
  opts?: AddEventListenerOptions,
): void {
  if (!el) return;
  el.addEventListener(event, handler, { ...opts, signal: screenAbort.signal });
}

/**
 * Add an app-lifetime listener that survives screen transitions. Use for
 * event delegation handlers on document/window that should not be torn down
 * during normal navigation.
 */
export function onGlobal<K extends keyof HTMLElementEventMap>(
  el: EventTarget | null,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void;
export function onGlobal<K extends keyof WindowEventMap>(
  el: Window | null,
  event: K,
  handler: (e: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void;
export function onGlobal<K extends keyof DocumentEventMap>(
  el: Document | null,
  event: K,
  handler: (e: DocumentEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void;
export function onGlobal(
  el: EventTarget | null,
  event: string,
  handler: EventListenerOrEventListenerObject,
  opts?: AddEventListenerOptions,
): void;
export function onGlobal(
  el: EventTarget | null,
  event: string,
  handler: EventListenerOrEventListenerObject,
  opts?: AddEventListenerOptions,
): void {
  if (!el) return;
  el.addEventListener(event, handler, { ...opts, signal: globalAbort.signal });
}

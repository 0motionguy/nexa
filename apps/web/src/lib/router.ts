/**
 * Hash router ported from app-v2.html's data-go delegation pattern.
 *
 * Two click sources are supported:
 *
 *   1. Light-DOM elements with [data-go="<screen-id>"]
 *      — caught by document-level click listener walking event.composedPath()
 *      — works through open shadow DOM (any custom element rendering buttons
 *        inside shadowRoot in `mode: 'open'` will surface its target via
 *        composedPath()).
 *
 *   2. Components emitting a composed bubbling CustomEvent('nexa:nav', detail: { to })
 *      — used by closed-shadow components or when the source element doesn't
 *        carry data-go directly (e.g. a programmatic button).
 *
 * State: `location.hash = '#s08'` is the canonical address. Subscribers receive
 * the screen id without the `#`.
 */

export type ScreenId = string;

type Listener = (to: ScreenId, from: ScreenId | null) => void;

/**
 * F044 — beforeNavigate guard. Return `false` (or a string ScreenId to
 * redirect) to block the requested navigation. Common uses: auth gate
 * ("not signed in → reroute to s01 sign-in"), kill-switch ("agent paused →
 * stay on current screen").
 */
export type Guard = (to: ScreenId, from: ScreenId | null) => boolean | ScreenId;

const listeners = new Set<Listener>();
const guards = new Set<Guard>();
let current: ScreenId | null = null;
let started = false;
let notFoundHandler: ((requested: ScreenId) => ScreenId | void) | null = null;
let knownScreens: Set<ScreenId> | null = null;

function parseHash(): ScreenId {
  const raw = location.hash.replace(/^#/, '').trim();
  return raw || 's01';
}

function navigate(to: ScreenId, replace = false) {
  let target = to;

  // F044 — 404 fallback. When a known-screens set is registered, an
  // unrecognized hash hands off to the notFound handler; the handler may
  // return a replacement ScreenId or undefined (default fallback to s01).
  if (knownScreens && !knownScreens.has(target)) {
    const replacement = notFoundHandler ? notFoundHandler(target) : undefined;
    target = replacement ?? 's01';
  }

  const from = current;

  // F044 — pre-navigation guards. A guard may return false (block), a string
  // (redirect to that screen, no further guards run), or true (continue).
  for (const g of guards) {
    const verdict = g(target, from);
    if (verdict === false) return;
    if (typeof verdict === 'string' && verdict !== target) {
      navigate(verdict, true);
      return;
    }
  }

  current = target;
  const href = `#${target}`;
  if (replace) {
    history.replaceState(null, '', href);
  } else if (location.hash !== href) {
    history.pushState(null, '', href);
  }
  for (const l of listeners) l(target, from);
}

function onHashChange() {
  const to = parseHash();
  if (to !== current) navigate(to, true);
}

function onClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  // composedPath() pierces shadow DOM (open mode). Walk it to find a [data-go] ancestor.
  const path = e.composedPath();
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const to = node.dataset['go'];
    if (to) {
      e.preventDefault();
      navigate(to);
      return;
    }
  }
}

function onNavEvent(e: Event) {
  const detail = (e as CustomEvent<{ to?: string }>).detail;
  if (!detail || typeof detail.to !== 'string') return;
  e.stopPropagation();
  navigate(detail.to);
}

export function start(initial?: ScreenId): ScreenId {
  if (!started) {
    started = true;
    document.addEventListener('click', onClick, { capture: false });
    document.addEventListener('nexa:nav', onNavEvent as EventListener);
    window.addEventListener('hashchange', onHashChange);
  }
  const first = initial ?? parseHash();
  navigate(first, true);
  return first;
}

/** Test-only: clears subscribers + current state. Listeners stay registered (idempotent re-`start`). */
export function __resetForTests(): void {
  listeners.clear();
  guards.clear();
  notFoundHandler = null;
  knownScreens = null;
  current = null;
}

/**
 * F044 — register a beforeNavigate guard. Returns an unsubscriber.
 * Multiple guards are evaluated in registration order; the first to return
 * `false` or a redirect-string wins.
 */
export function registerGuard(g: Guard): () => void {
  guards.add(g);
  return () => guards.delete(g);
}

/**
 * F044 — declare the set of screens the app actually knows about. When this
 * is set, navigations to anything else are routed through the 404 handler
 * (or fall back to 's01' if no handler was registered). Unset = no 404
 * handling, every hash is navigable (legacy behavior).
 */
export function registerScreens(ids: Iterable<ScreenId>): void {
  knownScreens = new Set(ids);
}

/** F044 — handler invoked for unrecognized hashes. May return a replacement ScreenId. */
export function onNotFound(fn: (requested: ScreenId) => ScreenId | void): void {
  notFoundHandler = fn;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function go(to: ScreenId): void {
  navigate(to);
}

export function getCurrent(): ScreenId | null {
  return current;
}

/**
 * Helper for components: dispatch a navigation request via custom event.
 * Useful when the click handler lives inside the component and you don't want
 * to render a [data-go] attribute on a child element.
 */
export function dispatchNav(target: EventTarget, to: ScreenId): void {
  target.dispatchEvent(
    new CustomEvent('nexa:nav', {
      detail: { to },
      bubbles: true,
      composed: true,
    }),
  );
}

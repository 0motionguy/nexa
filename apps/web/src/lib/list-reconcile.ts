/**
 * Keyed in-place reconcile for imperative list hosts (PLANB fluid-UI W1).
 *
 * The market lists used to clear their host and rebuild every row on each
 * render; a "Show all" expansion rebuilt 175+ shadow-DOM rows in one long
 * task. This helper patches instead: rows keyed by an identity attribute are
 * reused (moved when order changed), new rows are created, departed rows are
 * handed to `onRemove` so registries (realtime hub subscriptions, price-row
 * maps) release cleanly.
 *
 * No vdom, no library — a single ordered walk with an insertion cursor.
 * Non-row children (empty-state rows, skeletons, the Show-all footer) are
 * cleared up front; the caller re-appends its footer after reconciling.
 */
export interface ReconcileKeyedListOptions<T> {
  /** Attribute carrying the row's identity, e.g. `data-mkt-coin`. */
  keyAttr: string;
  /** Selector for managed row elements; every other child is removed. */
  rowSelector: string;
  keyOf: (item: T) => string;
  create: (item: T) => HTMLElement;
  update: (el: HTMLElement, item: T) => void;
  /** Called for rows leaving the list, before DOM removal. */
  onRemove?: (el: HTMLElement) => void;
}

export function reconcileKeyedList<T>(
  host: HTMLElement,
  items: readonly T[],
  opts: ReconcileKeyedListOptions<T>,
): void {
  // 1) Drop unmanaged children (skeletons, empty rows, Show-all footer).
  for (const child of Array.from(host.children)) {
    if (!(child instanceof HTMLElement) || !child.matches(opts.rowSelector)) child.remove();
  }

  // 2) Index existing rows by key. Keyless or duplicate-key rows can't be
  //    reconciled — treat them as departures so registries stay clean.
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(host.children)) {
    const el = child as HTMLElement;
    const key = el.getAttribute(opts.keyAttr);
    if (key && !existing.has(key)) {
      existing.set(key, el);
    } else {
      opts.onRemove?.(el);
      el.remove();
    }
  }

  // 3) Walk the desired order with an insertion cursor: matching row under
  //    the cursor is free, otherwise the row (reused or new) is inserted
  //    before it. `insertBefore(el, null)` appends.
  let cursor = host.firstElementChild;
  for (const item of items) {
    const key = opts.keyOf(item);
    let el = existing.get(key) ?? null;
    if (el) existing.delete(key);
    else el = opts.create(item);
    opts.update(el, item);
    if (el === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      host.insertBefore(el, cursor);
    }
  }

  // 4) Anything still indexed is no longer in the list.
  for (const el of existing.values()) {
    opts.onRemove?.(el);
    el.remove();
  }
}

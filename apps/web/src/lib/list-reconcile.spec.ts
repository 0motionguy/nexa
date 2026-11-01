import { beforeEach, describe, expect, it } from 'vitest';
import { reconcileKeyedList, type ReconcileKeyedListOptions } from './list-reconcile.js';

interface Item {
  id: string;
  label: string;
}

function opts(removed: HTMLElement[] = []): ReconcileKeyedListOptions<Item> {
  return {
    keyAttr: 'data-key',
    rowSelector: '.row',
    keyOf: (item) => item.id,
    create: (item) => {
      const el = document.createElement('div');
      el.className = 'row';
      el.setAttribute('data-key', item.id);
      return el;
    },
    update: (el, item) => {
      el.textContent = item.label;
    },
    onRemove: (el) => {
      removed.push(el);
    },
  };
}

describe('reconcileKeyedList', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('creates rows in item order', () => {
    reconcileKeyedList(host, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], opts());
    expect([...host.children].map((c) => c.getAttribute('data-key'))).toEqual(['a', 'b']);
    expect(host.children[0]?.textContent).toBe('A');
  });

  it('reuses existing elements instead of rebuilding them', () => {
    reconcileKeyedList(host, [{ id: 'a', label: 'A' }], opts());
    const first = host.children[0];
    reconcileKeyedList(host, [{ id: 'a', label: 'A2' }], opts());
    expect(host.children[0]).toBe(first);
    expect(host.children[0]?.textContent).toBe('A2');
  });

  it('moves reused rows when the order changes', () => {
    reconcileKeyedList(host, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], opts());
    const [a, b, c] = [...host.children];
    reconcileKeyedList(host, [{ id: 'c', label: 'C' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }], opts());
    expect([...host.children]).toEqual([c, a, b]);
  });

  it('removes departed rows through onRemove', () => {
    const removed: HTMLElement[] = [];
    reconcileKeyedList(host, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], opts(removed));
    const b = host.children[1] as HTMLElement;
    reconcileKeyedList(host, [{ id: 'a', label: 'A' }], opts(removed));
    expect(removed).toContain(b);
    expect(host.children).toHaveLength(1);
  });

  it('clears non-row children like skeletons and footers', () => {
    const skeleton = document.createElement('div');
    skeleton.className = 'skel-row';
    host.appendChild(skeleton);
    const footer = document.createElement('button');
    footer.className = 'lrow market-show-all';
    host.appendChild(footer);
    reconcileKeyedList(host, [{ id: 'a', label: 'A' }], opts());
    expect(host.querySelector('.skel-row')).toBeNull();
    expect(host.querySelector('.market-show-all')).toBeNull();
    expect(host.children).toHaveLength(1);
  });

  it('drops keyless rows through onRemove so registries release', () => {
    const removed: HTMLElement[] = [];
    const stray = document.createElement('div');
    stray.className = 'row';
    host.appendChild(stray);
    reconcileKeyedList(host, [{ id: 'a', label: 'A' }], opts(removed));
    expect(removed).toContain(stray);
    expect([...host.children].map((c) => c.getAttribute('data-key'))).toEqual(['a']);
  });

  it('is append-only for a Show-all style expansion', () => {
    const page = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    reconcileKeyedList(host, page, opts());
    const [a, b] = [...host.children];
    const all = [...page, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }];
    reconcileKeyedList(host, all, opts());
    expect(host.children[0]).toBe(a);
    expect(host.children[1]).toBe(b);
    expect(host.children).toHaveLength(4);
  });
});

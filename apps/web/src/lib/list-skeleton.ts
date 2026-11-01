/**
 * Skeleton rows for market lists (PLANB fluid-UI W1).
 *
 * Loading placeholders in the exact geometry of the rows they replace, so
 * the swap to real rows causes zero layout shift:
 *   - 'market-row' → <nexa-market-row> geometry (46px logo tile, 70px row)
 *   - 'lrow'       → .lrow.cards-row geometry (44px thumb, ~70px row)
 *   - 'pm-card'    → Polymarket event-card block
 * Bars reuse the existing `.skel` shimmer primitive (reduced-motion aware
 * via the global html.rm gate). Layout classes live in app.css.
 */
export type ListSkeletonKind = 'market-row' | 'lrow' | 'pm-card';

export function buildSkeletonRow(kind: ListSkeletonKind): HTMLElement {
  if (kind === 'pm-card') {
    const card = document.createElement('div');
    card.className = 'skel skel-pm-card';
    card.setAttribute('aria-hidden', 'true');
    return card;
  }
  const row = document.createElement('div');
  row.className = kind === 'lrow' ? 'skel-row skel-lrow' : 'skel-row';
  row.setAttribute('aria-hidden', 'true');

  const logo = document.createElement('span');
  logo.className = 'skel skel-logo';
  row.appendChild(logo);

  const stack = document.createElement('span');
  stack.className = 'skel-stack';
  const title = document.createElement('span');
  title.className = 'skel skel-bar';
  stack.appendChild(title);
  const sub = document.createElement('span');
  sub.className = 'skel skel-bar sub';
  stack.appendChild(sub);
  row.appendChild(stack);

  const right = document.createElement('span');
  right.className = 'skel-right';
  const amt = document.createElement('span');
  amt.className = 'skel skel-bar amt';
  right.appendChild(amt);
  const pct = document.createElement('span');
  pct.className = 'skel skel-bar pct';
  right.appendChild(pct);
  row.appendChild(right);

  return row;
}

/** Replace the host's children with `count` skeleton rows. */
export function paintListSkeleton(host: HTMLElement, kind: ListSkeletonKind, count = 8): void {
  host.textContent = '';
  for (let i = 0; i < count; i++) host.appendChild(buildSkeletonRow(kind));
}

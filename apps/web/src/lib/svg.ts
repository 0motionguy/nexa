/**
 * Compile-time SVG icon helper.
 *
 * Parses an SVG string via DOMParser (which never executes scripts) and
 * clones the result. Caches the parsed node per string identity so each
 * icon is parsed at most once.
 *
 * All callers in this codebase MUST pass compile-time string constants —
 * never user input. DOMParser is safe-by-default but the convention keeps
 * the audit story simple.
 */

const STR_CACHE = new Map<string, SVGElement>();

function parse(markup: string): SVGElement {
  const cached = STR_CACHE.get(markup);
  if (cached) return cached;
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') {
    throw new Error(`svg(): expected <svg> root, got <${root.nodeName}>`);
  }
  // Detach from parser document so we can adopt it elsewhere
  const node = root as unknown as SVGElement;
  STR_CACHE.set(markup, node);
  return node;
}

/**
 * Clone the parsed SVG. Cached so repeated calls with the same string only
 * parse once.
 */
export function svg(markup: string): SVGElement {
  return parse(markup).cloneNode(true) as SVGElement;
}

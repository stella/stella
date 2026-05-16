/**
 * Runtime-checked DOM narrowing helpers.
 *
 * The folio editor frequently narrows DOM nodes from `Element` to
 * `HTMLElement` (for `.dataset`, `.style`, `.closest()` callbacks)
 * and from `Element | null` query results to specific subtypes.
 * The native TS types are correct but conservative: these helpers
 * replace ad-hoc `as HTMLElement` casts with `instanceof` checks
 * so a mismatched runtime value is caught at the narrowing point
 * instead of leaking through.
 *
 * Prefer these helpers over inline casts in folio DOM code.
 */

/**
 * Find the first element in `elements` that is an HTMLElement and
 * matches the predicate. Returns `null` if no match.
 */
export const findHtmlElement = (
  elements: readonly Element[],
  predicate: (el: HTMLElement) => boolean,
): HTMLElement | null => {
  for (const el of elements) {
    if (el instanceof HTMLElement && predicate(el)) {
      return el;
    }
  }
  return null;
};

/**
 * Query a single descendant element matching `selector` and return
 * it only if it's an HTMLElement; null otherwise.
 *
 * Equivalent to `el.querySelector<HTMLElement>(selector)` but with
 * a runtime instanceof check (querySelector's generic does not
 * actually validate at runtime).
 */
export const queryHtmlElement = (
  root: ParentNode,
  selector: string,
): HTMLElement | null => {
  const found = root.querySelector(selector);
  return found instanceof HTMLElement ? found : null;
};

/**
 * Walk ancestors of `node` and return the nearest one matching
 * `selector` that is an HTMLElement.
 */
export const closestHtmlElement = (
  node: Element | null,
  selector: string,
): HTMLElement | null => {
  if (!node) {
    return null;
  }
  const found = node.closest(selector);
  return found instanceof HTMLElement ? found : null;
};

/**
 * Return `el.children[index]` only if it is an HTMLElement;
 * `undefined` otherwise.
 */
export const childHtmlElement = (
  el: Element,
  index: number,
): HTMLElement | undefined => {
  const child = el.children[index];
  return child instanceof HTMLElement ? child : undefined;
};

/**
 * `querySelectorAll` that returns only HTMLElements.
 *
 * Use at trusted DOM sources (layout containers rendered by
 * `LayoutPainter`, our own `Toolbar`/`Sidebar` markup) where the
 * matched nodes are guaranteed by construction to be HTMLElements.
 * The instanceof filter runs once at the source so downstream
 * iteration is statically-typed and pays zero per-element cost.
 */
export const htmlQueryAll = (
  root: ParentNode,
  selector: string,
): HTMLElement[] => {
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll(selector)) {
    if (el instanceof HTMLElement) {
      out.push(el);
    }
  }
  return out;
};

/**
 * Assert that `node` is an HTMLElement, throwing if not.
 *
 * Use at a single trusted boundary where the surrounding code
 * relies on the node being an HTMLElement (e.g., immediately
 * after `pagesContainerRef.current` is null-checked). Downstream
 * code reads from the asserted variable with zero runtime cost.
 */
export const assertHtmlElement = (
  node: Node | null | undefined,
  description?: string,
): HTMLElement => {
  if (!(node instanceof HTMLElement)) {
    const where = description ? ` (${description})` : "";
    throw new TypeError(`Expected HTMLElement${where}`);
  }
  return node;
};

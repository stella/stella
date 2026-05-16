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

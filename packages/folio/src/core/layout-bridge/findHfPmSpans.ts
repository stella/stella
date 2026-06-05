/**
 * Slot-scoped sibling of `findBodyPmSpans` — locates `data-pm-start` markers
 * inside a single painted header/footer slot. The pointer pipeline uses these
 * to translate a click coordinate inside `.layout-page-header[data-rid="…"]`
 * (or footer) to a PM position on the matching hidden HF EditorView.
 *
 * Slot identity is the part-relationship id (`rId`) emitted by the painter on
 * the HF DOM node — never the `(hdrFtrType, kind)` tuple (two sections that
 * share a header by rId share both the painted spans and the EditorView).
 */

import { findPositionInSpan } from "./clickToPositionDom";

export type HfSlotKind = "header" | "footer";

function slotSelector(kind: HfSlotKind, rId: string): string {
  return kind === "header"
    ? `.layout-page-header[data-rid="${rId}"]`
    : `.layout-page-footer[data-rid="${rId}"]`;
}

function associatedSlotSelector(kind: HfSlotKind, rId: string): string {
  return `[data-hf-slot-kind="${kind}"][data-hf-rid="${rId}"]`;
}

function uniqueElements(elements: HTMLElement[]): HTMLElement[] {
  return Array.from(new Set(elements));
}

function querySlotDescendants(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
  selector: string,
): HTMLElement[] {
  return uniqueElements([
    ...Array.from(
      container.querySelectorAll<HTMLElement>(
        `${slotSelector(kind, rId)} ${selector}`,
      ),
    ),
    ...Array.from(
      container.querySelectorAll<HTMLElement>(
        `${associatedSlotSelector(kind, rId)} ${selector}`,
      ),
    ),
  ]);
}

function querySlotAnchors(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
  selector: string,
): HTMLElement[] {
  return uniqueElements([
    ...querySlotDescendants(container, kind, rId, selector),
    ...Array.from(
      container.querySelectorAll<HTMLElement>(
        `${associatedSlotSelector(kind, rId)}${selector}`,
      ),
    ),
  ]);
}

export function findHfPmSpans(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
): HTMLElement[] {
  return querySlotDescendants(
    container,
    kind,
    rId,
    "span[data-pm-start][data-pm-end]",
  );
}

export function findHfPmAnchors(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
): HTMLElement[] {
  return querySlotAnchors(container, kind, rId, "[data-pm-start]");
}

export function findHfPmAnchor(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
  pmStart: number,
): HTMLElement | null {
  if (!Number.isFinite(pmStart)) {
    return null;
  }
  return (
    container.querySelector<HTMLElement>(
      `${slotSelector(kind, rId)} [data-pm-start="${String(pmStart)}"]`,
    ) ??
    container.querySelector<HTMLElement>(
      `${associatedSlotSelector(kind, rId)} [data-pm-start="${String(pmStart)}"]`,
    ) ??
    container.querySelector<HTMLElement>(
      `${associatedSlotSelector(kind, rId)}[data-pm-start="${String(pmStart)}"]`,
    )
  );
}

/**
 * Locate the span that covers a PM position for caret rendering, including
 * `pmEnd` boundaries. `findHfPmAnchor` only matches `data-pm-start="${pos}"`
 * exactly; when the caret sits at the end of a run / paragraph,
 * `selection.from` equals that span's `data-pm-end` and the exact lookup
 * returns null. This helper falls back to a range scan over the slot's
 * `[data-pm-start][data-pm-end]` spans and reports the edge the caret
 * should hug so the renderer can pick `left` vs `right`.
 */
export type HfCaretSpanHit = {
  element: HTMLElement;
  /** Which edge of the span's getBoundingClientRect to anchor the caret to. */
  edge: "left" | "right";
};

export function findHfCaretSpan(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
  pos: number,
): HfCaretSpanHit | null {
  if (!Number.isFinite(pos)) {
    return null;
  }
  const exact = findHfPmAnchor(container, kind, rId, pos);
  if (exact) {
    return { element: exact, edge: "left" };
  }
  const spans = findHfPmSpans(container, kind, rId);
  let best: HfCaretSpanHit | null = null;
  for (const span of spans) {
    const startStr = span.dataset["pmStart"];
    const endStr = span.dataset["pmEnd"];
    if (startStr === undefined || endStr === undefined) {
      continue;
    }
    const start = Number.parseInt(startStr, 10);
    const end = Number.parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    if (pos === end) {
      // Exact end-of-span match — prefer the latest (rightmost) hit so
      // a caret at the boundary between two adjacent runs lands on the
      // right edge of the run that precedes it, matching browser
      // selection behaviour.
      best = { element: span, edge: "right" };
    } else if (pos > start && pos < end && !best) {
      // Mid-span coverage. Rare for a collapsed caret but keep the
      // fallback so anything weird still renders something.
      best = { element: span, edge: "left" };
    }
  }
  return best;
}

/**
 * Find the painted HF slot enclosing the given DOM target. Returns the
 * slot's kind and rId for the pointer pipeline to dispatch on the matching
 * hidden HF EditorView. Returns `null` when the target is not inside an HF
 * slot (body or unrelated chrome).
 */
type ClosestCapable = {
  closest(selector: string): HTMLElement | null;
};

function hasCloset(value: unknown): value is ClosestCapable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { closest?: unknown }).closest === "function"
  );
}

/**
 * Slot-scoped click-to-position mapper. `clickToPositionDom`'s fallback
 * (`findNearestSpan`) is hardcoded to `.layout-page-content` — body — so when
 * the user clicks HF whitespace (right of the text, between lines, etc.),
 * the body fallback can return a body PM position that the HF dispatch then
 * applies to the HF EditorView (clamped) and the caret leaps to an
 * unrelated HF doc position (Codex #487 P2: 21:02 review).
 *
 * Scope everything to the slot element: try the exact-span lookup via
 * `document.elementsFromPoint` filtered to descendants of `slot`; fall back
 * to nearest-span-in-line + start/end edge math within the same slot.
 */
export function clickToPositionInHfSlot(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
  clientX: number,
  clientY: number,
): number | null {
  const ownerDoc =
    container instanceof Element ? container.ownerDocument : document;
  const elements = ownerDoc.elementsFromPoint(clientX, clientY);
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) {
      continue;
    }
    // Match any painted slot with this rId — there can be one per page when
    // the same header is referenced across pages, so a drag that crosses
    // between paginated instances must accept the hit regardless of which
    // exact slot DOM node it lands in.
    const slot = findHfSlotForTarget(el);
    if (!slot || slot.kind !== kind || slot.rId !== rId) {
      continue;
    }
    if (
      el.tagName === "SPAN" &&
      el.dataset["pmStart"] !== undefined &&
      el.dataset["pmEnd"] !== undefined
    ) {
      return findPositionInSpan(el, clientX, clientY);
    }
  }
  return findNearestSpanInHfSlots(container, kind, rId, clientX, clientY);
}

function computeColDist(
  inside: boolean,
  rect: DOMRect,
  clientX: number,
): number {
  if (inside) {
    return 0;
  }
  if (clientX < rect.left) {
    return rect.left - clientX;
  }
  return clientX - rect.right;
}

function findNearestSpanInHfSlots(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
  clientX: number,
  clientY: number,
): number | null {
  const spans = findHfPmSpans(container, kind, rId);
  if (spans.length === 0) {
    return null;
  }
  // Pick the line whose vertical centre is closest to clientY, then the
  // span on that line whose horizontal range contains clientX, otherwise
  // the closest by horizontal distance. Mirrors clickToPositionDom's
  // body-fallback shape so the UX feels identical.
  let bestSpan: HTMLElement | null = null;
  let bestRowDist = Number.POSITIVE_INFINITY;
  let bestColDist = Number.POSITIVE_INFINITY;
  let bestInside = false;
  for (const span of spans) {
    const rect = span.getBoundingClientRect();
    const centerY = (rect.top + rect.bottom) / 2;
    const rowDist = Math.abs(clientY - centerY);
    const inside = clientX >= rect.left && clientX <= rect.right;
    const colDist = computeColDist(inside, rect, clientX);
    const better =
      rowDist < bestRowDist ||
      (rowDist === bestRowDist &&
        ((inside && !bestInside) ||
          (inside === bestInside && colDist < bestColDist)));
    if (better) {
      bestRowDist = rowDist;
      bestColDist = colDist;
      bestInside = inside;
      bestSpan = span;
    }
  }
  if (!bestSpan) {
    return null;
  }
  if (bestInside) {
    return findPositionInSpan(bestSpan, clientX, clientY);
  }
  const rect = bestSpan.getBoundingClientRect();
  if (clientX < rect.left) {
    const v = bestSpan.dataset["pmStart"];
    return v ? Number(v) : null;
  }
  const v = bestSpan.dataset["pmEnd"];
  return v ? Number(v) : null;
}

export function findHfSlotForTarget(target: Node | null): {
  kind: HfSlotKind;
  rId: string;
  element: HTMLElement;
} | null {
  if (!target) {
    return null;
  }
  if (!hasCloset(target)) {
    // Text nodes don't have `closest`; walk up via parentElement.
    const owner = (target as Node).parentElement;
    if (!owner) {
      return null;
    }
    return findHfSlotForTarget(owner);
  }
  const header = target.closest(".layout-page-header[data-rid]");
  if (header) {
    const rId = header.dataset["rid"];
    if (rId) {
      return { kind: "header", rId, element: header };
    }
  }
  const footer = target.closest(".layout-page-footer[data-rid]");
  if (footer) {
    const rId = footer.dataset["rid"];
    if (rId) {
      return { kind: "footer", rId, element: footer };
    }
  }
  const associated = target.closest("[data-hf-slot-kind][data-hf-rid]");
  if (associated) {
    const kind = associated.dataset["hfSlotKind"];
    const rId = associated.dataset["hfRid"];
    if ((kind === "header" || kind === "footer") && rId) {
      return { kind, rId, element: associated };
    }
  }
  return null;
}

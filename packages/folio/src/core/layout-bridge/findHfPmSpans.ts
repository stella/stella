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

export type HfSlotKind = "header" | "footer";

function slotSelector(kind: HfSlotKind, rId: string): string {
  return kind === "header"
    ? `.layout-page-header[data-rid="${rId}"]`
    : `.layout-page-footer[data-rid="${rId}"]`;
}

export function findHfPmSpans(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `${slotSelector(kind, rId)} span[data-pm-start][data-pm-end]`,
    ),
  );
}

export function findHfPmAnchors(
  container: ParentNode,
  kind: HfSlotKind,
  rId: string,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `${slotSelector(kind, rId)} [data-pm-start]`,
    ),
  );
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
  return container.querySelector<HTMLElement>(
    `${slotSelector(kind, rId)} [data-pm-start="${String(pmStart)}"]`,
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
  const exact = container.querySelector<HTMLElement>(
    `${slotSelector(kind, rId)} [data-pm-start="${String(pos)}"]`,
  );
  if (exact) {
    return { element: exact, edge: "left" };
  }
  const spans = container.querySelectorAll<HTMLElement>(
    `${slotSelector(kind, rId)} span[data-pm-start][data-pm-end]`,
  );
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
  return null;
}

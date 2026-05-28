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
 * Find the painted HF slot enclosing the given DOM target. Returns the
 * slot's kind and rId for the pointer pipeline to dispatch on the matching
 * hidden HF EditorView. Returns `null` when the target is not inside an HF
 * slot (body or unrelated chrome).
 */
export function findHfSlotForTarget(target: Node | null): {
  kind: HfSlotKind;
  rId: string;
  element: HTMLElement;
} | null {
  if (!(target instanceof Element)) {
    if (!target) {
      return null;
    }
    const owner = target.parentElement;
    if (!owner) {
      return null;
    }
    return findHfSlotForTarget(owner);
  }
  const header = target.closest<HTMLElement>(".layout-page-header[data-rid]");
  if (header) {
    const rId = header.dataset["rid"];
    if (rId) {
      return { kind: "header", rId, element: header };
    }
  }
  const footer = target.closest<HTMLElement>(".layout-page-footer[data-rid]");
  if (footer) {
    const rId = footer.dataset["rid"];
    if (rId) {
      return { kind: "footer", rId, element: footer };
    }
  }
  return null;
}

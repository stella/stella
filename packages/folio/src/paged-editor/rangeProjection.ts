/**
 * Shared range → paged-canvas rectangle projection.
 *
 * Folio's editor lives off-screen, so features that paint over the
 * document (anonymization highlights, template-directive widgets)
 * must project their `{ from, to }` PM ranges onto container-space
 * rectangles. This mirrors the SelectionOverlay flow: prefer real
 * painted-DOM rects (correct for indents, tabs, justified text, line
 * wraps) and fall back to the layout-coordinate `selectionToRects`
 * projection only for ranges whose DOM spans aren't mounted yet
 * (initial paint, off-screen pages).
 */

import { findBodyPmSpans } from "../core/layout-bridge/findBodyPmSpans";
import type { SelectionRect } from "../core/layout-bridge/selectionRects";
import type { FlowBlock, Layout, Measure } from "../core/layout-engine/types";

export type ProjectableRange = { from: number; to: number };

export type ProjectedRange<T extends ProjectableRange> = {
  range: T;
  rects: SelectionRect[];
};

export type RangeProjectionContext = {
  pagesContainer: HTMLElement;
  zoom: number;
  layout: Layout | null;
  blocks: FlowBlock[];
  measures: Measure[];
};

const pageIndexOf = (el: Element): number => {
  const page = el.closest(".layout-page");
  const raw =
    page instanceof HTMLElement ? page.dataset["pageNumber"] : undefined;
  return raw ? Number(raw) - 1 : 0;
};

/** Real painted-DOM rects for a PM range via `Range.getClientRects`. */
const domRectsForRange = (
  pmSpans: HTMLElement[],
  overlayRect: DOMRect,
  zoom: number,
  from: number,
  to: number,
): SelectionRect[] => {
  const rects: SelectionRect[] = [];
  for (const spanEl of pmSpans) {
    const pmStart = Number(spanEl.dataset["pmStart"]);
    const pmEnd = Number(spanEl.dataset["pmEnd"]);
    if (!(pmEnd > from && pmStart < to)) {
      continue;
    }
    if (spanEl.classList.contains("layout-run-tab")) {
      const spanRect = spanEl.getBoundingClientRect();
      rects.push({
        x: (spanRect.left - overlayRect.left) / zoom,
        y: (spanRect.top - overlayRect.top) / zoom,
        width: spanRect.width / zoom,
        height: spanRect.height / zoom,
        pageIndex: pageIndexOf(spanEl),
      });
      continue;
    }
    let textNode: Text | null = null;
    if (spanEl.firstChild?.nodeType === Node.TEXT_NODE) {
      textNode = spanEl.firstChild as Text;
    } else if (
      spanEl.firstChild instanceof HTMLElement &&
      spanEl.firstChild.tagName === "A" &&
      spanEl.firstChild.firstChild?.nodeType === Node.TEXT_NODE
    ) {
      textNode = spanEl.firstChild.firstChild as Text;
    }
    if (!textNode) {
      continue;
    }
    const startChar = Math.max(0, from - pmStart);
    const endChar = Math.min(textNode.length, to - pmStart);
    if (startChar >= endChar) {
      continue;
    }
    const range = spanEl.ownerDocument.createRange();
    range.setStart(textNode, startChar);
    range.setEnd(textNode, endChar);
    const pageIndex = pageIndexOf(spanEl);
    for (const rect of Array.from(range.getClientRects())) {
      rects.push({
        x: (rect.left - overlayRect.left) / zoom,
        y: (rect.top - overlayRect.top) / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
        pageIndex,
      });
    }
  }
  return rects;
};

/**
 * Stable text-column left edge in container space: the minimum painted run-span
 * left on the first page. Gutter widgets (e.g. the block-directive rail) anchor
 * to this instead of a single re-projected range's `rects[0].x`, which can flip
 * horizontally between paint passes while content above reflows. The page's
 * left margin is fixed, so this value holds steady as text is edited.
 */
export const measureContentLeft = (
  pagesContainer: HTMLElement,
  zoom: number,
): number | null => {
  const overlay = pagesContainer.parentElement?.querySelector(
    '[data-testid="selection-overlay"]',
  );
  const firstPage = pagesContainer.querySelector(".layout-page");
  if (!overlay || !firstPage) {
    return null;
  }
  const spans = findBodyPmSpans(firstPage);
  if (spans.length === 0) {
    return null;
  }
  const overlayLeft = overlay.getBoundingClientRect().left;
  let min = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const left = span.getBoundingClientRect().left;
    if (left < min) {
      min = left;
    }
  }
  return Number.isFinite(min) ? (min - overlayLeft) / zoom : null;
};

export const projectRangesToRects = async <T extends ProjectableRange>(
  ranges: readonly T[],
  ctx: RangeProjectionContext,
): Promise<ProjectedRange<T>[]> => {
  const { pagesContainer, zoom, layout, blocks, measures } = ctx;
  if (ranges.length === 0) {
    return [];
  }
  const overlay = pagesContainer.parentElement?.querySelector(
    '[data-testid="selection-overlay"]',
  );
  const firstPage = pagesContainer.querySelector(".layout-page");
  if (!overlay || !firstPage) {
    return [];
  }
  const overlayRect = overlay.getBoundingClientRect();
  const pageRect = firstPage.getBoundingClientRect();
  const pageOffsetX = (pageRect.left - overlayRect.left) / zoom;
  const pageOffsetY = (pageRect.top - overlayRect.top) / zoom;
  const pmSpans = findBodyPmSpans(pagesContainer);

  const result: ProjectedRange<T>[] = [];
  const fallback: T[] = [];
  for (const range of ranges) {
    const rects = domRectsForRange(
      pmSpans,
      overlayRect,
      zoom,
      range.from,
      range.to,
    );
    if (rects.length > 0) {
      result.push({ range, rects });
    } else {
      fallback.push(range);
    }
  }

  if (fallback.length > 0 && layout && blocks.length > 0) {
    const { selectionToRects } =
      await import("../core/layout-bridge/selectionRects");
    for (const range of fallback) {
      const rects = selectionToRects(
        layout,
        blocks,
        measures,
        range.from,
        range.to,
      ).map((rect) => ({
        height: rect.height,
        pageIndex: rect.pageIndex,
        width: rect.width,
        x: rect.x + pageOffsetX,
        y: rect.y + pageOffsetY,
      }));
      if (rects.length > 0) {
        result.push({ range, rects });
      }
    }
  }

  return result;
};

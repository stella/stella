/**
 * DOM-based Click-to-Position Mapping
 *
 * Uses the browser's actual rendered DOM to find ProseMirror positions.
 * This is more accurate than geometry-based calculation because it uses
 * the browser's own text rendering with document.elementsFromPoint().
 *
 * DOM elements are tagged with data-pm-start and data-pm-end attributes,
 * enabling binary search to find exact character positions.
 */

import {
  closestHtmlElement,
  findHtmlElement,
  htmlQueryAll,
  queryHtmlElement,
} from "../utils/domGuards";

/**
 * Find ProseMirror position from a click using DOM-based detection.
 *
 * @param container - The pages container element
 * @param clientX - Client X coordinate from mouse event
 * @param clientY - Client Y coordinate from mouse event
 * @param zoom - Current zoom level (default 1)
 * @returns ProseMirror position, or null if not found
 */
export function clickToPositionDom(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  zoom: number = 1,
): number | null {
  // Get all elements at the click point
  const elements = document.elementsFromPoint(clientX, clientY);

  // Find the page element
  const pageEl = findHtmlElement(elements, (el) =>
    el.classList.contains("layout-page"),
  );
  if (!pageEl) {
    return null;
  }

  // Find span with PM position data
  const spanEl = findHtmlElement(
    elements,
    (el) =>
      el.tagName === "SPAN" &&
      el.dataset["pmStart"] !== undefined &&
      el.dataset["pmEnd"] !== undefined,
  );

  if (spanEl) {
    return findPositionInSpan(spanEl, clientX, clientY);
  }

  // Check for empty paragraphs (including inside table cells)
  const emptyRun = findHtmlElement(elements, (el) =>
    el.classList.contains("layout-empty-run"),
  );
  if (emptyRun) {
    const paragraph = closestHtmlElement(emptyRun, ".layout-paragraph");
    if (paragraph && paragraph.dataset["pmStart"]) {
      return Number(paragraph.dataset["pmStart"]);
    }
  }

  // Check for paragraph elements directly (handles clicks in whitespace
  // to the right of text, or table cells where the narrow empty-run span
  // isn't hit but the parent paragraph div is)
  const paragraphEl = findHtmlElement(
    elements,
    (el) =>
      el.classList.contains("layout-paragraph") &&
      el.dataset["pmStart"] !== undefined,
  );
  if (paragraphEl && paragraphEl.dataset["pmStart"]) {
    // Try to find the nearest span within this paragraph so clicks to the
    // right of text land at the end of the line, not the paragraph start.
    const nearestPos = findNearestSpanInElement(paragraphEl, clientX, clientY);
    if (nearestPos !== null) {
      return nearestPos;
    }
    return Number(paragraphEl.dataset["pmStart"]);
  }

  // Check if click is within a table cell. When clicking in empty space below
  // text in a cell, restrict the search to spans within that cell to avoid
  // the cursor jumping to a different cell (fixes #54).
  const cellEl = findHtmlElement(elements, (el) =>
    el.classList.contains("layout-table-cell"),
  );
  if (cellEl) {
    return findNearestSpanInElement(cellEl, clientX, clientY);
  }

  // Fallback: Find nearest text span on the page
  return findNearestSpan(container, pageEl, clientX, clientY, zoom);
}

/**
 * Find exact position within a text span. Defers to the
 * browser's own hit-tester (`caretPositionFromPoint` /
 * `caretRangeFromPoint`) — that's what every native text
 * editor uses, and it correctly handles bidi runs, kerning,
 * variable fonts, sub-pixel rendering, and line wrap. Falls
 * back to a per-glyph rect scan when the browser API is
 * unavailable or returns a point outside this span (e.g. the
 * caret API resolved to a sibling text node at the same y).
 */
export function findPositionInSpan(
  spanEl: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  const pmStart = Number(spanEl.dataset["pmStart"]);
  const pmEnd = Number(spanEl.dataset["pmEnd"]);

  // Special handling for tab spans - they have a visual width but only contain NBSP
  // Clicking anywhere on a tab should position cursor at start or end based on click position
  if (spanEl.classList.contains("layout-run-tab")) {
    const rect = spanEl.getBoundingClientRect();
    const midpoint = (rect.left + rect.right) / 2;
    // Click in left half -> start of tab, right half -> end of tab
    return clientX < midpoint ? pmStart : pmEnd;
  }

  const textNode = spanEl.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    // No text content - return start position
    return pmStart;
  }

  const text = textNode as Text;
  const textLength = text.length;

  if (textLength === 0) {
    return pmStart;
  }

  const ownerDoc = spanEl.ownerDocument;
  const native = caretOffsetFromPoint(ownerDoc, text, clientX, clientY);
  if (native !== null) {
    return pmStart + Math.min(native, pmEnd - pmStart);
  }

  // Fallback: per-glyph rect scan. Pick the glyph whose
  // visual midpoint is closest to `clientX` rather than
  // walking forward and breaking on the first midpoint
  // past the cursor — that shortcut assumes monotonic
  // increasing X, which is only true for LTR runs and
  // would resolve to the wrong glyph in a bidi/RTL
  // section. Distance-minimisation is direction-agnostic.
  // The earlier binary search compared `clientX` against
  // the `getBoundingClientRect().left` of a collapsed
  // range at offset `mid`, but that's the *caret* X
  // (boundary between glyphs N-1 and N), not any glyph's
  // centre, and the tie-break preferred the caret to the
  // right of the click on every exact midpoint, which
  // shifted drag selections one PM position left.
  // Reuse a single `Range` across the whole loop —
  // `createRange()` per iteration leaks DOM allocations
  // on long spans, and each `getBoundingClientRect()`
  // already forces a layout reflow we can't avoid.
  const range = ownerDoc.createRange();
  let bestOffset = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < textLength; i++) {
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    const midpoint = rect.left + rect.width / 2;
    const distance = Math.abs(clientX - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      // Click lands in the right half of glyph `i` →
      // caret should sit AFTER the glyph (offset i+1);
      // left half → caret BEFORE (offset i).
      bestOffset = clientX < midpoint ? i : i + 1;
    }
  }
  return pmStart + Math.min(bestOffset, pmEnd - pmStart);
}

/**
 * Resolve `(clientX, clientY)` to a character offset
 * inside `text` using the browser's caret hit-tester.
 * Returns `null` if the API is unavailable or resolved to
 * a different node — callers fall back to a glyph-by-glyph
 * scan in that case.
 */
function caretOffsetFromPoint(
  ownerDoc: Document,
  text: Text,
  clientX: number,
  clientY: number,
): number | null {
  // `caretPositionFromPoint` is the spec'd successor;
  // `caretRangeFromPoint` is the older WebKit-rooted API
  // still shipped by Chromium and Safari. Try both.
  type LegacyDocument = Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const doc: LegacyDocument = ownerDoc;
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (pos && pos.offsetNode === text) {
      return pos.offset;
    }
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (range && range.startContainer === text) {
      return range.startOffset;
    }
  }
  return null;
}

/**
 * Find the nearest text span within a specific element (e.g. a table cell).
 * Used when a click lands in empty space within a cell to keep the cursor
 * inside that cell rather than jumping to a different one.
 */
function findNearestSpanInElement(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): number | null {
  // Check for empty paragraphs within this element
  const emptyRun = queryHtmlElement(element, ".layout-empty-run");
  if (emptyRun) {
    const paragraph = closestHtmlElement(emptyRun, ".layout-paragraph");
    if (paragraph && paragraph.dataset["pmStart"]) {
      return Number(paragraph.dataset["pmStart"]);
    }
  }

  // Find the closest line within this element
  const lines = htmlQueryAll(element, ".layout-line");
  let closestLine: HTMLElement | null = null;
  let closestLineDistance = Infinity;

  for (const line of lines) {
    const rect = line.getBoundingClientRect();
    const centerY = (rect.top + rect.bottom) / 2;
    const distance = Math.abs(clientY - centerY);

    if (distance < closestLineDistance) {
      closestLineDistance = distance;
      closestLine = line;
    }
  }

  if (!closestLine) {
    // No lines - try paragraph directly
    const paragraph = queryHtmlElement(
      element,
      ".layout-paragraph[data-pm-start]",
    );
    if (paragraph?.dataset["pmStart"]) {
      return Number(paragraph.dataset["pmStart"]);
    }
    // Last resort: use the cell's own PM position
    if (element.dataset["pmStart"]) {
      return Number(element.dataset["pmStart"]);
    }
    return null;
  }

  // Find closest span in that line
  const lineSpans = htmlQueryAll(
    closestLine,
    "span[data-pm-start][data-pm-end]",
  );
  if (lineSpans.length === 0) {
    const paragraph = closestHtmlElement(closestLine, ".layout-paragraph");
    if (paragraph?.dataset["pmStart"]) {
      return Number(paragraph.dataset["pmStart"]);
    }
    return null;
  }

  let closestSpan: HTMLElement | null = null;
  let closestSpanDistance = Infinity;

  for (const spanEl of lineSpans) {
    const rect = spanEl.getBoundingClientRect();

    if (clientX >= rect.left && clientX <= rect.right) {
      return findPositionInSpan(spanEl, clientX, clientY);
    }

    const distance =
      clientX < rect.left ? rect.left - clientX : clientX - rect.right;
    if (distance < closestSpanDistance) {
      closestSpanDistance = distance;
      closestSpan = spanEl;
    }
  }

  if (!closestSpan) {
    return null;
  }

  const rect = closestSpan.getBoundingClientRect();
  if (clientX < rect.left) {
    return Number(closestSpan.dataset["pmStart"]);
  }
  return Number(closestSpan.dataset["pmEnd"]);
}

/**
 * Find the nearest text span when click is not directly on text.
 * This handles clicks in margins, between lines, etc.
 */
function findNearestSpan(
  _container: HTMLElement,
  pageEl: HTMLElement,
  clientX: number,
  clientY: number,
  _zoom: number,
): number | null {
  // Get all text spans on this page
  // Scope to body content — `pageEl` is the whole `.layout-page` and
  // includes header/footer subtrees whose `data-pm-start` collides with body
  // PM positions (HF content is a separate ProseMirror doc). Without scoping,
  // a click outside any body span could resolve to an HF position.
  const spans = htmlQueryAll(
    pageEl,
    ".layout-page-content span[data-pm-start][data-pm-end]",
  );
  if (spans.length === 0) {
    const firstP = htmlQueryAll(
      pageEl,
      ".layout-page-content .layout-paragraph",
    ).at(0);
    if (firstP) {
      return Number(firstP.dataset["pmStart"]) || 0;
    }
    return null;
  }

  // Find the closest line to the click Y
  const lines = htmlQueryAll(pageEl, ".layout-page-content .layout-line");
  let closestLine: HTMLElement | null = null;
  let closestLineDistance = Infinity;

  for (const line of lines) {
    const rect = line.getBoundingClientRect();
    const centerY = (rect.top + rect.bottom) / 2;
    const distance = Math.abs(clientY - centerY);

    if (distance < closestLineDistance) {
      closestLineDistance = distance;
      closestLine = line;
    }
  }

  if (!closestLine) {
    return null;
  }

  // Get spans in this line
  const lineSpans = htmlQueryAll(
    closestLine,
    "span[data-pm-start][data-pm-end]",
  );
  if (lineSpans.length === 0) {
    // Empty line - find PM position from paragraph
    const paragraph = closestHtmlElement(closestLine, ".layout-paragraph");
    if (paragraph?.dataset["pmStart"]) {
      return Number(paragraph.dataset["pmStart"]);
    }
    return null;
  }

  // Find closest span in the line
  let closestSpan: HTMLElement | null = null;
  let closestSpanDistance = Infinity;

  for (const spanEl of lineSpans) {
    const rect = spanEl.getBoundingClientRect();

    // Check if click is within span bounds
    if (clientX >= rect.left && clientX <= rect.right) {
      return findPositionInSpan(spanEl, clientX, clientY);
    }

    // Calculate distance to span
    const distance =
      clientX < rect.left ? rect.left - clientX : clientX - rect.right;

    if (distance < closestSpanDistance) {
      closestSpanDistance = distance;
      closestSpan = spanEl;
    }
  }

  if (!closestSpan) {
    return null;
  }

  const rect = closestSpan.getBoundingClientRect();

  // If click is to the left, return start; if right, return end
  if (clientX < rect.left) {
    return Number(closestSpan.dataset["pmStart"]);
  }
  return Number(closestSpan.dataset["pmEnd"]);
}

/**
 * Get selection rectangles for a PM range using DOM-based detection.
 *
 * @param container - The pages container element
 * @param from - Start PM position
 * @param to - End PM position
 * @param overlayRect - Bounding rect of the selection overlay
 * @returns Array of selection rectangles in overlay coordinates
 */
export type DomSelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
};

export function getSelectionRectsFromDom(
  container: HTMLElement,
  from: number,
  to: number,
  overlayRect: DOMRect,
): DomSelectionRect[] {
  const rects: DomSelectionRect[] = [];

  // Find all spans that intersect with the selection
  // Scope the query to body content. Headers and footers go through a
  // separate ProseMirror document whose positions also start at 1, so an
  // HF span can carry the same `data-pm-start` as a body run — without the
  // scope, body selections paint phantom rects on HF text and clicks in
  // body coords could resolve to HF positions.
  const spans = htmlQueryAll(
    container,
    ".layout-page-content span[data-pm-start][data-pm-end]",
  );

  for (const spanEl of spans) {
    const pmStart = Number(spanEl.dataset["pmStart"]);
    const pmEnd = Number(spanEl.dataset["pmEnd"]);

    // Check if span overlaps with selection
    if (pmEnd <= from || pmStart >= to) {
      continue;
    }

    const textNode = spanEl.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      continue;
    }

    const text = textNode as Text;
    const ownerDoc = spanEl.ownerDocument;

    // Calculate character range within this span
    const startChar = Math.max(0, from - pmStart);
    const endChar = Math.min(text.length, to - pmStart);

    if (startChar >= endChar) {
      continue;
    }

    // Create range for the selected text
    const range = ownerDoc.createRange();
    range.setStart(text, startChar);
    range.setEnd(text, endChar);

    // Get all client rects (handles line wraps)
    const clientRects = range.getClientRects();

    // Find page index
    const pageEl = closestHtmlElement(spanEl, ".layout-page");
    const pageIndex = pageEl
      ? Number(pageEl.dataset["pageNumber"] || 1) - 1
      : 0;

    for (const clientRect of Array.from(clientRects)) {
      rects.push({
        x: clientRect.left - overlayRect.left,
        y: clientRect.top - overlayRect.top,
        width: clientRect.width,
        height: clientRect.height,
        pageIndex,
      });
    }
  }

  return rects;
}

/**
 * Get caret position from DOM for a PM position.
 *
 * @param container - The pages container element
 * @param pmPos - ProseMirror position
 * @param overlayRect - Bounding rect of the selection overlay
 * @returns Caret position in overlay coordinates, or null
 */
export type DomCaretPosition = {
  x: number;
  y: number;
  height: number;
  pageIndex: number;
};

export function getCaretPositionFromDom(
  container: HTMLElement,
  pmPos: number,
  overlayRect: DOMRect,
): DomCaretPosition | null {
  // Find span containing this position
  // Scope the query to body content. Headers and footers go through a
  // separate ProseMirror document whose positions also start at 1, so an
  // HF span can carry the same `data-pm-start` as a body run — without the
  // scope, body selections paint phantom rects on HF text and clicks in
  // body coords could resolve to HF positions.
  const spans = htmlQueryAll(
    container,
    ".layout-page-content span[data-pm-start][data-pm-end]",
  );

  for (const spanEl of spans) {
    const pmStart = Number(spanEl.dataset["pmStart"]);
    const pmEnd = Number(spanEl.dataset["pmEnd"]);

    // Special handling for tab spans - use exclusive end to avoid boundary conflicts
    // Tab at [5,6) means position 6 belongs to the next run, not the tab
    if (spanEl.classList.contains("layout-run-tab")) {
      if (pmPos >= pmStart && pmPos < pmEnd) {
        const spanRect = spanEl.getBoundingClientRect();
        const pageEl = closestHtmlElement(spanEl, ".layout-page");
        const pageIndex = pageEl
          ? Number(pageEl.dataset["pageNumber"] || 1) - 1
          : 0;
        const lineEl = closestHtmlElement(spanEl, ".layout-line");
        const lineHeight = lineEl ? lineEl.offsetHeight : 16;

        // Position caret at start of tab (only position within tab)
        return {
          x: spanRect.left - overlayRect.left,
          y: spanRect.top - overlayRect.top,
          height: lineHeight,
          pageIndex,
        };
      }
      continue; // Skip to next span
    }

    // For text runs, use inclusive range
    if (pmPos >= pmStart && pmPos <= pmEnd) {
      const textNode = spanEl.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        // No text - use span bounds
        const spanRect = spanEl.getBoundingClientRect();
        const pageEl = closestHtmlElement(spanEl, ".layout-page");
        const pageIndex = pageEl
          ? Number(pageEl.dataset["pageNumber"] || 1) - 1
          : 0;
        const lineEl = closestHtmlElement(spanEl, ".layout-line");
        const lineHeight = lineEl ? lineEl.offsetHeight : 16;

        return {
          x: spanRect.left - overlayRect.left,
          y: spanRect.top - overlayRect.top,
          height: lineHeight,
          pageIndex,
        };
      }

      const text = textNode as Text;
      const charIndex = Math.min(pmPos - pmStart, text.length);

      const ownerDoc = spanEl.ownerDocument;

      const range = ownerDoc.createRange();
      range.setStart(text, charIndex);
      range.setEnd(text, charIndex);

      const rangeRect = range.getBoundingClientRect();
      const pageEl = closestHtmlElement(spanEl, ".layout-page");
      const pageIndex = pageEl
        ? Number(pageEl.dataset["pageNumber"] || 1) - 1
        : 0;
      const lineEl = closestHtmlElement(spanEl, ".layout-line");
      const lineHeight = lineEl ? lineEl.offsetHeight : 16;

      return {
        x: rangeRect.left - overlayRect.left,
        y: rangeRect.top - overlayRect.top,
        height: rangeRect.height || lineHeight,
        pageIndex,
      };
    }
  }

  // Check empty paragraphs
  const paragraphs = htmlQueryAll(container, ".layout-paragraph");
  for (const pEl of paragraphs) {
    const pStart = Number(pEl.dataset["pmStart"]);
    const pEnd = Number(pEl.dataset["pmEnd"]);

    if (pmPos >= pStart && pmPos <= pEnd) {
      const emptyRun = pEl.querySelector(".layout-empty-run");
      const targetEl = emptyRun || pEl;
      const rect = targetEl.getBoundingClientRect();

      const pageEl = closestHtmlElement(pEl, ".layout-page");
      const pageIndex = pageEl
        ? Number(pageEl.dataset["pageNumber"] || 1) - 1
        : 0;
      const lineCandidate = targetEl.closest(".layout-line") ?? targetEl;
      const lineHeight =
        lineCandidate instanceof HTMLElement ? lineCandidate.offsetHeight : 16;

      return {
        x: rect.left - overlayRect.left,
        y: rect.top - overlayRect.top,
        height: lineHeight,
        pageIndex,
      };
    }
  }

  return null;
}

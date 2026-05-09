/**
 * Shared utilities for layout-painter renderers.
 * Extracted to break import cycles between renderPage, renderParagraph, renderTable, etc.
 */

import type { ImageRun } from "../layout-engine/types";

/**
 * Context passed to fragment renderers
 */
export type RenderContext = {
  /** Current page number (1-indexed) */
  pageNumber: number;
  /** Total number of pages */
  totalPages: number;
  /** Which section is being rendered */
  section: "body" | "header" | "footer";
  /** Content width in pixels (page width minus margins) - used for justify */
  contentWidth?: number;
  /** When true, floating images render in-flow instead of being skipped (for table cells) */
  insideTableCell?: boolean;
};

/**
 * EMU to pixels conversion for floating image positioning
 */
export function emuToPixels(emu: number | undefined): number {
  if (emu === undefined) {
    return 0;
  }
  return Math.round((emu * 96) / 914_400);
}

/**
 * Check if an image run is a floating image (positioned at page level rather
 * than participating in inline flow).
 *
 * Includes wrapNone variants (`behind` / `inFront`) — those are anchored at
 * absolute coordinates but do not interact with line measurement; text paints
 * over or under them. They still need to be lifted out of the paragraph flow.
 */
export function isFloatingImageRun(run: ImageRun): boolean {
  const wrapType = run.wrapType;
  const displayMode = run.displayMode;

  if (
    wrapType === "square" ||
    wrapType === "tight" ||
    wrapType === "through" ||
    wrapType === "behind" ||
    wrapType === "inFront"
  ) {
    return true;
  }

  // Explicit float display mode (covers callers that set displayMode without a
  // wrapType, e.g. legacy ProseMirror nodes pre-dating the wrap-type roundtrip).
  if (displayMode === "float") {
    return true;
  }

  return false;
}

/**
 * Check if a floating image should create a text-wrap exclusion zone.
 *
 * `behind` / `inFront` (wrapNone) and `topAndBottom` images do *not* shrink
 * line widths in Word: text either flows above/below them as a block (TaB) or
 * paints over/under them (wrapNone). Only `square` / `tight` / `through`
 * actually divert lines around the image.
 *
 * `displayMode === "float"` with a CSS float direction is treated as wrapping
 * for ProseMirror nodes that don't carry a wrap type but do float.
 */
export function isTextWrappingFloatingImageRun(run: ImageRun): boolean {
  const wrapType = run.wrapType;

  if (
    wrapType === "behind" ||
    wrapType === "inFront" ||
    wrapType === "topAndBottom"
  ) {
    return false;
  }

  if (wrapType === "square" || wrapType === "tight" || wrapType === "through") {
    return true;
  }

  return run.displayMode === "float" && run.cssFloat !== "none";
}

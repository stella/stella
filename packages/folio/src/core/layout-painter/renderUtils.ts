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
 * Check if an image run is a floating image (should be positioned at page level)
 */
export function isFloatingImageRun(run: ImageRun): boolean {
  const wrapType = run.wrapType;
  const displayMode = run.displayMode;

  // Floating images have specific wrap types that allow text to flow around them
  if (wrapType && ["square", "tight", "through"].includes(wrapType)) {
    return true;
  }

  // Or explicit float display mode (but not topAndBottom — those are block images)
  if (displayMode === "float") {
    return true;
  }

  return false;
}

/**
 * Shared utilities for layout-painter renderers.
 * Extracted to break import cycles between renderPage, renderParagraph, renderTable, etc.
 */

import type { ImageRun } from "../layout-engine/types";

// `isFloatingImageRun` and `isTextWrappingFloatingImageRun` are pure
// predicates over `ImageRun` and now live in `layout-engine/types` so the
// bridge can call them without importing across the layer boundary. They
// are re-exported here for back-compat with existing painter consumers.
export {
  isFloatingImageRun,
  isTextWrappingFloatingImageRun,
} from "../layout-engine/types";

/**
 * Horizontal alignment for an image alone on a line. An anchored image
 * (`wp:positionH`, i.e. `position.horizontal` present) is positioned by its
 * OWN alignment, independent of the paragraph's `jc` — and defaults to LEFT
 * like Word, NOT the paragraph alignment (which would wrongly centre a
 * left-anchored header logo in a centred paragraph). An inline image (no
 * anchor) follows the paragraph alignment. Word's `inside`/`outside` collapse
 * to left/right (eigenpal/docx-editor#787, issue #777).
 */
export function resolveImageLineAlign(
  imageRun: ImageRun,
  paragraphAlignment: "left" | "center" | "right" | "justify" | undefined,
): "left" | "center" | "right" | "justify" | undefined {
  const horizontal = imageRun.position?.horizontal;
  if (!horizontal) {
    return paragraphAlignment;
  }
  switch (horizontal.align) {
    case "center":
      return "center";
    case "right":
    case "outside":
      return "right";
    default:
      // left, inside, or unspecified — Word's anchored default is left.
      return "left";
  }
}

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
  /** Bookmark name -> 1-indexed page, for resolving PAGEREF fields. */
  bookmarkPages?: ReadonlyMap<string, number>;
  /** Bookmark name -> paragraph text, for resolving REF fields. */
  bookmarkText?: ReadonlyMap<string, string>;
  /** Field run `pmStart` -> precomputed SEQ value, for resolving SEQ fields. */
  seqValues?: ReadonlyMap<number, number>;
  /** Pages in this page's section, for resolving SECTIONPAGES fields. */
  sectionPages?: number;
  /** Content width in pixels (page width minus margins) - used for justify */
  contentWidth?: number;
  /** When true, floating images render in-flow instead of being skipped (for table cells) */
  insideTableCell?: boolean;
  /**
   * How the renderer should position its outer element. The body lays
   * fragments at absolute (x, y) on the page (`'absolute'`), while
   * headers/footers stack blocks vertically inside their own container
   * (`'absolute'` with caller-supplied top/left). The default is
   * undefined; renderers fall back to `position: relative` and let the
   * caller override styles.
   */
  positioning?: "absolute" | "flow";
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

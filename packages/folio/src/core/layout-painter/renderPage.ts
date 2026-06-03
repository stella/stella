/**
 * Page Renderer
 *
 * Renders a single page from Layout data to DOM elements.
 * Each page contains positioned fragments within a content area.
 */

import { panic } from "better-result";

import {
  measureParagraph,
  rectsToFloatingZones,
} from "../layout-engine/measure";
import type {
  FloatingExclusionRect,
  FloatingImageZone,
} from "../layout-engine/measure";
import {
  FOOTNOTE_ENTRY_MARGIN_BOTTOM,
  FOOTNOTE_FALLBACK_LINE_HEIGHT,
  FOOTNOTE_SEPARATOR_HEIGHT,
  floatingTextBoxWrapsText,
  isFloatingTextBoxBlock,
} from "../layout-engine/types";
import type {
  Page,
  Fragment,
  FlowBlock,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  ParagraphFragment,
  ParagraphBorders,
  TableBlock,
  TableCell,
  TableMeasure,
  TableFragment,
  TableRow,
  ImageBlock,
  ImageMeasure,
  ImageFragment,
  ImageRun,
  Run,
  TextBoxBlock,
  TextBoxMeasure,
  TextBoxFragment,
  FootnoteContent,
  HeaderFooterContent,
} from "../layout-engine/types";
import type { BorderSpec, Theme, Watermark } from "../types/document";
import { resolveFontFamily } from "../utils/fontResolver";
import { borderToStyle } from "../utils/formatToStyle";
import { eighthsToPixels, pointsToPixels } from "../utils/units";
import type { BlockLookup } from "./index";
import { renderFragment } from "./renderFragment";
import {
  applyImageVisualAttrs,
  hasImageVisualAttrs,
  renderImageFragment,
} from "./renderImage";
import { renderParagraphFragment } from "./renderParagraph";
import { renderTableFragment } from "./renderTable";
import { renderTextBoxFragment } from "./renderTextBox";
import {
  emuToPixels,
  isFloatingImageRun,
  isTextWrappingFloatingImageRun,
} from "./renderUtils";
import type { RenderContext } from "./renderUtils";
import { renderWatermarkLayer } from "./renderWatermark";

/**
 * Page-level floating image that has been extracted from paragraphs.
 * These are positioned absolutely within the page's content area.
 */
type PageFloatingImage = {
  src: string;
  width: number;
  height: number;
  alt?: string;
  transform?: string;
  /**
   * Opacity in [0, 1] from `<a:alphaModFix amt>`. Undefined / 1 means fully
   * opaque. eigenpal #424 (opacity render pipeline).
   */
  opacity?: number;
  /** Which side: 'left' for left margin, 'right' for right margin */
  side: "left" | "right";
  /** X position relative to content area (0 = left edge of content) */
  x: number;
  /** Y position relative to content area (0 = top of content) */
  y: number;
  /** Wrap distances */
  distTop: number;
  distBottom: number;
  distLeft: number;
  distRight: number;
  /** ProseMirror start position for click-to-select */
  pmStart?: number;
  /** ProseMirror end position */
  pmEnd?: number;
  /** OOXML wrapText: which side(s) TEXT flows on */
  wrapText?: "bothSides" | "left" | "right" | "largest";
  /** Wrap type (square, tight, through, topAndBottom, behind, inFront) */
  wrapType?: string;
  /**
   * Whether this image creates a text-wrap exclusion zone (line widths shrink
   * around it). False for `behind`/`inFront` (wrapNone) and `topAndBottom`.
   */
  affectsTextWrap: boolean;
  /**
   * Whether this image paints behind body text. True only for `wrapType ===
   * "behind"` — the page-level layer is split into a behind-text and
   * above-text layer so wrapNone semantics survive in the DOM.
   */
  behindDoc: boolean;
};

/**
 * CSS class names for page elements
 */
export const PAGE_CLASS_NAMES = {
  page: "layout-page",
  content: "layout-page-content",
  header: "layout-page-header",
  footer: "layout-page-footer",
};

// RenderContext is re-exported from renderUtils
export type { RenderContext } from "./renderUtils";

export const getDefaultPageFontFamily = (): string =>
  resolveFontFamily("Calibri").cssFallback;

// HeaderFooterContent lives in `layout-engine/types` so the bridge can
// build it without importing across the layer boundary. Re-exported here
// for back-compat with callers that imported it from this module.
export type { HeaderFooterContent } from "../layout-engine/types";

/**
 * A single footnote item ready for rendering at page bottom.
 */
export type FootnoteRenderItem = {
  /** Display number (e.g. "1", "2") */
  displayNumber: string;
  /** Plain text content */
  text?: string;
  /** Pre-measured structured footnote content. */
  content?: Pick<FootnoteContent, "blocks" | "measures" | "height">;
};

/**
 * Options for rendering a page
 */
export type RenderPageOptions = {
  /** Document to create elements in (default: window.document) */
  document?: Document;
  /** Custom page class name */
  pageClassName?: string;
  /** Show page borders (for debugging) */
  showBorders?: boolean;
  /** Background color for pages */
  backgroundColor?: string;
  /** Drop shadow on pages */
  showShadow?: boolean;
  /** Header content to render (used for all pages, or pages 2+ when titlePg is set). */
  headerContent?: HeaderFooterContent;
  /** Footer content to render (used for all pages, or pages 2+ when titlePg is set). */
  footerContent?: HeaderFooterContent;
  /** Header content by part relationship id, used for section-scoped rendering. */
  headerContentByRId?: ReadonlyMap<string, HeaderFooterContent>;
  /** Footer content by part relationship id, used for section-scoped rendering. */
  footerContentByRId?: ReadonlyMap<string, HeaderFooterContent>;
  /** Header content for the first page only (when titlePg is set). */
  firstPageHeaderContent?: HeaderFooterContent;
  /** Footer content for the first page only (when titlePg is set). */
  firstPageFooterContent?: HeaderFooterContent;
  /** Whether different first page headers/footers are enabled (w:titlePg). */
  titlePg?: boolean;
  /** Distance from page top to header content. */
  headerDistance?: number;
  /** Distance from page bottom to footer content. */
  footerDistance?: number;
  /** Block lookup for rendering actual content. */
  blockLookup?: BlockLookup;
  /** OOXML page borders from section properties. */
  pageBorders?: {
    top?: BorderSpec;
    bottom?: BorderSpec;
    left?: BorderSpec;
    right?: BorderSpec;
    display?: "allPages" | "firstPage" | "notFirstPage";
    offsetFrom?: "page" | "text";
    zOrder?: "front" | "back";
  };
  /** Theme for resolving border colors. */
  theme?: Theme | null;
  /** Footnotes to render at the bottom of this page. */
  footnoteArea?: FootnoteRenderItem[];
  /**
   * Document watermark to paint behind page content. Word stores the
   * watermark on header parts; callers resolve it via
   * `getDocumentWatermark(doc)` and thread the same value to every page.
   */
  watermark?: Watermark;
  /**
   * Resolved image src for a picture watermark. The renderer cannot
   * resolve `imageRId` itself — relationship-id → asset URL belongs to
   * the package layer; without a resolved src a picture watermark is
   * silently skipped.
   */
  watermarkImageSrc?: string;
};

type HeaderFooterLayoutInfo = {
  flowTop: number;
  flowLeft: number;
  contentWidth: number;
  pageWidth: number;
  pageHeight: number;
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
};

/**
 * Apply page styles to an element
 */
function applyPageStyles(
  element: HTMLElement,
  width: number,
  height: number,
  options: RenderPageOptions,
): void {
  element.style.position = "relative";
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.backgroundColor =
    options.backgroundColor ?? "var(--doc-canvas, #ffffff)";
  element.style.color = "var(--doc-canvas-text, #1f2937)";
  element.style.overflow = "hidden";
  element.style.border = "none";
  element.style.boxShadow = "none";
  element.style.outline = "none";

  // Set default font styles (matches Word default: 11pt Calibri).
  // Keep this fallback chain aligned with canvas measurement so text widths
  // do not drift when Calibri is unavailable and Carlito is used instead.
  element.style.fontFamily = getDefaultPageFontFamily();
  // Use pixels to match Canvas-based measurements (11pt = 11 * 96/72 ≈ 14.67px)
  element.style.fontSize = `${(11 * 96) / 72}px`;
  element.style.color = "var(--doc-canvas-text, #000)";

  // Page borders are painted as a separate overlay (see renderPageBorderOverlay)
  // so they can honor OOXML offsetFrom/zOrder/display and remain text-relative.
}

function pageBorderShouldRender(
  pageNumber: number,
  display?: "allPages" | "firstPage" | "notFirstPage",
): boolean {
  switch (display ?? "allPages") {
    case "firstPage":
      return pageNumber === 1;
    case "notFirstPage":
      return pageNumber !== 1;
    case "allPages":
      return true;
  }
}

function pageBorderSpacePx(border: BorderSpec | undefined): number {
  return border?.space !== undefined ? pointsToPixels(border.space) : 0;
}

/**
 * Effective rendered border width in pixels. Mirrors `borderToStyle` (1px
 * floor for hairlines) and the 3px floor applied to double borders in
 * `applyPageBorderSide`, so callers can shift the overlay outward by the
 * exact stroke they will see on screen.
 */
function pageBorderWidthPx(border: BorderSpec | undefined): number {
  if (!border || border.style === "none" || border.style === "nil") {
    return 0;
  }
  const widthPx =
    border.size !== undefined && border.size !== 0
      ? eighthsToPixels(border.size)
      : 1;
  const floored = Math.max(1, widthPx);
  return border.style === "double" ? Math.max(3, floored) : floored;
}

function applyPageBorderSide(
  element: HTMLElement,
  border: BorderSpec | undefined,
  side: "Top" | "Bottom" | "Left" | "Right",
  theme?: Theme | null,
): void {
  if (!border || border.style === "none" || border.style === "nil") {
    return;
  }

  const styles = borderToStyle(border, side, theme);
  for (const [key, value] of Object.entries(styles)) {
    (element.style as unknown as Record<string, string>)[key] = String(value);
  }

  // Browsers collapse double borders narrower than 3px into a single line.
  const styleKey = `border${side}Style`;
  const widthKey = `border${side}Width`;
  const styleValue = (element.style as unknown as Record<string, string>)[
    styleKey
  ];
  if (styleValue === "double") {
    const widthValue = Number.parseFloat(
      (element.style as unknown as Record<string, string>)[widthKey] ?? "",
    );
    if (!Number.isFinite(widthValue) || widthValue < 3) {
      (element.style as unknown as Record<string, string>)[widthKey] = "3px";
    }
  }
}

function renderPageBorderOverlay(
  page: Page,
  options: RenderPageOptions,
  doc: Document,
): HTMLElement | null {
  const pb = options.pageBorders;
  if (!pb || !pageBorderShouldRender(page.number, pb.display)) {
    return null;
  }

  const hasBorder = [pb.top, pb.bottom, pb.left, pb.right].some(
    (border) => border && border.style !== "none" && border.style !== "nil",
  );
  if (!hasBorder) {
    return null;
  }

  const offsetFrom = pb.offsetFrom ?? "text";
  const topOffset = pageBorderSpacePx(pb.top);
  const rightOffset = pageBorderSpacePx(pb.right);
  const bottomOffset = pageBorderSpacePx(pb.bottom);
  const leftOffset = pageBorderSpacePx(pb.left);

  const overlay = doc.createElement("div");
  overlay.className = "layout-page-border";
  overlay.style.position = "absolute";
  overlay.style.pointerEvents = "none";
  overlay.style.boxSizing = "border-box";
  overlay.style.zIndex = pb.zOrder === "back" ? "0" : "20";

  if (offsetFrom === "page") {
    overlay.style.top = `${topOffset}px`;
    overlay.style.right = `${rightOffset}px`;
    overlay.style.bottom = `${bottomOffset}px`;
    overlay.style.left = `${leftOffset}px`;
  } else {
    // With box-sizing: border-box, the border paints inside the overlay,
    // so for offsetFrom="text" we must shift each side outward by both
    // `space` (text↔border gap) and the visible stroke width to preserve
    // the OOXML gap when borders are thick or doubled.
    const topWidth = pageBorderWidthPx(pb.top);
    const rightWidth = pageBorderWidthPx(pb.right);
    const bottomWidth = pageBorderWidthPx(pb.bottom);
    const leftWidth = pageBorderWidthPx(pb.left);
    overlay.style.top = `${Math.max(0, page.margins.top - topOffset - topWidth)}px`;
    overlay.style.right = `${Math.max(0, page.margins.right - rightOffset - rightWidth)}px`;
    overlay.style.bottom = `${Math.max(0, page.margins.bottom - bottomOffset - bottomWidth)}px`;
    overlay.style.left = `${Math.max(0, page.margins.left - leftOffset - leftWidth)}px`;
  }

  applyPageBorderSide(overlay, pb.top, "Top", options.theme);
  applyPageBorderSide(overlay, pb.bottom, "Bottom", options.theme);
  applyPageBorderSide(overlay, pb.left, "Left", options.theme);
  applyPageBorderSide(overlay, pb.right, "Right", options.theme);

  return overlay;
}

/**
 * Refresh the page-border overlay on an existing page shell so incremental
 * rerenders pick up changes to size, margins, page number, or pageBorders
 * options. Removes any stale `.layout-page-border` child before re-attaching
 * with the current z-order (back → first child, front → last child).
 */
function syncPageBorderOverlay(
  pageEl: HTMLElement,
  page: Page,
  options: RenderPageOptions,
  doc: Document,
): void {
  for (const stale of Array.from(
    pageEl.querySelectorAll<HTMLElement>(":scope > .layout-page-border"),
  )) {
    stale.remove();
  }
  const overlay = renderPageBorderOverlay(page, options, doc);
  if (!overlay) {
    return;
  }
  if (options.pageBorders?.zOrder === "back") {
    pageEl.prepend(overlay);
  } else {
    pageEl.append(overlay);
  }
}

/**
 * Apply content area styles to an element
 */
function applyContentAreaStyles(element: HTMLElement, page: Page): void {
  const margins = page.margins;

  element.style.position = "absolute";
  element.style.top = `${margins.top}px`;
  element.style.left = `${margins.left}px`;
  element.style.right = `${margins.right}px`;
  element.style.bottom = `${margins.bottom}px`;
  element.style.overflow = "visible";
}

function getPositionAlignment(
  position: { align?: string; alignment?: string } | undefined,
): string | undefined {
  return position?.align ?? position?.alignment;
}

function resolveHeaderFooterFloatTop(
  floatImg: {
    height: number;
    paragraphY: number;
    position: {
      vertical?: {
        relativeTo?: string;
        posOffset?: number;
        align?: string;
        alignment?: string;
      };
    };
  },
  layout: HeaderFooterLayoutInfo,
): number {
  const v = floatImg.position.vertical;
  if (!v) {
    return floatImg.paragraphY;
  }

  const align = getPositionAlignment(v);
  const offsetPx =
    v.posOffset !== undefined ? emuToPixels(v.posOffset) : undefined;

  if (v.relativeTo === "page") {
    if (offsetPx !== undefined) {
      return offsetPx - layout.flowTop;
    }
    if (align === "top") {
      return -layout.flowTop;
    }
    if (align === "bottom") {
      return layout.pageHeight - floatImg.height - layout.flowTop;
    }
    if (align === "center") {
      return (layout.pageHeight - floatImg.height) / 2 - layout.flowTop;
    }
  }

  if (v.relativeTo === "margin") {
    const marginTop = layout.margins.top;
    const marginHeight =
      layout.pageHeight - layout.margins.top - layout.margins.bottom;
    if (offsetPx !== undefined) {
      return marginTop + offsetPx - layout.flowTop;
    }
    if (align === "top") {
      return marginTop - layout.flowTop;
    }
    if (align === "bottom") {
      return marginTop + marginHeight - floatImg.height - layout.flowTop;
    }
    if (align === "center") {
      return marginTop + (marginHeight - floatImg.height) / 2 - layout.flowTop;
    }
  }

  if (offsetPx !== undefined) {
    return floatImg.paragraphY + offsetPx;
  }

  return floatImg.paragraphY;
}

/**
 * Resolve the on-page position of a floating header/footer table
 * (`<w:tbl><w:tblpPr ...>`). ECMA-376 §17.4.57. Returns coordinates
 * relative to the HF container (which itself is positioned at the page's
 * header or footer slot).
 */
function resolveHeaderFooterFloatingTablePosition(
  floating: NonNullable<TableBlock["floating"]>,
  measure: TableMeasure,
  layout: HeaderFooterLayoutInfo,
  sourceY: number,
): { left: number; top: number } {
  // Anchor-aware spec resolution: "right"/"bottom"/"center" are computed
  // relative to whichever frame the anchor selects (page vs margin).
  // Coordinates are returned relative to the HF container, so the page
  // anchor subtracts the HF flow origin (`flowLeft` / `flowTop`).
  const horzAnchor = floating.horzAnchor ?? "margin";
  const vertAnchor = floating.vertAnchor ?? "margin";
  const horzFrameWidth =
    horzAnchor === "page" ? layout.pageWidth : layout.contentWidth;
  const horzFrameOffset = horzAnchor === "page" ? -layout.flowLeft : 0;
  const vertFrameHeight =
    vertAnchor === "page"
      ? layout.pageHeight
      : layout.pageHeight - layout.margins.top - layout.margins.bottom;
  const vertFrameOffset =
    vertAnchor === "page"
      ? -layout.flowTop
      : layout.margins.top - layout.flowTop;

  // Horizontal. Match the body's `inside`/`outside` handling
  // (core/layout-engine: `inside` aliases left, `outside` aliases right).
  // We don't have facing-page context in HF rendering, so the simple
  // alias is the closest sensible match.
  let left = 0;
  const xSpec = floating.tblpXSpec;
  if (xSpec === "left" || xSpec === "inside") {
    left = horzFrameOffset;
  } else if (xSpec === "right" || xSpec === "outside") {
    left = horzFrameOffset + horzFrameWidth - measure.totalWidth;
  } else if (xSpec === "center") {
    left = horzFrameOffset + (horzFrameWidth - measure.totalWidth) / 2;
  } else if (floating.tblpX !== undefined) {
    left = horzFrameOffset + floating.tblpX;
  }

  // Vertical
  let top = sourceY;
  if (floating.tblpYSpec === "top") {
    top = vertFrameOffset;
  } else if (floating.tblpYSpec === "bottom") {
    top = vertFrameOffset + vertFrameHeight - measure.totalHeight;
  } else if (floating.tblpYSpec === "center") {
    top = vertFrameOffset + (vertFrameHeight - measure.totalHeight) / 2;
  } else if (floating.tblpY !== undefined) {
    top = vertFrameOffset + floating.tblpY;
  }

  return { left, top };
}

function applyHeaderFooterFloatHorizontalPosition(
  img: HTMLImageElement,
  floatImg: {
    width: number;
    position: {
      horizontal?: {
        relativeTo?: string;
        posOffset?: number;
        align?: string;
        alignment?: string;
      };
    };
  },
  layout: HeaderFooterLayoutInfo,
): void {
  const h = floatImg.position.horizontal;
  if (!h) {
    img.style.left = "0";
    return;
  }

  const align = getPositionAlignment(h);

  if (h.relativeTo === "page") {
    if (h.posOffset !== undefined) {
      img.style.left = `${emuToPixels(h.posOffset) - layout.flowLeft}px`;
      return;
    }
    if (align === "right") {
      img.style.left = `${layout.pageWidth - floatImg.width - layout.flowLeft}px`;
      return;
    }
    if (align === "center") {
      img.style.left = `${(layout.pageWidth - floatImg.width) / 2 - layout.flowLeft}px`;
      return;
    }
    if (align === "left") {
      img.style.left = `${-layout.flowLeft}px`;
      return;
    }
  }

  if (h.posOffset !== undefined) {
    img.style.left = `${emuToPixels(h.posOffset)}px`;
    return;
  }

  if (align === "right") {
    img.style.left = `${layout.contentWidth - floatImg.width}px`;
    return;
  }
  if (align === "center") {
    img.style.left = `${(layout.contentWidth - floatImg.width) / 2}px`;
    return;
  }

  img.style.left = "0";
}

/**
 * Apply fragment positioning styles
 * Note: Fragment x/y include page margins, but fragments are positioned
 * inside the content area which already has margin offsets applied.
 * So we subtract the margins to get content-area-relative positions.
 */
function applyFragmentStyles(
  element: HTMLElement,
  fragment: Fragment,
  margins: { left: number; top: number },
): void {
  element.style.position = "absolute";
  element.style.left = `${fragment.x - margins.left}px`;
  element.style.top = `${fragment.y - margins.top}px`;
  element.style.width = `${fragment.width}px`;

  // Height handling varies by fragment type
  if ("height" in fragment) {
    element.style.height = `${fragment.height}px`;
  }
}

// emuToPixels and isFloatingImageRun are re-exported from renderUtils
export { emuToPixels, isFloatingImageRun } from "./renderUtils";

/**
 * Page geometry needed to translate OOXML `relativeFrom` anchors into
 * painter coordinates. All values are in CSS pixels. Mirrors the upstream
 * (eigenpal docx-editor) `PageGeometry` shape introduced in #424 so the
 * anchor math stays identical across the two codebases.
 */
export type PageGeometry = {
  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  contentWidth: number;
  contentHeight: number;
};

/**
 * Resolved on-page coordinates for an anchored floating image.
 * `x` / `y` are in content-area-relative pixels (content origin = (0, 0)).
 * `side` feeds the text-wrap exclusion zone helper.
 */
export type AnchoredImagePosition = {
  x: number;
  y: number;
  side: "left" | "right";
};

// eigenpal #424 (positionV/H align): ECMA-376 §20.4.3.2 (ST_RelFromH).
// Maps the OOXML relativeFrom enum onto the painter's content-relative band.
// `baseX` is the band origin; `bandWidth` is the band's extent — both feed
// the align="left|center|right" / posOffset arithmetic below. We render
// single-sided, so `insideMargin` is treated as `leftMargin` (recto inside)
// and `outsideMargin` as `rightMargin` (recto outside).
function resolveHorizontalBand(
  relativeTo: string | undefined,
  geometry: PageGeometry,
): { baseX: number; bandWidth: number } {
  switch (relativeTo) {
    case "page":
      return { baseX: -geometry.marginLeft, bandWidth: geometry.pageWidth };
    case "leftMargin":
    case "insideMargin":
      return { baseX: -geometry.marginLeft, bandWidth: geometry.marginLeft };
    case "rightMargin":
    case "outsideMargin":
      return { baseX: geometry.contentWidth, bandWidth: geometry.marginRight };
    case "character":
      // `character` would need the originating run's x-position; we don't
      // thread that through the bridge yet. Anchor at the content origin.
      return { baseX: 0, bandWidth: 0 };
    default:
      // `column`, `margin`, and unknown values resolve to the content band.
      return { baseX: 0, bandWidth: geometry.contentWidth };
  }
}

// eigenpal #424 (positionV/H align): ECMA-376 §20.4.3.1 (ST_RelFromV).
// Symmetric with the horizontal helper. `topMargin` is the strip above
// the content area; `bottomMargin` is below it; `paragraph` / `line` fall
// back to the running paragraph anchor (no band). The resolver above
// uses `relativeTo` (not `bandHeight`) to detect the no-band case so a
// legitimately zero-sized margin still aligns correctly.
function resolveVerticalBand(
  relativeTo: string | undefined,
  fragmentY: number,
  geometry: PageGeometry,
): { baseY: number; bandHeight: number } {
  switch (relativeTo) {
    case "page":
      return { baseY: -geometry.marginTop, bandHeight: geometry.pageHeight };
    case "topMargin":
      return { baseY: -geometry.marginTop, bandHeight: geometry.marginTop };
    case "bottomMargin":
      return {
        baseY: geometry.contentHeight,
        bandHeight: geometry.marginBottom,
      };
    case "paragraph":
    case "line":
      return { baseY: fragmentY, bandHeight: 0 };
    default:
      // `margin`, `insideMargin`, `outsideMargin`, and unknown values all
      // resolve to the content band; vertical `*Margin` variants degenerate
      // to `margin` in a single-sided render.
      return { baseY: 0, bandHeight: geometry.contentHeight };
  }
}

/**
 * Resolve the on-page coordinates of an anchored floating image.
 *
 * Pure function — no DOM, no side effects — so the math is unit-testable
 * without spinning up a full page render. Used by
 * `extractFloatingImagesFromParagraph` for body anchors; mirrors the
 * upstream painter helper introduced in eigenpal #424.
 *
 * The OOXML position is `posOffset` (EMUs from the relativeFrom origin)
 * XOR `align` (symbolic top|center|bottom / left|center|right). When
 * neither is present, the spec means "anchor at the band origin"; for
 * paragraph/line that's the paragraph itself, otherwise the band origin
 * picked by `relativeFrom`.
 */
export function resolveAnchoredImagePosition(
  imgRun: ImageRun,
  fragmentY: number,
  geometry: PageGeometry,
): AnchoredImagePosition {
  const position = imgRun.position;
  const contentWidth = geometry.contentWidth;

  let side: "left" | "right" = "left";
  let x = 0;

  if (position?.horizontal) {
    const h = position.horizontal;
    const { baseX, bandWidth } = resolveHorizontalBand(h.relativeTo, geometry);
    // `character` is the only horizontal anchor that intentionally carries
    // no band (we don't yet thread the originating run's x); for every
    // other relativeFrom variant the band is real and `bandWidth === 0`
    // means the page legitimately has a zero-width strip (e.g. mirrored
    // margins on a no-margin layout), which should still be honoured.
    const horizontalHasBand = h.relativeTo !== "character";

    if (h.align === "right" || h.align === "outside") {
      // `outside` is the facing-page mirror of `right`. Without facing-page
      // context we treat it as the right edge of the band, matching Word's
      // single-sided render.
      side = "right";
      x = horizontalHasBand ? baseX + bandWidth - imgRun.width : 0;
    } else if (h.align === "left" || h.align === "inside") {
      side = "left";
      x = baseX;
    } else if (h.align === "center") {
      side = "left";
      x = horizontalHasBand ? baseX + (bandWidth - imgRun.width) / 2 : 0;
    } else if (h.posOffset !== undefined) {
      x = baseX + emuToPixels(h.posOffset);
      side = x > contentWidth / 2 ? "right" : "left";
    } else {
      // Bare positionH (no align, no offset) — anchor at the band origin.
      x = baseX;
    }
  } else if (imgRun.cssFloat === "right") {
    side = "right";
    x = contentWidth - imgRun.width;
  }

  let y: number;

  if (position?.vertical) {
    const v = position.vertical;
    const { baseY, bandHeight } = resolveVerticalBand(
      v.relativeTo,
      fragmentY,
      geometry,
    );
    // paragraph/line are the only vertical anchors without a band — they
    // ride the running paragraph's y, so align/center against a non-existent
    // band must defer to `fragmentY`. Every other relativeFrom variant has
    // a real band, so `bandHeight === 0` (e.g. zero top/bottom margin)
    // should still resolve via the band-relative math instead of falling
    // back to `fragmentY`.
    const verticalHasBand =
      v.relativeTo !== "paragraph" && v.relativeTo !== "line";

    if (v.align === "top" || v.align === "inside") {
      y = baseY;
    } else if (v.align === "center") {
      y = verticalHasBand
        ? baseY + (bandHeight - imgRun.height) / 2
        : fragmentY;
    } else if (v.align === "bottom" || v.align === "outside") {
      y = verticalHasBand ? baseY + bandHeight - imgRun.height : fragmentY;
    } else if (v.posOffset !== undefined) {
      y = baseY + emuToPixels(v.posOffset);
    } else {
      // Bare positionV — for paragraph/line bands the image stays in flow;
      // for any other band, the spec means "anchor at the band origin".
      y = verticalHasBand ? baseY : fragmentY;
    }
  } else {
    y = fragmentY;
  }

  return { x, y, side };
}

/**
 * Extract floating images from a paragraph block and determine their page-level positions.
 * Returns extracted images and info for the paragraph about space reserved.
 */
function extractFloatingImagesFromParagraph(
  block: ParagraphBlock,
  fragmentY: number, // Y position of the paragraph fragment on the page (relative to content area)
  geometry: PageGeometry,
): PageFloatingImage[] {
  const floatingImages: PageFloatingImage[] = [];

  for (const run of block.runs) {
    if (run.kind !== "image") {
      continue;
    }
    const imgRun = run as ImageRun;

    if (!isFloatingImageRun(imgRun)) {
      continue;
    }

    const distTop = imgRun.distTop ?? 0;
    const distBottom = imgRun.distBottom ?? 0;
    const distLeft = imgRun.distLeft ?? 12;
    const distRight = imgRun.distRight ?? 12;

    const { x, y, side } = resolveAnchoredImagePosition(
      imgRun,
      fragmentY,
      geometry,
    );

    // Derive wrapText from cssFloat:
    // cssFloat='left' → image floats left → text on right → wrapText='right'
    // cssFloat='right' → image floats right → text on left → wrapText='left'
    // cssFloat='none' or undefined → omit wrapText; rect.side drives the side
    // (preserves pre-eigenpal-#474 image wrap behavior — text boxes opt in to
    // the new bothSides splitting separately).
    let wrapText: "bothSides" | "left" | "right" | "largest" | undefined;
    if (imgRun.cssFloat === "left") {
      wrapText = "right";
    } else if (imgRun.cssFloat === "right") {
      wrapText = "left";
    }

    floatingImages.push({
      src: imgRun.src,
      width: imgRun.width,
      height: imgRun.height,
      ...(imgRun.alt !== undefined ? { alt: imgRun.alt } : {}),
      ...(imgRun.transform !== undefined
        ? { transform: imgRun.transform }
        : {}),
      // eigenpal #424 (opacity render pipeline). `!= null` so a PM null
      // schema default doesn't leak into PageFloatingImage.opacity.
      ...(imgRun.opacity != null ? { opacity: imgRun.opacity } : {}),
      side,
      x,
      y,
      distTop,
      distBottom,
      distLeft,
      distRight,
      ...(imgRun.pmStart !== undefined ? { pmStart: imgRun.pmStart } : {}),
      ...(imgRun.pmEnd !== undefined ? { pmEnd: imgRun.pmEnd } : {}),
      ...(wrapText !== undefined ? { wrapText } : {}),
      ...(imgRun.wrapType !== undefined ? { wrapType: imgRun.wrapType } : {}),
      affectsTextWrap: isTextWrappingFloatingImageRun(imgRun),
      behindDoc: imgRun.wrapType === "behind",
    });
  }

  return floatingImages;
}

/**
 * Render floating images into a page-level layer.
 *
 * `layerMode === "behind"` paints below body text (used for `behindDoc`
 * wrapNone images, e.g. full-page letterhead backgrounds). `"front"` paints
 * above text (default for `inFront` wrapNone and side-wrapping images).
 */
function renderFloatingImagesLayer(
  floatingImages: PageFloatingImage[],
  doc: Document,
  layerMode: "front" | "behind" = "front",
): HTMLElement {
  const layer = doc.createElement("div");
  layer.className =
    layerMode === "behind"
      ? "layout-floating-images-layer layout-floating-images-layer-behind"
      : "layout-floating-images-layer";
  layer.style.position = "absolute";
  layer.style.top = "0";
  layer.style.left = "0";
  layer.style.right = "0";
  layer.style.bottom = "0";
  layer.style.pointerEvents = "none"; // Allow clicks to pass through
  // Behind layer: leave default stacking so content (rendered after) paints
  // above. Front layer: lift above content fragments.
  if (layerMode === "front") {
    layer.style.zIndex = "10";
  }

  for (const floatImg of floatingImages) {
    const container = doc.createElement("div");
    container.className = "layout-page-floating-image";
    container.style.position = "absolute";
    container.style.pointerEvents = "auto"; // Make images clickable
    container.style.top = `${floatImg.y}px`;
    container.style.left = `${floatImg.x}px`;
    if (floatImg.pmStart !== undefined) {
      container.dataset["pmStart"] = String(floatImg.pmStart);
    }
    if (floatImg.pmEnd !== undefined) {
      container.dataset["pmEnd"] = String(floatImg.pmEnd);
    }

    const img = doc.createElement("img");
    img.src = floatImg.src;
    img.style.width = `${floatImg.width}px`;
    img.style.height = `${floatImg.height}px`;
    img.style.display = "block";
    if (floatImg.alt) {
      img.alt = floatImg.alt;
    }
    if (floatImg.transform) {
      img.style.transform = floatImg.transform;
    }
    // eigenpal #424 (opacity render pipeline)
    if (hasImageVisualAttrs(floatImg)) {
      applyImageVisualAttrs(img, floatImg);
    }

    container.append(img);
    layer.append(container);
  }

  return layer;
}

/**
 * Render header or footer content
 */
function renderHeaderFooterContent(
  content: HeaderFooterContent,
  context: RenderContext,
  options: RenderPageOptions,
  layout: HeaderFooterLayoutInfo,
): HTMLElement {
  const doc = options.document ?? document;
  const containerEl = doc.createElement("div");
  containerEl.style.position = "relative";

  // Use content width from context if available, otherwise default to reasonable width
  const contentWidth = context.contentWidth ?? 600;

  // Collect floating images to render separately, with their paragraph's Y position
  const floatingImages: {
    src: string;
    width: number;
    height: number;
    alt?: string;
    /**
     * Opacity in [0, 1] from `<a:alphaModFix amt>`. Undefined / 1 means
     * fully opaque. eigenpal #424 (opacity render pipeline).
     */
    opacity?: number;
    /** Run-level PM position so the pointer pipeline can NodeSelect HF images. */
    pmStart?: number;
    pmEnd?: number;
    paragraphY: number; // Y position of the containing paragraph
    behindDoc?: boolean;
    position: {
      horizontal?: {
        relativeTo?: string;
        posOffset?: number;
        align?: string;
        alignment?: string;
      };
      vertical?: {
        relativeTo?: string;
        posOffset?: number;
        align?: string;
        alignment?: string;
      };
    };
  }[] = [];

  let cursorY = 0;
  // Pass `positioning: 'absolute'` so renderers (and downstream readers of
  // RenderContext) know the HF caller is supplying its own top/left, rather
  // than the body case where the layout engine assigns fragment coordinates.
  const hfContext: RenderContext = { ...context, positioning: "absolute" };

  for (let i = 0; i < content.blocks.length; i++) {
    const block = content.blocks[i];
    const measure = content.measures[i];
    if (!block || !measure) {
      continue;
    }

    if (block.kind === "paragraph" && measure.kind === "paragraph") {
      const paragraphBlock = block;
      const paragraphMeasure = measure;

      // Track the Y position where this paragraph starts
      const paragraphStartY = cursorY;

      // Extract floating images and filter them from runs. Match the
      // body's classification (`isFloatingImageRun`) so images that are
      // floating by `wrapType`/`displayMode` alone — without an explicit
      // `<wp:positionH>`/`<wp:positionV>` — are still lifted out.
      // `renderParagraphFragment` skips them inline; without the matching
      // extraction here, a wrapped or behind header image without
      // explicit positioning would never render. Synthesize an empty
      // `position` for those runs; the float helpers fall through to a
      // paragraph-relative default.
      const inlineRuns: typeof paragraphBlock.runs = [];
      for (const run of paragraphBlock.runs) {
        if (run.kind === "image" && (isFloatingImageRun(run) || run.position)) {
          floatingImages.push({
            src: run.src,
            width: run.width,
            height: run.height,
            ...(run.alt !== undefined ? { alt: run.alt } : {}),
            // eigenpal #424 (opacity render pipeline). `!= null` so a PM
            // null schema default doesn't leak into the HF floating-image
            // collector.
            ...(run.opacity != null ? { opacity: run.opacity } : {}),
            ...(run.pmStart !== undefined ? { pmStart: run.pmStart } : {}),
            ...(run.pmEnd !== undefined ? { pmEnd: run.pmEnd } : {}),
            paragraphY: paragraphStartY,
            behindDoc: run.wrapType === "behind",
            position: run.position ?? {},
          });
        } else {
          // Keep non-floating runs for inline rendering
          inlineRuns.push(run);
        }
      }

      // Create a modified paragraph block without floating images
      const inlineBlock: ParagraphBlock = {
        ...paragraphBlock,
        runs: inlineRuns,
      };

      // Create a synthetic fragment for the paragraph
      const syntheticFragment: ParagraphFragment = {
        kind: "paragraph",
        blockId: paragraphBlock.id,
        x: 0,
        y: cursorY,
        width: contentWidth,
        height: paragraphMeasure.totalHeight,
        fromLine: 0,
        toLine: paragraphMeasure.lines.length,
      };

      const fragEl = renderParagraphFragment(
        syntheticFragment,
        inlineBlock,
        paragraphMeasure,
        hfContext,
        { document: doc },
      );

      // `paragraphMeasure.totalHeight` includes `spaceBefore + lines +
      // spaceAfter`, but `renderParagraphFragment` paints its first line at
      // the fragment top. The body's layout engine compensates by setting
      // `fragment.y = cursorY + spaceBefore` (see core/layout-engine
      // `addFragment`). Mirror that here so authored `w:spacing w:before`
      // visually pushes the first line down instead of being swallowed.
      // Only honor *explicit* spaceBefore: `normalizeHeaderFooterMeasureBlocks`
      // strips inherited (style-only) spacing from the measurement copy
      // (#380), so totalHeight already excludes it; offsetting by inherited
      // spaceBefore would shift the line below its reserved space and break
      // cursorY accumulation for following paragraphs.
      const explicitBefore =
        paragraphBlock.attrs?.spacingExplicit?.before === true;
      const spaceBefore = explicitBefore
        ? (paragraphBlock.attrs?.spacing?.before ?? 0)
        : 0;
      fragEl.style.position = "absolute";
      fragEl.style.top = `${cursorY + spaceBefore}px`;
      fragEl.style.left = "0";
      fragEl.style.width = `${contentWidth}px`;

      containerEl.append(fragEl);
      cursorY += paragraphMeasure.totalHeight;
    } else if (block.kind === "table" && measure.kind === "table") {
      // HF tables don't paginate — synthetic fragment covers all rows.
      const syntheticFragment: TableFragment = {
        kind: "table",
        blockId: block.id,
        x: 0,
        y: cursorY,
        width: measure.totalWidth,
        height: measure.totalHeight,
        fromRow: 0,
        toRow: measure.rows.length,
        ...(block.pmStart !== undefined ? { pmStart: block.pmStart } : {}),
        ...(block.pmEnd !== undefined ? { pmEnd: block.pmEnd } : {}),
      };
      const fragEl = renderTableFragment(
        syntheticFragment,
        block,
        measure,
        hfContext,
        { document: doc },
      );

      // Floating tables (`<w:tblpPr>`) opt out of the cursorY flow. They
      // anchor at (tblpX, tblpY) per ECMA-376 §17.4.57 and don't advance
      // cursorY. Inline tables stack within the HF container at cursorY.
      // `renderTableFragment` already sets `position: absolute` on its
      // returned element; we re-assert it here for parity with the
      // paragraph branch and so future changes to renderTableFragment
      // don't silently break HF positioning.
      if (block.floating) {
        const { left, top } = resolveHeaderFooterFloatingTablePosition(
          block.floating,
          measure,
          layout,
          cursorY,
        );
        fragEl.style.position = "absolute";
        fragEl.style.top = `${top}px`;
        fragEl.style.left = `${left}px`;
        containerEl.append(fragEl);
        // No cursorY advance — surrounding HF blocks flow as if the
        // floating table weren't there (Word semantics for unwrapped
        // floating tables).
      } else {
        // Honor `w:jc` / `w:tblInd` for inline HF tables, matching the body
        // pagination path (see core/layout-engine `desiredX` computation).
        let inlineLeft = 0;
        if (block.justification === "center") {
          inlineLeft = (contentWidth - measure.totalWidth) / 2;
        } else if (block.justification === "right") {
          inlineLeft = contentWidth - measure.totalWidth;
        } else if (block.indent) {
          inlineLeft = block.indent;
        }
        fragEl.style.position = "absolute";
        fragEl.style.top = `${cursorY}px`;
        fragEl.style.left = `${inlineLeft}px`;
        containerEl.append(fragEl);
        cursorY += measure.totalHeight;
      }
    } else if (block.kind === "textBox" && measure.kind === "textBox") {
      // The unified pipeline extracts top-level text boxes inside H/F as
      // their own block. `renderTextBoxFragment` sets `position: absolute`
      // internally; we only supply top/left so it stacks at cursorY.
      // Use the *measured* width (not contentWidth): measureBlocks computed
      // `measure.width` and the cached `innerMeasures` against the authored
      // text box width, so passing contentWidth would cause the outer box
      // to be the wrong size and force inner re-wrap inconsistent with the
      // measure cache.
      const syntheticFragment: TextBoxFragment = {
        kind: "textBox",
        blockId: block.id,
        x: 0,
        y: cursorY,
        width: measure.width,
        height: measure.height,
        ...(block.pmStart !== undefined ? { pmStart: block.pmStart } : {}),
        ...(block.pmEnd !== undefined ? { pmEnd: block.pmEnd } : {}),
      };
      const fragEl = renderTextBoxFragment(
        syntheticFragment,
        block,
        measure,
        hfContext,
        { document: doc },
      );
      fragEl.style.top = `${cursorY}px`;
      fragEl.style.left = "0";
      containerEl.append(fragEl);
      cursorY += measure.height;
    }
  }

  // Render floating images with absolute positioning
  for (const floatImg of floatingImages) {
    const img = doc.createElement("img");
    img.src = floatImg.src;
    img.width = floatImg.width;
    img.height = floatImg.height;
    if (floatImg.alt) {
      img.alt = floatImg.alt;
    }
    // Mark as a click-resolvable image fragment so the pointer pipeline's
    // `findImageElement` matches it. Without these markers an anchored HF
    // image rendered here would fall through to the generic HF text-click
    // branch and no NodeSelection could be created on the HF view
    // (Codex #487 P2 follow-up: 20:52 review).
    img.classList.add("layout-run", "layout-run-image");
    if (floatImg.pmStart !== undefined) {
      img.dataset["pmStart"] = String(floatImg.pmStart);
    }
    if (floatImg.pmEnd !== undefined) {
      img.dataset["pmEnd"] = String(floatImg.pmEnd);
    }

    img.style.position = "absolute";
    img.style.display = "block";
    // Header/footer images can intentionally extend beyond the text area.
    // Override global img resets (for example max-width: 100%) so the DOCX
    // anchor extent is honored instead of shrinking to the header/footer box.
    img.style.width = `${floatImg.width}px`;
    img.style.height = `${floatImg.height}px`;
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";

    // behindDoc images render behind text (full-page letterhead backgrounds)
    if (floatImg.behindDoc) {
      img.style.zIndex = "-1";
    }
    // eigenpal #424 (opacity render pipeline)
    if (hasImageVisualAttrs(floatImg)) {
      applyImageVisualAttrs(img, floatImg);
    }

    applyHeaderFooterFloatHorizontalPosition(img, floatImg, layout);
    img.style.top = `${resolveHeaderFooterFloatTop(floatImg, layout)}px`;

    containerEl.append(img);
  }

  return containerEl;
}

/**
 * Calculate the painter's actual footnote-area height in pixels:
 * separator slot + per-footnote content (or fallback line) + per-footnote
 * `marginBottom` spacing the painter applies in `renderFootnoteArea`. Used
 * to clamp the paginator's reservation if it under-estimated, so dense
 * stacks never overflow past the page bottom. Mirrors the upstream helper
 * from eigenpal/docx-editor#485, extended for folio's fallback rendering
 * and any wrapper margin so the helper matches the painted stack.
 */
export function calculateFootnoteAreaRenderHeight(
  footnotes: FootnoteRenderItem[],
): number {
  let height = FOOTNOTE_SEPARATOR_HEIGHT;
  for (const fn of footnotes) {
    const entryHeight = fn.content
      ? fn.content.height
      : FOOTNOTE_FALLBACK_LINE_HEIGHT;
    height += entryHeight + FOOTNOTE_ENTRY_MARGIN_BOTTOM;
  }
  return height;
}

/**
 * Render the footnote area at the bottom of a page.
 * Includes a separator line (33% width) and footnote entries.
 */
export function renderFootnoteArea(
  footnotes: FootnoteRenderItem[],
  contentWidth: number,
  doc: Document,
  context?: RenderContext,
): HTMLElement {
  const container = doc.createElement("div");
  container.className = "layout-footnote-area";
  container.style.width = `${contentWidth}px`;

  // Separator line (33% width, Google Docs style). Margins derive from
  // FOOTNOTE_SEPARATOR_HEIGHT so the painted separator slot matches the
  // paginator's reservation byte-for-byte. eigenpal/docx-editor#485.
  const separator = doc.createElement("div");
  const separatorRuleHeight = 0.5;
  const separatorMargin = (FOOTNOTE_SEPARATOR_HEIGHT - separatorRuleHeight) / 2;
  separator.style.width = "33%";
  separator.style.height = `${separatorRuleHeight}px`;
  separator.style.backgroundColor = "var(--doc-canvas-text, #000)";
  separator.style.marginTop = `${separatorMargin}px`;
  separator.style.marginBottom = `${separatorMargin}px`;
  container.append(separator);

  // Render each footnote
  for (const fn of footnotes) {
    const fnEl = doc.createElement("div");
    fnEl.style.marginBottom = `${FOOTNOTE_ENTRY_MARGIN_BOTTOM}px`;
    fnEl.style.color = "var(--doc-canvas-text, #000)";

    if (fn.content) {
      const contentEl = renderFootnoteContent(fn, contentWidth, doc, context);
      fnEl.append(contentEl);
    } else {
      fnEl.style.fontSize = "10px";
      fnEl.style.lineHeight = `${FOOTNOTE_FALLBACK_LINE_HEIGHT / 10}`;

      const sup = doc.createElement("sup");
      sup.textContent = fn.displayNumber;
      sup.style.fontSize = "7px";
      sup.style.marginRight = "2px";
      fnEl.append(sup);

      const textNode = doc.createTextNode(` ${fn.text ?? ""}`);
      fnEl.append(textNode);
    }

    container.append(fnEl);
  }

  return container;
}

function renderFootnoteContent(
  footnote: FootnoteRenderItem,
  contentWidth: number,
  doc: Document,
  context?: RenderContext,
): HTMLElement {
  const content = footnote.content;
  if (!content) {
    panic("Missing structured footnote content");
  }

  const wrapper = doc.createElement("div");
  wrapper.className = "layout-footnote-content";
  wrapper.style.position = "relative";
  wrapper.style.width = `${contentWidth}px`;
  wrapper.style.height = `${content.height}px`;

  const renderContext: RenderContext = {
    pageNumber: context?.pageNumber ?? 0,
    totalPages: context?.totalPages ?? 0,
    section: context?.section ?? "body",
    contentWidth,
  };

  let y = 0;
  for (let index = 0; index < content.blocks.length; index++) {
    const block = content.blocks[index];
    const measure = content.measures[index];
    if (!block || !measure) {
      continue;
    }

    const blockEl = renderFootnoteBlock(
      block,
      measure,
      contentWidth,
      y,
      renderContext,
      doc,
    );
    if (!blockEl) {
      continue;
    }
    wrapper.append(blockEl);
    y += getFootnoteMeasureHeight(measure);
  }

  return wrapper;
}

function renderFootnoteBlock(
  block: FlowBlock,
  measure: Measure,
  contentWidth: number,
  y: number,
  context: RenderContext,
  doc: Document,
): HTMLElement | null {
  const renderBlock = stripFootnotePmAnchors(block);

  if (renderBlock.kind === "paragraph" && measure.kind === "paragraph") {
    const fragment: ParagraphFragment = {
      kind: "paragraph",
      blockId: renderBlock.id,
      x: 0,
      y,
      width: contentWidth,
      height: measure.totalHeight,
      fromLine: 0,
      toLine: measure.lines.length,
    };
    const element = renderParagraphFragment(
      fragment,
      renderBlock,
      measure,
      context,
      {
        document: doc,
      },
    );
    positionFootnoteBlock(element, y, contentWidth, measure.totalHeight);
    return element;
  }

  if (renderBlock.kind === "table" && measure.kind === "table") {
    const fragment: TableFragment = {
      kind: "table",
      blockId: renderBlock.id,
      x: 0,
      y,
      width: measure.totalWidth,
      height: measure.totalHeight,
      fromRow: 0,
      toRow: renderBlock.rows.length,
    };
    const element = renderTableFragment(
      fragment,
      renderBlock,
      measure,
      context,
      {
        document: doc,
      },
    );
    positionFootnoteBlock(element, y, measure.totalWidth, measure.totalHeight);
    return element;
  }

  if (renderBlock.kind === "image" && measure.kind === "image") {
    const fragment: ImageFragment = {
      kind: "image",
      blockId: renderBlock.id,
      x: 0,
      y,
      width: measure.width,
      height: measure.height,
    };
    const element = renderImageFragment(
      fragment,
      renderBlock,
      measure,
      context,
      {
        document: doc,
      },
    );
    positionFootnoteBlock(element, y, measure.width, measure.height);
    return element;
  }

  if (renderBlock.kind === "textBox" && measure.kind === "textBox") {
    const fragment: TextBoxFragment = {
      kind: "textBox",
      blockId: renderBlock.id,
      x: 0,
      y,
      width: measure.width,
      height: measure.height,
    };
    const element = renderTextBoxFragment(
      fragment,
      renderBlock,
      measure,
      context,
      {
        document: doc,
      },
    );
    positionFootnoteBlock(element, y, measure.width, measure.height);
    return element;
  }

  return null;
}

function stripFootnotePmAnchors(block: FlowBlock): FlowBlock {
  switch (block.kind) {
    case "paragraph":
      return stripFootnoteParagraphPmAnchors(block);
    case "table": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...table } = block;
      return {
        ...table,
        rows: table.rows.map(stripFootnoteTableRowPmAnchors),
      };
    }
    case "image": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...image } = block;
      return image;
    }
    case "textBox": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...textBox } = block;
      return {
        ...textBox,
        content: textBox.content.map(stripFootnoteParagraphPmAnchors),
      };
    }
    case "pageBreak":
    case "columnBreak": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...breakBlock } = block;
      return breakBlock;
    }
    case "sectionBreak":
      return block;
    default:
      return block;
  }
}

function stripFootnoteTableRowPmAnchors(row: TableRow): TableRow {
  return {
    ...row,
    cells: row.cells.map(stripFootnoteTableCellPmAnchors),
  };
}

function stripFootnoteTableCellPmAnchors(cell: TableCell): TableCell {
  return {
    ...cell,
    blocks: cell.blocks.map(stripFootnotePmAnchors),
  };
}

function stripFootnoteParagraphPmAnchors(
  block: ParagraphBlock,
): ParagraphBlock {
  const { pmStart: _pmStart, pmEnd: _pmEnd, ...paragraph } = block;
  return {
    ...paragraph,
    runs: paragraph.runs.map(stripFootnoteRunPmAnchors),
  };
}

function stripFootnoteRunPmAnchors(run: Run): Run {
  switch (run.kind) {
    case "text": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...textRun } = run;
      return textRun;
    }
    case "tab": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...tabRun } = run;
      return tabRun;
    }
    case "image": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...imageRun } = run;
      return imageRun;
    }
    case "lineBreak": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...lineBreakRun } = run;
      return lineBreakRun;
    }
    case "field": {
      const { pmStart: _pmStart, pmEnd: _pmEnd, ...fieldRun } = run;
      return fieldRun;
    }
    default:
      return run;
  }
}

function positionFootnoteBlock(
  element: HTMLElement,
  top: number,
  width: number,
  height: number,
): void {
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = `${top}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
}

function getFootnoteMeasureHeight(measure: Measure): number {
  if (measure.kind === "paragraph" || measure.kind === "table") {
    return measure.totalHeight;
  }
  if (measure.kind === "image" || measure.kind === "textBox") {
    return measure.height;
  }
  return 0;
}

/**
 * Render a single page to DOM
 *
 * @param page - The page to render
 * @param context - Rendering context
 * @param options - Rendering options
 * @returns The page DOM element
 */
export function renderPage(
  page: Page,
  context: RenderContext,
  options: RenderPageOptions = {},
): HTMLElement {
  const doc = options.document ?? document;

  // Create page container
  const pageEl = doc.createElement("div");
  pageEl.className = options.pageClassName ?? PAGE_CLASS_NAMES.page;
  pageEl.dataset["pageNumber"] = String(page.number);

  applyPageStyles(pageEl, page.size.w, page.size.h, options);
  const pageBorderEl = renderPageBorderOverlay(page, options, doc);
  if (pageBorderEl && options.pageBorders?.zOrder === "back") {
    pageEl.append(pageBorderEl);
  }
  if (options.watermark) {
    const watermarkEl = renderWatermarkLayer(
      options.watermark,
      page,
      doc,
      options.watermarkImageSrc !== undefined
        ? { imageSrc: options.watermarkImageSrc }
        : {},
    );
    if (watermarkEl) {
      pageEl.append(watermarkEl);
    }
  }

  // Create content area
  const contentEl = doc.createElement("div");
  contentEl.className = PAGE_CLASS_NAMES.content;
  applyContentAreaStyles(contentEl, page);

  // Calculate content width for justify alignment
  const contentWidth = page.size.w - page.margins.left - page.margins.right;

  // PHASE 1: Extract all floating images from paragraphs on this page
  const allFloatingImages: PageFloatingImage[] = [];
  const floatingRects: FloatingExclusionRect[] = [];
  const pageGeometry: PageGeometry = {
    pageWidth: page.size.w,
    pageHeight: page.size.h,
    marginLeft: page.margins.left,
    marginTop: page.margins.top,
    marginRight: page.margins.right,
    marginBottom: page.margins.bottom,
    contentWidth,
    contentHeight: page.size.h - page.margins.top - page.margins.bottom,
  };

  for (const fragment of page.fragments) {
    if (fragment.kind === "paragraph" && options.blockLookup) {
      const blockData = options.blockLookup.get(String(fragment.blockId));
      if (blockData?.block.kind === "paragraph") {
        const paragraphBlock = blockData.block as ParagraphBlock;
        // Fragment Y is relative to page top, we need it relative to content area
        const contentRelativeY = fragment.y - page.margins.top;
        const extracted = extractFloatingImagesFromParagraph(
          paragraphBlock,
          contentRelativeY,
          pageGeometry,
        );
        allFloatingImages.push(...extracted);

        // Note: topAndBottom images are handled by measureParagraph as block images
        // (they get their own line). No exclusion zones needed for them.
      }
    }
  }

  // Collect floating image exclusion rectangles. wrapNone images (`behind`,
  // `inFront`) and `topAndBottom` block images do NOT shrink line widths —
  // they're filtered out here so text measurement ignores them. Without this,
  // a behindDoc letterhead would carve a vertical column out of body text.
  for (const img of allFloatingImages) {
    if (!img.affectsTextWrap) {
      continue;
    }
    floatingRects.push({
      side: img.side,
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
      distTop: img.distTop,
      distBottom: img.distBottom,
      distLeft: img.distLeft,
      distRight: img.distRight,
      ...(img.wrapText !== undefined ? { wrapText: img.wrapText } : {}),
      ...(img.wrapType !== undefined ? { wrapType: img.wrapType } : {}),
    });
  }

  // Collect floating table exclusion rectangles
  if (options.blockLookup) {
    for (const fragment of page.fragments) {
      if (fragment.kind !== "table") {
        continue;
      }
      const blockData = options.blockLookup.get(String(fragment.blockId));
      if (blockData?.block.kind !== "table") {
        continue;
      }
      const tableBlock = blockData.block as TableBlock;
      const floating = tableBlock.floating;
      if (!floating) {
        continue;
      }

      const contentX = fragment.x - page.margins.left;
      const contentY = fragment.y - page.margins.top;

      const distTop = floating.topFromText ?? 0;
      const distBottom = floating.bottomFromText ?? 0;
      const distLeft = floating.leftFromText ?? 12;
      const distRight = floating.rightFromText ?? 12;

      const side = contentX < contentWidth / 2 ? "left" : "right";

      floatingRects.push({
        side,
        x: contentX,
        y: contentY,
        width: fragment.width,
        height: fragment.height,
        distTop,
        distBottom,
        distLeft,
        distRight,
      });
    }
  }

  // Collect floating text-box exclusion rectangles (eigenpal #474).
  // The text-box paint already exists; this only adds the measurement-side
  // contribution so body text wraps around anchored boxes instead of
  // running underneath them.
  if (options.blockLookup) {
    for (const fragment of page.fragments) {
      if (fragment.kind !== "textBox") {
        continue;
      }
      const blockData = options.blockLookup.get(String(fragment.blockId));
      if (blockData?.block.kind !== "textBox") {
        continue;
      }
      const textBoxBlock = blockData.block as TextBoxBlock;
      if (!isFloatingTextBoxBlock(textBoxBlock)) {
        continue;
      }
      if (!floatingTextBoxWrapsText(textBoxBlock)) {
        continue;
      }

      const contentX = fragment.x - page.margins.left;
      const contentY = fragment.y - page.margins.top;

      const distTop = textBoxBlock.distTop ?? 0;
      const distBottom = textBoxBlock.distBottom ?? 0;
      const distLeft = textBoxBlock.distLeft ?? 12;
      const distRight = textBoxBlock.distRight ?? 12;

      // Side hints which margin the rect blocks when `wrapText` falls back to
      // `rect.side`. Prefer the explicit cssFloat over the X heuristic so a
      // right-floated box hugging the centre still produces a right-side rect.
      let side: "left" | "right" =
        contentX < contentWidth / 2 ? "left" : "right";
      if (textBoxBlock.cssFloat === "left") {
        side = "left";
      } else if (textBoxBlock.cssFloat === "right") {
        side = "right";
      }

      const rect: FloatingExclusionRect = {
        side,
        x: contentX,
        y: contentY,
        width: fragment.width,
        height: fragment.height,
        distTop,
        distBottom,
        distLeft,
        distRight,
      };
      if (textBoxBlock.wrapText !== undefined) {
        rect.wrapText = textBoxBlock.wrapText;
      }
      if (textBoxBlock.wrapType !== undefined) {
        rect.wrapType = textBoxBlock.wrapType;
      }
      floatingRects.push(rect);
    }
  }

  // PHASE 2: Convert floating rects to per-image measurement zones
  const floatingZones: FloatingImageZone[] =
    floatingRects.length > 0
      ? rectsToFloatingZones(floatingRects, contentWidth)
      : [];

  // PHASE 3a: Render behindDoc images first so they paint below body text.
  // Front-layer images (everything else) are appended after fragments below
  // so they overlay content as Word does for `inFront` and side-wrapped
  // images.
  const behindFloatingImages = allFloatingImages.filter((img) => img.behindDoc);
  const frontFloatingImages = allFloatingImages.filter((img) => !img.behindDoc);
  if (behindFloatingImages.length > 0) {
    const behindLayer = renderFloatingImagesLayer(
      behindFloatingImages,
      doc,
      "behind",
    );
    contentEl.append(behindLayer);
  }

  // PHASE 4: Render each fragment with floating image awareness
  // Helper to peek at a fragment's paragraph borders (for border grouping)
  const getParaBorders = (frag: Fragment): ParagraphBorders | undefined => {
    if (frag.kind !== "paragraph" || !options.blockLookup || !frag.blockId) {
      return undefined;
    }
    const blockData = options.blockLookup.get(String(frag.blockId));
    if (blockData?.block.kind === "paragraph") {
      return (blockData.block as ParagraphBlock).attrs?.borders;
    }
    return undefined;
  };

  let prevParagraphBorders: ParagraphBorders | undefined;
  const renderedInlineImageKeysByBlock = new Map<string, Set<string>>();

  for (let i = 0; i < page.fragments.length; i++) {
    const fragment = page.fragments[i]!; // SAFETY: i < page.fragments.length
    let fragmentEl: HTMLElement;
    const fragmentContext = {
      ...context,
      section: "body" as const,
      contentWidth,
    };

    // Calculate fragment's Y position relative to content area (for per-line margin calculation)
    const fragmentContentY = fragment.y - page.margins.top;

    // If we have block lookup, try to render full content based on fragment type
    if (options.blockLookup && fragment.blockId) {
      const blockData = options.blockLookup.get(String(fragment.blockId));

      if (
        fragment.kind === "paragraph" &&
        blockData?.block.kind === "paragraph" &&
        blockData.measure.kind === "paragraph"
      ) {
        const paragraphBlock = blockData.block as ParagraphBlock;
        const nextBorders =
          i + 1 < page.fragments.length
            ? getParaBorders(page.fragments[i + 1]!) // SAFETY: guarded by length check
            : undefined;
        const blockKey = String(fragment.blockId);
        let renderedInlineImageKeys =
          renderedInlineImageKeysByBlock.get(blockKey);
        if (!renderedInlineImageKeys) {
          renderedInlineImageKeys = new Set<string>();
          renderedInlineImageKeysByBlock.set(blockKey, renderedInlineImageKeys);
        }

        // Re-measure paragraph with floating zones for text wrapping
        let paragraphMeasure = blockData.measure as ParagraphMeasure;
        if (floatingZones.length > 0) {
          paragraphMeasure = measureParagraph(paragraphBlock, contentWidth, {
            floatingZones,
            paragraphYOffset: fragmentContentY,
          });
        }

        fragmentEl = renderParagraphFragment(
          fragment as ParagraphFragment,
          paragraphBlock,
          paragraphMeasure,
          fragmentContext,
          {
            document: doc,
            fragmentContentY,
            ...(prevParagraphBorders !== undefined
              ? { prevBorders: prevParagraphBorders }
              : {}),
            ...(nextBorders !== undefined ? { nextBorders } : {}),
            renderedInlineImageKeys,
          },
        );
        prevParagraphBorders = paragraphBlock.attrs?.borders;
      } else if (
        fragment.kind === "table" &&
        blockData?.block.kind === "table" &&
        blockData.measure.kind === "table"
      ) {
        fragmentEl = renderTableFragment(
          fragment as TableFragment,
          blockData.block as TableBlock,
          blockData.measure as TableMeasure,
          fragmentContext,
          { document: doc },
        );
        prevParagraphBorders = undefined;
      } else if (
        fragment.kind === "image" &&
        blockData?.block.kind === "image" &&
        blockData.measure.kind === "image"
      ) {
        fragmentEl = renderImageFragment(
          fragment as ImageFragment,
          blockData.block as ImageBlock,
          blockData.measure as ImageMeasure,
          fragmentContext,
          { document: doc },
        );
        prevParagraphBorders = undefined;
      } else if (
        fragment.kind === "textBox" &&
        blockData?.block.kind === "textBox" &&
        blockData.measure.kind === "textBox"
      ) {
        fragmentEl = renderTextBoxFragment(
          fragment as TextBoxFragment,
          blockData.block as TextBoxBlock,
          blockData.measure as TextBoxMeasure,
          fragmentContext,
          { document: doc },
        );
        prevParagraphBorders = undefined;
      } else {
        // Fallback to placeholder
        fragmentEl = renderFragment(fragment, fragmentContext, {
          document: doc,
        });
        prevParagraphBorders = undefined;
      }
    } else {
      // Use placeholder when no blockLookup
      fragmentEl = renderFragment(fragment, fragmentContext, { document: doc });
      prevParagraphBorders = undefined;
    }

    applyFragmentStyles(fragmentEl, fragment, {
      left: page.margins.left,
      top: page.margins.top,
    });
    contentEl.append(fragmentEl);
  }

  // PHASE 3b: Render front-layer floating images after text fragments so
  // wrapNone `inFront` images and side-wrapped images paint above body text
  // — matching Word's anchor stacking semantics.
  if (frontFloatingImages.length > 0) {
    const frontLayer = renderFloatingImagesLayer(
      frontFloatingImages,
      doc,
      "front",
    );
    contentEl.append(frontLayer);
  }

  // Render column separator lines between columns (when w:sep is set)
  if (page.columns && page.columns.separator && page.columns.count > 1) {
    const colCount = page.columns.count;
    const colGap = page.columns.gap;
    const colWidth = (contentWidth - (colCount - 1) * colGap) / colCount;
    const contentHeight = page.size.h - page.margins.top - page.margins.bottom;

    for (let col = 0; col < colCount - 1; col++) {
      const lineX = (col + 1) * colWidth + col * colGap + colGap / 2;
      const line = doc.createElement("div");
      line.style.position = "absolute";
      line.style.left = `${lineX}px`;
      line.style.top = "0";
      line.style.height = `${contentHeight}px`;
      line.style.width = "0.5px";
      line.style.backgroundColor = "var(--doc-canvas-text, #000)";
      line.style.pointerEvents = "none";
      contentEl.append(line);
    }
  }

  // Render footnote area at the bottom of the content area (above footer)
  if (options.footnoteArea && options.footnoteArea.length > 0) {
    const fnAreaEl = renderFootnoteArea(
      options.footnoteArea,
      contentWidth,
      doc,
      context,
    );
    fnAreaEl.style.position = "absolute";
    // Position at page bottom minus bottom margin (bottom of content
    // area). Clamp the reservation upward to the painter's calculated
    // area height so a dense stack of footnotes that under-reserved by
    // a few pixels still ends at the page bottom rather than spilling
    // past it; clamp the resulting top to `-page.margins.top` so an
    // oversized area cannot escape above the page entirely.
    // eigenpal/docx-editor#485.
    const reservedHeight = Math.max(
      page.footnoteReservedHeight ?? 0,
      calculateFootnoteAreaRenderHeight(options.footnoteArea),
    );
    const contentAreaBottom =
      page.size.h - page.margins.bottom - page.margins.top;
    fnAreaEl.style.top = `${Math.max(-page.margins.top, contentAreaBottom - reservedHeight)}px`;
    fnAreaEl.style.left = "0";
    fnAreaEl.style.right = "0";
    contentEl.append(fnAreaEl);
  }

  pageEl.append(contentEl);

  // Render header area (always rendered for hover hint / double-click target)
  {
    const defaultHeaderDistance = 48;
    const headerDistance =
      options.headerDistance ?? page.margins.header ?? defaultHeaderDistance;
    const headerContentWidth =
      page.size.w - page.margins.left - page.margins.right;
    const availableHeaderHeight = Math.max(
      page.margins.top - headerDistance,
      48,
    );
    const headerVisualTop = options.headerContent?.visualTop ?? 0;
    const headerVisualBottom =
      options.headerContent?.visualBottom ?? options.headerContent?.height ?? 0;
    const actualHeaderHeight = Math.max(
      headerVisualBottom - headerVisualTop,
      24,
    );
    // If header content fits in the original space, clip overflow; otherwise
    // margins.top was already expanded so let content show fully.
    const headerOverflows = headerVisualBottom > availableHeaderHeight;

    const headerEl = doc.createElement("div");
    headerEl.className = PAGE_CLASS_NAMES.header;
    if (options.headerContent?.rId) {
      headerEl.dataset["rid"] = options.headerContent.rId;
    }
    headerEl.style.position = "absolute";
    headerEl.style.top = `${headerDistance + headerVisualTop}px`;
    headerEl.style.left = `${page.margins.left}px`;
    headerEl.style.right = `${page.margins.right}px`;
    headerEl.style.width = `${headerContentWidth}px`;
    headerEl.style.height = `${actualHeaderHeight}px`;
    headerEl.style.minHeight = `${actualHeaderHeight}px`;
    headerEl.style.opacity = "0.62";

    let shouldClipHeader = !headerOverflows;
    if (options.headerContent && options.headerContent.blocks.length > 0) {
      const headerContentEl = renderHeaderFooterContent(
        options.headerContent,
        { ...context, section: "header", contentWidth: headerContentWidth },
        options,
        {
          flowTop: headerDistance,
          flowLeft: page.margins.left,
          contentWidth: headerContentWidth,
          pageWidth: page.size.w,
          pageHeight: page.size.h,
          margins: page.margins,
        },
      );
      headerContentEl.style.top = `${-headerVisualTop}px`;
      // Do not clip header containers that include media. Their measured content
      // height can exclude absolutely positioned runs, which causes visible cut-off.
      if (headerContentEl.querySelector("img")) {
        shouldClipHeader = false;
      }
      headerEl.append(headerContentEl);
    }
    if (shouldClipHeader) {
      headerEl.style.maxHeight = `${availableHeaderHeight}px`;
      headerEl.style.overflow = "hidden";
    }
    pageEl.append(headerEl);

    // behindDoc images (full-page letterhead backgrounds) must live on the
    // page element, not inside the clipped header container.  Move them out
    // so they aren't constrained by the header's bounds/overflow.
    // Prepend as first child so they paint below the page background layer;
    // z-index alone doesn't work because the page's own background covers
    // negative z-index children.
    for (const img of Array.from(
      headerEl.querySelectorAll<HTMLImageElement>('img[style*="z-index"]'),
    )) {
      if (img.style.zIndex !== "-1") {
        continue;
      }
      // Adjust position: the image's top/left was relative to the header
      // container origin.  Shift it so it's relative to the page origin.
      const currentTop = Number.parseFloat(img.style.top) || 0;
      const currentLeft = Number.parseFloat(img.style.left) || 0;
      img.style.top = `${currentTop + headerDistance + headerVisualTop}px`;
      img.style.left = `${currentLeft + page.margins.left}px`;
      // Use z-index 0 instead of -1 so the image sits above the page
      // background but below text content (which has higher stacking).
      img.style.zIndex = "0";
      pageEl.prepend(img);
    }
  }

  // Render footer area (always rendered for hover hint / double-click target)
  {
    const defaultFooterDistance = 48;
    const footerDistance =
      options.footerDistance ?? page.margins.footer ?? defaultFooterDistance;
    const footerContentWidth =
      page.size.w - page.margins.left - page.margins.right;
    const availableFooterHeight = Math.max(
      page.margins.bottom - footerDistance,
      48,
    );
    const footerFlowHeight = options.footerContent?.height ?? 0;
    const footerVisualTop = options.footerContent?.visualTop ?? 0;
    const footerVisualBottom =
      options.footerContent?.visualBottom ?? footerFlowHeight;
    const actualFooterHeight = Math.max(
      footerVisualBottom - footerVisualTop,
      24,
    );
    const footerOverflows = actualFooterHeight > availableFooterHeight;

    // Anchor the footer container at the *flow* origin, then let it stretch
    // upward (above-flow image overflow via negative visualTop) and downward
    // (below-flow floating-table overflow via visualBottom > flowHeight).
    // Anchoring at the flow origin keeps in-flow content rendered at the
    // natural footer line (page.h - footerDistance - flowHeight) and keeps
    // the resolver's `flowTop` consistent with where the in-flow first
    // paragraph actually paints.
    const footerNaturalTop = page.size.h - footerDistance - footerFlowHeight;
    const footerContainerTop = footerNaturalTop + footerVisualTop;
    const footerEl = doc.createElement("div");
    footerEl.className = PAGE_CLASS_NAMES.footer;
    if (options.footerContent?.rId) {
      footerEl.dataset["rid"] = options.footerContent.rId;
    }
    footerEl.style.position = "absolute";
    footerEl.style.top = `${footerContainerTop}px`;
    footerEl.style.left = `${page.margins.left}px`;
    footerEl.style.right = `${page.margins.right}px`;
    footerEl.style.width = `${footerContentWidth}px`;
    footerEl.style.height = `${actualFooterHeight}px`;
    footerEl.style.minHeight = `${actualFooterHeight}px`;
    footerEl.style.opacity = "0.62";

    let shouldClipFooter = !footerOverflows;
    if (options.footerContent && options.footerContent.blocks.length > 0) {
      const footerContentEl = renderHeaderFooterContent(
        options.footerContent,
        { ...context, section: "footer", contentWidth: footerContentWidth },
        options,
        {
          flowTop: footerNaturalTop,
          flowLeft: page.margins.left,
          contentWidth: footerContentWidth,
          pageWidth: page.size.w,
          pageHeight: page.size.h,
          margins: page.margins,
        },
      );
      footerContentEl.style.top = `${-footerVisualTop}px`;
      if (footerContentEl.querySelector("img")) {
        shouldClipFooter = false;
      }
      footerEl.append(footerContentEl);
    }
    if (shouldClipFooter) {
      footerEl.style.maxHeight = `${availableFooterHeight}px`;
      footerEl.style.overflow = "hidden";
    }
    pageEl.append(footerEl);
  }

  if (pageBorderEl && options.pageBorders?.zOrder !== "back") {
    pageEl.append(pageBorderEl);
  }

  return pageEl;
}

/**
 * Full options type used by page rendering helpers.
 */
type FullPageOptions = RenderPageOptions & {
  footnotesByPage?: Map<number, FootnoteRenderItem[]>;
};

export function applySectionHeaderFooterOptions(
  page: Page,
  pageOptions: RenderPageOptions,
  options: RenderPageOptions,
): boolean {
  const refs = page.headerFooterRefs;
  if (!refs) {
    return false;
  }

  const isFirstSectionPage = page.sectionPageNumber === 1;
  const useFirst = refs.titlePg === true && isFirstSectionPage;
  const sectionPageNumber = page.sectionPageNumber ?? page.number;
  const useEven = sectionPageNumber % 2 === 0;

  const headerRId = (() => {
    if (useFirst) {
      return refs.headerFirst;
    }
    if (useEven && refs.headerEven) {
      return refs.headerEven;
    }
    return refs.headerDefault;
  })();
  const footerRId = (() => {
    if (useFirst) {
      return refs.footerFirst;
    }
    if (useEven && refs.footerEven) {
      return refs.footerEven;
    }
    return refs.footerDefault;
  })();

  if (headerRId) {
    const content = options.headerContentByRId?.get(headerRId);
    if (content) {
      pageOptions.headerContent = content;
    } else {
      delete pageOptions.headerContent;
    }
  } else {
    delete pageOptions.headerContent;
  }

  if (footerRId) {
    const content = options.footerContentByRId?.get(footerRId);
    if (content) {
      pageOptions.footerContent = content;
    } else {
      delete pageOptions.footerContent;
    }
  } else {
    delete pageOptions.footerContent;
  }

  return true;
}

/**
 * Build a RenderContext and resolved page options (with footnotes) for a page.
 * Centralises logic shared by populatePageShell, repopulatePageContent, and the eager render path.
 */
function buildPageRenderArgs(
  page: Page,
  totalPages: number,
  options: FullPageOptions,
): { context: RenderContext; pageOptions: RenderPageOptions } {
  const context: RenderContext = {
    pageNumber: page.number,
    totalPages,
    section: "body",
  };
  const pageOptions: RenderPageOptions = { ...options };
  const hasSectionHeaderFooter = applySectionHeaderFooterOptions(
    page,
    pageOptions,
    options,
  );
  // Per-page header/footer selection when titlePg is enabled
  if (!hasSectionHeaderFooter && options.titlePg && page.number === 1) {
    if (options.firstPageHeaderContent !== undefined) {
      pageOptions.headerContent = options.firstPageHeaderContent;
    } else {
      delete pageOptions.headerContent;
    }
    if (options.firstPageFooterContent !== undefined) {
      pageOptions.footerContent = options.firstPageFooterContent;
    } else {
      delete pageOptions.footerContent;
    }
  }
  if (options.footnotesByPage) {
    const fns = options.footnotesByPage.get(page.number);
    if (fns && fns.length > 0) {
      (
        pageOptions as RenderPageOptions & {
          footnoteArea?: FootnoteRenderItem[];
        }
      ).footnoteArea = fns;
    }
  }
  return { context, pageOptions };
}

/**
 * State for a single page shell used in incremental rendering.
 */
type PageShellState = {
  element: HTMLElement;
  fingerprint: string | null;
  renderFingerprint: string | null;
};

/**
 * Stored state for the page container to enable incremental updates.
 */
type PageContainerState = {
  pageStates: PageShellState[];
  totalPages: number;
  optionsHash: string;
  pageDataMap: Map<
    HTMLElement,
    { page: Page; index: number; rendered: boolean }
  >;
  /** Current render options — kept up-to-date so the observer closure always reads fresh values. */
  currentOptions: FullPageOptions;
};

/**
 * Extended container type with observer and render state references.
 */
type PageContainer = {
  __pageObserver?: IntersectionObserver;
  __pageRenderState?: PageContainerState;
} & HTMLElement;

/**
 * Compute a fingerprint string for a page that changes when its content changes.
 * Used to detect which pages need re-rendering on incremental updates.
 */
export function computePageFingerprint(
  page: Page,
  blockLookup?: BlockLookup,
): string {
  return computePageFingerprintInternal(page, blockLookup, {
    includePmPositions: true,
  });
}

function computePageRenderFingerprint(
  page: Page,
  blockLookup?: BlockLookup,
): string {
  return computePageFingerprintInternal(page, blockLookup, {
    includePmPositions: false,
  });
}

function computePageFingerprintInternal(
  page: Page,
  blockLookup: BlockLookup | undefined,
  options: { includePmPositions: boolean },
): string {
  const parts: string[] = [];

  // Page-level properties
  parts.push(`s:${page.size.w},${page.size.h}`);
  parts.push(
    `m:${page.margins.top},${page.margins.right},${page.margins.bottom},${page.margins.left}`,
  );
  parts.push(`n:${page.number}`);
  if (page.sectionIndex !== undefined) {
    parts.push(`si:${page.sectionIndex}`);
  }
  if (page.sectionPageNumber !== undefined) {
    parts.push(`sp:${page.sectionPageNumber}`);
  }
  if (page.headerFooterRefs) {
    parts.push(`hf:${JSON.stringify(page.headerFooterRefs)}`);
  }
  if (page.footnoteReservedHeight) {
    parts.push(`fn:${page.footnoteReservedHeight}`);
  }

  // Each fragment's stable properties
  for (const frag of page.fragments) {
    let fp = `${frag.kind}:${frag.blockId},${frag.x},${frag.y},${frag.width},${frag.height}`;
    if (options.includePmPositions && frag.pmStart !== undefined) {
      fp += `,ps:${frag.pmStart}`;
    }
    if (options.includePmPositions && frag.pmEnd !== undefined) {
      fp += `,pe:${frag.pmEnd}`;
    }

    if (frag.kind === "paragraph") {
      fp += `,fl:${frag.fromLine},tl:${frag.toLine}`;
    } else if (frag.kind === "table") {
      fp += `,fr:${frag.fromRow},tr:${frag.toRow}`;
    }
    if (blockLookup) {
      const block = blockLookup.get(String(frag.blockId))?.block;
      const annotationFingerprint = block
        ? computeAnnotationFingerprint(block, options.includePmPositions)
        : "";
      if (annotationFingerprint) {
        fp += `,ann:${annotationFingerprint}`;
      }
      const contentFingerprint = block ? computeContentFingerprint(block) : "";
      if (contentFingerprint) {
        fp += `,c:${contentFingerprint}`;
      }
    }

    parts.push(fp);
  }

  return parts.join("|");
}

function computeAnnotationFingerprint(
  block: FlowBlock,
  includePmPositions: boolean,
): string {
  const parts: string[] = [];
  collectAnnotationFingerprint(block, parts, includePmPositions);
  return parts.join(";");
}

/**
 * Fingerprint of run-level content + formatting that the painter applies via
 * `applyRunStyles`. Geometry alone is insufficient: a mark-only edit (toggle
 * bold/italic/color/etc.) can leave fragment width/height/line counts
 * identical, in which case the geometry fingerprint matches and the
 * incremental render path would skip repopulating the page, leaving the new
 * formatting unpainted.
 */
function computeContentFingerprint(block: FlowBlock): string {
  const parts: string[] = [];
  collectContentFingerprint(block, parts);
  return parts.join(";");
}

function collectAnnotationFingerprint(
  block: FlowBlock,
  parts: string[],
  includePmPositions: boolean,
): void {
  if (block.kind === "paragraph") {
    for (let index = 0; index < block.runs.length; index++) {
      const run = block.runs[index];
      if (!run) {
        continue;
      }
      if (run.kind !== "text" && run.kind !== "tab" && run.kind !== "field") {
        continue;
      }
      const runParts: string[] = [];
      if (run.commentIds?.length) {
        runParts.push(`c:${run.commentIds.join(",")}`);
      }
      if (run.isInsertion) {
        runParts.push(`ins:${run.changeRevisionId ?? ""}`);
      }
      if (run.isDeletion) {
        runParts.push(`del:${run.changeRevisionId ?? ""}`);
      }
      if (runParts.length > 0) {
        parts.push(
          includePmPositions
            ? `${index}:${run.pmStart ?? ""}-${run.pmEnd ?? ""}:${runParts.join("|")}`
            : `${index}:${runParts.join("|")}`,
        );
      }
    }
    return;
  }

  if (block.kind === "table") {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) {
          collectAnnotationFingerprint(child, parts, includePmPositions);
        }
      }
    }
    return;
  }

  if (block.kind === "textBox") {
    for (const child of block.content) {
      collectAnnotationFingerprint(child, parts, includePmPositions);
    }
  }
}

function collectContentFingerprint(block: FlowBlock, parts: string[]): void {
  if (block.kind === "paragraph") {
    if (block.attrs?.styleId) {
      parts.push(`p:st:${block.attrs.styleId}`);
    }
    if (block.attrs?.alignment) {
      parts.push(`p:al:${block.attrs.alignment}`);
    }
    for (let index = 0; index < block.runs.length; index++) {
      const run = block.runs[index];
      if (!run) {
        continue;
      }
      parts.push(`${index}:${runContentKey(run)}`);
    }
    return;
  }

  if (block.kind === "table") {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) {
          collectContentFingerprint(child, parts);
        }
      }
    }
    return;
  }

  if (block.kind === "textBox") {
    for (const child of block.content) {
      collectContentFingerprint(child, parts);
    }
  }
}

function runContentKey(run: Run): string {
  if (run.kind === "lineBreak") {
    return "lb";
  }
  if (run.kind === "image") {
    return `img:${run.src}|${run.width}x${run.height}${run.transform ? `|tr:${run.transform}` : ""}`;
  }

  // Remaining kinds (text, tab, field, math) all carry RunFormatting.
  const parts: string[] = [run.kind];
  if (run.kind === "text") {
    parts.push(`t:${run.text}`);
  } else if (run.kind === "tab") {
    if (run.width !== undefined) {
      parts.push(`w:${run.width}`);
    }
  } else if (run.kind === "math") {
    // The OMML XML uniquely identifies the rendered MathML output;
    // include `display` so swapping inline ↔ block also re-fingerprints.
    parts.push(`md:${run.display}`);
    parts.push(`mx:${run.ommlXml}`);
  } else {
    parts.push(`ft:${run.fieldType}`);
    if (run.fallback !== undefined) {
      parts.push(`fb:${run.fallback}`);
    }
  }

  // Marks/format attrs the painter consumes via applyRunStyles. Keep in sync
  // with renderParagraph.ts so toggling any of these triggers a re-paint.
  if (run.bold) {
    parts.push("b");
  }
  if (run.italic) {
    parts.push("i");
  }
  if (run.underline) {
    parts.push(
      typeof run.underline === "boolean"
        ? "u"
        : `u:${run.underline.style ?? ""}:${run.underline.color ?? ""}`,
    );
  }
  if (run.strike) {
    parts.push("s");
  }
  if (run.color) {
    parts.push(`c:${run.color}`);
  }
  if (run.highlight) {
    parts.push(`hi:${run.highlight}`);
  }
  if (run.fontFamily) {
    parts.push(`ff:${run.fontFamily}`);
  }
  if (run.fontSize !== undefined) {
    parts.push(`fs:${run.fontSize}`);
  }
  if (run.letterSpacing !== undefined) {
    parts.push(`ls:${run.letterSpacing}`);
  }
  if (run.superscript) {
    parts.push("sup");
  }
  if (run.subscript) {
    parts.push("sub");
  }
  if (run.allCaps) {
    parts.push("ac");
  }
  if (run.smallCaps) {
    parts.push("sc");
  }
  if (run.positionPx !== undefined) {
    parts.push(`pp:${run.positionPx}`);
  }
  if (run.horizontalScale !== undefined && run.horizontalScale !== 100) {
    parts.push(`hs:${run.horizontalScale}`);
  }
  if (run.imprint) {
    parts.push("imp");
  }
  if (run.emboss) {
    parts.push("emb");
  }
  if (run.textShadow) {
    parts.push("sh");
  }
  if (run.textOutline) {
    parts.push("ol");
  }
  if (run.emphasisMark) {
    parts.push(`emk:${run.emphasisMark}`);
  }
  if (run.hyperlink) {
    parts.push(`hl:${run.hyperlink.href}`);
  }
  return parts.join("|");
}

function headerFooterContentFingerprint(
  prefix: string,
  entries: ReadonlyMap<string, HeaderFooterContent> | undefined,
): string[] {
  if (!entries) {
    return [];
  }
  return Array.from(entries.entries())
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([rId, content]) =>
        `${prefix}:${rId},${content.blocks.length},${content.height},${
          content.visualTop ?? 0
        },${content.visualBottom ?? content.height},${content.textSig ?? ""}`,
    );
}

/**
 * Compute a hash for render options that affect all pages globally.
 * When this changes, all pages need a full re-render.
 */
function computeOptionsHash(options: RenderPageOptions): string {
  const parts: string[] = [];

  // Header/footer content changes affect all pages. Include `textSig` so
  // same-height in-place edits (typing a replacement char, bold toggle, etc.)
  // invalidate the hash and force the per-page shells to re-render — block
  // count / height / visualBounds alone miss those (Codex #487 P1: 21:02
  // review). Include `rId` so switching to a different HF part with
  // identical content invalidates the hash too — otherwise the painted
  // `data-rid` would stay stale (Codex #487 P2: 22:48 review).
  if (options.headerContent) {
    parts.push(
      `hdr:${options.headerContent.blocks.length},${options.headerContent.height},${
        options.headerContent.visualTop ?? 0
      },${options.headerContent.visualBottom ?? options.headerContent.height},${
        options.headerContent.rId ?? ""
      },${options.headerContent.textSig ?? ""}`,
    );
  }
  if (options.footerContent) {
    parts.push(
      `ftr:${options.footerContent.blocks.length},${options.footerContent.height},${
        options.footerContent.visualTop ?? 0
      },${options.footerContent.visualBottom ?? options.footerContent.height},${
        options.footerContent.rId ?? ""
      },${options.footerContent.textSig ?? ""}`,
    );
  }
  parts.push(
    ...headerFooterContentFingerprint("hdr-map", options.headerContentByRId),
  );
  parts.push(
    ...headerFooterContentFingerprint("ftr-map", options.footerContentByRId),
  );

  if (options.firstPageHeaderContent) {
    parts.push(
      `fp-hdr:${options.firstPageHeaderContent.blocks.length},${options.firstPageHeaderContent.height},${
        options.firstPageHeaderContent.rId ?? ""
      },${options.firstPageHeaderContent.textSig ?? ""}`,
    );
  }
  if (options.firstPageFooterContent) {
    parts.push(
      `fp-ftr:${options.firstPageFooterContent.blocks.length},${options.firstPageFooterContent.height},${
        options.firstPageFooterContent.rId ?? ""
      },${options.firstPageFooterContent.textSig ?? ""}`,
    );
  }
  if (options.titlePg) {
    parts.push("titlePg");
  }

  // Theme changes
  if (options.theme) {
    parts.push(`thm:${options.theme.name ?? "default"}`);
  }

  // Page border changes
  if (options.pageBorders) {
    parts.push(`pb:${JSON.stringify(options.pageBorders)}`);
  }

  // Header/footer distances
  if (options.headerDistance !== undefined) {
    parts.push(`hd:${options.headerDistance}`);
  }
  if (options.footerDistance !== undefined) {
    parts.push(`fd:${options.footerDistance}`);
  }

  // Watermark identity. Without this, virtualized large documents
  // (8+ pages) keep already-rendered page shells when a watermark is
  // added, removed, or mutated — `repopulatePageContent` only refreshes
  // the content area and leaves the old watermark sibling behind. The
  // image src is fingerprinted too so swapping pictures invalidates.
  if (options.watermark) {
    parts.push(`wm:${JSON.stringify(options.watermark)}`);
  }
  if (options.watermarkImageSrc !== undefined) {
    parts.push(`wmsrc:${options.watermarkImageSrc}`);
  }

  return parts.join("|");
}

/**
 * Apply standard container styles for the pages wrapper.
 */
function applyContainerStyles(container: HTMLElement, pageGap: number): void {
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.alignItems = "center";
  container.style.gap = `${pageGap}px`;
  container.style.padding = "0";
  container.style.backgroundColor = "transparent";
}

/**
 * Number of pages to render above and below the visible area.
 * Keeps nearby pages ready for smooth scrolling.
 */
const VIRTUALIZATION_BUFFER = 1;
const VIRTUALIZATION_ROOT_MARGIN_PX = 1000;
const INITIAL_EAGER_RENDER_PAGES = 3;

/**
 * Minimum page count before virtualization kicks in.
 * Small documents render all pages eagerly for simplicity.
 */
const VIRTUALIZATION_THRESHOLD = 8;

/**
 * Render multiple pages to a container with virtualization for large documents.
 *
 * For documents with fewer than VIRTUALIZATION_THRESHOLD pages, all pages
 * are rendered eagerly. For larger documents, only pages near the visible
 * viewport are fully rendered — off-screen pages are lightweight shells
 * with correct dimensions to preserve scroll position.
 *
 * An IntersectionObserver watches page elements and populates/clears
 * content as pages scroll into and out of view.
 */
export function renderPages(
  pages: Page[],
  container: HTMLElement,
  options: RenderPageOptions & {
    pageGap?: number;
    footnotesByPage?: Map<number, FootnoteRenderItem[]>;
  } = {},
): void {
  const totalPages = pages.length;
  const pageGap = options.pageGap ?? 24;
  const pc = container as PageContainer;
  const prevState = pc.__pageRenderState;
  const currentOptionsHash = computeOptionsHash(options);
  const useVirtualization = totalPages >= VIRTUALIZATION_THRESHOLD;

  // Determine if we can do an incremental update
  const canIncremental =
    prevState &&
    prevState.optionsHash === currentOptionsHash &&
    useVirtualization;

  if (canIncremental) {
    // --- INCREMENTAL UPDATE PATH ---
    const prevShells = prevState.pageStates;
    const prevDataMap = prevState.pageDataMap;
    const observer = pc.__pageObserver;

    // If total page count changed, NUMPAGES fields in headers/footers are stale.
    // Force re-render of all currently-rendered pages.
    const totalPagesChanged = prevState.totalPages !== totalPages;

    // Update existing pages
    const commonCount = Math.min(prevShells.length, pages.length);
    for (let i = 0; i < commonCount; i++) {
      const prev = prevShells[i]!; // SAFETY: i < commonCount <= prevShells.length
      const page = pages[i]!; // SAFETY: i < commonCount <= pages.length
      const data = prevDataMap.get(prev.element);
      if (!data) {
        continue;
      }

      const oldPage = data.page;
      data.page = page;

      if (!data.rendered) {
        prev.fingerprint = null;
        prev.renderFingerprint = null;
        applyPageStyles(prev.element, page.size.w, page.size.h, options);
        syncPageBorderOverlay(
          prev.element,
          page,
          options,
          options.document ?? document,
        );
        prev.element.dataset["pageNumber"] = String(page.number);
        continue;
      }

      const newFp = computePageFingerprint(page, options.blockLookup);

      if (prev.fingerprint === newFp && !totalPagesChanged) {
        // Page unchanged — data map already points at the fresh page object.
        continue;
      }

      // Page changed — update the shell
      const shell = prev.element;
      const newRenderFp = computePageRenderFingerprint(
        page,
        options.blockLookup,
      );

      const renderChanged =
        totalPagesChanged || prev.renderFingerprint !== newRenderFp;
      const positionsSynced =
        !renderChanged && syncRenderedPmPositionData(shell, oldPage, data.page);

      if (!positionsSynced) {
        // Surgically replace only the content area, preserving header/footer
        repopulatePageContent(shell, prevDataMap, totalPages, options);
      }

      // Update fingerprint
      prev.fingerprint = newFp;
      prev.renderFingerprint = newRenderFp;

      // Update page styles in case size changed
      applyPageStyles(shell, page.size.w, page.size.h, options);
      syncPageBorderOverlay(shell, page, options, options.document ?? document);
      shell.dataset["pageNumber"] = String(page.number);
    }

    // Handle new pages (document grew)
    if (pages.length > prevShells.length) {
      const doc = options.document ?? document;
      for (let i = prevShells.length; i < pages.length; i++) {
        const page = pages[i]!; // SAFETY: i < pages.length
        const pageEl = doc.createElement("div");
        pageEl.className = options.pageClassName ?? PAGE_CLASS_NAMES.page;
        pageEl.dataset["pageNumber"] = String(page.number);
        pageEl.dataset["pageIndex"] = String(i);
        applyPageStyles(pageEl, page.size.w, page.size.h, options);
        syncPageBorderOverlay(pageEl, page, options, doc);
        container.append(pageEl);

        prevShells.push({
          element: pageEl,
          fingerprint: null,
          renderFingerprint: null,
        });
        prevDataMap.set(pageEl, { page, index: i, rendered: false });

        if (observer) {
          observer.observe(pageEl);
        }
      }
    }

    // Handle removed pages (document shrank)
    if (pages.length < prevShells.length) {
      for (let i = prevShells.length - 1; i >= pages.length; i--) {
        const shell = prevShells[i]!.element; // SAFETY: i >= pages.length and i < prevShells.length
        if (observer) {
          observer.unobserve(shell);
        }
        prevDataMap.delete(shell);
        shell.remove();
      }
      prevShells.length = pages.length;
    }

    // Update indices in data map (they may have shifted)
    for (let i = 0; i < prevShells.length; i++) {
      const data = prevDataMap.get(prevShells[i]!.element); // SAFETY: i < prevShells.length
      if (data) {
        data.index = i;
      }
    }

    // Update stored state with fresh options (blockLookup, footnotes, etc.)
    prevState.totalPages = totalPages;
    prevState.currentOptions = options;

    // Incremental path: existing shells were repopulated in place; fire
    // painter:painted so caret/selection overlays recompute against the
    // freshly written DOM (Codex #487 P2: 22:09 review).
    emitPainterPainted(container);
    return;
  }

  // --- FULL REBUILD PATH ---

  // Disconnect any previous observer
  const prevObserver = pc.__pageObserver;
  if (prevObserver) {
    prevObserver.disconnect();
    delete pc.__pageObserver;
  }

  // Clear existing content
  container.innerHTML = "";
  delete pc.__pageRenderState;

  applyContainerStyles(container, pageGap);

  // Build all page shells
  const pageShells: HTMLElement[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!; // SAFETY: i < pages.length

    if (!useVirtualization) {
      // Small document: render all pages eagerly
      const { context, pageOptions } = buildPageRenderArgs(
        page,
        totalPages,
        options,
      );
      const pageEl = renderPage(page, context, pageOptions);
      container.append(pageEl);
      pageShells.push(pageEl);
    } else {
      // Large document: create lightweight shell with correct dimensions
      const doc = options.document ?? document;
      const pageEl = doc.createElement("div");
      pageEl.className = options.pageClassName ?? PAGE_CLASS_NAMES.page;
      pageEl.dataset["pageNumber"] = String(page.number);
      pageEl.dataset["pageIndex"] = String(i);
      applyPageStyles(pageEl, page.size.w, page.size.h, options);
      syncPageBorderOverlay(pageEl, page, options, doc);
      container.append(pageEl);
      pageShells.push(pageEl);
    }
  }

  if (!useVirtualization) {
    // Store state for potential future incremental updates (won't be used
    // since small docs skip the incremental path, but keeps data consistent).
    // Fire painter:painted before returning so consumers — notably
    // HfCaretOverlay, which recomputes after the painter writes new HF
    // DOM — see the event in the common small-document path too
    // (Codex #487 P2: 22:09 review).
    emitPainterPainted(container);
    return;
  }

  // --- Virtualization via IntersectionObserver ---

  // Store page data for lazy rendering
  const pageDataMap = new Map<
    HTMLElement,
    { page: Page; index: number; rendered: boolean }
  >();
  for (let i = 0; i < pages.length; i++) {
    pageDataMap.set(pageShells[i]!, {
      // SAFETY: pageShells built with same indices
      page: pages[i]!, // SAFETY: i < pages.length
      index: i,
      rendered: false,
    });
  }

  // Use the browser viewport as intersection root.
  // The observer reads from pc.__pageRenderState so it always uses
  // the latest options/totalPages (updated by the incremental path).
  const observer = new IntersectionObserver(
    (entries) => {
      const renderState = pc.__pageRenderState;
      if (!renderState) {
        return;
      }
      const {
        currentOptions: liveOptions,
        totalPages: liveTotalPages,
        pageDataMap: liveDataMap,
      } = renderState;

      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) {
          continue;
        }
        const shell = entry.target;
        const data = liveDataMap.get(shell);
        if (!data) {
          continue;
        }

        if (entry.isIntersecting) {
          // Page is near viewport — render it and neighbors
          populatePageShell(shell, liveDataMap, liveTotalPages, liveOptions);

          // Also render buffer pages above and below
          for (
            let offset = -VIRTUALIZATION_BUFFER;
            offset <= VIRTUALIZATION_BUFFER;
            offset++
          ) {
            const neighborIdx = data.index + offset;
            if (
              neighborIdx >= 0 &&
              neighborIdx < renderState.pageStates.length &&
              neighborIdx !== data.index
            ) {
              populatePageShell(
                renderState.pageStates[neighborIdx]!.element, // SAFETY: guarded by length check above
                liveDataMap,
                liveTotalPages,
                liveOptions,
              );
            }
          }
        }
      }

      // Sweep: depopulate pages far from any currently-visible page.
      const viewportHeight = window.innerHeight;
      const nearThreshold = viewportHeight * 3;
      const nearIndices = new Set<number>();

      for (const [el, data] of liveDataMap) {
        if (!data.rendered) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (
          rect.bottom > -nearThreshold &&
          rect.top < viewportHeight + nearThreshold
        ) {
          nearIndices.add(data.index);
        }
      }

      for (const [el, data] of liveDataMap) {
        if (!data.rendered) {
          continue;
        }
        let keepRendered = false;
        for (const nearIdx of nearIndices) {
          if (Math.abs(data.index - nearIdx) <= VIRTUALIZATION_BUFFER + 1) {
            keepRendered = true;
            break;
          }
        }
        if (!keepRendered && nearIndices.size > 0) {
          depopulatePageShell(el, liveDataMap);
        }
      }
    },
    {
      root: null,
      rootMargin: `${VIRTUALIZATION_ROOT_MARGIN_PX}px 0px ${VIRTUALIZATION_ROOT_MARGIN_PX}px 0px`,
    },
  );

  // Observe all page shells
  for (const shell of pageShells) {
    observer.observe(shell);
  }

  // Store observer and render state on the container BEFORE eager rendering,
  // so the populatePageShell calls below can find state if needed.
  pc.__pageObserver = observer;
  pc.__pageRenderState = {
    pageStates: pageShells.map((el) => ({
      element: el,
      fingerprint: null,
      renderFingerprint: null,
    })),
    totalPages,
    optionsHash: currentOptionsHash,
    pageDataMap,
    currentOptions: options,
  };

  // Eagerly render the first few pages so the initial view isn't blank
  const initialRenderCount = Math.min(pages.length, INITIAL_EAGER_RENDER_PAGES);
  for (let i = 0; i < initialRenderCount; i++) {
    populatePageShell(pageShells[i]!, pageDataMap, totalPages, options); // SAFETY: i < initialRenderCount <= pages.length
  }

  emitPainterPainted(container);
}

// =============================================================================
// painter:painted event bus
// =============================================================================
//
// Subscribers (e.g. SelectionOverlay's HF caret cache, hidden HF PMs) need a
// single signal that the painter has finished writing children for the current
// layout pass. The body's hidden-PM + painter pipeline already exposes this
// implicitly via `syncCoordinator.onLayoutComplete`; for HF caret math the
// snapshot needs to invalidate the moment the painted DOM changes. A bubbling
// CustomEvent on the container element keeps the API ergonomic
// (`container.addEventListener("painter:painted", ...)`) without introducing a
// global EventTarget that would leak across multiple editor mounts.

export const PAINTER_PAINTED_EVENT = "painter:painted" as const;

export type PainterPaintedDetail = {
  container: HTMLElement;
  pageCount: number;
};

function emitPainterPainted(container: HTMLElement): void {
  const pageCount = container.querySelectorAll(
    `.${PAGE_CLASS_NAMES.page}`,
  ).length;
  const event = new CustomEvent<PainterPaintedDetail>(PAINTER_PAINTED_EVENT, {
    detail: { container, pageCount },
    bubbles: true,
    cancelable: false,
  });
  container.dispatchEvent(event);
}

/**
 * Populate a page shell with full rendered content.
 */
function populatePageShell(
  shell: HTMLElement,
  pageDataMap: Map<
    HTMLElement,
    { page: Page; index: number; rendered: boolean }
  >,
  totalPages: number,
  options: FullPageOptions,
): void {
  const data = pageDataMap.get(shell);
  if (!data || data.rendered) {
    return;
  }

  const { context, pageOptions } = buildPageRenderArgs(
    data.page,
    totalPages,
    options,
  );
  const fullPageEl = renderPage(data.page, context, pageOptions);

  // Strip any overlay left behind by the lightweight virtualized shell setup,
  // otherwise the overlay carried over from renderPage() stacks on top of it
  // and the border paints twice (darker/thicker than intended).
  for (const stale of Array.from(
    shell.querySelectorAll<HTMLElement>(":scope > .layout-page-border"),
  )) {
    stale.remove();
  }

  while (fullPageEl.firstChild) {
    shell.append(fullPageEl.firstChild);
  }

  data.rendered = true;
  syncPageShellFingerprints(shell, data, options);

  // Fire painter:painted on the pages container so HfCaretOverlay
  // recomputes against the now-populated shell. Without this, an HF
  // edit on a later page in a virtualized doc would emit
  // painter:painted while only the first three shells were populated
  // (full-rebuild path), the overlay would clear, and the caret would
  // not return until another transaction (Codex #487 P2: 22:27
  // review).
  const container = shell.parentElement;
  if (container instanceof HTMLElement) {
    emitPainterPainted(container);
  }
}

/**
 * Surgically replace only the content area of a rendered page shell.
 * Preserves header/footer elements to avoid blinking.
 */
function repopulatePageContent(
  shell: HTMLElement,
  pageDataMap: Map<
    HTMLElement,
    { page: Page; index: number; rendered: boolean }
  >,
  totalPages: number,
  options: FullPageOptions,
): void {
  const data = pageDataMap.get(shell);
  if (!data) {
    return;
  }

  const { context, pageOptions } = buildPageRenderArgs(
    data.page,
    totalPages,
    options,
  );

  // Render a full page off-screen
  const fullPageEl = renderPage(data.page, context, pageOptions);

  // Extract the new content area from the rendered page
  const newContentEl = fullPageEl.querySelector(`.${PAGE_CLASS_NAMES.content}`);
  const oldContentEl = shell.querySelector(`.${PAGE_CLASS_NAMES.content}`);

  if (newContentEl && oldContentEl) {
    // Replace only the content area — header/footer stay untouched
    oldContentEl.replaceWith(newContentEl);
  } else {
    // Fallback: full replace if structure doesn't match
    shell.innerHTML = "";
    data.rendered = false;
    populatePageShell(shell, pageDataMap, totalPages, options);
  }
}

function syncRenderedPmPositionData(
  shell: HTMLElement,
  oldPage: Page,
  newPage: Page,
): boolean {
  const delta = getUniformPagePositionDelta(oldPage, newPage);
  if (delta === null) {
    return false;
  }
  if (delta === 0) {
    return true;
  }

  for (const element of shell.querySelectorAll<HTMLElement>(
    "[data-pm-start], [data-pm-end], [data-table-pm-start]",
  )) {
    shiftNumericDatasetValue(element, "pmStart", delta);
    shiftNumericDatasetValue(element, "pmEnd", delta);
    shiftNumericDatasetValue(element, "tablePmStart", delta);
  }
  return true;
}

function getUniformPagePositionDelta(
  oldPage: Page,
  newPage: Page,
): number | null {
  if (oldPage.fragments.length !== newPage.fragments.length) {
    return null;
  }

  let delta: number | null = null;
  for (let i = 0; i < oldPage.fragments.length; i++) {
    const oldFragment = oldPage.fragments[i];
    const newFragment = newPage.fragments[i];
    if (!oldFragment || !newFragment) {
      return null;
    }
    if (
      oldFragment.kind !== newFragment.kind ||
      oldFragment.blockId !== newFragment.blockId
    ) {
      return null;
    }

    const startDelta = readPositionDelta(
      oldFragment.pmStart,
      newFragment.pmStart,
    );
    if (startDelta !== null) {
      if (delta !== null && delta !== startDelta) {
        return null;
      }
      delta = startDelta;
    }

    const endDelta = readPositionDelta(oldFragment.pmEnd, newFragment.pmEnd);
    if (endDelta !== null) {
      if (delta !== null && delta !== endDelta) {
        return null;
      }
      delta = endDelta;
    }
  }

  return delta;
}

function readPositionDelta(
  previous: number | undefined,
  next: number | undefined,
): number | null {
  if (previous === undefined && next === undefined) {
    return null;
  }
  if (previous === undefined || next === undefined) {
    return null;
  }
  return next - previous;
}

function shiftNumericDatasetValue(
  element: HTMLElement,
  key: "pmEnd" | "pmStart" | "tablePmStart",
  delta: number,
): void {
  const value = element.dataset[key];
  if (value === undefined) {
    return;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return;
  }

  element.dataset[key] = String(numeric + delta);
}

function syncPageShellFingerprints(
  shell: HTMLElement,
  data: { page: Page; index: number },
  options: FullPageOptions,
): void {
  const container = shell.parentElement as PageContainer | null;
  const pageState = container?.__pageRenderState?.pageStates[data.index];
  if (!pageState || pageState.element !== shell) {
    return;
  }

  pageState.fingerprint = computePageFingerprint(
    data.page,
    options.blockLookup,
  );
  pageState.renderFingerprint = computePageRenderFingerprint(
    data.page,
    options.blockLookup,
  );
}

/**
 * Find the page shell whose layout fragments cover (or are nearest
 * before) a given ProseMirror position. Returns null if the
 * container has no virtualization state — callers should fall back
 * to the cheaper run-level DOM query in that case.
 *
 * Uses the layout-side Page records (always present even when a
 * page's content hasn't rendered yet under virtualization), so the
 * caller can scroll to the correct page shell and let the
 * IntersectionObserver populate it on demand. This avoids the
 * "many clicks to arrive" failure mode where a per-run DOM query
 * only finds runs in the currently-rendered buffer and steps the
 * viewport one buffer at a time.
 */
export function findPageShellForPmPos(
  container: HTMLElement,
  pmPos: number,
): { element: HTMLElement; isExact: boolean } | null {
  const pc = container as PageContainer;
  const dataMap = pc.__pageRenderState?.pageDataMap;
  if (!dataMap || dataMap.size === 0) {
    return null;
  }
  let bestStartShell: HTMLElement | null = null;
  let bestStart = Number.NEGATIVE_INFINITY;
  for (const [shell, entry] of dataMap) {
    let pageStart = Number.POSITIVE_INFINITY;
    let pageEnd = Number.NEGATIVE_INFINITY;
    for (const fragment of entry.page.fragments) {
      if (fragment.pmStart !== undefined && fragment.pmStart < pageStart) {
        pageStart = fragment.pmStart;
      }
      if (fragment.pmEnd !== undefined && fragment.pmEnd > pageEnd) {
        pageEnd = fragment.pmEnd;
      }
    }
    if (pageStart === Number.POSITIVE_INFINITY) {
      continue;
    }
    if (pageStart <= pmPos && pmPos <= pageEnd) {
      return { element: shell, isExact: true };
    }
    if (pageStart <= pmPos && pageStart > bestStart) {
      bestStart = pageStart;
      bestStartShell = shell;
    }
  }
  return bestStartShell ? { element: bestStartShell, isExact: false } : null;
}

/**
 * Clear a page shell's content (keep shell dimensions for scroll).
 */
function depopulatePageShell(
  shell: HTMLElement,
  pageDataMap: Map<
    HTMLElement,
    { page: Page; index: number; rendered: boolean }
  >,
): void {
  const data = pageDataMap.get(shell);
  if (!data || !data.rendered) {
    return;
  }

  shell.innerHTML = "";
  data.rendered = false;

  const container = shell.parentElement as PageContainer | null;
  const pageState = container?.__pageRenderState?.pageStates[data.index];
  if (pageState?.element === shell) {
    pageState.fingerprint = null;
    pageState.renderFingerprint = null;
  }
}

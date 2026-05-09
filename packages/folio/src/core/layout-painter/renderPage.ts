/**
 * Page Renderer
 *
 * Renders a single page from Layout data to DOM elements.
 * Each page contains positioned fragments within a content area.
 */

import { measureParagraph } from "../layout-bridge/measuring";
import type { FloatingImageZone } from "../layout-bridge/measuring";
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
} from "../layout-engine/types";
import type { BorderSpec, Theme } from "../types/document";
import { resolveFontFamily } from "../utils/fontResolver";
import { borderToStyle } from "../utils/formatToStyle";
import type { BlockLookup } from "./index";
import { renderFragment } from "./renderFragment";
import { renderImageFragment } from "./renderImage";
import { renderParagraphFragment } from "./renderParagraph";
import { renderTableFragment } from "./renderTable";
import { renderTextBoxFragment } from "./renderTextBox";
import {
  emuToPixels,
  isFloatingImageRun,
  isTextWrappingFloatingImageRun,
} from "./renderUtils";
import type { RenderContext } from "./renderUtils";

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
 * Floating object exclusion rectangle used for text wrapping.
 */
type FloatingExclusionRect = {
  /** Which side the IMAGE is on (for rendering): 'left' or 'right' */
  side: "left" | "right";
  /** X position relative to content area (0 = left edge of content) */
  x: number;
  /** Y position relative to content area (0 = top of content) */
  y: number;
  /** Object dimensions */
  width: number;
  height: number;
  /** Wrap distances */
  distTop: number;
  distBottom: number;
  distLeft: number;
  distRight: number;
  /** OOXML wrapText: which side(s) TEXT flows on */
  wrapText?: "bothSides" | "left" | "right" | "largest";
  /** Wrap type from DOCX (square, tight, through, topAndBottom) */
  wrapType?: string;
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

/**
 * Header/footer content for rendering
 */
export type HeaderFooterContent = {
  /** Flow blocks for the header/footer content. */
  blocks: FlowBlock[];
  /** Measurements for the blocks. */
  measures: Measure[];
  /** Total height of the content. */
  height: number;
  /** Top-most visual extent relative to the nominal flow origin. */
  visualTop?: number;
  /** Bottom-most visual extent relative to the nominal flow origin. */
  visualBottom?: number;
};

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
    offsetFrom?: "page" | "text";
  };
  /** Theme for resolving border colors. */
  theme?: Theme | null;
  /** Footnotes to render at the bottom of this page. */
  footnoteArea?: FootnoteRenderItem[];
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

  // Page borders and shadows removed — Stella doesn't use them

  // Apply OOXML page borders
  if (options.pageBorders) {
    const pb = options.pageBorders;
    const sides = ["top", "bottom", "left", "right"] as const;
    const cssSides = ["Top", "Bottom", "Left", "Right"] as const;

    for (let i = 0; i < sides.length; i++) {
      const border = pb[sides[i]!]; // SAFETY: i < sides.length (4 elements)
      if (border && border.style !== "none" && border.style !== "nil") {
        const styles = borderToStyle(border, cssSides[i]!, options.theme); // SAFETY: same bounds
        for (const [key, value] of Object.entries(styles)) {
          (element.style as unknown as Record<string, string>)[key] =
            String(value);
        }
      }
    }
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

  // Horizontal
  let left = 0;
  if (floating.tblpXSpec === "left") {
    left = horzFrameOffset;
  } else if (floating.tblpXSpec === "right") {
    left = horzFrameOffset + horzFrameWidth - measure.totalWidth;
  } else if (floating.tblpXSpec === "center") {
    left = horzFrameOffset + (horzFrameWidth - measure.totalWidth) / 2;
  } else if (floating.tblpX !== undefined) {
    left = horzFrameOffset + floating.tblpX;
  }

  // Vertical
  let top = 0;
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
 * Extract floating images from a paragraph block and determine their page-level positions.
 * Returns extracted images and info for the paragraph about space reserved.
 */
function extractFloatingImagesFromParagraph(
  block: ParagraphBlock,
  fragmentY: number, // Y position of the paragraph fragment on the page (relative to content area)
  contentWidth: number, // Width of the content area
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

    // Determine position based on image attributes
    const position = imgRun.position;
    const distTop = imgRun.distTop ?? 0;
    const distBottom = imgRun.distBottom ?? 0;
    const distLeft = imgRun.distLeft ?? 12;
    const distRight = imgRun.distRight ?? 12;

    // Determine horizontal position (left or right side)
    let side: "left" | "right" = "left";
    let x = 0;

    if (position?.horizontal) {
      const h = position.horizontal;
      if (h.align === "right") {
        side = "right";
        // Position from right edge of content
        x = contentWidth - imgRun.width;
      } else if (h.align === "left") {
        side = "left";
        x = 0;
      } else if (h.align === "center") {
        side = "left"; // Treat centered as left-aligned for simplicity
        x = (contentWidth - imgRun.width) / 2;
      } else if (h.posOffset !== undefined) {
        // Explicit offset from margin
        x = emuToPixels(h.posOffset);
        side = x > contentWidth / 2 ? "right" : "left";
      }
    } else if (imgRun.cssFloat === "right") {
      side = "right";
      x = contentWidth - imgRun.width;
    }

    // Determine vertical position
    let y = 0;

    if (position?.vertical) {
      const v = position.vertical;
      if (v.align === "top") {
        // Align to top of margin area
        y = 0;
      } else if (v.align === "bottom") {
        // Would need page height - not supported, use paragraph position
        y = fragmentY;
      } else if (v.posOffset !== undefined) {
        y = emuToPixels(v.posOffset);
      } else {
        // Default to paragraph position
        y = fragmentY;
      }

      // Check relativeTo for positioning context
      if (
        v.relativeTo === "margin" &&
        (v.align === "top" || v.posOffset !== undefined)
      ) {
        // Already in content-relative coordinates (margin = content area)
      } else if (v.relativeTo === "paragraph") {
        // Add fragment Y offset
        y = fragmentY + y;
      }
    } else {
      // Default: position at paragraph
      y = fragmentY;
    }

    // Derive wrapText from cssFloat:
    // cssFloat='left' → image floats left → text on right → wrapText='right'
    // cssFloat='right' → image floats right → text on left → wrapText='left'
    // cssFloat='none' or undefined → wrapText='bothSides' (default)
    let wrapText: "bothSides" | "left" | "right" | "largest" = "bothSides";
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
      side,
      x,
      y,
      distTop,
      distBottom,
      distLeft,
      distRight,
      ...(imgRun.pmStart !== undefined ? { pmStart: imgRun.pmStart } : {}),
      ...(imgRun.pmEnd !== undefined ? { pmEnd: imgRun.pmEnd } : {}),
      wrapText,
      ...(imgRun.wrapType !== undefined ? { wrapType: imgRun.wrapType } : {}),
      affectsTextWrap: isTextWrappingFloatingImageRun(imgRun),
      behindDoc: imgRun.wrapType === "behind",
    });
  }

  return floatingImages;
}

/**
 * Convert floating exclusion rectangles to per-image FloatingImageZone[]
 * for the measurement system. Each rect becomes its own zone so
 * lines at different Y positions get independently correct widths.
 *
 * wrapText controls which side(s) TEXT flows on:
 *   'right'    → text only on right → image blocks left side (leftMargin)
 *   'left'     → text only on left  → image blocks right side (rightMargin)
 *   'bothSides'→ text on right of left-side images, left of right-side images
 *   'largest'  → same as bothSides (simplified)
 *
 * topAndBottom → full-width exclusion (leftMargin = contentWidth → forces line skip)
 */
function rectsToFloatingZones(
  rects: FloatingExclusionRect[],
  contentWidth: number,
): FloatingImageZone[] {
  return rects.map((rect) => {
    const rectRight = rect.x + rect.width + rect.distRight;
    const rectTop = rect.y - rect.distTop;
    const rectBottom = rect.y + rect.height + rect.distBottom;

    let leftMargin = 0;
    let rightMargin = 0;

    const wt = rect.wrapText ?? "bothSides";

    if (wt === "right") {
      // Text flows on RIGHT only → image blocks the left side
      leftMargin = rectRight;
    } else if (wt === "left") {
      // Text flows on LEFT only → image blocks the right side
      rightMargin = contentWidth - (rect.x - rect.distLeft);
    } else {
      // bothSides / largest: use image position to determine which side it blocks
      if (rect.side === "left") {
        leftMargin = rectRight;
      } else {
        rightMargin = contentWidth - (rect.x - rect.distLeft);
      }
    }

    return { leftMargin, rightMargin, topY: rectTop, bottomY: rectBottom };
  });
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

      // Extract floating images and filter them from runs
      const inlineRuns: typeof paragraphBlock.runs = [];
      for (const run of paragraphBlock.runs) {
        if (run.kind === "image" && "position" in run && run.position) {
          floatingImages.push({
            src: run.src,
            width: run.width,
            height: run.height,
            ...(run.alt !== undefined ? { alt: run.alt } : {}),
            paragraphY: paragraphStartY,
            behindDoc: run.wrapType === "behind",
            position: run.position,
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
      const spaceBefore = paragraphBlock.attrs?.spacing?.before ?? 0;
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
        );
        fragEl.style.position = "absolute";
        fragEl.style.top = `${top}px`;
        fragEl.style.left = `${left}px`;
        containerEl.append(fragEl);
        // No cursorY advance — surrounding HF blocks flow as if the
        // floating table weren't there (Word semantics for unwrapped
        // floating tables).
      } else {
        fragEl.style.position = "absolute";
        fragEl.style.top = `${cursorY}px`;
        fragEl.style.left = "0";
        containerEl.append(fragEl);
        cursorY += measure.totalHeight;
      }
    } else if (block.kind === "textBox" && measure.kind === "textBox") {
      // The unified pipeline extracts top-level text boxes inside H/F as
      // their own block. `renderTextBoxFragment` sets `position: absolute`
      // internally; we only supply top/left so it stacks at cursorY.
      const syntheticFragment: TextBoxFragment = {
        kind: "textBox",
        blockId: block.id,
        x: 0,
        y: cursorY,
        width: contentWidth,
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

    applyHeaderFooterFloatHorizontalPosition(img, floatImg, layout);
    img.style.top = `${resolveHeaderFooterFloatTop(floatImg, layout)}px`;

    containerEl.append(img);
  }

  return containerEl;
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

  // Separator line (33% width, Google Docs style)
  const separator = doc.createElement("div");
  separator.style.width = "33%";
  separator.style.height = "0.5px";
  separator.style.backgroundColor = "var(--doc-canvas-text, #000)";
  separator.style.marginBottom = "6px";
  separator.style.marginTop = "6px";
  container.append(separator);

  // Render each footnote
  for (const fn of footnotes) {
    const fnEl = doc.createElement("div");
    fnEl.style.marginBottom = "4px";
    fnEl.style.color = "var(--doc-canvas-text, #000)";

    if (fn.content) {
      const contentEl = renderFootnoteContent(fn, contentWidth, doc, context);
      fnEl.append(contentEl);
    } else {
      fnEl.style.fontSize = "10px";
      fnEl.style.lineHeight = "1.3";

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
    throw new Error("Missing structured footnote content");
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

  // Create content area
  const contentEl = doc.createElement("div");
  contentEl.className = PAGE_CLASS_NAMES.content;
  applyContentAreaStyles(contentEl, page);

  // Calculate content width for justify alignment
  const contentWidth = page.size.w - page.margins.left - page.margins.right;

  // PHASE 1: Extract all floating images from paragraphs on this page
  const allFloatingImages: PageFloatingImage[] = [];
  const floatingRects: FloatingExclusionRect[] = [];

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
          contentWidth,
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
        blockData?.measure.kind === "paragraph"
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
        blockData?.measure.kind === "table"
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
        blockData?.measure.kind === "image"
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
        blockData?.measure.kind === "textBox"
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
    // Position at page bottom minus bottom margin (bottom of content area)
    // The reserved height includes separator + all footnotes
    const reservedHeight = page.footnoteReservedHeight ?? 0;
    const contentAreaBottom =
      page.size.h - page.margins.bottom - page.margins.top;
    fnAreaEl.style.top = `${contentAreaBottom - reservedHeight}px`;
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
    const footerVisualTop = options.footerContent?.visualTop ?? 0;
    const footerVisualBottom =
      options.footerContent?.visualBottom ?? options.footerContent?.height ?? 0;
    const actualFooterHeight = Math.max(
      footerVisualBottom - footerVisualTop,
      24,
    );
    const footerOverflows = actualFooterHeight > availableFooterHeight;

    const footerEl = doc.createElement("div");
    footerEl.className = PAGE_CLASS_NAMES.footer;
    footerEl.style.position = "absolute";
    footerEl.style.top = `${page.size.h - footerDistance - actualFooterHeight}px`;
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
          flowTop:
            page.size.h - footerDistance - (options.footerContent?.height ?? 0),
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

  return pageEl;
}

/**
 * Full options type used by page rendering helpers.
 */
type FullPageOptions = RenderPageOptions & {
  footnotesByPage?: Map<number, FootnoteRenderItem[]>;
};

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
  // Per-page header/footer selection when titlePg is enabled
  if (options.titlePg && page.number === 1) {
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
  fingerprint: string;
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
  const parts: string[] = [];

  // Page-level properties
  parts.push(`s:${page.size.w},${page.size.h}`);
  parts.push(
    `m:${page.margins.top},${page.margins.right},${page.margins.bottom},${page.margins.left}`,
  );
  parts.push(`n:${page.number}`);
  if (page.footnoteReservedHeight) {
    parts.push(`fn:${page.footnoteReservedHeight}`);
  }

  // Each fragment's stable properties
  for (const frag of page.fragments) {
    let fp = `${frag.kind}:${frag.blockId},${frag.x},${frag.y},${frag.width},${frag.height}`;
    if (frag.pmStart !== undefined) {
      fp += `,ps:${frag.pmStart}`;
    }
    if (frag.pmEnd !== undefined) {
      fp += `,pe:${frag.pmEnd}`;
    }

    if (frag.kind === "paragraph") {
      fp += `,fl:${frag.fromLine},tl:${frag.toLine}`;
    } else if (frag.kind === "table") {
      fp += `,fr:${frag.fromRow},tr:${frag.toRow}`;
    }
    if (blockLookup && frag.blockId !== undefined) {
      const block = blockLookup.get(String(frag.blockId))?.block;
      const annotationFingerprint = block
        ? computeAnnotationFingerprint(block)
        : "";
      if (annotationFingerprint) {
        fp += `,ann:${annotationFingerprint}`;
      }
    }

    parts.push(fp);
  }

  return parts.join("|");
}

function computeAnnotationFingerprint(block: FlowBlock): string {
  const parts: string[] = [];
  collectAnnotationFingerprint(block, parts);
  return parts.join(";");
}

function collectAnnotationFingerprint(block: FlowBlock, parts: string[]): void {
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
          `${index}:${run.pmStart ?? ""}-${run.pmEnd ?? ""}:${runParts.join("|")}`,
        );
      }
    }
    return;
  }

  if (block.kind === "table") {
    for (const row of block.rows) {
      for (const cell of row.cells) {
        for (const child of cell.blocks) {
          collectAnnotationFingerprint(child, parts);
        }
      }
    }
    return;
  }

  if (block.kind === "textBox") {
    for (const child of block.content) {
      collectAnnotationFingerprint(child, parts);
    }
  }
}

/**
 * Compute a hash for render options that affect all pages globally.
 * When this changes, all pages need a full re-render.
 */
function computeOptionsHash(options: RenderPageOptions): string {
  const parts: string[] = [];

  // Header/footer content changes affect all pages
  if (options.headerContent) {
    parts.push(
      `hdr:${options.headerContent.blocks.length},${options.headerContent.height},${
        options.headerContent.visualTop ?? 0
      },${options.headerContent.visualBottom ?? options.headerContent.height}`,
    );
  }
  if (options.footerContent) {
    parts.push(
      `ftr:${options.footerContent.blocks.length},${options.footerContent.height},${
        options.footerContent.visualTop ?? 0
      },${options.footerContent.visualBottom ?? options.footerContent.height}`,
    );
  }

  if (options.firstPageHeaderContent) {
    parts.push(
      `fp-hdr:${options.firstPageHeaderContent.blocks.length},${options.firstPageHeaderContent.height}`,
    );
  }
  if (options.firstPageFooterContent) {
    parts.push(
      `fp-ftr:${options.firstPageFooterContent.blocks.length},${options.firstPageFooterContent.height}`,
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
const VIRTUALIZATION_BUFFER = 2;

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

    // Compute new fingerprints
    const newFingerprints: string[] = [];
    for (const page of pages) {
      newFingerprints.push(computePageFingerprint(page, options.blockLookup));
    }

    // If total page count changed, NUMPAGES fields in headers/footers are stale.
    // Force re-render of all currently-rendered pages.
    const totalPagesChanged = prevState.totalPages !== totalPages;

    // Update existing pages
    const commonCount = Math.min(prevShells.length, pages.length);
    for (let i = 0; i < commonCount; i++) {
      const prev = prevShells[i]!; // SAFETY: i < commonCount <= prevShells.length
      const newFp = newFingerprints[i]!; // SAFETY: i < commonCount <= pages.length

      if (prev.fingerprint === newFp && !totalPagesChanged) {
        // Page unchanged — update data map with new page data (references may differ)
        const data = prevDataMap.get(prev.element);
        if (data) {
          data.page = pages[i]!; // SAFETY: i < commonCount <= pages.length
        }
        continue;
      }

      // Page changed — update the shell
      const shell = prev.element;
      const data = prevDataMap.get(shell);

      // Update data map entry
      if (data) {
        data.page = pages[i]!; // SAFETY: i < commonCount <= pages.length

        if (data.rendered) {
          // Surgically replace only the content area, preserving header/footer
          repopulatePageContent(shell, prevDataMap, totalPages, options);
        }
        // If not rendered, it will be populated when it scrolls into view
      }

      // Update fingerprint
      prev.fingerprint = newFp;

      // Update page styles in case size changed
      const page = pages[i]!; // SAFETY: i < commonCount <= pages.length
      applyPageStyles(shell, page.size.w, page.size.h, options);
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
        container.append(pageEl);

        prevShells.push({ element: pageEl, fingerprint: newFingerprints[i]! }); // SAFETY: i < pages.length
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
  const fingerprints: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!; // SAFETY: i < pages.length
    fingerprints.push(computePageFingerprint(page, options.blockLookup));

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
      container.append(pageEl);
      pageShells.push(pageEl);
    }
  }

  if (!useVirtualization) {
    // Store state for potential future incremental updates (won't be used
    // since small docs skip the incremental path, but keeps data consistent)
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
        const shell = entry.target as HTMLElement;
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
      rootMargin: "1500px 0px 1500px 0px",
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
    pageStates: pageShells.map((el, i) => ({
      element: el,
      fingerprint: fingerprints[i]!, // SAFETY: fingerprints built with same indices as pageShells
    })),
    totalPages,
    optionsHash: currentOptionsHash,
    pageDataMap,
    currentOptions: options,
  };

  // Eagerly render the first few pages so the initial view isn't blank
  const initialRenderCount = Math.min(pages.length, VIRTUALIZATION_BUFFER + 3);
  for (let i = 0; i < initialRenderCount; i++) {
    populatePageShell(pageShells[i]!, pageDataMap, totalPages, options); // SAFETY: i < initialRenderCount <= pages.length
  }
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

  while (fullPageEl.firstChild) {
    shell.append(fullPageEl.firstChild);
  }

  data.rendered = true;
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
}

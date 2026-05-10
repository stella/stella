/**
 * Header / Footer Layout Utilities
 *
 * The header/footer rendering pipeline lives here so any rendering adapter
 * can share the conversion logic and just supply its platform-specific
 * `MeasureBlocksFn`. Mirrors the footnote pipeline in `footnoteLayout.ts`.
 *
 * Pipeline:
 *   HF.content -> headerFooterToProseDoc -> toFlowBlocks
 *     -> normalizeHeaderFooterMeasureBlocks (measure copy: drops floats and
 *        style-inherited spacing the renderer zeroes anyway, marks the
 *        canonical trailing-empty-paragraph-after-table as zero-height)
 *     -> measureBlocks (caller-supplied)
 *     -> HeaderFooterContent (blocks, measures, height, visualTop/Bottom)
 *
 * The render side uses the ORIGINAL block list (full data: floating images,
 * inherited spacing). Measurement uses the normalized copy.
 */

import type {
  FlowBlock,
  ImageRun,
  Measure,
  PageMargins,
  Run,
} from "../layout-engine/types";
import type { HeaderFooterContent } from "../layout-painter/renderPage";
import { headerFooterToProseDoc } from "../prosemirror/conversion/toProseDoc";
import type { HeaderFooter, StyleDefinitions, Theme } from "../types/document";
import { emuToPixels } from "../utils/units";
import type { MeasureBlocksFn } from "./footnoteLayout";
import { toFlowBlocks } from "./toFlowBlocks";

// =============================================================================
// 1. Page-level metrics passed in by the caller
// =============================================================================

export type HeaderFooterMetrics = {
  section: "header" | "footer";
  pageSize: { w: number; h: number };
  margins: PageMargins;
};

// =============================================================================
// 2. Measurement-time block normalization
// =============================================================================
//
// Three transforms are applied to the FlowBlock list before measurement:
//
// 1. Drop anchored / floating images (#358). They're positioned absolutely
//    at page level and don't contribute to in-flow paragraph height. The
//    measurement copy renders only the inline runs.
//
// 2. Strip style-inherited paragraph spacing (#380). Word visibly does NOT
//    honor inherited `spaceBefore` / `spaceAfter` (e.g. Normal's default
//    8pt-after) inside the HF text frame. Inline `<w:spacing>` set
//    explicitly on the HF paragraph IS honored. The parser flags inline
//    spacing via `spacingExplicit.before` / `.after`; anything not flagged
//    was inherited and is zeroed for measurement.
//
// 3. Zero trailing empty paragraph after a table (#381). OOXML requires a
//    trailing block-level element after the last `<w:tbl>` in any block
//    container, including `<w:hdr>` / `<w:ftr>`. Word renders that empty
//    paragraph as a zero-height anchor when it has no runs AND no authored
//    visual content (no paragraph borders, no explicit spacing). Marking
//    its measure with `suppressEmptyParagraphHeight` keeps the BLOCK so
//    click-to-position into the empty space below the table places the
//    cursor in the trailing paragraph (matching Word) but the measure
//    returns zero height. Empty paragraphs with authored `pBdr` or
//    explicit spacing are NOT suppressed — they exist for their visual
//    side effect, not just as a structural anchor.

function isAnchoredImageRun(run: Run): boolean {
  return run.kind === "image" && !!run.position;
}

function hasAuthoredVisualContent(block: FlowBlock): boolean {
  if (block.kind !== "paragraph") {
    return false;
  }
  const attrs = block.attrs;
  if (!attrs) {
    return false;
  }
  if (attrs.borders?.top || attrs.borders?.bottom) {
    return true;
  }
  if (attrs.spacingExplicit?.before || attrs.spacingExplicit?.after) {
    return true;
  }
  return false;
}

export function normalizeHeaderFooterMeasureBlocks(
  blocks: FlowBlock[],
): FlowBlock[] {
  // Only the *canonical trailing* OOXML paragraph after the LAST block
  // qualifies for height suppression. Empty paragraphs used as authored
  // spacers in the middle of an HF (e.g. `[table, blank, paragraph,
  // blank, table]`) carry intentional vertical space and must not be
  // collapsed.
  const trailingEmptyAfterTable = new Set<number>();
  const lastIndex = blocks.length - 1;
  if (lastIndex > 0) {
    const cur = blocks[lastIndex];
    const prev = blocks[lastIndex - 1];
    if (
      prev?.kind === "table" &&
      cur?.kind === "paragraph" &&
      cur.runs.length === 0 &&
      !hasAuthoredVisualContent(cur)
    ) {
      trailingEmptyAfterTable.add(lastIndex);
    }
  }

  return blocks.map((block, index) => {
    if (block.kind !== "paragraph") {
      return block;
    }

    const isTrailingEmpty = trailingEmptyAfterTable.has(index);

    const explicit = block.attrs?.spacingExplicit;
    const hasResolvedBefore = block.attrs?.spacing?.before != null;
    const hasResolvedAfter = block.attrs?.spacing?.after != null;
    const beforeIsInherited = hasResolvedBefore && !explicit?.before;
    const afterIsInherited = hasResolvedAfter && !explicit?.after;
    const stripsSpacing = beforeIsInherited || afterIsInherited;

    const stripsImages = block.runs.some(isAnchoredImageRun);

    if (!stripsSpacing && !stripsImages && !isTrailingEmpty) {
      return block;
    }

    let inlineRuns: Run[] = block.runs;
    if (stripsImages) {
      inlineRuns = block.runs.filter((r) => !isAnchoredImageRun(r));
      if (inlineRuns.length === 0) {
        inlineRuns = [{ kind: "text" as const, text: "" }];
      }
    }

    let attrs = block.attrs;
    if (stripsSpacing && attrs?.spacing) {
      const newSpacing = { ...attrs.spacing };
      if (!explicit?.before) {
        delete newSpacing.before;
      }
      if (!explicit?.after) {
        delete newSpacing.after;
      }
      attrs = { ...attrs, spacing: newSpacing };
    }

    if (isTrailingEmpty) {
      attrs = { ...attrs, suppressEmptyParagraphHeight: true };
    }

    return attrs
      ? { ...block, runs: inlineRuns, attrs }
      : { ...block, runs: inlineRuns };
  });
}

// =============================================================================
// 3. Visual bounds (account for floating images that paint above/below the
//    nominal flow rectangle so HF clipping & shadow regions size correctly)
// =============================================================================

type PositionedAxis = {
  relativeTo?: string;
  posOffset?: number;
  align?: string;
  alignment?: string;
};

function getPositionAlignment(
  axis: PositionedAxis | undefined,
): string | undefined {
  return axis?.align ?? axis?.alignment;
}

export function resolveHeaderFooterVisualTop(
  run: ImageRun,
  paragraphY: number,
  flowHeight: number,
  metrics: HeaderFooterMetrics,
): number {
  const flowTop =
    metrics.section === "header"
      ? (metrics.margins.header ?? 48)
      : metrics.pageSize.h - (metrics.margins.footer ?? 48) - flowHeight;
  const vertical = run.position?.vertical;

  if (!vertical) {
    return paragraphY;
  }

  const align = getPositionAlignment(vertical);
  const offsetPx =
    vertical.posOffset !== undefined
      ? emuToPixels(vertical.posOffset)
      : undefined;

  if (vertical.relativeTo === "page") {
    if (offsetPx !== undefined) {
      return offsetPx - flowTop;
    }
    if (align === "top") {
      return -flowTop;
    }
    if (align === "bottom") {
      return metrics.pageSize.h - run.height - flowTop;
    }
    if (align === "center") {
      return (metrics.pageSize.h - run.height) / 2 - flowTop;
    }
  }

  if (vertical.relativeTo === "margin") {
    const marginTop = metrics.margins.top;
    const marginHeight =
      metrics.pageSize.h - metrics.margins.top - metrics.margins.bottom;
    if (offsetPx !== undefined) {
      return marginTop + offsetPx - flowTop;
    }
    if (align === "top") {
      return marginTop - flowTop;
    }
    if (align === "bottom") {
      return marginTop + marginHeight - run.height - flowTop;
    }
    if (align === "center") {
      return marginTop + (marginHeight - run.height) / 2 - flowTop;
    }
  }

  if (offsetPx !== undefined) {
    return paragraphY + offsetPx;
  }

  return paragraphY;
}

export function calculateHeaderFooterVisualBounds(
  blocks: FlowBlock[],
  measures: Measure[],
  flowHeight: number,
  metrics: HeaderFooterMetrics,
): { visualTop: number; visualBottom: number } {
  let visualTop = 0;
  let visualBottom = flowHeight;
  let cursorY = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const measure = measures[i];
    if (!block || !measure) {
      continue;
    }

    if (block.kind === "paragraph" && measure.kind === "paragraph") {
      const paragraphStartY = cursorY;
      const paragraphBottomY = paragraphStartY + measure.totalHeight;
      visualTop = Math.min(visualTop, paragraphStartY);
      visualBottom = Math.max(visualBottom, paragraphBottomY);

      for (const run of block.runs) {
        if (run.kind !== "image" || !run.position) {
          continue;
        }
        const runTop = resolveHeaderFooterVisualTop(
          run,
          paragraphStartY,
          flowHeight,
          metrics,
        );
        visualTop = Math.min(visualTop, runTop);
        visualBottom = Math.max(visualBottom, runTop + run.height);
      }

      cursorY = paragraphBottomY;
    } else {
      // Tables / images / textBoxes contribute their measured height as a
      // single block (they don't reflow within the HF area). Floating
      // tables (`<w:tblpPr>`) anchor at (tblpX, tblpY) and don't
      // participate in the cursorY flow — they're positioned absolutely by
      // the renderer and can overlap surrounding HF content (Word
      // semantics for unwrapped floating tables).
      let blockHeight = 0;
      let advancesCursor = true;
      if (block.kind === "table" && measure.kind === "table") {
        blockHeight = measure.totalHeight;
        if (block.floating) {
          advancesCursor = false;
        }
      } else if (block.kind === "image" && measure.kind === "image") {
        blockHeight = measure.height;
      } else if (block.kind === "textBox" && measure.kind === "textBox") {
        blockHeight = measure.height;
      } else {
        continue;
      }
      if (advancesCursor) {
        const blockBottomY = cursorY + blockHeight;
        visualTop = Math.min(visualTop, cursorY);
        visualBottom = Math.max(visualBottom, blockBottomY);
        cursorY = blockBottomY;
      } else {
        // Floating table: expand visualBounds conservatively at the
        // current cursorY, since most floating HF tables anchor near
        // their source position. Exact (tblpX, tblpY)-resolved bounds
        // would require duplicating `resolveHeaderFooterFloatingTablePosition`
        // here; for tables anchored far from the in-flow stream the
        // bound undercounts. Without this, a floating-table-only
        // header would have `height = 0` and the table could be lost
        // from the body push-down calculation entirely.
        visualTop = Math.min(visualTop, cursorY);
        visualBottom = Math.max(visualBottom, cursorY + blockHeight);
      }
    }
  }

  return { visualTop, visualBottom };
}

// =============================================================================
// 4. HeaderFooter -> HeaderFooterContent (the public entry point)
// =============================================================================

export type ConvertHeaderFooterOptions = {
  styles?: StyleDefinitions | null;
  theme?: Theme | null;
  measureBlocks: MeasureBlocksFn;
};

/**
 * Convert HeaderFooter (document type) to HeaderFooterContent (render type).
 *
 * Routes through the same pipeline as the body: HF.content ->
 * headerFooterToProseDoc -> toFlowBlocks -> measureBlocks. The inline editor
 * uses the same conversion chain, so block support (paragraph, table, image,
 * textBox, fields) and the inline editor's content stay in lockstep.
 *
 * No result cache — typing in the body shouldn't recompute HF, but the
 * upstream cache keyed on `HeaderFooter` identity went stale after inline
 * edits. The HF pipeline runs at most four times per layout pass and the
 * paragraph-level measurement cache one layer down covers most of the work.
 */
export function convertHeaderFooterToContent(
  headerFooter: HeaderFooter | null | undefined,
  contentWidth: number,
  metrics: HeaderFooterMetrics,
  options: ConvertHeaderFooterOptions,
): HeaderFooterContent | undefined {
  if (
    !headerFooter ||
    !headerFooter.content ||
    headerFooter.content.length === 0
  ) {
    return undefined;
  }

  const proseDocOptions: { styles?: StyleDefinitions; theme?: Theme | null } =
    {};
  if (options.styles) {
    proseDocOptions.styles = options.styles;
  }
  if (options.theme !== undefined) {
    proseDocOptions.theme = options.theme;
  }
  const pmDoc = headerFooterToProseDoc(headerFooter.content, proseDocOptions);
  const flowOptions: { theme?: Theme | null } = {};
  if (options.theme !== undefined) {
    flowOptions.theme = options.theme;
  }
  const blocks = toFlowBlocks(pmDoc, flowOptions);
  if (blocks.length === 0) {
    return undefined;
  }

  const blocksForMeasure = normalizeHeaderFooterMeasureBlocks(blocks);
  const measures = options.measureBlocks(blocksForMeasure, contentWidth);
  let totalHeight = 0;
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i];
    const b = blocks[i];
    if (!m || !b) {
      continue;
    }
    if (m.kind === "paragraph") {
      totalHeight += m.totalHeight;
    } else if (m.kind === "table") {
      // Floating tables (`<w:tblpPr>`) anchor at (tblpX, tblpY) and don't
      // contribute to the in-flow height that drives body push-down.
      if (!(b.kind === "table" && b.floating)) {
        totalHeight += m.totalHeight;
      }
    } else if (m.kind === "image") {
      totalHeight += m.height;
    } else if (m.kind === "textBox") {
      totalHeight += m.height;
    }
  }
  const { visualTop, visualBottom } = calculateHeaderFooterVisualBounds(
    blocks,
    measures,
    totalHeight,
    metrics,
  );

  return {
    blocks,
    measures,
    height: totalHeight,
    visualTop,
    visualBottom,
  };
}

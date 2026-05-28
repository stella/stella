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

import type { Node as PMNode } from "prosemirror-model";

import type {
  FlowBlock,
  FloatingTablePosition,
  ImageRun,
  Measure,
  PageMargins,
  Run,
  TableBlock,
  TableMeasure,
} from "../layout-engine/types";
import type { HeaderFooterContent } from "../layout-painter/renderPage";
import { isFloatingImageRun } from "../layout-painter/renderUtils";
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
  if (run.kind !== "image") {
    return false;
  }
  // Match the renderer's classification: explicit `<wp:positionH>` /
  // `<wp:positionV>` OR `wrapType` / `displayMode` that the body's
  // `isFloatingImageRun` recognizes (square, tight, through, behind,
  // inFront, or `displayMode: "float"`). Without the second arm,
  // wrapped header images that omit explicit positioning would still
  // be measured as in-flow, inflating header height.
  if (run.position) {
    return true;
  }
  return isFloatingImageRun(run);
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
  return normalizeFlowBlockArray(blocks);
}

function normalizeFlowBlockArray(blocks: FlowBlock[]): FlowBlock[] {
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
    if (block.kind === "table") {
      return normalizeTableBlock(block);
    }
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

function normalizeTableBlock(block: TableBlock): TableBlock {
  const blockState = { changed: false };
  const rows = block.rows.map((row) => {
    const rowState = { changed: false };
    const cells = row.cells.map((cell) => {
      const normalizedBlocks = normalizeFlowBlockArray(cell.blocks);
      const cellChanged = normalizedBlocks.some(
        (normalizedBlock, idx) => normalizedBlock !== cell.blocks[idx],
      );
      if (!cellChanged) {
        return cell;
      }
      rowState.changed = true;
      return { ...cell, blocks: normalizedBlocks };
    });
    if (!rowState.changed) {
      return row;
    }
    blockState.changed = true;
    return { ...row, cells };
  });

  return blockState.changed ? { ...block, rows } : block;
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

function resolveHeaderFooterFloatingTableVisualTop(
  floating: FloatingTablePosition,
  measure: TableMeasure,
  sourceY: number,
  flowHeight: number,
  metrics: HeaderFooterMetrics,
): number {
  const flowTop =
    metrics.section === "header"
      ? (metrics.margins.header ?? 48)
      : metrics.pageSize.h - (metrics.margins.footer ?? 48) - flowHeight;
  const vertAnchor = floating.vertAnchor ?? "margin";
  const vertFrameHeight =
    vertAnchor === "page"
      ? metrics.pageSize.h
      : metrics.pageSize.h - metrics.margins.top - metrics.margins.bottom;
  const vertFrameOffset =
    vertAnchor === "page" ? -flowTop : metrics.margins.top - flowTop;

  if (floating.tblpYSpec === "top") {
    return vertFrameOffset;
  }
  if (floating.tblpYSpec === "bottom") {
    return vertFrameOffset + vertFrameHeight - measure.totalHeight;
  }
  if (floating.tblpYSpec === "center") {
    return vertFrameOffset + (vertFrameHeight - measure.totalHeight) / 2;
  }
  if (floating.tblpY !== undefined) {
    return vertFrameOffset + floating.tblpY;
  }

  return sourceY;
}

/**
 * Image is rendered "behind" body content (full-page letterhead, watermark).
 * The renderer lifts these out of the HF container to the page root, so they
 * must not push body margins down because they paint underneath the body.
 */
function isBehindDocImageRun(run: Run): boolean {
  return run.kind === "image" && run.wrapType === "behind";
}

function isBehindDocImageBlock(block: FlowBlock): boolean {
  return block.kind === "image" && block.anchor?.behindDoc === true;
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
        if (run.kind !== "image") {
          continue;
        }
        // Match the extraction/normalization classification: any image
        // floating by `position` OR by `wrapType`/`displayMode` is
        // rendered absolutely and stripped from paragraph measurement,
        // so its extent must be factored into the visual bounds. Without
        // this, a wrap-type-only header image would be visible but
        // `visualBottom` would still equal the stripped paragraph height,
        // and `computeHeaderFooterMarginExtender` wouldn't reserve enough
        // body push-down — the image would overlap body text.
        if (!run.position && !isFloatingImageRun(run)) {
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
      let blockHeight: number;
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
      } else if (
        block.kind === "table" &&
        block.floating &&
        measure.kind === "table"
      ) {
        const blockTop = resolveHeaderFooterFloatingTableVisualTop(
          block.floating,
          measure,
          cursorY,
          flowHeight,
          metrics,
        );
        visualTop = Math.min(visualTop, blockTop);
        visualBottom = Math.max(visualBottom, blockTop + blockHeight);
      }
    }
  }

  return { visualTop, visualBottom };
}

/**
 * Compute the header/footer bounds used by `computeHeaderFooterMarginExtender`
 * to push body margins clear of HF overflow. Excludes `behindDoc` images
 * (full-page letterheads, watermarks): the renderer lifts them out of the HF
 * container onto the page root and paints them behind body content, so they
 * must not reserve body push-down. Keeping them in `visualBottom` is still
 * correct for the renderer (and for the page-hash invalidation signal), but
 * the margin extender needs the flow-only extent.
 */
export function calculateHeaderFooterMarginPushBounds(
  blocks: FlowBlock[],
  measures: Measure[],
  flowHeight: number,
  metrics: HeaderFooterMetrics,
): { top: number; bottom: number } {
  let top = 0;
  let bottom = flowHeight;
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
      top = Math.min(top, paragraphStartY);
      bottom = Math.max(bottom, paragraphBottomY);

      for (const run of block.runs) {
        if (run.kind !== "image") {
          continue;
        }
        if (!run.position && !isFloatingImageRun(run)) {
          continue;
        }
        if (isBehindDocImageRun(run)) {
          continue;
        }
        const runTop = resolveHeaderFooterVisualTop(
          run,
          paragraphStartY,
          flowHeight,
          metrics,
        );
        top = Math.min(top, runTop);
        bottom = Math.max(bottom, runTop + run.height);
      }

      cursorY = paragraphBottomY;
    } else if (isBehindDocImageBlock(block)) {
      // ImageBlock with anchor.behindDoc: skip entirely for the same reason
      // as run-level behindDoc images. Does not advance cursorY because
      // anchored images don't participate in HF flow either.
      continue;
    } else {
      let blockHeight: number;
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
        top = Math.min(top, cursorY);
        bottom = Math.max(bottom, blockBottomY);
        cursorY = blockBottomY;
      } else if (
        block.kind === "table" &&
        block.floating &&
        measure.kind === "table"
      ) {
        const blockTop = resolveHeaderFooterFloatingTableVisualTop(
          block.floating,
          measure,
          cursorY,
          flowHeight,
          metrics,
        );
        top = Math.min(top, blockTop);
        bottom = Math.max(bottom, blockTop + blockHeight);
      }
    }
  }

  return { top, bottom };
}

// =============================================================================
// 4. HeaderFooter -> HeaderFooterContent (the public entry point)
// =============================================================================

export type ConvertHeaderFooterOptions = {
  styles?: StyleDefinitions | null;
  theme?: Theme | null;
  measureBlocks: MeasureBlocksFn;
  /** Document-wide `w:defaultTabStop` in twips — forwarded to toFlowBlocks. */
  defaultTabStopTwips?: number;
  /**
   * Relationship id of the source HF part. Stamped onto the returned
   * `HeaderFooterContent.rId` so the painter can emit `data-rid` on the
   * `.layout-page-header` / `.layout-page-footer` DOM node for the pointer
   * pipeline (`HiddenHeaderFooterPMs` + `findHfPmSpans`).
   */
  rId?: string;
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
  if (!headerFooter || headerFooter.content.length === 0) {
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
  const flowOptions: {
    theme?: Theme | null;
    defaultTabStopTwips?: number;
  } = {};
  if (options.theme !== undefined) {
    flowOptions.theme = options.theme;
  }
  if (options.defaultTabStopTwips !== undefined) {
    flowOptions.defaultTabStopTwips = options.defaultTabStopTwips;
  }
  const blocks = toFlowBlocks(pmDoc, flowOptions);
  return finalizeHeaderFooterContent(blocks, contentWidth, metrics, options);
}

// =============================================================================
// 5. PM doc source (persistent hidden HF EditorView path)
// =============================================================================

/**
 * Same as {@link convertHeaderFooterToContent}, but sourced from a live
 * ProseMirror document instead of `HeaderFooter.content`. Used by the
 * persistent hidden HF EditorView pipeline so the painter renders the PM's
 * current state (Word-style WYSIWYG: every keystroke repaints).
 *
 * The pmDoc is expected to be a body-shaped PM doc (the result of
 * `headerFooterToProseDoc` at mount, plus any user edits applied since).
 * Theme + styles do NOT need to be threaded again — they only matter for the
 * initial parse path; subsequent transformations are PM-internal.
 */
export function convertHeaderFooterPmDocToContent(
  pmDoc: PMNode | null | undefined,
  contentWidth: number,
  metrics: HeaderFooterMetrics,
  options: Omit<ConvertHeaderFooterOptions, "styles">,
): HeaderFooterContent | undefined {
  if (!pmDoc || pmDoc.content.size === 0) {
    return undefined;
  }
  const flowOptions: {
    theme?: Theme | null;
    defaultTabStopTwips?: number;
  } = {};
  if (options.theme !== undefined) {
    flowOptions.theme = options.theme;
  }
  if (options.defaultTabStopTwips !== undefined) {
    flowOptions.defaultTabStopTwips = options.defaultTabStopTwips;
  }
  const blocks = toFlowBlocks(pmDoc, flowOptions);
  return finalizeHeaderFooterContent(blocks, contentWidth, metrics, options);
}

// =============================================================================
// 6. Shared tail — blocks → HeaderFooterContent
// =============================================================================

function finalizeHeaderFooterContent(
  blocks: FlowBlock[],
  contentWidth: number,
  metrics: HeaderFooterMetrics,
  options: { measureBlocks: MeasureBlocksFn; rId?: string },
): HeaderFooterContent | undefined {
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
  const { top: marginPushTop, bottom: marginPushBottom } =
    calculateHeaderFooterMarginPushBounds(
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
    marginPushTop,
    marginPushBottom,
    textSig: computeHeaderFooterTextSig(blocks),
    ...(options.rId ? { rId: options.rId } : {}),
  };
}

/**
 * Cheap content fingerprint for the painter's incremental-render cache. The
 * default fields hashed by `computeOptionsHash` (block count + flow height +
 * visual bounds) miss same-height in-place edits — typing a replacement
 * character, toggling bold, etc. — so the painter's incremental path then
 * skips re-rendering page shells and the user's HF edits stay invisible
 * until something else triggers a full repaint (Codex #487 P1 follow-up:
 * 21:02 review; extended for run formatting + fields per 21:28 review).
 *
 * For each run carry text + every visual-affecting field: text characters,
 * field type (PAGE / NUMPAGES / DATE / TIME), and the full RunFormatting
 * record (bold, italic, color, underline, fontSize, font, etc.). Toggling
 * bold or inserting a PAGE field on existing same-height content now
 * differentiates the signature and forces a repaint. Tables, images, and
 * text boxes are summarised by kind + dims so resize / image swap also
 * invalidate. JSON.stringify is moderately expensive but folio HF is
 * bounded (a handful of paragraphs, max).
 */
function computeHeaderFooterTextSig(blocks: FlowBlock[]): string {
  return blocks.map(blockSig).join("|");
}

function blockSig(b: FlowBlock): string {
  if (b.kind === "paragraph") {
    // Carry paragraph-level formatting so same-height changes (alignment,
    // RTL/LTR, indent, line spacing, paragraph style, borders, shading,
    // list properties) still invalidate the cache. textSig was opening
    // every paragraph with a constant `p:` before, so the body PM could
    // toggle alignment / line spacing inside an HF paragraph without
    // shifting computeOptionsHash and the painter's incremental path
    // would skip the repaint (Codex #487 P2: 22:48 review).
    let text = `p:${serializeParagraphAttrs(b.attrs)}|`;
    for (const r of b.runs) {
      if (r.kind === "text") {
        text += `T:${r.text}|${serializeRunFmt(r)};`;
      } else if (r.kind === "tab") {
        text += `\\t|${serializeRunFmt(r)};`;
      } else if (r.kind === "lineBreak") {
        text += "\\n;";
      } else if (r.kind === "image") {
        // Include src + transform + wrapType so swapping the painted
        // image (different logo at the same dims) invalidates the
        // signature — width × height alone would let an unchanged
        // layout slip past the painter's incremental cache (Codex
        // #487 P2: 23:09 review).
        text +=
          `[i${r.width}x${r.height}|${r.src}|` +
          `${r.transform ?? ""}|${r.wrapType ?? ""}];`;
      } else {
        // field run
        text += `F:${r.fieldType}|${serializeRunFmt(r)};`;
      }
    }
    return text;
  }
  if (b.kind === "table") {
    // Recurse into cells — same-height text / formatting / field edits
    // inside an existing HF table cell are otherwise invisible to the
    // painter's incremental cache (Codex #487 P2: 21:41 review). Row
    // count + per-cell block signatures detect every visible change a
    // user can produce without growing the table.
    const cellParts: string[] = [];
    for (const row of b.rows) {
      for (const cell of row.cells) {
        cellParts.push(cell.blocks.map(blockSig).join(","));
      }
    }
    return `t:${b.rows.length}:${cellParts.join("|")}`;
  }
  if (b.kind === "image") {
    return (
      `i:${b.width}x${b.height}|${b.src}|` +
      `${b.transform ?? ""}|${b.anchor?.behindDoc ? "behind" : ""}`
    );
  }
  if (b.kind === "textBox") {
    // Text boxes can carry their own content (paragraph + runs). Recurse
    // when the layout-engine TextBoxBlock surfaces nested blocks; for
    // shapes that only carry dims we keep the original bare tag.
    const inner = (b as { blocks?: FlowBlock[] }).blocks;
    if (Array.isArray(inner) && inner.length > 0) {
      return `tb:${inner.map(blockSig).join(",")}`;
    }
    return "tb";
  }
  return "";
}

function serializeParagraphAttrs(
  attrs: Record<string, unknown> | undefined,
): string {
  if (!attrs) {
    return "";
  }
  const keys = [
    "alignment",
    "bidi",
    "indent",
    "spacing",
    "styleId",
    "borders",
    "shading",
    "contextualSpacing",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "numPr",
    "listMarker",
    "listIsBullet",
    "listMarkerHidden",
    "listMarkerSuffix",
    "tabs",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return JSON.stringify(out);
}

/**
 * Serialise the RunFormatting fields that actually drive the painter's
 * visual output. The Run type spreads RunFormatting in place, so we project
 * a small shape and JSON-stringify it; properties that are undefined are
 * skipped so the resulting string stays compact for unstyled runs.
 */
function serializeRunFmt(run: Record<string, unknown>): string {
  const keys = [
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "color",
    "highlightColor",
    "fontSize",
    "fontFamily",
    "verticalAlign",
    "letterSpacing",
    "smallCaps",
    "allCaps",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = run[k];
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return JSON.stringify(out);
}

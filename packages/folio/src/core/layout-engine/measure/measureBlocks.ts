import { recordMeasureBlock } from "../layoutInstrumentation";
import {
  bandTopContentY,
  floatingTextBoxReservesBand,
  isPageFrameRelativeAnchor,
} from "../textBoxFlow";
import { DEFAULT_TEXTBOX_MARGINS } from "../types";
import type {
  FlowBlock,
  ImageBlock,
  ImageRun,
  Measure,
  ParagraphBlock,
  ParagraphMeasure,
  TableBlock,
  TableCell,
  TableCellMeasure,
  TableMeasure,
  TextBoxBlock,
  TextBoxMeasure,
} from "../types";
import { getCachedParagraphMeasure, setCachedParagraphMeasure } from "./cache";
import {
  findClearLineY,
  measureParagraph,
  MIN_WRAP_SEGMENT_WIDTH,
} from "./measureParagraph";
import type { FloatingImageZone } from "./measureParagraph";

/**
 * Pseudo-infinite measurement width (px) used for `w:noWrap` table cells so
 * the paragraph line breaker never inserts a soft break. Large enough to
 * exceed any realistic single Word line; small enough to stay well clear of
 * floating-point precision concerns when summed downstream.
 */
const NO_WRAP_MEASURE_WIDTH = 1_000_000;

/**
 * Check if an image run is a *text-wrapping* floating image — it
 * occupies an exclusion zone the body text should flow around.
 *
 * `wrapType: "behind"` and `wrapType: "inFront"` are anchored
 * (out-of-flow) but Word's wrapNone semantics put them behind /
 * over the text without shrinking the body. They render as
 * `displayMode: "float"` in the prose model so the painter knows
 * they're out of normal flow, but `extractFloatingZones` must skip
 * them — including them here would make the line breaker wrap text
 * around a background letterhead or a foreground overlay (Codex
 * PR #258 review).
 */
function isFloatingImageRun(run: ImageRun): boolean {
  const wrapType = run.wrapType;
  const displayMode = run.displayMode;

  // wrapNone (behind / inFront): never an exclusion zone, regardless
  // of displayMode.
  if (wrapType === "behind" || wrapType === "inFront") {
    return false;
  }

  // Floating images have specific wrap types that allow text to flow around them
  if (wrapType && ["square", "tight", "through"].includes(wrapType)) {
    return true;
  }

  // Or explicit float display mode (only when no wrapNone semantics —
  // already filtered above).
  if (displayMode === "float") {
    return true;
  }

  return false;
}

/**
 * EMU to pixels conversion
 */
function emuToPixels(emu: number | undefined): number {
  if (emu === undefined) {
    return 0;
  }
  return Math.round((emu * 96) / 914_400);
}

function resolveTableWidthPx(
  width: number | undefined,
  widthType: string | undefined,
  contentWidth: number,
): number | undefined {
  if (!width) {
    return undefined;
  }
  if (widthType === "pct") {
    // width is in 50ths of a percent (5000 = 100%)
    return (contentWidth * width) / 5000;
  }
  if (widthType === "dxa" || !widthType || widthType === "auto") {
    return Math.round((width / 20) * 1.333);
  }
  return undefined;
}

function isInlineFlowImageRun(run: ImageRun): boolean {
  if (run.displayMode === "float") {
    return false;
  }

  if (
    run.wrapType === "square" ||
    run.wrapType === "tight" ||
    run.wrapType === "through" ||
    run.wrapType === "behind" ||
    run.wrapType === "inFront"
  ) {
    return false;
  }

  if (run.displayMode === "block" || run.wrapType === "topAndBottom") {
    return false;
  }

  return true;
}

export function measureTableCellBlockVisualHeight(
  block: FlowBlock,
  blockMeasure: Measure,
): number {
  if (block.kind !== "paragraph" || blockMeasure.kind !== "paragraph") {
    if ("totalHeight" in blockMeasure) {
      return blockMeasure.totalHeight;
    }
    if ("height" in blockMeasure) {
      return blockMeasure.height;
    }
    return 0;
  }

  const paragraphBlock = block;
  const paragraphMeasure = blockMeasure;
  const nonEmptyRuns = paragraphBlock.runs.filter(
    (run) =>
      run.kind !== "text" ||
      run.text.replace(/\u00a0/gu, " ").trim().length > 0,
  );
  if (paragraphMeasure.lines.length !== 1 || nonEmptyRuns.length === 0) {
    return paragraphMeasure.totalHeight;
  }

  const inlineImageRuns: ImageRun[] = [];
  for (const run of nonEmptyRuns) {
    if (run.kind !== "image" || !isInlineFlowImageRun(run)) {
      return paragraphMeasure.totalHeight;
    }
    inlineImageRuns.push(run);
  }

  let maxImageHeight = 0;
  for (const run of inlineImageRuns) {
    maxImageHeight = Math.max(maxImageHeight, run.height);
  }
  const spacingBefore = paragraphBlock.attrs?.spacing?.before ?? 0;
  const spacingAfter = paragraphBlock.attrs?.spacing?.after ?? 0;

  return spacingBefore + maxImageHeight + spacingAfter;
}

function getTableCellVerticalBorderHeight(cell: TableCell | undefined): number {
  const top = cell?.borders?.top?.width ?? 0;
  const bottom = cell?.borders?.bottom?.width ?? 0;
  return top + bottom;
}

export function measureTableBlock(
  tableBlock: TableBlock,
  contentWidth: number,
): TableMeasure {
  const DEFAULT_CELL_PADDING_X = 7; // Word default: 108 twips ≈ 7px
  const DEFAULT_CELL_PADDING_Y = 0; // OOXML/TableNormal default: top=0, bottom=0

  // columnWidths are already in pixels (converted in toFlowBlocks)
  let columnWidths = tableBlock.columnWidths ?? [];
  const explicitWidthPx = resolveTableWidthPx(
    tableBlock.width,
    tableBlock.widthType,
    contentWidth,
  );

  if (columnWidths.length === 0 && tableBlock.rows.length > 0) {
    // Determine total columns from first row's colSpans
    const colCount = tableBlock.rows[0]!.cells.reduce(
      // SAFETY: rows.length > 0
      (sum, cell) => sum + (cell.colSpan ?? 1),
      0,
    );
    const totalWidth = explicitWidthPx ?? contentWidth;
    const equalWidth = totalWidth / Math.max(1, colCount);
    columnWidths = Array.from({ length: colCount }, () => equalWidth);
  } else if (columnWidths.length > 0 && explicitWidthPx) {
    const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);
    if (totalWidth > 0 && Math.abs(totalWidth - explicitWidthPx) > 1) {
      const scale = explicitWidthPx / totalWidth;
      columnWidths = columnWidths.map((w) => w * scale);
    }
  }

  // Build a map of columns occupied by spanning cells from previous rows.
  // Without this, cells in rows with vertical merges get the wrong column width.
  const occupiedColumnsPerRow = new Map<number, Set<number>>();
  for (let rowIdx = 0; rowIdx < tableBlock.rows.length; rowIdx++) {
    const row = tableBlock.rows[rowIdx];
    if (!row) {
      continue;
    }
    let colIdx = 0;
    const occupied = occupiedColumnsPerRow.get(rowIdx) ?? new Set<number>();
    while (occupied.has(colIdx)) {
      colIdx++;
    }

    for (const cell of row.cells) {
      const colSpan = cell.colSpan ?? 1;
      const rowSpan = cell.rowSpan ?? 1;

      if (rowSpan > 1) {
        for (let r = rowIdx + 1; r < rowIdx + rowSpan; r++) {
          if (!occupiedColumnsPerRow.has(r)) {
            occupiedColumnsPerRow.set(r, new Set());
          }
          const occSet = occupiedColumnsPerRow.get(r)!;
          for (let c = 0; c < colSpan; c++) {
            occSet.add(colIdx + c);
          }
        }
      }

      colIdx += colSpan;
      while (occupied.has(colIdx)) {
        colIdx++;
      }
    }
  }

  // Calculate cell widths based on colSpan and columnWidths,
  // skipping columns occupied by spanning cells from previous rows.
  const rows = tableBlock.rows.map((row, rowIdx) => {
    let columnIndex = 0;
    const occupied = occupiedColumnsPerRow.get(rowIdx) ?? new Set<number>();
    while (occupied.has(columnIndex)) {
      columnIndex++;
    }

    return {
      cells: row.cells.map((cell) => {
        const colSpan = cell.colSpan ?? 1;
        // Calculate cell width as sum of spanned columns
        let cellWidth = 0;
        for (
          let c = 0;
          c < colSpan && columnIndex + c < columnWidths.length;
          c++
        ) {
          cellWidth += columnWidths[columnIndex + c] ?? 0;
        }
        // Fallback to cell.width or default if columnWidths not available
        if (cellWidth === 0) {
          cellWidth = cell.width ?? 100;
        }
        columnIndex += colSpan;
        while (occupied.has(columnIndex)) {
          columnIndex++;
        }

        const padLeft = cell.padding?.left ?? DEFAULT_CELL_PADDING_X;
        const padRight = cell.padding?.right ?? DEFAULT_CELL_PADDING_X;
        const cellContentWidth = Math.max(1, cellWidth - padLeft - padRight);
        // `w:noWrap` (§17.4.30): measure cell paragraphs against an effectively
        // unbounded width so the line breaker never splits a single Word line
        // into multiple MeasuredLines. The painter still constrains the cell
        // box to `cellWidth`; `white-space: nowrap` keeps inline content on
        // one line, and `overflow-x` lets it extend past the column. Without
        // this, `renderTable.ts`'s nowrap style only prevents inline wrapping
        // and the precomputed line splits would still render as stacked rows.
        const measureWidth = cell.noWrap
          ? NO_WRAP_MEASURE_WIDTH
          : cellContentWidth;
        const cellMeasure: TableCellMeasure = {
          blocks: cell.blocks.map((b) => measureBlock(b, measureWidth)),
          width: cellWidth,
          height: 0, // Calculated below
        };
        if (cell.colSpan !== undefined) {
          cellMeasure.colSpan = cell.colSpan;
        }
        if (cell.rowSpan !== undefined) {
          cellMeasure.rowSpan = cell.rowSpan;
        }
        return cellMeasure;
      }),
      height: 0,
    };
  });

  // Calculate cell heights, respecting explicit row height rules
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!; // SAFETY: rowIdx < rows.length
    const sourceRowCells = tableBlock.rows[rowIdx]?.cells;
    let maxHeight = 0;
    let maxVerticalBorderHeight = 0;
    for (let cellIdx = 0; cellIdx < row.cells.length; cellIdx++) {
      const cell = row.cells[cellIdx]!; // SAFETY: cellIdx < row.cells.length
      const sourceCell = sourceRowCells?.[cellIdx];
      cell.height = 0;
      for (let blockIdx = 0; blockIdx < cell.blocks.length; blockIdx++) {
        const sourceBlock = sourceCell?.blocks[blockIdx];
        const blockMeasure = cell.blocks[blockIdx];
        if (!sourceBlock || !blockMeasure) {
          continue;
        }
        cell.height += measureTableCellBlockVisualHeight(
          sourceBlock,
          blockMeasure,
        );
      }
      const padTop = sourceCell?.padding?.top ?? DEFAULT_CELL_PADDING_Y;
      const padBottom = sourceCell?.padding?.bottom ?? DEFAULT_CELL_PADDING_Y;
      cell.height += padTop + padBottom;
      maxHeight = Math.max(maxHeight, cell.height);
      maxVerticalBorderHeight = Math.max(
        maxVerticalBorderHeight,
        getTableCellVerticalBorderHeight(sourceCell),
      );
    }

    // Apply heightRule from the source row
    const sourceRow = tableBlock.rows[rowIdx];
    const explicitHeight = sourceRow?.height;
    const heightRule = sourceRow?.heightRule;

    if (explicitHeight && heightRule === "exact") {
      row.height = explicitHeight;
    } else if (explicitHeight) {
      // Both 'atLeast' and 'auto' (OOXML default) treat the value as minimum height.
      // ECMA-376 §17.4.81: when hRule is absent or "auto", val is the minimum row height.
      row.height = Math.max(
        maxHeight + maxVerticalBorderHeight,
        explicitHeight,
      );
    } else {
      // No explicit height — use content height directly.
      row.height = maxHeight + maxVerticalBorderHeight;
    }
  }

  const totalHeight = rows.reduce((h, r) => h + r.height, 0);
  const totalWidth =
    columnWidths.reduce((w, cw) => w + cw, 0) ||
    explicitWidthPx ||
    contentWidth;

  return {
    kind: "table",
    rows,
    columnWidths,
    totalWidth,
    totalHeight,
  };
}

/**
 * Extract floating image exclusion zones from all blocks.
 * Called before measurement to determine line width reductions.
 *
 * For images with vertical align="top" relative to margin, they're at Y=0.
 * The exclusion zones define the areas where text lines need reduced widths.
 */
/**
 * Extended floating zone info that includes anchor block index
 */
type FloatingZoneWithAnchor = {
  /** Block index where this floating image is anchored */
  anchorBlockIndex: number;
  /** If true, zone is positioned relative to margin/page and applies to all blocks */
  isMarginRelative?: boolean;
} & FloatingImageZone;

function perBlockNumberValue(
  value: number | number[],
  blockIndex: number,
  fallback: number,
): number {
  if (Array.isArray(value)) {
    return value[blockIndex] ?? fallback;
  }
  return value;
}

// Page geometry the band extraction needs to resolve page/margin-pinned
// topAndBottom anchors (bottom-strip frames, centered/bottom align). Per-block
// because sections can vary page size and margins. eigenpal #694.
type BandPageGeometry = {
  pageHeight: number | number[];
  marginBottom: number | number[];
};

function extractFloatingZones(
  blocks: FlowBlock[],
  contentWidth: number,
  marginTop: number | number[] = 0,
  pageGeometry?: BandPageGeometry,
): FloatingZoneWithAnchor[] {
  const zones: FloatingZoneWithAnchor[] = [];
  const defaultMarginTop = Array.isArray(marginTop)
    ? (marginTop[0] ?? 0)
    : marginTop;
  const pageHeightInput = pageGeometry?.pageHeight ?? 0;
  const marginBottomInput = pageGeometry?.marginBottom ?? 0;
  const defaultPageHeight = Array.isArray(pageHeightInput)
    ? (pageHeightInput[0] ?? 0)
    : pageHeightInput;
  const defaultMarginBottom = Array.isArray(marginBottomInput)
    ? (marginBottomInput[0] ?? 0)
    : marginBottomInput;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!; // SAFETY: blockIndex < blocks.length
    if (block.kind !== "paragraph") {
      continue;
    }

    const paragraphBlock = block as ParagraphBlock;

    for (const run of paragraphBlock.runs) {
      if (run.kind !== "image") {
        continue;
      }
      const imgRun = run as ImageRun;

      if (!isFloatingImageRun(imgRun)) {
        continue;
      }

      // Calculate Y position based on vertical alignment
      let topY = 0;
      const position = imgRun.position;
      const distTop = imgRun.distTop ?? 0;
      const distBottom = imgRun.distBottom ?? 0;
      const distLeft = imgRun.distLeft ?? 12;
      const distRight = imgRun.distRight ?? 12;

      if (position?.vertical) {
        const v = position.vertical;
        if (v.align === "top" && v.relativeTo === "margin") {
          // Image at top of content area
          topY = 0;
        } else if (v.posOffset !== undefined) {
          topY = emuToPixels(v.posOffset);
        }
        // Other cases (paragraph-relative) are harder to handle without knowing paragraph positions
      }

      const bottomY = topY + imgRun.height;

      // Calculate margins based on horizontal position
      let leftMargin = 0;
      let rightMargin = 0;

      if (position?.horizontal) {
        const h = position.horizontal;
        if (h.align === "left") {
          // Image on left - text needs left margin
          leftMargin = imgRun.width + distRight;
        } else if (h.align === "right") {
          // Image on right - text needs right margin
          rightMargin = imgRun.width + distLeft;
        } else if (h.posOffset !== undefined) {
          const x = emuToPixels(h.posOffset);
          if (x < contentWidth / 2) {
            leftMargin = x + imgRun.width + distRight;
          } else {
            rightMargin = contentWidth - x + distLeft;
          }
        }
      } else if (imgRun.cssFloat === "left") {
        leftMargin = imgRun.width + distRight;
      } else if (imgRun.cssFloat === "right") {
        rightMargin = imgRun.width + distLeft;
      }

      if (leftMargin > 0 || rightMargin > 0) {
        // Images positioned relative to margin/page apply globally (before their anchor paragraph)
        const isMarginRelative =
          position?.vertical?.relativeTo === "margin" ||
          position?.vertical?.relativeTo === "page";
        zones.push({
          leftMargin,
          rightMargin,
          topY: topY - distTop,
          bottomY: bottomY + distBottom,
          anchorBlockIndex: blockIndex,
          isMarginRelative,
        });
      }
    }
  }

  // Floating tables (block-level) - treat them as exclusion zones for subsequent text
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!; // SAFETY: blockIndex < blocks.length
    if (block.kind !== "table") {
      continue;
    }

    const tableBlock = block as TableBlock;
    const floating = tableBlock.floating;
    if (!floating) {
      continue;
    }

    const tableMeasure = measureTableBlock(tableBlock, contentWidth);
    const tableWidth = tableMeasure.totalWidth;
    const tableHeight = tableMeasure.totalHeight;

    const distLeft = floating.leftFromText ?? 12;
    const distRight = floating.rightFromText ?? 12;
    const distTop = floating.topFromText ?? 0;
    const distBottom = floating.bottomFromText ?? 0;

    let leftMargin = 0;
    let rightMargin = 0;

    // Determine horizontal position relative to content area
    let x = 0;
    if (floating.tblpX !== undefined) {
      x = floating.tblpX;
    } else if (floating.tblpXSpec) {
      if (floating.tblpXSpec === "left" || floating.tblpXSpec === "inside") {
        x = 0;
      } else if (
        floating.tblpXSpec === "right" ||
        floating.tblpXSpec === "outside"
      ) {
        x = contentWidth - tableWidth;
      } else {
        x = (contentWidth - tableWidth) / 2;
      }
    } else if (tableBlock.justification === "center") {
      x = (contentWidth - tableWidth) / 2;
    } else if (tableBlock.justification === "right") {
      x = contentWidth - tableWidth;
    }

    if (x < contentWidth / 2) {
      leftMargin = x + tableWidth + distRight;
    } else {
      rightMargin = contentWidth - x + distLeft;
    }

    const topY = floating.tblpY ?? 0;
    const bottomY = topY + tableHeight;

    zones.push({
      leftMargin,
      rightMargin,
      topY: topY - distTop,
      bottomY: bottomY + distBottom,
      anchorBlockIndex: blockIndex,
    });
  }

  // Page/margin-anchored topAndBottom text boxes (e.g. a banner pinned to the
  // page top) reserve a full-width band so body text flows above and below the
  // box instead of the box dropping into the flow at its anchor paragraph.
  // Paragraph-anchored topAndBottom boxes keep folio's in-flow handling (they
  // already render on their own line at the anchor). eigenpal docx-editor #694.
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]!; // SAFETY: blockIndex < blocks.length
    if (block.kind !== "textBox") {
      continue;
    }
    const tb = block as TextBoxBlock;
    if (!floatingTextBoxReservesBand(tb)) {
      continue;
    }
    const v = tb.position?.vertical;
    if (!isPageFrameRelativeAnchor(v?.relativeTo)) {
      continue;
    }

    const height = measureTextBoxBlock(tb).height;
    const distTop = tb.distTop ?? 0;
    const distBottom = tb.distBottom ?? 0;
    const blockMarginTop = perBlockNumberValue(
      marginTop,
      blockIndex,
      defaultMarginTop,
    );
    // Shared with layoutTextBox so the reserved band and the painted box agree.
    const rawTop = bandTopContentY(v, {
      pageHeight: perBlockNumberValue(
        pageHeightInput,
        blockIndex,
        defaultPageHeight,
      ),
      marginTop: blockMarginTop,
      marginBottom: perBlockNumberValue(
        marginBottomInput,
        blockIndex,
        defaultMarginBottom,
      ),
      boxHeight: height,
    });
    const bottomY = rawTop + height + distBottom;
    if (bottomY <= 0) {
      continue;
    }
    zones.push({
      leftMargin: 0,
      rightMargin: 0,
      topY: Math.max(0, rawTop - distTop),
      bottomY,
      anchorBlockIndex: blockIndex,
      isMarginRelative: true,
      fullWidthBlock: true,
    });
  }

  return zones;
}

/**
 * Measure a block based on its type.
 */
export function measureBlock(
  block: FlowBlock,
  contentWidth: number,
  floatingZones?: FloatingImageZone[],
  cumulativeY?: number,
): Measure {
  switch (block.kind) {
    case "paragraph": {
      const pBlock = block as ParagraphBlock;

      // Cache paragraph measurements when no floating zones affect this block.
      // Safe because without floating zones the result depends only on content
      // and contentWidth (both captured in the cache key). When floating zones
      // ARE present, we always measure fresh since zones depend on inter-block
      // layout context (cumulative Y, neighboring floating tables/images).
      if (!floatingZones || floatingZones.length === 0) {
        const cached = getCachedParagraphMeasure(pBlock, contentWidth);
        if (cached) {
          return cached;
        }
      }

      const measureOpts: Parameters<typeof measureParagraph>[2] = {
        paragraphYOffset: cumulativeY ?? 0,
      };
      if (floatingZones) {
        measureOpts.floatingZones = floatingZones;
      }
      const result = measureParagraph(pBlock, contentWidth, measureOpts);

      if (!floatingZones || floatingZones.length === 0) {
        setCachedParagraphMeasure(pBlock, contentWidth, result);
      }

      return result;
    }

    case "table": {
      return measureTableBlock(block as TableBlock, contentWidth);
    }

    case "image": {
      const imageBlock = block as ImageBlock;
      return {
        kind: "image",
        width: imageBlock.width,
        height: imageBlock.height,
      };
    }

    case "textBox": {
      return measureTextBoxBlock(block as TextBoxBlock);
    }

    case "pageBreak":
      return { kind: "pageBreak" };

    case "columnBreak":
      return { kind: "columnBreak" };

    case "sectionBreak":
      return { kind: "sectionBreak" };

    default:
      // Unknown block type - return empty paragraph measure
      return {
        kind: "paragraph",
        lines: [],
        totalHeight: 0,
      };
  }
}

export function measureTextBoxBlock(tb: TextBoxBlock): TextBoxMeasure {
  const margins = tb.margins ?? DEFAULT_TEXTBOX_MARGINS;
  const innerWidth = tb.width - margins.left - margins.right;
  const innerMeasures = tb.content.map((p) => measureParagraph(p, innerWidth));
  const contentHeight = innerMeasures.reduce(
    (sum, m) => sum + m.totalHeight,
    0,
  );
  const totalHeight = tb.height ?? contentHeight + margins.top + margins.bottom;
  return {
    kind: "textBox",
    width: tb.width,
    height: totalHeight,
    innerMeasures,
  };
}

/**
 * `true` for a section break that starts a new page (`nextPage`/`evenPage`/
 * `oddPage`, or an unspecified type, which the layout treats as `nextPage`).
 * A `continuous` break stays on the current page, so it does not open a fresh
 * page frame. Used by `measureBlocks` to reset the running Y for a page-pinned
 * band that lands right after the break. eigenpal #694.
 */
function isNextPageSectionBreak(block: FlowBlock): boolean {
  return block.kind === "sectionBreak" && block.type !== "continuous";
}

/**
 * Measure all blocks with floating image support.
 *
 * Pre-scans all blocks to find floating images and creates exclusion zones.
 * Then measures each block, passing the zones so paragraphs can calculate
 * per-line widths based on vertical overlap with floating images.
 */
export function measureBlocks(
  blocks: FlowBlock[],
  contentWidth: number | number[],
  marginTop: number | number[] = 0,
  pageGeometry?: BandPageGeometry,
): Measure[] {
  const defaultWidth = Array.isArray(contentWidth)
    ? (contentWidth[0] ?? 0)
    : contentWidth;
  // Pre-extract floating image exclusion zones with anchor block indices
  const floatingZonesWithAnchors = extractFloatingZones(
    blocks,
    defaultWidth,
    marginTop,
    pageGeometry,
  );

  // Margin-relative zones (positioned relative to page/margin) on the same vertical
  // position are likely on the same page. Group them and activate all from the earliest
  // anchor so text wraps around ALL images from the first paragraph onward.
  // e.g. left-aligned and right-aligned images at margin top should both affect text
  // starting from the first anchor paragraph, not just the one containing each image.
  // Full-width topAndBottom bands are excluded: each pins to its own text box, so a
  // second band sharing the same topY (e.g. body banners in different sections) must
  // not be rewritten to the earliest anchor, or earlier pages would reserve a band
  // that is painted elsewhere. They keep their own anchor below. eigenpal #694.
  const marginRelative = floatingZonesWithAnchors.filter(
    (z) => z.isMarginRelative && !z.fullWidthBlock,
  );
  const ownAnchorZones = floatingZonesWithAnchors.filter(
    (z) => !z.isMarginRelative || z.fullWidthBlock,
  );

  // Group margin-relative zones by topY and move all to earliest anchor in group
  const marginByTopY = new Map<number, FloatingZoneWithAnchor[]>();
  for (const z of marginRelative) {
    const group = marginByTopY.get(z.topY) ?? [];
    group.push(z);
    marginByTopY.set(z.topY, group);
  }

  const adjustedZones: FloatingZoneWithAnchor[] = [...ownAnchorZones];
  for (const group of marginByTopY.values()) {
    const minAnchor = Math.min(...group.map((z) => z.anchorBlockIndex));
    for (const z of group) {
      adjustedZones.push({ ...z, anchorBlockIndex: minAnchor });
    }
  }

  // Group zones by effective anchor block index
  const zonesByAnchor = new Map<number, FloatingImageZone[]>();
  for (const z of adjustedZones) {
    const existing = zonesByAnchor.get(z.anchorBlockIndex) ?? [];
    // Strip the anchor-tracking fields; the rest IS a FloatingImageZone. Spread
    // (rather than copying each field) so fullWidthBlock/segments can't be
    // dropped here.
    const {
      anchorBlockIndex: _anchorBlockIndex,
      isMarginRelative: _isMarginRelative,
      ...zone
    } = z;
    existing.push(zone);
    zonesByAnchor.set(z.anchorBlockIndex, existing);
  }

  const anchorIndices = new Set(zonesByAnchor.keys());

  // Two running Y cursors for floating-zone overlap:
  //  - cumulativeY resets to 0 at each floating-image/table anchor, giving that
  //    object a local frame for its side-wrap zone.
  //  - pageRelativeY is the real page cursor; it resets only at hard page breaks
  //    (never at a float anchor), so a page-pinned topAndBottom band always
  //    measures from a true page-relative position even when a float was
  //    anchored earlier on the same page. eigenpal #694.
  let cumulativeY = 0;
  let pageRelativeY = 0;
  let activeZones: FloatingImageZone[] = [];

  return blocks.map((block, blockIndex) => {
    recordMeasureBlock(blockIndex, block);

    // A hard page/section break starts a fresh page. Any active zone — including
    // a page-pinned topAndBottom band — belongs to the page it was anchored on,
    // so drop the active zones and restart both cursors at the new page top. A
    // band anchor on the new page re-establishes its own zone below; without
    // this, the first block after the break would be measured against a stale
    // band (a phantom float-skip) while layout paints no band there, opening a
    // gap. eigenpal #694.
    if (block.kind === "pageBreak" || isNextPageSectionBreak(block)) {
      activeZones = [];
      cumulativeY = 0;
      pageRelativeY = 0;
    }

    // Check if this block is an anchor for floating images
    // If so, replace active zones (old zones from previous anchors are invalid
    // after a Y reset since their topY/bottomY are in the old coordinate system).
    if (anchorIndices.has(blockIndex)) {
      activeZones = zonesByAnchor.get(blockIndex) ?? [];
      // Floating-image anchors open a fresh local frame (cumulativeY → 0). A
      // page/margin-pinned band instead reserves against the page, so it
      // measures from pageRelativeY — the real page cursor, which a prior float
      // anchor has not reset. This is a no-op when no float precedes the band on
      // the page (the two cursors agree) and 0 right after a hard break, so the
      // band still reserves from the real cursor down rather than re-reserving
      // the whole band over content that already precedes its anchor. eigenpal #694.
      const bandOnlyAnchor =
        activeZones.length > 0 && activeZones.every((z) => z.fullWidthBlock);
      cumulativeY = bandOnlyAnchor ? pageRelativeY : 0;
    }

    const zones = activeZones.length > 0 ? activeZones : undefined;

    try {
      const blockWidth = Array.isArray(contentWidth)
        ? (contentWidth[blockIndex] ?? defaultWidth)
        : contentWidth;
      const measure = measureBlock(block, blockWidth, zones, cumulativeY);

      // Paragraphs clear a full-width band internally (findClearLineY inside
      // measureParagraph). An in-flow table or inline image does not, so reserve
      // a leading skip here that layout applies before the block, pushing it
      // below the band rather than under it. eigenpal #694.
      const bandZones = zones?.filter((zone) => zone.fullWidthBlock);
      if (
        bandZones?.length &&
        (measure.kind === "image" ||
          (measure.kind === "table" && !(block as TableBlock).floating))
      ) {
        const blockHeight =
          measure.kind === "image" ? measure.height : measure.totalHeight;
        const skip =
          findClearLineY(
            cumulativeY,
            blockHeight,
            bandZones,
            blockWidth,
            MIN_WRAP_SEGMENT_WIDTH,
          ) - cumulativeY;
        if (skip > 0) {
          measure.bandSkipBefore = skip;
          cumulativeY += skip;
          pageRelativeY += skip;
        }
      }

      // Advance both cursors for the next block.
      if (
        "totalHeight" in measure &&
        !(block.kind === "table" && (block as TableBlock).floating)
      ) {
        cumulativeY += measure.totalHeight;
        pageRelativeY += measure.totalHeight;
      }

      return measure;
    } catch {
      // Return a minimal real measure so layout doesn't crash; the original
      // measureBlock failure is swallowed here (downstream layout treats this
      // as a single-line paragraph of fixed height).
      const fallback: ParagraphMeasure = {
        kind: "paragraph",
        lines: [],
        totalHeight: 20,
      };
      return fallback;
    }
  });
}

export function measureSingleBlockWithoutFloatingZones(
  block: FlowBlock,
  blockWidth: number,
  blockIndex: number,
): Measure {
  recordMeasureBlock(blockIndex, block);
  return measureBlock(block, blockWidth);
}

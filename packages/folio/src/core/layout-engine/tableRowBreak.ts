/**
 * Table row-break geometry. Ported from eigenpal/docx-editor#698 (folio subset).
 *
 * Word lets a table row break across a page boundary ("allow row to break
 * across pages", on by default). When a row is taller than a whole page it
 * cannot fit anywhere, so the portion that fits stays and the rest continues on
 * the next page — broken between whole text lines, never through a glyph.
 * Without this folio forced the oversized row onto one page and the overflow
 * was clipped (content lost; upstream #570).
 *
 * This computes, per row, the safe break offsets (the y of every line bottom in
 * the row's cells) so the paginator can snap a break to the deepest whole line
 * that still fits. Vertically-merged cells that span into a row are not modeled
 * here yet (a separate follow-up); each row uses its own cells' content.
 */

import { measureParagraph } from "./measure";
import {
  buildTableCellFloatingZones,
  getTableCellContentWidth,
  getTableCellFloatingImages,
} from "./measure/tableCellFloating";
import type {
  Measure,
  TableBlock,
  TableCell,
  TableCellMeasure,
  TableMeasure,
} from "./types";

type UnsafeBreakRange = {
  top: number;
  bottom: number;
};

type CellBreakGeometry = {
  bottoms: number[];
  unsafeRanges: UnsafeBreakRange[];
};

const DEFAULT_TABLE_CELL_PADDING_TOP = 1;

function getAtomicBlockHeight(measure: Measure): number {
  if ("totalHeight" in measure) {
    return measure.totalHeight;
  }
  if ("height" in measure) {
    return measure.height;
  }
  return 0;
}

function isInsideRange(offset: number, range: UnsafeBreakRange): boolean {
  return offset > range.top && offset < range.bottom;
}

function getVerticalAlignmentOffset(
  cell: TableCell | undefined,
  measure: TableCellMeasure,
  rowHeight: number,
): number {
  const spareHeight = Math.max(0, rowHeight - measure.height);
  if (cell?.verticalAlign === "bottom") {
    return spareHeight;
  }
  if (cell?.verticalAlign === "center") {
    return spareHeight / 2;
  }
  return 0;
}

function shiftCellGeometry(
  geometry: CellBreakGeometry,
  offset: number,
): CellBreakGeometry {
  if (offset <= 0) {
    return geometry;
  }
  return {
    bottoms: geometry.bottoms.map((bottom) => bottom + offset),
    unsafeRanges: geometry.unsafeRanges.map((range) => ({
      top: range.top + offset,
      bottom: range.bottom + offset,
    })),
  };
}

/** Cumulative break geometry within a single cell's content. */
function cellBreakGeometry(
  cell: TableCell | undefined,
  measure: TableCellMeasure,
): CellBreakGeometry {
  // Mirror the PAINTER's cell-content stacking (renderCellContent), not just the
  // cell-height model: each block advances by its `totalHeight` (which bundles
  // space-before/after), but its lines paint from the block top with no leading
  // space-before. Seating line bottoms this way keeps them on the painted line
  // boundaries so an oversized-row break never cuts through a glyph row.
  const bottoms: number[] = [];
  const unsafeRanges: UnsafeBreakRange[] = [];
  const cellBlocks = cell?.blocks;
  const blockMeasures = measure.blocks;
  const padTop = cell?.padding?.top ?? DEFAULT_TABLE_CELL_PADDING_TOP;
  const contentWidth = getTableCellContentWidth(cell, measure);
  const floatingImages =
    cell !== undefined
      ? getTableCellFloatingImages(cell, measure, contentWidth)
      : [];
  const floatingZones = buildTableCellFloatingZones(
    floatingImages,
    contentWidth,
  );
  let y = padTop;
  let paragraphY = 0;
  for (let i = 0; i < blockMeasures.length; i++) {
    let blockMeasure = blockMeasures[i];
    if (blockMeasure?.kind === "paragraph") {
      const block = cellBlocks?.[i];
      if (block?.kind === "paragraph" && floatingZones.length > 0) {
        blockMeasure = measureParagraph(block, contentWidth, {
          floatingZones,
          paragraphYOffset: paragraphY,
        });
      }
      // The painter (renderCellContent) stacks each cell paragraph by its full
      // measured height (`totalHeight`, which bundles space-before/after) yet
      // paints the lines from the fragment top with NO leading space-before; the
      // before/after surface as trailing space. Mirror that exactly: seat line
      // bottoms from the block top and advance by `totalHeight`. Offsetting the
      // lines by `spacing.before` (as the cell-height model does) shifted every
      // break offset off the painted line boundary, so an oversized row split
      // through the middle of a glyph row across the page break.
      const blockTop = y;
      for (const line of blockMeasure.lines) {
        y += line.floatSkipBefore ?? 0;
        const top = y;
        y += line.lineHeight;
        unsafeRanges.push({ top, bottom: y });
        bottoms.push(y);
      }
      y = blockTop + blockMeasure.totalHeight;
      paragraphY += blockMeasure.totalHeight;
    } else if (blockMeasure) {
      // Nested table / non-paragraph: one atomic block (break only at its bottom).
      const blockHeight = getAtomicBlockHeight(blockMeasure);
      if (blockHeight > 0) {
        const top = y;
        y += blockHeight;
        paragraphY += blockHeight;
        unsafeRanges.push({ top, bottom: y });
        bottoms.push(y);
      }
    }
  }
  return { bottoms, unsafeRanges };
}

/** Precomputed break geometry for a table. */
export type TableRowBreakInfo = {
  /** Cumulative y of the top of each row; `rowTops[rows.length]` is the table height. */
  rowTops: number[];
  /**
   * Per-row sorted, de-duplicated line-bottom offsets (relative to the row top)
   * at which a break is clean. Always includes the row's full height as the
   * final boundary.
   */
  breakOffsets: number[][];
};

/** Build break geometry for a table from its block + measure. */
export function buildTableRowBreakInfo(
  block: TableBlock,
  measure: TableMeasure,
): TableRowBreakInfo {
  const rowCount = measure.rows.length;
  const rowTops: number[] = [];
  let acc = 0;
  for (let r = 0; r < rowCount; r++) {
    rowTops.push(acc);
    acc += measure.rows[r]?.height ?? 0;
  }
  rowTops.push(acc);

  const breakOffsets: number[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const rowHeight = measure.rows[r]?.height ?? 0;
    const offsets = new Set<number>();
    offsets.add(rowHeight); // a row boundary is always a clean break
    const sourceCells = block.rows[r]?.cells ?? [];
    const measuredCells = measure.rows[r]?.cells ?? [];
    const cellGeometries: CellBreakGeometry[] = [];
    for (let c = 0; c < measuredCells.length; c++) {
      const measuredCell = measuredCells[c];
      if (!measuredCell) {
        continue;
      }
      const sourceCell = sourceCells[c];
      const geometry = shiftCellGeometry(
        cellBreakGeometry(sourceCell, measuredCell),
        getVerticalAlignmentOffset(sourceCell, measuredCell, rowHeight),
      );
      cellGeometries.push(geometry);
      for (const b of geometry.bottoms) {
        if (b > 0 && b < rowHeight) {
          offsets.add(b);
        }
      }
    }
    const safeOffsets = [...offsets].filter(
      (offset) =>
        offset === rowHeight ||
        cellGeometries.every((geometry) =>
          geometry.unsafeRanges.every((range) => !isInsideRange(offset, range)),
        ),
    );
    breakOffsets.push(safeOffsets.sort((a, b) => a - b));
  }

  return { rowTops, breakOffsets };
}

/**
 * Given a row and how much of it has already been placed (`fromOffset`), return
 * how many more px can be placed ending on a whole line, without exceeding
 * `maxSlice`. Returns 0 when not even the first line fits.
 */
export function snapRowBreak(
  info: TableRowBreakInfo,
  rowIndex: number,
  fromOffset: number,
  maxSlice: number,
): number {
  const offsets = info.breakOffsets[rowIndex];
  if (!offsets || offsets.length === 0) {
    return 0;
  }
  const limit = fromOffset + maxSlice;
  let best = 0;
  for (const off of offsets) {
    if (off <= fromOffset) {
      continue;
    }
    if (off <= limit) {
      best = off - fromOffset;
    } else {
      break;
    }
  }
  return best;
}

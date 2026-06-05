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

import type {
  FlowBlock,
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
  cellBlocks: FlowBlock[] | undefined,
  blockMeasures: Measure[],
  padTop: number,
): CellBreakGeometry {
  // Mirror measureTableBlock's cell-height model: each block contributes
  // before + lines + after with no inter-paragraph collapse (the paragraph
  // measure's totalHeight already bundles before/after). Keeping the same model
  // means these line bottoms line up with the row height the paginator splits.
  const bottoms: number[] = [];
  const unsafeRanges: UnsafeBreakRange[] = [];
  let y = padTop;
  for (let i = 0; i < blockMeasures.length; i++) {
    const measure = blockMeasures[i];
    if (measure?.kind === "paragraph") {
      const block = cellBlocks?.[i];
      const spacing =
        block?.kind === "paragraph" ? block.attrs?.spacing : undefined;
      y += spacing?.before ?? 0;
      for (const line of measure.lines) {
        y += line.floatSkipBefore ?? 0;
        const top = y;
        y += line.lineHeight;
        unsafeRanges.push({ top, bottom: y });
        bottoms.push(y);
      }
      y += spacing?.after ?? 0;
    } else if (measure) {
      // Nested table / non-paragraph: one atomic block (break only at its bottom).
      const blockHeight = getAtomicBlockHeight(measure);
      if (blockHeight > 0) {
        const top = y;
        y += blockHeight;
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
      const padTop = sourceCell?.padding?.top ?? 0;
      const geometry = shiftCellGeometry(
        cellBreakGeometry(sourceCell?.blocks, measuredCell.blocks, padTop),
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

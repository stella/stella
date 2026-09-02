import { panic } from "better-result";

import type { KanbanColumnBand } from "./grouping";
import type { KanbanBoardColumn } from "./matrix";
import { getKanbanBoardColumnIdentity } from "./matrix";

/**
 * Column bands: named runs of adjacent columns the board shows under one
 * header and can collapse as a unit.
 *
 * A band is presentation over the column order, never a second axis: cards
 * keep their column, and the matrix stays the placement authority. The board
 * only needs to know which adjacent columns share a header, which is what
 * `resolveKanbanColumnBands` derives from the columns' `band` metadata.
 */

/** Every board column takes this inline size; a collapsed band takes one lane. */
export const KANBAN_COLUMN_WIDTH_CLASS = "w-[300px] shrink-0";
export const KANBAN_COLUMN_WIDTH_PX = 300;
/** The `gap-3` between columns, so a band header can span its columns. */
export const KANBAN_COLUMN_GAP_PX = 12;
/** A collapsed band folds its columns into one narrow lane. */
export const KANBAN_COLLAPSED_BAND_WIDTH_CLASS = "w-12 shrink-0";
export const KANBAN_COLLAPSED_BAND_WIDTH_PX = 48;

/**
 * A run of adjacent columns under one header. `band` is `null` for a column
 * that belongs to no band, which renders as a run of one without a header.
 */
export type KanbanColumnBandSpan = {
  band: KanbanColumnBand | null;
  columns: KanbanBoardColumn[];
};

const bandOf = (column: KanbanBoardColumn): KanbanColumnBand | null =>
  column.type === "group" ? (column.group.band ?? null) : null;

/**
 * Group the presented columns into bands, in column order.
 *
 * Bands must be contiguous: the same band id appearing again after a column
 * of another band (or of none) is a programming error in the caller's schema,
 * not a state to render, because a header that spans two separate runs has no
 * meaning. The check fails loudly instead of silently drawing a second header.
 */
export const resolveKanbanColumnBands = (
  columns: readonly KanbanBoardColumn[],
): KanbanColumnBandSpan[] => {
  const spans: KanbanColumnBandSpan[] = [];
  const closedBandIds = new Set<string>();
  for (const column of columns) {
    const band = bandOf(column);
    const last = spans.at(-1);
    if (band !== null && last?.band?.id === band.id) {
      last.columns.push(column);
      continue;
    }
    if (last?.band !== null && last?.band !== undefined) {
      closedBandIds.add(last.band.id);
    }
    if (band !== null && closedBandIds.has(band.id)) {
      return panic(
        `Kanban column band "${band.id}" is not contiguous: it resumes at column ${getKanbanBoardColumnIdentity(column)}`,
      );
    }
    spans.push({ band, columns: [column] });
  }
  return spans;
};

/** Whether any presented column carries band metadata. */
export const hasKanbanColumnBands = (
  columns: readonly KanbanBoardColumn[],
): boolean => columns.some((column) => bandOf(column) !== null);

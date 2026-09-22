/**
 * Find-in-table, without React and without a row kind.
 *
 * A find is a substring filter over exactly what the grid renders, narrowed to
 * the columns the reader picked. Which columns it can reach, what the picker
 * shows after one is clicked, and which term the rows on screen were narrowed
 * by are the same questions whatever the rows are, so they are answered here:
 * the entity half turns the answer into a row query, the decision half into a
 * predicate over the rows it already holds.
 *
 * Public-safe: no store, no route, no entity.
 */

import { ENTITY_FIND_TERM_MIN_LENGTH } from "@stll/api-contract";

import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import { containsMatch } from "@/components/workspaces/table/find-highlight.logic";

/**
 * The shortest term a find accepts, in characters after trimming. One floor
 * for both surfaces: the server rejects a shorter one, and a reader who learns
 * the bar in a matter meets the same bar on a results page.
 */
export const TABLE_FIND_TERM_MIN_LENGTH = ENTITY_FIND_TERM_MIN_LENGTH;

/**
 * How wide a find reaches. `all` is the state the bar opens in: no column
 * chosen, so the row's name counts too. Narrowing to columns is a different
 * question, not a shorter list, which is why it is a branch rather than an
 * empty array.
 */
export type TableFindSelection =
  | { type: "all" }
  | { columnIds: string[]; type: "columns" };

export const UNRESTRICTED_FIND: TableFindSelection = { type: "all" };

/**
 * A surface's find. Absent means there is no find at all; the bar's own
 * visibility is `status` alone, because a find outlives its editor. Closing
 * the popover leaves the rows narrowed and the toolbar chip explaining why,
 * and clearing is the only thing that ends it.
 *
 * `typed` is what the input holds this keystroke. `submitted` is what the rows
 * on screen have actually been narrowed by. They are separate because the bar
 * debounces: one field would either lag the input by a quarter second or
 * requery on every keystroke, and "search now" (Enter) needs something to
 * submit early into. Only `submitted` may reach a query key or a highlight.
 */
export type TableFindState = {
  scope: TableFindSelection;
  status: "closed" | "open";
  submitted: string;
  typed: string;
};

/**
 * Where a surface keeps its find, and how the bar changes it.
 *
 * Injected rather than reached for: a matter keeps one per view in the table
 * store, and a public results page keeps one in page state, because a find is
 * a question about the rows in front of you rather than a saved setting.
 */
export type TableFindPersistence = {
  clear: () => void;
  /** Hide the bar and keep the term: the rows stay narrowed. */
  close: () => void;
  /**
   * What the find belongs to — a view, a jurisdiction. Identity, never shown:
   * the bar stays mounted across a switch, so anything it holds locally has to
   * know which owner it was opened for.
   */
  key: string;
  open: () => void;
  setScope: (scope: TableFindSelection) => void;
  setTyped: (typed: string) => void;
  /** Submit what is typed: the rows renarrow, and the marks follow. */
  submit: () => void;
  state: TableFindState | undefined;
};

/**
 * A column a find may be offered. Columns whose values a find cannot reach
 * stay in the list, marked: a column the reader can see in the grid that is
 * silently missing from the picker reads as a bug.
 */
export type TableFindColumn = {
  id: string;
  label: string;
  searchable: boolean;
};

export const searchableColumnIds = (
  columns: readonly TableFindColumn[],
): string[] =>
  columns.filter((column) => column.searchable).map((column) => column.id);

/**
 * The picker's selection after the columns it named are re-intersected with
 * what is currently searchable. A column hidden or deleted while the find is
 * live drops out; when that drops the last one the find widens back to
 * unrestricted, the same way clearing the last tick does, so the rows never
 * narrow to a search nothing can satisfy and the picker always shows a state
 * a click can leave.
 */
export const effectiveFindSelection = ({
  columns,
  selection,
}: {
  columns: readonly TableFindColumn[];
  selection: TableFindSelection;
}): TableFindSelection => {
  if (selection.type === "all") {
    return selection;
  }
  const chosen = new Set(selection.columnIds);
  const columnIds = searchableColumnIds(columns).filter((columnId) =>
    chosen.has(columnId),
  );
  if (columnIds.length === 0) {
    return { type: "all" };
  }
  return { columnIds, type: "columns" };
};

/**
 * The picker's selection after one column row is clicked.
 *
 * `all` is the unrestricted state, not the full list ticked, so under it the
 * columns show unticked and the first click narrows to exactly the column
 * clicked. Ticking every column stays `columns`: it is the only scope that
 * searches every cell without also matching the row's name, and on a grid with
 * a single searchable column it is the only way to narrow at all. Clearing the
 * last tick is the way back, because a search of no columns is one nothing can
 * satisfy.
 */
export const toggleFindColumn = ({
  columnId,
  searchable,
  selection,
}: {
  columnId: string;
  searchable: readonly string[];
  selection: TableFindSelection;
}): TableFindSelection => {
  const chosen = new Set(selection.type === "all" ? [] : selection.columnIds);
  if (chosen.has(columnId)) {
    chosen.delete(columnId);
  } else {
    chosen.add(columnId);
  }
  const columnIds = searchable.filter((id) => chosen.has(id));
  if (columnIds.length === 0) {
    return { type: "all" };
  }
  return { columnIds, type: "columns" };
};

export type TableFindResolution = {
  /** The columns the find actually reaches, in grid order. */
  columnIds: string[];
  highlight: TableFindHighlight | null;
  /** Whether the row's own name counts as well as the listed columns. */
  matchesName: boolean;
  /** The picker's selection, with columns that left the grid dropped. */
  selection: TableFindSelection;
  /** The submitted term once it clears the floor; null below it. */
  term: string | null;
};

/**
 * One resolution of a find: which columns it reaches, the marks drawn over the
 * rows it leaves, and the selection the picker shows. All three derive from
 * one pass so none can describe a find the others were not given.
 *
 * `hasNameColumn` is the row's own name — the string a name column renders —
 * which the unrestricted scope also matches. A kind whose rows have no such
 * column passes false.
 */
export const resolveTableFind = ({
  columns,
  hasNameColumn,
  selection,
  term,
}: {
  columns: readonly TableFindColumn[];
  hasNameColumn: boolean;
  selection: TableFindSelection;
  /** The submitted term, never what the bar currently holds typed. */
  term: string;
}): TableFindResolution => {
  const effective = effectiveFindSelection({ columns, selection });
  // A term under the floor is no find, the same as a blank one: the server
  // would reject it, and marking it would explain rows nothing narrowed.
  const trimmed = term.trim();
  if (trimmed.length < TABLE_FIND_TERM_MIN_LENGTH) {
    return {
      columnIds: [],
      highlight: null,
      matchesName: false,
      selection: effective,
      term: null,
    };
  }

  const narrowed = effective.type === "columns";
  const columnIds = narrowed
    ? effective.columnIds
    : searchableColumnIds(columns);
  // Once the reader narrows to columns the search is about those cells, so the
  // row's name and the column headers stop highlighting with it.
  const matchesName = !narrowed && hasNameColumn;
  return {
    columnIds,
    highlight: {
      columnIds: new Set(columnIds),
      matchesName,
      term: trimmed,
    },
    matchesName,
    selection: effective,
    term: trimmed,
  };
};

/** What a row shows, per column id. A column showing nothing is absent. */
export type TableFindRowText = ReadonlyMap<string, string>;

/**
 * Whether a row survives a find that runs over the rows already on screen.
 *
 * Matching folds the same way the marks do, through one splitter, so a row is
 * on screen exactly when something in it is marked: a surviving row with no
 * visible mark would read as a bug, and a marked run in a row nothing matched
 * would be a lie about why it is there.
 */
export const tableFindMatches = ({
  columnIds,
  term,
  text,
}: {
  columnIds: readonly string[];
  term: string;
  text: TableFindRowText;
}): boolean =>
  columnIds.some((columnId) => {
    const cell = text.get(columnId);
    return cell !== undefined && containsMatch(cell, term);
  });

type FindTableRowsInput<TRow> = {
  /** The columns the find reaches; empty while no term is applied. */
  columnIds: readonly string[];
  rows: readonly TRow[];
  /** What one row shows, per column id, for the columns a find reaches. */
  rowText: (row: TRow) => TableFindRowText;
  /** The submitted term once it clears the floor; null below it. */
  term: string | null;
};

/**
 * The rows a client-side find leaves on screen. The same list, by identity,
 * when no term is applied: a table compares its rows by identity, and a list
 * rebuilt per render loops a controlled table.
 */
export const findTableRows = <TRow>({
  columnIds,
  rows,
  rowText,
  term,
}: FindTableRowsInput<TRow>): readonly TRow[] => {
  if (term === null) {
    return rows;
  }
  return rows.filter((row) =>
    tableFindMatches({ columnIds, term, text: rowText(row) }),
  );
};

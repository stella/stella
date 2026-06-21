import type { RowSelectionState } from "@tanstack/react-table";

type SelectAllStateInput = {
  selectableRowIds: readonly string[];
  rowSelection: RowSelectionState;
  // All row ids that may legitimately stay selected across the whole view. In a
  // grouped table the sections share one selection, so this is the union of
  // every section's rows; toggling one section keeps selections in the others
  // while still dropping ids that are no longer any row (stale). Omitted by the
  // flat table, whose selectable set already covers every row.
  preservableRowIds?: readonly string[];
};

export type SelectAllState = {
  checked: boolean;
  indeterminate: boolean;
  key: "none" | "some" | "all";
};

export const getSelectAllState = ({
  selectableRowIds,
  rowSelection,
}: SelectAllStateInput): SelectAllState => {
  let selectedCount = 0;

  for (const rowId of selectableRowIds) {
    if (rowSelection[rowId]) {
      selectedCount += 1;
    }
  }

  const checked =
    selectableRowIds.length > 0 && selectedCount === selectableRowIds.length;
  const indeterminate =
    selectedCount > 0 && selectedCount < selectableRowIds.length;

  return {
    checked,
    indeterminate,
    key: (() => {
      if (checked) {
        return "all";
      }
      if (indeterminate) {
        return "some";
      }
      return "none";
    })(),
  };
};

export const getNextSelectAllRowSelection = ({
  selectableRowIds,
  rowSelection,
  preservableRowIds,
}: SelectAllStateInput): RowSelectionState => {
  const state = getSelectAllState({ selectableRowIds, rowSelection });
  const selectable = new Set(selectableRowIds);
  // Without an explicit set, nothing outside the selectable rows survives (the
  // flat table covers every row, so this drops stale ids on clear). With one, a
  // section keeps selections in other sections but still drops stale ids.
  const preservable = preservableRowIds
    ? new Set(preservableRowIds)
    : selectable;

  const next: RowSelectionState = {};
  for (const rowId of Object.keys(rowSelection)) {
    if (
      rowSelection[rowId] &&
      !selectable.has(rowId) &&
      preservable.has(rowId)
    ) {
      next[rowId] = true;
    }
  }

  if (!state.checked) {
    for (const rowId of selectableRowIds) {
      next[rowId] = true;
    }
  }

  return next;
};

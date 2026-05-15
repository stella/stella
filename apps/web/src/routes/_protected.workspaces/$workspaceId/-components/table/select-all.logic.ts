import type { RowSelectionState } from "@tanstack/react-table";

type SelectAllStateInput = {
  selectableRowIds: readonly string[];
  rowSelection: RowSelectionState;
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
}: SelectAllStateInput): RowSelectionState => {
  const state = getSelectAllState({ selectableRowIds, rowSelection });

  if (state.checked) {
    return {};
  }

  const next: RowSelectionState = {};
  for (const rowId of selectableRowIds) {
    next[rowId] = true;
  }

  return next;
};

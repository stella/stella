import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
} from "@tanstack/react-table";

import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const addPropertyColId = getInternalColId("add-property");
const utilityColumnIds = new Set<string>([selectColId, addPropertyColId]);

const isPersistableColumnId = (id: string) => !utilityColumnIds.has(id);

export const omitUtilityColumnSizing = (
  sizing: ColumnSizingState,
): ColumnSizingState => {
  const result: ColumnSizingState = {};

  for (const [id, size] of Object.entries(sizing)) {
    if (isPersistableColumnId(id)) {
      result[id] = size;
    }
  }

  return result;
};

export const createColumnPinningState = (
  pinnedColumnIds: readonly string[],
): ColumnPinningState => ({
  left: [selectColId, ...pinnedColumnIds.filter(isPersistableColumnId)],
  right: [],
});

export const getPersistedColumnPinning = (
  pinning: ColumnPinningState,
): string[] => pinning.left.filter(isPersistableColumnId);

export const createColumnOrderState = (
  orderedColumnIds: readonly string[],
): ColumnOrderState => [
  selectColId,
  ...orderedColumnIds.filter(isPersistableColumnId),
];

export const getPersistedColumnOrder = (order: ColumnOrderState): string[] =>
  order.filter(isPersistableColumnId);

export const createColumnVisibilityState = (
  hiddenColumnIds: readonly string[],
): ColumnVisibilityState => {
  const visibility: ColumnVisibilityState = {};

  for (const id of hiddenColumnIds) {
    if (isPersistableColumnId(id)) {
      visibility[id] = false;
    }
  }

  return visibility;
};

export const getPersistedHiddenColumnIds = (
  visibility: ColumnVisibilityState,
): string[] =>
  Object.entries(visibility)
    .filter(([, visible]) => !visible)
    .map(([id]) => id)
    .filter(isPersistableColumnId);

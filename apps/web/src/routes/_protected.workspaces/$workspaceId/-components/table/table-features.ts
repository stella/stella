import {
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createCoreRowModel,
  rowExpandingFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

// The registered feature set is both the runtime capability list and the
// source for the workspace table aliases in `./types`.
export const workspaceTableFeatures = tableFeatures({
  coreRowModel: createCoreRowModel(),
  rowSortingFeature,
  rowSelectionFeature,
  rowExpandingFeature,
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnResizingFeature,
});

export type WorkspaceTableFeatures = typeof workspaceTableFeatures;

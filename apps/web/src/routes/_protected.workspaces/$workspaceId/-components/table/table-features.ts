import {
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  rowExpandingFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

// v9 features are tree-shakable: only the slices the workspace table
// actually uses are registered, so column filtering, faceting, grouping,
// pagination, global filtering, and row pinning never reach the bundle.
// Adding a capability here is the single switch that turns it on across
// the table instance and the derived `Table*` types in `./types`.
export const workspaceTableFeatures = tableFeatures({
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

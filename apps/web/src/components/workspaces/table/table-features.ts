import {
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createCoreRowModel,
  metaHelper,
  rowExpandingFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

import type { ColumnContextMenu } from "@/components/workspaces/row-actions.logic";

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
  // `contextMenu` is set on every entity-row column; other row kinds have no
  // row menu.
  columnMeta: metaHelper<{
    contextMenu?: ColumnContextMenu;
    muted?: boolean;
  }>(),
});

export type WorkspaceTableFeatures = typeof workspaceTableFeatures;

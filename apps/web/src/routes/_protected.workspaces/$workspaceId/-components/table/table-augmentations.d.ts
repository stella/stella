import type { CellData, RowData, TableFeatures } from "@tanstack/table-core";

// Keep the declaration signature aligned with upstream so ColumnMeta merging
// applies to every feature set.
declare module "@tanstack/table-core" {
  // oxlint-disable-next-line consistent-type-definitions
  interface ColumnMeta<
    TFeatures extends TableFeatures,
    TData extends RowData,
    TValue extends CellData = CellData,
  > {
    muted?: boolean;
  }
}

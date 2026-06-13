import type { CellData, RowData, TableFeatures } from "@tanstack/table-core";

// Keep the declaration signature aligned with upstream so ColumnMeta merging
// applies to every feature set.
declare module "@tanstack/table-core" {
  // oxlint-disable-next-line consistent-type-definitions -- module augmentation requires interface for declaration merging
  interface ColumnMeta<
    TFeatures extends TableFeatures,
    TData extends RowData,
    TValue extends CellData = CellData,
  > {
    muted?: boolean;
  }
}

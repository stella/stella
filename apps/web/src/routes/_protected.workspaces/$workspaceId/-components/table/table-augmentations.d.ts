import type { CellData, RowData, TableFeatures } from "@tanstack/table-core";

// Module augmentation lives in a .d.ts so the (merge-mandated) unused type
// parameters do not trip TS 6205 the way they would in a .ts source file.
// The parameter list must mirror the upstream `ColumnMeta` declaration
// exactly for declaration merging to apply.
declare module "@tanstack/table-core" {
  // oxlint-disable-next-line consistent-type-definitions
  interface ColumnMeta<
    TFeatures extends TableFeatures,
    TData extends RowData,
    TValue extends CellData = CellData,
  > {
    /** Render cell text in muted-foreground. */
    muted?: boolean;
  }
}

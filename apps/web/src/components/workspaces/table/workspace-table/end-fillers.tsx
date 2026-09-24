import { flexRender } from "@tanstack/react-table";

import { cn } from "@stll/ui/utils";

import type {
  TableCell,
  TableColumn,
  TableRowData,
} from "@/components/workspaces/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import { PinnedBoundary } from "@/components/workspaces/table/workspace-table/internals";
import {
  getEndFillerGridColumn,
  getGridPinningStyles,
  isPinnedBoundaryColumn,
  tableEndFillerCellStyle,
} from "@/components/workspaces/table/workspace-table/internals-helpers";
import type { EndFillerInput } from "@/components/workspaces/table/workspace-table/internals-helpers";

type TableEndFillerProps<TRow extends TableRowData> = {
  renderColumns: TableColumn<TRow>[];
  addPropertyColumn: TableColumn<TRow> | null;
};

export const TableEndFiller = <TRow extends TableRowData>({
  renderColumns,
  addPropertyColumn,
}: TableEndFillerProps<TRow>) => (
  <WorkspaceGridRow className="pointer-events-none min-h-0 flex-1">
    {renderColumns.map((column, index) => (
      <WorkspaceGridCell
        className={cn(
          "border-b-0",
          isPinnedBoundaryColumn(column) && "border-e-0",
        )}
        key={column.id}
        role="presentation"
        style={{
          gridColumn: index + 1,
          ...getGridPinningStyles(column),
          ...tableEndFillerCellStyle,
        }}
      >
        <PinnedBoundary column={column} />
      </WorkspaceGridCell>
    ))}
    <WorkspaceGridCell
      className={cn("border-b-0 p-0", addPropertyColumn && "border-e-0")}
      role="presentation"
      style={{
        gridColumn: getEndFillerGridColumn({
          renderColumns,
          addPropertyColumn,
        }),
        ...tableEndFillerCellStyle,
      }}
    />
    {addPropertyColumn && (
      <WorkspaceGridCell
        className="border-s-2 border-e-2 border-b-0 p-0"
        data-add-property-surface
        style={{
          ...getGridPinningStyles(addPropertyColumn),
          ...tableEndFillerCellStyle,
        }}
      />
    )}
  </WorkspaceGridRow>
);

type RowEndFillerCellProps<TRow extends TableRowData> = EndFillerInput<TRow> & {
  selected: boolean;
};

export const RowEndFillerCell = <TRow extends TableRowData>({
  renderColumns,
  addPropertyColumn,
  selected,
}: RowEndFillerCellProps<TRow>) => (
  <WorkspaceGridCell
    aria-hidden="true"
    className={cn("p-0", addPropertyColumn && "border-e-0")}
    data-state={selected ? "selected" : undefined}
    role="presentation"
    style={{
      gridColumn: getEndFillerGridColumn({
        renderColumns,
        addPropertyColumn,
      }),
    }}
  />
);

type AddPropertyCellProps<TRow extends TableRowData> = {
  cell: TableCell<TRow> | undefined;
  columnIndex: number;
  selected: boolean;
};

export const AddPropertyCell = <TRow extends TableRowData>({
  cell,
  columnIndex,
  selected,
}: AddPropertyCellProps<TRow>) => {
  if (!cell) {
    return null;
  }

  return (
    <WorkspaceGridCell
      aria-colindex={columnIndex}
      className="border-s-2 border-e-2 p-0"
      data-add-property-surface
      data-state={selected ? "selected" : undefined}
      style={{
        ...getGridPinningStyles(cell.column),
      }}
    >
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </WorkspaceGridCell>
  );
};

type AddPropertyRailSpacerProps = {
  height: number;
};

export const AddPropertyRailSpacer = ({
  height,
}: AddPropertyRailSpacerProps) => (
  <WorkspaceGridCell
    className="border-s-2 border-e-2 border-b-0 p-0"
    data-add-property-surface
    style={{
      gridColumn: "-2 / -1",
      height,
      position: "sticky",
      insetInlineEnd: 0,
      zIndex: 2,
      ...tableEndFillerCellStyle,
    }}
  />
);

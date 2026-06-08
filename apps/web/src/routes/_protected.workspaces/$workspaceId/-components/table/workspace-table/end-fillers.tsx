import { flexRender } from "@tanstack/react-table";

import { cn } from "@stll/ui/lib/utils";

import type {
  TableCell,
  TableColumn,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import {
  getEndFillerGridColumn,
  getGridPinningStyles,
  isPinnedBoundaryColumn,
  PinnedBoundary,
  tableEndFillerCellStyle,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";
import type { EndFillerInput } from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals";

type TableEndFillerProps = {
  renderColumns: TableColumn[];
  addPropertyColumn: TableColumn | null;
};

export const TableEndFiller = ({
  renderColumns,
  addPropertyColumn,
}: TableEndFillerProps) => (
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

type RowEndFillerCellProps = EndFillerInput & {
  selected: boolean;
};

export const RowEndFillerCell = ({
  renderColumns,
  addPropertyColumn,
  selected,
}: RowEndFillerCellProps) => (
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

type AddPropertyCellProps = {
  cell: TableCell | undefined;
  columnIndex: number;
  selected: boolean;
};

export const AddPropertyCell = ({
  cell,
  columnIndex,
  selected,
}: AddPropertyCellProps) => {
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
      right: 0,
      zIndex: 2,
      ...tableEndFillerCellStyle,
    }}
  />
);

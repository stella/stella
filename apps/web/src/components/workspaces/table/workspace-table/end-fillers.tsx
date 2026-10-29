import { flexRender } from "@tanstack/react-table";

import { cn } from "@stll/ui/utils";

import type {
  TableCell,
  TableColumn,
  TableRowData,
} from "@/components/workspaces/table/types";
import {
  WorkspaceGridCell,
  WorkspaceGridFillerCell,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import { PinnedBoundary } from "@/components/workspaces/table/workspace-table/internals";
import {
  getEndFillerGridColumn,
  getGridPinningStyles,
  getWorkspaceGridColumnMetadata,
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
  actions?: React.ReactNode;
  selected: boolean;
};

export const RowEndFillerCell = <TRow extends TableRowData>({
  renderColumns,
  addPropertyColumn,
  actions: fallbackActions,
  selected,
}: RowEndFillerCellProps<TRow>) => {
  const { actionsColumnIndex } = getWorkspaceGridColumnMetadata({
    renderColumns,
    addPropertyColumn,
  });
  const actions =
    actionsColumnIndex === undefined ? undefined : fallbackActions;
  const Cell =
    actions === undefined ? WorkspaceGridFillerCell : WorkspaceGridCell;
  return (
    <Cell
      aria-colindex={actions === undefined ? undefined : actionsColumnIndex}
      aria-hidden={actions === undefined ? true : undefined}
      className={cn(
        "flex items-center justify-end p-0",
        addPropertyColumn && "border-e-0",
      )}
      data-state={selected ? "selected" : undefined}
      style={{
        gridColumn: getEndFillerGridColumn({
          renderColumns,
          addPropertyColumn,
        }),
      }}
    >
      {actions}
    </Cell>
  );
};

type AddPropertyCellProps<TRow extends TableRowData> = {
  cell: TableCell<TRow> | undefined;
  renderColumns: TableColumn<TRow>[];
  selected: boolean;
};

export const AddPropertyCell = <TRow extends TableRowData>({
  cell,
  renderColumns,
  selected,
}: AddPropertyCellProps<TRow>) => {
  if (!cell) {
    return null;
  }

  return (
    <WorkspaceGridCell
      aria-colindex={
        getWorkspaceGridColumnMetadata({
          renderColumns,
          addPropertyColumn: cell.column,
        }).addPropertyColumnIndex
      }
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

import { cn } from "@stll/ui/utils";
import type {
  CalculationSelection,
  WorkspaceCalculationLabels,
} from "@stll/workspace-ui/calculations";
import {
  CalculationKindPicker,
  ColumnCalculation,
} from "@stll/workspace-ui/calculations";

import type {
  TableColumn,
  TableTreeNode,
} from "@/components/workspaces/table/types";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty } from "@/lib/types";
import {
  calculationKindsForProperty,
  toCalculationValue,
} from "@/lib/workspaces/calculations";
import {
  WorkspaceGridCell,
  WorkspaceGridRow,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-grid";
import {
  getEndFillerGridColumn,
  getGridPinningStyles,
  isPinnedBoundaryColumn,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/internals-helpers";
import { useWorkspaceCalculationLabels } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workspace-calculation-labels";

type TableCalculationsRowProps = {
  renderColumns: TableColumn[];
  addPropertyColumn: TableColumn | null;
  rows: readonly TableTreeNode[];
  properties: readonly WorkspaceProperty[];
  calculations: readonly CalculationSelection[];
  onChange: (calculations: CalculationSelection[]) => void;
};

/**
 * The footer row: what each column adds up to, over exactly the rows above it.
 *
 * It runs the same reducer the board's column headers do, so a property totals
 * the same however the view is laid out. A column with no calculation shows
 * only its picker, and only while the row is hovered or focused.
 */
export const TableCalculationsRow = ({
  renderColumns,
  addPropertyColumn,
  rows,
  properties,
  calculations,
  onChange,
}: TableCalculationsRowProps) => {
  const labels = useWorkspaceCalculationLabels();

  return (
    <WorkspaceGridRow
      className={cn("bg-background sticky bottom-0 z-20", TOOLBAR_ROW_HEIGHT)}
    >
      {renderColumns.map((column, index) => (
        <WorkspaceGridCell
          className={cn(
            "flex items-center justify-end gap-1 border-t border-b-0",
            isPinnedBoundaryColumn(column) && "border-e-0",
          )}
          key={column.id}
          role="presentation"
          style={{ gridColumn: index + 1, ...getGridPinningStyles(column) }}
        >
          <CalculationCell
            calculations={calculations}
            columnId={column.id}
            labels={labels}
            onChange={onChange}
            properties={properties}
            rows={rows}
          />
        </WorkspaceGridCell>
      ))}
      <WorkspaceGridCell
        aria-hidden="true"
        className={cn(
          "border-t border-b-0 p-0",
          addPropertyColumn && "border-e-0",
        )}
        role="presentation"
        style={{
          gridColumn: getEndFillerGridColumn({
            renderColumns,
            addPropertyColumn,
          }),
        }}
      />
    </WorkspaceGridRow>
  );
};

type CalculationCellProps = {
  columnId: string;
  labels: WorkspaceCalculationLabels;
  rows: readonly TableTreeNode[];
  properties: readonly WorkspaceProperty[];
  calculations: readonly CalculationSelection[];
  onChange: (calculations: CalculationSelection[]) => void;
};

const CalculationCell = ({
  columnId,
  labels,
  rows,
  properties,
  calculations,
  onChange,
}: CalculationCellProps) => {
  const property = properties.find((candidate) => candidate.id === columnId);
  if (!property) {
    return null;
  }

  const selected =
    calculations.find((selection) => selection.propertyId === columnId) ?? null;

  const select = (kind: CalculationSelection["kind"] | null) => {
    const rest = calculations.filter(
      (selection) => selection.propertyId !== columnId,
    );
    onChange(kind === null ? rest : [...rest, { propertyId: columnId, kind }]);
  };

  return (
    <>
      {selected && (
        <ColumnCalculation
          kind={selected.kind}
          labels={labels}
          values={rows.map((row) =>
            toCalculationValue(row.fields[toSafeId<"property">(columnId)]),
          )}
        />
      )}
      <span className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <CalculationKindPicker
          kinds={calculationKindsForProperty(property)}
          labels={labels}
          onChange={select}
          value={selected?.kind ?? null}
        />
      </span>
    </>
  );
};

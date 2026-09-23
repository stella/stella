/**
 * The public-law results table: one table for decisions and statutes.
 *
 * It is the workspace table: the same shell, the same header menus, the same
 * column drag-and-drop, pinning and resizing. What this adds is the results
 * frame around it — the bounded box that owns the scroll, the fade while a
 * new search is in flight, the waiting rows, the empty line — and the wiring
 * of a reader's stored arrangement into the table's controlled state. What a
 * row is and what its columns draw is the calling slice's: decisions and
 * statutes are column definitions and a row host over this.
 */

import { useMemo } from "react";
import type { ReactNode } from "react";

import { useTable } from "@tanstack/react-table";
import type { RowSelectionState } from "@tanstack/react-table";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";
import { FindHighlightScope } from "@/components/workspaces/table/find-highlight";
import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import type { TableRowHost } from "@/components/workspaces/table/row-host";
import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-schema";
import type {
  DecisionRowData,
  StatuteRowData,
  TableColumnDef,
} from "@/components/workspaces/table/types";
import { useTableState } from "@/components/workspaces/table/use-table-state";
import { tableSkeletonRowCount } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";
import { WorkspaceTable } from "@/components/workspaces/table/workspace-table/workspace-table";

/** The row kinds a public-law results table draws. */
export type PublicLawRowData = DecisionRowData | StatuteRowData;

/**
 * Which rows the reader picked, for a table whose page acts on a selection.
 * A table with nothing to do with picked rows omits it and draws no checkbox.
 */
type PublicLawTableSelection = {
  selectedIds: readonly string[];
  onSelectedIdsChange: (ids: string[]) => void;
};

type PublicLawTableProps<
  TRow extends PublicLawRowData,
  TLayout extends PublicLawTableLayout,
> = {
  columns: TableColumnDef<TRow>[];
  /**
   * What stands where the rows would be when there are none, for a screen
   * that can say why. The plain "no results" line otherwise.
   */
  emptyState?: ReactNode | undefined;
  /**
   * How many rows the page being loaded will hold, so the waiting table stands
   * in at that size. Defaults to a compact stand-in where a screen cannot say.
   */
  expectedRowCount?: number | undefined;
  /** The find's marks, or null when no term is applied. */
  findHighlight?: TableFindHighlight | null | undefined;
  /** The ordinal of the first row: a page's first position in the whole list. */
  firstRowNumber: number;
  getRowId: (row: TRow) => string;
  isLoading: boolean;
  /**
   * The rows on screen answer the previous search while a new one is in
   * flight. They stay readable and fade, rather than being replaced by a
   * skeleton the reader has already read past.
   */
  isRefreshing?: boolean | undefined;
  layout: TLayout;
  onLayoutChange: (layout: TLayout) => void;
  rowHost: TableRowHost<TRow>;
  rows: TRow[];
  selection?: PublicLawTableSelection | undefined;
};

const NO_SELECTION: RowSelectionState = {};

export const PublicLawTable = <
  TRow extends PublicLawRowData,
  TLayout extends PublicLawTableLayout,
>({
  columns,
  emptyState,
  expectedRowCount,
  findHighlight = null,
  firstRowNumber,
  getRowId,
  isLoading,
  isRefreshing = false,
  layout,
  onLayoutChange,
  rowHost,
  rows,
  selection,
}: PublicLawTableProps<TRow, TLayout>) => {
  const t = useTranslations();
  const selectedIds = selection?.selectedIds;
  const rowSelection: RowSelectionState = useMemo(() => {
    if (selectedIds === undefined) {
      return NO_SELECTION;
    }
    const picked: RowSelectionState = {};
    for (const id of selectedIds) {
      picked[id] = true;
    }
    return picked;
  }, [selectedIds]);

  const tableState = useTableState({
    columnLayout: {
      hidden: layout.hidden,
      order: layout.order,
      pinned: layout.pinned,
      onChange: ({ hidden, order, pinned }) => {
        onLayoutChange({
          ...layout,
          ...(hidden === undefined ? {} : { hidden }),
          ...(order === undefined ? {} : { order }),
          ...(pinned === undefined ? {} : { pinned }),
        });
      },
    },
    columnSizing: {
      sizing: layout.sizing,
      onChange: (sizing) => onLayoutChange({ ...layout, sizing }),
    },
    rowSelection: {
      selection: rowSelection,
      onChange: (updater) => {
        if (selection === undefined) {
          return;
        }
        const next =
          typeof updater === "function" ? updater(rowSelection) : updater;
        // A selection map holds only picked rows, so its keys are the selection.
        selection.onSelectedIdsChange(Object.keys(next));
      },
    },
    // The search decides the order; no column of this table does.
    sorting: null,
  });

  const table = useTable({
    features: workspaceTableFeatures,
    columnResizeMode: "onChange",
    data: rows,
    columns,
    defaultColumn: { minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE },
    getRowId,
    // Without a selection to report to, the select column draws row numbers
    // only: no checkbox offers a pick nothing on the page acts on.
    enableRowSelection: selection !== undefined,
    state: tableState.state,
    ...tableState.listeners,
  });

  return (
    <MobileTableOrientationGate>
      <div
        aria-busy={isRefreshing}
        className={cn(
          // The table owns its scroll: it claims the height the page gives it
          // rather than growing to its rows. Without a bounded box the
          // virtualizer's scroll element never scrolls, so every row is drawn
          // and the frozen header has nothing to freeze against.
          "border-border/45 bg-background/60 flex min-h-64 flex-1 flex-col overflow-hidden rounded-md border transition-opacity duration-200",
          isRefreshing && "opacity-56",
        )}
      >
        <FindHighlightScope highlight={findHighlight}>
          <WorkspaceTable
            contentMode={layout.contentMode}
            // A results list is as tall as its results. The end filler has
            // nothing to fill here and nothing to add at the end of, so it
            // would draw as one empty bordered row under the last result.
            fillHeight={false}
            firstRowNumber={firstRowNumber}
            rowHost={rowHost}
            skeletonRowCount={
              isLoading ? tableSkeletonRowCount(expectedRowCount) : 0
            }
            table={table}
          />
        </FindHighlightScope>
        {rows.length === 0 &&
          !isLoading &&
          (emptyState ?? (
            <div className="text-muted-foreground p-4 text-sm">
              {t("common.noResults")}
            </div>
          ))}
      </div>
    </MobileTableOrientationGate>
  );
};

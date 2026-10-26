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

import { applyPublicLawSizingChange } from "@/components/public-law-table/public-law-table-layout.logic";
import type {
  PublicLawTableLayout,
  PublicLawTableLayoutUpdate,
} from "@/components/public-law-table/public-law-table-layout.logic";
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
  onLayoutChange: (update: PublicLawTableLayoutUpdate<TLayout>) => void;
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
        onLayoutChange((latest) => ({
          ...latest,
          ...(hidden === undefined ? {} : { hidden }),
          ...(order === undefined ? {} : { order }),
          ...(pinned === undefined ? {} : { pinned }),
        }));
      },
    },
    columnSizing: {
      sizing: layout.sizing,
      onChange: (sizing) =>
        onLayoutChange((latest) => ({
          ...latest,
          sizing: applyPublicLawSizingChange({
            previous: layout.sizing,
            next: sizing,
            latest: latest.sizing,
          }),
        })),
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
        {rows.length === 0 && !isLoading && (
          // The table stays a table when nothing matched: a few blurred rows
          // where results would be, and what to do next over them, rather
          // than a header above a blank box with a line of text far below.
          <div className="relative min-h-56 flex-1">
            <EmptyRowsBackdrop />
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="bg-background border-border/70 w-full max-w-md rounded-lg border p-4 shadow-xs">
                {emptyState ?? (
                  <p className="text-muted-foreground text-center text-sm">
                    {t("common.noResults")}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </MobileTableOrientationGate>
  );
};

/**
 * Rows' worth of shape behind the empty-results card. Decoration only: hidden
 * from assistive technology, still, and blurred so it never reads as rows
 * still loading.
 */
const EmptyRowsBackdrop = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none flex flex-col blur-xs select-none"
  >
    <BackdropRow textClassName="w-3/4" />
    <BackdropRow textClassName="w-2/3" />
    <BackdropRow textClassName="w-5/6" />
    <BackdropRow textClassName="w-1/2" />
    <BackdropRow textClassName="w-3/5" />
  </div>
);

const BackdropRow = ({ textClassName }: { textClassName: string }) => (
  <div className="border-border/45 flex items-center gap-4 border-b px-3 py-3">
    <span className="bg-muted h-3 w-20 shrink-0 rounded-sm" />
    <span className={cn("bg-muted h-3 rounded-sm", textClassName)} />
  </div>
);

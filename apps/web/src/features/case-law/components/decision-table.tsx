/**
 * The public results table.
 *
 * It is the workspace table: the same shell, the same header menus, the same
 * column drag-and-drop, pinning and resizing, the same field-value cell for an
 * AI answer and the same justification card behind it. What this module adds is
 * the decision half — the rows, their columns, and where a reader's
 * arrangement of them is kept — so a decision reads the same here as in a
 * matter, and neither table can drift from the other.
 */

import { useMemo } from "react";

import { useTable } from "@tanstack/react-table";
import type { RowSelectionState } from "@tanstack/react-table";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import { FindHighlightScope } from "@/components/workspaces/table/find-highlight";
import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-schema";
import type { DecisionRowData } from "@/components/workspaces/table/types";
import { useTableState } from "@/components/workspaces/table/use-table-state";
import { WorkspaceTable } from "@/components/workspaces/table/workspace-table/workspace-table";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import type { DecisionExtraColumn } from "@/features/case-law/decision-columns.logic";
import { useDecisionRowHost } from "@/features/case-law/decision-row-host";
import {
  DecisionRenderScope,
  useDecisionTableColumns,
} from "@/features/case-law/decision-table-columns";
import { queryHighlightTokens } from "@/features/case-law/headnote-highlight.logic";
import type { QuestionColumnSurface } from "@/features/case-law/research/question-columns.logic";

export type { Decision } from "@/features/case-law/components/decision-cells";

type DecisionTableProps = {
  decisions: readonly Decision[];
  /** Columns this screen adds to the shared model; none on the results page. */
  extraColumns?: readonly DecisionExtraColumn[] | undefined;
  /** The find's marks, or null when no term is applied. */
  findHighlight?: TableFindHighlight | null | undefined;
  isLoading: boolean;
  /**
   * The rows on screen answer the previous search while a new one is in
   * flight. They stay readable and fade, rather than being replaced by a
   * skeleton the reader has already read past.
   */
  isRefreshing?: boolean | undefined;
  layout: DecisionTableLayout;
  onLayoutChange: (layout: DecisionTableLayout) => void;
  onSelectedIdsChange: (decisionIds: string[]) => void;
  /** What was searched for, so the summary cell can say why a row matched. */
  query?: string | undefined;
  questions: QuestionColumnSurface;
  selectedIds: readonly string[];
};

export const DecisionTable = ({
  decisions,
  extraColumns,
  findHighlight = null,
  isLoading,
  isRefreshing = false,
  layout,
  onLayoutChange,
  onSelectedIdsChange,
  query,
  questions,
  selectedIds,
}: DecisionTableProps) => {
  const t = useTranslations();
  const columns = useDecisionTableColumns({ extraColumns, questions });
  const rows = useMemo(
    () =>
      decisions.map((decision): DecisionRowData => ({
        kind: "decision",
        decision,
        children: [],
      })),
    [decisions],
  );
  const rowSelection: RowSelectionState = useMemo(() => {
    const selection: RowSelectionState = {};
    for (const decisionId of selectedIds) {
      selection[decisionId] = true;
    }
    return selection;
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
        const next =
          typeof updater === "function" ? updater(rowSelection) : updater;
        // A selection map holds only picked rows, so its keys are the selection.
        onSelectedIdsChange(Object.keys(next));
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
    getRowId: (row) => row.decision.id,
    state: tableState.state,
    ...tableState.listeners,
  });

  // The rail is a write affordance: a reader the organization has not granted
  // `create` gets the table without it, not a trigger that fails on submit.
  const rowHost = useDecisionRowHost(
    questions.type === "available" && questions.grants.create
      ? {
          addColumnRail: (
            <BulkAddColumns
              target={{
                kind: "organisation",
                suggestion: questions.suggestion,
              }}
              triggerVariant="rail"
            />
          ),
        }
      : {},
  );

  const renderScope = useMemo(
    () => ({
      contentMode: layout.contentMode,
      queryTokens: queryHighlightTokens(query),
    }),
    [layout.contentMode, query],
  );

  return (
    <MobileTableOrientationGate>
      <div
        aria-busy={isRefreshing}
        className={cn(
          "border-border/45 bg-background/60 flex min-h-64 flex-col overflow-hidden rounded-md border transition-opacity duration-200",
          isRefreshing && "opacity-56",
        )}
      >
        <DecisionRenderScope value={renderScope}>
          <FindHighlightScope highlight={findHighlight}>
            <WorkspaceTable
              contentMode={layout.contentMode}
              rowHost={rowHost}
              table={table}
            />
          </FindHighlightScope>
        </DecisionRenderScope>
        {rows.length === 0 && (
          <div className="text-muted-foreground flex flex-col gap-2 p-4 text-sm">
            {isLoading ? (
              <>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </>
            ) : (
              t("common.noResults")
            )}
          </div>
        )}
      </div>
    </MobileTableOrientationGate>
  );
};

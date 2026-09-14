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

import { useMemo, useState } from "react";

import { useTable } from "@tanstack/react-table";
import type { RowSelectionState } from "@tanstack/react-table";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import { queryHighlightTokens } from "@/components/legal-reader/query-marks";
import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import { FindHighlightScope } from "@/components/workspaces/table/find-highlight";
import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-schema";
import type { DecisionRowData } from "@/components/workspaces/table/types";
import { useTableState } from "@/components/workspaces/table/use-table-state";
import { tableSkeletonRowCount } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";
import { WorkspaceTable } from "@/components/workspaces/table/workspace-table/workspace-table";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import type { DecisionExtraColumn } from "@/features/case-law/decision-columns.logic";
import { useDecisionRowHost } from "@/features/case-law/decision-row-host";
import {
  DecisionRenderScope,
  useDecisionTableColumns,
} from "@/features/case-law/decision-table-columns";
import type { QuestionColumnSurface } from "@/features/case-law/research/question-columns.logic";

export type { Decision } from "@/features/case-law/components/decision-cells";

const NO_EXPANDED_HEADNOTES: ReadonlySet<string> = new Set();

/** The same set with one row's headnote flipped between preview and whole. */
const withHeadnoteToggled = (
  current: ReadonlySet<string>,
  decisionId: string,
): ReadonlySet<string> => {
  const next = new Set(current);
  if (!next.delete(decisionId)) {
    next.add(decisionId);
  }
  return next;
};

type DecisionTableProps = {
  decisions: readonly Decision[];
  /**
   * How many rows the page being loaded will hold, so the waiting table stands
   * in at that size. Defaults to a compact stand-in where a screen cannot say.
   */
  expectedRowCount?: number | undefined;
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
  /**
   * The query the rows answer, which is not always the one the URL asks
   * for while a refresh is in flight: see `queryAnsweredByRows`. Every
   * cell's marks and every link out of a row are drawn from it.
   */
  query?: string | undefined;
  questions: QuestionColumnSurface;
  selectedIds: readonly string[];
};

export const DecisionTable = ({
  decisions,
  expectedRowCount,
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
  const rowHost = useDecisionRowHost({
    searchQuery: query,
    ...(questions.type === "available" && questions.grants.create
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
      : {}),
  });

  // Which rows are showing their whole headnote is about this screenful of
  // results and nothing else: it is not worth a URL, and a new search leaves
  // the ids behind with the rows they belonged to.
  const [expandedHeadnoteIds, setExpandedHeadnoteIds] = useState<
    ReadonlySet<string>
  >(NO_EXPANDED_HEADNOTES);

  const renderScope = useMemo(
    () => ({
      contentMode: layout.contentMode,
      expandedHeadnoteIds,
      onToggleHeadnote: (decisionId: string) => {
        setExpandedHeadnoteIds((current) =>
          withHeadnoteToggled(current, decisionId),
        );
      },
      queryTokens: queryHighlightTokens(query),
      searchQuery: query,
    }),
    [expandedHeadnoteIds, layout.contentMode, query],
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
              // A results list is as tall as its results. The end filler has
              // nothing to fill here and nothing to add at the end of, so it
              // would draw as one empty bordered row under the last decision.
              fillHeight={false}
              rowHost={rowHost}
              skeletonRowCount={
                isLoading ? tableSkeletonRowCount(expectedRowCount) : 0
              }
              table={table}
            />
          </FindHighlightScope>
        </DecisionRenderScope>
        {rows.length === 0 && !isLoading && (
          <div className="text-muted-foreground p-4 text-sm">
            {t("common.noResults")}
          </div>
        )}
      </div>
    </MobileTableOrientationGate>
  );
};

/**
 * Decisions in the public-law results table.
 *
 * The table is the shared one (`PublicLawTable`, itself the workspace table);
 * what this module adds is the decision half — the rows, their columns, the
 * render scope every decision cell reads, and the rail that adds a question —
 * so a decision reads the same here as in a matter, and the decision and
 * statute tables cannot drift from each other.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { queryHighlightTokens } from "@/components/legal-reader/query-marks";
import { PublicLawTable } from "@/components/public-law-table/public-law-table";
import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import type { DecisionRowData } from "@/components/workspaces/table/types";
import type { Decision } from "@/features/case-law/components/decision-cells";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import type { DecisionExtraColumn } from "@/features/case-law/decision-columns.logic";
import { useDecisionRowHost } from "@/features/case-law/decision-row-host";
import {
  DecisionRenderScope,
  useDecisionTableColumns,
} from "@/features/case-law/decision-table-columns";
import {
  AddQuestionColumn,
  questionColumnAddAction,
} from "@/features/case-law/research/add-question-column";
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

const decisionRowId = (row: DecisionRowData): string => row.decision.id;

type DecisionTableProps = {
  decisions: readonly Decision[];
  /** The ordinal of the first row: a page's first position in the whole list. */
  firstRowNumber: number;
  /** See `PublicLawTable`. */
  emptyState?: ReactNode | undefined;
  /** See `PublicLawTable`. */
  expectedRowCount?: number | undefined;
  /** Columns this screen adds to the shared model; none on the results page. */
  extraColumns?: readonly DecisionExtraColumn[] | undefined;
  /** The find's marks, or null when no term is applied. */
  findHighlight?: TableFindHighlight | null | undefined;
  isLoading: boolean;
  /** See `PublicLawTable`. */
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
  emptyState,
  expectedRowCount,
  extraColumns,
  findHighlight = null,
  firstRowNumber,
  isLoading,
  isRefreshing = false,
  layout,
  onLayoutChange,
  onSelectedIdsChange,
  query,
  questions,
  selectedIds,
}: DecisionTableProps) => {
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
  const selection = useMemo(
    () => ({ onSelectedIdsChange, selectedIds }),
    [onSelectedIdsChange, selectedIds],
  );

  // The rail is a transparent strip pinned over the table's end columns, so it
  // is reserved only where it actually carries a control; otherwise it would
  // swallow clicks on the cells beneath it.
  const rowHost = useDecisionRowHost({
    searchQuery: query,
    ...(questionColumnAddAction(questions) === null
      ? {}
      : {
          addColumnRail: (
            <AddQuestionColumn surface={questions} triggerVariant="rail" />
          ),
        }),
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
    <DecisionRenderScope value={renderScope}>
      <PublicLawTable
        columns={columns}
        emptyState={emptyState}
        expectedRowCount={expectedRowCount}
        findHighlight={findHighlight}
        firstRowNumber={firstRowNumber}
        getRowId={decisionRowId}
        isLoading={isLoading}
        isRefreshing={isRefreshing}
        layout={layout}
        onLayoutChange={onLayoutChange}
        rowHost={rowHost}
        rows={rows}
        selection={selection}
      />
    </DecisionRenderScope>
  );
};

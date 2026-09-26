/**
 * What each decision column draws.
 *
 * The mirror of the matter table's column factory, over the decision half of
 * the column union: the descriptors say which columns exist and what a reader
 * may do to them, and this turns each into the definition the table library
 * wants. The switch is exhaustive, so a member added to the decision half does
 * not compile until it draws.
 */

import { createContext, use, useMemo } from "react";

import { panic } from "better-result";
import {
  CalendarIcon,
  FileDigitIcon,
  FileTextIcon,
  GlobeIcon,
  HashIcon,
  LandmarkIcon,
  LanguagesIcon,
  QuoteIcon,
  ShapesIcon,
  TagIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { MetadataPopover } from "@/components/workspaces/table/metadata-popover";
import type {
  DecisionRowData,
  TableCellContext,
  TableColumnDef,
  TableHeaderContext,
} from "@/components/workspaces/table/types";
import type { Decision } from "@/features/case-law/components/decision-cells";
import { renderDecisionCell } from "@/features/case-law/decision-columns";
import {
  DECISION_COLUMN_LABEL_KEYS,
  decisionColumnLabelKey,
  decisionIdentityLineFields,
} from "@/features/case-law/decision-columns.logic";
import type {
  DecisionColumnId,
  DecisionContentMode,
  DecisionExtraColumn,
  DecisionReferenceColumnKind,
} from "@/features/case-law/decision-columns.logic";
import {
  decisionTableSchema,
  NO_EXTRA_DECISION_COLUMNS,
} from "@/features/case-law/decision-table-schema";
import type {
  DecisionColumnDescriptor,
  DecisionTableSchema,
} from "@/features/case-law/decision-table-schema";
import { QuestionCell } from "@/features/case-law/research/question-cell";
import { QuestionColumnPopover } from "@/features/case-law/research/question-column-popover";
import {
  allowedColumnActions,
  NO_QUESTION_COLUMNS,
} from "@/features/case-law/research/question-columns.logic";
import type {
  AvailableQuestionColumns,
  QuestionColumnSurface,
} from "@/features/case-law/research/question-columns.logic";

/** The icon each decision column wears in its header menu and the chooser. */
export const DECISION_COLUMN_ICONS = {
  caseNumber: FileDigitIcon,
  summary: FileTextIcon,
  court: LandmarkIcon,
  country: GlobeIcon,
  date: CalendarIcon,
  type: ShapesIcon,
  headnote: QuoteIcon,
  citedBy: HashIcon,
  language: LanguagesIcon,
} as const satisfies Record<DecisionColumnId, LucideIcon>;

/**
 * The decision field a column stands for. Not what the cell draws — that is
 * `renderDecisionCell` — but the value the table reads for the column, so a
 * column always names one field of the row rather than a rendered node.
 */
const DECISION_ACCESSORS = {
  caseNumber: "caseNumber",
  summary: "headnote",
  court: "court",
  country: "country",
  date: "decisionDate",
  type: "decisionType",
  headnote: "headnote",
  citedBy: "citationCount",
  language: "language",
} as const satisfies Record<DecisionColumnId, keyof Decision>;

/**
 * What every decision cell needs and no column carries: how much of a prose
 * cell to show, and the words the search matched. Through a context rather
 * than through the column definitions, because both change while the columns
 * do not, and rebuilding the definitions is what loops a controlled table.
 */
type DecisionRenderScopeValue = {
  contentMode: DecisionContentMode;
  /** The rows whose cut headnote the reader asked to see whole. */
  expandedHeadnoteIds: ReadonlySet<string>;
  onToggleHeadnote: (decisionId: string) => void;
  queryTokens: readonly string[];
  /** The query as typed, which every gesture that opens a row carries with it. */
  searchQuery: string | undefined;
};

const NO_QUERY_TOKENS: readonly string[] = [];
const NO_EXPANDED_HEADNOTES: ReadonlySet<string> = new Set();

const DecisionRenderScopeContext = createContext<DecisionRenderScopeValue>({
  contentMode: "tight",
  expandedHeadnoteIds: NO_EXPANDED_HEADNOTES,
  // A cell drawn outside a table has nowhere to keep the expansion; reading
  // the default rather than a provider is a defect, not a row that cannot
  // expand.
  onToggleHeadnote: () =>
    panic("Decision cell rendered outside a decision render scope"),
  queryTokens: NO_QUERY_TOKENS,
  searchQuery: undefined,
});

export const DecisionRenderScope = DecisionRenderScopeContext.Provider;

/** What the table is showing, for the parts of a row that are not a cell. */
export const useDecisionRenderScope = (): DecisionRenderScopeValue =>
  use(DecisionRenderScopeContext);

type UseDecisionTableColumnsOptions = {
  /** Columns only the calling screen has; none on the results page. */
  extraColumns?: readonly DecisionExtraColumn[] | undefined;
  /** The organization's questions and what may be done to one. */
  questions: QuestionColumnSurface;
  /** What the case-number column holds across the rows shown. */
  referenceKind: DecisionReferenceColumnKind;
};

/** The decision table's schema, with the labels resolved for the reader. */
export const useDecisionTableSchema = ({
  extraColumns = NO_EXTRA_DECISION_COLUMNS,
  questions,
  referenceKind,
}: UseDecisionTableColumnsOptions): DecisionTableSchema => {
  const t = useTranslations();
  const questionColumns =
    questions.type === "available" ? questions.columns : NO_QUESTION_COLUMNS;
  // The add-column column is the way into writing a question, which a reader
  // without an account is offered too; only a surface with nothing to ask of
  // drops it.
  const withQuestionSurface = questions.type !== "hidden";

  return useMemo(
    () =>
      decisionTableSchema({
        extraColumns,
        labels: {
          caseNumber: t(decisionColumnLabelKey("caseNumber", referenceKind)),
          summary: t(DECISION_COLUMN_LABEL_KEYS.summary),
          court: t(DECISION_COLUMN_LABEL_KEYS.court),
          country: t(DECISION_COLUMN_LABEL_KEYS.country),
          date: t(DECISION_COLUMN_LABEL_KEYS.date),
          type: t(DECISION_COLUMN_LABEL_KEYS.type),
          headnote: t(DECISION_COLUMN_LABEL_KEYS.headnote),
          citedBy: t(DECISION_COLUMN_LABEL_KEYS.citedBy),
          language: t(DECISION_COLUMN_LABEL_KEYS.language),
        },
        questionColumns,
        withQuestionSurface,
      }),
    [extraColumns, questionColumns, referenceKind, t, withQuestionSurface],
  );
};

export const useDecisionTableColumns = ({
  extraColumns,
  questions,
  referenceKind,
}: UseDecisionTableColumnsOptions): TableColumnDef<DecisionRowData>[] => {
  const schema = useDecisionTableSchema({
    extraColumns,
    questions,
    referenceKind,
  });
  const available = questions.type === "available" ? questions : null;

  return useMemo(
    () =>
      schema.columns.map((column) => toDecisionColumnDef(column, available)),
    [available, schema.columns],
  );
};

const renderNothing = () => null;

/** Null for a reader whose surface hides the questions; no cell is drawn then. */
const toDecisionColumnDef = (
  column: DecisionColumnDescriptor,
  questions: AvailableQuestionColumns | null,
): TableColumnDef<DecisionRowData> => {
  const base = {
    id: column.id,
    size: column.size,
    ...(column.minSize === undefined ? {} : { minSize: column.minSize }),
    enableSorting: column.capabilities.sort,
    enableHiding: column.capabilities.hide,
    enableResizing: column.capabilities.resize,
    enablePinning: column.capabilities.pin,
    ...(column.emphasis === "metadata" ? { meta: { muted: true } } : {}),
  };
  const { render } = column;

  switch (render.type) {
    case "select":
      return { ...base, accessorKey: column.id, header: renderNothing };
    case "add-property":
      return {
        ...base,
        accessorKey: column.id,
        header: renderNothing,
        cell: renderNothing,
      };
    case "decision": {
      const decisionColumn = render.column;
      return {
        ...base,
        accessorFn: (row) => row.decision[DECISION_ACCESSORS[decisionColumn]],
        header: ({ header }: TableHeaderContext<unknown, DecisionRowData>) => (
          <MetadataPopover
            column={header.column}
            icon={DECISION_COLUMN_ICONS[decisionColumn]}
            label={column.label}
          />
        ),
        cell: ({ row, table }: TableCellContext<unknown, DecisionRowData>) => (
          <DecisionCell
            column={decisionColumn}
            decision={row.original.decision}
            visibleColumnIds={table
              .getVisibleLeafColumns()
              .map((visible) => visible.id)}
          />
        ),
      };
    }
    case "decision-extra": {
      const extra = render.column;
      return {
        ...base,
        accessorKey: column.id,
        header: ({ header }: TableHeaderContext<unknown, DecisionRowData>) => (
          <MetadataPopover
            column={header.column}
            icon={TagIcon}
            label={column.label}
          />
        ),
        cell: ({ row }: TableCellContext<unknown, DecisionRowData>) =>
          extra.render(row.original.decision),
      };
    }
    case "question": {
      const questionColumn = render.column;
      return {
        ...base,
        accessorKey: column.id,
        header: ({ header }: TableHeaderContext<unknown, DecisionRowData>) => (
          <QuestionColumnPopover
            actions={
              questions === null ? [] : allowedColumnActions(questions.grants)
            }
            column={header.column}
            question={questionColumn}
            {...(questions === null
              ? {}
              : { onAction: questions.onColumnAction })}
          />
        ),
        cell: ({ row }: TableCellContext<unknown, DecisionRowData>) =>
          questions === null ? null : (
            <QuestionCell
              answersByKey={questions.answersByKey}
              column={questionColumn}
              decision={row.original.decision}
              onShowPassage={questions.onShowPassage}
              // Answering one failed cell again bills like any other run.
              {...(questions.grants.run
                ? { onRetry: questions.onRetryAnswer }
                : {})}
            />
          ),
      };
    }
    default: {
      render satisfies never;
      return panic(`Unhandled render: ${String(render)}`);
    }
  }
};

const DecisionCell = ({
  column,
  decision,
  visibleColumnIds,
}: {
  column: DecisionColumnId;
  decision: Decision;
  visibleColumnIds: readonly string[];
}) => {
  const {
    contentMode,
    expandedHeadnoteIds,
    onToggleHeadnote,
    queryTokens,
    searchQuery,
  } = use(DecisionRenderScopeContext);

  return renderDecisionCell({
    column,
    context: {
      contentMode,
      expandedHeadnoteIds,
      onToggleHeadnote,
      // Derived from what is on screen rather than stored, so hiding a column
      // moves its value into the identity line and showing it takes it back.
      identityLineFields: decisionIdentityLineFields(visibleColumnIds),
      queryTokens,
      searchQuery,
    },
    decision,
  });
};

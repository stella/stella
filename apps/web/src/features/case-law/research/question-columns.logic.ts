import {
  answerNeedsRun,
  CASE_LAW_RESEARCH_RUN_DECISIONS_MAX,
} from "@stll/api-contract";
import type {
  CaseLawResearchAnswerState,
  CaseLawResearchAnswerType,
} from "@stll/api-contract";

import type { Decision } from "@/features/case-law/components/decision-cells";
import type {
  JustificationContent,
  WorkspaceFieldContent,
  WorkspaceProperty,
} from "@/lib/types";

/**
 * What a run covers and what it costs, decided before anything is sent.
 *
 * Answers are produced for the rows the reader can see, never for the whole
 * result set: the corpus is millions of decisions and a question asked of all
 * of them is a bill, not a research step. So the run set is the page (or the
 * rows picked out of it), minus every cell that already holds an answer.
 */

/**
 * What a question column expects for an answer: the property content a matter
 * column of the same kind carries, narrowed to the kinds a model can produce.
 * Derived from the property model rather than restated, so a question column
 * and a matter property cannot describe their options differently — which is
 * also what lets one cell renderer draw both.
 */
export type QuestionColumnContent = Extract<
  WorkspaceProperty["content"],
  { type: CaseLawResearchAnswerType }
>;

/** What the question dialog holds: the wording, and what the answer is. */
export type QuestionDraft = {
  question: string;
  content: QuestionColumnContent;
};

/** A question column as the reader describes it, on the way to the endpoint. */
export type QuestionColumnInput = QuestionDraft;

/** One question asked of every decision the organization looks at. */
export type QuestionColumn = QuestionDraft & { id: string };

/**
 * What draws a question column's header and cells. One member of the table's
 * column union, declared here because the public results page cannot reach
 * into a matter's route; the cell it draws is the shared field-value renderer
 * a matter's AI property column draws, because a question column holds the
 * same content a property holds.
 */
export type QuestionColumnRender = {
  type: "question";
  column: QuestionColumn;
};

/**
 * A question column's id in the table. Namespaced, so a question can never
 * collide with a decision column or with either utility column.
 */
export const questionColumnId = (columnId: string): string =>
  `question:${columnId}`;

/** How an answer was produced, kept beside it so a cell can be read back. */
type QuestionAnswerRun = {
  rationale: string;
  /** The cited passages, in the citation shape a workspace justification uses. */
  justification: JustificationContent;
};

/** One cell, as the answer lookup reports it. */
export type QuestionAnswer = {
  columnId: string;
  decisionId: string;
  state: CaseLawResearchAnswerState;
  /** A pending cell whose run went quiet; the server decides, on its clock. */
  stale: boolean;
  answer: WorkspaceFieldContent | null;
  run?: QuestionAnswerRun | null;
};

/** Stable empties: an organization with no questions hands out the same one. */
export const NO_QUESTION_COLUMNS: readonly QuestionColumn[] = [];
export const NO_QUESTION_ANSWERS: readonly QuestionAnswer[] = [];

/** Cells are keyed by column and decision, the way the server stores them. */
export const answerKey = (columnId: string, decisionId: string): string =>
  `${columnId}:${decisionId}`;

/**
 * Whether a run would produce this cell. The contract's policy, which is also
 * what the queue applies, so the count the reader confirms is the count that
 * runs rather than a second opinion that drifts from it.
 */
const needsRun = (answer: QuestionAnswer | undefined): boolean =>
  answerNeedsRun(
    answer === undefined
      ? { state: null, stale: false }
      : { state: answer.state, stale: answer.stale },
  );

type RunSetInput = {
  columns: readonly QuestionColumn[];
  /** Every decision on the page, in the order it is drawn. */
  pageDecisionIds: readonly string[];
  /** The rows the reader picked; none of them still on the page means the page. */
  selectedDecisionIds: readonly string[];
  answersByKey: ReadonlyMap<string, QuestionAnswer>;
  /** One column, or every column when absent. */
  columnId?: string | undefined;
  /** Answer again, even where an answer already stands. */
  force?: boolean | undefined;
};

export type QuestionRunSet = {
  columnIds: string[];
  decisionIds: string[];
  /** Cells the run would produce: what the reader is asked to confirm. */
  cells: number;
};

/**
 * The decisions and columns a run covers, and how many cells that is.
 *
 * A decision stays in the set while any of the chosen columns still wants an
 * answer for it, because the server takes a rectangle of ids and skips the
 * cells that are already answered. `cells` counts the rectangle's holes, not
 * its area, so the number the reader confirms is the number they pay for.
 */
export const questionRunSet = ({
  answersByKey,
  columnId,
  columns,
  force = false,
  pageDecisionIds,
  selectedDecisionIds,
}: RunSetInput): QuestionRunSet => {
  const chosen =
    columnId === undefined
      ? columns
      : columns.filter((column) => column.id === columnId);
  // A selection outlives the rows it named: a query or facet change redraws
  // the page without clearing it. So the mode is decided from what the
  // selection still reaches on this page, and a selection that reaches nothing
  // is no selection at all — the run covers the page the reader is looking at
  // rather than reporting that there is nothing to answer.
  const selected = new Set(selectedDecisionIds);
  const picked = pageDecisionIds.filter((decisionId) =>
    selected.has(decisionId),
  );
  const visible = picked.length === 0 ? pageDecisionIds : picked;

  const decisionIds: string[] = [];
  let cells = 0;
  for (const decisionId of visible) {
    let missing = 0;
    for (const column of chosen) {
      if (
        force ||
        needsRun(answersByKey.get(answerKey(column.id, decisionId)))
      ) {
        missing += 1;
      }
    }
    if (missing > 0) {
      decisionIds.push(decisionId);
      cells += missing;
    }
  }

  return { columnIds: chosen.map((column) => column.id), decisionIds, cells };
};

/**
 * A run set as the endpoint will take it: one request per batch of decisions,
 * because the server refuses a longer list outright. A surface whose rows are
 * a page never has more than one; a saved table that has loaded several pages
 * does, and without the split the whole run would fail validation instead of
 * answering anything.
 */
export const researchRunBatches = (
  decisionIds: readonly string[],
): readonly string[][] => {
  const batches: string[][] = [];
  for (
    let start = 0;
    start < decisionIds.length;
    start += CASE_LAW_RESEARCH_RUN_DECISIONS_MAX
  ) {
    batches.push(
      decisionIds.slice(start, start + CASE_LAW_RESEARCH_RUN_DECISIONS_MAX),
    );
  }
  return batches;
};

/**
 * Whether saving this edit throws the column's answers away.
 *
 * The server trims the wording and drops every answer the column holds the
 * moment the wording or the answer type differs from what is stored, so the
 * dialog warns exactly when that happens: neither on a no-op save nor, in the
 * other direction, silently. Adding a column has nothing to discard.
 */
export const questionEditDiscardsAnswers = ({
  draft,
  stored,
}: {
  draft: QuestionDraft;
  /** Absent while a column is being added. */
  stored: QuestionDraft | undefined;
}): boolean =>
  stored !== undefined &&
  (stored.question.trim() !== draft.question.trim() ||
    stored.content.type !== draft.content.type);

/** What the reader can do to the column a question is asked in. */
export type QuestionColumnAction = "run" | "edit" | "delete";

/** Everything the table needs to draw and work the organization's questions. */
export type AvailableQuestionColumns = {
  type: "available";
  columns: readonly QuestionColumn[];
  answersByKey: ReadonlyMap<string, QuestionAnswer>;
  onColumnAction: (
    column: QuestionColumn,
    action: QuestionColumnAction,
  ) => void;
  /** Asks one failed cell again, from the cell itself. */
  onRetryAnswer: (column: QuestionColumn, decisionId: string) => void;
  /** Opens the decision at a cited passage, with the reader's highlight. */
  onShowPassage: (decision: Decision, anchorId: string) => void;
  /** True while a run is being queued, so every run control settles together. */
  isRunning: boolean;
};

/**
 * How much of the question surface a reader gets.
 *
 * The results page is public. A reader without an organization has nothing to
 * hang a question on and no way to pay for an answer, so they get the plain
 * table: no columns, and, because one answer decides both, no control that
 * would create or run one. `hidden` carries no columns at all, so a reader who
 * signed out cannot be drawn a column the table happens to still hold.
 */
export type QuestionColumnSurface =
  | { type: "hidden" }
  | AvailableQuestionColumns;

export const questionColumnSurface = ({
  hasActiveOrganization,
  ...available
}: Omit<AvailableQuestionColumns, "type"> & {
  hasActiveOrganization: boolean;
}): QuestionColumnSurface =>
  hasActiveOrganization
    ? { type: "available", ...available }
    : { type: "hidden" };

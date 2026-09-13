import {
  answerNeedsRun,
  CASE_LAW_RESEARCH_RUN_DECISIONS_MAX,
} from "@stll/api-contract";
import type {
  CaseLawResearchAnswerState,
  CaseLawResearchAnswerType,
  CaseLawResearchAnswerValue,
  CaseLawResearchAnswerPassage,
} from "@stll/api-contract";

/**
 * What a run covers and what it costs, decided before anything is sent.
 *
 * Answers are produced for the rows the reader can see, never for the whole
 * result set: the corpus is millions of decisions and a question asked of all
 * of them is a bill, not a research step. So the run set is the page (or the
 * rows picked out of it), minus every cell that already holds an answer.
 */

/** What the question dialog holds: the wording, and what the answer is. */
export type QuestionDraft = {
  question: string;
  answerType: CaseLawResearchAnswerType;
};

/** One question asked of every decision the organization looks at. */
export type QuestionColumn = QuestionDraft & { id: string };

/** One cell, as the answer lookup reports it. */
export type QuestionAnswer = {
  columnId: string;
  decisionId: string;
  state: CaseLawResearchAnswerState;
  /** A pending cell whose run went quiet; the server decides, on its clock. */
  stale: boolean;
  answer: CaseLawResearchAnswerValue | null;
  run?: {
    rationale: string;
    passages: readonly CaseLawResearchAnswerPassage[];
  } | null;
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
    stored.answerType !== draft.answerType);

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
  | { type: "available"; columns: readonly QuestionColumn[] };

export const questionColumnSurface = ({
  columns,
  hasActiveOrganization,
}: {
  columns: readonly QuestionColumn[];
  hasActiveOrganization: boolean;
}): QuestionColumnSurface =>
  hasActiveOrganization ? { type: "available", columns } : { type: "hidden" };

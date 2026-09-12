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

/** One question asked of every decision the organization looks at. */
export type QuestionColumn = {
  id: string;
  question: string;
  answerType: CaseLawResearchAnswerType;
};

/** One cell, as the answer lookup reports it. */
export type QuestionAnswer = {
  columnId: string;
  decisionId: string;
  state: CaseLawResearchAnswerState;
  answer: CaseLawResearchAnswerValue | null;
  confidence: number | null;
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
 * Whether a cell already holds something a run would not improve. A failed or
 * refused cell is a finished answer: running it again asks the same model the
 * same question about the same text, and a `not_allowed` decision will never
 * be allowed by a retry.
 */
const isAnswered = (answer: QuestionAnswer | undefined): boolean =>
  answer !== undefined && answer.state !== "pending";

type RunSetInput = {
  columns: readonly QuestionColumn[];
  /** Every decision on the page, in the order it is drawn. */
  pageDecisionIds: readonly string[];
  /** The rows the reader picked; empty means the whole page. */
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
  const selected = new Set(selectedDecisionIds);
  const visible =
    selected.size === 0
      ? pageDecisionIds
      : pageDecisionIds.filter((decisionId) => selected.has(decisionId));

  const decisionIds: string[] = [];
  let cells = 0;
  for (const decisionId of visible) {
    let missing = 0;
    for (const column of chosen) {
      if (
        force ||
        !isAnswered(answersByKey.get(answerKey(column.id, decisionId)))
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

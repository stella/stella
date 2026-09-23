import {
  answerNeedsRun,
  CASE_LAW_RESEARCH_RUN_DECISIONS_MAX,
  CASE_LAW_RESEARCH_SUGGEST_SAMPLES_MAX,
} from "@stll/api-contract";
import type {
  CaseLawResearchAnswerFailureReason,
  CaseLawResearchAnswerState,
  CaseLawResearchAnswerType,
} from "@stll/api-contract";
import type { PermissionInput } from "@stll/permissions";

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
  /** Why a `failed` cell failed; null in every other state. */
  failureReason: CaseLawResearchAnswerFailureReason | null;
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
const needsRun = (
  answer: QuestionAnswer | undefined,
  force: boolean,
): boolean =>
  answerNeedsRun(
    answer === undefined
      ? { state: null, stale: false, force }
      : { state: answer.state, stale: answer.stale, force },
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
      if (needsRun(answersByKey.get(answerKey(column.id, decisionId)), force)) {
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
 * One content document as a string that depends on nothing but its values.
 *
 * The server decides on structural equality over the whole document, so the
 * dialog has to as well; comparing the fields it happens to know about would
 * go blind the moment the content model grows one. Key order is not part of
 * the meaning: the stored content comes back from a JSONB column, the draft is
 * built by the composer, and the two order their keys differently.
 */
const contentFingerprint = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(contentFingerprint).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = new Map(Object.entries(value));
    // Code-unit order, not collation: these are field names, not words.
    const fields = [...entries.keys()]
      .filter((key) => entries.get(key) !== undefined)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${contentFingerprint(entries.get(key))}`,
      );
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * Whether saving this edit throws the column's answers away.
 *
 * The server trims the wording and drops every answer the column holds the
 * moment the wording or the content differs from what is stored, so the dialog
 * warns exactly when that happens: neither on a no-op save nor, in the other
 * direction, silently. The content is the whole document, options included —
 * an answer holding an option the column no longer offers is not an answer any
 * more. Adding a column has nothing to discard.
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
    contentFingerprint(stored.content) !== contentFingerprint(draft.content));

/**
 * The decisions a question is being written for: the search that returned
 * them, and the rows drawn from it. A matter's linked decisions were never
 * searched for and span jurisdictions, so it carries neither a country nor a
 * query — only the rows.
 */
export type QuestionSuggestionScope = {
  country: string | undefined;
  query: string | undefined;
  filters: {
    court: string | undefined;
    decisionType: string | undefined;
    dateFrom: string | undefined;
    dateTo: string | undefined;
    language: string | undefined;
  };
  /** Every decision on the page, in the order it is drawn. */
  decisionIds: readonly string[];
};

/** The search half of the scope; the rows come from the surface drawing them. */
export type QuestionSuggestionSearch = Omit<
  QuestionSuggestionScope,
  "decisionIds"
>;

/** A listing that was never searched for: a matter's links, for instance. */
export const UNSEARCHED_SCOPE: QuestionSuggestionSearch = {
  country: undefined,
  query: undefined,
  filters: {
    court: undefined,
    decisionType: undefined,
    dateFrom: undefined,
    dateTo: undefined,
    language: undefined,
  },
};

type QuestionSuggestionInput = {
  draft: QuestionDraft;
  /** The adjustment the reader picked, or typed. */
  instruction: string;
  scope: QuestionSuggestionScope;
};

/**
 * A suggestion request as the endpoint takes it.
 *
 * Only decision IDS travel: the server reads those decisions through the
 * public gate and quotes their published headnotes itself, so no decision text
 * ever leaves the client. The list is cut to the sample allowance here as well
 * as refused past it there, so a page of rows asks for a suggestion rather
 * than losing it to a validation error.
 */
export const questionSuggestionBody = ({
  draft,
  instruction,
  scope,
}: QuestionSuggestionInput) => ({
  question: draft.question.trim(),
  answerKind: draft.content.type,
  ...(draft.content.type === "single-select" ||
  draft.content.type === "multi-select"
    ? { options: draft.content.options }
    : {}),
  instruction,
  ...(scope.country === undefined ? {} : { country: scope.country }),
  ...(scope.query === undefined ? {} : { query: scope.query }),
  filters: setFilters(scope.filters),
  decisionIds: scope.decisionIds.slice(
    0,
    CASE_LAW_RESEARCH_SUGGEST_SAMPLES_MAX,
  ),
});

/** A filter the reader has not set is absent from the body, never undefined. */
const setFilters = ({
  court,
  dateFrom,
  dateTo,
  decisionType,
  language,
}: QuestionSuggestionScope["filters"]) => ({
  ...(court === undefined ? {} : { court }),
  ...(decisionType === undefined ? {} : { decisionType }),
  ...(dateFrom === undefined ? {} : { dateFrom }),
  ...(dateTo === undefined ? {} : { dateTo }),
  ...(language === undefined ? {} : { language }),
});

/** What the reader can do to the column a question is asked in, in menu order. */
const QUESTION_COLUMN_ACTIONS = ["edit", "run", "delete"] as const;

export type QuestionColumnAction = (typeof QUESTION_COLUMN_ACTIONS)[number];

/**
 * What the organization grants this reader over its questions, one flag per
 * action of the `caseLawResearch` resource. Derived from the permission
 * statement rather than restated, so an action added there does not compile
 * until the surface decides what it means.
 */
export type QuestionColumnGrants = Record<
  NonNullable<PermissionInput["caseLawResearch"]>[number],
  boolean
>;

/** A reader who may read the answers and change nothing. */
export const READ_ONLY_QUESTIONS = {
  create: false,
  update: false,
  delete: false,
  run: false,
} as const satisfies QuestionColumnGrants;

// Which grant each header action spends. Editing the wording and moving a
// column are both `update`; answering again spends `run` because it bills.
const COLUMN_ACTION_GRANT = {
  edit: "update",
  run: "run",
  delete: "delete",
} as const satisfies Record<QuestionColumnAction, keyof QuestionColumnGrants>;

/**
 * The header actions this reader may take, in menu order. A reader who holds
 * none gets a header that names the question and nothing else — the columns
 * and their answers stay readable, because reading them is not a grant.
 */
export const allowedColumnActions = (
  grants: QuestionColumnGrants,
): readonly QuestionColumnAction[] =>
  QUESTION_COLUMN_ACTIONS.filter(
    (action) => grants[COLUMN_ACTION_GRANT[action]],
  );

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
  /**
   * What this reader may do to the questions. Read separately from the surface
   * itself: a member of the organization without the grants still reads the
   * columns and their answers, and is simply offered nothing to change.
   */
  grants: QuestionColumnGrants;
  /**
   * What a newly written question's suggested wording is grounded in. It lives
   * on the available surface because the composer that uses it is drawn from
   * the same answer: a reader who gets no columns gets no way to add one.
   */
  suggestion: QuestionSuggestionScope;
};

/**
 * A reader without an organization, on a surface that asks questions. The
 * columns and the answers belong to an organization, so there are none to
 * draw and none to read; writing a question is still offered, and the account
 * is asked for the moment the composer would open. Nothing here reads the
 * organization's columns, so no request is spent on a reader who has none.
 */
type GatedQuestionColumns = {
  type: "gated";
  /** What a newly written question would be grounded in; needs no account. */
  suggestion: QuestionSuggestionScope;
};

/**
 * How much of the question surface a reader gets.
 *
 * A surface with nothing to ask of — a matter with no decision linked — is
 * `hidden`: no columns, and no control over columns it would have to read the
 * organization to draw. It carries no columns at all, so a reader who signed
 * out cannot be drawn a column the table happens to still hold.
 *
 * The results page is public, so a reader without an organization gets
 * `gated`: the same table, and the same way into writing a question, with the
 * account asked for at that step rather than by removing the control.
 *
 * Holding no grant is neither of those. A member the organization has not
 * licensed to author or run questions still belongs to it, so they get the
 * available surface and read every column and answer on it; `grants` decides
 * what they are offered, not whether they see the work.
 */
export type QuestionColumnSurface =
  | { type: "hidden" }
  | AvailableQuestionColumns
  | GatedQuestionColumns;

export const questionColumnSurface = ({
  activeOrganizationId,
  enabled,
  ...available
}: Omit<AvailableQuestionColumns, "type"> & {
  /** The organization the questions belong to; null for a reader without one. */
  activeOrganizationId: string | null;
  /** Whether this surface has anything to ask a question of. */
  enabled: boolean;
}): QuestionColumnSurface => {
  if (!enabled) {
    return { type: "hidden" };
  }

  return activeOrganizationId === null
    ? { type: "gated", suggestion: available.suggestion }
    : { type: "available", ...available };
};

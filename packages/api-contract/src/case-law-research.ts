import { panic } from "better-result";

import type { PropertyContentType } from "./entity-find";

/**
 * Question columns and their answers.
 *
 * A question column belongs to the organization: every member sees it, and an
 * answer keyed `(columnId, decisionId)` is reusable on every search that
 * surfaces the decision. Rows are the public corpus itself, addressed by
 * decision id; nothing about a decision is copied.
 */

/**
 * What a question column expects for an answer: the property content types a
 * model can produce a value for.
 *
 * Derived from `PROPERTY_CONTENT_TYPES`, not a second list: a question column
 * is a matter property asked of a decision instead of an entity, so the two
 * cannot answer "which kinds are there?" differently. The three exclusions are
 * the kinds a person enters by hand — a file is uploaded, a money amount needs
 * a currency the model cannot choose, and a person resolves to a member — and
 * they are exactly the kinds the workspace extractor never schedules.
 *
 * There is no boolean kind in the property model, so a yes/no question is a
 * single-select over two options. The text not settling a question is the
 * `not_stated` cell state, the same for every kind.
 */
type HandEnteredType = "file" | "money" | "person";

export type CaseLawResearchAnswerType = Exclude<
  PropertyContentType,
  HandEnteredType
>;

type CompleteAnswerTypes<T extends readonly CaseLawResearchAnswerType[]> =
  Exclude<CaseLawResearchAnswerType, T[number]> extends never ? T : never;

const answerTypes = [
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
] as const;

/** Every answer kind, in the order a column picker offers them. */
export const CASE_LAW_RESEARCH_ANSWER_TYPES =
  answerTypes satisfies CompleteAnswerTypes<typeof answerTypes>;

/** Select options a question column may carry; a column picker's practical cap. */
export const CASE_LAW_RESEARCH_COLUMN_OPTIONS_MAX = 20;

/** A question's wording; longer text is a prompt, not a column header. */
export const CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH = 500;

/**
 * Where one cell stands. A cell is never silently empty: `pending` while a run
 * is queued or working, `not_stated` when the decision does not say (any kind
 * of column can end there), `not_allowed` when the source's terms withhold
 * derived AI use, `failed` when the model or the corpus refused.
 */
export const CASE_LAW_RESEARCH_ANSWER_STATES = [
  "pending",
  "answered",
  "not_stated",
  "not_allowed",
  "failed",
] as const;

export type CaseLawResearchAnswerState =
  (typeof CASE_LAW_RESEARCH_ANSWER_STATES)[number];

/** Why a cell ended `failed`; a class, never the provider's wording. */
export const CASE_LAW_RESEARCH_ANSWER_FAILURE_REASONS = [
  "decision_unavailable",
  "no_text",
  "model_error",
  "missing_answer",
  "wrong_type",
  /** The run itself failed before it could classify the cell. */
  "run_error",
] as const;

export type CaseLawResearchAnswerFailureReason =
  (typeof CASE_LAW_RESEARCH_ANSWER_FAILURE_REASONS)[number];

/** A cell as the run policy reads it. */
export type ResearchAnswerRunCheck = {
  /** The state stored for the cell, or null when no cell exists yet. */
  state: CaseLawResearchAnswerState | null;
  /**
   * A `pending` cell whose run went quiet past the stale window, decided on
   * the server's clock. Meaningless for every other state.
   */
  stale: boolean;
  /** The caller asked to answer again where an answer already stands. */
  force: boolean;
};

/**
 * Whether a run has to produce this cell.
 *
 * One policy for both sides: the queue skips the cells this refuses, and the
 * client counts the cells it accepts, so the number a lawyer confirms is the
 * number that runs. A live `pending` cell belongs to another run; a stale one
 * is a run that died and may be claimed. `not_allowed` is the source's terms,
 * which a re-run cannot change, and `answered` and `not_stated` are the cache
 * that makes paging back to an answered page free; only `force` reopens them,
 * which is the caller's decision rather than the cell's state.
 */
export const answerNeedsRun = ({
  force,
  state,
  stale,
}: ResearchAnswerRunCheck): boolean => {
  switch (state) {
    case null:
      return true;
    case "pending":
      return stale;
    case "failed":
      return true;
    case "answered":
    case "not_stated":
      return force;
    case "not_allowed":
      return false;
    default: {
      state satisfies never;
      return panic(`Unhandled answer state: ${String(state)}`);
    }
  }
};

/** The model configuration a column's answers are produced with. */
export type CaseLawResearchColumnTool = {
  version: 1;
  role: "fast";
};

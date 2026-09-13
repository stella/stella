import { panic } from "better-result";

import type { SafeId } from "./safe-id";
import type { SearchSort } from "./search";

/**
 * Question columns and their answers, and the research tables they are being
 * moved off.
 *
 * A question column belongs to the organization: every member sees it, and an
 * answer keyed `(columnId, decisionId)` is reusable on every search that
 * surfaces the decision. Rows are the public corpus itself, addressed by
 * decision id; nothing about a decision is copied.
 *
 * A research table is a saved case-law search a lawyer keeps working on: the
 * query it was made from and the decisions pinned into or excluded from its
 * rows. It is retiring into the results table.
 */
export const CASE_LAW_RESEARCH_QUERY_VERSION = 1 as const;

/** A table's name; a search saved as a table is cut to this before it is sent. */
export const CASE_LAW_RESEARCH_TABLE_NAME_MAX_LENGTH = 256;

/** How one decision deviates from what the saved query returns. */
export const CASE_LAW_RESEARCH_DISPOSITIONS = ["pinned", "excluded"] as const;

export type CaseLawResearchDisposition =
  (typeof CASE_LAW_RESEARCH_DISPOSITIONS)[number];

/**
 * The search a table re-runs for its rows. Field names and types are those of
 * the public decision search body, so the client passes it straight through.
 */
export type CaseLawResearchSavedQuery = {
  version: typeof CASE_LAW_RESEARCH_QUERY_VERSION;
  query: string;
  country?: string;
  court?: string;
  dateFrom?: string;
  dateTo?: string;
  decisionType?: string;
  language?: string;
  sourceId?: SafeId<"caseLawSource">;
  /**
   * The order the table was saved under. Absent means the default, which is
   * what every table saved before the order existed was built from.
   */
  sort?: SearchSort;
};

/** What a question column expects for an answer. */
export const CASE_LAW_RESEARCH_ANSWER_TYPES = ["yes_no", "text"] as const;

export type CaseLawResearchAnswerType =
  (typeof CASE_LAW_RESEARCH_ANSWER_TYPES)[number];

/** A question's wording; longer text is a prompt, not a column header. */
export const CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH = 500;

/**
 * Where one cell stands. A cell is never silently empty: `pending` while a run
 * is queued or working, `not_allowed` when the source's terms withhold derived
 * AI use, `failed` when the model or the corpus refused.
 */
export const CASE_LAW_RESEARCH_ANSWER_STATES = [
  "pending",
  "answered",
  "not_allowed",
  "failed",
] as const;

export type CaseLawResearchAnswerState =
  (typeof CASE_LAW_RESEARCH_ANSWER_STATES)[number];

/** A cell as the run policy reads it. */
export type ResearchAnswerRunCheck = {
  /** The state stored for the cell, or null when no cell exists yet. */
  state: CaseLawResearchAnswerState | null;
  /**
   * A `pending` cell whose run went quiet past the stale window, decided on
   * the server's clock. Meaningless for every other state.
   */
  stale: boolean;
};

/**
 * Whether a run has to produce this cell, before an explicit re-answer.
 *
 * One policy for both sides: the queue skips the cells this refuses, and the
 * client counts the cells it accepts, so the number a lawyer confirms is the
 * number that runs. A live `pending` cell belongs to another run; a stale one
 * is a run that died and may be claimed. `not_allowed` is the source's terms,
 * which a re-run cannot change, and `answered` is the cache that makes paging
 * back to an answered page free — only `force` reopens that one, which is the
 * caller's decision rather than the cell's state.
 */
export const answerNeedsRun = ({
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
    case "not_allowed":
      return false;
    default: {
      state satisfies never;
      return panic(`Unhandled answer state: ${String(state)}`);
    }
  }
};

/** A yes/no question may honestly be undecidable from the text. */
export const CASE_LAW_RESEARCH_YES_NO_VALUES = [
  "yes",
  "no",
  "unclear",
] as const;

export type CaseLawResearchYesNoValue =
  (typeof CASE_LAW_RESEARCH_YES_NO_VALUES)[number];

/** The answer itself, typed by the question it answers. */
export type CaseLawResearchAnswerValue =
  | { type: "yes_no"; value: CaseLawResearchYesNoValue }
  | { type: "text"; value: string };

/** The model configuration a column's answers are produced with. */
export type CaseLawResearchColumnTool = {
  version: 1;
  role: "fast";
};

/** One passage the model leaned on, addressable in the reader by its anchor. */
export type CaseLawResearchAnswerPassage = {
  anchorId: string;
  excerpt: string;
};

/** How an answer was produced; kept beside it so a cell can be audited. */
export type CaseLawResearchAnswerRun = {
  version: 1;
  model: string;
  completedAt: string;
  /** True when the decision was too long to send whole and passages were retrieved. */
  retrieved: boolean;
  rationale: string;
  passages: CaseLawResearchAnswerPassage[];
};

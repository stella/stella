import type { SafeId } from "./safe-id";

/**
 * A research table is a saved case-law search a lawyer keeps working on: the
 * query it was made from, the decisions pinned into or excluded from its rows,
 * and (later) the questions asked of every row. Rows are the public corpus
 * itself, addressed by decision id; nothing about a decision is copied.
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
};

/** What a research-table question expects for an answer. */
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

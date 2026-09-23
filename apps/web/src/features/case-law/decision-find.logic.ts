/**
 * The decision half of find-in-table: what each column of a decision row shows
 * a find, and which rows survive one.
 *
 * Decision rows are found on the client, over exactly the page the reader is
 * looking at. The corpus is narrowed by the search box, which every hit has
 * already answered, so a second server round for the same words would be the
 * same question asked twice; a find is the other question, "where on this page
 * does that word appear".
 */

import { panic } from "better-result";

import { PROPERTY_FIND_SUPPORT } from "@stll/api-contract";
import { decisionHeadnoteText } from "@stll/api-contract/case-law-text-field";

import type { Decision } from "@/features/case-law/components/decision-cells";
import { DECISION_COLUMN_IDS } from "@/features/case-law/decision-columns.logic";
import type { DecisionColumnId } from "@/features/case-law/decision-columns.logic";
import {
  answerKey,
  questionColumnId,
} from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumn,
} from "@/features/case-law/research/question-columns.logic";
import type { WorkspaceFieldContent } from "@/lib/types";

/** What one decision column gives a find to read. */
type DecisionFindText = (decision: Decision) => string;

/**
 * The publisher's own summary, which both prose columns draw from. The summary
 * column shows the search's own highlighted snippet instead when the headnote
 * says nothing about the query; that snippet is the search's answer rather
 * than the decision's text, and it carries the search's marks already.
 */
const headnoteFindText = (decision: Decision): string =>
  // Exactly the text the cell draws, breaks included: a term matched against
  // a flattened reading would keep a row whose cell then marks nothing.
  decisionHeadnoteText(decision.headnote);

/**
 * The text each decision column shows a find, or null for a column a find
 * cannot reach. One map, so what the picker offers and what the matcher reads
 * cannot drift apart.
 *
 * The three exclusions share the property model's reason for excluding dates
 * and numbers: the stored value is not the string the cell renders. A date is
 * stored `2026-09-04` and drawn in the reader's locale, a citation count is
 * drawn digit-grouped, and a language is stored `cs` and drawn as its name, so
 * typing what you see would find nothing and typing the stored form could not
 * be marked. The facet rail filters all three.
 */
const DECISION_FIND_TEXT = {
  caseNumber: (decision) => decision.caseNumber,
  summary: headnoteFindText,
  court: (decision) => decision.court,
  country: (decision) => decision.country,
  date: null,
  type: (decision) => decision.decisionType ?? "",
  headnote: headnoteFindText,
  citedBy: null,
  language: null,
} as const satisfies Record<DecisionColumnId, DecisionFindText | null>;

export const isFindableDecisionColumn = (column: DecisionColumnId): boolean =>
  DECISION_FIND_TEXT[column] !== null;

/**
 * Whether a find can reach a question column's answers. The property model's
 * own answer: a question column holds the content a matter property holds, so
 * the kinds whose stored value is not the rendered string are excluded here
 * for the same reason they are there.
 */
export const isFindableQuestionColumn = (column: QuestionColumn): boolean =>
  PROPERTY_FIND_SUPPORT[column.content.type] === "searchable";

/**
 * The text an answer cell shows, for the kinds a find can reach. Empty for
 * every other kind and for a cell no run has answered: nothing to match.
 */
const answerFindText = (content: WorkspaceFieldContent | null): string => {
  if (content === null) {
    return "";
  }
  switch (content.type) {
    case "text":
      return content.value;
    case "single-select":
      return content.value ?? "";
    case "multi-select":
      return content.value.join(" ");
    // The rest either hold no answer yet or render differently from what they
    // store, which is why a column of that kind is out of a find's reach.
    case "clip":
    case "date":
    case "error":
    case "file":
    case "int":
    case "money":
    case "pending":
    case "person":
    case "unsupported":
      return "";
    default:
      content satisfies never;
      return panic(`Unhandled answer content: ${String(content)}`);
  }
};

type DecisionFindRowInput = {
  answersByKey: ReadonlyMap<string, QuestionAnswer>;
  decision: Decision;
  questionColumns: readonly QuestionColumn[];
};

/** What one decision row shows, per column id, for the columns a find reaches. */
export const decisionFindRowText = ({
  answersByKey,
  decision,
  questionColumns,
}: DecisionFindRowInput): ReadonlyMap<string, string> => {
  const text = new Map<string, string>();
  for (const column of DECISION_COLUMN_IDS) {
    const read = DECISION_FIND_TEXT[column];
    if (read !== null) {
      text.set(column, read(decision));
    }
  }
  for (const column of questionColumns) {
    if (!isFindableQuestionColumn(column)) {
      continue;
    }
    const answer = answersByKey.get(answerKey(column.id, decision.id));
    text.set(
      questionColumnId(column.id),
      answerFindText(answer?.answer ?? null),
    );
  }
  return text;
};

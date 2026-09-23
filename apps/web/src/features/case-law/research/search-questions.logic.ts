/**
 * Which of the organization's questions a search shows.
 *
 * The questions and their answers belong to the organization; each search
 * picks which of them to draw, and the results URL holds that pick as an
 * ordered list of column ids. So a link, a reload and the back button all
 * bring back the same columns, and a new search starts without the last
 * one's. What drops the list when the query changes is `withQuery`, the one
 * transition every write of the query goes through.
 */

import { CASE_LAW_RESEARCH_COLUMNS_PER_ORGANIZATION_MAX } from "@stll/api-contract";

import { NO_QUESTION_COLUMNS } from "@/features/case-law/research/question-columns.logic";
import type { QuestionColumn } from "@/features/case-law/research/question-columns.logic";

/** Longer than any column id; a longer entry is typed junk, not an id. */
const QUESTION_ID_MAX_LENGTH = 64;

/**
 * The list as the URL carries it: each id once, in the order first given, no
 * more than the organization can hold, and absent when empty so a search
 * without questions keeps one address. A public link may be typed or
 * crawled, so junk entries are dropped rather than refused.
 */
export const searchQuestionsParam = (
  columnIds: readonly string[],
): string[] | undefined => {
  const kept = [
    ...new Set(
      columnIds
        .map((columnId) => columnId.trim())
        .filter(
          (columnId) =>
            columnId.length > 0 && columnId.length <= QUESTION_ID_MAX_LENGTH,
        ),
    ),
  ].slice(0, CASE_LAW_RESEARCH_COLUMNS_PER_ORGANIZATION_MAX);
  return kept.length === 0 ? undefined : kept;
};

type QuestionsOnSearchInput = {
  /** Every question the organization asks. */
  library: readonly QuestionColumn[];
  /** The ids the URL names, in the order it names them. */
  shownIds: readonly string[];
};

type QuestionsOnSearch = {
  /** What the table draws, in the URL's order. */
  shown: readonly QuestionColumn[];
  /** The organization's other questions, in its own order, to add in one step. */
  addable: readonly QuestionColumn[];
};

/**
 * The split of the organization's questions for one search.
 *
 * An id the organization does not hold (a deleted question, a link from
 * another organization, a list still loading) is simply not drawn: the URL
 * is the reader's to edit, so a miss is an ordinary state, not a defect.
 */
export const questionsOnSearch = ({
  library,
  shownIds,
}: QuestionsOnSearchInput): QuestionsOnSearch => {
  if (shownIds.length === 0) {
    return { shown: NO_QUESTION_COLUMNS, addable: library };
  }
  const byId = new Map(library.map((column) => [column.id, column]));
  const shown = [...new Set(shownIds)].flatMap((columnId) => {
    const column = byId.get(columnId);
    return column === undefined ? [] : [column];
  });
  const shownSet = new Set(shownIds);
  return {
    shown,
    addable: library.filter((column) => !shownSet.has(column.id)),
  };
};

/** The list with questions appended after the ones already shown. */
export const withQuestionsOnSearch = (
  shownIds: readonly string[],
  added: readonly string[],
): string[] | undefined => searchQuestionsParam([...shownIds, ...added]);

/** The list without one question; its answers stay the organization's. */
export const withoutQuestionOnSearch = (
  shownIds: readonly string[],
  columnId: string,
): string[] | undefined =>
  searchQuestionsParam(shownIds.filter((shownId) => shownId !== columnId));

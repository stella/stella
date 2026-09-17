import type {
  CaseLawSearchWarning,
  CaseLawSearchWarningCode,
} from "@stll/api-contract/search";

/**
 * The agent-facing wording of each case-law search warning.
 *
 * A warning never fails a search: the page it rides on is the page the search
 * found. It exists because the three ways a case-law search surprises its
 * caller are all invisible in the result alone — a query that required fewer
 * words than it carried, an empty page a filter caused, and an empty page
 * nothing caused — and a caller that cannot tell them apart cannot act on
 * any of them. So every code names its corrective action in `hint`.
 *
 * The codes are the contract's (`@stll/api-contract/search`), shared with the
 * web, which renders its own translated wording from the same code. This
 * module owns only the sentences the API surfaces read verbatim: the MCP
 * tool, the CLI, and the HTTP response. `search-warnings.test.ts` holds the
 * census that keeps producers and codes in step.
 */

/**
 * The filters a request narrowed with, named as the caller spells them in the
 * request. Order is the schema's, so two requests carrying the same filters
 * produce the same sentence.
 */
type CaseLawSearchFilterNames = readonly string[];

type CaseLawSearchWarningsOptions = {
  /**
   * Function words the query stopped requiring, as the reader wrote them.
   * Empty when the query required every word it carried.
   */
  droppedFunctionWords: readonly string[];
  /** Filters the request narrowed with, empty for an unnarrowed search. */
  filters: CaseLawSearchFilterNames;
  /**
   * Whether the search found nothing at all. False on a continuation page,
   * which cannot say: a continuation is empty at the end of every result set
   * that had hits, so "nothing matched" would be false there.
   */
  emptyResultSet: boolean;
};

const functionWordsWarning = (
  dropped: readonly string[],
): CaseLawSearchWarning => ({
  code: "function_words_optional",
  // Named, not counted: a reader deciding whether the search answered their
  // question needs to know which words it stopped requiring, not how many.
  message: `The search did not require these words, which are grammar rather than subject matter: ${dropped.join(", ")}.`,
  hint: "Pass strict: true to require every word, or quote a phrase to require its words adjacently.",
});

const noHitsWarning = (): CaseLawSearchWarning => ({
  code: "no_hits",
  message:
    "Nothing matched the words this search required, so the result set is empty rather than narrow.",
  hint: "Search fewer or different words: the terms a judgment would use for the subject, rather than the sentence a question is asked in.",
});

const noHitsFilteredWarning = (
  filters: CaseLawSearchFilterNames,
): CaseLawSearchWarning => ({
  code: "no_hits_filtered",
  // The filters are named because the reader chose them and can drop them.
  // The other reading of an empty page — that the corpus holds nothing on the
  // subject — is the one this warning exists to rule out.
  message: `Nothing matched under the filters this search narrowed with: ${filters.join(", ")}.`,
  hint: `Drop or widen ${filters.length === 1 ? "that filter" : "those filters"} and search again; the same words may match outside it.`,
});

/**
 * Every warning one search earned, in a fixed order: what the query did
 * before what the result was, because the first explains the second.
 *
 * The two empty-page codes are exclusive. An empty page under a filter is
 * reported as the filter's, because that is the reading the caller can act
 * on: a filter is something they chose and can drop, where "nothing matched"
 * is not.
 */
export const caseLawSearchWarnings = ({
  droppedFunctionWords,
  filters,
  emptyResultSet,
}: CaseLawSearchWarningsOptions): CaseLawSearchWarning[] => {
  const warnings: CaseLawSearchWarning[] = [];
  if (droppedFunctionWords.length > 0) {
    warnings.push(functionWordsWarning(droppedFunctionWords));
  }
  if (!emptyResultSet) {
    return warnings;
  }
  warnings.push(
    filters.length > 0 ? noHitsFilteredWarning(filters) : noHitsWarning(),
  );
  return warnings;
};

/**
 * The producer of each code, for the census. A code is guidance a caller
 * reads verbatim, so one no search can produce has to be deleted rather than
 * left in the list; total over the code set, so a new code cannot land
 * without a producer to point at.
 */
export const CASE_LAW_SEARCH_WARNING_PRODUCERS = {
  function_words_optional: () => functionWordsWarning(["na"]),
  no_hits: noHitsWarning,
  no_hits_filtered: () => noHitsFilteredWarning(["court"]),
} as const satisfies Record<
  CaseLawSearchWarningCode,
  () => CaseLawSearchWarning
>;

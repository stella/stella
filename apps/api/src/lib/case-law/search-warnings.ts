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
 * Warnings only an agent surface raises, about a filter value it had to read
 * before searching or a phrasing it was sent. The web sends filters it took
 * from its own facets and one query per search, so it never meets these; they
 * stay out of the shared contract for that reason.
 *
 * - `filter_read`: the value named one known value in another spelling (a
 *   case, an abbreviation, an English name), and the search used that value.
 * - `filter_dropped`: the value named no known value, or several different
 *   ones, so the search ran without that filter rather than returning
 *   nothing for it.
 * - `many_required_terms`: a phrasing required many words in one passage and
 *   filled fewer result slots than it was given, so dropping a word is the
 *   likelier fix than paging. Raised only under `MCP_CASE_LAW_SEARCH_GUIDANCE`
 *   `v1`, from the page already returned: it costs no search.
 */
export const AGENT_CASE_LAW_SEARCH_WARNING_CODES = [
  "filter_read",
  "filter_dropped",
  "many_required_terms",
] as const;

type AgentCaseLawSearchWarningCode =
  (typeof AGENT_CASE_LAW_SEARCH_WARNING_CODES)[number];

export type AgentCaseLawSearchWarning = {
  readonly code: CaseLawSearchWarningCode | AgentCaseLawSearchWarningCode;
  readonly message: string;
  readonly hint: string;
};

/**
 * A court the corpus stores under several spellings (with and without the
 * country, say) is one court, so a value naming it reads as every spelling,
 * and the note lists them: the caller sees the filter that ran.
 */
export const filterReadWarning = ({
  filter,
  received,
  values: [value, ...others],
}: {
  filter: string;
  received: string;
  values: readonly [string, ...string[]];
}): AgentCaseLawSearchWarning =>
  others.length === 0
    ? {
        code: "filter_read",
        message: `Read ${filter} ${received} as "${value}".`,
        hint: `Pass ${filter} "${value}" to search the same way without this note.`,
      }
    : {
        code: "filter_read",
        message: `Read ${filter} ${received} as one ${filter} stored under ${String(others.length + 1)} spellings, and matched each: ${[value, ...others].map((spelling) => `"${spelling}"`).join(", ")}.`,
        hint: `Pass ${filter} "${value}" to search the same ${filter} the same way.`,
      };

export const filterDroppedWarning = ({
  filter,
  received,
  known,
}: {
  filter: string;
  received: string;
  /** The values the caller could have meant, most useful first; bounded. */
  known: string;
}): AgentCaseLawSearchWarning => ({
  code: "filter_dropped",
  message: `${received} names no single ${filter}, so this search ran without the ${filter} filter.`,
  hint: `To narrow by ${filter}, pass one of the stored values. ${known}`,
});

export const manyRequiredTermsWarning = ({
  terms,
  wordCount,
  slots,
}: {
  /** The terms and quoted phrases the phrasing required, as `queryUsed` spells them. */
  terms: readonly string[];
  /** The words those terms hold, a phrase counting each of its words. */
  wordCount: number;
  /** The result slots the phrasing was given on this page. */
  slots: number;
}): AgentCaseLawSearchWarning => ({
  code: "many_required_terms",
  message: `This phrasing required ${String(wordCount)} words in one passage and filled fewer than its ${String(slots)} result slots: ${terms.join(", ")}.`,
  hint: "Drop the least central of these words, or move an alternative wording into a phrasing of its own: a hit holds every required word in the same passage.",
});

/**
 * The values a facet counted for an empty page's filters, appended to its
 * `no_hits_filtered` hint so the next call can pick a value that exists
 * rather than guess another. A facet counts its own dimension under the
 * request's other filters, so these are the values that would have matched.
 */
export const withFacetValues = (
  warning: CaseLawSearchWarning,
  values: readonly { filter: string; values: readonly string[] }[],
): CaseLawSearchWarning => {
  const listed = values.filter((entry) => entry.values.length > 0);
  if (warning.code !== "no_hits_filtered" || listed.length === 0) {
    return warning;
  }
  const sentences = listed.map(
    ({ filter, values: known }) =>
      `${filter} values with hits under the other filters: ${known.map((value) => `"${value}"`).join(", ")}.`,
  );
  return { ...warning, hint: `${warning.hint} ${sentences.join(" ")}` };
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

/** The agent-only codes' producers, total over their set like the above. */
export const AGENT_CASE_LAW_SEARCH_WARNING_PRODUCERS = {
  filter_read: () =>
    filterReadWarning({
      filter: "court",
      received: '"NS"',
      values: ["Nejvyšší soud"],
    }),
  filter_dropped: () =>
    filterDroppedWarning({
      filter: "court",
      received: '"Česká republika"',
      known: 'Known values include "Nejvyšší soud".',
    }),
  many_required_terms: () =>
    manyRequiredTermsWarning({
      terms: [
        "promlčení",
        "náhrady",
        "škody",
        "subjektivní",
        "lhůta",
        "vědomost",
      ],
      wordCount: 6,
      slots: 5,
    }),
} as const satisfies Record<
  AgentCaseLawSearchWarningCode,
  () => AgentCaseLawSearchWarning
>;

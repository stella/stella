import { apexCourtAbbreviations } from "@stll/api-contract/case-law-court-abbreviations";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import type { CaseLawSearchGuidanceMode } from "@/api/lib/case-law/search-guidance-mode";
import { LIMITS } from "@/api/lib/limits";

/**
 * The agent-facing text of `search_case_law` per guidance mode
 * (`MCP_CASE_LAW_SEARCH_GUIDANCE`).
 *
 * `off` is the contract without experimental query-writing guidance, so the
 * gate can be evaluated against it. `v1` adds what a model cannot infer
 * from the schema: a hit is one passage holding every required word, so a
 * long phrasing finds less, not more; `limit` is shared evenly, so a weak
 * extra phrasing costs the good one slots; and the courts example names every
 * admitted country's apex courts from the court registry instead of one
 * country's.
 */

/**
 * Required terms from which a phrasing that fills fewer slots than it was
 * given carries `many_required_terms`.
 */
export const MANY_REQUIRED_TERMS_THRESHOLD = 6;

/** Which modes raise `many_required_terms`; total, so a new mode decides. */
export const CASE_LAW_SEARCH_GUIDANCE_RAISES_MANY_REQUIRED_TERMS = {
  off: false,
  v1: true,
} as const satisfies Record<CaseLawSearchGuidanceMode, boolean>;

type SearchCaseLawTexts = {
  description: string;
  queries: string;
  limit: string;
  courts: string;
};

const DESCRIPTION_HEAD =
  "Search case law. `queries` merges phrasings; matchedQueries " +
  "names each hit's phrasings. `limit` is split evenly.";

const DESCRIPTION_TAIL =
  " Facets are opt-in by name, first phrasing on page one only. Totals count full matches; uncounted for multiple phrasings. strict requires every word; otherwise function words are optional. Relevance pages may add some_terms hits after all_terms hits. searches[] reports queryUsed/warnings. source_id uses facets.source values.";

const QUERIES_TAIL =
  "Their pages are merged and deduplicated within the page, so a reformulation costs no extra round trip; one phrasing is a valid call. Omit queries and pass provision to list every decision citing it, by authority or date, paged without a total.";

const LIMIT_OFF =
  "Merged-page size, split evenly across the queries (at least one hit each)";

const COURTS_TAIL = "Combined with court, both filters must match.";

/** Each admitted country with the apex abbreviations its courts answer to. */
const apexCourtExamples = (): string =>
  PUBLIC_CASE_LAW_COUNTRIES.flatMap((country) => {
    const abbreviations = apexCourtAbbreviations(country);
    return abbreviations.length === 0
      ? []
      : [`${country} ${JSON.stringify(abbreviations).replaceAll(",", ", ")}`];
  }).join("; ");

const SEARCH_CASE_LAW_TEXTS = {
  off: {
    description: `${DESCRIPTION_HEAD}${DESCRIPTION_TAIL}`,
    queries: `Several phrasings of ONE question, at most ${String(LIMITS.caseLawSearchQueriesMax)}. ${QUERIES_TAIL}`,
    limit: LIMIT_OFF,
    courts: `Match any listed court. For Czech apex courts use ["NS", "NSS", "ÚS"]. ${COURTS_TAIL}`,
  },
  v1: {
    description: `${DESCRIPTION_HEAD} Put the most central phrasing first; three are usually enough.${DESCRIPTION_TAIL}`,
    queries:
      `Several phrasings of ONE question, at most ${String(LIMITS.caseLawSearchQueriesMax)}. ` +
      "A full match needs every word of a phrasing except function words in " +
      "one passage, so give each phrasing the two to four words that " +
      "define the issue, and put an alternative wording in a phrasing of " +
      "its own rather than lengthening one. Write a provision as `§ N` " +
      `plus the act's name or abbreviation. ${QUERIES_TAIL}`,
    limit: `${LIMIT_OFF}, so a phrasing added takes slots from the others: put the most central first.`,
    courts: `Match any listed court. Apex courts by abbreviation: ${apexCourtExamples()}. ${COURTS_TAIL}`,
  },
} as const satisfies Record<CaseLawSearchGuidanceMode, SearchCaseLawTexts>;

export const searchCaseLawTexts = (
  mode: CaseLawSearchGuidanceMode,
): SearchCaseLawTexts => SEARCH_CASE_LAW_TEXTS[mode];

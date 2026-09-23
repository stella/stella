import type { Static } from "elysia";

import type { DecisionQueryIntent } from "@stll/api-contract/decision-query-intent";
import type { CaseLawSearchWarning } from "@stll/api-contract/search";

import type { searchDecisionsBodySchema } from "@/api/handlers/case-law/decisions/search-schema";
import { caseLawSearchWarnings } from "@/api/lib/case-law/search-warnings";
import { caseLawQueryLanguage } from "@/api/lib/legal-search/corpus-index-read-contract";
import {
  formatCorpusQueryTokens,
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import {
  type LegalAlternatives,
  normalizeLegalAlternatives,
} from "@/api/lib/legal-search/legal-alternatives";
import { functionWordsFor } from "@/api/lib/legal-search/morphology/function-words";

/**
 * What a case-law search will require of the corpus, and what it has to say
 * about the answer.
 *
 * Its own module because both providers read it: which words a search
 * required is a property of the request, not of the engine that answered it,
 * so the corpus-index branch and the Postgres branch must answer identically
 * or the same query means two things depending on a deployment flag.
 */

type SearchDecisionsBody = Static<typeof searchDecisionsBodySchema>;

/** Every request key that is not the query itself or the index it selects. */
type SearchOptionKey = Exclude<keyof SearchDecisionsBody, "country" | "query">;

/**
 * Whether an option cuts the result set or only shapes it.
 *
 * `narrows` is what an empty page can be blamed on and what a reader can drop
 * to widen one; `shapes` orders, trims or paginates a set it does not cut.
 * `country` is neither and is absent above: it is required and selects the
 * index rather than filtering within it, so no reader can drop it.
 *
 * Total over the body's own option keys, so a filter added to the schema
 * fails to compile until it says which it is. A hand-kept list of filter
 * names beside the schema is exactly how an empty page starts being reported
 * as the corpus's fault instead of the new filter's.
 */
const SEARCH_OPTION_EFFECT = {
  court: "narrows",
  cursor: "shapes",
  dateFrom: "narrows",
  dateTo: "narrows",
  decisionType: "narrows",
  excerpt: "shapes",
  language: "narrows",
  limit: "shapes",
  sort: "shapes",
  sourceId: "narrows",
  strict: "shapes",
} as const satisfies Record<SearchOptionKey, "narrows" | "shapes">;

/** The keys {@link SEARCH_OPTION_EFFECT} marks as cutting the result set. */
type NarrowingOption = {
  [
    TKey in SearchOptionKey
  ]: (typeof SEARCH_OPTION_EFFECT)[TKey] extends "narrows" ? TKey : never;
}[SearchOptionKey];

/**
 * Whether a request carries each narrowing filter. Total over the union the
 * effect map derives, so the two cannot drift in either direction: a key that
 * becomes `narrows` has to gain a reader here, and a reader for a key that no
 * longer narrows stops compiling.
 */
const NARROWING_FILTERS = {
  court: ({ court }) => court !== undefined,
  dateFrom: ({ dateFrom }) => dateFrom !== undefined,
  dateTo: ({ dateTo }) => dateTo !== undefined,
  decisionType: ({ decisionType }) => decisionType !== undefined,
  language: ({ language }) => language !== undefined,
  sourceId: ({ sourceId }) => sourceId !== undefined,
} as const satisfies Record<
  NarrowingOption,
  (body: SearchDecisionsBody) => boolean
>;

/**
 * The narrowing filters this request carries, named as the request spells
 * them, in a fixed order: two requests carrying the same filters have to
 * produce the same sentence.
 */
export const narrowingFilters = (body: SearchDecisionsBody): string[] =>
  Object.entries(NARROWING_FILTERS)
    .filter(([, carriesFilter]) => carriesFilter(body))
    .map(([name]) => name)
    .toSorted();

export type DecisionQueryInterpretation = {
  /** The query as executed, itself re-readable as a query. */
  queryUsed: string;
  /** Function words left out, as the reader wrote them. */
  droppedFunctionWords: readonly string[];
  /** What the clause builder drops, or null to require every word. */
  functionWords: ReadonlySet<string> | null;
  /**
   * The legal-vocabulary alternatives the clause builder ORs in, normalized
   * against this query; empty where the search matches the words as typed.
   */
  legalAlternatives: LegalAlternatives;
};

/**
 * Which of a request's words the search will require, and which alternatives
 * it will accept beside them.
 *
 * Two requests never drop or add a word. `strict` is the caller asking for
 * exactly the words typed, and an identifier is a docket or an ECLI, whose
 * parts are not words at all and whose fall-through to the text index exists
 * precisely to find the decision it names.
 */
export const interpretDecisionQuery = (
  body: SearchDecisionsBody,
  intent: DecisionQueryIntent,
): DecisionQueryInterpretation => {
  const verbatim = body.strict === true || intent.type === "identifier";
  const functionWords = verbatim
    ? null
    : functionWordsFor(
          caseLawQueryLanguage({
            jurisdiction: body.country,
            language: body.language,
          }),
        );
  const { dropped, required } = partitionCorpusFunctionWords(
    tokenizeCorpusFreeText(body.query),
    functionWords,
  );
  return {
    // The reader's own string wherever nothing was dropped, so a search that
    // changed nothing reports itself back byte for byte rather than a
    // re-tokenised spelling of itself.
    queryUsed:
      dropped.length === 0 ? body.query : formatCorpusQueryTokens(required),
    droppedFunctionWords: dropped,
    functionWords,
    // Normalized again here because the request comes from a client: only
    // words this search requires keep alternatives, within the same bounds
    // the endpoint that proposed them applies.
    legalAlternatives: verbatim
      ? []
      : normalizeLegalAlternatives(body.alternatives ?? [], {
          functionWords,
          query: body.query,
        }),
  };
};

type SearchAnswerOptions = {
  body: SearchDecisionsBody;
  interpretation: DecisionQueryInterpretation;
  /** Hits this page carries. */
  hitCount: number;
  /**
   * Whether this page can speak for the whole result set. A continuation
   * page cannot: it comes back empty at the end of every result set that had
   * hits, so "nothing matched" would be false there.
   */
  countsResultSet: boolean;
};

export type SearchAnswer = {
  queryUsed: string;
  warnings: CaseLawSearchWarning[];
};

/**
 * The fields every answer carries beside its page. One builder, so the two
 * providers cannot describe the same request differently.
 */
export const searchAnswer = ({
  body,
  interpretation,
  hitCount,
  countsResultSet,
}: SearchAnswerOptions): SearchAnswer => ({
  queryUsed: interpretation.queryUsed,
  warnings: caseLawSearchWarnings({
    droppedFunctionWords: interpretation.droppedFunctionWords,
    filters: narrowingFilters(body),
    emptyResultSet: countsResultSet && hitCount === 0,
  }),
});

import { panic, Result } from "better-result";

import type {
  FACET_COUNT_TYPE,
  SearchPageEnd,
} from "@stll/api-contract/search";
import { SEARCH_PAGE_END } from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { mapWithConcurrency } from "@stll/concurrency";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import {
  type CorpusProjectionRevision,
  type CorpusProjectionRevisionField,
  corpusRevisionClause,
} from "@/api/lib/legal-search/corpus-index-revision-clause";
import { readCardinality } from "@/api/lib/legal-search/corpus-index-search-facets";
import { quoteCorpusValue } from "@/api/lib/legal-search/corpus-query";
import type { RankedHit } from "@/api/lib/legal-search/rerank";
import { corpusIndexReadRefusal } from "@/api/lib/legal-search/search-index-unavailable";
import { LIMITS } from "@/api/lib/limits";
import type { BoundedRequestStep } from "@/api/lib/load/request-latency-budget";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The relaxed phase of a corpus-index case-law search.
 *
 * Czech topic searches require every content word, so a question asked in
 * natural language often returns a handful of hits or none. When the strict
 * first page is short and its scan proved the strict set ended, the page is
 * topped up with decisions that hold only some of the words, ranked by how
 * many of them they hold. The strict hits stay first and untouched, and the
 * total and facets keep describing the strict set.
 */

/** Decisions the relaxed scan must leave out: everything the strict page showed. */
export type RelaxedExclusions = {
  ids: ReadonlySet<string>;
  /** A language sibling of a shown decision is the same judgment. */
  languageGroupKeys: ReadonlySet<string>;
};

type QueryTerm = { type: string; value: string };

/**
 * Whether a query has words to check one by one: at least two distinct ones,
 * and no more than one search checks. Counted on distinct terms, so a word
 * repeated in the query counts once, as it does in every query built from it.
 */
export const checksWordsOneByOne = (terms: readonly QueryTerm[]): boolean => {
  const distinct = new Set(terms.map(({ value }) => value)).size;
  return distinct >= 2 && distinct <= LIMITS.caseLawSearchTermCountsMax;
};

type ShouldRelaxOptions = {
  body: { strict?: boolean | undefined };
  intentType: string;
  isFirstPage: boolean;
  /**
   * The content terms the strict query required, as typed: the bounds below
   * count the distinct ones, here, so no caller can pass a count of repeats.
   */
  requiredTerms: readonly QueryTerm[];
  sort: string;
  strictHitCount: number;
  limit: number;
  /** Why the strict scan ended; only a complete end proves the set is exhausted. */
  strictEnd: SearchPageEnd;
};

/**
 * Whether a strict page is topped up. Every condition is needed: a cursor or
 * offset page is a slice of a set the first page described, `newest` asks for
 * a date order a coverage ranking would break, `strict` asks for exactly the
 * words typed, an identifier is a lookup rather than a topic, one term has
 * nothing to relax, a scan that stopped on a budget or has a
 * continuation has not shown the strict set ended, and a query with more
 * words than the phase checks one by one could not say which a hit lacks.
 */
export const shouldRelaxCaseLawSearch = ({
  body,
  intentType,
  isFirstPage,
  requiredTerms,
  sort,
  strictHitCount,
  limit,
  strictEnd,
}: ShouldRelaxOptions): boolean =>
  isFirstPage &&
  sort === "relevance" &&
  body.strict !== true &&
  intentType !== "identifier" &&
  checksWordsOneByOne(requiredTerms) &&
  strictEnd === SEARCH_PAGE_END.COMPLETE &&
  strictHitCount < limit;

/** Candidates scanned per slot, so coverage can promote a hit the engine ranked lower. */
const RELAXED_OVERFETCH = 3;

/**
 * How many relaxed hits the scan is asked for to fill `needed` slots: more
 * than needed, because the engine's order can rank a decision holding one
 * rare word above decisions holding several, and the cut by coverage can only
 * promote what the scan returned.
 */
export const relaxedFetchLimit = (needed: number): number =>
  Math.min(needed * RELAXED_OVERFETCH, LIMITS.caseLawSearchPageSizeMax);

/**
 * The required terms, each once, in the query's order: what the partial phase
 * checks one by one and what a hit's matched and missing words are read
 * against. Every one is checked, so a hit never reports a word as missing
 * that nobody looked for; `shouldRelaxCaseLawSearch` bounds how many.
 */
export const distinctRequiredTerms = <Term extends { value: string }>(
  terms: readonly Term[],
): Term[] => [...new Map(terms.map((term) => [term.value, term])).values()];

type FewDecisionsHoldEveryWordOptions = {
  intentType: string;
  isFirstPage: boolean;
  /** The content terms the strict query required, as typed. */
  requiredTerms: readonly QueryTerm[];
  strictHitCount: number;
  limit: number;
  strictEnd: SearchPageEnd;
};

/**
 * Whether fewer decisions than the page holds contain every word, proven by
 * a first page whose strict scan ended with room to spare. Then the words are
 * counted one by one, so the caller can see which one is rare. Unlike the
 * partial phase this holds under `strict` and any sort: it explains the set,
 * it does not add to it.
 */
export const fewDecisionsHoldEveryWord = ({
  intentType,
  isFirstPage,
  requiredTerms,
  strictHitCount,
  limit,
  strictEnd,
}: FewDecisionsHoldEveryWordOptions): boolean =>
  isFirstPage &&
  intentType !== "identifier" &&
  checksWordsOneByOne(requiredTerms) &&
  strictEnd === SEARCH_PAGE_END.COMPLETE &&
  strictHitCount < limit;

/** A query term as `queryUsed` spells it: a phrase keeps its quotes. */
export const spelledTerm = (term: { type: string; value: string }): string =>
  term.type === "phrase" ? `"${term.value}"` : term.value;

export type HitTerms = {
  matchedTerms: string[];
  missingTerms: string[];
};

/**
 * No words checked: a decision an identifier named or a provision listed,
 * which the query's words did not select.
 */
export const NO_HIT_TERMS: HitTerms = { matchedTerms: [], missingTerms: [] };

/** Every term held: a hit of the strict query, which required them all. */
export const allTermsHeld = (
  terms: readonly { type: string; value: string }[],
): HitTerms => ({
  matchedTerms: distinctRequiredTerms(terms).map(spelledTerm),
  missingTerms: [],
});

/** Split the checked terms by whether the decision holds each one. */
export const hitTermsFromCoverage = (
  terms: readonly { type: string; value: string }[],
  held: ReadonlySet<number>,
): HitTerms => {
  const distinct = distinctRequiredTerms(terms);
  return {
    matchedTerms: distinct
      .filter((_, index) => held.has(index))
      .map(spelledTerm),
    missingTerms: distinct
      .filter((_, index) => !held.has(index))
      .map(spelledTerm),
  };
};

export type RelaxedTopUpOutcome<T> =
  { type: "read"; value: T } | { type: "skipped"; error: unknown };

/**
 * How the top-up step ended. It is optional and starts with a strict page
 * already in hand, so any way of not finishing it answers with that page
 * rather than failing a request that has its hits.
 */
export const relaxedTopUpOutcome = <T>(
  step: BoundedRequestStep<Result<T, unknown>>,
): RelaxedTopUpOutcome<T> => {
  switch (step.status) {
    case "complete":
      return Result.isOk(step.value)
        ? { type: "read", value: step.value.value }
        : { type: "skipped", error: step.value.error };
    case "degraded":
    case "failed":
      return { type: "skipped", error: step.error };
    default:
      step satisfies never;
      return panic("Unhandled relaxed top-up step");
  }
};

const TERM_COVERAGE_CONCURRENCY = 4;

type ReadTermCoverageOptions = {
  aggregate: CorpusIndexClient["aggregate"];
  observer: RegistryRequestObservation;
  signal?: AbortSignal | undefined;
  indexId: string;
  /** One query per distinct required term, using the executed expansion dictionary. */
  queries: readonly string[];
  ids: readonly string[];
};

/**
 * Exact document membership per term, restricted to the bounded candidate set:
 * for each candidate, the indexes into `queries` of the terms it holds.
 * Buckets collapse repeated passages, so a term counts once per decision
 * wherever in the decision it stands. No snippet or stored presentation field
 * participates; a missing excerpt cannot change the ranking.
 */
export const readTermCoverage = async ({
  aggregate,
  observer,
  signal,
  indexId,
  queries,
  ids,
}: ReadTermCoverageOptions): Promise<
  Result<
    ReadonlyMap<string, ReadonlySet<number>>,
    HandlerError<400 | 502 | 503>
  >
> => {
  if (ids.length === 0) {
    return Result.ok(new Map());
  }
  const coverage = new Map(ids.map((id) => [id, new Set<number>()]));
  const candidates = `document_id: IN [${ids.map(quoteCorpusValue).join(" ")}]`;
  const results = await mapWithConcurrency({
    items: queries.map((query, index) => ({ query, index })),
    limit: TERM_COVERAGE_CONCURRENCY,
    operation: async ({
      query,
      index,
    }): Promise<Result<void, HandlerError<400 | 502 | 503>>> => {
      const answer = await aggregate({
        observer,
        signal,
        indexId,
        query: `(${query}) AND (${candidates})`,
        aggs: {
          term_coverage: {
            terms: {
              field: "document_id",
              size: ids.length,
              shard_size: ids.length,
              order: { _key: "asc" },
              show_term_doc_count_error: true,
            },
          },
        },
      });
      if (Result.isError(answer)) {
        return Result.err(
          corpusIndexReadRefusal(
            answer.error,
            (answered) =>
              new HandlerError({
                code: "upstream_unavailable",
                status: 503,
                message: "Search term coverage is temporarily unavailable",
                cause: answered,
              }),
          ),
        );
      }
      const buckets = answer.value["term_coverage"];
      if (
        !isRecord(buckets) ||
        !Array.isArray(buckets["buckets"]) ||
        buckets["sum_other_doc_count"] !== 0 ||
        buckets["doc_count_error_upper_bound"] !== 0
      ) {
        return Result.err(
          classifyFailure(
            new HandlerError({
              status: 502,
              code: "internal_error",
              message: "Search term coverage is incomplete",
              cause: new CorpusIndexError({
                message: "Expected exact candidate term buckets",
              }),
            }),
            "response_invalid",
          ),
        );
      }
      const seen = new Set<string>();
      for (const bucket of buckets["buckets"]) {
        if (
          !isRecord(bucket) ||
          typeof bucket["key"] !== "string" ||
          !coverage.has(bucket["key"]) ||
          seen.has(bucket["key"]) ||
          !Number.isSafeInteger(bucket["doc_count"]) ||
          Number(bucket["doc_count"]) <= 0
        ) {
          return Result.err(
            classifyFailure(
              new HandlerError({
                status: 502,
                code: "internal_error",
                message: "Search term coverage is invalid",
                cause: new CorpusIndexError({
                  message: "Unexpected candidate term bucket",
                }),
              }),
              "response_invalid",
            ),
          );
        }
        const id = bucket["key"];
        seen.add(id);
        (coverage.get(id) ?? panic("Missing candidate coverage")).add(index);
      }
      return Result.ok(undefined);
    },
  });
  for (const result of results) {
    if (Result.isError(result)) {
      return Result.err(result.error);
    }
  }
  return Result.ok(coverage);
};

type RankByTermCoverageOptions = {
  ranked: readonly RankedHit[];
  coverageById: ReadonlyMap<string, ReadonlySet<number>>;
};

/** Exact term membership leads; the existing blend breaks ties. */
export const rankByTermCoverage = ({
  ranked,
  coverageById,
}: RankByTermCoverageOptions): RankedHit[] =>
  ranked
    .map((hit, index) => ({
      hit,
      index,
      covered: (
        coverageById.get(hit.id) ?? panic("Missing candidate term coverage")
      ).size,
    }))
    .toSorted(
      (left, right) => right.covered - left.covered || left.index - right.index,
    )
    .map(({ hit }) => hit);

/** Per-word decision counts as the response carries them. */
export type TermDecisionCounts = {
  /** Decisions holding every word: exact, the strict set it was read beside. */
  allTerms: number;
  terms: { term: string; count: number }[];
  countType: typeof FACET_COUNT_TYPE.ESTIMATE;
};

type ReadTermDecisionCountsOptions = {
  aggregate: CorpusIndexClient["aggregate"];
  observer: RegistryRequestObservation;
  signal?: AbortSignal | undefined;
  indexId: string;
  /** The route's fixed scope, as the facet counts apply it. */
  filter: string | undefined;
  /** The field each decision has exactly one value of. */
  decisionCountField: string;
  /** One query per distinct required term, with the request's filters. */
  queries: readonly string[];
};

/**
 * How many decisions hold each term on its own, under the request's filters:
 * which word of a query few decisions hold all of is the rare one. One
 * distinct count per term, so the answer is the engine's sketch estimate.
 */
export const readTermDecisionCounts = async ({
  aggregate,
  observer,
  signal,
  indexId,
  filter,
  decisionCountField,
  queries,
}: ReadTermDecisionCountsOptions): Promise<
  Result<number[], HandlerError<400 | 502 | 503>>
> => {
  const results = await mapWithConcurrency({
    items: queries,
    limit: TERM_COVERAGE_CONCURRENCY,
    operation: async (
      query,
    ): Promise<Result<number, HandlerError<400 | 502 | 503>>> => {
      const answer = await aggregate({
        observer,
        signal,
        indexId,
        query,
        filter,
        aggs: { decisions: { cardinality: { field: decisionCountField } } },
      });
      if (Result.isError(answer)) {
        return Result.err(
          corpusIndexReadRefusal(
            answer.error,
            (answered) =>
              new HandlerError({
                code: "upstream_unavailable",
                status: 503,
                message: "Search term counts are temporarily unavailable",
                cause: answered,
              }),
          ),
        );
      }
      const count = readCardinality(answer.value["decisions"]);
      return count === null
        ? Result.err(
            classifyFailure(
              new HandlerError({
                status: 502,
                code: "internal_error",
                message: "Search term counts are invalid",
                cause: new CorpusIndexError({
                  message: "Expected a decision count per term",
                }),
              }),
              "response_invalid",
            ),
          )
        : Result.ok(count);
    },
  });
  const counts: number[] = [];
  for (const result of results) {
    if (Result.isError(result)) {
      return Result.err(result.error);
    }
    counts.push(result.value);
  }
  return Result.ok(counts);
};

/** The words a decision holds, and the copy of it they were read off. */
export type WordsAtCopy = {
  revision: CorpusProjectionRevision;
  held: ReadonlySet<number>;
};

export type WordsRead = ReadonlyMap<string, WordsAtCopy>;

type ReadWordsAtCopiesOptions = {
  aggregate: CorpusIndexClient["aggregate"];
  observer: RegistryRequestObservation;
  signal?: AbortSignal | undefined;
  indexId: string;
  revisionField: CorpusProjectionRevisionField;
  /** One query per distinct word, in the order hits report them. */
  wordQueries: readonly string[];
  /** Each decision and the copy of it the words are read off. */
  copies: readonly { id: string; revision: CorpusProjectionRevision }[];
};

/**
 * The one reader of which words decisions hold: each word's membership over
 * the named copies, each decision's answer tagged with the copy it came
 * from. A hit's matched and missing words go through `wordsHeldAt`, which
 * refuses an answer read off a copy other than the one the hit shows.
 */
export const readWordsAtCopies = async ({
  aggregate,
  observer,
  signal,
  indexId,
  revisionField,
  wordQueries,
  copies,
}: ReadWordsAtCopiesOptions): Promise<
  Result<WordsRead, HandlerError<400 | 502 | 503>>
> => {
  if (copies.length === 0) {
    return Result.ok(new Map());
  }
  const named = copies
    .map(({ id, revision }) =>
      corpusRevisionClause({
        clause: `document_id:${quoteCorpusValue(id)}`,
        field: revisionField,
        revision,
      }),
    )
    .join(" OR ");
  const held = await readTermCoverage({
    aggregate,
    observer,
    signal,
    indexId,
    ids: copies.map(({ id }) => id),
    queries: wordQueries.map((query) => `(${query}) AND (${named})`),
  });
  return held.map(
    (byId) =>
      new Map(
        copies.map(({ id, revision }) => [
          id,
          {
            revision,
            held: byId.get(id) ?? panic("Missing word membership for a copy"),
          },
        ]),
      ),
  );
};

/** Several reads as one, the later one answering for a copy it re-read. */
export const mergeWordsRead = (
  earlier: WordsRead,
  later: WordsRead,
): WordsRead => new Map([...earlier, ...later]);

/**
 * The words a hit's decision holds in the copy the hit shows. A read off any
 * other copy is a defect in the caller, not an answer: the words of an older
 * copy are not the words of the one on the page.
 */
export const wordsHeldAt = (
  read: WordsRead,
  id: string,
  shown: CorpusProjectionRevision | null,
): ReadonlySet<number> => {
  const words = read.get(id) ?? panic("No words read for a hit");
  return shown !== null && words.revision === shown
    ? words.held
    : panic("A hit's words were read off another copy than the one shown");
};

/**
 * The decisions whose shown copy is not the one their words were read off,
 * with the copy they show: what a second read must cover.
 */
export const copiesShownSinceRead = (
  read: WordsRead,
  shownRevisionOf: (id: string) => CorpusProjectionRevision | null,
): { id: string; revision: CorpusProjectionRevision }[] =>
  [...read].flatMap(([id, { revision }]) => {
    const shown = shownRevisionOf(id);
    return shown === null || shown === revision
      ? []
      : [{ id, revision: shown }];
  });

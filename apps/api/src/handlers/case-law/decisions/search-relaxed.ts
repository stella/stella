import { panic, Result } from "better-result";

import { SEARCH_PAGE_END } from "@stll/api-contract/search";
import type { SearchPageEnd } from "@stll/api-contract/search";
import type { RegistryRequestObservation } from "@stll/business-registries/shared/request-observer";
import { mapWithConcurrency } from "@stll/concurrency";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { quoteCorpusValue } from "@/api/lib/legal-search/corpus-query";
import type { RankedHit } from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";
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

type ShouldRelaxOptions = {
  body: { strict?: boolean | undefined };
  intentType: string;
  isFirstPage: boolean;
  /** Content terms the strict query required (a quoted phrase counts once). */
  requiredTermCount: number;
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
 * nothing to relax, and a scan that stopped on a budget or has a
 * continuation has not shown the strict set ended.
 */
export const shouldRelaxCaseLawSearch = ({
  body,
  intentType,
  isFirstPage,
  requiredTermCount,
  sort,
  strictHitCount,
  limit,
  strictEnd,
}: ShouldRelaxOptions): boolean =>
  isFirstPage &&
  sort === "relevance" &&
  body.strict !== true &&
  intentType !== "identifier" &&
  requiredTermCount >= 2 &&
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

const TERM_COVERAGE_CONCURRENCY = 4;

type ReadTermCoverageOptions = {
  aggregate: CorpusIndexClient["aggregate"];
  observer: RegistryRequestObservation;
  indexId: string;
  /** One query per distinct required term, using the executed expansion dictionary. */
  queries: readonly string[];
  ids: readonly string[];
};

/**
 * Exact document membership per term, restricted to the bounded candidate set.
 * Buckets collapse repeated passages. No snippet or stored presentation field
 * participates; a missing excerpt cannot change the ranking.
 */
export const readTermCoverage = async ({
  aggregate,
  observer,
  indexId,
  queries,
  ids,
}: ReadTermCoverageOptions): Promise<
  Result<ReadonlyMap<string, number>, HandlerError<502 | 503>>
> => {
  if (ids.length === 0) {
    return Result.ok(new Map());
  }
  const coverage = new Map(ids.map((id) => [id, 0]));
  const candidates = `document_id: IN [${ids.map(quoteCorpusValue).join(" ")}]`;
  const results = await mapWithConcurrency({
    items: queries,
    limit: TERM_COVERAGE_CONCURRENCY,
    operation: async (
      query,
    ): Promise<Result<void, HandlerError<502 | 503>>> => {
      const answer = await aggregate({
        observer,
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
          new HandlerError({
            code: "upstream_unavailable",
            status: 503,
            message: "Search term coverage is temporarily unavailable",
            cause: answer.error,
          }),
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
        coverage.set(
          id,
          (coverage.get(id) ?? panic("Missing candidate coverage")) + 1,
        );
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
  coverageById: ReadonlyMap<string, number>;
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
      covered:
        coverageById.get(hit.id) ?? panic("Missing candidate term coverage"),
    }))
    .toSorted(
      (left, right) => right.covered - left.covered || left.index - right.index,
    )
    .map(({ hit }) => hit);

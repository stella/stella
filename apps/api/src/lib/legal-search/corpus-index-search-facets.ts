import { panic, Result, TaggedError } from "better-result";

import { Temporal } from "@stll/time";

import type {
  DecisionSearchFacets,
  SearchFacetBucket,
} from "@/api/lib/case-law/decision-search-facets";
import {
  compareFacetBuckets,
  compareYearBuckets,
} from "@/api/lib/case-law/decision-search-facets";
import type {
  CorpusIndexAggregations,
  CorpusIndexAggregateInput,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { DECISION_TIMESTAMP_FIELD } from "@/api/lib/legal-search/corpus-index-config";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Result-set facets served by corpus index aggregations.
 *
 * The index unit is a passage: several documents carry one decision's shared
 * fields, so a terms aggregation's `doc_count` counts passages and would read
 * as a wildly inflated decision count. Every bucket's number is therefore a
 * `cardinality` sub-aggregation over the generation's document-id field, which
 * `corpus-index-read-contract` has already proven fast — the columnar store an
 * aggregation reads. A generation that does not mark it fast never reaches
 * here: the contract refuses to build.
 *
 * Cross-filtering is a query-per-facet, not a parameter: a facet omits its own
 * filter so selecting a value inside it does not empty it. Facets whose query
 * comes out identical (the common case, a request with no filters at all)
 * share one engine round trip.
 */

/** A corpus-index aggregation could not be read as decision counts. */
class CorpusSearchFacetsError extends TaggedError("CorpusSearchFacetsError")<{
  message: string;
  cause?: unknown;
}> {}

export const CORPUS_SEARCH_FACET_NAMES = [
  "court",
  "decisionType",
  "source",
  "language",
  "year",
] as const;

export type CorpusSearchFacetName = (typeof CORPUS_SEARCH_FACET_NAMES)[number];

/**
 * How a facet is aggregated. `year` is a range rather than a terms
 * aggregation because the index maps no per-passage year: the projection
 * writes `decision_year` on a decision's opening passage only, so a terms
 * aggregation over it would describe the decisions a query matched in their
 * opening passage rather than the ones it matched at all. The timestamp field
 * is on every passage, and explicit calendar-year bounds over it are exact
 * where a fixed-interval histogram drifts a day per leap year.
 */
type CorpusFacetSpec =
  | { kind: "terms"; field: string; buckets: number }
  | { kind: "year_range"; field: string };

/**
 * What each facet aggregates, bound in both directions at compile time: the
 * map must answer for every name the list declares, and for every facet the
 * response declares, so neither side can grow a member the other does not
 * know about.
 */
export const CORPUS_SEARCH_FACET_SPEC = {
  // Every court of a jurisdiction, not the top twenty: the engine ranks
  // buckets by passage volume before the cardinality sub-aggregation runs, so
  // asking for the presentation limit here loses an apex court behind district
  // courts with longer dockets. The tier grouping caps what a reader sees.
  court: {
    kind: "terms",
    field: "court",
    buckets: LIMITS.caseLawCourtFacetBuckets,
  },
  decisionType: {
    kind: "terms",
    field: "document_type",
    buckets: LIMITS.caseLawFacetLimit,
  },
  source: { kind: "terms", field: "source", buckets: LIMITS.caseLawFacetLimit },
  language: {
    kind: "terms",
    field: "language",
    buckets: LIMITS.caseLawFacetLimit,
  },
  year: { kind: "year_range", field: DECISION_TIMESTAMP_FIELD },
} as const satisfies Record<CorpusSearchFacetName, CorpusFacetSpec> &
  Record<keyof DecisionSearchFacets, CorpusFacetSpec>;

/**
 * Oldest year a bucket is offered for. Everything below it falls into the one
 * catch-all bucket the engine adds, which is not a year a reader filters by.
 */
export const CORPUS_YEAR_FACET_FLOOR = 1900;

export type CorpusYearRange = { key: string; from: number; to: number };

/**
 * Midnight UTC on 1 January, as the engine takes a bound on a datetime fast
 * field: a number of NANOSECONDS since the epoch. An ISO string is refused and
 * milliseconds are read as nanoseconds, so the unit is the whole contract.
 *
 * Every such instant is a whole number of days times 86_400 x 10^9, whose odd
 * part is small enough to sit in a double's mantissa, so the conversion is
 * exact for every year this facet spans. The panic is the proof, not a
 * fallback: a bound that lost precision would move a year boundary silently.
 */
const startOfYearNanoseconds = (year: number): number => {
  const epochNanoseconds = Temporal.Instant.from(
    `${String(year).padStart(4, "0")}-01-01T00:00:00Z`,
  ).epochNanoseconds;
  const bound = Number(epochNanoseconds);
  return BigInt(bound) === epochNanoseconds
    ? bound
    : panic(`Year boundary ${year} is not exactly representable as a bound`);
};

/**
 * One half-open `[1 Jan, 1 Jan)` range per calendar year, keyed by the year.
 * Runs one year past the current one so a decision a publisher dated ahead
 * still lands in a bucket rather than in the engine's tail.
 */
export const corpusYearRanges = (currentYear: number): CorpusYearRange[] => {
  const ranges: CorpusYearRange[] = [];
  for (let year = CORPUS_YEAR_FACET_FLOOR; year <= currentYear + 1; year += 1) {
    ranges.push({
      key: String(year),
      from: startOfYearNanoseconds(year),
      to: startOfYearNanoseconds(year + 1),
    });
  }
  return ranges;
};

/**
 * Per-split candidate depth behind each bucket, as the browse facets use it:
 * terms aggregations merge per-split top-k lists, and a depth at `size` alone
 * makes the merge approximate across many splits.
 */
const FACET_SEGMENT_SIZE = 5000;

/** Sub-aggregation name under every terms bucket; never a facet's own name. */
const DECISIONS_AGGREGATION = "decisions";

/** Top-level aggregation name for the whole query's decision count. */
const TOTAL_AGGREGATION = "total";

type FacetAggregationsOptions = {
  decisionCountField: string;
  /** Facets this request answers; the aggregation is named after each. */
  names: readonly CorpusSearchFacetName[];
  /** Whether this request also carries the whole query's decision count. */
  withTotal: boolean;
  yearRanges: readonly CorpusYearRange[];
};

const facetAggregations = ({
  decisionCountField,
  names,
  withTotal,
  yearRanges,
}: FacetAggregationsOptions): Record<string, unknown> => {
  const decisions = {
    [DECISIONS_AGGREGATION]: {
      cardinality: { field: decisionCountField },
    },
  };
  const aggregationFor = (spec: CorpusFacetSpec): Record<string, unknown> => {
    switch (spec.kind) {
      case "terms":
        return {
          terms: {
            field: spec.field,
            size: spec.buckets,
            segment_size: FACET_SEGMENT_SIZE,
            // Passage volume, because that is the only order the engine can
            // rank buckets by before the sub-aggregation runs. It decides
            // which buckets survive `size`, never what a reader sees: the
            // parse re-sorts by the decision count below.
            order: { _count: "desc" },
          },
          aggs: decisions,
        };
      case "year_range":
        return {
          range: { field: spec.field, ranges: yearRanges },
          aggs: decisions,
        };
      default:
        spec satisfies never;
        return panic(`Unhandled corpus facet spec: ${String(spec)}`);
    }
  };
  const aggs: Record<string, unknown> = {};
  for (const name of names) {
    aggs[name] = aggregationFor(CORPUS_SEARCH_FACET_SPEC[name]);
  }
  if (withTotal) {
    aggs[TOTAL_AGGREGATION] = { cardinality: { field: decisionCountField } };
  }
  return aggs;
};

/**
 * A cardinality value, rounded to the count it estimates. The engine answers
 * with a JSON float from a sketch, and a fractional "3.0000000001 decisions"
 * is not a number to put in front of a reader. Null when the shape is not one.
 */
const readCardinality = (aggregation: unknown): number | null => {
  if (!isRecord(aggregation)) {
    return null;
  }
  const value = aggregation["value"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
};

/**
 * Terms buckets as decision counts, or null when the engine returned a shape
 * this facet cannot be read from. Null is a hard failure, never an empty
 * facet: silently reporting "no courts" would look like a query nothing
 * answers.
 */
const parseFacetBuckets = (
  aggregation: unknown,
): SearchFacetBucket[] | null => {
  if (!isRecord(aggregation) || !Array.isArray(aggregation["buckets"])) {
    return null;
  }
  const buckets: SearchFacetBucket[] = [];
  for (const bucket of aggregation["buckets"]) {
    if (!isRecord(bucket)) {
      return null;
    }
    const key = bucket["key"];
    const count = readCardinality(bucket[DECISIONS_AGGREGATION]);
    if (typeof key !== "string" || key.length === 0 || count === null) {
      return null;
    }
    buckets.push({ value: key, label: null, count });
  }
  return buckets.sort(compareFacetBuckets);
};

/**
 * Range buckets as decision counts. Only the years this request asked for are
 * read: the engine adds one unkeyed catch-all bucket for everything below the
 * first bound, and a decision older than the floor is not a year a reader
 * filters by. A year nothing matched is dropped rather than shown as zero, so
 * the facet lists the years the result set actually spans.
 */
const parseYearBuckets = (
  aggregation: unknown,
  ranges: readonly CorpusYearRange[],
): SearchFacetBucket[] | null => {
  if (!isRecord(aggregation) || !Array.isArray(aggregation["buckets"])) {
    return null;
  }
  const requested = new Set(ranges.map((range) => range.key));
  const buckets: SearchFacetBucket[] = [];
  for (const bucket of aggregation["buckets"]) {
    if (!isRecord(bucket)) {
      return null;
    }
    const key = bucket["key"];
    if (typeof key !== "string" || !requested.has(key)) {
      continue;
    }
    const count = readCardinality(bucket[DECISIONS_AGGREGATION]);
    if (count === null) {
      return null;
    }
    if (count > 0) {
      buckets.push({ value: key, label: null, count });
    }
  }
  return buckets.sort(compareYearBuckets);
};

/** The buckets a facet's own aggregation kind reads out of the answer. */
const parseFacetAggregation = (
  name: CorpusSearchFacetName,
  aggregation: unknown,
  yearRanges: readonly CorpusYearRange[],
): SearchFacetBucket[] | null => {
  const spec: CorpusFacetSpec = CORPUS_SEARCH_FACET_SPEC[name];
  switch (spec.kind) {
    case "terms":
      return parseFacetBuckets(aggregation);
    case "year_range":
      return parseYearBuckets(aggregation, yearRanges);
    default:
      spec satisfies never;
      return panic(`Unhandled corpus facet spec: ${String(spec)}`);
  }
};

/** One engine round trip: the facets that share a query, and their names. */
type FacetRequest = {
  names: CorpusSearchFacetName[];
  query: string;
  withTotal: boolean;
};

/**
 * Group the facets by the query they run under, so a request with no filters
 * — every cross-filtered query identical to the full one — costs one round
 * trip instead of five.
 */
const facetRequests = (
  queryFor: CorpusFacetQuery,
  totalQuery: string,
): FacetRequest[] => {
  const byQuery = new Map<string, FacetRequest>();
  const requestFor = (query: string): FacetRequest => {
    const existing = byQuery.get(query);
    if (existing !== undefined) {
      return existing;
    }
    const created: FacetRequest = { names: [], query, withTotal: false };
    byQuery.set(query, created);
    return created;
  };
  requestFor(totalQuery).withTotal = true;
  for (const name of CORPUS_SEARCH_FACET_NAMES) {
    requestFor(queryFor(name)).names.push(name);
  }
  return [...byQuery.values()];
};

/**
 * The engine query one facet is counted under: this facet's own filter
 * dropped, every other filter kept.
 *
 * A function rather than a record, because a record is a shape a facet can go
 * missing from — and a facet whose query went missing is sent to the engine
 * with no query at all, which it refuses, taking the whole filter rail and the
 * result total down with it. Asked per name from the declared list, a facet
 * added to that list cannot be forgotten here.
 */
export type CorpusFacetQuery = (facet: CorpusSearchFacetName) => string;

/** The engine call this read makes; injected so a test needs no network. */
export type CorpusAggregate = (
  input: Pick<CorpusIndexAggregateInput, "query" | "aggs">,
) => Promise<Result<CorpusIndexAggregations, CorpusIndexError>>;

type ReadCorpusSearchFacetsOptions = {
  aggregate: CorpusAggregate;
  /** Newest year the facet offers a bucket for, minus the one-year lookahead. */
  currentYear: number;
  decisionCountField: string;
  queryFor: CorpusFacetQuery;
  /** The request's full query: what the total counts. */
  totalQuery: string;
};

type CorpusSearchFacetsRead = {
  facets: Record<CorpusSearchFacetName, SearchFacetBucket[]>;
  /** Distinct decisions the whole query matches. */
  total: number;
};

export const readCorpusSearchFacets = async ({
  aggregate,
  currentYear,
  decisionCountField,
  queryFor,
  totalQuery,
}: ReadCorpusSearchFacetsOptions): Promise<
  Result<CorpusSearchFacetsRead, CorpusSearchFacetsError>
> => {
  const yearRanges = corpusYearRanges(currentYear);
  const requests = facetRequests(queryFor, totalQuery);
  const answers = await Promise.all(
    requests.map(
      async ({ names, query, withTotal }) =>
        await aggregate({
          query,
          aggs: facetAggregations({
            decisionCountField,
            names,
            withTotal,
            yearRanges,
          }),
        }),
    ),
  );

  const facets: Partial<Record<CorpusSearchFacetName, SearchFacetBucket[]>> =
    {};
  let total: number | null = null;
  for (const [index, answer] of answers.entries()) {
    const request = requests[index];
    if (request === undefined) {
      return Result.err(
        new CorpusSearchFacetsError({
          message: "corpus index facet answers did not match the requests",
        }),
      );
    }
    if (Result.isError(answer)) {
      return Result.err(
        new CorpusSearchFacetsError({
          message: answer.error.message,
          cause: answer.error,
        }),
      );
    }
    if (request.withTotal) {
      total = readCardinality(answer.value[TOTAL_AGGREGATION]);
    }
    for (const name of request.names) {
      const buckets = parseFacetAggregation(
        name,
        answer.value[name],
        yearRanges,
      );
      if (buckets === null) {
        return Result.err(
          new CorpusSearchFacetsError({
            message: `corpus index returned an unreadable ${name} facet aggregation`,
          }),
        );
      }
      facets[name] = buckets;
    }
  }

  const court = facets.court;
  const decisionType = facets.decisionType;
  const source = facets.source;
  const language = facets.language;
  const year = facets.year;
  if (
    court === undefined ||
    decisionType === undefined ||
    source === undefined ||
    language === undefined ||
    year === undefined ||
    total === null
  ) {
    return Result.err(
      new CorpusSearchFacetsError({
        message: "corpus index did not answer every requested facet",
      }),
    );
  }
  return Result.ok({
    facets: { court, decisionType, source, language, year },
    total,
  });
};

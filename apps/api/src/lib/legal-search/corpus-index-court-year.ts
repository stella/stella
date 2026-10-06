import { CASE_LAW_COURT_YEAR_BUCKET_LIMIT } from "@stll/api-contract/case-law-court-year";

import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

import { DECISION_TIMESTAMP_FIELD } from "./corpus-index-config";
import type { CorpusYearRange } from "./corpus-index-search-facets";

/** Bound intermediate courts; the shared contract caps the published matrix. */
const COURT_CANDIDATE_LIMIT = LIMITS.caseLawFacetLimit + 1;
// Nested year/cardinality states are allocated per candidate court. Keep the
// split depth bounded too; incomplete merges are rejected by the decoder.
const COURT_SEGMENT_SIZE = COURT_CANDIDATE_LIMIT * 2;

type CourtYearAggregationOptions = {
  decisionCountField: string;
  yearRanges: readonly CorpusYearRange[];
};

export const courtYearAggregation = ({
  decisionCountField,
  yearRanges,
}: CourtYearAggregationOptions) => ({
  terms: {
    field: "court",
    size: COURT_CANDIDATE_LIMIT,
    segment_size: COURT_SEGMENT_SIZE,
    order: { _count: "desc" },
  },
  aggs: {
    years: {
      range: { field: DECISION_TIMESTAMP_FIELD, ranges: yearRanges },
      aggs: { decisions: { cardinality: { field: decisionCountField } } },
    },
  },
});

export type CorpusCourtYearBucket = {
  court: string;
  year: number;
  count: number;
};

export type CorpusCourtYear = {
  buckets: CorpusCourtYearBucket[];
  truncated: boolean;
};

type ParseCourtYearOptions = {
  aggregation: unknown;
  yearRanges: readonly CorpusYearRange[];
};

/** A malformed engine answer is unavailable, never an empty result set. */
export const parseCourtYearAggregation = ({
  aggregation,
  yearRanges,
}: ParseCourtYearOptions): CorpusCourtYear | null => {
  if (!isRecord(aggregation) || !Array.isArray(aggregation["buckets"])) {
    return null;
  }
  const omitted = aggregation["sum_other_doc_count"];
  const errorBound = aggregation["doc_count_error_upper_bound"];
  if (
    typeof omitted !== "number" ||
    !Number.isFinite(omitted) ||
    omitted < 0 ||
    typeof errorBound !== "number" ||
    !Number.isFinite(errorBound) ||
    errorBound !== 0
  ) {
    return null;
  }
  const years = new Map(yearRanges.map(({ key }) => [key, Number(key)]));
  const buckets: CorpusCourtYearBucket[] = [];
  let truncated = omitted > 0;
  for (const court of aggregation["buckets"]) {
    if (
      !isRecord(court) ||
      typeof court["key"] !== "string" ||
      !isRecord(court["years"]) ||
      !Array.isArray(court["years"]["buckets"])
    ) {
      return null;
    }
    for (const range of court["years"]["buckets"]) {
      if (!isRecord(range) || !isRecord(range["decisions"])) {
        return null;
      }
      const value = range["decisions"]["value"];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > Number.MAX_SAFE_INTEGER
      ) {
        return null;
      }
      const count = Math.round(value);
      if (count === 0) {
        continue;
      }
      const key = range["key"];
      const year = typeof key === "string" ? years.get(key) : undefined;
      if (year === undefined || court["key"].length === 0) {
        truncated = true;
        continue;
      }
      buckets.push({ court: court["key"], year, count });
    }
  }
  buckets.sort((a, b) => {
    const countOrder = b.count - a.count;
    if (countOrder !== 0) {
      return countOrder;
    }
    if (a.court === b.court) {
      return b.year - a.year;
    }
    return a.court < b.court ? -1 : 1;
  });
  return {
    buckets: buckets.slice(0, CASE_LAW_COURT_YEAR_BUCKET_LIMIT),
    truncated: truncated || buckets.length > CASE_LAW_COURT_YEAR_BUCKET_LIMIT,
  };
};

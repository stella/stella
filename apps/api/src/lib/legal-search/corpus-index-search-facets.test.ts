import { Result } from "better-result";
import { expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexAggregations } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_SEARCH_FACET_NAMES,
  CORPUS_SEARCH_FACET_SPEC,
  CORPUS_YEAR_FACET_FLOOR,
  type CorpusAggregate,
  type CorpusFacetQuery,
  type CorpusSearchFacetName,
  corpusYearRanges,
  readCorpusSearchFacets,
} from "@/api/lib/legal-search/corpus-index-search-facets";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";

const DOCUMENT_ID = "document_id";
const QUERY = "text:promlčení";
const CURRENT_YEAR = 2026;

/** A terms bucket as the engine answers it: passages, plus the decisions. */
const engineBucket = (key: string, passages: number, decisions: number) => ({
  key,
  doc_count: passages,
  decisions: { value: decisions },
});

type FakeEngine = {
  aggregate: CorpusAggregate;
  requests: { query: string; aggs: Record<string, unknown> }[];
};

/**
 * An engine that answers every requested facet with one bucket named after
 * the field it aggregated, so a test can see which query each facet ran under.
 */
const fakeEngine = (options?: {
  decisionsPerBucket?: number;
  passagesPerBucket?: number;
  total?: number;
}): FakeEngine => {
  const requests: FakeEngine["requests"] = [];
  return {
    requests,
    aggregate: async ({ query, aggs }) => {
      requests.push({ query, aggs });
      const answered: CorpusIndexAggregations = {};
      for (const name of Object.keys(aggs)) {
        if (name === "total") {
          answered[name] = { value: options?.total ?? 7 };
          continue;
        }
        answered[name] = {
          buckets: [
            engineBucket(
              name === "year" ? "2024" : `${name}-value`,
              options?.passagesPerBucket ?? 40,
              options?.decisionsPerBucket ?? 3,
            ),
          ],
        };
      }
      return Result.ok(answered);
    },
  };
};

const sameQueryForEveryFacet =
  (query: string): CorpusFacetQuery =>
  () =>
    query;

const read = async (
  engine: FakeEngine,
  queryFor = sameQueryForEveryFacet(QUERY),
) =>
  await readCorpusSearchFacets({
    aggregate: engine.aggregate,
    currentYear: CURRENT_YEAR,
    decisionCountField: DOCUMENT_ID,
    queryFor,
    totalQuery: QUERY,
  });

/**
 * The whole point of the cardinality sub-aggregation: the index unit is a
 * passage, so `doc_count` is a passage count and reporting it would inflate
 * every bucket by however many passages a decision happens to have.
 */
test("a bucket counts decisions, never the passages behind them", async () => {
  const engine = fakeEngine({ decisionsPerBucket: 3, passagesPerBucket: 40 });

  const result = await read(engine);

  expect(Result.isError(result)).toBe(false);
  if (Result.isError(result)) {
    return;
  }
  expect(result.value.facets.court).toEqual([
    { value: "court-value", label: null, count: 3 },
  ]);
});

test("the total counts distinct decisions over the whole query", async () => {
  const engine = fakeEngine({ total: 412 });

  const result = await read(engine);

  expect(Result.isError(result) ? null : result.value.total).toBe(412);
});

test("every facet aggregates its own index field, by its own kind", async () => {
  const engine = fakeEngine();

  await read(engine);

  const describeAggregation = (aggregation: unknown): unknown => {
    if (!isRecord(aggregation)) {
      return null;
    }
    for (const kind of ["terms", "range"]) {
      const body = aggregation[kind];
      if (isRecord(body)) {
        return kind === "terms"
          ? { kind, field: body["field"], buckets: body["size"] }
          : { kind: "year_range", field: body["field"] };
      }
    }
    return null;
  };
  expect(
    Object.fromEntries(
      engine.requests.flatMap((request) =>
        Object.entries(request.aggs).flatMap(([name, aggregation]) =>
          name === "total" ? [] : [[name, describeAggregation(aggregation)]],
        ),
      ),
    ),
  ).toEqual(CORPUS_SEARCH_FACET_SPEC);
});

// A request with no filters cross-filters to the same query everywhere, and
// five identical aggregation requests are four engine round trips a reader
// waits through for nothing.
test("facets sharing a query share one engine round trip", async () => {
  const engine = fakeEngine();

  await read(engine);

  expect(engine.requests).toHaveLength(1);
  expect(Object.keys(engine.requests.at(0)?.aggs ?? {}).sort()).toEqual(
    [...CORPUS_SEARCH_FACET_NAMES, "total"].sort(),
  );
});

// Cross-filtering is a query per facet: the court facet counts across every
// court, so it cannot run under the query that narrows to one.
test("a facet with its own filter dropped runs under its own query", async () => {
  const engine = fakeEngine();
  const filtered = `${QUERY} AND court:"Nejvyšší soud"`;

  await readCorpusSearchFacets({
    aggregate: engine.aggregate,
    currentYear: CURRENT_YEAR,
    decisionCountField: DOCUMENT_ID,
    queryFor: (facet) => (facet === "court" ? QUERY : filtered),
    totalQuery: filtered,
  });

  expect(engine.requests).toHaveLength(2);
  const queryFor = (aggregation: string): string | undefined =>
    engine.requests.find((request) =>
      Object.keys(request.aggs).includes(aggregation),
    )?.query;
  expect(queryFor("court")).toBe(QUERY);
  // The total describes the request as asked, so it keeps every filter.
  expect(queryFor("total")).toBe(filtered);
  expect(queryFor("language")).toBe(filtered);
});

test("a refused aggregation is an error, never an empty facet", async () => {
  const result = await readCorpusSearchFacets({
    aggregate: async () =>
      Result.err(new CorpusIndexError({ message: "engine refused" })),
    currentYear: CURRENT_YEAR,
    decisionCountField: DOCUMENT_ID,
    queryFor: sameQueryForEveryFacet(QUERY),
    totalQuery: QUERY,
  });

  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toContain("engine refused");
  }
});

// A bucket the engine did not count decisions for cannot be served with its
// passage count instead, which is the one substitution that looks plausible.
test("a bucket with no decision count fails the read", async () => {
  const result = await readCorpusSearchFacets({
    aggregate: async ({ aggs }) =>
      Result.ok(
        Object.fromEntries(
          Object.keys(aggs).map((name) => [
            name,
            name === "total"
              ? { value: 3 }
              : { buckets: [{ key: `${name}-value`, doc_count: 40 }] },
          ]),
        ),
      ),
    currentYear: CURRENT_YEAR,
    decisionCountField: DOCUMENT_ID,
    queryFor: sameQueryForEveryFacet(QUERY),
    totalQuery: QUERY,
  });

  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toContain("unreadable");
  }
});

// The engine ranks buckets by passage volume, which is the only order it can
// take before the sub-aggregation runs; what a reader sees is decisions.
test("buckets are ordered by decisions, not by the engine's passage order", async () => {
  const result = await readCorpusSearchFacets({
    aggregate: async ({ aggs }) =>
      Result.ok(
        Object.fromEntries(
          Object.keys(aggs).map((name) => [
            name,
            name === "total"
              ? { value: 9 }
              : {
                  buckets: [
                    engineBucket("wordy", 900, 2),
                    engineBucket("many", 100, 40),
                  ],
                },
          ]),
        ),
      ),
    currentYear: CURRENT_YEAR,
    decisionCountField: DOCUMENT_ID,
    queryFor: sameQueryForEveryFacet(QUERY),
    totalQuery: QUERY,
  });

  expect(
    Result.isError(result)
      ? null
      : result.value.facets.language.map((facetBucket) => facetBucket.value),
  ).toEqual(["many", "wordy"]);
});

test("every aggregation counts over the generation's document-id field", async () => {
  const engine = fakeEngine();

  await read(engine);

  const cardinalityFields = JSON.stringify(engine.requests.at(0)?.aggs).match(
    /"cardinality":\{"field":"(?<field>[^"]+)"\}/gu,
  );
  expect(cardinalityFields).toHaveLength(CORPUS_SEARCH_FACET_NAMES.length + 1);
  expect(
    cardinalityFields?.every((entry) => entry.includes(`"${DOCUMENT_ID}"`)),
  ).toBe(true);
});

/**
 * The unit is the whole contract: the engine refuses an ISO string on this
 * bound and reads milliseconds as nanoseconds, so a bound off by 10^6 would
 * put every decision in the wrong year without failing anything.
 */
test("year bounds are nanoseconds at midnight UTC on 1 January", () => {
  const ranges = corpusYearRanges(CURRENT_YEAR);

  expect(ranges.at(0)).toEqual({
    key: String(CORPUS_YEAR_FACET_FLOOR),
    from: Number(
      Temporal.Instant.from("1900-01-01T00:00:00Z").epochNanoseconds,
    ),
    to: Number(Temporal.Instant.from("1901-01-01T00:00:00Z").epochNanoseconds),
  });
  // The bound the engine was given for 2024, verified against the live index.
  expect(ranges.find((range) => range.key === "2024")).toEqual({
    key: "2024",
    from: 1_704_067_200_000_000_000,
    to: 1_735_689_600_000_000_000,
  });
  for (const range of ranges) {
    expect(Number.isSafeInteger(range.from / 1e9)).toBe(true);
    expect(
      Temporal.Instant.fromEpochNanoseconds(BigInt(range.from)).toString(),
    ).toBe(`${range.key}-01-01T00:00:00Z`);
  }
});

// One bucket per calendar year, running a year past the current one so a
// decision dated ahead lands in a year rather than in the engine's tail.
test("the year ranges span the floor to one year ahead", () => {
  const ranges = corpusYearRanges(CURRENT_YEAR);

  expect(ranges.at(0)?.key).toBe(String(CORPUS_YEAR_FACET_FLOOR));
  expect(ranges.at(-1)?.key).toBe(String(CURRENT_YEAR + 1));
  expect(ranges).toHaveLength(CURRENT_YEAR + 2 - CORPUS_YEAR_FACET_FLOOR);
  // Half-open and contiguous: no decision falls between two buckets.
  for (const [index, range] of ranges.entries()) {
    expect(range.to).toBe(ranges[index + 1]?.from ?? range.to);
  }
});

test("a year bucket reports its distinct decisions, newest year first", async () => {
  const result = await readCorpusSearchFacets({
    aggregate: async ({ aggs }) =>
      Result.ok(
        Object.fromEntries(
          Object.keys(aggs).map((name) => {
            if (name === "total") {
              return [name, { value: 9 }];
            }
            if (name !== "year") {
              return [name, { buckets: [engineBucket(name, 40, 3)] }];
            }
            return [
              name,
              {
                buckets: [
                  // The unkeyed catch-all the engine adds below the first
                  // bound: older than the floor, and not a year to filter by.
                  { key: "*--2208988800000000000", doc_count: 12 },
                  engineBucket("2019", 90, 4),
                  engineBucket("2024", 40, 11),
                  // A year the result set does not reach is not a zero row.
                  engineBucket("2022", 0, 0),
                ],
              },
            ];
          }),
        ),
      ),
    currentYear: CURRENT_YEAR,
    decisionCountField: DOCUMENT_ID,
    queryFor: sameQueryForEveryFacet(QUERY),
    totalQuery: QUERY,
  });

  expect(Result.isError(result) ? null : result.value.facets.year).toEqual([
    { value: "2024", label: null, count: 11 },
    { value: "2019", label: null, count: 4 },
  ]);
});

// Cross-filtering for the year facet drops the date range, not a terms filter.
test("the year facet runs under the query its own filter was dropped from", async () => {
  const engine = fakeEngine();
  const dated = `${QUERY} AND decision_date:[2024-01-01 TO 2024-12-31]`;

  await readCorpusSearchFacets({
    aggregate: engine.aggregate,
    currentYear: CURRENT_YEAR,
    decisionCountField: DOCUMENT_ID,
    queryFor: (facet) => (facet === "year" ? QUERY : dated),
    totalQuery: dated,
  });

  expect(engine.requests).toHaveLength(2);
  expect(
    engine.requests.find((request) =>
      Object.keys(request.aggs).includes("year"),
    )?.query,
  ).toBe(QUERY);
});

/**
 * The regression this shape exists to make impossible: a facet whose query
 * went missing reached the engine with no `query` at all, which it refuses,
 * taking the whole filter rail and the result total down with it.
 */
test("every declared facet is asked for its own query", async () => {
  const engine = fakeEngine();
  const asked: CorpusSearchFacetName[] = [];

  await read(engine, (facet) => {
    asked.push(facet);
    return `${QUERY} AND facet:${facet}`;
  });

  expect(new Set(asked)).toEqual(new Set(CORPUS_SEARCH_FACET_NAMES));
  expect(
    engine.requests.every(
      (request) =>
        typeof request.query === "string" && request.query.length > 0,
    ),
  ).toBe(true);
  // Five distinct facet queries plus the unfiltered total's own.
  expect(engine.requests).toHaveLength(CORPUS_SEARCH_FACET_NAMES.length + 1);
});

// Presence of an apex court must not depend on how much the district courts
// published, so the court aggregation asks for every court a jurisdiction
// spells; the cap a reader sees is applied per tier, after the grouping.
test("the court aggregation asks for every court, not the display limit", async () => {
  const engine = fakeEngine();

  await read(engine);

  const courtTerms = engine.requests
    .flatMap((request) => Object.entries(request.aggs))
    .find(([name]) => name === "court")
    ?.at(1);
  const terms = isRecord(courtTerms) ? courtTerms["terms"] : null;
  expect(isRecord(terms) ? terms["size"] : null).toBe(
    LIMITS.caseLawCourtFacetBuckets,
  );
  expect(LIMITS.caseLawCourtFacetBuckets).toBeGreaterThan(
    LIMITS.caseLawFacetLimit,
  );
  // The per-split candidate depth has to cover the buckets asked for, or the
  // merge across splits is approximate again.
  expect(
    isRecord(terms) ? Number(terms["segment_size"]) : 0,
  ).toBeGreaterThanOrEqual(LIMITS.caseLawCourtFacetBuckets);
});

import { Result } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as v from "valibot";

import {
  browseFacetNames,
  corpusIndexBrowseFacets as readCorpusIndexBrowseFacets,
} from "@/api/lib/legal-search/corpus-index-facets";
import type { ServingCorpusIndexGeneration } from "@/api/lib/legal-search/corpus-index-generation-store";

const segmentSizeSchema = v.pipe(
  v.object({ terms: v.object({ segment_size: v.number() }) }),
  v.transform(({ terms }) => terms.segment_size),
);

/**
 * The facet path reads the engine's aggregation response, so what can go wrong
 * is the reading: counting passages instead of decisions, mistaking a numeric
 * bucket key for a missing one, and — the one that would be invisible —
 * turning an unreadable response into an empty facet set, which renders as a
 * corpus with no courts in it.
 *
 * These stub the engine's HTTP response rather than mock the client module, so
 * the request body the engine would receive is asserted too.
 */

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const originalFetch = globalThis.fetch;

let requests: { url: string; body: Record<string, unknown> }[];
let responseBody: unknown;
let responseStatus: number;
const servingGeneration: ServingCorpusIndexGeneration = {
  family: "case_law",
  generation: "case_law_v5",
  cluster: "q09",
};

const corpusIndexBrowseFacets = async (
  query: Parameters<typeof readCorpusIndexBrowseFacets>[0],
) =>
  await readCorpusIndexBrowseFacets(query, {
    readServingGeneration: async () => await Promise.resolve(servingGeneration),
  });

beforeEach(() => {
  requests = [];
  responseStatus = 200;
  responseBody = { aggregations: {} };
  const stub = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    requests.push({
      url: requestUrl(input),
      body: v.parse(
        v.pipe(
          v.string(),
          v.transform((body: string) => JSON.parse(body)),
          v.record(v.string(), v.unknown()),
        ),
        init?.body,
      ),
    });
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type TermsBucket = { key: string | number; count: number };

/**
 * The engine reports `doc_count_error_upper_bound` for a `_count`-ordered
 * terms aggregation, where the merged per-split top-k can miss a term, and
 * omits it entirely for a `_key`-ordered one. A fixture that carried the
 * bound everywhere would never show the parser the shape production sends.
 */
const keyOrderedAggregation = (buckets: TermsBucket[]) => ({
  buckets: buckets.map(({ key, count }) => ({ key, doc_count: count })),
  sum_other_doc_count: 0,
});
const countOrderedAggregation = (buckets: TermsBucket[]) => ({
  ...keyOrderedAggregation(buckets),
  doc_count_error_upper_bound: 0,
});

/** Trimmed from a production response to the request the code sends. */
const engineResponse = () => ({
  aggregations: {
    country: countOrderedAggregation([{ key: "CZE", count: 1_034_713 }]),
    court: countOrderedAggregation([
      { key: "Nejvyšší soud", count: 165_146 },
      { key: "Ústavní soud", count: 104_627 },
      { key: "Nejvyšší správní soud", count: 79_436 },
    ]),
    // A u64 fast field comes back as a JSON float.
    year: keyOrderedAggregation([
      { key: 2026, count: 42_961 },
      { key: 2025, count: 85_590 },
      { key: 2024, count: 85_939 },
    ]),
  },
});

const aggregationsSchema = v.record(
  v.string(),
  v.record(v.string(), v.unknown()),
);

const respondedAggregations = (): Record<string, Record<string, unknown>> =>
  v.parse(aggregationsSchema, engineResponse().aggregations);

const respondedAggregation = (name: string): Record<string, unknown> =>
  v.parse(v.record(v.string(), v.unknown()), respondedAggregations()[name]);

const requestedAggregations = (): Record<string, unknown> =>
  v.parse(v.record(v.string(), v.unknown()), requests.at(0)?.body["aggs"]);

const orderingsSchema = v.record(
  v.string(),
  v.object({ terms: v.object({ order: v.record(v.string(), v.string()) }) }),
);

/** Facet name to the single key of the order it was requested with. */
const requestedOrderings = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(v.parse(orderingsSchema, requests.at(0)?.body["aggs"])).map(
      ([name, { terms }]) => [name, Object.keys(terms.order).join(",")],
    ),
  );

test("aggregates over opening passages only, so buckets count decisions", async () => {
  responseBody = engineResponse();

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(false);
  // Every passage of a decision carries the decision's court and country, so
  // an unrestricted aggregation would count a long judgment once per passage.
  expect(requests.at(0)?.body["query"]).toBe("is_opening:true");
  expect(requests.at(0)?.body["max_hits"]).toBe(0);
});

test("facets use only manifest-owned fields", async () => {
  responseBody = engineResponse();

  await corpusIndexBrowseFacets({ excludedSourceIds: [], limit: 20 });

  expect(requests.at(0)?.url).toContain("/case_law_v5_*/search");
  expect(requests.at(0)?.body["query"]).toBe("is_opening:true");
  expect(requestedAggregations()["year"]).toMatchObject({
    terms: { field: "decision_year" },
  });
});

test("requests exactly the aggregations the response is read from", async () => {
  responseBody = engineResponse();

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });
  if (Result.isError(result)) {
    throw result.error;
  }

  // Both directions: an aggregation nobody reads is dead engine work, and a
  // facet nobody requested can only ever come back empty.
  expect(Object.keys(requestedAggregations()).toSorted()).toEqual(
    browseFacetNames.toSorted(),
  );
  expect(Object.keys(result.value).toSorted()).toEqual(
    browseFacetNames.toSorted(),
  );
});

test("reads string and numeric bucket keys into the same bucket shape", async () => {
  responseBody = engineResponse();

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });
  if (Result.isError(result)) {
    throw result.error;
  }

  expect(result.value.country).toEqual([{ value: "CZE", count: 1_034_713 }]);
  expect(result.value.court.at(0)).toEqual({
    value: "Nejvyšší soud",
    count: 165_146,
  });
  // The year facet's contract is a string bucket value, as the Postgres path
  // produced with to_char; "2026", never "2026.0".
  expect(result.value.year.at(0)).toEqual({ value: "2026", count: 42_961 });
});

test("the fixture omits the exactness bound exactly where the engine does", async () => {
  responseBody = engineResponse();

  await corpusIndexBrowseFacets({ excludedSourceIds: [], limit: 20 });

  // Binds the fixture to the ordering the code actually requests, so changing
  // a facet's order cannot leave a fixture the engine would never send.
  expect(
    Object.fromEntries(
      Object.entries(respondedAggregations()).map(([name, aggregation]) => [
        name,
        "doc_count_error_upper_bound" in aggregation,
      ]),
    ),
  ).toEqual(
    Object.fromEntries(
      Object.entries(requestedOrderings()).map(([name, orderedBy]) => [
        name,
        orderedBy === "_count",
      ]),
    ),
  );
});

test("a key-ordered facet is exact without a bound the engine never sends", async () => {
  responseBody = engineResponse();
  // The fault boundary: rejecting this facet emptied all three in production.
  expect("doc_count_error_upper_bound" in respondedAggregation("year")).toBe(
    false,
  );

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });
  if (Result.isError(result)) {
    throw result.error;
  }

  expect(result.value.year).toEqual([
    { value: "2026", count: 42_961 },
    { value: "2025", count: 85_590 },
    { value: "2024", count: 85_939 },
  ]);
  expect(result.value.country).not.toHaveLength(0);
  expect(result.value.court).not.toHaveLength(0);
});

test("a key-ordered facet stating an error bound fails like any other", async () => {
  responseBody = {
    aggregations: {
      ...engineResponse().aggregations,
      year: {
        ...keyOrderedAggregation([{ key: 2026, count: 42_961 }]),
        // Absence is the contract, not a licence to ignore a stated bound.
        doc_count_error_upper_bound: 17,
      },
    },
  };

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(true);
});

test("a count-ordered facet missing its error bound fails", async () => {
  responseBody = {
    aggregations: {
      ...engineResponse().aggregations,
      // The engine always states the bound for `_count` ordering, so its
      // absence here is an unrecognized response, not an exact one.
      court: keyOrderedAggregation([{ key: "Nejvyšší soud", count: 165_146 }]),
    },
  };

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(true);
});

test("scopes to one jurisdiction index, and to the generation glob without one", async () => {
  responseBody = engineResponse();
  const generation = servingGeneration.generation;

  await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    jurisdiction: "CZE",
    limit: 20,
  });
  await corpusIndexBrowseFacets({ excludedSourceIds: [], limit: 20 });

  expect(requests.at(0)?.url).toContain(`/${generation}_cs_sk/search`);
  expect(requests.at(1)?.url).toContain(`/${generation}_*/search`);
});

test("a scoped query on a shared index carries its jurisdiction as a clause", async () => {
  responseBody = engineResponse();
  // CZE and SVK share one physical index, so selecting the index alone would
  // aggregate over both countries.
  await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    jurisdiction: "CZE",
    limit: 20,
  });
  await corpusIndexBrowseFacets({
    excludedSourceIds: ["018f0a2b-0000-7000-8000-000000000001"],
    jurisdiction: "POL",
    limit: 20,
  });

  expect(requests.at(0)?.url).toContain("/case_law_v5_cs_sk/search");
  expect(requests.at(0)?.body["query"]).toBe(
    'is_opening:true AND jurisdiction:"CZE"',
  );
  // A single-country index needs no clause; the source exclusion still lands.
  expect(requests.at(1)?.url).toContain("/case_law_v5_pol/search");
  expect(requests.at(1)?.body["query"]).toBe(
    'is_opening:true AND NOT (source:"018f0a2b-0000-7000-8000-000000000001")',
  );
});

test("asks for bucket depth beyond the requested size", async () => {
  responseBody = engineResponse();

  await corpusIndexBrowseFacets({ excludedSourceIds: [], limit: 20 });

  // Terms aggregations merge per-split top-k lists: at a depth of `size` the
  // merged counts are approximate, which would show wrong numbers next to
  // every court in the filter.
  const country = requestedAggregations()["country"];
  expect(country).toMatchObject({
    terms: { field: "jurisdiction", size: 20 },
  });
  expect(v.parse(segmentSizeSchema, country)).toBeGreaterThan(20);
});

test("excludes sources that may no longer be redistributed", async () => {
  responseBody = engineResponse();

  await corpusIndexBrowseFacets({
    excludedSourceIds: [
      "018f0a2b-0000-7000-8000-000000000001",
      "018f0a2b-0000-7000-8000-000000000002",
    ],
    limit: 20,
  });

  // Projection keeps ineligible sources out of the index, but a revocation
  // only queues their documents for removal: without this clause the buckets
  // keep counting them until reconciliation catches up.
  expect(requests.at(0)?.body["query"]).toBe(
    'is_opening:true AND NOT (source:"018f0a2b-0000-7000-8000-000000000001" OR source:"018f0a2b-0000-7000-8000-000000000002")',
  );
});

test("an approximate aggregation fails rather than serving wrong counts", async () => {
  responseBody = {
    aggregations: {
      ...engineResponse().aggregations,
      court: {
        ...countOrderedAggregation([{ key: "Nejvyšší soud", count: 165_146 }]),
        // The engine's own statement that the merged top-k is not exact.
        doc_count_error_upper_bound: 17,
      },
    },
  };

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(true);
});

test("an unreadable aggregation fails rather than reporting an empty corpus", async () => {
  responseBody = {
    aggregations: {
      ...engineResponse().aggregations,
      // A bucket with no `doc_count` is the shape under test; the exactness
      // bound is stated so this fails on the bucket rather than on it.
      court: {
        buckets: [{ key: "Nejvyšší soud" }],
        doc_count_error_upper_bound: 0,
      },
    },
  };

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(true);
});

test("a missing aggregation fails rather than reporting an empty corpus", async () => {
  responseBody = { aggregations: { country: countOrderedAggregation([]) } };

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(true);
});

test("an engine failure returns a typed error, not a throw", async () => {
  responseStatus = 503;
  responseBody = { message: "service unavailable" };

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error._tag).toBe("LegalBrowseFacetsError");
  }
});

import { Result } from "better-result";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { envBase } from "@/api/env-base";
import * as corpusFamily from "@/api/lib/legal-search/corpus-family";
import { corpusGeneration } from "@/api/lib/legal-search/corpus-family";
import {
  browseFacetNames,
  corpusIndexBrowseFacets,
} from "@/api/lib/legal-search/corpus-index-facets";

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

const termsAggregation = (
  buckets: { key: string | number; count: number }[],
) => ({
  buckets: buckets.map(({ key, count }) => ({ key, doc_count: count })),
  doc_count_error_upper_bound: 0,
  sum_other_doc_count: 0,
});

const engineResponse = () => ({
  aggregations: {
    country: termsAggregation([{ key: "CZE", count: 1_271_387 }]),
    court: termsAggregation([{ key: "Nejvyšší soud", count: 203_722 }]),
    // A u64 fast field comes back as a JSON float.
    year: termsAggregation([{ key: 2024, count: 1_425_310 }]),
  },
});

const requestedAggregations = (): Record<string, unknown> =>
  v.parse(v.record(v.string(), v.unknown()), requests.at(0)?.body["aggs"]);

test("aggregates over opening passages only, so buckets count decisions", async () => {
  responseBody = engineResponse();

  const result = await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    limit: 20,
  });

  expect(Result.isError(result)).toBe(false);
  // Every passage of a decision carries the decision's court and country, so
  // an unrestricted aggregation would count a long judgment once per passage.
  expect(requests.at(0)?.body["query"]).toBe("seq:0");
  expect(requests.at(0)?.body["max_hits"]).toBe(0);
});

test("v5 facets use only manifest-owned fields", async () => {
  responseBody = engineResponse();
  const generation = spyOn(corpusFamily, "corpusGeneration").mockReturnValue(
    "case_law_v5",
  );
  const originalEndpoint = envBase.CORPUS_INDEX_Q09_ENDPOINT;
  Object.assign(envBase, {
    CORPUS_INDEX_Q09_ENDPOINT: "http://localhost:7291",
  });
  try {
    await corpusIndexBrowseFacets({ excludedSourceIds: [], limit: 20 });
  } finally {
    generation.mockRestore();
    Object.assign(envBase, { CORPUS_INDEX_Q09_ENDPOINT: originalEndpoint });
  }

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

  expect(result.value.country).toEqual([{ value: "CZE", count: 1_271_387 }]);
  expect(result.value.court).toEqual([
    { value: "Nejvyšší soud", count: 203_722 },
  ]);
  // The year facet's contract is a string bucket value, as the Postgres path
  // produced with to_char; "2024", never "2024.0".
  expect(result.value.year).toEqual([{ value: "2024", count: 1_425_310 }]);
});

test("scopes to one jurisdiction index, and to the generation glob without one", async () => {
  responseBody = engineResponse();
  const generation = corpusGeneration("case_law");

  await corpusIndexBrowseFacets({
    excludedSourceIds: [],
    jurisdiction: "CZE",
    limit: 20,
  });
  await corpusIndexBrowseFacets({ excludedSourceIds: [], limit: 20 });

  expect(requests.at(0)?.url).toContain(`/${generation}_cze/search`);
  expect(requests.at(1)?.url).toContain(`/${generation}_*/search`);
});

test("a scoped query on a shared index carries its jurisdiction as a clause", async () => {
  responseBody = engineResponse();
  // From generation 3 on CZE and SVK share one physical index, so selecting
  // the index alone would aggregate over both countries.
  const generation = spyOn(corpusFamily, "corpusGeneration").mockReturnValue(
    "case_law_v3",
  );
  try {
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
  } finally {
    generation.mockRestore();
  }

  expect(requests.at(0)?.url).toContain("/case_law_v3_cs_sk/search");
  expect(requests.at(0)?.body["query"]).toBe('seq:0 AND jurisdiction:"CZE"');
  // A single-country index needs no clause; the source exclusion still lands.
  expect(requests.at(1)?.url).toContain("/case_law_v3_pol/search");
  expect(requests.at(1)?.body["query"]).toBe(
    'seq:0 AND NOT (source:"018f0a2b-0000-7000-8000-000000000001")',
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
    'seq:0 AND NOT (source:"018f0a2b-0000-7000-8000-000000000001" OR source:"018f0a2b-0000-7000-8000-000000000002")',
  );
});

test("an approximate aggregation fails rather than serving wrong counts", async () => {
  responseBody = {
    aggregations: {
      ...engineResponse().aggregations,
      court: {
        ...termsAggregation([{ key: "Nejvyšší soud", count: 203_722 }]),
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
  responseBody = { aggregations: { country: termsAggregation([]) } };

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

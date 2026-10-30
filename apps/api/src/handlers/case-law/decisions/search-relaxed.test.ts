import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { SEARCH_PAGE_END } from "@stll/api-contract/search";
import { readFailureBrand } from "@stll/errors";

import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import type { RankedHit } from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";

import {
  rankByTermCoverage,
  readTermCoverage,
  relaxedFetchLimit,
  shouldRelaxCaseLawSearch,
} from "./search-relaxed";

const ELIGIBLE = {
  body: {},
  intentType: "text",
  isFirstPage: true,
  requiredTermCount: 3,
  sort: "relevance",
  strictHitCount: 2,
  limit: 10,
  strictEnd: SEARCH_PAGE_END.COMPLETE,
} as const;

describe("when a short strict page is topped up", () => {
  test("a short, exhausted, first relevance page with several terms is", () => {
    expect(shouldRelaxCaseLawSearch(ELIGIBLE)).toBe(true);
    expect(shouldRelaxCaseLawSearch({ ...ELIGIBLE, strictHitCount: 0 })).toBe(
      true,
    );
  });

  test.each([
    ["strict: true", { body: { strict: true } }],
    ["a cursor or offset page", { isFirstPage: false }],
    ["sort newest", { sort: "newest" }],
    ["a full strict page", { strictHitCount: 10 }],
    ["an identifier lookup", { intentType: "identifier" }],
    ["a single required term", { requiredTermCount: 1 }],
    ["a continuation", { strictEnd: SEARCH_PAGE_END.MORE }],
    ["a scan stopped by a budget", { strictEnd: SEARCH_PAGE_END.STOPPED }],
  ] as const)("%s is not", (_name, override) => {
    expect(shouldRelaxCaseLawSearch({ ...ELIGIBLE, ...override })).toBe(false);
  });

  test("strict: false still relaxes", () => {
    expect(
      shouldRelaxCaseLawSearch({ ...ELIGIBLE, body: { strict: false } }),
    ).toBe(true);
  });
});

test("the relaxed scan reads more than the slots to fill, within the page cap", () => {
  expect(relaxedFetchLimit(2)).toBe(6);
  expect(relaxedFetchLimit(LIMITS.caseLawSearchPageSizeMax)).toBe(
    LIMITS.caseLawSearchPageSizeMax,
  );
});

const hit = (id: string, score: number): RankedHit => ({
  id,
  score,
  lexicalScore: score,
  citationAuthority: 0,
});

const MEMBERSHIP = new Map([
  ["term-a", ["four", "two"]],
  ["term-b", ["four", "two"]],
  ["term-c", ["four"]],
  ["term-d", ["four"]],
]);

test.each(["complete", "truncated", "missing"] as const)(
  "engine coverage ranks four terms above two with %s excerpts",
  async (presentation) => {
    // Presentation is deliberately misleading or absent; it never enters the
    // coverage API. Membership in the index is the independent ranking oracle.
    let fourSnippet: string | undefined;
    switch (presentation) {
      case "missing":
        fourSnippet = undefined;
        break;
      case "truncated":
        fourSnippet = "term-a";
        break;
      case "complete":
        fourSnippet = "term-a term-b term-c term-d";
        break;
    }
    const candidates = [
      { ...hit("two", 9), snippet: "term-a term-b" },
      { ...hit("four", 1), snippet: fourSnippet },
    ];
    const queries: string[] = [];
    const coverage = await readTermCoverage({
      ids: candidates.map(({ id }) => id),
      queries: [...MEMBERSHIP.keys()],
      observer: "unobserved",
      indexId: "fixture-index",
      aggregate: async ({ query, aggs }) => {
        queries.push(query);
        expect(query).toContain('document_id: IN ["two" "four"]');
        expect(aggs).toMatchObject({
          term_coverage: {
            terms: { size: 2, shard_size: 2, order: { _key: "asc" } },
          },
        });
        const term = [...MEMBERSHIP.keys()].find((key) => query.includes(key));
        const ids = term === undefined ? [] : (MEMBERSHIP.get(term) ?? []);
        return Result.ok({
          term_coverage: {
            buckets: ids.map((key) => ({ key, doc_count: 20 })),
            sum_other_doc_count: 0,
            doc_count_error_upper_bound: 0,
          },
        });
      },
    });
    const coverageById = coverage.unwrap();
    expect(queries).toHaveLength(4);
    expect([...coverageById]).toEqual([
      ["two", 2],
      ["four", 4],
    ]);
    expect(
      rankByTermCoverage({ ranked: candidates, coverageById }).map(
        ({ id }) => id,
      ),
    ).toEqual(["four", "two"]);
  },
);

test("equal engine coverage keeps the blended order", () => {
  expect(
    rankByTermCoverage({
      ranked: [hit("a", 3), hit("b", 2)],
      coverageById: new Map([
        ["a", 2],
        ["b", 2],
      ]),
    }).map(({ id }) => id),
  ).toEqual(["a", "b"]);
});

test.each([
  { buckets: [], sum_other_doc_count: 1, doc_count_error_upper_bound: 0 },
  { buckets: [], sum_other_doc_count: 0, doc_count_error_upper_bound: 1 },
])(
  "incomplete engine membership cannot silently supply coverage: %j",
  async (term_coverage) => {
    const result = await readTermCoverage({
      ids: ["a"],
      queries: ["term"],
      observer: "unobserved",
      indexId: "fixture-index",
      aggregate: async () => Result.ok({ term_coverage }),
    });
    if (Result.isOk(result)) {
      expect.unreachable("Incomplete coverage must fail");
    }
    expect(result.error).toMatchObject({
      message: "Search term coverage is incomplete",
    });
    expect(readFailureBrand(result.error)).toEqual({
      reason: "response_invalid",
      source: "instance",
    });
  },
);

test("a candidate without measured coverage is an invariant failure", () => {
  expect(() =>
    rankByTermCoverage({ ranked: [hit("a", 1)], coverageById: new Map() }),
  ).toThrow("Missing candidate term coverage");
});

test("an unavailable coverage read returns its tagged failure", async () => {
  const cause = new CorpusIndexError({
    message: "Coverage provider unavailable",
  });
  const result = await readTermCoverage({
    ids: ["a"],
    queries: ["term"],
    observer: "unobserved",
    indexId: "fixture-index",
    aggregate: async () => Result.err(cause),
  });
  if (Result.isOk(result)) {
    expect.unreachable("Unavailable coverage must fail");
  }
  expect(result.error).toMatchObject({
    _tag: "HandlerError",
    status: 503,
    code: "upstream_unavailable",
    message: "Search term coverage is temporarily unavailable",
    cause,
  });
});

test.each([
  { buckets: [{ key: "outside-candidates", doc_count: 1 }] },
  {
    buckets: [
      { key: "a", doc_count: 1 },
      { key: "a", doc_count: 1 },
    ],
  },
  { buckets: [{ key: "a", doc_count: 0 }] },
  { buckets: [{ key: "a", doc_count: 1.5 }] },
  { buckets: [{ key: 1, doc_count: 1 }] },
  { buckets: [null] },
])("invalid membership returns a tagged failure: %j", async ({ buckets }) => {
  const result = await readTermCoverage({
    ids: ["a"],
    queries: ["term"],
    observer: "unobserved",
    indexId: "fixture-index",
    aggregate: async () =>
      Result.ok({
        term_coverage: {
          buckets,
          sum_other_doc_count: 0,
          doc_count_error_upper_bound: 0,
        },
      }),
  });
  if (Result.isOk(result)) {
    expect.unreachable("Invalid coverage must fail");
  }
  expect(result.error).toMatchObject({
    _tag: "HandlerError",
    status: 502,
    message: "Search term coverage is invalid",
  });
  expect(readFailureBrand(result.error)).toEqual({
    reason: "response_invalid",
    source: "instance",
  });
});

import { describe, expect, test } from "bun:test";

import { SEARCH_PAGE_END } from "@stll/api-contract/search";

import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import type { RankedHit } from "@/api/lib/legal-search/rerank";
import { LIMITS } from "@/api/lib/limits";

import {
  rankByTermCoverage,
  relaxedFetchLimit,
  shouldRelaxCaseLawSearch,
  termsCovered,
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

const TOKENS = tokenizeCorpusFreeText("promlčení náhrada škody");

describe("coverage of the query's terms", () => {
  test("counts each distinct term the excerpt carries, once", () => {
    expect(
      termsCovered({
        snippet:
          "<mark>promlčení</mark> práva na <mark>náhradu</mark> a promlčení",
        tokens: TOKENS,
        language: null,
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      termsCovered({
        snippet: "<mark>škody</mark> vznikla; <mark>náhrada</mark> škody",
        tokens: TOKENS,
        language: null,
      }),
    ).toBe(2);
    expect(
      termsCovered({ snippet: undefined, tokens: TOKENS, language: null }),
    ).toBe(0);
  });

  test("a hit holding more terms leads, and the blend order breaks ties", () => {
    const ranked = [hit("rare-one", 9), hit("two", 5), hit("three", 4)];
    const snippetById = new Map([
      ["rare-one", "<mark>promlčení</mark> jen"],
      ["two", "<mark>škody</mark> a <mark>náhrada</mark>"],
      [
        "three",
        "<mark>škody</mark> a <mark>náhrada</mark> a <mark>promlčení</mark>",
      ],
    ]);
    expect(
      rankByTermCoverage({
        ranked,
        snippetById,
        tokens: TOKENS,
        language: null,
      }).map(({ id }) => id),
    ).toEqual(["three", "two", "rare-one"]);
    // Equal coverage keeps the engine's blended order.
    expect(
      rankByTermCoverage({
        ranked: [hit("a", 3), hit("b", 2)],
        snippetById: new Map([
          ["a", "<mark>škody</mark>"],
          ["b", "<mark>náhrada</mark>"],
        ]),
        tokens: TOKENS,
        language: null,
      }).map(({ id }) => id),
    ).toEqual(["a", "b"]);
  });
});

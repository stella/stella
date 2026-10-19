import { expect, test } from "bun:test";

import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import {
  SEARCH_PAGE_REACH,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";

import { assembleTwoPhaseSearchResponse } from "@/api/handlers/case-law/decisions/search";
import {
  interpretDecisionQuery,
  searchAnswer,
} from "@/api/handlers/case-law/decisions/search-interpretation";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { runTwoPhaseSearch } from "@/api/lib/legal-search/two-phase-search";

test("a short case-law page appends relaxed hits and emits relaxed_match", async () => {
  const body = {
    country: "CZE" as const,
    query: "možné opilost vyhodit zaměstnance",
    limit: 3,
  };
  const strictHit = { id: "strict" };
  const relaxedHit = { id: "relaxed" };
  const result = await runTwoPhaseSearch({
    atStart: true,
    sort: "relevance",
    cursor: null,
    fingerprint: "a".repeat(64),
    generation: "case_law_v7",
    limit: 3,
    strictOnly: false,
    read: async (phase) =>
      await Promise.resolve({
        hits: phase.type === "strict" ? [strictHit] : [relaxedHit],
        nextCursor: null,
        paginationOutcome: SEARCH_PAGINATION_COMPLETE,
      }),
    encodeCursor: () => null,
    groupToken: ({ id }) => id.padEnd(6, "0").slice(0, 6),
    hitId: ({ id }) => id,
  });
  const interpretation = interpretDecisionQuery({
    body,
    configuredVariant: "off",
    intent: parseDecisionQuery(body.query, {
      grammar: decisionDocketGrammarForCountry(body.country),
    }),
  });

  expect(result.hits.map(({ id }) => id)).toEqual(["strict", "relaxed"]);
  expect(result.relaxedHitCount).toBe(1);
  expect(
    searchAnswer({
      body,
      interpretation,
      hitCount: result.hits.length,
      countsResultSet: true,
      relaxedMatch: result.relaxedShown,
    }).warnings.map(({ code }) => code),
  ).toContain("relaxed_match");
});

test("the handler response keeps strict metadata beside appended relaxed hits", () => {
  const strictFacets = {
    courts: [{ value: "Nejvyšší soud", count: 2, countType: "exact" }],
  };
  const response = assembleTwoPhaseSearchResponse({
    page: {
      hits: [{ decisionId: "relaxed-1" }, { decisionId: "relaxed-2" }],
      total: { type: SEARCH_TOTAL_TYPE.EXACT, count: 0 },
      facets: strictFacets,
    },
    relaxedHitCount: 2,
    paginationOutcome: SEARCH_PAGINATION_COMPLETE,
    pageReach: SEARCH_PAGE_REACH.REACHED,
    answer: { queryUsed: "possible intoxication dismissal", warnings: [] },
  });

  expect(response).toMatchObject({
    hits: [{ decisionId: "relaxed-1" }, { decisionId: "relaxed-2" }],
    total: { type: SEARCH_TOTAL_TYPE.EXACT, count: 0 },
    relaxedHitCount: 2,
    facets: strictFacets,
  });
});

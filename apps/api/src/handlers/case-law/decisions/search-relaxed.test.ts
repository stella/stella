import { expect, test } from "bun:test";

import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import { SEARCH_PAGINATION_COMPLETE } from "@stll/api-contract/search";

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

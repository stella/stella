import { describe, expect, test } from "bun:test";

import {
  CASE_LAW_SEARCH_WARNING_CODES,
  type CaseLawSearchWarningCode,
} from "@stll/api-contract/search";

import {
  AGENT_CASE_LAW_SEARCH_WARNING_CODES,
  AGENT_CASE_LAW_SEARCH_WARNING_PRODUCERS,
  CASE_LAW_SEARCH_WARNING_PRODUCERS,
  caseLawSearchWarnings,
  DECISION_QUERY_WARNING_CODES,
  DECISION_QUERY_WARNING_PRODUCERS,
} from "@/api/lib/case-law/search-warnings";

describe("caseLawSearchWarnings", () => {
  test("a page with hits and every word required earns nothing", () => {
    expect(
      caseLawSearchWarnings({
        hitOrder: "all_words_first",
        droppedFunctionWords: [],
        filters: [],
        emptyResultSet: false,
      }),
    ).toEqual([]);
  });

  test("names the words the query stopped requiring", () => {
    const [warning] = caseLawSearchWarnings({
      hitOrder: "all_words_first",
      droppedFunctionWords: ["jak", "musí", "být"],
      filters: [],
      emptyResultSet: false,
    });

    expect(warning?.code).toBe("function_words_optional");
    expect(warning?.message).toContain("jak, musí, být");
    expect(warning?.hint).toContain("strict: true");
  });

  test("a query that dropped words and still found nothing earns both", () => {
    // The order is load-bearing: the first warning explains why the query
    // that found nothing is not the query the caller sent.
    expect(
      caseLawSearchWarnings({
        hitOrder: "all_words_first",
        droppedFunctionWords: ["na"],
        filters: [],
        emptyResultSet: true,
      }).map(({ code }) => code),
    ).toEqual(["function_words_optional", "no_hits"]);
  });

  test("an empty page under filters is the filters', not the corpus'", () => {
    const warnings = caseLawSearchWarnings({
      hitOrder: "all_words_first",
      droppedFunctionWords: [],
      filters: ["court", "dateFrom"],
      emptyResultSet: true,
    });

    expect(warnings.map(({ code }) => code)).toEqual(["no_hits_filtered"]);
    expect(warnings[0]?.message).toContain("court, dateFrom");
    expect(warnings[0]?.hint).toContain("those filters");
  });

  test("one filter is spoken of in the singular", () => {
    expect(
      caseLawSearchWarnings({
        hitOrder: "all_words_first",
        droppedFunctionWords: [],
        filters: ["language"],
        emptyResultSet: true,
      })[0]?.hint,
    ).toContain("that filter");
  });

  test("the two empty-page codes never both appear", () => {
    for (const filters of [[], ["court"]]) {
      const codes = caseLawSearchWarnings({
        hitOrder: "all_words_first",
        droppedFunctionWords: [],
        filters,
        emptyResultSet: true,
      }).map(({ code }) => code);
      expect(codes).toHaveLength(1);
    }
  });
});

describe("partial matches are told by where the page put them", () => {
  const partialWarning = (hitOrder: "score" | "all_words_first") =>
    caseLawSearchWarnings({
      hitOrder,
      droppedFunctionWords: [],
      partialHitCount: 2,
      filters: [],
      emptyResultSet: false,
    });

  test("a page listing full matches first says the partial ones follow", () => {
    const [warning] = partialWarning("all_words_first");
    expect(warning?.code).toBe("partial_matches_appended");
    expect(warning?.message).toContain("appended after");
  });

  test("a page in score order never says the partial ones follow", () => {
    const [warning] = partialWarning("score");
    expect(warning?.code).toBe("partial_matches_ranked");
    expect(warning?.message).not.toContain("appended");
    expect(warning?.message).not.toContain("after");
    expect(warning?.message).toContain(
      "ranked among the decisions holding every word",
    );
    expect(warning?.hint).toContain("strict: true");
  });
});

// A code nobody can produce is dead guidance a caller reads verbatim, and a
// producible code with no declaration is a code the web cannot render: both
// directions are asserted, so adding a code without a search that emits it
// fails here.
describe("warning code census", () => {
  test("every declared code is produced by a search that earns it", () => {
    const produced = new Set<CaseLawSearchWarningCode>([
      ...caseLawSearchWarnings({
        hitOrder: "all_words_first",
        droppedFunctionWords: ["na"],
        filters: [],
        emptyResultSet: true,
      }).map(({ code }) => code),
      ...caseLawSearchWarnings({
        hitOrder: "all_words_first",
        droppedFunctionWords: [],
        filters: ["court"],
        emptyResultSet: true,
      }).map(({ code }) => code),
      ...caseLawSearchWarnings({
        hitOrder: "all_words_first",
        droppedFunctionWords: [],
        partialHitCount: 2,
        filters: [],
        emptyResultSet: false,
      }).map(({ code }) => code),
      ...caseLawSearchWarnings({
        hitOrder: "score",
        droppedFunctionWords: [],
        partialHitCount: 2,
        filters: [],
        emptyResultSet: false,
      }).map(({ code }) => code),
    ]);

    expect([...produced].toSorted()).toEqual(
      [...CASE_LAW_SEARCH_WARNING_CODES].toSorted(),
    );
  });

  test("every code's producer emits that code, and says what to do", () => {
    for (const code of CASE_LAW_SEARCH_WARNING_CODES) {
      const warning = CASE_LAW_SEARCH_WARNING_PRODUCERS[code]();
      expect(warning.code).toBe(code);
      // A hint that only restates the message is a dead end; every one of
      // these names a call to make or a filter to drop.
      expect(warning.hint.length).toBeGreaterThan(0);
      expect(warning.hint).not.toBe(warning.message);
      expect(warning.message.endsWith(".")).toBe(true);
    }
  });

  test("every decision-query code's producer emits that code, and says what to do", () => {
    for (const code of DECISION_QUERY_WARNING_CODES) {
      const warning = DECISION_QUERY_WARNING_PRODUCERS[code]();
      expect(warning.code).toBe(code);
      expect(warning.hint.length).toBeGreaterThan(0);
      expect(warning.hint).not.toBe(warning.message);
      expect(warning.message.endsWith(".")).toBe(true);
    }
  });

  test("every agent-only code's producer emits that code, and says what to do", () => {
    for (const code of AGENT_CASE_LAW_SEARCH_WARNING_CODES) {
      const warning = AGENT_CASE_LAW_SEARCH_WARNING_PRODUCERS[code]();
      expect(warning.code).toBe(code);
      expect(warning.hint.length).toBeGreaterThan(0);
      expect(warning.hint).not.toBe(warning.message);
      expect(warning.message.endsWith(".")).toBe(true);
    }
  });
});
